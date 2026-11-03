import { useCallback, useRef } from "react";
import { ScrollView, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { api, type NotificationHistoryItem } from "@/src/api";
import { useT, translate } from "@/src/i18n";
import { useAccountScope, useAccountState } from "@/src/useAccountState";
import { InlineState, MenuRow } from "@/src/uiux48/Primitives";
import { FinalButton, FinalSurface } from "@/src/uiuxfinal/Primitives";

/** Selectively adapted from main@13da662's NotificationHistory. Listing is
 * read-only; only a deliberate row tap uses the existing delivered-push path. */
export default function NotificationCenter(){return <NotificationHistory/>;}
export function NotificationHistory(){
  const {locale}=useT();const router=useRouter();const {capture,current}=useAccountScope();
  const [items,setItems]=useAccountState<NotificationHistoryItem[]>([]);
  const [status,setStatus]=useAccountState<"loading"|"ready"|"error">("loading");
  const request=useRef(0),focused=useRef(false);
  const c=(cn:string,en:string)=>locale==="en"?en:translate(locale,cn);
  const load=useCallback(async()=>{
    const ticket=capture(),id=++request.current;if(ticket===null)return;
    try{
      const result=await api.listNotifications();
      if(!focused.current||!current(ticket)||request.current!==id)return;
      if(!Array.isArray(result.items))throw Error("notification_list_unconfirmed");
      setItems(result.items);setStatus("ready");
    }catch{if(focused.current&&current(ticket)&&request.current===id)setStatus("error");}
  },[capture,current,setItems,setStatus]);
  useFocusEffect(useCallback(()=>{focused.current=true;void load();return()=>{focused.current=false;request.current++;};},[load]));
  return <View style={{flex:1,minHeight:0,padding:24}}><FinalSurface fill testID="notification-history"><ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={{padding:24,gap:12}}>
    {status==="loading"&&!items.length?<InlineState busy message={c("正在加载…","Loading…")}/>:null}
    {status==="error"?<InlineState message={c("暂时无法读取通知记录。请稍后重试。","Notification history could not be loaded. Please retry.")} action={c("重试","Retry")} onPress={()=>{setStatus("loading");void load();}}/>:null}
    {status==="ready"&&!items.length?<InlineState message={c("还没有收到推送。Nuri发来的提醒和每日精选会出现在这里。","No notifications yet. Nuri's check-ins and daily picks will appear here.")}/>:null}
    {items.map(item=><MenuRow key={item.id} density="list" label={item.title} detail={item.body+"\n"+(Number.isNaN(Date.parse(item.sent_at))?"":new Date(item.sent_at).toLocaleString(locale))} onPress={()=>router.push(("/notifications/"+encodeURIComponent(item.id)) as never)} testID={"notification-"+item.id}/>)}
    <FinalButton secondary label={c("管理通知","Manage notifications")} onPress={()=>router.push("/notification-settings")}/>
  </ScrollView></FinalSurface></View>;
}
