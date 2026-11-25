import { NuriTextInput } from "@/src/keyboard/AppKeyboard";
import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { AccessibilityInfo, ActivityIndicator, Animated, Easing, Keyboard, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions, type NativeScrollEvent, type NativeSyntheticEvent, type ViewStyle } from "react-native";
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
import { aiConsent, api, apiErrorDetail, isAuthError } from "@/src/api";
import { AI_CONSENT_VERSION } from "@/src/aiConsent";
import { useAIConsent } from "@/src/useAIConsent";
import { CommunityMessageTranslations, communityNotesConsentCopy, communityTranslationActions, communityTranslationScope, currentTranslationRequest } from "@/src/communityMessageTranslation";
import { bottleNotificationSnapshot, childAgeLabel, communityApi, communityErrorCode, communityKey, intentCodes, intentIndexes, shortTime, type AIParticipation, type BottleNotification, type Comment, type Contact, type InboxItem, type Invitation, type Message, type MyProfile, type Page, type Preferences, type PublicParent, type Question, type Recommendation, type RelationView, type Reply, type ReportKind, type ReportReason } from "@/src/communityApi";
import { FinalButton, FinalChatBubble, FinalDivider, FinalSurface, FinalText, FINAL_COLOR } from "./Primitives";
import { ButtonBackdrop, FrostedPressable } from "./ButtonMaterial";
import { ParentChatAvatar, ParentChatHeader } from "./ParentChatHeader";
import { SettingsPage, SettingsRow, SettingsButton } from "./Settings";
import { CommunityProfileEditor, type GenderTag } from "./CommunityProfileEditor";
import { CommunityReportSheet } from "./CommunityReportSheet";
import { createFinalCommunity, finalCommunityReducer, isFinalCommunityScreen, selectedQuestionText, type FinalCommunityEvent, type FinalCommunityScreen, type FinalCommunityState, type ReceivedTab } from "./communityModel";
import { communityHubTopPadding, HUB_PAGINATION, HUB_CARD_BOTTOM_GUTTER, HUB_PAGER_GAP } from "./communityHubLayout";
import { useAccountScope } from "@/src/useAccountState";
import { loadCommunityNotificationEntry } from "@/src/communityNotificationEntry";
import { COMMUNITY_CHAT_PHOTO_LIMIT, selectCommunityImage, selectCommunityImages, sendCommunityChatPhotos } from "@/src/communityImageSelection";
import { storage } from "@/src/utils/storage";
import { CHINESE_NAME_TOO_LONG, chineseDisplayNameLimitMessage, isChineseDisplayNameTooLong } from "@/src/profileDisplayName";

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
  sent: ["发送完成", "Bottle sent"],
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
type ConsentSheet = { mode: "request" | "decision"; conversationId: string; person: string;
  noticeVersion: string; epoch: number; requestId?: string; offerKey?: string; ticket: number | null; revision: number };
type ChatConsentLease = Pick<ConsentSheet, "conversationId" | "person" | "noticeVersion" | "epoch" | "ticket" | "revision"> & { screen: FinalCommunityScreen };
type TranslationSettings = { ticket: number; revision: number; conversation?: { conversationId: string; parentName: string } };
type TranslationPermissionAction = "request" | "approve" | "decline" | "revoke";
type ChatPhoto = { id: string; prepared: PreparedChatImage };
type ChatPhotoDraft = { ticket: number; person: string; photos: ChatPhoto[] };
const friendIntentKey=(accountId:string)=>`community.friend-intent-completed.${accountId}`;
const privateChatNotesOfferKey=(accountId:string,conversationId:string)=>
  `community.notes-offer-dismissed.${encodeURIComponent(accountId)}:${encodeURIComponent(conversationId)}`;
function useRemote<T>(key: string | null, load: (isCurrent: () => boolean) => Promise<T>, { enabled = true, refresh = 0 } = {}): Remote<T> {
  const [state, setState] = useState<{ key: string | null; value?: T; error?: unknown; loading: boolean }>({ key: null, loading: false });
  const [nonce, setNonce] = useState(0);
  const loader = useRef(load); loader.current = load;
  useEffect(() => {
    if (!enabled) return;
    if (!key) { setState({ key: null, loading: false }); return; }
    let live = true;
    setState(previous => ({ key, value: previous.key === key ? previous.value : undefined, loading: true }));
    loader.current(() => live).then(value => { if (live) setState({ key, value, loading: false }); },
      error => { if (live) setState(previous => ({ key, value: previous.key === key ? previous.value : undefined, error, loading: false })); });
    return () => { live = false; };
  }, [key, nonce, enabled, refresh]);
  const reload = useCallback(() => setNonce(n => n + 1), []);
  return { value: state.key === key ? state.value : undefined, error: state.key === key ? state.error : undefined, loading: state.loading || state.key !== key, reload };
}

async function visibleBottlePages<T, P extends Page<T>>(
  load: (cursor: string | null) => Promise<P>, itemId: (item: T) => string,
  matches: (page: P) => boolean, current: () => boolean,
): Promise<P> {
  let cursor: string | null = null;
  let first: P | undefined;
  const seen = new Set<string>();
  const items = new Map<string, T>();
  while (current()) {
    const page = await load(cursor);
    if (!current() || !matches(page)) break;
    first ??= page;
    for (const item of page.items) items.set(itemId(item), item);
    if (!page.has_more) return { ...first, items: [...items.values()], next_cursor: null, has_more: false };
    cursor = page.next_cursor;
    if (!cursor || seen.has(cursor)) throw new Error("Invalid Community content cursor");
    seen.add(cursor);
  }
  throw new Error("Community content no longer matches the open view");
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

function BottleStatus({count,testID,hub=false}:{count:number;testID:string;hub?:boolean}) {
  const badgeWidth=Math.max(14,String(count).length*6+4);
  return <View pointerEvents="none" style={{width:hub?29:32,height:hub?24:32,flexShrink:0}}>
    <View style={{position:"absolute",left:hub?2:4.5,top:hub?2:5.5,width:20,height:20,alignItems:"center",justifyContent:"center"}}>
      <Image testID={testID} source={count>0?require("@/assets/final-flow-20261101/community-question-bottle-coral.svg"):require("./assets/bottle-read-empty.svg")} style={{width:7.875,height:16.3125,transform:[{rotate:"45deg"}]}} contentFit="contain" accessible={false}/>
    </View>
    {count>0?<View testID={testID+"-unread"} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{position:"absolute",left:16,top:hub?4:10,width:badgeWidth,height:14,borderRadius:7,alignItems:"center",justifyContent:"center",backgroundColor:badgeWidth>14?FINAL_COLOR.coral:undefined}}>
      {badgeWidth===14?<Image source={require("./assets/bottle-unread-badge.svg")} style={StyleSheet.absoluteFill} contentFit="contain" accessible={false}/>:null}
      <FinalText size={10} allowFontScaling={false} style={{lineHeight:14,color:"white"}}>{count}</FinalText>
    </View>:null}
  </View>;
}

function PrivateReplyField({value,onChangeText,editable,placeholder,testID}:{value:string;onChangeText:(text:string)=>void;editable:boolean;placeholder:string;testID:string}) {
  const {locale}=useT();
  const {fontScale}=useWindowDimensions();
  const lineHeight=Math.ceil(20*fontScale);
  const lineLimit=Math.max(1,Math.min(4,Math.floor(112/lineHeight)));
  const [lines,setLines]=useState(1);
  const measuredDraft=useRef({value,fontScale});
  measuredDraft.current={value,fontScale};
  const typography={fontSize:14,lineHeight:20,fontFamily:locale==="zh-CN"?"NotoSansSC_400Regular":undefined};
  return <View style={{minWidth:0}}>
    <NuriTextInput testID={testID} accessibilityLabel={placeholder} editable={editable} multiline scrollEnabled hideNativeKeyboardAccessory
      maxLength={1000} value={value} onChangeText={next=>{if(!next)setLines(1);onChangeText(next);}} placeholder={placeholder} placeholderTextColor="#918896"
      style={[typography,{height:Math.max(24,Math.min(value?lines:1,lineLimit)*lineHeight+4),padding:0,color:FINAL_COLOR.ink,textAlignVertical:"top"}]}/>
    {value?<Text key={fontScale+":"+value} pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      numberOfLines={lineLimit} ellipsizeMode="clip" style={[typography,{position:"absolute",left:0,right:0,top:0,opacity:0}]}
      onTextLayout={event=>{
        const size=event.nativeEvent.lines.length;
        if(size&&measuredDraft.current.value===value&&measuredDraft.current.fontScale===fontScale)setLines(size);
      }}>{value.endsWith("\n")?value+"\u200b":value}</Text>:null}
  </View>;
}

/** Signed read URLs are short-lived (300 s); keep each until shortly before it expires. */
function CommunityImage({mediaId,label}:{mediaId:string;label:string}){
  // Private signed URLs belong to this mounted account/route only. No module
  // cache survives a sign-out, conversation change, or expired authorization.
  const scope=useAccountScope();
  const [url,setUrl]=useState<string|null>(null);
  const [failed,setFailed]=useState(false);
  const currentURL=useRef<{url:string;live:boolean}|null>(null);
  useEffect(()=>{
    let live=true;
    const ticket=scope.capture();
    let timer:ReturnType<typeof setTimeout>|undefined;
    currentURL.current=null;setUrl(null);setFailed(false);
    const load=()=>{
      if(!live||!scope.current(ticket))return;
      void communityApi.mediaAccess(mediaId).then(result=>{
      if(!live||!scope.current(ticket))return;
      const access=result?.access;
      if(!access||typeof access.url!=="string"||!access.url.trim()||!Number.isFinite(access.expires_in_s)||access.expires_in_s<=0){currentURL.current=null;setUrl(null);setFailed(true);return;}
      currentURL.current={url:access.url,live:true};
      setUrl(access.url);setFailed(false);
      timer=setTimeout(()=>void load(),Math.max(1,access.expires_in_s-30)*1000);
    },()=>{if(live&&scope.current(ticket)){currentURL.current=null;setUrl(null);setFailed(true);}});
    };
    void load();
    return()=>{live=false;currentURL.current=null;if(timer)clearTimeout(timer);};
  },[mediaId,scope.capture,scope.current]);
  const imageLease=currentURL.current;
  return <View testID={"final-parent-image-"+mediaId} accessible accessibilityLabel={label} style={{width:200,maxWidth:"100%"}}>
    <View style={{width:"100%",aspectRatio:1,borderRadius:16,overflow:"hidden",backgroundColor:"rgba(115,92,132,.08)",alignItems:"center",justifyContent:"center"}}>
      {url?<Image source={{uri:url}} cachePolicy="none" style={StyleSheet.absoluteFill} contentFit="cover" accessible={false} onError={()=>{if(imageLease?.live&&currentURL.current===imageLease&&imageLease.url===url){currentURL.current=null;setFailed(true);setUrl(null);}}}/>:failed?<FinalText size={12} secondary>{label}</FinalText>:<ActivityIndicator color={FINAL_COLOR.accent}/>}
    </View>
  </View>;
}

/** The Community hub and its 42 approved states, on the live Community API
 * (/api/community/v1). Navigation and drafts are local; every send, answer,
 * invitation, block and consent decision is a server write, and a flow moves
 * on only after the server confirmed it. */
