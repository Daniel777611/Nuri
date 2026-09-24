# NURI Mobile Shell

Lightweight Expo/React Native shell for the production NURI web app at
`https://nurifam.app`.

## Conversation camera and image flow

- The production Web app remains responsible for image previews, upload, and
  AI image understanding.
- On iOS 18.4 and later, the shell uses WebKit's public open-panel delegate to
  offer Camera, Photos, and Files directly from the chat image input.
- A newly captured photo is saved to the system photo library. A metadata-free,
  1600 px JPEG copy is returned to WebKit for upload so modern 24/48 MP camera
  output does not destabilize the WebContent process.
- Photos and files selected by the user are prepared for upload but are not
  written back to the photo library, avoiding duplicate assets.
- Earlier iOS versions retain Safari-compatible WebKit file selection.

## Security boundary

- Only the exact HTTPS host `nurifam.app` stays inside the WebView.
- Other HTTPS links open through the operating system.
- HTTP, JavaScript, file, content, credential-bearing, and non-standard-port
  URLs are blocked. WebKit-generated `about:blank`, `blob:`, and `data:` URLs
  stay internal so previews and file-input handoff continue to work.
- No token is injected into the URL or JavaScript context.
- Arbitrary HTTP transport and mixed content are disabled.
- Camera and photo-library access are requested only after the user opens the
  image input. The shell never scans the library in the background.

## Local development

Use the bundled Node runtime configured for this workspace, then:

```bash
pnpm install
pnpm exec expo install react-native-webview @react-native-community/netinfo expo-status-bar
pnpm exec expo run:ios --device
```

The production Web URL is intentionally compiled into `src/config.ts`. Do not
replace it with unsigned remote configuration.

## Remote APNs notifications

Notification title and body content are owned by the backend APNs payload. The
iOS shell registers the device token, forwards the token to the production web
app, stores notification route metadata, and opens matching routes when the user
taps a notification.

The previous local reminder UI/content path has been retired. On launch and when
the app returns to the foreground, the native bridge removes legacy local reminder
requests owned by this app and keeps the stored local-reminder preference disabled.
Foreground local reminders with the legacy `local_reminder` marker are suppressed
so testers only see backend-delivered APNs content.
