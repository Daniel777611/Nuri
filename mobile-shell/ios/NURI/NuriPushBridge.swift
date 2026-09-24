import Foundation
import React
import Security
import UIKit
import UserNotifications

extension Notification.Name {
  static let nuriPushStateDidChange = Notification.Name("NuriPushStateDidChange")
  static let nuriNotificationRouteDidOpen = Notification.Name("NuriNotificationRouteDidOpen")
}

final class NuriPushStore {
  static let shared = NuriPushStore()

  private let tokenKey = "com.ordashtech.nuri.apns-token"
  private let tokenEnvironmentKey = "com.ordashtech.nuri.apns-token-environment"
  private let keychainService = "com.ordashtech.nuri.installation"
  private let keychainAccount = "installation-id"
  private let routeLock = NSLock()
  private var pendingRoute: String?

  private init() {}

  func updateDeviceToken(_ deviceToken: Data) {
    let token = deviceToken.map { String(format: "%02x", $0) }.joined()
    let environment = pushEnvironment()

    UserDefaults.standard.set(token, forKey: tokenKey)
    UserDefaults.standard.set(environment, forKey: tokenEnvironmentKey)
    notifyPushStateChanged()
  }

  func notifyPushStateChanged() {
    NotificationCenter.default.post(name: .nuriPushStateDidChange, object: nil)
  }

  func storeNotificationRoute(from userInfo: [AnyHashable: Any]) {
    guard let route = userInfo["route"] as? String, Self.isAllowedRoute(route) else {
      return
    }

    routeLock.lock()
    pendingRoute = route
    routeLock.unlock()

    NotificationCenter.default.post(
      name: .nuriNotificationRouteDidOpen,
      object: nil,
      userInfo: ["route": route]
    )
  }

  func consumePendingRoute() -> String? {
    routeLock.lock()
    defer { routeLock.unlock() }

    let route = pendingRoute
    pendingRoute = nil
    return route
  }

  func currentPushState(completion: @escaping ([String: Any]?) -> Void) {
    UNUserNotificationCenter.current().getNotificationSettings { [weak self] settings in
      guard let self else {
        completion(nil)
        return
      }

      let environment = self.pushEnvironment()
      guard
        let token = UserDefaults.standard.string(forKey: self.tokenKey),
        UserDefaults.standard.string(forKey: self.tokenEnvironmentKey) == environment,
        token.range(of: "^[0-9a-f]{32,256}$", options: .regularExpression) != nil
      else {
        completion(nil)
        return
      }

      let bundle = Bundle.main
      let state: [String: Any] = [
        "token": token,
        "environment": environment,
        "installationId": self.installationId(),
        "bundleId": bundle.bundleIdentifier ?? "com.ordashtech.nuri",
        "permissionStatus": Self.permissionStatus(settings.authorizationStatus),
        "timeZone": TimeZone.current.identifier,
        "appVersion": bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "",
        "buildNumber": bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "",
      ]
      completion(state)
    }
  }

  static func isAllowedRoute(_ route: String) -> Bool {
    guard
      route.hasPrefix("/notifications/"),
      route.first == "/",
      !route.contains(".."),
      !route.contains("://"),
      !route.contains("\\")
    else {
      return false
    }

    let decodedRoute = route.removingPercentEncoding ?? route
    return !decodedRoute.contains("..") && !decodedRoute.contains("://")
  }

  fileprivate static func permissionStatus(
    _ status: UNAuthorizationStatus
  ) -> String {
    switch status {
    case .notDetermined:
      return "not_determined"
    case .denied:
      return "denied"
    case .authorized:
      return "authorized"
    case .provisional, .ephemeral:
      return "provisional"
    @unknown default:
      return "not_determined"
    }
  }

  private func pushEnvironment() -> String {
    let configuredEnvironment = Bundle.main.object(
      forInfoDictionaryKey: "NuriAPNSEnvironment"
    ) as? String
    return configuredEnvironment == "production" ? "production" : "sandbox"
  }

  private func installationId() -> String {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: keychainService,
      kSecAttrAccount as String: keychainAccount,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]

