import {useEffect,useRef,useState} from "react";
import {ActivityIndicator,AppState,Pressable,View} from "react-native";
import {Image} from "expo-image";
import {useT,translate} from "@/src/i18n";
import {FinalText} from "./Primitives";
import {externalSourceUrl} from "@/src/externalContent";
import {socialPostThumbnail} from "@/src/recommendationMedia";
import {ButtonBackdrop} from "./ButtonMaterial";

function postCopy(locale:string){
 if(locale==="en")return {missing:"The source did not provide a usable thumbnail. Open the original post with the arrow.",failed:"The thumbnail is unavailable. Open the original post with the arrow; sign-in may be required.",unsafe:"No safe original-post link is available.",paused:"Post preview is paused.",loading:"Loading the source thumbnail…"};
 if(locale==="zh-TW")return {missing:"原站未提供可用縮圖，點右上角箭頭查看原帖。",failed:"縮圖暫時無法顯示，點右上角箭頭查看原帖，可能需要登入。",unsafe:"原帖未提供可安全開啟的連結。",paused:"原帖預覽已暫停。",loading:"正在載入原站縮圖…"};
 return {missing:"原站未提供可用缩略图，点右上角箭头查看原帖。",failed:"缩略图暂时无法显示，点右上角箭头查看原帖，可能需要登录。",unsafe:"原帖未提供可安全打开的链接。",paused:"原帖预览已暂停。",loading:"正在加载原站缩略图…"};
}

/** Use only this post's feed-supplied public image metadata. A provider page
 * is not an image: never embed/scrape it or invent a cover when none exists.
 * Videos retain their own validated cover and direct YouTube action. */
