import { NuriTextInput, useAppKeyboardVisible } from "@/src/keyboard/AppKeyboard";
import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { AccessibilityInfo, ActivityIndicator, Animated, Easing, Keyboard, Modal, Platform, Pressable, ScrollView, StyleSheet, View, type NativeScrollEvent, type NativeSyntheticEvent, type ViewStyle } from "react-native";
import { Image } from "expo-image";
import { BlurView } from "expo-blur";
import { useFocusEffect, useLocalSearchParams, usePathname, useRouter } from "expo-router";
import { useT, translate } from "@/src/i18n";
import { registerNativeNavigationGuard } from "@/src/components/nativeNavigation";
import { aiPermissionHref } from "@/src/aiPermissionNavigation";
import { IconAction, NuriKeyboardFrame } from "@/src/uiux48/Primitives";
import { NuriComposer } from "@/src/uiux48/Composer";
import { VoiceInputBar } from "@/src/uiux48/VoiceInputBar";
import * as ImagePicker from "expo-image-picker";
import { ChatImageInputError, pickWebChatImageFile, prepareChatImage, type PreparedChatImage } from "@/src/chatImageInput";
import { MAX_VOICE_SECONDS, VoiceInputError, isVoiceInputSupported, startVoiceRecording, type VoiceRecording } from "@/src/chatVoiceInput";
import { useComposerDockInset } from "@/src/uiux48/useComposerDock";
import { singleLineInputStyle } from "@/src/uiux48/inputLayout";
import { api, apiErrorDetail, isAuthError } from "@/src/api";
import { childAgeLabel, communityApi, communityErrorCode, communityKey, intentCodes, intentIndexes, shortTime, type AIParticipation, type Comment, type Contact, type InboxItem, type Invitation, type Message, type MyProfile, type Preferences, type PublicParent, type Question, type Recommendation, type RelationView, type Reply } from "@/src/communityApi";
import { FinalButton, FinalChatBubble, FinalDivider, FinalSurface, FinalText, FINAL_COLOR } from "./Primitives";
import { ButtonBackdrop, FrostedPressable } from "./ButtonMaterial";
import { ParentChatAvatar, ParentChatHeader } from "./ParentChatHeader";
import { SettingsPage, SettingsRow, SettingsButton } from "./Settings";
import { CommunityProfileEditor } from "./CommunityProfileEditor";
import { createFinalCommunity, finalCommunityReducer, isFinalCommunityScreen, selectedQuestionText, type FinalCommunityEvent, type FinalCommunityScreen, type FinalCommunityState, type ReceivedTab } from "./communityModel";
import { communityHubTopPadding, HUB_PAGINATION, HUB_CARD_BOTTOM_GUTTER, HUB_PAGER_GAP } from "./communityHubLayout";

const TITLE: Partial<Record<FinalCommunityScreen, readonly [string, string]>> = {
  hub: ["社区", "Community"],
  friends: ["社区", "Community"],
  inbox: ["社区", "Community"],
  contacts: ["好友列表", "Friends"],
  invitations: ["新的联系", "New connections"],
  intent: ["交友需求", "What brings you here?"],
  profile: ["我的档案", "My profile"],profileSettings:["我的档案","My profile"],
  suggestions: ["可能聊得来的家长", "Parents you may connect with"],
  parent: ["家长资料", "Parent profile"],
  compose: ["发一个漂流瓶", "Send a bottle"],
  original: ["发一个漂流瓶", "Send a bottle"],
  polished: ["发一个漂流瓶", "Send a bottle"],
  preview: ["发送前，确认一下", "Review before sending"],
  myQuestions: ["我的问题", "My questions"],
  selection: ["我的问题", "My questions"],
  replies: ["漂流瓶回复", "Bottle replies"],
  replyExpanded: ["漂流瓶回复", "Bottle replies"],
  comments: ["漂流瓶回复", "Bottle replies"],
  received: ["收到的问题", "Received questions"],
  receivedReplied: ["收到的问题", "Received questions"],
  receivedLocked: ["收到的问题", "Received questions"],
  respond: ["分享经验", "Share your experience"],
  responseSent: ["回应已发送", "Response sent"],
  responsePrompt:["分享经验","Share your experience"],inviteSent:["已发送","Invitation sent"],incomingParent:["家长资料","Parent profile"],
  preferences:["社区偏好","Community preferences"],blocked:["屏蔽的家长","Blocked parents"],blockedEmpty:["屏蔽的家长","Blocked parents"]
};
/** The six intent chips, by the index the server's INTENT_CODES use. */
const INTENT_LABELS: readonly (readonly [string, string, string])[] = [
  ["交流育儿智慧","Share parenting ideas","Share parenting ideas"],["聊聊育儿心事","Talk about parenting","Talk about parenting"],
  ["与我经历相似","Meet someone with similar experiences","Similar experiences"],["和我一起遛娃","Enjoy outings with children","Outings with children"],
  ["在我附近","Meet nearby parents","Nearby parents"],["随便聊聊","Have a chat","Have a chat"],
];
const ROLE_FILTER = ["any", "mom", "dad"] as const;
const DISTANCE_FILTER = [null, 1, 3, 5, 10] as const;

/** One server read, keyed: a new key (or reload) refetches; a stale answer is dropped. */
type Remote<T> = { value?: T; error?: unknown; loading: boolean; reload: () => void };
function useRemote<T>(key: string | null, load: () => Promise<T>): Remote<T> {
  const [state, setState] = useState<{ key: string | null; value?: T; error?: unknown; loading: boolean }>({ key: null, loading: false });
  const [nonce, setNonce] = useState(0);
  const loader = useRef(load); loader.current = load;
  useEffect(() => {
    if (!key) { setState({ key: null, loading: false }); return; }
    let live = true;
    setState(previous => ({ key, value: previous.key === key ? previous.value : undefined, loading: true }));
    loader.current().then(value => { if (live) setState({ key, value, loading: false }); },
      error => { if (live) setState(previous => ({ key, value: previous.key === key ? previous.value : undefined, error, loading: false })); });
    return () => { live = false; };
  }, [key, nonce]);
  const reload = useCallback(() => setNonce(n => n + 1), []);
  return { value: state.key === key ? state.value : undefined, error: state.key === key ? state.error : undefined, loading: state.loading || state.key !== key, reload };
}

function SampleAvatar({
  size = 40
}: {
  size?: number;
}) {
  const background=size===104?require("@/assets/final-flow-20261101/community-profile-background.svg"):size===36?require("@/assets/final-flow-20261101/community-reply-background.svg"):size===32?require("@/assets/final-flow-20261101/parent-header-avatar-background.svg"):require("@/assets/final-flow-20261101/parent-avatar-background.svg");
  const head=size===104?require("@/assets/final-flow-20261101/community-profile-head.png"):size===32?require("@/assets/final-flow-20261101/parent-header-avatar.png"):require("@/assets/final-flow-20261101/parent-avatar.png");
  return <View style={{width:size,height:size,borderRadius:size/1.5,overflow:"hidden",flexShrink:0}}>
    <Image source={background} style={{width:size,height:size}} contentFit="contain" accessible={false}/>
    <Image source={head} style={{position:"absolute",left:size*.1,top:size*.3083,width:size*19/24,height:size*83/120}} contentFit="fill" accessible={false}/>
  </View>;
}
function RefineAvatar({prompt=false}:{prompt?:boolean}={}){return <View style={{width:40,height:40,flexShrink:0}}>
  <Image source={prompt?require("@/assets/final-flow-20261101/community-prompt-background.svg"):require("@/assets/final-flow-20261101/community-refine-background.svg")} style={{width:40,height:40}} contentFit="contain" accessible={false}/>
  <View style={{position:"absolute",left:3.43,top:7.43,width:32.571,height:32.572,borderRadius:16.286,overflow:"hidden"}}><Image source={prompt?require("@/assets/final-flow-20261101/community-prompt-portrait.png"):require("@/assets/final-flow-20261101/community-refine-portrait.png")} style={{position:"absolute",left:-3.78,top:-.94,width:44.373,height:55.23}} contentFit="fill" accessible={false}/></View>
</View>;}
function CommunitySwitch({value,label,onChange,testID}:{value:boolean;label:string;onChange:()=>void;testID?:string}){return <Pressable accessibilityRole="switch" accessibilityLabel={label} accessibilityState={{checked:value}} aria-checked={value} onPress={onChange} testID={testID} style={{width:44,height:44,alignItems:"center",justifyContent:"center"}}>
  <Image source={value?require("@/assets/final-flow-20261101/parent-ai-on.svg"):require("@/assets/final-flow-20261101/parent-ai-off.svg")} style={{width:44,height:44}} contentFit="contain" accessible={false}/>
</Pressable>;}
function ConnectionPortrait({purple=false}:{purple?:boolean}){return <View style={{width:146,height:146,borderRadius:73,overflow:"hidden"}}><Image source={purple?require("@/assets/final-flow-20261101/community-connected-purple.svg"):require("@/assets/final-flow-20261101/community-connected-pink.svg")} style={{width:146,height:146}} contentFit="contain" accessible={false}/><Image source={require("@/assets/final-flow-20261101/community-connected-head.png")} style={{position:"absolute",left:14.6,top:45.016,width:115.583,height:100.983}} contentFit="fill" accessible={false}/></View>;}
function BottleSendVisual(){
  const ring=useRef(new Animated.Value(0)).current,float=useRef(new Animated.Value(0)).current;
  const [reduced,setReduced]=useState(true);
  useEffect(()=>{let active=true;AccessibilityInfo.isReduceMotionEnabled().then(value=>{if(active)setReduced(value);});const subscription=AccessibilityInfo.addEventListener("reduceMotionChanged",setReduced);return()=>{active=false;subscription.remove();};},[]);
  useEffect(()=>{
    ring.setValue(0);float.setValue(0);if(reduced)return;
    const native=Platform.OS!=="web",bob=Easing.bezier(.42,0,.58,1);
    const loop=Animated.loop(Animated.parallel([
      Animated.timing(ring,{toValue:1,duration:2400,easing:Easing.linear,useNativeDriver:native}),
      Animated.sequence([1,0,1,0].map(toValue=>Animated.timing(float,{toValue,duration:600,easing:bob,useNativeDriver:native})))
    ]));loop.start();return()=>loop.stop();
  },[reduced,ring,float]);
  return <View testID="final-bottle-sending-visual" style={{width:128,height:128}}>
    <Animated.View style={{position:"absolute",left:32,top:32,width:64,height:64,transform:[{rotate:ring.interpolate({inputRange:[0,1],outputRange:["0rad","9.425rad"]})}]}}><Image source={require("@/assets/final-flow-20261101/community-sending-ring.svg")} style={{width:64,height:64}} contentFit="contain" accessible={false}/></Animated.View>
    <Animated.View style={{position:"absolute",left:49.5,top:49.5,width:29,height:29,alignItems:"center",justifyContent:"center",transform:[{translateY:float.interpolate({inputRange:[0,1],outputRange:[0,-7]})},{rotate:float.interpolate({inputRange:[0,1],outputRange:["0rad","-.052rad"]})}]}}><Image source={require("@/assets/final-flow-20261101/community-bottle-sending.svg")} style={{width:10.9688,height:23.2031,transform:[{rotate:"45deg"}]}} contentFit="contain" accessible={false}/></Animated.View>
  </View>;
}
function Search({ value, onChange, placeholder, compact=false, iconSize=16 }: { value: string; onChange: (v: string) => void; placeholder: string; compact?: boolean; iconSize?:16|20; }) {
  return <View style={{height:compact?28:36,borderRadius:24,backgroundColor:"rgba(255,255,255,.8)",justifyContent:"center",alignSelf:"stretch",minWidth:0}}>
    {!value?<View pointerEvents="none" style={{position:"absolute",left:0,right:0,flexDirection:"row",alignItems:"center",justifyContent:"center",gap:4}}><Image source={iconSize===20?require("@/assets/final-flow-20261101/community-question-search.png"):require("@/assets/final-flow-20261101/community-search.png")} style={{width:iconSize,height:iconSize,opacity:.46}} contentFit="contain" accessible={false}/><FinalText size={compact?12:14} secondary style={{lineHeight:20}}>{placeholder}</FinalText></View>:null}
    <NuriTextInput testID="final-community-search" accessibilityLabel={placeholder} value={value} onChangeText={onChange} placeholderTextColor="#918896" style={{...singleLineInputStyle,height:compact?28:36,borderRadius:24,paddingHorizontal:16,color:FINAL_COLOR.ink,fontSize:compact?12:14}}/>
  </View>;
}
function FriendPreviewAvatar() {
  return <View style={{width:40,height:40,borderRadius:40/1.5,overflow:"hidden"}}>
    <Image source={require("@/assets/final-flow-20261101/parent-avatar-background.svg")} style={{width:40,height:40}} contentFit="contain" accessible={false}/>
    <Image source={require("@/assets/final-flow-20261101/parent-avatar.png")} style={{position:"absolute",left:4,top:12.332,width:31.667,height:27.667}} contentFit="fill" accessible={false}/>
  </View>;
}
function UnreadBadge({count,style}:{count:number;style:ViewStyle}){
  if(!count)return null;
  return <View pointerEvents="none" style={[{width:14,height:15.273,alignItems:"center",justifyContent:"center"},style]}><Image source={require("@/assets/final-flow-20261101/parent-unread.svg")} style={{position:"absolute",width:14,height:15.273}} contentFit="contain" accessible={false}/><FinalText size={10} style={{lineHeight:14,color:"white"}}>{count>9?"9+":count}</FinalText></View>;
}

/** Signed read URLs are short-lived (300 s); keep each until shortly before it expires. */
const mediaUrls=new Map<string,{url:string;until:number}>();
function CommunityImage({mediaId,label}:{mediaId:string;label:string}){
  const cached=mediaUrls.get(mediaId);
  const [url,setUrl]=useState<string|null>(cached&&cached.until>Date.now()?cached.url:null);
  const [failed,setFailed]=useState(false);
  useEffect(()=>{
    if(url||failed)return;
    let live=true;
    communityApi.mediaAccess(mediaId).then(result=>{mediaUrls.set(mediaId,{url:result.access.url,until:Date.now()+Math.max(30,result.access.expires_in_s-30)*1000});if(live)setUrl(result.access.url);},()=>{if(live)setFailed(true);});
    return()=>{live=false;};
  },[mediaId,url,failed]);
  return <View testID={"final-parent-image-"+mediaId} accessible accessibilityLabel={label} style={{width:200,height:200,borderRadius:16,overflow:"hidden",backgroundColor:"rgba(115,92,132,.08)",alignItems:"center",justifyContent:"center"}}>
    {url?<Image source={{uri:url}} style={{width:200,height:200}} contentFit="cover" accessible={false} onError={()=>{mediaUrls.delete(mediaId);setFailed(true);setUrl(null);}}/>:failed?<FinalText size={12} secondary>{label}</FinalText>:<ActivityIndicator color={FINAL_COLOR.accent}/>}
  </View>;
}

/** The Community hub and its 42 approved states, on the live Community API
 * (/api/community/v1). Navigation and drafts are local; every send, answer,
 * invitation, block and consent decision is a server write, and a flow moves
 * on only after the server confirmed it. */
