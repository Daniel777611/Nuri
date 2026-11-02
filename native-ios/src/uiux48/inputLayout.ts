import type { TextStyle } from "react-native";

/** Single-line controls share a symmetric UIKit text box. Multiline editors
 * remain top-aligned, so wrapping and caret scrolling keep their normal flow. */
export const singleLineInputStyle: TextStyle = {
  paddingVertical: 0,
  textAlignVertical: "center",
  includeFontPadding: false,
};
export const multilineInputStyle: TextStyle = {
  paddingVertical: 14,
  textAlignVertical: "top",
  includeFontPadding: false,
};