export function ReadingMedia({kind,uri,uris,sourceUrl,active=true,source,onPress,busy=false}:{kind:"post"|"video";uri?:string|null;uris?:readonly string[];sourceUrl?:string|null;active?:boolean;source:string;onPress:()=>void;busy?:boolean}){
 const {locale}=useT(),c=(cn:string,en:string)=>locale==="en"?en:translate(locale,cn),video=kind==="video";
 const [failed,setFailed]=useState<ReadonlySet<string>>(()=>new Set());
 const [loaded,setLoaded]=useState<ReadonlySet<string>>(()=>new Set());
 const show=Boolean(uri&&!failed.has(uri));
 const pageUrl=externalSourceUrl(sourceUrl);
 const postCandidates=[...new Set((uris??[uri]).map(value=>socialPostThumbnail(value,pageUrl)).filter((value):value is string=>Boolean(value)))].slice(0,2);
 const thumbnail=postCandidates.find(value=>!failed.has(value)),post=postCopy(locale);
 const foregroundRef=useRef(AppState.currentState==="active"),mounted=useRef(true);
 const [foreground,setForeground]=useState(foregroundRef.current);
 const [,setForegroundEpoch]=useState(0);
 const lifetime=useRef({key:"",revision:0});
 const authority=useRef({pageUrl,active,busy,onPress});authority.current={pageUrl,active,busy,onPress};
 const key=JSON.stringify([kind,pageUrl,active,thumbnail]);
 if(lifetime.current.key!==key){lifetime.current={key,revision:lifetime.current.revision+1};}
 const revision=lifetime.current.revision;
 const current=()=>mounted.current&&lifetime.current.revision===revision&&foregroundRef.current&&authority.current.active;
 useEffect(()=>{
  mounted.current=true;
  if(video)return()=>{mounted.current=false;};
  // Preserve the original source preview's foreground-only lifecycle without
  // mounting a remote webpage or giving it app credentials/cookies.
  const listener=AppState.addEventListener("change",state=>{
   foregroundRef.current=state==="active";
   if(!foregroundRef.current){lifetime.current.revision++;setForegroundEpoch(value=>value+1);}
   setForeground(foregroundRef.current);
  });
  foregroundRef.current=AppState.currentState==="active";setForeground(foregroundRef.current);
  return()=>{mounted.current=false;listener.remove();};
 },[video]);
 const showPost=active&&foreground&&Boolean(thumbnail),loadingPost=!video&&showPost&&!loaded.has(thumbnail!);
 useEffect(()=>{
  if(!loadingPost||!thumbnail)return;
  // Two supplied candidates, one bounded attempt each: no polling, scraping,
  // automatic source navigation or permanently spinning empty embed.
  const timer=setTimeout(()=>{if(current())setFailed(previous=>new Set(previous).add(thumbnail));},12000);
  return()=>clearTimeout(timer);
 },[loadingPost,thumbnail,revision]);
 const openPost=()=>{if(pageUrl&&current()&&!authority.current.busy)authority.current.onPress();};
 if(!video)return <View testID="daily-post-media-region" style={{height:showPost?188:undefined,minHeight:showPost?undefined:96,width:"100%",minWidth:0,maxWidth:"100%",flexShrink:0,borderRadius:24,overflow:"hidden",backgroundColor:"#FFFAF2"}}>
  {showPost?<Image key={`${thumbnail}:${revision}`} testID="daily-post-thumbnail" accessible={false} source={{uri:thumbnail!}} recyclingKey={thumbnail} cachePolicy="memory" contentFit="cover" transition={0}
   onLoad={()=>{if(thumbnail&&current())setLoaded(previous=>new Set(previous).add(thumbnail));}}
   onError={()=>{if(thumbnail&&current())setFailed(previous=>new Set(previous).add(thumbnail));}}
   style={{width:"100%",height:"100%"}}/>:
   <View testID={active&&foreground?"daily-post-thumbnail-unavailable":"daily-post-thumbnail-paused"} style={{minHeight:96,justifyContent:"center",padding:16,paddingRight:64}}>
    <FinalText size={12} style={{color:"#706A74",lineHeight:18}}>{!active||!foreground?post.paused:!pageUrl?post.unsafe:postCandidates.length?post.failed:post.missing}</FinalText>
   </View>}
  {loadingPost?<View pointerEvents="none" testID="daily-post-thumbnail-loading" accessibilityRole="progressbar" accessibilityLabel={post.loading} style={{position:"absolute",top:0,left:0,bottom:0,right:0,alignItems:"center",justifyContent:"center",backgroundColor:"#FFFAF2"}}><ActivityIndicator color="#746B7E"/></View>:null}
  <View testID="daily-post-media-control" style={{position:"absolute",right:6,top:6,width:48,height:48,borderRadius:999,boxShadow:"0px 0px 8px rgba(0,0,0,.2)"}}>
   <Pressable testID="daily-post-source" accessibilityRole="link" accessibilityLabel={c("打开原站链接","Open original source")} accessibilityState={{busy,disabled:busy||!pageUrl||!active||!foreground}} disabled={busy||!pageUrl||!active||!foreground} onPress={openPost} style={{flex:1,borderRadius:999,overflow:"hidden",alignItems:"center",justifyContent:"center"}}>
    <ButtonBackdrop testID="daily-post-media-blur" color="rgba(255,255,255,.3)" radius={999} blurRadius={40}/>
    {busy?<ActivityIndicator color={showPost?"white":"#746B7E"}/>:<Image testID="daily-post-media-icon" accessible={false} source={require("@/assets/final-flow-20261101/reading-source-arrow.svg")} tintColor={showPost?"#FFFFFF":"#746B7E"} contentFit="contain" style={{width:24,height:24,transform:[{rotate:"45deg"}]}}/>}
   </Pressable>
  </View>
 </View>;
 return <Pressable testID={`daily-${kind}-source`} accessibilityRole="link" accessibilityLabel={video?c("在YouTube打开","Open in YouTube"):c("打开原站链接","Open original source")} accessibilityState={{busy,disabled:busy}} disabled={busy} onPress={onPress} style={{height:188,flexShrink:0,borderRadius:24,overflow:"hidden",backgroundColor:"#746B7E"}}>
  {show?<Image key={uri} testID={`daily-${kind}-thumbnail`} accessible={false} source={{uri:uri!}} recyclingKey={uri} cachePolicy="memory" contentFit="cover" transition={0} onError={()=>{if(uri)setFailed(previous=>new Set(previous).add(uri));}} style={{width:"100%",height:"100%"}}/>:
   <View testID={`daily-${kind}-thumbnail-unavailable`} style={{flex:1,justifyContent:"flex-end",padding:16,gap:6}}>
    <FinalText size={12} numberOfLines={1} style={{color:"rgba(255,255,255,.8)",paddingRight:video?0:48}}>{source}</FinalText>
    <FinalText size={14} style={{color:"white",lineHeight:20}}>{uri?c("缩略图暂时无法显示，点此打开原站。","Thumbnail unavailable. Tap to open the source."):c("视频未提供可用封面，点此在 YouTube 打开。","No video cover available. Tap to open YouTube.")}</FinalText>
   </View>}
  <View pointerEvents="none" testID={`daily-${kind}-media-control`} style={[{borderRadius:999,boxShadow:video?"0px 0px 10px rgba(0,0,0,.2)":"0px 0px 8px rgba(0,0,0,.2)"},video?{position:"absolute",left:"50%",top:"50%",width:58,height:58,transform:[{translateX:-29},{translateY:-29}]}:{position:"absolute",right:6,top:6,width:48,height:48}]}>
   <View style={{flex:1,borderRadius:999,overflow:"hidden",alignItems:"center",justifyContent:"center"}}>
    <ButtonBackdrop testID={`daily-${kind}-media-blur`} color="rgba(255,255,255,.3)" radius={999} blurRadius={40}/>
    {busy?<ActivityIndicator color="white"/>:<Image testID={`daily-${kind}-media-icon`} accessible={false} source={video?require("@/assets/final-flow-20261101/reading-play.svg"):require("@/assets/final-flow-20261101/reading-source-arrow.svg")} tintColor={video?undefined:"#FFFFFF"} contentFit="contain" style={{width:24,height:24,transform:video?[]:[{rotate:"45deg"}]}}/>}
   </View>
  </View>
 </Pressable>;
}
