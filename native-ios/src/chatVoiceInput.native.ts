import { AppState, Platform } from "react-native";
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  setIsAudioActiveAsync,
  type AudioRecorder,
  type RecordingOptions,
} from "expo-audio";
import { File } from "expo-file-system";

// Keep this interface identical to the web transport without importing DOM code.
export const MAX_VOICE_SECONDS = 60;
export const MIN_VOICE_MS = 700;
const MAX_AUDIO_BYTES = 3_000_000;
const MAX_AUDIO_BASE64_CHARS = Math.ceil(MAX_AUDIO_BYTES / 3) * 4;

export type VoiceInputErrorCode =
  | "unsupported"
  | "permission_denied"
  | "no_microphone"
  | "too_short"
  | "failed";

export class VoiceInputError extends Error {
  readonly code: VoiceInputErrorCode;
  constructor(code: VoiceInputErrorCode, message: string = code) {
    super(message);
    this.code = code;
  }
}

export type VoiceRecording = {
  stop: () => Promise<string>;
  cancel: () => void;
  level: () => number | null;
};

const RECORDING_OPTIONS: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  extension: ".m4a",
  numberOfChannels: 1,
  bitRate: 64_000,
  isMeteringEnabled: true,
};
const nativeAudio = AudioModule;

let starting = false;
let currentRecording: VoiceRecording | null = null;
// A new recording must not race the previous session's asynchronous release.
let audioCleanup: Promise<void> = Promise.resolve();

export function isVoiceInputSupported(): boolean {
  return (Platform.OS === "ios" || Platform.OS === "android") && !Platform.isTV;
}

function voiceError(error: unknown): VoiceInputError {
  if (error instanceof VoiceInputError) return error;
  return new VoiceInputError("failed", "Unable to record audio");
}

function deleteClip(uri: string | null) {
  if (!uri) return;
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // The OS may have already removed an interrupted recorder's cache file.
  }
}

