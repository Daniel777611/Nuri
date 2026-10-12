import { Image, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { useT } from "@/src/i18n";

const mascotImage = require("@/assets/images/homepage/figma-mascot.png");

const C = {
  canvas: "#FFF9F3",
  text: "#261B45",
  muted: "#71629B",
  purple: "#4C368C",
  soft: "#EEE9FF",
};

// Where Home's not-yet-built entries lead, so a tap lands somewhere that says
// what is coming instead of on an empty list.
const FEATURES = {
  knowledge: {
    name: "知识图书馆",
    icon: "library-outline",
    blurb: "把专家建议和其他家长的经验，整理成随时能查的小卡片。",
  },
  community: {
    name: "家长社区",
    icon: "people-outline",
    blurb: "和同样在带娃的家长交流经验，互相打打气。",
  },
} as const;

export type ComingSoonFeature = keyof typeof FEATURES;

export default function ComingSoon({ feature }: { feature: ComingSoonFeature }) {
  const { t } = useT();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const phoneWidth = Math.min(width, 402);
  const info = FEATURES[feature];

  const back = () => (router.canGoBack() ? router.back() : router.replace("/(tabs)"));

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <View style={[styles.canvas, { width: phoneWidth }]}>
        <Pressable
          onPress={back}
          style={styles.backBtn}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t("返回")}
          testID="coming-soon-back"
        >
          <Ionicons name="chevron-back" size={26} color={C.text} />
        </Pressable>

        <View style={styles.body} testID={`coming-soon-${feature}`}>
          <View style={styles.mascotWrap}>
            <Image source={mascotImage} style={styles.mascot} resizeMode="contain" />
          </View>
          <View style={styles.badge}>
            <Ionicons name={info.icon} size={14} color={C.purple} />
            <Text style={styles.badgeText}>{t(info.name)}</Text>
          </View>
          <Text style={styles.title}>{t("新功能制作中")}</Text>
          <Text style={styles.blurb}>{t(info.blurb)}</Text>
          <Text style={styles.hint}>{t("上线后会第一时间告诉你。现在有什么想问的，可以先和 NURI 聊聊。")}</Text>
        </View>

        <View style={styles.actions}>
          <Pressable
            onPress={() => router.replace("/(tabs)/chats")}
            style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
            testID="coming-soon-chat"
          >
            <Text style={styles.primaryText}>{t("和 NURI 聊聊")}</Text>
          </Pressable>
          <Pressable
            onPress={back}
            style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
            testID="coming-soon-home"
          >
            <Text style={styles.secondaryText}>{t("返回首页")}</Text>
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#F4F1F9" },
  canvas: { flex: 1, alignSelf: "center", backgroundColor: C.canvas, paddingHorizontal: 24 },
  backBtn: { width: 36, height: 44, justifyContent: "center", marginLeft: -8, marginTop: 4 },
  body: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  mascotWrap: { width: 160, height: 160, borderRadius: 80, backgroundColor: C.soft, overflow: "hidden", marginBottom: 8 },
  mascot: { width: "100%", height: "100%" },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: C.soft,
  },
  badgeText: { color: C.purple, fontFamily: "NotoSansSC_600SemiBold", fontSize: 13 },
  title: { color: C.text, fontFamily: "NotoSansSC_700Bold", fontSize: 24, lineHeight: 32 },
  blurb: { color: C.text, fontFamily: "NotoSansSC_500Medium", fontSize: 15, lineHeight: 23, textAlign: "center" },
  hint: { color: C.muted, fontFamily: "NotoSansSC_400Regular", fontSize: 13, lineHeight: 20, textAlign: "center" },
  actions: { gap: 10, paddingBottom: 24 },
  primary: { height: 52, borderRadius: 26, backgroundColor: C.purple, alignItems: "center", justifyContent: "center" },
  primaryText: { color: "#FFFFFF", fontFamily: "NotoSansSC_700Bold", fontSize: 15 },
  secondary: { height: 52, borderRadius: 26, alignItems: "center", justifyContent: "center" },
  secondaryText: { color: C.purple, fontFamily: "NotoSansSC_600SemiBold", fontSize: 15 },
  pressed: { opacity: 0.8 },
});
