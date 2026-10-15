import * as ImageManipulator from "expo-image-manipulator";
import type { ImagePickerAsset } from "expo-image-picker";
import { File as NativeFile, Paths } from "expo-file-system";
import { Platform } from "react-native";

// Keep uploads small enough for a JSON request while preserving details that
// matter in parenting photos (skin changes, labels, feeding portions, etc.).
export const CHAT_IMAGE_MAX_DIMENSION = 1600;
export const CHAT_IMAGE_MAX_SOURCE_BYTES = 25 * 1024 * 1024;
// A compressed 48 MP phone photo can be only a few megabytes on disk while
// requiring hundreds of megabytes once WebKit decodes it. Reject that source
// before any canvas work so iOS cannot terminate the page for memory pressure.
export const CHAT_IMAGE_MAX_SOURCE_PIXELS = 16_000_000;
// Native image processing does not allocate WebKit canvases. Permit ordinary
// 24/48 MP iPhone photos, but not unbounded panoramas or invalid picker metadata.
// Expo still decodes the source UIImage before resizing, so serialize work and
// cap it at 50 MP (about 200 MB of RGBA pixels), not an unlimited source size.
export const CHAT_IMAGE_MAX_NATIVE_SOURCE_PIXELS = 50_000_000;
export const CHAT_IMAGE_MAX_NATIVE_SOURCE_DIMENSION = 10_000;
export const CHAT_IMAGE_MAX_NATIVE_DATA_URI_CHARS = 3 * 1024 * 1024;
// Mirrors the backend's decoded 2.5 MB ceiling, leaving room for the text,
// client context and JSON envelope under the 3.7 MB request guard.
export const CHAT_IMAGE_MAX_DATA_URI_CHARS = 3_250_000;

export type PreparedChatImage = {
  previewUri: string;
  dataUri: string;
  width: number;
  height: number;
};

export class ChatImageInputError extends Error {
  constructor(public readonly code: "too_large" | "unsupported" | "processing_failed") {
    super(code);
    this.name = "ChatImageInputError";
  }
}

type EncodedImageDimensions = { width: number; height: number };

function bytesEqual(bytes: Uint8Array, offset: number, expected: number[]) {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function readU24LE(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readEncodedImageDimensions(bytes: Uint8Array): EncodedImageDimensions | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && bytesEqual(bytes, 0, [0x89, 0x50, 0x4e, 0x47])) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length >= 10 && bytesEqual(bytes, 0, [0x47, 0x49, 0x46, 0x38])) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (bytes.length >= 26 && bytesEqual(bytes, 0, [0x42, 0x4d])) {
    return {
      width: Math.abs(view.getInt32(18, true)),
      height: Math.abs(view.getInt32(22, true)),
    };
  }
  if (
    bytes.length >= 30 &&
    bytesEqual(bytes, 0, [0x52, 0x49, 0x46, 0x46]) &&
    bytesEqual(bytes, 8, [0x57, 0x45, 0x42, 0x50])
  ) {
    if (bytesEqual(bytes, 12, [0x56, 0x50, 0x38, 0x58])) {
      return {
        width: readU24LE(bytes, 24) + 1,
        height: readU24LE(bytes, 27) + 1,
      };
    }
    if (bytesEqual(bytes, 12, [0x56, 0x50, 0x38, 0x4c]) && bytes[20] === 0x2f) {
      return {
        width: 1 + (bytes[21] | ((bytes[22] & 0x3f) << 8)),
        height: 1 + ((bytes[22] >> 6) | (bytes[23] << 2) | ((bytes[24] & 0x0f) << 10)),
      };
    }
    if (
      bytesEqual(bytes, 12, [0x56, 0x50, 0x38, 0x20]) &&
      bytesEqual(bytes, 23, [0x9d, 0x01, 0x2a])
    ) {
      return {
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff,
      };
    }
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      // JPEG permits any number of 0xFF fill bytes before a marker. TEM and
      // restart markers are standalone and therefore have no length field.
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      if (offset >= bytes.length) break;
      const marker = bytes[offset];
      offset += 1;
      if (marker === 0x00) continue;
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        continue;
      }
      if (offset + 2 > bytes.length) break;
      const blockLength = view.getUint16(offset);
      if (blockLength < 2 || offset + blockLength > bytes.length) break;
      const isStartOfFrame =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isStartOfFrame && blockLength >= 7) {
        return {
          width: view.getUint16(offset + 5),
          height: view.getUint16(offset + 3),
        };
      }
      offset += blockLength;
    }
  }

  // HEIC/HEIF and AVIF are ISO-BMFF containers. Their `ispe` boxes contain
  // encoded pixel dimensions without decoding the photo. Use the largest box
  // because a file may also contain small thumbnails.
  let largest: EncodedImageDimensions | null = null;
  for (let offset = 4; offset + 16 <= bytes.length; offset += 1) {
    if (!bytesEqual(bytes, offset, [0x69, 0x73, 0x70, 0x65])) continue;
    const boxSize = view.getUint32(offset - 4);
    if (boxSize < 20 || offset + 16 > bytes.length) continue;
    const width = view.getUint32(offset + 8);
    const height = view.getUint32(offset + 12);
    if (!width || !height || width > 100_000 || height > 100_000) continue;
    if (!largest || width * height > largest.width * largest.height) {
      largest = { width, height };
    }
  }
  return largest;
}

