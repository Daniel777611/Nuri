import {useRef,useState} from "react";
import {View} from "react-native";
import {Image} from "expo-image";
import {youtubeVideoThumbnail} from "@/src/recommendationMedia";

/** The design's room is illustrative; this slot shows only the actual video. */
export function HomeVideoThumbnail({videoId}:{videoId?:string|null}){
 const uri=youtubeVideoThumbnail(videoId);
 const [failed,setFailed]=useState<string|null>(null);
 const currentUri=useRef(uri);currentUri.current=uri;
 return <View testID="home-video-thumbnail" style={{width:72,height:80,borderRadius:16,overflow:"hidden",backgroundColor:"#746B7E"}}>
  {uri&&uri!==failed?<Image key={uri} accessible={false} source={{uri}} recyclingKey={uri} cachePolicy="memory" transition={0} contentFit="cover" onError={()=>{if(currentUri.current===uri)setFailed(uri);}} style={{width:72,height:80}}/>:null}
  <View pointerEvents="none" style={{position:"absolute",left:4,bottom:4,width:30,height:30,borderRadius:15,backgroundColor:"rgba(227,214,237,.96)",alignItems:"center",justifyContent:"center"}}><Image accessible={false} source={require("@/assets/final-flow-20261101/home-video-play.svg")} contentFit="contain" style={{width:20,height:20}}/></View>
 </View>;
}
