import {useState} from "react";
import {ActivityIndicator,Pressable,View} from "react-native";
import {Image} from "expo-image";
import {useT,translate} from "@/src/i18n";
import {FinalText} from "./Primitives";
import {PostSourcePreview} from "./PostSourcePreview";
import {externalSourceUrl} from "@/src/externalContent";
import {ButtonBackdrop} from "./ButtonMaterial";

/** Posts are the original live webpage, not an image/fabricated source card.
 * Videos retain their own validated cover and direct YouTube action. */
export function ReadingMedia({kind,uri,sourceUrl,active=true,source,onPress,busy=false}:{kind:"post"|"video";uri?:string|null;sourceUrl?:string|null;active?:boolean;source:string;onPress:()=>void;busy?:boolean}){
 const {locale}=useT(),c=(cn:string,en:string)=>locale==="en"?en:translate(locale,cn),video=kind==="video";
 const [failed,setFailed]=useState<ReadonlySet<string>>(()=>new Set());
 const show=Boolean(uri&&!failed.has(uri));
 const pageUrl=externalSourceUrl(sourceUrl);
 if(!video)return <View testID="daily-post-browser-region" style={{height:188,width:"100%",minWidth:0,maxWidth:"100%",flexShrink:0,borderRadius:24,overflow:"hidden",backgroundColor:"#FFFAF2"}}>
  <PostSourcePreview key={pageUrl??"missing-source"} sourceUrl={pageUrl} active={active} onOpenSource={onPress} busy={busy}/>
  <View testID="daily-post-media-control" style={{position:"absolute",right:6,top:6,width:48,height:48,borderRadius:999,boxShadow:"0px 0px 8px rgba(0,0,0,.2)"}}>
   <Pressable testID="daily-post-source" accessibilityRole="link" accessibilityLabel={c("打开原站链接","Open original source")} accessibilityState={{busy,disabled:busy||!pageUrl}} disabled={busy||!pageUrl} onPress={onPress} style={{flex:1,borderRadius:999,overflow:"hidden",alignItems:"center",justifyContent:"center"}}>
    <ButtonBackdrop testID="daily-post-media-blur" color="rgba(255,255,255,.3)" radius={999} blurRadius={40}/>
    {busy?<ActivityIndicator color="white"/>:<Image testID="daily-post-media-icon" accessible={false} source={require("@/assets/final-flow-20261101/reading-source-arrow.svg")} tintColor="#FFFFFF" contentFit="contain" style={{width:24,height:24,transform:[{rotate:"45deg"}]}}/>}
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
