import { View, Text, StyleSheet } from "react-native";

import { radius, spacing, type } from "@/src/theme";

/** 轻量顶部 toast。父组件负责在 2 秒后清空 message。 */
export default function Toast({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <View style={styles.wrap} pointerEvents="none">
      <View style={styles.toast} testID="toast">
        <Text style={styles.text}>{message}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    top: 64,
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 100,
  },
  toast: {
    backgroundColor: "rgba(30,30,30,0.9)",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.pill,
    maxWidth: "85%",
  },
  text: { color: "#fff", fontSize: type.base, fontWeight: "600" },
});
