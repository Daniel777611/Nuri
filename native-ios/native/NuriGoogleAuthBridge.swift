import Foundation
import React

// Only public OAuth configuration is exposed. Credentials and provider tokens
// stay in the Google SDK / the in-memory exchange, never in this bridge.
@objc(NuriGoogleAuthBridge)
final class NuriGoogleAuthBridge: NSObject {
  @objc static func requiresMainQueueSetup() -> Bool { false }

  @objc(getConfiguration:rejecter:)
  func getConfiguration(
    _ resolve: RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    let bundle = Bundle.main
    let iosClientID = bundle.object(forInfoDictionaryKey: "GIDClientID") as? String ?? ""
    let webClientID = bundle.object(forInfoDictionaryKey: "GIDServerClientID") as? String ?? ""
    let reversedID = iosClientID.split(separator: ".").reversed().joined(separator: ".")
    let urlTypes = bundle.object(forInfoDictionaryKey: "CFBundleURLTypes") as? [[String: Any]] ?? []
    let schemes = urlTypes.flatMap { $0["CFBundleURLSchemes"] as? [String] ?? [] }
    resolve([
      "bundleId": bundle.bundleIdentifier ?? "",
      "iosClientId": iosClientID,
      "webClientId": webClientID,
      "callbackRegistered": !iosClientID.isEmpty && schemes.contains(reversedID),
    ])
  }
}
