import { InputAccessoryView, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useT } from "@/src/i18n";

// Sampled from the lower, light iPhone keyboard in the approved screenshot.
// A uniform neutral base must not pick up the chat's rose tint through blur;
// the system still owns and renders the keyboard below this accessory.
const NATIVE_KEYBOARD_SURFACE = "#E0DFE4";

/** Only the app's accessory is styled. UIKit owns the keys, candidates,
 * language/emoji switching, dictation and Shift beneath this toolbar. */
export function NativeKeyboardAccessory({ nativeID, onDone, testID = nativeID }: { nativeID: string; onDone: () => void; testID?: string }) {
  const { locale } = useT(), { width } = useWindowDimensions();
  const done = locale === "en" ? "Done" : "完成";
  return <InputAccessoryView nativeID={nativeID} backgroundColor="transparent">
    <View style={[s.toolbar, { width }]} testID={`${testID}-keyboard-panel`}>
      <Pressable onPress={onDone} style={s.done} accessibilityRole="button" accessibilityLabel={done} testID={`${testID}-keyboard-done`}>
        <Text style={s.label}>{done}</Text>
      </Pressable>
    </View>
  </InputAccessoryView>;
}
const s = StyleSheet.create({
  toolbar: { height: 44, paddingHorizontal: 12, alignItems: "flex-end", justifyContent: "center", borderTopLeftRadius: 28, borderTopRightRadius: 28, overflow: "hidden", backgroundColor: NATIVE_KEYBOARD_SURFACE },
  done: { width: 60, height: 44, alignItems: "center", justifyContent: "center" },
  label: { fontSize: 16, lineHeight: 24, fontWeight: "500", color: "#706A74" },
});
