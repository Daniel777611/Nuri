import { Redirect } from "expo-router";

/** No history-list contract. Real delivered pushes still use [id].tsx. */
export default function NotificationCenter() { return <Redirect href="/(tabs)" />; }
