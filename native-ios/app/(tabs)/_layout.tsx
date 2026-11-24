import { Stack } from "expo-router";

// The final design's shared shell owns the three-tab bar.
export default function MainLayout() {
  return <Stack screenOptions={{ headerShown: false, animation: "simple_push", animationDuration: 300 }}>
    <Stack.Screen name="index" options={{ animation: "none" }} />
    <Stack.Screen name="chats" options={{ animation: "none" }} />
  </Stack>;
}
