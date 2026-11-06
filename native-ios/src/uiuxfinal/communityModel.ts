/** Community navigation and drafts. Server data (questions, replies, parents,
 * messages, consent) lives in CommunityFinal's API state, never here: this
 * reducer only moves between the 42 approved screens, keeps unsent drafts,
 * and advances a flow after the server has confirmed a write. */
export const FINAL_COMMUNITY_NODES = {
    hub: "188:64857", friends: "188:64991", inbox: "188:65390", contacts: "188:65588", invitations: "188:65665",
    intent: "188:61803", profile: "188:61840", suggestions: "188:62059", parent: "188:62018", connected: "188:65516", noMatches: "188:65540",
    chat: "188:65075", consent: "188:65175", chatOn: "188:65290",
    compose: "188:59375", original: "188:59125", polished: "188:59250", preview: "188:60988", sending: "188:60127", sent: "188:60161",
    myQuestions: "188:60269", selection: "188:60337", close: "188:60550", delete: "188:60769", replies: "188:61074", replyExpanded: "188:61480", replyDetail: "188:61420", replyKeyboard: "188:61556", comments: "188:61619",
    received: "188:60178", receivedReplied: "188:60221", receivedLocked: "188:60245", respond: "188:60056", responseSent: "188:59991",
    preferences: "188:62666", blocked: "188:62966", blockedEmpty: "188:62725", profileSettings: "188:63013", safetyConfirm: "188:63131",
    responsePrompt:"188:61687", inviteSent:"188:61884", incomingParent:"188:65771",
} as const;
/** This local safety menu has no corresponding design frame. Keep it out of
 * the Figma node catalog instead of attributing the user's profile frame to it. */
