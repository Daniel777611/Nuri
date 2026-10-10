// Membership page. Tiers are sized by how much a parent can talk to NURI each
// day: basic (free, ~10 turns), plus (more), unlimited. Today's usage is shown
// first. Not a member → pick a plan → Stripe Checkout. A member switches plan
// in place (POST /billing/change, after a confirm step, since an upgrade is
// charged at once) and manages payment details in the Stripe Customer Portal.
// Both Stripe pages are hosted by Stripe, so no card field ever renders here.
//
// Inside the iOS/Android shells it shows the same buttons only where a link
// out to another payment method is allowed (see usePurchaseAllowed): the
// United States App Store storefront on iOS, and the Android APK. Stripe then
// opens in the phone's browser — the shells send every non-NURI https link
// there — and comes back to /billing?from=app in that browser, which is not
// signed in, so that visit only says "go back to the app". Back in the app,
// the page re-reads the membership when it returns to the foreground.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";

import {
  api,
  apiErrorDetail,
  type BillingInterval,
  type BillingPlan,
  type BillingStatus,
  type BillingTier,
  type BillingUsage,
  type PaidTier,
} from "@/src/api";
import { useT } from "@/src/i18n";
import { isNativeShell, useOnReturnToApp, usePurchaseAllowed } from "@/src/nativeShell";
import { colors, radius, spacing, type } from "@/src/theme";

/** The iOS shell registers this scheme; opening it brings the app forward. */
const IOS_APP_URL = "nuri://";

const FIGMA_FRAME_WIDTH = 402;

function openExternal(url: string) {
  if (Platform.OS === "web" && typeof window !== "undefined") {
    window.location.assign(url);
  } else {
    Linking.openURL(url);
  }
}

function formatPrice(plan: BillingPlan, locale: string): string {
  if (plan.unit_amount == null || !plan.currency) return "";
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: plan.currency.toUpperCase(),
    }).format(plan.unit_amount / 100);
  } catch {
    return `${(plan.unit_amount / 100).toFixed(2)} ${plan.currency.toUpperCase()}`;
  }
}

function formatDate(iso: string | null | undefined, locale: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(locale);
}

export default function Billing() {
  const params = useLocalSearchParams<{ checkout?: string; from?: string }>();
  // Stripe sent a parent who started in the app back to this page in their
  // phone's browser. They aren't signed in here; point them back to the app.
  if (params.from === "app" && !isNativeShell()) {
    return <BackToApp checkout={params.checkout} />;
  }
  return <BillingPage checkout={params.checkout} />;
}

