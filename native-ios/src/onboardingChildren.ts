import { isValidBirthDate, isValidDueDate } from "./child-age";

export type ChildPayload = {
  nickname: string;
  birth_date: string;
  gender: "boy" | "girl" | "other";
  allergies: string[];
  notes: string;
};
export type ChildDraft = ChildPayload & { key: string; id?: string; expecting: boolean };
type Confirmed = { id: string; fingerprint: string };
type PendingCreate = { key: string; payload: ChildPayload; beforeIds: Set<string> };
export type ChildSaveProgress = { confirmed: Map<string, Confirmed>; pending: PendingCreate | null };
export const newChildSaveProgress = (): ChildSaveProgress => ({ confirmed: new Map(), pending: null });

export class ChildSaveError extends Error {
  constructor(public readonly code: "invalid" | "unconfirmed" | "stale" | "read-failed") {
    super("Child setup did not complete.");
    this.name = "ChildSaveError";
  }
}

export function childPayload(row: ChildPayload): ChildPayload {
  return { nickname: row.nickname.trim(), birth_date: row.birth_date, gender: row.gender,
    allergies: [...row.allergies], notes: row.notes };
}
export function childFingerprint(row: ChildPayload): string { return JSON.stringify(childPayload(row)); }

export function childDraftsFromServer(value: unknown): ChildDraft[] {
  if (!Array.isArray(value)) throw new ChildSaveError("read-failed");
  const ids = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry.id !== "string" || !entry.id || ids.has(entry.id)
      || typeof entry.nickname !== "string" || typeof entry.birth_date !== "string") throw new ChildSaveError("read-failed");
    ids.add(entry.id);
    return { key: entry.id, id: entry.id, nickname: entry.nickname, birth_date: entry.birth_date,
      gender: entry.gender === "boy" || entry.gender === "girl" ? entry.gender : "other",
      allergies: Array.isArray(entry.allergies) ? entry.allergies.filter((x: unknown): x is string => typeof x === "string") : [],
      notes: typeof entry.notes === "string" ? entry.notes : "", expecting: isValidDueDate(entry.birth_date) };
  });
}

export function validChildDraft(row: ChildDraft): boolean {
  return !!row.nickname.trim() && (row.expecting ? isValidDueDate(row.birth_date) : isValidBirthDate(row.birth_date));
}

/** Existing /children GET/POST/PUT only. Successful IDs are retained before
 * moving to the next row, so a later failure never recreates an earlier child.
 * A lost POST response is not safe to repeat: reconcile a unique newly visible
 * matching row or remain honestly unconfirmed. No invented idempotency API.
 * This checkpoint is in-memory for this account-bound onboarding session; a
 * fresh visit loads the server's complete child list before allowing writes. */
export async function persistOnboardingChildren(rows: ChildDraft[], options: {
  api: { listChildren: () => Promise<unknown>; addChild: (body: ChildPayload) => Promise<unknown>;
    updateChild: (id: string, body: ChildPayload) => Promise<unknown> };
  owns: () => Promise<boolean>;
  progress: ChildSaveProgress;
  onConfirmed: (key: string, id: string) => void;
}): Promise<void> {
  const { api, progress } = options;
  const own = async () => { if (!await options.owns()) throw new ChildSaveError("stale"); };
  const remember = (key: string, record: ChildDraft, payload: ChildPayload) => {
    progress.confirmed.set(key, { id: record.id!, fingerprint: childFingerprint(payload) });
    options.onConfirmed(key, record.id!);
  };
  const read = async () => { await own(); const value = await api.listChildren(); await own(); return childDraftsFromServer(value); };
  const reconcile = async () => {
    const pending = progress.pending;
    if (!pending) return;
    const visible = await read();
    const matches = visible.filter(row => !pending.beforeIds.has(row.id!) && childFingerprint(row) === childFingerprint(pending.payload));
    if (matches.length !== 1) throw new ChildSaveError("unconfirmed");
    remember(pending.key, matches[0], pending.payload);
    progress.pending = null;
  };
  if (new Set(rows.map(row => row.key)).size !== rows.length || rows.some(row => !validChildDraft(row))) throw new ChildSaveError("invalid");
  await own();
  await reconcile();
  for (const row of rows) {
    await own();
    const payload = childPayload(row), fingerprint = childFingerprint(payload);
    const checkpoint = progress.confirmed.get(row.key);
    if (checkpoint?.fingerprint === fingerprint) continue;
    const id = checkpoint?.id ?? row.id;
    if (id) {
      const returned = await api.updateChild(id, payload); await own();
      const [confirmed] = childDraftsFromServer([returned]);
      if (confirmed.id !== id || childFingerprint(confirmed) !== fingerprint) throw new ChildSaveError("unconfirmed");
      remember(row.key, confirmed, payload);
      continue;
    }
    const before = await read();
    progress.pending = { key: row.key, payload, beforeIds: new Set(before.map(item => item.id!)) };
    try {
      const returned = await api.addChild(payload); await own();
      const [confirmed] = childDraftsFromServer([returned]);
      if (progress.pending.beforeIds.has(confirmed.id!) || childFingerprint(confirmed) !== fingerprint) throw new ChildSaveError("unconfirmed");
      remember(row.key, confirmed, payload); progress.pending = null;
    } catch (error) {
      await own();
      // Validation/not-found means no new child was accepted. Timeouts and 5xx
      // do not: they must not trigger another POST automatically or on retry.
      const status = (error as { status?: number })?.status;
      if (status === 400 || status === 401 || status === 403 || status === 404 || status === 422) { progress.pending = null; throw error; }
      try { await reconcile(); }
      catch (reconcileError) {
        if (reconcileError instanceof ChildSaveError && reconcileError.code === "stale" || [401,403].includes((reconcileError as {status?:number})?.status ?? 0)) throw reconcileError;
        throw new ChildSaveError("unconfirmed");
      }
    }
  }
}