export const FINAL_COMMUNITY_LOCAL_SCREENS = ["parentSettings"] as const;
export type FinalCommunityScreen = keyof typeof FINAL_COMMUNITY_NODES | typeof FINAL_COMMUNITY_LOCAL_SCREENS[number];
export type ReceivedTab = "waiting" | "replied" | "locked";
export type SafetyAction = "block" | "disconnect" | "unblock";
type Location = {
    screen: FinalCommunityScreen;
    /** A server question id ("" when none is open). */
    questionID: string;
    /** The parent's own delivery of that question, for received questions. */
    deliveryID: string;
    /** A public parent_id from the server, and the name to title screens with. */
    person: string;
    personName: string;
    receivedTab: ReceivedTab;
    /** "all" or a server reply id; replyTargetName titles the thread. */
    replyTarget: string;
    replyTargetName: string;
};
export type FinalCommunityState = Location & {
    history: Location[];
    page: 0 | 1;
    inboxExpanded: boolean;
    drafts: Record<string, string>;
    questionVersion: "original" | "polished";
    polishID: string | null;
    showAge: boolean;
    anonymous: boolean;
    selected: string[];
    intents: number[];
    filters: { gender: number; distance: number };
    safetyAction: SafetyAction;
    /** The client key of the question being sent; reused if the send is retried. */
    sendKey: string | null;
    /** A short message for the current screen (a failed write), or null. */
    notice: string | null;
};
/** Screens a deep link may open: none of them needs a server id first. */
export const FINAL_COMMUNITY_ENTRY_SCREENS: readonly FinalCommunityScreen[] = ["hub", "friends", "inbox", "contacts", "invitations", "intent", "profile", "suggestions", "compose", "myQuestions", "received", "receivedReplied", "receivedLocked", "preferences", "blocked", "blockedEmpty", "profileSettings"];
export function isFinalCommunityScreen(value: unknown): value is FinalCommunityScreen { return typeof value === "string" && (Object.hasOwn(FINAL_COMMUNITY_NODES, value) || FINAL_COMMUNITY_LOCAL_SCREENS.some(screen=>screen===value)); }
export function createFinalCommunity(screen: FinalCommunityScreen = "hub"): FinalCommunityState {
    const entry: FinalCommunityScreen = FINAL_COMMUNITY_ENTRY_SCREENS.includes(screen) ? screen : "hub";
    const receivedTab: ReceivedTab = entry === "receivedReplied" ? "replied" : entry === "receivedLocked" ? "locked" : "waiting";
    return { screen: entry, questionID: "", deliveryID: "", person: "", personName: "", receivedTab, replyTarget: "all", replyTargetName: "",
        history: [], page: entry === "friends" || entry === "inbox" ? 1 : 0, inboxExpanded: entry === "inbox",
        drafts: {}, questionVersion: "original", polishID: null, showAge: false, anonymous: false, selected: [], intents: [],
        filters: { gender: 0, distance: 0 }, safetyAction: "block", sendKey: null, notice: null };
}
export function selectedQuestionText(s: FinalCommunityState) { return (s.questionVersion === "polished" ? s.drafts.polished : s.drafts.question)?.trim() ?? ""; }
function isPagerScreen(screen: FinalCommunityScreen) { return screen === "hub" || screen === "friends" || screen === "inbox"; }
function pagerLocation(screen: FinalCommunityScreen, inboxExpanded: boolean): Partial<Pick<FinalCommunityState, "page" | "inboxExpanded">> {
    return screen === "hub" ? { page: 0, inboxExpanded } : screen === "friends" ? { page: 1, inboxExpanded: false } : screen === "inbox" ? { page: 1, inboxExpanded: true } : {};
}
function here(s: FinalCommunityState): Location {
    return { screen: s.screen, questionID: s.questionID, deliveryID: s.deliveryID, person: s.person, personName: s.personName,
        receivedTab: s.receivedTab, replyTarget: s.replyTarget, replyTargetName: s.replyTargetName };
}
function navigate(s: FinalCommunityState, screen: FinalCommunityScreen, patch: Partial<FinalCommunityState> = {}): FinalCommunityState {
    return { ...s, ...patch, ...pagerLocation(screen, patch.inboxExpanded ?? s.inboxExpanded), screen,
        history: isPagerScreen(screen) ? [] : [...s.history, here(s)], notice: patch.notice ?? null };
}
/** Land on a result screen that must not be a Back destination twice. */
function settle(s: FinalCommunityState, screen: FinalCommunityScreen, patch: Partial<FinalCommunityState> = {}): FinalCommunityState {
    return { ...s, ...patch, ...pagerLocation(screen, s.inboxExpanded), screen, history: [], notice: null };
}
export type FinalCommunityEvent =
    | { type: "go"; screen: FinalCommunityScreen }
    | { type: "back" }
    | { type: "page"; page: 0 | 1 }
    | { type: "draft"; slot: string; text: string }
    | { type: "notice"; message: string | null }
    | { type: "newQuestion" }
    | { type: "version"; version: "original" | "polished" }
    | { type: "polished"; text: string; id: string }
    | { type: "toggle"; key: "showAge" | "anonymous" }
    | { type: "intent"; index: number }
    | { type: "setIntents"; intents: number[] }
    | { type: "filter"; key: "gender" | "distance"; index: number }
    | { type: "openQuestion"; id: string }
    | { type: "openReceived"; id: string; deliveryID: string; status: ReceivedTab }
    | { type: "select"; id: string }
    | { type: "receivedTab"; tab: ReceivedTab }
    | { type: "person"; person: string; name: string; screen: "parent" | "chat" | "incomingParent" }
    | { type: "replyTarget"; target: string; name?: string; expanded?: boolean }
    | { type: "safety"; action: SafetyAction; person?: string; name?: string }
    | { type: "previewQuestion" }
    // Results, dispatched only after the server confirmed the write:
    | { type: "sending"; key: string }
    | { type: "sent"; id: string }
    | { type: "sendFailed"; message: string }
    | { type: "questionsChanged" }
    | { type: "responseSent" }
    | { type: "commentSent"; slot: string }
    | { type: "messageSent"; slot: string }
    | { type: "inviteSent" }
    | { type: "connected" }
    | { type: "invitationDeclined" }
    | { type: "safetyDone" }
    | { type: "requestConsent" }
    | { type: "consentClosed"; effective: boolean };
