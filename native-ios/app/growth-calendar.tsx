// Week-by-week growth calendar (GET /children/{id}/growth-calendar): the
// critical periods a child is in or coming up to, and which of them what the
// parent told NURI confirms. Tapping a period says what it is; the wording
// stays "常见于", never a deadline.
import { useCallback, useState } from "react";
import { Pressable, View } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { api, type GrowthCalendar, type GrowthPeriod } from "@/src/api";
import { useAccountScope, useAccountState } from "@/src/useAccountState";
import { useT, translate } from "@/src/i18n";
import { InlineState } from "@/src/uiux48/Primitives";
import { useNuriTheme } from "@/src/uiux48/Theme";
import { SettingsPage, SettingsChoice, SettingsChoices, SettingsButton } from "@/src/uiuxfinal/Settings";
import { FinalText } from "@/src/uiuxfinal/Primitives";

type Child = { id: string; nickname: string; birth_date?: string | null };

export default function GrowthCalendarPage() {
  const theme = useNuriTheme();
  const router = useRouter();
  const { child: childParam } = useLocalSearchParams<{ child?: string }>();
  const { locale } = useT();
  const en = locale === "en";
  const copy = (cn: string, english: string) => en ? english : translate(locale, cn);
  const { capture, current } = useAccountScope();
  const [children, setChildren] = useAccountState<Child[]>([]);
  const [childId, setChildId] = useAccountState<string | null>(null);
  const [calendar, setCalendar] = useAccountState<GrowthCalendar | null>(null);
  const [state, setState] = useAccountState<"loading" | "ready" | "error" | "empty">("loading");
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async (wanted?: string | null) => {
    const ticket = capture();
    if (ticket === null) return;
    setState("loading");
    try {
      const kids = ((await api.listChildren()) as Child[]).filter(c => c.birth_date);
      if (!current(ticket)) return;
      setChildren(kids);
      const id = (wanted && kids.some(k => k.id === wanted) ? wanted : null)
        ?? (childParam && kids.some(k => k.id === childParam) ? childParam : null)
        ?? kids[kids.length - 1]?.id ?? null;
      setChildId(id);
      if (!id) { setState("empty"); return; }
      const cal = await api.growthCalendar(id);
      if (!current(ticket)) return;
      setCalendar(cal);
      setState(cal.state === "ready" ? "ready" : "empty");
    } catch {
      if (current(ticket)) setState("error");
    }
  }, [capture, current, childParam, setChildren, setChildId, setCalendar, setState]);

  useFocusEffect(useCallback(() => { void load(childId); }, [load]));

  const dateLabel = (iso: string) => {
    const [, m, d] = iso.split("-").map(Number);
    return en ? `${m}/${d}` : `${m}月${d}日`;
  };
  const ageLabel = (months: number) => en ? `${months.toFixed(1)} mo` : `${months.toFixed(1)} 个月`;
  const statusLabel: Record<GrowthPeriod["status"], string> = {
    active: copy("已出现", "Happening"),
    possible: copy("常见于这时", "Common now"),
    upcoming: copy("即将开始", "Coming up"),
    closing: copy("接近尾声", "Winding down"),
  };

  const pill = (weekStart: string, p: GrowthPeriod) => {
    const key = `${weekStart}:${p.id}`;
    const active = p.status === "active";
    const faint = p.status === "upcoming" || p.status === "closing";
    return <Pressable key={key} onPress={() => setOpen(open === key ? null : key)} accessibilityRole="button"
      testID={`growth-period-${p.id}`}
      style={{
        paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999,
        borderWidth: 1, borderStyle: p.status === "upcoming" ? "dashed" : "solid",
        borderColor: active ? theme.coral : theme.outline,
        backgroundColor: active ? theme.coral : "transparent",
        opacity: faint ? 0.75 : 1,
      }}>
      <FinalText size={13} style={{ color: active ? "#FFFFFF" : theme.ink }}>
        {p.label}{p.starts_this_week ? copy(" · 本周开始", " · starts") : ""}
      </FinalText>
    </Pressable>;
  };

  const detail = (weekStart: string, periods: GrowthPeriod[]) => {
    const p = periods.find(x => open === `${weekStart}:${x.id}`);
    if (!p) return null;
    return <View style={{ gap: 6, paddingTop: 4 }} testID="growth-period-detail">
      <FinalText size={13} secondary>{statusLabel[p.status]}</FinalText>
      <FinalText size={15} style={{ lineHeight: 22 }}>{p.about}</FinalText>
      {p.confirmed_by.map(c => <FinalText key={c.tag} size={13} secondary style={{ lineHeight: 19 }}>
        {copy("你跟 NURI 说过：", "You told NURI: ")}{c.said}
      </FinalText>)}
    </View>;
  };

  return <SettingsPage testID="growth-calendar">
    <FinalText size={20} style={{ fontWeight: "500" }}>{copy("成长日历", "Growth calendar")}</FinalText>
    <FinalText size={13} secondary style={{ lineHeight: 19 }}>
      {copy("按月龄列出孩子这几周常见的成长阶段。你跟 NURI 聊到的变化会把对应阶段标成「已出现」。每个孩子节奏不同，早几周晚几周都很正常。",
        "Common stages for your child's age, week by week. Changes you mention to NURI mark a stage as happening. Every child has their own pace; weeks earlier or later is normal.")}
    </FinalText>
    {children.length > 1 ? <SettingsChoices>{children.map(c =>
      <SettingsChoice key={c.id} label={c.nickname} selected={c.id === childId} onPress={() => { setOpen(null); void load(c.id); }} testID={`growth-child-${c.id}`} />)}</SettingsChoices> : null}
    {state === "loading" ? <InlineState busy message={copy("正在读取…", "Loading…")} /> : null}
    {state === "error" ? <InlineState message={copy("没能加载。", "Couldn't load.")} action={copy("重试", "Retry")} onPress={() => void load(childId)} /> : null}
    {state === "empty" ? <View style={{ gap: 12 }}>
      <FinalText secondary>{copy("填写孩子的生日后，这里会按周显示成长阶段。", "Add your child's birthday to see stages week by week.")}</FinalText>
      <SettingsButton label={copy("填写孩子信息", "Add child details")} onPress={() => router.push("/child/new")} />
    </View> : null}
    {state === "ready" && calendar ? calendar.weeks.map((w, i) => <View key={w.start} testID={w.is_current ? "growth-week-current" : undefined}
      style={{ gap: 10, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: theme.outline }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
        <FinalText size={15} style={{ fontWeight: w.is_current ? "600" : "400" }}>
          {dateLabel(w.start)} – {dateLabel(w.end)}
        </FinalText>
        <FinalText size={12} secondary>{ageLabel(w.age_months)}</FinalText>
        {w.is_current ? <FinalText size={12} style={{ color: theme.coral, fontWeight: "600" }}>{copy("本周", "This week")}</FinalText> : null}
      </View>
      {(() => {
        // This week shows everything; the others only what changes (a stage
        // starting, coming up, winding down, or a tag running out), so the
        // weeks don't repeat one another.
        const prev = new Map((calendar.weeks[i - 1]?.periods ?? []).map(p => [p.id, p.status]));
        const shown = w.is_current ? w.periods : w.periods.filter(p =>
          p.starts_this_week || p.status === "upcoming" || p.status === "closing" || prev.get(p.id) !== p.status);
        const ongoing = w.periods.filter(p => !shown.includes(p));
        return <>
          {shown.length ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{shown.map(p => pill(w.start, p))}</View> : null}
          {ongoing.length ? <FinalText size={12} secondary>{copy("还在继续：", "Still going: ")}{ongoing.map(p => p.label).join(en ? ", " : "、")}</FinalText> : null}
          {!w.periods.length ? <FinalText size={13} secondary>{copy("这周没有新的阶段。", "Nothing new this week.")}</FinalText> : null}
          {detail(w.start, shown)}
        </>;
      })()}
    </View>) : null}
    {state === "ready" && calendar?.released_tags.length ? <FinalText size={12} secondary style={{ lineHeight: 18 }} testID="growth-released">
      {copy("这些以前提到的情况已经过了对应阶段，不再用来挑推送：", "These earlier notes are past their stage and no longer pick your daily content: ")}
      {calendar.released_tags.map(t => t.label).join(en ? ", " : "、")}
    </FinalText> : null}
  </SettingsPage>;
}
