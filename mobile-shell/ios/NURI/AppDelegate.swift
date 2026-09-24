internal import Expo
import React
import ReactAppDependencyProvider
import UserNotifications

@main
class AppDelegate: ExpoAppDelegate, UNUserNotificationCenterDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

    let didFinishLaunching = super.application(
      application,
      didFinishLaunchingWithOptions: launchOptions
    )
    configureNotifications(launchOptions: launchOptions)

    return didFinishLaunching
  }

  private func configureNotifications(
    launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) {
    let notificationCenter = UNUserNotificationCenter.current()
    notificationCenter.delegate = self

    if
      let userInfo = launchOptions?[.remoteNotification] as? [AnyHashable: Any]
    {
      NuriPushStore.shared.storeNotificationRoute(from: userInfo)
    }

    NuriReminderScheduler.shared.restoreSavedSettings()

    notificationCenter.requestAuthorization(options: [.alert, .badge, .sound]) { _, _ in
      DispatchQueue.main.async {
        UIApplication.shared.registerForRemoteNotifications()
      }
      NuriPushStore.shared.notifyPushStateChanged()
      NuriReminderScheduler.shared.restoreSavedSettings()
    }
  }

  public override func application(
    _ application: UIApplication,
    didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    super.application(
      application,
      didRegisterForRemoteNotificationsWithDeviceToken: deviceToken
    )
    NuriPushStore.shared.updateDeviceToken(deviceToken)
  }

  public override func application(
    _ application: UIApplication,
    didFailToRegisterForRemoteNotificationsWithError error: Error
  ) {
    super.application(
      application,
      didFailToRegisterForRemoteNotificationsWithError: error
    )
    NuriPushStore.shared.notifyPushStateChanged()
  }

  public func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    if notification.request.content.userInfo["type"] as? String == "local_reminder" {
      NSLog("NURI local reminder suppressed")
      completionHandler([])
      return
    }
    completionHandler([.banner, .list, .sound])
  }

  public func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    NuriPushStore.shared.storeNotificationRoute(
      from: response.notification.request.content.userInfo
    )
    completionHandler()
  }

  // Linking API
  public override func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    return super.application(app, open: url, options: options) || RCTLinkingManager.application(app, open: url, options: options)
  }

  // Universal Links
  public override func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    let result = RCTLinkingManager.application(application, continue: userActivity, restorationHandler: restorationHandler)
    return super.application(application, continue: userActivity, restorationHandler: restorationHandler) || result
  }
}

class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {
  // Extension point for config-plugins

  override func sourceURL(for bridge: RCTBridge) -> URL? {
    // needed to return the correct URL for expo-dev-client.
    bridge.bundleURL ?? bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: ".expo/.virtual-metro-entry")
#else
    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
