import { useCallback, useEffect, useRef, useState } from "react";
import { useAccountScope, useAccountState } from "@/src/useAccountState";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  Switch,
  Platform,
  Linking,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView } from "@/src/components/NativeSafeAreaView";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";

import { api, auth } from "@/src/api";
import { completedAgeMonths } from "@/src/child-age";
import ConfirmDialog from "@/src/components/ConfirmDialog";
import { LOCALE_LABELS, LOCALES, useT } from "@/src/i18n";
import { usePurchaseAllowed } from "@/src/nativeShell";
import { openNotificationSettings } from "@/src/nativePush";
import { colors, radius, spacing, type } from "@/src/theme";

const FIGMA_FRAME_WIDTH = 402;

export default function Profile() {
  const router = useRouter();
  const { generation, capture, current, isMounted } = useAccountScope();
  const { t, locale, setLocale } = useT();
  const { width: viewportWidth } = useWindowDimensions();
  const phoneWidth = Math.min(viewportWidth, FIGMA_FRAME_WIDTH);
  const [children, setChildren] = useAccountState<any[]>([]);
  const [favorites, setFavorites] = useAccountState<any[]>([]);
  const [privacy, setPrivacy] = useAccountState<any>({
    allow_history_training: false,
    allow_external_content_research: false,
    daily_push: false,
    anonymous_community_share: false,
    language: "zh-CN",
  });
  const [privacyUnavailable, setPrivacyUnavailable] = useAccountState(true);
  const [confirmWipe, setConfirmWipe] = useAccountState(false);
  const [signingOut, setSigningOut] = useState(false);
  const signingOutRef = useRef(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [logoutFailureCode, setLogoutFailureCode] = useState("");
  const [policyError, setPolicyError] = useState<string | null>(null);
  const purchaseAllowed = usePurchaseAllowed();
  const logoutOwner = useRef<{ token: string; identity: number } | null>(null);
  const logoutVersion = useRef(0);
  useEffect(() => {
    if (logoutOwner.current && logoutOwner.current.identity !== auth.getIdentityGeneration()) {
      logoutOwner.current = null;
      logoutVersion.current++;
      signingOutRef.current = false;
      setSigningOut(false); setLogoutError(null); setLogoutFailureCode("");
    }
  }, [generation]);

  const load = useCallback(async () => {
    const ticket = capture();
    if (ticket === null) return;
    const token = await auth.getToken();
    if (!token || !current(ticket)) return;
    const [childrenResult, privacyResult, favoritesResult] = await Promise.allSettled([
      api.listChildren(),
      api.getPrivacy(),
      api.listFavorites(),
    ]);
    if (!current(ticket)) return;
    if (childrenResult.status === "fulfilled") setChildren(childrenResult.value);
    if (favoritesResult.status === "fulfilled") setFavorites(favoritesResult.value);
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
  }, [capture, current, setChildren, setFavorites, setPrivacy, setPrivacyUnavailable]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const updatePrivacy = async (patch: any) => {
    const ticket = capture();
    if (ticket === null || privacyUnavailable) return;
    const previous = privacy;
    // `locale` — not `privacy.language` — is what the parent is looking at, so
    // toggling an unrelated switch can't push a stale language back up and undo
    // their choice.
    const next = { ...privacy, language: locale, ...patch };
    setPrivacy(next);
    if (patch.language) await setLocale(patch.language);
    if (!current(ticket)) return;
    try {
      await api.setPrivacy(next);
    } catch {
      if (!current(ticket)) return;
      // Do not leave a privacy toggle visually enabled/disabled when the
      // persisted setting did not actually save.
      setPrivacy(previous);
      if (patch.language) await setLocale(locale);
    }
  };

  const finishSignOut = async (identity: number) => {
    const token = await auth.getToken();
    if (isMounted() && identity === auth.getIdentityGeneration() && token === null) router.replace("/login");
  };

  const wipeAll = async () => {
    const ticket = capture();
    if (ticket === null) return;
    const token = await auth.getToken();
    if (!token || !current(ticket)) return;
    try {
      await api.wipe();
      if (!current(ticket)) return;
      setConfirmWipe(false);
      await logout();
    } catch {
      if (!current(ticket)) return;
      setLogoutError(locale === "en" ? "Cloud-data removal was not confirmed. Check your connection and retry." : locale === "zh-TW" ? "雲端資料清除尚未確認，請檢查網路後重試。" : "云端数据清除尚未确认，请检查网络后重试。");
    }
  };

  const logout = async (forceLocal = false) => {
    const ticket = capture();
    if (ticket === null || signingOutRef.current) return;
    const identity = auth.getIdentityGeneration();
    const token = await auth.getToken();
    if (!current(ticket)) return;
    const owner = token ? { token, identity } : logoutOwner.current;
    if (!owner || owner.identity !== identity) return;
    logoutOwner.current = owner;
    const version = ++logoutVersion.current;
    signingOutRef.current = true;
    setSigningOut(true);
    setLogoutError(null);
    setLogoutFailureCode("");
    try {
      const cleared = await auth.clearToken({ expectedToken: owner.token, expectedGeneration: ticket, ...(forceLocal ? { forceLocal: true } : {}) });
      if (cleared) await finishSignOut(identity);
    } catch (error) {
      if (!isMounted() || identity !== auth.getIdentityGeneration() || version !== logoutVersion.current) return;
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      setLogoutFailureCode(code);
      if (code === "PUSH_CLEANUP_PENDING") {
        setLogoutError(locale === "en"
          ? "The server has not confirmed notification removal, so you are still signed in. Old-account notifications may still arrive. Retry online or turn off NURI notifications in system settings. Local-only sign-out does not confirm server removal."
          : locale === "zh-TW"
            ? "伺服器尚未確認取消通知，現在仍保持登入，也可能收到舊帳號的訊息。請連上網路後重試，或在系統設定關閉 NURI 通知。僅本機登出不代表伺服器已取消通知。"
            : "服务器尚未确认取消通知，现在仍保持登录，也可能收到旧账号的消息。请联网后重试，或在系统设置关闭 NURI 通知。仅本机退出不代表服务器已取消通知。");
      } else if (code === "LOCAL_SIGNOUT_FAILED") {
        setLogoutError(locale === "en" ? "Local credentials could not be cleared. Please retry; the app may still be signed in after a restart." : locale === "zh-TW" ? "本機登入憑據未確認清除，請重試。重新啟動 App 後仍可能保持登入。" : "本机登录凭据未确认清除，请重试。重新启动 App 后仍可能保持登录。");
      } else {
        setLogoutError(locale === "en" ? "Sign-out was not confirmed. Check your connection and retry." : locale === "zh-TW" ? "登出尚未確認，請檢查網路後重試。" : "登出尚未确认，请检查网络后重试。");
      }
    } finally {
      if (isMounted() && version === logoutVersion.current) { signingOutRef.current = false; setSigningOut(false); }
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <View style={[styles.phoneCanvas, { width: phoneWidth }]}>
        <ScrollView
        contentContainerStyle={{ paddingBottom: spacing.xxxl }}
        showsVerticalScrollIndicator={false}
        >
        <Pressable
          onPress={() => router.canGoBack() ? router.back() : router.replace("/(tabs)")}
          style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: spacing.md, paddingTop: spacing.sm, display: Platform.OS === "web" ? "flex" : "none" }}
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
                  {(({ key, vars }) => t(key, vars))(ageLabel(c.birth_date))}
                  {c.allergies?.length ? ` · 过敏：${c.allergies.join(", ")}` : ""}
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
          <Toggle
            label={t("允许匿名分享我的经验到社群")}
            value={privacy.anonymous_community_share}
            onChange={(v) =>
              updatePrivacy({ anonymous_community_share: v })
            }
            testID="privacy-toggle-community"
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
              <Ionicons name="chevron-forward" size={16} color={colors.muted} />
            </Pressable>
          </Section>
        ) : null}

        <Section title={t("账户")}>
          <Pressable style={styles.child} onPress={() => router.push("/ai-permission")} accessibilityRole="button" testID="profile-ai-permission">
            <Ionicons name="shield-checkmark-outline" size={20} color={colors.brand} />
            <Text style={[styles.childName, { flex: 1 }]}>{locale === "en" ? "Third-party AI permission" : locale === "zh-TW" ? "第三方 AI 使用許可" : "第三方 AI 使用许可"}</Text>
            <Ionicons name="chevron-forward" size={18} color={colors.muted} />
          </Pressable>
          <Pressable
            style={styles.child}
            accessibilityRole="link"
            accessibilityLabel={locale === "en" ? "Privacy policy" : locale === "zh-TW" ? "隱私政策" : "隐私政策"}
            testID="profile-privacy-policy"
            onPress={() => { setPolicyError(null); void Linking.openURL("https://nurifam.com/privacy").catch(() => setPolicyError(locale === "en" ? "The privacy policy could not be opened. Please retry." : locale === "zh-TW" ? "隱私政策暫時無法開啟，請重試。" : "隐私政策暂时无法打开，请重试。")); }}
          >
            <Ionicons name="shield-checkmark-outline" size={20} color={colors.brand} />
            <Text style={[styles.childName, { flex: 1 }]}>{locale === "en" ? "Privacy policy" : locale === "zh-TW" ? "隱私政策" : "隐私政策"}</Text>
            <Ionicons name="open-outline" size={18} color={colors.muted} />
          </Pressable>
          {policyError ? <Text style={[styles.privacyUnavailableText, { padding: spacing.md }]} accessibilityLiveRegion="polite">{policyError}</Text> : null}
          <Pressable style={styles.child} onPress={() => router.push("/account-deletion")} accessibilityRole="button" testID="profile-delete-account">
            <Ionicons name="trash-outline" size={20} color={colors.error} />
            <Text style={[styles.childName, { flex: 1, color: colors.error }]}>{locale === "en" ? "Permanently delete account" : locale === "zh-TW" ? "永久刪除帳號" : "永久删除账号"}</Text>
            <Ionicons name="chevron-forward" size={18} color={colors.muted} />
          </Pressable>
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
          {logoutError ? <Text style={[styles.privacyUnavailableText, { padding: spacing.md }]} accessibilityLiveRegion="assertive" testID="profile-logout-error">{logoutError}</Text> : null}
          {logoutFailureCode === "PUSH_CLEANUP_PENDING" ? <View style={{ gap: spacing.sm, padding: spacing.md }}>
            <Pressable onPress={() => void openNotificationSettings().catch(() => setLogoutError((current) => `${current || ""}\n${locale === "en" ? "System settings could not be opened. Please retry." : locale === "zh-TW" ? "系統設定暫時無法開啟，請重試。" : "系统设置暂时无法打开，请重试。"}`))} disabled={signingOut} style={styles.child} accessibilityRole="button" testID="profile-logout-notification-settings"><Text style={styles.childName}>{locale === "en" ? "Open system notification settings" : locale === "zh-TW" ? "開啟系統通知設定" : "打开系统通知设置"}</Text></Pressable>
            <Pressable onPress={() => void logout(true)} disabled={signingOut} style={styles.child} accessibilityRole="button" testID="profile-force-local-logout"><Text style={styles.logoutText}>{locale === "en" ? "Sign out on this iPhone only (notifications may continue)" : locale === "zh-TW" ? "僅本機登出（可能仍收到舊帳號通知）" : "仅本机退出（可能仍收到旧账号通知）"}</Text></Pressable>
          </View> : null}
          <Pressable style={[styles.logoutRow, signingOut && styles.disabledControl]} disabled={signingOut} testID="profile-logout-btn" onPress={() => void logout(logoutFailureCode === "LOCAL_SIGNOUT_FAILED")}>
            <Text style={styles.logoutText}>{signingOut ? locale === "en" ? "Signing out…" : "正在登出…" : logoutError ? locale === "en" ? "Retry sign-out" : locale === "zh-TW" ? "重試登出" : "重试登出" : t("登出")}</Text>
          </Pressable>
        </Section>
        </ScrollView>

        <ConfirmDialog
          visible={confirmWipe}
          title={locale === "en" ? "Delete this account's cloud data?" : locale === "zh-TW" ? "刪除此帳號的雲端資料？" : "删除此账号的云端数据？"}
          message={locale === "en" ? "This deletes child profiles, conversations, tasks and reflections for this shared cloud account in BOTH this app and the original NURI app. It is not just a reset of this device's app data and cannot be undone." : locale === "zh-TW" ? "這會刪除此共用雲端帳號的孩子檔案、對話、任務與反思，同時影響此應用和原版 NURI。不是僅重設本機應用資料，且不可恢復。" : "这会删除此共用云端账号的孩子档案、对话、任务与反思，同时影响此应用和原版 NURI。不是仅重置本机应用数据，且不可恢复。"}
          confirmText={locale === "en" ? "Delete account data" : locale === "zh-TW" ? "刪除帳號資料" : "删除账号数据"}
          danger
          onConfirm={wipeAll}
          onCancel={() => setConfirmWipe(false)}
        />
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

function ageLabel(birthDate: string) {
  const months = completedAgeMonths(birthDate);
  return months === null
    ? { key: "出生日期待确认" as const, vars: undefined }
    : { key: "{months} 月龄" as const, vars: { months } };
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
