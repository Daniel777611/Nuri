import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors, radius, spacing } from "@/src/theme";

// ── Supabase client (anon key — safe to expose, RLS controls access) ──────────
// Built lazily (not at module scope): expo-router's "single" web output requires
// every route file eagerly to build the navigation tree, so a top-level
// createClient() with a missing/empty URL would throw during app boot and blank
// out the entire app, not just this admin screen.
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL || "";
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || "";
let _supabase: SupabaseClient | null = null;
function getSupabase() {
  if (!_supabase) _supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return _supabase;
}

// ── Backend base URL (PDF indexing only) ──────────────────────────────────────
// On Vercel: same-origin (empty string), /index is routed to serverless backend.
// On local dev: set EXPO_PUBLIC_BACKEND_URL=http://localhost:8000
const BACKEND = process.env.EXPO_PUBLIC_BACKEND_URL
  ? process.env.EXPO_PUBLIC_BACKEND_URL.replace(/\/api$/, "")
  : "";

// ── Admin password gate ───────────────────────────────────────────────────────
const EXPECTED_KEY = process.env.EXPO_PUBLIC_ADMIN_KEY || "";

const CATEGORIES = ["儿童发展", "亲子育儿", "营养健康", "教育学习", "心理健康", "其他"];

// ── Types ─────────────────────────────────────────────────────────────────────
type Book = {
  id: string;
  doc_id: string;
  title: string;
  category?: string;
  enabled: boolean;
  chunk_count?: number;
  created_at: string;
};

type Unregistered = { doc_id: string; chunk_count: number };

