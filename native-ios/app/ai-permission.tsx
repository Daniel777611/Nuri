import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { aiConsent } from "@/src/api";
import { AIConsentError, AI_CONSENT_VERSION, AI_PRIVACY_URL, AI_PROVIDER_DATA_URL } from "@/src/aiConsent";
import { aiConsentCopy } from "@/src/aiConsentCopy";
import { useAIConsent } from "@/src/useAIConsent";
import { useT } from "@/src/i18n";
import { SafeAreaView } from "@/src/components/NativeSafeAreaView";
import { colors } from "@/src/theme";

export default function AIPermission() {
  const { locale } = useT();
  const copy = aiConsentCopy(locale);
  const { state, refresh } = useAIConsent();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(true);
  const request = useRef(0);
  const inFlight = useRef(false);
  useEffect(() => { const requestCounter = request; active.current = true; return () => { active.current = false; requestCounter.current++; }; }, []);
  const choose = async (allowed: boolean) => {
    if (!active.current || inFlight.current) return;
    inFlight.current = true;
    const sequence = ++request.current;
    setBusy(true); setError("");
    try {
      const saved = await aiConsent.setAllowed(allowed, state);
      if (active.current && sequence === request.current && !saved) setError(copy.changed);
    } catch (failure) {
      if (active.current && sequence === request.current) setError(failure instanceof AIConsentError && failure.code === "AI_CONSENT_STORAGE_FAILED" ? copy.storageError : copy.changed);
    } finally {
      inFlight.current = false;
      if (active.current && sequence === request.current) setBusy(false);
    }
  };
  const openLink = (url: string) => { void Linking.openURL(url).catch(() => { if (active.current) setError(copy.linkError); }); };
  const checked = !!state.userId && ["allowed", "not_allowed"].includes(state.status);
  return <SafeAreaView style={styles.safe}>
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.title}>{copy.title}</Text>
      {[copy.intro, copy.data, copy.provider, copy.separate, copy.withdraw].map((paragraph, index) => <Text key={index} style={styles.body} testID={`ai-permission-explanation-${index}`}>{paragraph}</Text>)}
      <Text style={styles.version}>{copy.version}: {AI_CONSENT_VERSION}</Text>
      <Pressable onPress={() => openLink(AI_PRIVACY_URL)} accessibilityRole="link" style={styles.link} testID="ai-permission-privacy"><Text style={styles.linkText}>{copy.privacy}</Text></Pressable>
      <Pressable onPress={() => openLink(AI_PROVIDER_DATA_URL)} accessibilityRole="link" style={styles.link} testID="ai-permission-provider"><Text style={styles.linkText}>{copy.processing}</Text></Pressable>
      <View style={styles.status} accessibilityLiveRegion="polite" testID="ai-permission-status">
        {state.status === "loading" || state.status === "unknown" ? <ActivityIndicator color={colors.brand} /> : null}
        <Text style={styles.body}>{state.status === "allowed" ? copy.allowed : state.status === "signed_out" ? copy.signedOut : state.status === "error" ? copy.loadError : state.status === "not_allowed" ? copy.denied : copy.loading}</Text>
      </View>
      {error ? <Text style={styles.error} accessibilityLiveRegion="assertive" testID="ai-permission-error">{error}</Text> : null}
      {checked ? <>
        {state.status !== "allowed" ? <Pressable disabled={busy} onPress={() => void choose(true)} style={[styles.button, styles.primary, busy && styles.disabled]} accessibilityRole="button" testID="ai-permission-allow"><Text style={styles.primaryText}>{copy.allow}</Text></Pressable> : null}
        <Pressable disabled={busy} onPress={() => void choose(false)} style={[styles.button, busy && styles.disabled]} accessibilityRole="button" testID="ai-permission-decline"><Text style={styles.buttonText}>{state.status === "allowed" ? copy.revoke : copy.decline}</Text></Pressable>
      </> : null}
      <Pressable disabled={busy} onPress={() => { setError(""); void refresh().catch(() => { if (active.current) setError(copy.loadError); }); }} style={styles.button} accessibilityRole="button" testID="ai-permission-retry"><Text style={styles.buttonText}>{copy.retry}</Text></Pressable>
      <Pressable disabled={busy} onPress={() => router.replace(state.status === "signed_out" ? "/login" : "/(tabs)/profile")} style={styles.button} accessibilityRole="button" testID="ai-permission-non-ai"><Text style={styles.buttonText}>{state.status === "signed_out" ? copy.login : copy.nonAI}</Text></Pressable>
    </ScrollView>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  content: { padding: 22, paddingBottom: 48, gap: 14 },
  title: { color: colors.onSurface, fontSize: 24, fontWeight: "700" },
  body: { color: colors.onSurface, fontSize: 15, lineHeight: 24 },
  version: { color: colors.muted, fontSize: 12 },
  link: { paddingVertical: 12, minHeight: 44 },
  linkText: { color: colors.brand, fontSize: 15, textDecorationLine: "underline" },
  status: { padding: 16, borderRadius: 12, backgroundColor: colors.brandTertiary, gap: 8 },
  button: { minHeight: 48, padding: 14, borderWidth: 1, borderColor: colors.border, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  primary: { backgroundColor: colors.brand },
  primaryText: { color: colors.onBrandPrimary, fontSize: 15, fontWeight: "600", textAlign: "center" },
  buttonText: { color: colors.onSurface, fontSize: 15, textAlign: "center" },
  disabled: { opacity: 0.5 },
  error: { color: colors.error, fontSize: 14, lineHeight: 22 },
});
