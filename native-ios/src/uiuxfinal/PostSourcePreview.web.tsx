import {useEffect,useRef,useState} from "react";
import {ActivityIndicator,AppState,Pressable,StyleSheet,View} from "react-native";
import {externalSourceUrl} from "@/src/externalContent";
import {useT} from "@/src/i18n";
import {FinalText} from "./Primitives";
import type {PostSourcePreviewProps} from "./PostSourcePreview";

type Authority={uri:string|null;active:boolean;busy:boolean;onOpenSource:()=>void};
function copy(locale:string){
 if(locale==="en")return {unavailable:"No safe original-post link is available.",paused:"Original-post preview is paused.",loading:"Loading the original site…",error:"The original site could not be displayed here.",retry:"Retry",open:"Open source"};
 if(locale==="zh-TW")return {unavailable:"原帖未提供可安全預覽的連結。",paused:"原帖預覽已暫停，返回頁面後重新載入。",loading:"正在載入原站…",error:"暫時無法在此顯示原帖。",retry:"重試",open:"開啟原站"};
 return {unavailable:"原帖未提供可安全预览的链接。",paused:"原帖预览已暂停，返回页面后重新加载。",loading:"正在加载原站…",error:"暂时无法在此显示原帖。",retry:"重试",open:"打开原站"};
}

/** Browser-only sandbox. No proxy, rewritten HTML, cross-origin DOM read or
 * injected script can bypass the original site's CSP/frame-ancestor policy. */
export function PostSourcePreview({sourceUrl,active=true,onOpenSource,busy=false}:PostSourcePreviewProps){
 const {locale}=useT(),uri=externalSourceUrl(sourceUrl),text=copy(locale);
 const foregroundRef=useRef(AppState.currentState==="active"),mounted=useRef(true);
 const [foreground,setForeground]=useState(foregroundRef.current);
 const backgroundGeneration=useRef(0),[generation,setGeneration]=useState(0);
 const authority=useRef<Authority>({uri,active,busy,onOpenSource});
 authority.current={uri,active,busy,onOpenSource};
 useEffect(()=>{
  mounted.current=true;
  const listener=AppState.addEventListener("change",state=>{
   foregroundRef.current=state==="active";
   if(!foregroundRef.current){backgroundGeneration.current++;setGeneration(backgroundGeneration.current);}
   setForeground(foregroundRef.current);
  });
  foregroundRef.current=AppState.currentState==="active";setForeground(foregroundRef.current);
  return()=>{mounted.current=false;foregroundRef.current=false;listener.remove();};
 },[]);
 const live=(candidate:string)=>mounted.current&&authority.current.uri===candidate&&authority.current.active&&foregroundRef.current&&backgroundGeneration.current===generation;
 const open=()=>{if(uri&&live(uri)&&!authority.current.busy)authority.current.onOpenSource();};
 return <View testID="post-source-preview" style={s.frame}>
  {!uri?<View testID="post-source-unavailable" style={s.state}><FinalText size={12} style={s.stateText}>{text.unavailable}</FinalText></View>:
   !active||!foreground?<View testID="post-source-paused" style={s.state}><FinalText size={12} style={s.stateText}>{text.paused}</FinalText></View>:
   <BrowserPostSession key={`${uri}:${generation}`} uri={uri} locale={locale} live={live} onOpenSource={open} busy={busy}/>}
 </View>;
}

function BrowserPostSession({uri,locale,live,onOpenSource,busy}:{uri:string;locale:string;live:(uri:string)=>boolean;onOpenSource:()=>void;busy:boolean}){
 const [phase,setPhase]=useState<"loading"|"load-event"|"error">("loading"),[attempt,setAttempt]=useState(0);
 const mounted=useRef(true),operation=useRef(0),currentBusy=useRef(busy);
 currentBusy.current=busy;
 const ticket=attempt,text=copy(locale);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 const current=()=>mounted.current&&operation.current===ticket&&live(uri);
 const retry=()=>{if(current()&&!currentBusy.current){operation.current++;setAttempt(operation.current);setPhase("loading");}};
 const open=()=>{if(current()&&!currentBusy.current)onOpenSource();};
 return <View style={s.frame}>
  {phase==="error"?<View testID="post-source-error" style={s.state}>
   <FinalText size={12} style={s.stateText}>{text.error}</FinalText>
   <View style={s.buttons}>
    <Pressable testID="post-source-retry" accessibilityRole="button" accessibilityLabel={text.retry} accessibilityState={{disabled:busy}} disabled={busy} onPress={retry} style={s.button}><FinalText size={12} style={s.buttonText}>{text.retry}</FinalText></Pressable>
    <Pressable testID="post-source-open" accessibilityRole="link" accessibilityLabel={text.open} accessibilityState={{disabled:busy,busy}} disabled={busy} onPress={open} style={s.button}><FinalText size={12} style={s.buttonText}>{text.open}</FinalText></Pressable>
   </View>
  </View>:<iframe
   key={`${uri}:${attempt}`}
   data-testid="post-source-iframe"
   title={locale==="en"?"Original post":locale==="zh-TW"?"原帖網頁":"原帖网页"}
   src={uri}
   // No same-origin, forms, downloads, popups or top-navigation permission.
   sandbox="allow-scripts"
   allow="camera 'none'; microphone 'none'; geolocation 'none'; autoplay 'none'; fullscreen 'none'; payment 'none'; clipboard-read 'none'; clipboard-write 'none'"
   referrerPolicy="no-referrer"
   // An extra isolation request where supported, not a universal incognito
   // guarantee. Never pass NURI cookies, tokens or credentials to the frame.
   {...{credentialless:""}}
   onLoad={()=>{if(current())setPhase(previous=>previous==="error"?previous:"load-event");}}
   onError={()=>{if(current())setPhase("error");}}
   style={{display:"block",width:"100%",height:"100%",border:0,backgroundColor:"#FFFAF2"}}
  />}
  {phase==="loading"?<View pointerEvents="none" testID="post-source-loading" accessibilityRole="progressbar" accessibilityLabel={text.loading} style={s.loading}><ActivityIndicator color="#746B7E"/><FinalText size={12} style={s.stateText}>{text.loading}</FinalText></View>:null}
  {/* Browsers can emit load even when X-Frame-Options/CSP blocks display.
      Never label that event as a successfully rendered or verified original. */}
 </View>;
}

const s=StyleSheet.create({
 frame:{width:"100%",height:"100%",minWidth:0,minHeight:0,position:"relative",backgroundColor:"#FFFAF2"},
 state:{flex:1,justifyContent:"center",paddingHorizontal:12,paddingVertical:12,gap:6,backgroundColor:"#FFFAF2"},
 stateText:{textAlign:"center",lineHeight:18,color:"#706A74"},
 buttons:{flexDirection:"row",justifyContent:"center",gap:8},
 button:{minHeight:44,minWidth:88,paddingHorizontal:12,alignItems:"center",justifyContent:"center",borderRadius:22,backgroundColor:"#F3E7E1"},
 buttonText:{textAlign:"center",color:"#746B7E"},
 loading:{...StyleSheet.absoluteFillObject,alignItems:"center",justifyContent:"center",paddingHorizontal:16,gap:6,backgroundColor:"rgba(255,250,242,.94)"},
});
