/** TestFlight presentation only. No API, native recording, account data or
 * server authority is inferred from these explicitly labelled sample states. */
export type CommunityScreen = "hub" | "intent" | "profile" | "suggestions" | "parent" | "connected" | "contacts" | "chat" | "requests" | "pending" | "withdrawn" | "preferences" | "blocked" | "report" | "block" | "disconnect" | "unblock" | "readonly" | "reported" | "archive" | "deleteArchive" | "archiveEmpty" | "compose" | "editQuestion" | "refine" | "original" | "waiting" | "bottleEmpty" | "replies" | "close" | "ended" | "respond" | "voiceReply" | "responseSent" | "safety" | "recordingReply";
export const COMMUNITY_NODES: Record<CommunityScreen, string> = { safety:"127:24672",recordingReply:"127:25398",hub: "127:25596", intent: "127:25683", profile: "127:25873", suggestions: "127:25921", parent: "127:25742", connected: "127:25782", contacts: "127:24448", chat: "127:24496", requests: "127:24549", pending: "127:24580", withdrawn: "127:24639", preferences: "127:24772", blocked: "127:24909", report: "127:24968", block: "127:25044", disconnect: "127:25070", unblock: "127:25119", readonly: "127:25094", reported: "127:25163", archive: "127:25828", deleteArchive: "127:25213", archiveEmpty: "127:25235", compose: "127:26012", editQuestion: "127:26626", refine: "127:26073", original: "127:26595", waiting: "127:26150", bottleEmpty: "127:26229", replies: "127:26347", close: "127:26301", ended: "127:25475", respond: "127:26432", voiceReply: "127:26505", responseSent: "127:26538" };
export const SAMPLE_PARENTS = ["Maya", "Dean", "Robin", "Ray"] as const;
export type Parent = typeof SAMPLE_PARENTS[number];
type Snapshot = {
    screen: CommunityScreen;
    person: Parent;
};
export type CommunityState = {
    screen: CommunityScreen;
    person: Parent;
    history: Snapshot[];
    mode: 0 | 1;
    connections: Record<Parent, "connected" | "pending" | "disconnected">;
    blocked: Partial<Record<Parent, boolean>>;
    drafts: Record<string, string>;
    messages: {
        person: Parent;
        text: string;
        voice?: boolean;
    }[];
    choices: Record<string, number[]>;
    savedChoices: Record<string, number[]>;
    savedProfile: Record<string, string>;
    setupComplete: boolean;
    editingPreferences: boolean;
    hidden: boolean;
    notifications: boolean;
    anonymous: boolean;
    closed: boolean;
    deleted: boolean;
    archiveIndex: number;
    deletedArchives: number[];
    thanks: number[];
    receipt: boolean;
    variant: "design" | "empty" | "loading" | "error" | "permission";
};
export function createCommunity(): CommunityState { return { screen: "hub", person: "Maya", history: [], mode: 0, connections: { Maya: "connected", Dean: "connected", Robin: "connected", Ray: "connected" }, blocked: {}, drafts: {}, messages: [], choices: { intent: [0], interests: [0], style: [0], gender: [0] }, savedChoices: { intent: [0], interests: [0], style: [0], gender: [0] }, savedProfile:{bio:"",customInterest:""}, setupComplete: true, editingPreferences: false, hidden: false, notifications: true, anonymous: true, closed: false, deleted: false,archiveIndex:0,deletedArchives:[], thanks: [], receipt: false, variant: "design" }; }
export function canSendCommunity(s: CommunityState) { return s.connections[s.person] === "connected" && !s.blocked[s.person]; }
const cloneChoices = (choices: Record<string, number[]>) => Object.fromEntries(Object.entries(choices).map(([k, v]) => [k, [...v]]));
const go = (s: CommunityState, screen: CommunityScreen, patch: Partial<CommunityState> = {}): CommunityState => ({ ...s, ...patch, screen, history: screen === "hub" ? [] : [...s.history, { screen: s.screen, person: s.person }], receipt: false, variant: "design" });
export type CommunityEvent = {
    type: "openArchive";index:number;
} | {
    type: "newQuestion";
} | {
    type: "go";
    screen: CommunityScreen;
} | {
    type: "back";
} | {
    type: "mode";
    value: 0 | 1;
} | {
    type: "draft";
    slot: string;
    text: string;
} | {
    type: "person";
    person: Parent;
    chat?: boolean;
} | {
    type: "choose";
    group: string;
    index: number;
    single?: boolean;
} | {
    type: "beginSetup";
    edit?: boolean;
} | {
    type: "cancelSetup";
} | {
    type: "saveSetup";
} | {
    type: "request";
} | {
    type: "accept";
} | {
    type: "decline";
} | {
    type: "withdraw";
} | {
    type: "send";
    text: string;
    voice?: boolean;
} | {
    type: "safety";
    action: "block" | "unblock" | "disconnect" | "report";
} | {
    type: "toggle";
    key: "hidden" | "notifications" | "anonymous";
} | {
    type: "bottleSend";
} | {
    type: "closeBottle";
} | {
    type: "deleteArchive";
} | {
    type: "thank";
    index: number;
} | {
    type: "reply";
} | {
    type: "variant";
    value: CommunityState["variant"];
};
export function communityReducer(s: CommunityState, e: CommunityEvent): CommunityState {
    switch (e.type) {
        case "openArchive":return !Number.isInteger(e.index)||e.index<0||e.index>3||s.deletedArchives.includes(e.index)?s:go(s,"ended",{archiveIndex:e.index});
        case "newQuestion":return go(s,"compose",{closed:false,drafts:{...s.drafts,question:""}});
        case "go": return e.screen === "chat" && !canSendCommunity(s) ? go(s, "readonly") : go(s, e.screen);
        case "back": {
            const h = s.history.at(-1);
            return h ? { ...s, ...h, history: s.history.slice(0, -1), receipt: false, variant: "design" } : s;
        }
        case "mode": return { ...s, mode: e.value };
        case "draft": return { ...s, drafts: { ...s.drafts, [e.slot]: e.text } };
        case "person": return go(s, e.chat ? (s.blocked[e.person] || s.connections[e.person] !== "connected" ? "readonly" : "chat") : "parent", { person: e.person, receipt: false });
        case "choose": {
            const a = s.choices[e.group] ?? [];
            return { ...s, choices: { ...s.choices, [e.group]: e.single ? [e.index] : a.includes(e.index) ? a.filter(x => x !== e.index) : [...a, e.index] } };
        }
        case "beginSetup": return go(s, e.edit || !s.setupComplete ? "intent" : "suggestions", { editingPreferences: !!e.edit, choices: cloneChoices(s.savedChoices),drafts:{...s.drafts,...s.savedProfile} });
        case "cancelSetup": return go(s, s.editingPreferences ? "preferences" : "hub", { choices: cloneChoices(s.savedChoices),drafts:{...s.drafts,...s.savedProfile}, editingPreferences: false });
        case "saveSetup": return s.screen!=="profile"?s:go(s, s.editingPreferences ? "preferences" : "suggestions", { savedChoices: cloneChoices(s.choices),savedProfile:{bio:s.drafts.bio??"",customInterest:s.drafts.customInterest??""}, setupComplete: true, editingPreferences: false });
        case "request": return s.blocked[s.person] ? s : canSendCommunity(s) ? go(s, "connected") : go(s, "pending", { connections: { ...s.connections, [s.person]: "pending" } });
        case "accept": return !["requests","pending"].includes(s.screen)||s.blocked[s.person]?s:go(s, "connected", { connections: { ...s.connections, [s.person]: "connected" } });
        case "decline": return go(s, "contacts", { connections: { ...s.connections, [s.person]: "disconnected" } });
        case "withdraw": return s.connections[s.person] !== "pending" ? s : go(s, "withdrawn", { connections: { ...s.connections, [s.person]: "disconnected" } });
        case "send": return s.screen!=="chat"||!canSendCommunity(s) || !e.text.trim() || !e.voice&&s.drafts[`chat:${s.person}`]?.trim()!==e.text.trim() ? s : { ...s, messages: [...s.messages, { person: s.person, text: e.text.trim(), voice: e.voice }], drafts: { ...s.drafts, [`chat:${s.person}`]: "" }, receipt: true };
        case "safety": {
            if(s.screen!==({block:"block",unblock:"unblock",disconnect:"disconnect",report:"report"} as const)[e.action])return s;
            if (e.action === "report")
                return !(s.choices.report?.length) ? s : { ...go(s, "reported"), receipt: true };
            if (e.action === "block")
                return { ...go(s, "readonly"), blocked: { ...s.blocked, [s.person]: true }, receipt: true };
            if (e.action === "disconnect")
                return { ...go(s, "readonly"), connections: { ...s.connections, [s.person]: "disconnected" }, receipt: true };
            return { ...go(s, "blocked"), blocked: { ...s.blocked, [s.person]: false }, connections: { ...s.connections, [s.person]: "disconnected" }, receipt: true };
        }
        case "toggle": return { ...s, [e.key]: !s[e.key] };
        case "bottleSend": return !["refine","original"].includes(s.screen)||!s.drafts.question?.trim() ? s : { ...go(s, "waiting"), receipt: true };
        case "closeBottle": return s.screen!=="close"?s:{ ...go(s, "ended"),archiveIndex:0, closed: true, receipt: true };
        case "deleteArchive": return s.screen!=="deleteArchive"||s.deletedArchives.includes(s.archiveIndex)?s:{ ...go(s, "archiveEmpty"), deleted: true,deletedArchives:[...s.deletedArchives,s.archiveIndex], receipt: true };
        case "thank": return { ...s, thanks: s.thanks.includes(e.index) ? s.thanks.filter(i => i !== e.index) : [...s.thanks, e.index] };
        case "reply": return !["respond","voiceReply"].includes(s.screen)||!s.drafts.answer?.trim() ? s : { ...go(s, "responseSent"), receipt: true };
        case "variant": return { ...s, variant: e.value };
    }
}
