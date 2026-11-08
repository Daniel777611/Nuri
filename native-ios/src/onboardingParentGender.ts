import * as SecureStore from "expo-secure-store";
import { NATIVE_SECURE_STORAGE_OPTIONS, NATIVE_STORAGE_NAMESPACE } from "./utils/storage";

export type ParentGender = "female" | "male" | "hidden";
export type ParentGenderOwner = () => Promise<boolean>;
export class ParentGenderStorageError extends Error {
  constructor(public readonly code: "invalid-user" | "invalid-value" | "stale" | "storage") {
    super("The parent gender choice could not be confirmed on this device.");
    this.name = "ParentGenderStorageError";
  }
}

const validGender = (value: unknown): value is ParentGender => value === "female" || value === "male" || value === "hidden";
function keyFor(userId: string): string {
  if (typeof userId !== "string" || !userId.trim()) throw new ParentGenderStorageError("invalid-user");
  // A collision-free encoding also keeps arbitrary verified IDs inside the
  // native key character allowlist. Never use a JWT/token as this identifier.
  let encoded = "";
  for (let i = 0; i < userId.length; i++) encoded += userId.charCodeAt(i).toString(16).padStart(4, "0");
  return `${NATIVE_STORAGE_NAMESPACE}onboarding_parent_gender.v1.${encoded}`;
}
async function own(owns: ParentGenderOwner): Promise<void> {
  let current = false;
  try { current = await owns(); } catch { /* A failed ownership check is not authority. */ }
  if (current !== true) throw new ParentGenderStorageError("stale");
}
async function io<T>(operation: () => Promise<T>, owns: ParentGenderOwner): Promise<T> {
  await own(owns);
  let result!: T, failed = false;
  try { result = await operation(); } catch { failed = true; }
  await own(owns);
  // Do not retain/log provider errors, keys, account IDs or the stored body.
  if (failed) throw new ParentGenderStorageError("storage");
  return result;
}

/** The caller must supply the verified /auth/me ID and a token+generation CAS.
 * This private device preference is NOT parent_role or cloud/AI permission.
 * Direct SecureStore preserves the existing namespace/options but can tell a
 * missing key from an I/O error (the general storage wrapper cannot). */
export async function readParentGender(userId: string, owns: ParentGenderOwner): Promise<ParentGender> {
  const key = keyFor(userId);
  const raw = await io(() => SecureStore.getItemAsync(key, NATIVE_SECURE_STORAGE_OPTIONS), owns);
  if (raw === null) return "hidden";
  let record: unknown;
  try { record = JSON.parse(raw); } catch { throw new ParentGenderStorageError("invalid-value"); }
  const value = record as { version?: unknown; owner?: unknown; value?: unknown } | null;
  if (!value || value.version !== 1 || value.owner !== userId || !validGender(value.value)) throw new ParentGenderStorageError("invalid-value");
  return value.value;
}

let writes: Promise<void> = Promise.resolve();
export function saveParentGender(userId: string, value: ParentGender, owns: ParentGenderOwner): Promise<void> {
  const write = async () => {
    const key = keyFor(userId);
    if (!validGender(value)) throw new ParentGenderStorageError("invalid-value");
    const raw = JSON.stringify({ version: 1, owner: userId, value });
    await io(() => SecureStore.setItemAsync(key, raw, NATIVE_SECURE_STORAGE_OPTIONS), owns);
    const confirmed = await io(() => SecureStore.getItemAsync(key, NATIVE_SECURE_STORAGE_OPTIONS), owns);
    if (confirmed !== raw) throw new ParentGenderStorageError("storage");
  };
  const result = writes.then(write, write);
  writes = result.catch(() => {});
  return result;
}
