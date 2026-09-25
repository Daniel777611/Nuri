import NetInfo from '@react-native-community/netinfo';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  BackHandler,
  Linking,
  NativeEventEmitter,
  NativeModules,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
  useColorScheme,
} from 'react-native';
import {
  WebView,
  type WebViewMessageEvent,
  type WebViewNavigation,
} from 'react-native-webview';

import { INITIAL_URL, LOAD_TIMEOUT_MS } from './src/config';
import { decideNavigation } from './src/navigation';
import {
  NOTIFICATION_ROUTE_EVENT,
  PUSH_STATE_EVENT,
  buildCustomEventScript,
  isAllowedNotificationRoute,
  isNuriPushState,
  isPushTokenRequest,
  isTrustedWebUrl,
  notificationRouteUrl,
  type NuriPushNativeModule,
  type NuriPushState,
} from './src/push';

type ShellError = 'offline' | 'timeout' | 'web';

const nativePushModule =
  Platform.OS === 'ios'
    ? (NativeModules.NuriPushBridge as NuriPushNativeModule | undefined)
    : undefined;
const nativePushEmitter = nativePushModule
  ? new NativeEventEmitter(nativePushModule)
  : null;
export default function App() {
  const webViewRef = useRef<WebView>(null);
  const webViewLoadedRef = useRef(false);
  const currentPageUrlRef = useRef<string>(INITIAL_URL);
  const pushStateRef = useRef<NuriPushState | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pushInjectionTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const webContentTerminationDatesRef = useRef<number[]>([]);
  const [canGoBack, setCanGoBack] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ShellError | null>(null);
  const [currentUrl, setCurrentUrl] = useState<string>(INITIAL_URL);
  const [webViewRevision, setWebViewRevision] = useState(0);
  const [nativeReady, setNativeReady] = useState(!nativePushModule);
  const colorScheme = useColorScheme();
  const dark = colorScheme === 'dark';

  const clearLoadTimeout = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const startLoadTimeout = useCallback(() => {
    clearLoadTimeout();
    timeoutRef.current = setTimeout(() => {
      setLoading(false);
      setError('timeout');
    }, LOAD_TIMEOUT_MS);
  }, [clearLoadTimeout]);

  const retry = useCallback(async () => {
    const network = await NetInfo.fetch();
    if (!network.isConnected || network.isInternetReachable === false) {
      setLoading(false);
      setError('offline');
      return;
    }

    setError(null);
    setLoading(true);
    startLoadTimeout();
    webViewLoadedRef.current = false;
    currentPageUrlRef.current = INITIAL_URL;
    setCurrentUrl(INITIAL_URL);
    webViewRef.current?.reload();
  }, [startLoadTimeout]);

  const injectTrustedEvent = useCallback(
    (
      eventName:
        | 'nuri:apns-token'
        | 'nuri:open-route',
      detail: NuriPushState | { route: string },
    ) => {
      if (
        !webViewLoadedRef.current ||
        !isTrustedWebUrl(currentPageUrlRef.current)
      ) {
        return false;
      }

      webViewRef.current?.injectJavaScript(
        buildCustomEventScript(eventName, detail),
      );
      return true;
    },
    [],
  );

  // The hosted app registers the device only after its signed-in web session is
  // ready. A WebView's `onLoadEnd` fires before that React listener is always
  // attached, so one one-shot injection can be lost. Replaying the current
  // state briefly is safe: the backend upsert is idempotent per installation.
  const clearPushInjectionTimers = useCallback(() => {
    pushInjectionTimersRef.current.forEach((timer) => clearTimeout(timer));
    pushInjectionTimersRef.current = [];
  }, []);

  const syncPushStateToWeb = useCallback(() => {
    const state = pushStateRef.current;
    if (state) {
      injectTrustedEvent('nuri:apns-token', state);
    }
  }, [injectTrustedEvent]);

  const replayPushStateToWeb = useCallback(() => {
    clearPushInjectionTimers();
    syncPushStateToWeb();
    // The hosted app may need to restore its signed-in session after WebView's
    // load event. The API upsert is idempotent, so longer replay coverage is
    // safer than silently losing the production APNs registration.
    pushInjectionTimersRef.current = [350, 1200, 3000, 7000, 12000].map((delay) =>
      setTimeout(syncPushStateToWeb, delay),
    );
  }, [clearPushInjectionTimers, syncPushStateToWeb]);

  const acceptPushState = useCallback(
    (state: unknown) => {
      if (!isNuriPushState(state)) {
        return;
      }
      pushStateRef.current = state;
      replayPushStateToWeb();
    },
    [replayPushStateToWeb],
  );


  const openNotificationRoute = useCallback(
    (route: unknown) => {
      if (!isAllowedNotificationRoute(route)) {
        webViewLoadedRef.current = false;
        currentPageUrlRef.current = INITIAL_URL;
        setCurrentUrl(INITIAL_URL);
        setWebViewRevision((revision) => revision + 1);
        return;
      }

      if (injectTrustedEvent('nuri:open-route', { route })) {
        return;
      }

      const url = notificationRouteUrl(route);
      webViewLoadedRef.current = false;
      currentPageUrlRef.current = url;
      setCurrentUrl(url);
    },
    [injectTrustedEvent],
  );

  useEffect(() => {
    startLoadTimeout();
    const unsubscribe = NetInfo.addEventListener((network) => {
      if (!network.isConnected || network.isInternetReachable === false) {
        clearLoadTimeout();
        setLoading(false);
        setError('offline');
      }
    });
    return () => {
      clearLoadTimeout();
      unsubscribe();
    };
  }, [clearLoadTimeout, startLoadTimeout]);

  useEffect(() => {
    if (!nativePushModule || !nativePushEmitter) {
      setNativeReady(true);
      return;
    }

    let disposed = false;
    const pushSubscription = nativePushEmitter.addListener(
      PUSH_STATE_EVENT,
      acceptPushState,
    );
    const routeSubscription = nativePushEmitter.addListener(
      NOTIFICATION_ROUTE_EVENT,
      (event: { route?: unknown }) => openNotificationRoute(event?.route),
    );
    const appStateSubscription = AppState.addEventListener(
      'change',
      (nextState) => {
        if (nextState !== 'active') {
          return;
        }
        // Re-register on foreground so a token acquired after the first page
        // load, or permission enabled in Settings, reaches the signed-in web
        // session without asking the parent to reinstall the app.
        void nativePushModule.requestPushRegistration().then(acceptPushState).catch(() => {
          // The rest of NURI remains usable when notifications are unavailable.
        });
      },
    );

    void nativePushModule
      .getInitialState()
      .then((initialState) => {
        if (disposed) {
          return;
        }
        acceptPushState(initialState?.pushState);
        if (initialState?.route) {
          openNotificationRoute(initialState.route);
        }
      })
      .catch(() => {
        // Keep the Web shell usable if native push registration is unavailable.
      })
      .finally(() => {
        if (!disposed) {
          setNativeReady(true);
        }
      });

    void nativePushModule
      .requestPushRegistration()
      .then(acceptPushState)
      .catch(() => {
        // The app remains usable when the user denies notifications.
      });

    return () => {
      disposed = true;
      clearPushInjectionTimers();
      pushSubscription.remove();
      routeSubscription.remove();
      appStateSubscription.remove();
    };
  }, [acceptPushState, clearPushInjectionTimers, openNotificationRoute]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (canGoBack) {
        webViewRef.current?.goBack();
        return true;
      }
      return false;
    });
    return () => subscription.remove();
  }, [canGoBack]);

  const openExternal = useCallback(async (url: string) => {
    try {
      if (await Linking.canOpenURL(url)) {
        await Linking.openURL(url);
      }
    } catch {
      // The WebView remains on the trusted page if the system cannot open a URL.
    }
  }, []);

  const shouldStartLoad = useCallback(
    (request: { url: string }) => {
      const decision = decideNavigation(request.url);
      if (decision.action === 'allow') {
        return true;
      }
      if (decision.action === 'external') {
        void openExternal(decision.url);
      }
      return false;
    },
    [openExternal],
  );

  const handleNavigationChange = useCallback((navigation: WebViewNavigation) => {
    setCanGoBack(navigation.canGoBack);
    currentPageUrlRef.current = navigation.url;
  }, []);

  const handleLoadStart = useCallback(() => {
    clearPushInjectionTimers();
    webViewLoadedRef.current = false;
    setError(null);
    setLoading(true);
    startLoadTimeout();
  }, [clearPushInjectionTimers, startLoadTimeout]);

  const handleLoadEnd = useCallback(() => {
    webViewLoadedRef.current = true;
    clearLoadTimeout();
    setError(null);
    setLoading(false);
    replayPushStateToWeb();
  }, [clearLoadTimeout, replayPushStateToWeb]);

  const handleWebMessage = useCallback(
    (event: WebViewMessageEvent) => {
      if (
        !isTrustedWebUrl(currentPageUrlRef.current) ||
        !isPushTokenRequest(event.nativeEvent.data)
      ) {
        return;
      }
      if (pushStateRef.current) {
        replayPushStateToWeb();
        return;
      }
      // The website may ask before APNs finishes issuing the first token. Ask
      // native again rather than dropping that request permanently.
      void nativePushModule?.requestPushRegistration().then(acceptPushState).catch(() => {
        // A denied or unavailable system permission is represented by no token.
      });
    },
    [acceptPushState, replayPushStateToWeb],
  );

  const handleWebError = useCallback(() => {
    clearLoadTimeout();
    setLoading(false);
    setError('web');
  }, [clearLoadTimeout]);

  const handleContentProcessDidTerminate = useCallback(() => {
    const now = Date.now();
    const recentTerminations = webContentTerminationDatesRef.current.filter(
      (timestamp) => now - timestamp <= 60_000,
    );
    recentTerminations.push(now);
    webContentTerminationDatesRef.current = recentTerminations;

    if (recentTerminations.length === 1) {
      setError(null);
      setLoading(true);
      startLoadTimeout();
      webViewRef.current?.reload();
      return;
    }

    clearLoadTimeout();
    setLoading(false);
    setError('web');
  }, [clearLoadTimeout, startLoadTimeout]);

  const palette = dark ? darkPalette : lightPalette;

  const goBack = useCallback(() => {
    if (canGoBack) {
      webViewRef.current?.goBack();
    }
  }, [canGoBack]);

  const goHome = useCallback(() => {
    clearPushInjectionTimers();
    webViewLoadedRef.current = false;
    currentPageUrlRef.current = INITIAL_URL;
    setCanGoBack(false);
    setCurrentUrl(INITIAL_URL);
    setWebViewRevision((revision) => revision + 1);
  }, [clearPushInjectionTimers]);

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: palette.background }]}>
      <StatusBar style={dark ? 'light' : 'dark'} />
      {nativePushModule && nativeReady ? (
        <View
          style={[
            styles.topControls,
            { backgroundColor: palette.panel, borderColor: palette.border },
          ]}
        >
          <View style={styles.navigationBar}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="返回上一页"
              disabled={!canGoBack}
              onPress={goBack}
              style={({ pressed }) => [
                styles.navigationButton,
                {
                  borderColor: palette.border,
                  backgroundColor: palette.background,
                  opacity: canGoBack ? (pressed ? 0.68 : 1) : 0.42,
                },
              ]}
            >
              <Text style={[styles.navigationButtonText, { color: palette.text }]}>‹ 返回</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="回到主页"
              onPress={goHome}
              style={({ pressed }) => [
                styles.navigationButton,
                {
                  borderColor: palette.border,
                  backgroundColor: palette.background,
                  opacity: pressed ? 0.68 : 1,
                },
              ]}
            >
              <Text style={[styles.navigationButtonText, { color: palette.text }]}>主页</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      <View style={styles.container}>
        {nativeReady ? <WebView
          key={webViewRevision}
          ref={webViewRef}
          source={{ uri: currentUrl }}
          style={[styles.webView, { backgroundColor: palette.background }]}
          originWhitelist={[
            'https://*',
            'about:*',
            'blob:*',
            'data:*',
            'mailto:*',
            'tel:*',
            'facetime:*',
            'maps:*',
          ]}
          onShouldStartLoadWithRequest={shouldStartLoad}
          onNavigationStateChange={handleNavigationChange}
          onMessage={handleWebMessage}
          onLoadStart={handleLoadStart}
          onLoadEnd={handleLoadEnd}
          onError={handleWebError}
          onHttpError={handleWebError}
          onContentProcessDidTerminate={handleContentProcessDidTerminate}
          onOpenWindow={({ nativeEvent }) => {
            const decision = decideNavigation(nativeEvent.targetUrl);
            if (decision.action === 'external') {
              void openExternal(decision.url);
            } else if (decision.action === 'allow') {
              webViewLoadedRef.current = false;
              currentPageUrlRef.current = nativeEvent.targetUrl;
              setCurrentUrl(nativeEvent.targetUrl);
            }
          }}
          allowsBackForwardNavigationGestures
          allowsInlineMediaPlayback
          // WebKit still shows the system microphone prompt. This only bypasses
          // an extra WebView-level prompt when the requesting page is the exact
          // NURI host; all other origins are denied.
          mediaCapturePermissionGrantType="grantIfSameHostElseDeny"
          contentInsetAdjustmentBehavior="never"
          sharedCookiesEnabled
          thirdPartyCookiesEnabled={false}
          javaScriptCanOpenWindowsAutomatically
          setSupportMultipleWindows={false}
          domStorageEnabled
          mixedContentMode="never"
          allowFileAccess={false}
          cacheEnabled
          pullToRefreshEnabled
          applicationNameForUserAgent="NURI-Mobile-Shell/0.2.8"
        /> : null}

        {loading && !error ? (
          <View style={[styles.overlay, { backgroundColor: palette.background }]}>
            <Text style={[styles.brand, { color: palette.text }]}>NURI</Text>
            <ActivityIndicator size="small" color={palette.accent} />
            <Text style={[styles.message, { color: palette.secondaryText }]}>正在连接 NURI…</Text>
          </View>
        ) : null}

        {error ? (
          <View style={[styles.overlay, { backgroundColor: palette.background }]}>
            <Text style={[styles.brand, { color: palette.text }]}>NURI</Text>
            <Text style={[styles.errorTitle, { color: palette.text }]}>
              {error === 'offline' ? '网络连接不可用' : '暂时无法打开 NURI'}
            </Text>
            <Text style={[styles.message, { color: palette.secondaryText }]}>
              {error === 'offline'
                ? '请检查 Wi‑Fi 或蜂窝网络，然后重试。'
                : '连接可能超时或服务暂时不可用，请稍后重试。'}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="重新连接 NURI"
              onPress={() => void retry()}
              style={({ pressed }) => [
                styles.retryButton,
                { backgroundColor: palette.accent, opacity: pressed ? 0.75 : 1 },
              ]}
            >
              <Text style={styles.retryText}>重新连接</Text>
            </Pressable>
          </View>
        ) : null}

      </View>
    </SafeAreaView>
  );
}

