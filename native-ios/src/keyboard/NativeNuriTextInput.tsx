import { forwardRef, useCallback, useId, useLayoutEffect, useRef, type ForwardedRef } from "react";
import { TextInput } from "react-native";
import type { NuriTextInputProps } from "./AppKeyboard";
import { NativeKeyboardAccessory } from "./NativeKeyboardAccessory";

function assignRef(ref: ForwardedRef<TextInput>, value: TextInput | null) {
  if (typeof ref === "function") ref(value); else if (ref) ref.current = value;
}

/** A separate native host, never registered with the custom editing/IME
 * controller. Native marked text, selection, autocorrection, Shift and input
 * language remain entirely owned by UIKit. No inputView override or reload. */
export const NativeNuriTextInput = forwardRef<TextInput, NuriTextInputProps & { scopeActive: boolean }>(function NativeNuriTextInput({ scopeActive, appKeyboard = true, keyboardActive = true, keyboardId, onAppKeyboardDone, onAppKeyboardSubmit, onAppKeyboardDictation: _dictation, onAppKeyboardSticker: _sticker, ...props }, forwardedRef) {
  const generatedId = useId(), nativeID = props.nativeID ?? keyboardId ?? `nuri-native-input-${generatedId}`;
  const ref = useRef<TextInput | null>(null), mounted = useRef(false), focused = useRef(false);
  const focusVersion = useRef(0), pendingDone = useRef<number | null>(null);
  const active = !appKeyboard || scopeActive && keyboardActive;
  const editable = props.editable !== false && props.readOnly !== true;
  const latest = useRef({ active, editable, props, onAppKeyboardDone, onAppKeyboardSubmit });
  latest.current = { active, editable, props, onAppKeyboardDone, onAppKeyboardSubmit };
  const mergedRef = useCallback((node: TextInput | null) => { ref.current = node; assignRef(forwardedRef, node); }, [forwardedRef]);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; focused.current = false; pendingDone.current = null; focusVersion.current++; }; }, []);
  useLayoutEffect(() => {
    if (!active || !editable) { focused.current = false; pendingDone.current = null; focusVersion.current++; ref.current?.blur(); }
  }, [active, editable]);
  const canEdit = () => mounted.current && latest.current.active && latest.current.editable;
  const done = () => {
    const current = latest.current;
    if (!mounted.current || !focused.current || !current.active || !current.editable || pendingDone.current !== null) return;
    // A blur command is not a native text-commit acknowledgement. Keep the
    // field alive until EndEditing, after UIKit's final change has arrived.
    pendingDone.current = focusVersion.current;
    focused.current = false;
    ref.current?.blur();
  };
  const ownAccessory = appKeyboard && props.inputAccessoryViewID == null;
  const accessoryID = ownAccessory ? `${nativeID}-accessory` : props.inputAccessoryViewID;
  return <>
    <TextInput {...props} ref={mergedRef} nativeID={nativeID}
      keyboardAppearance={props.keyboardAppearance ?? "light"}
      inputAccessoryViewID={accessoryID}
      onFocus={event => {
        if (!mounted.current) return;
        if (!latest.current.active || !latest.current.editable) { ref.current?.blur(); return; }
        pendingDone.current = null; focusVersion.current++;
        focused.current = true; latest.current.props.onFocus?.(event);
      }}
      onBlur={event => { if (!mounted.current) return; focused.current = false; latest.current.props.onBlur?.(event); }}
      // Gate retired fields, not native composition. Forward every live event
      // and raw string unchanged; UIKit alone owns marked text and the caret.
      onChange={event => { if (canEdit()) latest.current.props.onChange?.(event); }}
      onChangeText={text => { if (canEdit()) latest.current.props.onChangeText?.(text); }}
      onSelectionChange={event => { if (canEdit()) latest.current.props.onSelectionChange?.(event); }}
      onKeyPress={event => { if (canEdit()) latest.current.props.onKeyPress?.(event); }}
      // Blur/end/layout can finish after a scope closes. Its still-mounted
      // caller needs that cleanup, but no callback may reach an unmounted one.
      onEndEditing={event => {
        if (!mounted.current) return;
        const pending = pendingDone.current;
        pendingDone.current = null; focused.current = false;
        latest.current.props.onEndEditing?.(event);
        // The caller gets UIKit's original final event first and may retire or
        // refocus the field. Never synthesize a second onChangeText from it.
        if (pending !== null && pending === focusVersion.current && canEdit()) latest.current.onAppKeyboardDone?.();
      }}
      onPressIn={event => { if (mounted.current) latest.current.props.onPressIn?.(event); }}
      onPressOut={event => { if (mounted.current) latest.current.props.onPressOut?.(event); }}
      onLayout={event => { if (mounted.current) latest.current.props.onLayout?.(event); }}
      onContentSizeChange={event => { if (mounted.current) latest.current.props.onContentSizeChange?.(event); }}
      onScroll={event => { if (mounted.current) latest.current.props.onScroll?.(event); }}
      onAccessibilityAction={event => { if (mounted.current) latest.current.props.onAccessibilityAction?.(event); }}
      onSubmitEditing={event => {
        const current = latest.current;
        if (!canEdit()) return;
        // Several callers provide both callbacks for platform parity. A real
        // native submit must never dispatch the same request twice. Do not gate
        // on focus: UIKit may blur first for a blurAndSubmit return key.
        if (current.props.onSubmitEditing) current.props.onSubmitEditing(event); else current.onAppKeyboardSubmit?.();
      }}
    />
    {ownAccessory ? <NativeKeyboardAccessory nativeID={accessoryID!} onDone={done} testID={props.testID ?? nativeID} /> : null}
  </>;
});