const DISTANCE_MAX = 4, GENDER_MAX = 2;
export function finalCommunityReducer(s: FinalCommunityState, e: FinalCommunityEvent): FinalCommunityState {
    switch (e.type) {
        case "go": return navigate(s, e.screen, e.screen === "receivedReplied" ? { receivedTab: "replied" } : e.screen === "receivedLocked" ? { receivedTab: "locked" } : e.screen === "received" ? { receivedTab: "waiting" } : {});
        case "back": {
            const last = s.history.at(-1);
            return last ? { ...s, ...last, ...pagerLocation(last.screen, s.inboxExpanded), history: s.history.slice(0, -1), notice: null } : navigate(s, s.page ? s.inboxExpanded ? "inbox" : "friends" : "hub");
        }
        case "page": return !isPagerScreen(s.screen) || (e.page !== 0 && e.page !== 1) ? s : { ...s, page: e.page, screen: e.page ? s.inboxExpanded ? "inbox" : "friends" : "hub", history: [] };
        case "draft": return { ...s, drafts: { ...s.drafts, [e.slot]: e.text }, ...(e.slot === "question" || e.slot === "polished" ? { sendKey: null } : {}) };
        case "notice": return { ...s, notice: e.message };
        case "newQuestion": return navigate(s, "compose", { drafts: { ...s.drafts, question: "", polished: "" }, questionVersion: "original", polishID: null, sendKey: null });
        case "version": return { ...s, questionVersion: e.version, screen: e.version, sendKey: null };
        case "polished": return { ...s, drafts: { ...s.drafts, polished: e.text }, polishID: e.id, questionVersion: "polished", screen: "polished", sendKey: null, notice: null };
        case "toggle": return { ...s, [e.key]: !s[e.key], sendKey: null };
        case "intent": return { ...s, intents: s.intents.includes(e.index) ? s.intents.filter(n => n !== e.index) : [...s.intents, e.index].sort() };
        case "setIntents": return { ...s, intents: [...e.intents].sort() };
        case "filter": return !Number.isInteger(e.index) || e.index < 0 || e.index > (e.key === "distance" ? DISTANCE_MAX : GENDER_MAX) ? s : { ...s, filters: { ...s.filters, [e.key]: e.index }, notice: null };
        case "openQuestion": return e.id ? navigate(s, "replies", { questionID: e.id, deliveryID: "", replyTarget: "all", replyTargetName: "" }) : s;
        case "openReceived": return e.id ? navigate(s, e.status === "waiting" ? "responsePrompt" : "replies", { questionID: e.id, deliveryID: e.deliveryID, receivedTab: e.status, replyTarget: "all", replyTargetName: "" }) : s;
        case "select": return { ...s, selected: s.selected.includes(e.id) ? s.selected.filter(id => id !== e.id) : [...s.selected, e.id] };
        case "receivedTab": return { ...s, receivedTab: e.tab, screen: e.tab === "waiting" ? "received" : e.tab === "replied" ? "receivedReplied" : "receivedLocked", notice: null };
        case "person": return e.person ? navigate(s, e.screen, { person: e.person, personName: e.name }) : s;
        case "replyTarget": return navigate(s, e.expanded ? "replyExpanded" : "replyDetail", { replyTarget: e.target, replyTargetName: e.name ?? "" });
        case "safety": return navigate(s, "safetyConfirm", { safetyAction: e.action, ...(e.person ? { person: e.person, personName: e.name ?? s.personName } : {}) });
        case "previewQuestion": return selectedQuestionText(s) ? navigate(s, "preview", { sendKey: s.sendKey }) : s;
        case "sending": return s.screen !== "preview" || !selectedQuestionText(s) ? s : navigate(s, "sending", { sendKey: e.key });
        // Progress is transient, never a Back destination.
        case "sent": return s.screen !== "sending" ? s : settle(s, "sent", { questionID: e.id, sendKey: null, drafts: { ...s.drafts, question: "", polished: "" }, polishID: null });
        // The key is kept: a retry after an unknown outcome must not post twice.
        case "sendFailed": return s.screen !== "sending" ? s : { ...s, screen: "preview", history: s.history.slice(0, -1), notice: e.message };
        case "questionsChanged": return settle(s, "myQuestions", { selected: [] });
        case "responseSent": return settle(s, "responseSent", { drafts: { ...s.drafts, [`answer:${s.questionID}`]: "" }, receivedTab: "replied" });
        case "commentSent": return { ...s, drafts: { ...s.drafts, [e.slot]: "" }, screen: s.replyTarget === "all" ? "replies" : "comments", notice: null };
        case "messageSent": return { ...s, drafts: { ...s.drafts, [e.slot]: "" }, notice: null };
        case "inviteSent": return navigate(s, "inviteSent");
        case "connected": return navigate(s, "connected");
        case "invitationDeclined": return settle(s, "invitations");
        case "safetyDone": return settle(s, s.safetyAction === "unblock" ? "blocked" : "contacts");
        case "requestConsent": return ["chat", "chatOn"].includes(s.screen) ? navigate(s, "consent") : s;
        case "consentClosed": return s.screen !== "consent" ? s : { ...s, screen: e.effective ? "chatOn" : "chat", history: s.history.slice(0, -1) };
    }
}
