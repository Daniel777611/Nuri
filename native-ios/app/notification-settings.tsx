import { useCallback, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";
import { useHeaderHeight } from "@react-navigation/elements";
import { Ionicons } from "@expo/vector-icons";
import { ActivityIndicator, AppState, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";

import { api } from "@/src/api";
import { useT } from "@/src/i18n";
import { getReminderSettings, MAX_LOCAL_REMINDER_INTERVAL_SECONDS, openNotificationSettings, requestNotificationPermission, setReminderSettings, type NativeReminderSettings } from "@/src/nativePush";
import { SafeAreaView } from "@/src/components/NativeSafeAreaView";
import { notificationText, type NotificationCopyKey } from "@/src/components/notificationCopy";
import { parseReminderInterval, withDailyPushPreference } from "@/src/components/reminderInterval";
import { colors, radius, spacing } from "@/src/theme";

export default function NotificationSettings() {
  const { locale } = useT();
  const headerHeight = useHeaderHeight();
  const text = (key: NotificationCopyKey, values?: Record<string, string | number>) => notificationText(locale, key, values);
  const [saved, setSaved] = useState<NativeReminderSettings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [minutes, setMinutes] = useState("0");
  const [seconds, setSeconds] = useState("30");
  const [dailyPush, setDailyPush] = useState(false);
  const [privacyAvailable, setPrivacyAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"local" | "remote" | "permission" | null>(null);
  const busyRef = useRef(false);
  const activeRef = useRef(false);
  const draftDirtyRef = useRef(false);
  const [localMessage, setLocalMessage] = useState<NotificationCopyKey | null>(null);
  const [remoteMessage, setRemoteMessage] = useState<NotificationCopyKey | null>(null);

  const applySettings = useCallback((next: NativeReminderSettings, updateDraft = true) => {
    setSaved(next);
    if (updateDraft) {
      setEnabled(next.enabled);
      setMinutes(String(Math.floor(next.intervalSeconds / 60)));
      setSeconds(String(next.intervalSeconds % 60));
      draftDirtyRef.current = false;
    }
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    const [local, remote] = await Promise.allSettled([getReminderSettings(), api.getPrivacy()]);
    if (!activeRef.current) return;
    if (local.status === "fulfilled") {
      applySettings(local.value, !draftDirtyRef.current);
      setLocalMessage(null);
    } else {
      setLocalMessage("localUnavailable");
    }
    setPrivacyAvailable(remote.status === "fulfilled");
    if (remote.status === "fulfilled") setDailyPush(remote.value?.daily_push === true);
    setLoading(false);
  }, [applySettings]);

  useFocusEffect(useCallback(() => {
    activeRef.current = true;
    void reload();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && !busyRef.current) void reload();
    });
    return () => { activeRef.current = false; subscription.remove(); };
  }, [reload]));

  const changeRemote = async (next: boolean) => {
    if (!privacyAvailable || busyRef.current) return;
    busyRef.current = true;
    setBusy("remote");
    setRemoteMessage(null);
    try {
      // Read fresh preferences so a notification switch never reverts consent.
      const current = await api.getPrivacy();
      await api.setPrivacy(withDailyPushPreference(current, next));
      if (activeRef.current) { setDailyPush(next); setRemoteMessage("remoteSaved"); }
    } catch {
      if (activeRef.current) setRemoteMessage("remoteFailed");
    } finally {
      busyRef.current = false;
      if (activeRef.current) setBusy(null);
    }
  };

  const saveLocal = async () => {
    if (!saved || busyRef.current) return;
    const parsed = parseReminderInterval(minutes, seconds, MAX_LOCAL_REMINDER_INTERVAL_SECONDS);
    // Closing reminders must still work if an unsaved interval is invalid.
    if (enabled && !parsed.ok) {
      setLocalMessage(parsed.reason === "integer" ? "invalidInteger" : parsed.reason === "zero" ? "invalidZero" : "invalidRange");
      return;
    }
    busyRef.current = true;
    setBusy("local");
    try {
      const next = await setReminderSettings(enabled, parsed.ok ? parsed.intervalSeconds : saved.intervalSeconds);
      if (!activeRef.current) return;
      applySettings(next);
      setLocalMessage(!next.enabled ? "stopped" : next.scheduled ? "running" : "notScheduled");
    } catch {
      if (activeRef.current) setLocalMessage("localFailed");
    } finally {
      busyRef.current = false;
      if (activeRef.current) setBusy(null);
    }
  };

  const allowNotifications = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy("permission");
    try {
      await requestNotificationPermission();
      const next = await getReminderSettings();
      if (activeRef.current) applySettings(next, !draftDirtyRef.current);
    } catch {
      if (activeRef.current) setLocalMessage("permissionFailed");
    } finally {
      busyRef.current = false;
      if (activeRef.current) setBusy(null);
    }
  };

  const permissionKey: NotificationCopyKey = saved?.permissionStatus === "authorized" ? "authorized"
    : saved?.permissionStatus === "provisional" ? "provisional"
      : saved?.permissionStatus === "denied" ? "denied"
        : saved?.permissionStatus === "not_determined" ? "notDetermined" : "unknown";
  const disabled = loading || busy !== null;
  const markDirty = () => { draftDirtyRef.current = true; setLocalMessage("dirty"); };

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === "ios" ? "padding" : "height"} keyboardVerticalOffset={headerHeight}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
          <View style={styles.page}>
            <Text style={styles.title}>{text("title")}</Text>
            <Text style={styles.description}>{text("subtitle")}</Text>
            {loading ? <View style={styles.loading}><ActivityIndicator color={colors.brand} /><Text>{text("loading")}</Text></View> : null}

            <View style={styles.card}>
              <View style={styles.heading}><Ionicons name="notifications-outline" size={22} color={colors.brand} /><Text style={styles.sectionTitle}>{text("permission")}</Text></View>
              <Text style={styles.status} testID="notification-permission-status">{text(permissionKey)}</Text>
              {saved && saved.permissionStatus === "not_determined" ? <Action label={text("allow")} onPress={() => void allowNotifications()} disabled={disabled} testID="notification-request-permission" /> : null}
              <Action label={text("systemSettings")} onPress={() => void openNotificationSettings().catch(() => setLocalMessage("settingsFailed"))} disabled={disabled} testID="notification-system-settings" secondary />
            </View>

            <View style={styles.card} testID="remote-notification-preferences">
              <Text style={styles.sectionTitle}>{text("remoteTitle")}</Text>
              <Text style={styles.description}>{text("remoteDescription")}</Text>
              <View style={styles.toggle}><Text style={styles.toggleLabel}>{text("remoteToggle")}</Text><Switch value={dailyPush} disabled={disabled || !privacyAvailable} onValueChange={(next) => void changeRemote(next)} accessibilityLabel={text("remoteToggle")} testID="remote-daily-push-toggle" trackColor={{ true: colors.brand }} /></View>
              {!privacyAvailable && !loading ? <Text style={styles.note}>{text("remoteUnavailable")}</Text> : null}
              {remoteMessage ? <Text style={styles.note} accessibilityLiveRegion="polite">{text(remoteMessage)}</Text> : null}
            </View>

            <View style={styles.card} testID="local-test-reminder-settings">
              <View style={styles.heading}><Text style={styles.sectionTitle}>{text("localTitle")}</Text><Text style={styles.badge}>{text("localBadge")}</Text></View>
              <Text style={styles.description}>{text("localDescription")}</Text>
              <View style={styles.toggle}><Text style={styles.toggleLabel}>{text("localToggle")}</Text><Switch value={enabled} disabled={disabled || !saved} onValueChange={(next) => { setEnabled(next); markDirty(); }} accessibilityLabel={text("localToggle")} testID="local-test-reminder-toggle" trackColor={{ true: colors.brand }} /></View>
              <Text style={styles.fieldLabel}>{text("interval")}</Text>
              <View style={styles.inputs}>
                <View style={styles.field}><TextInput value={minutes} onChangeText={(value) => { setMinutes(value); markDirty(); }} keyboardType="number-pad" editable={!disabled && !!saved} style={styles.input} accessibilityLabel={text("minutes")} testID="reminder-minutes" maxLength={9} /><Text style={styles.unit}>{text("minutes")}</Text></View>
                <View style={styles.field}><TextInput value={seconds} onChangeText={(value) => { setSeconds(value); markDirty(); }} keyboardType="number-pad" editable={!disabled && !!saved} style={styles.input} accessibilityLabel={text("seconds")} testID="reminder-seconds" maxLength={9} /><Text style={styles.unit}>{text("seconds")}</Text></View>
              </View>
              <Text style={styles.note}>{text("intervalHint")}</Text>
              <Action label={text(busy === "local" ? "saving" : "save")} onPress={() => void saveLocal()} disabled={disabled || !saved} testID="local-test-reminder-save" />
              {localMessage ? <Text style={styles.note} accessibilityLiveRegion="polite" testID="local-test-reminder-result">{text(localMessage)}</Text> : null}
              {saved?.enabled && saved.scheduled ? <Text style={styles.note} testID="local-test-reminder-coverage">{saved.mode === "limited" ? text("limited", { count: saved.pendingCount, seconds: saved.coverageSeconds }) : text("repeating", { minutes: Math.floor(saved.intervalSeconds / 60), seconds: saved.intervalSeconds % 60 })}</Text> : null}
            </View>

            <Action label={text("retry")} onPress={() => void reload()} disabled={disabled} testID="notification-settings-retry" secondary />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Action({ label, onPress, disabled, secondary, testID }: { label: string; onPress: () => void; disabled: boolean; secondary?: boolean; testID: string }) {
  return <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => [styles.button, secondary && styles.secondary, disabled && styles.disabled, pressed && styles.pressed]} testID={testID}><Text style={[styles.buttonText, secondary && styles.secondaryText]}>{label}</Text></Pressable>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  fill: { flex: 1 },
  content: { padding: spacing.lg, paddingBottom: spacing.xxxl, alignItems: "center" },
  page: { width: "100%", maxWidth: 520, gap: spacing.md },
  title: { fontSize: 28, fontWeight: "800", color: colors.onSurface },
  description: { fontSize: 14, lineHeight: 22, color: colors.onSurfaceTertiary },
  loading: { flexDirection: "row", gap: spacing.sm, alignItems: "center", paddingVertical: spacing.md },
  card: { gap: spacing.md, backgroundColor: colors.surfaceSecondary, padding: spacing.lg, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border },
  heading: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: spacing.sm },
  sectionTitle: { fontSize: 18, fontWeight: "700", color: colors.onSurface },
  status: { fontSize: 15, fontWeight: "600", color: colors.brand },
  badge: { color: colors.brand, backgroundColor: colors.brandTertiary, paddingHorizontal: 8, paddingVertical: 4, borderRadius: radius.sm, fontSize: 12 },
  toggle: { flexDirection: "row", gap: spacing.md, alignItems: "center", justifyContent: "space-between", minHeight: 44 },
  toggleLabel: { flex: 1, fontSize: 15, color: colors.onSurface },
  fieldLabel: { fontSize: 14, fontWeight: "700", color: colors.onSurface },
  inputs: { flexDirection: "row", gap: spacing.md },
  field: { flex: 1, gap: spacing.xs },
  input: { minHeight: 48, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, fontSize: 20, color: colors.onSurface, backgroundColor: colors.surface },
  unit: { fontSize: 13, color: colors.muted },
  note: { fontSize: 13, lineHeight: 20, color: colors.onSurfaceTertiary },
  button: { minHeight: 44, alignItems: "center", justifyContent: "center", paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.md, backgroundColor: colors.brand },
  secondary: { backgroundColor: colors.brandTertiary },
  buttonText: { color: "#FFFFFF", fontWeight: "700", fontSize: 14, textAlign: "center" },
  secondaryText: { color: colors.brand },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.8 },
});