    var item: CFTypeRef?
    if
      SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
      let data = item as? Data,
      let storedValue = String(data: data, encoding: .utf8),
      UUID(uuidString: storedValue) != nil
    {
      return storedValue
    }

    let value = UUID().uuidString.lowercased()
    let valueData = Data(value.utf8)
    let deleteQuery: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: keychainService,
      kSecAttrAccount as String: keychainAccount,
    ]
    SecItemDelete(deleteQuery as CFDictionary)

    var addQuery = deleteQuery
    addQuery[kSecValueData as String] = valueData
    addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    SecItemAdd(addQuery as CFDictionary, nil)
    return value
  }
}

/// Manages the tester-only on-device reminder cadence. These reminders are
/// deliberately labelled as test reminders; production notification title/body
/// content is still owned by backend APNs payloads.
final class NuriReminderScheduler {
  static let shared = NuriReminderScheduler()

  private struct Preferences {
    let enabled: Bool
    let intervalSeconds: Int
  }

  private struct SchedulePlan {
    let identifier: String
    let content: UNNotificationContent
    let repeatInterval: TimeInterval?
    let dueDate: Date?
  }

  typealias Completion = (Result<[String: Any], Error>) -> Void

  private let center = UNUserNotificationCenter.current()
  private let defaults = UserDefaults.standard
  private let queue = DispatchQueue(label: "com.ordashtech.nuri.local-reminder-settings")
  private let enabledKey = "com.ordashtech.nuri.reminder-enabled"
  private let intervalKey = "com.ordashtech.nuri.reminder-interval-seconds"
  private let legacyIntervalKey = "com.ordashtech.nuri.reminder-interval-minutes"
  private let reminderIdentifier = "com.ordashtech.nuri.local-reminder"
  private let batchIdentifierPrefix = "com.ordashtech.nuri.local-reminder.batch."
  private let legacyIdentifiers = [
    "com.ordashtech.nuri.hourly-test-reminder",
    "com.ordashtech.nuri.immediate-test-reminder",
  ]
  private let maximumIntervalSeconds = 31_536_000
  private let maximumPendingRequests = 64
  private let maximumBatchCount = 60
  private var operations: [() -> Void] = []
  private var operationRunning = false
  private var foregroundObserver: NSObjectProtocol?

