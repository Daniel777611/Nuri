import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { AccessibilityInfo, Animated, Easing, Keyboard, Modal, Platform, Pressable, ScrollView, StyleSheet, TextInput, View, type ViewStyle } from "react-native";
import { Image } from "expo-image";
import { BlurView } from "expo-blur";
import { useFocusEffect, useLocalSearchParams, usePathname, useRouter } from "expo-router";
import { useT, translate } from "@/src/i18n";
import { registerNativeNavigationGuard } from "@/src/components/nativeNavigation";
import { IconAction, NuriKeyboardFrame } from "@/src/uiux48/Primitives";
import { NuriComposer } from "@/src/uiux48/Composer";
import { useComposerDockInset } from "@/src/uiux48/useComposerDock";
import { singleLineInputStyle } from "@/src/uiux48/inputLayout";
import { VoiceInputBar } from "@/src/uiux48/VoiceInputBar";
import { FinalButton, FinalChatBubble, FinalDivider, FinalSurface, FinalText, FINAL_COLOR } from "./Primitives";
import { ParentChatAvatar, ParentChatHeader } from "./ParentChatHeader";
import { SettingsPage, SettingsRow, SettingsToggle, SettingsButton, SettingsSpacer } from "./Settings";
import { CommunityProfileEditor } from "./CommunityProfileEditor";
import { createFinalCommunity, finalCommunityReducer, isFinalCommunityScreen, selectedFinalQuestion, selectedQuestionText, PARENT_FIXTURES, type FinalCommunityEvent, type FinalCommunityScreen, type FinalCommunityState, type FixtureParent, type FixtureQuestion } from "./communityModel";
import { communityHubTopPadding, HUB_PAGINATION, HUB_CARD_BOTTOM_GUTTER, HUB_PAGER_GAP } from "./communityHubLayout";
const ANSWERS = [["我们也哭了好几周。固定、简短的告别仪式很有帮助，我们也不会偷偷离开。", "We had tears for weeks too. A short, consistent goodbye helped; we never slipped away."], ["大约第三周开始好转。带一件熟悉的安抚物，让告别容易了一些。", "Things improved around week three. A familiar comfort item made goodbyes easier."]] as const;
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
  replyDetail: ["回复Maya", "Reply to Maya"],
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
    // Figma60127: one2400ms cohort; ring0→9.425rad linear, bottle
    // two0→−7px/−.052rad bobs with CSS ease-in-out(.42,0,.58,1).
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
function Search({
  value,
  onChange,
  placeholder,
  compact=false,
  iconSize=16
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  compact?: boolean;
  iconSize?:16|20;
}) {
  return <View style={{height:compact?28:36,borderRadius:24,backgroundColor:"rgba(255,255,255,.8)",justifyContent:"center",alignSelf:"stretch",minWidth:0}}>
    {!value?<View pointerEvents="none" style={{position:"absolute",left:0,right:0,flexDirection:"row",alignItems:"center",justifyContent:"center",gap:4}}><Image source={iconSize===20?require("@/assets/final-flow-20261101/community-question-search.png"):require("@/assets/final-flow-20261101/community-search.png")} style={{width:iconSize,height:iconSize,opacity:.46}} contentFit="contain" accessible={false}/><FinalText size={compact?12:14} secondary style={{lineHeight:20}}>{placeholder}</FinalText></View>:null}
    <TextInput testID="final-community-search" accessibilityLabel={placeholder} value={value} onChangeText={onChange} placeholderTextColor="#918896" style={{...singleLineInputStyle,height:compact?28:36,borderRadius:24,paddingHorizontal:16,color:FINAL_COLOR.ink,fontSize:compact?12:14}}/>
  </View>;
}
function FriendPreviewAvatar() {
  return <View style={{width:40,height:40,borderRadius:40/1.5,overflow:"hidden"}}>
    <Image source={require("@/assets/final-flow-20261101/parent-avatar-background.svg")} style={{width:40,height:40}} contentFit="contain" accessible={false}/>
    <Image source={require("@/assets/final-flow-20261101/parent-avatar.png")} style={{position:"absolute",left:4,top:12.332,width:31.667,height:27.667}} contentFit="fill" accessible={false}/>
  </View>;
}
function DemoLabel({
  en
}: {
  en: boolean;
}) {
  // Keep the prototype disclosure in the accessibility tree without adding a
  // 22pt visual row that moves every approved Figma card. Action receipts and
  // media/consent explanations remain visible and explicitly local-only.
  return <View testID="final-community-demo-region" accessible accessibilityLabel={en?"Flow preview. Sample data only; nothing is sent to a server.":"流程预览，示例数据，不发送到服务器。"} pointerEvents="none" style={{position:"absolute",width:1,height:1,overflow:"hidden"}}/>;
}
/** Current Figma's presentation graph. The Metro alias excludes it from
 * ordinary App Store builds; all writes below are reducer-only fixture writes. */