export default function CommunityFinal() {
  const { uiState } = useLocalSearchParams<{ uiState?: string; }>();
  const [state, dispatchState] = useReducer(finalCommunityReducer, isFinalCommunityScreen(uiState) ? uiState : "hub", createFinalCommunity);
  const [width, setWidth] = useState(0),
    [pagerHeight, setPagerHeight] = useState(0),
    [search, setSearch] = useState(""),
    [filter, setFilter] = useState<"gender" | "distance" | null>(null),
    [filterAnchor,setFilterAnchor]=useState<{left:number;top:number;width:number}|null>(null),
    [filterViewport,setFilterViewport]=useState<{left:number;top:number;width:number;height:number}|null>(null),
    [profileEditing,setProfileEditing]=useState(false),
    [selectionMenu,setSelectionMenu]=useState(false),
    [replyKeyboardVisible,setReplyKeyboardVisible]=useState(false),
    [questionFocusedInput,setQuestionFocusedInput]=useState<"question"|"polished"|null>(null),
    [busy,setBusy]=useState(false),
    [consentNeeded,setConsentNeeded]=useState(false),
    [tick,setTick]=useState(0);
  const { locale } = useT();
  const en = locale === "en";
  const appKeyboardVisible=useAppKeyboardVisible();
  const router = useRouter(), path = usePathname();
  const pager = useRef<ScrollView>(null),
    pagerWidth = useRef(width),
    pagerAligned = useRef<{host:ScrollView;width:number;page:0|1}|null>(null),
    messages = useRef<ScrollView>(null),
    latest = useRef(state),
    questionFocusEpoch=useRef(0),
    mounted=useRef(true),
    /** slot → the client key of its current text, so a retry reuses it. */
    writeKeys=useRef<Record<string,{text:string;key:string}>>({}),
    /** parent_id → a conversation already known from the inbox/contacts. */
    knownConversations=useRef<Record<string,string>>({}),
    consentPrompted=useRef<string|null>(null),
    profileSeeded=useRef(false),
    /** How many parents the last sent question reached; the sent page says so. */
    lastRecipients=useRef<number|null>(null);
  pagerWidth.current = width;
  latest.current = state;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const c = (cn: string, english: string) => en ? english : translate(locale, cn);
  const intentLabel=(index:number,short=false)=>{const l=INTENT_LABELS[index];return l?c(l[0],short?l[2]:l[1]):"";};
  const nameOf=(p:PublicParent|null|undefined)=>!p||p.anonymous||!p.parent_id?c("匿名家长","Anonymous parent"):p.display_name;
  const keyFor=(slot:string,text:string,tag:string)=>{const current=writeKeys.current[slot];if(current&&current.text===text)return current.key;const key=communityKey(tag);writeKeys.current[slot]={text,key};return key;};
  const refresh=()=>setTick(t=>t+1);

  const filterControls=useRef<Partial<Record<"gender"|"distance",View|null>>>({}),filterModal=useRef<View|null>(null),filterRequest=useRef(0),filterOpen=useRef<"gender"|"distance"|null>(null),filterMounted=useRef(true),filterFocused=useRef(true),filterBounds=useRef<{left:number;top:number;width:number;height:number}|null>(null);
  const closeFilter=useCallback(()=>{
    filterRequest.current++;filterOpen.current=null;
    setFilter(null);setFilterAnchor(null);
  },[]);
  useEffect(()=>{filterMounted.current=true;return()=>{filterMounted.current=false;filterOpen.current=null;filterRequest.current++;};},[]);
  useFocusEffect(useCallback(()=>{filterFocused.current=true;return()=>{filterFocused.current=false;closeFilter();};},[closeFilter]));
  const openFilter=(key:"gender"|"distance")=>{
    if(!filterMounted.current||!filterFocused.current||latest.current.screen!=="suggestions")return;
    if(filterOpen.current){closeFilter();return;}
    const control=filterControls.current[key];
    if(!control)return;
    const request=++filterRequest.current;
    filterOpen.current=key;filterBounds.current=null;
    setFilterViewport(null);setFilterAnchor(null);setFilter(key);
    control.measureInWindow((x,y,width,height)=>{
      if(!filterMounted.current||!filterFocused.current||filterRequest.current!==request||filterOpen.current!==key||latest.current.screen!=="suggestions")return;
      if(![x,y,width,height].every(Number.isFinite)||width<=0||height<=0){closeFilter();return;}
      setFilterAnchor({left:x,top:y+height+8,width:144});
    });
  };
  const go = (screen: FinalCommunityScreen) => dispatch({ type: "go", screen });
  const home = state.screen === "hub" || state.screen === "friends" || state.screen === "inbox";
  const searchScope = home ? "pager" : state.screen;
  const parentChat = ["chat", "chatOn", "consent"].includes(state.screen);
  const dockBottom = useComposerDockInset(parentChat);
  const bottle = !["hub", "friends", "inbox", "contacts", "invitations", "preferences", "blocked", "blockedEmpty", "profileSettings", "parentSettings", "safetyConfirm"].includes(state.screen) && !parentChat;
  const presentation = (next:FinalCommunityState) => {
    const chat=["chat","chatOn","consent"].includes(next.screen);
    const hub=next.screen==="hub"||next.screen==="friends"||next.screen==="inbox";
    const settings=["preferences","blocked","blockedEmpty","profileSettings","parentSettings","safetyConfirm"].includes(next.screen);
    const bottle=!hub&&!["inbox","contacts","invitations"].includes(next.screen)&&!settings&&!chat;
    return {
      flowTitle:chat||["connected","noMatches","incomingParent","parentSettings","safetyConfirm"].includes(next.screen)?next.personName:["replyDetail","replyKeyboard","comments"].includes(next.screen)?c("回复","Reply to ")+(next.replyTargetName||c("家长","parent")):TITLE[next.screen]?c(...TITLE[next.screen]!):c("社区","Community"),
      communityHeader:chat?"parent-chat":["sent","sending"].includes(next.screen)?"feedback":next.screen==="blocked"?"blocked-list":["intent","profile","profileSettings","suggestions","parent","connected","noMatches","invitations","contacts","incomingParent","inviteSent","preferences","blockedEmpty","parentSettings","safetyConfirm"].includes(next.screen)?"regular":"default",
      communityBackdrop:settings||next.screen==="profile"&&profileEditing?"settings":chat?"plain":bottle?"final-bottle":"final-unified",
      communityHideTabs:hub||["inbox","contacts","invitations"].includes(next.screen)?"0":"1",
      communityHideAvatar:["preferences","blocked","blockedEmpty"].includes(next.screen)?"1":"0",
      communityHideBack:hub||["inbox","contacts","invitations"].includes(next.screen)?"1":"0"
    };
  };
  const setProfileEditingMode=(editing:boolean)=>{router.setParams({...presentation(latest.current),communityBackdrop:editing||latest.current.screen==="profileSettings"?"settings":"final-bottle"});setProfileEditing(editing);};
  const title=presentation(state).flowTitle;
  const dispatch = (event:FinalCommunityEvent) => {
    const previous=latest.current,next=finalCommunityReducer(previous,event);
    if(["compose","original","polished"].includes(previous.screen)&&!["compose","original","polished"].includes(next.screen)){
      questionFocusEpoch.current++;
      setQuestionFocusedInput(null);
    }
    if(next.screen!==previous.screen||next.personName!==previous.personName)router.setParams(presentation(next));
    latest.current=next;
    dispatchState(event);
  };
  /** What a failed write tells the parent. Never a fake success. */
  const failure=(error:unknown)=>{
    const code=communityErrorCode(error),detail=apiErrorDetail(error);
    if(isAuthError(error))return c("登录已失效，请重新登录","Please sign in again");
    if(code==="RATE_LIMITED")return c("今天发送得有点多，请稍后再试","You've sent a lot today; please try again later");
    if(code==="CONSENT_REQUIRED"||(error as any)?.aiConsentRequired){setConsentNeeded(true);return c("需要先允许使用 AI 功能","AI permission is needed first");}
    if(code==="QUESTION_CLOSED")return c("这个问题已关闭","This question is closed");
    if(code==="DELIVERY_LOCKED")return c("这个问题已经不能回答了","This question can no longer be answered");
    if(code==="BLOCKED_OR_DISCONNECTED")return c("你们已不再联系，无法发送","You're no longer connected");
    if(code==="RELATIONSHIP_NOT_ALLOWED")return c("需要先建立联系","Connect first");
    if(code==="VERSION_CONFLICT")return c("内容已在其他设备更新，请重试","This changed on another device; please try again");
    if(code==="VALIDATION_FAILED"&&/community profile/i.test(detail))return c("请先建立你的社区档案","Create your community profile first");
    if(code==="VALIDATION_FAILED"&&/location/i.test(detail))return c("按距离筛选需要先分享大概位置","Share an approximate location to filter by distance");
    if(code==="VALIDATION_FAILED")return c("内容不符合要求，请修改后再试","Please check the content and try again");
    return c("网络或服务暂时不可用，请稍后重试","The service is unavailable; please try again");
  };
  /** Run one server write; on failure keep the drafts and show why. */
  const write=async(run:()=>Promise<void>)=>{
    if(busy)return;
    setBusy(true);
    try{await run();}
    catch(error){if(mounted.current)dispatch({type:"notice",message:failure(error)});}
    finally{if(mounted.current)setBusy(false);}
  };

  // ── Server reads, by screen ───────────────────────────────────────────────
  const s=state.screen;
  const onProfile=["intent","profile","profileSettings","compose","preview","hub"].includes(s);
  const me=useRemote(onProfile?`profile:${tick}`:null,()=>communityApi.myProfile());
  const account=useRemote<{nickname?:string;city?:string}>(["profile","profileSettings","intent"].includes(s)?"account":null,()=>api.me());
  const hub=useRemote(home?`hub:${tick}`:null,async()=>{
    const [questions,waiting,inbox]=await Promise.all([communityApi.myQuestions({status:"all"}),communityApi.deliveries("waiting"),communityApi.inbox()]);
    for(const item of inbox.items)if(item.parent?.parent_id)knownConversations.current[item.parent.parent_id]=item.conversation_id;
    return {questions:questions.items,waiting:waiting.items,inbox};
  });
  const relations=useRemote(["contacts","invitations"].includes(s)?`relations:${tick}`:null,async()=>{
    const [contacts,received,sent,inbox]=await Promise.all([communityApi.contacts(),communityApi.invitations("received"),communityApi.invitations("sent"),communityApi.inbox()]);
    for(const item of contacts.items)if(item.conversation_id&&item.parent.parent_id)knownConversations.current[item.parent.parent_id]=item.conversation_id;
    return {contacts:contacts.items,received:received.items,sent:sent.items,pending:inbox.summary.pending_invitations};
  });
  const roleFilter=ROLE_FILTER[state.filters.gender]??"any",distanceFilter=DISTANCE_FILTER[state.filters.distance]??null;
  const suggestions=useRemote(s==="suggestions"?`rec:${roleFilter}:${distanceFilter}:${tick}`:null,()=>communityApi.recommendations({role:roleFilter,distance_miles:distanceFilter}));
  const parentView=useRemote(["parent","incomingParent","connected","parentSettings","safetyConfirm"].includes(s)&&state.person?`parent:${state.person}:${tick}`:null,()=>communityApi.parent(state.person));
  const mine=useRemote(["myQuestions","selection","close","delete"].includes(s)?`mine:${tick}`:null,()=>communityApi.myQuestions({status:"all"}));
  const received=useRemote(["received","receivedReplied","receivedLocked"].includes(s)?`received:${state.receivedTab}:${tick}`:null,()=>communityApi.deliveries(state.receivedTab));
  const threadScreens=["replies","comments","replyExpanded","replyDetail","replyKeyboard"];
  const replies=useRemote(threadScreens.includes(s)&&state.questionID?`replies:${state.questionID}:${tick}`:null,()=>communityApi.replies(state.questionID));
  const allThread=replies.value?.all_thread;
  const comments=useRemote(threadScreens.includes(s)&&state.questionID&&(state.replyTarget!=="all"||allThread)?`comments:${state.questionID}:${state.replyTarget}:${tick}`:null,()=>communityApi.comments(state.questionID,state.replyTarget));
  const askedQuestion=useRemote(["respond","responsePrompt"].includes(s)&&state.questionID?`question:${state.questionID}`:null,()=>communityApi.question(state.questionID));
  const prefs=useRemote(s==="preferences"?`prefs:${tick}`:null,()=>communityApi.preferences());
  const blocks=useRemote(["blocked","blockedEmpty"].includes(s)?`blocks:${tick}`:null,()=>communityApi.blocks());
  const chat=useRemote(parentChat&&state.person?`chat:${state.person}:${tick}`:null,async()=>{
    let conversationId=knownConversations.current[state.person];
    if(!conversationId){conversationId=(await communityApi.openConversation(state.person,communityKey("conv"))).conversation.conversation_id;knownConversations.current[state.person]=conversationId;}
    const [list,ai]=await Promise.all([communityApi.messages(conversationId),communityApi.aiParticipation(conversationId)]);
    return {conversationId,conversation:list.conversation,messages:list.items,ai};
  });
  // New messages from the other parent arrive while the chat is open.
  useEffect(()=>{if(!parentChat)return;const timer=setInterval(()=>chat.reload(),8000);return()=>clearInterval(timer);},[parentChat,chat.reload]);
  // Reading the chat moves this parent's read cursor, never the other's.
  const lastSeq=chat.value?.messages.at(-1)?.seq;
  useEffect(()=>{if(chat.value&&lastSeq)communityApi.markRead(chat.value.conversationId,lastSeq).catch(()=>{});},[chat.value?.conversationId,lastSeq]);
  // A consent request from the other parent opens the decision sheet once.
  const incomingConsent=chat.value?.ai.requests.conversation_notes;
  useEffect(()=>{
    if(!incomingConsent||incomingConsent.state!=="pending"||incomingConsent.initiated_by!=="parent"||incomingConsent.my_decision!=="pending")return;
    if(consentPrompted.current===incomingConsent.request_id||!["chat","chatOn"].includes(latest.current.screen))return;
    consentPrompted.current=incomingConsent.request_id;dispatch({type:"requestConsent"});
  },[incomingConsent?.request_id,incomingConsent?.state,incomingConsent?.my_decision]);
  // The editor starts from the saved profile, once per visit.
  useEffect(()=>{
    if(!["intent","profile","profileSettings"].includes(s)){profileSeeded.current=false;return;}
    if(profileSeeded.current||!me.value)return;
    profileSeeded.current=true;
    if(me.value.profile)dispatch({type:"setIntents",intents:intentIndexes(me.value.profile.intents)});
  },[s,me.value]);

  // ── Pager plumbing (unchanged from the approved design) ──────────────────
  let pagerHost = pager.current;
  const currentPager = () => { const host=pager.current; if(!pagerHost)pagerHost=host; return host&&host===pagerHost?host:null; };
  const alignPager = () => {
    if(!filterMounted.current||!home||!width||pagerWidth.current!==width||!["hub","friends","inbox"].includes(latest.current.screen))return;
    const host=currentPager();if(!host)return;
    if(pagerAligned.current?.host!==host)pagerAligned.current=null;
    if(!pagerAligned.current&&latest.current.page===0)pagerAligned.current={host,width,page:0};
    host.scrollTo({x:width*latest.current.page,animated:false});
  };
  const settlePager = (event:NativeSyntheticEvent<NativeScrollEvent>) => {
    const {contentOffset,layoutMeasurement}=event.nativeEvent;
    const observedWidth=layoutMeasurement?.width;
    if(!filterMounted.current||!home||!width||pagerWidth.current!==width||!["hub","friends","inbox"].includes(latest.current.screen)||typeof observedWidth!=="number"||!Number.isFinite(observedWidth)||Math.abs(observedWidth-width)>=1||!Number.isFinite(contentOffset.x))return;
    const host=currentPager();if(!host)return;
    const page=Math.abs(contentOffset.x)<=1?0:Math.abs(contentOffset.x-width)<=1?1:null;
    if(page===null)return;
    if(Platform.OS==="web"&&(pagerAligned.current?.host!==host||pagerAligned.current.width!==width||pagerAligned.current.page!==latest.current.page)){
      if(page===latest.current.page)pagerAligned.current={host,width,page};
      return;
    }
    pagerAligned.current={host,width,page};
    if(page!==latest.current.page)dispatch({type:"page",page});
  };
  useFocusEffect(useCallback(() => {
    router.setParams(presentation(state));
    return registerNativeNavigationGuard(path, action => {
      if(filterOpen.current){closeFilter();return;}
      if (action === "back" && latest.current.history.length) { dispatch({ type: "back" }); return; }
      const routes = { home: "/(tabs)", chat: "/(tabs)/chats", community: "/community", notifications: "/notifications", profile: "/(tabs)/profile" } as const;
      if (action === "back") router.dismissTo("/(tabs)");else router.navigate(routes[action]);
    });
  }, [router, path, title, parentChat, bottle, home, state.screen,profileEditing,closeFilter]));
  // Coming back to Community (another tab, a notification) re-reads everything.
  const focusedOnce=useRef(false);
  useFocusEffect(useCallback(()=>{if(focusedOnce.current)refresh();focusedOnce.current=true;},[]));
  useEffect(() => { if(!home){pagerAligned.current=null;return;} alignPager(); }, [home, width, state.page]);
  useEffect(() => { closeFilter(); setProfileEditing(false); setConsentNeeded(false); }, [state.screen, state.person,closeFilter]);
  useEffect(() => { setSearch(""); }, [searchScope, state.person]);
  useEffect(()=>{
    if(state.screen!=="replyExpanded")return;
    setReplyKeyboardVisible(Keyboard?.isVisible?.()??false);
    const show=Keyboard?.addListener("keyboardDidShow",()=>setReplyKeyboardVisible(true)),hide=Keyboard?.addListener("keyboardDidHide",()=>setReplyKeyboardVisible(false));
    return()=>{show?.remove();hide?.remove();};
  },[state.screen]);

  const draft = (slot: string) => state.drafts[slot] ?? "";
  const setDraft = (slot: string, text: string) => dispatch({ type: "draft", slot, text });
  // ── Voice input: a recording becomes editable draft text (D14), never a message by itself.
  const [voice,setVoice]=useState<{slot:string;phase:"starting"|"recording"|"transcribing";seconds:number;metered:boolean}|null>(null);
  const voiceRef=useRef<{recording:VoiceRecording|null;slot:string|null;version:number;timer:ReturnType<typeof setInterval>|null}>({recording:null,slot:null,version:0,timer:null});
  const stopVoiceTimer=()=>{if(voiceRef.current.timer)clearInterval(voiceRef.current.timer);voiceRef.current.timer=null;};
  const cancelVoice=useCallback(()=>{
    const v=voiceRef.current;v.version++;if(v.timer)clearInterval(v.timer);v.timer=null;v.recording?.cancel();v.recording=null;v.slot=null;setVoice(null);
  },[]);
  // Leaving the screen, the parent or the app always releases the microphone.
  useEffect(()=>cancelVoice,[state.screen,state.person,cancelVoice]);
  useFocusEffect(useCallback(()=>()=>cancelVoice(),[cancelVoice]));
  const voiceError=(error:unknown)=>{
    const code=error instanceof VoiceInputError?error.code:"";
    dispatch({type:"notice",message:code==="permission_denied"?c("需要麦克风权限才能语音输入，请在系统设置中允许","Microphone access is needed for voice input"):code==="unsupported"?c("当前设备不支持语音输入，可以改用文字","Voice input isn't available here; please type"):code==="no_microphone"?c("没有找到可用的麦克风","No microphone was found"):code==="too_short"?c("说话时间太短","That was too short"):failure(error)});
  };
  const stopVoice=async(sendAfter=false)=>{
    const v=voiceRef.current,{recording,slot,version}=v;
    if(!recording||!slot)return;
    v.recording=null;stopVoiceTimer();
    setVoice(current=>current?{...current,phase:"transcribing"}:current);
    let spoken="";
    try{
      const clip=await recording.stop();
      if(version!==v.version)return;
      spoken=((await communityApi.transcribe(clip,locale,communityKey("asr"))).draft_text||"").trim();
      if(version!==v.version){spoken="";return;}
      if(!spoken){dispatch({type:"notice",message:c("没有听清，请再说一次","Didn't catch that; please try again")});return;}
      const before=latest.current.drafts[slot]??"";
      dispatch({type:"draft",slot,text:before.trim()?before.trimEnd()+" "+spoken:spoken});
    }catch(error){if(version===v.version)voiceError(error);spoken="";}
    finally{if(version===v.version){v.slot=null;setVoice(null);}}
    if(spoken&&sendAfter&&slot.startsWith("chat:"))void sendChat();
  };
  const startVoice=async(slot:string)=>{
    if(voiceRef.current.slot||busy)return;
    if(!isVoiceInputSupported()){voiceError(new VoiceInputError("unsupported"));return;}
    Keyboard.dismiss();
    const v=voiceRef.current,version=++v.version;
    v.slot=slot;setVoice({slot,phase:"starting",seconds:0,metered:false});
    try{
      const recording=await startVoiceRecording();
      if(version!==v.version||!mounted.current){recording.cancel();return;}
      v.recording=recording;
      const started=Date.now();
      setVoice({slot,phase:"recording",seconds:0,metered:recording.level()!==null});
      v.timer=setInterval(()=>{const seconds=Math.floor((Date.now()-started)/1000);setVoice(current=>current&&current.phase==="recording"?{...current,seconds}:current);if(seconds>=MAX_VOICE_SECONDS)void stopVoice();},250);
    }catch(error){if(version===v.version){v.slot=null;setVoice(null);voiceError(error);}}
  };
  const voiceBar=(slot:string)=>voice&&voice.slot===slot?<VoiceInputBar phase={voice.phase} seconds={voice.seconds} metered={voice.metered} level={()=>voiceRef.current.recording?.level()??null} onCancel={cancelVoice} onStop={()=>void stopVoice(false)} onSend={()=>void stopVoice(slot.startsWith("chat:"))}/>:null;
  // ── One photo per parent message, prepared like the NURI chat's (≤1600 px).
  const [chatImage,setChatImage]=useState<{person:string;prepared:PreparedChatImage}|null>(null);
  useEffect(()=>{setChatImage(current=>current&&current.person!==state.person?null:current);},[state.person]);
  const pickChatImage=async()=>{
    if(busy||voiceRef.current.slot)return;
    try{
      let asset:ImagePicker.ImagePickerAsset|null=null;
      if(Platform.OS==="web")asset=await pickWebChatImageFile();
      else{
        // The system photo picker grants access to the chosen photo only.
        const result=await ImagePicker.launchImageLibraryAsync({mediaTypes:["images"],allowsEditing:false,allowsMultipleSelection:false,base64:false,exif:false,quality:.78});
        asset=result.canceled?null:result.assets[0]??null;
      }
      if(!asset)return;
      const prepared=await prepareChatImage(asset);
      if(mounted.current)setChatImage({person:latest.current.person,prepared});
    }catch(error){
      dispatch({type:"notice",message:error instanceof ChatImageInputError&&error.code==="too_large"?c("图片太大了，请换一张","That photo is too large"):c("无法读取这张图片，请换一张","Couldn't read that photo")});
    }
  };
  const filterLabels = {
    gender: [c("不限", "Any"), c("妈妈", "Mothers"), c("爸爸", "Fathers")],
    distance: [c("不限", "Any"), c("1 英里内", "Within 1 mile"), c("3 英里内", "Within 3 miles"),c("5 英里内","Within 5 miles"),c("10 英里内","Within 10 miles")]
  };
  const settingsScreen = ["preferences", "blocked", "blockedEmpty", "parentSettings", "safetyConfirm"].includes(state.screen);
  const pending=(remote:Remote<unknown>,retry=true):ReactNode=>remote.error?<View style={{gap:12,alignItems:"center",paddingVertical:16}}><FinalText secondary style={{textAlign:"center"}}>{failure(remote.error)}</FinalText>{retry?<FinalButton small secondary label={c("重试","Retry")} onPress={remote.reload}/>:null}</View>:remote.loading&&remote.value===undefined?<View style={{paddingVertical:24,alignItems:"center"}}><ActivityIndicator color={FINAL_COLOR.accent}/></View>:null;
  const notice=state.notice?<View style={{gap:8,alignItems:"center"}}><FinalText testID="final-community-notice" size={12} style={{lineHeight:18,color:FINAL_COLOR.coral,textAlign:"center"}}>{state.notice}</FinalText>{consentNeeded?<FinalButton small secondary label={c("去开启 AI 功能","Turn on AI")} onPress={()=>router.push(aiPermissionHref("/community"))} testID="final-community-ai-permission"/>:null}</View>:null;
  const parentRow=(p:PublicParent|null,description:string,options:{status?:string;unread?:number;invitation?:boolean;inbox?:boolean;incoming?:boolean;conversationId?:string|null}={})=>{
    if(!p?.parent_id)return null;
    const id=p.parent_id,name=nameOf(p);
    return <Pressable key={id} testID={"final-parent-"+id} accessibilityRole="button" onPress={()=>{if(options.conversationId)knownConversations.current[id]=options.conversationId;dispatch({type:"person",person:id,name,screen:options.invitation?(options.incoming?"incomingParent":"parent"):"chat"});}} style={{minHeight:options.invitation?68:options.inbox?72:66,paddingVertical:options.invitation?12:8,paddingHorizontal:options.invitation?0:8,flexDirection:"row",alignItems:"center",gap:options.invitation?12:16}}>
      <View style={{width:40,height:40,flexShrink:0}}><FriendPreviewAvatar/>{options.unread?(options.invitation?<View pointerEvents="none" style={{position:"absolute",right:-2,top:0,width:8,height:8,borderRadius:4,backgroundColor:FINAL_COLOR.coral}}/>:<UnreadBadge count={options.unread} style={{position:"absolute",right:-1,top:-8}}/>):null}</View>
      <View style={{flex:1,minWidth:0,gap:options.invitation?2:4}}><FinalText style={{fontWeight:"500",lineHeight:24}}>{name}</FinalText><FinalText size={options.invitation?12:14} secondary style={{lineHeight:20}} numberOfLines={1}>{description}</FinalText></View>
      {options.status?<FinalText size={12} secondary style={{width:96,maxWidth:"34%",lineHeight:20,textAlign:"right",flexShrink:1}}>{options.status}</FinalText>:<FinalText size={20} style={{width:16,lineHeight:24,textAlign:"center",color:FINAL_COLOR.accent}}>›</FinalText>}
    </Pressable>;
  };
  function page(body: ReactNode, actions?: ReactNode, fill = false, layout:{bodyStyle?:ViewStyle;cardStyle?:ViewStyle;mainStyle?:ViewStyle}={}) {
    return <NuriKeyboardFrame><View style={[st.main,layout.mainStyle]}><FinalSurface fill={fill} style={layout.cardStyle} testID={`final-community-${state.screen}`}><ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" showsVerticalScrollIndicator={false} style={{ flexShrink: 1, ...(fill ? { flex: 1 } : {}) }} contentContainerStyle={[st.body,layout.bodyStyle]}>{body}</ScrollView></FinalSurface>{actions||state.notice ? <View style={st.actions}>{notice}{actions}</View> : null}</View></NuriKeyboardFrame>;
  }

  // ── Writes ────────────────────────────────────────────────────────────────
  const sendQuestion=()=>{
    const current=latest.current,text=selectedQuestionText(current);
    if(!text||busy)return;
    const key=current.sendKey??communityKey("q");
    dispatch({type:"sending",key});
    setBusy(true);
    communityApi.ask({body:text,original_language:locale,version_source:current.questionVersion,polish_id:current.questionVersion==="polished"?current.polishID:null,anonymous:current.anonymous,show_child_age:current.showAge,client_request_id:key})
      .then(result=>{if(mounted.current){lastRecipients.current=result.delivery.recipient_count;dispatch({type:"sent",id:result.question.question_id});refresh();}},
        error=>{if(mounted.current)dispatch({type:"sendFailed",message:failure(error)});})
      .finally(()=>{if(mounted.current)setBusy(false);});
  };
  const polish=()=>write(async()=>{
    const text=draft("question").trim();
    if(!text)return;
    const result=await communityApi.polish(text,locale,keyFor("polish",text,"polish"));
    dispatch({type:"polished",text:result.polish.text,id:result.polish.id});
  });
  const startQuestion=()=>{
    if(me.value&&!me.value.exists){dispatch({type:"go",screen:"profile"});dispatch({type:"notice",message:c("先建立你的社区档案，其他家长才能看到你的问题","Create your community profile first")});return;}
    dispatch({type:"newQuestion"});
  };
  const confirmQuestions=(action:"close"|"delete")=>write(async()=>{
    const ids=latest.current.selected;
    if(!ids.length)return;
    const result=await communityApi.transitionQuestions(action,ids.map(question_id=>({question_id})),communityKey(action));
    refresh();
    dispatch({type:"questionsChanged"});
    if(!result.all_succeeded)dispatch({type:"notice",message:c("有部分问题没有处理成功，请刷新后重试","Some questions could not be updated; please try again")});
  });
  const respond=()=>write(async()=>{
    const slot="answer:"+state.questionID,text=draft(slot).trim();
    if(!text||!state.deliveryID)return;
    await communityApi.respond(state.deliveryID,text,keyFor(slot,text,"resp"));
    delete writeKeys.current[slot];refresh();
    dispatch({type:"responseSent"});
  });
  const comment=(slot:string)=>write(async()=>{
    const text=draft(slot).trim();
    if(!text||!state.questionID)return;
    await communityApi.comment(state.questionID,state.replyTarget,text,keyFor(slot,text,"cm"));
    delete writeKeys.current[slot];refresh();
    dispatch({type:"commentSent",slot});
  });
  const connect=()=>write(async()=>{
    const relation=parentView.value?.relationship;
    if(!relation)return;
    if(relation.state==="connected"){dispatch({type:"person",person:state.person,name:state.personName,screen:"chat"});return;}
    if(relation.state==="invitation_received"&&relation.invitation_id){
      await communityApi.decideInvitation(relation.invitation_id,"accept",keyFor("accept:"+relation.invitation_id,"accept","dec"));
      refresh();dispatch({type:"connected"});return;
    }
    const result=await communityApi.invite(state.person,keyFor("invite:"+state.person,"invite","inv"));
    refresh();
    dispatch({type:result.relationship.state==="connected"?"connected":"inviteSent"});
  });
  const decline=()=>write(async()=>{
    const relation=parentView.value?.relationship;
    if(relation?.state!=="invitation_received"||!relation.invitation_id){dispatch({type:"back"});return;}
    await communityApi.decideInvitation(relation.invitation_id,"decline",keyFor("decline:"+relation.invitation_id,"decline","dec"));
    refresh();dispatch({type:"invitationDeclined"});
  });
  const confirmSafety=()=>write(async()=>{
    const {safetyAction,person}=latest.current;
    if(safetyAction==="block")await communityApi.block(person);
    else if(safetyAction==="unblock")await communityApi.unblock(person);
    else{
      const relation:RelationView|undefined=parentView.value?.relationship??(await communityApi.parent(person)).relationship;
      if(relation?.relationship_id&&relation.state==="connected")await communityApi.disconnect(relation.relationship_id);
    }
    delete knownConversations.current[person];
    refresh();dispatch({type:"safetyDone"});
  });
  const togglePreference=(key:keyof Omit<Preferences,"version">)=>write(async()=>{
    const current=prefs.value;if(!current)return;
    await communityApi.savePreferences({[key]:!current[key],expected_version:current.version});
    prefs.reload();
  });
  const saveProfile=(after:()=>void)=>write(async()=>{
    const profile=me.value?.profile;
    const about=state.drafts["profile:about"];
    await communityApi.saveProfile({
      ...(profile?{}:{display_name:(account.value?.nickname||"").trim().slice(0,30)||c("新家长","New parent"),city:(account.value?.city||"").trim().slice(0,60)}),
      ...(about!==undefined?{about:about.trim().slice(0,300)}:{}),
      intents:intentCodes(state.intents),
      ...(profile?{expected_version:profile.version}:{}),
    });
    me.reload();after();
  });
  function sendChat(){return write(async()=>{
    // Read the latest drafts: a voice transcript may have landed this tick.
    const current=latest.current,slot="chat:"+current.person,text=(current.drafts[slot]??"").trim(),conversationId=chat.value?.conversationId;
    const image=chatImage&&chatImage.person===current.person?chatImage.prepared:null;
    if((!text&&!image)||!conversationId)return;
    // The photo is stored and checked first; the message only binds a ready id.
    const mediaIds=image?[(await communityApi.uploadImage(image.dataUri,"message",keyFor(slot+":image",image.dataUri.length+":"+image.dataUri.slice(-96),"img"))).media.media_id]:[];
    await communityApi.sendMessage(conversationId,text,keyFor(slot,text+"|"+mediaIds.join(","),"msg"),mediaIds);
    delete writeKeys.current[slot];delete writeKeys.current[slot+":image"];
    setChatImage(null);
    dispatch({type:"messageSent",slot});chat.reload();
  });}
  const toggleAI=(on:boolean)=>write(async()=>{
    const value=chat.value;if(!value)return;
    if(on){
      const result=await communityApi.requestAI(value.conversationId,value.ai.notice_version,communityKey("air"));
      if(!result.request.effective)dispatch({type:"notice",message:c("已邀请对方，双方都同意后 Nuri 才会参与","Invitation sent. Nuri joins only after both of you agree")});
    }else await communityApi.revokeAI(value.conversationId);
    chat.reload();
  });
  const decideAI=(allowed:boolean)=>write(async()=>{
    const request=chat.value?.ai.requests.conversation_notes;
    if(!request){dispatch({type:"consentClosed",effective:false});return;}
    const result=await communityApi.decideAI(request.request_id,allowed?"allow":"decline",request.notice_version,communityKey("aid"));
    dispatch({type:"consentClosed",effective:result.request.effective});chat.reload();
  });

  // ── Settings: preferences, blocked parents, a parent's safety menu ────────
  if (settingsScreen) {
    const p=prefs.value,blocked=blocks.value?.items??[];
    const prefRow=(key:"parent_message_notifications_enabled"|"profile_hidden",label:string,hint?:string)=><Pressable key={key} testID={"final-community-preference-"+key} accessibilityRole="switch" accessibilityLabel={label} accessibilityState={{checked:!!p?.[key],disabled:!p||busy}} disabled={!p||busy} onPress={()=>togglePreference(key)} style={{paddingVertical:12,minHeight:48,flexDirection:"row",alignItems:"center",gap:16}}>
      <View style={{flex:1,minWidth:0,gap:4}}><FinalText>{label}</FinalText>{hint?<FinalText size={12} secondary style={{fontWeight:"500",lineHeight:16}}>{hint}</FinalText>:null}</View>
      <View pointerEvents="none" style={{width:52,height:20,justifyContent:"center"}}><Image source={p?.[key]?require("@/assets/final-flow-20261101/settings-switch-on.svg"):require("@/assets/final-flow-20261101/settings-switch-off.svg")} style={{width:p?.[key]?32.5:44,height:p?.[key]?20:44,marginLeft:p?.[key]?0:-5.75}} contentFit="contain" accessible={false}/></View>
    </Pressable>;
    return <><SettingsPage testID={`final-community-${state.screen}`}>
      {state.screen === "preferences" ? <>
        <SettingsRow label={c("交友资料与筛选", "Friend profile & filters")} onPress={() => go("profileSettings")} testID="final-open-profile-settings" />
        <FinalDivider />
        {pending(prefs)}
        <View style={{gap:12}} testID="final-community-preferences-group">
          {prefRow("parent_message_notifications_enabled",c("家长消息通知","Parent message notifications"))}
          {prefRow("profile_hidden",c("隐藏我的资料","Hide my profile"),c("暂停向其他家长推荐你；已有对话不受影响","Pause parent recommendations; existing conversations are unaffected"))}
          <SettingsRow label={c("屏蔽的家长", "Blocked parents")} onPress={() => go("blocked")} testID="final-open-blocked" />
        </View>
        <FinalDivider />
        <Pressable testID="final-community-preference-auto_translate_messages" accessibilityRole="switch" accessibilityLabel={c("消息自动翻译","Translate messages automatically")} accessibilityState={{checked:!!p?.auto_translate_messages,disabled:!p||busy}} disabled={!p||busy} onPress={()=>togglePreference("auto_translate_messages")} style={{paddingVertical:12,minHeight:48,flexDirection:"row",alignItems:"center",gap:16}}>
          <FinalText style={{flex:1}}>{c("消息自动翻译","Translate messages automatically")}</FinalText><View pointerEvents="none" style={{width:52,height:20,justifyContent:"center"}}><Image source={p?.auto_translate_messages?require("@/assets/final-flow-20261101/settings-switch-on.svg"):require("@/assets/final-flow-20261101/settings-switch-off.svg")} style={{width:p?.auto_translate_messages?32.5:44,height:p?.auto_translate_messages?20:44,marginLeft:p?.auto_translate_messages?0:-5.75}} contentFit="contain" accessible={false}/></View>
        </Pressable>
        <FinalText size={12} secondary style={{fontWeight:"500",lineHeight:16}}>{c("翻译对方的消息需要双方都同意","Translating the other parent's messages needs both of you to agree")}</FinalText>
        {notice}
      </> : state.screen === "blocked" || state.screen === "blockedEmpty" ? <>
        {pending(blocks)}
        {blocked.length ? <View>{blocked.map((entry,index)=><View key={entry.parent.parent_id}>
          {index?<View style={{height:1,backgroundColor:"rgba(112,106,116,.12)"}}/>:null}
          <View testID={"final-blocked-parent-"+entry.parent.parent_id} style={{height:76,paddingVertical:16,flexDirection:"row",alignItems:"center",gap:12}}><SampleAvatar/><FinalText style={{flex:1,fontWeight:"500",lineHeight:24}}>{nameOf(entry.parent)}</FinalText><Pressable accessibilityRole="button" accessibilityLabel={c("取消屏蔽","Unblock ")+nameOf(entry.parent)} style={{width:96,height:44,alignItems:"center",justifyContent:"center"}} onPress={()=>dispatch({type:"safety",action:"unblock",person:entry.parent.parent_id!,name:nameOf(entry.parent)})}><FinalText size={14} style={{fontWeight:"500",lineHeight:20,color:FINAL_COLOR.accent}}>{c("取消屏蔽","Unblock")}</FinalText></Pressable></View>
        </View>)}</View> : blocks.value ? <>
          <FinalText style={{fontWeight:"500",lineHeight:24}}>{c("你可以随时重新选择","You can change your choice at any time")}</FinalText>
          <FinalText secondary>{c("解除屏蔽不会自动恢复好友关系。","Unblocking does not automatically restore a friendship.")}</FinalText>
          <View style={{gap:12}}><FinalText size={18} style={{fontWeight:"500",lineHeight:26}}>{c("目前没有屏蔽的家长","No blocked parents")}</FinalText><FinalText secondary>{c("需要时，可在对话设置中屏蔽。","You can block a parent in conversation settings when needed.")}</FinalText></View>
        </> : null}
      </> : <>
        <SettingsRow label={c("查看家长资料", "View parent profile")} onPress={() => go("parent")} />
        <SettingsRow label={c("屏蔽这位家长", "Block this parent")} danger onPress={() => dispatch({type:"safety",action:"block"})} testID="final-block-parent" />
        {parentView.value?.relationship.state==="connected"?<SettingsRow label={c("解除联系", "Disconnect")} danger onPress={() => dispatch({type:"safety",action:"disconnect"})} />:null}
      </>}
    </SettingsPage>{state.screen==="safetyConfirm"?<Modal transparent animationType="fade" onRequestClose={()=>dispatch({type:"back"})}><BlurView tint="light" intensity={40} style={[st.modal,{backgroundColor:"rgba(254,250,247,.5)"}]}><FinalSurface surfaceColor="rgba(255,255,255,.94)" style={{width:354,maxWidth:"100%",boxShadow:"0px 4px 8px rgba(89,71,92,.14)"}} contentStyle={{padding:24,gap:16}}><FinalText size={20} secondary style={{lineHeight:28,fontWeight:"500"}}>{state.safetyAction==="unblock"?c("取消屏蔽这位家长？","Unblock this parent?"):state.safetyAction==="block"?c("屏蔽这位家长？","Block this parent?"):c("解除联系？","Disconnect?")}</FinalText><FinalText size={14} secondary>{state.safetyAction==="block"?c("屏蔽后，你们会解除联系，对方无法再看到你或给你发消息。","Blocking also disconnects you; they can no longer see or message you."):state.safetyAction==="unblock"?c("解除屏蔽不会自动恢复好友关系。","Unblocking does not restore the connection."):c("聊天记录会保留，但你们不能再互发消息。","Your chat history stays, but neither of you can send new messages.")}</FinalText>{notice}<View style={{flexDirection:"row",gap:12}}><SettingsButton secondary style={{flex:1,width:undefined}} label={c("取消","Cancel")} onPress={()=>dispatch({type:"back"})}/><SettingsButton style={{flex:1,width:undefined}} label={c("确认","Confirm")} onPress={confirmSafety} testID="final-confirm-safety"/></View></FinalSurface></BlurView></Modal>:null}</>;
  }

  // ── Hub pager: questions (left) and friends / inbox (right) ──────────────
  if (home) {
    const data=hub.value,inboxItems=data?.inbox.items??[];
    const latestQuestion=data?.questions[0],latestWaiting=data?.waiting[0];
    const preview=(item:InboxItem)=>item.last_message?.preview||c("开始聊天吧","Say hello");
    const entries=[
      ["myQuestions",!!latestQuestion?.reply_count,c("我的问题","My questions"),latestQuestion?.body??c("还没有发出漂流瓶","No bottles sent yet"),latestQuestion?(latestQuestion.reply_count?c(latestQuestion.reply_count+" 位家长分享了经验",latestQuestion.reply_count+" parents shared experiences"):c("等待回复","Waiting for replies")):""],
      ["received",!!data?.waiting.length,c("收到问题","Received questions"),latestWaiting?.question.body??c("暂时没有新的问题","No new questions"),latestWaiting?c(nameOf(latestWaiting.question.author)+"想听听你的意见",nameOf(latestWaiting.question.author)+" would like your thoughts"):""],
    ] as const;
    return <NuriKeyboardFrame><View style={{ flex: 1, minHeight: 0 }}><View style={{ flex: 1, minHeight: 0, paddingTop: 16, paddingBottom:4, gap:HUB_PAGER_GAP }} testID="final-community-pager-viewport" onLayout={e => {
      const nextWidth=e.nativeEvent.layout.width;
      if(nextWidth!==pagerWidth.current)pagerAligned.current=null;
      pagerWidth.current=nextWidth;setWidth(nextWidth);
    }}><ScrollView ref={pager} horizontal pagingEnabled directionalLockEnabled showsHorizontalScrollIndicator={false} onLayout={e => setPagerHeight(e.nativeEvent.layout.height)} onContentSizeChange={contentWidth=>{
      if(Math.abs(contentWidth-width*2)<1)alignPager();
    }} onMomentumScrollEnd={settlePager} onScroll={Platform.OS==="web"?settlePager:undefined} scrollEventThrottle={16} style={{ flex: 1 }} testID="final-community-pager">
    {([0, 1] as const).map(mode => <View key={mode} style={{ width: width || 1, height: pagerHeight || undefined, paddingHorizontal: 12, paddingBottom: HUB_CARD_BOTTOM_GUTTER }}><FinalSurface fill testID={`final-community-page-${mode}`} style={mode===1&&state.inboxExpanded?{maxHeight:619}:undefined}>{mode===1&&state.inboxExpanded?<View testID="final-community-inbox" style={{flex:1,minHeight:0}}><ScrollView key="inbox" testID="final-inbox-scroll" directionalLockEnabled nestedScrollEnabled keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} style={{flex:1,minHeight:0}} contentContainerStyle={{paddingHorizontal:24,paddingTop:24,paddingBottom:24,gap:12}}>
            <Search value={search} onChange={setSearch} placeholder={c("搜索","Search")}/>
            <View style={{paddingTop:4,gap:4}}>
              <View style={{height:32,flexDirection:"row",alignItems:"center",gap:4}}><Pressable testID="final-collapse-inbox" accessibilityRole="button" accessibilityLabel={c("收起我的消息","Collapse messages")} onPress={()=>go("friends")} style={{flex:1,minHeight:32,justifyContent:"center"}}><FinalText style={{fontWeight:"500"}}>{c("我的消息","My messages")} <FinalText size={16} style={{color:FINAL_COLOR.accent}}>⌄</FinalText></FinalText></Pressable><Pressable testID="final-open-contacts" accessibilityRole="button" accessibilityLabel={c("通讯录","Address book")} onPress={()=>go("contacts")} style={{width:44,height:44,alignItems:"center",justifyContent:"center"}}><Image source={require("@/assets/final-flow-20261101/address-book.svg")} style={{width:24,height:24}} contentFit="contain" accessible={false}/></Pressable></View>
              {pending(hub)}
              {inboxItems.filter(item=>nameOf(item.parent).toLocaleLowerCase().includes(search.toLocaleLowerCase())).map((item,i)=><View key={item.conversation_id} style={{gap:4}}>{i?<View style={st.friendDivider}/>:null}{parentRow(item.parent,preview(item),{unread:item.unread_count,inbox:true,conversationId:item.conversation_id})}</View>)}
              {data&&!inboxItems.length?<FinalText secondary style={{paddingVertical:16,textAlign:"center"}}>{c("还没有消息","No messages yet")}</FinalText>:null}
            </View>
        </ScrollView></View>:<ScrollView key={`preview-${mode}`} directionalLockEnabled nestedScrollEnabled showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" style={{flex:1,minHeight:0}} contentContainerStyle={{ paddingHorizontal: 24, paddingTop: communityHubTopPadding(pagerHeight,mode), paddingBottom: 16, gap: 12 }}>
      <View style={{ height: mode ? 240 : 260, gap: mode ? 8 : 28, alignItems: "center" }}><View style={{ height: 180, width: "100%", alignItems: "center", justifyContent: "center" }}>{mode ? <View style={{ position:"absolute", left:"22.03%", top:-5, width:"61.02%", aspectRatio:200.13558959960938/169.00338745117188, overflow: "hidden" }}><Image source={require("@/assets/final-flow-20261101/parent-friends.png")} contentFit="fill" style={{ position: "absolute", left: 0, top: "-0.07%", width: "100%", height: "110.66%" }} /></View> : <Image source={require("@/assets/final-flow-20261101/question-mascot.svg")} style={{ width: 146, height: 181 }} contentFit="contain" />}</View><FinalText size={18} style={{ textAlign: "center" }}>{mode ? c("认识聊得来的家长", "Meet parents you connect with") : c("把问题交给有经历的人", "Ask parents who've been there")}</FinalText></View>
      <FinalButton label={mode ? c("寻找育儿好友", "Find parent friends") : c("向家长提问", "Ask parents")} onPress={() => mode ? go("intent") : startQuestion()} testID={`final-hub-primary-${mode}`} />
      {mode ? <View testID="final-friends-messages" style={{paddingTop:4,gap:4}}><View style={st.friendDivider}/><View style={{ flexDirection: "row", alignItems: "center", minHeight:32 }}><Pressable accessibilityRole="button" onPress={() => go("inbox")} style={{ flex: 1, minHeight: 32, justifyContent: "center" }} testID="final-open-inbox"><FinalText>{c("我的消息", "My messages")}⌃</FinalText></Pressable><Pressable accessibilityRole="button" accessibilityLabel={c("通讯录", "Address book")} onPress={() => go("contacts")} style={{ width: 44, height: 32, alignItems: "center", justifyContent: "center" }} testID="final-open-contacts"><Image source={require("@/assets/final-flow-20261101/address-book.svg")} style={{ width: 24, height: 24 }} /></Pressable></View>
        {pending(hub,false)}
        {inboxItems.slice(0,2).map((item,i) => <View key={item.conversation_id} style={{gap:4}}>{i?<View style={st.friendDivider}/>:null}<Pressable testID={`final-parent-${item.parent?.parent_id}`} accessibilityRole="button" accessibilityLabel={`${nameOf(item.parent)}，${preview(item)}`} style={st.friendPreviewRow} onPress={() => {if(!item.parent?.parent_id)return;knownConversations.current[item.parent.parent_id]=item.conversation_id;dispatch({ type: "person", person: item.parent.parent_id, name: nameOf(item.parent), screen: "chat" });}}><FriendPreviewAvatar/><View style={{flex:1,minWidth:0,gap:4}}><FinalText style={{lineHeight:24}}>{nameOf(item.parent)}</FinalText><FinalText size={14} secondary numberOfLines={1} ellipsizeMode="tail" style={{lineHeight:20}}>{preview(item)}</FinalText></View><FinalText size={20} style={{width:16,lineHeight:24,textAlign:"center",color:FINAL_COLOR.accent}}>›</FinalText><UnreadBadge count={item.unread_count} style={{position:"absolute",left:"9.58%",top:"6.57%"}}/></Pressable></View>)}
        {data&&!inboxItems.length?<FinalText size={14} secondary style={{paddingVertical:12,textAlign:"center"}}>{c("建立联系后，消息会出现在这里","Messages appear here once you connect")}</FinalText>:null}
      </View> : <><FinalDivider/>{pending(hub,false)}{entries.map(([screen, fresh, label, detail, status], i) => <Pressable key={screen} testID={i ? "final-open-received" : "final-open-my-questions"} accessibilityRole="button" accessibilityLabel={`${label}，${detail}，${status}`} onPress={() => go(screen)} style={st.questionEntry}>
                  <View style={st.questionTitle}><View style={{width:29,height:24,justifyContent:"center",flexShrink:0}}>{fresh?<Image testID={`final-bottle-icon-${screen}`} source={require("@/assets/final-flow-20261101/bottle-unread.svg")} style={{width:31,height:29}} contentFit="contain" accessible={false} accessibilityElementsHidden />:<View style={{width:24,height:24,alignItems:"center",justifyContent:"center"}}><Image testID={`final-bottle-icon-${screen}`} source={require("@/assets/final-flow-20261101/community-question-bottle-coral.svg")} style={{width:7.875,height:16.3125,transform:[{rotate:"45deg"}]}} contentFit="contain" accessible={false} accessibilityElementsHidden /></View>}</View><FinalText size={16} style={{lineHeight:24,flex:1,minWidth:0}}>{label}</FinalText></View>
                  <FinalText size={14} secondary numberOfLines={1} ellipsizeMode="tail" style={{lineHeight:20,minHeight:22}}>{detail}</FinalText>
                  {status?<FinalText size={12} secondary numberOfLines={1} ellipsizeMode="tail" style={{lineHeight:18}}>{status}</FinalText>:null}
                  <View pointerEvents="none" style={st.questionChevron}><FinalText size={20} style={{lineHeight:24,color:FINAL_COLOR.accent}}>›</FinalText></View>
                </Pressable>)}{notice}</>}
    </ScrollView>}</FinalSurface></View>)}
  </ScrollView><View style={st.dots} testID="final-community-dots"><Image testID="final-community-dots-art" source={state.page?require("@/assets/final-flow-20261101/pagination-friends.svg"):require("@/assets/final-flow-20261101/pagination-questions.svg")} style={{width:HUB_PAGINATION.width,height:HUB_PAGINATION.height}} contentFit="contain" accessible={false}/>{([0, 1] as const).map(i => <Pressable key={i} testID={`final-community-dot-${i}`} accessibilityRole="button" accessibilityState={{selected:state.page===i}} accessibilityLabel={i ? c("育儿好友", "Parent friends") : c("漂流瓶", "Questions")} onPress={() => dispatch({ type: "page", page: i })} style={[st.dotTarget,{left:i*HUB_PAGINATION.targetSize}]} />)}</View></View></View></NuriKeyboardFrame>;
  }

  // ── Asking: compose, the two versions, preview, sending, sent ────────────
  const selectedDraft = state.questionVersion === "polished" ? "polished" : "question";
  if (["compose", "original", "polished"].includes(state.screen)) {
    const choosing=state.screen!=="compose";
    return page(<>
      <View style={{gap:12}}>
        <FinalText style={{fontWeight:"500",lineHeight:24}}>{c("我的问题","My question")}</FinalText>
        {choosing?<View style={{height:40,flexDirection:"row",alignItems:"center",gap:12}}><RefineAvatar/><FinalText style={{fontWeight:"500"}}>{state.questionVersion==="original"?c("选择原版","Use original"):c("选择Nuri润色版","Use Nuri version")}</FinalText></View>:null}
        {(choosing?["question","polished"] as const:["question"] as const).map(slot=>{
          const original=slot==="question",selected=original===(state.questionVersion==="original"),focusEpoch=questionFocusEpoch.current;
          return <View key={slot} style={{height:original?176:80,borderWidth:1,borderRadius:18,borderColor:choosing&&selected?FINAL_COLOR.selected:"#E0D8DC",backgroundColor:"rgba(255,250,245,.9)",overflow:"hidden"}}>
            <NuriTextInput testID={original?"final-question-input":"final-polished-input"} accessibilityLabel={original?c("我的原始问题","My original question"):c("Nuri版本草稿","Nuri version draft")} multiline maxLength={1000} value={draft(slot)} onChangeText={text=>setDraft(slot,text)} onFocus={()=>{
              if(filterMounted.current&&filterFocused.current&&questionFocusEpoch.current===focusEpoch&&["compose","original","polished"].includes(latest.current.screen))setQuestionFocusedInput(slot);
            }} onBlur={()=>{
              if(filterMounted.current&&questionFocusEpoch.current===focusEpoch)setQuestionFocusedInput(current=>current===slot?null:current);
            }} placeholder={c("写下你的问题…","Write your question…")} placeholderTextColor="#918896" style={{height:original?122:78,padding:16,paddingRight:choosing?38:16,fontSize:16,lineHeight:24,color:FINAL_COLOR.ink,textAlignVertical:"top",fontFamily:locale==="zh-CN"?"NotoSansSC_400Regular":undefined}}/>
            {original?<View style={{height:44,paddingHorizontal:8,flexDirection:"row",alignItems:"center"}}><Pressable testID="final-question-mic" accessibilityRole="button" accessibilityLabel={c("语音输入","Voice input")} onPress={()=>void startVoice(selectedDraft)} style={{width:44,height:44,alignItems:"center",justifyContent:"center"}}><Image source={require("@/assets/final-flow-20261101/microphone.svg")} style={{width:20,height:20}} contentFit="contain" accessible={false}/></Pressable></View>:null}
            {choosing?<Pressable accessibilityRole="radio" accessibilityState={{selected,checked:selected}} aria-checked={selected} accessibilityLabel={original?c("选择原版","Use original"):c("选择Nuri润色版","Use Nuri version")} onPress={()=>dispatch({type:"version",version:original?"original":"polished"})} testID={original?"final-question-original":"final-question-version"} style={{position:"absolute",right:-3,top:-3,width:44,height:44,alignItems:"center",justifyContent:"center"}}><Image source={selected?require("@/assets/final-flow-20261101/community-radio-selected.svg"):require("@/assets/final-flow-20261101/community-radio-empty.svg")} style={{width:16,height:16}} contentFit="contain" accessible={false}/></Pressable>:null}
          </View>;
        })}
      </View>
      {voiceBar(selectedDraft)}
      {!choosing?<View style={{height:44,flexDirection:"row",alignItems:"center",gap:12}}><RefineAvatar/><Pressable accessibilityRole="button" testID="final-refine-question" disabled={busy||!draft("question").trim()} onPress={polish} style={{height:44,borderRadius:999,paddingHorizontal:24,backgroundColor:FINAL_COLOR.selected,alignItems:"center",justifyContent:"center",boxShadow:"0px 1px 15px rgba(92,86,98,.18)",opacity:busy||!draft("question").trim()?.6:1}}>{busy?<ActivityIndicator color="white"/>:<FinalText style={{fontWeight:"500",color:"white"}}>{c("需要润色吗？","Refine your wording?")}</FinalText>}</Pressable></View>:null}
      <View style={st.quietDivider}/>
      <View style={{minHeight:44,flexDirection:"row",gap:12,alignItems:"center",flexWrap:"wrap"}}>
        {(["showAge","anonymous"] as const).map(key=><View key={key} style={{flexDirection:"row",alignItems:"center",gap:12}}><FinalText size={12} secondary style={{lineHeight:18}}>{key==="showAge"?c("显示孩子年龄","Show child's age"):c("匿名","Anonymous")}</FinalText><CommunitySwitch value={state[key]} label={key==="showAge"?c("显示孩子年龄","Show child's age"):c("匿名","Anonymous")} onChange={()=>dispatch({type:"toggle",key})} testID={"final-question-"+key}/></View>)}
      </View>
    </>,questionFocusedInput?undefined:<FinalButton label={c("预览问题","Preview question")} disabled={!selectedQuestionText(state)} onPress={()=>dispatch({type:"previewQuestion"})} testID="final-preview-question"/>);
  }
  if(state.screen==="preview"){
    const text=selectedQuestionText(state);
    return page(<>
      <FinalSurface radius={20} style={{boxShadow:"0px 0px 8px rgba(89,71,92,.12)",minHeight:136}} contentStyle={{padding:16,gap:12}}>
        <FinalText size={12} secondary style={{lineHeight:18}}>{state.questionVersion==="polished"?c("Nuri 润色版","Nuri version"):c("我的原话","My words")}</FinalText>
        <FinalText size={20} style={{fontWeight:"500",lineHeight:28}}>{text}</FinalText>
      </FinalSurface>
      <View style={{minHeight:42,flexDirection:"row",alignItems:"flex-start",gap:12}}><SampleAvatar/><View style={{flex:1,minWidth:0}}><FinalText style={{fontWeight:"500",lineHeight:24}}>{state.anonymous?c("匿名家长","Anonymous parent"):me.value?.profile?.display_name??c("你的社区名字","Your community name")}</FinalText>{state.showAge?<FinalText size={12} secondary style={{lineHeight:18}}>{c("会显示你最小孩子的年龄","Your youngest child's age will be shown")}</FinalText>:null}</View></View>
    </>,<View style={st.actionRow}><FinalButton small secondary label={c("返回编辑","Edit")} onPress={()=>dispatch({type:"back"})}/><FinalButton small disabled={busy} label={c("发送漂流瓶","Send bottle")} onPress={sendQuestion} testID="final-send-question"/></View>,false,{bodyStyle:{padding:12,paddingBottom:16,gap:16},cardStyle:{boxShadow:"0px 0px 8px rgba(89,71,92,.12)"},mainStyle:{paddingTop:12}});
  }
  if(state.screen==="inviteSent")return page(<View style={{height:463,gap:8}}><View style={{height:322,alignItems:"center"}}><Image source={require("@/assets/final-flow-20261101/community-invite-sent.svg")} style={{width:179,height:223,marginTop:42}} contentFit="contain" accessible={false}/></View><View style={{gap:6}}><FinalText size={24} style={{fontWeight:"500",lineHeight:24,textAlign:"center"}}>{c("你的邀请已发送","Your invitation has been sent")}</FinalText><FinalText size={14} secondary style={{lineHeight:20,textAlign:"center"}}>{c("对方通过后，你们就可以开始聊天","You can chat once they accept")}</FinalText></View></View>,<View style={{alignItems:"center",gap:12}}><FinalButton label={c("返回社区","Back to community")} onPress={()=>go("hub")}/></View>,true,{bodyStyle:{paddingVertical:32},cardStyle:{maxHeight:567},mainStyle:{paddingBottom:29}});
  if(state.screen==="connected"||state.screen==="noMatches"){
    const connected=state.screen==="connected";
    const shared=(parentView.value?.parent.intents??[]).filter(code=>me.value?.profile?.intents.includes(code)).map(code=>intentLabel(intentIndexes([code])[0],true));
    return page(<>
      <View style={{height:connected?312:311,width:"100%",position:"relative",alignItems:"center",justifyContent:"center"}}>
        {connected?<><View style={{position:"absolute",left:"12.424%",top:59,boxShadow:"-15px 19px 25px rgba(235,129,131,.12)",borderRadius:73}}><ConnectionPortrait/></View><View style={{position:"absolute",left:"42.121%",top:124,boxShadow:"27px -17px 23.9px rgba(193,160,221,.24)",borderRadius:73}}><ConnectionPortrait purple/></View></>:<Image source={require("@/assets/final-flow-20261101/community-patient.svg")} style={{width:174,height:217}} contentFit="contain" accessible={false}/>}
      </View>
      <View style={{gap:connected?8:12,width:"100%"}}><FinalText size={24} style={{lineHeight:32,fontWeight:"500",textAlign:"center"}}>{connected?c("你和 "+state.personName+" 已建立联系","You and "+state.personName+" are connected"):c("暂时没有合适的家长","No matching parents yet")}</FinalText><FinalText size={12} secondary style={{lineHeight:18,textAlign:"center"}}>{connected?(shared.length?shared.join("\n"):c("打个招呼，开始聊聊吧","Say hello and start chatting")):c("换个筛选条件，或完善你的档案\n让更多家长认识你","Try other filters, or complete your profile")}</FinalText></View>
    </>,<FinalButton label={connected?c("开始聊天","Start chatting"):c("修改我的档案","Edit my profile")} onPress={()=>connected?dispatch({type:"person",person:state.person,name:state.personName,screen:"chat"}):go("profile")} testID={connected?"final-connected-chat":"final-no-matches-profile"}/>,true,{bodyStyle:{paddingVertical:32},cardStyle:{maxHeight:connected?571:570},mainStyle:{paddingBottom:26}});
  }
  if(state.screen==="sent")return <NuriKeyboardFrame><View style={{flex:1,minHeight:0,paddingHorizontal:12,paddingTop:0,paddingBottom:34,alignItems:"center",justifyContent:"center"}}>
    <FinalSurface testID="final-community-sent" style={{width:354,maxWidth:"100%",height:340}} contentStyle={{height:340,paddingHorizontal:32,alignItems:"center",justifyContent:"center"}}>
      <FinalText size={20} secondary style={{fontWeight:"500",lineHeight:28,textAlign:"center"}}>{c("发送成功","Sent successfully")}</FinalText>
      <View style={{width:128,height:128,alignItems:"center",justifyContent:"center"}}><View style={{width:64,height:64,borderRadius:32,backgroundColor:"rgba(217,217,217,.3)",alignItems:"center",justifyContent:"center"}}><Image source={require("@/assets/final-flow-20261101/community-bottle-gray.svg")} style={{width:10.9688,height:23.2031,transform:[{rotate:"45deg"}]}} contentFit="contain" accessible={false}/></View></View>
      <FinalText size={14} secondary style={{lineHeight:20,textAlign:"center"}}>{lastRecipients.current===0?c("社区里暂时没有能收到这个问题的家长","No parents can receive this question yet"):c("请静静等待回复","Please wait for replies")}</FinalText>
    </FinalSurface>
    <View style={{position:"absolute",bottom:40,alignSelf:"center"}}><FinalButton label={c("继续","Continue")} onPress={()=>go("myQuestions")}/></View>
  </View></NuriKeyboardFrame>;
  if(state.screen==="responseSent")return page(<View style={{gap:8,alignItems:"center"}}>
    <Image source={require("@/assets/final-flow-20261101/community-experience-sent.svg")} style={{width:179,height:223}} contentFit="contain" accessible={false}/>
    <View style={{gap:4,width:"100%"}}><FinalText style={{fontWeight:"500",lineHeight:24,textAlign:"center"}}>{c("你的经验已经送到了","Your experience has been shared")}</FinalText><FinalText size={14} secondary style={{lineHeight:20,textAlign:"center"}}>{c("谢谢你，把自己走过的路分享给另一位家长。","Thank you for sharing your experience with another parent.")}</FinalText></View>
  </View>,<View style={{alignItems:"center",gap:12}}><FinalButton label={c("返回社区","Back to community")} onPress={()=>go("hub")}/></View>,false,{bodyStyle:{paddingHorizontal:24,paddingVertical:32},mainStyle:{paddingTop:12}});
  // The animation stays only while the real request is in flight.
  if(state.screen==="sending")return <NuriKeyboardFrame><View style={{flex:1,minHeight:0,paddingHorizontal:12,paddingTop:0,paddingBottom:34,alignItems:"center",justifyContent:"center"}}>
    <FinalSurface testID="final-community-sending" style={{width:354,maxWidth:"100%",height:340}} contentStyle={{height:340,paddingHorizontal:32,alignItems:"center",justifyContent:"center"}}>
      <FinalText size={20} secondary style={{fontWeight:"500",lineHeight:28,textAlign:"center"}}>{c("正在发送","Sending")}</FinalText><BottleSendVisual/><FinalText size={14} secondary style={{lineHeight:20,textAlign:"center"}}>{c("让漂流瓶轻轻出发…","Let the bottle set off gently…")}</FinalText>
    </FinalSurface>
  </View></NuriKeyboardFrame>;

  // ── My questions and their selection ─────────────────────────────────────
  if(["myQuestions","selection","close","delete"].includes(state.screen)){
    const all=mine.value?.items??[];
    const selecting=state.screen!=="myQuestions",visible=all.filter(q=>q.body.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
    const listQuestion=(q:Question)=><FinalSurface style={{boxShadow:"0px 0px 8px rgba(89,71,92,.12)"}} contentStyle={{padding:12,gap:12}}>
      <View style={{gap:8,paddingRight:selecting?24:0}}>
        <FinalText size={12} secondary style={{lineHeight:18}}>{q.anonymous?c("匿名提问","Asked anonymously"):c("我的问题","My question")}</FinalText>
        <FinalText size={20} style={{fontWeight:"500",lineHeight:28}}>{q.body}</FinalText>
      </View>
      <View style={{height:32,flexDirection:"row",alignItems:"center",gap:12}}>
        <View style={{width:32,height:32,alignItems:"center",justifyContent:"center"}}><Image source={q.status==="closed"?require("@/assets/final-flow-20261101/community-question-bottle-gray.svg"):require("@/assets/final-flow-20261101/community-question-bottle-coral.svg")} style={{width:7.875,height:16.3125,transform:[{rotate:"45deg"}]}} contentFit="contain" accessible={false}/>{q.status!=="closed"?<UnreadBadge count={q.reply_count} style={{position:"absolute",left:16,top:10}}/>:null}</View>
        <FinalText size={12} secondary style={{flex:1,lineHeight:20}} numberOfLines={1}>{q.status==="closed"?c("已关闭","Closed"):q.reply_count+" "+c("条回复","replies")+" · "+shortTime(q.created_at,en)}</FinalText>
      </View>
      {selecting?<View pointerEvents="none" style={{position:"absolute",right:12,top:12,width:20,height:20}}><Image source={state.selected.includes(q.question_id)?require("@/assets/final-flow-20261101/community-checkbox-selected.svg"):require("@/assets/final-flow-20261101/community-checkbox-empty.svg")} style={{width:20,height:20}} contentFit="contain" accessible={false}/></View>:null}
    </FinalSurface>;
    return <NuriKeyboardFrame><View style={{flex:1,minHeight:0,paddingTop:12,paddingBottom:selecting?108:34}}>
      <View style={{height:44,flexDirection:"row",alignItems:"center",gap:12,paddingHorizontal:12,zIndex:3}}>
        <View style={{flex:1,minWidth:0}}><Search compact iconSize={20} value={search} onChange={setSearch} placeholder={c("搜索","Search")}/></View>
        {selecting?<FinalSurface radius={22} surfaceColor={FINAL_COLOR.base} style={{width:104,height:44,boxShadow:"0px 2px 12px rgba(89,71,92,.12)"}} contentStyle={{flexDirection:"row"}}>
          <Pressable accessibilityRole="button" accessibilityLabel={c("更多操作","More actions")} testID="final-question-more" onPress={()=>setSelectionMenu(v=>!v)} style={{width:52,height:44,alignItems:"center",justifyContent:"center"}}><Image source={require("@/assets/final-flow-20261101/community-more.svg")} style={{width:20,height:20}} contentFit="contain" accessible={false}/></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={c("退出选择","Exit selection")} onPress={()=>{setSelectionMenu(false);dispatch({type:"back"});}} testID="final-exit-selection" style={{width:52,height:44,alignItems:"center",justifyContent:"center"}}><Image source={require("@/assets/final-flow-20261101/community-selection-exit.svg")} style={{width:20,height:20}} contentFit="contain" accessible={false}/></Pressable>
        </FinalSurface>:<Pressable accessibilityRole="button" onPress={()=>{setSelectionMenu(false);go("selection");}} testID="final-select-questions" style={{width:58,height:44,justifyContent:"center"}}><View style={{height:28,borderRadius:22,backgroundColor:FINAL_COLOR.base,alignItems:"center",justifyContent:"center",boxShadow:"0px 2px 12px rgba(89,71,92,.12)"}}><FinalText size={14} secondary style={{lineHeight:20,fontWeight:"500"}}>{c("选择","Select")}</FinalText></View></Pressable>}
      </View>
      {!selecting?<View style={{height:48,paddingTop:12,paddingHorizontal:12,justifyContent:"center"}}><FinalText size={12} secondary style={{lineHeight:18}}>{all.length} {c("个漂流瓶","bottles")}</FinalText></View>:null}
      <ScrollView testID="final-my-questions-scroll" showsVerticalScrollIndicator={false} style={{flex:1,minHeight:0,marginTop:-12}} contentContainerStyle={{paddingHorizontal:12,paddingTop:24,paddingBottom:24,gap:16}}>
        {pending(mine)}{notice}
        {visible.map(q=><Pressable key={q.question_id} accessibilityRole={selecting?"checkbox":"button"} accessibilityState={selecting?{checked:state.selected.includes(q.question_id)}:undefined} onPress={()=>selecting?dispatch({type:"select",id:q.question_id}):dispatch({type:"openQuestion",id:q.question_id})} testID={selecting?"final-select-"+q.question_id:"final-question-"+q.question_id}>{listQuestion(q)}</Pressable>)}
        {mine.value&&!visible.length?<FinalText secondary style={{padding:24,textAlign:"center"}}>{all.length?c("没有匹配的问题","No matching questions"):c("还没有发出漂流瓶","No bottles sent yet")}</FinalText>:null}
      </ScrollView>
      {selecting?<View style={{position:"absolute",left:0,right:0,bottom:46,alignItems:"center"}}><FinalSurface radius={25} surfaceColor={FINAL_COLOR.base} style={{width:228,height:50,boxShadow:"0px 2px 12px rgba(89,71,92,.12)"}} contentStyle={{height:50,alignItems:"center",justifyContent:"center"}}><FinalText size={14} secondary style={{fontWeight:"500",lineHeight:21}}>{c("已选择 "+state.selected.length+" 个漂流瓶",state.selected.length+" bottles selected")}</FinalText></FinalSurface></View>:null}
      {selecting&&selectionMenu?<View style={{position:"absolute",top:56,right:12,zIndex:10}}><FinalSurface radius={24} surfaceColor={FINAL_COLOR.base} style={{width:212,height:120,boxShadow:"0px 2px 12px rgba(89,71,92,.12)"}} contentStyle={{paddingVertical:8}}>{(["close","delete"] as const).map(action=><Pressable key={action} testID={"final-question-menu-"+action} accessibilityRole="button" disabled={!state.selected.length} onPress={()=>{setSelectionMenu(false);go(action);}} style={{height:52,paddingHorizontal:20,justifyContent:"center",opacity:state.selected.length?1:.5}}><FinalText style={{color:action==="delete"?FINAL_COLOR.coral:FINAL_COLOR.secondary}}>{action==="close"?c("关闭漂流瓶","Close bottles"):c("删除漂流瓶","Delete bottles")}</FinalText></Pressable>)}</FinalSurface></View>:null}
    </View>{state.screen==="close"||state.screen==="delete"?<Modal transparent animationType="fade" onRequestClose={()=>dispatch({type:"back"})}><BlurView tint="light" intensity={40} style={[st.modal,{backgroundColor:"rgba(254,250,247,.5)"}]}><FinalSurface surfaceColor="rgba(255,255,255,.94)" style={{width:354,maxWidth:"100%",boxShadow:"0px 4px 8px rgba(89,71,92,.14)"}} contentStyle={{padding:24,gap:16}}><FinalText size={20} secondary style={{lineHeight:28,fontWeight:"500"}}>{state.screen==="close"?c("确定关闭这 "+state.selected.length+" 个漂流瓶？","Close these "+state.selected.length+" bottles?"):c("确定删除这 "+state.selected.length+" 个漂流瓶？","Delete these "+state.selected.length+" bottles?")}</FinalText><FinalText size={14} secondary>{state.screen==="close"?c("关闭后不能再收到新的回复。","Closed bottles receive no new replies."):c("删除后，你和收到问题的家长都看不到它。","Deleted bottles disappear for you and the parents who received them.")}</FinalText>{notice}<View style={st.actionRow}><FinalButton small secondary label={c("取消","Cancel")} onPress={()=>dispatch({type:"back"})}/><FinalButton small disabled={busy} label={state.screen==="close"?c("确定关闭","Close"):c("确定删除","Delete")} onPress={()=>confirmQuestions(state.screen==="close"?"close":"delete")} testID="final-confirm-questions"/></View></FinalSurface></BlurView></Modal>:null}</NuriKeyboardFrame>;
  }

  // ── Received questions ───────────────────────────────────────────────────
  if(["received","receivedReplied","receivedLocked"].includes(state.screen)){
    const items=received.value?.items??[];
    return <NuriKeyboardFrame><View style={{flex:1,minHeight:0,padding:12,paddingBottom:34,gap:12}}>
    <View testID="final-received-tabs" style={{height:44,flexDirection:"row",padding:4,borderRadius:22}}><ButtonBackdrop color="rgba(255,255,255,.5)" radius={22} testID="final-received-tabs-material"/>{(["waiting","replied","locked"] as const).map((tab,i)=><Pressable key={tab} onPress={()=>dispatch({type:"receivedTab",tab})} accessibilityRole="tab" accessibilityState={{selected:state.receivedTab===tab}} testID={"final-received-"+tab} style={{flex:1,height:36,borderRadius:18,alignItems:"center",justifyContent:"center",backgroundColor:state.receivedTab===tab?FINAL_COLOR.selected:"transparent"}}><FinalText style={{color:state.receivedTab===tab?"white":FINAL_COLOR.secondary}}>{c(["待回复","已回复","已锁定"][i],["To reply","Replied","Locked"][i])}</FinalText></Pressable>)}</View>
    <ScrollView testID="final-received-scroll" showsVerticalScrollIndicator={false} style={{flex:1,minHeight:0}} contentContainerStyle={{gap:12,paddingBottom:12}}>
      {pending(received)}
      {items.map(d=>{const q=d.question,age=q.show_child_age?childAgeLabel(q.child_age_months,en):null,open=()=>dispatch({type:"openReceived",id:q.question_id,deliveryID:d.delivery_id,status:d.state as ReceivedTab});return <FinalSurface key={d.delivery_id} style={{boxShadow:"0px 0px 8px rgba(89,71,92,.12)"}} contentStyle={{padding:12,gap:12}}>
        <View style={{height:40,flexDirection:"row",alignItems:"center",gap:12}}><SampleAvatar size={32}/><View style={{flex:1,minWidth:0}}><FinalText style={{lineHeight:24}}>{nameOf(q.author)}</FinalText>{age?<FinalText size={12} secondary style={{lineHeight:18}}>{c("孩子年龄：","Child's age: ")+age}</FinalText>:null}</View><Pressable accessibilityRole="button" style={{width:72,height:40,alignItems:"center",justifyContent:"center"}} onPress={open} testID={"final-open-"+d.delivery_id}><FinalText size={12} secondary style={{lineHeight:18}}>{c("查看","View")}</FinalText></Pressable></View>
        <Pressable accessibilityRole="button" onPress={open}><FinalSurface radius={20} style={{minHeight:112,boxShadow:"0px 0px 8px rgba(89,71,92,.12)"}} contentStyle={{padding:16,gap:8}}>
          <View style={{height:20,flexDirection:"row",alignItems:"center",gap:12}}><View style={{width:20,height:20,alignItems:"center",justifyContent:"center"}}><Image testID={"final-received-bottle-"+d.delivery_id} source={d.state==="replied"?require("@/assets/final-flow-20261101/community-question-bottle-gray.svg"):require("@/assets/final-flow-20261101/community-received-bottle.svg")} style={{width:7.875,height:16.3125,transform:[{rotate:"45deg"}]}} contentFit="contain" accessible={false}/></View><FinalText size={12} secondary style={{flex:1,lineHeight:18}}>{d.state==="locked"?(d.lock_reason==="expired"?c("已过期","Expired"):c("已不能回答","No longer open")):""}</FinalText><FinalText size={12} secondary style={{lineHeight:18}}>{shortTime(q.created_at,en)}</FinalText></View>
          <FinalText style={{lineHeight:24}}>{q.body}</FinalText>
        </FinalSurface></Pressable>
      </FinalSurface>;})}
      {received.value&&!items.length?<FinalText secondary style={{padding:24,textAlign:"center"}}>{state.receivedTab==="waiting"?c("暂时没有等你回复的问题","No questions waiting for you"):c("这里还没有问题","Nothing here yet")}</FinalText>:null}
    </ScrollView>
  </View></NuriKeyboardFrame>;
  }

  // ── Replies, comment threads, answering ──────────────────────────────────
  if(["replies","comments","replyExpanded","replyDetail","replyKeyboard","respond","responsePrompt"].includes(state.screen)){
    const responding=state.screen==="respond",expanded=state.screen==="replyExpanded",prompting=state.screen==="responsePrompt",thread=state.screen==="comments",detail=thread||state.screen==="replyDetail"||state.screen==="replyKeyboard";
    const slot=responding?"answer:"+state.questionID:"comment:"+state.questionID+":"+state.replyTarget;
    const question:Question|undefined=replies.value?.question??askedQuestion.value?.question;
    const closed=question?.status==="closed";
    const answerer=!question?.is_mine;
    const items:Reply[]=replies.value?.items??[];
    const target=items.find(r=>r.reply_id===state.replyTarget);
    const threadComments:Comment[]=comments.value?.items?[...comments.value.items].reverse():[];
    const canPost=!closed&&(detail?comments.value?.can_post!==false:!!allThread?.can_post);
    const questionContext=<FinalSurface testID="final-question-context" style={{boxShadow:"0px 0px 8px rgba(89,71,92,.12)"}} contentStyle={{padding:12,gap:8}}>
      <View style={{height:responding?40:32,flexDirection:"row",alignItems:"center",gap:12}}><View style={{width:28,height:28,alignItems:"center",justifyContent:"center"}}><Image source={require("@/assets/final-flow-20261101/community-reply-question-bottle.svg")} style={{width:7.875,height:16.3125,transform:[{rotate:"45deg"}]}} contentFit="contain" accessible={false}/></View><FinalText size={12} secondary style={{flex:1,lineHeight:18}}>{question?(question.is_mine?c("我的问题","My question"):nameOf(question.author)):""}</FinalText><FinalText size={12} secondary style={{lineHeight:18}}>{shortTime(question?.created_at,en)}</FinalText></View>
      <FinalSurface radius={20} style={{height:responding?112:84,boxShadow:"0px 0px 8px rgba(89,71,92,.12)"}} contentStyle={{height:responding?112:84}}><ScrollView nestedScrollEnabled showsVerticalScrollIndicator={false} style={{flex:1,minHeight:0}} contentContainerStyle={{padding:16}}><FinalText size={20} style={{fontWeight:"500",lineHeight:28}}>{question?.body??""}</FinalText></ScrollView></FinalSurface>
    </FinalSurface>;
    const editor=(placeholder:string,onSend:()=>void)=><View style={{gap:8}}>
      {closed?<FinalText size={12} secondary>{c("此问题已关闭，不能继续回复。","This question is closed; replies are disabled.")}</FinalText>:null}
      <View testID="final-experience-editor" style={{height:145,borderRadius:18,borderWidth:1,borderColor:"rgba(115,92,132,.25)",backgroundColor:"rgba(255,250,245,.9)",padding:12,justifyContent:"space-between"}}>
        <NuriTextInput testID={"final-input-"+slot} accessibilityLabel={placeholder} editable={!closed} multiline maxLength={responding?2000:1000} value={draft(slot)} onChangeText={text=>setDraft(slot,text)} placeholder={placeholder} placeholderTextColor="#918896" style={{flex:1,minHeight:48,padding:0,fontSize:14,lineHeight:20,color:FINAL_COLOR.ink,textAlignVertical:"top",fontFamily:locale==="zh-CN"?"NotoSansSC_400Regular":undefined}}/>
        <View style={{height:24,flexDirection:"row",alignItems:"center",gap:8}}>
          <Pressable accessibilityRole="button" accessibilityLabel={c("语音输入","Voice input")} disabled={closed||!!voice} onPress={()=>void startVoice(slot)} style={{width:24,height:24,alignItems:"center",justifyContent:"center"}} hitSlop={8}><Image source={require("@/assets/final-flow-20261101/microphone.svg")} style={{width:20,height:20}} contentFit="contain" accessible={false}/></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={c("添加表情","Add emoji")} disabled={closed} onPress={()=>setDraft(slot,draft(slot)+" 🙂")} style={{width:24,height:24,alignItems:"center",justifyContent:"center"}} hitSlop={8}><Image source={require("@/assets/final-flow-20261101/community-emoji.svg")} style={{width:20,height:20}} contentFit="contain" accessible={false}/></Pressable>
          <View style={{flex:1}}/>
          <FrostedPressable accessibilityRole="button" testID="final-send-experience" disabled={closed||busy||!draft(slot).trim()} onPress={onSend} style={{width:50,height:24,borderRadius:18,backgroundColor:FINAL_COLOR.coral,alignItems:"center",justifyContent:"center",opacity:closed||busy||!draft(slot).trim()?.6:1}} hitSlop={8}><FinalText size={14} style={{lineHeight:20,color:"white"}}>{c("发送","Send")}</FinalText></FrostedPressable>
        </View>
      </View>
      {!closed?voiceBar(slot):null}
      {notice}
    </View>;
    const answer=(reply:Reply,small=false)=><View key={reply.reply_id} style={{gap:small?4:detail?16:12}}>
      <View style={{height:36,flexDirection:"row",alignItems:"center",gap:8}}><SampleAvatar size={36}/><FinalText size={small?14:16} secondary style={{flex:1,lineHeight:small?20:24,fontWeight:small?"400":"500"}}>{reply.is_mine?c("我的回复","My reply"):nameOf(reply.author)}</FinalText>{!detail&&!closed&&reply.allowed_actions.includes("comment")?<Pressable accessibilityRole="button" onPress={()=>dispatch({type:"replyTarget",target:reply.reply_id,name:reply.is_mine?c("我","me"):nameOf(reply.author)})} testID={"final-reply-"+reply.reply_id} style={{minWidth:60,height:36,alignItems:"center",justifyContent:"center"}}><FinalText size={12} secondary style={{lineHeight:18}}>{(reply.comment_count?reply.comment_count+" · ":"")+c("回复 ›","Reply ›")}</FinalText></Pressable>:null}</View>
      <FinalText size={small?14:16} style={{lineHeight:small?20:24}}>{reply.body}</FinalText>
      <View style={st.quietDivider}/>
    </View>;
    const commentRow=(entry:Comment)=><View key={entry.comment_id} style={{gap:8}}><FinalText size={12} secondary>{entry.is_mine?c("你的回复","Your reply"):nameOf(entry.author)}</FinalText><FinalText size={14} style={{lineHeight:20}}>{entry.body}</FinalText><View style={st.quietDivider}/></View>;
    if(prompting)return <NuriKeyboardFrame><View style={{flex:1,minHeight:0,padding:12,paddingBottom:34,gap:12}}>{pending(askedQuestion)}{questionContext}<View style={{height:44,flexDirection:"row",alignItems:"center",gap:12}}><RefineAvatar prompt/><Pressable accessibilityRole="button" testID="final-share-experience" onPress={()=>go("respond")} style={{height:44,paddingHorizontal:24,borderRadius:999,backgroundColor:FINAL_COLOR.selected,alignItems:"center",justifyContent:"center",boxShadow:"0px 1px 15px rgba(92,86,98,.18)"}}><FinalText style={{fontWeight:"500",color:"white"}}>{c("你有想法吗？","Would you like to share?")}</FinalText></Pressable></View></View></NuriKeyboardFrame>;
    if(responding||expanded&&(replyKeyboardVisible||appKeyboardVisible))return <NuriKeyboardFrame><View style={{flex:1,minHeight:0,padding:12,paddingBottom:34,gap:12}}>
      <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} style={{flex:1,minHeight:0}}>{questionContext}</ScrollView>
      <FinalSurface testID={"final-community-"+state.screen} style={{boxShadow:"0px 0px 8px rgba(92,86,98,.12)"}} contentStyle={{padding:16,gap:8}}><FinalText size={12} secondary style={{lineHeight:18}}>{responding?c("我的经验","My experience"):c("回复所有人","Reply to everyone")}</FinalText>{editor(c("写下你的回复…","Write your reply…"),responding?respond:()=>comment(slot))}</FinalSurface>
    </View></NuriKeyboardFrame>;
    if(detail)return <NuriKeyboardFrame><View style={{flex:1,minHeight:0,padding:12,paddingBottom:34}}>
      <FinalSurface testID={"final-community-"+state.screen} style={{maxHeight:thread?553:undefined,boxShadow:"0px 0px 8px rgba(89,71,92,.12)"}}>
        <ScrollView testID="final-reply-thread-scroll" keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} style={{flexShrink:1}} contentContainerStyle={{padding:20,gap:16,minHeight:thread?undefined:385}}>
          <FinalText size={12} secondary style={{lineHeight:18}}>{question?.body??""}</FinalText>
          {pending(comments)}
          {target?answer(target,thread):null}
          {threadComments.map(commentRow)}
          {canPost?<View style={{gap:12}}><FinalText size={14} secondary style={{lineHeight:20,fontWeight:"500"}}>{c("你的回复","Your reply")}</FinalText>{editor(c("写下你的回复…","Write your reply…"),()=>comment(slot))}</View>:null}
        </ScrollView>
      </FinalSurface>
    </View></NuriKeyboardFrame>;
    return <NuriKeyboardFrame><View style={{flex:1,minHeight:0,padding:12,paddingBottom:34,gap:16}}>
      {questionContext}
      <FinalSurface fill testID={"final-community-"+state.screen} style={{maxHeight:546,boxShadow:"0px 0px 8px rgba(89,71,92,.12)"}} contentStyle={{flex:1,minHeight:0,padding:16,gap:16}}>
        <FinalText size={12} secondary style={{lineHeight:18}}>{answerer?c("我的经验","My experience"):c("收到 "+items.length+" 位家长的经验","Experiences from "+items.length+" parents")}</FinalText>
        <ScrollView testID="final-reply-list-scroll" keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} style={{flex:1,minHeight:0}} contentContainerStyle={{gap:16,paddingBottom:16}}>
          {pending(replies)}
          {items.map(r=>answer(r))}
          {replies.value&&!items.length?<FinalText secondary style={{textAlign:"center"}}>{c("还没有家长回复，再等等","No replies yet")}</FinalText>:null}
          {state.replyTarget==="all"?threadComments.map(commentRow):null}
        </ScrollView>
        {allThread?.can_post?<View style={{gap:8}}>
          <Pressable accessibilityRole="button" testID="final-expand-reply" disabled={closed} onPress={()=>dispatch({type:"replyTarget",target:"all",expanded:true})} style={{minHeight:18,justifyContent:"center"}}><FinalText size={12} secondary style={{lineHeight:18}}>{closed?c("此问题已关闭","This question is closed"):c("回复所有人","Reply to everyone")}</FinalText></Pressable>
          {expanded?editor(c("写下你的回复…","Write your reply…"),()=>comment(slot)):<View style={{height:46,borderWidth:1,borderColor:"rgba(93,80,96,.16)",borderRadius:18,backgroundColor:"rgba(255,250,245,.9)",flexDirection:"row",alignItems:"center",paddingLeft:8,paddingRight:12}}>
            <Pressable accessibilityRole="button" disabled={closed||!!voice} accessibilityLabel={c("语音输入","Voice input")} onPress={()=>void startVoice(slot)} style={{width:44,height:44,alignItems:"center",justifyContent:"center"}}><Image source={require("@/assets/final-flow-20261101/microphone.svg")} style={{width:20,height:20}} contentFit="contain" accessible={false}/></Pressable>
            <NuriTextInput testID="final-comment-input" accessibilityLabel={c("写下回复","Write a reply")} editable={!closed} value={draft(slot)} onChangeText={text=>setDraft(slot,text)} onFocus={()=>dispatch({type:"replyTarget",target:"all",expanded:true})} placeholder={c("写下回复…","Write a reply…")} placeholderTextColor="#918896" style={{...singleLineInputStyle,flex:1,height:44,padding:0,fontSize:14,lineHeight:20,color:FINAL_COLOR.ink}}/>
          </View>}
          {!expanded&&!closed?voiceBar(slot):null}
        </View>:null}
      </FinalSurface>
    </View></NuriKeyboardFrame>;
  }

  // ── Contacts and invitations ─────────────────────────────────────────────
  if (state.screen==="contacts"||state.screen==="invitations"){
    const invitations=state.screen==="invitations",data=relations.value;
    const match=(p:PublicParent|null)=>!!p&&nameOf(p).toLocaleLowerCase().includes(search.toLocaleLowerCase());
    const divider=<View style={st.friendDivider}/>;
    const contacts:Contact[]=(data?.contacts??[]).filter(entry=>match(entry.parent)).sort((a,b)=>nameOf(a.parent).localeCompare(nameOf(b.parent)));
    const groups:{title:string;rows:{parent:PublicParent|null;description:string;status:string;incoming?:boolean;unread?:boolean}[]}[]=[
      {title:c("收到的邀请","Received invitations"),rows:(data?.received??[]).filter((i:Invitation)=>match(i.parent)).map(i=>({parent:i.parent,description:c("邀请你建立联系","Invited you to connect"),status:c("待你通过","Awaiting you"),incoming:true,unread:true}))},
      {title:c("发出的邀请","Sent invitations"),rows:(data?.sent??[]).filter((i:Invitation)=>match(i.parent)).map(i=>({parent:i.parent,description:c("邀请已发出","Invitation sent"),status:c("等待通过","Pending")}))},
      {title:c("已建立联系","Connected"),rows:contacts.map(entry=>({parent:entry.parent,description:c("已建立联系","Connected"),status:c("已建立联系","Connected")}))},
    ];
    return <NuriKeyboardFrame><View style={{flex:1,minHeight:0,paddingHorizontal:12,paddingTop:16,paddingBottom:22,gap:8}}>
      <FinalSurface fill style={{maxHeight:619}} testID={"final-community-"+state.screen}>
        <View style={{marginLeft:8,marginRight:28,marginTop:13,height:44,flexDirection:"row",alignItems:"center"}}><IconAction name="back" label={c("返回","Back")} onPress={()=>dispatch({type:"back"})}/><View style={{flex:1,minWidth:0}}><Search compact value={search} onChange={setSearch} placeholder={c("搜索","Search")}/></View></View>
        <ScrollView testID={"final-"+state.screen+"-scroll"} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} style={{flex:1,minHeight:0}} contentContainerStyle={{paddingHorizontal:24,paddingTop:invitations?11:14,paddingBottom:24,gap:invitations?16:8}}>
          {pending(relations)}
          {invitations?groups.map(group=><View key={group.title} style={{gap:4}}><View style={{height:24,flexDirection:"row",alignItems:"center",gap:8}}><FinalText size={14} style={{fontWeight:"500",lineHeight:20}}>{group.title}</FinalText><FinalText size={12} secondary style={{lineHeight:20}}>{group.rows.length}</FinalText></View>{group.rows.map((row,i)=><View key={row.parent?.parent_id??i}>{i?divider:null}{parentRow(row.parent,row.description,{invitation:true,incoming:row.incoming,unread:row.unread?1:0,status:row.status})}</View>)}</View>):<>
            <Pressable accessibilityRole="button" style={{minHeight:72,padding:4,flexDirection:"row",alignItems:"center",gap:12}} onPress={()=>go("invitations")} testID="final-new-connections"><View style={{flex:1,gap:4}}><View style={{flexDirection:"row",alignItems:"center"}}><FinalText style={{fontWeight:"500"}}>{c("新的联系","New connections")}</FinalText><UnreadBadge count={data?.pending??0} style={{alignSelf:"flex-start",marginTop:-4}}/></View><FinalText size={12} secondary style={{lineHeight:18}}>{c("查看请求与回应","View requests and responses")}</FinalText></View><FinalText size={20} style={{width:16,lineHeight:24,color:FINAL_COLOR.accent}}>›</FinalText></Pressable>
            {divider}
            {contacts.map((entry,i)=>{const name=nameOf(entry.parent),previous=i?nameOf(contacts[i-1].parent):"";return <View key={entry.relationship_id} style={{gap:8}}>{i===0||name[0]!==previous[0]?<FinalText size={10} style={{height:24,lineHeight:14}}>{name[0]?.toLocaleUpperCase()}</FinalText>:null}{parentRow(entry.parent,entry.parent.about||c("开始聊天","Start chatting"),{conversationId:entry.conversation_id})}{divider}</View>;})}
            {data&&!contacts.length?<FinalText secondary style={{paddingVertical:16,textAlign:"center"}}>{c("还没有联系人","No contacts yet")}</FinalText>:null}
          </>}
        </ScrollView>
      </FinalSurface>
    </View></NuriKeyboardFrame>;
  }

  // ── Finding parents: intent, my profile, suggestions, a parent ───────────
  if(state.screen==="intent")return page(<>
    <View style={{height:24,alignSelf:"stretch",alignItems:"flex-end"}}><Pressable accessibilityRole="button" accessibilityLabel={c("跳过","Skip")} hitSlop={10} style={{height:24,minWidth:44,alignItems:"center",justifyContent:"center"}} onPress={()=>go("profile")}><FinalText size={14} secondary style={{lineHeight:24,fontWeight:"500"}}>{c("跳过","Skip")}</FinalText></Pressable></View>
    <View style={{height:60}}><FinalText style={{fontWeight:"500",textAlign:"center",lineHeight:24}}>{c("你希望和新朋友一起","With new friends, you'd like to…")}</FinalText></View>
    <View style={{height:407,gap:16,alignItems:"center"}}>
      {INTENT_LABELS.map(([cn,english],i)=><Pressable key={i} onPress={()=>dispatch({type:"intent",index:i})} accessibilityRole="checkbox" accessibilityState={{checked:state.intents.includes(i)}} testID={"final-intent-"+i} style={{height:44,width:248,maxWidth:"100%",alignItems:"center",justifyContent:"center",flexShrink:0}}>
        <View pointerEvents="none" style={{position:"absolute",left:0,right:0,top:-2,height:48,borderRadius:22,boxShadow:"0px 1px 4px rgba(0,0,0,.25)"}}><ButtonBackdrop color={state.intents.includes(i)?FINAL_COLOR.selected:"rgba(255,248,242,.75)"} radius={22} testID={`final-intent-${i}-material`}/></View>
        <FinalText size={14} style={{lineHeight:20,color:state.intents.includes(i)?"white":FINAL_COLOR.ink,textAlign:"center",paddingHorizontal:12}}>{c(cn,english)}</FinalText>
      </Pressable>)}
      <FinalText size={12} style={{lineHeight:24,textAlign:"center",opacity:.65,fontWeight:"500"}}>{c("多选","Choose any that fit")}</FinalText>
    </View>
  </>,<FinalButton label={c("下一步","Next")} disabled={busy} onPress={()=>me.value?.exists?saveProfile(()=>go("profile")):go("profile")} testID="final-intent-next"/>,true,{bodyStyle:{paddingTop:32,paddingBottom:0},cardStyle:{maxHeight:555}});
  const myProfile:MyProfile["profile"]=me.value?.profile??null;
  const myName=myProfile?.display_name||account.value?.nickname||"";
  const myCity=myProfile?.city??account.value?.city??"";
  const myAbout=state.drafts["profile:about"]??myProfile?.about??"";
  if((state.screen==="profile"||state.screen==="profileSettings")&&(profileEditing||(me.value&&!me.value.exists)))return page(<>{pending(me)}<CommunityProfileEditor displayName={myName} city={myCity} about={myAbout} onAboutChange={text=>setDraft("profile:about",text)} selectedIntents={state.intents} onToggleIntent={index=>dispatch({type:"intent",index})} avatar={<SampleAvatar size={104}/>}/>{!myProfile?<FinalText size={12} secondary style={{paddingHorizontal:24,paddingBottom:16,lineHeight:18}}>{c("保存后，其他家长会看到你的名字、城市和以上内容。","After saving, other parents will see your name, city and the details above.")}</FinalText>:null}</>,<FinalButton label={c("保存","Save")} disabled={busy||!me.value} onPress={()=>saveProfile(()=>setProfileEditingMode(false))} testID="final-profile-save"/>,false,{bodyStyle:{padding:0,gap:0}});
  if (state.screen === "profile" || state.screen === "profileSettings" || state.screen === "parent" || state.screen === "incomingParent") {
    const own=state.screen==="profile"||state.screen==="profileSettings";
    const view=parentView.value,relation=view?.relationship;
    const shown:PublicParent|null=own?myProfile:view?.parent??null;
    const intents=intentIndexes(shown?.intents??[]);
    const relationAction=relation?.state==="connected"?c("开始聊天","Start chatting"):relation?.state==="invitation_received"?c("通过邀请","Accept"):relation?.state==="invitation_sent"?c("等待对方通过","Waiting for them"):relation?.state==="blocked_by_me"?c("已屏蔽","Blocked"):c("建立联系","Connect");
    return page(<>
      {own?<View style={{height:40,flexDirection:"row",alignItems:"center"}}><FinalText size={12} secondary style={{flex:1,lineHeight:18,fontWeight:"500"}}>{c("我的档案","My profile")}</FinalText><Pressable accessibilityRole="button" style={{width:72,minHeight:40,justifyContent:"center",alignItems:"flex-end"}} onPress={()=>setProfileEditingMode(true)} testID="final-profile-edit"><FinalText size={12} secondary style={{lineHeight:16,fontWeight:"500"}}>{c("编辑","Edit")}</FinalText></Pressable></View>:null}
      {pending(own?me:parentView)}
      {shown?<>
        <View style={{flexDirection:"row",alignItems:"flex-start",gap:20}}>
          <SampleAvatar size={104}/>
          <View style={{flex:1,minWidth:0,gap:4}}><FinalText size={36} style={{lineHeight:46,fontWeight:"700"}}>{own?myName:nameOf(shown)}</FinalText>
            {shown.city?<FinalText size={14} secondary style={{lineHeight:18,fontWeight:"500"}}>{shown.city}</FinalText>:null}
          </View>
        </View>
        <View style={st.quietDivider}/>
        <FinalText style={{fontWeight:"500"}}>{own?c("关于我","About me"):c("关于对方","About this parent")}</FinalText>
        <FinalText size={18} style={{lineHeight:26}}>{shown.about||c("还没有写介绍","No introduction yet")}</FinalText>
        {intents.length?<><FinalText style={{fontWeight:"500",lineHeight:24}}>{own?c("希望和新朋友一起","With new friends, I'd like to…"):c("对方希望","They'd like to…")}</FinalText>
        <View testID="final-profile-intents" style={{flexDirection:"row",flexWrap:"wrap",gap:8}}>{intents.map(index=><View key={index} style={{minWidth:123.333,maxWidth:"100%",minHeight:36,borderRadius:18,paddingHorizontal:8,backgroundColor:FINAL_COLOR.selected,alignItems:"center",justifyContent:"center"}}><FinalText style={{lineHeight:24,color:"white"}}>{intentLabel(index,true)}</FinalText></View>)}</View></>:null}
        {!own&&relation?<>
          <FinalButton disabled={busy||relation.state==="invitation_sent"||relation.state==="blocked_by_me"} label={relationAction} onPress={connect} testID="final-parent-connect"/>
          <FinalButton secondary label={relation.state==="invitation_received"?c("拒绝","Decline"):c("稍后再说","Maybe later")} onPress={decline}/>
        </>:null}
      </>:null}
    </>,own?<FinalButton label={state.screen==="profileSettings"?c("完成","Done"):c("下一步","Next")} onPress={()=>state.screen==="profileSettings"?dispatch({type:"back"}):go("suggestions")} testID={state.screen==="profileSettings"?"final-profile-settings-save":"final-profile-next"}/>:undefined,false,{bodyStyle:{paddingVertical:32}});
  }
  if(state.screen==="suggestions"){
    const items:Recommendation[]=suggestions.value?.items??[];
    const filterTicket=filterRequest.current;
    const currentFilter=()=>filterMounted.current&&filterFocused.current&&latest.current.screen==="suggestions"&&filterOpen.current===filter&&filter!==null&&filterRequest.current===filterTicket;
    const dismissFilter=()=>{if(currentFilter())closeFilter();};
    const menuWidth=filterAnchor&&filterViewport?Math.min(filterAnchor.width,Math.max(1,filterViewport.width-24)):144;
    const menuLeft=filterAnchor&&filterViewport?Math.max(12,Math.min(filterAnchor.left-filterViewport.left,filterViewport.width-menuWidth-12)):12;
    const menuTop=filterAnchor&&filterViewport?Math.max(12,Math.min(filterAnchor.top-filterViewport.top,filterViewport.height-64)):12;
    const menuHeight=filter&&filterViewport?Math.min(filterLabels[filter].length*44+8,Math.max(52,filterViewport.height-menuTop-12)):0;
    return <NuriKeyboardFrame><View accessibilityElementsHidden={filter!==null} importantForAccessibility={filter?"no-hide-descendants":"auto"} style={{flex:1,minHeight:0,paddingHorizontal:12,paddingTop:16,paddingBottom:40,gap:18}}>
      <View style={{height:32,flexDirection:"row",alignItems:"center",gap:8,paddingHorizontal:12,zIndex:5}}>
        {(["gender","distance"] as const).map(key=><FrostedPressable key={key} ref={node=>{filterControls.current[key]=node;}} collapsable={false} testID={`final-filter-${key}`} accessibilityRole="button" accessibilityLabel={key==="gender"?c("性别筛选","Filter gender"):c("距离筛选","Filter distance")} accessibilityState={{expanded:filter===key}} onPress={()=>openFilter(key)} style={{width:144,maxWidth:"48%",height:32,borderRadius:18,paddingHorizontal:12,flexDirection:"row",alignItems:"center",gap:8,backgroundColor:"rgba(255,255,255,.5)"}}><FinalText size={12} secondary style={{lineHeight:18,flex:1}}>{key==="gender"?c("性别","Gender"):c("距离","Distance")}  {filterLabels[key][state.filters[key]]}</FinalText><FinalText size={14} secondary style={{lineHeight:20}}>{filter===key?"⌃":"⌄"}</FinalText></FrostedPressable>)}
      </View>
      <FinalSurface fill testID="final-community-suggestions"><ScrollView style={{flex:1,minHeight:0}} contentContainerStyle={{padding:12,gap:12}} showsVerticalScrollIndicator={false}>
        {pending(suggestions)}
        {items.map(item=>{const p=item.parent,shared=intentIndexes(item.shared_intents).map(index=>intentLabel(index,true));return <Pressable key={p.parent_id} accessibilityRole="button" onPress={()=>{if(filterOpen.current){closeFilter();return;}dispatch({type:"person",person:p.parent_id!,name:nameOf(p),screen:item.relationship.state==="invitation_received"?"incomingParent":"parent"});}} testID={"final-suggestion-"+p.parent_id}><FinalSurface radius={20} surfaceColor="rgba(255,255,255,.2)" style={{boxShadow:"0px 2px 8px rgba(92,86,98,.1)"}} contentStyle={{padding:12,flexDirection:"row",gap:16,alignItems:"center"}}>
          <View style={{width:112,height:112,borderRadius:16,overflow:"hidden",backgroundColor:"rgba(235,129,131,.18)",flexShrink:0}}><Image source={require("@/assets/final-flow-20261101/community-suggestion-head.png")} style={{position:"absolute",left:11.2,top:34.93,width:88.667,height:77.467}} contentFit="fill" accessible={false}/></View>
          <View style={{flex:1,minWidth:0,gap:8}}><View style={{flexDirection:"row",alignItems:"center",gap:8,justifyContent:"space-between"}}><FinalText size={18} style={{lineHeight:26,fontWeight:"500",flexShrink:1}}>{nameOf(p)}</FinalText>{item.distance_miles!==null?<FinalText size={12} secondary style={{lineHeight:18,textAlign:"right",flexShrink:1}}>{c("约 "+item.distance_miles+" 英里","About "+item.distance_miles+" miles")}</FinalText>:p.city?<FinalText size={12} secondary style={{lineHeight:18,textAlign:"right",flexShrink:1}} numberOfLines={1}>{p.city}</FinalText>:null}</View><FinalText numberOfLines={2}>{p.about||c("还没有写介绍","No introduction yet")}</FinalText>{shared.length?<FinalText size={12} secondary style={{lineHeight:18}}>{c("你们都想 · ","You both want · ")+shared.join("、")}</FinalText>:null}</View>
        </FinalSurface></Pressable>;})}
        {suggestions.value&&!items.length?<View style={{gap:12,alignItems:"center",paddingVertical:16}}><FinalText secondary style={{textAlign:"center"}}>{c("暂时没有合适的家长","No matching parents yet")}</FinalText><FinalButton secondary small label={c("修改我的档案","Edit my profile")} onPress={()=>go("profile")}/></View>:null}
      </ScrollView></FinalSurface>
    </View>{filter?<Modal testID="final-filter-modal" visible transparent animationType="none" presentationStyle="overFullScreen" statusBarTranslucent onRequestClose={dismissFilter}>
      <View ref={filterModal} collapsable={false} testID="final-filter-modal-root" style={{flex:1}} accessibilityViewIsModal onAccessibilityEscape={dismissFilter} onLayout={()=>{
        if(!currentFilter())return;
        filterModal.current?.measureInWindow((left,top,width,height)=>{
          if(!currentFilter())return;
          if(![left,top,width,height].every(Number.isFinite)||width<=0||height<=0){closeFilter();return;}
          const previous=filterBounds.current;
          if(previous&&[Math.abs(previous.left-left),Math.abs(previous.top-top),Math.abs(previous.width-width),Math.abs(previous.height-height)].some(change=>change>.5)){closeFilter();return;}
          const bounds={left,top,width,height};filterBounds.current=bounds;
          setFilterViewport(bounds);
        });
      }}>
        <Pressable testID="final-filter-backdrop" accessibilityRole="button" accessibilityLabel={c("关闭筛选菜单","Close filter menu")} onPress={event=>{event.stopPropagation();dismissFilter();}} style={{position:"absolute",left:0,right:0,top:0,bottom:0}}/>
        {filterAnchor&&filterViewport?<View style={{position:"absolute",left:menuLeft,top:menuTop,width:menuWidth,height:menuHeight}}>
          <FinalSurface fill radius={20} testID="final-filter-menu" style={{boxShadow:"0px 2px 12px rgba(89,71,92,.12)"}}><ScrollView testID="final-filter-options" keyboardShouldPersistTaps="handled" style={{flex:1,minHeight:0}} contentContainerStyle={{paddingVertical:4}} showsVerticalScrollIndicator={false}>
            {filterLabels[filter].map((label,index)=><Pressable key={label} testID={`final-filter-${filter}-option-${index}`} accessibilityRole="radio" accessibilityState={{selected:state.filters[filter]===index,checked:state.filters[filter]===index}} aria-checked={state.filters[filter]===index} onPress={()=>{if(!currentFilter())return;dispatch({type:"filter",key:filter,index});closeFilter();}} style={{minHeight:44,paddingHorizontal:16,justifyContent:"center"}}><FinalText size={14} style={{lineHeight:20}}>{label}</FinalText></Pressable>)}
          </ScrollView></FinalSurface>
        </View>:null}
      </View>
    </Modal>:null}</NuriKeyboardFrame>;
  }

  // ── Parent-to-parent chat with two-party AI consent ──────────────────────
  const chatSlot = `chat:${state.person}`;
  const value=chat.value,ai:AIParticipation|undefined=value?.ai,mineAI=ai?.requests.conversation_notes;
  const canSend=!!value?.conversation.allowed_actions.includes("send_message");
  const waitingForParent=mineAI?.state==="pending"&&mineAI.initiated_by==="me";
  const list:Message[]=value?.messages??[];
  return <NuriKeyboardFrame><ParentChatHeader person={state.personName} participating={!!ai?.effective} status={ai?.effective ? c("Nuri 参与中", "Nuri is on") : waitingForParent ? c("等待对方同意","Waiting for them") : c("Nuri 未参与", "Nuri is off")} backLabel={c("返回", "Back")} toggleHint={c("开启前需要双方同意；任何一方都可以随时关闭。", "Both parents must agree first; either can turn it off at any time.")} onBack={()=>{
      if(state.history.length)dispatch({type:"back"});else router.dismissTo("/(tabs)");
    }} onToggle={toggleAI}/><ScrollView ref={messages} onContentSizeChange={() => messages.current?.scrollToEnd({ animated: false })} onLayout={() => messages.current?.scrollToEnd({ animated: false })} keyboardShouldPersistTaps="handled" style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ padding: 24, gap: 20 }} testID="final-parent-chat-scroll">
      {pending(chat)}
      {value&&!list.length?<FinalText secondary style={{textAlign:"center"}}>{c("打个招呼吧","Say hello")}</FinalText>:null}
      {list.map(m => {const incoming=m.sender==="parent";return <View key={m.message_id} testID={`final-parent-message-${m.seq}`} style={{ flexDirection: incoming ? "row" : "row-reverse", gap: 8, alignItems: incoming ? "flex-start" : "flex-end" }}><ParentChatAvatar/><FinalChatBubble incoming={incoming} style={{flex:1,maxWidth:incoming?306:258,boxShadow:incoming?"0px 0px 4px rgba(0,0,0,.1)":"0px 0px 8px rgba(0,0,0,.1)"}}>{m.media.map(item=><CommunityImage key={item.media_id} mediaId={item.media_id} label={c("图片","Photo")}/>)}{m.text?<FinalText>{m.text}</FinalText>:null}</FinalChatBubble></View>;})}
    </ScrollView><View testID="final-parent-composer-dock" style={{ padding: 24, paddingTop: 8, paddingBottom: dockBottom, gap: 8 }}>
      {notice}
      {value&&!canSend?<FinalText size={12} secondary style={{textAlign:"center"}}>{c("你们已不再联系，不能再发送消息","You're no longer connected and can't send messages")}</FinalText>:null}
      {voiceBar(chatSlot)??<NuriComposer disabled={!canSend||busy} busy={busy} value={draft(chatSlot)} onChangeText={text => setDraft(chatSlot, text)} onSend={()=>void sendChat()} onAttach={()=>void pickChatImage()} onMic={()=>void startVoice(chatSlot)} hasAttachment={!!chatImage} attachments={chatImage?[{id:"community-photo",kind:"image",uri:chatImage.prepared.previewUri,width:chatImage.prepared.width,height:chatImage.prepared.height,image:chatImage.prepared}]:undefined} onRemoveAttachment={()=>setChatImage(null)} placeholder={c("聊聊最近的活动吧…", "Talk about recent activities…")} testID="final-parent" />}
    </View>{state.screen === "consent" ? <Modal transparent animationType="fade" onRequestClose={() => decideAI(false)}><BlurView intensity={35} tint="light" style={st.modal}><FinalSurface contentStyle={{ padding: 24, gap: 16 }}><FinalText size={20}>{c("允许Nuri记录本次对话？", "Allow Nuri to record this conversation?")}</FinalText><FinalText size={14} secondary>{c("对方邀请Nuri记录这次对话。同意后，Nuri会记录之后的聊天内容，并整理对话要点。双方都可以随时关闭记录。", "The other parent invited Nuri to record this conversation from now on and organise its key points. Either person can turn it off at any time.")}</FinalText>{notice}<View style={st.actionRow}><FinalButton small secondary disabled={busy} label={c("暂不同意", "Not now")} onPress={() => decideAI(false)} /><FinalButton small disabled={busy} label={c("同意开启", "Allow")} onPress={() => decideAI(true)} testID="final-parent-consent-agree" /></View></FinalSurface></BlurView></Modal> : null}</NuriKeyboardFrame>;
}
const st = StyleSheet.create({
  main: { flex: 1, minHeight: 0, paddingHorizontal: 12, paddingTop: 16, paddingBottom: 32, gap: 16 },
  body: { padding: 24, gap: 16 },
  actions: { marginTop: "auto", paddingTop: 16, paddingBottom: 8, gap: 12 },
  actionRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 12 },
  friendPreviewRow: {minHeight:72,flexDirection:"row",alignItems:"center",gap:16,padding:8},
  friendDivider: {height:1,backgroundColor:"rgba(255,255,255,.65)",alignSelf:"stretch"},
  quietDivider: {height:1,backgroundColor:"rgba(77,64,92,.22)",alignSelf:"stretch"},
  questionEntry: {minHeight:80,paddingRight:24,paddingBottom:8,gap:4,justifyContent:"center"},
  questionTitle: {minHeight:24,flexDirection:"row",alignItems:"center",gap:12},
  questionChevron: {position:"absolute",right:0,top:0,bottom:0,width:16,alignItems:"center",justifyContent:"center"},
  dots: { height: HUB_PAGINATION.targetHeight, marginTop:HUB_PAGINATION.height-HUB_PAGINATION.targetHeight, width:HUB_PAGINATION.targetSize*2, alignSelf:"center", justifyContent: "flex-end", alignItems: "center" },
  dotTarget: { position:"absolute", width:HUB_PAGINATION.targetSize, height:HUB_PAGINATION.targetHeight, top:0 },
  modal: { flex: 1, justifyContent: "center", padding: 24, backgroundColor: "rgba(255,250,244,.15)" }
});