  private init() {
    foregroundObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.didBecomeActiveNotification,
      object: nil,
      queue: nil
    ) { [weak self] _ in
      self?.restoreSavedSettings()
    }
  }

  // Serialize the whole asynchronous operation, not just its initial dispatch.
  // A launch/foreground restore reads preferences when its turn begins, so it
  // cannot overwrite a newer choice made in the settings sheet.
  private func enqueue(_ operation: @escaping () -> Void) {
    queue.async {
      self.operations.append(operation)
      self.runNextOperation()
    }
  }

  private func runNextOperation() {
    guard !operationRunning, !operations.isEmpty else { return }
    operationRunning = true
    operations.removeFirst()()
  }

  private func finishOperation() {
    operationRunning = false
    runNextOperation()
  }

  private func savedPreferences() -> Preferences {
    let interval: Int
    if defaults.object(forKey: intervalKey) != nil {
      interval = defaults.integer(forKey: intervalKey)
    } else {
      // Version 0.2.4 stored minutes. Convert lazily without changing the
      // installed repeating request or resetting its next delivery time.
      let oldMinutes = defaults.integer(forKey: legacyIntervalKey)
      interval = (1...(maximumIntervalSeconds / 60)).contains(oldMinutes)
        ? oldMinutes * 60 : 3600
    }
    return Preferences(
      enabled: defaults.bool(forKey: enabledKey),
      intervalSeconds: (1...maximumIntervalSeconds).contains(interval) ? interval : 3600
    )
  }

  private func save(_ preferences: Preferences) {
    defaults.set(preferences.enabled, forKey: enabledKey)
    defaults.set(preferences.intervalSeconds, forKey: intervalKey)
  }

  private func removeLegacyTests() {
    center.removePendingNotificationRequests(withIdentifiers: legacyIdentifiers)
    center.removeDeliveredNotifications(withIdentifiers: legacyIdentifiers)
  }

  func restoreSavedSettings() {
    enqueue {
      self.removeLegacyTests()
      self.apply(self.savedPreferences(), requestPermission: false) { result in
        if case .failure = result {
          NSLog("NURI local reminder: restore failed")
        }
        self.finishOperation()
      }
    }
  }

  func getSettings(completion: @escaping Completion) {
    enqueue {
      let preferences = self.savedPreferences()
      self.center.getNotificationSettings { settings in
        self.queue.async {
          self.snapshot(preferences, settings: settings) { state in
            completion(.success(state))
            self.finishOperation()
          }
        }
      }
    }
  }

  func updateSettings(
    enabled: Bool,
    intervalSeconds: NSNumber,
    completion: @escaping Completion
  ) {
    enqueue {
      // Validate before converting to Int, including non-finite/oversized input.
      let seconds = intervalSeconds.doubleValue
      guard seconds.isFinite,
        seconds.rounded(.towardZero) == seconds,
        seconds >= 1,
        seconds <= Double(self.maximumIntervalSeconds)
      else {
        completion(.failure(self.error(
          code: 1,
          message: "Enter a whole number of seconds between 1 and 31536000."
        )))
        self.finishOperation()
        return
      }

      self.removeLegacyTests()
      let preferences = Preferences(
        enabled: enabled,
        intervalSeconds: intervalSeconds.intValue
      )
      self.apply(preferences, requestPermission: true) { result in
        completion(result)
        self.finishOperation()
      }
    }
  }

  private func apply(
    _ preferences: Preferences,
    requestPermission: Bool,
    completion: @escaping Completion
  ) {
    center.getNotificationSettings { settings in
      self.queue.async {
        if preferences.enabled,
          requestPermission,
          settings.authorizationStatus == .notDetermined
        {
          self.center.requestAuthorization(options: [.alert, .badge, .sound]) { _, error in
            self.queue.async {
              if let error {
                completion(.failure(error))
                return
              }
              self.apply(preferences, requestPermission: false, completion: completion)
            }
          }
          return
        }

        self.center.getPendingNotificationRequests { requests in
          self.queue.async {
            guard preferences.enabled, self.canNotify(settings.authorizationStatus) else {
              self.cancelOwnedRequests(requests) {
                // Preserve the user's desired settings when OS permission is
                // denied, but accurately return scheduled=false.
                self.save(preferences)
                self.snapshot(preferences, settings: settings) { state in
                  self.logState(state, action: "disabled or permission unavailable")
                  completion(.success(state))
                }
              }
              return
            }

            let previous = self.savedPreferences()
            let matching = requests.filter { self.matches($0, preferences: preferences) }
            if previous.enabled,
              previous.intervalSeconds == preferences.intervalSeconds,
              !matching.isEmpty
            {
              // Keep every existing due date. In limited mode, only replenish
              // after the entire batch is exhausted and the app becomes active
              // again (or the user explicitly saves settings again).
              let matchingIDs = Set(matching.map(\.identifier))
              let staleIDs = requests.filter {
                self.isOwned($0.identifier) && !matchingIDs.contains($0.identifier)
              }.map(\.identifier)
              self.center.removePendingNotificationRequests(withIdentifiers: staleIDs)
              self.save(preferences)
              let state = self.state(preferences, settings: settings, requests: matching)
              self.logState(state, action: "retained; countdown unchanged")
              completion(.success(state))
              return
            }

            let unrelatedCount = requests.filter { !self.isOwned($0.identifier) }.count
            let freeSlots = max(0, self.maximumPendingRequests - unrelatedCount)
            let requestedCount = preferences.intervalSeconds < 60
              ? min(self.maximumBatchCount, freeSlots) : min(1, freeSlots)
            guard requestedCount > 0 else {
              completion(.failure(self.error(
                code: 2,
                message: "The notification queue is full. Other reminders were left unchanged."
              )))
              return
            }

            let previousPlans = requests.filter { self.isOwned($0.identifier) }
              .compactMap { self.planToRestore($0) }
            let plans = self.newPlans(preferences, count: requestedCount)
            self.cancelOwnedRequests(requests) {
              self.addPlans(plans) { result in
                if case .failure(let schedulingError) = result {
                  self.rollback(previousPlans, originalError: schedulingError, completion: completion)
                  return
                }
                // Commit only after the complete replacement batch succeeds.
                self.save(preferences)
                self.snapshot(preferences, settings: settings) { state in
                  self.logState(state, action: "scheduled")
                  completion(.success(state))
                }
              }
            }
          }
        }
      }
    }
  }

  private func canNotify(_ status: UNAuthorizationStatus) -> Bool {
    status == .authorized || status == .provisional || status == .ephemeral
  }

  private func matches(_ request: UNNotificationRequest, preferences: Preferences) -> Bool {
    guard let trigger = request.trigger as? UNTimeIntervalNotificationTrigger,
      request.content.userInfo["type"] as? String == "local_reminder"
    else {
      return false
    }

    if preferences.intervalSeconds >= 60 {
      // Accept the previous build's compatible hourly request without resetting.
      return request.identifier == reminderIdentifier && trigger.repeats
        && trigger.timeInterval == TimeInterval(preferences.intervalSeconds)
    }

    return request.identifier.hasPrefix(batchIdentifierPrefix)
      && !trigger.repeats
      && (request.content.userInfo["reminderSchema"] as? NSNumber)?.intValue == 2
      && (request.content.userInfo["intervalSeconds"] as? NSNumber)?.intValue == preferences.intervalSeconds
      && (dueDate(request)?.timeIntervalSinceNow ?? 0) > 0
  }

  private func isOwned(_ identifier: String) -> Bool {
    identifier == reminderIdentifier || identifier.hasPrefix(batchIdentifierPrefix)
  }

  private func dueDate(_ request: UNNotificationRequest) -> Date? {
    // nextTriggerDate() alone can rederive an interval from the current time.
    // Store the original absolute due date so repeated reads cannot extend it.
    if let timestamp = request.content.userInfo["reminderDueAt"] as? NSNumber {
      return Date(timeIntervalSince1970: timestamp.doubleValue)
    }
    return (request.trigger as? UNTimeIntervalNotificationTrigger)?.nextTriggerDate()
  }

  private func newPlans(_ preferences: Preferences, count: Int) -> [SchedulePlan] {
    guard preferences.enabled else { return [] }

    if preferences.intervalSeconds >= 60 {
      let content = notificationContent(preferences: preferences, dueDate: nil)
      return [
        SchedulePlan(
          identifier: reminderIdentifier,
          content: content,
          repeatInterval: TimeInterval(preferences.intervalSeconds),
          dueDate: nil
        ),
      ]
    }

    return (1...count).map { index in
      let dueDate = Date().addingTimeInterval(
        TimeInterval(preferences.intervalSeconds * index)
      )
      return SchedulePlan(
        identifier: "\(batchIdentifierPrefix)\(index)",
        content: notificationContent(preferences: preferences, dueDate: dueDate),
        repeatInterval: nil,
        dueDate: dueDate
      )
    }
  }

  private func notificationContent(
    preferences: Preferences,
    dueDate: Date?
  ) -> UNMutableNotificationContent {
    let content = UNMutableNotificationContent()
    content.title = "NURI 测试提醒"
    content.body = "这条用于验证提醒频率；真实通知内容由后端 APNs 发送。"
    content.sound = .default

    var userInfo: [String: Any] = [
      "type": "local_reminder",
      "reminderSchema": 2,
      "intervalSeconds": preferences.intervalSeconds,
    ]
    if let dueDate {
      userInfo["reminderDueAt"] = dueDate.timeIntervalSince1970
    }
    content.userInfo = userInfo
    return content
  }

  private func planToRestore(_ request: UNNotificationRequest) -> SchedulePlan? {
    guard let trigger = request.trigger as? UNTimeIntervalNotificationTrigger else { return nil }
    if trigger.repeats {
      guard trigger.timeInterval >= 60 else { return nil }
      return SchedulePlan(
        identifier: request.identifier, content: request.content,
        repeatInterval: trigger.timeInterval, dueDate: nil
      )
    }
    guard let date = dueDate(request), date.timeIntervalSinceNow > 0 else { return nil }
    return SchedulePlan(
      identifier: request.identifier, content: request.content,
      repeatInterval: nil, dueDate: date
    )
  }

  private func cancelOwnedRequests(_ requests: [UNNotificationRequest], completion: @escaping () -> Void) {
    center.removePendingNotificationRequests(
      withIdentifiers: requests.filter { isOwned($0.identifier) }.map(\.identifier)
    )
    center.getDeliveredNotifications { notifications in
      self.queue.async {
        let identifiers = notifications.map { $0.request.identifier }.filter { self.isOwned($0) }
        self.center.removeDeliveredNotifications(withIdentifiers: identifiers)
        completion()
      }
    }
  }

  private func addPlans(
    _ plans: [SchedulePlan],
    index: Int = 0,
    completion: @escaping (Result<Void, Error>) -> Void
  ) {
    guard index < plans.count else {
      completion(.success(()))
      return
    }
    let plan = plans[index]
    // A one-shot which elapsed during a slow scheduling/rollback operation is
    // skipped, never converted into an immediate burst of stale reminders.
    if plan.repeatInterval == nil, (plan.dueDate?.timeIntervalSinceNow ?? 0) <= 0 {
      addPlans(plans, index: index + 1, completion: completion)
      return
    }
    center.getPendingNotificationRequests { pending in
      self.queue.async {
        guard pending.count < self.maximumPendingRequests
          || pending.contains(where: { $0.identifier == plan.identifier })
        else {
          completion(.failure(self.error(code: 2, message: "The notification queue is full.")))
          return
        }
        let interval: TimeInterval
        if let repeatingInterval = plan.repeatInterval {
          interval = repeatingInterval
        } else {
          guard let remaining = plan.dueDate?.timeIntervalSinceNow, remaining > 0 else {
            self.addPlans(plans, index: index + 1, completion: completion)
            return
          }
          interval = remaining
        }
        let request = UNNotificationRequest(
          identifier: plan.identifier,
          content: plan.content,
          trigger: UNTimeIntervalNotificationTrigger(
            timeInterval: interval, repeats: plan.repeatInterval != nil
          )
        )
        self.center.add(request) { error in
          self.queue.async {
            if let error {
              completion(.failure(error))
            } else {
              self.addPlans(plans, index: index + 1, completion: completion)
            }
          }
        }
      }
    }
  }

  private func rollback(
    _ previousPlans: [SchedulePlan],
    originalError: Error,
    completion: @escaping Completion
  ) {
    center.getPendingNotificationRequests { pending in
      self.queue.async {
        self.cancelOwnedRequests(pending) {
          self.addPlans(previousPlans) { result in
            if case .failure = result {
              // Preferences still reflect the prior user choice. Clear a
              // partial rollback so the UI can truthfully report unscheduled.
              self.center.getPendingNotificationRequests { restored in
                self.queue.async {
                  self.cancelOwnedRequests(restored) {
                    NSLog("NURI local reminder: replacement and rollback failed; settings retained, scheduled=false")
                    completion(.failure(self.error(
                      code: 3,
                      message: "The change failed and the previous schedule could not be restored. Your previous settings were kept; reopen the app to retry."
                    )))
                  }
                }
              }
            } else {
              NSLog("NURI local reminder: change failed; previous schedule restored where still pending")
              completion(.failure(originalError))
            }
          }
        }
      }
    }
  }

  private func error(code: Int, message: String) -> NSError {
    NSError(domain: "NuriReminderSettings", code: code, userInfo: [NSLocalizedDescriptionKey: message])
  }

  private func logState(_ state: [String: Any], action: String) {
    NSLog(
      "NURI local reminder: %@ intervalSeconds=%@ mode=%@ pendingCount=%@ scheduled=%@",
      action,
      String(describing: state["intervalSeconds"] ?? 0),
      String(describing: state["mode"] ?? "unknown"),
      String(describing: state["pendingCount"] ?? 0),
      String(describing: state["scheduled"] ?? false)
    )
  }

  private func snapshot(
    _ preferences: Preferences,
    settings: UNNotificationSettings,
    completion: @escaping ([String: Any]) -> Void
  ) {
    center.getPendingNotificationRequests { requests in
      self.queue.async {
        completion(self.state(preferences, settings: settings, requests: requests))
      }
    }
  }

  private func state(
    _ preferences: Preferences,
    settings: UNNotificationSettings,
    requests: [UNNotificationRequest]
  ) -> [String: Any] {
    let matching = requests.filter { matches($0, preferences: preferences) }
    let limited = preferences.intervalSeconds < 60
    let lastDueOffset = limited
      ? matching.compactMap { dueDate($0)?.timeIntervalSinceNow }.max() ?? 0 : 0
    return [
      "enabled": preferences.enabled,
      "intervalSeconds": preferences.intervalSeconds,
      "permissionStatus": NuriPushStore.permissionStatus(settings.authorizationStatus),
      "scheduled": preferences.enabled && canNotify(settings.authorizationStatus) && !matching.isEmpty,
      "mode": limited ? "limited" : "repeating",
      "pendingCount": matching.count,
      "coverageSeconds": Int(ceil(max(0, lastDueOffset))),
    ]
  }
}

