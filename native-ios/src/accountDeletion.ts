import type { AppleCredential } from "./api";

export type AccountDeletionOwner = { token: string; id: string; email: string; appleSignInLinked?: boolean };
export type AccountDeletionTransport = {
  getToken: () => Promise<string | null>;
  deleteAccount: (password: string, expectedToken: string) => Promise<unknown>;
  deleteAccountWithApple?: (credential: AppleCredential, expectedToken: string) => Promise<unknown>;
  clearToken: (options: { expectedToken: string; forceLocal: true }) => Promise<boolean>;
};

export class AccountDeletionError extends Error {
  constructor(readonly code: "INVALID_CONFIRMATION" | "INVALID_PASSWORD" | "SESSION_CHANGED" | "RESULT_UNCONFIRMED") {
    super(code);
  }
}

export function validDeletionPassword(password: string): boolean {
  // bcrypt's limit is bytes, not JavaScript characters. Never trim a password.
  try {
    const bytes = encodeURIComponent(password).replace(/%[0-9a-f]{2}/gi, "x").length;
    return bytes > 0 && bytes <= 72;
  } catch {
    return false;
  }
}

export async function deleteOwnedAccount(
  owner: AccountDeletionOwner,
  credential: string | AppleCredential,
  confirmation: string,
  transport: AccountDeletionTransport,
): Promise<{ deleted: true; signedOut: boolean; appleRevocationPending?: true }> {
  if (confirmation !== "DELETE") throw new AccountDeletionError("INVALID_CONFIRMATION");
  if (typeof credential === "string" && !validDeletionPassword(credential)) throw new AccountDeletionError("INVALID_PASSWORD");
  if (!owner.id || !owner.token || await transport.getToken() !== owner.token) {
    throw new AccountDeletionError("SESSION_CHANGED");
  }
  // The transport must use this captured owner, never whichever account logs
  // in while the irreversible request is in flight. Password stays in memory.
  const result = typeof credential === "string"
    ? await transport.deleteAccount(credential, owner.token)
    : await transport.deleteAccountWithApple?.(credential, owner.token);
  if (!result || typeof result !== "object" || !("account_deleted" in result) || result.account_deleted !== true) {
    throw new AccountDeletionError("RESULT_UNCONFIRMED");
  }
  // Compare-and-clear inside auth's existing serialized queue. A newer login
  // must not be signed out by an older account's completed deletion.
  const signedOut = await transport.clearToken({ expectedToken: owner.token, forceLocal: true });
  return result && "apple_revocation_pending" in result && result.apple_revocation_pending === true
    ? { deleted: true, signedOut, appleRevocationPending: true }
    : { deleted: true, signedOut };
}