const en = {
  title: "Your children", guide: "You can add more than one child. Add each child below, then continue. Details are saved when you finish setup.",
  child: "Child", addAnother: "Add another child", saveAndAdd: "Add this child & add another", edit: "Edit", draft: "Ready to save",
  cancelNew: "Back to my children's list", removeDraft: "Remove from setup", nickname: "Child's nickname",
  summary: "Children added to setup", manageLater: "You can add or edit children later in Profile & Settings → Children.",
  year: "Year (type any year)", yearHint: "Type a year directly, or scroll. There is no recent-years-only limit.",
  earlierYears: "Earlier years", newerYears: "Newer years",
  unconfirmed: "A child's save result is not confirmed. Retry to check the saved list first; the app will not create that child again blindly.",
  reload: "Retry loading family details", editChildren: "Review my children", loading: "Loading family details…",
};
export function onboardingChildCopy(locale: string) {
  if (locale === "en") return en;
  if (locale === "zh-TW") return {
    title:"孩子資料", guide:"可以新增多位孩子。請逐一填寫，完成後繼續；資料會在完成設定時儲存。", child:"孩子",
    addAnother:"再新增一位孩子", saveAndAdd:"加入這位，再新增下一位", edit:"編輯", draft:"待完成設定時儲存",
    cancelNew:"返回孩子清單", removeDraft:"從本次設定移除", nickname:"孩子的暱稱", summary:"本次設定的孩子",
    manageLater:"之後可在「個人資料與設定 → 孩子」繼續新增或編輯。", year:"年份（可直接輸入）",
    yearHint:"可直接輸入年份，也可捲動選擇；不再只限最近幾年。",
    earlierYears:"更早年份", newerYears:"較近年份",
    unconfirmed:"有一位孩子的儲存結果尚未確認。重試時會先核對已儲存清單，不會直接重複新增。",
    reload:"重新載入家庭資料", editChildren:"查看與編輯孩子資料", loading:"正在載入家庭資料…",
  };
  return {
    title:"孩子资料", guide:"可以添加多位孩子。请逐一填写，完成后继续；资料会在完成设置时保存。", child:"孩子",
    addAnother:"再添加一位孩子", saveAndAdd:"加入这位，再添加下一位", edit:"编辑", draft:"待完成设置时保存",
    cancelNew:"返回孩子列表", removeDraft:"从本次设置移除", nickname:"孩子的昵称", summary:"本次设置的孩子",
    manageLater:"之后可在“个人资料与设置 → 孩子”继续添加或编辑。", year:"年份（可直接输入）",
    yearHint:"可直接输入年份，也可滚动选择；不再只限最近几年。",
    earlierYears:"更早年份", newerYears:"较近年份",
    unconfirmed:"有一位孩子的保存结果尚未确认。重试时会先核对已保存列表，不会直接重复添加。",
    reload:"重新加载家庭资料", editChildren:"查看与编辑孩子资料", loading:"正在加载家庭资料…",
  };
}
