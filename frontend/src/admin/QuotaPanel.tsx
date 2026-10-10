// 对话额度: the daily chat allowance per tier, and per-account overrides for
// sponsored accounts. Backed by /admin/quota* (backend/quota.py). Allowances
// are in conversation turns; one turn is `tokens_per_turn` tokens.

import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { Collapsible, Note } from "@/src/admin/AdminParts";
import { colors, radius, spacing } from "@/src/theme";

type QuotaConfig = {
  tokens_per_turn: number;
  turns: { basic: number | null; plus: number | null; unlimited: null };
};

type Override = {
  user_id: string;
  email?: string | null;
  nickname?: string | null;
  daily_turns: number | null;
  note: string;
  expires_at: string | null;
  updated_at: string;
};

async function call(url: string, adminKey: string, init?: RequestInit) {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", "x-admin-key": adminKey, ...(init?.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body.detail === "string" ? body.detail : `HTTP ${res.status}`);
  }
  return res.json();
}

function positive(text: string): number | null {
  const n = Number(text.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

export default function QuotaPanel({ backend, adminKey }: { backend: string; adminKey: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [enforced, setEnforced] = useState(false);
  const [overrides, setOverrides] = useState<Override[]>([]);

  const [basic, setBasic] = useState("");
  const [plus, setPlus] = useState("");
  const [perTurn, setPerTurn] = useState("");
  const [configStatus, setConfigStatus] = useState("");

  const [email, setEmail] = useState("");
  const [turns, setTurns] = useState("");
  const [unlimited, setUnlimited] = useState(false);
  const [note, setNote] = useState("");
  const [expires, setExpires] = useState("");
  const [overrideStatus, setOverrideStatus] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const d = await call(`${backend}/admin/quota`, adminKey);
      const config: QuotaConfig = d.config;
      setBasic(String(config.turns.basic ?? ""));
      setPlus(String(config.turns.plus ?? ""));
      setPerTurn(String(config.tokens_per_turn));
      setEnforced(!!d.enforced);
      setOverrides(d.overrides || []);
    } catch (e: any) {
      setError(String(e?.message || e).slice(0, 200));
    }
    setLoading(false);
  }, [backend, adminKey]);

  useEffect(() => {
    load();
  }, [load]);

  const saveConfig = async () => {
    const b = positive(basic);
    const p = positive(plus);
    const t = positive(perTurn);
    if (!b || !p || !t) {
      setConfigStatus("三个数都要是正整数。");
      return;
    }
    setConfigStatus("");
    try {
      await call(`${backend}/admin/quota/config`, adminKey, {
        method: "PUT",
        body: JSON.stringify({ basic_turns: b, plus_turns: p, tokens_per_turn: t }),
      });
      setConfigStatus("已保存，1 分钟内对所有人生效。");
    } catch (e: any) {
      setConfigStatus(`保存失败: ${String(e?.message || e).slice(0, 160)}`);
    }
  };

  const saveOverride = async () => {
    const n = unlimited ? null : positive(turns);
    if (!email.trim()) {
      setOverrideStatus("先填账号邮箱。");
      return;
    }
    if (!unlimited && !n) {
      setOverrideStatus("每天轮数要是正整数，或勾选不限。");
      return;
    }
    let expiresAt: string | null = null;
    if (expires.trim()) {
      const d = new Date(`${expires.trim()}T23:59:59`);
      if (Number.isNaN(d.getTime())) {
        setOverrideStatus("到期日期格式是 2026-12-31，或留空表示长期。");
        return;
      }
      expiresAt = d.toISOString();
    }
    setOverrideStatus("");
    try {
      await call(`${backend}/admin/quota/overrides`, adminKey, {
        method: "PUT",
        body: JSON.stringify({
          email: email.trim(), daily_turns: n, note: note.trim(), expires_at: expiresAt,
        }),
      });
      setOverrideStatus(`已设置：${email.trim()}`);
      setEmail("");
      setTurns("");
      setUnlimited(false);
      setNote("");
      setExpires("");
      load();
    } catch (e: any) {
      setOverrideStatus(`设置失败: ${String(e?.message || e).slice(0, 160)}`);
    }
  };

  const removeOverride = async (userId: string) => {
    try {
      await call(`${backend}/admin/quota/overrides/${encodeURIComponent(userId)}`, adminKey, {
        method: "DELETE",
      });
      setConfirmRemove(null);
      setOverrides((rows) => rows.filter((r) => r.user_id !== userId));
    } catch (e: any) {
      setError(`删除失败: ${String(e?.message || e).slice(0, 160)}`);
    }
  };

  return (
    <Collapsible
      title="对话额度"
      summary={
        loading
          ? "加载中…"
          : `基础 ${basic || "?"} 轮 · 进阶 ${plus || "?"} 轮 · 单独设置 ${overrides.length} 个${enforced ? "" : " · 未开启限额"}`
      }
      testID="admin-quota"
    >
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {!enforced ? (
        <Text style={styles.hint}>
          目前没有限额：Vercel 里没有设 QUOTA_ENFORCED=1，所有人都能无限聊天，这里的数字只用来显示。
        </Text>
      ) : null}

      <Text style={styles.label}>每档每天可以聊几轮</Text>
      <View style={styles.row}>
        <Field label="基础（免费）" value={basic} onChange={setBasic} testID="admin-quota-basic" />
        <Field label="进阶" value={plus} onChange={setPlus} testID="admin-quota-plus" />
        <Field label="每轮按多少 token 算" value={perTurn} onChange={setPerTurn} testID="admin-quota-per-turn" />
      </View>
      <View style={styles.row}>
        <Pressable style={styles.btn} onPress={saveConfig} testID="admin-quota-save">
          <Text style={styles.btnText}>保存</Text>
        </Pressable>
        {configStatus ? <Text style={styles.status}>{configStatus}</Text> : null}
      </View>
      <Note>
        无限档永远不限。实际扣的是 token：一轮对话（路由 + 回复 + 记忆提取）在生产上中位数约 1 万、
        较长的约 1.3 万 token，所以默认每轮按 13000 算。家长粘贴长文的那一轮会多扣，闲聊会少扣。
      </Note>

      <Text style={[styles.label, { marginTop: spacing.lg }]}>单独给某个账号设额度（赞助账号等）</Text>
      <Text style={styles.hint}>
        账号会拿到「这里的数」和「它所在档位的数」中更多的那个，所以不会把付费用户限得更低。
      </Text>
      <View style={styles.row}>
        <Field label="账号邮箱" value={email} onChange={setEmail} wide testID="admin-quota-email" />
        <Field
          label="每天轮数"
          value={unlimited ? "" : turns}
          onChange={setTurns}
          disabled={unlimited}
          testID="admin-quota-turns"
        />
        <Pressable
          style={[styles.check, unlimited && styles.checkOn]}
          onPress={() => setUnlimited((v) => !v)}
          testID="admin-quota-unlimited"
        >
          <Text style={[styles.checkText, unlimited && styles.checkTextOn]}>不限</Text>
        </Pressable>
      </View>
      <View style={styles.row}>
        <Field label="备注" value={note} onChange={setNote} wide testID="admin-quota-note" />
        <Field label="到期（可留空）" value={expires} onChange={setExpires} placeholder="2026-12-31" testID="admin-quota-expires" />
      </View>
      <View style={styles.row}>
        <Pressable style={styles.btn} onPress={saveOverride} testID="admin-quota-override-save">
          <Text style={styles.btnText}>设置</Text>
        </Pressable>
        {overrideStatus ? <Text style={styles.status}>{overrideStatus}</Text> : null}
      </View>

      {loading ? <ActivityIndicator color={colors.brand} style={{ marginTop: spacing.md }} /> : null}
      {overrides.map((o) => {
        const expired = o.expires_at ? new Date(o.expires_at) < new Date() : false;
        return (
          <View key={o.user_id} style={styles.item} testID={`admin-quota-override-${o.user_id}`}>
            <View style={{ flex: 1 }}>
              <Text style={styles.itemTitle}>
                {o.email || o.user_id}
                {o.nickname ? `（${o.nickname}）` : ""}
              </Text>
              <Text style={styles.itemMeta}>
                {o.daily_turns == null ? "不限" : `每天 ${o.daily_turns} 轮`}
                {o.expires_at
                  ? ` · ${expired ? "已过期" : "到期"} ${new Date(o.expires_at).toLocaleDateString()}`
                  : " · 长期"}
                {o.note ? ` · ${o.note}` : ""}
              </Text>
            </View>
            {confirmRemove === o.user_id ? (
              <Pressable style={[styles.btn, styles.danger]} onPress={() => removeOverride(o.user_id)}>
                <Text style={styles.btnText}>确认删除</Text>
              </Pressable>
            ) : (
              <Pressable onPress={() => setConfirmRemove(o.user_id)}>
                <Text style={styles.link}>删除</Text>
              </Pressable>
            )}
          </View>
        );
      })}
    </Collapsible>
  );
}

