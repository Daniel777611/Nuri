// Membership page: pick a plan → Stripe Checkout; already a member → Stripe
// Customer Portal. Both are Stripe-hosted, so no card field ever renders here.
//
// Inside the iOS/Android shells it shows the same buttons only where a link
// out to another payment method is allowed (see usePurchaseAllowed): the
// United States App Store storefront on iOS, and the Android APK. Stripe then
// opens in the phone's browser — the shells send every non-NURI https link
// there — and comes back to /billing?from=app in that browser, which is not
// signed in, so that visit only says "go back to the app". Back in the app,
// the page re-reads the membership when it returns to the foreground.
// Native Lab iOS is deliberately read-only: the backend's app payment return
// still targets the original shell. Status queries remain available regardless
// of storefront capability, but Checkout/Portal cannot be started in this lab.

import { useCallback, useEffect, useRef, useState } from "react";
import { useAccountScope, useAccountState } from "@/src/useAccountState";
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
import { SafeAreaView } from "@/src/components/NativeSafeAreaView";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";

import { api, apiErrorDetail, type BillingInterval, type BillingPlan, type BillingStatus } from "@/src/api";
import { useT } from "@/src/i18n";
import { isNativeShell, useOnReturnToApp, usePurchaseAllowed } from "@/src/nativeShell";
import { colors, radius, spacing, type } from "@/src/theme";

