import { AuthFrame, NuriButton, NuriText } from "@/src/uiux48/Primitives";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { aiConsent } from "@/src/api";
import { AIConsentError, AI_CONSENT_VERSION, AI_PRIVACY_URL, AI_PROVIDER_DATA_URL } from "@/src/aiConsent";
import { aiConsentCopy } from "@/src/aiConsentCopy";
import { useAIConsent } from "@/src/useAIConsent";
import { useT, translate } from "@/src/i18n";
import { SafeAreaView } from "@/src/components/NativeSafeAreaView";
import { colors } from "@/src/theme";
import { aiPermissionReturnPath } from "@/src/aiPermissionNavigation";
import { requestFailureCopy } from "@/src/requestFailure";
import { StateCard } from "@/src/uiux48/StateCard";

export default function AIPermission() {
  const { locale } = useT();
  const copy = aiConsentCopy(locale);
  const { state, refresh } = useAIConsent();
  const router = useRouter();
  const { returnTo } = useLocalSearchParams<{ returnTo?: string }>();
  const returnPath = aiPermissionReturnPath(returnTo);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [withdraw, setWithdraw] = useState(false);
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
      if(saved && !allowed && active.current && sequence === request.current) setWithdraw(false);
      if (active.current && sequence === request.current && !saved) setError(copy.changed);
      if (saved && allowed && returnPath && active.current && sequence === request.current
          && aiConsent.getState().userId === state.userId && aiConsent.getState().status === "allowed") {
        // Back preserves the originating screen's recommendation parameters.
        // That screen retries on focus; no AI choice is assumed or preselected.
        if (router.canGoBack()) router.back();
        else router.replace(returnPath as never);
      }
    } catch (failure) {
      if (active.current && sequence === request.current) setError(failure instanceof AIConsentError && failure.code === "AI_CONSENT_STORAGE_FAILED" ? copy.storageError : copy.changed);
    } finally {
      inFlight.current = false;
      if (active.current && sequence === request.current) setBusy(false);
    }
  };
  const openLink = (url: string) => { void Linking.openURL(url).catch(() => { if (active.current) setError(copy.linkError); }); };
  const checked = !!state.userId && ["allowed", "not_allowed"].includes(state.status);
  const needsLogin = state.status === "signed_out" || state.failure === "session";
  // Opening this card is not consent withdrawal. Only the explicit confirm
  // callback calls the existing owner-checked consent service.
  if(withdraw && state.status === "allowed") return <StateCard testID="ai-withdraw-card" title={locale==="en"?"Pause AI features?":translate(locale, "暂时停用 AI 功能？")} message={locale==="en"?"Your profile and non-AI records remain available. You can choose permission again later.":translate(locale, "个人资料与已有非 AI 记录仍可使用。之后可以重新选择许可。")} primary={{label:locale==="en"?"Confirm withdrawal":translate(locale, "确认撤回"),onPress:()=>void choose(false)}} secondary={{label:locale==="en"?"Keep using AI":translate(locale, "继续使用 AI"),onPress:()=>setWithdraw(false)}} busy={busy} error={error} />;
  return <AuthFrame testID="ai-permission-card">
    {[copy.intro,copy.data,copy.provider,copy.separate,copy.withdraw].map((paragraph,index)=><NuriText key={index} style={{fontSize:16,lineHeight:24}} testID={`ai-permission-explanation-${index}`}>{paragraph}</NuriText>)}
    <NuriText secondary style={{fontSize:12}}>{copy.version}: {AI_CONSENT_VERSION}</NuriText>
    <Pressable onPress={()=>openLink(AI_PRIVACY_URL)} accessibilityRole="link" style={{minHeight:44,justifyContent:"center"}} testID="ai-permission-privacy"><NuriText secondary style={{fontSize:13,textDecorationLine:"underline"}}>{copy.privacy}</NuriText></Pressable>
    <Pressable onPress={()=>openLink(AI_PROVIDER_DATA_URL)} accessibilityRole="link" style={{minHeight:44,justifyContent:"center"}} testID="ai-permission-provider"><NuriText secondary style={{fontSize:13,textDecorationLine:"underline"}}>{copy.processing}</NuriText></Pressable>
    <View accessibilityLiveRegion="polite" testID="ai-permission-status">{state.status==="loading"||state.status==="unknown"?<ActivityIndicator />:null}<NuriText secondary style={{fontSize:13}}>{state.status==="allowed"?copy.allowed:needsLogin?requestFailureCopy(locale,"session").detail:state.status==="error"?copy.loadError:state.status==="not_allowed"?copy.denied:copy.loading}</NuriText></View>
    {error?<NuriText style={{color:colors.error,fontSize:13}} testID="ai-permission-error">{error}</NuriText>:null}
    {state.status==="allowed"?<NuriButton disabled={busy} label={locale==="en"?"Continue":translate(locale, "继续使用 Nuri")} onPress={()=>{if(returnPath&&router.canGoBack())router.back();else router.replace((returnPath||"/(tabs)")as never);}} testID="ai-permission-continue" />:null}
    {checked?<>{state.status!=="allowed"?<NuriButton disabled={busy} busy={busy} label={copy.allow} onPress={()=>void choose(true)} testID="ai-permission-allow" />:null}<NuriButton secondary disabled={busy} label={state.status==="allowed"?copy.revoke:copy.decline} onPress={()=>state.status==="allowed"?setWithdraw(true):void choose(false)} testID="ai-permission-decline" /></>:null}
    {(state.status==="error"||state.status==="unknown")?<NuriButton secondary disabled={busy} label={copy.retry} onPress={()=>{setError("");void refresh().catch(()=>{if(active.current)setError(copy.loadError);});}} testID="ai-permission-retry" />:null}
    <NuriButton secondary disabled={busy} label={needsLogin?copy.login:copy.nonAI} onPress={()=>router.replace(needsLogin?"/login":"/(tabs)/profile")} testID="ai-permission-non-ai" />
  </AuthFrame>;
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
