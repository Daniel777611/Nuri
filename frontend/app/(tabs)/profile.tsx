import { useCallback, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  Switch,
  Image,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";

import { api, auth, turnsLeftOf } from "@/src/api";
import { completedAgeMonths, pregnancyWeeks } from "@/src/child-age";
import ConfirmDialog from "@/src/components/ConfirmDialog";
import Toast from "@/src/components/Toast";
import { LOCALE_LABELS, LOCALES, useT } from "@/src/i18n";
import { usePurchaseAllowed } from "@/src/nativeShell";
import { colors, radius, spacing, type } from "@/src/theme";

const FIGMA_FRAME_WIDTH = 402;

export default function Profile() {
  const router = useRouter();
  const { t, locale, setLocale } = useT();
  const { width: viewportWidth } = useWindowDimensions();
  const phoneWidth = Math.min(viewportWidth, FIGMA_FRAME_WIDTH);
  const [children, setChildren] = useState<any[]>([]);
  const [favorites, setFavorites] = useState<any[]>([]);
  const [privacy, setPrivacy] = useState<any>({
    allow_history_training: false,
    allow_external_content_research: false,
    daily_push: false,
    anonymous_community_share: false,
    language: "zh-CN",
  });
  const [privacyUnavailable, setPrivacyUnavailable] = useState(true);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [wiping, setWiping] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [me, setMe] = useState<any>(null);
  const [memoryCount, setMemoryCount] = useState<number | null>(null);
  // Today's chat allowance, in turns. Null when unlimited or unknown.
  const [turnsLeft, setTurnsLeft] = useState<{ left: number; total: number } | null>(null);
  const purchaseAllowed = usePurchaseAllowed();

  const load = useCallback(async () => {
    const [childrenResult, privacyResult, favoritesResult, meResult, memoriesResult, usageResult] =
      await Promise.allSettled([
        api.listChildren(),
        api.getPrivacy(),
        api.listFavorites(),
        api.me(),
        api.listMemories(),
        api.billingUsage(),
      ]);
    if (childrenResult.status === "fulfilled") setChildren(childrenResult.value);
    if (favoritesResult.status === "fulfilled") setFavorites(favoritesResult.value);
    if (meResult.status === "fulfilled") setMe(meResult.value);
    if (memoriesResult.status === "fulfilled") setMemoryCount(memoriesResult.value.length);
    setTurnsLeft(usageResult.status === "fulfilled" ? turnsLeftOf(usageResult.value) : null);
    if (privacyResult.status === "fulfilled") {
      setPrivacy(privacyResult.value);
      setPrivacyUnavailable(false);
    } else {
      setPrivacy((current: any) => ({
        ...current,
        allow_history_training: false,
      }));
      setPrivacyUnavailable(true);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const updatePrivacy = async (patch: any) => {
    if (privacyUnavailable) return;
    const previous = privacy;
    // `locale` — not `privacy.language` — is what the parent is looking at, so
    // toggling an unrelated switch can't push a stale language back up and undo
    // their choice.
    const next = { ...privacy, language: locale, ...patch };
    setPrivacy(next);
    if (patch.language) await setLocale(patch.language);
    try {
      await api.setPrivacy(next);
    } catch {
      // Do not leave a privacy toggle visually enabled/disabled when the
      // persisted setting did not actually save.
      setPrivacy(previous);
      if (patch.language) await setLocale(locale);
    }
  };

  const wipeAll = async () => {
    if (wiping) return;
    setWiping(true);
    try {
      await api.wipe();
    } catch {
      // Nothing was confirmed deleted, so stay signed in and say so.
      setWiping(false);
      setConfirmWipe(false);
      setToastMsg(t("删除没有完成，请检查网络后重试"));
      setTimeout(() => setToastMsg(null), 2400);
      return;
    }
    await auth.clearToken();
    setConfirmWipe(false);
    router.replace("/login");
  };

  const avatarUrl = [me?.avatar_url, me?.photo_url, me?.picture].find(
    (u) => typeof u === "string" && /^https:\/\//i.test(u),
  );

  const logout = async () => {
    await auth.clearToken();
    // Signed-out users land on login, matching app/index.tsx. Sending them to
    // register is what had testers typing their credentials into the signup form.
    router.replace("/login");
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={[styles.phoneCanvas, { width: phoneWidth }]}>
        <ScrollView
        contentContainerStyle={{ paddingBottom: spacing.xxxl }}
        showsVerticalScrollIndicator={false}
        >
        <Pressable
          onPress={() => router.back()}
          style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: spacing.md, paddingTop: spacing.sm }}
          hitSlop={8}
          testID="profile-back-btn"
        >
          <Ionicons name="chevron-back" size={24} color={colors.onSurface} />
          <Text style={{ fontSize: type.lg, fontWeight: "700", color: colors.onSurface }}>{t("返回")}</Text>
        </Pressable>
        <View style={styles.header}>
          <View style={styles.avatar}>
            {avatarUrl ? (
              <Image source={{ uri: avatarUrl }} style={styles.avatarImage} />
            ) : me?.nickname ? (
              <Text style={styles.avatarText}>{String(me.nickname).slice(0, 1)}</Text>
            ) : (
              <Ionicons name="person-outline" size={26} color={colors.brand} />
            )}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.name} numberOfLines={1}>{me?.nickname || t("家长")}</Text>
            <Text style={styles.sub} numberOfLines={1}>{me?.email || t("育儿AI · 北美华人版")}</Text>
          </View>
          <Pressable
            onPress={() => router.push("/profile-edit" as never)}
            style={styles.editBtn}
            testID="profile-edit-btn"
          >
            <Text style={styles.editBtnText}>{t("编辑资料")}</Text>
          </Pressable>
        </View>

        <Section title={t("孩子信息")}>
          {children.map((c) => (
            <Pressable
              key={c.id}
              onPress={() => router.push(`/child/${c.id}`)}
              style={styles.child}
              testID={`profile-child-${c.id}`}
            >
              <View style={styles.childAvatar}>
                <Ionicons name="leaf-outline" size={18} color={colors.brand} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.childName}>{c.nickname}</Text>
                <Text style={styles.childMeta}>
                  {(({ key, vars }) => t(key, vars))(ageLabel(c.birth_date))}
                  {c.allergies?.length ? ` · ${t("过敏")}: ${c.allergies.join(", ")}` : ""}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={colors.muted} />
            </Pressable>
          ))}
          <Pressable
            onPress={() => router.push("/child/new")}
            style={styles.addRow}
            testID="profile-add-child"
          >
            <Ionicons name="add-circle-outline" size={18} color={colors.brand} />
            <Text style={styles.addRowText}>{t("添加孩子")}</Text>
          </Pressable>
        </Section>

        {/* Nothing can be favorited any more; old favorites stay reachable. */}
        {favorites.length > 0 ? (
        <Section title={t("我的收藏")}>
          {favorites.map((f) => (
              <Pressable
                key={f.id}
                onPress={() => router.push(`/detail/${f.id}`)}
                style={styles.child}
                testID={`profile-fav-${f.id}`}
              >
                <View style={styles.childAvatar}>
                  <Ionicons name="star" size={16} color={colors.brand} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.childName} numberOfLines={1}>
                    {f.title}
                  </Text>
                  <Text style={styles.childMeta}>{f.type_label}</Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color={colors.muted} />
              </Pressable>
          ))}
        </Section>
        ) : null}

        <Section title={t("NURI 记得的事")}>
          <Pressable
            onPress={() => router.push("/memories" as never)}
            style={[styles.child, { borderBottomWidth: 0 }]}
            testID="profile-memories"
          >
            <View style={styles.childAvatar}>
              <Ionicons name="albums-outline" size={16} color={colors.brand} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.childName}>{t("查看和管理")}</Text>
              <Text style={styles.childMeta}>
                {memoryCount == null
                  ? t("NURI 从对话里记下的家庭情况")
                  : t("共 {count} 条，会影响 NURI 的回复和每日精选", { count: memoryCount })}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={colors.muted} />
          </Pressable>
        </Section>

        <Section title={t("隐私设置")}>
          <View style={styles.policy} testID="privacy-policy-card">
            <Ionicons
              name="shield-checkmark-outline"
              size={16}
              color={colors.brand}
            />
              <Text style={styles.policyText}>
              {t("对话个性化只在 NURI 内部选择相关主题。只有你另外开启“外部内容检索”后，NURI 才会先去除明显身份信息，再把必要的主题与家庭情境用于公开网页检索。我们不会出售对话，也不用于训练公共模型。")}
            </Text>
          </View>
          {privacyUnavailable ? (
            <View style={styles.privacyUnavailable} testID="privacy-unavailable-message">
              <Ionicons name="cloud-offline-outline" size={16} color={colors.error} />
              <Text style={styles.privacyUnavailableText}>
                {t("隐私设置暂时无法读取。为保护你的隐私，NURI 当前不会使用对话历史；恢复后请重新查看。")}
              </Text>
            </View>
          ) : null}
          <Toggle
            label={t("允许使用对话历史个性化建议与学习资源")}
            value={privacy.allow_history_training}
            onChange={(v) =>
              updatePrivacy(
                v
                  ? { allow_history_training: true }
                  : {
                      allow_history_training: false,
                      allow_external_content_research: false,
                    }
              )
            }
            testID="privacy-toggle-history"
            disabled={privacyUnavailable}
          />
          <Toggle
            label={t("允许将脱敏后的对话主题用于外部内容检索")}
            value={privacy.allow_external_content_research === true}
            onChange={(v) =>
              updatePrivacy({ allow_external_content_research: v })
            }
            testID="privacy-toggle-external-research"
            disabled={privacyUnavailable || !privacy.allow_history_training}
          />
          <Toggle
            label={t("接收每日推送提醒")}
            value={privacy.daily_push}
            onChange={(v) => updatePrivacy({ daily_push: v })}
            testID="privacy-toggle-push"
            disabled={privacyUnavailable}
          />
          <Pressable
            style={styles.danger}
            onPress={() => setConfirmWipe(true)}
            testID="privacy-wipe-btn"
          >
            <Ionicons name="trash-outline" size={16} color={colors.error} />
            <Text style={styles.dangerText}>{t("删除我的所有数据")}</Text>
          </Pressable>
        </Section>

        {/* In the apps only where linking out to pay is allowed (see app/billing.tsx). */}
        {purchaseAllowed ? (
          <Section title={t("会员")}>
            <Pressable
              onPress={() => router.push("/billing")}
              style={[styles.child, { borderBottomWidth: 0 }]}
              testID="profile-billing"
            >
              <View style={styles.childAvatar}>
                <Ionicons name="sparkles-outline" size={16} color={colors.brand} />
              </View>
              <Text style={[styles.childName, { flex: 1 }]}>{t("NURI 会员")}</Text>
              {turnsLeft ? (
                <Text style={styles.childMeta}>
                  {t("今天还能聊 {left}/{total} 次", turnsLeft)}
                </Text>
              ) : null}
              <Ionicons name="chevron-forward" size={16} color={colors.muted} />
            </Pressable>
          </Section>
        ) : null}

        <Section title={t("账户")}>
          <View style={styles.langRow}>
            <Text style={styles.langLabel}>{t("语言偏好")}</Text>
            <View style={styles.languageOptions}>
              {LOCALES.map((value) => {
                // Compared against the live locale, not the stored setting:
                // the rendered language is what the parent is actually seeing.
                const active = locale === value;
                return (
                  <Pressable
                    key={value}
                    onPress={() => updatePrivacy({ language: value })}
                    disabled={privacyUnavailable}
                    style={[
                      styles.languageOption,
                      active && styles.languageOptionActive,
                      privacyUnavailable && styles.disabledControl,
                    ]}
                    testID={`profile-language-${value}`}
                  >
                    <Text style={[styles.languageOptionText, active && styles.languageOptionTextActive]}>
                      {LOCALE_LABELS[value]}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
          <Pressable style={styles.logoutRow} testID="profile-logout-btn" onPress={logout}>
            <Text style={styles.logoutText}>{t("登出")}</Text>
          </Pressable>
        </Section>
        </ScrollView>

        <ConfirmDialog
          visible={confirmWipe}
          title="确认删除所有数据？"
          message={t("包括孩子档案、对话记录和 NURI 记得的事。此操作不可恢复。")}
          confirmText={wiping ? "删除中..." : "确认删除"}
          danger
          onConfirm={wipeAll}
          onCancel={() => setConfirmWipe(false)}
        />
        <Toast message={toastMsg} />
      </View>
    </SafeAreaView>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <View style={{ marginTop: spacing.lg, paddingHorizontal: spacing.lg }}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

function Toggle({
  label,
  value,
  onChange,
  testID,
  disabled = false,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  testID: string;
  disabled?: boolean;
}) {
  return (
    <View style={[styles.toggleRow, disabled && styles.disabledControl]}>
      <Text style={styles.toggleLabel}>{label}</Text>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{ true: "#3A2F5A", false: "#D6D3D1" }}
        ios_backgroundColor="#D6D3D1"
        thumbColor="#fff"
        testID={testID}
      />
    </View>
  );
}

function ageLabel(birthDate: string): { key: string; vars?: Record<string, string | number> } {
  const months = completedAgeMonths(birthDate);
  if (months !== null) return { key: "{months} 月龄", vars: { months } };
  const weeks = pregnancyWeeks(birthDate);
  if (weeks !== null) return { key: "预产期 {date} · 怀孕约 {weeks} 周", vars: { date: birthDate, weeks } };
  return { key: "出生日期待确认" };
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  phoneCanvas: { flex: 1, alignSelf: "center", overflow: "hidden" },
  header: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: radius.pill,
    backgroundColor: colors.brandTertiary,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  name: { fontSize: type.xl, fontWeight: "700", color: colors.onSurface },
  avatarImage: { width: "100%", height: "100%" },
  avatarText: { color: colors.brand, fontSize: 22, fontWeight: "700" },
  editBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  editBtnText: { fontSize: type.sm, fontWeight: "600", color: colors.onSurface },
  sub: { fontSize: type.sm, color: colors.muted, marginTop: 2 },
  sectionTitle: {
    fontSize: type.sm,
    fontWeight: "700",
    color: colors.muted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: spacing.sm,
  },
  sectionBody: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    borderColor: colors.border,
    borderWidth: 1,
    overflow: "hidden",
  },
  child: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.md,
    borderBottomColor: colors.divider,
    borderBottomWidth: 1,
  },
  childAvatar: {
    width: 36,
    height: 36,
    borderRadius: radius.pill,
    backgroundColor: colors.brandTertiary,
    alignItems: "center",
    justifyContent: "center",
  },
  childName: { fontSize: type.lg, color: colors.onSurface, fontWeight: "600" },
  childMeta: { fontSize: type.sm, color: colors.muted, marginTop: 2 },
  addRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    padding: spacing.md,
  },
  addRowText: { fontSize: type.base, color: colors.brand, fontWeight: "600" },
  policy: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    backgroundColor: colors.brandTertiary,
    padding: spacing.md,
  },
  policyText: {
    flex: 1,
    fontSize: type.sm,
    color: colors.onBrandTertiary,
    lineHeight: 18,
  },
  privacyUnavailable: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    padding: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
    backgroundColor: "#FFF4F2",
  },
  privacyUnavailableText: {
    flex: 1,
    fontSize: type.sm,
    lineHeight: 18,
    color: colors.error,
  },
  disabledControl: { opacity: 0.55 },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  toggleLabel: {
    flex: 1,
    fontSize: type.base,
    color: colors.onSurface,
    paddingRight: spacing.md,
  },
  danger: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    padding: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  dangerText: { color: colors.error, fontWeight: "600", fontSize: type.base },
  langRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: spacing.md,
  },
  langLabel: { fontSize: type.base, color: colors.onSurface },
  languageOptions: { flexDirection: "row", alignItems: "center", gap: 6 },
  languageOption: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 9,
    backgroundColor: "rgba(104, 84, 149, 0.10)",
  },
  languageOptionActive: { backgroundColor: "#3A2F5A" },
  languageOptionText: { fontSize: 12, fontWeight: "600", color: colors.muted },
  languageOptionTextActive: { color: "#FFFFFF" },
  logoutRow: {
    padding: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  logoutText: { color: colors.error, fontSize: type.base, fontWeight: "600" },
  modalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.4)",
  },
  confirm: {
    position: "absolute",
    left: spacing.lg,
    right: spacing.lg,
    top: "30%",
    backgroundColor: "#fff",
    borderRadius: radius.lg,
    padding: spacing.xl,
  },
  confirmTitle: { fontSize: type.lg, fontWeight: "700", color: colors.onSurface },
  confirmSub: {
    fontSize: type.base,
    color: colors.muted,
    marginTop: spacing.sm,
    lineHeight: 20,
  },
  confirmBtn: {
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: "center",
  },
});
