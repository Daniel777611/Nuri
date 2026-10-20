import { Stack } from "expo-router";

// The App Store shell exposes only mature Home/Chat tabs. Profile stays in Settings.
export default function MainLayout() {
  return <Stack screenOptions={{ headerShown: false }}><Stack.Protected guard={false}><Stack.Screen name="tasks" /></Stack.Protected></Stack>;
}
