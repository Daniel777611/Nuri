import { useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";
import { Image } from "expo-image";
import { IconAction, NuriIcon } from "@/src/uiux48/Primitives";
import { NuriAvatar } from "@/src/uiux48/Scene";
import { useT, translate } from "@/src/i18n";
import { FinalDivider, FinalSurface, FinalText, FINAL_COLOR } from "./Primitives";

/** Presents supplied content only. No invented article, summary, or save API. */
export function FinalArticle({title,source,summary,points,notes,onSource,onTalk,busy,notice,allowSavePreview=false}:{
  title:string;source:string;summary:string|null;points:string[];notes:string[];
  onSource:()=>void;onTalk:()=>void;busy:boolean;notice?:ReactNode;allowSavePreview?:boolean;
}){
  const {locale}=useT(),en=locale==="en";
  const [savedPreview,setSavedPreview]=useState(false);
  const c=(cn:string,english:string)=>en?english:translate(locale,cn);
  return <View testID="daily-post-question" style={{flex:1,minHeight:0,paddingHorizontal:12,paddingTop:16,paddingBottom:34,gap:24}}>
    <FinalSurface fill testID="final-article-card">
      <ScrollView style={{flex:1,minHeight:0}} contentContainerStyle={{padding:24,gap:16}} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" testID="final-article-scroll">
        {notice}
        <View style={{flexDirection:"row",gap:8,alignItems:"flex-start"}}>
          <FinalText size={22} style={{fontWeight:"600",lineHeight:30,flex:1}}>{title}</FinalText>
          {allowSavePreview?<IconAction name="heart" label={c("收藏流程预览（不保存到云端）","Preview saving (not saved to cloud)")} onPress={()=>setSavedPreview(v=>!v)} testID="final-article-save-preview"/>:null}
        </View>
        {savedPreview?<FinalText size={12} secondary testID="final-article-save-note">{c("收藏状态演示，尚未同步到云端。","Saved-state preview only; not synced to the cloud.")}</FinalText>:null}
        <FinalText size={12} style={{color:FINAL_COLOR.accent}}>{source}</FinalText>
        <View style={{height:188,borderRadius:24,overflow:"hidden"}}>
          <Image source={require("@/assets/final-flow-20261101/article-illustration.png")} contentFit="cover" accessibilityLabel={c("文章插画","Article illustration")} style={{width:"100%",height:"100%"}}/>
          <Pressable style={{position:"absolute",right:4,top:4,width:44,height:44,alignItems:"center",justifyContent:"center",backgroundColor:"rgba(255,255,255,.5)",borderRadius:22}} accessibilityRole="link" accessibilityLabel={c("打开原站链接","Open original source")} onPress={onSource} testID="daily-post-source"><NuriIcon name="expand"/></Pressable>
        </View>
        <FinalText testID="daily-post-summary-situation">{summary||c("这条资源暂时没有可用摘要，请打开原站查看。","No summary is available for this resource. Open the original source.")}</FinalText>
        <FinalDivider/><FinalText size={12} secondary>{c("Nuri 整理","Organised by Nuri")}</FinalText>
        {points.map((point,i)=><View key={i} style={{flexDirection:"row",gap:16}} testID={`daily-post-summary-point-${i}`}><FinalText size={24} style={{color:FINAL_COLOR.accent,lineHeight:32}}>{String(i+1).padStart(2,"0")}</FinalText><FinalText style={{flex:1}}>{point}</FinalText></View>)}
        {notes.filter(Boolean).map((note,i)=><FinalText key={i} size={12} secondary testID={i===0?"daily-post-summary-disclosure":undefined}>{note}</FinalText>)}
      </ScrollView>
    </FinalSurface>
    <View style={{flexDirection:"row",gap:8,paddingHorizontal:6,alignItems:"center"}}>
      <NuriAvatar size={60}/><Pressable disabled={busy} accessibilityRole="button" testID="daily-post-chat" onPress={onTalk} style={{flex:1,minHeight:60,borderRadius:30,paddingHorizontal:20,paddingVertical:16,backgroundColor:"#B78EA8",alignItems:"center",justifyContent:"center",opacity:busy?.6:1}}>
        {busy?<ActivityIndicator color="white"/>:<FinalText size={14} style={{color:"white"}}>{c("和我聊聊你家的情况吗？","Shall we talk about your family?")}</FinalText>}
      </Pressable>
    </View>
  </View>;
}
