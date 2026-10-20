import { Redirect } from "expo-router";

/** No Community contract in this release: no placeholder, CTA or request. */
export default function Community() { return <Redirect href="/(tabs)" />; }