export default function CommunityFinal() {
  const { uiState, notificationId } = useLocalSearchParams<{ uiState?: string; notificationId?: string }>();
  const accountScope=useAccountScope();
  const alphaCommunityLayout=Platform.OS==="ios"&&process.env.EXPO_PUBLIC_RELEASE_FLAVOR==="live-alpha";
  const [state, dispatchState] = useReducer(finalCommunityReducer, isFinalCommunityScreen(uiState) ? uiState : "hub", createFinalCommunity);
  const [width, setWidth] = useState(0),
    [pagerHeight, setPagerHeight] = useState(0),
    [search, setSearch] = useState(""),
    [filter, setFilter] = useState<"gender" | "distance" | null>(null),
    [filterAnchor,setFilterAnchor]=useState<{left:number;top:number;width:number}|null>(null),
    [filterViewport,setFilterViewport]=useState<{left:number;top:number;width:number;height:number}|null>(null),
    [profileEditing,setProfileEditing]=useState(false),
    [questionSendPending,setQuestionSendPending]=useState(false),
    [questionFocusedInput,setQuestionFocusedInput]=useState<"question"|"polished"|null>(null),
    [busy,setBusy]=useState(false),
    [consentNeeded,setConsentNeeded]=useState(false),
    [focusTick,setFocusTick]=useState(0),
    [writeTick,setWriteTick]=useState(0);
  const [directBottleRead,setDirectBottleRead]=useState<{ticket:number;notice:BottleNotification}|null>(null);
  const tick=focusTick+writeTick;
  const { locale } = useT();
  const { state:localAI } = useAIConsent();
  const deviceAIAllowed=localAI.status==="allowed"&&!!localAI.userId&&localAI.version===AI_CONSENT_VERSION;
  const notesConsentCopy=communityNotesConsentCopy(locale);
  const [translations]=useState(()=>new CommunityMessageTranslations(communityApi.translateMessage,()=>communityKey("tr")));
  const [,setTranslationRevision]=useState(0);
  const [translationPaused,setTranslationPaused]=useState<string|null>(null);
  const [translationPreferencePaused,setTranslationPreferencePaused]=useState<number|null>(null);
  const [translationSettings,setTranslationSettings]=useState<TranslationSettings|null>(null);
  const translationSettingsRef=useRef(translationSettings);
  translationSettingsRef.current=translationSettings;
  const [consentSheet,setConsentSheet]=useState<ConsentSheet|null>(null);
  const consentSheetRef=useRef(consentSheet);consentSheetRef.current=consentSheet;
  const consentAction=useRef(false);
  const revokeAction=useRef<ChatConsentLease|null>(null);
  useEffect(()=>()=>translations.clear(),[translations]);
  const en = locale === "en";
  const router = useRouter(), path = usePathname();
  const pager = useRef<ScrollView>(null),
    pagerWidth = useRef(width),
    pagerAligned = useRef<{host:ScrollView;width:number;page:0|1}|null>(null),
    messages = useRef<ScrollView>(null),
    replyAllInput = useRef<NuriTextInput>(null),
    latest = useRef(state),
    navigationRevision=useRef(0),
    questionFocusEpoch=useRef(0),
    questionSendInFlight=useRef(false),
    questionSendRequest=useRef<Parameters<typeof communityApi.ask>[0]|null>(null),
    questionBatchInFlight=useRef(false),
    bottleReadsInFlight=useRef(new Set<string>()),
    mounted=useRef(true),
    /** slot → the client key of its current text, so a retry reuses it. */
    writeKeys=useRef<Record<string,{text:string;key:string}>>({}),
    /** parent_id → a conversation already known from the inbox/contacts. */
    knownConversations=useRef<Record<string,string>>({}),
    consentPrompted=useRef(new Set<string>()),
    profileSeeded=useRef(false),
    /** How many parents the last sent question reached; the sent page says so. */
    lastRecipients=useRef<number|null>(null);
  pagerWidth.current = width;
  latest.current = state;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const c = (cn: string, english: string) => en ? english : translate(locale, cn);
  const bottleUnreadLabel=(count:number)=>en?count+" unread":count+(locale==="zh-TW"?" 則未讀":" 条未读");
  const originalMessageHint = locale==="zh-TW"?"長按訊息可查看原文":c("长按消息可查看原文","Press and hold a message to view the original.");
  const intentLabel=(index:number,short=false)=>{const l=INTENT_LABELS[index];return l?c(l[0],short?l[2]:l[1]):"";};
  const nameOf=(p:PublicParent|null|undefined)=>!p||p.anonymous||!p.parent_id?c("匿名家长","Anonymous parent"):p.display_name;
  const keyFor=(slot:string,text:string,tag:string)=>{const current=writeKeys.current[slot];if(current&&current.text===text)return current.key;const key=communityKey(tag);writeKeys.current[slot]={text,key};return key;};
  const conversationKey=(person:string)=>`${accountScope.generation}:${person}`;
  const refresh=()=>setWriteTick(t=>t+1);

  const filterControls=useRef<Partial<Record<"gender"|"distance",View|null>>>({}),filterModal=useRef<View|null>(null),filterRequest=useRef(0),filterOpen=useRef<"gender"|"distance"|null>(null),filterMounted=useRef(true),filterFocused=useRef(true),filterBounds=useRef<{left:number;top:number;width:number;height:number}|null>(null);
  const closeFilter=useCallback(()=>{
    filterRequest.current++;filterOpen.current=null;
    setFilter(null);setFilterAnchor(null);
  },[]);
  useEffect(()=>{filterMounted.current=true;return()=>{filterMounted.current=false;filterOpen.current=null;filterRequest.current++;};},[]);
  useFocusEffect(useCallback(()=>{filterFocused.current=true;return()=>{filterFocused.current=false;navigationRevision.current++;closeFilter();};},[closeFilter]));
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
  const dockBottom = useComposerDockInset(parentChat||["replyExpanded","replyDetail","replyKeyboard","comments"].includes(state.screen));
  const bottle = !["hub", "friends", "inbox", "contacts", "invitations", "preferences", "blocked", "blockedEmpty", "profileSettings", "parentSettings", "safetyConfirm"].includes(state.screen) && !parentChat;
  const presentation = (next:FinalCommunityState) => {
    const chat=["chat","chatOn","consent"].includes(next.screen);
    const hub=next.screen==="hub"||next.screen==="friends"||next.screen==="inbox";
    const settings=["preferences","blocked","blockedEmpty","profileSettings","parentSettings","safetyConfirm"].includes(next.screen);
    const bottle=!hub&&!["inbox","contacts","invitations"].includes(next.screen)&&!settings&&!chat;
    return {
      communityMotionKey: next.screen,
      communityMotionDepth: String(next.history.length),
      flowTitle:chat||["connected","noMatches","incomingParent","parentSettings","safetyConfirm"].includes(next.screen)?next.personName:["replyDetail","replyKeyboard","comments"].includes(next.screen)?c("回复","Reply to ")+(next.replyTargetName||c("家长","parent")):TITLE[next.screen]?c(...TITLE[next.screen]!):c("社区","Community"),
      communityHeader:chat?"parent-chat":next.screen==="sending"?"feedback":next.screen==="blocked"?"blocked-list":["intent","profile","profileSettings","suggestions","parent","connected","noMatches","invitations","contacts","incomingParent","inviteSent","preferences","blockedEmpty","parentSettings","safetyConfirm"].includes(next.screen)?"regular":"default",
      communityBackdrop:settings||next.screen==="profile"&&profileEditing?"settings":chat?"plain":bottle?"final-bottle":"final-unified",
      communityHideTabs:hub||["inbox","contacts","invitations"].includes(next.screen)?"0":"1",
      communityHideAvatar:["preferences","blocked","blockedEmpty"].includes(next.screen)?"1":"0",
      communityHideBack:hub||["inbox","contacts","invitations"].includes(next.screen)?"1":"0"
    };
  };
  const setProfileEditingMode=(editing:boolean)=>{router.setParams({...presentation(latest.current),communityBackdrop:editing||latest.current.screen==="profileSettings"?"settings":"final-bottle"});setProfileEditing(editing);};
  const title=presentation(state).flowTitle;
  const dismissNotesOffer=(sheet:ConsentSheet|null)=>{
    if(sheet?.offerKey&&accountScope.current(sheet.ticket))void storage.setItem(sheet.offerKey,true).catch(()=>{});
  };
  const dispatch = (event:FinalCommunityEvent) => {
    const previous=latest.current,next=finalCommunityReducer(previous,event);
    if(event.type==="back"&&previous.screen==="consent")dismissNotesOffer(consentSheetRef.current);
    if(next.screen!==previous.screen||next.person!==previous.person)navigationRevision.current++;
    if(["compose","original","polished"].includes(previous.screen)&&!["compose","original","polished"].includes(next.screen)){
      questionFocusEpoch.current++;
      setQuestionFocusedInput(null);
    }
    if(next.screen!==previous.screen||next.personName!==previous.personName)router.setParams(presentation(next));
    latest.current=next;
    dispatchState(event);
  };
  useEffect(()=>{
    if(!notificationId)return;
    let live=true;
    const ticket=accountScope.capture();
    const revision=navigationRevision.current;
    const current=()=>live&&accountScope.current(ticket)&&filterFocused.current&&revision===navigationRevision.current;
    void loadCommunityNotificationEntry(notificationId,communityApi).then(async entry=>{
      if(!current())return;
      if(entry.conversation)knownConversations.current[conversationKey(entry.conversation.parentId)]=entry.conversation.id;
      // One checked synchronous navigation transaction: its own reducer events
      // increment revision, but must not invalidate later events in this entry.
      for(const event of entry.events)dispatch(event);
      if(alphaCommunityLayout&&ticket!==null&&entry.translationSettings){
        setTranslationSettings({ticket,revision:navigationRevision.current,conversation:entry.translationSettings});
      }
      router.setParams({notificationId:undefined});
      // A read receipt is separate from navigation; a failed write is not
      // reported as read, and never sends this event to the NURI AI chat.
      if(alphaCommunityLayout&&ticket!==null&&entry.bottleNotification){
        setDirectBottleRead({ticket,notice:entry.bottleNotification});
        return;
      }
      try{await communityApi.markNotificationRead(notificationId);}catch{/* no false read receipt */}
    },()=>{
      if(current())dispatch({type:"notice",message:c("这条通知不存在或已过期","This notification is unavailable or has expired")});
    });
    return()=>{live=false;};
  },[notificationId,alphaCommunityLayout,accountScope.capture,accountScope.current]);
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
    if(code===CHINESE_NAME_TOO_LONG)return chineseDisplayNameLimitMessage(locale);
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
  const me=useRemote(onProfile?`profile:${accountScope.generation}:${tick}`:null,()=>communityApi.myProfile());
  const account=useRemote<{id?:string;nickname?:string;city?:string}>(["profile","profileSettings","intent"].includes(s)?`account:${accountScope.generation}`:null,()=>api.me());
  const friendIntentInFlight=useRef(false);
  const findFriends=()=>{
    if(!alphaCommunityLayout){go("intent");return;}
    if(busy||friendIntentInFlight.current)return;
    const ticket=accountScope.capture(),revision=navigationRevision.current;
    const current=()=>accountScope.current(ticket)&&filterFocused.current&&revision===navigationRevision.current;
    if(!current())return;
    friendIntentInFlight.current=true;
    void write(async()=>{
      try{
        const [accountInfo,profile]=await Promise.all([api.me(),communityApi.myProfile()]);
        if(!current())return;
        const completed=typeof accountInfo.id==="string"&&await storage.getItem(friendIntentKey(accountInfo.id),false);
        if(!current())return;
        const hasChosenIntents=!!profile.profile?.intents.length;
        go(completed||hasChosenIntents?(profile.exists?"suggestions":"profile"):"intent");
      }catch(error){
        if(current())dispatch({type:"notice",message:failure(error)});
      }finally{friendIntentInFlight.current=false;}
    });
  };
  // Each list can render as soon as its own response arrives.
  const inbox=useRemote(home||s==="contacts"?`inbox:${accountScope.generation}:${tick}`:null,()=>communityApi.inbox());
  const contactsList=useRemote(s==="contacts"||s==="invitations"?`contacts:${accountScope.generation}:${tick}`:null,()=>communityApi.contacts());
  const receivedInvitations=useRemote(s==="invitations"?`received-invitations:${tick}`:null,()=>communityApi.invitations("received"));
  const sentInvitations=useRemote(s==="invitations"?`sent-invitations:${tick}`:null,()=>communityApi.invitations("sent"));
  useEffect(()=>{
    for(const item of inbox.value?.items??[]){
      if(item.parent?.parent_id)knownConversations.current[conversationKey(item.parent.parent_id)]=item.conversation_id;
    }
    for(const item of contactsList.value?.items??[]){
      if(item.conversation_id&&item.parent.parent_id)knownConversations.current[conversationKey(item.parent.parent_id)]=item.conversation_id;
    }
  },[inbox.value,contactsList.value,accountScope.generation]);
  const roleFilter=ROLE_FILTER[state.filters.gender]??"any",distanceFilter=DISTANCE_FILTER[state.filters.distance]??null;
  const suggestions=useRemote(s==="suggestions"?`rec:${roleFilter}:${distanceFilter}:${tick}`:null,()=>communityApi.recommendations({role:roleFilter,distance_miles:distanceFilter}));
  const parentView=useRemote(["parent","incomingParent","connected","parentSettings","safetyConfirm"].includes(s)&&state.person?`parent:${state.person}:${tick}`:null,()=>communityApi.parent(state.person));
  // Keep the previous preview on focus or a return to the hub. Writes invalidate it.
  const previewReads={enabled:home,refresh:focusTick};
  const minePreview=useRemote(`mine-preview:${writeTick}`,async()=>{
    const page=await communityApi.myQuestions({status:"all",pageSize:1});
    return page.items[0]??null;
  },previewReads);
  const legacyReceivedPreview=useRemote(`received-preview:${writeTick}`,async isCurrent=>{
    const ticket=accountScope.capture();
    if(ticket===null)return null;
    const current=()=>isCurrent()&&accountScope.current(ticket);
    let page=await communityApi.deliveries("waiting",null,1);
    // Deleted questions are filtered after pagination, so an empty page can still have a next cursor.
    while(!page.items.length&&page.next_cursor&&current()){
      page=await communityApi.deliveries("waiting",page.next_cursor,10);
    }
    return current()?page.items[0]??null:null;
  },{enabled:home&&!alphaCommunityLayout,refresh:focusTick});
  const bottleNotificationsVisible=home||["myQuestions","selection","close","delete","received","receivedReplied","receivedLocked","replies","comments","replyExpanded","replyDetail","replyKeyboard","respond","responsePrompt"].includes(s);
  const bottleSnapshot=useRemote(`bottle-notifications:${accountScope.generation}:${writeTick}:${focusTick}:${s}`,isCurrent=>{
    const ticket=accountScope.capture();
    return bottleNotificationSnapshot(()=>isCurrent()&&ticket!==null&&accountScope.current(ticket));
  },{enabled:alphaCommunityLayout&&bottleNotificationsVisible,refresh:focusTick});
  const currentBottleSnapshot=!bottleSnapshot.loading&&!bottleSnapshot.error?bottleSnapshot.value:undefined;
  const bottleNotifications={...bottleSnapshot,value:currentBottleSnapshot?.notifications};
  const receivedSnapshot={...bottleSnapshot,error:currentBottleSnapshot?.waitingError??bottleSnapshot.error};
  const waitingSnapshot=currentBottleSnapshot&&!currentBottleSnapshot.waitingError?currentBottleSnapshot.waiting:undefined;
  const receivedPreview=alphaCommunityLayout?{...receivedSnapshot,value:waitingSnapshot?waitingSnapshot[0]??null:undefined}:legacyReceivedPreview;
  const [readBottles,setReadBottles]=useState<{generation:number;ids:ReadonlySet<string>}|null>(null);
  const readIds=readBottles?.generation===accountScope.generation?readBottles.ids:undefined;
  const unreadReplies=new Map<string,number>();
  const unreadReplyComments=new Map<string,number>();
  const unreadDeliveries=new Set<string>();
  let unreadSent=0;
  for(const {notification_id,target} of bottleNotifications.value??[]){
    if(readIds?.has(notification_id))continue;
    if(target.kind==="community_question")unreadDeliveries.add(target.delivery_id);
    else{
      unreadReplies.set(target.question_id,(unreadReplies.get(target.question_id)??0)+1);
      unreadSent++;
      if(target.question_id===state.questionID&&target.comment_id&&!target.reply_id&&target.thread_id!=="all"){
        unreadReplyComments.set(target.thread_id,(unreadReplyComments.get(target.thread_id)??0)+1);
      }
    }
  }
  const unreadReceived=unreadDeliveries.size;
  const mine=useRemote(["myQuestions","selection","close","delete"].includes(s)?`mine:${tick}`:null,()=>communityApi.myQuestions({status:"all"}));
  const receivedTab=state.receivedTab;
  const receivedRemote=useRemote(["received","receivedReplied","receivedLocked"].includes(s)&&(!alphaCommunityLayout||receivedTab!=="waiting")?`received:${receivedTab}:${tick}`:null,()=>communityApi.deliveries(receivedTab));
  const received=alphaCommunityLayout&&receivedTab==="waiting"?{...receivedSnapshot,value:waitingSnapshot?{items:waitingSnapshot,has_more:false,next_cursor:null}:undefined}:receivedRemote;
  const threadScreens=["replies","comments","replyExpanded","replyDetail","replyKeyboard"];
  const replyNotificationsKey = (bottleNotifications.value ?? [])
    .filter(event => event.target.kind === "community_reply" && event.target.question_id === state.questionID)
    .map(event => event.notification_id).sort().join(",");
  const replies=useRemote(threadScreens.includes(s)&&state.questionID?`replies:${accountScope.generation}:${state.questionID}:${tick}:${replyNotificationsKey}`:null,isCurrent=>{
    const question=state.questionID,ticket=accountScope.capture();
    return visibleBottlePages(cursor=>communityApi.replies(question,cursor),(reply:Reply)=>reply.reply_id,
      page=>page.question.question_id===question,()=>isCurrent()&&accountScope.current(ticket));
  });
  const allThread=replies.value?.all_thread;
  const comments=useRemote(threadScreens.includes(s)&&state.questionID&&(state.replyTarget!=="all"||allThread)?`comments:${accountScope.generation}:${state.questionID}:${state.replyTarget}:${tick}:${replyNotificationsKey}`:null,isCurrent=>{
    const question=state.questionID,thread=state.replyTarget,ticket=accountScope.capture();
    return visibleBottlePages(cursor=>communityApi.comments(question,thread,cursor),(comment:Comment)=>comment.comment_id,
      page=>page.thread_id===thread,()=>isCurrent()&&accountScope.current(ticket));
  });
  const askedQuestion=useRemote(["respond","responsePrompt"].includes(s)&&state.questionID?`question:${state.questionID}`:null,()=>communityApi.question(state.questionID));
  useEffect(()=>{
    if(!alphaCommunityLayout||!filterFocused.current)return;
    const ticket=accountScope.capture();
    if(ticket===null)return;
    const activeNotice=directBottleRead?.ticket===ticket?directBottleRead.notice:undefined;
    const notices=bottleNotifications.value??[];
    const candidates=activeNotice&&!notices.some(item=>item.notification_id===activeNotice.notification_id)
      ?[...notices,activeNotice]:notices;
    const receiptKey=(id:string)=>`${ticket}:${id}`;
    const overview=s==="replies"||s==="replyExpanded";
    const privateView=s==="comments"||s==="replyDetail"||s==="replyKeyboard";
    const opened=candidates.filter(({notification_id,target})=>{
      if(readIds?.has(notification_id)||bottleReadsInFlight.current.has(receiptKey(notification_id))||target.question_id!==state.questionID)return false;
      if(target.kind==="community_question"){
        const question=askedQuestion.value?.question;
        return ["respond","responsePrompt"].includes(state.screen)&&!askedQuestion.loading&&!askedQuestion.error&&
          target.delivery_id===state.deliveryID&&question?.question_id===target.question_id&&question.is_mine===false&&
          question.delivery?.delivery_id===target.delivery_id&&question.delivery.state==="waiting";
      }
      if(replies.loading||replies.error||replies.value?.question.question_id!==target.question_id)return false;
      const replyVisible=replies.value.items.some(reply=>reply.reply_id===target.thread_id);
      if(target.reply_id!==undefined){
        return target.comment_id===undefined&&target.reply_id===target.thread_id&&replyVisible&&
          (overview||privateView&&state.replyTarget===target.thread_id);
      }
      if(comments.loading||comments.error||!comments.value||comments.value.thread_id!==target.thread_id||state.replyTarget!==target.thread_id)return false;
      const commentsVisible=target.thread_id==="all"
        ?!!replies.value.all_thread&&(overview||privateView)
        :privateView&&replyVisible;
      if(!commentsVisible)return false;
      return target.comment_id===undefined?replyVisible||comments.value.items.length>0:
        comments.value.items.some(comment=>comment.comment_id===target.comment_id);
    });
    if(!opened.length)return;
    for(const {notification_id} of opened)bottleReadsInFlight.current.add(receiptKey(notification_id));
    void Promise.allSettled(opened.map(async ({notification_id})=>{
      let receipt;
      try{receipt=await communityApi.markNotificationRead(notification_id);}
      catch(error){
        if(isAuthError(error)||!accountScope.current(ticket))return null;
        await new Promise(resolve=>setTimeout(resolve,750));
        if(!accountScope.current(ticket))return null;
        receipt=await communityApi.markNotificationRead(notification_id);
      }
      return receipt?.notification_id===notification_id&&typeof receipt.read_at==="string"&&
        /^\d{4}-\d{2}-\d{2}T/.test(receipt.read_at)&&Number.isFinite(Date.parse(receipt.read_at))?notification_id:null;
    })).then(results=>{
      for(const {notification_id} of opened)bottleReadsInFlight.current.delete(receiptKey(notification_id));
      const confirmed=results.flatMap(result=>result.status==="fulfilled"&&result.value?[result.value]:[]);
      if(!accountScope.current(ticket)||!confirmed.length)return;
      setReadBottles(previous=>{
        if(!accountScope.current(ticket))return previous;
        const ids=new Set(previous?.generation===ticket?previous.ids:undefined);
        for(const id of confirmed)ids.add(id);
        return {generation:ticket,ids};
      });
      setDirectBottleRead(previous=>previous?.ticket===ticket&&confirmed.includes(previous.notice.notification_id)?null:previous);
      bottleNotifications.reload();
    });
  },[alphaCommunityLayout,accountScope.capture,accountScope.current,askedQuestion.value,askedQuestion.loading,askedQuestion.error,bottleNotifications.value,bottleNotifications.reload,directBottleRead,readIds,replies.value,replies.loading,replies.error,comments.value,comments.loading,comments.error,state.questionID,state.deliveryID,state.replyTarget,state.screen]);
  const prefs=useRemote(s==="preferences"||parentChat?`prefs:${accountScope.generation}:${tick}`:null,()=>communityApi.preferences());
  const openTranslationSettings=alphaCommunityLayout&&s==="preferences"&&translationSettings?.ticket===accountScope.generation
    &&translationSettings.revision===navigationRevision.current?translationSettings:null;
  const translationChat=openTranslationSettings?.conversation;
  const translationConversations=useRemote(openTranslationSettings&&!translationChat?`translation-chats:${accountScope.generation}:${tick}`:null,async isCurrent=>{
    const rows=new Map<string,InboxItem>();
    const visited=new Set<string>();
    let cursor:string|null=null;
    do{
      const page=await communityApi.inbox(cursor);
      if(!isCurrent())return [];
      page.items.forEach(item=>{if(item.parent?.parent_id&&item.allowed_actions.includes("send_message"))rows.set(item.conversation_id,item);});
      cursor=page.next_cursor;
      if(!cursor||visited.has(cursor))break;
      visited.add(cursor);
    }while(isCurrent());
    return [...rows.values()];
  });
  const translationPermission=useRemote(translationChat?`translation-permission:${accountScope.generation}:${translationChat.conversationId}:${tick}`:null,
    ()=>communityApi.aiParticipation(translationChat!.conversationId));
  const blocks=useRemote(["blocked","blockedEmpty"].includes(s)?`blocks:${tick}`:null,()=>communityApi.blocks());
  const chat=useRemote(parentChat&&state.person?`chat:${conversationKey(state.person)}:${tick}`:null,async()=>{
    const key=conversationKey(state.person);
    let conversationId=knownConversations.current[key];
    if(!conversationId){conversationId=(await communityApi.openConversation(state.person,communityKey("conv"))).conversation.conversation_id;knownConversations.current[key]=conversationId;}
    const [list,ai]=await Promise.all([communityApi.messages(conversationId),communityApi.aiParticipation(conversationId)]);
    return {conversationId,conversation:list.conversation,messages:list.items,ai};
  });
  const chatAuthority=useRef(chat.value);chatAuthority.current=chat.value;
  const translationScope=communityTranslationScope(String(accountScope.generation),chat.value?.conversationId,locale,chat.value?.ai);
  const pausedKey=chat.value?`${chat.value.conversationId}:${chat.value.ai.epoch}`:"";
  const translationEnabled=parentChat&&s!=="consent"&&!!prefs.value?.auto_translate_messages&&!prefs.error&&!chat.error
    &&!!chat.value?.conversation.allowed_actions.includes("send_message")&&deviceAIAllowed&&translationPaused!==pausedKey
    &&translationPreferencePaused!==accountScope.generation;
  // Synchronous configuration hides old results in the very render that
  // withdraws authority; an effect must not flash a previous account's text.
  translations.configure(translationScope,translationEnabled);
  const translationKey=translationScope?JSON.stringify(translationScope):"";
  const translationMessages=chat.value?.messages.map(message=>message.message_id+":"+message.seq).join("|")??"";
  useEffect(()=>{
    if(!translationEnabled||!translationScope||!chat.value)return;
    const ticket=accountScope.capture(),person=state.person,revision=navigationRevision.current;
    const expected={userId:localAI.userId,session:localAI.session};
    const owns=()=>{
      const live=aiConsent.getState();
      return mounted.current&&accountScope.current(ticket)&&filterFocused.current&&latest.current.person===person
        &&navigationRevision.current===revision&&live.status==="allowed"&&live.version===AI_CONSENT_VERSION
        &&live.userId===expected.userId&&live.session===expected.session;
    };
    void translations.queue(chat.value.messages,owns,()=>{if(owns())setTranslationRevision(value=>value+1);});
  },[translations,translationKey,translationMessages,translationEnabled,localAI.userId,localAI.session,accountScope.capture,accountScope.current]);
  // New messages from the other parent arrive while the chat is open.
  useEffect(()=>{if(!parentChat)return;const timer=setInterval(()=>chat.reload(),8000);return()=>clearInterval(timer);},[parentChat,chat.reload]);
  // Reading the chat moves this parent's read cursor, never the other's.
  const lastSeq=chat.value?.messages.at(-1)?.seq;
  useEffect(()=>{if(chat.value&&lastSeq)communityApi.markRead(chat.value.conversationId,lastSeq).catch(()=>{});},[chat.value?.conversationId,lastSeq]);
  const incomingNotes=chat.value?.ai.requests.conversation_notes;
  const notesOfferKey=alphaCommunityLayout&&deviceAIAllowed&&chat.value?.ai.notes_offer_eligible===true
    &&!chat.value.ai.effective&&!incomingNotes&&chat.value.conversation.allowed_actions.includes("send_message")
    ?privateChatNotesOfferKey(localAI.userId!,chat.value.conversationId):null;
  const notesOfferDismissed=useRemote(notesOfferKey,()=>storage.getItem(notesOfferKey!,false));
  // Opening a chat can present a choice, but only the explicit Agree button
  // submits consent. The server's history excludes previously decided chats.
  useEffect(()=>{
    const value=chat.value;
    const ticket=accountScope.capture();
    if(!value||chat.loading||chat.error||busy||consentAction.current||!filterFocused.current||ticket===null
      ||!["chat","chatOn"].includes(latest.current.screen)||value.ai.conversation_id!==value.conversationId
      ||!value.conversation.allowed_actions.includes("send_message"))return;
    const request=value.ai.requests.conversation_notes;
    if(request){
      if(request.purpose!=="conversation_notes"||request.epoch!==value.ai.epoch||request.notice_version!==value.ai.notice_version
        ||request.state!=="pending"||request.initiated_by!=="parent"||request.my_decision!=="pending"||consentPrompted.current.has(request.request_id))return;
      consentPrompted.current.add(request.request_id);
      setConsentSheet({mode:"decision",conversationId:value.conversationId,person:state.person,noticeVersion:request.notice_version,epoch:request.epoch,requestId:request.request_id,ticket,revision:navigationRevision.current+1});
    }else{
      if(!notesOfferKey||notesOfferDismissed.value!==false||consentPrompted.current.has(notesOfferKey))return;
      consentPrompted.current.add(notesOfferKey);
      setConsentSheet({mode:"request",conversationId:value.conversationId,person:state.person,noticeVersion:value.ai.notice_version,epoch:value.ai.epoch,offerKey:notesOfferKey,ticket,revision:navigationRevision.current+1});
    }
    dispatch({type:"requestConsent"});
  },[s,state.person,chat.loading,!!chat.error,busy,chat.value?.conversationId,chat.value?.ai.epoch,chat.value?.ai.notice_version,
    incomingNotes?.request_id,incomingNotes?.state,incomingNotes?.my_decision,notesOfferKey,notesOfferDismissed.value,accountScope.capture]);
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
  useFocusEffect(useCallback(()=>{if(focusedOnce.current)setFocusTick(t=>t+1);focusedOnce.current=true;},[]));
  useEffect(() => { if(!home){pagerAligned.current=null;return;} alignPager(); }, [home, width, state.page]);
  useEffect(() => { closeFilter(); setProfileEditing(false); setConsentNeeded(false); }, [state.screen, state.person,closeFilter]);
  useEffect(() => { setSearch(""); }, [searchScope, state.person]);
  useEffect(()=>{
    if(state.screen!=="replyExpanded")return;
    // Focus after the expanded field and its native accessory have mounted.
    const frame=requestAnimationFrame(()=>{
      if(latest.current.screen==="replyExpanded"&&latest.current.questionID===state.questionID)replyAllInput.current?.focus();
    });
    return()=>cancelAnimationFrame(frame);
  },[state.screen,state.questionID]);

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
  const [chatPhotoDraft,setChatPhotoDraft]=useState<ChatPhotoDraft|null>(null);
  const chatPhotos=chatPhotoDraft?.person===state.person&&chatPhotoDraft.ticket===accountScope.generation?chatPhotoDraft.photos:[];
  const [pickingChatPhotos,setPickingChatPhotos]=useState(false);
  const photoPickerInFlight=useRef(false);
  const chatSendInFlight=useRef(false);
  useEffect(()=>{setChatPhotoDraft(current=>current&&(current.person!==state.person||current.ticket!==accountScope.generation)?null:current);},[state.person,accountScope.generation]);
  const removeChatPhotos=(ticket:number|null,person:string,ids:readonly string[])=>{
    setChatPhotoDraft(previous=>previous&&previous.ticket===ticket&&previous.person===person
      ?{...previous,photos:previous.photos.filter(photo=>!ids.includes(photo.id))}:previous);
  };
  // ── Reports (Play UGC policy): reviewed by a person at /admin, never by AI.
  const [report,setReport]=useState<{kind:ReportKind;id:string;title:string;allowBlock:boolean;
    original?:{conversationId:string;ticket:number;revision:number}}|null>(null);
  const originalLease=report?.original;
  const originalMessage=originalLease&&parentChat&&s!=="consent"&&accountScope.current(originalLease.ticket)
    &&filterFocused.current&&navigationRevision.current===originalLease.revision
    &&chat.value?.conversationId===originalLease.conversationId
    ?chat.value.messages.find(message=>message.message_id===report.id&&message.sender==="parent")
    :undefined;
  const activeReport=originalLease&&!originalMessage?null:report;
  const submitReport=(reason:ReportReason,note:string,blockToo:boolean)=>{
    const target=activeReport;if(!target)return;
    if(target.original&&(!accountScope.current(target.original.ticket)||!filterFocused.current
      ||navigationRevision.current!==target.original.revision))return;
    void write(async()=>{
      try{
        const result=await communityApi.report({target_kind:target.kind,target_id:target.id,reason,note:note||undefined,block:blockToo});
        refresh();
        dispatch({type:"notice",message:result.blocked?c("已收到举报，并已屏蔽对方。NURI 团队会尽快人工审核。","Report received and the parent is blocked. The NURI team will review it soon."):c("已收到举报，NURI 团队会尽快人工审核。","Report received. The NURI team will review it soon.")});
      }finally{if(mounted.current)setReport(null);}
    });
  };
  const reportButton=(kind:ReportKind,id:string,title:string,allowBlock:boolean,testID:string)=><Pressable accessibilityRole="button" accessibilityLabel={title} onPress={()=>setReport({kind,id,title,allowBlock})} testID={testID} hitSlop={8} style={{minWidth:44,minHeight:32,alignItems:"center",justifyContent:"center"}}><FinalText size={12} secondary style={{lineHeight:18}}>{c("举报","Report")}</FinalText></Pressable>;
  const reportSheet=<CommunityReportSheet key={activeReport?.id} visible={!!activeReport} busy={busy}
    title={activeReport?.title??""} allowBlock={!!activeReport?.allowBlock} originalText={originalMessage?.text}
    onClose={()=>setReport(null)} onSubmit={submitReport}/>;
  const pickChatImage=async()=>{
    if(busy||photoPickerInFlight.current||chatSendInFlight.current||voiceRef.current.slot)return;
    const person=latest.current.person,screen=latest.current.screen,ticket=accountScope.capture(),revision=navigationRevision.current;
    const current=()=>accountScope.current(ticket)&&mounted.current&&filterFocused.current&&navigationRevision.current===revision&&latest.current.person===person&&latest.current.screen===screen;
    if(ticket===null||!person||!["chat","chatOn"].includes(screen)||!current())return;
    const limit=alphaCommunityLayout?COMMUNITY_CHAT_PHOTO_LIMIT-chatPhotos.length:1;
    if(limit<1){dispatch({type:"notice",message:c("最多可选 10 张图片","You can select up to 10 photos")});return;}
    photoPickerInFlight.current=true;
    if(alphaCommunityLayout)setPickingChatPhotos(true);
    try{
      const photoOptions={mediaTypes:["images"] as ImagePicker.MediaType[],allowsEditing:false,base64:false,exif:false,quality:.78};
      const preparePhotos=async()=>{
        if(alphaCommunityLayout)return selectCommunityImages(current,async()=>{
          const result=await ImagePicker.launchImageLibraryAsync({...photoOptions,allowsMultipleSelection:true,orderedSelection:true,selectionLimit:limit});
          return result.canceled?[]:result.assets;
        },prepareChatImage,limit);
        const prepared=await selectCommunityImage(current,async()=>{
          if(Platform.OS==="web")return pickWebChatImageFile();
          const result=await ImagePicker.launchImageLibraryAsync({...photoOptions,allowsMultipleSelection:false});
          return result.canceled?null:result.assets[0]??null;
        },prepareChatImage);
        return prepared?[prepared]:[];
      };
      const selected=await preparePhotos();
      if(!selected.length||!current())return;
      const photos=selected.map(prepared=>({prepared,id:communityKey("img")}));
      dispatch({type:"notice",message:null});
      setChatPhotoDraft(previous=>{
        const existing=alphaCommunityLayout&&previous?.person===person&&previous.ticket===ticket?previous.photos:[];
        return {person,ticket,photos:[...existing,...photos].slice(0,alphaCommunityLayout?COMMUNITY_CHAT_PHOTO_LIMIT:1)};
      });
    }catch(error){
      if(!current())return;
      dispatch({type:"notice",message:error instanceof ChatImageInputError&&error.code==="too_large"?c("图片太大了，请换一张","That photo is too large"):c("无法读取这张图片，请换一张","Couldn't read that photo")});
    }finally{
      photoPickerInFlight.current=false;
      if(alphaCommunityLayout&&mounted.current)setPickingChatPhotos(false);
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
    return <Pressable key={id} testID={"final-parent-"+id} accessibilityRole="button" onPress={()=>{if(options.conversationId)knownConversations.current[conversationKey(id)]=options.conversationId;dispatch({type:"person",person:id,name,screen:options.invitation?(options.incoming?"incomingParent":"parent"):"chat"});}} style={{minHeight:options.invitation?68:options.inbox?72:66,paddingVertical:options.invitation?12:8,paddingHorizontal:options.invitation?0:8,flexDirection:"row",alignItems:"center",gap:options.invitation?12:16}}>
      <View style={{width:40,height:40,flexShrink:0}}><FriendPreviewAvatar/>{options.unread?(options.invitation?<View pointerEvents="none" style={{position:"absolute",right:-2,top:0,width:8,height:8,borderRadius:4,backgroundColor:FINAL_COLOR.coral}}/>:<UnreadBadge count={options.unread} style={{position:"absolute",right:-1,top:-8}}/>):null}</View>
      <View style={{flex:1,minWidth:0,gap:options.invitation?2:4}}><FinalText style={{fontWeight:"500",lineHeight:24}}>{name}</FinalText><FinalText size={options.invitation?12:14} secondary style={{lineHeight:20}} numberOfLines={1}>{description}</FinalText></View>
      {options.status?<FinalText size={12} secondary style={{width:96,maxWidth:"34%",lineHeight:20,textAlign:"right",flexShrink:1}}>{options.status}</FinalText>:<FinalText size={20} style={{width:16,lineHeight:24,textAlign:"center",color:FINAL_COLOR.accent}}>›</FinalText>}
    </Pressable>;
  };
  function page(body: ReactNode, actions?: ReactNode, fill = false, layout:{bodyStyle?:ViewStyle;cardStyle?:ViewStyle;mainStyle?:ViewStyle}={}) {
    return <NuriKeyboardFrame><View style={[st.main,layout.mainStyle]}><FinalSurface fill={fill} style={layout.cardStyle} testID={`final-community-${state.screen}`}><ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" showsVerticalScrollIndicator={false} style={{ flexShrink: 1, minHeight: 0, ...(fill ? { flex: 1 } : {}) }} contentContainerStyle={[st.body,layout.bodyStyle]}>{body}</ScrollView></FinalSurface>{actions||state.notice ? <View style={st.actions}>{notice}{actions}</View> : null}</View></NuriKeyboardFrame>;
  }

  // ── Writes ────────────────────────────────────────────────────────────────
  const sendQuestion=async()=>{
    const current=latest.current,text=selectedQuestionText(current);
    const ticket=accountScope.capture();
    if(current.screen!=="preview"||!text||busy||questionSendInFlight.current||ticket===null)return;
    const key=current.sendKey??communityKey("q");
    const previousRequest=questionSendRequest.current;
    const request=previousRequest?.client_request_id===key?previousRequest:{
      body:text,original_language:locale,version_source:current.questionVersion,
      polish_id:current.questionVersion==="polished"?current.polishID:null,
      anonymous:current.anonymous,show_child_age:current.showAge,client_request_id:key,
    };
    const owns=()=>mounted.current&&accountScope.current(ticket);
    questionSendRequest.current=request;
    questionSendInFlight.current=true;
    setQuestionSendPending(true);
    dispatch({type:"sending",key});
    try {
      const result=await communityApi.ask(request);
      if(!owns())return;
      questionSendRequest.current=null;
      lastRecipients.current=result.delivery.recipient_count;
      dispatch({type:"sent",key,id:result.question.question_id});
      refresh();
    } catch(error) {
      if(!owns()||latest.current.sendKey!==key)return;
      const message=communityErrorCode(error)||isAuthError(error)
        ?failure(error):c("暂时无法确认是否发送成功，请重试。","We couldn't confirm the send. Please try again.");
      dispatch({type:"sendFailed",key,message});
    } finally {
      questionSendInFlight.current=false;
      if(owns())setQuestionSendPending(false);
    }
  };
  const polish=()=>write(async()=>{
    const text=draft("question").trim();
    if(!text)return;
    const result=await communityApi.polish(text,locale,keyFor("polish",text,"polish"));
    dispatch({type:"polished",text:result.polish.text,id:result.polish.id});
  });
  const startQuestion=()=>{
    if(latest.current.sendKey){dispatch({type:"resumeQuestion"});return;}
    if(me.value&&!me.value.exists){dispatch({type:"go",screen:"profile"});dispatch({type:"notice",message:c("先建立你的社区档案，其他家长才能看到你的问题","Create your community profile first")});return;}
    dispatch({type:"newQuestion"});
  };
  const confirmQuestions=(action:"close"|"delete")=>{
    const ids=latest.current.selected;
    const ticket=accountScope.capture(), revision=navigationRevision.current;
    if(busy||!ids.length||latest.current.screen!==action||questionBatchInFlight.current||ticket===null)return;
    const ownsScreen=()=>accountScope.current(ticket)&&navigationRevision.current===revision&&latest.current.screen===action;
    questionBatchInFlight.current=true;
    void write(async()=>{
      try {
        const result=await communityApi.transitionQuestions(action,ids.map(question_id=>({question_id})),communityKey(action));
        if(!accountScope.current(ticket))return;
        refresh();
        if(!ownsScreen())return;
        dispatch({type:"questionsChanged"});
        if(!result.all_succeeded){
          const succeeded=result.results.filter(item=>item.ok).length, failed=ids.length-succeeded;
          const message=en?`${succeeded} updated, ${failed} unsuccessful. Check the list before retrying.`
            :translate(locale,"已处理 {succeeded} 个漂流瓶，{failed} 个未处理。请核对列表后重试。",{succeeded,failed});
          dispatch({type:"notice",message});
        }
      } catch(error) {
        if(ownsScreen())dispatch({type:"notice",message:failure(error)});
      } finally {
        questionBatchInFlight.current=false;
      }
    });
  };
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
    delete knownConversations.current[conversationKey(person)];
    refresh();dispatch({type:"safetyDone"});
  });
  const togglePreference=(key:keyof Omit<Preferences,"version">)=>write(async()=>{
    const current=prefs.value,ticket=accountScope.capture();if(!current||ticket===null)return;
    // A parent's OFF intent stops local translation even if the preference
    // write has an unknown outcome. Only an explicit confirmed ON clears it.
    if(key==="auto_translate_messages"&&current.auto_translate_messages){setTranslationPreferencePaused(ticket);translations.clear();}
    const saved=await communityApi.savePreferences({[key]:!current[key],expected_version:current.version});
    if(!accountScope.current(ticket))return;
    if(key==="auto_translate_messages"&&saved.auto_translate_messages===true)setTranslationPreferencePaused(null);
    prefs.reload();
  });
  const changeTranslationSettings=(conversation?:TranslationSettings["conversation"])=>{
    const ticket=accountScope.capture();
    if(ticket===null||!filterFocused.current||latest.current.screen!=="preferences")return;
    const next={ticket,revision:navigationRevision.current,conversation};
    translationSettingsRef.current=next;
    setTranslationSettings(next);
  };
  const changeTranslationPermission=(settings:TranslationSettings,action:TranslationPermissionAction)=>write(async()=>{
    const target=settings.conversation;
    const owns=()=>mounted.current&&filterFocused.current&&accountScope.current(settings.ticket)
      &&translationSettingsRef.current===settings&&navigationRevision.current===settings.revision
      &&latest.current.screen==="preferences";
    const aiOK=()=>{
      const live=aiConsent.getState();
      return live.status==="allowed"&&!!live.userId&&live.version===AI_CONSENT_VERSION
        &&live.userId===localAI.userId&&live.session===localAI.session;
    };
    if(!target||!owns()||((action==="request"||action==="approve")&&!aiOK()))return;
    const id=target.conversationId;
    const snapshot=translationPermission.value;
    const previous=currentTranslationRequest(id,snapshot);
    if(!snapshot||translationPermission.loading||translationPermission.error||
      !communityTranslationActions(previous).some(candidate=>candidate===action))return;
    if(action==="revoke"){setTranslationPaused(`${id}:${snapshot.epoch}`);translations.clear();}
    try{
      const fresh=await communityApi.aiParticipation(id);
      if(!owns()||((action==="request"||action==="approve")&&!aiOK()))return;
      const request=currentTranslationRequest(id,fresh);
      if(fresh.epoch!==snapshot.epoch||fresh.notice_version!==snapshot.notice_version||
        request?.request_id!==previous?.request_id||request?.version!==previous?.version||
        !communityTranslationActions(request).some(candidate=>candidate===action)){
        translationPermission.reload();
        dispatch({type:"notice",message:c("会话许可已变更，请重新核对","Conversation permissions changed. Check again.")});
        return;
      }
      if(action==="revoke"){
        await communityApi.revokeAI(id,"translation");
      }else if(action==="request"){
        const slot=`air:${id}:translation`;
        const key=keyFor(slot,`${fresh.notice_version}:${fresh.epoch}`,"air");
        const {request:created}=await communityApi.requestAI(id,fresh.notice_version,key,"translation");
        if(accountScope.current(settings.ticket)&&writeKeys.current[slot]?.key===key)delete writeKeys.current[slot];
        if(!owns())return;
        if(created.purpose!=="translation"||created.epoch!==fresh.epoch||created.notice_version!==fresh.notice_version
          ||!["pending","effective"].includes(created.state))throw new Error("TRANSLATION_PERMISSION_CHANGED");
        if(created.initiated_by==="parent"&&created.my_decision==="pending"&&aiOK()){
          await communityApi.decideAI(created.request_id,"allow",fresh.notice_version,
            keyFor(`aid:${created.request_id}`,`allow:${created.version}`,"aid"),created.version);
        }
      }else if(request){
        const decision=action==="approve"?"allow":"decline";
        await communityApi.decideAI(request.request_id,decision,fresh.notice_version,
          keyFor(`aid:${request.request_id}`,`${decision}:${request.version}`,"aid"),request.version);
      }
      if(owns()){
        translationPermission.reload();
        dispatch({type:"notice",message:""});
      }
    }catch(error){if(owns()){translationPermission.reload();throw error;}}
  });
  const saveProfile=(after:()=>void|Promise<void>)=>write(async()=>{
    const profile=me.value?.profile;
    const about=state.drafts["profile:about"];
    const draftName=state.drafts["profile:name"]?.trim();
    const displayName=draftName||(!profile?account.value?.nickname?.trim()||c("新家长","New parent"):"");
    if(alphaCommunityLayout&&displayName!==profile?.display_name&&isChineseDisplayNameTooLong(displayName)){
      dispatch({type:"notice",message:chineseDisplayNameLimitMessage(locale)});
      return;
    }
    const preserveLegacyName=alphaCommunityLayout&&displayName===profile?.display_name&&isChineseDisplayNameTooLong(displayName);
    await communityApi.saveProfile({
      ...(profile?{}:{city:(account.value?.city||"").trim().slice(0,60)}),
      ...(about!==undefined?{about:about.trim().slice(0,300)}:{}),
      ...(displayName&&!preserveLegacyName?{display_name:displayName.slice(0,30)}:{}),
      ...(state.drafts["profile:gender"]?{gender_tag:state.drafts["profile:gender"] as GenderTag}:{}),
      intents:intentCodes(state.intents),
      ...(profile?{expected_version:profile.version}:{}),
    });
    me.reload();await after();
  });
  const completeFriendIntent=(skipped:boolean)=>{
    if(!alphaCommunityLayout){
      if(!skipped&&me.value?.exists)return saveProfile(()=>go("profile"));
      go("profile");return;
    }
    if(busy||!me.value)return;
    const ticket=accountScope.capture(),revision=navigationRevision.current;
    const current=()=>accountScope.current(ticket)&&filterFocused.current&&revision===navigationRevision.current&&latest.current.screen==="intent";
    if(!current())return;
    const finish=async()=>{
      if(!current())return;
      const accountId=account.value?.id??(await api.me()).id;
      if(!current())return;
      if(typeof accountId!=="string"||!accountId||!await storage.setItem(friendIntentKey(accountId),true)){
        throw new Error("Couldn't save completion of friend-intent onboarding");
      }
      if(current())go("profile");
    };
    if(!skipped&&me.value.exists)return saveProfile(finish);
    return write(finish);
  };
  function sendChat(){
    if(busy||chatSendInFlight.current||photoPickerInFlight.current)return;
    // Read the latest text because a voice transcript may have landed this tick.
    const {person,screen,drafts}=latest.current,slot="chat:"+person,text=drafts[slot]??"",conversationId=chat.value?.conversationId;
    const ticket=accountScope.capture(),revision=navigationRevision.current;
    const owns=()=>accountScope.current(ticket)&&mounted.current;
    const current=()=>owns()&&filterFocused.current&&navigationRevision.current===revision&&latest.current.person===person
      &&latest.current.screen===screen&&chatAuthority.current?.conversationId===conversationId;
    if((!text.trim()&&!chatPhotos.length)||!conversationId||!["chat","chatOn"].includes(screen)||!current())return;
    chatSendInFlight.current=true;
    dispatch({type:"notice",message:null});
    return write(async()=>{
      try{
        await sendCommunityChatPhotos(chatPhotos,text.trim(),current,
          async photo=>(await communityApi.uploadImage(photo.prepared.dataUri,"message",photo.id)).media.media_id,
          (caption,mediaIds)=>communityApi.sendMessage(conversationId,caption,keyFor(slot,JSON.stringify([conversationId,caption,mediaIds]),"msg"),mediaIds),
          (photos,caption)=>{
            if(!owns())return;
            delete writeKeys.current[slot];
            removeChatPhotos(ticket,person,photos.map(photo=>photo.id));
            if((caption||!photos.length)&&latest.current.drafts[slot]===text)dispatch({type:"messageSent",slot});
            if(current())chat.reload();
          },chat.value?.conversation.message_media_limit);
      }catch(error){
        if(current())dispatch({type:"notice",message:failure(error)});
      }finally{chatSendInFlight.current=false;}
    });
  }
  // Every callback belongs to the chat and notice rendered beside that button.
  // Never rebind an old button to the latest chat/sheet when it finally fires.
  const consentRenderLease:ChatConsentLease|null=chat.value?{conversationId:chat.value.conversationId,person:state.person,screen:state.screen,
    epoch:chat.value.ai.epoch,noticeVersion:chat.value.ai.notice_version,ticket:accountScope.capture(),revision:navigationRevision.current}:null;
  const currentConsentLease=(lease:ChatConsentLease|null)=>{
    const value=chatAuthority.current;
    return !!lease&&lease.ticket!==null&&mounted.current&&accountScope.current(lease.ticket)&&filterFocused.current
      &&navigationRevision.current===lease.revision&&latest.current.person===lease.person&&latest.current.screen===lease.screen
      &&value?.conversationId===lease.conversationId&&value.ai.epoch===lease.epoch&&value.ai.notice_version===lease.noticeVersion;
  };
  const openConsent=()=>{
    const lease=consentRenderLease,value=chatAuthority.current;
    if(busy||consentAction.current||currentConsentLease(revokeAction.current)||!currentConsentLease(lease)||!lease||!value
      ||!["chat","chatOn"].includes(lease.screen)||!value.conversation.allowed_actions.includes("send_message"))return;
    const request=value.ai.requests.conversation_notes;
    setConsentSheet({mode:request?.state==="pending"&&request.my_decision==="pending"?"decision":"request",
      conversationId:lease.conversationId,person:lease.person,noticeVersion:lease.noticeVersion,epoch:lease.epoch,
      requestId:request?.request_id,ticket:lease.ticket,revision:lease.revision+1});
    dispatch({type:"requestConsent"});
  };
  const closeConsent=(expectedSheet:ConsentSheet|null)=>{
    // The current sheet may be dismissed after its notice/epoch changes, but
    // an old sheet's Cancel/Close must never dismiss its replacement.
    if(!expectedSheet||expectedSheet!==consentSheetRef.current||!currentConsentLease(consentRenderLease)||consentRenderLease?.screen!=="consent")return;
    dismissNotesOffer(expectedSheet);
    setConsentSheet(null);dispatch({type:"consentClosed",effective:!!chatAuthority.current?.ai.effective});
  };
  const revokeConsent=async()=>{
    const lease=consentRenderLease;
    if(busy||consentAction.current||!lease||!["chat","chatOn"].includes(lease.screen)||!currentConsentLease(lease)
      ||currentConsentLease(revokeAction.current))return;
    revokeAction.current=lease;
    // The backend bumps the whole conversation epoch, even for a single
    // purpose. Stop local work now; an unconfirmed withdrawal never resumes it.
    setTranslationPaused(`${lease.conversationId}:${lease.epoch}`);translations.clear();
    const current=()=>revokeAction.current===lease&&currentConsentLease(lease);
    try{await communityApi.revokeAI(lease.conversationId,"conversation_notes");if(current())chat.reload();}
    catch(error){if(current())dispatch({type:"notice",message:failure(error)});}
    finally{if(revokeAction.current===lease)revokeAction.current=null;}
  };
  const toggleAI=(on:boolean)=>{if(on)openConsent();else void revokeConsent();};
  const decideAI=async(sheet:ConsentSheet|null,allowed:boolean)=>{
    if(!sheet||sheet!==consentSheetRef.current||busy||consentAction.current)return;
    const current=()=>{
      const value=chatAuthority.current;
      return mounted.current&&accountScope.current(sheet.ticket)&&filterFocused.current&&navigationRevision.current===sheet.revision&&consentSheetRef.current===sheet&&latest.current.screen==="consent"
        &&latest.current.person===sheet.person&&value?.conversationId===sheet.conversationId
        &&value.ai.epoch===sheet.epoch&&value.ai.notice_version===sheet.noticeVersion;
    };
    if(!current())return;
    if(!allowed&&sheet.mode==="request"){closeConsent(sheet);return;}
    const canAllow=()=>{
      const live=aiConsent.getState();
      return live.status==="allowed"&&!!live.userId&&live.userId===localAI.userId&&live.session===localAI.session&&live.version===AI_CONSENT_VERSION;
    };
    if(allowed&&!canAllow()){
      setConsentNeeded(true);
      dispatch({type:"notice",message:c("需要先允许使用 AI 功能","AI permission is needed first")});
      return;
    }
    const existing=chatAuthority.current?.ai.requests.conversation_notes;
    if(sheet.mode==="decision"&&(!existing||existing.request_id!==sheet.requestId||existing.purpose!=="conversation_notes"))return;
    consentAction.current=true;setBusy(true);
    try{
      const requestSlot="air:"+sheet.conversationId+":conversation_notes";
      const requestKey=sheet.mode==="request"?keyFor(requestSlot,sheet.noticeVersion+":"+sheet.epoch,"air"):null;
      let result=sheet.mode==="request"
        ?await communityApi.requestAI(sheet.conversationId,sheet.noticeVersion,requestKey!,"conversation_notes")
        :await communityApi.decideAI(sheet.requestId!,allowed?"allow":"decline",sheet.noticeVersion,keyFor("aid:"+sheet.requestId,allowed+":"+sheet.noticeVersion,"aid"));
      if(result.request.purpose!=="conversation_notes"||result.request.epoch!==sheet.epoch||result.request.notice_version!==sheet.noticeVersion)throw new Error("CONSENT_RESULT_CHANGED");
      // A confirmed response ends this logical P25 operation. A later explicit
      // request (e.g. after refusal, without an epoch bump) needs a fresh key;
      // unknown-outcome exceptions keep their original idempotency key.
      if(requestKey&&accountScope.current(sheet.ticket)&&writeKeys.current[requestSlot]?.key===requestKey)delete writeKeys.current[requestSlot];
      if(!current())return;
      if(allowed&&!["pending","effective"].includes(result.request.state)){
        dispatch({type:"notice",message:notesConsentCopy.changed});chat.reload();return;
      }
      // A simultaneous request from the other parent may already exist. P25
      // returns it without consenting on this parent's behalf; the explicit
      // Allow click still needs its own P26 decision in that case.
      if(allowed&&result.request.my_decision==="pending"){
        if(!canAllow())return;
        result=await communityApi.decideAI(result.request.request_id,"allow",sheet.noticeVersion,keyFor("aid:"+result.request.request_id,"true:"+sheet.noticeVersion,"aid"));
        if(!current())return;
      }
      if(result.request.purpose!=="conversation_notes"||result.request.epoch!==sheet.epoch||result.request.notice_version!==sheet.noticeVersion)throw new Error("CONSENT_RESULT_CHANGED");
      if(allowed&&!["pending","effective"].includes(result.request.state)){
        dispatch({type:"notice",message:notesConsentCopy.changed});chat.reload();return;
      }
      setConsentSheet(null);
      dispatch({type:"consentClosed",effective:result.request.effective});
      chat.reload();
    }catch(error){if(current())dispatch({type:"notice",message:communityErrorCode(error)==="CONSENT_REVOKED_OR_CHANGED"?notesConsentCopy.changed:failure(error)});}
    finally{consentAction.current=false;if(mounted.current&&accountScope.current(sheet.ticket))setBusy(false);}
  };

  // ── Settings: preferences, blocked parents, a parent's safety menu ────────
  if (settingsScreen) {
    const p=prefs.value,blocked=blocks.value?.items??[];
    const ct=(cn:string,english:string,tw:string)=>locale==="zh-TW"?tw:c(cn,english);
    const permission=translationChat?currentTranslationRequest(translationChat.conversationId,translationPermission.value):undefined;
    const permissionActions=communityTranslationActions(permission);
    const permissionLabels={
      request:ct("同意翻译并请求对方","Allow translation and ask them","同意翻譯並請求對方"),
      approve:ct("同意翻译","Allow translation","同意翻譯"),
      decline:ct("不同意","Decline","不同意"),
      revoke:permission?.state==="pending"?ct("取消请求","Cancel request","取消請求"):ct("撤回翻译许可","Withdraw translation permission","撤回翻譯許可"),
    };
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
        <FinalText size={12} secondary style={{fontWeight:"500",lineHeight:16}}>
          {alphaCommunityLayout?ct("译文跟随 App 当前语言。双方允许后，长按消息可查看原文。","Translations follow your app language. Press and hold a translated message to see the original.","譯文跟隨 App 目前語言。雙方允許後，長按訊息可查看原文。"):originalMessageHint}
        </FinalText>
        {alphaCommunityLayout?<SettingsRow label={ct("会话翻译许可","Conversation translation permissions","對話翻譯許可")}
          disabled={busy} onPress={()=>changeTranslationSettings()} testID="final-community-translation-permissions"/>:null}
        {openTranslationSettings?<View style={{gap:12}} testID="final-community-translation-settings">
          {translationChat?<><FinalText>{translationChat.parentName}</FinalText>
            {pending(translationPermission)}
            {!translationPermission.loading&&!translationPermission.error&&permission!==undefined?<><FinalText size={12} secondary>
              {ct("双方允许后，Nuri 会将需要翻译的消息送给 OpenAI。许可涵盖本会话的历史消息，原文会保留。","If you both agree, Nuri sends messages that need translation to OpenAI. This permission covers past messages in this conversation. The original text is kept.","雙方允許後，Nuri 會將需要翻譯的訊息送給 OpenAI。許可涵蓋這段對話的歷史訊息，原文會保留。")}
            </FinalText>
            {permission?.effective?<FinalText size={12} secondary>{ct("双方已允许翻译","You both allowed translation","雙方已允許翻譯")}</FinalText>:null}
            {permission?.state==="pending"&&permission.my_decision==="allow"?<FinalText size={12} secondary>{ct("等待对方同意","Waiting for them","等待對方同意")}</FinalText>:null}
            {permissionActions.some(action=>action==="revoke")?<FinalText size={12} secondary>
              {ct("撤回后，本会话的其他 Nuri 许可可能需要重新确认。","After withdrawing, you may need to confirm other Nuri permissions in this conversation again.","撤回後，這段對話的其他 Nuri 許可可能需要重新確認。")}
            </FinalText>:null}
            {permissionActions.map(action=><SettingsRow key={action} label={permissionLabels[action]} testID={`final-translation-permission-${action}`}
              disabled={busy||((action==="request"||action==="approve")&&!deviceAIAllowed)}
              onPress={()=>void changeTranslationPermission(openTranslationSettings,action)}/>)}
            {!deviceAIAllowed&&permissionActions.some(action=>action==="request"||action==="approve")?
              <SettingsRow label={ct("去开启 AI 功能","Turn on AI","前往開啟 AI 功能")} testID="final-translation-ai-permission"
                onPress={()=>router.push(aiPermissionHref("/community"))}/>:null}
            </>:null}
            {!translationPermission.loading&&!translationPermission.error&&permission===undefined?<FinalText size={12} secondary>
              {ct("暂时无法核对这段会话的许可。","We couldn't verify permissions for this conversation.","暫時無法核對這段對話的許可。")}
            </FinalText>:null}
          </>:<>{pending(translationConversations)}
            {translationConversations.value?.map(item=><SettingsRow key={item.conversation_id} label={nameOf(item.parent)}
              testID={`final-translation-conversation-${item.conversation_id}`}
              onPress={()=>changeTranslationSettings({conversationId:item.conversation_id,parentName:nameOf(item.parent)})}/>)}
            {!translationConversations.loading&&translationConversations.value?.length===0?<FinalText size={12} secondary>
              {ct("建立私聊后，可在这里管理会话翻译。","Conversation permissions appear here once you start chatting.","建立私聊後，可在這裡管理對話翻譯。")}
            </FinalText>:null}
          </>}
        </View>:null}
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
        <SettingsRow label={c("举报这位家长", "Report this parent")} onPress={() => setReport({kind:"parent",id:state.person,title:c("举报这位家长","Report this parent"),allowBlock:true})} testID="final-report-parent-menu" />
        <SettingsRow label={c("屏蔽这位家长", "Block this parent")} danger onPress={() => dispatch({type:"safety",action:"block"})} testID="final-block-parent" />
        {parentView.value?.relationship.state==="connected"?<SettingsRow label={c("解除联系", "Disconnect")} danger onPress={() => dispatch({type:"safety",action:"disconnect"})} />:null}
      </>}
    </SettingsPage>{state.screen==="safetyConfirm"?<Modal transparent animationType="fade" onRequestClose={()=>dispatch({type:"back"})}><BlurView tint="light" intensity={40} style={[st.modal,{backgroundColor:"rgba(254,250,247,.5)"}]}><FinalSurface surfaceColor="rgba(255,255,255,.94)" style={{width:354,maxWidth:"100%",boxShadow:"0px 4px 8px rgba(89,71,92,.14)"}} contentStyle={{padding:24,gap:16}}><FinalText size={20} secondary style={{lineHeight:28,fontWeight:"500"}}>{state.safetyAction==="unblock"?c("取消屏蔽这位家长？","Unblock this parent?"):state.safetyAction==="block"?c("屏蔽这位家长？","Block this parent?"):c("解除联系？","Disconnect?")}</FinalText><FinalText size={14} secondary>{state.safetyAction==="block"?c("屏蔽后，你们会解除联系，对方无法再看到你或给你发消息。","Blocking also disconnects you; they can no longer see or message you."):state.safetyAction==="unblock"?c("解除屏蔽不会自动恢复好友关系。","Unblocking does not restore the connection."):c("聊天记录会保留，但你们不能再互发消息。","Your chat history stays, but neither of you can send new messages.")}</FinalText>{notice}<View style={{flexDirection:"row",gap:12}}><SettingsButton secondary style={{flex:1,width:undefined}} label={c("取消","Cancel")} onPress={()=>dispatch({type:"back"})}/><SettingsButton style={{flex:1,width:undefined}} label={c("确认","Confirm")} onPress={confirmSafety} testID="final-confirm-safety"/></View></FinalSurface></BlurView></Modal>:null}{reportSheet}</>;
  }

  // ── Hub pager: questions (left) and friends / inbox (right) ──────────────
  if (home) {
    const askLabel=state.sendKey
      ?questionSendPending?c("查看发送进度","View send progress"):c("继续发送漂流瓶","Resume sending")
      :c("向家长提问", "Ask parents");
    const inboxItems=inbox.value?.items??[];
    const latestQuestion=minePreview.value,latestWaiting=receivedPreview.value;
    const previewDetail=(remote:Remote<unknown>,body:string|undefined,empty:string)=>{
      if(remote.value!==undefined)return body??empty;
      return remote.error?c("加载失败，请稍后再试","Couldn’t load preview"):c("正在加载…","Loading…");
    };
    const preview=(item:InboxItem)=>item.last_message?.preview||c("开始聊天吧","Say hello");
    const entries=[
      ["myQuestions",!!latestQuestion?.reply_count,c("我的问题","My questions"),previewDetail(minePreview,latestQuestion?.body,c("还没有发出漂流瓶","No bottles sent yet")),latestQuestion?(latestQuestion.reply_count?c(latestQuestion.reply_count+" 位家长分享了经验",latestQuestion.reply_count+" parents shared experiences"):c("等待回复","Waiting for replies")):"",minePreview.loading&&latestQuestion===undefined,unreadSent],
      ["received",!!latestWaiting,c("收到问题","Received questions"),previewDetail(receivedPreview,latestWaiting?.question.body,c("暂时没有新的问题","No new questions")),latestWaiting?c(nameOf(latestWaiting.question.author)+"想听听你的意见",nameOf(latestWaiting.question.author)+" would like your thoughts"):"",receivedPreview.loading&&latestWaiting===undefined,unreadReceived],
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
              <View style={{height:32,flexDirection:"row",alignItems:"center",gap:4}}><Pressable testID="final-collapse-inbox" accessibilityRole="button" accessibilityLabel={c("收起我的消息","Collapse messages")} onPress={()=>go("friends")} style={{flex:1,minHeight:32,flexDirection:"row",alignItems:"center",gap:4}}><FinalText style={{fontWeight:"500"}}>{c("我的消息","Messages")}</FinalText><FinalText size={16} style={{color:FINAL_COLOR.accent}}>⌄</FinalText></Pressable><Pressable testID="final-open-contacts" accessibilityRole="button" accessibilityLabel={c("通讯录","Address book")} onPress={()=>go("contacts")} style={{width:44,height:44,alignItems:"center",justifyContent:"center"}}><Image source={require("@/assets/final-flow-20261101/address-book.svg")} style={{width:24,height:24}} contentFit="contain" accessible={false}/></Pressable></View>
              {pending(inbox)}
              {inboxItems.filter(item=>nameOf(item.parent).toLocaleLowerCase().includes(search.toLocaleLowerCase())).map((item,i)=><View key={item.conversation_id} style={{gap:4}}>{i?<View style={st.friendDivider}/>:null}{parentRow(item.parent,preview(item),{unread:item.unread_count,inbox:true,conversationId:item.conversation_id})}</View>)}
              {inbox.value&&!inboxItems.length?<FinalText secondary style={{paddingVertical:16,textAlign:"center"}}>{c("还没有消息","No messages yet")}</FinalText>:null}
            </View>
        </ScrollView></View>:<ScrollView key={`preview-${mode}`} directionalLockEnabled nestedScrollEnabled showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" style={{flex:1,minHeight:0}} contentContainerStyle={{ paddingHorizontal: 24, paddingTop: communityHubTopPadding(pagerHeight,mode), paddingBottom: 16, gap: 12 }}>
      <View style={{ height: mode ? 240 : 260, gap: mode ? 8 : 28, alignItems: "center" }}><View style={{ height: 180, width: "100%", alignItems: "center", justifyContent: "center" }}>{mode ? <View style={{ position:"absolute", left:"22.03%", top:-5, width:"61.02%", aspectRatio:200.13558959960938/169.00338745117188, overflow: "hidden" }}><Image source={require("@/assets/final-flow-20261101/parent-friends.png")} contentFit="fill" style={{ position: "absolute", left: 0, top: "-0.07%", width: "100%", height: "110.66%" }} /></View> : <Image source={require("@/assets/final-flow-20261101/question-mascot.svg")} style={{ width: 146, height: 181 }} contentFit="contain" />}</View><FinalText size={18} style={{ textAlign: "center" }}>{mode ? c("认识聊得来的家长", "Meet other parents") : c("把问题交给有经历的人", "Get advice from other parents")}</FinalText></View>
      <FinalButton label={mode ? c("寻找育儿好友", "Find friends") : askLabel} onPress={() => mode ? findFriends() : startQuestion()} testID={`final-hub-primary-${mode}`} />
      {mode ? <View testID="final-friends-messages" style={{paddingTop:4,gap:4}}><View style={st.friendDivider}/><View style={{ flexDirection: "row", alignItems: "center", minHeight:32 }}><Pressable accessibilityRole="button" accessibilityLabel={c("展开我的消息","Expand messages")} onPress={() => go("inbox")} style={{ flex: 1, minHeight: 32, flexDirection:"row", alignItems:"center", gap:4 }} testID="final-open-inbox"><FinalText>{c("我的消息", "Messages")}</FinalText><FinalText size={16} style={{color:FINAL_COLOR.accent}}>⌃</FinalText></Pressable><Pressable accessibilityRole="button" accessibilityLabel={c("通讯录", "Address book")} onPress={() => go("contacts")} style={{ width: 44, height: 32, alignItems: "center", justifyContent: "center" }} testID="final-open-contacts"><Image source={require("@/assets/final-flow-20261101/address-book.svg")} style={{ width: 24, height: 24 }} /></Pressable></View>
        {pending(inbox,false)}
        {inboxItems.slice(0,2).map((item,i) => <View key={item.conversation_id} style={{gap:4}}>{i?<View style={st.friendDivider}/>:null}<Pressable testID={`final-parent-${item.parent?.parent_id}`} accessibilityRole="button" accessibilityLabel={`${nameOf(item.parent)}，${preview(item)}`} style={st.friendPreviewRow} onPress={() => {if(!item.parent?.parent_id)return;knownConversations.current[conversationKey(item.parent.parent_id)]=item.conversation_id;dispatch({ type: "person", person: item.parent.parent_id, name: nameOf(item.parent), screen: "chat" });}}><FriendPreviewAvatar/><View style={{flex:1,minWidth:0,gap:4}}><FinalText style={{lineHeight:24}}>{nameOf(item.parent)}</FinalText><FinalText size={14} secondary numberOfLines={1} ellipsizeMode="tail" style={{lineHeight:20}}>{preview(item)}</FinalText></View><FinalText size={20} style={{width:16,lineHeight:24,textAlign:"center",color:FINAL_COLOR.accent}}>›</FinalText><UnreadBadge count={item.unread_count} style={{position:"absolute",left:"9.58%",top:"6.57%"}}/></Pressable></View>)}
        {inbox.value&&!inboxItems.length?<FinalText size={14} secondary style={{paddingVertical:12,textAlign:"center"}}>{c("建立联系后，消息会出现在这里","Messages appear here once you connect")}</FinalText>:null}
      </View> : <><FinalDivider/>{entries.map(([screen, fresh, label, detail, status, loading, unreadCount], i) =>
                <Pressable key={screen} testID={i ? "final-open-received" : "final-open-my-questions"} accessibilityRole="button" accessibilityLabel={[label,detail,status,alphaCommunityLayout&&unreadCount?bottleUnreadLabel(unreadCount):null].filter(Boolean).join("，")} accessibilityState={{busy:loading}} onPress={() => go(screen)} style={st.questionEntry}>
                  <View style={st.questionTitle}>{alphaCommunityLayout?<BottleStatus count={unreadCount} testID={`final-bottle-icon-${screen}`} hub/>:<View style={{width:29,height:24,justifyContent:"center",flexShrink:0}}>{fresh?<Image testID={`final-bottle-icon-${screen}`} source={require("@/assets/final-flow-20261101/bottle-unread.svg")} style={{width:31,height:29}} contentFit="contain" accessible={false} accessibilityElementsHidden />:<View style={{width:24,height:24,alignItems:"center",justifyContent:"center"}}><Image testID={`final-bottle-icon-${screen}`} source={require("@/assets/final-flow-20261101/community-question-bottle-coral.svg")} style={{width:7.875,height:16.3125,transform:[{rotate:"45deg"}]}} contentFit="contain" accessible={false} accessibilityElementsHidden /></View>}</View>}<FinalText size={16} style={{lineHeight:24,flex:1,minWidth:0}}>{label}</FinalText></View>
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
          const draftText=draft(slot);
          const fontFamily=locale==="zh-CN"?"NotoSansSC_400Regular":undefined;
          const fieldStyle={minHeight:original?122:78,padding:16,paddingRight:choosing?38:16};
          return <View key={slot} style={{minHeight:original?176:80,borderWidth:1,borderRadius:18,borderColor:choosing&&selected?FINAL_COLOR.selected:"#E0D8DC",backgroundColor:"rgba(255,250,245,.9)"}}>
            <View>
              {Platform.OS==="web"?<View aria-hidden pointerEvents="none" style={fieldStyle}>
                <FinalText style={{opacity:0,lineHeight:24,fontFamily}}>{draftText+"\u200b"}</FinalText>
              </View>:null}
              <NuriTextInput testID={original?"final-question-input":"final-polished-input"} accessibilityLabel={original?c("我的原始问题","My original question"):c("Nuri版本草稿","Nuri version draft")} multiline scrollEnabled={false} maxLength={1000} value={draftText} onChangeText={text=>setDraft(slot,text)} onFocus={()=>{
                if(filterMounted.current&&filterFocused.current&&questionFocusEpoch.current===focusEpoch&&["compose","original","polished"].includes(latest.current.screen))setQuestionFocusedInput(slot);
              }} onBlur={()=>{
                if(filterMounted.current&&questionFocusEpoch.current===focusEpoch)setQuestionFocusedInput(current=>current===slot?null:current);
              }} placeholder={c("写下你的问题…","Write your question…")} placeholderTextColor="#918896" style={[fieldStyle,{fontSize:16,lineHeight:24,color:FINAL_COLOR.ink,textAlignVertical:"top",fontFamily},Platform.OS==="web"&&{...StyleSheet.absoluteFillObject,width:"100%",height:"100%"}]}/>
            </View>
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
    </>,questionFocusedInput?undefined:<FinalButton label={c("预览问题","Preview question")} disabled={!selectedQuestionText(state)} onPress={()=>dispatch({type:"previewQuestion"})} testID="final-preview-question"/>,true);
  }
  if(state.screen==="preview"){
    const text=selectedQuestionText(state);
    const sendError=state.sendKey?state.sendError:null;
    return page(<>
      <FinalSurface radius={20} style={{boxShadow:"0px 0px 8px rgba(89,71,92,.12)",minHeight:136}} contentStyle={{padding:16,gap:12}}>
        <FinalText size={12} secondary style={{lineHeight:18}}>{state.questionVersion==="polished"?c("Nuri 润色版","Nuri version"):c("我的原话","My words")}</FinalText>
        <FinalText size={20} style={{fontWeight:"500",lineHeight:28}}>{text}</FinalText>
      </FinalSurface>
      <View style={{minHeight:42,flexDirection:"row",alignItems:"flex-start",gap:12}}><SampleAvatar/><View style={{flex:1,minWidth:0}}><FinalText style={{fontWeight:"500",lineHeight:24}}>{state.anonymous?c("匿名家长","Anonymous parent"):me.value?.profile?.display_name??c("你的社区名字","Your community name")}</FinalText>{state.showAge?<FinalText size={12} secondary style={{lineHeight:18}}>{c("会显示你最小孩子的年龄","Your youngest child's age will be shown")}</FinalText>:null}</View></View>
      {sendError?<FinalText testID="final-bottle-send-error" size={14} style={{color:FINAL_COLOR.coral}}>{sendError}</FinalText>:null}
    </>,<View style={st.actionRow}>
      <FinalButton small secondary label={questionSendPending?c("返回社区","Back to community"):c("返回编辑","Edit")} onPress={()=>questionSendPending?go("hub"):dispatch({type:"back"})}/>
      <FinalButton small disabled={busy||questionSendPending||!text} label={questionSendPending?c("正在发送","Sending"):c("发送漂流瓶","Send bottle")} onPress={()=>void sendQuestion()} testID="final-send-question"/>
    </View>,false,{bodyStyle:{padding:12,paddingBottom:16,gap:16},cardStyle:{boxShadow:"0px 0px 8px rgba(89,71,92,.12)"},mainStyle:{paddingTop:12}});
  }
  if(state.screen==="inviteSent")return page(<View style={{minHeight:463,gap:8}}><View style={{height:322,alignItems:"center"}}><Image source={require("@/assets/final-flow-20261101/community-invite-sent.svg")} style={{width:179,height:223,marginTop:42}} contentFit="contain" accessible={false}/></View><View style={{gap:6}}><FinalText testID="final-invite-sent-title" size={24} style={{fontWeight:"500",lineHeight:32,paddingVertical:2,textAlign:"center",flexShrink:0}}>{c("你的邀请已发送","Your invitation has been sent")}</FinalText><FinalText testID="final-invite-sent-description" size={14} secondary style={{lineHeight:22,textAlign:"center",flexShrink:0}}>{c("对方通过后，你们就可以开始聊天","You can chat once they accept")}</FinalText></View></View>,<View style={{alignItems:"center",gap:12}}><FinalButton label={c("返回社区","Back to community")} onPress={()=>go("hub")} testID="final-invite-sent-return"/></View>,true,{bodyStyle:{paddingVertical:32},cardStyle:{maxHeight:567},mainStyle:{paddingBottom:29}});
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
  if(state.screen==="sent"||state.screen==="sending"){
    const sent=state.screen==="sent";
    const description=sent
      ?lastRecipients.current===0?c("社区里暂时没有能收到这个问题的家长","No parents can receive this question yet"):c("请静静等待回复","Please wait for replies")
      :c("你可以先返回社区，发送会继续。","You can return to Community while your bottle sends.");
    return <NuriKeyboardFrame><ScrollView style={{flex:1,minHeight:0}} contentContainerStyle={{flexGrow:1,justifyContent:"center",alignItems:"center",paddingHorizontal:12,paddingBottom:34,gap:24}}>
      <FinalSurface testID={`final-community-${state.screen}`} style={{width:354,maxWidth:"100%"}} contentStyle={{paddingHorizontal:24,paddingVertical:24,alignItems:"center",justifyContent:"center"}}>
        <FinalText size={20} secondary style={{fontWeight:"500",lineHeight:28,textAlign:"center"}}>{sent?c("发送成功","Sent successfully"):c("正在发送","Sending")}</FinalText>
        {sent?<View style={{width:128,height:128,alignItems:"center",justifyContent:"center"}}><View style={{width:64,height:64,borderRadius:32,backgroundColor:"rgba(217,217,217,.3)",alignItems:"center",justifyContent:"center"}}><Image source={require("@/assets/final-flow-20261101/community-bottle-gray.svg")} style={{width:10.9688,height:23.2031,transform:[{rotate:"45deg"}]}} contentFit="contain" accessible={false}/></View></View>:<BottleSendVisual/>}
        <FinalText size={14} secondary style={{lineHeight:20,textAlign:"center"}}>{description}</FinalText>
      </FinalSurface>
      {sent?<View style={[st.actionRow,{alignItems:"stretch"}]}>
        <FinalButton small secondary style={st.stretchButton} label={c("我的问题","My questions")} onPress={()=>go("myQuestions")} testID="final-bottle-sent-my-questions"/>
        <FinalButton small style={st.stretchButton} label={c("完成","Done")} onPress={()=>go("hub")} testID="final-bottle-sent-done"/>
      </View>:<FinalButton secondary label={c("返回社区","Back to community")} onPress={()=>go("hub")} testID="final-bottle-sending-back"/>}
    </ScrollView></NuriKeyboardFrame>;
  }
  if(state.screen==="responseSent")return page(<View style={{gap:8,alignItems:"center"}}>
    <Image source={require("@/assets/final-flow-20261101/community-experience-sent.svg")} style={{width:179,height:223}} contentFit="contain" accessible={false}/>
    <View style={{gap:4,width:"100%"}}><FinalText style={{fontWeight:"500",lineHeight:24,textAlign:"center"}}>{c("你的经验已经送到了","Your experience has been shared")}</FinalText><FinalText size={14} secondary style={{lineHeight:20,textAlign:"center"}}>{c("谢谢你，把自己走过的路分享给另一位家长。","Thank you for sharing your experience with another parent.")}</FinalText></View>
  </View>,<View style={{alignItems:"center",gap:12}}><FinalButton label={c("返回社区","Back to community")} onPress={()=>go("hub")}/></View>,false,{bodyStyle:{paddingHorizontal:24,paddingVertical:32},mainStyle:{paddingTop:12}});
  // ── My questions and their selection ─────────────────────────────────────
  if(["myQuestions","selection","close","delete"].includes(state.screen)){
    const all=mine.value?.items??[];
    const selecting=state.screen!=="myQuestions";
    const needle=search.toLocaleLowerCase();
    const visible=all.filter(q=>q.body.toLocaleLowerCase().includes(needle)).sort((a,b)=>{
      if(a.status!==b.status)return a.status==="open"?-1:1;
      const aTime=Date.parse(a.created_at),bTime=Date.parse(b.created_at);
      return (Number.isNaN(bTime)?-Infinity:bTime)-(Number.isNaN(aTime)?-Infinity:aTime)||0;
    });
    const listQuestion=(q:Question)=>{
      const closed=q.status==="closed";
      return <FinalSurface surfaceColor={closed?"#E7E5E7":undefined} style={{boxShadow:"0px 0px 8px rgba(89,71,92,.12)"}} contentStyle={{padding:12,gap:12}}>
        <View style={{gap:8,paddingRight:selecting?24:0}}>
          <FinalText size={12} secondary style={{lineHeight:18}}>{q.anonymous?c("匿名提问","Asked anonymously"):c("我的问题","My question")}</FinalText>
          <FinalText size={20} secondary={closed} style={{fontWeight:"500",lineHeight:28}}>{q.body}</FinalText>
        </View>
        <View style={{height:32,flexDirection:"row",alignItems:"center",gap:12}}>
          {alphaCommunityLayout?<BottleStatus count={unreadReplies.get(q.question_id)??0} testID={"final-my-bottle-"+q.question_id}/>:<View style={{width:32,height:32,alignItems:"center",justifyContent:"center"}}><Image source={closed?require("@/assets/final-flow-20261101/community-question-bottle-gray.svg"):require("@/assets/final-flow-20261101/community-question-bottle-coral.svg")} style={{width:7.875,height:16.3125,transform:[{rotate:"45deg"}]}} contentFit="contain" accessible={false}/>{!closed?<UnreadBadge count={q.reply_count} style={{position:"absolute",left:16,top:10}}/>:null}</View>}
          <FinalText size={12} secondary style={{flex:1,lineHeight:20}} numberOfLines={1}>{closed?c("已关闭","Closed"):q.reply_count+" "+c("条回复","replies")+" · "+shortTime(q.created_at,en)}</FinalText>
        </View>
        {selecting?<View pointerEvents="none" style={{position:"absolute",right:12,top:12,width:20,height:20}}><Image source={state.selected.includes(q.question_id)?require("@/assets/final-flow-20261101/community-checkbox-selected.svg"):require("@/assets/final-flow-20261101/community-checkbox-empty.svg")} style={{width:20,height:20}} contentFit="contain" accessible={false}/></View>:null}
      </FinalSurface>;
    };
    return <NuriKeyboardFrame><View style={{flex:1,minHeight:0,paddingTop:12,paddingBottom:34}}>
      <View style={{height:44,flexDirection:"row",alignItems:"center",gap:12,paddingHorizontal:12,zIndex:3}}>
        <View style={{flex:1,minWidth:0}}><Search compact iconSize={20} value={search} onChange={setSearch} placeholder={c("搜索","Search")}/></View>
        {selecting?<FinalSurface radius={22} surfaceColor={FINAL_COLOR.base} style={{width:44,height:44,boxShadow:"0px 2px 12px rgba(89,71,92,.12)"}}>
          <Pressable accessibilityRole="button" accessibilityLabel={c("退出选择","Exit selection")} onPress={()=>dispatch({type:"back"})} testID="final-exit-selection" style={{width:44,height:44,alignItems:"center",justifyContent:"center"}}><Image source={require("@/assets/final-flow-20261101/community-selection-exit.svg")} style={{width:20,height:20}} contentFit="contain" accessible={false}/></Pressable>
        </FinalSurface>:<Pressable accessibilityRole="button" onPress={()=>go("selection")} testID="final-select-questions" style={{width:58,height:44,justifyContent:"center"}}><View style={{height:28,borderRadius:22,backgroundColor:FINAL_COLOR.base,alignItems:"center",justifyContent:"center",boxShadow:"0px 2px 12px rgba(89,71,92,.12)"}}><FinalText size={14} secondary style={{lineHeight:20,fontWeight:"500"}}>{c("选择","Select")}</FinalText></View></Pressable>}
      </View>
      {!selecting?<View style={{height:48,paddingTop:12,paddingHorizontal:12,justifyContent:"center"}}><FinalText size={12} secondary style={{lineHeight:18}}>{all.length} {c("个漂流瓶","bottles")}</FinalText></View>:null}
      <ScrollView testID="final-my-questions-scroll" showsVerticalScrollIndicator={false} style={{flex:1,minHeight:0,marginTop:-12}} contentContainerStyle={{paddingHorizontal:12,paddingTop:24,paddingBottom:24,gap:16}}>
        {pending(mine)}{notice}
        {visible.map(q=>{
          const unreadCount=unreadReplies.get(q.question_id)??0;
          return <Pressable key={q.question_id} accessibilityRole={selecting?"checkbox":"button"} accessibilityState={selecting?{checked:state.selected.includes(q.question_id)}:undefined} accessibilityHint={alphaCommunityLayout&&unreadCount?bottleUnreadLabel(unreadCount):undefined} onPress={()=>selecting?dispatch({type:"select",id:q.question_id}):dispatch({type:"openQuestion",id:q.question_id})} testID={selecting?"final-select-"+q.question_id:"final-question-"+q.question_id}>{listQuestion(q)}</Pressable>;
        })}
        {mine.value&&!visible.length?<FinalText secondary style={{padding:24,textAlign:"center"}}>{all.length?c("没有匹配的问题","No matching questions"):c("还没有发出漂流瓶","No bottles sent yet")}</FinalText>:null}
      </ScrollView>
      {!selecting&&!alphaCommunityLayout?<View testID="final-my-questions-footer" style={{flexShrink:0,paddingTop:16,paddingHorizontal:24}}>
        <FinalButton label={c("完成","Done")} onPress={()=>{Keyboard.dismiss();go("hub");}} testID="final-my-questions-done"/>
      </View>:null}
      {selecting?<View testID="final-question-selection-footer" style={{flexShrink:0,paddingTop:8,paddingHorizontal:24,gap:8}}>
        <FinalText size={12} secondary style={{lineHeight:18,textAlign:"center"}}>
          {en?`${state.selected.length} ${state.selected.length===1?"bottle":"bottles"} selected`:translate(locale,"已选择 {count} 个漂流瓶",{count:state.selected.length})}
        </FinalText>
        <View style={[st.actionRow,{alignItems:"stretch"}]}>
          <FinalButton small secondary style={st.stretchButton} disabled={!state.selected.length||busy} label={c("关闭漂流瓶","Close bottles")} onPress={()=>{Keyboard.dismiss();go("close");}} testID="final-question-close"/>
          <FinalButton small style={st.stretchButton} disabled={!state.selected.length||busy} label={c("删除漂流瓶","Delete bottles")} onPress={()=>{Keyboard.dismiss();go("delete");}} testID="final-question-delete"/>
        </View>
      </View>:null}
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
    const adaptiveReply=alphaCommunityLayout&&detail;
    const slot=responding?"answer:"+state.questionID:"comment:"+state.questionID+":"+state.replyTarget;
    const question:Question|undefined=replies.value?.question??askedQuestion.value?.question;
    const closed=question?.status==="closed";
    const answerer=!question?.is_mine;
    const items:Reply[]=replies.value?.items??[];
    const target=items.find(r=>r.reply_id===state.replyTarget);
    const threadComments:Comment[]=comments.value?.items?[...comments.value.items].reverse():[];
    const canPost=!closed&&(detail?comments.value?.can_post!==false:!!allThread?.can_post);
    const canEdit=!closed&&(!expanded||!replies.value||canPost);
    const sendDisabled=!canEdit||busy||!draft(slot).trim();
    const openReplyAll=()=>{
      if(canPost&&latest.current.screen==="replies")dispatch({type:"replyTarget",target:"all",expanded:true});
    };
    const questionContext=<FinalSurface testID="final-question-context" style={{boxShadow:"0px 0px 8px rgba(89,71,92,.12)"}} contentStyle={{padding:12,gap:8}}>
      <View style={{height:responding?40:32,flexDirection:"row",alignItems:"center",gap:12}}><View style={{width:28,height:28,alignItems:"center",justifyContent:"center"}}><Image source={require("@/assets/final-flow-20261101/community-reply-question-bottle.svg")} style={{width:7.875,height:16.3125,transform:[{rotate:"45deg"}]}} contentFit="contain" accessible={false}/></View><FinalText size={12} secondary style={{flex:1,lineHeight:18}}>{question?(question.is_mine?c("我的问题","My question"):nameOf(question.author)):""}</FinalText><FinalText size={12} secondary style={{lineHeight:18}}>{shortTime(question?.created_at,en)}</FinalText>{question&&!question.is_mine?reportButton("question",question.question_id,c("举报这个问题","Report this question"),!question.anonymous,"final-report-question"):null}</View>
      <FinalSurface radius={20} style={{boxShadow:"0px 0px 8px rgba(89,71,92,.12)"}} contentStyle={{minHeight:responding?112:84,padding:16}}><FinalText size={20} style={{fontWeight:"500",lineHeight:28}}>{question?.body??""}</FinalText></FinalSurface>
    </FinalSurface>;
    const editor=(placeholder:string,onSend:()=>void)=><View style={{gap:8}}>
      {closed?<FinalText size={12} secondary>{c("此问题已关闭，不能继续回复。","This question is closed; replies are disabled.")}</FinalText>:null}
      <View testID="final-experience-editor" style={{height:adaptiveReply?undefined:145,gap:adaptiveReply?8:undefined,borderRadius:18,borderWidth:1,borderColor:"rgba(115,92,132,.25)",backgroundColor:"rgba(255,250,245,.9)",padding:12,justifyContent:"space-between"}}>
        {adaptiveReply?<PrivateReplyField key={slot} testID={"final-input-"+slot} editable={canEdit} value={draft(slot)} onChangeText={text=>setDraft(slot,text)} placeholder={placeholder}/>:<NuriTextInput ref={expanded?replyAllInput:undefined} testID={"final-input-"+slot} accessibilityLabel={placeholder} editable={canEdit} multiline maxLength={responding?2000:1000} value={draft(slot)} onChangeText={text=>setDraft(slot,text)} placeholder={placeholder} placeholderTextColor="#918896" style={{flex:1,minHeight:48,padding:0,fontSize:14,lineHeight:20,color:FINAL_COLOR.ink,textAlignVertical:"top",fontFamily:locale==="zh-CN"?"NotoSansSC_400Regular":undefined}}/>}
        <View style={{height:24,flexDirection:"row",alignItems:"center",gap:8}}>
          <Pressable accessibilityRole="button" accessibilityLabel={c("语音输入","Voice input")} disabled={!canEdit||!!voice} onPress={()=>void startVoice(slot)} style={{width:24,height:24,alignItems:"center",justifyContent:"center"}} hitSlop={8}><Image source={require("@/assets/final-flow-20261101/microphone.svg")} style={{width:20,height:20}} contentFit="contain" accessible={false}/></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={c("添加表情","Add emoji")} disabled={!canEdit} onPress={()=>setDraft(slot,draft(slot)+" 🙂")} style={{width:24,height:24,alignItems:"center",justifyContent:"center"}} hitSlop={8}><Image source={require("@/assets/final-flow-20261101/community-emoji.svg")} style={{width:20,height:20}} contentFit="contain" accessible={false}/></Pressable>
          <View style={{flex:1}}/>
          <FrostedPressable accessibilityRole="button" testID="final-send-experience" disabled={sendDisabled} onPress={onSend} style={{width:50,height:24,borderRadius:18,backgroundColor:FINAL_COLOR.coral,alignItems:"center",justifyContent:"center",opacity:sendDisabled ? .6 : 1}} hitSlop={8}><FinalText size={14} style={{lineHeight:20,color:"white"}}>{c("发送","Send")}</FinalText></FrostedPressable>
        </View>
      </View>
      {!closed?voiceBar(slot):null}
      {notice}
    </View>;
    const answer=(reply:Reply,small=false)=>{
      const unread=unreadReplyComments.get(reply.reply_id)??0;
      const canOpenThread=closed ? reply.comment_count>0||unread>0 : reply.allowed_actions.includes("comment");
      const replyLabel=(reply.comment_count?reply.comment_count+" · ":"")+(closed?c("查看 ›","View ›"):c("回复 ›","Reply ›"));
      return <View key={reply.reply_id} style={{gap:small?4:detail?16:12}}>
        <View style={{height:36,flexDirection:"row",alignItems:"center",gap:8}}>
          <SampleAvatar size={36}/>
          <FinalText size={small?14:16} secondary style={{flex:1,lineHeight:small?20:24,fontWeight:small?"400":"500"}}>{reply.is_mine?c("我的回复","My reply"):nameOf(reply.author)}</FinalText>
          {!detail&&canOpenThread?<Pressable accessibilityRole="button"
            accessibilityLabel={unread?`${replyLabel}${en?", ":"，"}${bottleUnreadLabel(unread)}`:replyLabel}
            onPress={()=>dispatch({type:"replyTarget",target:reply.reply_id,name:reply.is_mine?c("我","me"):nameOf(reply.author)})}
            testID={"final-reply-"+reply.reply_id} style={{minWidth:60,height:36,flexDirection:"row",gap:5,alignItems:"center",justifyContent:"center"}}>
            {unread>0?<View testID={"final-reply-unread-"+reply.reply_id} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
              style={{width:6,height:6,borderRadius:3,backgroundColor:FINAL_COLOR.coral}}/>:null}
            <FinalText size={12} secondary style={{lineHeight:18}}>{replyLabel}</FinalText>
          </Pressable>:null}
          {!reply.is_mine?reportButton("reply",reply.reply_id,c("举报这条经验","Report this reply"),!reply.anonymous,"final-report-reply-"+reply.reply_id):null}
        </View>
        <FinalText size={small?14:16} style={{lineHeight:small?20:24}}>{reply.body}</FinalText>
        <View style={st.quietDivider}/>
      </View>;
    };
    const commentRow=(entry:Comment)=><View key={entry.comment_id} style={{gap:8}}><View style={{flexDirection:"row",alignItems:"center",gap:8}}><FinalText size={12} secondary style={{flex:1}}>{entry.is_mine?c("你的回复","Your reply"):nameOf(entry.author)}</FinalText>{!entry.is_mine?reportButton("comment",entry.comment_id,c("举报这条回复","Report this comment"),!!entry.author.parent_id&&!entry.author.anonymous,"final-report-comment-"+entry.comment_id):null}</View><FinalText size={14} style={{lineHeight:20}}>{entry.body}</FinalText><View style={st.quietDivider}/></View>;
    const replyListContent=()=> <>
      <FinalText size={12} secondary style={{lineHeight:18}}>{answerer?c("我的经验","My experience"):c("收到 "+items.length+" 位家长的经验",items.length===1?"1 parent replied":`${items.length} parents replied`)}</FinalText>
      {pending(replies)}
      {items.map(r=>answer(r))}
      {replies.value&&!items.length?<FinalText secondary style={{textAlign:"center"}}>{c("还没有家长回复，再等等","No replies yet")}</FinalText>:null}
      {state.replyTarget==="all"?threadComments.map(commentRow):null}
    </>;
    if(prompting)return <NuriKeyboardFrame><ScrollView style={{flex:1,minHeight:0}} contentContainerStyle={{padding:12,paddingBottom:34,gap:12}}>{pending(askedQuestion)}{questionContext}<View style={{height:44,flexDirection:"row",alignItems:"center",gap:12}}><RefineAvatar prompt/><Pressable accessibilityRole="button" testID="final-share-experience" onPress={()=>go("respond")} style={{height:44,paddingHorizontal:24,borderRadius:999,backgroundColor:FINAL_COLOR.selected,alignItems:"center",justifyContent:"center",boxShadow:"0px 1px 15px rgba(92,86,98,.18)"}}><FinalText style={{fontWeight:"500",color:"white"}}>{c("你有想法吗？","Would you like to share?")}</FinalText></Pressable></View></ScrollView>{reportSheet}</NuriKeyboardFrame>;
    // Keep the same focused field and accessory mounted throughout keyboard transitions.
    if(responding||expanded)return <NuriKeyboardFrame><View style={{flex:1,minHeight:0,padding:12,paddingBottom:expanded?dockBottom:34,gap:12}}>
      <ScrollView testID={expanded?"final-reply-all-context-scroll":undefined} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} style={{flex:1,minHeight:0}} contentContainerStyle={{gap:12}}>{questionContext}{expanded?<FinalSurface contentStyle={{padding:16,gap:16}}>{replyListContent()}</FinalSurface>:null}</ScrollView>
      <FinalSurface testID={"final-community-"+state.screen} style={{flexShrink:0,boxShadow:"0px 0px 8px rgba(92,86,98,.12)"}} contentStyle={{padding:16,gap:8}}><FinalText size={12} secondary style={{lineHeight:18}}>{responding?c("我的经验","My experience"):c("回复所有人","Reply to everyone")}</FinalText>{editor(c("写下你的回复…","Write your reply…"),responding?respond:()=>comment(slot))}</FinalSurface>
    </View>{reportSheet}</NuriKeyboardFrame>;
    if(detail)return <NuriKeyboardFrame><View style={{flex:1,minHeight:0,padding:12,paddingBottom:dockBottom}}>
      <FinalSurface fill testID={"final-community-"+state.screen} style={{maxHeight:thread?553:undefined,boxShadow:"0px 0px 8px rgba(89,71,92,.12)"}}>
        <ScrollView testID="final-reply-thread-scroll" keyboardShouldPersistTaps="handled" keyboardDismissMode={adaptiveReply?"interactive":undefined} showsVerticalScrollIndicator={false} style={{flex:1,minHeight:0}} contentContainerStyle={{padding:20,gap:16}}>
          <FinalText size={12} secondary style={{lineHeight:18}}>{question?.body??""}</FinalText>
          {pending(comments)}
          {target?answer(target,thread):null}
          {threadComments.map(commentRow)}
        </ScrollView>
        {canPost?<View testID="final-private-reply-dock" style={{flexShrink:0,gap:12,paddingHorizontal:20,paddingTop:8,paddingBottom:20}}><FinalText size={14} secondary style={{lineHeight:20,fontWeight:"500"}}>{c("你的回复","Your reply")}</FinalText>{editor(c("写下你的回复…","Write your reply…"),()=>comment(slot))}</View>:null}
      </FinalSurface>
    </View>{reportSheet}</NuriKeyboardFrame>;
    return <NuriKeyboardFrame><ScrollView testID="final-reply-list-scroll" keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} style={{flex:1,minHeight:0}} contentContainerStyle={{flexGrow:1,padding:12,paddingBottom:34,gap:16}}>
      {questionContext}
      <FinalSurface testID={"final-community-"+state.screen} style={{flexGrow:1,flexShrink:0,boxShadow:"0px 0px 8px rgba(89,71,92,.12)"}} contentStyle={{flexGrow:1,padding:16,gap:16}}>
        {replyListContent()}
        {allThread?.can_post?<View style={{gap:8,marginTop:"auto"}}>
          <Pressable accessibilityRole="button" testID="final-expand-reply" disabled={closed} onPress={openReplyAll} style={{minHeight:18,justifyContent:"center"}}><FinalText size={12} secondary style={{lineHeight:18}}>{closed?c("此问题已关闭","This question is closed"):c("回复所有人","Reply to everyone")}</FinalText></Pressable>
          <View style={{height:46,borderWidth:1,borderColor:"rgba(93,80,96,.16)",borderRadius:18,backgroundColor:"rgba(255,250,245,.9)",flexDirection:"row",alignItems:"center",paddingLeft:8,paddingRight:12}}>
            <Pressable accessibilityRole="button" disabled={closed||!!voice} accessibilityLabel={c("语音输入","Voice input")} onPress={()=>void startVoice(slot)} style={{width:44,height:44,alignItems:"center",justifyContent:"center"}}><Image source={require("@/assets/final-flow-20261101/microphone.svg")} style={{width:20,height:20}} contentFit="contain" accessible={false}/></Pressable>
            <Pressable testID="final-comment-input" accessibilityRole="button" accessibilityLabel={c("写下回复","Write a reply")} disabled={closed} onPress={openReplyAll} style={{flex:1,height:44,justifyContent:"center"}}><FinalText size={14} numberOfLines={1} style={{lineHeight:20,color:draft(slot)?FINAL_COLOR.ink:"#918896"}}>{draft(slot)||c("写下回复…","Write a reply…")}</FinalText></Pressable>
          </View>
          {!closed?voiceBar(slot):null}
        </View>:null}
      </FinalSurface>
    </ScrollView>{reportSheet}</NuriKeyboardFrame>;
  }

  // ── Contacts and invitations ─────────────────────────────────────────────
  if (state.screen==="contacts"||state.screen==="invitations"){
    const invitations=state.screen==="invitations";
    const match=(p:PublicParent|null)=>!!p&&nameOf(p).toLocaleLowerCase().includes(search.toLocaleLowerCase());
    const divider=<View style={st.friendDivider}/>;
    const contacts:Contact[]=(contactsList.value?.items??[]).filter(entry=>match(entry.parent)).sort((a,b)=>nameOf(a.parent).localeCompare(nameOf(b.parent)));
    const groups:{title:string;remote:Remote<unknown>;rows:{parent:PublicParent|null;description:string;status:string;incoming?:boolean;unread?:boolean}[]}[]=[
      {title:c("收到的邀请","Received invitations"),remote:receivedInvitations,rows:(receivedInvitations.value?.items??[]).filter((i:Invitation)=>match(i.parent)).map(i=>({parent:i.parent,description:c("邀请你建立联系","Invited you to connect"),status:c("待你通过","Awaiting you"),incoming:true,unread:true}))},
      {title:c("发出的邀请","Sent invitations"),remote:sentInvitations,rows:(sentInvitations.value?.items??[]).filter((i:Invitation)=>match(i.parent)).map(i=>({parent:i.parent,description:c("邀请已发出","Invitation sent"),status:c("等待通过","Pending")}))},
      {title:c("已建立联系","Connected"),remote:contactsList,rows:contacts.map(entry=>({parent:entry.parent,description:c("已建立联系","Connected"),status:c("已建立联系","Connected")}))},
    ];
    return <NuriKeyboardFrame><View style={{flex:1,minHeight:0,paddingHorizontal:12,paddingTop:16,paddingBottom:22,gap:8}}>
      <FinalSurface fill style={{maxHeight:619}} testID={"final-community-"+state.screen}>
        <View style={{marginLeft:8,marginRight:28,marginTop:13,height:44,flexDirection:"row",alignItems:"center"}}><IconAction name="back" label={c("返回","Back")} onPress={()=>dispatch({type:"back"})}/><View style={{flex:1,minWidth:0}}><Search compact value={search} onChange={setSearch} placeholder={c("搜索","Search")}/></View></View>
        <ScrollView testID={"final-"+state.screen+"-scroll"} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} style={{flex:1,minHeight:0}} contentContainerStyle={{paddingHorizontal:24,paddingTop:invitations?11:14,paddingBottom:24,gap:invitations?16:8}}>
          {invitations?groups.map(group=><View key={group.title} style={{gap:4}}>
            <View style={{height:24,flexDirection:"row",alignItems:"center",gap:8}}>
              <FinalText size={14} style={{fontWeight:"500",lineHeight:20}}>{group.title}</FinalText>
              {group.remote.value!==undefined?<FinalText size={12} secondary style={{lineHeight:20}}>{group.rows.length}</FinalText>:null}
            </View>
            {pending(group.remote)}
            {group.rows.map((row,i)=><View key={row.parent?.parent_id??i}>{i?divider:null}{parentRow(row.parent,row.description,{invitation:true,incoming:row.incoming,unread:row.unread?1:0,status:row.status})}</View>)}
          </View>):<>
            <Pressable accessibilityRole="button" style={{minHeight:72,padding:4,flexDirection:"row",alignItems:"center",gap:12}} onPress={()=>go("invitations")} testID="final-new-connections"><View style={{flex:1,gap:4}}><View style={{flexDirection:"row",alignItems:"center"}}><FinalText style={{fontWeight:"500"}}>{c("新的联系","New connections")}</FinalText><UnreadBadge count={inbox.value?.summary.pending_invitations??0} style={{alignSelf:"flex-start",marginTop:-4}}/></View><FinalText size={12} secondary style={{lineHeight:18}}>{c("查看请求与回应","View requests and responses")}</FinalText></View><FinalText size={20} style={{width:16,lineHeight:24,color:FINAL_COLOR.accent}}>›</FinalText></Pressable>
            {divider}
            {pending(contactsList)}
            {contacts.map((entry,i)=>{const name=nameOf(entry.parent),previous=i?nameOf(contacts[i-1].parent):"";return <View key={entry.relationship_id} style={{gap:8}}>{i===0||name[0]!==previous[0]?<FinalText size={10} style={{height:24,lineHeight:14}}>{name[0]?.toLocaleUpperCase()}</FinalText>:null}{parentRow(entry.parent,entry.parent.about||c("开始聊天","Start chatting"),{conversationId:entry.conversation_id})}{divider}</View>;})}
            {contactsList.value&&!contacts.length?<FinalText secondary style={{paddingVertical:16,textAlign:"center"}}>{c("还没有联系人","No contacts yet")}</FinalText>:null}
          </>}
        </ScrollView>
      </FinalSurface>
    </View></NuriKeyboardFrame>;
  }

  // ── Finding parents: intent, my profile, suggestions, a parent ───────────
  if(state.screen==="intent")return page(<>
    <View style={{height:24,alignSelf:"stretch",alignItems:"flex-end"}}><Pressable accessibilityRole="button" accessibilityLabel={c("跳过","Skip")} hitSlop={10} style={{height:24,minWidth:44,alignItems:"center",justifyContent:"center"}} onPress={()=>completeFriendIntent(true)}><FinalText size={14} secondary style={{lineHeight:24,fontWeight:"500"}}>{c("跳过","Skip")}</FinalText></Pressable></View>
    <View style={{minHeight:60,flexShrink:0}}><FinalText style={{fontWeight:"500",textAlign:"center",lineHeight:24}}>{c("你希望和新朋友一起","With new friends, you'd like to…")}</FinalText></View>
    <View style={{minHeight:407,gap:16,alignItems:"center"}}>
      {INTENT_LABELS.map(([cn,english],i)=><Pressable key={i} onPress={()=>dispatch({type:"intent",index:i})} accessibilityRole="checkbox" accessibilityState={{checked:state.intents.includes(i)}} testID={"final-intent-"+i} style={{minHeight:44,paddingVertical:12,width:248,maxWidth:"100%",alignItems:"center",justifyContent:"center",flexShrink:0}}>
        <View pointerEvents="none" style={{position:"absolute",left:0,right:0,top:-2,bottom:-2,borderRadius:22,boxShadow:"0px 1px 4px rgba(0,0,0,.25)"}}><ButtonBackdrop color={state.intents.includes(i)?FINAL_COLOR.selected:"rgba(255,248,242,.75)"} radius={22} testID={`final-intent-${i}-material`}/></View>
        <FinalText size={14} style={{lineHeight:20,color:state.intents.includes(i)?"white":FINAL_COLOR.ink,textAlign:"center",paddingHorizontal:12}}>{c(cn,english)}</FinalText>
      </Pressable>)}
      <FinalText size={12} style={{lineHeight:24,textAlign:"center",opacity:.65,fontWeight:"500"}}>{c("多选","Choose any that fit")}</FinalText>
    </View>
  </>,<FinalButton label={c("下一步","Next")} disabled={busy} onPress={()=>completeFriendIntent(false)} testID="final-intent-next"/>,true,{bodyStyle:{paddingTop:32,paddingBottom:0},cardStyle:{maxHeight:555}});
  const myProfile:MyProfile["profile"]=me.value?.profile??null;
  const myName=state.drafts["profile:name"]??(myProfile?.display_name||account.value?.nickname||"");
  const invalidProfileName=alphaCommunityLayout&&myName.trim()!==myProfile?.display_name&&isChineseDisplayNameTooLong(myName);
  const myGender=(state.drafts["profile:gender"]||myProfile?.gender_tag||null) as GenderTag|null;
  const myCity=myProfile?.city??account.value?.city??"";
  const myAbout=state.drafts["profile:about"]??myProfile?.about??"";
  if((state.screen==="profile"||state.screen==="profileSettings")&&(profileEditing||(me.value&&!me.value.exists)))return page(<>{pending(me)}<CommunityProfileEditor displayName={myName} city={myCity} about={myAbout} onAboutChange={text=>setDraft("profile:about",text)} selectedIntents={state.intents} onToggleIntent={index=>dispatch({type:"intent",index})} avatar={<SampleAvatar size={104}/>} onDisplayNameChange={text=>setDraft("profile:name",text)} genderTag={myGender} onGenderTag={tag=>setDraft("profile:gender",tag)}/>{invalidProfileName?<FinalText size={12} secondary style={{paddingHorizontal:24,paddingBottom:16,lineHeight:18}} testID="community-profile-name-limit">{chineseDisplayNameLimitMessage(locale)}</FinalText>:null}{!myProfile?<FinalText size={12} secondary style={{paddingHorizontal:24,paddingBottom:16,lineHeight:18}}>{c("保存后，其他家长会看到你的名字、城市和以上内容。","After saving, other parents will see your name, city and the details above.")}</FinalText>:null}</>,<FinalButton label={c("保存","Save")} disabled={busy||!me.value||invalidProfileName} onPress={()=>saveProfile(()=>setProfileEditingMode(false))} testID="final-profile-save"/>,true,{bodyStyle:{padding:0,gap:0}});
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
          {reportButton("parent",state.person,c("举报这位家长","Report this parent"),true,"final-report-parent")}
          {reportSheet}
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
  const sheetCurrent=!!consentSheet&&accountScope.current(consentSheet.ticket)&&filterFocused.current&&consentSheet.revision===navigationRevision.current&&consentSheet.person===state.person
    &&consentSheet.conversationId===value?.conversationId&&consentSheet.epoch===ai?.epoch&&consentSheet.noticeVersion===ai?.notice_version;
  const list:Message[]=value?.messages??[];
  const messageTicket=accountScope.capture(),messageRevision=navigationRevision.current;
  return <NuriKeyboardFrame><ParentChatHeader person={state.personName} participating={!!ai?.effective} status={ai?.effective ? c("Nuri 参与中", "Nuri is on") : waitingForParent ? c("等待对方同意","Waiting for them") : c("Nuri 未参与", "Nuri is off")} backLabel={c("返回", "Back")} toggleHint={c("开启前需要双方同意；任何一方都可以随时关闭。", "Both parents must agree first; either can turn it off at any time.")} onBack={()=>{
      if(state.history.length)dispatch({type:"back"});else router.dismissTo("/(tabs)");
    }} onToggle={toggleAI}/><ScrollView ref={messages} onContentSizeChange={() => messages.current?.scrollToEnd({ animated: false })} onLayout={() => messages.current?.scrollToEnd({ animated: false })} keyboardShouldPersistTaps="handled" style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ padding: 24, gap: 20 }} testID="final-parent-chat-scroll">
      {pending(chat)}
      {value&&!list.length?<FinalText secondary style={{textAlign:"center"}}>{c("打个招呼吧","Say hello")}</FinalText>:null}
      {list.map(message => {
        const incoming=message.sender==="parent";
        const translated=translations.text(message);
        return <View key={message.message_id} testID={`final-parent-message-${message.seq}`} style={[st.chatRow,incoming?st.chatIncoming:st.chatOutgoing]}>
          <ParentChatAvatar/>
          <Pressable
            disabled={!incoming}
            delayLongPress={400}
            onLongPress={()=>{
              if(!incoming||messageTicket===null||!accountScope.current(messageTicket)
                ||!filterFocused.current||navigationRevision.current!==messageRevision
                ||chatAuthority.current?.conversationId!==message.conversation_id)return;
              setReport({kind:"message",id:message.message_id,title:c("举报这条消息","Report this message"),allowBlock:true,
                original:translated?{conversationId:message.conversation_id,ticket:messageTicket,revision:messageRevision}:undefined});
            }}
            accessibilityHint={incoming?(translated?originalMessageHint:c("长按可以举报","Long press to report")):undefined}
            testID={`final-parent-message-press-${message.seq}`}
            style={[st.chatMessage,incoming?st.chatIncomingWidth:st.chatOutgoingWidth]}
          >
            <FinalChatBubble incoming={incoming} style={incoming?st.chatIncomingBubble:undefined}>
              {message.media.map(item=><CommunityImage key={item.media_id} mediaId={item.media_id} label={c("图片","Photo")}/>)}
              {translated
                ? <FinalText testID={`final-parent-translation-${message.seq}`}>{translated}</FinalText>
                : message.text?<FinalText testID={`final-parent-original-${message.seq}`}>{message.text}</FinalText>:null}
            </FinalChatBubble>
          </Pressable>
        </View>;
      })}
    </ScrollView><View testID="final-parent-composer-dock" style={{ padding: 24, paddingTop: 8, paddingBottom: dockBottom, gap: 8 }}>
      {notice}
      {value&&!canSend?<FinalText size={12} secondary style={{textAlign:"center"}}>{c("你们已不再联系，不能再发送消息","You're no longer connected and can't send messages")}</FinalText>:null}
      {voiceBar(chatSlot)??<NuriComposer disabled={!canSend||busy||pickingChatPhotos} busy={busy||pickingChatPhotos} value={draft(chatSlot)} onChangeText={text => setDraft(chatSlot, text)} onSend={()=>void sendChat()} onAttach={()=>void pickChatImage()} onMic={()=>void startVoice(chatSlot)} attachments={chatPhotos.map(({id,prepared})=>({id,kind:"image",uri:prepared.previewUri,width:prepared.width,height:prepared.height,image:prepared}))} onRemoveAttachment={id=>removeChatPhotos(accountScope.capture(),state.person,[id])} placeholder={c("聊聊最近的活动吧…", "Talk about recent activities…")} testID="final-parent" />}
    </View>{state.screen === "consent" ? <Modal transparent animationType="fade" onRequestClose={() => {if(!busy)closeConsent(consentSheet);}}><BlurView intensity={35} tint="light" style={st.modal}><FinalSurface contentStyle={{ padding: 24, gap: 16 }}><FinalText size={20}>{notesConsentCopy.title}</FinalText><FinalText testID="final-parent-consent-purpose" size={14} secondary>{notesConsentCopy.body}</FinalText><FinalText size={12} secondary>{notesConsentCopy.closeWarning}</FinalText>{!sheetCurrent?<FinalText>{notesConsentCopy.changed}</FinalText>:null}{notice}<View style={[st.actionRow,st.consentActions]}><FinalButton small secondary style={st.consentButton} disabled={busy||!sheetCurrent} label={consentSheet?.mode==="request"?notesConsentCopy.cancel:notesConsentCopy.decline} onPress={() => void decideAI(consentSheet,false)} testID="final-parent-consent-decline"/><FinalButton small style={st.consentButton} disabled={busy||!sheetCurrent} label={consentSheet?.mode==="request"?notesConsentCopy.allowRequest:notesConsentCopy.allow} onPress={() => void decideAI(consentSheet,true)} testID="final-parent-consent-agree" /></View><FinalButton small secondary disabled={busy} label={notesConsentCopy.close} onPress={()=>closeConsent(consentSheet)} testID="final-parent-consent-close"/></FinalSurface></BlurView></Modal> : null}{reportSheet}</NuriKeyboardFrame>;
}
const st = StyleSheet.create({
  main: { flex: 1, minHeight: 0, paddingHorizontal: 12, paddingTop: 16, paddingBottom: 32, gap: 16 },
  body: { padding: 24, gap: 16 },
  actions: { marginTop: "auto", paddingTop: 16, paddingBottom: 8, gap: 12 },
  actionRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 12 },
  stretchButton: { alignSelf: "stretch" },
  consentActions: { alignItems: "stretch" },
  consentButton: { alignSelf: "stretch" },
  chatRow: { gap: 8 },
  chatIncoming: { flexDirection: "row", alignItems: "flex-start" },
  chatOutgoing: { flexDirection: "row-reverse", alignItems: "flex-end" },
  chatMessage: { flexShrink: 1, minWidth: 0 },
  chatIncomingWidth: { maxWidth: 306 },
  chatOutgoingWidth: { maxWidth: 258 },
  chatIncomingBubble: { boxShadow: "0px 0px 4px rgba(0,0,0,.1)" },
  friendPreviewRow: {minHeight:72,flexDirection:"row",alignItems:"center",gap:16,padding:8},
  friendDivider: {height:1,backgroundColor:"rgba(255,255,255,.65)",alignSelf:"stretch"},
  quietDivider: {height:1,backgroundColor:"rgba(77,64,92,.22)",alignSelf:"stretch"},
  questionEntry: {minHeight:80,paddingRight:24,paddingBottom:8,gap:4},
  questionTitle: {minHeight:24,flexDirection:"row",alignItems:"center",gap:12},
  questionChevron: {position:"absolute",right:0,top:0,bottom:0,width:16,alignItems:"center",justifyContent:"center"},
  dots: { height: HUB_PAGINATION.targetHeight, marginTop:HUB_PAGINATION.height-HUB_PAGINATION.targetHeight, width:HUB_PAGINATION.targetSize*2, alignSelf:"center", justifyContent: "flex-end", alignItems: "center" },
  dotTarget: { position:"absolute", width:HUB_PAGINATION.targetSize, height:HUB_PAGINATION.targetHeight, top:0 },
  modal: { flex: 1, justifyContent: "center", padding: 24, backgroundColor: "rgba(255,250,244,.15)" }
});
