// Where a parent on the web gets the Android app. The APK is served by the
// web deployment itself (public/download/), so the link and the QR code that
// points at it never change; replace the file there to ship a new build.
import { Linking, Platform, View } from "react-native";
import { Image } from "expo-image";
import { useT, translate } from "@/src/i18n";
import { NuriButton, NuriText } from "@/src/uiux48/Primitives";

export const ANDROID_APK_URL = "https://nurifam.app/download/nuri-android.apk";

function download() {
  if (Platform.OS === "web" && typeof window !== "undefined") window.location.assign(ANDROID_APK_URL);
  else void Linking.openURL(ANDROID_APK_URL);
}

export default function AndroidDownloadSection() {
  const { locale } = useT();
  const copy = (cn: string, en: string) => locale === "en" ? en : translate(locale, cn);
  return <>
    <NuriText secondary>{copy("用安卓手机扫描二维码，或在手机浏览器里点下面的按钮下载安装包。", "Scan the QR code with an Android phone, or tap the button below in the phone's browser to download the installer.")}</NuriText>
    <View style={{ alignItems: "center" }}>
      <Image source={require("@/assets/uiux48/android-download-qr.png")} style={{ width: 180, height: 180, borderRadius: 12 }} contentFit="contain" accessibilityLabel={copy("安卓 App 下载二维码", "QR code for the Android app")} testID="android-download-qr" />
    </View>
    <NuriButton label={copy("下载安卓安装包", "Download for Android")} onPress={download} testID="android-download-button" />
    <NuriText secondary style={{ fontSize: 12, lineHeight: 18 }}>{copy("下载后在手机上打开安装包。如果提示“未知来源”，请按提示在设置里允许这次安装。安装后用同一个账号登录即可，资料和对话都会保留。", "Open the file on your phone once it has downloaded. If Android warns about an unknown source, allow this install in Settings when prompted. Then sign in with the same account; your profile and conversations carry over.")}</NuriText>
  </>;
}
