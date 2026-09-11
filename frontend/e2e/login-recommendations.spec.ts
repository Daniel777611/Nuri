import { expect, test, type Page } from "@playwright/test";

async function loginFromCleanPage(page: Page) {
  const email = process.env.NURI_E2E_EMAIL?.trim();
  const password = process.env.NURI_E2E_PASSWORD;
  if (!email) {
    throw new Error(
      "NURI_E2E_EMAIL is required for the authenticated E2E test",
    );
  }
  if (!password) {
    throw new Error(
      "NURI_E2E_PASSWORD is required for the authenticated E2E test",
    );
  }

  await page.goto("/login", { waitUntil: "domcontentloaded" });

  const emailInput = page.getByTestId("login-email");
  const passwordInput = page.getByTestId("login-password");
  const submitButton = page.getByTestId("login-submit-btn");

  await expect(emailInput).toBeVisible();
  await expect(passwordInput).toBeVisible();
  await emailInput.fill(email);
  await passwordInput.fill(password);

  const loginResponsePromise = page.waitForResponse(
    (response) => {
      const pathname = new URL(response.url()).pathname;
      return (
        pathname.endsWith("/api/auth/login") &&
        response.request().method() === "POST"
      );
    },
    { timeout: 30_000 },
  );

  await expect(submitButton).toBeEnabled();
  await submitButton.click();

  const loginResponse = await loginResponsePromise;
  expect(loginResponse.status(), "login endpoint should return 200").toBe(200);
  await expect(page.getByTestId("login-error")).toHaveCount(0);
  await expect(page.getByTestId("home-avatar")).toBeVisible({
    timeout: 60_000,
  });
  await expect(page).not.toHaveURL(/\/onboarding(?:\/|$)/);
}

test("real login keeps its session and shows today's parent post", async ({ page }) => {
  await loginFromCleanPage(page);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("home-avatar")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("login-email")).toHaveCount(0);

  // The first visit of the day builds the card (search + two model calls), so
  // allow for that; a day with no usable post shows an explicit empty state.
  const card = page.getByTestId("home-daily-post-card");
  const empty = page.getByTestId("home-daily-post-empty");
  await expect(card.or(empty)).toBeVisible({ timeout: 120_000 });
  if (await empty.isVisible()) {
    test.info().annotations.push({ type: "note", description: "no usable post today" });
    return;
  }

  await expect(page.getByTestId("home-daily-post-greeting")).toContainText(
    /你好呀，其他(?:妈妈|家长)可能会这么处理/,
  );
  await card.click();
  await expect(page).toHaveURL(/\/daily-post/, { timeout: 30_000 });
  await expect(page.getByTestId("daily-post-greeting")).toBeVisible();
  await expect(page.getByTestId("daily-post-source")).toBeVisible();
  await expect(page.getByTestId("daily-post-chat")).toBeVisible();

  // Same card on a second visit the same day: it is decided once.
  const headline = await page.getByTestId("daily-post-headline").innerText();
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(card).toBeVisible({ timeout: 60_000 });
  await card.click();
  await expect(page.getByTestId("daily-post-headline")).toHaveText(headline);
});
