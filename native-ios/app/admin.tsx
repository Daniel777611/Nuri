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
import { Link } from "expo-router";
import { Collapsible, Note } from "@/src/admin/AdminParts";
import UsageDashboard from "@/src/admin/UsageDashboard";
import { colors, radius, spacing } from "@/src/theme";

// ── Backend base URL ──────────────────────────────────────────────────────────
// On Vercel: same-origin (empty string), /admin is routed to serverless backend.
// On local dev: set EXPO_PUBLIC_BACKEND_URL=http://localhost:8000
const BACKEND = process.env.EXPO_PUBLIC_BACKEND_URL
  ? process.env.EXPO_PUBLIC_BACKEND_URL.replace(/\/api$/, "")
  : "";

// ── Admin password gate ───────────────────────────────────────────────────────
const EXPECTED_KEY = process.env.EXPO_PUBLIC_ADMIN_KEY || "";

// ── Types ─────────────────────────────────────────────────────────────────────
type StyleRule = {
  id: string;
  rule: string;
  category?: string | null;
  source_note?: string | null;
  active: boolean;
  // Optional because a deployment that has not run
  // nuri_style_rules_selection.sql returns rows without them. Undefined reads
  // as advisory here, which matches the column default.
  mode?: string;
  priority?: number;
  applies_when?: Record<string, unknown> | null;
  created_by?: string | null;
  created_at: string;
};

type Account = {
  id: string;
  email: string;
  nickname: string;
  city?: string;
  parent_role?: string | null;
  onboarding_completed?: boolean;
  email_verified_at?: string | null;
  is_internal?: boolean;
  created_at: string;
  children?: number;
  sessions?: number;
  turns?: number;
};

type FixReviewer = {
  user_id: string;
  email?: string | null;
  nickname?: string | null;
  added_at: string;
};

