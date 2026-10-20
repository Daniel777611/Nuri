import type { ReactNode } from "react";
import { View } from "react-native";
import { AuthFrame, NuriButton, NuriText } from "./Primitives";

/** Presentation only. Callers own confirmation, account scope and all effects. */
export function StateCard({ title, message, note, children, primary, secondary, error, busy, testID }: {
  title?: string; message?: string; note?: string; children?: ReactNode;
  primary: { label: string; onPress: () => void; disabled?: boolean };
  secondary?: { label: string; onPress: () => void; disabled?: boolean };
  error?: string; busy?: boolean; testID: string;
}) {
  return <AuthFrame testID={testID} contentGap={24}>
    {title ? <NuriText style={{fontSize:20,lineHeight:26,fontWeight:"500"}}>{title}</NuriText> : null}
    {message ? <NuriText style={{fontSize:16,lineHeight:22}}>{message}</NuriText> : null}
    {note ? <NuriText secondary style={{fontSize:12,lineHeight:16}}>{note}</NuriText> : null}
    {children}
    {error ? <NuriText accessibilityLiveRegion="assertive" testID={`${testID}-error`}>{error}</NuriText> : null}
    <View style={{gap:12}}>
      <NuriButton label={primary.label} onPress={primary.onPress} disabled={busy||primary.disabled} busy={busy} testID={`${testID}-primary`} />
      {secondary ? <NuriButton secondary label={secondary.label} onPress={secondary.onPress} disabled={busy||secondary.disabled} testID={`${testID}-secondary`} /> : null}
    </View>
  </AuthFrame>;
}
