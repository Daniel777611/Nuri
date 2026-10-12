import { useLocalSearchParams } from "expo-router";

import ComingSoon from "@/src/components/ComingSoon";

export default function ComingSoonRoute() {
  const { feature } = useLocalSearchParams<{ feature?: string }>();
  return <ComingSoon feature={feature === "community" ? "community" : "knowledge"} />;
}
