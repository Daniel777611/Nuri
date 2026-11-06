import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { AccessibilityInfo, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions, type ViewStyle } from "react-native";
import { Image } from "expo-image";
import { BlurView } from "expo-blur";
import { requireOptionalNativeModule } from "expo";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useT } from "@/src/i18n";
import type { AppKeyboardMode, KeyboardPanelProps } from "./AppKeyboard";
import thirdPartyNotices from "./vendor/THIRD_PARTY_NOTICES.json";

/** Approved instance188:64331, linked EN/emoji variants76:14714/14770.
 * Figma radius50 exports as CSS blur25. Glass optics are design references:
 * UIKit's public UIGlassEffect owns refraction/lighting; it does not expose
 * Figma's depth/dispersion/light controls. Do not claim numerical equivalence.
 * RN has no linear-dodge/burn blend. Native uses public light materials and
 * derived white luminance veils, not opaque dark stand-ins; it remains an
 * approximation requiring native pixel/performance acceptance.
 * No disabled Figma drop shadow is added. No night design was requested. */
export const KEYBOARD_DESIGN = {
  width:402,height:336,toolbar:44,radius:28,blurRadius:50,cssBlur:25,
  fills:[{color:"rgba(229,167,159,.1)",blend:"luminosity"},{color:"rgba(27,27,27,.2)",blend:"plus-lighter"},{color:"rgba(211,158,158,.1)",blend:"linear-burn"}],
  glass:{radius:4,refraction:.8,depth:20,lightAngle:-45,lightIntensity:.8,dispersion:.5,splay:0},
  key:{height:43,radius:8.5,gap:6,rowGap:11,inset:6.67,fontSize:28},
} as const;
const INK="#5C5662",SECONDARY="#706A74";
const glyphs={
  shift:require("@/assets/final-flow-20261101/keyboard-shift.svg"),
  delete:require("@/assets/final-flow-20261101/keyboard-delete.svg"),
  globe:require("@/assets/final-flow-20261101/keyboard-globe.svg"),
  return:require("@/assets/final-flow-20261101/keyboard-return.svg"),
  emoji:require("@/assets/final-flow-20261101/community-emoji.svg"),
  mic:require("@/assets/final-flow-20261101/microphone.svg"),
};
export const KEYBOARD_STICKERS={
  1:require("@/assets/final-flow-20261101/keyboard-sticker-1.png"),
  2:require("@/assets/final-flow-20261101/keyboard-sticker-2.png"),
  3:require("@/assets/final-flow-20261101/keyboard-sticker-3.png"),
  4:require("@/assets/final-flow-20261101/keyboard-sticker-4.png"),
  5:require("@/assets/final-flow-20261101/keyboard-sticker-5.png"),
} as const;
type Sticker=keyof typeof KEYBOARD_STICKERS;
// Unicode text and five actual image slots from the linked Figma emoji grid.
// Image stickers must not masquerade as Unicode or be silently sent as text.
const EMOJI_COLUMNS:readonly (readonly (string|Sticker)[])[]=[
  ["😂","👊","😭","👀"],["😩","😊","👻","💨"],["😔","🦆",1,"🐵"],
  ["😏","👊","👩‍💻","👍"],["💕","🙆‍♀️","😭","🙃"],["😂",2,"👀",3],
  ["👁",4,"🏆",5],["😀","😃","😄","😁"],["🥹","😅","😂","🤣"],
];
const EMOJI_NAMES:Record<string,string>={"😂":"笑 laugh joy","👊":"拳 fist","😭":"哭 cry","👀":"眼 eye","😩":"累 tired","😊":"笑 smile","👻":"鬼 ghost","💨":"风 wind","😔":"难过 sad","🦆":"鸭 duck","🐵":"猴 monkey","😏":"笑 smirk","👩‍💻":"工作 woman computer","👍":"好 good thumb","💕":"爱 heart love","🙆‍♀️":"好 ok woman","🙃":"笑 upside","👁":"眼 eye","🏆":"奖 trophy","😀":"笑 smile","😃":"笑 smile","😄":"笑 smile","😁":"笑 smile","🥹":"感动 tears","😅":"汗 sweat","🤣":"笑 laugh"};
type MaterialState={reduced:boolean;webTransfer:boolean;NativeGlass:ComponentType<import("expo-glass-effect").GlassViewProps>|null};
type KeyProps={id:string;label:string;children?:ReactNode;onPress:()=>void;onLongPress?:()=>void;repeat?:boolean;style?:ViewStyle;selected?:boolean;small?:boolean;material:MaterialState};
function Key({id,label,children,onPress,onLongPress,repeat=false,style,selected=false,small=false,material}:KeyProps){
  const timer=useRef<ReturnType<typeof setInterval>|null>(null);
  const clear=()=>{if(timer.current)clearInterval(timer.current);timer.current=null;};
  useEffect(()=>clear,[]);
  return <Pressable testID={`app-key-${id}`} accessibilityRole="keyboardkey" accessibilityLabel={label} accessibilityState={{selected}} onPress={onPress}
    onPressOut={clear} delayLongPress={350} onLongPress={onLongPress??(repeat?()=>{clear();const heldAction=onPress;timer.current=setInterval(heldAction,80);}:undefined)}
    style={[s.key,style]}>
    {({pressed})=><><KeyboardMaterial kind="key" state={material}/><View pointerEvents="none" style={[StyleSheet.absoluteFill,{backgroundColor:pressed?"rgba(235,129,131,.24)":selected?"rgba(193,160,221,.55)":"transparent"}]}/>
    {children??<Text allowFontScaling={false} numberOfLines={1} style={[s.keyText,{fontSize:(small?16:28)*Math.min(1,(typeof style?.height==="number"?style.height:43)/43),lineHeight:(small?24:34)*Math.min(1,(typeof style?.height==="number"?style.height:43)/43)}]}>{label}</Text>}
    </>}
  </Pressable>;
}
function Glyph({name}:{name:keyof typeof glyphs}){return <Image source={glyphs[name]} style={{width:20,height:20}} contentFit="contain" accessible={false} accessibilityElementsHidden/>;}
// RN-web Modals are body portals, outside the footer Host. Mark only these
// owned roots so a focus-trap transition does not dismiss their input owner.
function KeyboardPortal({children}:{children:ReactNode}){
  return Platform.OS==="web"?<div data-nuri-keyboard-host="keyboard-portal" style={{display:"flex",flex:1,minHeight:0,width:"100%"}}>{children}</div>:<View style={{flex:1}}>{children}</View>;
}
function useKeyboardMaterial():MaterialState{
  const [reduced,setReduced]=useState(true);
  const [webTransfer,setWebTransfer]=useState(false);
  useEffect(()=>{
    if(Platform.OS==="web"){
      // WebKit can silently discard the entire blur+SVG filter chain
      // (bugs245510/317059). Syntax support is not rendered support. Only
      // the verified Chromium path opts in; Safari/CriOS keep real blur.
      const ua=typeof navigator!=="undefined"?navigator.userAgent:"";
      setWebTransfer(/\b(?:Chrome|Chromium|Edg|OPR)\//.test(ua)&&!/(?:CriOS|FxiOS|EdgiOS)\//.test(ua));
      const media=typeof globalThis.matchMedia==="function"?globalThis.matchMedia("(prefers-reduced-transparency: reduce)"):null;
      setReduced(media?.matches??false);
      const change=()=>setReduced(media?.matches??false);media?.addEventListener?.("change",change);
      return()=>media?.removeEventListener?.("change",change);
    }
    let active=true,newerEvent=false;
    void AccessibilityInfo.isReduceTransparencyEnabled().then(value=>{if(active&&!newerEvent)setReduced(value);}).catch(()=>{});
    const sub=AccessibilityInfo.addEventListener("reduceTransparencyChanged",value=>{newerEvent=true;if(active)setReduced(value);});
    return()=>{active=false;sub.remove();};
  },[]);
  let NativeGlass:ComponentType<import("expo-glass-effect").GlassViewProps>|null=null;
  if(Platform.OS==="ios"&&!reduced){try{
    if(requireOptionalNativeModule("ExpoGlassEffect")){
      const glass= require("expo-glass-effect") as typeof import("expo-glass-effect");
      if(glass.isLiquidGlassAvailable()&&glass.isGlassEffectAPIAvailable())NativeGlass=glass.GlassView;
    }
  }catch{/* A development binary predating this module uses the blur fallback. */}}
  return {reduced,webTransfer,NativeGlass};
}
function KeyboardMaterial({kind="panel",state}:{kind?:"panel"|"key";state:MaterialState}){
  const {reduced,webTransfer,NativeGlass}=state,key=kind==="key",testID=key?"app-key-material":"app-keyboard-material";
  const webFilter=webTransfer?`blur(25px) url(#nuri-keyboard-${key?"key":"panel"}-tint)`:"blur(25px)";
  if(Platform.OS==="web")return <div data-testid={testID} aria-hidden="true" style={{position:"absolute",inset:0,pointerEvents:"none",borderRadius:"inherit",overflow:"hidden",...(reduced?{backgroundColor:key?"white":"#F8F3F2"}:{backdropFilter:webFilter,WebkitBackdropFilter:webFilter})}}>
    {!reduced?(key?<><div style={{position:"absolute",inset:0,background:"rgba(255,255,255,.67)"}}/>{!webTransfer?<div style={{position:"absolute",inset:0,background:`rgba(255,255,255,${25/255/(1-.67)})`}}/>:null}</>:<>
      <div style={{position:"absolute",inset:0,background:"rgba(229,167,159,.1)",mixBlendMode:"luminosity"}}/>
      {!webTransfer?<><div style={{position:"absolute",inset:0,background:`rgba(255,255,255,${27/255*.2})`}}/><div style={{position:"absolute",inset:0,background:"rgba(211,158,158,.1)"}}/></>:null}
    </>):null}
  </div>;
  return <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={StyleSheet.absoluteFill} testID={testID}>
    {reduced?<View style={[StyleSheet.absoluteFill,{backgroundColor:key?"white":"#F8F3F2"}]}/>:<>
      {!key&&NativeGlass?<NativeGlass glassEffectStyle="regular" colorScheme="light" style={StyleSheet.absoluteFill}/>:<BlurView tint="systemUltraThinMaterialLight" intensity={50} style={StyleSheet.absoluteFill}/>}
      {/* Native has no per-channel backdrop transfer; the derived white veil
          is a light-only fallback, not CSS screen with an opaque dark fill. */}
      {key?<><View style={[StyleSheet.absoluteFill,{backgroundColor:"rgba(255,255,255,.67)"}]}/><View style={[StyleSheet.absoluteFill,{backgroundColor:`rgba(255,255,255,${25/255/(1-.67)})`}]}/></>:<>
        <View style={[StyleSheet.absoluteFill,{backgroundColor:"rgba(229,167,159,.1)",mixBlendMode:"luminosity"}]}/>
        {/* Public RN lacks additive/burn blend modes. A light neutral veil
            carries27/255 ×20% luminance, never the old dark27/.2 overlay. */}
        <View style={[StyleSheet.absoluteFill,{backgroundColor:`rgba(255,255,255,${27/255*.2})`}]}/>
        <View style={[StyleSheet.absoluteFill,{backgroundColor:"rgba(211,158,158,.1)"}]}/>
      </>}
    </>}
  </View>;
}

// CSS plus-lighter sums premultiplied alpha, unlike Figma's additive fill:
// an opaque#191919 over67%white can turn grey. Apply the actual channel
// arithmetic to the sampled backdrop instead; never add an opaque dark key.
const keyboardChannelTable=(rose:number)=>Array.from({length:256},(_,index)=>{
    const b=index/255,burn=b*.9+Math.max(0,b+rose-1)*.1;
    return (burn*.8+Math.min(1,burn+27/255)*.2).toFixed(6);
  }).join(" ");
const KEYBOARD_TINT_TABLES=[keyboardChannelTable(.8269230723381042),keyboardChannelTable(.620192289352417)];
function KeyboardBackdropFilters(){
  return <svg width="0" height="0" aria-hidden="true" style={{position:"absolute",pointerEvents:"none"}}><defs>
    <filter id="nuri-keyboard-panel-tint" colorInterpolationFilters="sRGB"><feComponentTransfer><feFuncR type="table" tableValues={KEYBOARD_TINT_TABLES[0]}/><feFuncG type="table" tableValues={KEYBOARD_TINT_TABLES[1]}/><feFuncB type="table" tableValues={KEYBOARD_TINT_TABLES[1]}/></feComponentTransfer></filter>
    <filter id="nuri-keyboard-key-tint" colorInterpolationFilters="sRGB"><feComponentTransfer><feFuncR type="linear" slope="1" intercept={25/255/(1-.67)}/><feFuncG type="linear" slope="1" intercept={25/255/(1-.67)}/><feFuncB type="linear" slope="1" intercept={25/255/(1-.67)}/></feComponentTransfer></filter>
  </defs></svg>;
}

/** The host consumes layout space. This view never covers the OS keys, paints
 * a screenshot keyboard, adds a file picker, or sends/records anything itself. */
export function KeyboardPanel(p:KeyboardPanelProps){
  const {locale}=useT(),en=locale==="en",zh=(cn:string,tw:string)=>locale==="zh-TW"?tw:cn,safe=useSafeAreaInsets(),window=useWindowDimensions();
  const material=useKeyboardMaterial();
  const scale=Math.min(1,Math.max(.55,(window.height-safe.top-160)/336));
  const height=336*scale+Math.max(0,safe.bottom-34),keyHeight=43*scale,gap=11*scale;
  const [symbols2,setSymbols2]=useState(false),[textMode,setTextMode]=useState<AppKeyboardMode>(p.mode==="en"||p.mode==="zh-CN"||p.mode==="zh-TW"?p.mode:locale==="en"?"en":locale==="zh-TW"?"zh-TW":"zh-CN");
  const [searching,setSearching]=useState(false),[query,setQuery]=useState(""),[preview,setPreview]=useState<Sticker|null>(null);
  const [noticesVisible,setNoticesVisible]=useState(false);
  const mode=p.mode,numeric=["numeric","decimal","phone"].includes(p.layout),emoji=mode==="emoji"&&!numeric&&!p.secure;
  useEffect(()=>{if(mode==="en"||mode==="zh-CN"||mode==="zh-TW")setTextMode(mode);if(mode!=="emoji"){setSearching(false);setQuery("");}},[mode]);
  const text=(value:string)=>{if(searching)setQuery(old=>(old+value).slice(0,64));else p.onText(value);};
  const backspace=()=>{if(searching)setQuery(old=>Array.from(old).slice(0,-1).join(""));else p.onBackspace();};
  const language=()=>p.onModeChange(mode==="en"?(locale==="zh-TW"?"zh-TW":"zh-CN"):"en");
  const key=(value:string,id=value)=> <Key material={material} key={id} id={id} label={value} onPress={()=>text(value)} style={{height:keyHeight,flex:1}}/>;
  const erase=<Key material={material} id="backspace" label={en?"Delete":zh("删除","刪除")} onPress={backspace} repeat style={{height:keyHeight,width:45}}><Glyph name="delete"/></Key>;
  const returnKey=<Key material={material} id="return" label={p.returnKeyLabel} onPress={()=>searching?setSearching(false):p.onEnter()} style={{height:keyHeight,width:93}}>{p.multiline&&!searching?<Glyph name="return"/>:<Text allowFontScaling={false} style={{fontSize:16,color:INK}}>{searching?(en?"Search":zh("搜索","搜尋")):p.returnKeyLabel}</Text>}</Key>;
  const footer=(fromEmoji=false)=><View style={[s.row,{height:keyHeight,gap:6}]}>
    <Key material={material} id="symbols" label={fromEmoji||mode==="symbols"?"ABC":"123"} small onPress={()=>{if(searching){text("123");return;}p.onModeChange(fromEmoji||mode==="symbols"?textMode:"symbols");}} style={{width:50,height:keyHeight}}/>
    <Key material={material} id="language" label={en?"Change input language; hold for system keyboard":zh("切换输入语言；长按使用系统键盘","切換輸入語言；長按使用系統鍵盤")} onPress={language} onLongPress={p.onUseSystemKeyboard} style={{width:44,height:keyHeight}}><Glyph name="globe"/></Key>
    {p.layout==="email"||p.layout==="url"?<Key material={material} id="at-or-slash" label={p.layout==="email"?"@":"/"} onPress={()=>text(p.layout==="email"?"@":"/")} style={{width:34,height:keyHeight}}/>:null}
    <Key material={material} id="space" label={en?"Space":"空格"} onPress={()=>searching?text(" "):p.onSpace()} style={{flex:1,height:keyHeight}}><View/></Key>
    {returnKey}
  </View>;
  const letters=(symbol=false)=>{
    const rows=symbol?(symbols2?["[]{}#%^*+=","_\\|~<>€£¥•",".,?!'\"-"]:["1234567890","-/:;()$&@\"",".,?!'\"-"]):["qwertyuiop","asdfghjkl","zxcvbnm"];
    return <View style={{gap,paddingHorizontal:6.67}} testID="app-keyboard-text-keys">
      <View style={[s.row,{height:keyHeight}]}>{Array.from(rows[0]).map(value=>key(!symbol&&p.shift?value.toUpperCase():value))}</View>
      <View style={[s.row,{height:keyHeight,paddingHorizontal:20}]}>{Array.from(rows[1]).map(value=>key(!symbol&&p.shift?value.toUpperCase():value))}</View>
      <View style={[s.row,{height:keyHeight,gap:13.333}]}>
        <Key material={material} id="shift" label={symbol?(symbols2?"123":"#+="):(en?"Shift":zh("大写","大寫"))} selected={!symbol&&p.shift} small onPress={()=>symbol?setSymbols2(old=>!old):p.onShift()} style={{height:keyHeight,width:45}}>{symbol?undefined:<Glyph name="shift"/>}</Key>
        <View style={[s.row,{height:keyHeight,flex:1}]}>{Array.from(rows[2]).map(value=>key(!symbol&&p.shift?value.toUpperCase():value))}</View>{erase}
      </View>
      {footer()}
    </View>;
  };
  const emojiColumns=EMOJI_COLUMNS.map(column=>column.filter(item=>!query||typeof item==="string"&&(item+" "+(EMOJI_NAMES[item]??"")).toLowerCase().includes(query.toLowerCase()))).filter(column=>column.length);
  const toolbarHeight=44*scale,preeditHeight=24*scale,candidateHeight=25*scale;
  return <View testID="app-keyboard" onLayout={event=>p.onHeightChange?.(event.nativeEvent.layout.height)} style={{width:"100%",height,flexShrink:0,borderTopLeftRadius:28,borderTopRightRadius:28,overflow:"hidden"}} accessibilityLabel={en?"Nuri keyboard":zh("Nuri 键盘","Nuri 鍵盤")}>
    {Platform.OS==="web"?<KeyboardBackdropFilters/>:null}<KeyboardMaterial state={material}/>
    <View style={[s.toolbar,{height:toolbarHeight}]}>
      <View style={{width:60}}><Pressable testID="app-keyboard-emoji" accessibilityRole="button" accessibilityLabel={en?"Emoji keyboard":zh("表情键盘","表情鍵盤")} accessibilityState={{selected:emoji,disabled:p.secure||numeric}} disabled={p.secure||numeric} onPress={()=>p.onModeChange(emoji?textMode:"emoji")} style={{width:44,height:toolbarHeight,alignItems:"center",justifyContent:"center",opacity:p.secure||numeric?.4:1}}><Glyph name="emoji"/></Pressable></View>
      {p.onDictation?<Pressable testID="app-keyboard-dictation" accessibilityRole="button" accessibilityLabel={en?"Dictate":zh("语音输入","語音輸入")} onPress={p.onDictation} style={{width:44,height:toolbarHeight,alignItems:"center",justifyContent:"center"}}><Glyph name="mic"/></Pressable>:null}
      <Pressable testID="app-keyboard-done" accessibilityRole="button" accessibilityLabel={en?"Done":"完成"} onPress={p.onDone} onLongPress={()=>setNoticesVisible(true)} accessibilityActions={[{name:"notices",label:en?"Keyboard open-source notices":zh("键盘开源许可","鍵盤開源授權")}]} onAccessibilityAction={event=>{if(event.nativeEvent.actionName==="notices")setNoticesVisible(true);}} style={{width:60,height:toolbarHeight,alignItems:"center",justifyContent:"center"}}><Text allowFontScaling={false} style={{fontSize:16,lineHeight:24,fontWeight:"500",color:SECONDARY}}>{en?"Done":"完成"}</Text></Pressable>
    </View>
    <View pointerEvents="none" style={{position:"absolute",top:48*scale,left:0,right:0,height:1,backgroundColor:"white"}}/>
    {emoji&&!searching?<>
      <View style={{height:211*scale}}>
        <Pressable testID="app-keyboard-emoji-search" accessibilityRole="button" accessibilityLabel={en?"Search emoji":zh("搜索表情","搜尋表情")} onPress={()=>setSearching(true)} style={{height:51*scale,justifyContent:"center",paddingHorizontal:12}}><View style={{height:32*scale,borderRadius:10,backgroundColor:"rgba(118,118,128,.12)",justifyContent:"center",paddingHorizontal:12}}><Text style={{fontSize:16,color:SECONDARY}}>{query|| (en?"Search Emoji":zh("搜索表情","搜尋表情"))}</Text></View></Pressable>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" contentContainerStyle={{paddingHorizontal:10,gap:14}}>
          {emojiColumns.map((column,index)=><ScrollView key={index} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="always" style={{width:40,height:160*scale}} contentContainerStyle={{gap:5}}>{column.map((item,row)=><Pressable key={row} testID={`app-keyboard-emoji-${index}-${row}`} accessibilityRole="keyboardkey" accessibilityLabel={typeof item==="string"?item:en?`Sticker ${item}`:zh(`贴纸 ${item}`,`貼紙 ${item}`)} accessibilityHint={typeof item==="number"&&!p.onSticker?(en?"Opens image preview. This text field does not accept image attachments.":zh("打开图片预览；此文字栏不接收图片附件。","開啟圖片預覽；此文字欄不接受圖片附件。")):undefined} onPress={()=>typeof item==="string"?p.onText(item):p.onSticker?p.onSticker(item):setPreview(item)} style={{width:40,height:50,alignItems:"center",justifyContent:"center"}}>{typeof item==="string"?<Text allowFontScaling={false} style={{fontSize:39,lineHeight:50}}>{item}</Text>:<Image source={KEYBOARD_STICKERS[item]} style={{width:item===2?35:40,height:item===4?50.52:item===5?39:43}} contentFit="contain" accessible={false}/>}</Pressable>)}</ScrollView>)}
        </ScrollView>
      </View>
      <View style={{paddingHorizontal:6.67}}>{footer(true)}</View>
    </>:<>
      <View style={{height:preeditHeight,justifyContent:"center",paddingHorizontal:12}}><Text testID="app-keyboard-preedit" numberOfLines={1} allowFontScaling={false} style={{fontSize:12,color:SECONDARY}}>{searching?(query||(en?"Type a search, then press Search":zh("输入关键词，再点搜索","輸入關鍵字，再點搜尋"))):p.preedit}</Text></View>
      <ScrollView horizontal testID="app-keyboard-candidates" showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" style={{height:candidateHeight,flexGrow:0}} contentContainerStyle={{minWidth:"100%",height:candidateHeight}}>{!searching?p.candidates.map((word,index)=><Pressable key={word} testID={`app-keyboard-candidate-${index}`} accessibilityRole="keyboardkey" accessibilityLabel={word} onPress={()=>p.onCandidate(word)} style={{minWidth:window.width/3,height:candidateHeight,alignItems:"center",justifyContent:"center",paddingHorizontal:12,borderRightWidth:1,borderRightColor:"rgba(255,255,255,.22)"}}><Text numberOfLines={1} allowFontScaling={false} style={{fontSize:18,color:"#1B1B1B"}}>{word}</Text></Pressable>):null}</ScrollView>
      {numeric?<View style={{gap,paddingHorizontal:6.67}} testID="app-keyboard-number-keys">{["123","456","789"].map((row,index)=><View key={row} style={[s.row,{height:keyHeight}]}>{Array.from(row).map(value=>key(value))}</View>)}<View style={[s.row,{height:keyHeight}]}>{p.layout==="decimal"?key("."):p.layout==="phone"?key("+"):<Key material={material} id="system" label={en?"System keyboard":zh("系统键盘","系統鍵盤")} small onPress={p.onUseSystemKeyboard} style={{height:keyHeight,flex:1}}/>}{key("0")}{erase}{returnKey}</View></View>:letters(mode==="symbols"&&!searching)}
    </>}
    {Platform.OS==="web"?<View pointerEvents="none" style={{position:"absolute",bottom:8,left:"50%",marginLeft:-72,width:144,height:5,borderRadius:2.5,backgroundColor:INK}}/>:null}
    <Modal visible={preview!==null} transparent animationType="fade" onRequestClose={()=>setPreview(null)}><KeyboardPortal><Pressable testID="app-keyboard-sticker-preview" accessibilityRole="button" accessibilityLabel={en?"Close sticker preview":zh("关闭贴纸预览","關閉貼紙預覽")} onPress={()=>setPreview(null)} style={{flex:1,backgroundColor:"rgba(77,64,92,.35)",alignItems:"center",justifyContent:"center"}}>{preview?<Image source={KEYBOARD_STICKERS[preview]} style={{width:240,height:260}} contentFit="contain"/>:null}</Pressable></KeyboardPortal></Modal>
    <Modal visible={noticesVisible} animationType="slide" onRequestClose={()=>setNoticesVisible(false)}><KeyboardPortal><View style={{flex:1,paddingTop:Math.max(24,safe.top),paddingBottom:safe.bottom,backgroundColor:"#FFFAF2"}}><Pressable accessibilityRole="button" accessibilityLabel={en?"Close notices":zh("关闭许可","關閉授權")} onPress={()=>setNoticesVisible(false)} style={{minHeight:44,paddingHorizontal:24,justifyContent:"center"}}><Text style={{color:INK}}>{en?"Done":"完成"}</Text></Pressable><ScrollView keyboardShouldPersistTaps="always" contentContainerStyle={{padding:24,gap:24}}>{thirdPartyNotices.components.map(component=><View key={component.name} style={{gap:8}}><Text style={{fontWeight:"600",color:INK}}>{component.name} · {component.version} · {component.license}</Text><Text selectable style={{fontSize:12,lineHeight:18,color:INK}}>{component.text}</Text></View>)}</ScrollView></View></KeyboardPortal></Modal>
  </View>;
}
const s=StyleSheet.create({
  toolbar:{paddingHorizontal:12,flexDirection:"row",alignItems:"center",justifyContent:"space-between"},
  row:{flexDirection:"row",alignItems:"center",justifyContent:"center",gap:6},
  key:{height:43,borderRadius:8.5,alignItems:"center",justifyContent:"center",overflow:"hidden",minWidth:0},
  keyText:{fontSize:28,color:"#000",textAlign:"center"},
});
