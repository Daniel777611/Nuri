import { useEffect, useState } from "react";
import { aiConsent } from "./api";

export function useAIConsent() {
  const [state, setState] = useState(aiConsent.getState);
  useEffect(() => {
    let active = true;
    const refresh = () => { void aiConsent.refresh().catch(() => {}); };
    const unsubscribe = aiConsent.subscribe((next) => {
      if (!active) return;
      setState(next);
      if (next.status === "unknown") refresh();
    });
    if (["unknown", "error"].includes(aiConsent.getState().status)) refresh();
    return () => { active = false; unsubscribe(); };
  }, []);
  return { state, refresh: aiConsent.refresh };
}