const lightPalette = {
  background: '#FFFDF8',
  panel: '#FFFFFF',
  input: '#F6F3E8',
  text: '#1D2A25',
  secondaryText: '#5E6964',
  accent: '#347A67',
  border: 'rgba(29, 42, 37, 0.14)',
  placeholder: '#9AA39D',
  danger: '#B42318',
  quickPressed: 'rgba(52, 122, 103, 0.12)',
  switchTrack: '#D8DED9',
};

const darkPalette = {
  background: '#14201C',
  panel: '#1B2A25',
  input: '#22332E',
  text: '#F6F3E8',
  secondaryText: '#B8C2BC',
  accent: '#65B49D',
  border: 'rgba(246, 243, 232, 0.16)',
  placeholder: '#7F8C85',
  danger: '#FFB4AB',
  quickPressed: 'rgba(101, 180, 157, 0.16)',
  switchTrack: '#42514B',
};

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  container: {
    flex: 1,
  },
  webView: {
    flex: 1,
  },
  overlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 14,
  },
  brand: {
    fontSize: 26,
    fontWeight: '700',
    letterSpacing: 4,
    marginBottom: 8,
  },
  errorTitle: {
    fontSize: 20,
    fontWeight: '600',
    textAlign: 'center',
  },
  message: {
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
  },
  retryButton: {
    minWidth: 144,
    minHeight: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 10,
    paddingHorizontal: 24,
  },
  retryText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  topControls: {
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  reminderBar: {
    minHeight: 48,
    paddingHorizontal: 24,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  reminderBarLabel: {
    fontSize: 15,
    fontWeight: '500',
  },
  reminderBarValue: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  reminderBarSummary: {
    fontSize: 16,
    fontWeight: '600',
  },
  chevron: {
    fontSize: 28,
    lineHeight: 30,
    marginTop: -2,
  },
  navigationBar: {
    minHeight: 52,
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  navigationButton: {
    minHeight: 34,
    minWidth: 72,
    borderRadius: 17,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 12,
  },
  navigationButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
  modalBackdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
    backgroundColor: 'rgba(0, 0, 0, 0.42)',
  },
  reminderPanel: {
    width: '100%',
    maxWidth: 420,
    borderRadius: 28,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 20,
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.24,
    shadowRadius: 32,
    elevation: 10,
  },
  reminderPanelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    marginBottom: 18,
  },
  reminderPanelTitleBlock: {
    flex: 1,
  },
  reminderPanelTitle: {
    fontSize: 21,
    fontWeight: '700',
    marginBottom: 6,
  },
  reminderPanelDescription: {
    fontSize: 13,
    lineHeight: 19,
  },
  reminderInputRow: {
    flexDirection: 'row',
    gap: 10,
  },
  reminderInputBlock: {
    flex: 1,
  },
  reminderInputLabel: {
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 6,
  },
  reminderInput: {
    minHeight: 48,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
  },
  quickRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 14,
  },
  quickButton: {
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  quickButtonText: {
    fontSize: 13,
    fontWeight: '600',
  },
  reminderStatus: {
    fontSize: 12,
    lineHeight: 18,
    marginTop: 14,
  },
  reminderError: {
    fontSize: 13,
    lineHeight: 18,
    marginTop: 10,
  },
  reminderActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    marginTop: 18,
  },
  secondaryButton: {
    minWidth: 86,
    minHeight: 44,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
  },
  secondaryButtonText: {
    fontSize: 15,
    fontWeight: '600',
  },
  primaryButton: {
    minWidth: 96,
    minHeight: 44,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
});
