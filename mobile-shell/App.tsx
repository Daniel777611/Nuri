import NetInfo from '@react-native-community/netinfo';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  BackHandler,
  Linking,
  Modal,
  NativeEventEmitter,
  NativeModules,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
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
  type NuriReminderSettings,
} from './src/push';

type ShellError = 'offline' | 'timeout' | 'web';
type ReminderFields = { hours: string; minutes: string; seconds: string };

const nativePushModule =
  Platform.OS === 'ios'
    ? (NativeModules.NuriPushBridge as NuriPushNativeModule | undefined)
    : undefined;
const nativePushEmitter = nativePushModule
  ? new NativeEventEmitter(nativePushModule)
  : null;
const MAX_REMINDER_SECONDS = 31_536_000;

function normalizeNumberInput(value: string): string {
  return value.replace(/[^\d]/g, '').slice(0, 7);
}

function secondsToFields(totalSeconds: number): ReminderFields {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds || 0));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;
  return {
    hours: hours ? String(hours) : '',
    minutes: minutes ? String(minutes) : '',
    seconds: seconds ? String(seconds) : '',
  };
}

function fieldsToSeconds(fields: ReminderFields): number {
  const hours = Number(fields.hours || 0);
  const minutes = Number(fields.minutes || 0);
  const seconds = Number(fields.seconds || 0);
  return hours * 3600 + minutes * 60 + seconds;
}

function formatInterval(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds || 0));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;
  const parts = [
    hours ? `${hours} 小时` : '',
    minutes ? `${minutes} 分钟` : '',
    seconds ? `${seconds} 秒` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' ') : '未设置';
}

