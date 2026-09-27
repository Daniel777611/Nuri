// Membership page: pick a plan → Stripe Checkout; already a member → Stripe
// Customer Portal. Both are Stripe-hosted, so no card field ever renders here.
//
// Web only for now. Inside the iOS/Android shells the page shows nothing to
// buy: Apple allows an external purchase link only on the US storefront, and
// the shells can't yet tell which storefront they're on or bring Safari back
// into the app afterwards (see the payments groundwork notes). Google Play has
// its own billing rules that haven't been checked.

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

import { api, apiErrorDetail, type BillingInterval, type BillingPlan, type BillingStatus } from "@/src/api";
import { useT } from "@/src/i18n";
import { isNativeShell } from "@/src/nativeShell";
import { colors, radius, spacing, type } from "@/src/theme";

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
  const router = useRouter();
  const { t, locale } = useT();
  const { width: viewportWidth } = useWindowDimensions();
  const phoneWidth = Math.min(viewportWidth, FIGMA_FRAME_WIDTH);
  const params = useLocalSearchParams<{ checkout?: string }>();
  const checkoutResult = params.checkout === "success" || params.checkout === "cancel"
    ? params.checkout
    : null;

  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<BillingInterval | "portal" | null>(null);
  const [actionError, setActionError] = useState("");
  const inShell = isNativeShell();

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

  // Returning from Checkout can beat the webhook here by a few seconds; keep
  // re-reading briefly so the page doesn't tell a parent who just paid that
  // they aren't a member.
  // The plan buttons stay hidden meanwhile: offering them to someone who has
  // just paid is how a second subscription gets bought.
  const polled = useRef(false);
  const [syncing, setSyncing] = useState(checkoutResult === "success");
  useEffect(() => {
    if (checkoutResult !== "success" || polled.current) return;
    polled.current = true;
    let cancelled = false;
    (async () => {
      for (let i = 0; i < 8 && !cancelled; i++) {
        const next = await load();
        if (next?.entitled) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (!cancelled) setSyncing(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [checkoutResult, load]);

  const subscribe = async (interval: BillingInterval) => {
    setBusy(interval);
    setActionError("");
    try {
      const { url } = await api.billingCheckout(interval);
      openExternal(url);
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
    setBusy("portal");
    setActionError("");
    try {
      const { url } = await api.billingPortal();
      openExternal(url);
    } catch {
      setActionError(t("暂时无法打开订阅管理，请稍后再试。"));
      setBusy(null);
    }
  };

  const sub = status?.subscription;
  const planLabel = (interval: BillingInterval | null | undefined) =>
    interval === "year" ? t("年付") : interval === "month" ? t("月付") : "";

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

          {inShell ? (
            <Banner tone="muted" testID="billing-shell-notice">{t("App 内暂不支持开通会员。")}</Banner>
          ) : (!status && !loadFailed) || (syncing && !status?.entitled) ? (
            <ActivityIndicator style={{ marginTop: spacing.xxl }} color={colors.brand} />
          ) : loadFailed ? (
            <Banner tone="error" testID="billing-load-failed">
              {t("会员信息暂时无法读取，请稍后再试。")}
            </Banner>
          ) : status?.entitled && sub ? (
            <View style={[styles.card, { marginHorizontal: spacing.lg }]} testID="billing-member-card">
              <View style={styles.memberRow}>
                <Ionicons name="checkmark-circle" size={20} color={colors.brand} />
                <Text style={styles.memberTitle}>{t("你已是 NURI 会员")}</Text>
                {planLabel(sub.interval) ? <Text style={styles.chip}>{planLabel(sub.interval)}</Text> : null}
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
                  disabled={busy !== null}
                  onPress={() => subscribe(plan.interval)}
                />
              ))}
              {status.has_customer ? (
                <Pressable onPress={manage} disabled={busy !== null} testID="billing-history-btn">
                  <Text style={styles.link}>{t("查看付款记录")}</Text>
                </Pressable>
              ) : null}
              <Text style={styles.fineprint}>
                {t("付款由 Stripe 安全处理，NURI 不会保存你的银行卡信息。订阅会自动续费，可随时取消。")}
              </Text>
            </View>
          )}

          {actionError ? <Banner tone="error" testID="billing-action-error">{actionError}</Banner> : null}
        </ScrollView>
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
  banner: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    borderRadius: radius.md,
    padding: spacing.md,
  },
});
