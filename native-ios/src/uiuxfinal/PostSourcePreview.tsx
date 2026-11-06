import {useEffect,useRef,useState} from "react";
import {ActivityIndicator,AppState,Pressable,StyleSheet,View} from "react-native";
import {WebView} from "react-native-webview";
import {externalSourceUrl} from "@/src/externalContent";
import {useT} from "@/src/i18n";
import {FinalText} from "./Primitives";

export type PostSourcePreviewProps={sourceUrl?:string|null;active?:boolean;onOpenSource:()=>void;busy?:boolean};
type Authority={uri:string|null;active:boolean;busy:boolean;onOpenSource:()=>void};

// No address bar is available in this small source region. Do not let a
// different public site inherit the original post's surrounding identity.
// Each social root is a separate family: even cross-platform/alias redirects
// require the user's explicit Open source action outside this preview.
const SOCIAL_SOURCE_ROOTS=["facebook.com","instagram.com","threads.net","threads.com","x.com","twitter.com"] as const;
export function allowPostSourceTopNavigation(sourceUrl:unknown,targetUrl:unknown):boolean{
 const source=externalSourceUrl(sourceUrl),target=externalSourceUrl(targetUrl);
 if(!source||!target)return false;
 const host=(url:string)=>new URL(url).hostname.toLowerCase().replace(/\.$/,"");
 const sourceHost=host(source),targetHost=host(target),withoutMobilePrefix=(value:string)=>value.replace(/^(www|m)\./,"");
 if(withoutMobilePrefix(sourceHost)===withoutMobilePrefix(targetHost))return true;
 const root=SOCIAL_SOURCE_ROOTS.find(value=>sourceHost===value||sourceHost.endsWith(`.${value}`));
 return !!root&&(targetHost===root||targetHost.endsWith(`.${root}`));
}

function copy(locale:string){
 if(locale==="en")return {unavailable:"No safe original-post link is available.",paused:"Original-post preview is paused.",loading:"Loading the original site…",error:"The original site could not be displayed here.",retry:"Retry",open:"Open source"};
 if(locale==="zh-TW")return {unavailable:"原帖未提供可安全預覽的連結。",paused:"原帖預覽已暫停，返回頁面後重新載入。",loading:"正在載入原站…",error:"暫時無法在此顯示原帖。",retry:"重試",open:"開啟原站"};
 return {unavailable:"原帖未提供可安全预览的链接。",paused:"原帖预览已暂停，返回页面后重新加载。",loading:"正在加载原站…",error:"暂时无法在此显示原帖。",retry:"重试",open:"打开原站"};
}

/** An isolated remote page, not an image, copied article or authenticated NURI
 * browser. Removing the child destroys its page/JS/media when not foreground. */
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
   <NativePostSession key={`${uri}:${generation}`} uri={uri} locale={locale} live={live} onOpenSource={open} busy={busy}/>}
 </View>;
}

