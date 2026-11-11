import { useCallback, useEffect, useRef } from "react";
import { AccessibilityInfo, ActivityIndicator, Keyboard, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { api, auth, isAuthError } from "@/src/api";
import { useAccountScope, useAccountState as useState } from "@/src/useAccountState";
import { ExpiredSessionRecoveryNotice, useExpiredSessionRecovery } from "@/src/authExpiredRecovery";
import { registerNativeNavigationGuard } from "@/src/components/nativeNavigation";
import ConfirmDialog from "@/src/components/ConfirmDialog";
import { NuriButton, NuriIcon, NuriKeyboardFrame, NuriText } from "@/src/uiux48/Primitives";
import { useNuriTheme } from "@/src/uiux48/Theme";
import { useT, translate } from "@/src/i18n";
import { childDraftsFromServer, childFingerprint, ChildSaveError, deleteOnboardingChild, newChildSaveProgress, onboardingChildCopy, persistOnboardingChildren, refreshOnboardingChildren, removeOnboardingDraft, validChildDraft, type ChildDraft, type ChildSaveProgress } from "@/src/onboardingChildren";
import { appendChildDraft, blankChildDraft, cloneChildDraft, committableChildDrafts, isBlankChildDraft } from "@/src/simplifiedOnboarding";
import { readParentGender, saveParentGender } from "@/src/onboardingParentGender";
import { ChildProfileCard, ParentProfileCard, OnboardingPrompt, ChildReviewCard, type ParentDraft } from "@/src/uiuxfinal/OnboardingForm";
import { OnboardingKeyboardFooter, useOnboardingKeyboardVisible } from "@/src/uiuxfinal/OnboardingKeyboardFooter";

type SetupError = "" | "load" | "delete" | "unconfirmed" | "save" | "invalid-edit" | "parent-name" | "incomplete-children";

/** Replaces the retired topic/preferences tour. Navigation and editing are
 * local; only final Confirm completes setup through the real guarded API. */
export default function Onboarding() {
  const { capture, current } = useAccountScope();
  const { t, locale } = useT();
  const keyboardVisible = useOnboardingKeyboardVisible();
  const theme = useNuriTheme(), copy = onboardingChildCopy(locale), router = useRouter();
  const cn = (text: string, en: string, vars?: Record<string, string | number>) => translate(locale, locale === "en" ? en : text, vars);
  const recovery = useExpiredSessionRecovery(() => router.replace("/login")), recover = recovery.recover;
  const [page, setPage] = useState<0 | 1 | 2>(0);
  const [parent, setParent] = useState<ParentDraft>({ nickname: "", city: "", gender: "hidden" });
  const [parentCommitted, setParentCommitted] = useState<ParentDraft | null>(null);
  const [rows, setRows] = useState<ChildDraft[]>([]), [review, setReview] = useState<ChildDraft[]>([]);
  const [expecting, setExpecting] = useState(false), [editing, setEditing] = useState<ChildDraft | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ChildDraft | null>(null);
  const [loaded, setLoaded] = useState(false), [saving, setSaving] = useState(false), [reload, setReload] = useState(0);
  const [error, setError] = useState<SetupError>(""), [reducedMotion, setReducedMotion] = useState(false), [scrollRevision, setScrollRevision] = useState(0);
  // Keep semantic errors, not translated snapshots: an already-visible error
  // follows a device/app language change without reloading or losing drafts.
  const errorMessage = error === "load" ? cn("家庭资料加载失败，请检查网络并刷新后重试。", "Family details could not be loaded. Check your connection and retry.")
    : error === "delete" ? copy.deleteFailed : error === "unconfirmed" ? copy.unconfirmed
    : error === "save" ? cn("保存失败，这次资料尚未完整写入。请检查网络后重试。", "Setup was not fully saved. Check your connection and retry.")
    : error === "invalid-edit" ? cn("请填写昵称并选择有效日期。", "Enter a nickname and choose a valid date.")
    : error === "parent-name" ? cn("请填写称呼，或跳过此步骤。", "Enter your name, or skip this step.")
    : error === "incomplete-children" ? cn("请补全孩子昵称和有效日期，或移除未填写的卡片。", "Complete each child's nickname and date, or remove the incomplete card.") : "";
  const initialParent = useRef<{ ticket: number; userId: string; value: ParentDraft } | null>(null);
  const progress = useRef<{ ticket: number; value: ChildSaveProgress } | null>(null);
  const action = useRef(false), sequence = useRef(0), scroll = useRef<ScrollView>(null);
  const positions = useRef(new Map<string, number>()), offsets = useRef({ born: 0, unborn: 0 });
  const pendingScroll = useRef<{ ticket: number; key: string; expecting: boolean } | null>(null);
  const frame = useRef<ReturnType<typeof requestAnimationFrame> | null>(null);
  const newKey = () => `setup-${capture()}-${++sequence.current}`;
  const available = () => capture() !== null && loaded && !action.current;

  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(value => { if (active) setReducedMotion(value); });
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReducedMotion);
    return () => { active = false; subscription.remove(); if (frame.current !== null) cancelAnimationFrame(frame.current); };
  }, [setReducedMotion]);
  useEffect(() => {
    const ticket = capture(); if (ticket === null) return;
    let cancelled = false; setLoaded(false); setError("");
    (async () => {
      const token = await auth.getToken();
      const owns = async () => !cancelled && current(ticket) && await auth.getToken() === token && current(ticket);
      try {
        if (!token || !await owns()) return;
        const [me, children] = await Promise.all([api.me(), api.listChildren()]);
        if (!await owns()) return;
        if (!me || typeof me.id !== "string" || !me.id) throw new Error("Missing account identity");
        const gender = await readParentGender(me.id, owns); if (!await owns()) return;
        const value: ParentDraft = { nickname: me.nickname || "", city: me.city || "", gender };
        initialParent.current = { ticket, userId: me.id, value };
        const drafts = childDraftsFromServer(children), saved = newChildSaveProgress();
        for (const child of drafts) saved.confirmed.set(child.key, { id: child.id!, fingerprint: childFingerprint(child) });
        progress.current = { ticket, value: saved };
        setParent(value); setParentCommitted(null); setReview(drafts.map(cloneChildDraft));
        setRows(drafts.length ? drafts : [blankChildDraft(newKey(), false)]);
        setPage(0); setExpecting(false); setEditing(null);
        pendingScroll.current = null; positions.current.clear(); offsets.current = { born: 0, unborn: 0 }; setLoaded(true);
      } catch (failure) {
        if (cancelled || !current(ticket)) return;
        if (isAuthError(failure)) { await recover(failure, token); return; }
        setError("load");
      }
    })();
    return () => { cancelled = true; };
  // Typing or a system-language update must not reload account data, erase
  // in-progress child cards, or remount fields. Errors localize at render time.
  }, [reload, capture, current, recover]);

  const back = useCallback(() => {
    if (capture() === null || action.current) return;
    Keyboard.dismiss();
    if (confirmDelete) setConfirmDelete(null);
    else if (editing) { setEditing(null); setError(""); }
    else if (page > 0) { setPage(page === 2 ? 1 : 0); setError(""); }
    else router.replace("/welcome");
  }, [capture, confirmDelete, editing, page, router, setConfirmDelete, setEditing, setPage, setError]);
  useFocusEffect(useCallback(() => registerNativeNavigationGuard("/onboarding", navigation => { if (navigation === "back") back(); }), [back]));
  // Wait for actual new-card layout. Fixed footer is a separate flex sibling;
  // full circle and its shadow remain inside the padded scroll viewport.
  const revealPending = () => {
    const pending = pendingScroll.current;
    if (!pending || !current(pending.ticket) || page !== 1 || pending.expecting !== expecting) return;
    const y = positions.current.get(pending.key); if (y === undefined) return;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (pendingScroll.current !== pending || !current(pending.ticket)) return;
      scroll.current?.scrollTo({ y: Math.max(0, y - 8), animated: !reducedMotion }); pendingScroll.current = null;
    });
  };
  useEffect(() => { revealPending(); }, [scrollRevision, page, expecting, reducedMotion]);
  const changeCategory = (value: boolean) => {
    if (!available() || value === expecting) return;
    Keyboard.dismiss(); pendingScroll.current = null; setExpecting(value);
    if (!rows.some(row => row.expecting === value)) setRows(old => appendChildDraft(old, newKey(), value));
    requestAnimationFrame(() => scroll.current?.scrollTo({ y: value ? offsets.current.unborn : offsets.current.born, animated: false }));
  };
  const add = () => {
    const ticket = capture(); if (ticket === null || !available()) return;
    Keyboard.dismiss(); const key = newKey(); pendingScroll.current = { ticket, key, expecting };
    setRows(old => appendChildDraft(old, key, expecting)); setScrollRevision(value => value + 1);
  };
  const update = (row: ChildDraft) => {
    if (!available()) return;
    if (editing?.key === row.key) setEditing(row); else setRows(old => old.map(previous => previous.key === row.key ? row : previous));
  };
  const remove = (row: ChildDraft) => {
    if (!available()) return;
    if (row.id) { setConfirmDelete(row); return; }
    const ticket = capture(); if (progress.current?.ticket === ticket) removeOnboardingDraft(row.key, progress.current.value);
    setRows(old => old.filter(item => item.key !== row.key)); setReview(old => old.filter(item => item.key !== row.key));
    if (editing?.key === row.key) setEditing(null);
  };
  const deleteSaved = async () => {
    const child = confirmDelete, ticket = capture();
    if (!child?.id || ticket === null || !available() || progress.current?.ticket !== ticket) return;
    setConfirmDelete(null); action.current = true; setSaving(true); setError(""); const token = await auth.getToken();
    try {
      await deleteOnboardingChild(child.id, { api, progress: progress.current.value,
        owns: async () => current(ticket) && await auth.getToken() === token && current(ticket), onConfirmed: () => {} });
      if (!current(ticket)) return;
      setRows(old => old.filter(item => item.id !== child.id)); setReview(old => old.filter(item => item.id !== child.id));
      if (editing?.id === child.id) setEditing(null);
    } catch (failure) { if (current(ticket)) { if (isAuthError(failure)) await recover(failure, token); else setError("delete"); } }
    finally { action.current = false; if (current(ticket)) setSaving(false); }
  };
  const reconcile = async () => {
    const ticket = capture(); if (ticket === null || !available() || progress.current?.ticket !== ticket) return;
    action.current = true; setSaving(true); const token = await auth.getToken();
    try {
      const recovered = await refreshOnboardingChildren(page === 1 ? rows : review, { api, progress: progress.current.value,
        owns: async () => current(ticket) && await auth.getToken() === token && current(ticket), onConfirmed: () => {} });
      if (!current(ticket)) return;
      if (page !== 1) setReview(recovered);
      setRows(recovered.map(cloneChildDraft)); setEditing(null); setError(progress.current.value.pending ? "unconfirmed" : "");
    } catch (failure) { if (current(ticket)) { if (isAuthError(failure)) await recover(failure, token); else setError("unconfirmed"); } }
    finally { action.current = false; if (current(ticket)) setSaving(false); }
  };
  const finish = async () => {
    const ticket = capture(), original = initialParent.current;
    if (ticket === null || !available() || original?.ticket !== ticket || editing) return;
    action.current = true; setSaving(true); setError(""); const token = await auth.getToken();
    const owns = async () => current(ticket) && await auth.getToken() === token && current(ticket);
    try {
      if (!token || !await owns()) return;
      if (progress.current?.ticket !== ticket) throw new ChildSaveError("stale");
      await persistOnboardingChildren(review, { api, progress: progress.current.value, owns,
        onConfirmed: (key, id) => { setReview(old => old.map(row => row.key === key ? { ...row, id } : row)); setRows(old => old.map(row => row.key === key ? { ...row, id } : row)); } });
      if (!await owns()) return;
      if (parentCommitted && parentCommitted.gender !== original.value.gender) await saveParentGender(original.userId, parentCommitted.gender, owns);
      if (!await owns()) return;
      // Retired role/topic preferences are preserved. Gender is local and is
      // deliberately never inferred as a parenting role.
      const profile: any = await api.updateMe({ ...(parentCommitted ? { nickname: parentCommitted.nickname.trim(), city: parentCommitted.city.trim() } : {}), onboarding_completed: true });
      if (!await owns()) return;
      if (profile?.onboarding_completed !== true) throw new Error("Completion unconfirmed");
      if (!await auth.setOnboarded(true, { expectedToken: token, expectedGeneration: ticket })) throw new Error("Local completion unconfirmed");
      if (await owns()) router.replace("/(tabs)");
    } catch (failure) {
      if (!current(ticket)) return;
      if (isAuthError(failure)) await recover(failure, token);
      else setError(failure instanceof ChildSaveError && failure.code === "unconfirmed" ? "unconfirmed" : "save");
    } finally { action.current = false; if (current(ticket)) setSaving(false); }
  };
  const next = () => {
    if (!available()) return;
    Keyboard.dismiss(); setError("");
    if (editing) {
      if (!validChildDraft(editing)) { setError("invalid-edit"); return; }
      setReview(old => old.map(row => row.key === editing.key ? cloneChildDraft(editing) : row));
      setRows(old => old.map(row => row.key === editing.key ? cloneChildDraft(editing) : row)); setEditing(null); return;
    }
    if (page === 0) {
      if (!parent.nickname.trim()) { setError("parent-name"); return; }
      setParentCommitted({ ...parent }); setPage(1); return;
    }
    if (page === 1) {
      try { setReview(committableChildDrafts(rows)); setPage(2); }
      catch {
        setError("incomplete-children");
        const invalid = rows.find(row => !isBlankChildDraft(row) && !validChildDraft(row)), ticket = capture();
        if (invalid && ticket !== null) { setExpecting(invalid.expecting); pendingScroll.current = { ticket, key: invalid.key, expecting: invalid.expecting }; setScrollRevision(value => value + 1); }
      }
    } else void finish();
  };
  const skip = () => {
    if (!available()) return;
    Keyboard.dismiss(); setError("");
    if (editing) { setEditing(null); return; }
    if (page === 0) { const original = initialParent.current; if (original?.ticket === capture()) setParent({ ...original.value }); setParentCommitted(null); setPage(1); }
    else if (page === 1) { setRows(review.map(cloneChildDraft)); setPage(2); }
    else void finish();
  };

  if (recovery.blocked) return <ExpiredSessionRecoveryNotice pending={recovery.pending} onRetry={recover} />;
  return <View style={styles.screen} testID="simplified-onboarding"><NuriKeyboardFrame><View style={styles.screen} testID="onboarding-keyboard-body">
    <View style={styles.navigation}>
      <Pressable accessibilityRole="button" accessibilityLabel={t("返回")} onPress={back} disabled={saving} style={styles.hit} testID="onboarding-back"><NuriIcon name="back" size={20} /></Pressable>
      <View style={styles.progress} accessibilityLabel={cn("步骤 {step}，共 2 步", "Step {step} of 2", { step: page === 0 ? 1 : 2 })}>{[0, 1].map(step => <View key={step} style={[styles.segment, { backgroundColor: (page === 0 ? 0 : 1) === step ? "#BA94AC" : "#E1DAE2" }]} />)}</View>
      <Pressable accessibilityRole="button" accessibilityLabel={cn("跳过当前步骤", "Skip this step")} disabled={!loaded || saving} onPress={skip} style={styles.hit} testID="onboarding-skip"><NuriText role="Caption" secondary>{t("跳过")}</NuriText></Pressable>
    </View>
    <OnboardingPrompt label={page === 0 ? cn("创建你的档案", "Your profile") : page === 1 ? cn("创建孩子档案", "Child profiles") : cn("确认孩子资料", "Review profiles")} />
    {page === 1 ? <View style={styles.tabs}><View style={[styles.tabTrack, { backgroundColor: theme.composer, borderColor: theme.outline }]}>{[false, true].map(value => <Pressable key={String(value)} accessibilityRole="tab" accessibilityState={{ selected: expecting === value }} disabled={!loaded || saving} onPress={() => changeCategory(value)} testID={value ? "onboarding-expecting" : "onboarding-born"} style={[styles.tab, { backgroundColor: expecting === value ? "#C1A0DD" : "transparent" }]}><NuriText style={{ color: expecting === value ? "white" : theme.ink }}>{value ? cn("未出生", "Expecting") : cn("已出生", "Born")}</NuriText></Pressable>)}</View></View> : null}
    <ScrollView key={page} ref={scroll} style={styles.viewport} contentContainerStyle={styles.content} removeClippedSubviews={false} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" scrollEventThrottle={32} showsVerticalScrollIndicator={false} testID="onboarding-scroll"
      onScroll={event => { if (page === 1) offsets.current[expecting ? "unborn" : "born"] = event.nativeEvent.contentOffset.y; }} onContentSizeChange={revealPending}>
      {error ? <View accessibilityLiveRegion="polite" testID="onboarding-error" style={styles.error}><NuriText role="Caption" style={{ color: "#A25563" }}>{errorMessage}</NuriText>{loaded ? <NuriButton secondary label={copy.refresh} disabled={saving} onPress={() => void reconcile()} testID="onboarding-reconcile-children" /> : <NuriButton secondary label={copy.reload} onPress={() => { if (capture() !== null) setReload(value => value + 1); }} testID="onboarding-reload" />}</View> : null}
      {!loaded ? <ActivityIndicator testID="onboarding-loading" color={theme.ink} /> : page === 0 ? <ParentProfileCard value={parent} onChange={setParent} disabled={saving} /> : page === 1 ? <>
        {rows.filter(row => row.expecting === expecting).map((row, index) => <View key={row.key} onLayout={event => { positions.current.set(row.key, event.nativeEvent.layout.y); revealPending(); }}><ChildProfileCard row={row} ordinal={index + 1} disabled={saving} onChange={update} onRemove={() => remove(row)} /></View>)}
        <View style={styles.addClearance} testID="onboarding-add-clearance"><Pressable accessibilityRole="button" accessibilityLabel={expecting ? cn("添加未出生孩子", "Add an expected child") : cn("添加已出生孩子", "Add a born child")} disabled={saving} onPress={add} style={[styles.add, { backgroundColor: theme.night ? "#44384F" : "#FEFBF6" }]} testID="onboarding-add-another"><NuriIcon name="plus" size={20} /></Pressable></View>
      </> : <View style={{ gap: 16 }} testID="onboarding-review">
        {review.length === 0 ? <NuriText secondary role="Caption" testID="onboarding-empty-review">{cn("暂未添加孩子，之后可在设置中补充。", "No children added yet. You can add them later in Settings.")}</NuriText> : review.map((row, index) => editing?.key === row.key ? <ChildProfileCard key={row.key} row={editing} ordinal={index + 1} disabled={saving} onChange={update} onRemove={() => remove(row)} /> : <ChildReviewCard key={row.key} row={row} disabled={saving} onEdit={() => { if (available()) { setEditing(cloneChildDraft(row)); setError(""); } }} />)}
      </View>}
    </ScrollView>
  </View></NuriKeyboardFrame>
    <OnboardingKeyboardFooter hidden={keyboardVisible}><View style={styles.footer} testID="onboarding-fixed-footer"><NuriButton label={saving ? t("保存中...") : editing ? cn("保存", "Save") : page === 2 ? cn("确认", "Confirm") : t("继续")} disabled={!loaded || saving || keyboardVisible} busy={saving} onPress={next} style={{ width: 200 }} testID="onboarding-next-btn" /></View></OnboardingKeyboardFooter>
    <ConfirmDialog visible={!!confirmDelete} title={copy.deleteTitle} message={copy.deleteBody} confirmText={copy.deleteConfirm} danger onConfirm={() => void deleteSaved()} onCancel={() => setConfirmDelete(null)} />
  </View>;
}
const styles = StyleSheet.create({
  screen: { flex: 1, minHeight: 0 }, navigation: { height: 52, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 16 }, hit: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  progress: { flex: 1, flexDirection: "row", gap: 8 }, segment: { flex: 1, height: 4, borderRadius: 2 },
  tabs: { paddingHorizontal: 24, paddingTop: 12, paddingBottom: 12, alignItems: "center" }, tabTrack: { width: 276, maxWidth: "100%", minHeight: 48, flexDirection: "row", gap: 4, padding: 3, borderRadius: 24, borderWidth: 1 }, tab: { flex: 1, minHeight: 40, alignItems: "center", justifyContent: "center", borderRadius: 20 },
  viewport: { flex: 1, minHeight: 0 }, content: { paddingHorizontal: 24, paddingTop: 12, paddingBottom: 64, gap: 16 },
  addClearance: { alignItems: "center", paddingTop: 4, paddingBottom: 12, overflow: "visible", zIndex: 1 }, add: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", boxShadow: "0px 0px 5px rgba(0,0,0,.25)", elevation: 4, zIndex: 2 },
  footer: { paddingHorizontal: 24, paddingTop: 16, paddingBottom: 8, alignItems: "center", flexShrink: 0, zIndex: 0 }, error: { gap: 12, padding: 12, borderRadius: 16, backgroundColor: "rgba(255,245,243,.9)" },
});
