import { useCallback, useRef } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { api } from "@/src/api";
import { aiPermissionHref } from "@/src/aiPermissionNavigation";
import { cardText } from "@/src/cardText";
import { SafeAreaView } from "@/src/components/NativeSafeAreaView";
import RequestFailureNotice from "@/src/components/RequestFailureNotice";
import { useT } from "@/src/i18n";
import { requestFailureKind, type RequestFailureKind } from "@/src/requestFailure";
import { colors } from "@/src/theme";
import { useAccountScope, useAccountState } from "@/src/useAccountState";
import { shortResourceSummary } from "@/src/resourceSummary";

type LibraryCard = Record<string, unknown> & { id: string; title: string };

const copy = {
  en: {
    title: "Knowledge library", detail: "Browse and search NURI’s existing content cards.",
    placeholder: "Search titles, topics or keywords", search: "Search", loading: "Loading cards…",
    empty: "No cards are available right now.", noMatches: "No matching cards. Try another keyword.",
    results: "cards", open: "Open card", clear: "Show all cards",
  },
  "zh-CN": {
    title: "知识图书馆", detail: "浏览和搜索 NURI 已有的内容卡片。",
    placeholder: "搜索标题、主题或关键词", search: "搜索", loading: "正在加载卡片…",
    empty: "目前暂无可阅读的卡片。", noMatches: "没有匹配的卡片，请尝试其他关键词。",
    results: "张卡片", open: "打开卡片", clear: "查看全部卡片",
  },
  "zh-TW": {
    title: "知識圖書館", detail: "瀏覽和搜尋 NURI 已有的內容卡片。",
    placeholder: "搜尋標題、主題或關鍵字", search: "搜尋", loading: "正在載入卡片…",
    empty: "目前暫無可閱讀的卡片。", noMatches: "沒有相符的卡片，請嘗試其他關鍵字。",
    results: "張卡片", open: "開啟卡片", clear: "查看全部卡片",
  },
};

function libraryCards(value: unknown): LibraryCard[] {
  if (!Array.isArray(value)) throw new Error("Invalid card catalog response");
  const ids = new Set<string>();
  const cards = value.filter((item): item is LibraryCard => {
    if (!item || typeof item !== "object") return false;
    const card = item as Record<string, unknown>;
    if (typeof card.id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(card.id)
      || typeof card.title !== "string" || !card.title.trim() || ids.has(card.id)) return false;
    ids.add(card.id);
    return true;
  });
  if (value.length && !cards.length) throw new Error("No valid cards in catalog response");
  return cards;
}

