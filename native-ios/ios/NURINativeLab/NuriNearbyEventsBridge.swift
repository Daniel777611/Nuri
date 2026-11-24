import CoreLocation
import Foundation
import React
import UserNotifications

@objc(NuriNearbyEventsBridge)
final class NuriNearbyEventsBridge: NSObject, CLLocationManagerDelegate {
  private let reminderPrefix = "nuri-alpha-nearby."
  private let reminderHistoryKey = "nuri-alpha-nearby.history"
  private var manager: CLLocationManager?
  private var geocoder: CLGeocoder?
  private var localityReply: RCTPromiseResolveBlock?
  private var localityTimeout: DispatchWorkItem?
  private var requestedLocation = false
  private var reminderRevision = 0

  @objc static func requiresMainQueueSetup() -> Bool { true }

  private var isAlpha: Bool {
    Bundle.main.bundleIdentifier == "com.ordashtech.nuri.beta"
      && Bundle.main.object(forInfoDictionaryKey: "NuriReleaseFlavor") as? String == "live-alpha"
  }

  @objc func getLocationPermission(
    _ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      guard self.isAlpha else { resolve("unavailable"); return }
      resolve(self.permission(CLLocationManager().authorizationStatus))
    }
  }

  @objc func resolveNearbyLocality(
    _ askPermission: Bool, resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      guard self.isAlpha else { resolve(["status": "unavailable"]); return }
      self.finishLocality("cancelled")
      let manager = CLLocationManager()
      self.manager = manager
      self.localityReply = resolve
      self.requestedLocation = false
      manager.desiredAccuracy = kCLLocationAccuracyThreeKilometers
      manager.delegate = self
      let deadline = DispatchWorkItem { [weak self] in self?.finishLocality("unavailable") }
      self.localityTimeout = deadline
      DispatchQueue.main.asyncAfter(deadline: .now() + 25, execute: deadline)

      if manager.authorizationStatus == .notDetermined {
        if askPermission { manager.requestWhenInUseAuthorization() }
        else { self.finishLocality("not_determined") }
      } else {
        self.advance(manager)
      }
    }
  }

  @objc func cancelLocality(
    _ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async { self.finishLocality("cancelled"); resolve(nil) }
  }

  private func permission(_ status: CLAuthorizationStatus) -> String {
    switch status {
    case .authorizedAlways, .authorizedWhenInUse: return "authorized"
    case .denied, .restricted: return "denied"
    case .notDetermined: return "not_determined"
    @unknown default: return "unavailable"
    }
  }

  private func advance(_ manager: CLLocationManager) {
    guard self.manager === manager else { return }
    switch permission(manager.authorizationStatus) {
    case "authorized":
      guard !requestedLocation else { return }
      requestedLocation = true
      manager.requestLocation()
    case "not_determined":
      break // iOS may report its initial state while the prompt is open.
    case let state:
      finishLocality(state)
    }
  }

  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    advance(manager)
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    guard self.manager === manager else { return }
    finishLocality(permission(manager.authorizationStatus) == "denied" ? "denied" : "unavailable")
  }

  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    guard self.manager === manager, geocoder == nil else { return }
    guard let location = locations.last(where: {
      $0.horizontalAccuracy >= 0 && abs($0.timestamp.timeIntervalSinceNow) < 180
    }) else { finishLocality("unavailable"); return }
    let lookup = CLGeocoder()
    geocoder = lookup
    lookup.reverseGeocodeLocation(location) { [weak self, weak manager] placemarks, _ in
      DispatchQueue.main.async {
        guard let self, let manager, self.manager === manager else { return }
        guard self.permission(manager.authorizationStatus) == "authorized" else {
          self.finishLocality("denied")
          return
        }
        guard let place = placemarks?.first,
              let city = place.locality?.trimmingCharacters(in: .whitespacesAndNewlines), !city.isEmpty,
              let country = place.isoCountryCode, country.range(of: "^[A-Z]{2}$", options: .regularExpression) != nil
        else { self.finishLocality("unavailable"); return }
        // Coordinates, street, postal code and sub-locality never cross the bridge.
        self.finishLocality("authorized", [
          "city": city,
          "region": place.administrativeArea ?? "",
          "country": country,
        ])
      }
    }
  }

  private func finishLocality(_ status: String, _ locality: [String: String]? = nil) {
    let reply = localityReply
    localityReply = nil
    localityTimeout?.cancel()
    localityTimeout = nil
    manager?.delegate = nil
    manager?.stopUpdatingLocation()
    manager = nil
    geocoder?.cancelGeocode()
    geocoder = nil
    var result: [String: Any] = ["status": status]
    if let locality { result["locality"] = locality }
    reply?(result)
  }

  @objc func requestNearbyNotificationPermission(
    _ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock
  ) {
    guard isAlpha else { resolve(false); return }
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) {
      allowed, error in
      if error != nil { resolve(false) } else { resolve(allowed) }
    }
  }

  @objc func cancelNearbyReminders(
    _ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      guard self.isAlpha else { resolve(nil); return }
      self.reminderRevision += 1
      let center = UNUserNotificationCenter.current()
      center.getPendingNotificationRequests { requests in
        center.removePendingNotificationRequests(withIdentifiers: requests
          .map(\.identifier).filter { $0.hasPrefix(self.reminderPrefix) })
        center.getDeliveredNotifications { delivered in
          center.removeDeliveredNotifications(withIdentifiers: delivered
            .map { $0.request.identifier }.filter { $0.hasPrefix(self.reminderPrefix) })
          resolve(nil)
        }
      }
    }
  }

  @objc func scheduleNearbyReminder(
    _ eventID: String, dateMs: NSNumber, title: String, body: String,
    resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      let delay = dateMs.doubleValue / 1_000 - Date().timeIntervalSince1970
      guard self.isAlpha, delay.isFinite, delay >= 30, delay <= 30 * 86400,
            eventID.range(of: "^[a-f0-9]{24}$", options: .regularExpression) != nil,
            (1...100).contains(title.count), (1...200).contains(body.count)
      else { resolve(false); return }
      let now = Date().timeIntervalSince1970
      let defaults = UserDefaults.standard
      let previous = defaults.dictionary(forKey: self.reminderHistoryKey) as? [String: TimeInterval] ?? [:]
      // Hashes only. A notice that was due already cannot be scheduled again
      // even when the parent cleared the delivered item from Notification Center.
      if let prior = previous[eventID], prior <= now { resolve(false); return }
      let center = UNUserNotificationCenter.current()
      let revision = self.reminderRevision
      let identifier = self.reminderPrefix + eventID
      center.getNotificationSettings { settings in
        DispatchQueue.main.async {
          guard revision == self.reminderRevision,
                [.authorized, .provisional, .ephemeral].contains(settings.authorizationStatus)
          else { resolve(false); return }
          let timeLeft = dateMs.doubleValue / 1_000 - Date().timeIntervalSince1970
          guard timeLeft >= 30 else { resolve(false); return }
          let content = UNMutableNotificationContent()
          content.title = title
          content.body = body
          content.sound = .default
          content.threadIdentifier = "nuri-nearby-activities"
          content.userInfo = ["route": "/notifications/nearby-activities"]
          let request = UNNotificationRequest(identifier: identifier, content: content,
            trigger: UNTimeIntervalNotificationTrigger(timeInterval: timeLeft, repeats: false))
          center.add(request) { error in
            DispatchQueue.main.async {
              guard revision == self.reminderRevision else {
                center.removePendingNotificationRequests(withIdentifiers: [identifier])
                resolve(false)
                return
              }
              guard error == nil else { resolve(false); return }
              var history = previous.filter { (_, due) in due >= now - 30 * 86400 && due <= now }
              history[eventID] = dateMs.doubleValue / 1_000
              defaults.set(history, forKey: self.reminderHistoryKey)
              center.getPendingNotificationRequests { requests in
                DispatchQueue.main.async {
                  guard revision == self.reminderRevision else { resolve(false); return }
                  center.removePendingNotificationRequests(withIdentifiers: requests.map(\.identifier)
                    .filter { $0.hasPrefix(self.reminderPrefix) && $0 != identifier })
                  resolve(true)
                }
              }
            }
          }
        }
      }
    }
  }
}