@objc(NuriPushBridge)
final class NuriPushBridge: RCTEventEmitter {
  private var hasListeners = false

  override static func requiresMainQueueSetup() -> Bool {
    true
  }

  override func supportedEvents() -> [String]! {
    ["nuriPushStateChanged", "nuriNotificationRouteOpened"]
  }

  override func startObserving() {
    hasListeners = true
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(pushStateDidChange),
      name: .nuriPushStateDidChange,
      object: nil
    )
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(notificationRouteDidOpen(_:)),
      name: .nuriNotificationRouteDidOpen,
      object: nil
    )
  }

  override func stopObserving() {
    hasListeners = false
    NotificationCenter.default.removeObserver(self)
  }

  @objc(getInitialState:rejecter:)
  func getInitialState(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    let route = NuriPushStore.shared.consumePendingRoute()
    NuriPushStore.shared.currentPushState { state in
      let result: [String: Any] = [
        "pushState": state ?? NSNull(),
        "route": route ?? NSNull(),
      ]
      resolve(result)
    }
  }

  @objc(refreshPushState:rejecter:)
  func refreshPushState(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    NuriPushStore.shared.currentPushState { state in
      resolve(state ?? NSNull())
    }
  }

  @objc(getReminderSettings:rejecter:)
  func getReminderSettings(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    NuriReminderScheduler.shared.getSettings { result in
      switch result {
      case .success(let state): resolve(state)
      case .failure(let error): reject("REMINDER_SETTINGS_FAILED", error.localizedDescription, error)
      }
    }
  }

  @objc(updateReminderSettings:intervalSeconds:resolver:rejecter:)
  func updateReminderSettings(
    _ enabled: Bool,
    intervalSeconds: NSNumber,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    NuriReminderScheduler.shared.updateSettings(
      enabled: enabled,
      intervalSeconds: intervalSeconds
    ) { result in
      switch result {
      case .success(let state): resolve(state)
      case .failure(let error): reject("REMINDER_SETTINGS_FAILED", error.localizedDescription, error)
      }
    }
  }

  @objc(requestPushRegistration:rejecter:)
  func requestPushRegistration(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    let center = UNUserNotificationCenter.current()
    center.requestAuthorization(options: [.alert, .badge, .sound]) { _, _ in
      DispatchQueue.main.async {
        UIApplication.shared.registerForRemoteNotifications()
      }
      NuriPushStore.shared.notifyPushStateChanged()
      NuriPushStore.shared.currentPushState { state in
        resolve(state ?? NSNull())
      }
    }
  }

  @objc private func pushStateDidChange() {
    guard hasListeners else {
      return
    }

    NuriPushStore.shared.currentPushState { [weak self] state in
      guard let self, self.hasListeners, let state else {
        return
      }
      self.sendEvent(withName: "nuriPushStateChanged", body: state)
    }
  }

  @objc private func notificationRouteDidOpen(_ notification: Notification) {
    guard
      hasListeners,
      let route = notification.userInfo?["route"] as? String,
      NuriPushStore.isAllowedRoute(route)
    else {
      return
    }

    sendEvent(
      withName: "nuriNotificationRouteOpened",
      body: ["route": route]
    )
  }
}
