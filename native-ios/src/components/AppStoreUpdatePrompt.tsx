import { useEffect, useRef } from "react";
import * as Application from "expo-application";
import Constants from "expo-constants";
import { Alert, AppState, Linking, NativeModules, Platform } from "react-native";
import { useT, type Locale } from "@/src/i18n";
import { getStorefront } from "@/src/nativeShell";
import { appStoreUpdateURL, findAppStoreUpdate } from "@/src/release/appStoreUpdate";
import { findTestFlightUpdate, testFlightChannelForFlavor, testFlightChannels, testFlightUpdateURLs, type TestFlightChannel } from "@/src/release/testflightUpdate";
import { storage } from "@/src/utils/storage";

const checkInterval = 15 * 60 * 1000;
const remindAfter = 24 * 60 * 60 * 1000;
const copy = {
  en: {
    title: "Nuri update available",
    message: (version: string) => `Version ${version} is available on the App Store.`,
    testFlightMessage: (version: string) => `Version ${version} is available in TestFlight.`,
    now: "Update Now", later: "Later",
    storeUnavailable: "Could not open the App Store. Please try again later.",
    testFlightUnavailable: "Could not open TestFlight. Please try again later.",
  },
  "zh-CN": {
    title: "Nuri 有新版本",
    message: (version: string) => `版本 ${version} 已在 App Store 上线。`,
    testFlightMessage: (version: string) => `版本 ${version} 已在 TestFlight 上线。`,
    now: "现在更新", later: "稍后再说",
    storeUnavailable: "暂时无法打开 App Store，请稍后再试。",
    testFlightUnavailable: "暂时无法打开 TestFlight，请稍后再试。",
  },
  "zh-TW": {
    title: "Nuri 有新版本",
    message: (version: string) => `版本 ${version} 已在 App Store 上架。`,
    testFlightMessage: (version: string) => `版本 ${version} 已在 TestFlight 上架。`,
    now: "立即更新", later: "稍後再說",
    storeUnavailable: "暫時無法開啟 App Store，請稍後再試。",
    testFlightUnavailable: "暫時無法開啟 TestFlight，請稍後再試。",
  },
} satisfies Record<Locale, {
  title: string; message: (version: string) => string; testFlightMessage: (version: string) => string;
  now: string; later: string; storeUnavailable: string; testFlightUnavailable: string;
}>;

type UpdateTarget = { version: string; reminderKey: string; testFlightChannel?: TestFlightChannel };

