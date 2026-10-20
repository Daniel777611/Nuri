import { Redirect } from "expo-router";

/** Retired task UI has no current contract. No backend data is removed. */
export default function DeprecatedTasksRoute() { return <Redirect href="/(tabs)" />; }
