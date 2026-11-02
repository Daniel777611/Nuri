/** Presentation fixtures only. No API/storage dependency; resets at session
 * boundaries. Navigation cannot perform a service operation or grant consent. */
export const FINAL_COMMUNITY_NODES = {
    hub: "188:64857", friends: "188:64991", inbox: "188:65390", contacts: "188:65588", invitations: "188:65665",
    intent: "188:61803", profile: "188:61840", suggestions: "188:62059", parent: "188:62018", connected: "188:65516", noMatches: "188:65540",
    chat: "188:65075", consent: "188:65175", chatOn: "188:65290",
    compose: "188:59375", original: "188:59125", polished: "188:59250", preview: "188:60988", sending: "188:60127", sent: "188:60161",
    myQuestions: "188:60269", selection: "188:60337", close: "188:60550", delete: "188:60769", replies: "188:61074", replyExpanded: "188:61480", replyDetail: "188:61420", replyKeyboard: "188:61556", comments: "188:61619",
    received: "188:60178", receivedReplied: "188:60221", receivedLocked: "188:60245", respond: "188:60056", responseSent: "188:59991",
    preferences: "188:62666", blocked: "188:62966", blockedEmpty: "188:62725", parentSettings: "188:63013", safetyConfirm: "188:63131",
} as const;
export type FinalCommunityScreen = keyof typeof FINAL_COMMUNITY_NODES;
export type ReceivedTab = "waiting" | "replied" | "locked";
export type FixtureQuestion = {
    id: string;
    cn: string;
    en: string;
    categoryCN: string;
    categoryEN: string;
    replies: number;
    closed: boolean;
};
export type ReceivedQuestion=FixtureQuestion & {status:ReceivedTab;answer?:string};
export const QUESTION_FIXTURES: readonly FixtureQuestion[] = [
    { id: "sample-daycare", cn: "宝宝每天在托育告别时都会哭。什么方法曾帮助你们平稳度过这个阶段？", en: "My child cries at daycare drop-off every day. What helped your family through this stage?", categoryCN: "托育适应", categoryEN: "Daycare adjustment", replies: 2, closed: false },
    { id: "sample-daycare-second", cn: "宝宝每天在托育告别时都会哭。什么方法曾帮助你们平稳度过这个阶段？", en: "My child cries at daycare drop-off every day. What helped your family through this stage?", categoryCN: "托育适应", categoryEN: "Daycare adjustment", replies: 1, closed: false },
    { id: "sample-sleep", cn: "孩子最近睡前总要反复找爸爸妈妈。你们是怎么建立安心的睡前仪式的？", en: "Our child keeps asking for us at bedtime. How did you establish a reassuring bedtime routine?", categoryCN: "睡眠习惯", categoryEN: "Sleep routines", replies: 5, closed: false },
    { id: "sample-weekend", cn: "周末想带孩子多去户外，有哪些适合一家人慢慢玩的小活动？", en: "What relaxed outdoor activities do you enjoy together as a family?", categoryCN: "亲子陪伴", categoryEN: "Family time", replies: 4, closed: false },
    { id: "sample-food", cn: "孩子吃饭时总想自己动手，但又容易着急。你们会怎样陪他练习？", en: "Our child wants to eat independently but gets frustrated. What helped you practise?", categoryCN: "饮食习惯", categoryEN: "Eating habits", replies: 2, closed: false },
];
export const PARENT_FIXTURES = ["Maya", "Dean", "Sonya", "Jo", "Sam", "Robin", "Lina", "Alex", "Ray", "Maria", "Zoe"] as const;
export type FixtureParent = typeof PARENT_FIXTURES[number];
type Location = {
    screen: FinalCommunityScreen;
    questionID: string;
    person: FixtureParent;
    receivedTab: ReceivedTab;
    replyTarget: string;
};
export type FinalCommunityState = Location & {
    history: Location[];
    page: 0 | 1;
    questions: FixtureQuestion[];
    incoming: ReceivedQuestion[];
    nextQuestionID:number;
    contacts:FixtureParent[];
    filters:{gender:number;distance:number};
    blocked: FixtureParent[];
    disconnected: FixtureParent[];
    preferences:{discoverable:boolean;nearby:boolean;showAge:boolean};
    safetyAction:"block"|"disconnect"|"unblock";
    drafts: Record<string, string>;
    questionVersion: "original" | "polished";
    showAge: boolean;
    anonymous: boolean;
    selected: string[];
    intents: number[];
    ai: Partial<Record<FixtureParent, boolean>>;
    messages: {
        person: FixtureParent;
        text: string;
    }[];
    comments: {
        questionID: string;
        target: string;
        text: string;
    }[];
    localReceipt: boolean;
};
export function isFinalCommunityScreen(value: unknown): value is FinalCommunityScreen { return typeof value === "string" && Object.hasOwn(FINAL_COMMUNITY_NODES, value); }
export function createFinalCommunity(screen: FinalCommunityScreen = "hub"): FinalCommunityState {
    const incoming:ReceivedQuestion[]=(["waiting","replied","locked"] as const).flatMap(status=>QUESTION_FIXTURES.filter(q=>q.id!=="sample-daycare-second").slice(0,status==="waiting"?3:2).map((q,i)=>({...q,id:`received-${status}-${i}`,status,closed:status==="locked",answer:status==="replied"?"A sample family experience / 示例家庭经验":undefined})));
    const receivedTab=screen==="receivedReplied"?"replied":screen==="receivedLocked"?"locked":"waiting";
    return { screen, questionID: screen.startsWith("received")||screen==="respond"?incoming.find(q=>q.status===receivedTab)!.id:QUESTION_FIXTURES[0].id, person: "Maya", receivedTab, history: [], page: screen === "friends" ? 1 : 0, questions: QUESTION_FIXTURES.map(q => ({ ...q })),incoming,nextQuestionID:1,contacts:["Maya","Maria","Zoe"],filters:{gender:0,distance:0},blocked:[],disconnected:[],preferences:{discoverable:true,nearby:true,showAge:false},safetyAction:"block", drafts: {}, questionVersion: "original", showAge: false, anonymous: false, selected: [], intents: [1], ai: {}, messages: [], comments: [], localReceipt: false, replyTarget: "all" };
}
export function selectedFinalQuestion(s:FinalCommunityState){return [...s.questions,...s.incoming].find(q=>q.id===s.questionID);}
export function selectedQuestionText(s:FinalCommunityState){return (s.questionVersion==="polished"?s.drafts.polished:s.drafts.question)?.trim()??"";}
function navigate(s: FinalCommunityState, screen: FinalCommunityScreen, patch: Partial<FinalCommunityState> = {}): FinalCommunityState {
    return { ...s, ...patch, screen, history: screen === "hub" || screen === "friends" ? [] : [...s.history, { screen: s.screen, questionID: s.questionID, person: s.person, receivedTab: s.receivedTab,replyTarget:s.replyTarget }], localReceipt: false };
}
export type FinalCommunityEvent = {
    type:"preference";key:keyof FinalCommunityState["preferences"];value:boolean;
} | {
    type:"safety";action:FinalCommunityState["safetyAction"];person?:FixtureParent;
} | {
    type:"confirmSafety";
} | {
    type:"openReceived";id:string;
} | {
    type:"connect";
} | {
    type:"filter";key:"gender"|"distance";index:number;
} | {
    type: "go";
    screen: FinalCommunityScreen;
} | {
    type: "back";
} | {
    type: "page";
    page: 0 | 1;
} | {
    type: "draft";
    slot: string;
    text: string;
} | {
    type: "newQuestion";
} | {
    type: "version";
    version: "original" | "polished";
} | {
    type: "toggle";
    key: "showAge" | "anonymous";
} | {
    type: "intent";
    index: number;
} | {
    type: "openQuestion";
    id: string;
} | {
    type: "select";
    id: string;
} | {
    type: "receivedTab";
    tab: ReceivedTab;
} | {
    type: "person";
    person: FixtureParent;
    screen: "parent" | "chat";
} | {
    type: "requestConsent";
} | {
    type: "confirmConsent";
    allowed: boolean;
} | {
    type: "disableAI";
} | {
    type: "sendMessage";
} | {
    type: "previewQuestion";
} | {
    type: "sendQuestion";
} | {
    type: "finishSend";
} | {
    type: "confirmQuestions";
    action: "close" | "delete";
} | {
    type: "replyTarget";
    target: string;
    expanded?: boolean;
} | {
    type: "sendComment";
} | {
    type: "sendResponse";
};
export function finalCommunityReducer(s: FinalCommunityState, e: FinalCommunityEvent): FinalCommunityState {
    switch (e.type) {
        case "go": return navigate(s, e.screen, e.screen==="receivedReplied"?{receivedTab:"replied"}:e.screen==="receivedLocked"?{receivedTab:"locked"}:e.screen==="received"?{receivedTab:"waiting"}:{});
        case "back": {
            const last = s.history.at(-1);
            return last ? { ...s, ...last, history: s.history.slice(0, -1), localReceipt: false } : navigate(s, s.page ? "friends" : "hub");
        }
        case "page": return { ...s, page: e.page, screen: e.page ? "friends" : "hub", history: [] };
        case "draft": return { ...s, drafts: { ...s.drafts, [e.slot]: e.text } };
        case "preference":return {...s,preferences:{...s.preferences,[e.key]:e.value}};
        case "safety":return navigate(s,"safetyConfirm",{safetyAction:e.action,...(e.person?{person:e.person}:{})});
        case "confirmSafety":{
            if(s.screen!=="safetyConfirm")return s;
            const blocked=s.safetyAction==="block"?[...new Set([...s.blocked,s.person])]:s.safetyAction==="unblock"?s.blocked.filter(p=>p!==s.person):s.blocked;
            const disconnecting=s.safetyAction!=="unblock";
            return {...s,blocked,disconnected:disconnecting?[...new Set([...s.disconnected,s.person])]:s.disconnected,contacts:disconnecting?s.contacts.filter(p=>p!==s.person):s.contacts,ai:{...s.ai,[s.person]:false},screen:s.safetyAction==="unblock"?"blocked":"contacts",history:[],localReceipt:true};
        }
        case "newQuestion": return navigate(s, "compose", { drafts: { ...s.drafts, question: "", polished: "" }, questionVersion: "original" });
        case "version": return { ...s, questionVersion: e.version, screen: e.version };
        case "toggle": return { ...s, [e.key]: !s[e.key] };
        case "intent": return { ...s, intents: s.intents.includes(e.index) ? s.intents.filter(n => n !== e.index) : [...s.intents, e.index] };
        case "openQuestion": return [...s.questions,...s.incoming].some(q => q.id === e.id) ? navigate(s, "replies", { questionID: e.id, replyTarget: "all" }) : s;
        case "openReceived":{const q=s.incoming.find(q=>q.id===e.id);return q?navigate(s,q.status==="waiting"?"respond":"replies",{questionID:q.id,receivedTab:q.status,replyTarget:"all"}):s;}
        case "select": return !s.questions.some(q => q.id === e.id) ? s : { ...s, selected: s.selected.includes(e.id) ? s.selected.filter(id => id !== e.id) : [...s.selected, e.id] };
        case "receivedTab": return { ...s, receivedTab: e.tab, screen: e.tab === "waiting" ? "received" : e.tab === "replied" ? "receivedReplied" : "receivedLocked" };
        case "person": return PARENT_FIXTURES.includes(e.person) ? navigate(s, e.screen==="chat"&&(s.blocked.includes(e.person)||s.disconnected.includes(e.person))?"parent":e.screen, { person: e.person }) : s;
        case "connect":return s.screen!=="parent"||s.blocked.includes(s.person)?s:{...navigate(s,"connected"),disconnected:s.disconnected.filter(p=>p!==s.person),contacts:s.contacts.includes(s.person)?s.contacts:[...s.contacts,s.person],localReceipt:true};
        case "filter":return e.index<0||e.index>2?s:{...s,filters:{...s.filters,[e.key]:e.index}};
        case "requestConsent": return s.blocked.includes(s.person)||s.disconnected.includes(s.person)||(s.screen !== "chat" && s.screen !== "chatOn") ? s : navigate(s, "consent");
        case "confirmConsent": return s.screen !== "consent" ? s : { ...s, screen:e.allowed?"chatOn":"chat",history:s.history.slice(0,-1),ai: { ...s.ai, [s.person]: e.allowed } };
        case "disableAI": return { ...s, screen: "chat", ai: { ...s.ai, [s.person]: false } };
        case "sendMessage": {
            const slot = `chat:${s.person}`, text = s.drafts[slot]?.trim();
            return !["chat", "chatOn"].includes(s.screen) || s.blocked.includes(s.person) || s.disconnected.includes(s.person) || !text ? s : { ...s, messages: [...s.messages, { person: s.person, text }], drafts: { ...s.drafts, [slot]: "" }, localReceipt: true };
        }
        case "previewQuestion": return !selectedQuestionText(s) ? s : navigate(s, "preview");
        case "sendQuestion": return s.screen !== "preview" || !selectedQuestionText(s) ? s : navigate(s, "sending");
        case "finishSend": {
            if (s.screen !== "sending")
                return s;
            const text = selectedQuestionText(s);
            if(!text)return navigate(s,"compose");
            const id = `local-question-${s.nextQuestionID}`;
            // Progress is transient, never a Back destination: revisiting it
            // would re-run the UI timer and create a duplicate fixture.
            return { ...s,screen:"sent",history:[],questionID:id,nextQuestionID:s.nextQuestionID+1,questions:[{id,cn:text,en:text,categoryCN:"我的问题",categoryEN:"My question",replies:0,closed:false},...s.questions],localReceipt:true };
        }
        case "confirmQuestions": {
            if (s.screen !== e.action || !s.selected.length)
                return s;
            const ids = new Set(s.selected);
            return { ...s,screen:"myQuestions",history:[],questions:e.action==="delete"?s.questions.filter(q=>!ids.has(q.id)):s.questions.map(q=>ids.has(q.id)?{...q,closed:true}:q),selected:[],localReceipt:true };
        }
        case "replyTarget": return selectedFinalQuestion(s)?.closed?s:navigate(s, e.expanded ? "replyExpanded" : "replyDetail", { replyTarget: e.target });
        case "sendComment": {
            const text = s.drafts[`comment:${s.questionID}:${s.replyTarget}`]?.trim();
            if (!text || !selectedFinalQuestion(s) || selectedFinalQuestion(s)?.closed || !["replies", "replyExpanded", "replyDetail", "replyKeyboard", "comments"].includes(s.screen))
                return s;
            return { ...s, screen: "comments",replyTarget:"all", comments: [...s.comments, { questionID: s.questionID, target: s.replyTarget, text }], drafts: { ...s.drafts, [`comment:${s.questionID}:${s.replyTarget}`]: "" }, localReceipt: true };
        }
        case "sendResponse": {
            const text=s.drafts[`answer:${s.questionID}`]?.trim();
            if(s.screen!=="respond"||!text||!s.incoming.some(q=>q.id===s.questionID&&q.status==="waiting"))return s;
            return {...s,screen:"responseSent",history:[],incoming:s.incoming.map(q=>q.id===s.questionID?{...q,status:"replied",answer:text}:q),receivedTab:"replied",localReceipt:true};
        }
    }
}
