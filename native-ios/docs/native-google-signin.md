# Native Google sign-in (configuration gate)

The iOS implementation uses `@react-native-google-signin/google-signin` 16.1.5 and Google's native iOS SDK. It does not load the web GIS script, a DOM button, or an embedded OAuth WebView. The login and registration pages share this native flow.

Implementation and isolated tests are present. On 2026-10-05, with the user's action-time confirmation, the Native Lab iOS OAuth client was created in the existing company Google project `nifty-canyon-510623-c2`; the existing `Nuri web` client was left unchanged. The two public IDs are configured in `app.json`. **Google sign-in is not yet confirmed operational:** an authorized real login and backend audience acceptance still need verification. The project remains External/Testing. Its generic test-user warning does not establish that other accounts are blocked: Google's basic identity-scope exception applies to this implementation's default `email profile` scopes. No test-user list or publishing status was changed. Workspace or Advanced Protection restrictions may still apply. An unconfigured installed app displays an unavailable/email-alternative notice and does not start Google authentication.

## Required public configuration

- An OAuth client of type **iOS**, for the actual bundle `com.ordashtech.nuri.nativelab` (not the original web shell).
- A compatible OAuth client of type **Web** for the same Google project, whose audience the existing production backend accepts through `GOOGLE_CLIENT_IDS` / `GOOGLE_CLIENT_ID`.
- Root-controlled Expo configuration must include `./plugins/withNuriGoogleSignIn` alongside `./plugins/withNuriNative`. The wrapper consumes public `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` and `EXPO_PUBLIC_GOOGLE_CLIENT_ID`, or its `iosClientId` / `webClientId` options. Neither is a client secret. Do not supply a secret, fabricate an ID, or change production backend configuration through this client task.

The wrapper delegates to the official Expo plugin with `{ iosUrlScheme: <dot-reversed iOS client ID> }`, and writes `GIDClientID` / `GIDServerClientID`. No IDs means no OAuth plist changes; a partial/invalid configuration fails explicitly. Root owns prebuild, Pods, versioning and distribution.

At runtime `NuriGoogleAuthBridge` reads the **installed binary's** bundle, public IDs, and registered callback scheme. The adapter requires the Lab bundle, both valid-looking IDs, an actual callback registration, and the linked SDK. This is a configuration check, not proof of Google project permissions or backend audience acceptance. The native AppDelegate forwards Google's callback to its SDK while preserving Expo/RCT linking and push handling.

## Session and account contract

Interactive Google sign-in returns an ID token; only that credential and the language are sent to the existing `POST https://nurifam.app/api/auth/google`. The server verifies Google's signature/issuer/audience/expiry/verified email and determines the existing/new NURI user. The client does not trust a provider profile or email as NURI account identity.

The returned NURI JWT is installed through the existing private SecureStore/auth queue with `expectedGeneration`, read-back checks, guarded onboarding state and owner-bound navigation. Cancellation, missing configuration, server rejection, unmount, A→B/ABA changes, and late results cannot install an obsolete account. Local storage failures remain explicit and retryable. A known signed-in account cannot be silently replaced from the registration flow. Google provider caches are signed out around the interactive flow without revoking grants; this is not a claim that the Google SDK never temporarily stores its own credentials.

The backend and NURI cloud account/data remain shared with the web app. Local bundle, URL scheme, Keychain and push/reminder namespaces stay isolated. No backend, Google account/project permissions, production login, deployment, or upload was changed by this integration.

## Release gate and verification

Enabling third-party primary-account login also requires assessment of Apple's **4.8 Login Services** equivalent option: name/email-only data, private-email account setup, and no advertising use of interactions without consent. The current real-email/password flow is not evidence of that equivalent private-email option. This main backend has no Sign in with Apple token-exchange endpoint; a native Apple button alone cannot implement it. Do not claim Google-enabled external Beta/App Store readiness until configuration, a real authorized device login, backend audience compatibility and the applicable review requirement are resolved.

Offline regression command: `node --test scripts/test-native-google-signin.mjs`. Its fake provider, `.invalid` server and in-memory OS storage exercise real adapter/session/API/UI modules without Google accounts, production requests or AI calls. Separate email-login and session-isolation regressions must also pass. These tests do not replace signed-device OAuth validation.

Primary references:

- [Google iOS setup and backend client ID](https://developers.google.com/identity/sign-in/ios/start-integrating)
- [Google backend identity verification](https://developers.google.com/identity/sign-in/ios/backend-auth)
- [Expo native Google authentication](https://docs.expo.dev/guides/google-authentication/)
- [Library official Expo configuration](https://react-native-google-signin.github.io/docs/setting-up/expo)
- [Google Audience rules and basic identity exception](https://support.google.com/cloud/answer/15549945?hl=en)
- [Actual resolved Google iOS SDK default scopes](https://github.com/google/GoogleSignIn-iOS/blob/9.2.0/GoogleSignIn/Sources/GIDScopes.m)
- [Apple App Review 4.8](https://developer.apple.com/app-store/review/guidelines/#login-services)