// ── Main component ────────────────────────────────────────────────────────────
export default function AdminPage() {
  const [key, setKey] = useState("");
  const [authed, setAuthed] = useState(false);
  const [error, setError] = useState("");

  // NURI 规则文档（#fix 聊天指令自动写入，也支持在这里直接改）
  const [rules, setRules] = useState<StyleRule[]>([]);
  const [rulesLoading, setRulesLoading] = useState(false);
  const [newRuleText, setNewRuleText] = useState("");
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [ruleError, setRuleError] = useState("");

  // 账号查删：删除会级联清空该账号的全部数据
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountQuery, setAccountQuery] = useState("");
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountError, setAccountError] = useState("");
  // Holds the id awaiting confirmation, so deletion always takes two taps.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // Scripted/team accounts: verified on creation, no mail sent.
  const [testEmail, setTestEmail] = useState("");
  const [testPassword, setTestPassword] = useState("");
  const [creatingTest, setCreatingTest] = useState(false);
  const [testAccountStatus, setTestAccountStatus] = useState("");

  // "#fix" 白名单：只有这里列出的账号在聊天里发 #fix 才会被当成指令
  const [reviewers, setReviewers] = useState<FixReviewer[]>([]);
  const [reviewersLoading, setReviewersLoading] = useState(false);
  const [newReviewerEmail, setNewReviewerEmail] = useState("");
  const [reviewerError, setReviewerError] = useState("");

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
  };

  // ── NURI 规则文档 ──────────────────────────────────────────────────────────
  const loadRules = useCallback(async () => {
    setRulesLoading(true);
    setRuleError("");
    try {
      const res = await fetch(`${BACKEND}/admin/style-rules`, { headers: { "x-admin-key": key } });
      if (res.ok) { const d = await res.json(); setRules(d.rules || []); }
      // Swallowing this is what made a missing table read as "0 条生效" for days,
      // instead of as the failure it was.
      else setRuleError(`加载失败 (${res.status})：${(await res.text()).slice(0, 140)}`);
    } catch (e: any) {
      setRuleError(`加载失败：${String(e?.message || e).slice(0, 140)}`);
    }
    setRulesLoading(false);
  }, [key]);

  const addRule = async () => {
    const rule = newRuleText.trim();
    if (!rule) return;
    try {
      const res = await fetch(`${BACKEND}/admin/style-rules`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-key": key },
        body: JSON.stringify({ rule }),
      });
      if (res.ok) { setNewRuleText(""); loadRules(); }
    } catch {}
  };

  const toggleRule = async (id: string, active: boolean) => {
    setRules((rs) => rs.map((r) => (r.id === id ? { ...r, active } : r)));
    try {
      const res = await fetch(`${BACKEND}/admin/style-rules/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-admin-key": key },
        body: JSON.stringify({ active }),
      });
      if (!res.ok) throw new Error();
    } catch {
      setRules((rs) => rs.map((r) => (r.id === id ? { ...r, active: !active } : r)));
    }
  };

  // active 只说这条规则还在不在用；mode 说它进不进每一轮的 prompt。
  // must 的每轮都在，advisory 的按 priority 取前几条（见 dialogue.plan），
  // 所以「开着但没生效」是正常状态，不是 bug——两个开关得分开看。
  const toggleRuleMode = async (id: string, mode?: string) => {
    const next = mode === "must" ? "advisory" : "must";
    setRules((rs) => rs.map((r) => (r.id === id ? { ...r, mode: next } : r)));
    try {
      const res = await fetch(`${BACKEND}/admin/style-rules/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-admin-key": key },
        body: JSON.stringify({ mode: next }),
      });
      if (!res.ok) throw new Error();
    } catch {
      setRules((rs) => rs.map((r) => (r.id === id ? { ...r, mode } : r)));
    }
  };

  const saveRuleEdit = async (id: string) => {
    const rule = editingText.trim();
    if (!rule) return;
    try {
      const res = await fetch(`${BACKEND}/admin/style-rules/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-admin-key": key },
        body: JSON.stringify({ rule }),
      });
      if (res.ok) { setEditingRuleId(null); loadRules(); }
    } catch {}
  };

  const deleteRule = async (id: string) => {
    if (Platform.OS === "web" && !window.confirm("确定删除这条规则？")) return;
    try {
      const res = await fetch(`${BACKEND}/admin/style-rules/${id}`, {
        method: "DELETE",
        headers: { "x-admin-key": key },
      });
      if (res.ok) setRules((rs) => rs.filter((r) => r.id !== id));
    } catch {}
  };

  // ── 账号查删 ───────────────────────────────────────────────────────────────
  const loadAccounts = useCallback(async () => {
    setAccountsLoading(true);
    setAccountError("");
    try {
      const res = await fetch(
        `${BACKEND}/admin/accounts?limit=50&q=${encodeURIComponent(accountQuery.trim())}`,
        { headers: { "x-admin-key": key } },
      );
      if (!res.ok) throw new Error(await res.text());
      const d = await res.json();
      setAccounts(d.accounts || []);
    } catch (e: any) {
      setAccountError(`加载失败: ${String(e?.message || e).slice(0, 160)}`);
    }
    setAccountsLoading(false);
  }, [key, accountQuery]);

  const createTestAccount = async () => {
    setCreatingTest(true);
    setTestAccountStatus("");
    try {
      const res = await fetch(`${BACKEND}/admin/test-accounts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-key": key },
        body: JSON.stringify({ email: testEmail.trim().toLowerCase(), password: testPassword }),
      });
      if (!res.ok) throw new Error(await res.text());
      const d = await res.json();
      setTestAccountStatus(`已创建：${d.user?.email}，可以直接登录。`);
      setTestEmail("");
      setTestPassword("");
    } catch (e: any) {
      const msg = String(e?.message || e);
      setTestAccountStatus(
        msg.includes("已注册") ? "这个邮箱已经有账号了。" : `创建失败: ${msg.slice(0, 160)}`,
      );
    }
    setCreatingTest(false);
  };

  const deleteAccount = async (id: string) => {
    setDeletingId(id);
    setAccountError("");
    try {
      const res = await fetch(`${BACKEND}/admin/accounts/${id}`, {
        method: "DELETE",
        headers: { "x-admin-key": key },
      });
      if (!res.ok) throw new Error(await res.text());
      setAccounts((as) => as.filter((a) => a.id !== id));
      setConfirmDeleteId(null);
    } catch (e: any) {
      setAccountError(`删除失败: ${String(e?.message || e).slice(0, 160)}`);
    }
    setDeletingId(null);
  };

  // ── "#fix" 白名单 ──────────────────────────────────────────────────────────
  const loadReviewers = useCallback(async () => {
    setReviewersLoading(true);
    try {
      const res = await fetch(`${BACKEND}/admin/fix-reviewers`, { headers: { "x-admin-key": key } });
      if (res.ok) { const d = await res.json(); setReviewers(d.reviewers || []); }
    } catch {}
    setReviewersLoading(false);
  }, [key]);

  const addReviewer = async () => {
    const email = newReviewerEmail.trim();
    if (!email) return;
    setReviewerError("");
    try {
      const res = await fetch(`${BACKEND}/admin/fix-reviewers`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-key": key },
        body: JSON.stringify({ email }),
      });
      if (res.ok) { setNewReviewerEmail(""); loadReviewers(); }
      else { const d = await res.json().catch(() => ({})); setReviewerError(d.detail || "添加失败"); }
    } catch { setReviewerError("添加失败"); }
  };

  const removeReviewer = async (userId: string) => {
    try {
      const res = await fetch(`${BACKEND}/admin/fix-reviewers/${userId}`, {
        method: "DELETE",
        headers: { "x-admin-key": key },
      });
      if (res.ok) setReviewers((rs) => rs.filter((r) => r.user_id !== userId));
    } catch {}
  };

  useEffect(() => {
    if (authed) {
      loadRules();
      loadReviewers();
    }
  }, [authed, loadRules, loadReviewers]);

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
  const activeRules = rules.filter((r) => r.active);
  const mustRules = activeRules.filter((r) => r.mode === "must");

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }}>
      <ScrollView contentContainerStyle={styles.page}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.pageTitle}>NURI Admin</Text>
          <View style={styles.headerLinks}>
            <Link href="/admin/logs" style={styles.navLink}>
              对话性能日志 →
            </Link>
            <Pressable onPress={logout}>
              <Text style={styles.logoutText}>退出</Text>
            </Pressable>
          </View>
        </View>

        {/* The main thing this page is for: who is using NURI, how much. */}
        <UsageDashboard adminKey={key} backend={BACKEND} />

        <Text style={styles.sectionDivider}>设置</Text>

        {/* NURI 规则文档 */}
        <Collapsible
          title="NURI 规则"
          summary={rulesLoading ? "加载中…" : `${activeRules.length} 条启用 · ${mustRules.length} 条必守`}
          testID="admin-rules"
        >
          <Text style={styles.modeHint}>
            必守：每一轮都用。酌用：按 P 值只取前 3 条，带条件的还要这一轮命中。点规则文字可以修改。
          </Text>
          <Note>
            聊天里发 #fix 会自动写入一条规则。启用不等于每次都在用；全部设成必守整段注入，
            正是让 NURI 每次都编号追问、条列一大堆的原因。改坏了先降成酌用或停用，不用发版。
          </Note>
          <View style={styles.inputRow}>
            <TextInput
              style={[styles.input, { flex: 1 }]}
              placeholder="新增一条规则……"
              value={newRuleText}
              onChangeText={setNewRuleText}
              onSubmitEditing={addRule}
            />
            <Pressable
              style={[styles.smallBtn, !newRuleText.trim() && styles.smallBtnDisabled]}
              onPress={addRule}
              disabled={!newRuleText.trim()}
            >
              <Text style={styles.smallBtnText}>添加</Text>
            </Pressable>
          </View>
          {ruleError ? <Text style={styles.errorText}>{ruleError}</Text> : null}
          {rulesLoading && <ActivityIndicator color={colors.brand} style={{ marginVertical: spacing.md }} />}
          {!rulesLoading && !ruleError && rules.length === 0 && (
            <Text style={styles.emptyText}>还没有规则，等 #fix 用起来或者手动加一条。</Text>
          )}
          {rules.map((r) => (
            <View key={r.id} style={styles.row}>
              {editingRuleId === r.id ? (
                <View style={{ flex: 1, gap: spacing.sm }}>
                  <TextInput
                    style={[styles.miniInput, { minHeight: 90 }]}
                    value={editingText}
                    onChangeText={setEditingText}
                    multiline
                    autoFocus
                  />
                  <View style={styles.rowActions}>
                    <Pressable style={styles.smallBtn} onPress={() => saveRuleEdit(r.id)}>
                      <Text style={styles.smallBtnText}>保存</Text>
                    </Pressable>
                    <Pressable onPress={() => setEditingRuleId(null)} hitSlop={8}>
                      <Text style={styles.linkText}>取消</Text>
                    </Pressable>
                  </View>
                </View>
              ) : (
                <>
                  <Pressable
                    style={{ flex: 1 }}
                    onPress={() => { setEditingRuleId(r.id); setEditingText(r.rule); }}
                  >
                    <Text
                      numberOfLines={2}
                      style={[
                        styles.rowTitle,
                        !r.active && { color: colors.onSurfaceTertiary, textDecorationLine: "line-through" },
                      ]}
                    >
                      {r.rule}
                    </Text>
                    <Text style={styles.rowMeta}>
                      {[
                        r.mode === "must" ? "必守" : `酌用 P${r.priority ?? 50}`,
                        r.applies_when && Object.keys(r.applies_when).length ? "有条件" : "",
                        new Date(r.created_at).toLocaleDateString("zh-CN"),
                      ].filter(Boolean).join(" · ")}
                    </Text>
                  </Pressable>
                  <View style={styles.rowActions}>
                    <Pressable onPress={() => toggleRuleMode(r.id, r.mode)} hitSlop={8}>
                      <Text style={styles.linkText}>
                        {r.mode === "must" ? "降为酌用" : "升为必守"}
                      </Text>
                    </Pressable>
                    <Switch
                      value={r.active}
                      onValueChange={(v) => toggleRule(r.id, v)}
                      trackColor={{ true: colors.brand, false: "#D4D4D0" }}
                      thumbColor="#fff"
                    />
                    <Pressable onPress={() => deleteRule(r.id)} hitSlop={8}>
                      <Text style={styles.deleteText}>删除</Text>
                    </Pressable>
                  </View>
                </>
              )}
            </View>
          ))}
        </Collapsible>

        {/* 账号查删 */}
        <Collapsible title="账号管理" summary="查找、删除、创建测试账号" testID="admin-accounts">
          <Text style={styles.modeHint}>
            删除会连带清空该账号的孩子档案、对话、任务、长期记忆和性能日志，且不可恢复。
          </Text>
          <View style={styles.inputRow}>
            <TextInput
              style={[styles.input, { flex: 1 }]}
              placeholder="邮箱或昵称（留空列出全部）"
              autoCapitalize="none"
              value={accountQuery}
              onChangeText={setAccountQuery}
              onSubmitEditing={loadAccounts}
            />
            <Pressable style={styles.smallBtn} onPress={loadAccounts} testID="admin-search-accounts">
              <Text style={styles.smallBtnText}>搜索</Text>
            </Pressable>
          </View>
          {accountError ? <Text style={styles.errorText}>{accountError}</Text> : null}
          {accountsLoading && <ActivityIndicator color={colors.brand} style={{ marginVertical: spacing.md }} />}
          {accounts.map((a) => (
            <View key={a.id} style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>
                  {a.nickname || "(无昵称)"}
                  <Text style={styles.rowMeta}>
                    {"  "}{a.email}
                    {a.is_internal ? " · 内部" : ""}
                    {a.email_verified_at === null ? " · 邮箱未验证" : ""}
                  </Text>
                </Text>
                <Text style={styles.rowMeta}>
                  {[
                    `${a.children ?? 0} 个孩子`,
                    `${a.turns ?? 0} 轮对话`,
                    a.onboarding_completed ? "" : "未完成引导",
                    `${new Date(a.created_at).toLocaleDateString("zh-CN")} 注册`,
                  ].filter(Boolean).join(" · ")}
                </Text>
              </View>
              {confirmDeleteId === a.id ? (
                <View style={styles.rowActions}>
                  <Pressable
                    onPress={() => deleteAccount(a.id)}
                    disabled={deletingId === a.id}
                    hitSlop={8}
                    testID={`admin-confirm-delete-${a.id}`}
                  >
                    <Text style={styles.deleteText}>
                      {deletingId === a.id ? "删除中…" : "确认删除"}
                    </Text>
                  </Pressable>
                  <Pressable onPress={() => setConfirmDeleteId(null)} hitSlop={8} testID={`admin-cancel-delete-${a.id}`}>
                    <Text style={styles.linkText}>取消</Text>
                  </Pressable>
                </View>
              ) : (
                <Pressable onPress={() => setConfirmDeleteId(a.id)} hitSlop={8} testID={`admin-delete-${a.id}`}>
                  <Text style={styles.deleteText}>删除</Text>
                </Pressable>
              )}
            </View>
          ))}

          <Text style={[styles.subTitle, { marginTop: spacing.lg }]}>创建测试账号</Text>
          <Text style={styles.modeHint}>
            不发验证邮件、直接可登录，可以用假地址。自动标记为内部账号，不计入测试人数。
          </Text>
          <View style={[styles.inputRow, { flexWrap: "wrap" }]}>
            <TextInput
              style={[styles.input, { flex: 2, minWidth: 200 }]}
              placeholder="邮箱"
              autoCapitalize="none"
              value={testEmail}
              onChangeText={setTestEmail}
              testID="admin-test-account-email"
            />
            <TextInput
              style={[styles.input, { flex: 1, minWidth: 140 }]}
              placeholder="密码（至少6位）"
              autoCapitalize="none"
              value={testPassword}
              onChangeText={setTestPassword}
              testID="admin-test-account-password"
            />
            <Pressable
              style={[styles.smallBtn, (creatingTest || !testEmail || testPassword.length < 6) && { opacity: 0.5 }]}
              onPress={createTestAccount}
              disabled={creatingTest || !testEmail || testPassword.length < 6}
              testID="admin-create-test-account"
            >
              <Text style={styles.smallBtnText}>{creatingTest ? "创建中…" : "创建"}</Text>
            </Pressable>
          </View>
          {testAccountStatus ? <Text style={styles.modeHint}>{testAccountStatus}</Text> : null}
        </Collapsible>

        {/* "#fix" 白名单 */}
        <Collapsible
          title="#fix 白名单"
          summary={reviewersLoading ? "加载中…" : `${reviewers.length} 人`}
          testID="admin-fix-reviewers"
        >
          <Text style={styles.modeHint}>
            只有这些账号在聊天里发的 #fix 会被当成指令，其他人的会当成普通对话。
          </Text>
          <View style={styles.inputRow}>
            <TextInput
              style={[styles.input, { flex: 1 }]}
              placeholder="账号邮箱"
              autoCapitalize="none"
              keyboardType="email-address"
              value={newReviewerEmail}
              onChangeText={setNewReviewerEmail}
              onSubmitEditing={addReviewer}
            />
            <Pressable
              style={[styles.smallBtn, !newReviewerEmail.trim() && styles.smallBtnDisabled]}
              onPress={addReviewer}
              disabled={!newReviewerEmail.trim()}
            >
              <Text style={styles.smallBtnText}>添加</Text>
            </Pressable>
          </View>
          {reviewerError ? <Text style={styles.errorText}>{reviewerError}</Text> : null}
          {!reviewersLoading && reviewers.length === 0 && (
            <Text style={styles.emptyText}>还没有人能用 #fix。</Text>
          )}
          {reviewers.map((r) => (
            <View key={r.user_id} style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>{r.nickname || r.email || r.user_id}</Text>
                <Text style={styles.rowMeta}>
                  {[r.email, new Date(r.added_at).toLocaleDateString("zh-CN")].filter(Boolean).join(" · ")}
                </Text>
              </View>
              <Pressable onPress={() => removeReviewer(r.user_id)} hitSlop={8}>
                <Text style={styles.deleteText}>移除</Text>
              </Pressable>
            </View>
          ))}
        </Collapsible>
      </ScrollView>
    </SafeAreaView>
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

  page: { padding: spacing.lg, gap: spacing.md, maxWidth: 1200, width: "100%", alignSelf: "center" },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  headerLinks: { flexDirection: "row", alignItems: "center", gap: spacing.lg },
  pageTitle: { fontSize: 22, fontWeight: "700" as const, color: colors.onSurface },
  sectionDivider: {
    fontSize: 13, fontWeight: "700", color: colors.onSurfaceTertiary,
    letterSpacing: 0.5, marginTop: spacing.sm,
  },
  logoutText: { color: colors.error, fontSize: 14, fontWeight: "500" },
  navLink: { color: colors.brand, fontSize: 14, fontWeight: "600" },

  subTitle: { fontSize: 13, fontWeight: "700", color: colors.onSurface, marginBottom: spacing.xs },
  modeHint: { fontSize: 12, color: colors.muted, marginTop: 2 },
  inputRow: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm, alignItems: "center" },

  errorText: { color: colors.error, fontSize: 13, marginTop: spacing.xs },
  emptyText: { color: colors.onSurfaceTertiary, fontSize: 14, textAlign: "center", paddingVertical: spacing.lg },

  row: {
    flexDirection: "row", alignItems: "center", backgroundColor: colors.surfaceTertiary,
    borderRadius: radius.md, paddingVertical: spacing.sm, paddingHorizontal: spacing.md,
    gap: spacing.md, marginTop: spacing.sm,
  },
  rowTitle: { fontSize: 14, fontWeight: "600", color: colors.onSurface, lineHeight: 20 },
  rowMeta: { fontSize: 12, fontWeight: "400", color: colors.onSurfaceTertiary, marginTop: 2 },
  rowActions: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  linkText: { color: colors.brand, fontSize: 12, fontWeight: "600" },
  deleteText: { color: colors.error, fontSize: 12, fontWeight: "500" },

  miniInput: {
    borderWidth: 1, borderColor: "#D4D4D0", borderRadius: radius.sm, padding: spacing.sm,
    fontSize: 14, color: colors.onSurface, backgroundColor: colors.surfaceSecondary,
  },
  smallBtn: {
    backgroundColor: colors.brand, borderRadius: radius.sm,
    paddingVertical: spacing.xs, paddingHorizontal: spacing.md,
  },
  smallBtnDisabled: { backgroundColor: "#D4D4D0" },
  smallBtnText: { color: "#fff", fontWeight: "600", fontSize: 13 },

  input: {
    borderWidth: 1, borderColor: "#D4D4D0", borderRadius: radius.md, padding: spacing.sm,
    fontSize: 14, color: colors.onSurface, backgroundColor: colors.surfaceSecondary,
  },
});
