import { Stack } from "expo-router";

// UIUX48's shared shell owns the four-tab bar; nested stacks stay transparent.
export default function MainLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
