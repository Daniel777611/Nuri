import { AI_CONSENT_VERSION, type AIConsentState } from "./aiConsent";

export const INITIAL_AI_CHOICE_KEY = `ai_initial_choice.${AI_CONSENT_VERSION}`;
export type InitialAIChoice = {
  version: string;
  allowed: boolean;
  phase: "pending" | "consumed" | "retired";
  ownerId: string | null;
};
type ChoiceStorage = {
  secureGet(key: string, fallback: string): Promise<string | null>;
  secureSet(key: string, value: string): Promise<boolean>;
};
const validOwner = (owner: unknown): owner is string => typeof owner === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(owner);
export type InitialAIChoiceAcknowledgement = { userId: string; version: string };

/** Presentation proof only, never AI authorization. A refresh's omitted
 * choiceRecorded field is not evidence that a parent has never chosen. */
export function initialAIChoiceAcknowledgement(state: AIConsentState): InitialAIChoiceAcknowledgement | null {
  return state.version === AI_CONSENT_VERSION && validOwner(state.userId) && state.choiceRecorded === true
    && (state.status === "allowed" || state.status === "not_allowed")
    ? { userId: state.userId, version: state.version } : null;
}

export function shouldShowInitialAIChoice(loaded: boolean, record: InitialAIChoice | null, state: AIConsentState,
  acknowledged: InitialAIChoiceAcknowledgement | null = null): boolean {
  if (!loaded || state.version !== AI_CONSENT_VERSION) return false;
  if (state.status === "signed_out") return !record || record.phase === "retired";
  if (state.status !== "not_allowed" || state.choiceRecorded !== false || !validOwner(state.userId) || record?.phase === "pending") return false;
  const seenForOwner = acknowledged?.userId === state.userId && acknowledged.version === state.version;
  return !seenForOwner;
}

/** A pre-login click is a one-use intent, NOT account permission. Before any
 * grant, consume it durably for one verified owner. A crash/storage failure or
 * A→B switch can never replay an anonymous grant onto a later account. */
export class InitialAIChoiceController {
  private record: InitialAIChoice | null = null;
  private durableRecord: InitialAIChoice | null = null;
  private writes: Promise<unknown> = Promise.resolve();
  private loaded: Promise<InitialAIChoice | null> | null = null;
  constructor(private readonly storage: ChoiceStorage) {}
  load = (): Promise<InitialAIChoice | null> => {
    if (!this.loaded) this.loaded = this.readInitialRecord().catch(error => { this.loaded = null; throw error; });
    return this.loaded;
  };
  private async readInitialRecord(): Promise<InitialAIChoice | null> {
    const raw = await this.storage.secureGet(INITIAL_AI_CHOICE_KEY, "");
    let value: any = null;
    try { value = JSON.parse(raw || ""); } catch { /* missing/corrupt is not consent */ }
    this.record = value?.version === AI_CONSENT_VERSION && typeof value.allowed === "boolean"
      && (value.phase === "pending" && value.ownerId === null || value.phase === "consumed" && validOwner(value.ownerId))
      // An anonymous intent from a previous process is not replayable. A crash
      // may have happened while binding it to A, with a failed durable write.
      ? { version: value.version, allowed: value.allowed, phase: value.phase === "pending" ? "retired" : value.phase, ownerId: value.ownerId } : null;
    this.durableRecord = this.record ? { ...this.record } : null;
    return this.record;
  }
  getState = (): InitialAIChoice | null => this.record ? { ...this.record } : null;
  getAcknowledgement = (): InitialAIChoiceAcknowledgement | null => this.durableRecord?.phase === "consumed" && this.durableRecord.ownerId
    ? { userId: this.durableRecord.ownerId, version: this.durableRecord.version } : null;
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.writes.then(work, work);
    this.writes = next.catch(() => {});
    return next;
  }
  private async save(record: InitialAIChoice): Promise<InitialAIChoice> {
    if (!await this.storage.secureSet(INITIAL_AI_CHOICE_KEY, JSON.stringify(record))) throw new Error("INITIAL_AI_CHOICE_STORAGE_FAILED");
    this.record = record;
    this.durableRecord = { ...record };
    return record;
  }
  choose = (allowed: boolean, ownerId: string | null): Promise<InitialAIChoice> => this.enqueue(() => {
    if (ownerId !== null && !validOwner(ownerId)) throw new Error("INITIAL_AI_CHOICE_OWNER_INVALID");
    // A new explicit choice supersedes any prior anonymous grant even if this
    // write fails while switching accounts. Never leave that grant replayable.
    this.record = { version: AI_CONSENT_VERSION, allowed, phase: ownerId ? "consumed" : "retired", ownerId };
    return this.save({ ...this.record, phase: ownerId ? "consumed" : "pending" });
  });
  claimPending = (ownerId: string): Promise<InitialAIChoice | null> => this.enqueue(async () => {
    if (!validOwner(ownerId)) throw new Error("INITIAL_AI_CHOICE_OWNER_INVALID");
    if (this.record?.phase !== "pending") return null;
    // Retire in memory BEFORE awaiting storage. A failed A consume can never
    // automatically retry on B; restored anonymous intents also require a click.
    const consumed: InitialAIChoice = { ...this.record, phase: "consumed", ownerId };
    this.record = consumed;
    return this.save(consumed);
  });
}
