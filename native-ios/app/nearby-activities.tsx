import { useCallback, useRef } from "react";
import { Linking, Pressable, StyleSheet, View } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";

import { api, ApiError, isAuthError } from "@/src/api";
import { useT } from "@/src/i18n";
import {
  activityCopy, formatActivitySchedule, localActivitiesEnabled, localActivityId, officialActivityUrl,
  validLocalActivity, type ActivityLocale, type LocalActivities, type LocalActivity,
} from "@/src/localActivities";
import { useAccountScope, useAccountState } from "@/src/useAccountState";
import { InlineState, NuriIcon } from "@/src/uiux48/Primitives";
import { FinalDivider, FinalSurface, FinalText } from "@/src/uiuxfinal/Primitives";
import { SettingsButton, SettingsPage } from "@/src/uiuxfinal/Settings";

type LoadError = "missing" | "session" | "load";
const settings = { pathname: "/(tabs)/profile", params: { section: "nearby" } } as const;

export default function NearbyActivities() {
  const { id } = useLocalSearchParams<{ id?: string | string[] }>();
  const { locale } = useT();
  const activityId = localActivityId(id);
  const c = (cn: string, en: string, tw: string) => activityCopy(locale, cn, en, tw);

  if (!localActivitiesEnabled || (id !== undefined && !activityId)) {
    return <SettingsPage testID="local-activity-unavailable">
      <InlineState message={c("此活动暂时无法查看。", "This activity is unavailable.", "此活動暫時無法查看。")} />
    </SettingsPage>;
  }
  return activityId
    ? <ActivityDetail key={activityId} id={activityId} locale={locale} />
    : <ActivitiesDirectory locale={locale} />;
}

function ActivitiesDirectory({ locale }: { locale: ActivityLocale }) {
  const router = useRouter();
  const { capture, current } = useAccountScope();
  const [feed, setFeed] = useAccountState<LocalActivities | null>(null);
  const [error, setError] = useAccountState<LoadError | null>(null);
  const active = useRef(false);
  const sequence = useRef(0);
  const c = (cn: string, en: string, tw: string) => activityCopy(locale, cn, en, tw);

  const load = useCallback(async () => {
    const owner = capture();
    if (owner === null) return;
    const request = ++sequence.current;
    const owns = () => current(owner) && active.current && request === sequence.current;
    setFeed(null);
    setError(null);
    try {
      const result = await api.listLocalActivities(locale);
      if (!owns()) return;
      if (!Array.isArray(result?.items) || !["disabled", "ready", "empty", "unavailable"].includes(result.state)) {
        throw new Error("Invalid local activity response");
      }
      setFeed({ state: result.state, items: result.items.filter(validLocalActivity) });
    } catch (cause) {
      if (owns()) setError(isAuthError(cause) ? "session" : "load");
    }
  }, [capture, current, locale, setError, setFeed]);

  useFocusEffect(useCallback(() => {
    active.current = true;
    void load();
    return () => {
      active.current = false;
      sequence.current += 1;
    };
  }, [load]));

  const items = feed?.state === "ready" ? feed.items : [];
  return <SettingsPage testID="local-activities-screen">
    {error === "session" ? <InlineState
      message={c("请先登录查看附近活动。", "Sign in to see nearby events.", "請先登入查看附近活動。")}
      action={c("登录", "Sign in", "登入")} onPress={() => router.push("/login")} />
    : error === "load" || feed?.state === "unavailable" ? <InlineState
      message={c("附近活动暂时无法读取，请重试。", "Nearby events could not be loaded. Try again.", "附近活動暫時無法讀取，請重試。")}
      action={c("重试", "Retry", "重試")} onPress={() => void load()} />
    : !feed ? <InlineState busy message={c("正在查找附近活动…", "Finding nearby events…", "正在尋找附近活動…")} />
    : feed.state === "disabled" ? <InlineState
      message={c(
        "在设置中选择推荐地区后，即可查看附近活动。",
        "Choose a recommendation area in Settings to see nearby events.",
        "在設定中選擇推薦地區後，即可查看附近活動。",
      )}
      action={c("打开设置", "Open Settings", "開啟設定")} onPress={() => router.push(settings as never)} />
    : items.length === 0 ? <InlineState
      message={c(
        "暂时没有找到时间、地址和适龄范围都已确认的附近活动。",
        "No nearby events with confirmed times, addresses and age ranges are available yet.",
        "暫時沒有找到時間、地址和適齡範圍都已確認的附近活動。",
      )}
      action={c("刷新", "Refresh", "重新整理")} onPress={() => void load()} />
    : items.map(item => <ActivityCard
      key={item.id} item={item} locale={locale}
      open={() => router.push({ pathname: "/nearby-activities", params: { id: item.id } })} />)}
  </SettingsPage>;
}

