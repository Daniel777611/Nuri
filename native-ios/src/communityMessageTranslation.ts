import type { AIParticipation, Message, MessageTranslation } from "./communityApi";

export type CommunityTranslationScope = {
  owner: string; conversationId: string; language: string; epoch: number;
  requestId: string; noticeVersion: string; afterSeq: number;
};

/** Notes consent is deliberately not inspected. Only a current, two-party
 * translation grant supplies authority over the other parent's words. */
export function communityTranslationScope(owner: string, conversationId: string | undefined, language: string,
  ai: AIParticipation | undefined): CommunityTranslationScope | null {
  const request = ai?.requests.translation;
  if (!owner || !conversationId || ai?.conversation_id !== conversationId || !["en", "zh-CN", "zh-TW"].includes(language)
      || !Number.isSafeInteger(ai.epoch) || ai.epoch < 0 || !ai.notice_version
      || !request || request.purpose !== "translation" || request.state !== "effective" || request.effective !== true
      || request.my_decision !== "allow" || request.parent_decision !== "allow" || request.epoch !== ai.epoch
      || request.notice_version !== ai.notice_version || !request.request_id
      || !Number.isSafeInteger(request.effective_from_seq) || request.effective_from_seq! < 0) return null;
  return { owner, conversationId, language, epoch: ai.epoch, requestId: request.request_id,
    noticeVersion: ai.notice_version, afterSeq: request.effective_from_seq! };
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
          entry.text = translated.text; entry.status = "ready"; changed();
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
  title: "消息翻译", translated: "AI 译文 · 原文保留", loading: "正在核对翻译偏好和会话许可…", unavailable: "翻译许可未能核实，目前只显示原文。",
  preferenceOff: "消息自动翻译已关闭。开启偏好不会自动授权 AI。", preferences: "社区偏好",
  deviceOff: "本机尚未允许 AI，当前只显示原文。", devicePermission: "查看 AI 使用许可",
  required: "翻译对方的消息需要单独的双方翻译许可。对话整理许可不能替代。",
  waiting: "翻译请求已发出，等待对方同意；目前只显示原文。", active: "双方已允许消息翻译，原文始终保留。",
  paused: "翻译已在本机暂停；请核对云端许可是否已关闭。", request: "请求翻译许可", review: "查看翻译请求", stop: "关闭翻译许可",
  titleTranslation: "允许翻译这段对话的消息？",
  bodyTranslation: "此许可只用于消息翻译，不是记录或整理许可。同意后，你们双方都可以将本对话中对方的全部文字发送给 OpenAI 翻译，包括同意之前的历史消息和后续消息；原文不会被替换。使用翻译还需要各自本机的 AI 许可和自动翻译偏好。",
  titleNotes: "允许 Nuri 使用这段对话？",
  bodyNotes: "此处仅保存对话整理许可，当前尚未开始记录或整理。许可范围包括本对话的全部内容，也包括同意之前的历史消息。这不代表允许消息翻译；翻译需要另行取得双方同意。",
  closeWarning: "任何一方都可关闭。关闭会更新会话许可，其他 Nuri 会话许可也可能需要重新确认。",
  allowRequest: "同意并请求对方", allowTranslation: "同意翻译", allowNotes: "同意开启", decline: "不同意", cancel: "暂不请求", close: "返回对话",
  sent: "已请求对方同意翻译；双方都同意前只显示原文。", changed: "会话或许可已变更，请返回对话重新核对。",
};
const en: typeof cn = {
  title: "Message translation", translated: "AI translation · original retained", loading: "Checking translation preferences and consent…", unavailable: "Translation permission could not be verified. Only originals are shown.",
  preferenceOff: "Automatic translation is off. Enabling the preference does not grant AI permission.", preferences: "Community preferences",
  deviceOff: "AI is not allowed on this device. Only originals are shown.", devicePermission: "Review AI permission",
  required: "Translating the other parent's words needs separate consent from both parents. Notes consent cannot replace it.",
  waiting: "Translation requested; waiting for the other parent. Only originals are shown.", active: "Both parents allow translation. Originals are always retained.",
  paused: "Translation is paused on this device. Check whether cloud consent was withdrawn.", request: "Request translation consent", review: "Review translation request", stop: "Withdraw translation consent",
  titleTranslation: "Allow translation of this conversation?",
  bodyTranslation: "This consent is for message translation, not recording or notes. If you agree, both parents may send all of the other parent's text in this conversation to OpenAI for translation, including messages sent before consent and future messages. Originals are not replaced. Each parent also needs their own device AI permission and automatic-translation preference to use translation.",
  titleNotes: "Allow Nuri to use this conversation?",
  bodyNotes: "This only saves notes consent; no recording or organising has started. It covers the entire conversation, including messages sent before consent. It does not allow message translation, which needs separate agreement from both parents.",
  closeWarning: "Either parent can withdraw. This updates the conversation's consent epoch, so other Nuri conversation permissions may also need confirmation again.",
  allowRequest: "Agree and ask the other parent", allowTranslation: "Allow translation", allowNotes: "Allow", decline: "Do not agree", cancel: "Not now", close: "Back to conversation",
  sent: "Translation consent requested. Only originals are shown until both parents agree.", changed: "The conversation or consent changed. Go back and check again.",
};
const tw: typeof cn = {
  title: "訊息翻譯", translated: "AI 譯文 · 保留原文", loading: "正在核對翻譯偏好與對話許可…", unavailable: "翻譯許可未能核實，目前只顯示原文。",
  preferenceOff: "訊息自動翻譯已關閉。開啟偏好不會自動授權 AI。", preferences: "社區偏好",
  deviceOff: "本機尚未允許 AI，目前只顯示原文。", devicePermission: "查看 AI 使用許可",
  required: "翻譯對方的訊息需要另外取得雙方翻譯許可，不能以對話整理許可取代。",
  waiting: "翻譯請求已送出，等待對方同意；目前只顯示原文。", active: "雙方已允許訊息翻譯，原文始終保留。",
  paused: "翻譯已在本機暫停；請核對雲端許可是否已關閉。", request: "請求翻譯許可", review: "查看翻譯請求", stop: "關閉翻譯許可",
  titleTranslation: "允許翻譯這段對話的訊息？",
  bodyTranslation: "此許可只用於訊息翻譯，不是記錄或整理許可。同意後，你們雙方都可以將本對話中對方的全部文字傳送給 OpenAI 翻譯，包括同意之前的歷史訊息及之後的訊息；原文不會被取代。使用翻譯仍需要各自本機的 AI 許可及自動翻譯偏好。",
  titleNotes: "允許 Nuri 使用這段對話？",
  bodyNotes: "此處僅儲存對話整理許可，目前尚未開始記錄或整理。許可範圍包括本對話的全部內容，也包含同意之前的歷史訊息。這不代表允許訊息翻譯；翻譯需另外取得雙方同意。",
  closeWarning: "任何一方都可關閉。關閉會更新對話許可，其他 Nuri 對話許可也可能需要重新確認。",
  allowRequest: "同意並請求對方", allowTranslation: "同意翻譯", allowNotes: "同意開啟", decline: "不同意", cancel: "暫不請求", close: "返回對話",
  sent: "已請求對方同意翻譯；雙方同意前只顯示原文。", changed: "對話或許可已變更，請返回對話重新核對。",
};
export function communityTranslationCopy(locale: string) { return locale === "en" ? en : locale === "zh-TW" ? tw : cn; }
