// The usage dashboard at the top of /admin: how many testers, who came back,
// how long they stayed, how much they talked, and about what.
//
// Reads GET /admin/usage/overview, which does all the arithmetic; this file
// only lays it out. Admin screens are not translated (see src/i18n).
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { colors, radius, spacing } from "@/src/theme";

// ── Types (mirror backend/usage_dashboard.py build_overview) ────────────────
type DayCell = {
  turns: number;
  online_seconds: number;
  visits: number;
  first_seen: string | null;
  last_seen: string | null;
};
type UsageUser = {
  id: string;
  email: string;
  nickname: string;
  created_at: string;
  is_internal: boolean;
  days_active: number;
  days_chatted: number;
  turns: number;
  online_seconds: number;
  visits: number;
  last_seen_at: string | null;
  by_day: Record<string, DayCell>;
};
type Daily = {
  day: string;
  active_users: number;
  chatting_users: number;
  turns: number;
  online_seconds: number;
  visits: number;
  new_users: number;
};
type Overview = {
  tz: string;
  days: string[];
  tracking_since: string | null;
  visits_available: boolean;
  truncated: string[];
  testers: {
    total: number;
    unverified: number;
    internal: number;
    active_today: number;
    chatted_today: number;
    active_in_window: number;
    new_in_window: number;
  };
  daily: Daily[];
  hours: { turns: number[]; visits: number[] };
  users: UsageUser[];
  daily_posts?: DailyPosts;
  topics: {
    categories: { key: string; label: string; turns: number; share: number }[];
    top: { topic: string; turns: number }[];
    labelled_turns: number;
    unlabelled_turns: number;
  };
};

type DailyPostDay = {
  day: string; ready: number; empty: number; failed: number;
  opened: number; source_clicks: number; chats: number;
};
type DailyPostRow = {
  day: string; user: string; email: string; headline: string; source_label: string;
  source_url: string; platform: string; author_kind: string; basis: string;
  has_excerpt: boolean; opened: boolean; source_clicked: boolean; chat: boolean;
};
type DailyPosts = {
  days: DailyPostDay[];
  totals: Omit<DailyPostDay, "day">;
  recent: DailyPostRow[];
  basis: Record<string, number>;
  platforms: Record<string, number>;
} | null;

type SpendSplit = { key: "chat" | "cards" | "other"; label: string; tokens: number; share: number };
type QuotaPeriod = { period_start: string; turns: number; tokens: number; split: SpendSplit[] };
type QuotaIncident = QuotaPeriod & {
  exhausted_at: string;
  last_failure_at: string;
  failed_turns: number;
  recovered_at: string | null;
};
type QuotaReport = {
  days: number;
  since: string;
  incidents: QuotaIncident[];
  current: QuotaPeriod | null;
  truncated: string[];
};

// Mirrors backend/openai_billing.py summarize.
type CostDay = {
  day: string; usd: number; input_tokens: number; output_tokens: number;
  cached_tokens: number; requests: number; logged_tokens: number | null;
};
type CostReport =
  | { configured: false }
  | {
      configured: true;
      days: number;
      since: string;
      until: string;
      month_start: string;
      total_usd: number;
      month_to_date_usd: number;
      daily: CostDay[];
      projects: { id: string; name: string; usd: number; share: number }[];
      line_items: { name: string; usd: number; share: number }[];
      usage: { input_tokens: number; cached_tokens: number; output_tokens: number; requests: number; cached_share: number };
      logged: { tokens: number; unlogged_tokens: number; unlogged_share: number } | null;
      turns: number | null;
      usd_per_turn: number | null;
      target_usd_per_turn: number;
      fetched_at: string;
      truncated: string[];
      warnings?: string[];
    };

// ── Encoding ─────────────────────────────────────────────────────────────────
// Every chart here is a single series, so one mark color; identity comes from
// the title. The heatmap is magnitude: one hue, light -> dark (the validated
// default sequential blue ramp). "Online, didn't chat" is a neutral gray so it
// never reads as a small number of turns.
const MARK = colors.brandPrimary;
const RAMP = ["#b7d3f6", "#86b6ef", "#5598e7", "#256abf", "#104281"];
const RAMP_BINS = [
  { max: 2, label: "1–2" },
  { max: 5, label: "3–5" },
  { max: 10, label: "6–10" },
  { max: 20, label: "11–20" },
  { max: Infinity, label: "21+" },
];
const PRESENT_ONLY = "#e4e2dc";
// Who spent the tokens: identity, so categorical, in fixed slot order (the
// first three slots of the validated default palette; aqua is under 3:1 on
// white, so every share also prints as a number).
const SPEND_COLORS: Record<SpendSplit["key"], string> = {
  chat: "#2a78d6",
  cards: "#eb6834",
  other: "#1baf7a",
};

function fmtTokens(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(v);
}
const INK = colors.onSurface;
const INK_SECONDARY = colors.onSurfaceTertiary;
const INK_MUTED = colors.muted;

function binFor(turns: number): number {
  return RAMP_BINS.findIndex((b) => turns <= b.max);
}

const WINDOWS = [7, 14, 30] as const;

function browserTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Los_Angeles";
  } catch {
    return "America/Los_Angeles";
  }
}

const TZ_CHOICES = [
  { tz: "America/Los_Angeles", label: "美西" },
  { tz: "America/Toronto", label: "美东/多伦多" },
  { tz: "Asia/Shanghai", label: "北京" },
];

