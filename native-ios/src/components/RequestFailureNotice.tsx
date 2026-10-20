import { Pressable, StyleSheet, Text, View } from "react-native";
import { useT } from "@/src/i18n";
import { NuriButton, NuriText } from "@/src/uiux48/Primitives";
import { colors } from "@/src/theme";
import { requestFailureCopy, type RequestFailureKind } from "@/src/requestFailure";

export default function RequestFailureNotice({ error, onRetry, onPermission, onLogin }: {
  error: RequestFailureKind;
  onRetry: () => void;
  onPermission: () => void;
  onLogin: () => void;
}) {
  const { locale } = useT();
  const copy = requestFailureCopy(locale, error);
  const action = error === "permission" ? onPermission : error === "session" ? onLogin : onRetry;
  return <View style={{alignSelf:"stretch",padding:20,gap:14}} testID={`request-failure-${error}`} accessibilityLiveRegion="polite">
    <NuriText style={{fontSize:20,lineHeight:28}}>{copy.title}</NuriText>
    <NuriText secondary>{copy.detail}</NuriText>
    <NuriButton onPress={action} label={copy.action} accessibilityLabel={copy.action} testID="request-failure-action" />
  </View>;
}

const styles = StyleSheet.create({
  box: { alignSelf: "stretch", padding: 20, gap: 14, alignItems: "center" },
  title: { color: colors.onSurface, fontSize: 18, fontWeight: "600", textAlign: "center" },
  detail: { color: colors.muted, fontSize: 14, lineHeight: 22, textAlign: "center" },
  button: { minHeight: 48, borderRadius: 16, paddingVertical: 12, paddingHorizontal: 18, backgroundColor: colors.brand, alignItems: "center", justifyContent: "center" },
  action: { color: colors.onBrandPrimary, fontSize: 14, fontWeight: "600", textAlign: "center" },
});
