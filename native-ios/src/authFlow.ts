// Shared pieces of the email-code screens: which address is waiting for a
// code, the resend countdown, and how a server error code reads to a parent.

import { useEffect, useState } from "react";

import { apiErrorDetail } from "./api";
import { storage } from "./utils/storage";

// Kept in storage rather than the URL: an address in a query string ends up in
// browser history, and a reload of the code screen still needs to know it.
const PENDING_KEY = "pending_verification";

export type PendingVerification = { email: string; resendAt: number };

export async function savePendingVerification(email: string, resendAfterS: number) {
  const pending: PendingVerification = { email, resendAt: Date.now() + resendAfterS * 1000 };
  await storage.setItem(PENDING_KEY, JSON.stringify(pending));
}

export async function loadPendingVerification(): Promise<PendingVerification | null> {
  const raw = await storage.getItem(PENDING_KEY, "");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(String(raw));
    return typeof parsed?.email === "string" && parsed.email
      ? { email: parsed.email, resendAt: Number(parsed.resendAt) || 0 }
      : null;
  } catch {
    return null;
  }
}

export async function clearPendingVerification() {
  await storage.removeItem(PENDING_KEY);
}

/** Whole seconds left until `targetMs`, ticking down to 0. */
export function useCountdown(targetMs: number): number {
  const secondsLeft = () => Math.max(0, Math.ceil((targetMs - Date.now()) / 1000));
  const [left, setLeft] = useState(secondsLeft);
  useEffect(() => {
    setLeft(secondsLeft());
    const timer = setInterval(() => {
      const next = secondsLeft();
      setLeft(next);
      if (next <= 0) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetMs]);
  return left;
}

/** Keeps only the digits of whatever was typed or pasted, at most six. */
export function cleanCode(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, 6);
}

/**
 * The parent-facing wording for an auth route's error code, or "" when the
 * error isn't one of them (the caller then shows its own generic message).
 */
export function authErrorMessage(err: unknown, t: (s: string) => string): string {
  switch (apiErrorDetail(err)) {
    case "CODE_WRONG":
      return t("验证码不正确");
    case "CODE_EXPIRED":
      return t("验证码已过期，请重新获取");
    case "CODE_LOCKED":
      return t("错误次数过多，请重新获取验证码");
    case "CODE_RATE_LIMITED":
      return t("发送太频繁，请稍后再试");
    case "MAIL_SEND_FAILED":
      return t("验证邮件发送失败，请稍后重试");
    case "MAILBOX_UNDELIVERABLE":
      return t("这个邮箱无法接收邮件，请检查拼写");
    case "MAILBOX_DISPOSABLE":
      return t("请使用常用邮箱，不支持临时邮箱");
    case "MAILBOX_INVALID":
      return t("邮箱格式不正确");
    default:
      return "";
  }
}