async function webAssetFromFile(file: File): Promise<ImagePickerAsset> {
  if (file.size > CHAT_IMAGE_MAX_SOURCE_BYTES) {
    throw new ChatImageInputError("too_large");
  }
  const header = new Uint8Array(
    await file.slice(0, Math.min(file.size, 2 * 1024 * 1024)).arrayBuffer(),
  );
  const dimensions = readEncodedImageDimensions(header);
  if (!dimensions) {
    throw new ChatImageInputError(file.type.startsWith("image/") ? "processing_failed" : "unsupported");
  }
  if (dimensions.width * dimensions.height > CHAT_IMAGE_MAX_SOURCE_PIXELS) {
    throw new ChatImageInputError("too_large");
  }
  return {
    uri: URL.createObjectURL(file),
    width: dimensions.width,
    height: dimensions.height,
    type: "image",
    mimeType: file.type || undefined,
    fileName: file.name,
    fileSize: file.size,
    file,
  };
}

/**
 * Opens the browser-owned photo chooser without `capture=environment` and
 * without Expo's eager full-resolution metadata decode. iOS still offers
 * Camera and Photo Library in its chooser, while NURI receives the raw File.
 */
export function pickWebChatImageFile(): Promise<ImagePickerAsset | null> {
  if (typeof document === "undefined") {
    return Promise.reject(new ChatImageInputError("processing_failed"));
  }
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.style.position = "fixed";
    input.style.left = "-10000px";
    input.style.width = "1px";
    input.style.height = "1px";
    let settled = false;

    const cleanup = () => {
      input.remove();
    };
    const finish = (asset: ImagePickerAsset | null, error?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(asset);
    };

    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) {
        finish(null);
        return;
      }
      void webAssetFromFile(file).then((asset) => finish(asset), (error) => finish(null, error));
    }, { once: true });
    input.addEventListener("cancel", () => finish(null), { once: true });
    document.body.appendChild(input);
    try {
      input.click();
    } catch (error) {
      finish(null, error);
    }
  });
}

