import { useRef, useState } from "react";
import { ActivityIndicator, requireNativeComponent, StyleSheet, View, type ViewProps } from "react-native";
import { useRouter } from "expo-router";
import { apiErrorDetail, auth } from "@/src/api";
import { APPLE_CONTROL_NAME, canUseNativeAppleSignIn, linkNativeAppleAccount, signInWithNativeApple, useAppleSignInReady } from "@/src/appleSignIn";
import { useT } from "@/src/i18n";
import { safeNotificationRoute } from "@/src/nativePushRuntime";
import type { ProviderStorageFailure } from "@/src/providerSignInSession";
import { useAccountScope, useAccountState } from "@/src/useAccountState";
import { NuriText } from "@/src/uiux48/Primitives";

const AppleControl = canUseNativeAppleSignIn()
  ? requireNativeComponent<ViewProps & { disabled: boolean; onPress: () => void }>(APPLE_CONTROL_NAME)
  : null;

export default function AppleSignInButton({ disabled = false, returnTo, acquire, release, onBusyChange, onLinked, description }: {
  disabled?: boolean;
  returnTo?: string;
  acquire?: () => boolean;
  release?: () => void;
  onBusyChange?: (busy: boolean) => void;
  onLinked?: () => void;
  description?: string;
}) {
  const ready = useAppleSignInReady();
  const { locale, setLocale } = useT();
  const router = useRouter();
  const { generation, capture, current, isMounted } = useAccountScope();
  const [busy, setBusy] = useAccountState(false);
  const [message, setMessage] = useAccountState("");
  const [localFailure, setLocalFailure] = useState<ProviderStorageFailure | null>(null);
  const pending = useRef(false);
  const failure = localFailure?.identity === auth.getIdentityGeneration() && localFailure.generation === generation;
  const copy = (zh: string, tw: string, en: string) => locale === "en" ? en : locale === "zh-TW" ? tw : zh;

  const submit = async () => {
    const ticket = capture();
    if (ticket === null || disabled || !ready || pending.current || acquire && !acquire()) return;
    pending.current = true;
    setBusy(true); setMessage(""); setLocalFailure(null); onBusyChange?.(true);
    try {
      if (onLinked) {
        if (await linkNativeAppleAccount(ticket, current) && current(ticket)) onLinked();
      } else {
        const result = await signInWithNativeApple({
          ticket, current, isMounted, language: locale, setLocale,
          retryLocalFailure: failure,
          navigate: onboarded => {
            const notification = safeNotificationRoute(returnTo);
            const detail = notification && /^\/notifications\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(notification) ? notification : null;
            router.replace(onboarded ? (detail ?? "/(tabs)") as never : "/onboarding");
          },
        });
        if (typeof result === "object" && isMounted() && result.identity === auth.getIdentityGeneration()
          && result.generation === auth.getSessionGeneration()) setLocalFailure(result);
      }
    } catch (error) {
      if (!current(ticket)) return;
      const detail = apiErrorDetail(error);
      if (detail === "APPLE_ACCOUNT_LINK_REQUIRED") {
        setMessage(copy("请先用原有方式登录，再到「账号与安全」关联 Apple。","請先用原有方式登入，再到「帳號與安全」連結 Apple。","Sign in with your existing method first, then link Apple in Account & security."));
      } else if (detail === "APPLE_LINK_REAUTH_REQUIRED") {
        setMessage(copy("请先退出，再用原有方式登录，随后返回这里关联 Apple。","請先登出，再用原有方式登入，然後回到這裡連結 Apple。","Sign out and sign in with your existing method, then return here to link Apple."));
      } else if (detail === "APPLE_IDENTITY_ALREADY_LINKED") {
        setMessage(copy("这个 Apple 账号已关联另一个 NURI 账号。","這個 Apple 帳號已連結另一個 NURI 帳號。","This Apple Account is already linked to another NURI account."));
      } else if (detail === "APPLE_EMAIL_UNAVAILABLE") {
        setMessage(copy("Apple 未提供可用邮箱。请尝试共享邮箱或选择其他登录方式。","Apple 未提供可用的電子郵件。請嘗試分享電子郵件或選擇其他登入方式。","Apple did not supply an email address. Try sharing your email or use another sign-in method."));
      } else {
        setMessage(copy("未能完成 Apple 验证，请重试。","未能完成 Apple 驗證，請重試。","Apple verification could not be completed. Please try again."));
      }
    } finally {
      pending.current = false;
      release?.();
      setBusy(false); onBusyChange?.(false);
    }
  };

  if (!AppleControl || !ready) return null;
  return <View style={styles.wrap}>
    {description ? <NuriText>{description}</NuriText> : null}
    <AppleControl style={styles.control} disabled={disabled || busy} onPress={() => void submit()} testID={onLinked ? "apple-link-button" : "apple-signin-native-button"} />
    {!onLinked ? <NuriText secondary style={styles.note}>
      {copy("已有 NURI 账号？先用原有方式登录，再在「账号与安全」关联 Apple。","已有 NURI 帳號？先用原有方式登入，再在「帳號與安全」連結 Apple。","Already have a NURI account? Sign in as usual, then link Apple in Account & security.")}
    </NuriText> : null}
    {busy ? <ActivityIndicator /> : null}
    {failure || message ? <NuriText secondary accessibilityLiveRegion="polite" testID="apple-signin-message">
      {failure ? copy("本机未能完成登录设置，请再用 Apple 试一次。","本機未能完成登入設定，請再用 Apple 試一次。","This device could not finish signing in. Please try Apple again.") : message}
    </NuriText> : null}
  </View>;
}

const styles = StyleSheet.create({
  wrap: { width: "100%", gap: 8 },
  control: { width: "100%", height: 48, alignSelf: "center" },
  note: { fontSize: 12, lineHeight: 17 },
});
