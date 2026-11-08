import { useEffect, useMemo, useRef, useState } from "react";
import { AccessibilityInfo, AppState, Platform, ScrollView, StyleSheet, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { NuriText } from "@/src/uiux48/Primitives";
import { useNuriTheme } from "@/src/uiux48/Theme";
import { useT, translate } from "@/src/i18n";
import type { ChildDraft } from "@/src/onboardingChildren";
import { defaultInlineDate, displayInlineDateDraft, inlineDateDraft, inlineDateOptions, inlineDateValue, selectInlineDatePart, usesInlineDateDefault, type InlineDatePart } from "@/src/onboardingInlineDate";
import { localDateOnly } from "@/src/child-age";

const ROW_HEIGHT = 34;
const WINDOW_RADIUS = 4;
const SETTLE_DELAY = 140;
type ScrollEvent = NativeSyntheticEvent<NativeScrollEvent>;

type InlineDateWheelProps = {
  part: InlineDatePart;
  label: string;
  values: number[];
  value: number;
  onSelect: (value: number) => void;
  disabled: boolean;
  reducedMotion: boolean;
  testID: string;
};

/** A bounded, non-VirtualizedList wheel can live inside the form's ScrollView.
 * Only a small absolute-positioned window is mounted, even for year 0001. */
export function InlineDateWheel({ part, label, values, value, onSelect, disabled, reducedMotion, testID }: InlineDateWheelProps) {
  const theme = useNuriTheme(), { locale } = useT();
  const entries = values;
  const selected = Math.max(0, entries.indexOf(Math.max(entries[0], Math.min(entries[entries.length - 1], value))));
  const selectedValue = entries[selected];
  const [window, setWindow] = useState({ entries, value, index: selected });
  // A dependency clamp is reflected in this render, not an effect one frame
  // later. The previous year's/month's viewport is never flashed in between.
  const center = window.entries === entries && window.value === value ? window.index : selected;
  const setCenter = (index: number) => setWindow({ entries, value, index });
  const scroll = useRef<ScrollView>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A pending gesture owns THIS render's callback. Never forward an old
  // account's timer/event to a new account through a latest-callback ref.
  const lifetime = useMemo(() => ({ active: true }), [entries, value, onSelect, disabled]);
  const userIntent = useRef<typeof lifetime | null>(null);
  const clearTimer = () => { if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; } };
  const indexAt = (offset: number) => Math.max(0, Math.min(entries.length - 1, Math.round(offset / ROW_HEIGHT)));
  const settle = (offset: number) => {
    if (!lifetime.active || disabled || !Number.isFinite(offset)) return;
    clearTimer();
    const index = indexAt(offset);
    setCenter(index);
    userIntent.current = null;
    if (Math.abs(offset - index * ROW_HEIGHT) > .5) scroll.current?.scrollTo({ y: index * ROW_HEIGHT, animated: !reducedMotion });
    if (entries[index] !== value) onSelect(entries[index]);
  };
  const schedule = (offset: number) => {
    if (!lifetime.active || disabled) return;
    clearTimer();
    timer.current = setTimeout(() => { timer.current = null; settle(offset); }, SETTLE_DELAY);
  };
  useEffect(() => {
    lifetime.active = true;
    return () => { lifetime.active = false; clearTimer(); if (userIntent.current === lifetime) userIntent.current = null; };
  }, [lifetime]);
  useEffect(() => {
    clearTimer(); userIntent.current = null;
    scroll.current?.scrollTo({ y: selected * ROW_HEIGHT, animated: false });
  }, [lifetime, selected]);
  const visible = Array.from({ length: Math.min(entries.length - Math.max(0, center - WINDOW_RADIUS), WINDOW_RADIUS * 2 + 1) }, (_, offset) => Math.max(0, center - WINDOW_RADIUS) + offset);
  const format = (option: number) => String(option).padStart(part === "year" ? 4 : 2, "0");
  const fontFamily = locale === "zh-CN" ? "NotoSansSC_400Regular" : undefined;
  const armWebInput = () => { if (lifetime.active && !disabled) userIntent.current = lifetime; };
  // RN Web emits onScroll (including a final tick), but no drag/momentum
  // events for a mouse wheel. Arm only from real input: initial/prop-sync
  // scrollTo events must never turn a placeholder into an invented date.
  const webInput = Platform.OS === "web" ? {
    onWheel: (event?: { stopPropagation?: () => void }) => { armWebInput(); event?.stopPropagation?.(); },
    onKeyDown: (event: { key: string }) => { if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) armWebInput(); },
  } : {};
  return <View style={styles.column}>
    <Text accessible={false} style={[styles.label, { color: theme.secondary, fontFamily }]}>{label}</Text>
    <ScrollView {...webInput} ref={scroll} testID={testID} style={styles.wheel} contentOffset={{ x: 0, y: selected * ROW_HEIGHT }}
      scrollEnabled={!disabled} nestedScrollEnabled directionalLockEnabled bounces={false} overScrollMode="never"
      snapToInterval={ROW_HEIGHT} snapToAlignment="start" decelerationRate="fast" scrollEventThrottle={16}
      showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
      automaticallyAdjustContentInsets={false} contentInsetAdjustmentBehavior="never"
      accessible accessibilityRole="adjustable" accessibilityLabel={label} accessibilityState={{ disabled }}
      accessibilityValue={{ text: format(selectedValue) }}
      accessibilityActions={disabled ? [] : [{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={event => {
        if (!lifetime.active || disabled) return;
        const direction = event.nativeEvent.actionName === "increment" ? 1 : event.nativeEvent.actionName === "decrement" ? -1 : 0;
        if (!direction) return;
        clearTimer(); userIntent.current = null; const index = Math.max(0, Math.min(entries.length - 1, selected + direction));
        setCenter(index); scroll.current?.scrollTo({ y: index * ROW_HEIGHT, animated: !reducedMotion });
        if (entries[index] !== value) onSelect(entries[index]);
      }}
      onScrollBeginDrag={() => { if (lifetime.active && !disabled) { clearTimer(); userIntent.current = lifetime; } }}
      onTouchMove={() => { if (Platform.OS === "web") armWebInput(); }}
      onScroll={(event: ScrollEvent) => {
        if (!lifetime.active || disabled) return;
        const offset = event.nativeEvent.contentOffset.y; if (!Number.isFinite(offset)) return;
        setCenter(indexAt(offset));
        // Web/no-momentum releases may continue emitting scroll events. Keep
        // their short-stop timer behind the latest physical position only.
        if (timer.current !== null || Platform.OS === "web" && userIntent.current === lifetime) schedule(offset);
      }}
      onScrollEndDrag={(event: ScrollEvent) => schedule(event.nativeEvent.contentOffset.y)}
      onMomentumScrollBegin={() => { if (lifetime.active && !disabled) clearTimer(); }}
      onMomentumScrollEnd={(event: ScrollEvent) => settle(event.nativeEvent.contentOffset.y)}>
      <View pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ height: (entries.length + 2) * ROW_HEIGHT }}>
        {visible.map(index => <View key={entries[index]} testID={`${testID}-option-${entries[index]}`} style={[styles.row, { top: (index + 1) * ROW_HEIGHT }]}>
          {index === center ? <NuriText accessible={false} role="H1" numberOfLines={1}>{format(entries[index])}</NuriText> : <Text accessible={false} numberOfLines={1} style={[styles.neighbor, { color: theme.ink, fontFamily }]}>{format(entries[index])}</Text>}
        </View>)}
      </View>
    </ScrollView>
  </View>;
}