function fmtDuration(seconds: number): string {
  if (!seconds) return "0";
  if (seconds < 60) return "<1分";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}分`;
  const hours = minutes / 60;
  return `${hours >= 10 ? Math.round(hours) : hours.toFixed(1)}小时`;
}

function fmtDay(day: string): string {
  const [, m, d] = day.split("-");
  return `${Number(m)}/${Number(d)}`;
}

function fmtWhen(iso: string | null, tz: string): string {
  if (!iso) return "–";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "–";
  try {
    return d.toLocaleString("zh-CN", {
      timeZone: tz, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return d.toLocaleString();
  }
}

// ── Component ────────────────────────────────────────────────────────────────
export default function UsageDashboard({ adminKey, backend }: { adminKey: string; backend: string }) {
  const localTz = useMemo(browserTz, []);
  const [days, setDays] = useState<number>(14);
  const [tz, setTz] = useState<string>(localTz);
  const [includeInternal, setIncludeInternal] = useState(false);
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<{ userId: string; day: string } | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [hourMode, setHourMode] = useState<"turns" | "visits">("turns");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(
        `${backend}/admin/usage/overview?days=${days}&tz=${encodeURIComponent(tz)}` +
          `&include_internal=${includeInternal}`,
        { headers: { "x-admin-key": adminKey } },
      );
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      setData(await res.json());
    } catch (e: any) {
      setError(`看板加载失败：${String(e?.message || e).slice(0, 200)}`);
    } finally {
      setLoading(false);
    }
  }, [adminKey, backend, days, tz, includeInternal]);

  useEffect(() => {
    load();
  }, [load]);

  // Quota history reads the largest table over a longer window, so it loads
  // on its own and never holds up the rest of the dashboard.
  const [quotaDays, setQuotaDays] = useState<number>(60);
  const [quota, setQuota] = useState<QuotaReport | null>(null);
  const [quotaError, setQuotaError] = useState("");
  const loadQuota = useCallback(async () => {
    setQuotaError("");
    try {
      const res = await fetch(`${backend}/admin/usage/quota?days=${quotaDays}`, {
        headers: { "x-admin-key": adminKey },
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      setQuota(await res.json());
    } catch (e: any) {
      setQuota(null);
      setQuotaError(`额度记录加载失败：${String(e?.message || e).slice(0, 200)}`);
    }
  }, [adminKey, backend, quotaDays]);

  useEffect(() => {
    loadQuota();
  }, [loadQuota]);

  // The OpenAI bill comes from OpenAI itself (cached 10 minutes on the
  // server), so it also loads on its own.
  const [costDays, setCostDays] = useState<number>(30);
  const [costs, setCosts] = useState<CostReport | null>(null);
  const [costError, setCostError] = useState("");
  const loadCosts = useCallback(async (refresh = false) => {
    setCostError("");
    try {
      const res = await fetch(`${backend}/admin/usage/costs?days=${costDays}&refresh=${refresh}`, {
        headers: { "x-admin-key": adminKey },
      });
      if (!res.ok) {
        const text = await res.text();
        let detail = text;
        try {
          detail = JSON.parse(text).detail ?? text;
        } catch {}
        throw new Error(`${res.status} ${detail}`);
      }
      setCosts(await res.json());
    } catch (e: any) {
      setCosts(null);
      setCostError(`账单加载失败：${String(e?.message || e).slice(0, 200)}`);
    }
  }, [adminKey, backend, costDays]);

  useEffect(() => {
    loadCosts();
  }, [loadCosts]);

  const toggleInternal = async (user: UsageUser) => {
    setTogglingId(user.id);
    try {
      const res = await fetch(`${backend}/admin/accounts/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-admin-key": adminKey },
        body: JSON.stringify({ is_internal: !user.is_internal }),
      });
      if (!res.ok) throw new Error(await res.text());
      await load();
    } catch (e: any) {
      setError(`标记失败：${String(e?.message || e).slice(0, 200)}`);
    } finally {
      setTogglingId(null);
    }
  };

  const tzChoices = useMemo(() => {
    const known = TZ_CHOICES.some((c) => c.tz === localTz);
    return known ? TZ_CHOICES : [{ tz: localTz, label: `本地 (${localTz})` }, ...TZ_CHOICES];
  }, [localTz]);

  const today = data?.daily[data.daily.length - 1];
  const selectedUser = selected ? data?.users.find((u) => u.id === selected.userId) : undefined;
  const selectedCell = selectedUser && selected ? selectedUser.by_day[selected.day] : undefined;

  return (
    <View style={styles.wrap} testID="usage-dashboard">
      <View style={styles.titleRow}>
        <Text style={styles.title}>用户行为看板</Text>
        {loading ? <ActivityIndicator color={MARK} size="small" /> : null}
      </View>

      {/* Filters: one row above everything they affect. */}
      <View style={styles.filterRow}>
        {WINDOWS.map((d) => (
          <Chip key={d} label={`最近 ${d} 天`} active={days === d} onPress={() => setDays(d)} />
        ))}
        <View style={styles.filterGap} />
        {tzChoices.map((c) => (
          <Chip key={c.tz} label={c.label} active={tz === c.tz} onPress={() => setTz(c.tz)} />
        ))}
        <View style={styles.filterGap} />
        <Chip
          label="含内部账号"
          active={includeInternal}
          onPress={() => setIncludeInternal((v) => !v)}
        />
        <Pressable
          onPress={() => {
            load();
            loadQuota();
            loadCosts(true);
          }}
          style={styles.refreshBtn}
          testID="usage-refresh"
        >
          <Text style={styles.refreshText}>刷新</Text>
        </Pressable>
      </View>

      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      {data && today ? (
        <>
          {!data.visits_available ? (
            <Text style={styles.warnText}>
              user_visits 表还没建：在线时长和访问次数为空。先在 Supabase 跑
              20260910020000_usage_dashboard.sql。
            </Text>
          ) : null}
          {data.truncated.length ? (
            <Text style={styles.warnText}>
              数据量超过读取上限（{data.truncated.join("、")}），下面的数字只覆盖一部分。
            </Text>
          ) : null}

          {/* ── Headline numbers ── */}
          <View style={styles.tileRow}>
            <Tile
              label="测试人数"
              value={String(data.testers.total)}
              hint={`近 ${days} 天新增 ${data.testers.new_in_window}${
                data.testers.unverified ? ` · 未验证 ${data.testers.unverified}` : ""
              }`}
            />
            <Tile
              label="今日活跃"
              value={String(data.testers.active_today)}
              hint={`其中 ${data.testers.chatted_today} 人对话`}
            />
            <Tile
              label={`近 ${days} 天活跃`}
              value={`${data.testers.active_in_window}/${data.testers.total}`}
              hint={
                data.testers.total
                  ? `${Math.round((data.testers.active_in_window / data.testers.total) * 100)}% 回来过`
                  : undefined
              }
            />
            <Tile label="今日对话轮数" value={String(today.turns)} />
            <Tile
              label="今日在线"
              value={fmtDuration(today.online_seconds)}
              hint={
                today.active_users
                  ? `人均 ${fmtDuration(Math.round(today.online_seconds / today.active_users))} · ${today.visits} 次访问`
                  : undefined
              }
            />
          </View>

          {/* ── Daily trend: small multiples, one measure each, never two axes ── */}
          <View style={styles.multiples}>
            <ColumnChart
              title="每日活跃人数"
              values={data.daily.map((d) => d.active_users)}
              labels={data.days}
              format={(v) => `${v} 人`}
              detail={(i) =>
                `${data.daily[i].chatting_users} 人对话${
                  data.daily[i].new_users ? ` · 新增 ${data.daily[i].new_users}` : ""
                }`
              }
            />
            <ColumnChart
              title="每日对话轮数"
              values={data.daily.map((d) => d.turns)}
              labels={data.days}
              format={(v) => `${v} 轮`}
            />
            <ColumnChart
              title="每日在线时长"
              values={data.daily.map((d) => Math.round(d.online_seconds / 60))}
              labels={data.days}
              format={(v) => `${v} 分钟`}
              detail={(i) => `${data.daily[i].visits} 次访问`}
            />
          </View>

          {/* ── Per-tester matrix ── */}
          <Text style={styles.sectionTitle}>每位测试者 · 每天</Text>
          <Text style={styles.hint}>
            格子里的数字是当天对话轮数；灰格 = 上线了但没对话；空格 = 没来。点格子看当天在线时长和上线时间。
          </Text>
          <Legend />
          <Matrix
            data={data}
            selected={selected}
            onSelect={(userId, day) =>
              setSelected((cur) => (cur?.userId === userId && cur.day === day ? null : { userId, day }))
            }
            onToggleInternal={toggleInternal}
            togglingId={togglingId}
          />
          {selectedUser && selected ? (
            <View style={styles.detailCard} testID="usage-cell-detail">
              <Text style={styles.detailTitle}>
                {selectedUser.nickname || selectedUser.email} · {fmtDay(selected.day)}
              </Text>
              {selectedCell ? (
                <Text style={styles.detailText}>
                  对话 {selectedCell.turns} 轮 · 在线 {fmtDuration(selectedCell.online_seconds)} ·{" "}
                  {selectedCell.visits} 次访问
                  {selectedCell.first_seen
                    ? ` · ${selectedCell.first_seen}–${selectedCell.last_seen} 之间活动`
                    : ""}
                </Text>
              ) : (
                <Text style={styles.detailText}>这天没有来。</Text>
              )}
            </View>
          ) : null}

          {/* ── The daily card: built, opened, used ── */}
          <View style={styles.panelBlock} testID="usage-daily-posts">
            <Text style={styles.panelTitle}>每日家长经验卡片（近 {days} 天）</Text>
            <DailyPostsSection posts={data.daily_posts} tz={data.tz} />
          </View>

          {/* ── What they talk about / when ── */}
          <View style={styles.multiples}>
            <View style={[styles.panel, { flexGrow: 2 }]}>
              <Text style={styles.panelTitle}>
                内容分布（{data.topics.labelled_turns} 轮有话题标签
                {data.topics.unlabelled_turns ? `，${data.topics.unlabelled_turns} 轮没有` : ""}）
              </Text>
              <TopicBars categories={data.topics.categories} />
              {data.topics.top.length ? (
                <>
                  <Text style={[styles.panelTitle, { marginTop: spacing.md }]}>最常见的具体话题</Text>
                  <View style={styles.topicWrap}>
                    {data.topics.top.map((t) => (
                      <View key={t.topic} style={styles.topicChip}>
                        <Text style={styles.topicText} numberOfLines={1}>
                          {t.topic}
                        </Text>
                        <Text style={styles.topicCount}>{t.turns}</Text>
                      </View>
                    ))}
                  </View>
                </>
              ) : null}
            </View>
            <View style={[styles.panel, { flexGrow: 1 }]}>
              <View style={styles.panelHead}>
                <Text style={styles.panelTitle}>一天里什么时候用</Text>
                <View style={styles.segment}>
                  <Chip small label="对话" active={hourMode === "turns"} onPress={() => setHourMode("turns")} />
                  <Chip small label="上线" active={hourMode === "visits"} onPress={() => setHourMode("visits")} />
                </View>
              </View>
              <ColumnChart
                bare
                peakByDefault
                values={data.hours[hourMode]}
                labels={Array.from({ length: 24 }, (_, h) => `${h}`)}
                format={(v) => (hourMode === "turns" ? `${v} 轮` : `${v} 次上线`)}
                labelFor={(h) => `${h}:00–${h}:59`}
              />
            </View>
          </View>

          {/* ── OpenAI bill: what the whole organization was charged ── */}
          <View style={styles.panelBlock} testID="usage-openai-costs">
            <View style={styles.panelHead}>
              <Text style={styles.panelTitle}>OpenAI 真实账单（整个组织）</Text>
              <View style={styles.segment}>
                {[7, 30, 90].map((d) => (
                  <Chip key={d} small label={`${d} 天`} active={costDays === d} onPress={() => setCostDays(d)} />
                ))}
              </View>
            </View>
            {costError ? <Text style={styles.errorText}>{costError}</Text> : null}
            {costs ? (
              <CostSection report={costs} />
            ) : !costError ? (
              <ActivityIndicator color={MARK} style={{ marginVertical: spacing.sm }} />
            ) : null}
          </View>

          {/* ── OpenAI quota: how far one top-up goes, and who spends it ── */}
          <View style={styles.panelBlock}>
            <View style={styles.panelHead}>
              <Text style={styles.panelTitle}>OpenAI 额度耗光记录</Text>
              <View style={styles.segment}>
                {[30, 60, 180].map((d) => (
                  <Chip key={d} small label={`${d} 天`} active={quotaDays === d} onPress={() => setQuotaDays(d)} />
                ))}
              </View>
            </View>
            {quotaError ? <Text style={styles.errorText}>{quotaError}</Text> : null}
            {quota ? (
              <QuotaSection report={quota} tz={data.tz} />
            ) : !quotaError ? (
              <ActivityIndicator color={MARK} style={{ marginVertical: spacing.sm }} />
            ) : null}
          </View>

          <Text style={styles.footNote}>
            时区 {data.tz}。对话轮数 = 家长发出的消息数，历史数据完整；在线时长与访问次数来自 App
            心跳，{data.tracking_since ? `从 ${fmtWhen(data.tracking_since, data.tz)} 开始记录` : "还没有记录"}
            ，之前的日子只有对话。测试人数不含内部账号和未验证邮箱的账号。话题分类是关键词归类，适合看比例，不适合逐条核对。
          </Text>
        </>
      ) : !error && loading ? (
        <ActivityIndicator color={MARK} style={{ marginVertical: spacing.lg }} />
      ) : null}
    </View>
  );
}

