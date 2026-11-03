import {useState} from "react";
import {ActivityIndicator,Platform,Pressable,View,type ViewStyle} from "react-native";
import {Image} from "expo-image";
import {BlurView} from "expo-blur";
import {useT,translate} from "@/src/i18n";
import {FinalText} from "./Primitives";

/** The Figma room is an example, never source content. Render only the current
 * controller's validated thumbnail. A missing/failed preview remains a link. */
export function ReadingMedia({kind,uri,source,onPress,busy=false}:{kind:"post"|"video";uri?:string|null;source:string;onPress:()=>void;busy?:boolean}){
 const {locale}=useT(),c=(cn:string,en:string)=>locale==="en"?en:translate(locale,cn),video=kind==="video";
 const [failed,setFailed]=useState<ReadonlySet<string>>(()=>new Set());
 const show=Boolean(uri&&!failed.has(uri));
 return <Pressable testID={`daily-${kind}-source`} accessibilityRole="link" accessibilityLabel={video?c("在YouTube打开","Open in YouTube"):c("打开原站链接","Open original source")} accessibilityState={{busy,disabled:busy}} disabled={busy} onPress={onPress} style={{height:188,flexShrink:0,borderRadius:24,overflow:"hidden",backgroundColor:"#746B7E"}}>
  {show?<Image key={uri} testID={`daily-${kind}-thumbnail`} accessible={false} source={{uri:uri!}} recyclingKey={uri} cachePolicy="memory" contentFit="cover" transition={0} onError={()=>{if(uri)setFailed(previous=>new Set(previous).add(uri));}} style={{width:"100%",height:"100%"}}/>:
   <View testID={`daily-${kind}-thumbnail-unavailable`} style={{flex:1,justifyContent:"flex-end",padding:16,gap:6}}>
    <FinalText size={12} numberOfLines={1} style={{color:"rgba(255,255,255,.8)",paddingRight:video?0:48}}>{source}</FinalText>
    <FinalText size={14} style={{color:"white",lineHeight:20}}>{uri?c("缩略图暂时无法显示，点此打开原站。","Thumbnail unavailable. Tap to open the source."):video?c("视频未提供可用封面，点此在 YouTube 打开。","No video cover available. Tap to open YouTube."):c("原帖暂未提供缩略图，点此查看原帖。","No post thumbnail provided. Tap to view the original post.")}</FinalText>
   </View>}
  <View pointerEvents="none" testID={`daily-${kind}-media-control`} style={[{borderRadius:999,boxShadow:video?"0px 0px 10px rgba(0,0,0,.2)":"0px 0px 8px rgba(0,0,0,.2)"},video?{position:"absolute",left:"50%",top:"50%",width:58,height:58,transform:[{translateX:-29},{translateY:-29}]}:{position:"absolute",right:6,top:6,width:48,height:48}]}>
   <View style={{flex:1,borderRadius:999,overflow:"hidden",alignItems:"center",justifyContent:"center"}}>
    {Platform.OS==="web"?<View pointerEvents="none" testID={`daily-${kind}-media-blur`} style={{position:"absolute",top:0,bottom:0,left:0,right:0,borderRadius:999,backdropFilter:"blur(7.5px)"} as ViewStyle}/>:<BlurView pointerEvents="none" testID={`daily-${kind}-media-blur`} intensity={15} tint="light" style={{position:"absolute",top:0,bottom:0,left:0,right:0,borderRadius:999}}/>}
    <View pointerEvents="none" testID={`daily-${kind}-media-fill`} style={{position:"absolute",top:0,bottom:0,left:0,right:0,borderRadius:999,backgroundColor:"rgba(255,255,255,.3)"}}/>
    {busy?<ActivityIndicator color="white"/>:<Image testID={`daily-${kind}-media-icon`} accessible={false} source={video?require("@/assets/final-flow-20261101/reading-play.svg"):require("@/assets/final-flow-20261101/reading-source-arrow.svg")} tintColor={video?undefined:"#FFFFFF"} contentFit="contain" style={{width:24,height:24,transform:video?[]:[{rotate:"45deg"}]}}/>}
   </View>
  </View>
 </Pressable>;
}
