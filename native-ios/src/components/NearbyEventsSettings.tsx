import { useCallback, useRef } from "react";
import { AppState, Linking, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { ApiError } from "../api";
import { useT } from "../i18n";
import {
  areaLabel, enableNearbyReminders, manualArea,
  readNearbyPreference, refreshNearbyEvents, setNearbyPreference,
  type NearbyEvent, type NearbyPreference,
} from "../nearbyEvents";
import { useAccountScope, useAccountState } from "../useAccountState";
import { InlineState, NuriText } from "../uiux48/Primitives";
import { SettingsButton, SettingsDivider, SettingsField, SettingsRow, SettingsToggle } from "../uiuxfinal/Settings";

export function NearbyEventsSettings({ owner, profileCity }: { owner: string; profileCity: string }) {
  const { locale } = useT();
  const { capture, current } = useAccountScope();
  const [preference, showPreference] = useAccountState<NearbyPreference | null>(null);
  const [manualCity, setManualCity] = useAccountState<string | null>(null);
  const [events, setEvents] = useAccountState<NearbyEvent[]>([]);
  const [busy, setBusy] = useAccountState(false);
  const [loaded, setLoaded] = useAccountState(false);
  const [lookupComplete, setLookupComplete] = useAccountState(false);
  const [error, setError] = useAccountState<"notify" | "search" | "retry" | "save" | "link" | null>(null);
  const action = useRef(false);
  const copy = (cn: string, en: string, tw: string) => locale === "en" ? en : locale === "zh-TW" ? tw : cn;

  const reload = useCallback(async (force = false) => {
    const ticket = capture();
    if (ticket === null || !owner) return;
    try {
      const saved = await readNearbyPreference(owner);
      if (!current(ticket)) return;
      showPreference(saved);
      setLoaded(true);
      if (!saved) { setEvents([]); setLookupComplete(false); return; }
      const found = await refreshNearbyEvents(owner, locale, force);
      if (!current(ticket)) return;
      // Permissions might have been revoked in Settings during a foreground refresh.
      const stillEnabled = await readNearbyPreference(owner);
      if (!current(ticket)) return;
      showPreference(stillEnabled);
      setEvents(stillEnabled ? found : []);
      setLookupComplete(Boolean(stillEnabled));
      setError(null);
    } catch (cause) {
      if (current(ticket)) setError(cause instanceof ApiError && cause.status === 429 ? "retry" : "search");
    }
  }, [capture, current, locale, owner, setError, setEvents, setLoaded, setLookupComplete, showPreference]);

  useFocusEffect(useCallback(() => {
    void reload();
    const sub = AppState.addEventListener("change", state => {
      if (state === "active" && !action.current) void reload();
    });
    return () => { sub.remove(); };
  }, [reload]));

  async function doAction(run: (ticket: number) => Promise<void>) {
    const ticket = capture();
    if (ticket === null || action.current || !owner) return;
    action.current = true;
    setBusy(true);
    setError(null);
    try { await run(ticket); }
    catch { if (current(ticket)) setError("save"); }
    finally {
      action.current = false;
      if (current(ticket)) setBusy(false);
    }
  }

  async function save(ticket: number, next: NearbyPreference | null) {
    if (!current(ticket)) return;
    await setNearbyPreference(owner, next);
    if (!current(ticket)) return;
    showPreference(next);
    setEvents([]);
    setLookupComplete(false);
    if (next) await reload();
  }

  const selectedManualCity = manualCity ?? (!preference ? profileCity : "");
  const manualLocality = manualArea(selectedManualCity);
  const enableManual = () => void doAction(async ticket => {
    if (!manualLocality) return;
    await save(ticket, { mode: "manual", locality: manualLocality, reminders: preference?.reminders ?? false,
      locatedAt: Date.now() });
  });
  const toggleReminders = (on: boolean) => void doAction(async ticket => {
    if (!preference) return;
    if (on && !await enableNearbyReminders()) {
      if (current(ticket)) setError("notify");
      return;
    }
    await save(ticket, { ...preference, reminders: on });
  });
  const formatDate = (date: string) => new Intl.DateTimeFormat(locale, {
    month: "short", day: "numeric", weekday: "short", year: "numeric", timeZone: "UTC",
  }).format(new Date(date + "T12:00:00Z"));
  const messages = {
    notify: copy("请先在系统设置中开启 Nuri 通知。", "Allow Nuri notifications in Settings first.", "請先在系統設定中開啟 Nuri 通知。"),
    search: copy("附近活动暂时无法读取。", "Nearby activities are temporarily unavailable.", "附近活動暫時無法讀取。"),
    retry: copy("刚刚搜索过，请稍后再试。", "You just searched. Try again shortly.", "剛剛搜尋過，請稍後再試。"),
    save: copy("偏好未保存，请重试。", "Your preference could not be saved. Try again.", "偏好未儲存，請重試。"),
    link: copy("活动来源页面暂时无法打开。", "Could not open the event source.", "活動來源頁面暫時無法開啟。"),
  };

  if (!loaded || !owner) return <InlineState busy message={copy("正在读取…", "Loading…", "正在讀取…")} />;
  return <View style={{ gap: 16 }} testID="alpha-nearby-events-settings">
    <NuriText secondary>
      {copy(
        "Nuri 使用城市和地区搜索图书馆活动和亲子活动。搜索服务只收到大致地区，Nuri 不上传街道地址或坐标。可在设置首页管理当前位置，或在下方手动填写城市。",
        "Nuri uses your city and region to find library and family events. The search provider receives only the area. Nuri does not upload your street address or coordinates. Manage current location on the main Settings page, or enter a city below.",
        "Nuri 使用城市和地區搜尋圖書館活動和親子活動。搜尋服務只收到大致地區，Nuri 不上傳街道地址或座標。可在設定首頁管理目前位置，或在下方手動填寫城市。",
      )}
    </NuriText>
    {preference ? <NuriText testID="alpha-nearby-area">
      {areaLabel(preference.locality)}
    </NuriText> : null}
    <SettingsField label={copy("或手动填写城市、地区", "Or enter a city and region", "或手動填寫城市、地區")}
      value={selectedManualCity} onChangeText={setManualCity}
      placeholder={copy("例如 Savannah, GA", "For example Savannah, GA", "例如 Savannah, GA")}
      testID="alpha-nearby-manual-city" />
    <SettingsButton secondary label={copy("按城市查找", "Find activities by city", "按城市查找")}
      disabled={busy || !manualLocality} onPress={enableManual} testID="alpha-nearby-use-manual" />
    {error ? <NuriText secondary accessibilityLiveRegion="polite" testID="alpha-nearby-error">
      {messages[error]}
    </NuriText> : null}
    {error === "notify"
      ? <SettingsButton secondary label={copy("打开系统设置", "Open Settings", "開啟系統設定")}
          onPress={() => void Linking.openSettings().catch(() => setError("save"))} /> : null}
    {preference ? <>
      <SettingsDivider />
      <SettingsToggle label={copy("附近活动提醒", "Nearby activity reminders", "附近活動提醒")}
        detail={copy("打开 App 时更新活动。提醒遵守通知开关和安静时段。",
          "Activities refresh when you open Nuri. Reminders respect the notification switch and quiet hours.",
          "開啟 App 時更新活動。提醒遵守通知開關和安靜時段。")}
        value={preference.reminders} disabled={busy} onChange={toggleReminders}
        testID="alpha-nearby-reminder-toggle" />
      {events.map(event => <SettingsRow key={event.id}
        label={event.title}
        detail={`${formatDate(event.date)} · ${event.source}`}
        onPress={() => void Linking.openURL(event.url).catch(() => setError("link"))} />)}
      {lookupComplete && !events.length ? <NuriText secondary testID="alpha-nearby-empty">
        {copy("还没找到日期明确的近期活动。", "No upcoming activities with a specific date were found.", "還沒找到日期明確的近期活動。")}
      </NuriText> : null}
      <SettingsButton secondary label={copy("刷新活动", "Refresh activities", "重新整理活動")}
        disabled={busy} onPress={() => void doAction(() => reload(true))} />
      <SettingsButton secondary label={copy("关闭附近活动", "Turn off nearby activities", "關閉附近活動")}
        disabled={busy} onPress={() => void doAction(ticket => save(ticket, null))}
        testID="alpha-nearby-disable" />
    </> : null}
  </View>;
}
