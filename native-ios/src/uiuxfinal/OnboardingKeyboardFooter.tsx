import { useEffect, useState, type ReactNode } from "react";
import { AppState, Dimensions, Keyboard, View, type KeyboardEvent } from "react-native";
import { useAppKeyboardVisible } from "@/src/keyboard/AppKeyboard";

function hasVisibleKeyboardFrame(frame: { height: number; screenY: number }): boolean {
  const screenHeight = Dimensions.get("screen").height;
  return Number.isFinite(frame.height) && frame.height > 0 && Number.isFinite(frame.screenY)
    && frame.screenY + frame.height > 0 && (screenHeight <= 0 || frame.screenY < screenHeight);
}

function nativeKeyboardVisible(): boolean {
  // RN Web can omit the native snapshot APIs. Its app keyboard is observed
  // separately; a focused hardware-keyboard field alone is not a soft keyboard.
  const frame = Keyboard.metrics?.();
  return frame ? hasVisibleKeyboardFrame(frame) : Keyboard.isVisible?.() === true;
}

/** Presentation only. No field focus/edit, navigation, dismissal or save work.
 * A late event from a retired page cannot update its new mounted replacement. */
export function useOnboardingKeyboardVisible(): boolean {
  const appKeyboard = useAppKeyboardVisible();
  const [nativeVisible, setNativeVisible] = useState(nativeKeyboardVisible);
  useEffect(() => {
    let active = true;
    const show = (event: KeyboardEvent) => { if (active) setNativeVisible(hasVisibleKeyboardFrame(event.endCoordinates)); };
    const hide = () => { if (active) setNativeVisible(false); };
    const willChange = (event: KeyboardEvent) => {
      if (active && hasVisibleKeyboardFrame(event.endCoordinates)) setNativeVisible(true);
      // An offscreen WILL frame begins dismissal; keep the CTA hidden until
      // the final DID frame/hide, not midway through the keyboard animation.
    };
    const subscriptions = [Keyboard.addListener("keyboardWillShow", show), Keyboard.addListener("keyboardDidShow", show),
      Keyboard.addListener("keyboardWillChangeFrame", willChange), Keyboard.addListener("keyboardDidChangeFrame", show),
      Keyboard.addListener("keyboardDidHide", hide)];
    const foreground = AppState.addEventListener("change", state => {
      if (active && state === "active") setNativeVisible(nativeKeyboardVisible());
    });
    // Close a mount/subscribe race without relying on an input-focus signal.
    setNativeVisible(nativeKeyboardVisible());
    return () => { active = false; subscriptions.forEach(subscription => subscription.remove()); foreground.remove(); };
  }, []);
  return appKeyboard || nativeVisible;
}

/** Keep its original flex slot. The body, not this footer, avoids the keyboard.
 * Shell/custom-host resizing may change hidden geometry; no CTA is allowed to
 * remain visible, tappable or exposed to accessibility above the keyboard. */
export function OnboardingKeyboardFooter({ children, hidden }: { children: ReactNode; hidden: boolean }) {
  return <View testID="onboarding-static-footer" style={{ flexShrink: 0, opacity: hidden ? 0 : 1 }}
    pointerEvents={hidden ? "none" : "auto"} accessibilityElementsHidden={hidden}
    importantForAccessibility={hidden ? "no-hide-descendants" : "auto"}>{children}</View>;
}