function boundedDimensions(width: number, height: number, maxDimension: number) {
  if (!width || !height) throw new ChatImageInputError("processing_failed");
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function canvasDataUri(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  maxDimension: number,
  quality: number,
) {
  const size = boundedDimensions(sourceWidth, sourceHeight, maxDimension);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new ChatImageInputError("processing_failed");
  context.drawImage(source, 0, 0, size.width, size.height);
  const dataUri = canvas.toDataURL("image/jpeg", quality);
  // Release the backing store as soon as encoding finishes. On mobile Safari,
  // keeping even a 1600 px canvas around alongside a camera bitmap is costly.
  canvas.width = 1;
  canvas.height = 1;
  return { dataUri, ...size };
}

async function loadWebImageElement(uri: string) {
  const image = new window.Image();
  image.decoding = "async";
  image.src = uri;
  await new Promise<void>((resolve, reject) => {
    image.addEventListener("load", () => resolve(), { once: true });
    image.addEventListener("error", () => reject(new Error("image-decode-failed")), {
      once: true,
    });
  });
  return image;
}

function isMemoryConstrainedMobileWeb() {
  if (typeof navigator === "undefined") return false;
  const userAgent = navigator.userAgent || "";
  const iPadDesktopMode = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  return iPadDesktopMode || /iPhone|iPad|iPod|Android|Mobile/i.test(userAgent);
}

async function prepareWebChatImage(asset: ImagePickerAsset): Promise<PreparedChatImage> {
  if (!asset.file || typeof document === "undefined") {
    throw new ChatImageInputError("processing_failed");
  }
  const sourceWidth = asset.width || 0;
  const sourceHeight = asset.height || 0;
  if (
    !sourceWidth ||
    !sourceHeight ||
    sourceWidth * sourceHeight > CHAT_IMAGE_MAX_SOURCE_PIXELS
  ) {
    throw new ChatImageInputError("too_large");
  }

  let source: ImageBitmap | HTMLImageElement | null = null;
  const allowFullResolutionFallback = !isMemoryConstrainedMobileWeb();
  try {
    if (typeof createImageBitmap === "function") {
      const target = boundedDimensions(
        sourceWidth,
        sourceHeight,
        CHAT_IMAGE_MAX_DIMENSION,
      );
      // Decode-time resizing avoids expo-image-manipulator's Web path, which
      // first allocates a full-resolution canvas and then creates more canvases
      // to resize and encode it.
      try {
        source = await createImageBitmap(asset.file, {
          imageOrientation: "from-image",
          resizeWidth: target.width,
          resizeHeight: target.height,
          resizeQuality: "high",
        });
      } catch {
        if (!allowFullResolutionFallback) {
          throw new ChatImageInputError("processing_failed");
        }
        try {
          source = await createImageBitmap(asset.file);
        } catch {
          // Some Safari releases expose createImageBitmap but cannot decode
          // HEIC through it. The browser image decoder can still handle the
          // same object URL; the pixel guard above bounds its memory cost.
          source = await loadWebImageElement(asset.uri);
        }
      }
    } else {
      if (!allowFullResolutionFallback) {
        throw new ChatImageInputError("processing_failed");
      }
      source = await loadWebImageElement(asset.uri);
    }

    if (!source) throw new ChatImageInputError("processing_failed");
    const isBitmap = typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap;
    const decodedWidth = isBitmap
      ? (source as ImageBitmap).width
      : (source as HTMLImageElement).naturalWidth;
    const decodedHeight = isBitmap
      ? (source as ImageBitmap).height
      : (source as HTMLImageElement).naturalHeight;
    let rendered = canvasDataUri(
      source,
      decodedWidth,
      decodedHeight,
      CHAT_IMAGE_MAX_DIMENSION,
      0.72,
    );
    if (rendered.dataUri.length > CHAT_IMAGE_MAX_DATA_URI_CHARS) {
      rendered = canvasDataUri(
        source,
        decodedWidth,
        decodedHeight,
        1200,
        0.55,
      );
    }
    if (
      !rendered.dataUri.startsWith("data:image/jpeg;base64,") ||
      rendered.dataUri.length > CHAT_IMAGE_MAX_DATA_URI_CHARS
    ) {
      throw new ChatImageInputError("too_large");
    }
    return {
      previewUri: rendered.dataUri,
      dataUri: rendered.dataUri,
      width: rendered.width,
      height: rendered.height,
    };
  } finally {
    if (typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap) source.close();
    if (asset.uri.startsWith("blob:")) URL.revokeObjectURL(asset.uri);
  }
}

function validateNativeDimensions(width: number, height: number, maxDimension: number, maxPixels: number) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new ChatImageInputError("processing_failed");
  }
  if (Math.max(width, height) > maxDimension || width * height > maxPixels) {
    throw new ChatImageInputError("too_large");
  }
}

async function resizeNativeImage(source: string | ImageManipulator.ImageRef, width: number, height: number, maxDimension: number) {
  const context = ImageManipulator.ImageManipulator.manipulate(source);
  let rendered: ImageManipulator.ImageRef | null = null;
  try {
    // Both dimensions bound the actual output even if orientation changed while
    // the source was loaded. Never create a full-size JPEG or JS bitmap first.
    context.resize(boundedDimensions(width, height, maxDimension));
    rendered = await context.renderAsync();
    validateNativeDimensions(rendered.width, rendered.height, maxDimension, maxDimension * maxDimension);
    return rendered;
  } catch (error) {
    rendered?.release();
    throw error;
  } finally {
    context.release();
  }
}

