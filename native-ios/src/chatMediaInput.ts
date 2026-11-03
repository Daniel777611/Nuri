import type { ImagePickerAsset } from "expo-image-picker";
import { File as NativeFile } from "expo-file-system";
import { createVideoPlayer, type VideoThumbnail, type VideoTrack } from "expo-video";
import { Platform } from "react-native";
import type { ChatDraftAttachment } from "./chatAttachments";
import { ChatImageInputError, prepareChatImage, webAssetFromFile } from "./chatImageInput";

export const CHAT_MAX_ATTACHMENTS = 6;
// Local draft/decode resource bounds, not a declaration of a server's upload
// limits or video-analysis capability. No network or persistence happens here.
export const CHAT_VIDEO_MAX_SOURCE_BYTES = 100 * 1024 * 1024;
export const CHAT_VIDEO_MAX_DURATION_MS = 120_000;
export const CHAT_VIDEO_MAX_DIMENSION = 4096;
export const CHAT_VIDEO_MAX_PIXELS = 16_000_000;
export const CHAT_VIDEO_COVER_MAX_DIMENSION = 320;
export const CHAT_MEDIA_PREPARATION_TIMEOUT_MS = 15_000;

const ownedPickerUrls = new Map<ImagePickerAsset, string>();
const discardedPickerAssets = new WeakSet<ImagePickerAsset>();
const attachmentReleases = new WeakMap<ChatDraftAttachment, () => void>();
let preparationQueue: Promise<void> = Promise.resolve();
let nextId = 0;
const mediaError = (code: "too_large" | "unsupported" | "processing_failed") => new ChatImageInputError(code);

function releaseQuietly(release: () => void) { try { release(); } catch { /* OS may already have released it. */ } }
function releasePickerUrl(asset: ImagePickerAsset) {
  const uri = ownedPickerUrls.get(asset);
  if (!uri) return;
  ownedPickerUrls.delete(asset);
  releaseQuietly(() => URL.revokeObjectURL(uri));
}

/** Safe on stale/cancelled results and in a controller's finally block. A
 * successfully prepared video's URL has already transferred to its draft. */
export function releaseChatPickerAssets(assets: readonly ImagePickerAsset[]) {
  for (const asset of assets) {
    discardedPickerAssets.add(asset);
    releasePickerUrl(asset);
  }
}

/** Only our thumbnail SharedRef or our own browser object URL is released.
 * Never delete picker originals, photo-library assets or broad cache folders. */
export function releaseChatAttachment(attachment: ChatDraftAttachment) {
  const release = attachmentReleases.get(attachment);
  attachmentReleases.delete(attachment);
  if (release) releaseQuietly(release);
}

function localUri(uri: string) {
  return Platform.OS === "web" ? /^blob:/.test(uri) : /^(file|content|ph|assets-library):\/\//.test(uri);
}

function videoSize(asset: ImagePickerAsset) {
  let bytes = asset.file?.size ?? asset.fileSize;
  if (bytes !== undefined && (!Number.isSafeInteger(bytes) || bytes <= 0)) throw mediaError("processing_failed");
  if (Platform.OS !== "web" && /^(file|content):\/\//.test(asset.uri)) {
    try {
      const file = new NativeFile(asset.uri);
      if (file.exists) {
        const actual = file.size;
        if (!Number.isSafeInteger(actual) || actual <= 0) throw mediaError("processing_failed");
        bytes = Math.max(bytes ?? 0, actual);
      }
    } catch (error) {
      if (error instanceof ChatImageInputError) throw error;
      // Some scoped content providers expose size only in picker metadata.
      // No file body is loaded in order to obtain this resource bound.
    }
  }
  if (bytes === undefined || !Number.isSafeInteger(bytes) || bytes <= 0) throw mediaError("processing_failed");
  if (bytes > CHAT_VIDEO_MAX_SOURCE_BYTES) throw mediaError("too_large");
}

function videoDimensions(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw mediaError("processing_failed");
  if (Math.max(width, height) > CHAT_VIDEO_MAX_DIMENSION || width * height > CHAT_VIDEO_MAX_PIXELS) throw mediaError("too_large");
}

