// Chat turn performance log viewer.
//
// Standalone from admin.tsx so the wide table and paging state don't crowd it,
// but it shares the same `admin_key` in localStorage, so signing in on either
// page covers both. Served at /admin/logs, which needs the explicit rewrite in
// vercel.json — /admin/(.*) otherwise goes to the Python function.
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Link } from "expo-router";

import { colors, radius, spacing } from "@/src/theme";

const BACKEND = process.env.EXPO_PUBLIC_BACKEND_URL
  ? process.env.EXPO_PUBLIC_BACKEND_URL.replace(/\/api$/, "")
  : "";
const EXPECTED_KEY = process.env.EXPO_PUBLIC_ADMIN_KEY || "";
const PAGE_SIZE = 25;

type Stat = { count: number; avg: number | null; p50: number | null; p95: number | null; max: number | null };
type Summary = {
  window_days: number;
  turns: number;
  streamed: number;
  failed: number;
  suggested_tasks: number;
  route_failed: number;
  searched: number;
  medical: number;
  cited: number;
  latency_ms: Record<
    "total" | "model" | "context" | "first_token" | "tasks" | "route" | "search",
    Stat
  >;
  length: Record<"reply_chars" | "history_msgs" | "history_chars" | "system_chars", Stat>;
  tokens: Record<"prompt" | "completion", Stat>;
};
type TurnLog = {
  id: string;
  created_at: string;
  session_id: string | null;
  user_id: string | null;
  streamed: boolean;
  status: string;
  model: string;
  total_ms: number | null;
  context_ms: number | null;
  model_ms: number | null;
  first_token_ms: number | null;
  tasks_ms: number | null;
  reply_chars: number | null;
  history_msgs: number | null;
  history_chars: number | null;
  system_chars: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  finish_reason: string | null;
  error: string | null;
  route_ok: boolean | null;
  route_error: string | null;
  route_reason: string | null;
  needs_search: boolean | null;
  is_medical: boolean | null;
  search_scope: string | null;
  search_hits: number | null;
  cited_sources: number | null;
  search_provider: string | null;
  route_ms: number | null;
  search_ms: number | null;
};
type Account = { id: string; email: string; nickname: string; turns?: number };

const WINDOWS = [1, 7, 30] as const;

// Column widths are fixed so the header and rows stay aligned inside the
// horizontal scroller.
const COLUMNS: { key: keyof TurnLog | "when"; label: string; width: number }[] = [
  { key: "when", label: "时间", width: 132 },
  { key: "status", label: "状态", width: 72 },
  { key: "total_ms", label: "总耗时", width: 78 },
  { key: "first_token_ms", label: "首字", width: 68 },
  { key: "model_ms", label: "模型", width: 68 },
  { key: "context_ms", label: "上下文", width: 72 },
  { key: "tasks_ms", label: "任务", width: 62 },
  { key: "route_ms", label: "分流", width: 62 },
  { key: "search_ms", label: "检索", width: 62 },
  { key: "route_ok", label: "分流OK", width: 68 },
  { key: "needs_search", label: "要检索", width: 68 },
  { key: "is_medical", label: "医疗", width: 56 },
  { key: "search_hits", label: "来源", width: 56 },
  { key: "cited_sources", label: "引用", width: 56 },
  { key: "reply_chars", label: "回复字数", width: 80 },
  { key: "prompt_tokens", label: "prompt", width: 74 },
  { key: "completion_tokens", label: "完成", width: 64 },
  { key: "history_msgs", label: "历史轮", width: 68 },
  { key: "system_chars", label: "system", width: 74 },
];

