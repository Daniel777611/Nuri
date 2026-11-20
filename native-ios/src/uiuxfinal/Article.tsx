import type {ReactNode} from "react";
import {Pressable,View} from "react-native";
import {useT,translate} from "@/src/i18n";
import {FinalText} from "./Primitives";
import {FinalReadingPage,ReadingStep} from "./Reading";

/** Supplied summaries only; never a fabricated article or a new save API. */
export type ArticleSource={n:number;title:string;label:string;url:string};

export function FinalArticle({title,source,sourceUrl,sourceActive=true,summary,points,pointSources,sources,onOpenSource,onSource,onTalk,busy,sourceBusy=false,notice,allowSavePreview=false}:{
 title:string;source:string;summary:string|null;points:string[];
 /** Per point, the numbers of the sources behind it (a summary card). */
 pointSources?:number[][];
 /** Every source a summary card read, numbered as the points cite them. */
 sources?:ArticleSource[];
 onOpenSource?:(source:ArticleSource)=>void;
 sourceUrl?:string|null;sourceActive?:boolean;
 onSource:()=>void;onTalk:()=>void;busy:boolean;sourceBusy?:boolean;notice?:ReactNode;allowSavePreview?:boolean;
}){
 const {locale}=useT(),c=(cn:string,en:string)=>locale==="en"?en:translate(locale,cn);
 return <FinalReadingPage kind="post" title={title} source={source} sourceUrl={sourceUrl} sourceActive={sourceActive} onSource={onSource} sourceBusy={sourceBusy} onTalk={onTalk} busy={busy} talkLabel={c("和我聊聊你家的情况吗？","Shall we talk about your family?")} notice={notice} allowSavePreview={allowSavePreview} hideMedia={Boolean(sources?.length)}>
  <FinalText testID="daily-post-summary-situation">{summary||c("这条资源暂时没有可用摘要，请打开原站查看。","No summary is available for this resource. Open the original source.")}</FinalText>
  <View style={{height:1,backgroundColor:"rgba(112,106,116,.18)"}}/>
  <FinalText size={12} secondary>{c("Nuri 整理","Organised by Nuri")}</FinalText>
  {points.map((point,i)=><ReadingStep key={i} index={i} testID={`daily-post-summary-point-${i}`}>
   <FinalText size={18} style={{lineHeight:26,fontWeight:"500"}}>{point}</FinalText>
   {pointSources?.[i]?.length?<FinalText size={12} secondary testID={`daily-post-summary-point-sources-${i}`}>{c("来源","Sources")} {pointSources[i].join(locale==="en"?", ":"、")}</FinalText>:null}
  </ReadingStep>)}
  {sources?.length?<View style={{gap:10}} testID="daily-post-sources">
   <View style={{height:1,backgroundColor:"rgba(112,106,116,.18)"}}/>
   <FinalText size={12} secondary>{c("参考来源","Sources")}</FinalText>
   {sources.map((s)=><Pressable key={s.n} onPress={()=>onOpenSource?.(s)} accessibilityRole="link" testID={`daily-post-source-${s.n}`}>
    <FinalText size={14} numberOfLines={2}>{s.n}. {s.label}{s.title?` · ${s.title}`:""}</FinalText>
   </Pressable>)}
  </View>:null}
 </FinalReadingPage>;
}