export default function CommunityFinal() {
  const {
    uiState
  } = useLocalSearchParams<{
    uiState?: string;
  }>();
  const [state, dispatchState] = useReducer(finalCommunityReducer, isFinalCommunityScreen(uiState) ? uiState : "hub", createFinalCommunity);
  const [width, setWidth] = useState(0),
    [pagerHeight, setPagerHeight] = useState(0),
    [search, setSearch] = useState(""),
    [voice, setVoice] = useState(false),
    [attachment, setAttachment] = useState(false),
    [filter, setFilter] = useState<"gender" | "distance" | null>(null),
    [profileEditing,setProfileEditing]=useState(false),
    [selectionMenu,setSelectionMenu]=useState(false),
    [replyKeyboardVisible,setReplyKeyboardVisible]=useState(false);
  const {
    locale
  } = useT();
  const en = locale === "en";
  const router = useRouter(),
    path = usePathname();
  const pager = useRef<ScrollView>(null),
    messages = useRef<ScrollView>(null),
    latest = useRef(state);
  latest.current = state;
  const c = (cn: string, english: string) => en ? english : translate(locale, cn);
  const go = (screen: FinalCommunityScreen) => dispatch({
    type: "go",
    screen
  });
  const home = state.screen === "hub" || state.screen === "friends";
  const parentChat = ["chat", "chatOn", "consent"].includes(state.screen);
  const dockBottom = useComposerDockInset(parentChat);
  const bottle = !["hub", "friends", "inbox", "contacts", "invitations", "preferences", "blocked", "blockedEmpty", "profileSettings", "parentSettings", "safetyConfirm"].includes(state.screen) && !parentChat;
  const presentation = (next:FinalCommunityState) => {
    const chat=["chat","chatOn","consent"].includes(next.screen);
    const hub=next.screen==="hub"||next.screen==="friends";
    const settings=["preferences","blocked","blockedEmpty","profileSettings","parentSettings","safetyConfirm"].includes(next.screen);
    const bottle=!hub&&!["inbox","contacts","invitations"].includes(next.screen)&&!settings&&!chat;
    return {
      flowTitle:chat||["connected","noMatches","incomingParent","parentSettings","safetyConfirm"].includes(next.screen)?next.person:["replyDetail","replyKeyboard","comments"].includes(next.screen)?c("回复","Reply to ")+(next.replyTarget==="anonymous"?c("匿名家长","Anonymous parent"):next.replyTarget):TITLE[next.screen]?c(...TITLE[next.screen]!):c("社区","Community"),
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
    // Publish shell presentation in the same user-event batch as the local
    // screen. Waiting for the focus effect would flash two headers on entry
    // and leave a blank/stale header on return.
    if(next.screen!==previous.screen||next.person!==previous.person)router.setParams(presentation(next));
    latest.current=next;
    dispatchState(event);
  };
  useFocusEffect(useCallback(() => {
    router.setParams(presentation(state));
    return registerNativeNavigationGuard(path, action => {
      if (action === "back" && latest.current.history.length) {
        dispatch({
          type: "back"
        });
        return;
      }
      const routes = {
        home: "/(tabs)",
        chat: "/(tabs)/chats",
        community: "/community",
        notifications: "/notifications",
        profile: "/(tabs)/profile"
      } as const;
      if (action === "back") router.dismissTo("/(tabs)");else router.navigate(routes[action]);
    });
  }, [router, path, title, parentChat, bottle, home, state.screen,profileEditing]));
  useEffect(() => {
    if (home && width) pager.current?.scrollTo({
      x: width * state.page,
      animated: false
    });
  }, [home, width, state.page]);
  useEffect(() => {
    setVoice(false);
    setAttachment(false);
    setFilter(null);
    setSearch("");
    setProfileEditing(false);
  }, [state.screen, state.person]);
  useEffect(()=>{
    if(state.screen!=="replyExpanded")return;
    setReplyKeyboardVisible(Keyboard?.isVisible?.()??false);
    const show=Keyboard?.addListener("keyboardDidShow",()=>setReplyKeyboardVisible(true)),hide=Keyboard?.addListener("keyboardDidHide",()=>setReplyKeyboardVisible(false));
    return()=>{show?.remove();hide?.remove();};
  },[state.screen]);
  // The progress state is an honest local simulation, not an upload receipt.
  useEffect(() => {
    if (state.screen !== "sending") return;
    const timer = setTimeout(() => dispatch({
      type: "finishSend"
    }), 2400);
    return () => clearTimeout(timer);
  }, [state.screen]);
  const draft = (slot: string) => state.drafts[slot] ?? "";
  const setDraft = (slot: string, text: string) => dispatch({
    type: "draft",
    slot,
    text
  });
  const receipt = state.localReceipt ? <FinalText size={12} secondary testID="final-local-receipt">{c("仅保存在本次演示，没有发送到服务器。", "Saved in this preview only. Nothing was sent to a server.")}</FinalText> : null;
  const question = selectedFinalQuestion(state) ?? state.questions[0];
  const selectedDraft = state.questionVersion === "polished" ? "polished" : "question";
  const answerIndex = state.replyTarget === "anonymous" ? 1 : 0;
  const incomingQuestion = state.incoming.find(q => q.id === state.questionID);
  const responseFixtures = question?.categoryEN === "Sleep routines" ? [["固定睡前的几件小事帮助了我们。我们会先读一本短绘本，再轻声道晚安。", "A consistent bedtime ritual helped us: a short picture book, then a quiet goodnight."], ["我们试着提前开始睡前准备，给孩子多一些平静下来的时间。", "We started winding down earlier to give our child time to settle."]] : question?.categoryEN === "Family time" ? [["我们喜欢去附近公园找不同颜色的树叶，慢慢走就很开心。", "We look for different coloured leaves in a nearby park and take our time."], ["带上水和简单的小点心去散步，很适合我们。", "A walk with water and a simple snack works well for us."]] : question?.categoryEN === "Eating habits" ? [["我们会准备容易拿的小块食物，让孩子按自己的节奏试。", "We offer easy-to-hold food and let our child practise at their own pace."], ["多留一点时间，不急着帮忙，对我们很有用。", "Leaving extra time and not rushing to help worked for us."]] : ANSWERS;
  const answerRows = incomingQuestion ? incomingQuestion.answer ? [[incomingQuestion.answer, incomingQuestion.answer] as const] : [] : question?.replies ? responseFixtures.slice(0, question.replies) : [];
  const filterLabels = {
    gender: [c("不限", "Any"), c("妈妈", "Mothers"), c("爸爸", "Fathers")],
    distance: [c("不限", "Any"), c("1 英里内", "Within 1 mile"), c("3 英里内", "Within 3 miles"),c("5 英里内","Within 5 miles"),c("10 英里内","Within 10 miles")]
  };
  const suggestions = PARENT_FIXTURES.slice(0, 8).filter((p, i) => !state.blocked.includes(p) && (!state.filters.gender || i % 2 === state.filters.gender - 1) && (!state.filters.distance || [1,2,1.5,.8,2.5,1.2,1.8,2.2][i] <= [Infinity,1,3,5,10][state.filters.distance]));
  const settingsScreen = ["preferences", "blocked", "blockedEmpty", "parentSettings", "safetyConfirm"].includes(state.screen);
  const questionText = (q: FixtureQuestion) => en ? q.en : q.cn;
  function page(body: ReactNode, actions?: ReactNode, fill = false, layout:{bodyStyle?:ViewStyle;cardStyle?:ViewStyle;mainStyle?:ViewStyle;showReceipt?:boolean}={}) {
    return <NuriKeyboardFrame><DemoLabel en={en} /><View style={[s.main,layout.mainStyle]}><FinalSurface fill={fill} style={layout.cardStyle} testID={`final-community-${state.screen}`}><ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" showsVerticalScrollIndicator={false} style={{
            flexShrink: 1,
            ...(fill ? {
              flex: 1
            } : {})
          }} contentContainerStyle={[s.body,layout.bodyStyle]}>{body}{layout.showReceipt!==false?receipt:null}</ScrollView></FinalSurface>{actions ? <View style={s.actions}>{actions}</View> : null}</View></NuriKeyboardFrame>;
  }
  const localVoice = (slot: string) => voice ? <VoiceInputBar previewOnly phase="recording" seconds={8} metered={false} level={() => null} onCancel={() => setVoice(false)} onStop={() => {
    setDraft(slot, draft(slot) || c("这是一条语音示例。", "This is a sample voice message."));
    setVoice(false);
  }} onSend={() => {
    setDraft(slot, draft(slot) || c("这是一条语音示例。", "This is a sample voice message."));
    dispatch({
      type: slot==="question"||slot==="polished" ? "previewQuestion" : slot.startsWith("chat:") ? "sendMessage" : slot.startsWith("answer:") ? "sendResponse" : "sendComment"
    });
    setVoice(false);
  }} /> : null;
  const editor=(slot:string,placeholder:string)=><View style={{gap:8}}>
    {question?.closed?<FinalText size={12} secondary>{c("此问题已关闭，不能继续回复。","This question is closed; replies are disabled.")}</FinalText>:null}
    <View testID="final-experience-editor" style={{height:145,borderRadius:18,borderWidth:1,borderColor:"rgba(115,92,132,.25)",backgroundColor:"rgba(255,250,245,.9)",padding:12,justifyContent:"space-between"}}>
      <TextInput testID={"final-input-"+slot} accessibilityLabel={placeholder} editable={!question?.closed} multiline value={draft(slot)} onChangeText={text=>setDraft(slot,text)} placeholder={placeholder} placeholderTextColor="#918896" style={{flex:1,minHeight:48,padding:0,fontSize:14,lineHeight:20,color:FINAL_COLOR.ink,textAlignVertical:"top",fontFamily:locale==="zh-CN"?"NotoSansSC_400Regular":undefined}}/>
      <View style={{height:24,flexDirection:"row",alignItems:"center",gap:8}}>
        <Pressable accessibilityRole="button" accessibilityLabel={c("语音流程预览","Preview voice flow")} disabled={question?.closed} onPress={()=>setVoice(v=>!v)} style={{width:24,height:24,alignItems:"center",justifyContent:"center"}} hitSlop={8}><Image source={require("@/assets/final-flow-20261101/microphone.svg")} style={{width:20,height:20}} contentFit="contain" accessible={false}/></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={c("添加表情","Add emoji")} disabled={question?.closed} onPress={()=>setDraft(slot,draft(slot)+" 🙂")} style={{width:24,height:24,alignItems:"center",justifyContent:"center"}} hitSlop={8}><Image source={require("@/assets/final-flow-20261101/community-emoji.svg")} style={{width:20,height:20}} contentFit="contain" accessible={false}/></Pressable>
        <View style={{flex:1}}/>
        <Pressable accessibilityRole="button" testID="final-send-experience" disabled={question?.closed||!draft(slot).trim()} onPress={()=>dispatch({type:slot.startsWith("answer:")?"sendResponse":"sendComment"})} style={{width:50,height:24,borderRadius:18,backgroundColor:FINAL_COLOR.coral,alignItems:"center",justifyContent:"center",opacity:question?.closed||!draft(slot).trim()?.6:1}} hitSlop={8}><FinalText size={14} style={{lineHeight:20,color:"white"}}>{c("发送","Send")}</FinalText></Pressable>
      </View>
    </View>
    {!question?.closed?localVoice(slot):null}
  </View>;
  if (settingsScreen) return <><DemoLabel en={en} /><SettingsPage testID={`final-community-${state.screen}`}>
      {receipt}
      {state.screen === "preferences" ? <>
        <SettingsRow label={c("交友资料与筛选", "Friend profile & filters")} detail={c("仅本次演示", "This preview only")} onPress={() => go("profileSettings")} testID="final-open-profile-settings" />
        <FinalDivider />
        <View style={{gap:12}} testID="final-community-preferences-group">
          {(["discoverable","nearby"] as const).map(key=><Pressable key={key} testID={"final-community-preference-"+key} accessibilityRole="switch" accessibilityLabel={key==="discoverable"?c("家长消息通知","Parent message notifications"):c("隐藏我的资料","Hide my profile")} accessibilityState={{checked:state.preferences[key]}} onPress={()=>dispatch({type:"preference",key,value:!state.preferences[key]})} style={{paddingVertical:12,minHeight:48,flexDirection:"row",alignItems:"center",gap:16}}>
            <View style={{flex:1,minWidth:0,gap:4}}><FinalText>{key==="discoverable"?c("家长消息通知","Parent message notifications"):c("隐藏我的资料","Hide my profile")}</FinalText>{key==="nearby"?<FinalText size={12} secondary style={{fontWeight:"500",lineHeight:16}}>{c("暂停向其他家长推荐你；已有对话不受影响","Pause parent recommendations; existing conversations are unaffected")}</FinalText>:null}</View>
            <View pointerEvents="none" style={{width:52,height:20,justifyContent:"center"}}><Image source={state.preferences[key]?require("@/assets/final-flow-20261101/settings-switch-on.svg"):require("@/assets/final-flow-20261101/settings-switch-off.svg")} style={{width:state.preferences[key]?32.5:44,height:state.preferences[key]?20:44,marginLeft:state.preferences[key]?0:-5.75}} contentFit="contain" accessible={false}/></View>
          </Pressable>)}
          <SettingsRow label={c("屏蔽的家长", "Blocked parents")} onPress={() => go(state.blocked.length ? "blocked" : "blockedEmpty")} testID="final-open-blocked" />
        </View>
        <FinalDivider />
        <Pressable testID="final-community-preference-showAge" accessibilityRole="switch" accessibilityLabel={c("消息自动翻译","Translate messages automatically")} accessibilityState={{checked:state.preferences.showAge}} onPress={()=>dispatch({type:"preference",key:"showAge",value:!state.preferences.showAge})} style={{paddingVertical:12,minHeight:48,flexDirection:"row",alignItems:"center",gap:16}}>
          <FinalText style={{flex:1}}>{c("消息自动翻译","Translate messages automatically")}</FinalText><View pointerEvents="none" style={{width:52,height:20,justifyContent:"center"}}><Image source={state.preferences.showAge?require("@/assets/final-flow-20261101/settings-switch-on.svg"):require("@/assets/final-flow-20261101/settings-switch-off.svg")} style={{width:state.preferences.showAge?32.5:44,height:state.preferences.showAge?20:44,marginLeft:state.preferences.showAge?0:-5.75}} contentFit="contain" accessible={false}/></View>
        </Pressable>
        <FinalText size={12} secondary style={{fontWeight:"500",lineHeight:16}}>{c("长按消息可查看原文","Long press a message to view the original")}</FinalText>
      </> : state.screen === "blocked" || state.screen === "blockedEmpty" ? <>
        {state.blocked.length ? <View>{state.blocked.map((person,index)=><View key={person}>
          {index?<View style={{height:1,backgroundColor:"rgba(112,106,116,.12)"}}/>:null}
          <View testID={"final-blocked-parent-"+person} style={{height:76,paddingVertical:16,flexDirection:"row",alignItems:"center",gap:12}}><SampleAvatar/><FinalText style={{flex:1,fontWeight:"500",lineHeight:24}}>{person}</FinalText><Pressable accessibilityRole="button" accessibilityLabel={c("取消屏蔽","Unblock ")+person} style={{width:96,height:44,alignItems:"center",justifyContent:"center"}} onPress={()=>dispatch({type:"safety",action:"unblock",person})}><FinalText size={14} style={{fontWeight:"500",lineHeight:20,color:FINAL_COLOR.accent}}>{c("取消屏蔽","Unblock")}</FinalText></Pressable></View>
        </View>)}</View> : <>
          <FinalText style={{fontWeight:"500",lineHeight:24}}>{c("你可以随时重新选择","You can change your choice at any time")}</FinalText>
          <FinalText secondary>{c("解除屏蔽不会自动恢复好友关系。","Unblocking does not automatically restore a friendship.")}</FinalText>
          <View style={{gap:12}}><FinalText size={18} style={{fontWeight:"500",lineHeight:26}}>{c("目前没有屏蔽的家长","No blocked parents")}</FinalText><FinalText secondary>{c("需要时，可在对话设置中屏蔽。","You can block a parent in conversation settings when needed.")}</FinalText></View>
        </>}
      </> : <>
        <SettingsRow label={c("查看家长资料", "View parent profile")} onPress={() => go("parent")} />
        <SettingsRow label={c("屏蔽这位家长", "Block this parent")} danger onPress={() => dispatch({type:"safety",action:"block"})} testID="final-block-parent" />
        <SettingsRow label={c("解除联系", "Disconnect")} danger onPress={() => dispatch({type:"safety",action:"disconnect"})} />
      </>}
      <FinalText size={12} secondary>{c("社区服务尚未接入；以上为本地演示设置。", "Community service is not connected; these are local preview settings.")}</FinalText>
    </SettingsPage>{state.screen==="safetyConfirm"?<Modal transparent animationType="fade" onRequestClose={()=>dispatch({type:"back"})}><BlurView tint="light" intensity={40} style={[s.modal,{backgroundColor:"rgba(254,250,247,.5)"}]}><FinalSurface surfaceColor="rgba(255,255,255,.94)" style={{width:354,maxWidth:"100%",boxShadow:"0px 4px 8px rgba(89,71,92,.14)"}} contentStyle={{padding:24,gap:16}}><FinalText size={20} secondary style={{lineHeight:28,fontWeight:"500"}}>{state.safetyAction==="unblock"?c("取消屏蔽这位家长？","Unblock this parent?"):state.safetyAction==="block"?c("屏蔽这位家长？","Block this parent?"):c("解除联系？","Disconnect?")}</FinalText><FinalText size={14} secondary style={{lineHeight:20}}>{c("仅更改本地演示，不影响真实账号或联系。","This changes only the local preview, not real accounts or connections.")}</FinalText><View style={{flexDirection:"row",gap:12}}><SettingsButton secondary style={{flex:1,width:undefined}} label={c("取消","Cancel")} onPress={()=>dispatch({type:"back"})}/><SettingsButton style={{flex:1,width:undefined}} label={c("确认","Confirm")} onPress={()=>dispatch({type:"confirmSafety"})} testID="final-confirm-safety"/></View></FinalSurface></BlurView></Modal>:null}</>;
  if (home) return <View style={{
    flex: 1,
    minHeight: 0
  }}><DemoLabel en={en} /><View style={{
      flex: 1,
      minHeight: 0,
      paddingTop: 16,
      paddingBottom:4,
      gap:HUB_PAGER_GAP
    }} testID="final-community-pager-viewport" onLayout={e => setWidth(e.nativeEvent.layout.width)}><ScrollView ref={pager} horizontal pagingEnabled showsHorizontalScrollIndicator={false} onLayout={e => setPagerHeight(e.nativeEvent.layout.height)} onContentSizeChange={contentWidth=>{
      // A direct Friends entry/rotation may reach the effect before native
      // content width is committed. Retry only for the current two-page width.
      if(width&&Math.abs(contentWidth-width*2)<1)pager.current?.scrollTo({x:width*state.page,animated:false});
    }} onMomentumScrollEnd={e => {
        if (width) dispatch({
          type: "page",
          page: e.nativeEvent.contentOffset.x > width / 2 ? 1 : 0
        });
      }} style={{
        flex: 1
      }} testID="final-community-pager">
    {([0, 1] as const).map(mode => <View key={mode} style={{
          width: width || 1,
          height: pagerHeight || undefined,
          paddingHorizontal: 12,
          paddingBottom: HUB_CARD_BOTTOM_GUTTER
        }}><FinalSurface fill testID={`final-community-page-${mode}`}><ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{
              paddingHorizontal: 24,
              paddingTop: communityHubTopPadding(pagerHeight,mode),
              paddingBottom: 16,
              gap: 12
            }}>
      <View style={{
                height: mode ? 240 : 260,
                gap: mode ? 8 : 28,
                alignItems: "center"
              }}><View style={{
                  height: 180,
                  width: "100%",
                  alignItems: "center",
                  justifyContent: "center"
                }}>{mode ? <View style={{
                    position:"absolute",
                    left:"22.03%",
                    top:-5,
                    width:"61.02%",
                    aspectRatio:200.13558959960938/169.00338745117188,
                    overflow: "hidden"
                  }}><Image source={require("@/assets/final-flow-20261101/parent-friends.png")} contentFit="fill" style={{
                      position: "absolute",
                      left: 0,
                      top: "-0.07%",
                      width: "100%",
                      height: "110.66%"
                    }} /></View> : <Image source={require("@/assets/final-flow-20261101/question-mascot.svg")} style={{
                    width: 146,
                    height: 181
                  }} contentFit="contain" />}</View><FinalText size={18} style={{
                  textAlign: "center"
                }}>{mode ? c("认识聊得来的家长", "Meet parents you connect with") : c("把问题交给有经历的人", "Ask parents who've been there")}</FinalText></View>
      <FinalButton label={mode ? c("寻找育儿好友", "Find parent friends") : c("向家长提问", "Ask parents")} onPress={() => mode ? go("intent") : dispatch({
                type: "newQuestion"
              })} testID={`final-hub-primary-${mode}`} />
      {mode ? <View testID="final-friends-messages" style={{paddingTop:4,gap:4}}><View style={s.friendDivider}/><View style={{
                  flexDirection: "row",
                  alignItems: "center",
                  minHeight:32
                }}><Pressable accessibilityRole="button" onPress={() => go("inbox")} style={{
                    flex: 1,
                    minHeight: 32,
                    justifyContent: "center"
                  }} testID="final-open-inbox"><FinalText>{c("我的消息", "My messages")}⌃</FinalText></Pressable><Pressable accessibilityRole="button" accessibilityLabel={c("通讯录", "Address book")} onPress={() => go("contacts")} style={{
                    width: 44,
                    height: 32,
                    alignItems: "center",
                    justifyContent: "center"
                  }} testID="final-open-contacts"><Image source={require("@/assets/final-flow-20261101/address-book.svg")} style={{
                      width: 24,
                      height: 24
                    }} /></Pressable></View>{(["Maya", "Ray"] as const).filter(p=>!state.blocked.includes(p)&&!state.disconnected.includes(p)).map((p,i) => <View key={p} style={{gap:4}}>{i?<View style={s.friendDivider}/>:null}<Pressable testID={`final-parent-${p}`} accessibilityRole="button" accessibilityLabel={`${p}，${p==="Maya"?c("好啊！下次我们一起去！", "Sure! Let's go together next time!"):c("周末有空一起去读书角活动吗？", "Free for the reading corner this weekend?")}`} style={s.friendPreviewRow} onPress={() => dispatch({
                  type: "person",
                  person: p,
                  screen: "chat"
                })}><FriendPreviewAvatar/><View style={{flex:1,minWidth:0,gap:4}}><FinalText style={{lineHeight:24}}>{p}</FinalText><FinalText size={14} secondary numberOfLines={1} ellipsizeMode="tail" style={{lineHeight:20}}>{p==="Maya"?c("好啊！下次我们一起去！", "Sure! Let's go together next time!"):c("周末有空一起去读书角活动吗？", "Free for the reading corner this weekend?")}</FinalText></View><FinalText size={20} style={{width:16,lineHeight:24,textAlign:"center",color:FINAL_COLOR.accent}}>›</FinalText><View pointerEvents="none" style={{position:"absolute",left:"9.58%",top:"6.57%",width:14,height:15.2727,alignItems:"center",justifyContent:"center"}}><Image source={require("@/assets/final-flow-20261101/parent-unread.svg")} style={{position:"absolute",width:14,height:15.2727}} contentFit="contain" accessible={false}/><FinalText size={10} style={{lineHeight:14,color:"white",textAlign:"center"}}>1</FinalText></View></Pressable></View>)}</View> : <><FinalDivider/>{([["myQuestions", c("我的问题", "My questions"), c("托育告别总是哭，怎么办？", "Tears at daycare drop-off?"), c("Maya分享了经验", "Maya shared an experience")], ["received", c("收到问题", "Received questions"), c("托育告别总是哭，怎么办？", "Tears at daycare drop-off?"), c("Dean想听听你的意见", "Dean would like your thoughts")]] as const).map(([screen, label, detail, status], i) => <Pressable key={screen} testID={i ? "final-open-received" : "final-open-my-questions"} accessibilityRole="button" accessibilityLabel={`${label}，${detail}，${status}`} onPress={() => go(screen)} style={s.questionEntry}>
                  <View style={s.questionTitle}><View style={{width:29,height:24,justifyContent:"center",flexShrink:0}}><Image testID={`final-bottle-icon-${screen}`} source={require("@/assets/final-flow-20261101/bottle-unread.svg")} style={{width:31,height:29}} contentFit="contain" accessible={false} accessibilityElementsHidden /></View><FinalText size={16} style={{lineHeight:24,flex:1,minWidth:0}}>{label}</FinalText></View>
                  <FinalText size={14} secondary numberOfLines={1} ellipsizeMode="tail" style={{lineHeight:20,minHeight:22}}>{detail}</FinalText>
                  <FinalText size={12} secondary numberOfLines={1} ellipsizeMode="tail" style={{lineHeight:18}}>{status}</FinalText>
                  <View pointerEvents="none" style={s.questionChevron}><FinalText size={20} style={{lineHeight:24,color:FINAL_COLOR.accent}}>›</FinalText></View>
                </Pressable>)}</>}
    </ScrollView></FinalSurface></View>)}
  </ScrollView><View style={s.dots} testID="final-community-dots"><Image testID="final-community-dots-art" source={state.page?require("@/assets/final-flow-20261101/pagination-friends.svg"):require("@/assets/final-flow-20261101/pagination-questions.svg")} style={{width:HUB_PAGINATION.width,height:HUB_PAGINATION.height}} contentFit="contain" accessible={false}/>{([0, 1] as const).map(i => <Pressable key={i} testID={`final-community-dot-${i}`} accessibilityRole="button" accessibilityState={{selected:state.page===i}} accessibilityLabel={i ? c("育儿好友", "Parent friends") : c("漂流瓶", "Questions")} onPress={() => dispatch({
          type: "page",
          page: i
        })} style={[s.dotTarget,{left:i*HUB_PAGINATION.targetSize}]} />)}</View></View></View>;
  if (["compose", "original", "polished"].includes(state.screen)) {
    const choosing=state.screen!=="compose";
    return page(<>
      <View style={{gap:12}}>
        <FinalText style={{fontWeight:"500",lineHeight:24}}>{c("我的问题","My question")}</FinalText>
        {choosing?<View style={{height:40,flexDirection:"row",alignItems:"center",gap:12}}><RefineAvatar/><FinalText style={{fontWeight:"500"}}>{state.questionVersion==="original"?c("选择原版","Use original"):c("选择Nuri润色版","Use Nuri version")}</FinalText></View>:null}
        {(choosing?["question","polished"] as const:["question"] as const).map(slot=>{
          const original=slot==="question",selected=original===(state.questionVersion==="original");
          return <View key={slot} style={{height:original?176:80,borderWidth:1,borderRadius:18,borderColor:choosing&&selected?FINAL_COLOR.selected:"#E0D8DC",backgroundColor:"rgba(255,250,245,.9)",overflow:"hidden"}}>
            <TextInput testID={original?"final-question-input":"final-polished-input"} accessibilityLabel={original?c("我的原始问题","My original question"):c("Nuri版本草稿","Nuri version draft")} multiline value={draft(slot)} onChangeText={text=>setDraft(slot,text)} placeholder={c("写下你的问题…","Write your question…")} placeholderTextColor="#918896" style={{height:original?122:78,padding:16,paddingRight:choosing?38:16,fontSize:16,lineHeight:24,color:FINAL_COLOR.ink,textAlignVertical:"top",fontFamily:locale==="zh-CN"?"NotoSansSC_400Regular":undefined}}/>
            {original?<View style={{height:44,paddingHorizontal:8,flexDirection:"row",alignItems:"center"}}><Pressable testID="final-question-mic" accessibilityRole="button" accessibilityLabel={c("语音流程预览","Preview voice flow")} onPress={()=>setVoice(v=>!v)} style={{width:44,height:44,alignItems:"center",justifyContent:"center"}}><Image source={require("@/assets/final-flow-20261101/microphone.svg")} style={{width:20,height:20}} contentFit="contain" accessible={false}/></Pressable></View>:null}
            {choosing?<Pressable accessibilityRole="radio" accessibilityState={{selected,checked:selected}} aria-checked={selected} accessibilityLabel={original?c("选择原版","Use original"):c("选择Nuri润色版","Use Nuri version")} onPress={()=>dispatch({type:"version",version:original?"original":"polished"})} testID={original?"final-question-original":"final-question-version"} style={{position:"absolute",right:-3,top:-3,width:44,height:44,alignItems:"center",justifyContent:"center"}}><Image source={selected?require("@/assets/final-flow-20261101/community-radio-selected.svg"):require("@/assets/final-flow-20261101/community-radio-empty.svg")} style={{width:16,height:16}} contentFit="contain" accessible={false}/></Pressable>:null}
          </View>;
        })}
      </View>
      {localVoice(selectedDraft)}
      {!choosing?<View style={{height:44,flexDirection:"row",alignItems:"center",gap:12}}><RefineAvatar/><Pressable accessibilityRole="button" testID="final-refine-question" onPress={()=>{setDraft("polished",draft("question"));dispatch({type:"version",version:"polished"});}} style={{height:44,borderRadius:999,paddingHorizontal:24,backgroundColor:FINAL_COLOR.selected,alignItems:"center",justifyContent:"center",boxShadow:"0px 1px 15px rgba(92,86,98,.18)"}}><FinalText style={{fontWeight:"500",color:"white"}}>{c("需要润色吗？","Refine your wording?")}</FinalText></Pressable></View>:null}
      <View style={s.quietDivider}/>
      <View style={{minHeight:44,flexDirection:"row",gap:12,alignItems:"center",flexWrap:"wrap"}}>
        {(["showAge","anonymous"] as const).map(key=><View key={key} style={{flexDirection:"row",alignItems:"center",gap:12}}><FinalText size={12} secondary style={{lineHeight:18}}>{key==="showAge"?c("显示孩子年龄","Show child's age"):c("匿名","Anonymous")}</FinalText><CommunitySwitch value={state[key]} label={key==="showAge"?c("显示孩子年龄","Show child's age"):c("匿名","Anonymous")} onChange={()=>dispatch({type:"toggle",key})} testID={"final-question-"+key}/></View>)}
      </View>
      {choosing?<View accessible accessibilityLabel={c("仅模拟版本选择，不调用AI或隐私处理。","Version-selection preview only. No AI or privacy processing is performed.")} style={{position:"absolute",width:1,height:1,overflow:"hidden"}}/>:null}
    </>,<FinalButton label={c("预览问题","Preview question")} disabled={!selectedQuestionText(state)} onPress={()=>dispatch({type:"previewQuestion"})} testID="final-preview-question"/>);
  }
  if(state.screen==="preview"){
    const text=selectedQuestionText(state);
    return page(<>
      <FinalSurface radius={20} style={{boxShadow:"0px 0px 8px rgba(89,71,92,.12)",minHeight:136}} contentStyle={{padding:16,gap:12}}>
        <FinalText size={12} secondary style={{lineHeight:18}}>{en?question.categoryEN:question.categoryCN}</FinalText>
        <FinalText size={20} style={{fontWeight:"500",lineHeight:28}}>{text}</FinalText>
      </FinalSurface>
      <View style={{minHeight:42,flexDirection:"row",alignItems:"flex-start",gap:12}}><SampleAvatar/><View style={{flex:1,minWidth:0}}><FinalText style={{fontWeight:"500",lineHeight:24}}>{c(state.anonymous?"匿名家长":"示例家长",state.anonymous?"Anonymous parent":"Sample parent")}</FinalText>{state.showAge?<FinalText size={12} secondary style={{lineHeight:18}}>{c("孩子年龄：示例","Child's age: sample")}</FinalText>:null}</View></View>
    </>,<View style={s.actionRow}><FinalButton small secondary label={c("返回编辑","Edit")} onPress={()=>go("compose")}/><FinalButton small label={c("发送漂流瓶","Send bottle")} onPress={()=>dispatch({type:"sendQuestion"})} testID="final-send-question"/></View>,false,{bodyStyle:{padding:12,paddingBottom:16,gap:16},cardStyle:{boxShadow:"0px 0px 8px rgba(89,71,92,.12)"},mainStyle:{paddingTop:12}});
  }
  if(state.screen==="inviteSent")return page(<View style={{height:463,gap:8}}><View style={{height:322,alignItems:"center"}}><Image source={require("@/assets/final-flow-20261101/community-invite-sent.svg")} style={{width:179,height:223,marginTop:42}} contentFit="contain" accessible={false}/></View><View style={{gap:6}}><FinalText size={24} style={{fontWeight:"500",lineHeight:24,textAlign:"center"}}>{c("你的邀请已发送","Your invitation has been sent")}</FinalText><FinalText size={14} secondary style={{lineHeight:20,textAlign:"center"}}>{c("缘分让我们相遇在NURI","Find your connections in NURI")}</FinalText></View></View>,<View style={{alignItems:"center",gap:12}}><FinalText size={10} secondary style={{lineHeight:14,textAlign:"center"}}>{c("仅本地模拟，未真实发送。","Local simulation only; nothing sent.")}</FinalText><FinalButton label={c("返回社区","Back to community")} onPress={()=>go("hub")}/></View>,true,{bodyStyle:{paddingVertical:32},cardStyle:{maxHeight:567},mainStyle:{paddingBottom:29}});
  if(state.screen==="connected"||state.screen==="noMatches"){
    const connected=state.screen==="connected";
    return page(<>
      <View style={{height:connected?312:311,width:"100%",position:"relative",alignItems:"center",justifyContent:"center"}}>
        {connected?<><View style={{position:"absolute",left:"12.424%",top:59,boxShadow:"-15px 19px 25px rgba(235,129,131,.12)",borderRadius:73}}><ConnectionPortrait/></View><View style={{position:"absolute",left:"42.121%",top:124,boxShadow:"27px -17px 23.9px rgba(193,160,221,.24)",borderRadius:73}}><ConnectionPortrait purple/></View></>:<Image source={require("@/assets/final-flow-20261101/community-patient.svg")} style={{width:174,height:217}} contentFit="contain" accessible={false}/>}
      </View>
      <View style={{gap:connected?8:12,width:"100%"}}><FinalText size={24} style={{lineHeight:32,fontWeight:"500",textAlign:"center"}}>{connected?c("你和 "+state.person+" 已建立联系","You and "+state.person+" are connected"):c("暂时没有回应","No response yet")}</FinalText><FinalText size={12} secondary style={{lineHeight:18,textAlign:"center"}}>{connected?c("你们都有幼儿\n住得不远\n喜欢安静的周末","You both have toddlers\nLive nearby\nEnjoy quiet weekends"):c("有新的匹配\n我们会通知你","We'll let you know\nwhen there's a new match")}</FinalText></View>
      <FinalText size={10} secondary style={{lineHeight:14,textAlign:"center",marginTop:16}}>{c("仅在本次演示中预览，不向真实家长发送信息。","Local preview only. Nothing is sent to real parents.")}</FinalText>
    </>,<FinalButton label={connected?c("开始聊天","Start chatting"):c("修改我的档案","Edit my profile")} onPress={()=>connected?dispatch({type:"person",person:state.person,screen:"chat"}):go("profile")} testID={connected?"final-connected-chat":"final-no-matches-profile"}/>,true,{bodyStyle:{paddingVertical:32},cardStyle:{maxHeight:connected?571:570},mainStyle:{paddingBottom:26}});
  }
  if(state.screen==="sent")return <NuriKeyboardFrame><DemoLabel en={en}/><View style={{flex:1,minHeight:0,paddingHorizontal:12,paddingTop:0,paddingBottom:34,alignItems:"center",justifyContent:"center"}}>
    <FinalSurface testID="final-community-sent" style={{width:354,maxWidth:"100%",height:340}} contentStyle={{height:340,paddingHorizontal:32,alignItems:"center",justifyContent:"center"}}>
      <FinalText size={20} secondary style={{fontWeight:"500",lineHeight:28,textAlign:"center"}}>{c("发送成功","Sent successfully")}</FinalText>
      <View style={{width:128,height:128,alignItems:"center",justifyContent:"center"}}><View style={{width:64,height:64,borderRadius:32,backgroundColor:"rgba(217,217,217,.3)",alignItems:"center",justifyContent:"center"}}><Image source={require("@/assets/final-flow-20261101/community-bottle-gray.svg")} style={{width:10.9688,height:23.2031,transform:[{rotate:"45deg"}]}} contentFit="contain" accessible={false}/></View></View>
      <FinalText size={14} secondary style={{lineHeight:20,textAlign:"center"}}>{c("请静静等待回复","Please wait for replies")}</FinalText>
      <FinalText testID="final-sent-local-disclosure" size={10} secondary style={{position:"absolute",left:24,right:24,bottom:24,lineHeight:14,textAlign:"center"}}>{c("本地流程预览，没有发送到服务器。","Local flow preview. Nothing sent to a server.")}</FinalText>
    </FinalSurface>
    <View style={{position:"absolute",bottom:40,alignSelf:"center"}}><FinalButton label={c("继续","Continue")} onPress={()=>go("myQuestions")}/></View>
  </View></NuriKeyboardFrame>;
  if(state.screen==="responseSent")return page(<View style={{gap:8,alignItems:"center"}}>
    <Image source={require("@/assets/final-flow-20261101/community-experience-sent.svg")} style={{width:179,height:223}} contentFit="contain" accessible={false}/>
    <View style={{gap:4,width:"100%"}}><FinalText style={{fontWeight:"500",lineHeight:24,textAlign:"center"}}>{c("你的经验已经送到了","Your experience has been shared")}</FinalText><FinalText size={14} secondary style={{lineHeight:20,textAlign:"center"}}>{c("谢谢你，把自己走过的路分享给另一位家长。","Thank you for sharing your experience with another parent.")}</FinalText></View>
  </View>,<View style={{alignItems:"center",gap:12}}><FinalText size={10} secondary style={{lineHeight:14,textAlign:"center"}}>{c("仅本地模拟，未真实发送。","Local simulation only; nothing sent.")}</FinalText><FinalButton label={c("返回社区","Back to community")} onPress={()=>go("hub")}/></View>,false,{bodyStyle:{paddingHorizontal:24,paddingVertical:32},mainStyle:{paddingTop:12},showReceipt:false});
  if(state.screen==="sending")return <NuriKeyboardFrame><DemoLabel en={en}/><View style={{flex:1,minHeight:0,paddingHorizontal:12,paddingTop:0,paddingBottom:34,alignItems:"center",justifyContent:"center"}}>
    <FinalSurface testID="final-community-sending" style={{width:354,maxWidth:"100%",height:340}} contentStyle={{height:340,paddingHorizontal:32,alignItems:"center",justifyContent:"center"}}>
      <FinalText size={20} secondary style={{fontWeight:"500",lineHeight:28,textAlign:"center"}}>{c("正在发送","Sending")}</FinalText><BottleSendVisual/><FinalText size={14} secondary style={{lineHeight:20,textAlign:"center"}}>{c("让漂流瓶轻轻出发…","Let the bottle set off gently…")}</FinalText>
      <FinalText size={10} secondary style={{lineHeight:14,textAlign:"center",marginTop:8}}>{c("仅本地模拟，未真实发送。","Local simulation only; nothing sent.")}</FinalText>
    </FinalSurface>
  </View></NuriKeyboardFrame>;
  if(["myQuestions","selection","close","delete"].includes(state.screen)){
    const selecting=state.screen!=="myQuestions",visible=state.questions.filter(q=>questionText(q).toLocaleLowerCase().includes(search.toLocaleLowerCase()));
    const listQuestion=(q:FixtureQuestion)=><FinalSurface style={{boxShadow:"0px 0px 8px rgba(89,71,92,.12)"}} contentStyle={{padding:12,gap:12}}>
      <View style={{gap:8,paddingRight:selecting?24:0}}>
        <FinalText size={12} secondary style={{lineHeight:18}}>{en?q.categoryEN:q.categoryCN}</FinalText>
        <FinalText size={20} style={{fontWeight:"500",lineHeight:28}}>{questionText(q)}</FinalText>
      </View>
      <View style={{height:32,flexDirection:"row",alignItems:"center",gap:12}}>
        <View style={{width:32,height:32,alignItems:"center",justifyContent:"center"}}><Image source={q.closed?require("@/assets/final-flow-20261101/community-question-bottle-gray.svg"):require("@/assets/final-flow-20261101/community-question-bottle-coral.svg")} style={{width:7.875,height:16.3125,transform:[{rotate:"45deg"}]}} contentFit="contain" accessible={false}/>{!q.closed&&q.replies?<View style={{position:"absolute",left:16,top:10,width:14,height:15.273,alignItems:"center",justifyContent:"center"}}><Image source={require("@/assets/final-flow-20261101/parent-unread.svg")} style={{position:"absolute",width:14,height:15.273}} contentFit="contain" accessible={false}/><FinalText size={10} style={{color:"white",lineHeight:14}}>{q.replies>2?3:1}</FinalText></View>:null}</View>
        <FinalText size={12} secondary style={{flex:1,lineHeight:20}} numberOfLines={1}>{q.closed?c("已关闭","Closed"):q.replies+" "+c("条回复 · 今天 09:35","replies · Today 09:35")}</FinalText>
      </View>
      {selecting?<View pointerEvents="none" style={{position:"absolute",right:12,top:12,width:20,height:20}}><Image source={state.selected.includes(q.id)?require("@/assets/final-flow-20261101/community-checkbox-selected.svg"):require("@/assets/final-flow-20261101/community-checkbox-empty.svg")} style={{width:20,height:20}} contentFit="contain" accessible={false}/></View>:null}
    </FinalSurface>;
    return <NuriKeyboardFrame><DemoLabel en={en}/><View style={{flex:1,minHeight:0,paddingTop:12,paddingBottom:selecting?108:34}}>
      <View style={{height:44,flexDirection:"row",alignItems:"center",gap:12,paddingHorizontal:12,zIndex:3}}>
        <View style={{flex:1,minWidth:0}}><Search compact iconSize={20} value={search} onChange={setSearch} placeholder={c("搜索","Search")}/></View>
        {selecting?<FinalSurface radius={22} surfaceColor={FINAL_COLOR.base} style={{width:104,height:44,boxShadow:"0px 2px 12px rgba(89,71,92,.12)"}} contentStyle={{flexDirection:"row"}}>
          <Pressable accessibilityRole="button" accessibilityLabel={c("更多操作","More actions")} testID="final-question-more" onPress={()=>setSelectionMenu(v=>!v)} style={{width:52,height:44,alignItems:"center",justifyContent:"center"}}><Image source={require("@/assets/final-flow-20261101/community-more.svg")} style={{width:20,height:20}} contentFit="contain" accessible={false}/></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={c("退出选择","Exit selection")} onPress={()=>{setSelectionMenu(false);go("myQuestions");}} testID="final-exit-selection" style={{width:52,height:44,alignItems:"center",justifyContent:"center"}}><Image source={require("@/assets/final-flow-20261101/community-selection-exit.svg")} style={{width:20,height:20}} contentFit="contain" accessible={false}/></Pressable>
        </FinalSurface>:<Pressable accessibilityRole="button" onPress={()=>{setSelectionMenu(false);go("selection");}} testID="final-select-questions" style={{width:58,height:44,justifyContent:"center"}}><View style={{height:28,borderRadius:22,backgroundColor:FINAL_COLOR.base,alignItems:"center",justifyContent:"center",boxShadow:"0px 2px 12px rgba(89,71,92,.12)"}}><FinalText size={14} secondary style={{lineHeight:20,fontWeight:"500"}}>{c("选择","Select")}</FinalText></View></Pressable>}
      </View>
      {!selecting?<View style={{height:48,paddingTop:12,paddingHorizontal:12,justifyContent:"center"}}><FinalText size={12} secondary style={{lineHeight:18}}>{state.questions.length} {c("个漂流瓶","bottles")}</FinalText></View>:null}
      <ScrollView testID="final-my-questions-scroll" showsVerticalScrollIndicator={false} style={{flex:1,minHeight:0,marginTop:-12}} contentContainerStyle={{paddingHorizontal:12,paddingTop:24,paddingBottom:24,gap:16}}>
        {receipt}
        {visible.map(q=><Pressable key={q.id} accessibilityRole={selecting?"checkbox":"button"} accessibilityState={selecting?{checked:state.selected.includes(q.id)}:undefined} onPress={()=>selecting?dispatch({type:"select",id:q.id}):dispatch({type:"openQuestion",id:q.id})} testID={selecting?"final-select-"+q.id:"final-question-"+q.id}>{listQuestion(q)}</Pressable>)}
        {!visible.length?<FinalText secondary style={{padding:24,textAlign:"center"}}>{c("没有匹配的问题","No matching questions")}</FinalText>:null}
      </ScrollView>
      {selecting?<View style={{position:"absolute",left:0,right:0,bottom:46,alignItems:"center"}}><FinalSurface radius={25} surfaceColor={FINAL_COLOR.base} style={{width:228,height:50,boxShadow:"0px 2px 12px rgba(89,71,92,.12)"}} contentStyle={{height:50,alignItems:"center",justifyContent:"center"}}><FinalText size={14} secondary style={{fontWeight:"500",lineHeight:21}}>{c("已选择 "+state.selected.length+" 个漂流瓶",state.selected.length+" bottles selected")}</FinalText></FinalSurface></View>:null}
      {selecting&&selectionMenu?<View style={{position:"absolute",top:56,right:12,zIndex:10}}><FinalSurface radius={24} surfaceColor={FINAL_COLOR.base} style={{width:212,height:120,boxShadow:"0px 2px 12px rgba(89,71,92,.12)"}} contentStyle={{paddingVertical:8}}>{(["close","delete"] as const).map(action=><Pressable key={action} testID={"final-question-menu-"+action} accessibilityRole="button" disabled={!state.selected.length} onPress={()=>{setSelectionMenu(false);go(action);}} style={{height:52,paddingHorizontal:20,justifyContent:"center",opacity:state.selected.length?1:.5}}><FinalText style={{color:action==="delete"?FINAL_COLOR.coral:FINAL_COLOR.secondary}}>{action==="close"?c("关闭漂流瓶","Close bottles"):c("删除漂流瓶","Delete bottles")}</FinalText></Pressable>)}</FinalSurface></View>:null}
    </View>{state.screen==="close"||state.screen==="delete"?<Modal transparent animationType="fade" onRequestClose={()=>dispatch({type:"back"})}><BlurView tint="light" intensity={40} style={[s.modal,{backgroundColor:"rgba(254,250,247,.5)"}]}><FinalSurface surfaceColor="rgba(255,255,255,.94)" style={{width:354,maxWidth:"100%",boxShadow:"0px 4px 8px rgba(89,71,92,.14)"}} contentStyle={{padding:24,gap:16}}><FinalText size={20} secondary style={{lineHeight:28,fontWeight:"500"}}>{state.screen==="close"?c("确定关闭这 "+state.selected.length+" 个漂流瓶？","Close these "+state.selected.length+" bottles?"):c("确定删除这 "+state.selected.length+" 个漂流瓶？","Delete these "+state.selected.length+" bottles?")}</FinalText><FinalText size={14} secondary style={{lineHeight:20}}>{c("只影响本次演示中的选中记录，不修改真实数据。","Only selected records in this preview are affected; no real data is changed.")}</FinalText><View style={s.actionRow}><FinalButton small secondary label={c("取消","Cancel")} onPress={()=>dispatch({type:"back"})}/><FinalButton small label={state.screen==="close"?c("确定关闭","Close"):c("确定删除","Delete")} onPress={()=>dispatch({type:"confirmQuestions",action:state.screen==="close"?"close":"delete"})} testID="final-confirm-questions"/></View></FinalSurface></BlurView></Modal>:null}</NuriKeyboardFrame>;
  }
  if(["received","receivedReplied","receivedLocked"].includes(state.screen))return <NuriKeyboardFrame><DemoLabel en={en}/><View style={{flex:1,minHeight:0,padding:12,paddingBottom:34,gap:12}}>
    <View testID="final-received-tabs" style={{height:44,flexDirection:"row",padding:4,borderRadius:22,backgroundColor:"rgba(255,255,255,.5)"}}>{(["waiting","replied","locked"] as const).map((tab,i)=><Pressable key={tab} onPress={()=>dispatch({type:"receivedTab",tab})} accessibilityRole="tab" accessibilityState={{selected:state.receivedTab===tab}} testID={"final-received-"+tab} style={{flex:1,height:36,borderRadius:18,alignItems:"center",justifyContent:"center",backgroundColor:state.receivedTab===tab?FINAL_COLOR.selected:"transparent"}}><FinalText style={{color:state.receivedTab===tab?"white":FINAL_COLOR.secondary}}>{c(["待回复","已回复","已锁定"][i],["To reply","Replied","Locked"][i])}</FinalText></Pressable>)}</View>
    <ScrollView testID="final-received-scroll" showsVerticalScrollIndicator={false} style={{flex:1,minHeight:0}} contentContainerStyle={{gap:12,paddingBottom:12}}>
      {state.incoming.filter(q=>q.status===state.receivedTab).map((q,i)=><FinalSurface key={q.id} style={{boxShadow:"0px 0px 8px rgba(89,71,92,.12)"}} contentStyle={{padding:12,gap:12}}>
        <View style={{height:40,flexDirection:"row",alignItems:"center",gap:12}}><SampleAvatar size={32}/><View style={{flex:1,minWidth:0}}><FinalText style={{lineHeight:24}}>{i===1?"Maya":c("匿名家长","Anonymous parent")}</FinalText>{i<2?<FinalText size={12} secondary style={{lineHeight:18}}>{c("孩子年龄：示例","Child's age: sample")}</FinalText>:null}</View><Pressable accessibilityRole="button" style={{width:72,height:40,alignItems:"center",justifyContent:"center"}} onPress={()=>dispatch({type:"openReceived",id:q.id})} testID={"final-open-"+q.id}><FinalText size={12} secondary style={{lineHeight:18}}>{c("查看","View")}</FinalText></Pressable></View>
        <Pressable accessibilityRole="button" onPress={()=>dispatch({type:"openReceived",id:q.id})}><FinalSurface radius={20} style={{minHeight:112,boxShadow:"0px 0px 8px rgba(89,71,92,.12)"}} contentStyle={{padding:16,gap:8}}>
          <View style={{height:20,flexDirection:"row",alignItems:"center",gap:12}}><View style={{width:20,height:20,alignItems:"center",justifyContent:"center"}}><Image testID={"final-received-bottle-"+q.id} source={q.status==="replied"?require("@/assets/final-flow-20261101/community-question-bottle-gray.svg"):require("@/assets/final-flow-20261101/community-received-bottle.svg")} style={{width:7.875,height:16.3125,transform:[{rotate:"45deg"}]}} contentFit="contain" accessible={false}/></View><FinalText size={12} secondary style={{flex:1,lineHeight:18}}>{en?q.categoryEN:q.categoryCN}</FinalText><FinalText size={12} secondary style={{lineHeight:18}}>{c("今天 09:20","Today 09:20")}</FinalText></View>
          <FinalText style={{lineHeight:24}}>{questionText(q)}</FinalText>
        </FinalSurface></Pressable>
      </FinalSurface>)}
    </ScrollView>
  </View></NuriKeyboardFrame>;
  if(["replies","comments","replyExpanded","replyDetail","replyKeyboard","respond","responsePrompt"].includes(state.screen)){
    const responding=state.screen==="respond",expanded=state.screen==="replyExpanded",prompting=state.screen==="responsePrompt",thread=state.screen==="comments",detail=thread||state.screen==="replyDetail"||state.screen==="replyKeyboard";
    const slot=responding?"answer:"+state.questionID:"comment:"+state.questionID+":"+state.replyTarget;
    const questionContext=<FinalSurface testID="final-question-context" style={{boxShadow:"0px 0px 8px rgba(89,71,92,.12)"}} contentStyle={{padding:12,gap:8}}>
      <View style={{height:responding?40:32,flexDirection:"row",alignItems:"center",gap:12}}><View style={{width:28,height:28,alignItems:"center",justifyContent:"center"}}><Image source={require("@/assets/final-flow-20261101/community-reply-question-bottle.svg")} style={{width:7.875,height:16.3125,transform:[{rotate:"45deg"}]}} contentFit="contain" accessible={false}/></View><FinalText size={12} secondary style={{flex:1,lineHeight:18}}>{(en?question.categoryEN:question.categoryCN)+c("/匿名"," / Anonymous")}</FinalText><FinalText size={12} secondary style={{lineHeight:18}}>{c("今天 09:20","Today 09:20")}</FinalText></View>
      <FinalSurface radius={20} style={{height:responding?112:84,boxShadow:"0px 0px 8px rgba(89,71,92,.12)"}} contentStyle={{height:responding?112:84}}><ScrollView nestedScrollEnabled showsVerticalScrollIndicator={false} style={{flex:1,minHeight:0}} contentContainerStyle={{padding:16}}><FinalText size={20} style={{fontWeight:"500",lineHeight:28}}>{questionText(question)}</FinalText></ScrollView></FinalSurface>
    </FinalSurface>;
    const answer=(entry:readonly string[],i:number,small=false)=><View key={i} style={{gap:small?4:detail?16:12}}>
      <View style={{height:36,flexDirection:"row",alignItems:"center",gap:8}}><SampleAvatar size={36}/><FinalText size={small?14:16} secondary style={{flex:1,lineHeight:small?20:24,fontWeight:small?"400":"500"}}>{incomingQuestion?c("我的回复","My reply"):(detail?answerIndex:i)?c("匿名家长","Anonymous parent"):"Maya"}</FinalText>{!detail&&!question.closed&&!incomingQuestion?<Pressable accessibilityRole="button" onPress={()=>dispatch({type:"replyTarget",target:i?"anonymous":"Maya"})} testID={i?"final-reply-anonymous":"final-reply-Maya"} style={{minWidth:60,height:36,alignItems:"center",justifyContent:"center"}}><FinalText size={12} secondary style={{lineHeight:18}}>{c("回复 ›","Reply ›")}</FinalText></Pressable>:null}</View>
      <FinalText size={small?14:16} style={{lineHeight:small?20:24}}>{c(entry[0],entry[1])}</FinalText>
      <View style={s.quietDivider}/>
    </View>;
    if(prompting)return <NuriKeyboardFrame><DemoLabel en={en}/><View style={{flex:1,minHeight:0,padding:12,paddingBottom:34,gap:12}}>{questionContext}<View style={{height:44,flexDirection:"row",alignItems:"center",gap:12}}><RefineAvatar prompt/><Pressable accessibilityRole="button" testID="final-share-experience" onPress={()=>go("respond")} style={{height:44,paddingHorizontal:24,borderRadius:999,backgroundColor:FINAL_COLOR.selected,alignItems:"center",justifyContent:"center",boxShadow:"0px 1px 15px rgba(92,86,98,.18)"}}><FinalText style={{fontWeight:"500",color:"white"}}>{c("你有想法吗？","Would you like to share?")}</FinalText></Pressable></View></View></NuriKeyboardFrame>;
    if(responding||expanded&&replyKeyboardVisible)return <NuriKeyboardFrame><DemoLabel en={en}/><View style={{flex:1,minHeight:0,padding:12,paddingBottom:34,gap:12}}>
      <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} style={{flex:1,minHeight:0}}>{questionContext}</ScrollView>
      <FinalSurface testID={"final-community-"+state.screen} style={{boxShadow:"0px 0px 8px rgba(92,86,98,.12)"}} contentStyle={{padding:16,gap:8}}><FinalText size={12} secondary style={{lineHeight:18}}>{responding?c("我的经验","My experience"):c("回复所有人","Reply to everyone")}</FinalText>{editor(slot,c("写下你的回复…","Write your reply…"))}{receipt}</FinalSurface>
    </View></NuriKeyboardFrame>;
    if(detail)return <NuriKeyboardFrame><DemoLabel en={en}/><View style={{flex:1,minHeight:0,padding:12,paddingBottom:34}}>
      <FinalSurface testID={"final-community-"+state.screen} style={{maxHeight:thread?553:undefined,boxShadow:"0px 0px 8px rgba(89,71,92,.12)"}}>
        <ScrollView testID="final-reply-thread-scroll" keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} style={{flexShrink:1}} contentContainerStyle={{padding:20,gap:16,minHeight:thread?undefined:385}}>
          <FinalText size={12} secondary style={{lineHeight:18}}>{(en?question.categoryEN:question.categoryCN)+c("/匿名"," / Anonymous")}</FinalText>
          {(answerRows.slice(answerIndex,answerIndex+1)).map((a,i)=>answer(a,i,thread))}
          {state.comments.filter(comment=>comment.questionID===state.questionID&&comment.target===state.replyTarget).map((comment,i)=><View key={i} style={{gap:8}}><FinalText size={12} secondary>{c("你的演示回复","Your preview reply")}</FinalText><FinalText size={14} style={{lineHeight:20}}>{comment.text}</FinalText><View style={s.quietDivider}/></View>)}
          <View style={{gap:12}}><FinalText size={14} secondary style={{lineHeight:20,fontWeight:"500"}}>{c("你的回复","Your reply")}</FinalText>{editor(slot,c("写下你的回复…","Write your reply…"))}</View>
          {receipt}
        </ScrollView>
      </FinalSurface>
    </View></NuriKeyboardFrame>;
    return <NuriKeyboardFrame><DemoLabel en={en}/><View style={{flex:1,minHeight:0,padding:12,paddingBottom:34,gap:16}}>
      {questionContext}
      <FinalSurface fill testID={"final-community-"+state.screen} style={{maxHeight:546,boxShadow:"0px 0px 8px rgba(89,71,92,.12)"}} contentStyle={{flex:1,minHeight:0,padding:16,gap:16}}>
        <FinalText size={12} secondary style={{lineHeight:18}}>{incomingQuestion?c("我的经验","My experience"):c("收到 "+answerRows.length+" 位家长的经验","Experiences from "+answerRows.length+" parents")}</FinalText>
        <ScrollView testID="final-reply-list-scroll" keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} style={{flex:1,minHeight:0}} contentContainerStyle={{gap:16,paddingBottom:16}}>{answerRows.map((a,i)=>answer(a,i))}{state.comments.filter(comment=>comment.questionID===state.questionID&&comment.target==="all").map((comment,i)=><View key={i} style={{gap:8}}><FinalText size={12} secondary>{c("你的演示回复","Your preview reply")}</FinalText><FinalText>{comment.text}</FinalText></View>)}{receipt}</ScrollView>
        <View style={{gap:8}}>
          <Pressable accessibilityRole="button" testID="final-expand-reply" disabled={question.closed} onPress={()=>dispatch({type:"replyTarget",target:"all",expanded:true})} style={{minHeight:18,justifyContent:"center"}}><FinalText size={12} secondary style={{lineHeight:18}}>{question.closed?c("此问题已关闭","This question is closed"):c("回复所有人","Reply to everyone")}</FinalText></Pressable>
          {expanded?editor(slot,c("写下你的回复…","Write your reply…")):<View style={{height:46,borderWidth:1,borderColor:"rgba(93,80,96,.16)",borderRadius:18,backgroundColor:"rgba(255,250,245,.9)",flexDirection:"row",alignItems:"center",paddingLeft:8,paddingRight:12}}>
            <Pressable accessibilityRole="button" disabled={question.closed} accessibilityLabel={c("语音流程预览","Preview voice flow")} onPress={()=>setVoice(v=>!v)} style={{width:44,height:44,alignItems:"center",justifyContent:"center"}}><Image source={require("@/assets/final-flow-20261101/microphone.svg")} style={{width:20,height:20}} contentFit="contain" accessible={false}/></Pressable>
            <TextInput testID="final-comment-input" accessibilityLabel={c("写下回复","Write a reply")} editable={!question.closed} value={draft(slot)} onChangeText={text=>setDraft(slot,text)} onFocus={()=>dispatch({type:"replyTarget",target:"all",expanded:true})} placeholder={c("写下回复…","Write a reply…")} placeholderTextColor="#918896" style={{...singleLineInputStyle,flex:1,height:44,padding:0,fontSize:14,lineHeight:20,color:FINAL_COLOR.ink}}/>
          </View>}{!expanded?localVoice(slot):null}
        </View>
      </FinalSurface>
    </View></NuriKeyboardFrame>;
  }
  if (state.screen==="inbox"||state.screen==="contacts"||state.screen==="invitations"){
    const inbox=state.screen==="inbox",invitations=state.screen==="invitations";
    const visible=(people:readonly FixtureParent[])=>people.filter(p=>!state.blocked.includes(p)&&(invitations||!state.disconnected.includes(p))&&p.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
    const row=(person:FixtureParent,description:string,options:{status?:string;unread?:boolean;invitation?:boolean}={})=><Pressable key={person} testID={"final-parent-"+person} accessibilityRole="button" onPress={()=>dispatch({type:"person",person,screen:invitations?(state.receivedInvitations.includes(person)?"incomingParent":"parent"):"chat"})} style={{minHeight:options.invitation?68:inbox?72:66,paddingVertical:options.invitation?12:8,paddingHorizontal:options.invitation?0:8,flexDirection:"row",alignItems:"center",gap:options.invitation?12:16}}>
      <View style={{width:40,height:40,flexShrink:0}}><FriendPreviewAvatar/>{options.unread?<View pointerEvents="none" style={options.invitation?{position:"absolute",right:-2,top:0,width:8,height:8,borderRadius:4,backgroundColor:FINAL_COLOR.coral}:{position:"absolute",right:-1,top:-8,width:14,height:15.273,alignItems:"center",justifyContent:"center"}}>{!options.invitation?<><Image source={require("@/assets/final-flow-20261101/parent-unread.svg")} style={{position:"absolute",width:14,height:15.273}} contentFit="contain" accessible={false}/><FinalText size={10} style={{lineHeight:14,color:"white",textAlign:"center"}}>1</FinalText></>:null}</View>:null}</View>
      <View style={{flex:1,minWidth:0,gap:options.invitation?2:4}}><FinalText style={{fontWeight:"500",lineHeight:24}}>{person}</FinalText><FinalText size={options.invitation?12:14} secondary style={{lineHeight:20}} numberOfLines={1}>{description}</FinalText></View>
      {options.status?<FinalText size={12} secondary style={{width:96,maxWidth:"34%",lineHeight:20,textAlign:"right",flexShrink:1}}>{options.status}</FinalText>:<FinalText size={20} style={{width:16,lineHeight:24,textAlign:"center",color:FINAL_COLOR.accent}}>›</FinalText>}
    </Pressable>;
    const divider=<View style={s.friendDivider}/>;
    const groups=[{title:c("收到的邀请","Received invitations"),people:state.receivedInvitations},{title:c("发出的邀请","Sent invitations"),people:state.sentInvitations},{title:c("已建立联系","Connected"),people:state.contacts.filter(p=>p!=="Zoe")}];
    return <NuriKeyboardFrame><DemoLabel en={en}/><View style={{flex:1,minHeight:0,paddingHorizontal:12,paddingTop:16,paddingBottom:inbox?4:22,gap:8}}>
      <FinalSurface fill style={{maxHeight:619}} testID={"final-community-"+state.screen}>
        {!inbox?<View style={{marginLeft:8,marginRight:28,marginTop:13,height:44,flexDirection:"row",alignItems:"center"}}><IconAction name="back" label={c("返回","Back")} onPress={()=>dispatch({type:"back"})}/><View style={{flex:1,minWidth:0}}><Search compact value={search} onChange={setSearch} placeholder={c("搜索","Search")}/></View></View>:null}
        <ScrollView testID={"final-"+state.screen+"-scroll"} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} style={{flex:1,minHeight:0}} contentContainerStyle={{paddingHorizontal:24,paddingTop:inbox?24:invitations?11:14,paddingBottom:24,gap:inbox?12:invitations?16:8}}>
          {inbox?<>
            <Search value={search} onChange={setSearch} placeholder={c("搜索","Search")}/>
            <View style={{paddingTop:4,gap:4}}>
              <View style={{height:32,flexDirection:"row",alignItems:"center",gap:4}}><Pressable accessibilityRole="button" accessibilityLabel={c("收起我的消息","Collapse messages")} onPress={()=>go("friends")} style={{flex:1,minHeight:32,justifyContent:"center"}}><FinalText style={{fontWeight:"500"}}>{c("我的消息","My messages")} <FinalText size={16} style={{color:FINAL_COLOR.accent}}>⌄</FinalText></FinalText></Pressable><Pressable accessibilityRole="button" accessibilityLabel={c("通讯录","Address book")} onPress={()=>go("contacts")} style={{width:44,height:44,alignItems:"center",justifyContent:"center"}}><Image source={require("@/assets/final-flow-20261101/address-book.svg")} style={{width:24,height:24}} contentFit="contain" accessible={false}/></Pressable></View>
              {visible(["Maya","Ray","Dean","Robin","Maria","Zoe"]).map((p,i)=><View key={p} style={{gap:4}}>{i?divider:null}{row(p,p==="Maya"?c("好啊！下次我们一起去！","Sure! Let's go together next time!"):c("周末有空一起去读书角活动吗？","Free for the reading corner this weekend?"),{unread:true})}</View>)}
            </View>
          </>:invitations?groups.map((group,groupIndex)=><View key={group.title} style={{gap:4}}><View style={{height:24,flexDirection:"row",alignItems:"center",gap:8}}><FinalText size={14} style={{fontWeight:"500",lineHeight:20}}>{group.title}</FinalText><FinalText size={12} secondary style={{lineHeight:20}}>{visible(group.people).length}</FinalText></View>{visible(group.people).map((p,i)=><View key={p}>{i?divider:null}{row(p,groupIndex===0?c("邀请你建立联系","Invited you to connect"):groupIndex===1?c("邀请已发出","Invitation sent"):p==="Maya"?c("对方已通过你的邀请","Accepted your invitation"):c("你已通过对方的邀请","You accepted their invitation"),{invitation:true,unread:groupIndex!==1,status:groupIndex===0?c("待你通过","Awaiting you"):groupIndex===1?c("等待通过","Pending"):c("已建立联系","Connected")})}</View>)}</View>):<>
            <Pressable accessibilityRole="button" style={{minHeight:72,padding:4,flexDirection:"row",alignItems:"center",gap:12}} onPress={()=>go("invitations")} testID="final-new-connections"><View style={{flex:1,gap:4}}><View style={{flexDirection:"row",alignItems:"center"}}><FinalText style={{fontWeight:"500"}}>{c("新的联系","New connections")}</FinalText><View style={{width:14,height:15.273,alignItems:"center",justifyContent:"center",alignSelf:"flex-start",marginTop:-4}}><Image source={require("@/assets/final-flow-20261101/parent-unread.svg")} style={{position:"absolute",width:14,height:15.273}} contentFit="contain" accessible={false}/><FinalText size={10} style={{lineHeight:14,color:"white"}}>4</FinalText></View></View><FinalText size={12} secondary style={{lineHeight:18}}>{c("查看请求与回应","View requests and responses")}</FinalText></View><FinalText size={20} style={{width:16,lineHeight:24,color:FINAL_COLOR.accent}}>›</FinalText></Pressable>
            {divider}
            {visible(state.contacts).map((p,i,people)=><View key={p} style={{gap:8}}>{i===0||p[0]!==people[i-1][0]?<FinalText size={10} style={{height:24,lineHeight:14}}>{p[0]}</FinalText>:null}{row(p,p==="Maria"?"Hello!":c("好啊！下次我们一起去！","Sure! Let's go together next time!"))}{divider}</View>)}
          </>}
        </ScrollView>
      </FinalSurface>
      {inbox?<View style={{width:30,height:9,alignSelf:"center"}}><Image source={require("@/assets/final-flow-20261101/pagination-friends.svg")} style={{width:30,height:9}} contentFit="contain" accessible={false}/></View>:null}
    </View></NuriKeyboardFrame>;
  }
  if(state.screen==="intent")return page(<>
    <View style={{height:24,alignSelf:"stretch",alignItems:"flex-end"}}><Pressable accessibilityRole="button" accessibilityLabel={c("跳过","Skip")} hitSlop={10} style={{height:24,minWidth:44,alignItems:"center",justifyContent:"center"}} onPress={()=>go("profile")}><FinalText size={14} secondary style={{lineHeight:24,fontWeight:"500"}}>{c("跳过","Skip")}</FinalText></Pressable></View>
    <View style={{height:60}}><FinalText style={{fontWeight:"500",textAlign:"center",lineHeight:24}}>{c("你希望和新朋友一起","With new friends, you'd like to…")}</FinalText></View>
    <View style={{height:407,gap:16,alignItems:"center"}}>
      {[["交流育儿智慧","Share parenting ideas"],["聊聊育儿心事","Talk about parenting"],["与我经历相似","Meet someone with similar experiences"],["和我一起遛娃","Enjoy outings with children"],["在我附近","Meet nearby parents"],["随便聊聊","Have a chat"]].map(([cn,english],i)=><Pressable key={i} onPress={()=>dispatch({type:"intent",index:i})} accessibilityRole="checkbox" accessibilityState={{checked:state.intents.includes(i)}} style={{height:44,width:248,maxWidth:"100%",alignItems:"center",justifyContent:"center",flexShrink:0}}>
        <View pointerEvents="none" style={{position:"absolute",left:0,right:0,top:-2,height:48,borderRadius:22,backgroundColor:state.intents.includes(i)?FINAL_COLOR.selected:"rgba(255,248,242,.75)",boxShadow:"0px 1px 4px rgba(0,0,0,.25)"}}/>
        <FinalText size={14} style={{lineHeight:20,color:state.intents.includes(i)?"white":FINAL_COLOR.ink,textAlign:"center",paddingHorizontal:12}}>{c(cn,english)}</FinalText>
      </Pressable>)}
      <FinalText size={12} style={{lineHeight:24,textAlign:"center",opacity:.65,fontWeight:"500"}}>{c("多选","Choose any that fit")}</FinalText>
    </View>
  </>,<FinalButton label={c("下一步","Next")} onPress={()=>go("profile")}/>,true,{bodyStyle:{paddingTop:32,paddingBottom:0},cardStyle:{maxHeight:555}});
  if((state.screen==="profile"||state.screen==="profileSettings")&&profileEditing)return page(<CommunityProfileEditor displayName={draft("profile:name")||"Nina"} city={draft("profile:city")||"Savannah, GA, 31401"} about={state.drafts["profile:about"]??c("“我知道托育附近一家不错的小餐馆。”","“I know a nice little restaurant near daycare.”")} onAboutChange={text=>setDraft("profile:about",text)} selectedIntents={state.intents} onToggleIntent={index=>dispatch({type:"intent",index})} avatar={<SampleAvatar size={104}/>}/>,<FinalButton label={c("保存","Save")} onPress={()=>setProfileEditingMode(false)} testID="final-profile-save"/>,false,{bodyStyle:{padding:0,gap:0},showReceipt:false});
  if(state.screen==="profileSettings")return page(<>
    <View style={{height:40,flexDirection:"row",alignItems:"center"}}><FinalText size={12} secondary style={{flex:1,lineHeight:18,fontWeight:"500"}}>{c("我的档案","My profile")}</FinalText><Pressable accessibilityRole="button" testID="final-profile-edit" style={{width:72,height:40,alignItems:"flex-end",justifyContent:"center"}} onPress={()=>setProfileEditingMode(true)}><FinalText size={12} secondary style={{fontWeight:"500",lineHeight:16}}>{c("编辑","Edit")}</FinalText></Pressable></View>
    <View style={{flexDirection:"row",alignItems:"flex-start",gap:20}}><SampleAvatar size={104}/><View style={{flex:1,minWidth:0,gap:4}}><FinalText size={36} style={{lineHeight:46,fontWeight:"700"}}>{draft("profile:name")||"Nina"}</FinalText><FinalText size={14} secondary style={{lineHeight:18,fontWeight:"500"}}>{draft("profile:city")||"Savannah, GA, 31401"}</FinalText><FinalText size={12} secondary style={{lineHeight:18,fontWeight:"500"}}>{c("喜欢“咖啡”，“阅读”，“园艺”","Enjoys coffee, reading and gardening")}</FinalText></View></View>
    <View style={s.quietDivider}/>
    <FinalText size={18} style={{lineHeight:26,fontWeight:"500"}}>{c("我的生活","My life")}</FinalText>
    <View testID="final-profile-settings-context" style={{flexDirection:"row",alignItems:"flex-start",gap:16}}><View testID="final-profile-settings-children" style={{width:"51.2121%",maxWidth:169,minWidth:0,gap:4}}><FinalText style={{fontWeight:"500"}}>{c("我的小孩","My children")}</FinalText><FinalText size={12} secondary style={{lineHeight:18}}>{c("正在经历学龄前阶段","At the preschool stage")}</FinalText></View><View style={{flex:1,minWidth:0,gap:4}}><FinalText style={{fontWeight:"500"}}>{c("生活节奏","Daily rhythm")}</FinalText><FinalText size={12} secondary style={{lineHeight:18}}>{c("喜欢安静的周末活动","Relaxed weekend activities")}</FinalText></View></View>
    <View style={s.quietDivider}/>
    <View style={{gap:4}}><FinalText style={{fontWeight:"500",lineHeight:24}}>{c("关于我","About me")}</FinalText><FinalText size={18} style={{lineHeight:26}}>{state.drafts["profile:about"]??c("“我知道托育附近一家不错的小餐馆。”","“I know a nice little restaurant near daycare.”")}</FinalText></View>
    <FinalText style={{fontWeight:"500",lineHeight:24}}>{c("希望和新朋友一起","With new friends, I'd like to…")}</FinalText>
    <View testID="final-profile-settings-intents" style={{flexDirection:"row",flexWrap:"wrap",gap:8}}>{state.intents.map(index=><View key={index} style={{minWidth:123.333,maxWidth:"100%",minHeight:36,borderRadius:18,paddingHorizontal:8,backgroundColor:FINAL_COLOR.selected,alignItems:"center",justifyContent:"center"}}><FinalText style={{lineHeight:24,color:"white"}}>{c(["交流育儿智慧","聊聊育儿心事","与我经历相似","和我一起遛娃","在我附近","随便聊聊"][index],["Share parenting ideas","Talk about parenting","Similar experiences","Outings with children","Nearby parents","Have a chat"][index])}</FinalText></View>)}</View>
  </>,<FinalButton label={c("保存","Save")} onPress={()=>dispatch({type:"back"})} testID="final-profile-settings-save"/>,false,{bodyStyle:{paddingTop:32,paddingBottom:22},showReceipt:false});
  if (state.screen === "profile" || state.screen === "parent" || state.screen === "incomingParent") return page(<>
    {state.screen==="profile"?<View style={{height:40,flexDirection:"row",alignItems:"center"}}><FinalText size={12} secondary style={{flex:1,lineHeight:18,fontWeight:"500"}}>{c("我的档案","My profile")}</FinalText><Pressable accessibilityRole="button" style={{width:72,minHeight:40,justifyContent:"center",alignItems:"flex-end"}} onPress={()=>setProfileEditingMode(true)} testID="final-profile-edit"><FinalText size={12} secondary style={{lineHeight:16,fontWeight:"500"}}>{c("编辑","Edit")}</FinalText></Pressable></View>:null}
    <View style={{flexDirection:"row",alignItems:"flex-start",gap:20}}>
      <SampleAvatar size={104}/>
      <View style={{flex:1,minWidth:0,gap:4}}><FinalText size={36} style={{lineHeight:46,fontWeight:"700"}}>{state.screen==="profile"?draft("profile:name")||"Nina":state.person}</FinalText>
        <FinalText size={14} secondary style={{lineHeight:18,fontWeight:"500"}}>{state.screen==="profile"?draft("profile:city")||"Savannah, GA, 31401":c("约 1.5 英里","About 1.5 miles")}</FinalText>
        <FinalText size={12} secondary style={{lineHeight:18,fontWeight:"500"}}>{state.screen==="profile"?c("喜欢“咖啡”，“阅读”，“园艺”","Enjoys coffee, reading and gardening"):c("喜欢散步、绘本和亲子活动","Walks, picture books and family activities")}</FinalText>
      </View>
    </View>
    <View style={s.quietDivider}/>
    <FinalText size={18} style={{lineHeight:26,fontWeight:"500"}}>{state.screen==="profile"?c("我的生活","My life"):c("你们的共同点","What you have in common")}</FinalText>
    <View style={{flexDirection:"row",alignItems:"flex-start",gap:16}}>
      <View style={{flex:1,minWidth:0,gap:4}}><FinalText style={{fontWeight:"500"}}>{state.screen==="profile"?c("我的小孩","My children"):c("孩子年龄相近","Children of similar ages")}</FinalText><FinalText size={12} secondary style={{lineHeight:18}}>{state.screen==="profile"?c("正在经历学龄前阶段","At the preschool stage"):c("都在经历学龄前阶段","Both at the preschool stage")}</FinalText></View>
      <View style={{flex:1,minWidth:0,gap:4}}><FinalText style={{fontWeight:"500"}}>{state.screen==="profile"?c("生活节奏","Daily rhythm"):c("周末节奏相似","Similar weekends")}</FinalText><FinalText size={12} secondary style={{lineHeight:18}}>{c("喜欢安静的周末活动","Relaxed weekend activities")}</FinalText></View>
    </View>
    <View style={s.quietDivider}/>
    <FinalText style={{fontWeight:"500"}}>{state.screen==="profile"?c("关于我","About me"):c("关于对方","About this parent")}</FinalText>
    <FinalText size={18} style={{lineHeight:26}}>{state.screen==="profile"?(state.drafts["profile:about"]??c("“我知道托育附近一家不错的小餐馆。”","“I know a nice little restaurant near daycare.”")):c("希望认识附近的家长，周末可以一起带孩子散步。","I'd like to meet nearby parents for weekend walks with our children.")}</FinalText>
    {state.screen!=="profile"?<>
      <FinalButton disabled={state.blocked.includes(state.person)} label={c("建立联系","Connect")} onPress={()=>dispatch({type:"connect"})}/>
      <FinalButton secondary label={state.screen==="incomingParent"?c("拒绝","Decline"):c("稍后再说","Maybe later")} onPress={()=>dispatch({type:state.screen==="incomingParent"?"declineInvitation":"back"})}/>
    </>:null}
  </>,state.screen==="profile"?<FinalButton label={c("下一步","Next")} onPress={()=>go("suggestions")}/>:undefined,false,{bodyStyle:{paddingVertical:32}});
  if(state.screen==="suggestions"){
    const distances=[1,2,1.5,.8,2.5,1.2,1.8,2.2];
    const intros=[c("孩子同龄，周末合拍","Similar child ages and weekends"),c("孩子同龄，周末合拍","Similar child ages and weekends"),c("孩子同龄，都爱户外","Similar child ages, outdoor interests"),c("住得近，接送时间相似","Nearby, with similar pickup times"),c("都在经历托育适应期","Both navigating daycare adjustment"),c("周末相似，喜欢慢生活","Similar, relaxed weekends"),c("喜欢亲子阅读","Enjoy family reading"),c("喜欢一起户外活动","Enjoy family outdoor activities")];
    const interests=[c("你们都喜欢 / 咖啡、徒步","Shared interests / Coffee, hiking"),c("都从事创意工作 · 设计、阅读","Creative work · Design, reading"),c("共同兴趣 · 散步、绘本","Shared interests · Walks, books"),c("共同兴趣 · 咖啡、亲子活动","Shared interests · Coffee, family time"),c("共同兴趣 · 徒步、自然探索","Shared interests · Hiking, nature"),c("共同兴趣 · 阅读、园艺","Shared interests · Reading, gardening"),c("共同兴趣 · 绘本、散步","Shared interests · Books, walks"),c("共同兴趣 · 徒步、阅读","Shared interests · Hiking, reading")];
    return <NuriKeyboardFrame><DemoLabel en={en}/><View style={{flex:1,minHeight:0,paddingHorizontal:12,paddingTop:16,paddingBottom:40,gap:18}}>
      <View style={{height:32,flexDirection:"row",alignItems:"center",gap:8,paddingHorizontal:12,zIndex:5}}>
        {(["gender","distance"] as const).map(key=><Pressable key={key} accessibilityRole="button" accessibilityLabel={key==="gender"?c("性别筛选","Filter gender"):c("距离筛选","Filter distance")} accessibilityState={{expanded:filter===key}} onPress={()=>setFilter(filter===key?null:key)} style={{width:144,maxWidth:"48%",height:32,borderRadius:18,paddingHorizontal:12,flexDirection:"row",alignItems:"center",gap:8,backgroundColor:"rgba(255,255,255,.5)"}}><FinalText size={12} secondary style={{lineHeight:18,flex:1}}>{key==="gender"?c("性别","Gender"):c("距离","Distance")}  {filterLabels[key][state.filters[key]]}</FinalText><FinalText size={14} secondary style={{lineHeight:20}}>{filter===key?"⌃":"⌄"}</FinalText></Pressable>)}
        {filter?<FinalSurface radius={20} style={{position:"absolute",left:filter==="gender"?12:164,top:40,width:144,zIndex:10,boxShadow:"0px 2px 12px rgba(89,71,92,.12)"}} contentStyle={{paddingVertical:4}}>{filterLabels[filter].map((label,index)=><Pressable key={label} accessibilityRole="radio" accessibilityState={{selected:state.filters[filter]===index,checked:state.filters[filter]===index}} aria-checked={state.filters[filter]===index} onPress={()=>{dispatch({type:"filter",key:filter,index});setFilter(null);}} style={{minHeight:44,paddingHorizontal:16,justifyContent:"center"}}><FinalText size={14} style={{lineHeight:20}}>{label}</FinalText></Pressable>)}</FinalSurface>:null}
      </View>
      <FinalSurface fill testID="final-community-suggestions"><ScrollView style={{flex:1,minHeight:0}} contentContainerStyle={{padding:12,gap:12}} showsVerticalScrollIndicator={false}>
        {suggestions.map(p=>{const index=PARENT_FIXTURES.indexOf(p);return <Pressable key={p} accessibilityRole="button" onPress={()=>dispatch({type:"person",person:p,screen:"parent"})} testID={"final-suggestion-"+p}><FinalSurface radius={20} surfaceColor="rgba(255,255,255,.2)" style={{boxShadow:"0px 2px 8px rgba(92,86,98,.1)"}} contentStyle={{padding:12,flexDirection:"row",gap:16,alignItems:"center"}}>
          <View style={{width:112,height:112,borderRadius:16,overflow:"hidden",backgroundColor:"rgba(235,129,131,.18)",flexShrink:0}}><Image source={require("@/assets/final-flow-20261101/community-suggestion-head.png")} style={{position:"absolute",left:11.2,top:34.93,width:88.667,height:77.467}} contentFit="fill" accessible={false}/></View>
          <View style={{flex:1,minWidth:0,gap:8}}><View style={{flexDirection:"row",alignItems:"center",gap:8,justifyContent:"space-between"}}><FinalText size={18} style={{lineHeight:26,fontWeight:"500",flexShrink:1}}>{p}</FinalText><FinalText size={12} secondary style={{lineHeight:18,textAlign:"right",flexShrink:1}}>{c("约 "+distances[index]+" 英里","About "+distances[index]+" miles")}</FinalText></View><FinalText>{intros[index]}</FinalText><FinalText size={12} secondary style={{lineHeight:18}}>{interests[index]}</FinalText></View>
        </FinalSurface></Pressable>;})}
        {!suggestions.length?<FinalText secondary>{c("暂时没有合适的家长","No matching parents yet")}</FinalText>:null}
        <FinalButton secondary label={c("查看无匹配状态","Preview no-match state")} onPress={()=>go("noMatches")}/>
      </ScrollView></FinalSurface>
    </View></NuriKeyboardFrame>;
  }
  const chatSlot = `chat:${state.person}`;
  return <NuriKeyboardFrame><ParentChatHeader person={state.person} participating={!!state.ai[state.person]} status={state.ai[state.person] ? c("Nuri 参与中", "Nuri is on") : c("Nuri 未参与", "Nuri is off")} backLabel={c("返回", "Back")} toggleHint={c("仅在此设备模拟；开启前需要双方同意，不会启动真实记录。", "Local preview only. Both parents must agree; no real recording starts.")} onBack={()=>{
      if(state.history.length)dispatch({type:"back"});else router.dismissTo("/(tabs)");
    }} onToggle={value => dispatch({
        type: value ? "requestConsent" : "disableAI"
      })}/><ScrollView ref={messages} onContentSizeChange={() => messages.current?.scrollToEnd({
      animated: false
    })} onLayout={() => messages.current?.scrollToEnd({
      animated: false
    })} keyboardShouldPersistTaps="handled" style={{
      flex: 1,
      minHeight: 0
    }} contentContainerStyle={{
      padding: 24,
      gap: 20
    }} testID="final-parent-chat-scroll">{[c("刚才我们聊到宝宝的睡眠。最近有什么新的变化吗？", "We were talking about your child's sleep. Has anything changed?"), c("最近哄睡要一个多小时，放下后也容易醒。", "Settling takes over an hour, and they wake after being put down."), c("听起来，这几晚你也很辛苦。可以说说昨晚是怎么哄睡的吗？", "That sounds exhausting. What was settling like last night?"), c("昨晚八点开始哄，快九点才睡着。", "We started settling at eight last night. It was nearly nine when they fell asleep."), c("谢谢你的建议，我想再试试看。", "Thanks for your advice. I'd like to try again.")].map((text, i) => <View key={i} testID={`final-parent-message-${i}`} style={{
        flexDirection: i % 2 ? "row-reverse" : "row",
        gap: 8,
        alignItems: i % 2 ? "flex-end" : "flex-start"
      }}><ParentChatAvatar/><FinalChatBubble incoming={i%2===0} style={{flex:1,maxWidth:i%2?258:306,boxShadow:i%2?"0px 0px 8px rgba(0,0,0,.1)":"0px 0px 4px rgba(0,0,0,.1)"}}><FinalText>{text}</FinalText></FinalChatBubble></View>)}{state.messages.filter(m => m.person === state.person).map((m, i) => <View key={i} style={{flexDirection:"row-reverse",alignItems:"flex-end",gap:8}}><ParentChatAvatar/><FinalChatBubble incoming={false} style={{flex:1,maxWidth:258}}><FinalText>{m.text}</FinalText></FinalChatBubble></View>)}{receipt}</ScrollView><View testID="final-parent-composer-dock" style={{
      padding: 24,
      paddingTop: 8,
      paddingBottom: dockBottom,
      gap: 8
    }}>{attachment ? <FinalSurface contentStyle={{
        padding: 16,
        gap: 12
      }}><FinalText size={12} secondary>{c("示例附件 · 不读取相册、不上传", "Sample attachment · No photo access or upload")}</FinalText><FinalButton secondary label={c("移除附件", "Remove attachment")} onPress={() => setAttachment(false)} /></FinalSurface> : null}{voice ? localVoice(chatSlot) : <NuriComposer disabled={state.blocked.includes(state.person)||state.disconnected.includes(state.person)} value={draft(chatSlot)} onChangeText={text => setDraft(chatSlot, text)} onSend={() => dispatch({
        type: "sendMessage"
      })} onAttach={() => setAttachment(true)} onMic={() => setVoice(true)} placeholder={c("聊聊最近的活动吧…", "Talk about recent activities…")} testID="final-parent" />}</View>{state.screen === "consent" ? <Modal transparent animationType="fade" onRequestClose={() => dispatch({
      type: "confirmConsent",
      allowed: false
    })}><BlurView intensity={35} tint="light" style={s.modal}><FinalSurface contentStyle={{
          padding: 24,
          gap: 16
        }}><FinalText size={20}>{c("允许Nurry记录本次对话？", "Allow Nurry to record this conversation?")}</FinalText><FinalText size={14} secondary>{c("对方邀请Nurry记录这次对话。同意后，Nurry会记录聊天内容，并整理对话要点。双方都可以随时关闭记录。", "The other parent invited Nurry to record this conversation and organise its key points. Either person can turn it off at any time.")}</FinalText><FinalText size={12} secondary>{c("仅在此设备模拟，不保存真实同意，也不启动真实记录。", "Simulated on this device only. No real consent is saved and no real recording starts.")}</FinalText><View style={s.actionRow}><FinalButton small secondary label={c("暂不同意", "Not now")} onPress={() => dispatch({
              type: "confirmConsent",
              allowed: false
            })} /><FinalButton small label={c("同意开启", "Allow")} onPress={() => dispatch({
              type: "confirmConsent",
              allowed: true
            })} testID="final-parent-consent-agree" /></View></FinalSurface></BlurView></Modal> : null}</NuriKeyboardFrame>;
}
const s = StyleSheet.create({
  main: {
    flex: 1,
    minHeight: 0,
    paddingHorizontal: 12,
    paddingTop: 16,
    paddingBottom: 32,
    gap: 16
  },
  body: {
    padding: 24,
    gap: 16
  },
  actions: {
    marginTop: "auto",
    paddingTop: 16,
    paddingBottom: 8,
    gap: 12
  },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 12
  },
  personRow: {
    minHeight: 72,
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    paddingVertical: 8
  },
  friendPreviewRow: {minHeight:72,flexDirection:"row",alignItems:"center",gap:16,padding:8},
  friendDivider: {height:1,backgroundColor:"rgba(255,255,255,.65)",alignSelf:"stretch"},
  quietDivider: {height:1,backgroundColor:"rgba(77,64,92,.22)",alignSelf:"stretch"},
  questionEntry: {minHeight:80,paddingRight:24,paddingBottom:8,gap:4,justifyContent:"center"},
  questionTitle: {minHeight:24,flexDirection:"row",alignItems:"center",gap:12},
  questionChevron: {position:"absolute",right:0,top:0,bottom:0,width:16,alignItems:"center",justifyContent:"center"},
  dots: {
    height: HUB_PAGINATION.targetHeight,
    marginTop:HUB_PAGINATION.height-HUB_PAGINATION.targetHeight,
    width:HUB_PAGINATION.targetSize*2,
    alignSelf:"center",
    justifyContent: "flex-end",
    alignItems: "center"
  },
  dotTarget: {
    position:"absolute",
    width:HUB_PAGINATION.targetSize,
    height:HUB_PAGINATION.targetHeight,
    top:0
  },
  editor: {
    height: 144,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#DDD2DE",
    padding: 16,
    paddingTop: 16,
    fontSize: 16,
    lineHeight: 24,
    color: FINAL_COLOR.ink,
    backgroundColor: "rgba(255,250,244,.6)",
    textAlignVertical: "top"
  },
  textTarget: {
    minWidth: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center"
  },
  segment: {
    flexDirection: "row",
    borderRadius: 24,
    padding: 4,
    backgroundColor: "rgba(255,255,255,.7)"
  },
  modal: {
    flex: 1,
    justifyContent: "center",
    padding: 24,
    backgroundColor: "rgba(255,250,244,.15)"
  }
});