export function AppStoreUpdatePrompt({ enabled }: { enabled: boolean }) {
  const { locale } = useT();
  const currentLocale = useRef(locale);
  const lastCheck = useRef<number | null>(null);
  const promptOwner = useRef<object | null>(null);
  const reminder = useRef<{ key: string; until: number } | null>(null);
  currentLocale.current = locale;

  useEffect(() => {
    const flavor = process.env.EXPO_PUBLIC_RELEASE_FLAVOR;
    const testFlightChannel = testFlightChannelForFlavor(flavor);
    if (!enabled || Platform.OS !== "ios" || (!testFlightChannel && flavor !== "app-store")) return;
    const bridge = NativeModules.NuriPushBridge as { getInstalledAppVersion?: () => Promise<unknown> } | undefined;
    if (!testFlightChannel && !bridge?.getInstalledAppVersion) return;
    const trusted = testFlightChannel ? testFlightChannels[testFlightChannel] : null;
    // Embedded configuration must agree with the native app's own bundle ID.
    // EXApplication reads version/build/identity directly from the signed binary,
    // independent of Expo manifests and the optional custom Pro version bridge.
    if (trusted && (Constants.expoConfig?.ios?.bundleIdentifier !== trusted.bundleId
        || Constants.expoConfig?.extra?.releaseFlavor !== trusted.flavor
        || Constants.expoConfig?.extra?.releaseChannel !== trusted.releaseChannel
        || Application.applicationId !== trusted.bundleId)) return;

    let mounted = true;
    let generation = 0;
    let inFlight: AbortController | undefined;
    const cancelRequest = () => {
      generation += 1;
      inFlight?.abort();
      inFlight = undefined;
    };

    const check = async () => {
      if (!mounted || AppState.currentState !== "active" || inFlight || promptOwner.current
          || (lastCheck.current !== null && Date.now() - lastCheck.current < checkInterval)) return;
      const request = new AbortController();
      const ticket = ++generation;
      inFlight = request;
      const current = () => mounted && ticket === generation && inFlight === request
        && !request.signal.aborted && AppState.currentState === "active";
      const timeout = setTimeout(() => {
        if (inFlight === request) cancelRequest();
      }, 5000);
      let attemptedPrompt: object | null = null;
      try {
        let target: UpdateTarget | null = null;
        if (testFlightChannel && trusted) {
          const installed = Application.nativeApplicationVersion;
          const build = Application.nativeBuildVersion;
          const bundleId = Application.applicationId;
          if (!current() || typeof installed !== "string" || typeof build !== "string" || bundleId !== trusted.bundleId) return;
          const update = await findTestFlightUpdate(testFlightChannel, {
            bundleId, version: installed, build,
          }, String(Platform.Version), request.signal);
          if (!current()) return;
          if (update) target = {
            version: `${update.version} (${update.build})`, testFlightChannel,
            reminderKey: `testflight-update-reminder.${testFlightChannel}.${update.version}.${update.build}`,
          };
        } else {
          const [country, installed] = await Promise.all([getStorefront(), bridge?.getInstalledAppVersion?.()]);
          if (!current() || !country || typeof installed !== "string") return;
          const version = await findAppStoreUpdate(country, installed, String(Platform.Version), request.signal);
          if (!current()) return;
          if (version) target = { version, reminderKey: `app-store-update-reminder.${version}` };
        }
        if (!current()) return;
        if (!target) { lastCheck.current = Date.now(); return; }

        const { reminderKey: key } = target;
        const savedUntil = await storage.getItem(key, 0);
        // Backgrounding, disabling or a newer request invalidates storage reads
        // too; their late completion must never open an obsolete alert.
        if (!current()) return;
        lastCheck.current = Date.now();
        if ((typeof savedUntil === "number" && savedUntil > Date.now())
            || (reminder.current?.key === key && reminder.current.until > Date.now())) return;

        const strings = copy[currentLocale.current];
        const owner = {};
        const ownsPrompt = () => mounted && promptOwner.current === owner;
        const snooze = () => {
          if (!ownsPrompt()) return;
          const until = Date.now() + remindAfter;
          reminder.current = { key, until };
          promptOwner.current = null;
          void storage.setItem(key, until).catch(() => {});
        };
        const openUpdate = async () => {
          if (target.testFlightChannel) {
            const links = testFlightUpdateURLs(target.testFlightChannel);
            try { await Linking.openURL(links.native); }
            catch { if (ownsPrompt()) await Linking.openURL(links.https); }
          } else await Linking.openURL(appStoreUpdateURL);
        };
        attemptedPrompt = owner;
        promptOwner.current = owner;
        Alert.alert(strings.title, target.testFlightChannel ? strings.testFlightMessage(target.version) : strings.message(target.version), [
          { text: strings.later, style: "cancel", onPress: snooze },
          { text: strings.now, onPress: () => {
            if (!ownsPrompt()) return;
            void openUpdate().then(snooze, () => {
              if (!ownsPrompt()) return;
              promptOwner.current = null;
              if (AppState.currentState === "active") {
                Alert.alert(strings.title, target.testFlightChannel ? strings.testFlightUnavailable : strings.storeUnavailable);
              }
            });
          } },
        ]);
      } catch {
        if (attemptedPrompt && promptOwner.current === attemptedPrompt) promptOwner.current = null;
        // Optional version checks never interrupt startup or the current page.
      } finally {
        clearTimeout(timeout);
        if (inFlight === request) inFlight = undefined;
      }
    };

    const subscription = AppState.addEventListener("change", state => {
      if (state === "active") void check();
      else cancelRequest();
    });
    void check();
    return () => {
      mounted = false;
      subscription.remove();
      cancelRequest();
      promptOwner.current = null;
    };
  }, [enabled]);
  return null;
}
