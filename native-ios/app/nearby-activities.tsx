import { useCallback, useRef } from "react";
import { AppState, Linking, View } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";

import { api, ApiError, isAuthError } from "@/src/api";
import { externalSourceHost, externalSourceUrl } from "@/src/externalContent";
import { useT } from "@/src/i18n";
import {
  activityCopy, formatActivityDate, localActivitiesEnabled, localActivityId, normalizedActivityArea,
  validLocalActivity, type ActivityArea, type ActivityLocale, type ActivityPreferences,
  type ActivityPreferencesPatch, type LocalActivities, type LocalActivity,
} from "@/src/localActivities";
import { enableNearbyDeviceLocation, nearbyEventsAvailable } from "@/src/nearbyEvents";
import { useAccountScope, useAccountState } from "@/src/useAccountState";
import { InlineState } from "@/src/uiux48/Primitives";
import { FinalSurface, FinalText } from "@/src/uiuxfinal/Primitives";
import { SettingsButton, SettingsField, SettingsPage, SettingsRow } from "@/src/uiuxfinal/Settings";

const emptyArea: ActivityArea = { city: "", region: "", country: "" };
const cardStyle = { padding: 20, gap: 12 };

type LoadError = "missing" | "session" | "load" | "save" | "location" | "permission" | "source";

export default function NearbyActivities() {
  const { id } = useLocalSearchParams<{ id?: string | string[] }>();
  const { locale } = useT();
  const activityId = localActivityId(id);
  const c = (cn: string, en: string, tw: string) => activityCopy(locale, cn, en, tw);

  if (!localActivitiesEnabled || (id !== undefined && !activityId)) {
    return <SettingsPage testID="local-activity-unavailable">
      <FinalSurface contentStyle={cardStyle}>
        <FinalText>{c("此活动暂时无法查看。", "This activity is unavailable.", "此活動暫時無法查看。")}</FinalText>
      </FinalSurface>
    </SettingsPage>;
  }
  return activityId
    ? <ActivityDetail key={activityId} id={activityId} locale={locale} />
    : <ActivitiesDirectory locale={locale} />;
}