export default function App() {
  const webViewRef = useRef<WebView>(null);
  const webViewLoadedRef = useRef(false);
  const currentPageUrlRef = useRef<string>(INITIAL_URL);
  const pushStateRef = useRef<NuriPushState | null>(null);
  const reminderSettingsRef = useRef<NuriReminderSettings | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const webContentTerminationDatesRef = useRef<number[]>([]);
  const [canGoBack, setCanGoBack] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ShellError | null>(null);
  const [currentUrl, setCurrentUrl] = useState<string>(INITIAL_URL);
  const [webViewRevision, setWebViewRevision] = useState(0);
  const [nativeReady, setNativeReady] = useState(!nativePushModule);
  const [reminderSettings, setReminderSettings] =
    useState<NuriReminderSettings | null>(null);
  const [reminderModalVisible, setReminderModalVisible] = useState(false);
  const [reminderEnabled, setReminderEnabled] = useState(false);
  const [reminderFields, setReminderFields] = useState<ReminderFields>(() =>
    secondsToFields(3600),
  );
  const [reminderSaving, setReminderSaving] = useState(false);
  const [reminderError, setReminderError] = useState<string | null>(null);
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
        | 'nuri:open-route'
        | 'nuri:reminder-settings',
      detail: NuriPushState | { route: string } | NuriReminderSettings,
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

  const acceptReminderSettings = useCallback(
    (settings: NuriReminderSettings) => {
      reminderSettingsRef.current = settings;
      setReminderSettings(settings);
      injectTrustedEvent('nuri:reminder-settings', settings);
    },
    [injectTrustedEvent],
  );

  const acceptPushState = useCallback(
    (state: unknown) => {
      if (!isNuriPushState(state)) {
        return;
      }
      pushStateRef.current = state;
      injectTrustedEvent('nuri:apns-token', state);
    },
    [injectTrustedEvent],
  );

  const refreshReminderSettings = useCallback(async () => {
    if (!nativePushModule) {
      return;
    }
    try {
      const settings = await nativePushModule.getReminderSettings();
      acceptReminderSettings(settings);
      setReminderEnabled(settings.enabled);
      setReminderFields(secondsToFields(settings.intervalSeconds || 3600));
    } catch {
      // The test reminder panel is optional; the web shell stays usable.
    }
  }, [acceptReminderSettings]);

  const openReminderModal = useCallback(() => {
    const settings = reminderSettingsRef.current;
    if (settings) {
      setReminderEnabled(settings.enabled);
      setReminderFields(secondsToFields(settings.intervalSeconds || 3600));
    }
    setReminderError(null);
    setReminderModalVisible(true);
    void refreshReminderSettings();
  }, [refreshReminderSettings]);

  const updateReminderField = useCallback(
    (field: keyof ReminderFields, value: string) => {
      setReminderFields((current) => ({
        ...current,
        [field]: normalizeNumberInput(value),
      }));
    },
    [],
  );

  const quickSetReminder = useCallback((seconds: number) => {
    setReminderFields(secondsToFields(seconds));
    setReminderEnabled(true);
    setReminderError(null);
  }, []);

  const saveReminderSettings = useCallback(async () => {
    if (!nativePushModule || reminderSaving) {
      return;
    }
    const intervalSeconds = fieldsToSeconds(reminderFields);
    if (
      reminderEnabled &&
      (intervalSeconds < 1 || intervalSeconds > MAX_REMINDER_SECONDS)
    ) {
      setReminderError('请输入 1 秒到 365 天之间的提醒间隔。');
      return;
    }

    setReminderSaving(true);
    setReminderError(null);
    try {
      const settings = await nativePushModule.updateReminderSettings(
        reminderEnabled,
        Math.max(1, intervalSeconds || reminderSettings?.intervalSeconds || 3600),
      );
      acceptReminderSettings(settings);
      setReminderEnabled(settings.enabled);
      setReminderFields(secondsToFields(settings.intervalSeconds || 3600));
      setReminderModalVisible(false);
    } catch (err) {
      setReminderError(
        err instanceof Error ? err.message : '保存失败，请稍后重试。',
      );
    } finally {
      setReminderSaving(false);
    }
  }, [
    acceptReminderSettings,
    reminderEnabled,
    reminderFields,
    reminderSaving,
    reminderSettings?.intervalSeconds,
  ]);

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
        void nativePushModule.refreshPushState().then(acceptPushState).catch(() => {
          // Notification registration is optional until Apple enables the capability.
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
      pushSubscription.remove();
      routeSubscription.remove();
      appStateSubscription.remove();
    };
  }, [acceptPushState, openNotificationRoute]);

  useEffect(() => {
    if (!nativeReady || !nativePushModule) {
      return;
    }
    void refreshReminderSettings();
  }, [nativeReady, refreshReminderSettings]);

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
    webViewLoadedRef.current = false;
    setError(null);
    setLoading(true);
    startLoadTimeout();
  }, [startLoadTimeout]);

  const handleLoadEnd = useCallback(() => {
    webViewLoadedRef.current = true;
    clearLoadTimeout();
    setError(null);
    setLoading(false);
    if (pushStateRef.current) {
      injectTrustedEvent('nuri:apns-token', pushStateRef.current);
    }
    if (reminderSettingsRef.current) {
      injectTrustedEvent('nuri:reminder-settings', reminderSettingsRef.current);
    }
  }, [clearLoadTimeout, injectTrustedEvent]);

  const handleWebMessage = useCallback(
    (event: WebViewMessageEvent) => {
      if (
        !isTrustedWebUrl(currentPageUrlRef.current) ||
        !isPushTokenRequest(event.nativeEvent.data) ||
        !pushStateRef.current
      ) {
        return;
      }
      injectTrustedEvent('nuri:apns-token', pushStateRef.current);
    },
    [injectTrustedEvent],
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
  const reminderDraftSeconds = fieldsToSeconds(reminderFields);
  const reminderSummary = reminderSettings
    ? reminderSettings.enabled
      ? `${formatInterval(reminderSettings.intervalSeconds)}`
      : '已关闭'
    : '设置';

  return (
    <View style={[styles.safeArea, { backgroundColor: palette.background }]}>
      <StatusBar style={dark ? 'light' : 'dark'} />
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

        {nativePushModule && nativeReady ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="打开测试提醒频率设置"
            onPress={openReminderModal}
            style={({ pressed }) => [
              styles.reminderFab,
              {
                backgroundColor: palette.panel,
                borderColor: palette.border,
                opacity: pressed ? 0.82 : 0.96,
                shadowColor: dark ? '#000000' : '#1D2A25',
              },
            ]}
          >
            <Text style={[styles.reminderFabTitle, { color: palette.text }]}>
              测试提醒
            </Text>
            <Text
              style={[styles.reminderFabSubtitle, { color: palette.secondaryText }]}
              numberOfLines={1}
            >
              {reminderSummary}
            </Text>
          </Pressable>
        ) : null}

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

        <Modal
          animationType="fade"
          transparent
          visible={reminderModalVisible}
          onRequestClose={() => setReminderModalVisible(false)}
        >
          <View style={styles.modalBackdrop}>
            <View
              style={[
                styles.reminderPanel,
                {
                  backgroundColor: palette.panel,
                  borderColor: palette.border,
                  shadowColor: dark ? '#000000' : '#1D2A25',
                },
              ]}
            >
              <View style={styles.reminderPanelHeader}>
                <View style={styles.reminderPanelTitleBlock}>
                  <Text style={[styles.reminderPanelTitle, { color: palette.text }]}>
                    测试提醒频率
                  </Text>
                  <Text
                    style={[
                      styles.reminderPanelDescription,
                      { color: palette.secondaryText },
                    ]}
                  >
                    用于测试阶段快速触发通知；后端 APNs 真实内容照常接收。
                  </Text>
                </View>
                <Switch
                  value={reminderEnabled}
                  onValueChange={(value) => {
                    setReminderEnabled(value);
                    setReminderError(null);
                  }}
                  trackColor={{
                    false: palette.switchTrack,
                    true: palette.accent,
                  }}
                  thumbColor="#FFFFFF"
                />
              </View>

              <View style={styles.reminderInputRow}>
                <ReminderInput
                  label="小时"
                  value={reminderFields.hours}
                  onChangeText={(value) => updateReminderField('hours', value)}
                  palette={palette}
                />
                <ReminderInput
                  label="分钟"
                  value={reminderFields.minutes}
                  onChangeText={(value) => updateReminderField('minutes', value)}
                  palette={palette}
                />
                <ReminderInput
                  label="秒"
                  value={reminderFields.seconds}
                  onChangeText={(value) => updateReminderField('seconds', value)}
                  palette={palette}
                />
              </View>

              <View style={styles.quickRow}>
                {[30, 60, 120].map((seconds) => (
                  <Pressable
                    key={seconds}
                    accessibilityRole="button"
                    onPress={() => quickSetReminder(seconds)}
                    style={({ pressed }) => [
                      styles.quickButton,
                      {
                        borderColor: palette.border,
                        backgroundColor: pressed ? palette.quickPressed : 'transparent',
                      },
                    ]}
                  >
                    <Text style={[styles.quickButtonText, { color: palette.text }]}>
                      {formatInterval(seconds)}
                    </Text>
                  </Pressable>
                ))}
              </View>

              <Text style={[styles.reminderStatus, { color: palette.secondaryText }]}>
                当前输入：{formatInterval(reminderDraftSeconds)}
                {reminderDraftSeconds < 60 && reminderDraftSeconds > 0
                  ? ' · iOS 会预排一批短间隔测试提醒'
                  : ''}
              </Text>

              {reminderError ? (
                <Text style={[styles.reminderError, { color: palette.danger }]}>
                  {reminderError}
                </Text>
              ) : null}

              <View style={styles.reminderActions}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setReminderModalVisible(false)}
                  style={({ pressed }) => [
                    styles.secondaryButton,
                    {
                      borderColor: palette.border,
                      opacity: pressed ? 0.75 : 1,
                    },
                  ]}
                >
                  <Text style={[styles.secondaryButtonText, { color: palette.text }]}>
                    取消
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void saveReminderSettings()}
                  disabled={reminderSaving}
                  style={({ pressed }) => [
                    styles.primaryButton,
                    {
                      backgroundColor: palette.accent,
                      opacity: reminderSaving || pressed ? 0.75 : 1,
                    },
                  ]}
                >
                  <Text style={styles.primaryButtonText}>
                    {reminderSaving ? '保存中…' : '保存'}
                  </Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
      </View>
    </View>
  );
}

function ReminderInput({
  label,
  value,
  onChangeText,
  palette,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  palette: typeof lightPalette;
}) {
  return (
    <View style={styles.reminderInputBlock}>
      <Text style={[styles.reminderInputLabel, { color: palette.secondaryText }]}>
        {label}
      </Text>
      <TextInput
        accessibilityLabel={`测试提醒间隔${label}`}
        keyboardType="number-pad"
        value={value}
        onChangeText={onChangeText}
        placeholder="0"
        placeholderTextColor={palette.placeholder}
        selectionColor={palette.accent}
        style={[
          styles.reminderInput,
          {
            color: palette.text,
            borderColor: palette.border,
            backgroundColor: palette.input,
          },
        ]}
      />
    </View>
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
  reminderFab: {
    position: 'absolute',
    right: 14,
    bottom: 28,
    minWidth: 108,
    maxWidth: 148,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 10,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.16,
    shadowRadius: 18,
    elevation: 6,
  },
  reminderFabTitle: {
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 2,
  },
  reminderFabSubtitle: {
    fontSize: 11,
    lineHeight: 14,
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
