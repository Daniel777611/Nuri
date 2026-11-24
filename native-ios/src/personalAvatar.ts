import * as FileSystem from "expo-file-system/legacy";
import { Platform } from "react-native";
import { isCurrentNativeRelease } from "./release/currentNativeRelease";

function avatarFile(userId: unknown): string | null {
  if (Platform.OS !== "ios" || !isCurrentNativeRelease() || !FileSystem.documentDirectory
    || typeof userId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(userId)) return null;
  return `${FileSystem.documentDirectory}nuri-personal-avatar-v1-${userId}.txt`;
}

export function personalAvatarAvailable(userId: unknown): boolean {
  return avatarFile(userId) !== null;
}

const isAvatarPhoto = (value: string) =>
  value.length < 700_000 && /^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(value);

export async function readPersonalAvatar(userId: unknown): Promise<string | null> {
  const file = avatarFile(userId);
  if (!file) return null;
  const info = await FileSystem.getInfoAsync(file);
  if (!info.exists || info.isDirectory || info.size >= 700_000) return null;
  const photo = await FileSystem.readAsStringAsync(file);
  return isAvatarPhoto(photo) ? photo : null;
}

export async function savePersonalAvatar(userId: unknown, photo: string): Promise<void> {
  const file = avatarFile(userId);
  if (!file || !isAvatarPhoto(photo)) throw new Error("Invalid personal avatar");
  // The iOS UTF-8 write is atomic, preserving the previous photo on failure.
  await FileSystem.writeAsStringAsync(file, photo);
}

export async function deletePersonalAvatar(userId: unknown): Promise<void> {
  const file = avatarFile(userId);
  if (file) await FileSystem.deleteAsync(file, { idempotent: true });
}