// ── Main component ────────────────────────────────────────────────────────────
export default function AdminPage() {
  const [key, setKey] = useState("");
  const [authed, setAuthed] = useState(false);
  const [books, setBooks] = useState<Book[]>([]);
  const [unregistered, setUnregistered] = useState<Unregistered[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [feedMode, setFeedMode] = useState<"ai" | "alt">("ai");
  const [feedModeLoading, setFeedModeLoading] = useState(false);

  // Daily push state
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushLastSent, setPushLastSent] = useState<string | null>(null);
  const [smtpOk, setSmtpOk] = useState(false);
  const [pushLoading, setPushLoading] = useState(false);
  const [triggerLoading, setTriggerLoading] = useState(false);
  const [triggerResult, setTriggerResult] = useState<string | null>(null);

  // New book form
  const [newTitle, setNewTitle] = useState("");
  const [newCategory, setNewCategory] = useState(CATEGORIES[0]);
  const [indexing, setIndexing] = useState(false);
  const [indexStatus, setIndexStatus] = useState("");

  // Inline titles for unregistered docs
  const [regTitles, setRegTitles] = useState<Record<string, string>>({});

  // ── Auth persistence ──────────────────────────────────────────────────────
  useEffect(() => {
    if (Platform.OS === "web" && typeof window !== "undefined") {
      const saved = localStorage.getItem("admin_key");
      if (saved && (EXPECTED_KEY === "" || saved === EXPECTED_KEY)) {
        setKey(saved);
        setAuthed(true);
      }
    }
  }, []);

  const login = () => {
    if (EXPECTED_KEY && key !== EXPECTED_KEY) {
      setError("密码错误");
      return;
    }
    if (Platform.OS === "web" && typeof window !== "undefined") {
      localStorage.setItem("admin_key", key);
    }
    setError("");
    setAuthed(true);
  };

  const logout = () => {
    if (Platform.OS === "web" && typeof window !== "undefined") {
      localStorage.removeItem("admin_key");
    }
    setAuthed(false);
    setKey("");
    setBooks([]);
    setUnregistered([]);
  };

  // ── Load books from Supabase directly ─────────────────────────────────────
  const loadBooks = useCallback(async () => {
    setLoading(true);
    setError("");
    const { data, error: err } = await getSupabase()
      .from("books")
      .select("*")
      .order("created_at", { ascending: false });
    if (err) setError(`加载失败: ${err.message}`);
    else setBooks(data || []);
    setLoading(false);
  }, []);

  // ── Discover unregistered doc_ids via RPC ─────────────────────────────────
  const loadUnregistered = useCallback(async () => {
    const { data: chunksData } = await getSupabase().rpc("distinct_chunk_doc_ids", {
      p_namespace: "pdf",
    });
    const { data: booksData } = await getSupabase().from("books").select("doc_id");
    if (!chunksData) return;
    const registered = new Set((booksData || []).map((b: any) => b.doc_id));
    setUnregistered(
      (chunksData as any[])
        .filter((r) => !registered.has(r.doc_id))
        .map((r) => ({ doc_id: r.doc_id, chunk_count: Number(r.chunk_count) }))
    );
  }, []);

  const loadFeedMode = useCallback(async () => {
    try {
      const res = await fetch(`${BACKEND}/admin/settings`, {
        headers: { "x-admin-key": key },
      });
      if (res.ok) { const d = await res.json(); setFeedMode(d.feed_gen_mode || "ai"); }
    } catch {}
  }, [key]);

  const toggleFeedMode = async (isAI: boolean) => {
    const mode = isAI ? "ai" : "alt";
    setFeedModeLoading(true);
    try {
      const res = await fetch(`${BACKEND}/admin/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-admin-key": key },
        body: JSON.stringify({ mode }),
      });
      if (res.ok) { const d = await res.json(); setFeedMode(d.feed_gen_mode || mode); }
    } catch {}
    setFeedModeLoading(false);
  };

  const loadDailyPush = useCallback(async () => {
    try {
      const res = await fetch(`${BACKEND}/admin/daily-push`, {
        headers: { "x-admin-key": key },
      });
      if (res.ok) {
        const d = await res.json();
        setPushEnabled(!!d.enabled);
        setPushLastSent(d.last_sent || null);
        setSmtpOk(!!d.smtp_configured);
      }
    } catch {}
  }, [key]);

  const toggleDailyPush = async (enabled: boolean) => {
    setPushLoading(true);
    try {
      const res = await fetch(`${BACKEND}/admin/daily-push`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-admin-key": key },
        body: JSON.stringify({ enabled }),
      });
      if (res.ok) setPushEnabled(enabled);
    } catch {}
    setPushLoading(false);
  };

  const triggerDailyPush = async () => {
    setTriggerLoading(true);
    setTriggerResult(null);
    try {
      const res = await fetch(`${BACKEND}/admin/daily-push/trigger`, {
        method: "POST",
        headers: { "x-admin-key": key },
      });
      const d = await res.json();
      if (res.ok) {
        setTriggerResult(`发送成功 ${d.sent} 封，失败 ${d.failed} 封${d.errors?.length ? `\n${d.errors.slice(0, 3).join("\n")}` : ""}`);
        loadDailyPush();
      } else {
        setTriggerResult(`错误: ${d.detail || "未知错误"}`);
      }
    } catch (e: any) {
      setTriggerResult(`错误: ${e.message}`);
    }
    setTriggerLoading(false);
  };

  useEffect(() => {
    if (authed) {
      loadBooks();
      loadUnregistered();
      loadFeedMode();
      loadDailyPush();
    }
  }, [authed, loadBooks, loadUnregistered, loadFeedMode, loadDailyPush]);

  // ── Toggle enabled — direct Supabase write ────────────────────────────────
  const toggleBook = async (doc_id: string, enabled: boolean) => {
    setBooks((bs) => bs.map((b) => (b.doc_id === doc_id ? { ...b, enabled } : b)));
    const { error: err } = await getSupabase()
      .from("books")
      .update({ enabled })
      .eq("doc_id", doc_id);
    if (err) {
      setError(`更新失败: ${err.message}`);
      setBooks((bs) => bs.map((b) => (b.doc_id === doc_id ? { ...b, enabled: !enabled } : b)));
    }
  };

  // ── Register unregistered doc — direct Supabase upsert ───────────────────
  const registerDoc = async (doc_id: string, chunk_count: number) => {
    const title = regTitles[doc_id]?.trim() || doc_id;
    const { error: err } = await getSupabase()
      .from("books")
      .upsert({ doc_id, title, chunk_count, enabled: true }, { onConflict: "doc_id" });
    if (err) { setError(`注册失败: ${err.message}`); return; }
    setUnregistered((u) => u.filter((d) => d.doc_id !== doc_id));
    loadBooks();
  };

  // ── Delete book — direct Supabase delete ──────────────────────────────────
  const deleteBook = async (doc_id: string) => {
    if (Platform.OS === "web" && !window.confirm("确定从书籍表中删除此条目？\n（rag_chunks 向量数据不受影响）")) return;
    const { error: err } = await getSupabase().from("books").delete().eq("doc_id", doc_id);
    if (err) { setError(`删除失败: ${err.message}`); return; }
    setBooks((bs) => bs.filter((b) => b.doc_id !== doc_id));
  };

  // ── Index new PDF ─────────────────────────────────────────────────────────
  // Flow: frontend → Supabase Storage (bypasses Vercel 4.5MB limit)
  //       → backend /api/index-from-url (downloads & vectorizes) → books table
  const handleIndexNewBook = () => {
    if (!newTitle.trim()) { setIndexStatus("请先填写书名"); return; }
    if (Platform.OS !== "web") { setIndexStatus("文件上传仅支持 Web 端"); return; }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".pdf";
    input.onchange = async (e: any) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setIndexing(true);
      try {
        // Step 1: Upload to Supabase Storage
        setIndexStatus("正在上传 PDF 到 Supabase Storage……");
        const storagePath = `${Date.now()}_${file.name.replace(/\s+/g, "_")}`;
        const { error: uploadErr } = await getSupabase().storage
          .from("pdfs")
          .upload(storagePath, file, { contentType: "application/pdf", upsert: true });
        if (uploadErr) throw new Error(`Storage 上传失败: ${uploadErr.message}`);

        // Step 2: Get public URL
        const { data: urlData } = getSupabase().storage.from("pdfs").getPublicUrl(storagePath);
        const pdfUrl = urlData.publicUrl;

        // Step 3: Ask backend to download & vectorize
        setIndexStatus("正在向量化，可能需要几分钟……");
        const res = await fetch(`${BACKEND}/api/index-from-url`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: pdfUrl, filename: file.name }),
        });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();

        // Step 4: Clean up storage (fire and forget)
        getSupabase().storage.from("pdfs").remove([storagePath]);

        // Step 5: Register in books table
        setIndexStatus(`向量化完成 ${data.total_chunks} 个 chunk，正在注册……`);
        await getSupabase().from("books").upsert(
          { doc_id: data.doc_id, title: newTitle.trim(), category: newCategory, chunk_count: data.total_chunks, enabled: true },
          { onConflict: "doc_id" }
        );
        const already = data.already_indexed ? "（已存在，跳过向量化）" : "";
        setIndexStatus(`✓ 完成${already}  doc_id: ${data.doc_id} | ${data.total_chunks} chunks`);
        setNewTitle("");
        loadBooks();
        loadUnregistered();
      } catch (e: any) {
        setIndexStatus(`错误: ${e.message}`);
      } finally {
        setIndexing(false);
      }
    };
    input.click();
  };

  // ── Password gate ─────────────────────────────────────────────────────────
  if (!authed) {
    return (
      <SafeAreaView style={styles.gateWrap}>
        <View style={styles.gateCard}>
          <Text style={styles.gateTitle}>Admin</Text>
          <TextInput
            style={styles.gateInput}
            placeholder="管理员密码"
            secureTextEntry
            value={key}
            onChangeText={setKey}
            onSubmitEditing={login}
            autoFocus
          />
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
          <Pressable style={styles.gateBtn} onPress={login}>
            <Text style={styles.gateBtnText}>登录</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  // ── Dashboard ─────────────────────────────────────────────────────────────
  const enabledCount = books.filter((b) => b.enabled).length;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }}>
      <ScrollView contentContainerStyle={styles.page}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.pageTitle}>Books Admin</Text>
          <Pressable onPress={logout}>
            <Text style={styles.logoutText}>退出</Text>
          </Pressable>
        </View>

        {/* Stats */}
        <View style={styles.statsRow}>
          <StatBox label="已启用" value={enabledCount} />
          <StatBox label="总书籍" value={books.length} />
          <StatBox label="未注册" value={unregistered.length} accent={unregistered.length > 0} />
        </View>

        {/* Feed Generation Mode */}
        <View style={styles.modeCard}>
          <Text style={styles.modeTitle}>知识卡片生成模式</Text>
          <View style={styles.modeRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.modeLabel}>
                {feedMode === "ai" ? "🤖 AI 实时生成" : "📦 备选库随机"}
              </Text>
              <Text style={styles.modeHint}>
                {feedMode === "ai"
                  ? "滑到底触发时调 OpenAI 生成新卡片（含封面图）"
                  : "从预设备选库随机抽取，不消耗 AI 配额"}
              </Text>
            </View>
            <Switch
              value={feedMode === "ai"}
              onValueChange={toggleFeedMode}
              disabled={feedModeLoading}
              trackColor={{ false: "#ccc", true: colors.brand }}
              thumbColor="#fff"
            />
          </View>
        </View>

        {/* Daily Email Push */}
        <View style={styles.modeCard}>
          <Text style={styles.modeTitle}>每日邮件推送</Text>
          <View style={styles.modeRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.modeLabel}>
                {pushEnabled ? "📧 推送已开启" : "📭 推送已关闭"}
              </Text>
              <Text style={styles.modeHint}>
                {smtpOk
                  ? "每位用户根据关注话题收到专属卡片，每天上午 10 点发送"
                  : "⚠️ SMTP 未配置，请在服务器环境变量中设置 SMTP_USER / SMTP_PASSWORD"}
              </Text>
              {pushLastSent ? (
                <Text style={[styles.modeHint, { marginTop: 4 }]}>
                  上次发送：{new Date(pushLastSent).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}
                </Text>
              ) : null}
            </View>
            <Switch
              value={pushEnabled}
              onValueChange={toggleDailyPush}
              disabled={pushLoading || !smtpOk}
              trackColor={{ false: "#ccc", true: colors.brand }}
              thumbColor="#fff"
            />
          </View>
          {pushEnabled && smtpOk && (
            <Pressable
              style={[styles.triggerBtn, triggerLoading && styles.uploadBtnDisabled]}
              onPress={triggerDailyPush}
              disabled={triggerLoading}
            >
              <Text style={styles.triggerBtnText}>
                {triggerLoading ? "发送中..." : "立即手动发送"}
              </Text>
            </Pressable>
          )}
          {triggerResult ? (
            <Text style={styles.indexStatusText}>{triggerResult}</Text>
          ) : null}
        </View>

        {error ? <Text style={styles.errorBanner}>{error}</Text> : null}

        <Pressable style={styles.refreshBtn} onPress={() => { loadBooks(); loadUnregistered(); }}>
          <Text style={styles.refreshBtnText}>刷新列表</Text>
        </Pressable>

        {/* Books list */}
        <Text style={styles.sectionHeader}>已注册书籍</Text>
        {loading && <ActivityIndicator color={colors.brand} style={{ marginVertical: spacing.md }} />}
        {!loading && books.length === 0 && (
          <Text style={styles.emptyText}>暂无书籍。先上传 PDF 或注册已有的向量。</Text>
        )}
        {books.map((book) => (
          <View key={book.doc_id} style={styles.bookRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.bookTitle}>{book.title}</Text>
              <Text style={styles.bookMeta}>
                {[book.category, book.chunk_count ? `${book.chunk_count} chunks` : null, book.doc_id]
                  .filter(Boolean).join("  ·  ")}
              </Text>
            </View>
            <View style={styles.bookActions}>
              <Switch
                value={book.enabled}
                onValueChange={(v) => toggleBook(book.doc_id, v)}
                trackColor={{ true: colors.brand, false: "#D4D4D0" }}
                thumbColor="#fff"
              />
              <Pressable onPress={() => deleteBook(book.doc_id)} hitSlop={8}>
                <Text style={styles.deleteText}>删除</Text>
              </Pressable>
            </View>
          </View>
        ))}

        {/* Unregistered docs */}
        {unregistered.length > 0 && (
          <>
            <Text style={styles.sectionHeader}>rag_chunks 中未注册的 doc_id</Text>
            <Text style={styles.hintText}>这些向量已存在，填写书名后点击注册即可启用。</Text>
            {unregistered.map((item) => (
              <View key={item.doc_id} style={styles.unregRow}>
                <Text style={styles.docIdText}>{item.doc_id}</Text>
                <Text style={styles.bookMeta}>{item.chunk_count} chunks</Text>
                <TextInput
                  style={styles.miniInput}
                  placeholder="书名（必填）"
                  value={regTitles[item.doc_id] || ""}
                  onChangeText={(t) => setRegTitles((r) => ({ ...r, [item.doc_id]: t }))}
                />
                <Pressable
                  style={[styles.smallBtn, !regTitles[item.doc_id]?.trim() && styles.smallBtnDisabled]}
                  onPress={() => registerDoc(item.doc_id, item.chunk_count)}
                  disabled={!regTitles[item.doc_id]?.trim()}
                >
                  <Text style={styles.smallBtnText}>注册</Text>
                </Pressable>
              </View>
            ))}
          </>
        )}

        {/* Upload new book */}
        <Text style={styles.sectionHeader}>上传新书</Text>
        <Text style={styles.hintText}>选择 PDF → 向量化（需联通 Render 后端）→ 自动注册到 Supabase。</Text>
        <TextInput
          style={styles.input}
          placeholder="书名（必填）"
          value={newTitle}
          onChangeText={setNewTitle}
        />
        <View style={styles.categoryWrap}>
          {CATEGORIES.map((cat) => (
            <Pressable
              key={cat}
              style={[styles.chip, newCategory === cat && styles.chipActive]}
              onPress={() => setNewCategory(cat)}
            >
              <Text style={[styles.chipText, newCategory === cat && styles.chipTextActive]}>{cat}</Text>
            </Pressable>
          ))}
        </View>
        <Pressable
          style={[styles.uploadBtn, (indexing || !newTitle.trim()) && styles.uploadBtnDisabled]}
          onPress={handleIndexNewBook}
          disabled={indexing || !newTitle.trim()}
        >
          {indexing
            ? <ActivityIndicator color="#fff" />
            : <Text style={styles.uploadBtnText}>选择 PDF 并上传索引</Text>}
        </Pressable>
        {indexStatus ? <Text style={styles.indexStatusText}>{indexStatus}</Text> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────
function StatBox({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <View style={styles.statBox}>
      <Text style={[styles.statValue, accent && { color: colors.warning }]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  gateWrap: { flex: 1, backgroundColor: colors.surface, justifyContent: "center", alignItems: "center" },
  gateCard: {
    width: 320, padding: spacing.xl, backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.lg, gap: spacing.md,
    shadowColor: "#000", shadowOpacity: 0.08, shadowRadius: 12, elevation: 4,
  },
  gateTitle: { fontSize: 22, fontWeight: "700" as const, textAlign: "center", color: colors.onSurface },
  gateInput: {
    borderWidth: 1, borderColor: "#D4D4D0", borderRadius: radius.md,
    padding: spacing.md, fontSize: 16, color: colors.onSurface,
  },
  gateBtn: { backgroundColor: colors.brand, borderRadius: radius.md, padding: spacing.md, alignItems: "center" },
  gateBtnText: { color: "#fff", fontWeight: "600", fontSize: 16 },

  page: { padding: spacing.lg, gap: spacing.md },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  pageTitle: { fontSize: 22, fontWeight: "700" as const, color: colors.onSurface },
  logoutText: { color: colors.error, fontSize: 14, fontWeight: "500" },

  modeCard: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  modeTitle: { fontSize: 13, fontWeight: "700", color: colors.onSurface, marginBottom: spacing.sm },
  modeRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  modeLabel: { fontSize: 14, fontWeight: "600", color: colors.onSurface },
  modeHint: { fontSize: 12, color: colors.muted, marginTop: 2 },
  statsRow: { flexDirection: "row", gap: spacing.md },
  statBox: {
    flex: 1, backgroundColor: colors.surfaceSecondary, borderRadius: radius.md,
    padding: spacing.md, alignItems: "center", gap: 2,
  },
  statValue: { fontSize: 28, fontWeight: "700", color: colors.brand },
  statLabel: { fontSize: 12, color: colors.onSurfaceTertiary },

  errorBanner: { color: colors.error, fontSize: 13, textAlign: "center" },
  errorText: { color: colors.error, fontSize: 13 },
  emptyText: { color: colors.onSurfaceTertiary, fontSize: 14, textAlign: "center", paddingVertical: spacing.lg },
  hintText: { color: colors.onSurfaceTertiary, fontSize: 13, marginBottom: spacing.xs },
  sectionHeader: {
    fontSize: 12, fontWeight: "600" as const, textTransform: "uppercase" as const,
    letterSpacing: 0.5, color: colors.onSurface, marginTop: spacing.md, marginBottom: spacing.xs,
  },
  refreshBtn: { alignSelf: "flex-end" },
  refreshBtnText: { color: colors.brand, fontSize: 13, fontWeight: "500" },

  bookRow: {
    flexDirection: "row", alignItems: "center", backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md, padding: spacing.md, gap: spacing.sm,
  },
  bookTitle: { fontSize: 15, fontWeight: "600", color: colors.onSurface },
  bookMeta: { fontSize: 12, color: colors.onSurfaceTertiary, marginTop: 2 },
  bookActions: { alignItems: "center", gap: spacing.xs },
  deleteText: { color: colors.error, fontSize: 12, fontWeight: "500" },

  unregRow: {
    backgroundColor: colors.surfaceTertiary, borderRadius: radius.md, padding: spacing.md, gap: spacing.sm,
  },
  docIdText: { fontFamily: Platform.OS === "web" ? "monospace" : "Courier", fontSize: 13, color: colors.onSurfaceTertiary },
  miniInput: {
    borderWidth: 1, borderColor: "#D4D4D0", borderRadius: radius.sm, padding: spacing.sm,
    fontSize: 14, color: colors.onSurface, backgroundColor: colors.surfaceSecondary,
  },
  smallBtn: {
    backgroundColor: colors.brand, borderRadius: radius.sm,
    paddingVertical: spacing.xs, paddingHorizontal: spacing.md, alignSelf: "flex-start",
  },
  smallBtnDisabled: { backgroundColor: "#D4D4D0" },
  smallBtnText: { color: "#fff", fontWeight: "600", fontSize: 13 },

  input: {
    borderWidth: 1, borderColor: "#D4D4D0", borderRadius: radius.md, padding: spacing.md,
    fontSize: 15, color: colors.onSurface, backgroundColor: colors.surfaceSecondary,
  },
  categoryWrap: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  chip: { borderWidth: 1, borderColor: "#D4D4D0", borderRadius: radius.pill, paddingVertical: 4, paddingHorizontal: spacing.sm },
  chipActive: { backgroundColor: colors.brandTertiary, borderColor: colors.brand },
  chipText: { fontSize: 13, color: colors.onSurfaceTertiary },
  chipTextActive: { color: colors.onBrandTertiary, fontWeight: "600" },
  uploadBtn: { backgroundColor: colors.brand, borderRadius: radius.md, padding: spacing.md, alignItems: "center" },
  uploadBtnDisabled: { backgroundColor: "#D4D4D0" },
  uploadBtnText: { color: "#fff", fontWeight: "600", fontSize: 15 },
  triggerBtn: {
    marginTop: spacing.sm,
    backgroundColor: colors.surfaceTertiary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm,
    alignItems: "center" as const,
  },
  triggerBtnText: { color: colors.brand, fontWeight: "600" as const, fontSize: 13 },
  indexStatusText: {
    fontSize: 13, color: colors.onSurfaceTertiary,
    backgroundColor: colors.surfaceTertiary, borderRadius: radius.sm, padding: spacing.sm,
  },
});