function deleteGeneratedImage(uri: string, sourceUri: string) {
  // Only remove the exact file returned by our saveAsync in Expo's cache folder;
  // never delete the picker original, a photo-library asset, or a broad folder.
  if (uri === sourceUri || !uri.startsWith("file://")) return;
  try {
    const file = new NativeFile(uri);
    const generatedFolder = `${Paths.cache.uri.replace(/\/?$/, "/")}ImageManipulator/`;
    if (file.uri.startsWith(generatedFolder) && file.exists) file.delete();
  } catch {
    // The OS can evict cache files; failed cleanup must not mask the real error.
  }
}

async function prepareNativeChatImage(asset: ImagePickerAsset): Promise<PreparedChatImage> {
  validateNativeDimensions(asset.width, asset.height, CHAT_IMAGE_MAX_NATIVE_SOURCE_DIMENSION, CHAT_IMAGE_MAX_NATIVE_SOURCE_PIXELS);
  if (asset.fileSize != null && (!Number.isFinite(asset.fileSize) || asset.fileSize < 0)) {
    throw new ChatImageInputError("processing_failed");
  }
  let image: ImageManipulator.ImageRef | null = null;
  const generatedFiles = new Set<string>();
  const saveJpeg = async (rendered: ImageManipulator.ImageRef, quality: number) => {
    const result = await rendered.saveAsync({ base64: true, compress: quality, format: ImageManipulator.SaveFormat.JPEG });
    if (typeof result.uri === "string") generatedFiles.add(result.uri);
    validateNativeDimensions(result.width, result.height, CHAT_IMAGE_MAX_DIMENSION, CHAT_IMAGE_MAX_DIMENSION ** 2);
    if (result.width !== rendered.width || result.height !== rendered.height || typeof result.base64 !== "string" || !result.base64.startsWith("/9j/")) {
      throw new ChatImageInputError("processing_failed");
    }
    return result;
  };
  try {
    image = await resizeNativeImage(asset.uri, asset.width, asset.height, CHAT_IMAGE_MAX_DIMENSION);
    let result = await saveJpeg(image, 0.72);
    const prefix = "data:image/jpeg;base64,";
    const maxChars = Math.min(CHAT_IMAGE_MAX_DATA_URI_CHARS, CHAT_IMAGE_MAX_NATIVE_DATA_URI_CHARS);
    if (result.base64!.length + prefix.length > maxChars) {
      // Retry from the already bounded native reference, never decode the 48 MP
      // original a second time or keep two full-resolution contexts alive.
      const smaller = await resizeNativeImage(image, image.width, image.height, 1200);
      image.release();
      image = smaller;
      result = await saveJpeg(image, 0.55);
    }
    const base64 = result.base64!;
    if (base64.length + prefix.length > maxChars) throw new ChatImageInputError("too_large");
    if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new ChatImageInputError("processing_failed");
    const decodedBytes = base64.length / 4 * 3 - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
    if (decodedBytes > 3 * 1024 * 1024) throw new ChatImageInputError("too_large");
    const dataUri = prefix + base64;
    // A data URI remains valid after deleting both temporary JPEG outputs and
    // after navigating away. It contains only the user-selected resized photo.
    return { previewUri: dataUri, dataUri, width: result.width, height: result.height };
  } finally {
    image?.release();
    for (const uri of generatedFiles) deleteGeneratedImage(uri, asset.uri);
  }
}

let nativeImageWork: Promise<void> = Promise.resolve();

export async function prepareChatImage(asset: ImagePickerAsset): Promise<PreparedChatImage> {
  if (asset.type && asset.type !== "image") throw new ChatImageInputError("unsupported");
  if (asset.fileSize && asset.fileSize > CHAT_IMAGE_MAX_SOURCE_BYTES) {
    throw new ChatImageInputError("too_large");
  }
  if (
    Platform.OS === "web" &&
    asset.width &&
    asset.height &&
    asset.width * asset.height > CHAT_IMAGE_MAX_SOURCE_PIXELS
  ) {
    throw new ChatImageInputError("too_large");
  }

  try {
    if (Platform.OS === "web") return await prepareWebChatImage(asset);
    const work = nativeImageWork.then(() => prepareNativeChatImage(asset));
    nativeImageWork = work.then(() => undefined, () => undefined);
    return await work;
  } catch (error) {
    if (error instanceof ChatImageInputError) throw error;
    throw new ChatImageInputError("processing_failed");
  }
}
