import type { ImageProps } from "expo-image";
import type { PreparedChatImage } from "./chatImageInput";

/** Ephemeral, account-scoped composer draft. Never persist private media. */
export type ChatDraftAttachment = {
  id: string;
  kind: "image" | "video";
  uri: string;
  previewSource?: ImageProps["source"];
  durationMs?: number;
  fileName?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  image?: PreparedChatImage;
};

/** Window-space bounds of the60pt add capsule (not the20/24pt artwork). */
export type ChatAttachmentAnchor = { x: number; y: number; width: number; height: number };