function Field({
  label,
  value,
  onChange,
  wide,
  disabled,
  placeholder,
  testID,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  wide?: boolean;
  disabled?: boolean;
  placeholder?: string;
  testID: string;
}) {
  return (
    <View style={[styles.field, wide && { flex: 2 }]}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={[styles.input, disabled && { opacity: 0.4 }]}
        value={value}
        onChangeText={onChange}
        editable={!disabled}
        placeholder={placeholder}
        autoCapitalize="none"
        testID={testID}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 14, fontWeight: "700", color: colors.onSurface, marginBottom: spacing.xs },
  hint: { fontSize: 12, color: colors.muted, marginBottom: spacing.sm, lineHeight: 18 },
  error: { fontSize: 12, color: colors.error, marginBottom: spacing.sm },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "flex-end", gap: spacing.sm, marginBottom: spacing.sm },
  field: { flex: 1, minWidth: 110, gap: 2 },
  fieldLabel: { fontSize: 12, color: colors.muted },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    fontSize: 14,
    backgroundColor: "#fff",
    color: colors.onSurface,
  },
  btn: {
    backgroundColor: colors.brand,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
  },
  btnText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  danger: { backgroundColor: colors.error },
  status: { fontSize: 12, color: colors.muted, flexShrink: 1 },
  check: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    backgroundColor: "#fff",
  },
  checkOn: { backgroundColor: colors.brand, borderColor: colors.brand },
  checkText: { fontSize: 13, color: colors.onSurface },
  checkTextOn: { color: "#fff", fontWeight: "700" },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  itemTitle: { fontSize: 13, fontWeight: "600", color: colors.onSurface },
  itemMeta: { fontSize: 12, color: colors.muted, marginTop: 2 },
  link: { fontSize: 13, color: colors.error },
});
