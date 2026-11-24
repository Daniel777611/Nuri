import { useCallback, useRef } from "react";
import { AppState, Linking, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { useT } from "../i18n";
import { nearbyEventsAvailable, readNearbyLocationSetting, setNearbyLocationEnabled } from "../nearbyEvents";
import { useAccountScope, useAccountState } from "../useAccountState";
import { NuriText } from "../uiux48/Primitives";
import { SettingsAction, SettingsToggle } from "../uiuxfinal/Settings";

type LocationSetting = Awaited<ReturnType<typeof readNearbyLocationSetting>>;
type SettingError = "load" | "save" | "unavailable" | "settings" | "link" | null;
type Focus = { owner: string; ticket: number; read: number; mutating: boolean; openingSettings: boolean };

/** The root Settings switch owns explicit location opt-in. Reading or returning
 * from system Settings never independently asks for permission. */
export function NearbyLocationSetting({ owner }: { owner: string }) {
  const { locale } = useT();
  const { capture, current } = useAccountScope();
  const [saved, setSaved] = useAccountState<{ owner: string; setting: LocationSetting } | null>(null);
  const [busy, setBusy] = useAccountState(false);
  const [error, setError] = useAccountState<SettingError>(null);
  const [openingSettings, setOpeningSettings] = useAccountState(false);
  const focus = useRef<Focus | null>(null);
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const available = process.env.EXPO_PUBLIC_RELEASE_FLAVOR === "live-alpha" && nearbyEventsAvailable();
  const copy = (cn: string, en: string, tw: string) => locale === "en" ? en : locale === "zh-TW" ? tw : cn;
  const owns = useCallback((value: Focus) => focus.current === value && currentOwner.current === value.owner
    && current(value.ticket), [current]);

  const refresh = useCallback(async (value: Focus) => {
    const read = ++value.read;
    try {
      const setting = await readNearbyLocationSetting(value.owner);
      if (!owns(value) || read !== value.read) return;
      setSaved({ owner: value.owner, setting });
      setError(null);
    } catch {
      if (owns(value) && read === value.read) setError("load");
    }
  }, [owns, setError, setSaved]);

  useFocusEffect(useCallback(() => {
    const ticket = capture();
    if (!available || !owner || ticket === null) return;
    const value: Focus = { owner, ticket, read: 0, mutating: false, openingSettings: false };
    focus.current = value;
    setBusy(false);
    setOpeningSettings(false);
    void refresh(value);
    const subscription = AppState.addEventListener("change", state => {
      if (state === "active" && owns(value) && !value.mutating) void refresh(value);
    });
    return () => {
      value.read += 1;
      if (focus.current === value) focus.current = null;
      subscription.remove();
    };
  }, [available, owner, capture, owns, refresh, setBusy, setOpeningSettings]));

  const setting = saved?.owner === owner ? saved.setting : null;
  const change = async (enabled: boolean) => {
    const value = focus.current;
    if (!available || !setting || !value || value.owner !== owner || !owns(value) || value.mutating) return;
    value.mutating = true;
    value.read += 1; // An older foreground read cannot undo this choice's UI.
    setBusy(true);
    setError(null);
    try {
      const result = await setNearbyLocationEnabled(value.owner, enabled, locale);
      if (!owns(value)) return;
      const state = await readNearbyLocationSetting(value.owner);
      if (!owns(value)) return;
      setSaved({ owner: value.owner, setting: state });
      if (result === "settings_required") setError("settings");
      else if (result === "unavailable") setError("unavailable");
      else if (state.enabled !== enabled) setError(state.permission === "denied" && enabled ? "settings" : "save");
    } catch {
      if (owns(value)) {
        // A failed write is not a successful opt-in or opt-out. Read back what
        // is actually persisted without replaying the mutation or permission UI.
        try {
          const state = await readNearbyLocationSetting(value.owner);
          if (owns(value)) setSaved({ owner: value.owner, setting: state });
        } catch { /* Keep the last known value and the explicit save error. */ }
        if (owns(value)) setError("save");
      }
    } finally {
      value.mutating = false;
      if (owns(value)) setBusy(false);
      else {
        const latest = focus.current;
        // Returning to this page during the same account's explicit operation
        // gets a fresh read after it settles, not a replayed permission request.
        if (latest && latest.owner === value.owner && current(value.ticket)
            && owns(latest) && !latest.mutating) void refresh(latest);
      }
    }
  };
  const openSettings = async () => {
    const value = focus.current;
    if (!value || value.owner !== owner || !owns(value) || value.mutating || value.openingSettings || AppState.currentState !== "active") return;
    value.openingSettings = true;
    setOpeningSettings(true);
    try { await Linking.openSettings(); }
    catch { if (owns(value)) setError("link"); }
    finally {
      value.openingSettings = false;
      if (owns(value)) setOpeningSettings(false);
    }
  };
  const settingsRequired = setting?.permission === "denied" || error === "settings";
  const messages = {
    load: copy("位置设置暂时无法读取，请重试。", "Could not read the location setting. Please retry.", "位置設定暫時無法讀取，請重試。"),
    save: copy("位置设置未保存，请重试。", "The location setting could not be saved. Please retry.", "位置設定未儲存，請重試。"),
    unavailable: copy("暂时无法使用当前位置。请重试，或在附近活动中手动填写城市。", "Your location is temporarily unavailable. Retry or enter a city in Nearby family activities.", "暫時無法使用目前位置。請重試，或在附近活動中手動填寫城市。"),
    settings: copy("系统位置权限未开启。请在系统设置中允许 Nuri 使用位置。", "Location permission is off. Allow Nuri to use location in system Settings.", "系統位置權限未開啟。請在系統設定中允許 Nuri 使用位置。"),
    link: copy("系统设置暂时无法打开，请重试。", "Could not open system Settings. Please retry.", "系統設定暫時無法開啟，請重試。"),
  };
  if (!available) return null;
  return <View testID="alpha-nearby-location-setting">
    <SettingsToggle label={copy("使用当前位置", "Use my current location", "使用目前位置")}
      detail={busy ? copy("正在更新位置设置…", "Updating location setting…", "正在更新位置設定…")
        : !setting && !error ? copy("正在读取位置设置…", "Loading location setting…", "正在讀取位置設定…")
        : copy("用于查找附近亲子活动，随时可以关闭。", "Find nearby family activities. You can turn this off anytime.", "用於查找附近親子活動，隨時可以關閉。")}
      value={setting?.enabled === true} disabled={!owner || !setting || busy || error === "load"}
      onChange={enabled => void change(enabled)} testID="alpha-nearby-location-toggle" />
    {error ? <NuriText secondary accessibilityLiveRegion="polite" testID="alpha-nearby-location-error">{messages[error]}</NuriText> : null}
    {settingsRequired ? <View style={{ alignSelf: "flex-start", paddingBottom: 8 }}>
      <SettingsAction label={copy("打开系统设置", "Open Settings", "開啟系統設定")}
        disabled={busy || openingSettings} onPress={() => void openSettings()} testID="alpha-nearby-location-open-settings" />
    </View> : null}
    {error === "load" ? <View style={{ alignSelf: "flex-start", paddingBottom: 8 }}>
      <SettingsAction label={copy("重试", "Retry", "重試")} onPress={() => {
        const value = focus.current;
        if (value && value.owner === owner && owns(value) && !value.mutating) void refresh(value);
      }} testID="alpha-nearby-location-retry" />
    </View> : null}
  </View>;
}
