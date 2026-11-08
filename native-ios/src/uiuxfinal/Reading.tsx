import {useState,type ReactNode} from "react";
import {ActivityIndicator,Pressable,ScrollView,View,useWindowDimensions} from "react-native";
import {Image} from "expo-image";
import {useSafeAreaInsets} from "react-native-safe-area-context";
import {useT,translate} from "@/src/i18n";
import {FinalSurface,FinalText,FINAL_COLOR} from "./Primitives";
import {ReadingMedia} from "./ReadingMedia";

/** Original 402pt footer illustration, mask slot and shadow-inclusive SVG.
 * Scale only this fixed artwork group; card text remains responsive native UI. */
export function ReadingTalkAction({label,busy,onPress,testID}:{label:string;busy:boolean;onPress:()=>void;testID:string}){
 const {width,fontScale=1}=useWindowDimensions(),scale=Math.min(width,402)/402;
 // Keep the exact default-size artwork, but reserve two scaled text lines at
 // accessibility sizes. The original SVG file/viewBox is never rewritten.
 const extra=Math.max(0,Math.ceil(48*fontScale+20)-68);
 return <View testID="final-reading-talk-dock" style={{width:402*scale,height:(89+extra)*scale,alignSelf:"center",flexShrink:0}}>
  <View style={{width:402,height:89+extra,transform:[{scale}],transformOrigin:"top left"}}>
   <Image accessible={false} source={require("@/assets/final-flow-20261101/reading-avatar-background.svg")} contentFit="contain" style={{position:"absolute",left:19,top:11+extra/2,width:70,height:70}}/>
   <View testID="final-reading-avatar-mask" style={{position:"absolute",left:25,top:24+extra/2,width:57,height:57,borderRadius:28.5,overflow:"hidden"}}>
    <Image accessible={false} source={require("@/assets/final-flow-20261101/reading-avatar.png")} contentFit="fill" style={{position:"absolute",left:-6.609,top:-1.652,width:77.652,height:96.652}}/>
   </View>
   <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{busy,disabled:busy}} disabled={busy} onPress={onPress} testID={testID} style={{position:"absolute",left:95,top:12,width:296,minHeight:68+extra,justifyContent:"center",paddingLeft:23,paddingRight:10,paddingVertical:10,opacity:busy?.65:1}}>
    <Image accessible={false} pointerEvents="none" source={require("@/assets/final-flow-20261101/reading-talk-bubble.svg")} contentFit={extra?"fill":"contain"} style={{position:"absolute",left:-15,top:-14,width:326,height:98+extra}}/>
    {busy?<ActivityIndicator color="white"/>:<FinalText size={16} numberOfLines={2} style={{color:"white",lineHeight:24}}>{label}</FinalText>}
   </Pressable>
  </View>
 </View>;
}

export function ReadingStep({index,children,testID}:{index:number;children:ReactNode;testID?:string}){
 return <View testID={testID} style={{flexDirection:"row",gap:16,alignItems:"flex-start"}}>
  <FinalText size={24} style={{width:36,lineHeight:32,color:FINAL_COLOR.accent,fontWeight:"500"}}>{String(index+1).padStart(2,"0")}</FinalText>
  <View style={{flex:1,minWidth:0,gap:6}}>{children}</View>
 </View>;
}

/** Presentation only. Controllers retain source validation, request guards,
 * permission handling, summary provenance and the real linked-chat operation. */
export function FinalReadingPage({kind,title,source,mediaUrl,mediaUrls,sourceUrl,sourceActive=true,onSource,sourceBusy=false,onTalk,busy,talkLabel,allowSavePreview=false,notice,children}:{
 kind:"post"|"video";title:string;source:string;onSource:()=>void;sourceBusy?:boolean;
 mediaUrl?:string|null;mediaUrls?:readonly string[];sourceUrl?:string|null;sourceActive?:boolean;
 onTalk:()=>void;busy:boolean;talkLabel:string;allowSavePreview?:boolean;notice?:ReactNode;children:ReactNode;
}){
 const {locale}=useT(),c=(cn:string,en:string)=>locale==="en"?en:translate(locale,cn);
 const [saved,setSaved]=useState(false),safe=useSafeAreaInsets(),video=kind==="video";
 return <View testID={video?"final-video-reading":"daily-post-question"} style={{flex:1,minHeight:0,paddingTop:19,paddingBottom:Math.max(26,safe.bottom-8),gap:video?22:19}}>
  <FinalSurface fill material="reading" testID={video?"final-video-card":"final-article-card"} style={{marginHorizontal:12,width:"auto",maxWidth:500,alignSelf:"stretch"}}>
   <ScrollView style={{flex:1,minHeight:0}} contentContainerStyle={{paddingTop:24,paddingBottom:24,paddingHorizontal:video?22.5:25,gap:16}} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" testID={video?"final-video-scroll":"final-article-scroll"}>
    {notice}
    <View style={{paddingRight:allowSavePreview?36:0,minHeight:32}}>
     <FinalText testID={video?"daily-video-external-title":undefined} size={24} style={{lineHeight:32,fontWeight:"500",fontFamily:locale==="zh-CN"?"NotoSansSC_500Medium":undefined}}>{title}</FinalText>
     {allowSavePreview?<Pressable testID={video?"final-video-save-preview":"final-article-save-preview"} accessibilityRole="checkbox" accessibilityState={{checked:saved}} aria-checked={saved} accessibilityLabel={c("收藏状态预览（不保存到云端）","Preview saved state (not saved to cloud)")} onPress={()=>setSaved(v=>!v)} style={{position:"absolute",right:-10,top:-10,width:44,height:44,alignItems:"center",justifyContent:"center",opacity:saved?.5:1}}><Image accessible={false} source={require("@/assets/final-flow-20261101/heart.png")} style={{width:24,height:24}} contentFit="contain"/></Pressable>:null}
    </View>
    {video?<FinalText size={12} secondary>{source}</FinalText>:<Pressable testID="daily-post-source-caption" accessibilityRole="link" accessibilityLabel={c("打开原站链接","Open original source")} disabled={sourceBusy} onPress={onSource} hitSlop={{top:10,bottom:10}}><FinalText size={12} style={{color:FINAL_COLOR.accent}}>{source}</FinalText></Pressable>}
    <ReadingMedia kind={kind} uri={mediaUrl} uris={mediaUrls} sourceUrl={sourceUrl} active={sourceActive} source={source} busy={sourceBusy} onPress={onSource}/>
    {children}
   </ScrollView>
  </FinalSurface>
  <ReadingTalkAction label={talkLabel} busy={busy} onPress={onTalk} testID={video?"daily-video-chat":"daily-post-chat"}/>
 </View>;
}
