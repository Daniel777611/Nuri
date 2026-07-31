import { useCallback, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  Switch,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";

import { api, auth } from "@/src/api";
import ConfirmDialog from "@/src/components/ConfirmDialog";
import Toast from "@/src/components/Toast";
import { LOCALE_LABELS, LOCALES, useT } from "@/src/i18n";
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
    allow_history_training: true,
    daily_push: true,
    anonymous_community_share: false,
    language: "zh-CN",
  });
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 2400);
  };

  const load = useCallback(async () => {
    const [ks, p, favs] = await Promise.all([
      api.listChildren(),
      api.getPrivacy(),
      api.listFavorites(),
    ]);
    setChildren(ks);
    setPrivacy(p);
    setFavorites(favs);
    // Deliberately does NOT re-apply p.language. /privacy always answers with a
    // concrete language (it has to render the switch), so a default — or a
    // response from before privacy_settings_migration.sql ran — would silently
    // overwrite the choice the parent just made here. The account's language is
    // adopted once at launch and at sign-in, where /auth/me reports an empty
    // string when nothing is actually stored.
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  // Optimistic, then reverted if the write fails. A settings row that reverts
  // with an explanation beats one that appears to work and quietly forgets.
  const updatePrivacy = async (patch: any) => {
    const previous = privacy;
    // `locale` — not `privacy.language` — is what the parent is looking at.
    // Toggling an unrelated switch must not push a stale language back up and
    // undo their choice.
    const next = { ...privacy, language: locale, ...patch };
    setPrivacy(next);
    if (patch.language) await setLocale(patch.language);
    try {
      await api.setPrivacy(next);
    } catch {
      setPrivacy(previous);
      if (patch.language) await setLocale(locale);
      showToast(t("设置没能保存，请稍后再试"));
    }
  };

  const wipeAll = async () => {
    await api.wipe();
    await auth.clearToken();
    setConfirmWipe(false);
    router.replace("/login");
  };

  const logout = async () => {
    await auth.clearToken();
    // Signed-out users land on login, matching app/index.tsx. Sending them to
    // register was what made testers type their credentials into the signup form.
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
            <Ionicons name="person-outline" size={26} color={colors.brand} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.name}>{t("家长")}</Text>
            <Text style={styles.sub}>{t("育儿AI · 北美华人版")}</Text>
          </View>
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
                  {t("{months} 月龄", { months: monthsOf(c.birth_date) })}
                  {c.allergies?.length ? ` · ${t("过敏")}：${c.allergies.join(", ")}` : ""}
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

        <Section title={t("我的收藏")}>
          {favorites.length === 0 ? (
            <View style={{ padding: spacing.md }}>
              <Text style={{ color: colors.muted, fontSize: 14 }}>
                {t("还没有收藏。在首页或详情页点击 ★ 即可收藏。")}
              </Text>
            </View>
          ) : (
            favorites.map((f) => (
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
            ))
          )}
        </Section>

        <Section title={t("隐私设置")}>
          <View style={styles.policy} testID="privacy-policy-card">
            <Ionicons
              name="shield-checkmark-outline"
              size={16}
              color={colors.brand}
            />
            <Text style={styles.policyText}>
              {t("你的对话内容仅用于为你提供个性化建议，我们不会出售给第三方，也不用于训练公共模型。")}
            </Text>
          </View>
          <Toggle
            label={t("允许使用我的对话历史改善建议质量")}
            value={privacy.allow_history_training}
            onChange={(v) => updatePrivacy({ allow_history_training: v })}
            testID="privacy-toggle-history"
          />
          <Toggle
            label={t("接收每日推送提醒")}
            value={privacy.daily_push}
            onChange={(v) => updatePrivacy({ daily_push: v })}
            testID="privacy-toggle-push"
          />
          <Toggle
            label={t("允许匿名分享我的经验到社群")}
            value={privacy.anonymous_community_share}
            onChange={(v) =>
              updatePrivacy({ anonymous_community_share: v })
            }
            testID="privacy-toggle-community"
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

        <Section title={t("账户")}>
          <View style={styles.langRow}>
            <Text style={styles.langLabel}>{t("语言偏好")}</Text>
            <View style={styles.languageOptions}>
              {LOCALES.map((value) => {
                // Compared against the live locale, not `privacy.language`: the
                // rendered language is what the parent is actually looking at.
                const active = locale === value;
                return (
                  <Pressable
                    key={value}
                    onPress={() => updatePrivacy({ language: value })}
                    style={[styles.languageOption, active && styles.languageOptionActive]}
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
          title={t("确认删除所有数据？")}
          message={t("包括孩子档案、对话记录、任务和反思。此操作不可恢复。")}
          confirmText={t("确认删除")}
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
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  testID: string;
}) {
  return (
    <View style={styles.toggleRow}>
      <Text style={styles.toggleLabel}>{label}</Text>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ true: "#3A2F5A", false: "#D6D3D1" }}
        ios_backgroundColor="#D6D3D1"
        thumbColor="#fff"
        testID={testID}
      />
    </View>
  );
}

function monthsOf(birth: string) {
  try {
    const b = new Date(birth);
    const n = new Date();
    return Math.max(
      0,
      (n.getFullYear() - b.getFullYear()) * 12 + (n.getMonth() - b.getMonth())
    );
  } catch {
    return 0;
  }
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
  },
  name: { fontSize: type.xl, fontWeight: "700", color: colors.onSurface },
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