// ── Pieces ───────────────────────────────────────────────────────────────────

function Chip({
  label, active, onPress, small,
}: { label: string; active: boolean; onPress: () => void; small?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.chip, small && styles.chipSmall, active && styles.chipActive]}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

function Tile({
  label, value, hint, alert,
}: { label: string; value: string; hint?: string; alert?: boolean }) {
  return (
    <View style={styles.tile}>
      <Text style={[styles.tileValue, alert && styles.tileValueAlert]}>{value}</Text>
      <Text style={styles.tileLabel}>{label}</Text>
      {hint ? <Text style={styles.tileHint}>{hint}</Text> : null}
    </View>
  );
}

const CHART_H = 96;

/** Single-series columns from one baseline. The newest column is labelled;
 *  any other column's value shows on hover (web) or tap. */
function ColumnChart({
  title, values, labels, format, detail, labelFor, bare, peakByDefault,
}: {
  title?: string;
  values: number[];
  labels: string[];
  format: (v: number) => string;
  detail?: (i: number) => string;
  labelFor?: (i: number) => string;
  bare?: boolean;
  /** Caption the tallest column instead of the newest one when nothing is
   *  hovered — for a distribution, where "latest" means nothing. */
  peakByDefault?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...values);
  const resting = peakByDefault ? values.indexOf(Math.max(...values)) : values.length - 1;
  const shown = hover ?? resting;
  const every = values.length > 20 ? Math.ceil(values.length / 8) : values.length > 10 ? 2 : 1;
  const axisLabel = (i: number) => (labels[i].includes("-") ? fmtDay(labels[i]) : labels[i]);
  const caption = `${hover === null && peakByDefault ? "高峰 " : ""}${
    labelFor ? labelFor(shown) : axisLabel(shown)
  }：${format(values[shown] ?? 0)}${detail ? ` · ${detail(shown)}` : ""}`;

  const body = (
    <>
      {title ? <Text style={styles.panelTitle}>{title}</Text> : null}
      <Text style={styles.chartCaption} numberOfLines={1}>
        {caption}
      </Text>
      <View style={styles.plot}>
        {values.map((v, i) => {
          const h = v ? Math.max(3, Math.round((v / max) * CHART_H)) : 0;
          return (
            <Pressable
              key={i}
              style={styles.slot}
              onHoverIn={() => setHover(i)}
              onHoverOut={() => setHover(null)}
              onPress={() => setHover((cur) => (cur === i ? null : i))}
              accessibilityLabel={`${labelFor ? labelFor(i) : axisLabel(i)} ${format(v)}`}
            >
              <View
                style={[
                  styles.column,
                  { height: h, backgroundColor: MARK, opacity: hover === null || hover === i ? 1 : 0.45 },
                ]}
              />
            </Pressable>
          );
        })}
      </View>
      <View style={styles.axis}>
        {values.map((_, i) => (
          <Text key={i} style={styles.axisText} numberOfLines={1}>
            {i % every === (values.length - 1) % every ? axisLabel(i) : ""}
          </Text>
        ))}
      </View>
    </>
  );
  return bare ? <View>{body}</View> : <View style={styles.panel}>{body}</View>;
}

