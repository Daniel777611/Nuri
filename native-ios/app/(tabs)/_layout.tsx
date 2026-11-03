import { Stack } from "expo-router";

// The final design's shared shell owns the three-tab bar.
export default function MainLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