/** Inline only: selecting wheels changes local draft columns, never API state.
 * A partially selected date survives category/card reuse without inventing it. */
export function InlineChildDate({ row, onChange, disabled }: { row: ChildDraft; onChange: (row: ChildDraft) => void; disabled: boolean }) {
  const theme = useNuriTheme(), { locale } = useT();
  const [reducedMotion, setReducedMotion] = useState(false);
  const [today, setToday] = useState(localDateOnly);
  const mounted = useRef(true);
  const defaultDate = usesInlineDateDefault(row);
  const source = row.date_parts ?? inlineDateDraft(row.birth_date);
  const draft = defaultDate ? defaultInlineDate(row.expecting, today) : displayInlineDateDraft(source, row.expecting, today);
  const sourceValue = inlineDateValue(source, row.expecting, today);
  const needsRepair = !defaultDate && (sourceValue === null || sourceValue !== row.birth_date);
  const options = useMemo(() => inlineDateOptions(draft, row.expecting, today), [draft.year, draft.month, draft.day, row.expecting, today]);
  useEffect(() => {
    mounted.current = true;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = () => {
      if (!mounted.current) return;
      const value = localDateOnly();
      setToday(previous => previous.year === value.year && previous.month === value.month && previous.day === value.day ? previous : value);
    };
    const schedule = () => {
      clearTimeout(timer);
      const now = new Date();
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      timer = setTimeout(() => { refresh(); schedule(); }, Math.max(1, midnight.getTime() - now.getTime()));
    };
    schedule();
    const subscription = AppState?.addEventListener?.("change", state => { if (state === "active" && mounted.current) { refresh(); schedule(); } });
    return () => { mounted.current = false; clearTimeout(timer); subscription?.remove(); };
  }, []);
  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(value => { if (active) setReducedMotion(value); }).catch(() => {});
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", value => { if (active) setReducedMotion(value); });
    return () => { active = false; subscription.remove(); };
  }, []);
  const choose = (part: InlineDatePart, value: number) => {
    if (disabled || !mounted.current) return;
    let next;
    try { next = selectInlineDatePart(draft, part, value, row.expecting, today); }
    catch (failure) { if (failure instanceof RangeError) return; throw failure; }
    const updated = { ...row, date_parts: next, birth_date: inlineDateValue(next, row.expecting, today) ?? "" };
    delete updated.date_default;
    onChange(updated);
  };
  const copy = (cn: string, en: string) => locale === "en" ? en : translate(locale, cn);
  return <View testID={`onboarding-inline-date-${row.key}`} style={[styles.frame, { borderColor: theme.outline, opacity: disabled ? .5 : 1 }]}>
    {defaultDate ? <View testID="onboarding-date-default" accessible={false} pointerEvents="none" style={{ width: 0, height: 0 }} /> : null}
    {needsRepair ? <NuriText testID={`onboarding-date-needs-confirmation-${row.key}`} role="Caption" style={styles.repair}>{locale === "en" ? "Scroll to confirm this incomplete date" : locale === "zh-TW" ? "請捲動確認未完整的日期" : "请滚动确认未完整的日期"}</NuriText> : null}
    <View pointerEvents="none" style={styles.highlight} />
    <View style={styles.columns}>
      {(["year", "month", "day"] as const).map(part => <InlineDateWheel key={part} part={part} label={part === "year" ? copy("年", "Year") : part === "month" ? copy("月", "Month") : copy("日", "Day")}
        values={part === "year" ? options.years : part === "month" ? options.months : options.days} value={draft[part]}
        onSelect={value => choose(part, value)} disabled={disabled} reducedMotion={reducedMotion} testID={`onboarding-wheel-${row.key}-${part}`} />)}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  frame: { position: "relative", height: 124, borderWidth: 1, borderRadius: 18, overflow: "hidden" },
  highlight: { position: "absolute", left: 7, right: 7, top: 55, height: 34, borderRadius: 10, backgroundColor: "rgba(193,160,221,.16)" },
  columns: { position: "absolute", left: 7, right: 7, top: 3, height: 120, flexDirection: "row" },
  column: { flex: 1, minWidth: 0 }, label: { height: 18, fontSize: 12, lineHeight: 18, fontWeight: "400", textAlign: "center" },
  wheel: { height: 102, flexGrow: 0 }, row: { position: "absolute", left: 0, right: 0, height: ROW_HEIGHT, alignItems: "center", justifyContent: "center" },
  neighbor: { fontSize: 14, lineHeight: 20, fontWeight: "400", opacity: .62, textAlign: "center" },
  repair: { position: "absolute", left: 0, right: 0, bottom: 0, textAlign: "center", fontSize: 9, lineHeight: 11, zIndex: 1, backgroundColor: "#FFFAF5" },
});
