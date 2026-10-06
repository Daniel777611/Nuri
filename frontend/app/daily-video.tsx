// Today's video, in full: NURI's line on why it is here, the video playing
// right on the page, a short summary NURI wrote from its title and
// description, and two ways on — talking it through, or YouTube itself.
//
// The summary is written the first time this page asks for it
// (GET /feed/daily-video/{id}/summary), so it loads a moment after the video.
import { createElement, useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as WebBrowser from "expo-web-browser";

import { api, type DailyVideoCard } from "@/src/api";
import { useT } from "@/src/i18n";
import { canEmbedVideo } from "@/src/nativeShell";

const C = {
  canvas: "#FFF9F3",
  text: "#261B45",
  soft: "#5B5272",
  purple: "#4C368C",
  line: "rgba(38,27,69,0.12)",
  summary: "#F3EEFF",
};

function embedUrl(videoId: string): string {
  // youtube-nocookie: no tracking cookies until the parent presses play.
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?playsinline=1&rel=0&modestbranding=1`;
}

function Player({
  videoId,
  thumbnailUrl,
  width,
  onOpenYouTube,
}: {
  videoId: string;
  thumbnailUrl: string;
  width: number;
  onOpenYouTube: () => void;
}) {
  const { t } = useT();
  const height = Math.round((width * 9) / 16);
  if (Platform.OS === "web" && !canEmbedVideo()) {
    // An older iOS shell can't play it in the page (see canEmbedVideo), so
    // offer the YouTube app straight away rather than a black frame.
    return (
      <Pressable
        onPress={onOpenYouTube}
        style={[styles.player, { width, height }]}
        accessibilityRole="button"
        testID="daily-video-poster"
      >
        <Image source={{ uri: thumbnailUrl }} style={StyleSheet.absoluteFill} resizeMode="cover" />
        <View style={styles.posterShade} />
        <View style={styles.posterPlay}>
          <Ionicons name="play" size={28} color="#FFFFFF" style={{ marginLeft: 3 }} />
        </View>
        <Text style={styles.posterHint}>{t("点击在 YouTube 中播放")}</Text>
      </Pressable>
    );
  }
  if (Platform.OS === "web") {
    // The app ships as a web page inside the iOS/Android shells, so this is
    // the player every parent sees.
    return (
      <View style={[styles.player, { width, height }]} testID="daily-video-player">
        {createElement("iframe", {
          src: embedUrl(videoId),
          title: "YouTube video",
          allow: "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture",
          allowFullScreen: true,
          // YouTube checks which page embeds the player and refuses without
          // it (Error 153); send our origin even if a stricter default applies.
          referrerPolicy: "strict-origin-when-cross-origin",
          style: { width: "100%", height: "100%", border: 0 },
        })}
      </View>
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { WebView } = require("react-native-webview");
  return (
    <View style={[styles.player, { width, height }]} testID="daily-video-player">
      <WebView
        source={{ uri: embedUrl(videoId) }}
        allowsInlineMediaPlayback
        allowsFullscreenVideo
        mediaPlaybackRequiresUserAction
        style={{ flex: 1 }}
      />
    </View>
  );
}

export default function DailyVideoScreen() {
  const { t } = useT();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const pageWidth = Math.min(width, 402);
  const { id } = useLocalSearchParams<{ id?: string }>();
  const [card, setCard] = useState<DailyVideoCard | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing">("loading");
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryState, setSummaryState] = useState<"loading" | "ready" | "failed">("loading");
  const [openingChat, setOpeningChat] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (id ? api.getDailyVideoById(String(id)) : api.getDailyVideo())
      .then((res) => {
        if (cancelled) return;
        if (res.state === "ready" && res.card) {
          setCard(res.card);
          setState("ready");
        } else {
          setState("missing");
        }
      })
      .catch(() => !cancelled && setState("missing"));
    return () => {
      cancelled = true;
    };
  }, [id]);

  const loadSummary = useCallback(async (video: DailyVideoCard) => {
    if (video.summary) {
      setSummary(video.summary);
      setSummaryState("ready");
      return;
    }
    setSummaryState("loading");
    try {
      const res = await api.getDailyVideoSummary(video.id);
      setSummary(res.summary || "");
      setSummaryState(res.summary ? "ready" : "failed");
    } catch {
      setSummaryState("failed");
    }
  }, []);

  useEffect(() => {
    if (card) void loadSummary(card);
  }, [card, loadSummary]);

  const goBack = () => (router.canGoBack() ? router.back() : router.replace("/(tabs)"));

  const openYouTube = useCallback(() => {
    if (!card || !/^https:\/\/www\.youtube\.com\//.test(card.source_url)) return;
    void api.dailyVideoEvent(card.id, "source_click").catch(() => {});
    const opening =
      Platform.OS === "web" ? Linking.openURL(card.source_url) : WebBrowser.openBrowserAsync(card.source_url);
    void opening.catch(() => {});
  }, [card]);

  const talkItThrough = useCallback(async () => {
    if (!card || openingChat) return;
    setOpeningChat(true);
    try {
      const session = await api.startSession({ card_id: card.card_id });
      router.push(`/chat/${session.id}`);
    } catch {
      setOpeningChat(false);
    }
  }, [card, openingChat, router]);

  if (state === "loading") {
    return (
      <View style={[styles.safe, styles.center]}>
        <ActivityIndicator color={C.purple} />
      </View>
    );
  }

  if (state === "missing" || !card) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={[styles.page, { width: pageWidth }]}>
          <BackButton onPress={goBack} label={t("返回")} />
          <Text style={styles.body}>{t("这个视频暂时打不开，回首页再试试。")}</Text>
        </View>
      </SafeAreaView>
    );
  }

  const playerWidth = pageWidth - 40;
  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <ScrollView contentContainerStyle={{ alignItems: "center", paddingBottom: 40 }}>
        <View style={[styles.page, { width: pageWidth }]}>
          <BackButton onPress={goBack} label={t("返回")} />

          <Text style={styles.intro} testID="daily-video-intro">{card.intro}</Text>
          {card.key_points ? (
            <View style={styles.pointsBox} testID="daily-video-points">
              <Text style={styles.pointsLabel}>{t("和你相关的要点")}</Text>
              <Text style={styles.pointsText}>{card.key_points}</Text>
            </View>
          ) : null}

          <Player
            videoId={card.video_id}
            thumbnailUrl={card.thumbnail_url}
            width={playerWidth}
            onOpenYouTube={openYouTube}
          />

          <Text style={styles.title} testID="daily-video-title">{card.display_title || card.title}</Text>
          <View style={styles.metaRow}>
            <Ionicons name="logo-youtube" size={14} color="#FF3B30" />
            <Text style={styles.meta} numberOfLines={1}>
              {[card.channel, card.video_lang === "en" ? t("英文视频") : ""].filter(Boolean).join(" · ") || "YouTube"}
            </Text>
          </View>

          <View style={styles.summaryBox} testID="daily-video-summary">
            <Text style={styles.summaryLabel}>{t("NURI帮你看了视频简介")}</Text>
            {summaryState === "loading" ? (
              <View style={styles.summaryLoading}>
                <ActivityIndicator size="small" color={C.purple} />
                <Text style={styles.summaryWait}>{t("正在整理视频要点…")}</Text>
              </View>
            ) : summaryState === "ready" && summary ? (
              <Text style={styles.body}>{summary}</Text>
            ) : (
              <Pressable onPress={() => void loadSummary(card)} accessibilityRole="button">
                <Text style={styles.summaryWait}>{t("要点暂时没整理出来，点一下再试试。")}</Text>
              </Pressable>
            )}
          </View>
          <Text style={styles.small}>
            {t("要点根据视频标题和简介整理，NURI没有看视频画面，具体以视频为准。视频是外部内容，不是专业诊断。")}
          </Text>

          <Pressable
            onPress={talkItThrough}
            disabled={openingChat}
            style={({ pressed }) => [styles.primary, (pressed || openingChat) && styles.pressed]}
            accessibilityRole="button"
            testID="daily-video-chat"
          >
            <Text style={styles.primaryText}>
              {openingChat ? t("正在打开…") : t("和NURI聊聊这个")}
            </Text>
          </Pressable>
          <Pressable
            onPress={openYouTube}
            style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
            accessibilityRole="link"
            testID="daily-video-source"
          >
            <Text style={styles.secondaryText}>{t("在YouTube打开")}</Text>
            <Ionicons name="open-outline" size={16} color={C.purple} />
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function BackButton({ onPress, label }: { onPress: () => void; label: string }) {
  return (
    <Pressable onPress={onPress} style={styles.back} hitSlop={8} accessibilityRole="button" testID="daily-video-back">
      <Ionicons name="chevron-back" size={20} color={C.text} />
      <Text style={styles.backText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.canvas },
  center: { alignItems: "center", justifyContent: "center" },
  page: { alignSelf: "center", paddingHorizontal: 20 },
  back: { flexDirection: "row", alignItems: "center", gap: 2, paddingVertical: 12, alignSelf: "flex-start" },
  backText: { color: C.text, fontFamily: "NotoSansSC_600SemiBold", fontSize: 14 },
  intro: { color: C.text, fontFamily: "NotoSansSC_600SemiBold", fontSize: 16, lineHeight: 25, marginTop: 4, marginBottom: 14 },
  pointsBox: {
    borderLeftWidth: 3, borderLeftColor: C.purple, paddingLeft: 12, paddingVertical: 2, marginBottom: 16,
  },
  pointsLabel: { color: C.purple, fontFamily: "NotoSansSC_700Bold", fontSize: 12, marginBottom: 4 },
  pointsText: { color: C.text, fontFamily: "NotoSansSC_500Medium", fontSize: 15, lineHeight: 23 },
  player: { borderRadius: 18, overflow: "hidden", backgroundColor: "#000000" },
  posterShade: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.25)" },
  posterPlay: {
    position: "absolute", top: "50%", left: "50%", width: 64, height: 64, marginTop: -40, marginLeft: -32,
    borderRadius: 32, backgroundColor: "#FF0033", alignItems: "center", justifyContent: "center",
  },
  posterHint: {
    position: "absolute", left: 0, right: 0, bottom: 14, textAlign: "center",
    color: "#FFFFFF", fontFamily: "NotoSansSC_600SemiBold", fontSize: 13,
  },
  title: { color: C.text, fontFamily: "NotoSansSC_700Bold", fontSize: 17, lineHeight: 25, marginTop: 14 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6 },
  meta: { flex: 1, color: C.soft, fontFamily: "NotoSansSC_400Regular", fontSize: 12 },
  summaryBox: { backgroundColor: C.summary, borderRadius: 16, padding: 16, marginTop: 18 },
  summaryLabel: { color: C.soft, fontFamily: "NotoSansSC_700Bold", fontSize: 13, marginBottom: 8 },
  summaryLoading: { flexDirection: "row", alignItems: "center", gap: 8 },
  summaryWait: { color: C.soft, fontFamily: "NotoSansSC_400Regular", fontSize: 14, lineHeight: 22 },
  body: { color: C.text, fontFamily: "NotoSansSC_400Regular", fontSize: 15, lineHeight: 24, flexShrink: 1 },
  small: { color: C.soft, fontFamily: "NotoSansSC_400Regular", fontSize: 12, lineHeight: 18, marginTop: 12 },
  primary: {
    marginTop: 24, borderRadius: 999, backgroundColor: C.purple, paddingVertical: 15, alignItems: "center",
  },
  primaryText: { color: "#FFFFFF", fontFamily: "NotoSansSC_700Bold", fontSize: 15 },
  secondary: {
    marginTop: 12, borderRadius: 999, borderWidth: 1, borderColor: C.purple, paddingVertical: 13,
    alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 6,
  },
  secondaryText: { color: C.purple, fontFamily: "NotoSansSC_700Bold", fontSize: 15 },
  pressed: { opacity: 0.75 },
});