function videoDuration(durationMs: number) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw mediaError("processing_failed");
  if (durationMs > CHAT_VIDEO_MAX_DURATION_MS) throw mediaError("too_large");
}

function validateKnownVideoMetadata(asset: ImagePickerAsset) {
  videoSize(asset);
  if (!Number.isFinite(asset.width) || !Number.isFinite(asset.height) || asset.width < 0 || asset.height < 0) throw mediaError("processing_failed");
  if (asset.width && asset.height) videoDimensions(asset.width, asset.height);
  if (asset.duration != null && asset.duration !== 0) videoDuration(asset.duration);
}

function attachmentBase(asset: ImagePickerAsset, kind: ChatDraftAttachment["kind"]): ChatDraftAttachment {
  return { id: `draft-media-${Date.now()}-${++nextId}`, kind, uri: asset.uri,
    fileName: asset.fileName ?? undefined, mimeType: asset.mimeType ?? asset.file?.type ?? undefined };
}

function withTimeout<T>(work: Promise<T>, expire: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { expire(); reject(mediaError("processing_failed")); }, CHAT_MEDIA_PREPARATION_TIMEOUT_MS);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

async function nativeVideo(asset: ImagePickerAsset): Promise<ChatDraftAttachment> {
  const player = createVideoPlayer(null);
  let expired = false, kept = false;
  let thumbnails: VideoThumbnail[] = [];
  const subscriptions: { remove(): void }[] = [];
  let resolveMetadata!: (value: { duration: number; tracks: VideoTrack[] }) => void;
  let rejectMetadata!: (error: unknown) => void;
  const metadata = new Promise<{ duration: number; tracks: VideoTrack[] }>((resolve, reject) => { resolveMetadata = resolve; rejectMetadata = reject; });
  // Errors can arrive while replaceAsync is still pending. Handle the promise
  // immediately as well as awaiting it below; never leak an unhandled rejection.
  void metadata.catch(() => {});
  try {
    player.muted = true;
    player.volume = 0;
    player.allowsExternalPlayback = false;
    player.keepScreenOnWhilePlaying = false;
    player.staysActiveInBackground = false;
    player.showNowPlayingNotification = false;
    subscriptions.push(player.addListener("sourceLoad", event => resolveMetadata({ duration: event.duration, tracks: event.availableVideoTracks })));
    subscriptions.push(player.addListener("statusChange", event => { if (event.status === "error") rejectMetadata(mediaError("processing_failed")); }));
    const work = (async () => {
      await player.replaceAsync({ uri: asset.uri });
      if (expired) throw mediaError("processing_failed");
      if (player.duration > 0 && player.availableVideoTracks.length) resolveMetadata({ duration: player.duration, tracks: player.availableVideoTracks });
      const loaded = await metadata;
      if (expired) throw mediaError("processing_failed");
      videoDuration(loaded.duration * 1000);
      if (!loaded.tracks.length) throw mediaError("unsupported");
      for (const track of loaded.tracks) videoDimensions(track.size.width, track.size.height);
      const track = loaded.tracks.reduce((a, b) => a.size.width * a.size.height >= b.size.width * b.size.height ? a : b);
      const generated = await player.generateThumbnailsAsync(0, { maxWidth: CHAT_VIDEO_COVER_MAX_DIMENSION, maxHeight: CHAT_VIDEO_COVER_MAX_DIMENSION });
      if (expired) { for (const ref of generated) releaseQuietly(() => ref.release()); throw mediaError("processing_failed"); }
      thumbnails = generated;
      const first = generated[0];
      if (!first || !Number.isFinite(first.width) || !Number.isFinite(first.height) || first.width <= 0 || first.height <= 0 || Math.max(first.width, first.height) > CHAT_VIDEO_COVER_MAX_DIMENSION) throw mediaError("processing_failed");
      if (discardedPickerAssets.has(asset)) throw mediaError("processing_failed");
      const attachment: ChatDraftAttachment = { ...attachmentBase(asset, "video"), previewSource: first,
        durationMs: loaded.duration * 1000, width: track.size.width, height: track.size.height };
      attachmentReleases.set(attachment, () => first.release());
      return attachment;
    })();
    const attachment = await withTimeout(work, () => { expired = true; });
    kept = true;
    return attachment;
  } finally {
    expired = true;
    for (const subscription of subscriptions) releaseQuietly(() => subscription.remove());
    releaseQuietly(() => player.release());
    for (const ref of kept ? thumbnails.slice(1) : thumbnails) releaseQuietly(() => ref.release());
  }
}

