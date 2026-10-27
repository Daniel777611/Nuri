import { useCallback, useRef, useState } from "react";
import { View, AppState, Platform } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { api, type NotificationPreferences } from "@/src/api";
import { useAccountState, useAccountScope } from "@/src/useAccountState";
import { useT, translate } from "@/src/i18n";
import { getReminderSettings, openNotificationSettings, requestNotificationPermission, type NativeReminderSettings } from "@/src/nativePush";
import { CardList, CenteredCard, NuriButton, NuriText, NuriField, MenuRow, ToggleRow, InlineState } from "@/src/uiux48/Primitives";
import { StateCard } from "@/src/uiux48/StateCard";

/** Only the native app can read and ask for this device's notification access. */
const DEVICE_SETTINGS = Platform.OS !== "web";
const preferenceKeys: (keyof NotificationPreferences)[]=["enabled","reminders_enabled","chat_enabled","care_enabled","quiet_hours_start","quiet_hours_end","time_zone","max_per_day","show_preview"];

/** Uses the existing GET/PATCH contract rather than conflating device access,
 * daily content privacy, and server push preferences. No permissions auto-change. */
export default function NotificationSettings() {
 const {locale}=useT();const en=locale==="en";const {capture,current}=useAccountScope();
 const router=useRouter();const {uiState}=useLocalSearchParams<{uiState?:string}>();
 const [device,setDevice]=useState<NativeReminderSettings|null>(null);
 const [prefs,setPrefs]=useAccountState<NotificationPreferences|null>(null);
 const [daily,setDaily]=useAccountState(false);const [dailyLoaded,setDailyLoaded]=useAccountState(false);
 const [dailyDirty,setDailyDirty]=useAccountState(false);
 const [loading,setLoading]=useState(true);const [busy,setBusy]=useState(false);
 const [error,setError]=useAccountState("");const active=useRef(false);const pending=useRef(false);const dirty=useRef(false);
 const [saved,setSaved]=useAccountState(false);
 const copy=(cn:string,english:string)=>en?english:translate(locale,cn);
 const reload=useCallback(async()=>{
  const owner=capture();setLoading(true);
  // The web has no device module: the shells own system permission, so the
  // page only reads and saves the account preferences there.
  const results=await Promise.allSettled([DEVICE_SETTINGS?getReminderSettings():Promise.resolve(null),api.getNotificationPreferences(),api.getPrivacy()]);
  if(!active.current)return;
  if(results[0].status==="fulfilled"&&results[0].value)setDevice(results[0].value);
  if(current(owner)){
   if(results[1].status==="fulfilled"&&!dirty.current)setPrefs(results[1].value);
   if(results[2].status==="fulfilled"&&!dirty.current){setDaily(results[2].value?.daily_push===true);setDailyLoaded(true);}
   if(results.some(r=>r.status==="rejected"))setError(copy("部分设置未能读取，请重试。","Some settings could not be loaded. Please retry."));
  }setLoading(false);
 },[capture,current,setPrefs,setDaily,setDailyLoaded,setError,locale]);
 useFocusEffect(useCallback(()=>{active.current=true;void reload();const sub=AppState.addEventListener("change",s=>{if(s==="active"&&!pending.current)void reload();});return()=>{active.current=false;sub.remove();};},[reload]));
 const patch=(value:Partial<NotificationPreferences>)=>{dirty.current=true;setPrefs(p=>p?{...p,...value}:p);};
 const save=async()=>{
  const owner=capture();if(owner===null||pending.current||!prefs)return;
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(prefs.quiet_hours_start)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(prefs.quiet_hours_end)){setError(copy("安静时段请使用 HH:MM（24小时制）。","Use HH:MM (24-hour time) for quiet hours."));return;}
  pending.current=true;setBusy(true);setError("");setSaved(false);
  try{
   const confirmed=await api.setNotificationPreferences(prefs);
   if(!current(owner)||!active.current)return;
   // A 2xx with an empty or conflicting body is not a confirmed save. Keep
   // the form/draft for a deliberate reload instead of showing false success.
   if(!confirmed||preferenceKeys.some(key=>confirmed[key]!==prefs[key]))throw new Error("notification_preferences_unconfirmed");
   if(dailyDirty){const privacy=await api.getPrivacy();if(!current(owner)||!active.current)return;const result=await api.setPrivacy({...privacy,daily_push:daily});if(result?.daily_push!==daily)throw new Error("daily_push_unconfirmed");}
   if(current(owner)&&active.current){dirty.current=false;setDailyDirty(false);setSaved(true);}
  }catch{if(current(owner)&&active.current)setError(copy("保存未完全确认，请重新读取并核对后重试。","Save not fully confirmed. Reload and check before retrying."));}
  finally{pending.current=false;if(active.current)setBusy(false);}
 };
 const allow=async()=>{if(pending.current)return;pending.current=true;setBusy(true);setError("");try{await requestNotificationPermission();const state=await getReminderSettings();if(active.current){setDevice(state);if(state.permissionStatus==="authorized"||state.permissionStatus==="provisional"){if(uiState==="permission")router.replace("/notification-settings");}else setError(copy("通知尚未允许；你可以继续使用 App，之后在系统设置中开启。","Notifications are not allowed yet. You can keep using the app and enable them later in system settings."));}}catch{if(active.current)setError(copy("未能确认通知权限，请查看系统设置。","Notification permission was not confirmed. Check system settings."));}finally{pending.current=false;if(active.current)setBusy(false);}};
 const state=device?.permissionStatus;
 const permission=state==="authorized"||state==="provisional"?copy("已允许","Allowed"):state==="denied"?copy("未允许","Not allowed"):state==="not_determined"?copy("尚未询问","Not requested"):copy("未能读取","Unavailable");
 if(saved)return <StateCard testID="notification-settings-saved" title={copy("设置已保存","Settings saved")} message={copy("你的通知偏好已保存。","Your notification preferences have been saved.")} note={copy("通知能否送达还取决于系统权限和网络；这不代表已发送测试提醒。","Delivery still depends on system access and the network. This does not mean a test reminder was sent.")} primary={{label:copy("完成","Done"),onPress:()=>setSaved(false)}} />;
 if(uiState==="permission")return <CenteredCard testID="notification-permission-card" contentGap={24}>
  <NuriText style={{fontSize:16,lineHeight:22}}>{copy("允许通知后，Nuri 的提醒可以出现在这台设备上。","Allow notifications so Nuri’s reminders can appear on this device.")}</NuriText>
  <NuriText style={{fontSize:16,lineHeight:22}}>{copy("你也可以继续使用 App，之后再开启。","You can keep using the app and turn them on later.")}</NuriText>
  {error?<NuriText accessibilityLiveRegion="polite" style={{fontSize:13}} testID="notification-permission-result">{error}</NuriText>:null}
  <View style={{gap:10}}><NuriButton label={copy("允许通知","Allow notifications")} busy={busy} disabled={busy} onPress={()=>void allow()} testID="notification-permission-allow" />
  <NuriButton secondary label={copy("暂不开启","Not now")} disabled={busy} onPress={()=>router.replace("/notification-settings")} testID="notification-permission-skip" /></View>
 </CenteredCard>;
 return <CardList testID="notification-settings-card">
  {DEVICE_SETTINGS?<MenuRow label={copy("这台设备的通知权限","Notification access on this device")} detail={permission} onPress={()=>{if(state==="not_determined")router.push({pathname:"/notification-settings",params:{uiState:"permission"}});else void openNotificationSettings().catch(()=>setError(copy("系统设置未能打开。","Could not open system settings.")));}} testID="notification-system-settings" />:null}
  {DEVICE_SETTINGS&&state==="not_determined"?<NuriButton label={copy("允许通知","Allow notifications")} disabled={busy} onPress={()=>router.push({pathname:"/notification-settings",params:{uiState:"permission"}})} testID="notification-request-permission" />:null}
  {loading?<InlineState busy message={copy("正在读取设置…","Loading settings…")} />:null}
  <ToggleRow label={copy("Nuri 的关怀提醒","Nuri care reminders")} value={prefs?.care_enabled===true} disabled={!prefs||busy} onChange={care_enabled=>patch({care_enabled})} testID="notification-care" />
  <ToggleRow label={copy("每日精选内容","Daily featured content")} value={daily} disabled={!dailyLoaded||busy} onChange={v=>{dirty.current=true;setDailyDirty(true);setDaily(v);}} testID="remote-daily-push-toggle" />
  <ToggleRow label={copy("聊天通知","Chat notifications")} value={prefs?.chat_enabled===true} disabled={!prefs||busy} onChange={chat_enabled=>patch({chat_enabled})} testID="notification-chat" />
  <ToggleRow label={copy("显示通知预览","Show notification previews")} value={prefs?.show_preview===true} disabled={!prefs||busy} onChange={show_preview=>patch({show_preview})} testID="notification-preview" />
  <NuriText>{copy("安静时段","Quiet hours")}</NuriText><View style={{flexDirection:"row",gap:12}}><View style={{flex:1}}><NuriField label={copy("开始","From")} value={prefs?.quiet_hours_start??""} onChangeText={quiet_hours_start=>patch({quiet_hours_start})} editable={!!prefs&&!busy} placeholder="22:00" testID="quiet-hours-start" /></View><View style={{flex:1}}><NuriField label={copy("结束","Until")} value={prefs?.quiet_hours_end??""} onChangeText={quiet_hours_end=>patch({quiet_hours_end})} editable={!!prefs&&!busy} placeholder="08:00" testID="quiet-hours-end" /></View></View><NuriText secondary style={{fontSize:12}}>{prefs?.time_zone||copy("时区未能读取","Time zone unavailable")}</NuriText>
  {error?<NuriText accessibilityLiveRegion="polite" testID="notification-settings-result">{error}</NuriText>:null}
  <NuriButton label={copy("保存设置","Save settings")} disabled={busy||!prefs} busy={busy} onPress={()=>void save()} testID="notification-settings-save" />
  <NuriButton secondary label={copy("重新读取","Reload")} disabled={busy} onPress={()=>{dirty.current=false;setDailyDirty(false);void reload();}} testID="notification-settings-retry" />
 </CardList>;
}
