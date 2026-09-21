// Voice input for the chat composer.
//
// Every client runs the web build (the iOS app is a WKWebView shell), so the
// clip is recorded with the browser's own MediaRecorder rather than a native
// module. The recording is posted to /chat/transcribe and the text comes back
// into the composer for the parent to check before sending.

import { Platform } from "react-native";

// A spoken chat turn is a sentence or two. The cap keeps the upload far below
// the backend's 3 MB limit on any encoder.
export const MAX_VOICE_SECONDS = 60;
// A tap that is released at once records a few hundred ms of silence, which
// the transcription model tends to fill with invented text.
export const MIN_VOICE_MS = 700;

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

// Safari only records MP4/AAC; Chrome, Firefox and Android record WebM/Ogg.
// Ask for the first one this browser supports so the backend always gets a
// container it recognises.
const PREFERRED_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
];

export function isVoiceInputSupported(): boolean {
  if (Platform.OS !== "web" || typeof window === "undefined") return false;
  return !!(
    typeof navigator !== "undefined"
    && typeof navigator.mediaDevices?.getUserMedia === "function"
    && typeof (window as any).MediaRecorder !== "undefined"
  );
}

function pickMimeType(): string | undefined {
  const Recorder = (window as any).MediaRecorder;
  if (!Recorder?.isTypeSupported) return undefined;
  return PREFERRED_TYPES.find((type) => Recorder.isTypeSupported(type));
}

function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("read failed"));
    reader.readAsDataURL(blob);
  });
}

export type VoiceRecording = {
  /** Resolves with the clip as a data URI once recording has stopped. */
  stop: () => Promise<string>;
  /** Stops and throws the clip away. */
  cancel: () => void;
};

export async function startVoiceRecording(): Promise<VoiceRecording> {
  if (!isVoiceInputSupported()) throw new VoiceInputError("unsupported");

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch (error: any) {
    const name = error?.name || "";
    if (name === "NotAllowedError" || name === "SecurityError") {
      throw new VoiceInputError("permission_denied");
    }
    if (name === "NotFoundError" || name === "OverconstrainedError") {
      throw new VoiceInputError("no_microphone");
    }
    throw new VoiceInputError("failed", String(error?.message || error));
  }

  const release = () => stream.getTracks().forEach((track) => track.stop());
  const mimeType = pickMimeType();
  let recorder: MediaRecorder;
  try {
    // Speech needs far less than the 128 kbps browsers default to, and a
    // lower rate keeps a full minute of Safari AAC well inside the upload cap.
    recorder = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: 64000,
    });
  } catch {
    release();
    throw new VoiceInputError("unsupported");
  }

  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };
  const startedAt = Date.now();
  // No timeslice: one blob at stop is a single well-formed container, which
  // matters for Safari's MP4 output.
  recorder.start();

  let finished = false;
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });

  return {
    stop: async () => {
      if (finished) throw new VoiceInputError("failed", "already stopped");
      finished = true;
      const elapsed = Date.now() - startedAt;
      if (recorder.state !== "inactive") recorder.stop();
      await stopped;
      release();
      if (elapsed < MIN_VOICE_MS) throw new VoiceInputError("too_short");
      const type = (recorder.mimeType || mimeType || chunks[0]?.type || "audio/webm");
      const blob = new Blob(chunks, { type });
      if (!blob.size) throw new VoiceInputError("too_short");
      const uri = await blobToDataUri(blob);
      // Some browsers label the data URI with a bare or empty type; the
      // backend needs the container, so restore it from the recorder.
      return uri.replace(/^data:[^,]*?;base64,/, `data:${type.split(";")[0]};base64,`);
    },
    cancel: () => {
      if (finished) return;
      finished = true;
      try {
        if (recorder.state !== "inactive") recorder.stop();
      } catch {}
      release();
    },
  };
}
