export const SAFETY_CONTACT = "contact@ordashteches.com";
export const SAFETY_REASONS = ["unsafe", "sexual", "hate", "privacy", "other"] as const;
export type SafetyReason = typeof SAFETY_REASONS[number];

const reasonNames: Record<SafetyReason, string> = {
  unsafe: "Dangerous or harmful advice",
  sexual: "Sexual content or child safety",
  hate: "Harassment, hate or threats",
  privacy: "Personal information or privacy",
  other: "Other content concern",
};

/** Draft only: no request, automatic mail send, account data or conversation
 * text. References are optional and require a separate explicit choice. */
export function safetyReportMailto(input: {
  reason: SafetyReason;
  note: string;
  includeReferences: boolean;
  conversationId?: string;
  messageId?: string;
}): string {
  if (!SAFETY_REASONS.includes(input.reason)) throw new Error("INVALID_REPORT_REASON");
  const lines = ["NURI content safety report", "Concern: " + reasonNames[input.reason]];
  if (input.includeReferences) {
    // Only canonical server IDs, never URL fragments, message text or JWTs.
    const id = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (input.conversationId && id.test(input.conversationId)) lines.push("Conversation: " + input.conversationId);
    if (input.messageId && id.test(input.messageId)) lines.push("Message: " + input.messageId);
  }
  const note = input.note.trim().slice(0, 500);
  if (note) lines.push("Details provided by sender: " + note);
  lines.push("Please review this concern. This draft was opened by the user, not automatically sent by NURI.");
  return "mailto:" + SAFETY_CONTACT + "?subject=" + encodeURIComponent("NURI content safety report")
    + "&body=" + encodeURIComponent(lines.join("\n\n"));
}
