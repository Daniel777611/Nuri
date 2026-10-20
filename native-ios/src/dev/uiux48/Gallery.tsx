import { useState } from "react";
import { ActivityIndicator, ScrollView, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useT } from "@/src/i18n";
import { AuthFrame, ChoiceChip, GlassSurface, IconAction, MenuRow, NuriButton, NuriField, NuriIcon, NuriText, ToggleRow } from "@/src/uiux48/Primitives";
import { NuriComposer } from "@/src/uiux48/Composer";
import { GALLERY_SCREENS, FIXTURE_SENTINEL, type Copy48, type GalleryBlock } from "./galleryData";

/** Pure local state only: no API, auth, permission, storage or transport imports. */
export default function Gallery() {
  const {group}=useLocalSearchParams<{group?:string}>();
  const [key,setKey]=useState(group||"community");const [variant,setVariant]=useState("design");
  const [drafts,setDrafts]=useState<Record<string,string>>({});
  const [choices,setChoices]=useState<Record<string,boolean>>({});const [notice,setNotice]=useState("");
  const {locale}=useT();const en=locale==="en";const copy=(x:Copy48)=>x[en?1:0];
  const design=GALLERY_SCREENS.find(s=>s.key===key)??GALLERY_SCREENS[0];
  const go=(target?:string)=>{
    const next=key==="communityTyping"&&target==="communityChat"?"communityChatSent":target;
    if(next&&GALLERY_SCREENS.some(s=>s.key===next)){setKey(next);setVariant("design");setNotice("");}
    else setNotice(en?"Fixture navigation only. This destination has no service contract in this gallery.":"这里只演示导航，此目的地尚无可核实的服务契约。");
  };
  const field=(b:GalleryBlock,i:number)=>{const id=`${design.key}-${i}`;return <NuriField key={id} testID={`gallery-field-${i}`} label={copy(b.copy[0])} value={drafts[id]??copy(b.copy[1]??["",""])} onChangeText={value=>setDrafts(v=>({...v,[id]:value}))} multiline style={{height:96,paddingTop:14,textAlignVertical:"top"}} />;};
  let actions=0;
  const block=(b:GalleryBlock,i:number)=>{
    const id=`${key}-${i}`;
    if(b.kind==="field")return field(b,i);
    if(b.kind==="choices")return <View key={id} style={{gap:16}}><NuriText secondary style={{fontSize:12,lineHeight:16}}>{copy(b.copy[0])}</NuriText><View style={{flexDirection:"row",flexWrap:"wrap",gap:12}}>{b.copy.slice(1).map((label,n)=><ChoiceChip key={n} label={copy(label)} selected={choices[id+"-"+n]??n===0} onPress={()=>setChoices(v=>({...v,[id+"-"+n]:!(v[id+"-"+n]??n===0)}))} testID={`gallery-choice-${i}-${n}`} />)}</View></View>;
    if(b.kind==="row")return <MenuRow key={id} density="community" label={copy(b.copy[0])} detail={b.copy[1]?copy(b.copy[1]):undefined} onPress={()=>go(b.target)} testID={`gallery-row-${i}`} />;
    if(b.kind==="action")return <NuriButton key={id} label={copy(b.copy[0])} secondary={actions++>0} onPress={()=>go(b.target)} testID={`gallery-action-${i}`} />;
    return <NuriText key={id} secondary={b.note} style={{fontSize:b.note?12:b.heading?20:16,lineHeight:b.note?16:b.heading?26:22,fontWeight:b.heading?"500":"400"}}>{copy(b.copy[0])}</NuriText>;
  };
  let blocks=design.blocks;
  // Shared row, switch and message surfaces follow the actual frame structures.
  if(key==="community")blocks=[blocks[0],...[[1,2,"bottleCompose"],[3,4,"matchIntent"],[5,6,"communityInbox"]].map(([a,b,target])=>({kind:"row",copy:[blocks[Number(a)].copy[0],blocks[Number(b)].copy[0]],target:String(target)}))];
  if(key==="communityNewChat")blocks=blocks.map((b,i)=>i>=2&&i<=4?{...b,kind:"row",target:"communityTyping"}:b);
  const chat=key==="communityChat"||key==="communityChatSent"||key==="communityNewChat";
  const body=variant!=="design"?<AuthFrame testID="gallery-state-card" contentGap={24}>{variant==="loading"?<ActivityIndicator />:null}<NuriText>{variant==="loading"?(en?"Loading fixture…":"夹具加载中…"):variant==="permission"?(en?"Permission was not granted. No microphone, camera or account setting was changed.":"权限未获允许，没有更改麦克风、相机或账号设置。"):en?"Service unavailable. No message or profile was sent.":"服务暂不可用，没有发送消息或个人资料。"}</NuriText><NuriButton secondary label={en?"Return to design fixture":"返回设计夹具"} onPress={()=>setVariant("design")} /></AuthFrame>:
    chat?<View style={{flex:1,minHeight:0}}><ScrollView testID="gallery-chat-scroll" style={{flex:1,minHeight:0}} contentContainerStyle={{padding:24,gap:12}} keyboardShouldPersistTaps="handled">
      {key==="communityNewChat"?<>
        <GlassSurface kind="message" contentStyle={{padding:20}}>{block(blocks[0],0)}</GlassSurface>
        <GlassSurface kind="message" contentStyle={{padding:20}}>{block(blocks[1],1)}</GlassSurface>
        <GlassSurface kind="message" contentStyle={{paddingHorizontal:20}}>{blocks.slice(2,5).map((b,i)=>block(b,i+2))}</GlassSurface>
        <GlassSurface kind="message" contentStyle={{padding:20}}>{block(blocks[5],5)}</GlassSurface>
      </>:<>
        {key==="communityChat"?<GlassSurface kind="message" contentStyle={{padding:20}}>{block(blocks[0],0)}</GlassSurface>:null}
        {[0,1,2].map(i=>{const index=(key==="communityChat"?1:0)+i*2;return <GlassSurface key={i} kind={i===1?"user":"message"} contentStyle={{padding:20,gap:2}}>{block(blocks[index],index)}{block(blocks[index+1],index+1)}</GlassSurface>;})}
        <GlassSurface kind="message" contentStyle={{paddingHorizontal:20}}>{blocks.slice(key==="communityChat"?7:6).map((b,i)=>block({...b,kind:"row",target:b.target??["communityMeeting","communityTranslation","communityTyping"][i]},i+10))}</GlassSurface>
      </>}
    </ScrollView><View style={{paddingHorizontal:24,paddingBottom:12}}><NuriComposer value={drafts.chat??""} onChangeText={v=>setDrafts(s=>({...s,chat:v}))} onSend={()=>go("communityTyping")} onAttach={()=>setNotice(en?"Fixture only: no photo picker opened.":"仅夹具：没有打开相册。")} onMic={()=>go("communityVoice")} testID="gallery-composer" /></View></View>:
    <AuthFrame testID={`gallery-card-${key}`} contentGap={24}>
      {key==="communityVoice"||key==="voice"?<View style={{gap:16}}><NuriIcon name="mic" /><View style={{height:64,flexDirection:"row",alignItems:"center",gap:5}}>{Array.from({length:32},(_,i)=><View key={i} style={{width:3,height:8+(i*31%48),borderRadius:1.5,backgroundColor:"#735c84"}} />)}</View></View>:null}
      {key==="imagePreview"?<GlassSurface kind="composer" contentStyle={{height:220,alignItems:"center",justifyContent:"center"}}><NuriIcon name="image" /></GlassSurface>:null}
      {key==="communityPreferences"?<>{Array.from({length:5},(_,i)=><View key={i}><ToggleRow label={copy(blocks[i*2].copy[0])} value={choices[`toggle-${i}`]??i<4} onChange={v=>setChoices(s=>({...s,[`toggle-${i}`]:v}))} testID={`gallery-toggle-${i}`} /><NuriText secondary style={{fontSize:12,lineHeight:16}}>{copy(blocks[i*2+1].copy[0])}</NuriText></View>)}{blocks.slice(10).map((b,i)=>block(b,i+10))}</>:blocks.map(block)}
    </AuthFrame>;
  return <View style={{flex:1,minHeight:0}} testID="uiux48-isolated-gallery" accessibilityLabel={FIXTURE_SENTINEL}>
    <GlassSurface kind="message" style={{marginHorizontal:24,marginTop:4}} contentStyle={{padding:12,gap:6}}><NuriText testID="gallery-warning" style={{fontSize:12,lineHeight:16,fontWeight:"500"}}>{en?"DEVELOPMENT FIXTURE — no real people, sends, matches or history.":"开发夹具 — 非真实用户、发送、匹配或历史记录。"}</NuriText><NuriText testID="gallery-title" style={{fontSize:16,fontWeight:"500"}}>{copy(design.title)}</NuriText><NuriText secondary style={{fontSize:10,lineHeight:14}}>{design.key} · Figma {design.node}</NuriText><ScrollView horizontal showsHorizontalScrollIndicator={false}><View style={{flexDirection:"row",gap:8}}>{["design","loading","error","permission"].map(v=><ChoiceChip key={v} label={v} selected={variant===v} onPress={()=>setVariant(v)} testID={`gallery-variant-${v}`} />)}<IconAction name="back" label="Previous fixture" onPress={()=>go(GALLERY_SCREENS[(GALLERY_SCREENS.indexOf(design)+GALLERY_SCREENS.length-1)%GALLERY_SCREENS.length].key)} testID="gallery-previous" /><IconAction name="chevronRight" label="Next fixture" onPress={()=>go(GALLERY_SCREENS[(GALLERY_SCREENS.indexOf(design)+1)%GALLERY_SCREENS.length].key)} testID="gallery-next" /></View></ScrollView>{notice?<NuriText testID="gallery-notice" secondary style={{fontSize:12,lineHeight:16}}>{notice}</NuriText>:null}</GlassSurface>
    {body}
  </View>;
}
