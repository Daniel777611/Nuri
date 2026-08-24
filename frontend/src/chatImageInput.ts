import * as ImageManipulator from "expo-image-manipulator";
import type { ImagePickerAsset } from "expo-image-picker";

// Keep uploads small enough for a JSON request while preserving details that
// matter in parenting photos (skin changes, labels, feeding portions, etc.).
export const CHAT_IMAGE_MAX_DIMENSION = 1600;
export const CHAT_IMAGE_MAX_SOURCE_BYTES = 25 * 1024 * 1024;
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

function resizeAction(width: number, height: number): ImageManipulator.Action[] {
  if (!width || !height || Math.max(width, height) <= CHAT_IMAGE_MAX_DIMENSION) return [];
  return width >= height
    ? [{ resize: { width: CHAT_IMAGE_MAX_DIMENSION } }]
    : [{ resize: { height: CHAT_IMAGE_MAX_DIMENSION } }];
}

async function compress(
  asset: ImagePickerAsset,
  maxDimension = CHAT_IMAGE_MAX_DIMENSION,
  quality = 0.72,
) {
  const dimension = Math.max(asset.width || 0, asset.height || 0);
  const actions: ImageManipulator.Action[] = dimension > maxDimension
    ? asset.width >= asset.height
      ? [{ resize: { width: maxDimension } }]
      : [{ resize: { height: maxDimension } }]
    : resizeAction(asset.width, asset.height);
  return ImageManipulator.manipulateAsync(asset.uri, actions, {
    base64: true,
    compress: quality,
    format: ImageManipulator.SaveFormat.JPEG,
  });
}

export async function prepareChatImage(asset: ImagePickerAsset): Promise<PreparedChatImage> {
  if (asset.type && asset.type !== "image") throw new ChatImageInputError("unsupported");
  if (asset.fileSize && asset.fileSize > CHAT_IMAGE_MAX_SOURCE_BYTES) {
    throw new ChatImageInputError("too_large");
  }

  try {
    let result = await compress(asset);
    let dataUri = result.base64 ? `data:image/jpeg;base64,${result.base64}` : "";

    // A very detailed source can still be too large after the first pass. One
    // bounded retry avoids sending a request that the host must reject.
    if (dataUri.length > CHAT_IMAGE_MAX_DATA_URI_CHARS) {
      result = await compress(asset, 1200, 0.55);
      dataUri = result.base64 ? `data:image/jpeg;base64,${result.base64}` : "";
    }
    if (!dataUri || dataUri.length > CHAT_IMAGE_MAX_DATA_URI_CHARS) {
      throw new ChatImageInputError("too_large");
    }

    return {
      previewUri: result.uri,
      dataUri,
      width: result.width,
      height: result.height,
    };
  } catch (error) {
    if (error instanceof ChatImageInputError) throw error;
    throw new ChatImageInputError("processing_failed");
  }
}
