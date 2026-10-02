/** Never expose response bodies, identifiers or credentials in error UI. */
export type RequestFailureKind = "permission" | "session" | "timeout" | "service" | "connection";

export function requestFailureKind(error: unknown): RequestFailureKind {
  if (!error || typeof error !== "object") return "connection";
  const failure = error as { code?: string; aiConsentRequired?: boolean; status?: number; name?: string };
  if (failure.code === "AI_SESSION_CHANGED" || failure.name === "SessionChangedError" || failure.status === 401) return "session";
  if (failure.aiConsentRequired === true) return "permission";
  if (failure.name === "AbortError") return "timeout";
  if (typeof failure.status === "number") return "service";
  return "connection";
}

export function requestFailureCopy(locale: string, kind: RequestFailureKind) {
  const copy = locale === "en" ? {
    permission: { title: "AI permission is needed", detail: "This action may send relevant information to OpenAI. Review the notice and choose whether to allow it. This is not a backend connection failure.", action: "Review AI permission" },
    session: { title: "Please sign in again", detail: "Your session changed or expired. Sign in before continuing.", action: "Sign in" },
    timeout: { title: "The request took too long", detail: "The shared NURI service did not finish in time. Check your connection and retry.", action: "Retry" },
    service: { title: "The service could not complete this request", detail: "Your request reached the shared NURI service. Please retry shortly.", action: "Retry" },
    connection: { title: "Unable to connect", detail: "Check your connection, then try the shared NURI service again.", action: "Retry" },
  } : locale === "zh-TW" ? {
    permission: { title: "需要先選擇 AI 使用許可", detail: "此操作可能將相關資訊傳送給 OpenAI。請閱讀告知並自行選擇是否允許；這不是後端連線失敗。", action: "查看 AI 使用許可" },
    session: { title: "請重新登入", detail: "登入狀態已變更或過期，請登入後繼續。", action: "登入" },
    timeout: { title: "請求等待時間過長", detail: "共用 NURI 服務未能及時完成，請檢查網路後重試。", action: "重試" },
    service: { title: "服務暫時未能完成請求", detail: "請求已到達共用 NURI 服務，請稍後重試。", action: "重試" },
    connection: { title: "暫時無法連線", detail: "請檢查網路，再重新連接共用 NURI 服務。", action: "重試" },
  } : {
    permission: { title: "需要先选择 AI 使用许可", detail: "此操作可能将相关信息发送给 OpenAI。请阅读告知并自行选择是否允许；这不是后端连接失败。", action: "查看 AI 使用许可" },
    session: { title: "请重新登录", detail: "登录状态已变更或过期，请登录后继续。", action: "登录" },
    timeout: { title: "请求等待时间过长", detail: "共用 NURI 服务未能及时完成，请检查网络后重试。", action: "重试" },
    service: { title: "服务暂时未能完成请求", detail: "请求已到达共用 NURI 服务，请稍后重试。", action: "重试" },
    connection: { title: "暂时无法连接", detail: "请检查网络，再重新连接共用 NURI 服务。", action: "重试" },
  };
  return copy[kind];
}
