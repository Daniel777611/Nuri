import { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  ActivityIndicator,
  Modal,
  Animated,
  Easing,
  KeyboardAvoidingView,
  Platform,
  TextInput,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";

import { api } from "@/src/api";
import { colors, radius, spacing, type } from "@/src/theme";

type Collection = { id: string; name: string; created_at: string };
const MAX_COLLECTIONS = 12;

const USE_NATIVE_DRIVER = Platform.OS !== "web";

const TAG_BG: Record<string, string> = {
  tip: "#EEF6F1",
  news: "#FFF1EE",
  product: "#FEF9E7",
};
const TAG_FG: Record<string, string> = {
  tip: "#2F7A4B",
  news: colors.onBrandTertiary,
  product: "#8A6D1B",
};

export default function Detail() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [card, setCard] = useState<any>(null);
  const [favorited, setFavorited] = useState(false);
  const [currentCollId, setCurrentCollId] = useState<string | null>(null);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [newCollName, setNewCollName] = useState("");
  const [creatingColl, setCreatingColl] = useState(false);
  const [collSaving, setCollSaving] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastOpacity = useRef(new Animated.Value(0)).current;

  const showToast = useCallback(
    (msg: string) => {
      setToast(msg);
      Animated.sequence([
        Animated.timing(toastOpacity, {
          toValue: 1,
          duration: 180,
          useNativeDriver: USE_NATIVE_DRIVER,
        }),
        Animated.delay(1400),
        Animated.timing(toastOpacity, {
          toValue: 0,
          duration: 250,
          useNativeDriver: USE_NATIVE_DRIVER,
        }),
      ]).start(() => setToast(null));
    },
    [toastOpacity]
  );

  useEffect(() => {
    if (!id) return;
    (async () => {
      const [d, favs, cols] = await Promise.all([
        api.getCardDetail(id as string),
        api.listFavorites(),
        api.listCollections(),
      ]);
      setCard(d);
      const fav = favs.find((f: any) => f.id === id);
      setFavorited(!!fav);
      setCurrentCollId(fav?.collection_id ?? null);
      setCollections(cols);
      api.trackEvent("detail_view", { card_id: id, card_type: d.type }).catch(() => {});
    })();
  }, [id]);

  const openPicker = () => {
    setNewCollName("");
    setCreatingColl(false);
    setPickerOpen(true);
  };

  const closePicker = () => {
    setPickerOpen(false);
    setNewCollName("");
    setCreatingColl(false);
  };

  const saveToCollection = async (col: Collection) => {
    if (!id || collSaving) return;
    setCollSaving(true);
    try {
      const r = await api.saveFavorite(id as string, col.id);
      setFavorited(r.saved);
      setCurrentCollId(r.saved ? col.id : null);
      showToast(r.saved ? `已存入「${col.name}」` : "已取消收藏");
      api.trackEvent("favorite", { card_id: id, card_type: card?.type, value: r.saved ? 1 : 0 }).catch(() => {});
      closePicker();
    } finally {
      setCollSaving(false);
    }
  };

  const handleCreateCollection = async () => {
    const name = newCollName.trim();
    if (!name || !id) return;
    setCollSaving(true);
    try {
      const col = await api.createCollection(name);
      setCollections((p) => [...p, col]);
      await saveToCollection(col);
    } catch (e: any) {
      showToast(e?.message || "创建失败");
      setCollSaving(false);
    }
  };

  const askAI = async () => {
    if (!card) return;
    api.trackEvent("click_ask_ai_detail", { card_id: card.id, card_type: card.type }).catch(() => {});
    const s = await api.startSession({ card_id: card.id, title: card.title });
    router.push(`/chat/${s.id}`);
  };

  if (!card) {
    return (
      <SafeAreaView style={[styles.safe, { justifyContent: "center", alignItems: "center" }]}>
        <ActivityIndicator color={colors.brand} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.iconBtn} testID="detail-back-btn">
          <Ionicons name="chevron-back" size={20} color={colors.onSurface} />
        </Pressable>
        <View style={{ flex: 1 }} />
        <Pressable onPress={openPicker} style={styles.iconBtn} testID="detail-fav-btn">
          <Ionicons
            name={favorited ? "star" : "star-outline"}
            size={20}
            color={favorited ? colors.brand : colors.onSurface}
          />
        </Pressable>
        <Pressable
          onPress={() => setShareOpen(true)}
          style={styles.iconBtn}
          testID="detail-share-btn"
        >
          <Ionicons name="share-outline" size={20} color={colors.onSurface} />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        <View style={[styles.typeChip, { backgroundColor: TAG_BG[card.type] }]}>
          <Text style={[styles.typeChipText, { color: TAG_FG[card.type] }]}>
            {card.type_label}
          </Text>
        </View>
        <Text style={styles.title}>{card.title}</Text>
        {card.image_url ? (
          <Image source={{ uri: card.image_url }} style={styles.hero} contentFit="cover" transition={200} />
        ) : null}
        <Text style={styles.body}>{card.body}</Text>
        <View style={styles.tags}>
          {(card.tags || []).map((t: string) => (
            <View key={t} style={styles.tagChip}>
              <Text style={styles.tagText}>{t}</Text>
            </View>
          ))}
        </View>
        <Text style={styles.hook} testID="detail-hook-line">
          {card.hook_line}
        </Text>
        <View style={{ height: 120 }} />
      </ScrollView>

      <View style={styles.askBar}>
        <Pressable onPress={askAI} style={styles.askBtn} testID="detail-ask-ai-btn">
          <Ionicons name="sparkles" size={16} color="#fff" />
          <Text style={styles.askBtnText}>问问AI</Text>
        </Pressable>
      </View>

      {toast ? (
        <Animated.View style={[styles.toast, { opacity: toastOpacity, pointerEvents: "none" }]}>
          <Text style={styles.toastText}>{toast}</Text>
        </Animated.View>
      ) : null}

      {/* Collection picker bottom sheet */}
      <Modal visible={pickerOpen} transparent animationType="slide" onRequestClose={closePicker}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
          <Pressable style={styles.sheetBackdrop} onPress={closePicker} />
          <View style={styles.shareSheet} testID="detail-fav-picker-sheet">
            <View style={styles.sheetHandle} />
            <View style={styles.pickerHeader}>
              <Text style={styles.sheetTitle}>存入收藏夹</Text>
              <Pressable onPress={closePicker} hitSlop={8}>
                <Ionicons name="close" size={20} color={colors.muted} />
              </Pressable>
            </View>

            {collections.length === 0 && !creatingColl ? (
              <Text style={styles.pickerEmpty}>还没有收藏夹，点下方按钮新建一个吧</Text>
            ) : (
              collections.map((col) => {
                const isInThis = currentCollId === col.id;
                return (
                  <Pressable
                    key={col.id}
                    style={styles.shareRow}
                    onPress={() => !collSaving && saveToCollection(col)}
                    testID={`detail-picker-col-${col.id}`}
                  >
                    <Ionicons name="folder-outline" size={18} color={colors.brand} />
                    <Text style={[styles.shareLabel, { flex: 1 }]} numberOfLines={1}>{col.name}</Text>
                    {isInThis && <Ionicons name="checkmark-circle" size={18} color={colors.brand} />}
                  </Pressable>
                );
              })
            )}

            {creatingColl ? (
              <View style={styles.newCollRow}>
                <TextInput
                  style={styles.newCollInput}
                  placeholder="收藏夹名称（最多20字）"
                  placeholderTextColor={colors.muted}
                  value={newCollName}
                  onChangeText={setNewCollName}
                  maxLength={20}
                  autoFocus
                  returnKeyType="done"
                  onSubmitEditing={() => !collSaving && handleCreateCollection()}
                />
                <Pressable
                  style={[styles.newCollConfirm, (!newCollName.trim() || collSaving) && { opacity: 0.4 }]}
                  onPress={() => !collSaving && handleCreateCollection()}
                  disabled={!newCollName.trim() || collSaving}
                >
                  {collSaving
                    ? <ActivityIndicator size="small" color="#fff" />
                    : <Text style={styles.newCollConfirmText}>确认</Text>
                  }
                </Pressable>
              </View>
            ) : collections.length >= MAX_COLLECTIONS ? (
              <View style={styles.maxLimitBox}>
                <Text style={styles.pickerEmpty}>
                  已创建 {MAX_COLLECTIONS} 个收藏夹，已达上限。
                </Text>
                <Pressable
                  onPress={() => { closePicker(); router.back(); }}
                  style={styles.maxLimitBtn}
                >
                  <Text style={styles.maxLimitBtnText}>前往管理收藏夹 →</Text>
                </Pressable>
              </View>
            ) : (
              <Pressable
                style={styles.shareRow}
                onPress={() => setCreatingColl(true)}
                testID="detail-picker-new-collection"
              >
                <Ionicons name="add-circle-outline" size={18} color={colors.brand} />
                <Text style={[styles.shareLabel, { color: colors.brand, fontWeight: "600" }]}>新建收藏夹</Text>
              </Pressable>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal visible={shareOpen} transparent animationType="slide" onRequestClose={() => setShareOpen(false)}>
        <Pressable style={styles.sheetBackdrop} onPress={() => setShareOpen(false)} />
        <View style={styles.shareSheet} testID="share-sheet">
          <View style={styles.sheetHandle} />
          <Text style={styles.sheetTitle}>分享到</Text>
          {[
            { label: "复制链接", icon: "link-outline" as const },
            { label: "微信", icon: "logo-wechat" as const },
            { label: "短信", icon: "chatbox-outline" as const },
            { label: "更多…", icon: "ellipsis-horizontal" as const },
          ].map((o) => (
            <Pressable
              key={o.label}
              onPress={() => {
                setShareOpen(false);
                showToast("已分享 (mock)");
                api
                  .trackEvent("share", { card_id: card.id, card_type: card.type })
                  .catch(() => {});
              }}
              style={styles.shareRow}
              testID={`share-${o.label}`}
            >
              <Ionicons name={o.icon} size={20} color={colors.onSurface} />
              <Text style={styles.shareLabel}>{o.label}</Text>
            </Pressable>
          ))}
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    backgroundColor: "#fff",
    borderBottomColor: colors.divider,
    borderBottomWidth: 1,
  },
  iconBtn: {
    width: 38,
    height: 38,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  scroll: { padding: spacing.lg },
  typeChip: {
    alignSelf: "flex-start",
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 4,
    borderRadius: radius.pill,
    marginBottom: spacing.md,
  },
  typeChipText: { fontSize: type.sm, fontWeight: "700" },
  title: {
    fontSize: type.xxl,
    fontWeight: "700",
    color: colors.onSurface,
    lineHeight: 32,
    marginBottom: spacing.md,
  },
  hero: {
    width: "100%",
    aspectRatio: 4 / 3,
    borderRadius: radius.md,
    marginBottom: spacing.lg,
    backgroundColor: colors.surfaceTertiary,
  },
  body: {
    fontSize: type.lg,
    color: colors.onSurfaceSecondary,
    lineHeight: 26,
  },
  tags: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
  tagChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    backgroundColor: colors.brandTertiary,
    borderRadius: radius.pill,
  },
  tagText: { color: colors.onBrandTertiary, fontSize: type.sm, fontWeight: "600" },
  hook: {
    marginTop: spacing.xl,
    fontSize: type.base,
    color: colors.muted,
    fontStyle: "italic",
    textAlign: "center",
  },
  askBar: {
    position: "absolute",
    left: spacing.lg,
    right: spacing.lg,
    bottom: spacing.lg,
  },
  askBtn: {
    flexDirection: "row",
    backgroundColor: colors.brand,
    paddingVertical: spacing.md + 2,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
  },
  askBtnText: { color: "#fff", fontWeight: "700", fontSize: type.lg },
  toast: {
    position: "absolute",
    top: 80,
    alignSelf: "center",
    backgroundColor: "rgba(28,25,23,0.92)",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
    borderRadius: radius.pill,
  },
  toastText: { color: "#fff", fontSize: type.base, fontWeight: "600" },
  sheetBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.32)" },
  shareSheet: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "#fff",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  sheetHandle: {
    width: 36,
    height: 4,
    backgroundColor: colors.border,
    borderRadius: 2,
    alignSelf: "center",
    marginBottom: spacing.md,
  },
  sheetTitle: {
    fontSize: type.lg,
    fontWeight: "700",
    color: colors.onSurface,
    marginBottom: spacing.md,
  },
  shareRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderTopColor: colors.divider,
    borderTopWidth: 1,
  },
  shareLabel: { fontSize: type.lg, color: colors.onSurface },
  pickerHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.md,
  },
  pickerEmpty: { fontSize: type.base, color: colors.muted, paddingVertical: spacing.md, textAlign: "center" },
  newCollRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.md,
    borderTopColor: colors.divider,
    borderTopWidth: 1,
  },
  newCollInput: {
    flex: 1,
    height: 40,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    fontSize: type.base,
    color: colors.onSurface,
    backgroundColor: colors.surfaceSecondary,
  },
  newCollConfirm: {
    height: 40,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.brand,
    borderRadius: radius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  newCollConfirmText: { color: "#fff", fontWeight: "700", fontSize: type.base },
  maxLimitBox: { paddingVertical: spacing.md, borderTopColor: colors.divider, borderTopWidth: 1, gap: spacing.sm },
  maxLimitBtn: { alignSelf: "flex-start" },
  maxLimitBtnText: { fontSize: type.base, color: colors.brand, fontWeight: "600" },
});
