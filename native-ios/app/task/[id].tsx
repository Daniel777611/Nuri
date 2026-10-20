import { Redirect } from "expo-router";

/** Retired task deep links return home without rendering or API calls. */
export default function DeprecatedTaskRoute() { return <Redirect href="/(tabs)" />; }
