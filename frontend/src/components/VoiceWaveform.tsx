import { useEffect, useState } from "react";
import { View, StyleSheet } from "react-native";

import { colors } from "@/src/theme";

// A scrolling bar trace of the microphone's loudness while a voice clip is
// recording. Its job is reassurance: the bars jump when the parent speaks and
// lie flat when nothing is reaching the mic, so a silent or muted mic shows up
// before the clip is sent off to be transcribed.

const BARS = 32;
const SAMPLE_MS = 70;
const MIN_HEIGHT = 3;
const MAX_HEIGHT = 26;

export default function VoiceWaveform({
  level,
  testID,
}: {
  /** Current loudness 0–1, or null when it can't be measured. */
  level: () => number | null;
  testID?: string;
}) {
  const [history, setHistory] = useState<number[]>(() => Array(BARS).fill(0));

  useEffect(() => {
    const timer = setInterval(() => {
      const value = level();
      if (value === null) return;
      setHistory((prev) => [...prev.slice(1), value]);
    }, SAMPLE_MS);
    return () => clearInterval(timer);
  }, [level]);

  return (
    <View style={styles.row} testID={testID}>
      {history.map((value, i) => (
        <View
          key={i}
          style={[
            styles.bar,
            { height: MIN_HEIGHT + value * (MAX_HEIGHT - MIN_HEIGHT) },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flex: 1,
    height: MAX_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    overflow: "hidden",
  },
  bar: {
    width: 3,
    borderRadius: 1.5,
    backgroundColor: colors.brand,
  },
});
