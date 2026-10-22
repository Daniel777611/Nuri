import { useCallback, useReducer, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";
import { useFocusEffect, usePathname, useRouter } from "expo-router";
import { useT, translate } from "@/src/i18n";
import { registerNativeNavigationGuard } from "@/src/components/nativeNavigation";
import { ChoiceChip, GlassSurface, IconAction, MenuRow, NuriButton, NuriField, NuriKeyboardFrame, NuriText, ToggleRow } from "@/src/uiux48/Primitives";
import { NuriComposer } from "@/src/uiux48/Composer";
import { FLOW_SCREENS, type FlowBlock, type FlowCopy } from "./screens";
import { canChat49, createFlow49, draftSlot49, flowReducer49, type FlowEvent49 } from "./model";
import { FLOW_TW49 } from "./traditional";
import CommunityRedesign from "./CommunityRedesign";
import { useAccountScope } from "@/src/useAccountState";

export const FLOW_PREVIEW_ENABLED = true;
/** TestFlight-only local prototype. The Metro alias excludes this whole graph
 * from ordinary release builds. Real features keep their existing adapters. */
export default function FlowPreview({entry}:{entry:"community"|"notifications"}) {
  // A session boundary remounts all ephemeral sample drafts immediately;
  // private text must not reappear when another tester account signs in.
  const { generation } = useAccountScope();
  return entry === "community" ? <CommunityRedesign key={generation} /> : <LegacyFlowPreview key={generation} entry={entry} />;
}
/** Kept for the notification prototype and regression of the previous pure
 * presentation model; Community's real entry uses the new design above. */
export function LegacyFlowPreview({entry}:{entry:"community"|"notifications"}) {
  const [state,dispatch]=useReducer(flowReducer49,entry,createFlow49);
  const [showStates,setShowStates]=useState(false);
  const latest=useRef(state);latest.current=state;
  const scroll=useRef<ScrollView>(null);
  const {locale}=useT();const router=useRouter();const path=usePathname();
  const text=(cn:string,en:string)=>locale==="en"?en:locale==="zh-TW"?FLOW_TW49[cn]??translate(locale,cn):cn;
  const copy=(p:FlowCopy)=>text(p[0],p[1]);
  const design=FLOW_SCREENS.find(s=>s.key===state.screen);
  const forPerson=(s:string)=>/^(community|match)/.test(state.screen)?s.replaceAll("Maya",state.context.person):s;
  const title=state.screen==="bottleRefine"&&state.context.role==="responder"?text("整理你的回答","Refine your answer"):state.screen==="matchPending"?text("等待双方同意","Waiting for both parents"):state.screen.startsWith("communityVoice")?text("语音预览","Voice preview"):state.screen.startsWith("communityImage")||state.screen==="communityAttachment"||state.screen==="communityCameraPermission"?text("图片预览","Image preview"):design?forPerson(copy(design.title)):text("内容预览","Content preview");
  useFocusEffect(useCallback(()=>{
    router.setParams({flowTitle:title});
    return registerNativeNavigationGuard(path,action=>{
      const current=latest.current;
      if(action==="back"&&current.history.length){dispatch({type:"back"});return;}
      if(action==="back"){if(router.canGoBack())router.back();else router.dismissTo("/(tabs)");return;}
      const targets={home:"/(tabs)",chat:"/(tabs)/chats",notifications:"/notifications",community:"/community",profile:"/(tabs)/profile"} as const;
      router.navigate(targets[action]);
    });
  },[path,router,title]));
  const go=(screen:string)=>dispatch({type:"go",screen});
  const slot=draftSlot49(state);
  const messageSlot=draftSlot49(state,"communityChat");
  const draft=state.drafts[messageSlot]??"";
  const voice=()=>dispatch({type:"voice",slot:state.screen.startsWith("bottle")?slot:messageSlot});
  const attach=()=>dispatch({type:"attach",slot:messageSlot});
  const button=(cn:string,en:string,event:FlowEvent49,secondary=false,disabled=false)=><NuriButton key={cn} label={text(cn,en)} testID={`flow-action-${event.type}`} onPress={()=>dispatch(event)} secondary={secondary} disabled={disabled} />;
  const receipt=state.receipt?<NuriText role="Caption" secondary testID="flow-local-receipt">{text("仅在此原型中完成，没有发送到服务器。","Completed only in this prototype. Nothing was sent to the server.")}</NuriText>:null;
  const badge=<View style={s.badge}><View style={{flex:1}}><NuriText role="Caption" testID="flow-preview-label">{text("流程预览 · 演示数据，不发送到服务器","FLOW PREVIEW · Sample data. Not sent to a server.")}</NuriText></View><IconAction name="settings" label={text("切换演示状态","Choose a sample state")} onPress={()=>setShowStates(v=>!v)} testID="flow-state-picker" /></View>;
  const statePicker=showStates?<View style={s.statePicker}>{(["design","empty","loading","error","permission"] as const).map((value,i)=><ChoiceChip key={value} label={text(["正常","空状态","加载","失败","权限"][i],["Design","Empty","Loading","Error","Permission"][i])} selected={state.variant===value} onPress={()=>{dispatch({type:"variant",value});setShowStates(false);}} testID={`flow-variant-${value}`} />)}</View>:null;
  function frame(body:ReactNode,actions?:ReactNode,heading?:ReactNode) { return <NuriKeyboardFrame>{badge}{statePicker}<View style={[s.region,heading?{gap:20}:null]}>{heading?<View style={{width:"100%",maxWidth:500,alignSelf:"center"}}>{heading}</View>:null}<GlassSurface kind="message" style={s.card} contentStyle={s.cardInside} testID={`flow-card-${state.screen}`}><ScrollView key={state.screen+state.variant} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={s.body} style={{flexShrink:1}} testID="flow-card-scroll">{receipt}{body}</ScrollView>{actions?<View style={s.actions}>{actions}</View>:null}</GlassSurface></View></NuriKeyboardFrame>; }
  if(state.variant!=="design") {
    const labels={empty:["这里还没有内容","Nothing here yet"],loading:["正在加载的演示状态","Sample loading state"],error:["暂时无法加载，请稍后重试","Unable to load. Try again later."],permission:["尚未允许访问","Access has not been allowed"]} as const;
    return frame(<>{state.variant==="loading"?<ActivityIndicator />:null}<NuriText role="H2">{copy(labels[state.variant])}</NuriText><NuriText>{text("这是界面状态预览，不会请求权限或调用服务。","This is a UI-state preview. It does not request permission or call a service.")}</NuriText></>,button("返回流程","Back to flow",{type:"variant",value:"design"}));
  }
  if(state.screen==="community") return frame(<><View>{[
    ["向有相似经历的家长提问","Ask parents with similar experiences","发一个漂流瓶，听听其他家长的经验。","Send a bottle and hear other parents' experiences.",{type:"bottle",role:"questioner"}],
    ["认识聊得来的家长","Meet parents you connect with","认识附近、兴趣相投的家长。","Meet nearby parents with shared interests.",{type:"go",screen:"matchIntent"}],
    ["聊天与漂流瓶","Chats & bottles","2 位家长回复了你的漂流瓶","Two sample replies to your bottle",{type:"go",screen:"communityInbox"}],
  ].map(([cn,en,detailCN,detailEN,event],i)=><MenuRow key={i} density="community" separator={i!==2} label={text(String(cn),String(en))} detail={text(String(detailCN),String(detailEN))} onPress={()=>dispatch(event as FlowEvent49)} testID={`flow-hub-${i}`} />)}</View></>,undefined,<NuriText role="H2">{text("今天，你需要什么？","What do you need today?")}</NuriText>);
  if(state.screen==="matchPending") return frame(<><NuriText role="H2">{text("等待双方同意","Waiting for both parents")}</NuriText><NuriText>{text("这里只演示匹配流程，没有向真实家长发送请求。","This previews matching only. No request was sent to a real parent.")}</NuriText></>,<>{button("模拟双方同意","Simulate mutual agreement",{type:"simulateMutual"})}{button("返回推荐","Back to suggestions",{type:"go",screen:"matchDiscovery"},true)}</>);
if(state.screen==="bottleRefine") return frame(<><NuriText role="H2">{text(state.context.role==="responder"?"你的原始回答":"你的原始问题",state.context.role==="responder"?"Your original answer":"Your original question")}</NuriText><NuriText testID="flow-refine-original">{state.drafts[slot]??""}</NuriText><NuriText>{text("整理预览（不调用 AI）","Refinement preview (no AI request)")}</NuriText><NuriField multiline label={text("可编辑的版本","Editable version")} value={state.drafts[`refine:${slot}`]??""} onChangeText={value=>dispatch({type:"draft",slot:`refine:${slot}`,text:value})} style={s.multiline} testID="flow-refine-draft" /><NuriText secondary>{text("演示保留你的原文，不声称已完成隐私处理。","This demo preserves your text; it does not claim to have removed private information.")}</NuriText><MenuRow label={text("继续编辑","Keep editing")} onPress={()=>dispatch({type:"editOriginal"})} testID="flow-refine-edit" /><MenuRow label={text("保留原文","Keep original")} onPress={()=>dispatch({type:"finishRefine",useEdited:false})} testID="flow-refine-keep-original" /></>,button(state.context.role==="responder"?"发送回应":"使用这个版本",state.context.role==="responder"?"Send response":"Use this version",{type:"finishRefine",useEdited:true},false,!state.drafts[`refine:${slot}`]?.trim()));
  if(state.screen==="communityVoice"||state.screen==="communityVoiceReview") return frame(<><NuriText role="H2">{text("语音与文字确认","Voice and text review")}</NuriText><NuriText>{text("本流程只演示界面，不启用麦克风、不录音、不上传音频。","This flow previews the UI only. It does not enable the microphone, record or upload audio.")}</NuriText><NuriField label={text("演示识别文本，可修改","Sample transcript — editable")} multiline style={s.multiline} value={state.voiceText} onChangeText={value=>dispatch({type:"voiceText",text:value})} testID="flow-voice-text" /><NuriButton secondary label={text("使用示例文本","Use sample text")} onPress={()=>dispatch({type:"voiceText",text:text("固定、简短的告别仪式帮助了我们。","A short, consistent goodbye ritual helped us.")})} /></>,<>{state.screen==="communityVoice"?button("查看确认界面","Review text",{type:"voiceReview"}):button("加入原草稿","Add to original draft",{type:"applyVoice"},false,!state.voiceText.trim())}{button("取消并返回原页面","Cancel and return",{type:"cancelVoice"},true)}</>);
  if(state.screen==="communityAttachment"||state.screen==="communityCameraPermission"||state.screen==="communityImageReview") return frame(<><NuriText role="H2">{text("添加图片","Add an image")}</NuriText><NuriText>{text("这里只预览图片流程，不请求相机或相册权限，也不读取你的照片。","This previews the image flow only. It requests no camera or photo access and reads no photos.")}</NuriText>{state.screen==="communityAttachment"?<><MenuRow label={text("拍照","Camera")} onPress={()=>go("communityCameraPermission")} testID="flow-camera" /><MenuRow label={text("从相册选择","Choose a photo")} onPress={()=>go("communityImageReview")} testID="flow-photo" /></>:state.screen==="communityCameraPermission"?<NuriText>{text("相机权限提示的演示状态。","Sample camera-permission explanation.")}</NuriText>:<GlassSurface shadow={false} contentStyle={{height:140,alignItems:"center",justifyContent:"center"}}><NuriText>{text("示例图片占位 · 非真实照片","Sample image placeholder · Not a real photo")}</NuriText></GlassSurface>}</>,<>{state.screen==="communityCameraPermission"?button("预览拍照确认","Preview camera review",{type:"go",screen:"communityImageReview"}):state.screen==="communityImageReview"?button("加入原草稿","Add to original draft",{type:"applyAttachment"}):null}{button("取消并返回原页面","Cancel and return",{type:"cancelAttachment"},true)}</>);
  const chat=state.screen==="communityChat"||state.screen==="communityNewChat"||state.screen==="communityTyping";
  if(chat) return <NuriKeyboardFrame>{badge}{statePicker}<ScrollView ref={scroll} key={state.screen} keyboardShouldPersistTaps="handled" style={{flex:1,minHeight:0}} contentContainerStyle={s.chatStack} showsVerticalScrollIndicator={false} onContentSizeChange={()=>{if(state.messages.length)scroll.current?.scrollToEnd({animated:false});}} testID="flow-chat-scroll">
    {receipt?<GlassSurface kind="message" contentStyle={{padding:20}}>{receipt}</GlassSurface>:null}
    {state.screen==="communityNewChat"?design?.blocks.slice(0,2).map((b,i)=><GlassSurface key={i} kind="message" contentStyle={{padding:20}}><NuriText>{forPerson(copy(b.copy[0]))}</NuriText></GlassSurface>):state.screen==="communityChat"?[[0],[1,2],[3,4],[5,6]].map((indices,i)=><GlassSurface key={i} kind={i===2?"user":"message"} contentStyle={{padding:20}}><NuriText>{indices.map(index=>forPerson(copy(design!.blocks[index].copy[0]))).join("\n")}</NuriText></GlassSurface>):null}
    {state.screen==="communityNewChat"?<GlassSurface kind="message" contentStyle={{paddingHorizontal:20}}>{design?.blocks.filter(b=>b.kind==="icebreaker").map((b,i)=><MenuRow key={i} label={copy(b.copy[0])} onPress={()=>dispatch({type:"icebreaker",text:copy(b.copy[0])})} testID={`flow-icebreaker-${i}`} />)}</GlassSurface>:null}
    {state.screen==="communityNewChat"?<GlassSurface kind="message" contentStyle={{padding:20}}><NuriText>{copy(design!.blocks[5].copy[0])}</NuriText></GlassSurface>:null}
    {state.messages.filter(m=>m.conversationId===state.context.conversationId).map((m,i)=><GlassSurface key={i} kind="user" contentStyle={{padding:20}}><NuriText testID={`flow-local-message-${i}`}>{m.text}</NuriText>{m.attachment?<NuriText role="Caption">{text("示例图片占位 · 非真实照片","Sample image placeholder · Not a real photo")}</NuriText>:null}</GlassSurface>)}
    {state.screen!=="communityNewChat"?<GlassSurface kind="message" contentStyle={{paddingHorizontal:20}}><MenuRow label={text("稍后见个面","Meet sometime")} onPress={()=>go("communityMeeting")} /><MenuRow label={text("翻译辅助","Translation help")} onPress={()=>go("communityTranslation")} /><MenuRow label={text("对话设置","Conversation settings")} onPress={()=>go("communitySafety")} /></GlassSurface>:null}
  </ScrollView><View style={s.composer}>{state.attachment&&state.attachmentSlot===messageSlot?<MenuRow label={text("已选示例图片 · 点击移除","Sample attachment · Remove")} onPress={()=>dispatch({type:"removeAttachment"})} />:null}<NuriComposer testID="flow-chat" value={draft} onChangeText={value=>dispatch({type:"draft",slot:messageSlot,text:value})} onSend={()=>dispatch({type:"send"})} onAttach={attach} onMic={voice} hasAttachment={state.attachment&&state.attachmentSlot===messageSlot} disabled={!canChat49(state)} placeholder={text("写一条消息…","Write a message…")} /></View></NuriKeyboardFrame>;
  function action(b:FlowBlock,index:number) {
    if(state.screen==="bottleCompose")return dispatch({type:"refine"});
    if(state.screen==="bottleRespond"&&b.target==="communityVoice")return voice();
    if(state.screen==="bottleRespond"&&b.target==="bottleRefine")return dispatch({type:"refine"});
    if(state.screen==="bottleRespond"&&b.kind==="action"&&b.target==="communityInbox")return dispatch({type:"replyBottle"});
    if(state.screen==="bottleReplies"&&b.target==="bottleCompose")return dispatch({type:"followup"});
    if(state.screen==="bottleClose"&&b.target==="community")return dispatch({type:"closeBottle"});
    if(state.screen==="matchDetail"&&b.target==="matchConnected")return dispatch({type:"requestMatch"});
    if(state.screen==="communityInbox") {
      if(b.target==="bottleReplies")return dispatch({type:"ownReplies"});
      if(b.target==="bottleRespond")return dispatch({type:"bottle",role:"responder"});
      if(b.target==="communityChat"||b.target==="communityNewChat")return dispatch({type:"person",name:b.copy[0][1],source:"inbox"});
      if(b.target==="matchDetail")return dispatch({type:"person",name:b.copy[0][1],source:"discovery"});
    }
    if(state.screen==="matchDiscovery")return dispatch({type:"person",name:b.copy[0][1],source:"discovery"});
    if(state.screen==="communityReport"&&b.target==="communityReported")return dispatch({type:"confirmSafety",action:"report"});
    if(state.screen==="communityBlock"&&index===1)return dispatch({type:"confirmSafety",action:"block"});
    if(state.screen==="communityDisconnect"&&index===1)return dispatch({type:"confirmSafety",action:"disconnect"});
    if(state.screen==="communityUnblock"&&index===1)return dispatch({type:"confirmSafety",action:"unblock"});
    if(state.screen==="communityMeeting"&&index===3)return dispatch({type:"icebreaker",text:copy(design!.blocks[1].copy[0])});
    if(state.screen==="communityTranslation"&&b.target==="communityVoice")return voice();
    if(state.screen==="communityTranslation"&&b.target==="communityTyping")return dispatch({type:"icebreaker",text:state.drafts[messageSlot]??""});
    if(b.target==="socialDetail")return go("prototypeSocial");
    if(b.target==="videoDetail")return go("prototypeVideo");
    if(b.target==="notificationSettings")return router.push("/notification-settings");
    if(b.target==="home")return router.navigate("/(tabs)");
    if(b.target==="chat")return router.navigate("/(tabs)/chats");
    if(b.target)go(b.target);
  }
  function renderBlock(b:FlowBlock,index:number) {
    const id=`${state.screen}:${index}`;
    const groups:Record<string,number[][]>={bottleReplies:[[1,2],[4,5]],bottleWaiting:[[2,3,4]],matchDetail:[[0,1],[3,4,5],[7,8]],communityTranslation:[[0,1]]};
    const group=groups[state.screen]?.find(indices=>indices.includes(index));
    if(group&&index!==group[0])return null;
    if(group) {
      const content=group.map(i=>state.screen==="bottleWaiting"&&i===4?text(state.identity==="anonymous"?"显示为：匿名":"显示为：仅名字",state.identity==="anonymous"?"Shown as: Anonymous":"Shown as: First name only"):forPerson(copy(design!.blocks[i].copy[0]))).join("\n");
      return <NuriText key={id} role={state.screen==="matchDetail"&&index===0?"H2":"Body"}>{content}</NuriText>;
    }
    if(b.kind==="action")return null;
    if(b.kind==="field") {
      const fieldSlot=draftSlot49(state,state.screen,index);
      return <NuriField key={id} label={copy(b.copy[0])} placeholder={copy(b.copy[1]??["",""])} multiline style={s.multiline} value={state.drafts[fieldSlot]??""} onChangeText={value=>dispatch({type:"draft",slot:fieldSlot,text:value})} testID={`flow-field-${index}`} />;
    }
    if(b.kind==="row") {
      if(state.screen==="communityBlocked")return null;
      if(state.screen==="communityInbox"&&(b.target==="communityChat"||b.target==="communityNewChat")) { const personId=`demo-parent-${b.copy[0][1]}`; if(state.blocked[personId]||state.connections[personId]==="disconnected")return null; }
      return <MenuRow key={id} density="list" label={forPerson(copy(b.copy[0]))} detail={b.copy[1]?forPerson(copy(b.copy[1])):undefined} onPress={()=>action(b,index)} testID={`flow-row-${index}`} />;
    }
    if(b.kind==="choices") {
      const identity=state.screen==="bottleCompose"&&index===3;
      return <View key={id} style={{gap:16}}><NuriText>{forPerson(copy(b.copy[0]))}</NuriText><View style={s.choices}>{b.copy.slice(1).map((option,i)=><ChoiceChip key={i} label={copy(option)} selected={identity?state.identity===(i===0?"anonymous":"firstName"):(state.choices[id]??[]).includes(i)} onPress={()=>dispatch(identity?{type:"identity",value:i===0?"anonymous":"firstName"}:{type:"choose",group:id,index:i,single:state.screen==="communityReport"||state.screen==="bottleRespond"})} testID={`flow-choice-${index}-${i}`} />)}</View></View>;
    }
    if(state.screen==="communityPreferences"&&index<10) {
      if(index%2)return null;
      const hidden=index===8;
      return <View key={id}><ToggleRow label={copy(b.copy[0])} value={hidden?state.hidden:!(state.choices[id]??[]).includes(0)} onChange={value=>dispatch(hidden?{type:"hide",value}:{type:"choose",group:id,index:0})} testID={`flow-toggle-${index}`} /><NuriText secondary>{copy(design!.blocks[index+1].copy[0])}</NuriText></View>;
    }
    if(state.screen==="bottleWaiting"&&index===4)return <NuriText key={id}>{text(state.identity==="anonymous"?"显示为：匿名":"显示为：仅名字",state.identity==="anonymous"?"Shown as: Anonymous":"Shown as: First name only")}</NuriText>;
    return <NuriText key={id} role={b.heading?"H2":"Body"} secondary={b.note}>{forPerson(copy(b.copy[0]))}</NuriText>;
  }
  if(!design)return frame(<NuriText>{text("此内容仅供流程测试，没有加载真实推荐。","Sample content for flow testing; no live recommendation was loaded.")}</NuriText>,button("返回推送","Back to notifications",{type:"go",screen:"notifications"},true));
  const actions=design.blocks.map((b,index)=>b.kind==="action"?<NuriButton key={index} label={forPerson(copy(b.copy[0]))} secondary={design.blocks.slice(0,index).some(x=>x.kind==="action")} onPress={()=>action(b,index)} disabled={(state.screen==="bottleCompose"||state.screen==="bottleRespond"&&b.target==="communityInbox")&&!state.drafts[slot]?.trim()} testID={`flow-button-${index}`} />:null);
  return frame(<>{design.blocks.map(renderBlock)}{state.screen==="bottleRespond"?<View style={{flexDirection:"row",justifyContent:"flex-end"}}><IconAction name="mic" label={text("语音回答","Voice answer")} onPress={voice} testID="flow-answer-voice" /></View>:null}{state.screen==="communityBlocked"?<><NuriText role="Caption" secondary>{text("此列表与屏蔽操作仅为本地演示。","This list and blocking are local demonstrations only.")}</NuriText>{Object.entries(state.blocked).filter(([,blocked])=>blocked).length?Object.entries(state.blocked).filter(([,blocked])=>blocked).map(([personId])=><MenuRow key={personId} label={personId.split("-").at(-1)??""} onPress={()=>dispatch({type:"reviewBlocked",personId,name:personId.split("-").at(-1)??""})} />):<NuriText>{text("尚未屏蔽示例家长","No sample parents are blocked")}</NuriText>}</>:null}</>,<>{actions}{entry==="notifications"&&state.screen==="notifications"?<NuriButton secondary label={text("管理实际通知设置","Manage real notification settings")} onPress={()=>router.push("/notification-settings")} testID="flow-real-notification-settings" />:null}</>);
}
const s=StyleSheet.create({
  badge:{paddingLeft:24,paddingRight:12,minHeight:44,flexDirection:"row",alignItems:"center",gap:8},
  statePicker:{paddingHorizontal:24,flexDirection:"row",flexWrap:"wrap",gap:8},
  region:{flex:1,minHeight:0,justifyContent:"center",paddingHorizontal:24,paddingTop:24,paddingBottom:32},
  card:{width:"100%",maxWidth:500,alignSelf:"center",flexShrink:1},
  cardInside:{padding:24,flexShrink:1},body:{gap:24,paddingBottom:4},
  actions:{gap:12,paddingTop:24},multiline:{height:96,paddingTop:12,textAlignVertical:"top"},
  choices:{flexDirection:"row",flexWrap:"wrap",gap:10},
  chatStack:{paddingHorizontal:24,paddingTop:24,paddingBottom:32,gap:12},
  composer:{paddingHorizontal:24,paddingBottom:4,paddingTop:12},
});