export async function startVoiceRecording(): Promise<VoiceRecording> {
  if (!isVoiceInputSupported()) throw new VoiceInputError("unsupported");
  if (starting || currentRecording) throw new VoiceInputError("failed", "A recording is already active");
  starting = true;

  let recorder: AudioRecorder | null = null;
  let ownsAudioSession = false;
  let startedAt = 0;
  let durationMs = 0;
  let uri: string | null = null;
  let consumed = false;
  let cancelled = false;
  let ready = false;
  let terminalError: VoiceInputError | null = null;
  let halted: Promise<void> | null = null;
  let limitTimer: ReturnType<typeof setTimeout> | null = null;
  let statusTimer: ReturnType<typeof setInterval> | null = null;
  let appStateSubscription: ReturnType<typeof AppState.addEventListener> | null = null;

  const clearObservers = () => {
    if (limitTimer) clearTimeout(limitTimer);
    if (statusTimer) clearInterval(statusTimer);
    limitTimer = statusTimer = null;
    appStateSubscription?.remove();
    appStateSubscription = null;
  };

  const halt = (): Promise<void> => {
    if (halted) return halted;
    clearObservers();
    durationMs = startedAt ? Math.min(Date.now() - startedAt, MAX_VOICE_SECONDS * 1000) : 0;
    halted = (async () => {
      try {
        if (recorder) {
          // stop() also finalizes a file that the native duration cap stopped.
          await recorder.stop();
          uri = recorder.uri;
        }
      } catch (error) {
        terminalError ||= voiceError(error);
      } finally {
        // Capture the URI before releasing the shared native recorder.
        if (recorder) {
          try { uri ||= recorder.uri; } catch {}
          try { recorder.release(); } catch {}
          recorder = null;
        }
        if (ownsAudioSession) {
          try {
            await setAudioModeAsync({ allowsRecording: false });
          } catch {} finally {
            await setIsAudioActiveAsync(false).catch(() => {});
          }
          ownsAudioSession = false;
        }
        if (cancelled || terminalError) deleteClip(uri);
        if (currentRecording === recording) currentRecording = null;
      }
    })();
    audioCleanup = halted;
    return halted;
  };

  const recording: VoiceRecording = {
    stop: async () => {
      if (consumed) throw new VoiceInputError("failed", "Recording has already stopped");
      consumed = true;
      await halt();
      try {
        if (cancelled) throw terminalError || new VoiceInputError("failed", "Recording was cancelled");
        if (terminalError) throw terminalError;
        if (durationMs < MIN_VOICE_MS) throw new VoiceInputError("too_short");
        if (!uri) throw new VoiceInputError("failed", "Recording is unavailable");
        const clip = new File(uri);
        if (!clip.exists || !clip.size) throw new VoiceInputError("too_short");
        if (clip.size > MAX_AUDIO_BYTES) throw new VoiceInputError("failed", "Audio exceeds the 3 MB limit");
        const base64 = await clip.base64();
        // Check the encoded result too, before a network request can be made.
        if (!base64 || base64.length > MAX_AUDIO_BASE64_CHARS) {
          throw new VoiceInputError("failed", "Audio exceeds the 3 MB limit");
        }
        if (cancelled) throw terminalError || new VoiceInputError("failed", "Recording was cancelled");
        return `data:audio/m4a;base64,${base64}`;
      } catch (error) {
        throw voiceError(error);
      } finally {
        deleteClip(uri);
      }
    },
    cancel: () => {
      cancelled = true;
      // stop() may be reading the finished file when the screen is dismissed.
      void halt().then(() => deleteClip(uri));
    },
    level: () => {
      if (!recorder || halted || cancelled) return null;
      try {
        const db = recorder.getStatus().metering;
        if (typeof db !== "number" || !Number.isFinite(db)) return null;
        return Math.min(1, Math.sqrt(5 * Math.pow(10, Math.min(0, db) / 20)));
      } catch {
        return null;
      }
    },
  };

  try {
    await audioCleanup;
    const permission = await nativeAudio.requestRecordingPermissionsAsync();
    if (!permission.granted) throw new VoiceInputError("permission_denied");
    if (AppState.currentState !== "active") throw new VoiceInputError("failed", "App is not active");
    // Attach after the system permission dialog, which temporarily makes iOS inactive.
    appStateSubscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") {
        terminalError = new VoiceInputError("failed", "Recording was interrupted");
        // Preparation owns pending native promises. Let its catch path release
        // them in order instead of racing setAudioModeAsync with its reset.
        if (ready) recording.cancel();
        else cancelled = true;
      }
    });
    ownsAudioSession = true;
    await setAudioModeAsync({
      allowsRecording: true,
      playsInSilentMode: true,
      allowsBackgroundRecording: false,
      shouldPlayInBackground: false,
      interruptionMode: "doNotMix",
    });
    if (cancelled) throw terminalError;
    await setIsAudioActiveAsync(true);
    if (cancelled) throw terminalError;
    // The imperative constructor takes the same flattened platform options as
    // useAudioRecorder. Preparing without new options avoids an extra cache file.
    recorder = new nativeAudio.AudioRecorder({
      ...RECORDING_OPTIONS,
      ...(Platform.OS === "ios" ? RECORDING_OPTIONS.ios : RECORDING_OPTIONS.android),
    });
    await recorder.prepareToRecordAsync();
    if (cancelled || AppState.currentState !== "active") throw terminalError || new VoiceInputError("failed");
    recorder.record({ forDuration: MAX_VOICE_SECONDS });
    startedAt = Date.now();
    currentRecording = recording;
    ready = true;
    // The native cap still holds if JS timers are delayed. This timer releases
    // the mic/session while the composer consumes the bounded clip.
    limitTimer = setTimeout(() => { void halt(); }, MAX_VOICE_SECONDS * 1000);
    statusTimer = setInterval(() => {
      if (!recorder || halted) return;
      try {
        const status = recorder.getStatus();
        if (status.mediaServicesDidReset || (!status.isRecording && Date.now() - startedAt < 59_500)) {
          terminalError = new VoiceInputError("failed", "Recording was interrupted");
          recording.cancel();
        }
      } catch {
        terminalError = new VoiceInputError("failed");
        recording.cancel();
      }
    }, 200);
    return recording;
  } catch (error) {
    terminalError ||= voiceError(error);
    cancelled = true;
    await halt();
    throw terminalError;
  } finally {
    starting = false;
  }
}
