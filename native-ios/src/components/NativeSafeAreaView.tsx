import { Platform } from "react-native";
import { SafeAreaView as SystemSafeAreaView, type SafeAreaViewProps } from "react-native-safe-area-context";

/** Stack's visible native header already applies the top inset. */
export function SafeAreaView({ edges, ...props }: SafeAreaViewProps) {
  const pageEdges: SafeAreaViewProps["edges"] = Platform.OS === "web"
    ? edges
    : edges === undefined
      ? ["left", "right", "bottom"]
      : Array.isArray(edges)
        ? edges.filter((edge) => edge !== "top")
        : { ...edges, top: "off" };
  return <SystemSafeAreaView {...props} edges={pageEdges} />;
}