function Legend() {
  return (
    <View style={styles.legendRow}>
      <View style={[styles.legendSwatch, { backgroundColor: PRESENT_ONLY }]} />
      <Text style={styles.legendText}>上线未对话</Text>
      {RAMP_BINS.map((b, i) => (
        <View key={b.label} style={styles.legendItem}>
          <View style={[styles.legendSwatch, { backgroundColor: RAMP[i] }]} />
          <Text style={styles.legendText}>{b.label} 轮</Text>
        </View>
      ))}
    </View>
  );
}

const NAME_W = 190;
const STAT_COLS = [
  { key: "days", label: "活跃天", width: 58 },
  { key: "turns", label: "对话轮", width: 58 },
  { key: "online", label: "在线", width: 66 },
  { key: "visits", label: "访问", width: 48 },
  { key: "last", label: "最近在线", width: 108 },
] as const;
const CELL = 30;

function Matrix({
  data, selected, onSelect, onToggleInternal, togglingId,
}: {
  data: Overview;
  selected: { userId: string; day: string } | null;
  onSelect: (userId: string, day: string) => void;
  onToggleInternal: (u: UsageUser) => void;
  togglingId: string | null;
}) {
  if (!data.users.length) {
    return <Text style={styles.hint}>还没有测试者。</Text>;
  }
  const every = data.days.length > 14 ? 3 : 1;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator style={styles.matrixScroll}>
      <View>
        <View style={styles.matrixHeader}>
          <Text style={[styles.th, { width: NAME_W }]}>测试者</Text>
          {STAT_COLS.map((c) => (
            <Text key={c.key} style={[styles.th, { width: c.width }]}>
              {c.label}
            </Text>
          ))}
          {data.days.map((d, i) => (
            <Text key={d} style={[styles.th, styles.dayHead]}>
              {i % every === (data.days.length - 1) % every ? fmtDay(d) : ""}
            </Text>
          ))}
          <Text style={[styles.th, { width: 84, textAlign: "center" }]}>标记</Text>
        </View>
        {data.users.map((u) => (
          <View key={u.id} style={styles.matrixRow}>
            <View style={{ width: NAME_W }}>
              <Text style={styles.name} numberOfLines={1}>
                {u.nickname || "(无昵称)"}
                {u.is_internal ? "  · 内部" : ""}
              </Text>
              <Text style={styles.email} numberOfLines={1}>
                {u.email}
              </Text>
            </View>
            <Text style={[styles.td, { width: 58 }]}>
              {u.days_active}/{data.days.length}
            </Text>
            <Text style={[styles.td, { width: 58 }]}>{u.turns}</Text>
            <Text style={[styles.td, { width: 66 }]}>{fmtDuration(u.online_seconds)}</Text>
            <Text style={[styles.td, { width: 48 }]}>{u.visits}</Text>
            <Text style={[styles.td, { width: 108 }]} numberOfLines={1}>
              {fmtWhen(u.last_seen_at, data.tz)}
            </Text>
            {data.days.map((d) => {
              const cell = u.by_day[d];
              const active = !!cell && (cell.turns > 0 || cell.visits > 0);
              const bin = cell && cell.turns ? binFor(cell.turns) : -1;
              const fill = bin >= 0 ? RAMP[bin] : active ? PRESENT_ONLY : "transparent";
              const isSelected = selected?.userId === u.id && selected.day === d;
              return (
                <Pressable
                  key={d}
                  onPress={() => onSelect(u.id, d)}
                  style={styles.cellHit}
                  accessibilityLabel={`${u.email} ${d} ${cell ? `${cell.turns} 轮` : "未活跃"}`}
                >
                  <View
                    style={[
                      styles.cell,
                      { backgroundColor: fill },
                      !active && styles.cellEmpty,
                      isSelected && styles.cellSelected,
                    ]}
                  >
                    {cell && cell.turns ? (
                      <Text style={[styles.cellText, bin >= 3 && { color: "#fff" }]}>{cell.turns}</Text>
                    ) : null}
                  </View>
                </Pressable>
              );
            })}
            <Pressable
              onPress={() => onToggleInternal(u)}
              disabled={togglingId === u.id}
              style={[styles.flagBtn, togglingId === u.id && { opacity: 0.5 }]}
            >
              <Text style={styles.flagText}>{u.is_internal ? "设为测试者" : "设为内部"}</Text>
            </Pressable>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

function pct(part: number, whole: number): string {
  return whole ? `${Math.round((part / whole) * 100)}%` : "–";
}

function DailyPostsSection({ posts, tz }: { posts: DailyPosts | undefined; tz: string }) {
  if (posts === undefined) return null;
  if (posts === null) {
    return (
      <Text style={styles.warnText}>
        daily_post_cards 表还没建：先在 Supabase 跑 20260911010000_daily_post_cards.sql。
      </Text>
    );
  }
  const { totals } = posts;
  const attempted = totals.ready + totals.empty + totals.failed;
  return (
    <View>
      <View style={styles.tileRow}>
        <Tile
          label="生成成功"
          value={String(totals.ready)}
          hint={attempted ? `共尝试 ${attempted} 次 · 成功率 ${pct(totals.ready, attempted)}` : undefined}
        />
        <Tile label="打开" value={String(totals.opened)} hint={`占生成 ${pct(totals.opened, totals.ready)}`} />
        <Tile
          label="点原帖"
          value={String(totals.source_clicks)}
          hint={`占打开 ${pct(totals.source_clicks, totals.opened)}`}
        />
        <Tile label="去聊天" value={String(totals.chats)} hint={`占打开 ${pct(totals.chats, totals.opened)}`} />
      </View>
      <Text style={styles.hint}>
        {`按对话找到 ${posts.basis.conversation || 0} 张 · 按孩子月龄找到 ${posts.basis.profile || 0} 张`}
        {totals.empty ? ` · ${totals.empty} 次当天没找到合适的帖子` : ""}
        {totals.failed ? ` · ${totals.failed} 次出错` : ""}
        。按对话找需要家长打开“外部内容检索”开关。
      </Text>
      {posts.recent.length ? (
        <>
          <Text style={[styles.panelTitle, { marginTop: spacing.sm }]}>最近发出的卡片（点标题看原帖）</Text>
          {posts.recent.map((row) => (
            <View key={`${row.day}:${row.email}`} style={styles.postRow}>
              <Text style={styles.postMeta} numberOfLines={1}>
                {row.day.slice(5).replace("-", "/")} · {row.user}
                {"  "}
                {row.basis === "conversation" ? "按对话" : "按月龄"}
                {row.author_kind === "parent_group_answers" ? " · 家长群讨论" : " · 家长分享"}
                {row.has_excerpt ? "" : " · 无原文摘录"}
              </Text>
              <Pressable
                onPress={() => /^https:\/\//i.test(row.source_url) && void Linking.openURL(row.source_url)}
                accessibilityRole="link"
              >
                <Text style={styles.postTitle} numberOfLines={2}>{row.headline}</Text>
              </Pressable>
              <Text style={styles.postMeta} numberOfLines={1}>
                {row.source_label}
                {"   "}
                {[row.opened ? "已打开" : "未打开", row.source_clicked ? "点了原帖" : "", row.chat ? "去聊天了" : ""]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
            </View>
          ))}
        </>
      ) : (
        <Text style={styles.hint}>这个范围内还没有发出的卡片。</Text>
      )}
      <Text style={styles.hint}>卡片的日期是测试者自己时区的“当天”，不随上面选的时区（{tz}）变。</Text>
    </View>
  );
}

function SpendBar({ split }: { split: SpendSplit[] }) {
  const parts = split.filter((s) => s.tokens > 0);
  if (!parts.length) return <Text style={styles.hint}>这段时间没有 token 记录。</Text>;
  return (
    <View>
      {/* 100% stacked: segments separated by 2px of surface. */}
      <View style={styles.spendTrack}>
        {parts.map((s) => (
          <View
            key={s.key}
            style={{ flex: s.tokens, backgroundColor: SPEND_COLORS[s.key], height: 12 }}
            accessibilityLabel={`${s.label} ${Math.round(s.share * 100)}%`}
          />
        ))}
      </View>
      <View style={styles.spendLegend}>
        {split.map((s) => (
          <View key={s.key} style={styles.legendItem}>
            <View style={[styles.legendSwatch, { backgroundColor: SPEND_COLORS[s.key] }]} />
            <Text style={styles.legendText}>
              {s.label} {Math.round(s.share * 100)}% · {fmtTokens(s.tokens)}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function fmtUsd(v: number): string {
  if (v > 0 && v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

function CostBars({ rows }: { rows: { key: string; name: string; usd: number; share: number }[] }) {
  if (!rows.length) return <Text style={styles.hint}>这段时间没有花费。</Text>;
  const max = Math.max(...rows.map((r) => r.usd), 0.0001);
  return (
    <View>
      {rows.map((r) => (
        <View key={r.key} style={styles.hbarRow}>
          <Text style={styles.costLabel} numberOfLines={1}>
            {r.name}
          </Text>
          <View style={styles.hbarTrack}>
            <View style={[styles.hbar, { width: `${Math.max(2, (r.usd / max) * 100)}%` }]} />
          </View>
          <Text style={styles.costValue}>
            {fmtUsd(r.usd)} · {Math.round(r.share * 100)}%
          </Text>
        </View>
      ))}
    </View>
  );
}

function CostSection({ report }: { report: CostReport }) {
  if (!report.configured) {
    return (
      <Text style={styles.hint}>
        还没有配置 OPENAI_ADMIN_KEY：在 Vercel 环境变量里加上（Production 和 Preview），重新部署后这里会显示真实账单。
      </Text>
    );
  }
  const perTurn = report.usd_per_turn;
  const overTarget = perTurn !== null && perTurn > report.target_usd_per_turn;
  const billedTokens = report.usage.input_tokens + report.usage.output_tokens;
  return (
    <View>
      <View style={styles.tileRow}>
        <Tile
          label={`近 ${report.days} 天花费`}
          value={fmtUsd(report.total_usd)}
          hint={`${fmtDay(report.since)} – ${fmtDay(report.until)}（UTC）`}
        />
        <Tile label="本月累计" value={fmtUsd(report.month_to_date_usd)} hint={`${fmtDay(report.month_start)} 起`} />
        <Tile
          label="每轮对话折算"
          value={perTurn === null ? "–" : `$${perTurn.toFixed(4)}`}
          hint={
            perTurn === null
              ? "这段时间本库没有成功的对话"
              : `${overTarget ? "高于" : "达到"}目标 ≤ $${report.target_usd_per_turn} · ${report.turns} 轮`
          }
          alert={overTarget}
        />
        {report.logged ? (
          <Tile
            label="本库没记录的 token"
            value={`${Math.round(report.logged.unlogged_share * 100)}%`}
            hint={`${fmtTokens(report.logged.unlogged_tokens)} / 账单 ${fmtTokens(billedTokens)}`}
          />
        ) : null}
      </View>

      <ColumnChart
        title="每天花费（UTC）"
        values={report.daily.map((d) => d.usd)}
        labels={report.daily.map((d) => d.day)}
        format={fmtUsd}
        detail={(i) => {
          const d = report.daily[i];
          return `${fmtTokens(d.input_tokens + d.output_tokens)} token · ${d.requests} 次请求`;
        }}
      />

      <Text style={styles.sectionTitle}>按项目</Text>
      <CostBars rows={report.projects.map((p) => ({ key: p.id || "none", ...p }))} />
      <Text style={styles.sectionTitle}>按费用类型</Text>
      <CostBars rows={report.line_items.map((l) => ({ key: l.name, ...l }))} />

      <Text style={styles.detailText}>
        输入 {fmtTokens(report.usage.input_tokens)}（其中命中缓存 {Math.round(report.usage.cached_share * 100)}%）· 输出{" "}
        {fmtTokens(report.usage.output_tokens)} · {report.usage.requests} 次请求
      </Text>
      {report.warnings?.length ? (
        <Text style={styles.errorText}>token 用量没读到（金额不受影响）：{report.warnings.join("；")}</Text>
      ) : null}
      {report.truncated.length ? (
        <Text style={styles.warnText}>本库日志读取不完整：{report.truncated.join("、")}。</Text>
      ) : null}
      <Text style={styles.hint}>
        数据来自 OpenAI 组织账单（Costs / Usage API），包含所有环境和所有密钥，按 UTC 自然日统计，最近几个小时的花费会延迟入账。
        每轮折算 = 账单总额 ÷ 本库成功的对话轮数；开发、评测的花费也算在里面，所以会偏高，把它们拆到独立项目后看线上项目最准。
        本库没记录的 token = 账单里的对话 token − 本库 llm_call_logs 的记录（不含 embedding），差额来自开发库、评测脚本和关了日志的调用。
        服务器缓存 10 分钟，点“刷新”会重新读取。
      </Text>
    </View>
  );
}

function QuotaSection({ report, tz }: { report: QuotaReport; tz: string }) {
  return (
    <View>
      {report.current ? (
        <View style={styles.quotaCurrent}>
          <Text style={styles.detailTitle}>
            当前这一段（{report.incidents.length ? "上次恢复" : `近 ${report.days} 天起`}{" "}
            {fmtWhen(report.current.period_start, tz)} 至今）：已对话 {report.current.turns} 轮 · 共{" "}
            {fmtTokens(report.current.tokens)} token
          </Text>
          <SpendBar split={report.current.split} />
        </View>
      ) : (
        <Text style={[styles.errorText, { marginVertical: spacing.sm }]}>
          额度现在是耗光状态：最近一次失败之后还没有成功的对话。
        </Text>
      )}

      {report.incidents.length === 0 ? (
        <Text style={styles.hint}>近 {report.days} 天没有遇到额度耗光。</Text>
      ) : (
        report.incidents.map((inc) => (
          <View key={inc.exhausted_at} style={styles.quotaRow}>
            <Text style={styles.detailText}>
              <Text style={{ fontWeight: "700" }}>{fmtWhen(inc.exhausted_at, tz)} 耗光</Text>
              {inc.recovered_at ? ` · ${fmtWhen(inc.recovered_at, tz)} 恢复` : " · 仍未恢复"}
              {inc.failed_turns ? ` · 期间失败 ${inc.failed_turns} 轮` : ""}
            </Text>
            <Text style={styles.detailText}>
              耗光前这一段（{fmtWhen(inc.period_start, tz)} 起）共对话{" "}
              <Text style={{ fontWeight: "700" }}>
                {inc.turns}
                {inc.period_start === report.since ? "+" : ""}
              </Text>{" "}
              轮 · {fmtTokens(inc.tokens)} token
              {inc.period_start === report.since
                ? "（从统计范围的开头算起，更早的对话不在范围内，实际更多；拉长天数可看全）"
                : ""}
            </Text>
            <SpendBar split={inc.split} />
          </View>
        ))
      )}
      {report.truncated.length ? (
        <Text style={styles.warnText}>读取不完整：{report.truncated.join("、")}。</Text>
      ) : null}
      <Text style={styles.hint}>
        耗光 = OpenAI 返回 insufficient_quota（普通的每分钟限流不算）；下一轮成功的对话视为已充值恢复。
        对话 token 含回复、路由、记忆、摘要、任务卡；知识卡片含卡片生成与内容检索。对话轮数含内部账号，因为它们花的是同一份额度。
      </Text>
    </View>
  );
}

function TopicBars({ categories }: { categories: Overview["topics"]["categories"] }) {
  if (!categories.length) {
    return <Text style={styles.hint}>这个范围内还没有带话题的对话。</Text>;
  }
  const max = Math.max(...categories.map((c) => c.turns));
  return (
    <View>
      {categories.map((c) => (
        <View key={c.key} style={styles.hbarRow}>
          <Text style={styles.hbarLabel} numberOfLines={1}>
            {c.label}
          </Text>
          <View style={styles.hbarTrack}>
            <View style={[styles.hbar, { width: `${Math.max(2, (c.turns / max) * 100)}%` }]} />
          </View>
          <Text style={styles.hbarValue}>
            {c.turns} · {Math.round(c.share * 100)}%
          </Text>
        </View>
      ))}
    </View>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  wrap: {
    backgroundColor: colors.surfaceSecondary, borderRadius: radius.lg, borderWidth: 1,
    borderColor: colors.border, padding: spacing.lg, marginBottom: spacing.lg,
  },
  titleRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginBottom: spacing.md },
  title: { fontSize: 18, fontWeight: "800", color: INK },

  filterRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, marginBottom: spacing.md },
  filterGap: { width: spacing.sm },
  chip: {
    paddingVertical: 6, paddingHorizontal: 12, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceSecondary,
  },
  chipSmall: { paddingVertical: 3, paddingHorizontal: 8 },
  chipActive: { backgroundColor: MARK, borderColor: MARK },
  chipText: { color: INK, fontSize: 12 },
  chipTextActive: { color: "#fff", fontWeight: "600" },
  refreshBtn: {
    marginLeft: "auto", paddingVertical: 6, paddingHorizontal: 12, borderRadius: radius.md,
    backgroundColor: MARK,
  },
  refreshText: { color: "#fff", fontSize: 12, fontWeight: "600" },

  errorText: { color: colors.error, fontSize: 13, marginBottom: spacing.sm },
  warnText: { color: INK_SECONDARY, fontSize: 12, marginBottom: spacing.sm, lineHeight: 18 },

  tileRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginBottom: spacing.md },
  tile: {
    flexGrow: 1, flexBasis: 130, borderRadius: radius.md, borderWidth: 1,
    borderColor: colors.border, padding: spacing.md,
  },
  tileValue: { fontSize: 22, fontWeight: "800", color: INK },
  tileValueAlert: { color: colors.error },
  tileLabel: { fontSize: 12, color: INK_SECONDARY, marginTop: 2 },
  tileHint: { fontSize: 11, color: INK_MUTED, marginTop: 2 },

  multiples: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginBottom: spacing.md },
  panel: {
    flexGrow: 1, flexBasis: 260, borderRadius: radius.md, borderWidth: 1,
    borderColor: colors.border, padding: spacing.md,
  },
  // A full-width panel on its own row. `panel`'s flexBasis is a width inside a
  // row of panels, but in a column it becomes a fixed height and clips.
  panelBlock: {
    borderRadius: radius.md, borderWidth: 1, borderColor: colors.border,
    padding: spacing.md, marginBottom: spacing.md,
  },
  panelHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  panelTitle: { fontSize: 12, fontWeight: "700", color: INK_SECONDARY, marginBottom: 4 },
  segment: { flexDirection: "row", gap: 4 },
  chartCaption: { fontSize: 12, color: INK, marginBottom: 6 },
  plot: {
    height: CHART_H, flexDirection: "row", alignItems: "flex-end",
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  slot: { flex: 1, height: "100%", justifyContent: "flex-end", alignItems: "center", paddingHorizontal: 1 },
  // <= 24px, rounded data-end, square at the baseline.
  column: { width: "70%", maxWidth: 24, borderTopLeftRadius: 4, borderTopRightRadius: 4 },
  axis: { flexDirection: "row", marginTop: 3 },
  axisText: { flex: 1, fontSize: 9, color: INK_MUTED, textAlign: "center" },

  sectionTitle: { fontSize: 13, fontWeight: "700", color: INK_SECONDARY, marginTop: spacing.sm },
  hint: { fontSize: 12, color: INK_MUTED, marginTop: 2, marginBottom: spacing.sm },
  legendRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, marginBottom: spacing.sm },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 4 },
  legendSwatch: { width: 12, height: 12, borderRadius: 3 },
  legendText: { fontSize: 11, color: INK_SECONDARY, marginRight: 6 },

  matrixScroll: { marginBottom: spacing.sm },
  matrixHeader: {
    flexDirection: "row", alignItems: "flex-end", borderBottomWidth: 1,
    borderBottomColor: colors.border, paddingBottom: 4,
  },
  th: { fontSize: 11, fontWeight: "700", color: INK_SECONDARY },
  dayHead: { width: CELL, textAlign: "center", fontSize: 9 },
  matrixRow: {
    flexDirection: "row", alignItems: "center", paddingVertical: 4,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
  },
  name: { fontSize: 12, fontWeight: "600", color: INK },
  email: { fontSize: 10, color: INK_MUTED },
  td: { fontSize: 12, color: INK },
  cellHit: { width: CELL, height: CELL, alignItems: "center", justifyContent: "center" },
  // 2px of surface between neighbours comes from the cell being 26 in a 30 slot.
  cell: { width: CELL - 4, height: CELL - 4, borderRadius: 4, alignItems: "center", justifyContent: "center" },
  cellEmpty: { borderWidth: 1, borderColor: colors.border },
  cellSelected: { borderWidth: 2, borderColor: INK },
  cellText: { fontSize: 11, fontWeight: "700", color: INK },
  flagBtn: {
    width: 84, marginLeft: 6, paddingVertical: 4, borderRadius: radius.sm,
    borderWidth: 1, borderColor: colors.border, alignItems: "center",
  },
  flagText: { fontSize: 11, color: INK_SECONDARY },

  detailCard: {
    borderRadius: radius.md, borderWidth: 1, borderColor: colors.border,
    padding: spacing.md, marginBottom: spacing.md, backgroundColor: colors.surface,
  },
  detailTitle: { fontSize: 13, fontWeight: "700", color: INK },
  detailText: { fontSize: 12, color: INK, marginTop: 4 },

  hbarRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginVertical: 3 },
  hbarLabel: { width: 64, fontSize: 12, color: INK },
  hbarTrack: { flex: 1, height: 14, justifyContent: "center" },
  hbar: {
    height: 14, backgroundColor: MARK,
    borderTopRightRadius: 4, borderBottomRightRadius: 4,
  },
  hbarValue: { width: 72, fontSize: 11, color: INK_SECONDARY, textAlign: "right" },
  costLabel: { width: 160, fontSize: 12, color: INK },
  costValue: { width: 96, fontSize: 11, color: INK_SECONDARY, textAlign: "right" },
  topicWrap: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  topicChip: {
    flexDirection: "row", alignItems: "center", gap: 6, maxWidth: 260,
    paddingVertical: 4, paddingHorizontal: 8, borderRadius: radius.pill,
    borderWidth: 1, borderColor: colors.border,
  },
  topicText: { fontSize: 11, color: INK, flexShrink: 1 },
  topicCount: { fontSize: 11, color: INK_MUTED },

  spendTrack: {
    flexDirection: "row", gap: 2, borderRadius: 4, overflow: "hidden", marginTop: 6,
  },
  spendLegend: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 6 },
  quotaCurrent: {
    borderRadius: radius.md, backgroundColor: colors.surface, padding: spacing.md,
    marginVertical: spacing.sm,
  },
  postRow: {
    paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border,
  },
  postMeta: { fontSize: 11, color: INK_MUTED },
  postTitle: { fontSize: 13, fontWeight: "600", color: colors.brandPrimary, marginVertical: 2 },
  quotaRow: {
    paddingVertical: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },

  footNote: { fontSize: 11, color: INK_MUTED, lineHeight: 17, marginTop: spacing.sm },
});