export default function KnowledgeLibrary() {
  const router = useRouter();
  const { locale, t } = useT();
  const words = copy[locale];
  const { capture, current } = useAccountScope();
  const [cards, setCards] = useAccountState<LibraryCard[]>([]);
  const [query, setQuery] = useAccountState("");
  const [submittedQuery, setSubmittedQuery] = useAccountState("");
  const [loading, setLoading] = useAccountState(true);
  const [failure, setFailure] = useAccountState<RequestFailureKind | null>(null);
  const active = useRef(false);
  const sequence = useRef(0);

  const load = useCallback(async (search: string) => {
    const ticket = capture();
    if (ticket === null || !active.current) return;
    const request = ++sequence.current;
    const trimmed = search.trim();
    const acceptsResult = () => active.current && current(ticket) && request === sequence.current;
    setSubmittedQuery(trimmed);
    setCards([]);
    setFailure(null);
    setLoading(true);
    try {
      // Empty search returns the real existing catalog, including learning
      // cards. Never prepare/generate cards or fill empty results with fixtures.
      const result = libraryCards(await api.searchCards(trimmed));
      if (acceptsResult()) setCards(result);
    } catch (error) {
      if (acceptsResult()) setFailure(requestFailureKind(error));
    } finally {
      if (acceptsResult()) setLoading(false);
    }
  }, [capture, current, setCards, setFailure, setLoading, setSubmittedQuery]);

  useFocusEffect(useCallback(() => {
    active.current = true;
    setQuery("");
    void load("");
    return () => { active.current = false; sequence.current++; };
  }, [load, setQuery]));

  const navigate = (kind: "permission" | "login") => {
    if (capture() === null || !active.current) return;
    if (kind === "permission") router.push(aiPermissionHref("/knowledge"));
    else router.replace("/login");
  };

  return <SafeAreaView style={styles.screen}>
    <View style={styles.header}>
      <Text style={styles.title}>{words.title}</Text>
      <Text style={styles.detail}>{words.detail}</Text>
      <View style={styles.searchRow}>
        <TextInput
          value={query} onChangeText={setQuery} placeholder={words.placeholder}
          placeholderTextColor={colors.muted} style={styles.input}
          accessibilityLabel={words.placeholder} returnKeyType="search" maxLength={200}
          autoCapitalize="none" autoCorrect={false} onSubmitEditing={() => { void load(query); }}
          testID="knowledge-search-input"
        />
        <Pressable onPress={() => { void load(query); }} style={styles.searchButton}
          accessibilityRole="button" accessibilityLabel={words.search} testID="knowledge-search-submit">
          <Ionicons name="search" size={20} color={colors.onBrandPrimary} />
        </Pressable>
      </View>
      {submittedQuery ? <Pressable style={styles.clearButton} testID="knowledge-show-all"
        onPress={() => { if (capture() === null || !active.current) return; setQuery(""); void load(""); }}
        accessibilityRole="button"><Text style={styles.clearText}>{words.clear}</Text></Pressable> : null}
    </View>
    {loading ? <View style={styles.state} testID="knowledge-loading" accessibilityLiveRegion="polite">
      <ActivityIndicator color={colors.brand} /><Text style={styles.detail}>{words.loading}</Text>
    </View> : failure ? <RequestFailureNotice error={failure}
      onRetry={() => { void load(submittedQuery); }}
      onPermission={() => navigate("permission")} onLogin={() => navigate("login")} />
      : <FlatList<LibraryCard>
          data={cards} keyExtractor={(card) => card.id} style={styles.list}
          contentContainerStyle={styles.listContent} keyboardShouldPersistTaps="handled"
          ListHeaderComponent={cards.length ? <Text style={styles.count}>{cards.length} {words.results}</Text> : null}
          ListEmptyComponent={<Text style={styles.empty} testID="knowledge-empty">
            {submittedQuery ? words.noMatches : words.empty}
          </Text>}
          renderItem={({ item }) => {
            const title = cardText(item, "title", locale);
            const label = cardText(item, "type_label", locale);
            const summary = shortResourceSummary(cardText(item, "summary", locale), locale === "en" ? 600 : 220);
            return <Pressable style={styles.card} testID={`knowledge-card-${item.id}`}
              accessibilityRole="button" accessibilityLabel={`${words.open}: ${title}`}
              onPress={() => {
                if (capture() === null || !active.current) return;
                router.push({ pathname: "/detail/[id]", params: { id: item.id } });
              }}>
              <View style={styles.cardText}>
                {label ? <Text style={styles.cardLabel}>{t(label)}</Text> : null}
                <Text style={styles.cardTitle}>{title}</Text>
                {summary ? <Text style={styles.cardSummary} numberOfLines={3} testID={`knowledge-summary-${item.id}`}>{summary}</Text> : null}
              </View>
              <Ionicons name="chevron-forward" size={20} color={colors.muted} />
            </Pressable>;
          }}
          testID="knowledge-card-list"
        />}
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.surface },
  header: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12, gap: 10 },
  title: { color: colors.onSurface, fontSize: 26, lineHeight: 34, fontWeight: "700" },
  detail: { color: colors.muted, fontSize: 14, lineHeight: 22 },
  searchRow: { flexDirection: "row", gap: 10, alignItems: "center" },
  input: { flex: 1, minWidth: 0, minHeight: 48, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 14,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceSecondary, color: colors.onSurface, fontSize: 15 },
  searchButton: { width: 48, height: 48, borderRadius: 14, backgroundColor: colors.brand, alignItems: "center", justifyContent: "center" },
  clearButton: { alignSelf: "flex-start", minHeight: 44, justifyContent: "center", paddingHorizontal: 4 },
  clearText: { color: colors.brand, fontSize: 14, fontWeight: "600" },
  state: { padding: 24, alignItems: "center", gap: 12 },
  list: { flex: 1 },
  listContent: { paddingHorizontal: 20, paddingBottom: 24, gap: 12 },
  count: { color: colors.muted, fontSize: 13, marginBottom: 4 },
  empty: { color: colors.muted, fontSize: 15, lineHeight: 24, textAlign: "center", paddingVertical: 28 },
  card: { minHeight: 72, padding: 16, borderRadius: 18, backgroundColor: colors.surfaceSecondary,
    borderWidth: 1, borderColor: colors.border, flexDirection: "row", alignItems: "center", gap: 12 },
  cardText: { flex: 1, minWidth: 0, gap: 6 },
  cardLabel: { color: colors.brand, fontSize: 12, fontWeight: "600" },
  cardTitle: { color: colors.onSurface, fontSize: 17, lineHeight: 24, fontWeight: "600" },
  cardSummary: { color: colors.muted, fontSize: 14, lineHeight: 21 },
});