function NativePostSession({uri,locale,live,onOpenSource,busy}:{uri:string;locale:string;live:(uri:string)=>boolean;onOpenSource:()=>void;busy:boolean}){
 const [phase,setPhase]=useState<"loading"|"load-event"|"error">("loading"),[attempt,setAttempt]=useState(0);
 const mounted=useRef(true),operation=useRef(0),topUrl=useRef(uri),currentBusy=useRef(busy);
 currentBusy.current=busy;
 const ticket=attempt,text=copy(locale);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 const current=()=>mounted.current&&operation.current===ticket&&live(uri);
 const fail=()=>{if(current())setPhase("error");};
 const isCurrentPage=(url:string)=>!url||externalSourceUrl(url)===topUrl.current;
 const retry=()=>{
  if(!current()||currentBusy.current)return;
  operation.current++;topUrl.current=uri;setAttempt(operation.current);setPhase("loading");
 };
 const open=()=>{if(current()&&!currentBusy.current)onOpenSource();};
 return <View style={s.frame}>
  {phase==="error"?<View testID="post-source-error" style={s.state}>
   <FinalText size={12} style={s.stateText}>{text.error}</FinalText>
   <View style={s.buttons}>
    <Pressable testID="post-source-retry" accessibilityRole="button" accessibilityLabel={text.retry} accessibilityState={{disabled:busy}} disabled={busy} onPress={retry} style={s.button}><FinalText size={12} style={s.buttonText}>{text.retry}</FinalText></Pressable>
    <Pressable testID="post-source-open" accessibilityRole="link" accessibilityLabel={text.open} accessibilityState={{disabled:busy,busy}} disabled={busy} onPress={open} style={s.button}><FinalText size={12} style={s.buttonText}>{text.open}</FinalText></Pressable>
   </View>
  </View>:<WebView
   key={`${uri}:${attempt}`}
   testID="post-source-webview"
   source={{uri}}
   originWhitelist={["*"]}
   onShouldStartLoadWithRequest={request=>{
    // Whitelist all origins only to prevent the library's automatic Linking
    // fallback. Every navigation still needs this explicit HTTPS validation.
    if(!current())return false;
    const safe=externalSourceUrl(request.url);
    if(!safe){if(request.isTopFrame!==false)fail();return false;}
    if(request.isTopFrame!==false){
     if(!allowPostSourceTopNavigation(uri,safe)){fail();return false;}
     topUrl.current=safe;
    }
    return true;
   }}
   // The installed native implementation cancels a target=_blank navigation
   // when this callback exists. Never infer a user gesture from targetUrl.
   onOpenWindow={()=>{}}
   onFileDownload={fail}
   javaScriptEnabled
   javaScriptCanOpenWindowsAutomatically={false}
   scrollEnabled nestedScrollEnabled
   mediaPlaybackRequiresUserAction
   allowsInlineMediaPlayback
   allowsPictureInPictureMediaPlayback={false}
   allowsAirPlayForMediaPlayback={false}
   allowsFullscreenVideo={false}
   mediaCapturePermissionGrantType="deny"
   geolocationEnabled={false}
   incognito sharedCookiesEnabled={false} thirdPartyCookiesEnabled={false} useSharedProcessPool={false}
   cacheEnabled={false} cacheMode="LOAD_NO_CACHE" saveFormDataDisabled
   allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
   mixedContentMode="never"
   setSupportMultipleWindows
   allowsBackForwardNavigationGestures={false} allowsLinkPreview={false}
   keyboardDisplayRequiresUserAction
   paymentRequestEnabled={false} enableApplePay={false}
   webviewDebuggingEnabled={false}
   dataDetectorTypes="none"
   automaticallyAdjustContentInsets={false} contentInsetAdjustmentBehavior="never"
   onLoadStart={({nativeEvent})=>{if(current()&&isCurrentPage(nativeEvent.url))setPhase(previous=>previous==="error"?previous:"loading");}}
   onLoad={({nativeEvent})=>{
    if(current()&&isCurrentPage(nativeEvent.url))setPhase(previous=>previous==="error"?previous:"load-event");
   }}
   onError={({nativeEvent})=>{if(isCurrentPage(nativeEvent.url))fail();}}
   onHttpError={({nativeEvent})=>{if(nativeEvent.statusCode>=400&&isCurrentPage(nativeEvent.url))fail();}}
   onContentProcessDidTerminate={fail}
   onRenderProcessGone={fail}
   renderError={()=><View style={s.browser}/>}
   containerStyle={s.browser}
   style={s.browser}
  />}
  {phase==="loading"?<View pointerEvents="none" testID="post-source-loading" accessibilityRole="progressbar" accessibilityLabel={text.loading} style={s.loading}><ActivityIndicator color="#746B7E"/><FinalText size={12} style={s.stateText}>{text.loading}</FinalText></View>:null}
 </View>;
}

// The parent owns the188pt/r24 clip. There is intentionally no JS injection,
// onMessage bridge, request header, login flow or OS URL-opening capability.
// geolocationEnabled is Android-only in this library; iOS system/site prompts
// are not programmable here. No permission is requested or auto-granted by NURI.
const s=StyleSheet.create({
 frame:{width:"100%",height:"100%",minWidth:0,minHeight:0,position:"relative",backgroundColor:"#FFFAF2"},
 browser:{width:"100%",height:"100%",minWidth:0,minHeight:0,backgroundColor:"#FFFAF2"},
 state:{flex:1,justifyContent:"center",paddingHorizontal:12,paddingVertical:12,gap:6,backgroundColor:"#FFFAF2"},
 stateText:{textAlign:"center",lineHeight:18,color:"#706A74"},
 buttons:{flexDirection:"row",justifyContent:"center",gap:8},
 button:{minHeight:44,minWidth:88,paddingHorizontal:12,alignItems:"center",justifyContent:"center",borderRadius:22,backgroundColor:"#F3E7E1"},
 buttonText:{textAlign:"center",color:"#746B7E"},
 loading:{...StyleSheet.absoluteFillObject,alignItems:"center",justifyContent:"center",paddingHorizontal:16,gap:6,backgroundColor:"rgba(255,250,242,.94)"},
});