async function webVideo(asset: ImagePickerAsset): Promise<ChatDraftAttachment> {
  if (typeof document === "undefined" || !asset.file) throw mediaError("processing_failed");
  const video = document.createElement("video");
  const canvas = document.createElement("canvas");
  let cleanup = () => {};
  let expired = false;
  try {
    video.muted = true; video.volume = 0; video.playsInline = true; video.autoplay = false; video.preload = "metadata";
    const work = new Promise<ChatDraftAttachment>((resolve, reject) => {
      let metadataReady = false, settled = false;
      const fail = (error: unknown) => { if (!settled) { settled = true; reject(error); } };
      const draw = () => {
        if (expired || settled || !metadataReady || video.readyState < 2) return;
        try {
          const scale = Math.min(1, CHAT_VIDEO_COVER_MAX_DIMENSION / Math.max(video.videoWidth, video.videoHeight));
          canvas.width = Math.max(1, Math.round(video.videoWidth * scale)); canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
          const context = canvas.getContext("2d", { alpha: false });
          if (!context) throw mediaError("processing_failed");
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          const cover = canvas.toDataURL("image/jpeg", .7);
          if (!cover.startsWith("data:image/jpeg;base64,") || cover.length > 512_000) throw mediaError("processing_failed");
          if (discardedPickerAssets.has(asset)) throw mediaError("processing_failed");
          settled = true;
          resolve({ ...attachmentBase(asset, "video"), previewSource: { uri: cover },
            durationMs: video.duration * 1000, width: video.videoWidth, height: video.videoHeight });
        } catch (error) { fail(error); }
      };
      const loaded = () => {
        if (expired || settled) return;
        try { videoDuration(video.duration * 1000); videoDimensions(video.videoWidth, video.videoHeight); metadataReady = true; video.currentTime = 0; draw(); }
        catch (error) { fail(error); }
      };
      const failed = () => fail(mediaError("processing_failed"));
      video.addEventListener("loadedmetadata", loaded); video.addEventListener("loadeddata", draw); video.addEventListener("seeked", draw); video.addEventListener("error", failed);
      cleanup = () => { video.removeEventListener("loadedmetadata", loaded); video.removeEventListener("loadeddata", draw); video.removeEventListener("seeked", draw); video.removeEventListener("error", failed); };
      video.src = asset.uri;
      video.load();
    });
    const attachment = await withTimeout(work, () => { expired = true; });
    const ownedUri = ownedPickerUrls.get(asset);
    if (ownedUri) { ownedPickerUrls.delete(asset); attachmentReleases.set(attachment, () => URL.revokeObjectURL(ownedUri)); }
    return attachment;
  } finally {
    expired = true;
    cleanup();
    releaseQuietly(() => video.pause());
    video.removeAttribute("src");
    releaseQuietly(() => video.load());
    canvas.width = 1; canvas.height = 1;
  }
}

/** Serial decoding avoids simultaneous full-resolution photo/video surfaces.
 * The caller owns account/focus checks, then releases stale results with the
 * two explicit release helpers; this function never sends or stores media. */
