import { useCallback, useRef } from "react";
import { AppState, Linking } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";

import { api, isAuthError } from "@/src/api";
import { useT } from "@/src/i18n";
import {
  activityCopy, normalizedActivityArea,
  type ActivityArea, type ActivityPreferences, type ActivityPreferencesPatch,
} from "@/src/localActivities";
import { enableNearbyDeviceLocation, nearbyEventsAvailable } from "@/src/nearbyEvents";
import { useAccountScope, useAccountState } from "@/src/useAccountState";
import { InlineState } from "@/src/uiux48/Primitives";
import { FinalSurface, FinalText } from "@/src/uiuxfinal/Primitives";
import { SettingsButton, SettingsField, SettingsRow } from "@/src/uiuxfinal/Settings";

const emptyArea: ActivityArea = { city: "", region: "", country: "" };
const cardStyle = { padding: 20, gap: 12 };
type SettingError = "session" | "load" | "save" | "location" | "permission" | "settings";

export default function LocalActivityAreaSettings() {
  const { locale } = useT();
  const router = useRouter();
  const { capture, current } = useAccountScope();
  const [prefs, setPrefs] = useAccountState<ActivityPreferences | null>(null);
  const [draft, setDraft] = useAccountState<ActivityArea>(emptyArea);
  const [editing, setEditing] = useAccountState(false);
  const [busy, setBusy] = useAccountState(false);
  const [loading, setLoading] = useAccountState(true);
  const [error, setError] = useAccountState<SettingError | null>(null);
  const active = useRef(false);
  const sequence = useRef(0);
  const action = useRef<{ owner: number; request: number; done: Promise<void> } | null>(null);
  const c = (cn: string, en: string, tw: string) => activityCopy(locale, cn, en, tw);

  const load = useCallback(async () => {
    const owner = capture();
    if (owner === null || !active.current || action.current?.owner === owner) return;
    const request = ++sequence.current;
    const owns = () => current(owner) && active.current && request === sequence.current;
    setLoading(true);
    setError(null);
    try {
      const preferences = await api.getLocalActivityPreferences();
      if (!owns()) return;
      if (typeof preferences?.enabled !== "boolean") throw new Error("Activity settings were not confirmed");
      setPrefs(preferences);
    } catch (cause) {
      if (owns()) setError(isAuthError(cause) ? "session" : "load");
    } finally {
      if (owns()) setLoading(false);
    }
  }, [capture, current, setError, setLoading, setPrefs]);

  useFocusEffect(useCallback(() => {
    active.current = true;
    const owner = capture();
    const pending = action.current;
    if (pending && pending.owner === owner) {
      const focus = sequence.current;
      setBusy(true);
      // Reopening Settings during a save must not read preferences before the
      // save settles or let the next edit overtake it.
      void pending.done.then(() => {
        if (active.current && sequence.current === focus && current(owner)) {
          setBusy(false);
          void load();
        }
      });
    } else {
      setBusy(false);
      void load();
    }
    return () => {
      active.current = false;
      sequence.current += 1;
    };
  }, [capture, current, load, setBusy]));

  function perform(run: (owns: () => boolean) => Promise<void>) {
    const owner = capture();
    if (owner === null || !active.current || action.current?.owner === owner || loading) return;
    const request = ++sequence.current;
    const owns = () => current(owner) && active.current && sequence.current === request;
    setBusy(true);
    setError(null);
    const done = Promise.resolve().then(() => {
      if (owns()) return run(owns);
    }).catch(cause => {
      if (owns()) setError(isAuthError(cause) ? "session" : "save");
    }).finally(() => {
      if (action.current?.request === request) action.current = null;
      if (owns()) setBusy(false);
    });
    action.current = { owner, request, done };
    return done;
  }

  async function save(patch: ActivityPreferencesPatch) {
    await perform(async owns => {
      const saved = await api.setLocalActivityPreferences(patch);
      if (!owns()) return;
      if (saved?.enabled !== patch.enabled ||
          (patch.enabled
            ? saved.city !== patch.city || (saved.region ?? "") !== patch.region || saved.country !== patch.country
            : Boolean(saved.city || saved.region || saved.country))) {
        throw new Error("Activity settings were not saved");
      }
      setPrefs(saved);
      setDraft(emptyArea);
      setEditing(false);
    });
  }

  function edit() {
    setDraft({ city: prefs?.city ?? "", region: prefs?.region ?? "", country: prefs?.country ?? "" });
    setEditing(true);
    setError(null);
  }

  function fillFromDevice() {
    return perform(async owns => {
      if (AppState.currentState !== "active") return;
      try {
        const result = await enableNearbyDeviceLocation();
        if (!owns()) return;
        const area = result.status === "authorized" && result.locality
          ? normalizedActivityArea(result.locality) : null;
        if (area) setDraft(area);
        else setError(result.status === "denied" ? "permission" : "location");
      } catch {
        if (owns()) setError("location");
      }
    });
  }

  function openSystemSettings() {
    return perform(async owns => {
      try {
        await Linking.openSettings();
      } catch {
        if (owns()) setError("settings");
      }
    });
  }

  const area = normalizedActivityArea(draft);
  const savedArea = [prefs?.city, prefs?.region, prefs?.country].filter(Boolean).join(", ");
  const messages: Record<SettingError, string> = {
    session: c("请先登录管理推荐地区。", "Sign in to manage your recommendation area.", "請先登入管理推薦地區。"),
    load: c("推荐地区暂时无法读取，请重试。", "Could not load the recommendation area. Try again.", "推薦地區暫時無法讀取，請重試。"),
    save: c("未能确认保存，请重新读取后再试。", "Your save could not be confirmed. Reload and try again.", "未能確認儲存，請重新讀取後再試。"),
    location: c("暂时无法读取当前位置。你可以手动填写城市。", "Could not get your current area. You can enter a city.", "暫時無法讀取目前位置。你可以手動填寫城市。"),
    permission: c("请在系统设置允许使用位置，或手动填写城市。", "Allow location in system Settings or enter a city.", "請在系統設定允許使用位置，或手動填寫城市。"),
    settings: c("系统设置暂时无法打开。", "System Settings could not be opened.", "系統設定暫時無法開啟。"),
  };
  const showForm = editing || prefs?.enabled === false;
  const disabled = busy || loading;

  return <FinalSurface contentStyle={cardStyle} testID="local-activity-area-settings">
    <FinalText size={18} accessibilityRole="header">{c("推荐地区", "Recommendation area", "推薦地區")}</FinalText>
    {loading && !prefs ? <InlineState busy message={c("正在读取…", "Loading…", "正在讀取…")} /> : null}
    {prefs?.enabled && savedArea && !editing ? <FinalText testID="local-activities-area">{savedArea}</FinalText> : null}
    {showForm ? <>
      <FinalText secondary>{c(
        "Nuri 用你保存的城市、地区和国家查找附近的亲子活动。允许通知后，也会不定期推送。你可以手动填写，或用手机位置填入这三个字段。",
        "Nuri uses your saved city, region and country to find nearby family activities. If allowed, Nuri can send occasional notifications. Enter these fields or fill them using your device location.",
        "Nuri 用你儲存的城市、地區和國家尋找附近的親子活動。允許通知後，也會不定期推播。你可以手動填寫，或用手機位置填入這三個欄位。",
      )}</FinalText>
      {nearbyEventsAvailable() ? <SettingsButton secondary label={c("用当前位置填写", "Fill from current location", "用目前位置填寫")}
        onPress={() => void fillFromDevice()} disabled={disabled} testID="local-activities-device-location" /> : null}
      <SettingsField label={c("城市", "City", "城市")} value={draft.city} maxLength={80} editable={!disabled}
        onChangeText={city => setDraft(value => ({ ...value, city }))} testID="local-activities-city" />
      <SettingsField label={c("州或地区", "State or region", "州或地區")} value={draft.region} maxLength={70} editable={!disabled}
        onChangeText={region => setDraft(value => ({ ...value, region }))} testID="local-activities-region" />
      <SettingsField label={c("两位国家代码", "Two-letter country code", "兩位國家代碼")}
        placeholder={c("例如 US 或 CN", "For example US or CA", "例如 US 或 TW")} autoCapitalize="characters"
        value={draft.country} maxLength={2} editable={!disabled}
        onChangeText={country => setDraft(value => ({ ...value, country }))} testID="local-activities-country" />
      <SettingsButton label={c("保存地区", "Save area", "儲存地區")} busy={busy} disabled={!area || disabled}
        onPress={() => { if (area) void save({ enabled: true, ...area }); }} testID="local-activities-save" />
      {editing && prefs?.enabled ? <SettingsButton secondary label={c("取消修改", "Cancel edit", "取消修改")}
        disabled={disabled} onPress={() => { setEditing(false); setDraft(emptyArea); setError(null); }} /> : null}
    </> : null}
    {prefs?.enabled && !editing ? <>
      <SettingsRow label={c("更改地区", "Change area", "變更地區")} disabled={disabled} onPress={edit} testID="local-activities-edit" />
      <SettingsRow label={c("关闭推荐并移除地区", "Turn off recommendations and remove area", "關閉推薦並移除地區")}
        disabled={disabled} onPress={() => void save({ enabled: false })} testID="local-activities-disable" />
    </> : null}
    {error ? <InlineState message={messages[error]}
      action={error === "permission" || error === "settings" ? c("打开系统设置", "Open Settings", "開啟系統設定")
        : error === "session" ? c("登录", "Sign in", "登入")
        : error === "load" || error === "save" ? c("重新读取", "Reload", "重新讀取") : undefined}
      onPress={error === "permission" || error === "settings" ? () => void openSystemSettings()
        : error === "session" ? () => router.push("/login") : () => void load()} /> : null}
  </FinalSurface>;
}
