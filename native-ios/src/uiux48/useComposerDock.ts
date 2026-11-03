import { useEffect, useState } from "react";
import { Keyboard } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { composerDockBottomInset } from "./composerLayout";

/** The page owns the bottom inset, never the reusable/nested composer. */
export function useComposerDockInset(enabled = true) {
  const safe = useSafeAreaInsets();
  const [keyboardVisible, setKeyboardVisible] = useState(() => Keyboard.isVisible?.() ?? false);
  useEffect(() => {
    if (!enabled) return;
    setKeyboardVisible(Keyboard.isVisible?.() ?? false);
    const show = () => setKeyboardVisible(true), hide = () => setKeyboardVisible(false);
    const listeners = [Keyboard.addListener("keyboardWillShow", show), Keyboard.addListener("keyboardDidShow", show), Keyboard.addListener("keyboardWillHide", hide), Keyboard.addListener("keyboardDidHide", hide)];
    return () => listeners.forEach(listener => listener.remove());
  }, [enabled]);
  return enabled ? composerDockBottomInset(safe.bottom, keyboardVisible) : 0;
}