function ActivityCard({ item, locale, open }: { item: LocalActivity; locale: ActivityLocale; open: () => void }) {
  return <Pressable onPress={open} accessibilityRole="button" testID={`local-activity-${item.id}`}
    style={({ pressed }) => pressed ? styles.pressed : undefined}>
    <FinalSurface contentStyle={styles.card}>
      <View style={styles.titleRow}>
        <FinalText size={20} style={styles.cardTitle}>{item.title}</FinalText>
        <NuriIcon name="chevronRight" size={20} color="#5C5662" />
      </View>
      <ActivityFacts item={item} locale={locale} />
      <FinalText size={14} numberOfLines={3}>{item.summary?.trim() || item.description}</FinalText>
      <ActivityReason text={item.match_reason} locale={locale} />
    </FinalSurface>
  </Pressable>;
}

function ActivityFacts({ item, locale }: { item: LocalActivity; locale: ActivityLocale }) {
  const c = (cn: string, en: string, tw: string) => activityCopy(locale, cn, en, tw);

  return <View style={styles.facts}>
    <View style={styles.fact}>
      <FinalText size={12} secondary style={styles.factLabel}>{c("地点", "Venue", "地點")}</FinalText>
      <View style={styles.factValue}>
        <FinalText size={14} style={styles.emphasis}>{item.venue_name}</FinalText>
        <FinalText size={14} secondary>{item.address}</FinalText>
      </View>
    </View>
    <View style={styles.fact}>
      <FinalText size={12} secondary style={styles.factLabel}>{c("时间", "When", "時間")}</FinalText>
      <FinalText size={14} style={styles.factValue}>{formatActivitySchedule(item, locale)}</FinalText>
    </View>
    <View style={styles.fact}>
      <FinalText size={12} secondary style={styles.factLabel}>{c("适龄", "Ages", "適齡")}</FinalText>
      <FinalText size={14} style={styles.factValue}>{item.age_label}</FinalText>
    </View>
  </View>;
}

function ActivityReason({ text, locale }: { text: string; locale: ActivityLocale }) {
  return <View style={styles.reason}>
    <FinalText size={12} style={styles.reasonLabel}>{activityCopy(locale, "为什么适合你家", "Why it fits your family", "為什麼適合你家")}</FinalText>
    <FinalText size={14}>{text}</FinalText>
  </View>;
}