/** Only open the independent lab; never route back into the public shell. */
const IOS_APP_URL = "nuri-native-lab://";

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
  const { capture, current } = useAccountScope();
  const router = useRouter();
  const { t, locale } = useT();
  const { width: viewportWidth } = useWindowDimensions();
  const phoneWidth = Math.min(viewportWidth, FIGMA_FRAME_WIDTH);
  const nativeLabReadOnly = Platform.OS === "ios";
  const readOnlyNotice = locale === "en"
    ? "NURI Native Lab shows membership status only. Payment return links are not yet isolated from the original app, so subscriptions, subscription management, and payment history are unavailable in this iOS test app."
    : locale === "zh-TW"
      ? "NURI Native Lab 僅供查看會員狀態。付款返回連結尚未適配獨立實驗版，此 iOS 實驗版暫不支援開通、管理訂閱或查看付款紀錄。"
      : "NURI Native Lab 仅供查看会员状态。支付返回链接尚未适配独立实验版，此 iOS 实验版暂不支持开通、管理订阅或查看付款记录。";
  const checkoutResult = !nativeLabReadOnly && (checkout === "success" || checkout === "cancel") ? checkout : null;

  const [status, setStatus] = useAccountState<BillingStatus | null>(null);
  const [loadFailed, setLoadFailed] = useAccountState(false);
  const [busy, setBusy] = useState<BillingInterval | "portal" | null>(null);
  const [actionError, setActionError] = useState("");
  const inShell = isNativeShell();
  const purchaseAllowed = usePurchaseAllowed();
  const returnTo = inShell ? "app" : "web";

  const load = useCallback(async () => {
    const ticket = capture();
    if (ticket === null) return null;
    try {
      const next = await api.billingStatus();
      if (!current(ticket)) return null;
      setStatus(next);
      setLoadFailed(false);
      return next;
    } catch {
      if (!current(ticket)) return null;
      setLoadFailed(true);
      return null;
    }
  }, [capture, current, setStatus, setLoadFailed]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

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

  const subscribe = async (interval: BillingInterval) => {
    if (Platform.OS === "ios") return;
    setBusy(interval);
    setActionError("");
    try {
      const { url } = await api.billingCheckout(interval, returnTo);
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

  const manage = async () => {
    if (Platform.OS === "ios") return;
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
  const planLabel = (interval: BillingInterval | null | undefined) =>
    interval === "year" ? t("年付") : interval === "month" ? t("月付") : "";

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <View style={[styles.phoneCanvas, { width: phoneWidth }]}>
        <ScrollView contentContainerStyle={{ paddingBottom: spacing.xxxl }} showsVerticalScrollIndicator={false}>
          <Pressable
            onPress={() => (router.canGoBack() ? router.back() : router.replace("/(tabs)/profile"))}
            style={[styles.back, Platform.OS !== "web" && { display: "none" }]}
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
            <Text style={styles.subtitle}>{t("解锁完整的 NURI 育儿陪伴。")}</Text>
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

          {nativeLabReadOnly ? <Banner tone="muted" testID="billing-native-lab-read-only">{readOnlyNotice}</Banner> : null}

          {inShell && !purchaseAllowed && !nativeLabReadOnly ? (
            <Banner tone="muted" testID="billing-shell-notice">{t("App 内暂不支持开通会员。")}</Banner>
          ) : (!status && !loadFailed) || (syncing && !status?.entitled) ? (
            <ActivityIndicator style={{ marginTop: spacing.xxl }} color={colors.brand} />
          ) : loadFailed ? (
            <Banner tone="error" testID="billing-load-failed">
              {t("会员信息暂时无法读取，请稍后再试。")}
            </Banner>
          ) : status?.entitled && (sub || nativeLabReadOnly) ? (
            <View style={[styles.card, { marginHorizontal: spacing.lg }]} testID="billing-member-card">
              <View style={styles.memberRow}>
                <Ionicons name="checkmark-circle" size={20} color={colors.brand} />
                <Text style={styles.memberTitle}>{t("你已是 NURI 会员")}</Text>
                {planLabel(sub?.interval) ? <Text style={styles.chip}>{planLabel(sub?.interval)}</Text> : null}
              </View>
              {sub?.status === "past_due" ? (
                <Text style={[styles.meta, { color: colors.error }]}>
                  {t("上次扣款没有成功，请更新付款方式以免会员中断。")}
                </Text>
              ) : sub?.current_period_end ? (
                <Text style={styles.meta}>
                  {sub.cancel_at_period_end
                    ? t("会员将于 {date} 到期，不再续费", { date: formatDate(sub.current_period_end, locale) })
                    : t("下次续费日期：{date}", { date: formatDate(sub.current_period_end, locale) })}
                </Text>
              ) : null}
              <Pressable
                style={[styles.secondaryBtn, (nativeLabReadOnly || busy === "portal") && styles.disabled]}
                onPress={manage}
                disabled={nativeLabReadOnly || busy !== null}
                testID="billing-manage-btn"
              >
                {busy === "portal" ? (
                  <ActivityIndicator color={colors.brand} />
                ) : (
                  <Text style={styles.secondaryBtnText}>{t("管理订阅")}</Text>
                )}
              </Pressable>
            </View>
          ) : !status?.enabled || !status.plans.length ? (
            <Banner tone="muted" testID="billing-disabled">{t("会员订阅暂未开放，敬请期待。")}</Banner>
          ) : (
            <View style={{ paddingHorizontal: spacing.lg, gap: spacing.md }}>
              {sortPlans(status.plans).map((plan) => (
                <PlanCard
                  key={plan.interval}
                  plan={plan}
                  price={formatPrice(plan, locale)}
                  label={planLabel(plan.interval)}
                  per={plan.interval === "year" ? t("每年") : t("每月")}
                  cta={t("订阅")}
                  busy={busy === plan.interval}
                  disabled={nativeLabReadOnly || busy !== null}
                  onPress={() => subscribe(plan.interval)}
                />
              ))}
              {status.has_customer ? (
                <Pressable onPress={manage} disabled={nativeLabReadOnly || busy !== null} testID="billing-history-btn">
                  <Text style={styles.link}>{t("查看付款记录")}</Text>
                </Pressable>
              ) : null}
              {!nativeLabReadOnly ? <Text style={styles.fineprint}>
                {t("付款由 Stripe 安全处理，NURI 不会保存你的银行卡信息。订阅会自动续费，可随时取消。")}
              </Text> : null}
              {inShell && !nativeLabReadOnly ? (
                // Said before the parent leaves the app, not after.
                <Text style={styles.fineprint} testID="billing-external-notice">
                  {t("点击订阅后，会在手机浏览器中打开 Stripe 付款页面；付款完成后回到 NURI App 即可。")}
                </Text>
              ) : null}
            </View>
          )}

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

function sortPlans(plans: BillingPlan[]): BillingPlan[] {
  // Yearly first: it's the one we'd rather a parent notice.
  const rank = (p: BillingPlan) => (p.interval === "year" ? 0 : 1);
  return [...plans].sort((a, b) => rank(a) - rank(b));
}

function PlanCard({
  plan,
  price,
  label,
  per,
  cta,
  busy,
  disabled,
  onPress,
}: {
  plan: BillingPlan;
  price: string;
  label: string;
  per: string;
  cta: string;
  busy: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const featured = plan.interval === "year";
  return (
    <View style={[styles.card, styles.planCard, featured && styles.planFeatured]} testID={`billing-plan-${plan.interval}`}>
      <View style={{ flex: 1 }}>
        <Text style={styles.planLabel}>{label}</Text>
        <Text style={styles.planPrice}>
          {price}
          <Text style={styles.planPer}> / {per}</Text>
        </Text>
      </View>
      <Pressable
        style={[styles.primaryBtn, disabled && !busy && styles.disabled]}
        onPress={onPress}
        disabled={disabled}
        testID={`billing-subscribe-${plan.interval}`}
      >
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>{cta}</Text>}
      </Pressable>
    </View>
  );
}

function Banner({
  tone,
  children,
  testID,
}: {
  tone: "success" | "muted" | "error";
  children: React.ReactNode;
  testID: string;
}) {
  const palette = {
    success: { bg: colors.brandTertiary, fg: colors.onBrandTertiary },
    muted: { bg: colors.surfaceTertiary, fg: colors.onSurfaceTertiary },
    error: { bg: "#FFF4F2", fg: colors.error },
  }[tone];
  return (
    <View style={[styles.banner, { backgroundColor: palette.bg }]} testID={testID}>
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
