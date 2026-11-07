// /admin: the community report queue (Google Play UGC policy). Each report
// shows what was reported, as it was at the time, and who it is against; the
// reviewer marks it handled or dismissed, optionally taking the content down.
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

type ReportRow = {
  id: string; target_kind: string; target_id: string; reason: string; note: string | null;
  snapshot: string; status: "pending" | "actioned" | "dismissed"; content_removed: boolean;
  reviewer_note: string | null; created_at: string; reporter: string; reported: string | null;
  reported_email: string | null; reports_against_reported: number;
};

const KIND: Record<string, string> = { question: "问题", reply: "经验回复", comment: "评论", message: "私聊消息", parent: "家长资料" };
const REASON: Record<string, string> = {
  harassment: "骚扰/辱骂", sexual: "色情", hate: "仇恨/歧视", child_safety: "危害儿童安全",
  self_harm: "自伤/危险", spam: "广告/诈骗", other: "其他",
};
const REMOVE: Record<string, string> = { question: "删除问题", reply: "删除回复", comment: "删除评论", message: "删除消息", parent: "隐藏资料" };

export function CommunityReportsPanel({ backend, adminKey }: { backend: string; adminKey: string }) {
  const [filter, setFilter] = useState<"pending" | "all">("pending");
  const [rows, setRows] = useState<ReportRow[] | null>(null);
  const [error, setError] = useState("");
  const [working, setWorking] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError("");
    try {
      const res = await fetch(`${backend}/admin/community-reports?status=${filter}&limit=100`, { headers: { "x-admin-key": adminKey } });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      setRows((await res.json()).rows);
    } catch (e: any) {
      setRows(null);
      setError(`社区举报加载失败：${String(e?.message || e).slice(0, 200)}`);
    }
  }, [adminKey, backend, filter]);
  useEffect(() => { load(); }, [load]);

  const review = async (row: ReportRow, status: "actioned" | "dismissed", removeContent = false) => {
    setWorking(row.id);
    try {
      const res = await fetch(`${backend}/admin/community-reports/${row.id}`, {
        method: "POST", headers: { "Content-Type": "application/json", "x-admin-key": adminKey },
        body: JSON.stringify({ status, remove_content: removeContent }),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      await load();
    } catch (e: any) {
      setError(`处理失败：${String(e?.message || e).slice(0, 200)}`);
    } finally {
      setWorking(null);
    }
  };

  const pendingCount = rows?.filter(r => r.status === "pending").length ?? 0;
  return <View style={s.block} testID="usage-community-reports">
    <View style={s.head}>
      <Text style={s.title}>社区举报{rows && filter === "pending" ? `（待处理 ${pendingCount}）` : ""}</Text>
      <View style={{ flexDirection: "row", gap: 6 }}>
        {(["pending", "all"] as const).map(f => <Pressable key={f} onPress={() => setFilter(f)} style={[s.chip, filter === f && s.chipOn]}><Text style={[s.chipText, filter === f && s.chipTextOn]}>{f === "pending" ? "待处理" : "全部"}</Text></Pressable>)}
      </View>
    </View>
    {error ? <Text style={s.error}>{error}</Text> : null}
    {!rows && !error ? <ActivityIndicator style={{ marginVertical: 8 }} /> : null}
    {rows && !rows.length ? <Text style={s.muted}>{filter === "pending" ? "没有待处理的举报。" : "还没有举报。"}</Text> : null}
    {rows?.map(row => <View key={row.id} style={s.row} testID={`community-report-${row.id}`}>
      <Text style={s.meta}>{new Date(row.created_at).toLocaleString()} · {KIND[row.target_kind] ?? row.target_kind} · {REASON[row.reason] ?? row.reason}{row.status !== "pending" ? ` · ${row.status === "actioned" ? "已处理" : "已驳回"}` : ""}{row.content_removed ? " · 内容已移除" : ""}</Text>
      <Text style={s.snapshot}>{row.snapshot || "（无文字）"}</Text>
      {row.note ? <Text style={s.muted}>举报人补充：{row.note}</Text> : null}
      <Text style={s.muted}>被举报：{row.reported ?? "未知"}{row.reported_email ? `（${row.reported_email}）` : ""} · 共被举报 {row.reports_against_reported} 次 · 举报人：{row.reporter}</Text>
      {row.status === "pending" ? <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
        <Pressable disabled={working === row.id} onPress={() => review(row, "actioned", true)} style={[s.button, s.danger]}><Text style={s.buttonTextOn}>{REMOVE[row.target_kind] ?? "移除"}并标记已处理</Text></Pressable>
        <Pressable disabled={working === row.id} onPress={() => review(row, "actioned")} style={s.button}><Text style={s.buttonText}>标记已处理</Text></Pressable>
        <Pressable disabled={working === row.id} onPress={() => review(row, "dismissed")} style={s.button}><Text style={s.buttonText}>驳回</Text></Pressable>
        {working === row.id ? <ActivityIndicator /> : null}
      </View> : null}
    </View>)}
  </View>;
}

const s = StyleSheet.create({
  block: { gap: 8, padding: 16, borderRadius: 16, backgroundColor: "rgba(255,255,255,.7)" },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  title: { fontSize: 16, fontWeight: "600", color: "#3a3340" },
  chip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, backgroundColor: "rgba(0,0,0,.05)" },
  chipOn: { backgroundColor: "#735C84" },
  chipText: { fontSize: 12, color: "#3a3340" },
  chipTextOn: { fontSize: 12, color: "white" },
  row: { gap: 4, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "rgba(0,0,0,.12)" },
  meta: { fontSize: 12, color: "#6b6370" },
  snapshot: { fontSize: 14, color: "#2b2530" },
  muted: { fontSize: 12, color: "#8a8290" },
  error: { fontSize: 12, color: "#c0392b" },
  button: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 10, backgroundColor: "rgba(0,0,0,.06)" },
  danger: { backgroundColor: "#d9534f" },
  buttonText: { fontSize: 12, color: "#3a3340" },
  buttonTextOn: { fontSize: 12, color: "white" },
});