function ActivitiesDirectory({ locale }: { locale: ActivityLocale }) {
  const router = useRouter();
  const { capture, current } = useAccountScope();
  const [prefs, setPrefs] = useAccountState<ActivityPreferences | null>(null);
  const [feed, setFeed] = useAccountState<LocalActivities | null>(null);
  const [draft, setDraft] = useAccountState<ActivityArea>(emptyArea);
  const [editing, setEditing] = useAccountState(false);
  const [busy, setBusy] = useAccountState(false);
  const [loading, setLoading] = useAccountState(true);
  const [error, setError] = useAccountState<LoadError | null>(null);
  const active = useRef(false);
  const sequence = useRef(0);
  const action = useRef<number | null>(null);
  const c = (cn: string, en: string, tw: string) => activityCopy(locale, cn, en, tw);

  const load = useCallback(async () => {
    const owner = capture();
    if (owner === null || action.current !== null) return;
    const request = ++sequence.current;
    const owns = () => current(owner) && active.current && request === sequence.current;
    setLoading(true);
    setFeed(null);
    setError(null);
    // The city controls should remain available even while search is pending.
    const pendingFeed = api.listLocalActivities(locale).then(
      value => ({ status: "fulfilled" as const, value }),
      reason => ({ status: "rejected" as const, reason }),
    );
    try {
      const preferences = await api.getLocalActivityPreferences();
      if (!owns()) return;
      if (typeof preferences?.enabled !== "boolean") throw new Error("Local activity settings were not confirmed");
      setPrefs(preferences);
      if (!preferences.enabled) return;
      const results = await pendingFeed;
      if (!owns()) return;
      if (results.status === "rejected") throw results.reason;
      if (!Array.isArray(results.value?.items)) throw new Error("Local activities response was not confirmed");
      setFeed({ state: results.value.state, items: results.value.items.filter(validLocalActivity) });
    } catch (cause) {
      if (owns()) setError(isAuthError(cause) ? "session" : "load");
    } finally {
      if (owns()) setLoading(false);
    }
  }, [capture, current, locale, setError, setFeed, setLoading, setPrefs]);

  useFocusEffect(useCallback(() => {
    active.current = true;
    setBusy(false);
    void load();
    return () => {
      active.current = false;
      sequence.current += 1;
      action.current = null;
    };
  }, [load, setBusy]));

  async function perform(run: (owns: () => boolean) => Promise<void>) {
    const owner = capture();
    if (owner === null || !active.current || action.current !== null) return;
    const request = ++sequence.current;
    action.current = request;
    const owns = () => current(owner) && active.current && sequence.current === request;
    setBusy(true);
    setLoading(false);
    setError(null);
    try {
      await run(owns);
    } catch (cause) {
      if (owns()) setError(isAuthError(cause) ? "session" : "save");
    } finally {
      if (action.current === request) action.current = null;
      if (owns()) setBusy(false);
    }
  }

  async function save(patch: ActivityPreferencesPatch) {
    let refresh = false;
    await perform(async owns => {
      const saved = await api.setLocalActivityPreferences(patch);
      if (!owns()) return;
      if (saved?.enabled !== patch.enabled ||
          (patch.enabled
            ? saved.city !== patch.city || (saved.region ?? "") !== patch.region || saved.country !== patch.country
            : Boolean(saved.city || saved.region || saved.country))) {
        throw new Error("The local activity preference did not save");
      }
      setPrefs(saved);
      setFeed(null);
      setDraft(emptyArea);
      setEditing(false);
      refresh = saved.enabled;
    });
    if (refresh) await load();
  }

  function edit() {
    setDraft({ city: prefs?.city ?? "", region: prefs?.region ?? "", country: prefs?.country ?? "" });
    setEditing(true);
    setError(null);
  }

  function fillFromDevice() {
    return perform(async owns => {
      if (AppState.currentState !== "active") return;
      const result = await enableNearbyDeviceLocation();
      if (!owns()) return;
      const area = result.status === "authorized" && result.locality
        ? normalizedActivityArea(result.locality) : null;
      if (area) setDraft(area);
      else setError(result.status === "denied" ? "permission" : "location");
    });
  }

  const area = normalizedActivityArea(draft);
  const savedArea = [prefs?.city, prefs?.region, prefs?.country].filter(Boolean).join(", ");
  const messages: Record<LoadError, string> = {
    missing: c("找不到此活动。", "This activity could not be found.", "找不到此活動。"),
    session: c("请先登录查看附近活动。", "Sign in to see nearby activities.", "請先登入查看附近活動。"),
    load: c("附近活动暂时无法读取，请重试。", "Activities could not be loaded. Try again.", "附近活動暫時無法讀取，請重試。"),
    save: c("未能确认保存，请重新读取后再试。", "Your save could not be confirmed. Reload and try again.", "未能確認儲存，請重新讀取後再試。"),
    location: c("暂时无法读取当前位置。你可以手动填写城市。", "Could not get your current area. You can enter a city.", "暫時無法讀取目前位置。你可以手動填寫城市。"),
    permission: c("请在系统设置允许使用位置，或手动填写城市。", "Allow location in system Settings or enter a city.", "請在系統設定允許使用位置，或手動填寫城市。"),
    source: c("系统设置暂时无法打开。", "System Settings could not be opened.", "系統設定暫時無法開啟。"),
  };
  const items = feed?.state === "ready" ? feed.items : [];
  const unavailable = feed?.state === "unavailable" || feed?.state === "disabled";
  const showForm = editing || prefs?.enabled === false;

  return <SettingsPage testID="local-activities-screen">
    <FinalSurface contentStyle={cardStyle}>
      {loading && !prefs ? <InlineState busy message={c("正在读取…", "Loading…", "正在讀取…")} /> : null}
      <FinalText size={18} accessibilityRole="header">{c("推荐地区", "Recommendation area", "推薦地區")}</FinalText>
      {savedArea && !editing ? <FinalText testID="local-activities-area">{savedArea}</FinalText> : null}
      {showForm ? <>
        <FinalText secondary>{c(
          "Nuri 用你保存的城市、地区和国家查找适合孩子的活动和资源。允许通知后，Nuri 也会不定期推送。使用手机位置只会填写这三个字段。",
          "Nuri uses your saved city, region and country to find activities and resources suited to your children. If you allow notifications, Nuri can send occasional updates. Device location only fills in these fields.",
          "Nuri 用你儲存的城市、地區和國家尋找適合孩子的活動和資源。允許通知後，Nuri 也會不定期推播。使用手機位置只會填寫這三個欄位。",
        )}</FinalText>
        {nearbyEventsAvailable() ? <SettingsButton secondary
          label={c("用当前位置填写", "Fill from current location", "用目前位置填寫")}
          onPress={() => void fillFromDevice()} disabled={busy || loading} testID="local-activities-device-location" /> : null}
        <SettingsField label={c("城市", "City", "城市")} value={draft.city} maxLength={80} editable={!busy && !loading}
          onChangeText={city => setDraft(value => ({ ...value, city }))} testID="local-activities-city" />
        <SettingsField label={c("州或地区", "State or region", "州或地區")} value={draft.region} maxLength={70} editable={!busy && !loading}
          onChangeText={region => setDraft(value => ({ ...value, region }))} testID="local-activities-region" />
        <SettingsField label={c("两位国家代码", "Two-letter country code", "兩位國家代碼")}
          placeholder={c("例如 US 或 CN", "For example US or CA", "例如 US 或 TW")} autoCapitalize="characters"
          value={draft.country} maxLength={2} editable={!busy && !loading}
          onChangeText={country => setDraft(value => ({ ...value, country }))} testID="local-activities-country" />
        <SettingsButton label={c("保存并查看活动", "Save and see activities", "儲存並查看活動")}
          busy={busy} disabled={!area || busy || loading}
          onPress={() => { if (area) void save({ enabled: true, ...area }); }} testID="local-activities-save" />
        {editing && prefs?.enabled ? <SettingsButton secondary label={c("取消修改", "Cancel edit", "取消修改")}
          disabled={busy} onPress={() => { setEditing(false); setDraft(emptyArea); setError(null); }} /> : null}
      </> : null}
      {prefs?.enabled && !editing ? <>
        <SettingsRow label={c("更改地区", "Change area", "變更地區")} disabled={busy} onPress={edit} testID="local-activities-edit" />
        <SettingsRow label={c("关闭推荐并移除地区", "Turn off recommendations and remove area", "關閉推薦並移除地區")}
          disabled={busy} onPress={() => void save({ enabled: false })} testID="local-activities-disable" />
      </> : null}
      {error ? <InlineState message={messages[error]}
        action={error === "permission" ? c("打开系统设置", "Open Settings", "開啟系統設定")
          : error === "session" ? c("登录", "Sign in", "登入")
          : error === "load" || error === "save" ? c("重新读取", "Reload", "重新讀取") : undefined}
        onPress={error === "permission" ? () => void Linking.openSettings().catch(() => setError("source"))
          : error === "session" ? () => router.push("/login") : () => void load()} /> : null}
    </FinalSurface>
    {prefs?.enabled ? <>
      {loading || !feed && !error ? <FinalSurface contentStyle={cardStyle}>
        <InlineState busy message={c("正在整理附近活动…", "Finding nearby activities…", "正在整理附近活動…")} />
      </FinalSurface> : null}
      {!loading && feed && !items.length ? <FinalSurface contentStyle={cardStyle}>
        <InlineState message={unavailable
          ? c("附近活动暂时无法提供。", "Nearby activities are temporarily unavailable.", "附近活動暫時無法提供。")
          : c("这个地区暂时没有找到合适的活动或资源。", "No suitable activities or resources were found in this area.", "這個地區暫時沒有找到合適的活動或資源。")}
          action={c("刷新", "Refresh", "重新整理")} onPress={() => void load()} />
      </FinalSurface> : null}
      {[["dated_event", c("近期活动", "Upcoming events", "近期活動")],
        ["ongoing_resource", c("场所与资源", "Places and resources", "場所與資源")]].map(([kind, heading]) => {
        const group = items.filter(item => item.kind === kind);
        if (!group.length) return null;
        return <FinalSurface key={kind} contentStyle={cardStyle}>
          <FinalText size={18} accessibilityRole="header">{heading}</FinalText>
          {group.map(item => <SettingsRow key={item.id} label={item.title}
            detail={[formatActivityDate(item, locale), item.location_label, item.source_label].filter(Boolean).join(" · ")}
            testID={`local-activity-${item.id}`}
            disabled={busy || loading || editing}
            onPress={() => router.push({ pathname: "/nearby-activities", params: { id: item.id } })} separator />)}
        </FinalSurface>;
      })}
    </> : null}
  </SettingsPage>;
}

