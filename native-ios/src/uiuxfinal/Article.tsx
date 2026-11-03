import type {ReactNode} from "react";
import {View} from "react-native";
import {useT,translate} from "@/src/i18n";
import {FinalText} from "./Primitives";
import {FinalReadingPage,ReadingStep} from "./Reading";

/** Supplied summaries only; never a fabricated article or a new save API. */
export function FinalArticle({title,source,mediaUrl,summary,points,notes,onSource,onTalk,busy,sourceBusy=false,notice,allowSavePreview=false}:{
 title:string;source:string;summary:string|null;points:string[];notes:string[];
 mediaUrl?:string|null;
 onSource:()=>void;onTalk:()=>void;busy:boolean;sourceBusy?:boolean;notice?:ReactNode;allowSavePreview?:boolean;
}){
 const {locale}=useT(),c=(cn:string,en:string)=>locale==="en"?en:translate(locale,cn);
 return <FinalReadingPage kind="post" title={title} source={source} mediaUrl={mediaUrl} onSource={onSource} sourceBusy={sourceBusy} onTalk={onTalk} busy={busy} talkLabel={c("和我聊聊你家的情况吗？","Shall we talk about your family?")} notice={notice} allowSavePreview={allowSavePreview}>
  <FinalText testID="daily-post-summary-situation">{summary||c("这条资源暂时没有可用摘要，请打开原站查看。","No summary is available for this resource. Open the original source.")}</FinalText>
  <View style={{height:1,backgroundColor:"rgba(112,106,116,.18)"}}/>
  <FinalText size={12} secondary>{c("Nuri 整理","Organised by Nuri")}</FinalText>
  {points.map((point,i)=><ReadingStep key={i} index={i} testID={`daily-post-summary-point-${i}`}><FinalText size={18} style={{lineHeight:26,fontWeight:"500"}}>{point}</FinalText></ReadingStep>)}
  {notes.filter(Boolean).map((note,i)=><FinalText key={i} size={12} secondary testID={i===0?"daily-post-summary-disclosure":undefined}>{note}</FinalText>)}
 </FinalReadingPage>;
}
