import { useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Linking, Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { aiConsent } from "@/src/api";
import { AI_CONSENT_VERSION, AI_PRIVACY_URL, AI_PROVIDER_DATA_URL } from "@/src/aiConsent";
import { aiConsentCopy } from "@/src/aiConsentCopy";
import { initialAIChoiceAcknowledgement, InitialAIChoiceController, shouldShowInitialAIChoice, type InitialAIChoice, type InitialAIChoiceAcknowledgement } from "@/src/initialAIChoice";
import { useAIConsent } from "@/src/useAIConsent";
import { storage } from "@/src/utils/storage";
import { useT, translate } from "@/src/i18n";
import { NuriButton, NuriText } from "@/src/uiux48/Primitives";

/** One startup sheet above the navigator. The navigator stays mounted through
 * sign-in and permission changes; typing cannot remount a page or lose history. */
export function AIConsentStartupGate({ children }: { children: ReactNode }) {
  const { locale } = useT();
  const copy = aiConsentCopy(locale);
  const { state } = useAIConsent();
  const [controller] = useState(() => { aiConsent.setStartupHold(true); return new InitialAIChoiceController(storage); });
  const [loaded, setLoaded] = useState(false);
  const [record, setRecord] = useState<InitialAIChoice | null>(null);
  const [busy, setBusy] = useState(false);
  const [promptBusy, setPromptBusy] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadRetry, setLoadRetry] = useState(0);
  const [error, setError] = useState("");
  const errorOwner = useRef<{ userId: string | null; session: number; version: string } | null>(null);
  const acknowledged = useRef<InitialAIChoiceAcknowledgement | null>(initialAIChoiceAcknowledgement(state));
  const receipt = controller.getAcknowledgement();
  const verified = initialAIChoiceAcknowledgement(state)
    ?? (receipt?.userId === state.userId && receipt.version === state.version ? receipt : null);
  if (verified) acknowledged.current = verified;
  else if (state.version !== acknowledged.current?.version || state.userId && state.userId !== acknowledged.current?.userId) acknowledged.current = null;
  const currentError = error && errorOwner.current?.userId === state.userId && errorOwner.current?.session === state.session
    && errorOwner.current?.version === state.version ? error : "";
  const active = useRef(true);
  const inFlight = useRef(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    active.current = true;
    let cancelled = false;
    void controller.load().then(value => { if (active.current && !cancelled) { setRecord(value); setLoaded(true); setLoadFailed(false); } })
      .catch(() => { if (active.current && !cancelled) { setLoadFailed(true); } });
    return () => { cancelled = true; active.current = false; };
  }, [controller, loadRetry]);

  useEffect(() => {
    if (!loaded || currentError || inFlight.current || !state.userId || state.version !== AI_CONSENT_VERSION
        || !["allowed", "not_allowed"].includes(state.status) || record?.phase !== "pending") return;
    // Existing account consent already has its own durable account/version row.
    // Do not migrate it through a startup-sheet busy state on each mount.
    inFlight.current = true;
    const expected = state;
    setBusy(true); setError("");
    void (async () => {
      try {
        const claimed = await controller.claimPending(expected.userId!);
        if (!active.current || !claimed) return;
        setRecord(claimed);
        const applied = await aiConsent.setAllowed(claimed.allowed, expected);
        const live = aiConsent.getState();
        if (!applied && live.session === expected.session && live.userId === expected.userId) { errorOwner.current = expected; setError(copy.changed); }
      } catch {
        const live = aiConsent.getState();
        if (active.current && live.session === expected.session && live.userId === expected.userId) { errorOwner.current = expected; setError(copy.storageError); }
      } finally {
        inFlight.current = false;
        if (active.current) { setRecord(controller.getState()); setBusy(false); setRetry(value => value + 1); }
      }
    })();
  }, [loaded, record, state.status, state.userId, state.session, state.version, controller, retry, currentError]);

  const choose = async (allowed: boolean) => {
    if (inFlight.current || !active.current) return;
    inFlight.current = true;
    const expected = state;
    const liveAtClick = aiConsent.getState();
    if (liveAtClick.session !== expected.session || liveAtClick.userId !== expected.userId || liveAtClick.version !== expected.version
        || expected.version !== AI_CONSENT_VERSION) { inFlight.current = false; return; }
    // A queued tap from a sheet which has since disappeared is not a fresh
    // choice. In particular it cannot undo withdrawal or become anonymous
    // intent while identity/permission is being refreshed.
    if (!shouldShowInitialAIChoice(loaded, controller.getState(), liveAtClick, acknowledged.current) && !currentError) {
      inFlight.current = false; return;
    }
    // A refresh can publish loading with a verified A owner. Never turn that
    // known-account click into an anonymous intent for some later B login.
    const owner = expected.userId;
    aiConsent.setStartupHold(true);
    errorOwner.current = expected;
    setBusy(true); setPromptBusy(true); setError("");
    try {
      const saved = await controller.choose(allowed, owner);
      if (!active.current) return;
      setRecord(saved);
      if (owner) {
        const applied = await aiConsent.setAllowed(allowed, expected);
        const live = aiConsent.getState();
        if (!applied && live.userId === owner && live.session === expected.session) setError(copy.changed);
      }
    } catch {
      const live = aiConsent.getState();
      if (active.current && (!owner || live.userId === owner && live.session === expected.session)) setError(copy.storageError);
    } finally {
      inFlight.current = false;
      if (active.current) { setRecord(controller.getState()); setBusy(false); setPromptBusy(false); setRetry(value => value + 1); }
    }
  };
  // Hydration/loading is unknown, NOT a new request for permission. Keep the
  // navigator in place and let the unchanged account-scoped API verify every
  // request. Only a verified, genuinely unasked owner gets the consent sheet.
  const visible = shouldShowInitialAIChoice(loaded, record, state, acknowledged.current) || promptBusy && errorOwner.current?.session === state.session
    && errorOwner.current?.userId === state.userId && errorOwner.current?.version === state.version || !!currentError;
  const held = !loaded || loadFailed || busy || visible || record?.phase === "pending" || state.version !== AI_CONSENT_VERSION;
  useEffect(() => { aiConsent.setStartupHold(held); }, [held]);
  const openLink = (url: string) => {
    const expected = state;
    void Linking.openURL(url).catch(() => {
      const live = aiConsent.getState();
      if (active.current && live.session === expected.session && live.userId === expected.userId && live.version === expected.version) {
        errorOwner.current = expected; setError(copy.linkError);
      }
    });
  };
  return <>{children}{loadFailed ? <View style={styles.unavailable} accessibilityLiveRegion="polite" testID="startup-ai-status-unavailable"><NuriText role="Caption">{copy.loadError}</NuriText><NuriButton secondary label={copy.retry} onPress={() => { setLoadFailed(false); setLoadRetry(value => value + 1); }} testID="startup-ai-load-retry" /></View> : null}<Modal visible={visible} animationType="fade" presentationStyle="fullScreen" onRequestClose={() => {}}>
    {/* A native Modal has its own window: measure its insets here rather than
        inheriting the navigator's provider/frame outside that native window. */}
    <SafeAreaProvider style={styles.screen} testID="startup-ai-modal-safe-area-provider">
    <SafeAreaView edges={["top", "right", "bottom", "left"]} style={styles.screen} testID="startup-ai-permission">
      <View style={styles.heading}><NuriText style={{ fontSize: 24, lineHeight: 32, fontWeight: "500" }}>{locale === "en" ? "Choose how to use Nuri" : translate(locale, "选择如何使用 Nuri")}</NuriText><NuriText secondary>{copy.header}</NuriText></View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.body} showsVerticalScrollIndicator testID="startup-ai-explanation-scroll">
        {[copy.intro, copy.data, copy.provider, copy.separate, copy.withdraw].map((paragraph, index) => <NuriText key={index} testID={`startup-ai-explanation-${index}`}>{paragraph}</NuriText>)}
        <NuriText secondary testID="startup-ai-account-scope">{locale === "en" ? "Before sign-in, this choice applies once to the next account you sign in to on this device. AI stays blocked until that account is verified and your choice is saved. Other accounts choose separately." : translate(locale, "登录前的选择仅应用于你接下来在本设备登录的账号。账号核实且选择保存前，AI 始终保持关闭。其他账号需分别选择。")}</NuriText>
        <Pressable accessibilityRole="link" onPress={() => openLink(AI_PRIVACY_URL)} style={styles.link}><NuriText secondary style={styles.linkText}>{copy.privacy}</NuriText></Pressable>
        <Pressable accessibilityRole="link" onPress={() => openLink(AI_PROVIDER_DATA_URL)} style={styles.link}><NuriText secondary style={styles.linkText}>{copy.processing}</NuriText></Pressable>
      </ScrollView>
      <View style={styles.footer}>
        <NuriText secondary style={{ fontSize: 13, lineHeight: 20 }}>{locale === "en" ? "Allowing sends relevant information to OpenAI. You can change this later in Privacy & AI. Declining keeps non-AI features available." : translate(locale, "允许后，相关信息会发送给 OpenAI。可在“隐私与 AI”随时更改；暂不允许仍可使用非 AI 功能。")}</NuriText>
        {currentError ? <NuriText accessibilityLiveRegion="assertive" testID="startup-ai-error">{currentError}</NuriText> : null}
        {!loaded || busy ? <ActivityIndicator testID="startup-ai-saving" /> : <><NuriButton style={styles.button} label={copy.allow} onPress={() => void choose(true)} testID="startup-ai-allow" /><NuriButton style={styles.button} secondary label={copy.decline} onPress={() => void choose(false)} testID="startup-ai-decline" /></>}
      </View>
    </SafeAreaView>
    </SafeAreaProvider>
  </Modal></>;
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#FFFAF5" },
  heading: { paddingHorizontal: 24, paddingTop: 20, paddingBottom: 16, gap: 8 },
  body: { paddingHorizontal: 24, paddingBottom: 24, gap: 16 },
  footer: { paddingHorizontal: 24, paddingTop: 16, paddingBottom: 12, gap: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#D9D0D3" },
  button: { width: "100%", minHeight: 54 },
  unavailable: { paddingHorizontal: 24, paddingVertical: 12, gap: 8, backgroundColor: "#FFFAF5" },
  link: { minHeight: 44, justifyContent: "center" },
  linkText: { textDecorationLine: "underline" },
});
