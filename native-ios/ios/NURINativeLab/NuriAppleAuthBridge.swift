import AuthenticationServices
import CryptoKit
import Foundation
import React
import UIKit

@objc(NuriAppleAuthBridge)
final class NuriAppleAuthBridge: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
  private var controller: ASAuthorizationController?
  private var window: UIWindow?
  private var resolve: RCTPromiseResolveBlock?
  private var reject: RCTPromiseRejectBlock?
  private var state: String?

  @objc static func requiresMainQueueSetup() -> Bool { false }

  @objc(authorize:resolver:rejecter:)
  func authorize(_ nonce: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      guard self.controller == nil else {
        reject("APPLE_SIGNIN_IN_PROGRESS", "Apple sign-in is already in progress.", nil)
        return
      }
      guard nonce.utf8.count >= 24, nonce.utf8.count <= 256,
            let window = UIApplication.shared.connectedScenes
              .compactMap({ $0 as? UIWindowScene })
              .filter({ $0.activationState == .foregroundActive })
              .flatMap(\.windows).first(where: \.isKeyWindow) else {
        reject("APPLE_SIGNIN_UNAVAILABLE", "Apple sign-in is unavailable.", nil)
        return
      }

      let request = ASAuthorizationAppleIDProvider().createRequest()
      request.requestedScopes = [.email, .fullName]
      request.nonce = SHA256.hash(data: Data(nonce.utf8)).map { String(format: "%02x", $0) }.joined()
      let state = UUID().uuidString
      request.state = state
      let controller = ASAuthorizationController(authorizationRequests: [request])
      self.controller = controller
      self.window = window
      self.resolve = resolve
      self.reject = reject
      self.state = state
      controller.delegate = self
      controller.presentationContextProvider = self
      controller.performRequests()
    }
  }

  func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
    window ?? UIWindow()
  }

  func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
    guard controller === self.controller else { return }
    defer { clearRequest() }
    guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
          credential.state == state,
          let tokenBytes = credential.identityToken,
          let token = String(data: tokenBytes, encoding: .utf8),
          let codeBytes = credential.authorizationCode,
          let code = String(data: codeBytes, encoding: .utf8) else {
      reject?("APPLE_TOKEN_INVALID", "Apple did not return valid credentials.", nil)
      return
    }
    var result = ["identity_token": token, "authorization_code": code]
    result["first_name"] = credential.fullName?.givenName
    result["last_name"] = credential.fullName?.familyName
    resolve?(result)
  }

  func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
    guard controller === self.controller else { return }
    defer { clearRequest() }
    if (error as? ASAuthorizationError)?.code == .canceled {
      resolve?(NSNull())
    } else {
      reject?("APPLE_SIGNIN_FAILED", "Apple sign-in did not complete.", nil)
    }
  }

  private func clearRequest() {
    controller = nil
    window = nil
    resolve = nil
    reject = nil
    state = nil
  }
}
