import { expect, test, type Page } from "@playwright/test";

const RECOMMENDATION_CATEGORIES = [
  { key: "authority", label: "权威答案" },
  { key: "featured", label: "精选方法" },
  { key: "case", label: "相似案例" },
] as const;

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

async function readyRecommendationCard(page: Page, category: string) {
  const card = page.locator(
    `[data-testid^="home-hero-card-"][data-testid$="-${category}"]`,
  );
  await expect(card).toHaveCount(1, { timeout: 120_000 });
  await expect(card).toContainText("内容已准备好 · 文章 + 视频", {
    timeout: 120_000,
  });
  await expect(card).not.toContainText("正在准备");
  return card;
}

test("real login keeps its session and opens three ready recommendation lanes", async ({
  page,
}) => {
  await loginFromCleanPage(page);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("home-avatar")).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByTestId("login-email")).toHaveCount(0);

  const cardTexts: string[] = [];
  for (const category of RECOMMENDATION_CATEGORIES) {
    const card = await readyRecommendationCard(page, category.key);
    await expect(card).toContainText(category.label);
    if (category.key === "authority" || category.key === "featured") {
      await expect(card).toContainText(/机构官方(?:简体)?中文|简体中文|普通话/);
      await expect(card).not.toContainText(/英文原文|英文视频|英文原声/);
    }
    cardTexts.push(await card.innerText());
  }
  expect(new Set(cardTexts).size, "the three lanes must not reuse one card").toBe(
    3,
  );

  for (const category of RECOMMENDATION_CATEGORIES) {
    const card = await readyRecommendationCard(page, category.key);
    await card.click();

    await expect(page).toHaveURL(/\/detail\//, { timeout: 30_000 });
    await expect(page.getByTestId("content-detail-scroll")).toBeVisible();
    await expect(page.getByTestId("detail-error-state")).toHaveCount(0);
    await expect(
      page.getByTestId(`detail-resource-category-${category.key}`),
    ).toBeVisible();

    const resources = page.locator(
      '[data-testid^="detail-resource-"]:not([data-testid^="detail-resource-category-"])',
    );
    await expect(resources).toHaveCount(2, { timeout: 60_000 });

    const resourceSection = page.getByTestId("detail-learning-resources");
    await expect(resourceSection).toContainText("文章");
    await expect(resourceSection).toContainText("视频");
    await expect(resourceSection).not.toContainText("正在准备");
    if (category.key === "authority" || category.key === "featured") {
      const article = resources.filter({
        has: page.getByText("文章", { exact: true }),
      });
      const video = resources.filter({
        has: page.getByText("视频", { exact: true }),
      });
      await expect(article).toHaveCount(1);
      await expect(video).toHaveCount(1);
      await expect(article).toContainText(/机构官方(?:简体)?中文|简体中文/);
      await expect(article).not.toContainText(/英文原文|英文文章/);
      await expect(video).toContainText(/普通话|国语|华语/);
      await expect(video).not.toContainText(/英文视频|英文原声|English/);
    }

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("home-avatar")).toBeVisible({
      timeout: 60_000,
    });
  }
});