function BillingPage({ checkout }: { checkout?: string }) {
  const router = useRouter();
  const { t, locale } = useT();
  const { width: viewportWidth } = useWindowDimensions();
  const phoneWidth = Math.min(viewportWidth, FIGMA_FRAME_WIDTH);
  const checkoutResult = checkout === "success" || checkout === "cancel" ? checkout : null;

  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [intervalChoice, setIntervalChoice] = useState<BillingInterval>("month");
  const [pendingChange, setPendingChange] = useState<BillingPlan | null>(null);
  const inShell = isNativeShell();
  const purchaseAllowed = usePurchaseAllowed();
  const returnTo = inShell ? "app" : "web";

  const load = useCallback(async () => {
    try {
      const next = await api.billingStatus();
      setStatus(next);
      setLoadFailed(false);
      return next;
    } catch {
      setLoadFailed(true);
      return null;
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  // A member sees their own interval first.
  const subInterval = status?.subscription?.interval;
  useEffect(() => {
    if (status?.entitled && subInterval) setIntervalChoice(subInterval);
  }, [status?.entitled, subInterval]);

  // Returning from Checkout can beat the webhook here by a few seconds; keep
  // re-reading briefly so the page doesn't tell a parent who just paid that
  // they aren't a member.
  // The plan buttons stay hidden meanwhile: offering them to someone who has
  // just paid is how a second subscription gets bought.
  const polled = useRef(false);
  const [syncing, setSyncing] = useState(checkoutResult === "success");
  const pollUntilMember = useCallback(async (isCancelled: () => boolean) => {
    setSyncing(true);
    for (let i = 0; i < 8 && !isCancelled(); i++) {
      const next = await load();
      if (next?.entitled) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!isCancelled()) setSyncing(false);
  }, [load]);

  useEffect(() => {
    if (checkoutResult !== "success" || polled.current) return;
    polled.current = true;
    let cancelled = false;
    pollUntilMember(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [checkoutResult, pollUntilMember]);

  // In the app, Stripe runs in the phone's browser and this page never sees
  // it finish. Coming back to the app is the signal: re-read, and if the
  // parent had gone to pay, wait briefly for the webhook.
  const leftToPay = useRef(false);
  useOnReturnToApp(useCallback(() => {
    setBusy(null);
    if (leftToPay.current) {
      leftToPay.current = false;
      pollUntilMember(() => false);
    } else {
      load();
    }
  }, [load, pollUntilMember]));

  const subscribe = async (plan: BillingPlan) => {
    setBusy(planKey(plan));
    setActionError("");
    setNotice("");
    try {
      const { url } = await api.billingCheckout(plan.tier, plan.interval, returnTo);
      leftToPay.current = inShell;
      openExternal(url);
      // In the app this page stays put while the browser opens; don't leave
      // the button spinning if the parent comes straight back.
      if (inShell) setTimeout(() => setBusy(null), 3000);
    } catch (err) {
      setActionError(
        apiErrorDetail(err) === "ALREADY_SUBSCRIBED"
          ? t("你已经是会员了，如需更换方案请点“管理订阅”。")
          : t("暂时无法打开支付页面，请稍后再试。")
      );
      load();
      setBusy(null);
    }
  };

  const change = async (plan: BillingPlan) => {
    setBusy(planKey(plan));
    setActionError("");
    setNotice("");
    try {
      const next = await api.billingChange(plan.tier, plan.interval);
      setStatus((prev) => ({ ...(prev || next), ...next }));
      setPendingChange(null);
      setNotice(t("方案已更新为「{plan}」。", { plan: tierName(plan.tier, t) }));
      load();
    } catch (err) {
      const code = apiErrorDetail(err);
      setActionError(
        code === "PAYMENT_FAILED"
          ? t("扣款没有成功，方案没有变化。请在“管理订阅”里更新付款方式后再试。")
          : t("暂时无法更换方案，请稍后再试。")
      );
    } finally {
      setBusy(null);
    }
  };

  const manage = async () => {
    setBusy("portal");
    setActionError("");
    try {
      const { url } = await api.billingPortal(returnTo);
      openExternal(url);
      if (inShell) setTimeout(() => setBusy(null), 3000);
    } catch {
      setActionError(t("暂时无法打开订阅管理，请稍后再试。"));
      setBusy(null);
    }
  };

  const sub = status?.subscription;
  const currentTier: BillingTier = status?.tier || "basic";
  const plans = status?.plans || [];
  const intervals = INTERVALS.filter((i) => plans.some((p) => p.interval === i));
  const shownInterval = intervals.includes(intervalChoice) ? intervalChoice : intervals[0];
  const currentPlan = status?.entitled
    ? plans.find((p) => p.tier === currentTier && p.interval === sub?.interval) || null
    : null;
  const canBuy = !inShell || purchaseAllowed;

  const intervalLabel = (i: BillingInterval | null | undefined) =>
    i === "year" ? t("年付") : i === "month" ? t("月付") : "";

  const allowanceText = (tier: BillingTier) => {
    const turns = status?.allowances?.[tier];
    if (turns === null) return t("不限对话次数");
    if (turns == null) return "";
    return t("每天 {n} 轮对话", { n: turns });
  };

  const isUpgrade = (plan: BillingPlan) =>
    !currentPlan || monthlyAmount(plan) > monthlyAmount(currentPlan);

  const planAction = (plan: BillingPlan) => {
    if (!status?.entitled) return { label: t("订阅"), onPress: () => subscribe(plan) };
    if (currentPlan && planKey(plan) === planKey(currentPlan)) return null;
    return {
      label: TIER_RANK[plan.tier] > TIER_RANK[currentTier] ? t("升级") : t("切换"),
      onPress: () => {
        setActionError("");
        setPendingChange(plan);
      },
    };
  };

  const loading = (!status && !loadFailed) || (syncing && !status?.entitled);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={[styles.phoneCanvas, { width: phoneWidth }]}>
        <ScrollView contentContainerStyle={{ paddingBottom: spacing.xxxl }} showsVerticalScrollIndicator={false}>
          <Pressable
            onPress={() => (router.canGoBack() ? router.back() : router.replace("/profile"))}
            style={styles.back}
            hitSlop={8}
            testID="billing-back-btn"
          >
            <Ionicons name="chevron-back" size={24} color={colors.onSurface} />
            <Text style={styles.backText}>{t("返回")}</Text>
          </Pressable>

          <View style={styles.hero}>
            <View style={styles.heroIcon}>
              <Ionicons name="sparkles-outline" size={26} color={colors.brand} />
            </View>
            <Text style={styles.title}>{t("NURI 会员")}</Text>
            <Text style={styles.subtitle}>{t("按每天想和 NURI 聊多少，选择适合你的方案。")}</Text>
          </View>

          {checkoutResult === "success" ? (
            <Banner tone="success" testID="billing-banner-success">
              {status?.entitled
                ? t("支付成功，欢迎成为 NURI 会员！")
                : syncing
                  ? t("支付成功，会员状态正在同步，请稍候…")
                  : t("会员状态还在同步中，请稍后刷新本页。如已扣款，无需重复支付。")}
            </Banner>
          ) : checkoutResult === "cancel" ? (
            <Banner tone="muted" testID="billing-banner-cancel">{t("已取消支付，没有产生扣款。")}</Banner>
          ) : null}

          {loading ? (
            <ActivityIndicator style={{ marginTop: spacing.xxl }} color={colors.brand} />
          ) : loadFailed || !status ? (
            <Banner tone="error" testID="billing-load-failed">
              {t("会员信息暂时无法读取，请稍后再试。")}
            </Banner>
          ) : (
            <View style={{ paddingHorizontal: spacing.lg, gap: spacing.md }}>
              {status.usage ? (
                <UsageCard
                  usage={status.usage}
                  tierLabel={status.usage.override ? t("专属额度") : tierName(status.usage.tier, t)}
                  locale={locale}
                />
              ) : null}

              {status.entitled && sub ? (
                <View style={styles.card} testID="billing-member-card">
                  <View style={styles.memberRow}>
                    <Ionicons name="checkmark-circle" size={20} color={colors.brand} />
                    <Text style={styles.memberTitle}>
                      {t("你是「{plan}」会员", { plan: tierName(currentTier, t) })}
                    </Text>
                    {intervalLabel(sub.interval) ? <Text style={styles.chip}>{intervalLabel(sub.interval)}</Text> : null}
                  </View>
                  {sub.status === "past_due" ? (
                    <Text style={[styles.meta, { color: colors.error }]}>
                      {t("上次扣款没有成功，请更新付款方式以免会员中断。")}
                    </Text>
                  ) : sub.current_period_end ? (
                    <Text style={styles.meta}>
                      {sub.cancel_at_period_end
                        ? t("会员将于 {date} 到期，不再续费", { date: formatDate(sub.current_period_end, locale) })
                        : t("下次续费日期：{date}", { date: formatDate(sub.current_period_end, locale) })}
                    </Text>
                  ) : null}
                  <Pressable
                    style={[styles.secondaryBtn, busy === "portal" && styles.disabled]}
                    onPress={manage}
                    disabled={busy !== null}
                    testID="billing-manage-btn"
                  >
                    {busy === "portal" ? (
                      <ActivityIndicator color={colors.brand} />
                    ) : (
                      <Text style={styles.secondaryBtnText}>{t("管理订阅")}</Text>
                    )}
                  </Pressable>
                </View>
              ) : null}

              {!canBuy ? (
                <Banner tone="muted" testID="billing-shell-notice" inset={false}>
                  {t("App 内暂不支持开通会员。")}
                </Banner>
              ) : !status.enabled || !plans.length ? (
                <Banner tone="muted" testID="billing-disabled" inset={false}>
                  {t("会员订阅暂未开放，敬请期待。")}
                </Banner>
              ) : (
                <>
                  {intervals.length > 1 ? (
                    <View style={styles.toggle} testID="billing-interval-toggle">
                      {intervals.map((i) => (
                        <Pressable
                          key={i}
                          style={[styles.toggleItem, shownInterval === i && styles.toggleItemOn]}
                          onPress={() => setIntervalChoice(i)}
                          testID={`billing-interval-${i}`}
                        >
                          <Text style={[styles.toggleText, shownInterval === i && styles.toggleTextOn]}>
                            {intervalLabel(i)}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  ) : null}

                  <TierCard
                    testID="billing-tier-basic"
                    name={tierName("basic", t)}
                    price={t("免费")}
                    allowance={allowanceText("basic")}
                    current={currentTier === "basic"}
                    currentLabel={t("当前方案")}
                  />
                  {PAID_TIERS.map((tier) => {
                    const plan = plans.find((p) => p.tier === tier && p.interval === shownInterval);
                    if (!plan) return null;
                    const action = planAction(plan);
                    return (
                      <TierCard
                        key={tier}
                        testID={`billing-tier-${tier}`}
                        name={tierName(tier, t)}
                        price={formatPrice(plan, locale)}
                        per={plan.interval === "year" ? t("每年") : t("每月")}
                        allowance={allowanceText(tier)}
                        featured={tier === "unlimited"}
                        current={!!currentPlan && planKey(plan) === planKey(currentPlan)}
                        currentLabel={t("当前方案")}
                        action={action?.label}
                        busy={busy === planKey(plan)}
                        disabled={busy !== null || syncing}
                        onPress={action?.onPress}
                      />
                    );
                  })}

                  {pendingChange ? (
                    <View style={[styles.card, styles.confirmCard]} testID="billing-change-confirm">
                      <Text style={styles.confirmTitle}>
                        {t("切换到「{plan}」（{interval}）？", {
                          plan: tierName(pendingChange.tier, t),
                          interval: intervalLabel(pendingChange.interval),
                        })}
                      </Text>
                      <Text style={styles.meta}>
                        {isUpgrade(pendingChange)
                          ? t("会立即按本期剩余天数补差价，新额度马上生效。")
                          : t("立即生效，本期多付的部分会抵扣下一次账单。")}
                      </Text>
                      <View style={styles.confirmRow}>
                        <Pressable
                          style={[styles.secondaryBtn, styles.confirmBtn]}
                          onPress={() => setPendingChange(null)}
                          disabled={busy !== null}
                          testID="billing-change-cancel"
                        >
                          <Text style={styles.secondaryBtnText}>{t("取消")}</Text>
                        </Pressable>
                        <Pressable
                          style={[styles.primaryBtn, styles.confirmBtn, busy !== null && styles.disabled]}
                          onPress={() => change(pendingChange)}
                          disabled={busy !== null}
                          testID="billing-change-confirm-btn"
                        >
                          {busy === planKey(pendingChange) ? (
                            <ActivityIndicator color="#fff" />
                          ) : (
                            <Text style={styles.primaryBtnText}>{t("确认")}</Text>
                          )}
                        </Pressable>
                      </View>
                    </View>
                  ) : null}

                  {status.has_customer && !status.entitled ? (
                    <Pressable onPress={manage} disabled={busy !== null} testID="billing-history-btn">
                      <Text style={styles.link}>{t("查看付款记录")}</Text>
                    </Pressable>
                  ) : null}
                  <Text style={styles.fineprint}>
                    {t("付款由 Stripe 安全处理，NURI 不会保存你的银行卡信息。订阅会自动续费，可随时取消。")}
                  </Text>
                  {inShell && !status.entitled ? (
                    // Said before the parent leaves the app, not after.
                    <Text style={styles.fineprint} testID="billing-external-notice">
                      {t("点击订阅后，会在手机浏览器中打开 Stripe 付款页面；付款完成后回到 NURI App 即可。")}
                    </Text>
                  ) : null}
                </>
              )}
            </View>
          )}

          {notice ? <Banner tone="success" testID="billing-change-done">{notice}</Banner> : null}
          {actionError ? <Banner tone="error" testID="billing-action-error">{actionError}</Banner> : null}
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

/** What the phone's browser shows after a checkout or Portal visit that
 *  started in the app. No API calls: this browser isn't signed in. */
function BackToApp({ checkout }: { checkout?: string }) {
  const { t } = useT();
  const isIos = typeof navigator !== "undefined" && /iPhone|iPad|iPod/.test(navigator.userAgent || "");
  const title =
    checkout === "success"
      ? t("付款成功")
      : checkout === "cancel"
        ? t("已取消支付，没有产生扣款。")
        : t("订阅设置已更新");
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.backToApp} testID="billing-back-to-app">
        <View style={styles.heroIcon}>
          <Ionicons
            name={checkout === "success" ? "checkmark-circle-outline" : "phone-portrait-outline"}
            size={26}
            color={colors.brand}
          />
        </View>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.subtitle}>{t("请回到 NURI App，会员状态会自动更新。")}</Text>
        {isIos ? (
          <Pressable
            style={[styles.primaryBtn, { marginTop: spacing.lg }]}
            onPress={() => Linking.openURL(IOS_APP_URL)}
            testID="billing-open-app-btn"
          >
            <Text style={styles.primaryBtnText}>{t("打开 NURI App")}</Text>
          </Pressable>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

const INTERVALS: BillingInterval[] = ["month", "year"];
const PAID_TIERS: PaidTier[] = ["plus", "unlimited"];
const TIER_RANK: Record<BillingTier, number> = { basic: 0, plus: 1, unlimited: 2 };

type Translate = ReturnType<typeof useT>["t"];

function tierName(tier: BillingTier, t: Translate): string {
  return tier === "unlimited" ? t("无限") : tier === "plus" ? t("进阶") : t("基础");
}

function planKey(plan: BillingPlan): string {
  return `${plan.tier}:${plan.interval}`;
}

function monthlyAmount(plan: BillingPlan): number {
  const amount = plan.unit_amount || 0;
  return plan.interval === "year" ? amount / 12 : amount;
}

function formatTime(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}

function UsageCard({
  usage,
  tierLabel,
  locale,
}: {
  usage: BillingUsage;
  tierLabel: string;
  locale: string;
}) {
  const { t } = useT();
  const unlimited = usage.limit == null;
  const share = unlimited || !usage.limit ? 0 : Math.min(1, usage.used / usage.limit);
  const perTurn = usage.tokens_per_turn;
  const turnsLeft =
    !unlimited && perTurn ? Math.max(0, Math.floor((usage.remaining || 0) / perTurn)) : null;
  return (
    <View style={styles.card} testID="billing-usage-card">
      <View style={styles.memberRow}>
        <Text style={[styles.memberTitle, { fontSize: type.base }]}>{t("今日对话额度")}</Text>
        <Text style={styles.chip}>{tierLabel}</Text>
      </View>
      {unlimited ? (
        <Text style={styles.meta}>{t("不限对话次数，畅聊无忧。")}</Text>
      ) : (
        <>
          <View style={styles.meter}>
            <View
              style={[
                styles.meterFill,
                { width: `${Math.round(share * 100)}%` },
                usage.exhausted && { backgroundColor: colors.error },
              ]}
            />
          </View>
          <Text style={styles.meta} testID="billing-usage-text">
            {usage.exhausted
              ? t("今天的额度已用完，{time} 恢复。", { time: formatTime(usage.resets_at, locale) })
              : turnsLeft != null
                ? t("今天还能聊约 {n} 轮，{time} 重置。", {
                    n: turnsLeft,
                    time: formatTime(usage.resets_at, locale),
                  })
                : t("已用 {pct}%", { pct: Math.round(share * 100) })}
          </Text>
        </>
      )}
    </View>
  );
}

function TierCard({
  name,
  price,
  per,
  allowance,
  featured,
  current,
  currentLabel,
  action,
  busy,
  disabled,
  onPress,
  testID,
}: {
  name: string;
  price: string;
  per?: string;
  allowance: string;
  featured?: boolean;
  current?: boolean;
  currentLabel: string;
  action?: string;
  busy?: boolean;
  disabled?: boolean;
  onPress?: () => void;
  testID: string;
}) {
  return (
    <View
      style={[styles.card, styles.planCard, featured && styles.planFeatured, current && styles.planCurrent]}
      testID={testID}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.planLabel}>{name}</Text>
        <Text style={styles.planPrice}>
          {price}
          {per ? <Text style={styles.planPer}> / {per}</Text> : null}
        </Text>
        {allowance ? <Text style={styles.meta}>{allowance}</Text> : null}
      </View>
      {current ? (
        <Text style={styles.chip} testID={`${testID}-current`}>{currentLabel}</Text>
      ) : action && onPress ? (
        <Pressable
          style={[styles.primaryBtn, disabled && !busy && styles.disabled]}
          onPress={onPress}
          disabled={disabled}
          testID={`${testID}-action`}
        >
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>{action}</Text>}
        </Pressable>
      ) : null}
    </View>
  );
}

function Banner({
  tone,
  children,
  testID,
  inset = true,
}: {
  tone: "success" | "muted" | "error";
  children: React.ReactNode;
  testID: string;
  /** False inside a container that already pads its children. */
  inset?: boolean;
}) {
  const palette = {
    success: { bg: colors.brandTertiary, fg: colors.onBrandTertiary },
    muted: { bg: colors.surfaceTertiary, fg: colors.onSurfaceTertiary },
    error: { bg: "#FFF4F2", fg: colors.error },
  }[tone];
  return (
    <View
      style={[styles.banner, !inset && { marginHorizontal: 0, marginBottom: 0 }, { backgroundColor: palette.bg }]}
      testID={testID}
    >
      <Text style={{ color: palette.fg, fontSize: type.base, lineHeight: 20 }}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  phoneCanvas: { flex: 1, alignSelf: "center", overflow: "hidden" },
  back: { flexDirection: "row", alignItems: "center", paddingHorizontal: spacing.md, paddingTop: spacing.sm },
  backText: { fontSize: type.lg, fontWeight: "700", color: colors.onSurface },
  hero: { alignItems: "center", paddingHorizontal: spacing.lg, paddingVertical: spacing.xl, gap: spacing.sm },
  heroIcon: {
    width: 56,
    height: 56,
    borderRadius: radius.pill,
    backgroundColor: colors.brandTertiary,
    alignItems: "center",
    justifyContent: "center",
  },
  title: { fontSize: type.xxl, fontWeight: "700", color: colors.onSurface },
  subtitle: { fontSize: type.base, color: colors.muted, textAlign: "center" },
  card: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    borderColor: colors.border,
    borderWidth: 1,
    padding: spacing.lg,
    gap: spacing.sm,
    marginHorizontal: 0,
  },
  planCard: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  planFeatured: { borderColor: colors.brand, borderWidth: 2 },
  planCurrent: { backgroundColor: colors.brandTertiary },
  toggle: {
    flexDirection: "row",
    alignSelf: "center",
    backgroundColor: colors.surfaceTertiary,
    borderRadius: radius.pill,
    padding: 3,
  },
  toggleItem: { paddingHorizontal: spacing.lg, paddingVertical: spacing.xs + 2, borderRadius: radius.pill },
  toggleItemOn: { backgroundColor: "#fff" },
  toggleText: { fontSize: type.base, color: colors.muted, fontWeight: "600" },
  toggleTextOn: { color: colors.onSurface },
  meter: {
    height: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceTertiary,
    overflow: "hidden",
  },
  meterFill: { height: 8, borderRadius: radius.pill, backgroundColor: colors.brand },
  confirmCard: { borderColor: colors.brand },
  confirmTitle: { fontSize: type.base, fontWeight: "700", color: colors.onSurface },
  confirmRow: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.xs },
  confirmBtn: { flex: 1, marginTop: 0, minWidth: 0 },
  planLabel: { fontSize: type.base, color: colors.muted, fontWeight: "600" },
  planPrice: { fontSize: type.xl, color: colors.onSurface, fontWeight: "700", marginTop: 2 },
  planPer: { fontSize: type.sm, color: colors.muted, fontWeight: "400" },
  primaryBtn: {
    backgroundColor: "#3A2F5A",
    borderRadius: radius.pill,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm + 2,
    minWidth: 88,
    alignItems: "center",
  },
  primaryBtnText: { color: "#fff", fontWeight: "700", fontSize: type.base },
  secondaryBtn: {
    marginTop: spacing.sm,
    borderRadius: radius.pill,
    borderColor: colors.brand,
    borderWidth: 1,
    paddingVertical: spacing.sm + 2,
    alignItems: "center",
  },
  secondaryBtnText: { color: colors.brand, fontWeight: "700", fontSize: type.base },
  disabled: { opacity: 0.55 },
  memberRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  memberTitle: { fontSize: type.lg, fontWeight: "700", color: colors.onSurface, flex: 1 },
  chip: {
    fontSize: type.sm,
    color: colors.onBrandTertiary,
    backgroundColor: colors.brandTertiary,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    overflow: "hidden",
  },
  meta: { fontSize: type.sm, color: colors.muted },
  link: { color: colors.brand, fontWeight: "600", fontSize: type.base, textAlign: "center" },
  fineprint: { fontSize: type.sm, color: colors.muted, lineHeight: 18, textAlign: "center" },
  backToApp: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.xl,
    gap: spacing.sm,
  },
  banner: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    borderRadius: radius.md,
    padding: spacing.md,
  },
});
