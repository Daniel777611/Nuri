// Public "how to delete your NURI account" page at nurifam.app/delete-account.
// Google Play's account deletion policy needs a web link that works without
// the app or a sign-in, so this page only explains; the deletion itself is the
// signed-in /account-deletion flow, or an email request for people without
// the app.

import { Linking, ScrollView, StyleSheet, View } from "react-native";
import { Stack } from "expo-router";

import { SafeAreaView } from "@/src/components/NativeSafeAreaView";
import { useT } from "@/src/i18n";
import { GlassSurface, NuriButton, NuriText } from "@/src/uiux48/Primitives";

const CONTACT_EMAIL = "contact@ordashteches.com";
const PRIVACY_URL = "https://nurifam.com/privacy";

export default function DeleteAccountInfo() {
  const { locale } = useT();
  const copy = (zh: string, tw: string, en: string) => locale === "en" ? en : locale === "zh-TW" ? tw : zh;
  const mailto = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent("NURI account deletion request")}`;

  const section = (title: string, lines: string[], testID: string) => (
    <GlassSurface contentStyle={styles.card} testID={testID}>
      <NuriText role="H2">{title}</NuriText>
      {lines.map((line, i) => <NuriText key={i} style={styles.line}>{line}</NuriText>)}
    </GlassSurface>
  );

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <Stack.Screen options={{ title: copy("删除 NURI 账号", "刪除 NURI 帳號", "Delete your NURI account") }} />
      <ScrollView contentContainerStyle={styles.page} testID="delete-account-info">
        <View style={{ gap: 8 }}>
          <NuriText role="H1">{copy("删除你的 NURI 账号", "刪除你的 NURI 帳號", "Delete your NURI account")}</NuriText>
          <NuriText secondary>{copy(
            "NURI 由 Ordash Tech, Inc. 运营。你可以随时删除账号和相关数据。",
            "NURI 由 Ordash Tech, Inc. 營運。你可以隨時刪除帳號和相關資料。",
            "NURI is operated by Ordash Tech, Inc. You can delete your account and its data at any time.",
          )}</NuriText>
        </View>
        {section(copy("在 App 里删除", "在 App 裡刪除", "Delete in the app"), [
          copy("1. 打开 NURI 并登录要删除的账号。", "1. 開啟 NURI 並登入要刪除的帳號。", "1. Open NURI and sign in to the account you want to delete."),
          copy("2. 点头像打开设置，进入「账号与安全」→「删除账号」。", "2. 點頭像開啟設定，進入「帳號與安全」→「刪除帳號」。", "2. Tap your avatar to open settings, then Account & security → Delete account."),
          copy("3. 输入密码并确认。删除会立即开始，无法撤销。", "3. 輸入密碼並確認。刪除會立即開始，無法復原。", "3. Enter your password and confirm. Deletion starts right away and cannot be undone."),
        ], "delete-account-in-app")}
        {section(copy("没有 App 时申请删除", "沒有 App 時申請刪除", "Request deletion without the app"), [
          copy(
            `用注册邮箱发邮件到 ${CONTACT_EMAIL}，标题写「删除账号」。我们核实身份后会删除账号，并回信确认。`,
            `用註冊信箱寄信到 ${CONTACT_EMAIL}，標題寫「刪除帳號」。我們核實身分後會刪除帳號，並回信確認。`,
            `Email ${CONTACT_EMAIL} from the address you signed up with, with the subject "Delete account". We verify it is you, delete the account and reply to confirm.`,
          ),
        ], "delete-account-by-email")}
        {section(copy("会删除哪些数据", "會刪除哪些資料", "What is deleted"), [
          copy(
            "账号资料、孩子信息、全部对话和图片、NURI 记住的事、收藏、反馈与举报、通知设置和设备记录。",
            "帳號資料、孩子資訊、全部對話和圖片、NURI 記住的事、收藏、回饋與檢舉、通知設定和裝置紀錄。",
            "Your profile, children's details, all conversations and photos, what NURI remembers, favorites, feedback and reports, and notification settings and devices.",
          ),
          copy(
            "如果你有付费会员，删除前会先取消订阅。支付服务商 Stripe 会按法律要求保留发票记录。",
            "如果你有付費會員，刪除前會先取消訂閱。支付服務商 Stripe 會依法律要求保留發票紀錄。",
            "If you have a paid membership, it is cancelled first. Our payment processor, Stripe, keeps invoice records as the law requires.",
          ),
        ], "delete-account-what")}
        <NuriButton label={copy("发邮件申请删除", "寄信申請刪除", "Email a deletion request")} onPress={() => void Linking.openURL(mailto)} testID="delete-account-email" />
        <NuriButton secondary label={copy("查看隐私政策", "查看隱私權政策", "Read the privacy policy")} onPress={() => void Linking.openURL(PRIVACY_URL)} testID="delete-account-privacy" />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 24, gap: 16, maxWidth: 640, width: "100%", alignSelf: "center" },
  card: { padding: 20, gap: 8 },
  line: { lineHeight: 24 },
});
