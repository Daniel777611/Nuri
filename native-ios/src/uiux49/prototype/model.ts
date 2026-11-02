import { FLOW_SCREENS } from "./screens";

/** Deliberately pure, ephemeral presentation model. No transport, storage,
 * credentials, native permissions, background timers or real account actions. */
export type Origin49 = { screen: string; slot: string };
export type Context49 = { bottleId: string; role: "questioner" | "responder"; replyId: string | null; person: string; personId: string; conversationId: string };
export type FlowState49 = {
  screen: string; history: { screen: string; context: Context49 }[]; context: Context49; ownBottleId:string;
  drafts: Record<string, string>; choices: Record<string, number[]>; identity: "anonymous" | "firstName";
  voiceOrigin: Origin49 | null; attachmentOrigin: Origin49 | null; voiceText: string;
  attachment: boolean; attachmentSlot: string | null; connections: Record<string, "pending" | "mutual" | "disconnected">;
  blocked: Record<string, boolean>; hidden: boolean; closed: Record<string, boolean>;
  messages: { conversationId: string; text: string; attachment: boolean }[];
  receipt: "" | "local"; variant: "design" | "empty" | "loading" | "error" | "permission";
};
const EXTRA_SCREENS = ["matchPending", "communityVoiceReview", "communityAttachment", "communityCameraPermission", "communityImageReview", "prototypeSocial", "prototypeVideo"];
const KEYS = new Set([...FLOW_SCREENS.map(s => s.key), ...EXTRA_SCREENS]);
const CHAT_SCREENS = new Set(["communityNewChat", "communityChat", "communityTyping", "communityTranslation", "communityMeeting", "communitySafety"]);
export function createFlow49(entry: "community" | "notifications" = "community"): FlowState49 {
return { screen: entry, ownBottleId:"demo-bottle-own", history: [], context: { bottleId: "demo-bottle-own", role: "questioner", replyId: null, person: "Maya", personId: "demo-parent-Maya", conversationId: "demo-parent-Maya" }, drafts: {}, choices: {}, identity: "anonymous", voiceOrigin: null, attachmentOrigin: null, voiceText: "", attachment: false, attachmentSlot: null, connections: {}, blocked: {}, hidden: false, closed: {}, messages: [], receipt: "", variant: "design" };
}
export function draftSlot49(state: FlowState49, screen = state.screen, index = 0) {
  const c = state.context;
  if (screen === "bottleCompose" || screen === "bottleRespond" || screen === "bottleRefine") return `${c.bottleId}:${c.role}:${c.replyId ?? "root"}`;
  if (["communityChat", "communityTyping", "communityNewChat", "communityTranslation", "communityMeeting"].includes(screen)) return `chat:${c.conversationId}`;
  return `${screen}:${index}`;
}
export function canChat49(s: FlowState49) { return s.connections[s.context.personId] === "mutual" && !s.blocked[s.context.personId]; }
function visit(s: FlowState49, screen: string, changes: Partial<FlowState49> = {}): FlowState49 {
  const next = { ...s, ...changes };
  if (!KEYS.has(screen) || CHAT_SCREENS.has(screen) && !canChat49(next) || screen === "matchConnected" && !canChat49(next)) return s;
  return { ...next, screen, history: [...s.history, { screen: s.screen, context: { ...s.context } }], variant: "design", receipt: "" };
}
export type FlowEvent49 =
  | { type: "go"; screen: string }
  | { type: "back" }
  | { type: "draft"; slot: string; text: string }
  | { type: "choose"; group: string; index: number; single?: boolean }
  | { type: "identity"; value: FlowState49["identity"] }
  | { type: "variant"; value: FlowState49["variant"] }
  | { type: "person"; name: string; source: "inbox" | "discovery" }
  | { type: "bottle"; role: Context49["role"] }
  | { type: "ownReplies" }
  | { type: "followup" }
  | { type: "refine" }
  | { type: "editOriginal" }
  | { type: "finishRefine"; useEdited: boolean }
  | { type: "deliverBottle" }
  | { type: "replyBottle" }
  | { type: "closeBottle" }
  | { type: "requestMatch" }
  | { type: "simulateMutual" }
  | { type: "icebreaker"; text: string }
  | { type: "voice"; slot: string }
  | { type: "voiceText"; text: string }
  | { type: "voiceReview" }
  | { type: "applyVoice" }
  | { type: "cancelVoice" }
  | { type: "attach"; slot: string }
  | { type: "applyAttachment" }
  | { type: "cancelAttachment" }
  | { type: "removeAttachment" }
  | { type: "reviewBlocked"; personId: string; name: string }
  | { type: "send" }
  | { type: "confirmSafety"; action: "block" | "disconnect" | "report" | "unblock" }
  | { type: "hide"; value: boolean }
  | { type: "localReceipt" };
