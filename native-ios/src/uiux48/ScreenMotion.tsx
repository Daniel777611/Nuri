import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AccessibilityInfo, Animated, Easing, Platform, type StyleProp, type ViewStyle } from "react-native";
import { routeMotionKey, routeMotionPlan, type RouteMotionSnapshot } from "./routeMotion";

type MotionFrameProps = {
  children: ReactNode;
  motionKey: string;
  direction?: -1 | 0 | 1;
  animate?: boolean;
  header?: boolean;
  style?: StyleProp<ViewStyle>;
};

/** Keep the existing children mounted so a visual transition cannot reset a
 * form, repeat a request, or alter a navigation/account transaction. */
export function MotionFrame({ children, motionKey, direction = 0, animate = true, header = false, style }: MotionFrameProps) {
  const opacity = useRef(new Animated.Value(1)).current;
  const offset = useRef(new Animated.Value(0)).current;
  const previousKey = useRef(motionKey);
  const [reducedMotion, setReducedMotion] = useState(true);
  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(value => {
      if (active) setReducedMotion(value);
    }).catch(() => {});
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReducedMotion);
    return () => { active = false; subscription.remove(); };
  }, []);
  useLayoutEffect(() => {
    const changed = previousKey.current !== motionKey;
    previousKey.current = motionKey;
    opacity.stopAnimation();
    offset.stopAnimation();
    if (!changed || !animate || reducedMotion || Platform.OS !== "ios") {
      opacity.setValue(1);
      offset.setValue(0);
      return;
    }
    opacity.setValue(header ? 0.8 : 0.72);
    offset.setValue(header ? 0 : direction * 28);
    const delay = header ? 0 : 32;
    const animation = Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 180,
        delay,
        easing: Easing.bezier(0.42, 0, 0.58, 1),
        useNativeDriver: true,
      }),
      Animated.sequence([
        Animated.timing(offset, {
          toValue: direction * 2,
          duration: 220,
          delay,
          easing: Easing.bezier(0.42, 0, 0.58, 1),
          useNativeDriver: true,
        }),
        Animated.spring(offset, {
          toValue: 0,
          stiffness: 220,
          damping: 24,
          mass: 1,
          overshootClamping: true,
          useNativeDriver: true,
        }),
      ]),
    ]);
    animation.start();
    return () => animation.stop();
  }, [motionKey, direction, animate, header, reducedMotion, opacity, offset]);
  return <Animated.View testID={header ? "nuri-header-motion" : "nuri-content-motion"} style={[
    header ? { flexShrink: 0 } : { flex: 1, minHeight: 0 },
    style,
    { opacity, transform: [{ translateX: offset }] },
  ]}>{children}</Animated.View>;
}

export function RouteMotion({ children, snapshot }: { children: ReactNode; snapshot: RouteMotionSnapshot }) {
  const state = useRef({ snapshot, plan: { key: routeMotionKey(snapshot), direction: 0 as -1 | 0 | 1, animate: false } });
  if (routeMotionKey(state.current.snapshot) !== routeMotionKey(snapshot)) {
    state.current = { snapshot, plan: routeMotionPlan(state.current.snapshot, snapshot) };
  }
  const { key, direction, animate } = state.current.plan;
  return <MotionFrame motionKey={key} direction={direction} animate={animate}>{children}</MotionFrame>;
}
