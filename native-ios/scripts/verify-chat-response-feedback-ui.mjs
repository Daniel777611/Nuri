import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const baseURL = process.env.NURI_FEEDBACK_PREVIEW_URL || "http://127.0.0.1:8085";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({
  viewport: { width: 402, height: 874 },
  permissions: ["clipboard-read", "clipboard-write"],
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});

try {
  await page.goto(`${baseURL}/`, { waitUntil: "networkidle" });
  await page.getByTestId("login-email").fill("preview@nuri.app");
  await page.getByTestId("login-password").fill("preview");
  await page.getByTestId("login-submit-btn").click();
  await page.getByTestId("home-nuri-action").waitFor({ state: "visible" });
  await page.getByTestId("home-nuri-action").click();

  const actions = page.locator('[data-testid^="chat-response-actions-"]');
  await actions.last().waitFor({ state: "visible" });
  const like = page.locator('[data-testid^="chat-like-"]').last();
  const dislike = page.locator('[data-testid^="chat-dislike-"]').last();
  const copy = page.locator('[data-testid^="chat-copy-"]').last();

  const expectedIconSources = [
    [copy, "/chat-feedback/copy.svg"],
    [like, "/chat-feedback/like.svg"],
    [dislike, "/chat-feedback/dislike.svg"],
  ];
  for (const [button, expectedPath] of expectedIconSources) {
    const source = await button.locator("img").getAttribute("src");
    if (!source?.includes(expectedPath)) {
      throw new Error(`Expected exact Figma asset ${expectedPath}, received ${source}`);
    }
  }

  const iconBoxes = [];
  for (const [button] of expectedIconSources) {
    const buttonBox = await button.boundingBox();
    const iconBox = await button.locator("img").boundingBox();
    if (!buttonBox || !iconBox) throw new Error("Feedback button or Figma icon is not visible");
    if (Math.abs(buttonBox.width - 28) > 0.5 || Math.abs(buttonBox.height - 28) > 0.5) {
      throw new Error(`Feedback button is too small: ${JSON.stringify(buttonBox)}`);
    }
    if (Math.abs(iconBox.width - 20) > 0.5 || Math.abs(iconBox.height - 20) > 0.5) {
      throw new Error(`Figma icon display scale is wrong: ${JSON.stringify(iconBox)}`);
    }
    iconBoxes.push(iconBox);
  }
  for (let index = 1; index < iconBoxes.length; index += 1) {
    const visualGap = iconBoxes[index].x - (iconBoxes[index - 1].x + iconBoxes[index - 1].width);
    if (Math.abs(visualGap - 8) > 0.5) {
      throw new Error(`Figma icon gap must scale with the icons: ${visualGap}px`);
    }
  }

  if (await page.locator('[data-testid="chat-response-actions-__streaming__"]').count()) {
    throw new Error("streaming placeholder exposed feedback actions");
  }
  await mkdir("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/chat-feedback-402.png", fullPage: true });
  await like.click();
  await page.waitForTimeout(50);
  const likeState = await like.evaluate((element) => ({
    selected: element.getAttribute("aria-selected"),
    pressed: element.getAttribute("aria-pressed"),
    label: element.getAttribute("aria-label"),
    html: element.outerHTML,
  }));
  if (likeState.selected !== "true" && likeState.pressed !== "true") {
    throw new Error(`Like did not select: ${JSON.stringify(likeState)}`);
  }
  await dislike.click();
  await page.waitForTimeout(50);
  if ((await dislike.getAttribute("aria-pressed")) !== "true") throw new Error("Dislike did not select");
  if ((await like.getAttribute("aria-pressed")) !== "false") throw new Error("Like and Dislike were not exclusive");

  const responseText = await page.locator('[data-testid="bubble-ai"]').last().innerText();
  await copy.click();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  if (!clipboard || !responseText.includes(clipboard)) throw new Error("Copy did not write the response text");

  await page.screenshot({ path: "test-results/chat-feedback-selected-402.png", fullPage: true });
  if (errors.length) throw new Error(`browser errors: ${errors.join(" | ")}`);
  console.log(`chat feedback UI: ok (${await actions.count()} AI answers, 402x874)`);
} finally {
  await browser.close();
}
