import { View, Text, StyleSheet, Pressable } from "react-native";

import { colors, radius, spacing, type } from "@/src/theme";

/** 通用二次确认弹窗（跨平台，替代 RN Alert 以兼容 web 预览）。 */
export default function ConfirmDialog({
  visible,
  title,
  message,
  confirmText = "确认",
  cancelText = "取消",
  danger = false,
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!visible) return null;
  return (
    <View style={styles.root}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onCancel} />
      <View style={styles.box} testID="confirm-dialog">
        <Text style={styles.title}>{title}</Text>
        {message ? <Text style={styles.message}>{message}</Text> : null}
        <View style={styles.row}>
          <Pressable onPress={onCancel} style={styles.btn} testID="confirm-cancel">
            <Text style={styles.cancelText}>{cancelText}</Text>
          </Pressable>
          <Pressable
            onPress={onConfirm}
            style={[styles.btn, styles.confirmBtn, danger && { backgroundColor: "#FF3B30" }]}
            testID="confirm-ok"
          >
            <Text style={styles.confirmText}>{confirmText}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.35)",
    justifyContent: "center",
    alignItems: "center",
    padding: spacing.xl,
    zIndex: 50,
  },
  box: {
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: spacing.xl,
    width: "100%",
    maxWidth: 340,
  },
  title: { fontSize: type.lg, fontWeight: "700", color: colors.onSurface },
  message: {
    fontSize: type.base,
    color: colors.onSurfaceSecondary,
    marginTop: spacing.sm,
    lineHeight: 20,
  },
  row: { flexDirection: "row", gap: spacing.md, marginTop: spacing.xl },
  btn: {
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: "center",
    backgroundColor: colors.surfaceTertiary,
  },
  confirmBtn: { backgroundColor: colors.brand },
  cancelText: { color: colors.onSurfaceSecondary, fontWeight: "600", fontSize: type.base },
  confirmText: { color: "#fff", fontWeight: "700", fontSize: type.base },
});