export function prepareChatAttachment(asset: ImagePickerAsset): Promise<ChatDraftAttachment> {
  const work = preparationQueue.then(async () => {
    if (discardedPickerAssets.has(asset)) throw mediaError("processing_failed");
    try {
      if (!asset.uri || !localUri(asset.uri)) throw mediaError("unsupported");
      const kind = asset.type ?? (asset.mimeType?.startsWith("video/") ? "video" : "image");
      if (kind !== "image" && kind !== "video") throw mediaError("unsupported");
      // Scoped providers can omit MIME or return application/octet-stream.
      // Reject a contradictory known media kind, then let the real decoder
      // inspect the local content rather than trusting the filename/MIME alone.
      if (asset.mimeType && /^(image|video)\//.test(asset.mimeType) && !asset.mimeType.startsWith(`${kind}/`)) throw mediaError("unsupported");
      if (kind === "image") {
        try {
          const image = await prepareChatImage(asset);
          if (discardedPickerAssets.has(asset)) throw mediaError("processing_failed");
          return { ...attachmentBase(asset, "image"), uri: image.previewUri, previewSource: { uri: image.previewUri }, width: image.width, height: image.height, image };
        } finally {
          // The existing web image helper already revokes its input blob. Drop
          // our ownership entry rather than retaining a dead URL until unmount.
          ownedPickerUrls.delete(asset);
        }
      }
      validateKnownVideoMetadata(asset);
      return await (Platform.OS === "web" ? webVideo(asset) : nativeVideo(asset));
    } catch (error) {
      releasePickerUrl(asset);
      if (error instanceof ChatImageInputError) throw error;
      throw mediaError("processing_failed");
    }
  });
  preparationQueue = work.then(() => undefined, () => undefined);
  return work;
}

/** Browser-owned raw File chooser, without forced camera process transitions
 * or Expo's eager full-resolution image decode. Native selection is owned by
 * the controller's existing scoped OS picker. */
export function pickWebChatMediaFiles(source: "camera" | "library", remaining: number): Promise<ImagePickerAsset[]> {
  const limit = Math.min(CHAT_MAX_ATTACHMENTS, Math.max(0, Math.floor(Number.isFinite(remaining) ? remaining : 0)));
  if (!limit) return Promise.reject(mediaError("too_large"));
  if (typeof document === "undefined") return Promise.reject(mediaError("processing_failed"));
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file"; input.accept = "image/*,video/*"; input.multiple = source === "library" && limit > 1;
    input.style.position = "fixed"; input.style.left = "-10000px"; input.style.width = "1px"; input.style.height = "1px";
    let settled = false;
    const created: ImagePickerAsset[] = [];
    const finish = (assets: ImagePickerAsset[], error?: unknown) => {
      if (settled) { releaseChatPickerAssets(assets); return; }
      settled = true; input.remove();
      if (error) { releaseChatPickerAssets(created); reject(error); }
      else { if (assets !== created) releaseChatPickerAssets(created); resolve(assets); }
    };
    input.addEventListener("cancel", () => finish([]), { once: true });
    input.addEventListener("change", () => {
      const files = Array.from(input.files ?? []);
      if (files.length > limit || source === "camera" && files.length > 1) { finish([], mediaError("too_large")); return; }
      void (async () => {
        try {
          for (const file of files) {
            if (settled) return;
            let asset: ImagePickerAsset;
            if (file.type.startsWith("video/") || (!file.type || file.type === "application/octet-stream") && /\.(mp4|mov|m4v|webm)$/i.test(file.name)) {
              if (file.size <= 0 || !Number.isFinite(file.size)) throw mediaError("processing_failed");
              if (file.size > CHAT_VIDEO_MAX_SOURCE_BYTES) throw mediaError("too_large");
              asset = { uri: URL.createObjectURL(file), type: "video", width: 0, height: 0, fileName: file.name, mimeType: file.type || undefined, fileSize: file.size, file };
            } else {
              asset = await webAssetFromFile(file);
            }
            ownedPickerUrls.set(asset, asset.uri); created.push(asset);
            if (settled) { releaseChatPickerAssets(created); return; }
          }
          finish(created);
        } catch (error) { finish([], error instanceof ChatImageInputError ? error : mediaError("processing_failed")); }
      })();
    }, { once: true });
    document.body.appendChild(input);
    try { input.click(); } catch { finish([], mediaError("processing_failed")); }
  });
}
