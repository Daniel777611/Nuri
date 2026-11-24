import type { AIParticipation, ConsentRequest, Message, MessageTranslation } from "./communityApi";

export type CommunityTranslationScope = {
  owner: string; conversationId: string; language: string; epoch: number;
  requestId: string; noticeVersion: string; afterSeq: number;
};

/** Notes consent is deliberately not inspected. Only a current, two-party
 * translation grant supplies authority over the other parent's words. */
export function communityTranslationScope(owner: string, conversationId: string | undefined, language: string,
  ai: AIParticipation | undefined): CommunityTranslationScope | null {
  const request = ai?.requests?.translation;
  if (!owner || !conversationId || ai?.conversation_id !== conversationId || !["en", "zh-CN", "zh-TW"].includes(language)
      || !Number.isSafeInteger(ai.epoch) || ai.epoch < 0 || !ai.notice_version
      || !request || request.purpose !== "translation" || request.state !== "effective" || request.effective !== true
      || request.my_decision !== "allow" || request.parent_decision !== "allow" || request.epoch !== ai.epoch
      || request.notice_version !== ai.notice_version || !request.request_id
      || !Number.isSafeInteger(request.effective_from_seq) || request.effective_from_seq! < 0) return null;
  return { owner, conversationId, language, epoch: ai.epoch, requestId: request.request_id,
    noticeVersion: ai.notice_version, afterSeq: request.effective_from_seq! };
}

export function currentTranslationRequest(conversationId: string, ai: AIParticipation | undefined): ConsentRequest | null | undefined {
  if (!ai || ai.conversation_id !== conversationId || !Number.isSafeInteger(ai.epoch) || ai.epoch < 0 || !ai.notice_version) return undefined;
  const request = ai.requests?.translation;
  if (request === null) return null;
  if (!request || request.purpose !== "translation" || request.epoch !== ai.epoch ||
      request.notice_version !== ai.notice_version || !request.request_id || !Number.isSafeInteger(request.version) ||
      !["pending", "effective"].includes(request.state)) return undefined;
  return request;
}

export function communityTranslationActions(request: ConsentRequest | null | undefined) {
  if (request === null) return ["request"] as const;
  if (request?.state === "pending" && request.initiated_by === "parent" && request.my_decision === "pending") {
    return ["approve", "decline"] as const;
  }
  if (request?.my_decision === "allow" && (request.state === "pending" || request.effective === true && request.parent_decision === "allow")) {
    return ["revoke"] as const;
  }
  return [] as const;
}

function alreadyInTargetLanguage(source: Message["language"], target: string): boolean {
  const language = typeof source === "string" ? source.toLowerCase().replaceAll("_", "-") : "";
  if (target === "en") return language === "en" || language.startsWith("en-");
  return target === "zh-CN" ? ["zh-cn", "zh-sg", "zh-hans"].includes(language)
    : target === "zh-TW" && ["zh-tw", "zh-hk", "zh-mo", "zh-hant"].includes(language);
}

type Entry = { original: string; status: "queued" | "pending" | "ready" | "failed"; text?: string };
const keyOf = (scope: CommunityTranslationScope | null) => scope ? JSON.stringify([
  scope.owner, scope.conversationId, scope.language, scope.epoch, scope.requestId, scope.noticeVersion, scope.afterSeq,
]) : "";

/** Mounted-chat memory only. One serial queue prevents a historical page from
 * firing 50 concurrent model calls. A failed/withdrawn attempt is not retried
 * by polling, rerenders, foreground refresh or preference toggles. */
export class CommunityMessageTranslations {
  private key = "";
  private scope: CommunityTranslationScope | null = null;
  private enabled = false;
  private revision = 0;
  private entries = new Map<string, Entry>();
  private work: Promise<void> = Promise.resolve();
  constructor(private readonly translate: (messageId: string, language: string, key: string) => Promise<MessageTranslation>,
    private readonly newKey: () => string) {}