function fmtMs(v: number | null): string {
  if (v === null || v === undefined) return "–";
  return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}s` : `${v}ms`;
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export default function AdminLogs() {
  const [key, setKey] = useState("");
  const [authed, setAuthed] = useState(false);
  const [gateError, setGateError] = useState("");

  const [summary, setSummary] = useState<Summary | null>(null);
  const [logs, setLogs] = useState<TurnLog[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const [offset, setOffset] = useState(0);
  const [days, setDays] = useState<number>(7);

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountQuery, setAccountQuery] = useState("");
  const [userId, setUserId] = useState<string | null>(null);
  const [onlyFailed, setOnlyFailed] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

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
      setGateError("密码错误");
      return;
    }
    if (Platform.OS === "web" && typeof window !== "undefined") {
      localStorage.setItem("admin_key", key);
    }
    setGateError("");
    setAuthed(true);
  };

  const call = useCallback(
    async (path: string) => {
      const res = await fetch(`${BACKEND}${path}`, { headers: { "X-Admin-Key": key } });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      return res.json();
    },
    [key],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const scope = userId ? `&user_id=${encodeURIComponent(userId)}` : "";
    try {
      const [s, l] = await Promise.all([
        call(`/admin/turn-logs/summary?days=${days}${scope}`),
        call(
          `/admin/turn-logs?limit=${PAGE_SIZE}&offset=${offset}${scope}` +
            (onlyFailed ? "&status=fallback" : ""),
        ),
      ]);
      setSummary(s);
      setLogs(l.logs || []);
      setHasMore(!!l.has_more);
      setTotal(l.total ?? null);
    } catch (e: any) {
      setError(
        String(e?.message || e).includes("503")
          ? "读取失败 —— chat_turn_logs 表可能还没建，先在 Supabase 跑 chat_turn_logs_migration.sql"
          : `读取失败: ${e?.message || e}`,
      );
    } finally {
      setLoading(false);
    }
  }, [call, days, offset, userId, onlyFailed]);

  useEffect(() => {
    if (authed) load();
  }, [authed, load]);

  const searchAccounts = useCallback(async () => {
    try {
      const d = await call(`/admin/accounts?limit=20&q=${encodeURIComponent(accountQuery)}`);
      setAccounts(d.accounts || []);
    } catch (e: any) {
      setError(`账号搜索失败: ${e?.message || e}`);
    }
  }, [call, accountQuery]);

  if (!authed) {
    return (
      <SafeAreaView style={styles.gateWrap}>
        <View style={styles.gateCard}>
          <Text style={styles.gateTitle}>对话性能日志</Text>
          <TextInput
            value={key}
            onChangeText={setKey}
            placeholder="管理员密码"
            placeholderTextColor={colors.muted}
            secureTextEntry
            onSubmitEditing={login}
            style={styles.gateInput}
          />
          {gateError ? <Text style={styles.errorText}>{gateError}</Text> : null}
          <Pressable onPress={login} style={styles.gateBtn}>
            <Text style={styles.gateBtnText}>进入</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const selected = accounts.find((a) => a.id === userId);

  return (
    <SafeAreaView style={styles.page}>
      <ScrollView contentContainerStyle={{ padding: spacing.lg }}>
        <View style={styles.header}>
          <Text style={styles.pageTitle}>对话性能日志</Text>
          <Link href="/admin" style={styles.link}>
            ← 返回后台
          </Link>
        </View>

        {error ? (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        {/* ── Window + filters ── */}
        <View style={styles.card}>
          <Text style={styles.sectionHeader}>统计范围</Text>
          <View style={styles.row}>
            {WINDOWS.map((d) => (
              <Pressable
                key={d}
                onPress={() => {
                  setDays(d);
                  setOffset(0);
                }}
                style={[styles.chip, days === d && styles.chipActive]}
              >
                <Text style={[styles.chipText, days === d && styles.chipTextActive]}>
                  最近 {d} 天
                </Text>
              </Pressable>
            ))}
            <Pressable
              onPress={() => {
                setOnlyFailed((v) => !v);
                setOffset(0);
              }}
              style={[styles.chip, onlyFailed && styles.chipActive]}
            >
              <Text style={[styles.chipText, onlyFailed && styles.chipTextActive]}>
                只看失败
              </Text>
            </Pressable>
            <Pressable onPress={load} style={styles.refreshBtn} testID="logs-refresh">
              <Text style={styles.refreshBtnText}>刷新</Text>
            </Pressable>
          </View>

          <Text style={[styles.sectionHeader, { marginTop: spacing.md }]}>按账号筛选</Text>
          <View style={styles.row}>
            <TextInput
              value={accountQuery}
              onChangeText={setAccountQuery}
              placeholder="邮箱或昵称"
              placeholderTextColor={colors.muted}
              onSubmitEditing={searchAccounts}
              style={styles.searchInput}
            />
            <Pressable onPress={searchAccounts} style={styles.smallBtn} testID="logs-search-accounts">
              <Text style={styles.smallBtnText}>搜索</Text>
            </Pressable>
            {userId ? (
              <Pressable
                onPress={() => {
                  setUserId(null);
                  setOffset(0);
                }}
                style={styles.smallBtn}
              >
                <Text style={styles.smallBtnText}>清除筛选</Text>
              </Pressable>
            ) : null}
          </View>
          {userId ? (
            <Text style={styles.hintText}>
              当前只看：{selected ? `${selected.nickname || "(无昵称)"} <${selected.email}>` : userId}
            </Text>
          ) : (
            <Text style={styles.hintText}>当前：全部账号</Text>
          )}
          {accounts.length ? (
            <View style={{ marginTop: spacing.sm }}>
              {accounts.map((a) => (
                <Pressable
                  key={a.id}
                  onPress={() => {
                    setUserId(a.id);
                    setOffset(0);
                  }}
                  style={[styles.accountRow, userId === a.id && styles.accountRowActive]}
                  testID={`logs-account-${a.id}`}
                >
                  <Text style={styles.accountText}>
                    {a.nickname || "(无昵称)"} · {a.email}
                  </Text>
                  <Text style={styles.accountMeta}>{a.turns ?? 0} 轮</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>

        {/* ── Summary ── */}
        {summary ? (
          <View style={styles.card}>
            <Text style={styles.sectionHeader}>
              汇总（{summary.window_days} 天 · {summary.turns} 轮
              {summary.turns ? ` · 失败 ${summary.failed}` : ""}）
            </Text>
            {summary.turns === 0 ? (
              <Text style={styles.emptyText}>这个范围内还没有数据。</Text>
            ) : (
              <>
                <View style={styles.tileRow}>
                  <Tile label="总耗时 P50" value={fmtMs(summary.latency_ms.total.p50)} />
                  <Tile label="总耗时 P95" value={fmtMs(summary.latency_ms.total.p95)} />
                  <Tile label="最慢一轮" value={fmtMs(summary.latency_ms.total.max)} />
                  <Tile label="首字 P50" value={fmtMs(summary.latency_ms.first_token.p50)} />
                </View>
                <View style={styles.tileRow}>
                  <Tile label="模型 P50" value={fmtMs(summary.latency_ms.model.p50)} />
                  <Tile label="上下文 P50" value={fmtMs(summary.latency_ms.context.p50)} />
                  <Tile
                    label="任务生成 P50"
                    value={fmtMs(summary.latency_ms.tasks.p50)}
                    hint={`${summary.latency_ms.tasks.count} 轮触发`}
                  />
                  <Tile
                    label="失败率"
                    value={`${Math.round((summary.failed / summary.turns) * 100)}%`}
                  />
                </View>
                {/* External sources. These three only mean something together:
                    分流失败 high says the router is broken, while 触发检索 high
                    with 产生引用 near zero says search runs and returns nothing
                    worth citing — the same symptom, a different fix. */}
                <View style={styles.tileRow}>
                  <Tile label="分流 P50" value={fmtMs(summary.latency_ms.route?.p50)} />
                  <Tile
                    label="检索 P50"
                    value={fmtMs(summary.latency_ms.search?.p50)}
                    hint={`${summary.latency_ms.search?.count ?? 0} 轮检索`}
                  />
                  <Tile
                    label="分流失败"
                    value={String(summary.route_failed ?? 0)}
                    hint="应接近 0"
                  />
                  <Tile
                    label="触发检索"
                    value={`${summary.searched ?? 0} / ${summary.turns}`}
                    hint={`其中医疗 ${summary.medical ?? 0}`}
                  />
                  <Tile
                    label="产生引用"
                    value={`${summary.cited ?? 0} / ${summary.searched ?? 0}`}
                    hint="检索过的轮次里"
                  />
                </View>
                <View style={styles.tileRow}>
                  <Tile
                    label="回复平均字数"
                    value={`${summary.length.reply_chars.avg ?? "–"}`}
                    hint={`最长 ${summary.length.reply_chars.max ?? "–"}`}
                  />
                  <Tile
                    label="prompt tokens"
                    value={`${summary.tokens.prompt.avg ?? "–"}`}
                    hint={`P95 ${summary.tokens.prompt.p95 ?? "–"}`}
                  />
                  <Tile
                    label="completion tokens"
                    value={`${summary.tokens.completion.avg ?? "–"}`}
                    hint={`P95 ${summary.tokens.completion.p95 ?? "–"}`}
                  />
                  <Tile
                    label="历史轮数"
                    value={`${summary.length.history_msgs.avg ?? "–"}`}
                    hint={`最多 ${summary.length.history_msgs.max ?? "–"}`}
                  />
                </View>
              </>
            )}
          </View>
        ) : null}

        {/* ── Table ── */}
        <View style={styles.card}>
          <Text style={styles.sectionHeader}>
            每轮明细{total !== null ? `（共 ${total} 条）` : ""}
          </Text>
          {loading ? <ActivityIndicator color={colors.brandPrimary} /> : null}
          {!loading && !logs.length ? <Text style={styles.emptyText}>没有记录。</Text> : null}
          {logs.length ? (
            <ScrollView horizontal showsHorizontalScrollIndicator>
              <View>
                <View style={styles.tableHeader}>
                  {COLUMNS.map((c) => (
                    <Text key={c.key} style={[styles.th, { width: c.width }]}>
                      {c.label}
                    </Text>
                  ))}
                </View>
                {logs.map((row) => (
                  <View key={row.id} style={styles.tr}>
                    {COLUMNS.map((c) => {
                      let text: string;
                      if (c.key === "when") text = fmtWhen(row.created_at);
                      else if (c.key === "status") text = row.status === "ok" ? "ok" : row.status;
                      else if (c.key.toString().endsWith("_ms")) {
                        text = fmtMs(row[c.key as keyof TurnLog] as number | null);
                      } else {
                        const v = row[c.key as keyof TurnLog];
                        text =
                          v === null || v === undefined
                            ? "–"
                            : typeof v === "boolean"
                              ? (v ? "✓" : "✗")
                              : String(v);
                      }
                      // null route_ok just means the turn predates the router;
                      // only an explicit false is a fault worth flagging.
                      const bad =
                        (c.key === "status" && row.status !== "ok") ||
                        (c.key === "route_ok" && row.route_ok === false);
                      const slow = c.key === "total_ms" && (row.total_ms ?? 0) > 10000;
                      return (
                        <Text
                          key={c.key}
                          style={[
                            styles.td,
                            { width: c.width },
                            (bad || slow) && styles.tdAlert,
                          ]}
                          numberOfLines={1}
                        >
                          {text}
                        </Text>
                      );
                    })}
                  </View>
                ))}
              </View>
            </ScrollView>
          ) : null}

          <View style={[styles.row, { marginTop: spacing.md, alignItems: "center" }]}>
            <Pressable
              onPress={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
              disabled={offset === 0}
              style={[styles.smallBtn, offset === 0 && styles.smallBtnDisabled]}
              testID="logs-prev-page"
            >
              <Text style={styles.smallBtnText}>上一页</Text>
            </Pressable>
            <Text style={styles.hintText}>
              第 {Math.floor(offset / PAGE_SIZE) + 1} 页
            </Text>
            <Pressable
              onPress={() => setOffset((o) => o + PAGE_SIZE)}
              disabled={!hasMore}
              style={[styles.smallBtn, !hasMore && styles.smallBtnDisabled]}
              testID="logs-next-page"
            >
              <Text style={styles.smallBtnText}>下一页</Text>
            </Pressable>
          </View>
        </View>

        <Text style={styles.footNote}>
          日志只记录耗时与长度，不保存对话内容。#fix 指令和无 AI 的脚本回复不计入。
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <View style={styles.tile}>
      <Text style={styles.tileValue}>{value}</Text>
      <Text style={styles.tileLabel}>{label}</Text>
      {hint ? <Text style={styles.tileHint}>{hint}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  gateWrap: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface },
  gateCard: {
    width: 320, borderRadius: radius.lg, backgroundColor: colors.surfaceSecondary,
    borderWidth: 1, borderColor: colors.border, padding: spacing.lg, gap: spacing.md,
  },
  gateTitle: { fontSize: 18, fontWeight: "700", color: colors.onSurface },
  gateInput: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    padding: spacing.md, color: colors.onSurface,
  },
  gateBtn: {
    backgroundColor: colors.brandPrimary, borderRadius: radius.md,
    padding: spacing.md, alignItems: "center",
  },
  gateBtnText: { color: "#fff", fontWeight: "700" },

  page: { flex: 1, backgroundColor: colors.surface },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    marginBottom: spacing.lg,
  },
  pageTitle: { fontSize: 22, fontWeight: "800", color: colors.onSurface },
  link: { color: colors.brandPrimary, fontWeight: "600" },

  card: {
    backgroundColor: colors.surfaceSecondary, borderRadius: radius.lg, borderWidth: 1,
    borderColor: colors.border, padding: spacing.lg, marginBottom: spacing.lg,
  },
  sectionHeader: {
    fontSize: 13, fontWeight: "700", color: colors.onSurfaceTertiary,
    letterSpacing: 0.5, marginBottom: spacing.sm,
  },
  row: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, alignItems: "center" },

  chip: {
    paddingVertical: 6, paddingHorizontal: 12, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border,
  },
  chipActive: { backgroundColor: colors.brandPrimary, borderColor: colors.brandPrimary },
  chipText: { color: colors.onSurface, fontSize: 13 },
  chipTextActive: { color: "#fff" },

  refreshBtn: {
    paddingVertical: 6, paddingHorizontal: 12, borderRadius: radius.md,
    backgroundColor: colors.brandPrimary,
  },
  refreshBtnText: { color: "#fff", fontSize: 13, fontWeight: "600" },

  searchInput: {
    flexGrow: 1, minWidth: 180, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: 8,
    color: colors.onSurface, fontSize: 13,
  },
  smallBtn: {
    paddingVertical: 8, paddingHorizontal: 12, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border,
  },
  smallBtnDisabled: { opacity: 0.4 },
  smallBtnText: { color: colors.onSurface, fontSize: 13 },

  accountRow: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    paddingVertical: 8, paddingHorizontal: spacing.md, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border, marginTop: 6,
  },
  accountRowActive: { borderColor: colors.brandPrimary },
  accountText: { color: colors.onSurface, fontSize: 13, flexShrink: 1 },
  accountMeta: { color: colors.muted, fontSize: 12 },

  tileRow: { flexDirection: "row", gap: spacing.sm, marginBottom: spacing.sm },
  tile: {
    flex: 1, minWidth: 96, borderRadius: radius.md, borderWidth: 1,
    borderColor: colors.border, padding: spacing.md,
  },
  tileValue: { fontSize: 18, fontWeight: "800", color: colors.onSurface },
  tileLabel: { fontSize: 11, color: colors.onSurfaceTertiary, marginTop: 2 },
  tileHint: { fontSize: 10, color: colors.muted, marginTop: 1 },

  tableHeader: {
    flexDirection: "row", borderBottomWidth: 1, borderBottomColor: colors.border,
    paddingBottom: 6, marginBottom: 4,
  },
  th: { fontSize: 11, fontWeight: "700", color: colors.onSurfaceTertiary },
  tr: { flexDirection: "row", paddingVertical: 5 },
  td: { fontSize: 12, color: colors.onSurface },
  tdAlert: { color: colors.error, fontWeight: "700" },

  errorBanner: {
    backgroundColor: colors.surfaceSecondary, borderWidth: 1, borderColor: colors.error,
    borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.md,
  },
  errorText: { color: colors.error, fontSize: 13 },
  emptyText: { color: colors.muted, fontSize: 13 },
  hintText: { color: colors.muted, fontSize: 12 },
  footNote: { color: colors.muted, fontSize: 11, textAlign: "center", marginBottom: spacing.lg },
});
