import { useCallback } from "react";
import { useFocusEffect, useRouter } from "expo-router";
import { api, type NotificationHistoryItem } from "@/src/api";
import { useT, translate } from "@/src/i18n";
import { useAccountScope, useAccountState } from "@/src/useAccountState";
import { CardList, InlineState, MenuRow, NuriButton } from "@/src/uiux48/Primitives";
import FlowPreview, { FLOW_PREVIEW_ENABLED } from "nuri-ux49-flow-preview";

/** The notifications that reached this account's phones (GET /notifications),
 * newest first. A row opens exactly like the system notification did: through
 * /notifications/<id>, which carries it into the NURI conversation. */
export default function NotificationCenter() {
 if(FLOW_PREVIEW_ENABLED)return <FlowPreview entry="notifications" />;
 return <NotificationHistory />;
}

function sentLabel(iso: string) {
 const at = new Date(iso);
 if (Number.isNaN(at.getTime())) return "";
 const pad = (n: number) => String(n).padStart(2, "0");
 return `${at.getMonth() + 1}/${at.getDate()} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

export function NotificationHistory() {
 const {locale}=useT();const router=useRouter();
 const copy=(cn:string,en:string)=>locale==="en"?en:translate(locale,cn);
 const { capture, current } = useAccountScope();
 const [items, setItems] = useAccountState<NotificationHistoryItem[]>([]);
 const [state, setState] = useAccountState<"loading" | "ready" | "error">("loading");

 const load = useCallback(async () => {
  const ticket = capture();
  if (ticket === null) return;
  try {
   const { items: rows } = await api.listNotifications();
   if (!current(ticket)) return;
   setItems(rows);
   setState("ready");
  } catch {
   if (current(ticket)) setState("error");
  }
 }, [capture, current, setItems, setState]);

 // Re-read on focus: one that arrives while the tab is open shows next visit.
 useFocusEffect(useCallback(() => { void load(); }, [load]));

 return <CardList contentContainerStyle={{gap:0}} testID="notification-history">
  {state==="loading"&&!items.length?<InlineState busy message={copy("正在加载…","Loading…")} />:null}
  {state==="error"?<InlineState message={copy("加载失败，请稍后再试","Couldn't load. Please try again.")} action={copy("重试","Retry")} onPress={()=>{setState("loading");void load();}} />:null}
  {state==="ready"&&!items.length?<InlineState message={copy("还没有收到推送。NURI 发来的提醒和每日精选会出现在这里。","No notifications yet. NURI's check-ins and daily picks will show up here.")} />:null}
  {items.map((item)=><MenuRow key={item.id} density="list" label={item.title} detail={`${item.body}\n${sentLabel(item.sent_at)}`} onPress={()=>router.push(`/notifications/${item.id}` as never)} testID={`notification-${item.id}`} />)}
  <NuriButton label={copy("管理通知","Manage notifications")} secondary style={{marginTop:16}} onPress={()=>router.push("/notification-settings")} testID="notification-center-settings" />
 </CardList>;
}
