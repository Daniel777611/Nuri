import { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";

import { ENCOURAGEMENTS, RATINGS, taskColors as c } from "@/src/taskMeta";

/**
 * 记录任务感想 bottom sheet（打卡后触发，设计稿复刻）。
 * onDone(rating): rating 为 null 表示跳过（不记录）。
 */
export default function CheckinSheet({
  visible,
  taskType,
  onDone,
}: {
  visible: boolean;
  taskType: string;
  onDone: (rating: string | null) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (visible) setSelected(null);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [visible]);

  const pick = (key: string) => {
    if (selected) return;
    setSelected(key);
    // 点击任意选项 → 高亮 0.5 秒后关闭
    timer.current = setTimeout(() => onDone(key), 500);
  };

  if (!visible) return null;

  return (
    <View style={styles.root}>
      <Pressable style={StyleSheet.absoluteFill} onPress={() => onDone(null)} />
      <View style={styles.sheet} testID="checkin-sheet">
        <View style={styles.handle} />
        <Pressable
          onPress={() => onDone(null)}
          style={styles.skip}
          hitSlop={8}
          testID="checkin-skip"
        >
          <Text style={styles.skipText}>跳过</Text>
        </Pressable>
        <Text style={styles.encourage} testID="checkin-encouragement">
          {ENCOURAGEMENTS[taskType] || ENCOURAGEMENTS.interaction}
        </Text>
        <Text style={styles.subtitle}>记录这次任务体验</Text>
        <View style={styles.ratingRow}>
          {RATINGS.map((r) => (
            <Pressable
              key={r.key}
              onPress={() => pick(r.key)}
              style={[styles.ratingBtn, selected === r.key && styles.ratingActive]}
              testID={`checkin-rating-${r.key}`}
            >
              <Text style={styles.emoji}>{r.emoji}</Text>
              <Text
                style={[
                  styles.ratingLabel,
                  selected === r.key && { color: c.primary, fontWeight: "700" },
                ]}
              >
                {r.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.32)",
    justifyContent: "flex-end",
    zIndex: 50,
  },
  sheet: {
    backgroundColor: "#fff",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 24,
    paddingBottom: 36,
  },
  handle: {
    width: 36,
    height: 4,
    backgroundColor: c.track,
    borderRadius: 2,
    alignSelf: "center",
    marginBottom: 8,
  },
  skip: { position: "absolute", top: 14, right: 18 },
  skipText: { color: c.textSecondary, fontSize: 13 },
  encourage: {
    fontSize: 19,
    fontWeight: "700",
    color: c.text,
    textAlign: "center",
    marginTop: 18,
    lineHeight: 27,
  },
  subtitle: {
    fontSize: 13,
    color: c.textSecondary,
    textAlign: "center",
    marginTop: 6,
  },
  ratingRow: {
    flexDirection: "row",
    justifyContent: "space-around",
    marginTop: 24,
    paddingHorizontal: 12,
  },
  ratingBtn: {
    alignItems: "center",
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 12,
  },
  ratingActive: { backgroundColor: c.primaryLight },
  emoji: { fontSize: 34 },
  ratingLabel: { fontSize: 12, color: c.textSecondary },
});