function ActivityDetail({ id, locale }: { id: string; locale: ActivityLocale }) {
  const router = useRouter();
  const { capture, current } = useAccountScope();
  const [activity, setActivity] = useAccountState<LocalActivity | null>(null);
  const [error, setError] = useAccountState<LoadError | null>(null);
  const active = useRef(false);
  const request = useRef(0);
  const c = (cn: string, en: string, tw: string) => activityCopy(locale, cn, en, tw);

  const load = useCallback(async () => {
    const owner = capture();
    if (owner === null) return;
    const sequence = ++request.current;
    const owns = () => current(owner) && active.current && sequence === request.current;
    setError(null);
    try {
      const result = await api.getLocalActivity(id);
      if (!owns()) return;
      if (!validLocalActivity(result) || result.id !== id) {
        setError("missing");
        return;
      }
      setActivity(result);
    } catch (cause) {
      if (owns()) setError(isAuthError(cause) ? "session" : cause instanceof ApiError && cause.status === 404 ? "missing" : "load");
    }
  }, [capture, current, id, setActivity, setError]);

  useFocusEffect(useCallback(() => {
    active.current = true;
    setActivity(null);
    void load();
    return () => {
      active.current = false;
      request.current += 1;
    };
  }, [load, setActivity]));

  async function openSource() {
    const owner = capture();
    const url = externalSourceUrl(activity?.source_url);
    if (owner === null || !active.current || !url) return;
    setError(null);
    try {
      await Linking.openURL(url);
    } catch {
      if (current(owner) && active.current) setError("source");
    }
  }

  const cannotView = error === "missing" || error === "session" || error === "load";
  return <SettingsPage testID="local-activity-detail">
    <FinalSurface contentStyle={cardStyle}>
      {cannotView ? <InlineState
        message={error === "session" ? c("请先登录查看活动。", "Sign in to see this activity.", "請先登入查看活動。")
          : error === "missing" ? c("此活动已过期或无法查看。", "This activity is expired or unavailable.", "此活動已過期或無法查看。")
          : c("活动详情暂时无法读取。", "The activity could not be loaded.", "活動詳情暫時無法讀取。")}
        action={error === "session" ? c("登录", "Sign in", "登入")
          : error === "missing" ? c("查看附近活动", "See nearby activities", "查看附近活動") : c("重试", "Retry", "重試")}
        onPress={error === "session" ? () => router.push("/login")
          : error === "missing" ? () => router.replace("/nearby-activities") : () => void load()} />
        : activity ? <>
          <FinalText size={12} secondary>{activity.kind === "dated_event"
            ? c("近期活动", "Upcoming event", "近期活動") : c("场所与资源", "Place or resource", "場所與資源")}</FinalText>
          <FinalText size={24} style={{ fontWeight: "600" }} accessibilityRole="header">{activity.title}</FinalText>
          <View style={{ gap: 4 }}>
            {activity.start_date ? <FinalText secondary>{formatActivityDate(activity, locale)}</FinalText> : null}
            {activity.location_label ? <FinalText secondary>{activity.location_label}</FinalText> : null}
          </View>
          {activity.summary ? <FinalText>{activity.summary}</FinalText> : null}
          <FinalText secondary>{c("请到来源页面确认时间、适龄范围和报名要求。", "Check the source for times, age guidance and registration.", "請到來源頁面確認時間、適齡範圍和報名要求。")}</FinalText>
          <FinalText size={12} secondary>{activity.source_label || externalSourceHost(activity.source_url)}</FinalText>
          <SettingsButton label={c("查看活动来源", "Open source", "查看活動來源")} testID="local-activity-source"
            onPress={() => void openSource()} />
          {error === "source" ? <InlineState message={c("来源暂时打不开。", "The source could not be opened.", "來源暫時打不開。")} /> : null}
        </> : <InlineState busy message={c("正在读取活动…", "Loading activity…", "正在讀取活動…")} />}
    </FinalSurface>
  </SettingsPage>;
}
