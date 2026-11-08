// Browser-only local preference, not a claim of Keychain security or cloud sync.
// New keys are identity-scoped without changing the legacy web storage wrapper.
export type ParentGender = "female" | "male" | "hidden";
export type ParentGenderOwner = () => Promise<boolean>;
export class ParentGenderStorageError extends Error {
  constructor(public readonly code: "invalid-user" | "invalid-value" | "stale" | "storage") {
    super("The parent gender choice could not be confirmed on this device.");
    this.name = "ParentGenderStorageError";
  }
}

const validGender = (value: unknown): value is ParentGender => value === "female" || value === "male" || value === "hidden";
const flavor = process.env.EXPO_PUBLIC_RELEASE_FLAVOR;
const namespace = flavor === "early-access" ? "com.ordashtech.nuri.earlyaccess.v1."
  : flavor === "alpha" || flavor === "beta" ? "com.ordashtech.nuri.beta.v1." : "com.ordashtech.nuri.nativelab.v1.";
function keyFor(userId: string): string {
  if (typeof userId !== "string" || !userId.trim()) throw new ParentGenderStorageError("invalid-user");
  let encoded = "";
  for (let i = 0; i < userId.length; i++) encoded += userId.charCodeAt(i).toString(16).padStart(4, "0");
  return `${namespace}onboarding_parent_gender.v1.${encoded}`;
}
async function own(owns: ParentGenderOwner): Promise<void> {
  let current = false;
  try { current = await owns(); } catch { /* A failed ownership check is not authority. */ }
  if (current !== true) throw new ParentGenderStorageError("stale");
}
async function io<T>(operation: () => T, owns: ParentGenderOwner): Promise<T> {
  await own(owns);
  let result!: T, failed = false;
  try { result = operation(); } catch { failed = true; }
  await own(owns);
  if (failed) throw new ParentGenderStorageError("storage");
  return result;
}

/** userId must be verified by /auth/me; owns checks the current token+epoch. */
export async function readParentGender(userId: string, owns: ParentGenderOwner): Promise<ParentGender> {
  const key = keyFor(userId);
  const raw = await io(() => globalThis.localStorage.getItem(key), owns);
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
    await io(() => globalThis.localStorage.setItem(key, raw), owns);
    const confirmed = await io(() => globalThis.localStorage.getItem(key), owns);
    if (confirmed !== raw) throw new ParentGenderStorageError("storage");
  };
  const result = writes.then(write, write);
  writes = result.catch(() => {});
  return result;
}
