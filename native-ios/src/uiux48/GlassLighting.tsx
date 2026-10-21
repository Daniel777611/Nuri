import { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import { glassLightingSvg, GLASS_INNER_LIGHT } from "./glassLightPaint";

/** Decorative lighting cannot catch touches, cover text, or enlarge layout. */
export function GlassLighting({ radius, night, control = false }: { radius: number; night: boolean; control?: boolean }) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const source = useMemo(() => size.width && size.height ? {
    uri: `data:image/svg+xml;utf8,${encodeURIComponent(glassLightingSvg(size.width, size.height, radius, night, control))}`,
  } : null, [size.width, size.height, radius, night, control]);
  return <View pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[StyleSheet.absoluteFill, { borderRadius: radius, overflow: "hidden", boxShadow: night ? GLASS_INNER_LIGHT.night : GLASS_INNER_LIGHT.day }]} onLayout={({ nativeEvent: { layout } }) => {
    const width = Math.round(layout.width * 2) / 2, height = Math.round(layout.height * 2) / 2;
    setSize(previous => previous.width === width && previous.height === height ? previous : { width, height });
  }} testID="nuri-glass-lighting">
    {source ? <Image source={source} style={StyleSheet.absoluteFill} contentFit="fill" transition={0} cachePolicy="memory" accessible={false} testID="nuri-glass-gradient-light" /> : null}
  </View>;
}