function returnOrigin(s: FlowState49, origin: Origin49 | null): FlowState49 {
  if (!origin) return s;
  // The entire media subflow is dismissed, not left in Back history.
  let index = s.history.length - 1;
  while (index >= 0 && s.history[index].screen !== origin.screen) index--;
  return { ...s, screen: origin.screen, history: index >= 0 ? s.history.slice(0, index) : s.history, voiceOrigin: null, attachmentOrigin: null, variant: "design" };
}
export function flowReducer49(s: FlowState49, event: FlowEvent49): FlowState49 {
  switch (event.type) {
    case "go": return visit(s, event.screen);
    case "back": {
      if (s.voiceOrigin) return returnOrigin(s, s.voiceOrigin);
      if (s.attachmentOrigin) return returnOrigin(s, s.attachmentOrigin);
      let index = s.history.length - 1;
      while (index >= 0) {
        const previous = s.history[index];
        if (!CHAT_SCREENS.has(previous.screen)&&previous.screen!=="matchConnected" || canChat49({ ...s, context: previous.context })) return { ...s, ...previous, history: s.history.slice(0, index), variant: "design", receipt: "" };
        index--;
      }
      return s;
    }
    case "draft": return { ...s, drafts: { ...s.drafts, [event.slot]: event.text } };
    case "choose": { const current = s.choices[event.group] ?? []; return { ...s, choices: { ...s.choices, [event.group]: event.single ? [event.index] : current.includes(event.index) ? current.filter(i => i !== event.index) : [...current, event.index] } }; }
    case "identity": return { ...s, identity: event.value };
    case "variant": return { ...s, variant: event.value };
    case "person": {
      const id = `demo-parent-${event.name}`;
      const connections = event.source === "inbox" && !s.connections[id] ? { ...s.connections, [id]: "mutual" as const } : s.connections;
      return visit(s, event.source === "inbox" ? "communityNewChat" : "matchDetail", { connections, context: { ...s.context, person: event.name, personId: id, conversationId: id } });
    }
    case "bottle": { const ownBottleId=s.closed[s.ownBottleId]?`demo-bottle-own-${Object.keys(s.closed).length+1}`:s.ownBottleId;return visit(s, event.role === "questioner" ? "bottleCompose" : "bottleRespond", { ownBottleId, context: { ...s.context, bottleId: event.role === "questioner" ? ownBottleId : "demo-bottle-received", role: event.role, replyId: null } }); }
    case "ownReplies": return visit(s, "bottleReplies", { context: { ...s.context, bottleId: s.ownBottleId, role: "questioner", replyId: null } });
    case "followup": return s.closed[s.context.bottleId] ? s : visit(s, "bottleCompose", { context: { ...s.context, role: "questioner", replyId: "demo-reply-Maya" } });
    case "refine": return visit(s, "bottleRefine",{drafts:{...s.drafts,[`refine:${draftSlot49(s)}`]:s.drafts[draftSlot49(s)]??""}});
    case "editOriginal": return visit(s, s.context.role === "responder" ? "bottleRespond" : "bottleCompose");
    case "finishRefine": {
      if(s.screen!=="bottleRefine")return s;
      const slot=draftSlot49(s),text=s.drafts[event.useEdited?`refine:${slot}`:slot]??"";
      return flowReducer49({...s,drafts:{...s.drafts,[slot]:text}},{type:s.context.role==="responder"?"replyBottle":"deliverBottle"});
    }
    case "deliverBottle": return s.context.role !== "questioner" || s.closed[s.context.bottleId] || !s.drafts[draftSlot49(s)]?.trim() ? s : { ...visit(s, "bottleWaiting"), receipt: "local" };
    case "replyBottle": return s.context.role !== "responder" || !s.drafts[draftSlot49(s)]?.trim() ? s : { ...visit(s, "communityInbox"), receipt: "local" };
    case "closeBottle": return s.screen !== "bottleClose" || s.context.role !== "questioner" ? s : { ...visit(s, "community"), closed: { ...s.closed, [s.context.bottleId]: true }, receipt: "local" };
    case "requestMatch": return s.screen !== "matchDetail" ? s : canChat49(s)?visit(s,"matchConnected"):visit(s, "matchPending", { connections: { ...s.connections, [s.context.personId]: "pending" } });
    case "simulateMutual": return s.screen !== "matchPending" || s.connections[s.context.personId] !== "pending" ? s : visit(s, "matchConnected", { connections: { ...s.connections, [s.context.personId]: "mutual" } });
    case "icebreaker": return canChat49(s) ? visit(s, "communityTyping", { drafts: { ...s.drafts, [draftSlot49(s, "communityChat")]: event.text } }) : s;
    case "voice": return visit(s, "communityVoice", { voiceOrigin: { screen: s.screen, slot: event.slot }, voiceText: "" });
    case "voiceText": return { ...s, voiceText: event.text };
    case "voiceReview": return s.voiceOrigin ? visit(s, "communityVoiceReview") : s;
    case "applyVoice": {
      const origin = s.voiceOrigin;
      if (!origin || !s.voiceText.trim()) return s;
      const original = s.drafts[origin.slot] ?? "";
      return returnOrigin({ ...s, drafts: { ...s.drafts, [origin.slot]: [original, s.voiceText.trim()].filter(Boolean).join("\n") }, voiceText: "" }, origin);
    }
    case "cancelVoice": return returnOrigin({ ...s, voiceText: "" }, s.voiceOrigin);
    case "attach": return visit(s, "communityAttachment", { attachmentOrigin: { screen: s.screen, slot: event.slot } });
    case "applyAttachment": return s.attachmentOrigin ? returnOrigin({ ...s, attachment: true, attachmentSlot: s.attachmentOrigin.slot }, s.attachmentOrigin) : s;
    case "cancelAttachment": return returnOrigin(s, s.attachmentOrigin);
    case "removeAttachment": return { ...s, attachment: false, attachmentSlot: null };
    case "reviewBlocked": return s.blocked[event.personId] ? visit(s,"communityUnblock",{context:{...s.context,person:event.name,personId:event.personId,conversationId:event.personId}}) : s;
    case "send": {
      const slot = draftSlot49(s, "communityChat"), text = s.drafts[slot]?.trim() ?? "";
      const attachment=s.attachment&&s.attachmentSlot===slot;
      if (!canChat49(s) || !text && !attachment) return s;
      return { ...visit(s, "communityChat"), drafts: { ...s.drafts, [slot]: "" }, attachment: false, attachmentSlot:null, messages: [...s.messages, { conversationId: s.context.conversationId, text, attachment }], receipt: "local" };
    }
    case "confirmSafety": {
      const id = s.context.personId;
      if (event.action === "report") return s.screen === "communityReport" && (s.choices["communityReport:0"]?.length ?? 0) > 0 ? { ...visit(s, "communityReported"), receipt: "local" } : s;
      if (event.action === "block" && s.screen === "communityBlock") return { ...visit(s, "communityInbox"), blocked: { ...s.blocked, [id]: true }, receipt: "local" };
      if (event.action === "unblock" && s.screen === "communityUnblock") return { ...visit(s, "communityBlocked"), blocked: { ...s.blocked, [id]: false }, receipt: "local" };
      if (event.action === "disconnect" && s.screen === "communityDisconnect") return { ...visit(s, "communityInbox"), connections: { ...s.connections, [id]: "disconnected" }, receipt: "local" };
      return s;
    }
    case "hide": return { ...s, hidden: event.value };
    case "localReceipt": return { ...s, receipt: "local" };
  }
}
