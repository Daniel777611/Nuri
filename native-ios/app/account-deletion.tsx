import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { useHeaderHeight } from "@react-navigation/elements";
import { api, apiErrorDetail, auth } from "@/src/api";
import { deleteOwnedAccount, validDeletionPassword, type AccountDeletionOwner } from "@/src/accountDeletion";
import { SafeAreaView } from "@/src/components/NativeSafeAreaView";
import { useT } from "@/src/i18n";
import { CardList, NuriButton, NuriText, NuriField } from "@/src/uiux48/Primitives";
import { colors, radius, spacing } from "@/src/theme";
import { StateCard } from "@/src/uiux48/StateCard";

export default function AccountDeletionPage() {
  const router = useRouter();
  const { locale } = useT();
  const headerHeight = useHeaderHeight();
  const copy = (zh: string, tw: string, en: string) => locale === "en" ? en : locale === "zh-TW" ? tw : zh;
  const [owner, setOwner] = useState<AccountDeletionOwner | null>(null);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [deleted, setDeleted] = useState(false);
  const [cleanupOwner, setCleanupOwner] = useState<AccountDeletionOwner | null>(null);
  const active = useRef(false);
  const pending = useRef(false);
  const generation = useRef(0);
  const publishedToken = useRef<string | null | undefined>(undefined);

  useFocusEffect(useCallback(() => {
    active.current = true;
    let current = true;
    const revision = ++generation.current;
    setLoading(true);
    setOwner(null);
    setPassword("");
    setConfirmation("");
    setMessage("");
    publishedToken.current = undefined;
    const unsubscribe = auth.subscribeSessionChange((token) => {
      publishedToken.current = token;
      generation.current++;
      if (active.current) {
        setOwner(null);
        setPassword("");
        setConfirmation("");
        setLoading(false);
      }
    });
    void (async () => {
      try {
        const token = await auth.getToken();
        if (!token) throw new Error("SESSION_CHANGED");
        const me = await api.me();
        if (!me?.id || !me?.email || await auth.getToken() !== token) throw new Error("SESSION_CHANGED");
        if (current && generation.current === revision) setOwner({ token, id: me.id, email: me.email });
      } catch {
        if (current && generation.current === revision) setMessage(locale === "en" ? "The current account could not be verified. Reopen this page after signing in." : locale === "zh-TW" ? "無法核實目前帳號。請登入後重新開啟此頁。" : "无法核实当前账号。请登录后重新打开此页。");
      } finally {
        if (current && generation.current === revision) setLoading(false);
      }
    })();
    return () => {
      current = false;
      active.current = false;
      generation.current++;
      unsubscribe();
    };
  }, [locale]));

  const finishSignOut = async (signedOut: boolean) => {
    const token = await auth.getToken();
    if (!active.current) return;
    if (signedOut && token === null && !publishedToken.current) { setDeleted(true); router.setParams({uiState:"deleted"}); }
    else setMessage(copy("原账号已删除。当前会话已改变，不会退出另一个账号。", "原帳號已刪除。目前工作階段已改變，不會登出另一個帳號。", "The original account was deleted. Your newer sign-in was not signed out."));
  };

  const retryLocalSignOut = async () => {
    if (!active.current || pending.current || !cleanupOwner) return;
    pending.current = true;
    setBusy(true);
    try {
      const cleared = await auth.clearToken({ expectedToken: cleanupOwner.token, forceLocal: true });
      if (active.current) setCleanupOwner(null);
      await finishSignOut(cleared);
    } catch {
      if (active.current) setMessage(copy("本机凭据仍未确认清除，请重试。", "本機憑據仍未確認清除，請重試。", "Local credential removal is still unconfirmed. Please retry."));
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  };

  const submit = async () => {
    if (!active.current || pending.current || cleanupOwner || !owner || confirmation !== "DELETE" || !validDeletionPassword(password)) return;
    pending.current = true;
    setBusy(true);
    setMessage("");
    const capturedOwner = owner;
    try {
      const result = await deleteOwnedAccount(capturedOwner, password, confirmation, {
        getToken: auth.getToken,
        deleteAccount: api.deleteAccount,
        clearToken: auth.clearToken,
      });
      if (!active.current) return;
      await finishSignOut(result.signedOut);
    } catch (error) {
      if (!active.current) return;
      const detail = apiErrorDetail(error);
      const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 0;
      if (detail === "ACCOUNT_REAUTH_FAILED") setMessage(copy("当前密码不正确，账号未删除。", "目前密碼不正確，帳號未刪除。", "The current password is incorrect. The account was not deleted."));
      else if (detail === "SUBSCRIPTION_CANCEL_FAILED") setMessage(copy("网页订阅取消未获确认，账号尚未删除。请稍后重试，或先在原网页订阅渠道管理订阅。", "網頁訂閱取消未獲確認，帳號尚未刪除。請稍後重試，或先在原網頁訂閱管道管理訂閱。", "Web subscription cancellation was not confirmed. The account was not deleted. Retry later or manage the subscription with the original web provider."));
      else if (status === 404 || status === 405 || detail === "ACCOUNT_DELETION_UNAVAILABLE") setMessage(copy("账号删除服务尚不可用，未确认删除。请稍后重试。", "帳號刪除服務尚不可用，未確認刪除。請稍後重試。", "Account deletion is unavailable. Deletion was not confirmed; please try again later."));
      else if (status === 401 || (error && typeof error === "object" && "code" in error && error.code === "SESSION_CHANGED")) setMessage(copy("登录状态已改变或已失效。这次未确认删除，请重新登录核实账号。", "登入狀態已改變或已失效。此次未確認刪除，請重新登入核實帳號。", "Your sign-in changed or expired. Deletion was not confirmed; sign in again to verify your account."));
      else if (error && typeof error === "object" && "code" in error && error.code === "LOCAL_SIGNOUT_FAILED") {
        setCleanupOwner(capturedOwner);
        setMessage(copy("服务器已确认删除，但本机登录凭据清除失败。请重试退出；不要继续使用旧登录。", "伺服器已確認刪除，但本機登入憑據清除失敗。請重試登出；不要繼續使用舊登入。", "Server deletion was confirmed, but local credential removal failed. Retry sign-out before continuing."));
      }
      else setMessage(copy("无法确认删除是否完成，可能已有部分数据被清理。请检查登录状态后再尝试；此处不会显示删除成功。", "無法確認刪除是否完成，可能已有部分資料被清理。請檢查登入狀態後再嘗試；此處不會顯示刪除成功。", "Completion could not be confirmed; some data may already have been removed. Check your sign-in status before retrying. This is not a success confirmation."));
    } finally {
      pending.current = false;
      if (active.current) {
        setBusy(false);
        setPassword("");
        setConfirmation("");
      }
    }
  };

  const canDelete = !busy && !cleanupOwner && !!owner && confirmation === "DELETE" && validDeletionPassword(password);
  if(deleted) return <StateCard testID="account-deleted-card" message={copy("你的账号已删除。谢谢你曾让 Nuri 陪你走过这段日常。","你的帳號已刪除。謝謝你曾讓 Nuri 陪你走過這段日常。","Your account has been deleted. Thank you for sharing these days with Nuri.")} primary={{label:copy("返回欢迎页","返回歡迎頁","Back to welcome"),onPress:()=>router.replace("/welcome")}} />;
  return <KeyboardAvoidingView style={{flex:1}} behavior={Platform.OS==="ios"?"padding":"height"} keyboardVerticalOffset={headerHeight}><CardList>
    <NuriText style={{fontSize:20,fontWeight:"500"}}>{copy("删除账号","刪除帳號","Delete account")}</NuriText>
    <NuriText>{copy("这会永久删除账号及相关云端个人数据，无法恢复。","這會永久刪除帳號及相關雲端個人資料，無法恢復。","This permanently deletes the account and associated cloud personal data. It cannot be undone.")}</NuriText>
    <NuriText secondary testID="delete-account-shared-warning">{copy("此应用和原版 NURI 使用同一个云端账号。这次删除会同时影响两者，不只是删除这台设备上的应用数据。","此應用程式與原版 NURI 使用同一個雲端帳號。此次刪除會同時影響兩者，不只是刪除此裝置上的資料。","This app and the original NURI app share this cloud account. Deletion affects BOTH apps, not just this device.")}</NuriText>
    <NuriText secondary style={{fontSize:12}} testID="delete-account-billing-scope">{copy("网页订阅会先尝试取消，取消未确认时不会开始删除。Apple 订阅仍需在 Apple 管理；依法需保留的交易记录可能继续保留。","網頁訂閱會先嘗試取消，取消未確認時不會開始刪除。Apple 訂閱仍需在 Apple 管理；依法需保留的交易紀錄可能繼續保留。","Web subscription cancellation is attempted before deletion; an unconfirmed cancellation prevents deletion from starting. Manage Apple subscriptions with Apple. Transaction records required by law may be retained.")}</NuriText>
    {loading?<ActivityIndicator />:null}
    <NuriText secondary>{copy("要删除的账号","要刪除的帳號","Account to delete")}</NuriText><NuriText testID="delete-account-owner">{owner?.email||copy("未核实，请重新登录后打开此页","未核實，請重新登入後開啟此頁","Not verified. Reopen after signing in.")}</NuriText>
    <NuriField label={copy("输入 DELETE 确认","輸入 DELETE 確認","Type DELETE to confirm")} value={confirmation} onChangeText={setConfirmation} autoCapitalize="characters" autoCorrect={false} editable={!busy&&!!owner} accessibilityLabel="DELETE" testID="delete-account-confirmation" />
    <NuriField label={copy("当前 NURI 密码（不是 Apple 密码）","目前 NURI 密碼（不是 Apple 密碼）","Current NURI password (not Apple password)")} value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" autoCorrect={false} textContentType="password" editable={!busy&&!!owner} testID="delete-account-password" />
    {message?<NuriText accessibilityLiveRegion="assertive" testID="delete-account-message">{message}</NuriText>:null}
    {cleanupOwner?<NuriButton label={copy("重试清除本机登录","重試清除本機登入","Retry local sign-out")} onPress={()=>void retryLocalSignOut()} disabled={busy} testID="delete-account-retry-local" />:null}
    <NuriButton label={busy?copy("正在确认删除…","正在確認刪除…","Confirming deletion…"):copy("永久删除账号","永久刪除帳號","Permanently delete account")} disabled={!canDelete} busy={busy} onPress={()=>void submit()} testID="delete-account-submit" />
    <NuriButton secondary label={copy("保留账号","保留帳號","Keep account")} disabled={busy} onPress={()=>router.canGoBack()?router.back():router.replace("/(tabs)/profile")} />
  </CardList></KeyboardAvoidingView>;
}
