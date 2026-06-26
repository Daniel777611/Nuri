import { useCallback, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  Switch,
  Modal,
  TextInput,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";

import { api, auth } from "@/src/api";
import { colors, radius, spacing, type } from "@/src/theme";

type Collection = { id: string; name: string };

export default function Profile() {
  const router = useRouter();
  const [children, setChildren] = useState<any[]>([]);
  const [favorites, setFavorites] = useState<any[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [privacy, setPrivacy] = useState<any>({
    allow_history_training: true,
    daily_push: true,
    anonymous_community_share: false,
    language: "zh",
  });
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Collection | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  const load = useCallback(async () => {
    const [ks, p, favs, cols] = await Promise.all([
      api.listChildren(),
      api.getPrivacy(),
      api.listFavorites(),
      api.listCollections(),
    ]);
    setChildren(ks);
    setPrivacy(p);
    setFavorites(favs);
    setCollections(cols);
  }, []);

  const openRename = (col: Collection) => {
    setRenameDraft(col.name);
    setRenameTarget(col);
  };

  const confirmRename = async () => {
    if (!renameTarget) return;
    const name = renameDraft.trim();
    if (!name) return;
    await api.renameCollection(renameTarget.id, name);
    setCollections((p) => p.map((c) => c.id === renameTarget.id ? { ...c, name } : c));
    setRenameTarget(null);
  };

  const deleteCollection = (col: Collection) => {
    Alert.alert(
      `删除「${col.name}」`,
      "收藏夹将被删除，其中的收藏内容不会消失（变为未分类）。确认删除？",
      [
        { text: "取消", style: "cancel" },
        {
          text: "删除",
          style: "destructive",
          onPress: async () => {
            await api.deleteCollection(col.id);
            setCollections((p) => p.filter((c) => c.id !== col.id));
            setFavorites((p) => p.map((f) => f.collection_id === col.id ? { ...f, collection_id: null } : f));
          },
        },
      ]
    );
  };

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const updatePrivacy = async (patch: any) => {
    const next = { ...privacy, ...patch };
    setPrivacy(next);
    await api.setPrivacy(next);
  };

  const wipeAll = async () => {
    await api.wipe();
    await auth.clearToken();
    setConfirmWipe(false);
    router.replace("/register");
  };

  const logout = async () => {
    await auth.clearToken();
    router.replace("/login");
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: spacing.xxxl }}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <View style={styles.avatar}>
            <Ionicons name="person-outline" size={26} color={colors.brand} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.name}>家长</Text>
            <Text style={styles.sub}>育儿AI · 北美华人版</Text>
          </View>
        </View>

        <Section title="孩子信息">
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
                  {monthsOf(c.birth_date)} 月龄
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
            <Text style={styles.addRowText}>添加孩子</Text>
          </Pressable>
        </Section>

        {/* Collections with their favorites grouped */}
        {collections.length > 0 ? (
          collections.map((col) => {
            const colFavs = favorites.filter((f) => f.collection_id === col.id);
            return (
              <Section key={col.id} title={col.name}>
                {colFavs.length === 0 ? (
                  <View style={{ padding: spacing.md }}>
                    <Text style={{ color: colors.muted, fontSize: 14 }}>暂无内容</Text>
                  </View>
                ) : (
                  colFavs.map((f) => (
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
                        <Text style={styles.childName} numberOfLines={1}>{f.title}</Text>
                        <Text style={styles.childMeta}>{f.type_label}</Text>
                      </View>
                      <Ionicons name="chevron-forward" size={16} color={colors.muted} />
                    </Pressable>
                  ))
                )}
              </Section>
            );
          })
        ) : null}

        {/* Uncategorized favorites (no collection) */}
        {(() => {
          const uncategorized = favorites.filter((f) => !f.collection_id);
          return (
            <Section title="我的收藏">
              {favorites.length === 0 ? (
                <View style={{ padding: spacing.md }}>
                  <Text style={{ color: colors.muted, fontSize: 14 }}>
                    还没有收藏。在首页或详情页点击 ★ 可选择收藏夹保存。
                  </Text>
                </View>
              ) : uncategorized.length === 0 && collections.length > 0 ? null : (
                uncategorized.map((f) => (
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
                      <Text style={styles.childName} numberOfLines={1}>{f.title}</Text>
                      <Text style={styles.childMeta}>{f.type_label}</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={16} color={colors.muted} />
                  </Pressable>
                ))
              )}
            </Section>
          );
        })()}

        {/* Manage collections — shown when there are collections */}
        {collections.length > 0 && (
          <Section title={`管理收藏夹 (${collections.length}/12)`}>
            {collections.map((col) => (
              <View key={col.id} style={styles.collManageRow}>
                <Ionicons name="folder-outline" size={18} color={colors.brand} />
                <Text style={styles.collManageName} numberOfLines={1}>{col.name}</Text>
                <Pressable
                  onPress={() => openRename(col)}
                  hitSlop={8}
                  testID={`profile-col-rename-${col.id}`}
                >
                  <Ionicons name="pencil-outline" size={16} color={colors.muted} />
                </Pressable>
                <Pressable
                  onPress={() => deleteCollection(col)}
                  hitSlop={8}
                  testID={`profile-col-delete-${col.id}`}
                >
                  <Ionicons name="trash-outline" size={16} color={colors.error} />
                </Pressable>
              </View>
            ))}
          </Section>
        )}

        <Section title="隐私设置">
          <View style={styles.policy} testID="privacy-policy-card">
            <Ionicons
              name="shield-checkmark-outline"
              size={16}
              color={colors.brand}
            />
            <Text style={styles.policyText}>
              你的对话内容仅用于为你提供个性化建议，我们不会出售给第三方，也不用于训练公共模型。
            </Text>
          </View>
          <Toggle
            label="允许使用我的对话历史改善建议质量"
            value={privacy.allow_history_training}
            onChange={(v) => updatePrivacy({ allow_history_training: v })}
            testID="privacy-toggle-history"
          />
          <Toggle
            label="接收每日推送提醒"
            value={privacy.daily_push}
            onChange={(v) => updatePrivacy({ daily_push: v })}
            testID="privacy-toggle-push"
          />
          <Toggle
            label="允许匿名分享我的经验到社群"
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
            <Text style={styles.dangerText}>删除我的所有数据</Text>
          </Pressable>
        </Section>

        <Section title="账户">
          <Pressable
            style={styles.langRow}
            onPress={() =>
              updatePrivacy({
                language: privacy.language === "zh" ? "en" : "zh",
              })
            }
            testID="profile-lang-btn"
          >
            <Text style={styles.langLabel}>语言偏好</Text>
            <Text style={styles.langVal}>
              {privacy.language === "zh" ? "中文" : "English (mock)"}
            </Text>
          </Pressable>
          <Pressable style={styles.logoutRow} testID="profile-logout-btn" onPress={logout}>
            <Text style={styles.logoutText}>登出</Text>
          </Pressable>
        </Section>
      </ScrollView>

      {/* Rename collection modal */}
      <Modal visible={!!renameTarget} transparent animationType="fade" onRequestClose={() => setRenameTarget(null)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setRenameTarget(null)} />
        <View style={styles.confirm} testID="rename-col-modal">
          <Text style={styles.confirmTitle}>重命名收藏夹</Text>
          <TextInput
            style={styles.renameInput}
            value={renameDraft}
            onChangeText={setRenameDraft}
            maxLength={20}
            autoFocus
            placeholder="收藏夹名称"
            placeholderTextColor={colors.muted}
            returnKeyType="done"
            onSubmitEditing={confirmRename}
          />
          <View style={{ flexDirection: "row", gap: spacing.sm, marginTop: spacing.lg }}>
            <Pressable
              style={[styles.confirmBtn, { backgroundColor: colors.surfaceTertiary }]}
              onPress={() => setRenameTarget(null)}
            >
              <Text style={{ color: colors.onSurface, fontWeight: "600" }}>取消</Text>
            </Pressable>
            <Pressable
              style={[styles.confirmBtn, { backgroundColor: colors.brand }]}
              onPress={confirmRename}
              testID="rename-col-confirm"
            >
              <Text style={{ color: "#fff", fontWeight: "700" }}>确认</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <Modal visible={confirmWipe} transparent animationType="fade">
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => setConfirmWipe(false)}
        />
        <View style={styles.confirm} testID="wipe-confirm-modal">
          <Text style={styles.confirmTitle}>确认删除所有数据？</Text>
          <Text style={styles.confirmSub}>
            包括孩子档案、对话记录、任务和反思。此操作不可恢复。
          </Text>
          <View style={{ flexDirection: "row", gap: spacing.sm, marginTop: spacing.lg }}>
            <Pressable
              style={[styles.confirmBtn, { backgroundColor: colors.surfaceTertiary }]}
              onPress={() => setConfirmWipe(false)}
            >
              <Text style={{ color: colors.onSurface, fontWeight: "600" }}>取消</Text>
            </Pressable>
            <Pressable
              style={[styles.confirmBtn, { backgroundColor: colors.error }]}
              onPress={wipeAll}
              testID="wipe-confirm-yes"
            >
              <Text style={{ color: "#fff", fontWeight: "700" }}>确认删除</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
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
        trackColor={{ true: colors.brand, false: colors.border }}
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
    justifyContent: "space-between",
    padding: spacing.md,
  },
  langLabel: { fontSize: type.base, color: colors.onSurface },
  langVal: { fontSize: type.base, color: colors.muted },
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
  collManageRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.md,
    borderBottomColor: colors.divider,
    borderBottomWidth: 1,
  },
  collManageName: { flex: 1, fontSize: type.base, color: colors.onSurface },
  renameInput: {
    marginTop: spacing.md,
    height: 44,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    fontSize: type.base,
    color: colors.onSurface,
    backgroundColor: colors.surfaceSecondary,
  },
});
