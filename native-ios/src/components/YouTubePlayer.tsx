import { useEffect, useRef, useState } from "react";
import { AppState, Linking, Pressable, StyleSheet, Text, View } from "react-native";
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

// Player links leave this cookie-isolated WebView through the OS. HTTPS
// universal links let an installed YouTube app handle its own links, with the
// default system browser handling them otherwise. Never dispatch a URL scheme
// supplied by page JavaScript, credentials, or an implicit HTTP downgrade.
export function youtubeExternalUrl(url: string): string | null {
  if (/[\u0000-\u0020\u007f\\]/.test(url)) return null;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port
      || !host.includes(".") || /^[\d.]+$/.test(host) || host.startsWith("[")
      || ["localhost", "local", "internal", "lan", "home"].some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return null;
    // A related embed can be navigated to by the official player. Give the OS
    // its ordinary watch URL so it can open YouTube, not another embed page.
    if (parsed.hostname === "www.youtube-nocookie.com") {
      const relatedId = parsed.pathname.match(/^\/embed\/([A-Za-z0-9_-]{11})$/)?.[1];
      if (relatedId) return `https://www.youtube.com/watch?v=${relatedId}`;
    }
    return parsed.href;
  } catch { return null; }
}

export function isYouTubeServiceUrl(url: string): boolean {
  const external = youtubeExternalUrl(url);
  if (!external) return false;
  const host = new URL(external).hostname;
  return host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com")
    || host === "youtube-nocookie.com" || host.endsWith(".youtube-nocookie.com")
    || host === "accounts.google.com" || host === "consent.google.com"
    || host === "policies.google.com" || host === "support.google.com";
}

export async function openYouTubeLink(url: string): Promise<boolean> {
  const external = youtubeExternalUrl(url);
  if (!external) return false;
  try { await Linking.openURL(external); return true; } catch { return false; }
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
  const [linkFailure, setLinkFailure] = useState<string | null>(null);
  const linkOperation = useRef(0), openingLink = useRef<string | null>(null), mounted = useRef(true);
  const activeState = useRef(active), foregroundState = useRef(foreground), currentVideo = useRef(videoId);
  activeState.current = active;
  currentVideo.current = videoId;
  useEffect(() => {
    mounted.current = true;
    const operation = linkOperation;
    const listener = AppState.addEventListener("change", (state) => {
      foregroundState.current = state === "active";
      if (!foregroundState.current) { linkOperation.current++; openingLink.current = null; }
      setForeground(foregroundState.current);
    });
    return () => { mounted.current = false; operation.current++; listener.remove(); };
  }, []);
  useEffect(() => {
    setFailed(false); setLinkFailure(null); openingLink.current = null; linkOperation.current++;
  }, [videoId]);
  useEffect(() => { if (!active || !foreground) { linkOperation.current++; openingLink.current = null; } }, [active, foreground]);
  const uri = youtubeEmbedUrl(videoId);
  const referer = youtubeAppReferer(Constants.expoConfig?.ios?.bundleIdentifier);
  const openLink = async (url: string) => {
    const external = youtubeExternalUrl(url);
    if (!mounted.current || !activeState.current || !foregroundState.current || currentVideo.current !== videoId
      || !external || openingLink.current === external) return;
    const request = ++linkOperation.current;
    openingLink.current = external; setLinkFailure(null);
    const opened = await openYouTubeLink(external);
    if (mounted.current && request === linkOperation.current) {
      openingLink.current = null;
      if (!opened) setLinkFailure(external);
    }
  };
  // Keep 16:9 content inside a >=200pt viewport for YouTube's minimum player
  // controls size on narrow phones. The native player letterboxes, not stretches.
  return <View style={{ width, alignSelf: "center" }}>
    <View style={[styles.player, { width, height: Math.max(200, width * 9 / 16) }]} testID="daily-video-player">
    {failed || !uri || !referer ? <Pressable style={styles.failure} onPress={() => { setFailed(false); setAttempt((n) => n + 1); }} testID="daily-video-player-retry" accessibilityRole="button">
      <Text style={styles.failureText}>{t("视频暂时无法播放，点一下再试试。")}</Text>
    </Pressable> : active && foreground ? <WebView
      key={`${videoId}:${attempt}`}
      testID="daily-video-webview"
      source={{ uri, headers: { Referer: referer } }}
      // Keep all routing in the validated handlers rather than WebView's
      // unvalidated originWhitelist -> Linking fallback. Do not suppress the
      // official player's links, related videos, support links or ad targets.
      originWhitelist={["*"]}
      onShouldStartLoadWithRequest={(request) => {
        if (allowYouTubeNavigation(request.url, videoId)) return true;
        const external = youtubeExternalUrl(request.url);
        if (!external) return false;
        // Sandboxed HTTPS subframes belong to the player (including ads).
        // A clicked iframe link, however, must open outside the embed too.
        if (request.isTopFrame === false && request.navigationType !== "click") return true;
        if (request.navigationType === "click" || isYouTubeServiceUrl(external)) void openLink(external);
        return false;
      }}
      onOpenWindow={({ nativeEvent }) => { void openLink(nativeEvent.targetUrl); }}
      allowsInlineMediaPlayback allowsFullscreenVideo mediaPlaybackRequiresUserAction
      sharedCookiesEnabled={false} thirdPartyCookiesEnabled={false} incognito
      setSupportMultipleWindows javaScriptCanOpenWindowsAutomatically={false}
      onError={() => setFailed(true)}
      onContentProcessDidTerminate={() => setFailed(true)}
      onHttpError={({ nativeEvent }) => { if (nativeEvent.statusCode >= 400) setFailed(true); }}
      style={styles.webview}
    /> : null}
    </View>
    {linkFailure ? <Pressable style={styles.linkFailure} onPress={() => void openLink(linkFailure)} accessibilityRole="button" testID="daily-video-link-retry">
      <Text style={styles.linkFailureText}>{t("外部内容暂时无法打开，请稍后再试")} · {t("重试")}</Text>
    </Pressable> : null}
  </View>;
}

const styles = StyleSheet.create({
  player: { backgroundColor: "#000000", marginTop: 18, alignSelf: "center" },
  webview: { flex: 1, backgroundColor: "#000000" },
  failure: { flex: 1, minHeight: 44, alignItems: "center", justifyContent: "center", padding: 20 },
  failureText: { color: "#FFFFFF", textAlign: "center", fontSize: 14, lineHeight: 22 },
  linkFailure: { minHeight: 44, justifyContent: "center", paddingVertical: 10 },
  linkFailureText: { color: "#4C368C", fontSize: 13, lineHeight: 20 },
});
