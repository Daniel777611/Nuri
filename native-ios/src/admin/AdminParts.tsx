// Small shared pieces that keep /admin readable: sections that stay closed
// until needed, and explanations that stay out of the way until asked for.

import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { colors, radius, spacing } from "@/src/theme";

/** A bordered section whose body renders only while open. */
export function Collapsible({
  title,
  summary,
  defaultOpen = false,
  right,
  children,
  testID,
}: {
  title: string;
  /** One line shown next to the title, open or closed. */
  summary?: string;
  defaultOpen?: boolean;
  /** Controls shown in the header while open (e.g. range chips). */
  right?: ReactNode;
  children: ReactNode;
  testID?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <View style={styles.card} testID={testID}>
      <View style={styles.head}>
        <Pressable
          onPress={() => setOpen((v) => !v)}
          style={styles.headToggle}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
        >
          <Ionicons
            name={open ? "chevron-down" : "chevron-forward"}
            size={16}
            color={colors.onSurfaceTertiary}
          />
          <Text style={styles.title}>{title}</Text>
          {summary ? <Text style={styles.summary} numberOfLines={1}>{summary}</Text> : null}
        </Pressable>
        {open && right ? <View style={styles.right}>{right}</View> : null}
      </View>
      {open ? <View style={styles.body}>{children}</View> : null}
    </View>
  );
}

/** Explanatory fine print, folded behind a "说明" link. */
export function Note({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.note}>
      <Pressable onPress={() => setOpen((v) => !v)} hitSlop={6} accessibilityRole="button">
        <Text style={styles.noteToggle}>{open ? "收起说明" : "说明"}</Text>
      </Pressable>
      {open ? <Text style={styles.noteText}>{children}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.md,
  },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
    paddingRight: spacing.md,
  },
  headToggle: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    padding: spacing.md,
  },
  title: { fontSize: 14, fontWeight: "700", color: colors.onSurface },
  summary: { flexShrink: 1, fontSize: 12, color: colors.muted, marginLeft: spacing.xs },
  right: { flexDirection: "row", gap: 4 },
  body: { paddingHorizontal: spacing.md, paddingBottom: spacing.md },
  note: { marginTop: spacing.xs },
  noteToggle: { fontSize: 12, color: colors.brand, fontWeight: "600" },
  noteText: { fontSize: 12, color: colors.muted, marginTop: 4, lineHeight: 18 },
});
