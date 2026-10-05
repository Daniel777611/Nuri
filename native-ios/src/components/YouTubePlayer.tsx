import { useEffect, useState } from "react";
import { AppState, Pressable, StyleSheet, Text, View } from "react-native";
import Constants from "expo-constants";
import { WebView } from "react-native-webview";
import { useT } from "@/src/i18n";

export const isYouTubeVideoId = (id: string): boolean => /^[A-Za-z0-9_-]{11}$/.test(id);

export function youtubeEmbedUrl(id: string): string | null {
  return isYouTubeVideoId(id) ? `https://www.youtube-nocookie.com/embed/${id}?playsinline=1&rel=0&autoplay=0` : null;
}

export function allowYouTubeNavigation(url: string, id: string): boolean {
  if (url === "about:blank") return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "www.youtube-nocookie.com"
      && !parsed.username && !parsed.password && !parsed.port && parsed.pathname === `/embed/${id}`;
  } catch { return false; }
}

// Only an app identifier is sent as Referer (YouTube's required client
// identification). Never forward NURI cookies, a JWT, or an authenticated URL.
export function youtubeAppReferer(bundleId: string | undefined): string | null {
  return bundleId && /^[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)+$/.test(bundleId)
    ? `https://${bundleId.toLowerCase()}` : null;
}

export default function YouTubePlayer({ videoId, width, active }: { videoId: string; width: number; active: boolean }) {
  const { t } = useT();
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) => setForeground(state === "active"));
    return () => listener.remove();
  }, []);
  useEffect(() => setFailed(false), [videoId]);
  const uri = youtubeEmbedUrl(videoId);
  const referer = youtubeAppReferer(Constants.expoConfig?.ios?.bundleIdentifier);
  // Keep 16:9 content inside a >=200pt viewport for YouTube's minimum player
  // controls size on narrow phones. The native player letterboxes, not stretches.
  return <View style={[styles.player, { width, height: Math.max(200, width * 9 / 16) }]} testID="daily-video-player">
    {failed || !uri || !referer ? <Pressable style={styles.failure} onPress={() => { setFailed(false); setAttempt((n) => n + 1); }} testID="daily-video-player-retry" accessibilityRole="button">
      <Text style={styles.failureText}>{t("视频暂时无法播放，点一下再试试。")}</Text>
    </Pressable> : active && foreground ? <WebView
      key={`${videoId}:${attempt}`}
      testID="daily-video-webview"
      source={{ uri, headers: { Referer: referer } }}
      // WebView's whitelist fallback opens rejected origins via Linking.
      // Route every URL to our deny-by-default callback instead; it NEVER
      // opens external URLs. Only the separate source button can do that.
      originWhitelist={["*"]}
      onShouldStartLoadWithRequest={(request) => allowYouTubeNavigation(request.url, videoId)}
      onOpenWindow={() => { /* External links require the explicit source button. */ }}
      allowsInlineMediaPlayback allowsFullscreenVideo mediaPlaybackRequiresUserAction
      sharedCookiesEnabled={false} thirdPartyCookiesEnabled={false} incognito
      setSupportMultipleWindows={false} javaScriptCanOpenWindowsAutomatically={false}
      onError={() => setFailed(true)}
      onContentProcessDidTerminate={() => setFailed(true)}
      onHttpError={({ nativeEvent }) => { if (nativeEvent.statusCode >= 400) setFailed(true); }}
      style={styles.webview}
    /> : null}
  </View>;
}

const styles = StyleSheet.create({
  player: { backgroundColor: "#000000", marginTop: 18, alignSelf: "center" },
  webview: { flex: 1, backgroundColor: "#000000" },
  failure: { flex: 1, minHeight: 44, alignItems: "center", justifyContent: "center", padding: 20 },
  failureText: { color: "#FFFFFF", textAlign: "center", fontSize: 14, lineHeight: 22 },
});
