// 长期记忆画像：the five memory categories, their subcategories and behavior
// tags, how many live memories fall into each, and the critical-period table
// the tags confirm (GET /admin/memory-profile; backend/nuri_core/
// memory_taxonomy.py and critical_periods.py). Read-only: the split lives in
// code so the extractor, the calendar and the push ranking agree.
//
// Shares `admin_key` in localStorage with /admin. Served at /admin/memory via
// the explicit rewrite in vercel.json.
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Link } from "expo-router";

import { colors, radius, spacing } from "@/src/theme";

const BACKEND = process.env.EXPO_PUBLIC_BACKEND_URL
  ? process.env.EXPO_PUBLIC_BACKEND_URL.replace(/\/api$/, "")
  : "";

type Tag = { id: string; label: string; ttl_weeks: number; count: number };
type Sub = { id: string; label: string; hint: string; tags: Tag[]; count: number };
type Category = { id: string; label: string; count: number; unsorted: number; subcategories: Sub[] };
type Period = { id: string; label: string; weeks: [number, number]; months: [number, number]; need: string; about: string; tags: { id: string; label: string }[] };
type Profile = { categories: Category[]; periods: Period[]; total: number; inferred: number; error: string | null; grace_weeks: number };

export default function AdminMemoryProfile() {
  const [key, setKey] = useState<string | null>(null);
  const [data, setData] = useState<Profile | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<"memory" | "periods">("memory");

  useEffect(() => {
    if (Platform.OS === "web" && typeof window !== "undefined") setKey(localStorage.getItem("admin_key") || "");
    else setKey("");
  }, []);

  const load = useCallback(async () => {
    if (!key) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${BACKEND}/admin/memory-profile`, { headers: { "x-admin-key": key } });
      if (!res.ok) throw new Error(String(res.status));
      setData(await res.json());
    } catch (e) {
      setError(`读取失败（${e instanceof Error ? e.message : "?"}）`);
    } finally {
      setLoading(false);
    }
  }, [key]);

  useEffect(() => { void load(); }, [load]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }}>
      <ScrollView contentContainerStyle={styles.page}>
        <View style={styles.header}>
          <Text style={styles.title}>长期记忆画像</Text>
          <Link href="/admin" style={styles.navLink}>← 返回 Admin</Link>
        </View>
        {key === "" ? <Text style={styles.muted}>请先在 /admin 登录。</Text> : null}
        <Text style={styles.muted}>
          每条记忆 = 大类 / 细分 + 家长原话；孩子正在出现的行为另外带一个行为标签。标签确认关键期，
          关键期决定推送和成长日历。细分是初稿，改动请直接告诉 Claude（代码在 backend/nuri_core/memory_taxonomy.py）。
        </Text>
        <View style={styles.tabs}>
          {(["memory", "periods"] as const).map(t => (
            <Pressable key={t} onPress={() => setTab(t)} style={[styles.tab, tab === t && styles.tabOn]}>
              <Text style={[styles.tabText, tab === t && styles.tabTextOn]}>{t === "memory" ? "记忆细分" : "关键期表"}</Text>
            </Pressable>
          ))}
          <Pressable onPress={() => void load()} style={styles.tab}><Text style={styles.tabText}>刷新</Text></Pressable>
        </View>
        {loading ? <ActivityIndicator /> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {data?.error ? <Text style={styles.error}>计数读取失败：{data.error}（结构照常显示）</Text> : null}

        {data && tab === "memory" ? <>
          <Text style={styles.muted}>
            线上有效记忆 {data.total} 条，其中 {data.inferred} 条是细分上线前写的，按文字推断归类。
          </Text>
          {data.categories.map(c => (
            <View key={c.id} style={styles.card}>
              <Text style={styles.cardTitle}>{c.label} <Text style={styles.code}>{c.id}</Text> · {c.count} 条</Text>
              {c.subcategories.map(s => (
                <View key={s.id} style={styles.sub}>
                  <Text style={styles.subTitle}>{s.label} <Text style={styles.code}>{s.id}</Text> · {s.count} 条</Text>
                  <Text style={styles.muted}>{s.hint}</Text>
                  {s.tags.length ? <View style={styles.tags}>
                    {s.tags.map(t => (
                      <Text key={t.id} style={styles.tag}>{t.label} <Text style={styles.code}>{t.id}</Text> · {t.count} · {t.ttl_weeks} 周有效</Text>
                    ))}
                  </View> : null}
                </View>
              ))}
              {c.unsorted ? <Text style={styles.muted}>未能归类：{c.unsorted} 条</Text> : null}
            </View>
          ))}
        </> : null}

        {data && tab === "periods" ? <>
          <Text style={styles.muted}>
            月龄在窗口内 = 「常见于这时」；窗口内又有有效标签 = 「已出现」，推送优先。标签在观察后超过有效周数、
            或对应关键期结束 {data.grace_weeks} 周后自动解除。
          </Text>
          {data.periods.map(p => (
            <View key={p.id} style={styles.card}>
              <Text style={styles.cardTitle}>{p.label} <Text style={styles.code}>{p.id}</Text></Text>
              <Text style={styles.muted}>第 {p.weeks[0]}–{p.weeks[1]} 周（约 {p.months[0]}–{p.months[1]} 个月）· 推送主题 {p.need}</Text>
              <Text style={styles.body}>{p.about}</Text>
              <Text style={styles.muted}>确认标签：{p.tags.length ? p.tags.map(t => t.label).join("、") : "无（只看月龄）"}</Text>
            </View>
          ))}
        </> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { padding: spacing.xl, gap: spacing.md, maxWidth: 960, width: "100%", alignSelf: "center" },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  title: { fontSize: 22, fontWeight: "700", color: colors.onSurface },
  navLink: { color: colors.brand, fontSize: 14, fontWeight: "600" },
  muted: { color: colors.onSurfaceSecondary, fontSize: 13, lineHeight: 19 },
  error: { color: "#b3261e", fontSize: 13 },
  body: { color: colors.onSurface, fontSize: 14, lineHeight: 20 },
  tabs: { flexDirection: "row", gap: spacing.sm },
  tab: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border },
  tabOn: { backgroundColor: colors.brand, borderColor: colors.brand },
  tabText: { color: colors.onSurface, fontSize: 13 },
  tabTextOn: { color: "#fff" },
  card: { backgroundColor: colors.surfaceSecondary, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.sm, borderWidth: 1, borderColor: colors.border },
  cardTitle: { fontSize: 16, fontWeight: "600", color: colors.onSurface },
  sub: { paddingLeft: spacing.md, borderLeftWidth: 2, borderLeftColor: colors.border, gap: 4, marginTop: spacing.sm },
  subTitle: { fontSize: 14, fontWeight: "600", color: colors.onSurface },
  code: { fontFamily: Platform.OS === "web" ? "monospace" : undefined, fontSize: 12, color: colors.onSurfaceSecondary, fontWeight: "400" },
  tags: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 },
  tag: { fontSize: 12, color: colors.onSurface, paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill, backgroundColor: colors.brandTertiary, overflow: "hidden" },
});