function ActivityDetail({ id, locale }: { id: string; locale: ActivityLocale }) {
  const router = useRouter();
  const { capture, current } = useAccountScope();
  const [activity, setActivity] = useAccountState<LocalActivity | null>(null);
  const [error, setError] = useAccountState<LoadError | null>(null);
  const [linkFailed, setLinkFailed] = useAccountState(false);
  const active = useRef(false);
  const request = useRef(0);
  const c = (cn: string, en: string, tw: string) => activityCopy(locale, cn, en, tw);

  const load = useCallback(async () => {
    const owner = capture();
    if (owner === null) return;
    const sequence = ++request.current;
    const owns = () => current(owner) && active.current && sequence === request.current;
    setActivity(null);
    setError(null);
    setLinkFailed(false);
    try {
      const result = await api.getLocalActivity(id);
      if (!owns()) return;
      if (!validLocalActivity(result) || result.id !== id) setError("missing");
      else setActivity(result);
    } catch (cause) {
      if (owns()) setError(isAuthError(cause) ? "session" : cause instanceof ApiError && cause.status === 404 ? "missing" : "load");
    }
  }, [capture, current, id, setActivity, setError, setLinkFailed]);

  useFocusEffect(useCallback(() => {
    active.current = true;
    void load();
    return () => {
      active.current = false;
      request.current += 1;
    };
  }, [load]));

  async function openLink(url: string) {
    const owner = capture();
    if (owner === null || !active.current) return;
    const sequence = request.current;
    setLinkFailed(false);
    try {
      await Linking.openURL(url);
    } catch {
      if (current(owner) && active.current && sequence === request.current) setLinkFailed(true);
    }
  }

  const source = officialActivityUrl(activity?.source_url);
  const register = activity?.registration_required === true ? officialActivityUrl(activity.registration_url) : null;
  return <SettingsPage testID="local-activity-detail">
    {error ? <InlineState
      message={error === "session" ? c("请先登录查看活动。", "Sign in to see this event.", "請先登入查看活動。")
        : error === "missing" ? c("此活动已过期或无法查看。", "This event is expired or unavailable.", "此活動已過期或無法查看。")
        : c("活动详情暂时无法读取。", "Event details could not be loaded.", "活動詳情暫時無法讀取。")}
      action={error === "session" ? c("登录", "Sign in", "登入")
        : error === "missing" ? c("查看附近活动", "See nearby events", "查看附近活動") : c("重试", "Retry", "重試")}
      onPress={error === "session" ? () => router.push("/login")
        : error === "missing" ? () => router.replace("/nearby-activities") : () => void load()} />
    : activity ? <FinalSurface contentStyle={styles.detail}>
      <FinalText size={24} style={styles.emphasis} accessibilityRole="header">{activity.title}</FinalText>
      <ActivityFacts item={activity} locale={locale} />
      <FinalDivider />
      <View style={styles.section}>
        <FinalText size={18} style={styles.emphasis} accessibilityRole="header">{c("活动介绍", "About this event", "活動介紹")}</FinalText>
        <FinalText testID="local-activity-description">{activity.description}</FinalText>
      </View>
      <ActivityReason text={activity.match_reason} locale={locale} />
      {activity.cost ? <FinalText secondary>{c("费用", "Cost", "費用")} · {activity.cost}</FinalText> : null}
      {activity.registration_notes ? <FinalText secondary>{activity.registration_notes}</FinalText> : null}
      {activity.registration_required === true && !register ? <FinalText secondary>{c(
        "主办方要求报名，可在该活动的官方页面查看报名方式。",
        "Registration is required. See the organizer’s event page for how to sign up.",
        "主辦方要求報名，可在該活動的官方頁面查看報名方式。",
      )}</FinalText> : null}
      {(register || source) ? <View style={styles.actions}>
        {register ? <SettingsButton
          label={c("报名", "Register", "報名")} testID="local-activity-register"
          onPress={() => void openLink(register)} /> : null}
        {source && source !== register ? <SettingsButton secondary
          label={c("查看主办方活动详情", "Organizer’s event page", "查看主辦方活動詳情")}
          testID="local-activity-source" onPress={() => void openLink(source)} /> : null}
      </View> : null}
      {linkFailed ? <InlineState message={c("链接暂时打不开。", "The link could not be opened.", "連結暫時打不開。")} /> : null}
    </FinalSurface> : <InlineState busy message={c("正在读取活动…", "Loading event…", "正在讀取活動…")} />}
  </SettingsPage>;
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.75 },
  card: { padding: 20, gap: 12 },
  detail: { padding: 20, gap: 16 },
  titleRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  cardTitle: { flex: 1, minWidth: 0, fontWeight: "600" },
  emphasis: { fontWeight: "600" },
  facts: { gap: 8 },
  fact: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  factLabel: { width: 48, paddingTop: 4 },
  factValue: { flex: 1, minWidth: 0 },
  reason: { gap: 4, backgroundColor: "rgba(193,160,221,.14)", padding: 12, borderRadius: 14 },
  reasonLabel: { color: "#735C84", fontWeight: "600" },
  section: { gap: 6 },
  actions: { gap: 10, marginTop: 2 },
});
