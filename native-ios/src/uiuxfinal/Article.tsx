import type {ReactNode} from "react";
import {Pressable,View} from "react-native";
import {useT,translate} from "@/src/i18n";
import {FinalText} from "./Primitives";
import {FinalReadingPage,ReadingStep} from "./Reading";

/** Supplied summaries only; never a fabricated article or a new save API. */
export type ArticleSource = {n:number;title:string;label:string;url:string};

export function FinalArticle({title,source,sourceUrl,mediaUrls,sourceActive=true,summary,points,
 hideMedia=false,reason,pointSources,sources,onOpenSource,onSource,onTalk,busy,sourceBusy=false,notice,allowSavePreview=false}:{
 title:string;source:string;summary:string|null;points:string[];
 sourceUrl?:string|null;mediaUrls?:readonly string[];sourceActive?:boolean;
 hideMedia?:boolean;reason?:string|null;pointSources?:number[][];sources?:ArticleSource[];
 onOpenSource?:(source:ArticleSource)=>void;
 onSource:()=>void;onTalk:()=>void;busy:boolean;sourceBusy?:boolean;notice?:ReactNode;allowSavePreview?:boolean;
}){
 const {locale}=useT(),c=(cn:string,en:string)=>locale==="en"?en:translate(locale,cn);
 return <FinalReadingPage kind="post" title={title} source={source} sourceUrl={sourceUrl} mediaUrls={mediaUrls} sourceActive={sourceActive} hideMedia={hideMedia} onSource={onSource} sourceBusy={sourceBusy} onTalk={onTalk} busy={busy} talkLabel={c("和我聊聊你家的情况吗？","Shall we talk about your family?")} notice={notice} allowSavePreview={allowSavePreview}>
  <FinalText testID="daily-post-summary-situation">{summary||(sourceUrl
   ?c("这条资源暂时没有可用摘要，请打开原站查看。","No summary is available for this resource. Open the original source.")
   :c("这条资源暂时没有可用摘要。","No summary is available for this resource."))}</FinalText>
  <View style={{height:1,backgroundColor:"rgba(112,106,116,.18)"}}/>
  <FinalText size={12} secondary>{c("Nuri 整理","Organised by Nuri")}</FinalText>
  {reason?<FinalText size={14} secondary testID="daily-post-summary-reason">{reason}</FinalText>:null}
  {points.map((point,i)=><ReadingStep key={i} index={i} testID={`daily-post-summary-point-${i}`}>
   <FinalText size={18} style={{lineHeight:26,fontWeight:"500"}}>{point}</FinalText>
   {pointSources?.[i]?.length?<FinalText size={12} secondary testID={`daily-post-summary-point-sources-${i}`}>
    {c("来源","Sources")} {pointSources[i].join(locale==="en"?", ":"、")}
   </FinalText>:null}
  </ReadingStep>)}
  {sources?.length?<View testID="daily-post-sources" style={{gap:4}}>
   <FinalText size={12} secondary>{c("参考来源","Sources")}</FinalText>
   {sources.map((item)=><Pressable key={item.n} accessibilityRole="link" disabled={sourceBusy || !sourceActive}
    testID={`daily-post-source-${item.n}`} onPress={()=>onOpenSource?.(item)}
    style={{minHeight:44,justifyContent:"center",paddingVertical:6}}>
    <FinalText size={14}>{item.n}. {item.label}{item.title?` · ${item.title}`:""}</FinalText>
   </Pressable>)}
  </View>:null}
 </FinalReadingPage>;
}
