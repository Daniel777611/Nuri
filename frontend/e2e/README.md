# Authenticated NURI E2E

This test uses the real login page and a dedicated, fully onboarded test account.
Credentials are read only from the process environment and are never saved as
Playwright storage state, screenshots, video, or traces.

On Windows, run the secure prompt wrapper:

```powershell
npm run e2e:login:prompt
```

For CI, store `NURI_E2E_EMAIL` and `NURI_E2E_PASSWORD` in the runner's secret
store, then run `npm run e2e:login`. `NURI_E2E_BASE_URL` may override the fixed
test deployment URL. Do not pass credentials as command-line arguments.