  configure(scope: CommunityTranslationScope | null, enabled: boolean): void {
    const key = keyOf(scope);
    if (key !== this.key) { this.revision++; this.entries.clear(); this.key = key; }
    if (this.enabled && !enabled) {
      this.revision++;
      for (const [id, entry] of this.entries) {
        if (entry.status === "queued") this.entries.delete(id);
        else if (entry.status === "pending") entry.status = "failed";
      }
    }
    this.scope = scope; this.enabled = !!scope && enabled;
  }
  clear(): void { this.configure(null, false); }
  text(message: Message): string | null {
    if (!this.enabled || message.sender !== "parent" || message.conversation_id !== this.scope?.conversationId) return null;
    const entry = this.entries.get(message.message_id);
    return entry?.status === "ready" && entry.original === message.text ? entry.text ?? null : null;
  }
  queue(messages: readonly Message[], owns: () => boolean, changed: () => void): Promise<void> {
    const scope = this.scope, revision = this.revision, key = this.key;
    if (!this.enabled || !scope || !owns()) return this.work;
    for (const message of messages) {
      if (message.sender !== "parent" || message.conversation_id !== scope.conversationId || !message.text.trim()
          || alreadyInTargetLanguage(message.language, scope.language)
          || !Number.isSafeInteger(message.seq) || message.seq <= scope.afterSeq || this.entries.has(message.message_id)) continue;
      const entry: Entry = { original: message.text, status: "queued" };
      this.entries.set(message.message_id, entry);
      const current = () => this.enabled && this.key === key && this.revision === revision && this.entries.get(message.message_id) === entry && owns();
      this.work = this.work.catch(() => {}).then(async () => {
        if (!current()) { if (this.entries.get(message.message_id) === entry && entry.status === "queued") this.entries.delete(message.message_id); return; }
        entry.status = "pending";
        try {
          const result = await this.translate(message.message_id, scope.language, this.newKey());
          if (!current()) { if (this.entries.get(message.message_id) === entry) entry.status = "failed"; return; }
          const translated = result.translation;
          if (result.message_id !== message.message_id || result.original?.text !== message.text || translated?.kind !== "translation"
              || translated.state !== "succeeded" || translated.target_language !== scope.language || !translated.text?.trim()) throw new Error("INVALID_TRANSLATION_RESULT");
          entry.status = "ready";
          if (translated.text.trim() !== message.text.trim()) { entry.text = translated.text; changed(); }
        } catch {
          if (this.entries.get(message.message_id) === entry) entry.status = "failed";
          // Original text remains visible. Polling must not become a retry loop
          // or an automatic request for another parent's consent.
        }
      });
    }
    return this.work;
  }
}

const cn = {
  title: "允许 Nuri 使用这段对话？",
  body: "此处仅保存对话整理许可，尚未开始记录或整理。双方同意后许可才生效，范围包括本对话的全部内容，也包括同意之前的历史消息。",
  closeWarning: "任何一方都可关闭。关闭会更新会话许可，其他 Nuri 会话许可也可能需要重新确认。",
  allowRequest: "同意并请求对方", allow: "同意开启", decline: "不同意", cancel: "保持关闭", close: "返回对话",
  changed: "会话或许可已变更，请返回对话重新核对。",
};
const en: typeof cn = {
  title: "Allow Nuri to use this conversation?",
  body: "This only saves notes consent. No recording or organising has started. It takes effect after both parents agree and covers the entire conversation, including messages sent before consent.",
  closeWarning: "Either parent can withdraw. This updates the conversation's consent epoch, so other Nuri conversation permissions may also need confirmation again.",
  allowRequest: "Agree and ask the other parent", allow: "Allow", decline: "Do not agree", cancel: "Keep off", close: "Back to conversation",
  changed: "The conversation or consent changed. Go back and check again.",
};
const tw: typeof cn = {
  title: "允許 Nuri 使用這段對話？",
  body: "此處僅儲存對話整理許可，尚未開始記錄或整理。雙方同意後許可才生效，範圍包括本對話的全部內容，也包含同意之前的歷史訊息。",
  closeWarning: "任何一方都可關閉。關閉會更新對話許可，其他 Nuri 對話許可也可能需要重新確認。",
  allowRequest: "同意並請求對方", allow: "同意開啟", decline: "不同意", cancel: "保持關閉", close: "返回對話",
  changed: "對話或許可已變更，請返回對話重新核對。",
};
export function communityNotesConsentCopy(locale: string) { return locale === "en" ? en : locale === "zh-TW" ? tw : cn; }
