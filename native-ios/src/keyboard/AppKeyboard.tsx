import { createContext, forwardRef, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ForwardedRef, type ReactNode } from "react";
import { AppState, Platform, TextInput, View, type TextInputProps } from "react-native";
import { usePathname } from "expo-router";
import { useT, translate, type Locale } from "@/src/i18n";
import { KeyboardPanel } from "./KeyboardPanel";
import { getPinyinCandidates } from "./pinyinEngine";
import { deleteKeyboardSelection, keyboardSelection, replaceKeyboardSelection, type KeyboardEdit, type KeyboardSelection } from "./editingModel";

export type AppKeyboardMode = "zh-CN" | "zh-TW" | "en" | "emoji" | "symbols";
export type AppKeyboardLayout = "text" | "email" | "url" | "numeric" | "decimal" | "phone" | "password";
export type KeyboardPanelProps = {
  layout: AppKeyboardLayout; mode: AppKeyboardMode; shift: boolean; secure: boolean; multiline: boolean;
  returnKeyLabel: string; preedit: string; candidates: readonly string[];
  onText: (text: string) => void; onBackspace: () => void; onSpace: () => void; onEnter: () => void;
  onDone: () => void; onModeChange: (mode: AppKeyboardMode) => void; onShift: () => void;
  onCandidate: (text: string) => void; onDictation?: () => void;
  onSticker?: (id: 1 | 2 | 3 | 4 | 5) => void;
  /** Explicit accessibility/long-press action, never an automatic fallback. */
  onUseSystemKeyboard: () => void; onHeightChange?: (height: number) => void;
};
export type AppKeyboardSnapshot = {
  visible: boolean; activeHostId: string | null; height: number; epoch: number;
  layout: AppKeyboardLayout; mode: AppKeyboardMode; shift: boolean; secure: boolean;
  multiline: boolean; returnKeyLabel: string; preedit: string; candidates: readonly string[]; canDictate: boolean; canSticker: boolean;
};
type FieldSnapshot = {
  value: string; selection: KeyboardSelection; hostId: string; active: boolean; editable: boolean;
  secure: boolean; layout: AppKeyboardLayout; locale: string; multiline: boolean; maxLength?: number; returnKeyLabel: string;
};
export type AppKeyboardBinding = {
  id: string; read: () => FieldSnapshot; apply: (edit: KeyboardEdit) => boolean;
  blur: () => void; system: (enabled: boolean) => void; done?: () => void;
  submit?: () => void; dictate?: () => void; sticker?: (id: 1 | 2 | 3 | 4 | 5) => void;
};
const EMPTY: AppKeyboardSnapshot = { visible: false, activeHostId: null, height: 0, epoch: 0, layout: "text", mode: "en", shift: false, secure: false, multiline: false, returnKeyLabel: "Done", preedit: "", candidates: [], canDictate: false, canSticker: false };
type Composition = { id: string; start: number; end: number; raw: string };
const rootScreens = new Set<AppKeyboardMode>(["zh-CN", "zh-TW", "en", "emoji", "symbols"]);

/** Ephemeral focus controller. It never persists/logs field contents, learns
 * passwords, starts recording, or calls a network service. Drafts remain owned
 * by the original onChangeText controller, including raw uncommitted pinyin. */
export class AppKeyboardController {
  private fields = new Map<string, AppKeyboardBinding>();
  private scopes = new Map<string, boolean>();
  private listeners = new Set<() => void>();
  private activeId: string | null = null;
  private composition: Composition | null = null;
  private enabled = true;
  private snapshot: AppKeyboardSnapshot = EMPTY;
  private preferred: "en" | "zh-CN" | "zh-TW" | null = null;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  private update(patch: Partial<AppKeyboardSnapshot>) { this.snapshot = { ...this.snapshot, ...patch }; this.listeners.forEach(listener => listener()); }
  private field() {
    const binding = this.activeId ? this.fields.get(this.activeId) : undefined;
    if (!binding || !this.enabled) return null;
    const field = binding.read();
    if (!field.active || !field.editable || this.scopes.get(field.hostId) === false) return null;
    return { binding, field };
  }
  register(binding: AppKeyboardBinding) { this.fields.set(binding.id, binding); return () => { if (this.fields.get(binding.id) !== binding) return; this.fields.delete(binding.id); if (this.activeId === binding.id) this.dismiss(false); }; }
  setScope(id: string, active: boolean) { this.scopes.set(id, active); if (!active && this.activeId && this.fields.get(this.activeId)?.read().hostId === id) this.dismiss(); }
  removeScope(id: string) { if (this.activeId && this.fields.get(this.activeId)?.read().hostId === id) this.dismiss(); this.scopes.delete(id); }
  setEnabled(enabled: boolean) { this.enabled = enabled; if (!enabled) this.dismiss(); }
  focus(id: string) {
    const binding = this.fields.get(id), field = binding?.read();
    if (!binding || !field || !this.enabled || !field.active || !field.editable || this.scopes.get(field.hostId) === false) return;
    this.activeId = id; this.composition = null;
    const mode = field.layout === "text" ? this.preferred ?? (field.locale === "zh-CN" || field.locale === "zh-TW" ? field.locale : "en") : "en";
    binding.system(false);
    this.update({ visible: true, activeHostId: field.hostId, height: 0, epoch: this.snapshot.epoch + 1, layout: field.layout, mode, shift: false, secure: field.secure, multiline: field.multiline, returnKeyLabel: field.returnKeyLabel, preedit: "", candidates: [], canDictate: !field.secure && !!binding.dictate, canSticker: !field.secure && !!binding.sticker });
  }
  blur(id: string) { if (this.activeId === id) this.dismiss(false); }
  dismiss = (blur = true) => {
    const previous = this.activeId ? this.fields.get(this.activeId) : undefined;
    this.activeId = null; this.composition = null;
    this.update({ visible: false, activeHostId: null, height: 0, epoch: this.snapshot.epoch + 1, preedit: "", candidates: [], canDictate: false, canSticker: false });
    previous?.system(false); if (blur) previous?.blur();
  };
  refresh(id: string) {
    if (this.activeId !== id) return;
    const current = this.field();
    if (!current) { this.dismiss(); return; }
    const { field, binding } = current;
    if (this.composition && (field.value.slice(this.composition.start, this.composition.end) !== this.composition.raw || field.selection.start !== this.composition.end || field.selection.end !== this.composition.end)) this.clearComposition();
    if (this.snapshot.layout !== field.layout || this.snapshot.secure !== field.secure) {
      this.clearComposition(); this.update({ layout: field.layout, secure: field.secure, mode: "en", canDictate: !field.secure && !!binding.dictate, canSticker: !field.secure && !!binding.sticker });
    }
    const canDictate = !field.secure && !!binding.dictate, canSticker = !field.secure && !!binding.sticker;
    if (this.snapshot.canDictate !== canDictate || this.snapshot.canSticker !== canSticker || this.snapshot.multiline !== field.multiline || this.snapshot.returnKeyLabel !== field.returnKeyLabel) this.update({ canDictate, canSticker, multiline: field.multiline, returnKeyLabel: field.returnKeyLabel });
  }
  externalEdit(id: string) { if (this.activeId === id) { this.clearComposition(); this.update({ epoch: this.snapshot.epoch + 1 }); } }
  private clearComposition() { this.composition = null; if (this.snapshot.preedit || this.snapshot.candidates.length) this.update({ preedit: "", candidates: [] }); }
  private publishComposition() {
    const raw = this.composition?.raw ?? "", mode = this.snapshot.mode;
    const candidates = raw && (mode === "zh-CN" || mode === "zh-TW") ? getPinyinCandidates(raw, mode) : [];
    this.update({ preedit: raw, candidates });
  }
  private validComposition(field: FieldSnapshot) {
    const c = this.composition;
    return c && c.id === this.activeId && field.value.slice(c.start, c.end) === c.raw && field.selection.start === c.end && field.selection.end === c.end ? c : null;
  }
  text = (input: string) => {
    const current = this.field(); if (!current || !this.snapshot.visible || !input) return;
    const { field, binding } = current;
    let text = input;
    if (field.layout === "numeric") text = text.replace(/\D/g, "");
    else if (field.layout === "decimal") text = text.replace(/[^0-9.,-]/g, "");
    else if (field.layout === "phone") text = text.replace(/[^0-9+*#(), -]/g, "");
    if (!text) return;
    const composing = field.layout === "text" && !field.secure && (this.snapshot.mode === "zh-CN" || this.snapshot.mode === "zh-TW") && /^[a-z']+$/i.test(text);
    const previous = composing ? this.validComposition(field) : null;
    if (!composing) this.clearComposition();
    if (this.snapshot.mode === "en" && this.snapshot.shift) text = text.toUpperCase();
    const range = keyboardSelection(field.value, field.selection), edit = replaceKeyboardSelection(field.value, range, text, field.maxLength);
    if (!edit.inserted && edit.value === field.value) return;
    if (!binding.apply(edit)) return;
    if (composing && edit.inserted) {
      this.composition = { id: binding.id, start: previous?.start ?? range.start, end: edit.selection.end, raw: (previous?.raw ?? "") + edit.inserted };
      this.publishComposition();
    } else if (composing) this.clearComposition();
    if (this.snapshot.shift) this.update({ shift: false });
  };
  backspace = () => {
    const current = this.field(); if (!current || !this.snapshot.visible) return;
    const previous = this.validComposition(current.field), edit = deleteKeyboardSelection(current.field.value, current.field.selection);
    if (edit.value === current.field.value && edit.selection.start === current.field.selection.start && edit.selection.end === current.field.selection.end) return;
    if (!current.binding.apply(edit)) return;
    if (previous && edit.selection.end >= previous.start) { const raw = edit.value.slice(previous.start, edit.selection.end); this.composition = raw ? { ...previous, end: edit.selection.end, raw } : null; this.publishComposition(); }
    else this.clearComposition();
  };
  candidate = (text: string) => {
    const current = this.field(); if (!current || !this.snapshot.visible || current.field.secure || !this.snapshot.candidates.includes(text)) return;
    const composition = this.validComposition(current.field); if (!composition) { this.clearComposition(); return; }
    const edit = replaceKeyboardSelection(current.field.value, { start: composition.start, end: composition.end }, text, current.field.maxLength);
    // Never replace a whole pinyin phrase with a truncated candidate.
    if (edit.inserted !== text || !current.binding.apply(edit)) return;
    this.clearComposition();
  };
  space = () => { if (this.snapshot.candidates[0]) this.candidate(this.snapshot.candidates[0]); else this.text(" "); };
  enter = () => {
    const current = this.field(); if (!current || !this.snapshot.visible) return;
    if (this.snapshot.candidates[0]) { this.candidate(this.snapshot.candidates[0]); return; }
    this.clearComposition();
    if (current.field.multiline) this.text("\n");
    else if (current.binding.submit) current.binding.submit(); else this.done();
  };
  done = () => { const current = this.field(); this.dismiss(); current?.binding.done?.(); };
  mode = (mode: AppKeyboardMode) => {
    const current = this.field(); if (!current || !rootScreens.has(mode)) return;
    if (current.field.layout !== "text" && mode !== "en" && mode !== "symbols") return;
    if (current.field.secure && mode !== "en" && mode !== "symbols") return;
    this.clearComposition();
    if (!current.field.secure && current.field.layout === "text" && (mode === "en" || mode === "zh-CN" || mode === "zh-TW")) this.preferred = mode;
    this.update({ mode, shift: false });
  };
  shift = () => { if (this.field()) this.update({ shift: !this.snapshot.shift }); };
  dictate = () => { const current = this.field(); if (!current || current.field.secure || !current.binding.dictate) return; this.dismiss(); current.binding.dictate(); };
  sticker = (id: 1 | 2 | 3 | 4 | 5) => { const current = this.field(); if (!current || current.field.secure || !current.binding.sticker || ![1,2,3,4,5].includes(id)) return; this.clearComposition(); current.binding.sticker(id); };
  system = () => {
    const current = this.field(); if (!current) return;
    this.clearComposition(); this.update({ visible: false, height: 0, activeHostId: null, epoch: this.snapshot.epoch + 1 });
    current.binding.system(true);
  };
  height = (hostId: string, epoch: number, height: number) => { if (this.snapshot.visible && this.snapshot.activeHostId === hostId && this.snapshot.epoch === epoch && Number.isFinite(height) && height >= 0 && height !== this.snapshot.height) this.update({ height }); };
}

const ControllerContext = createContext<AppKeyboardController | null>(null);
const ScopeContext = createContext({ id: "root", active: true });
const noopSubscribe = () => () => {};
const emptySnapshot = () => EMPTY;

export function AppKeyboardProvider({ children, ownerKey }: { children: ReactNode; ownerKey?: string | number }) {
  const path = usePathname(), controllerRef = useRef<AppKeyboardController | null>(null);
  if (!controllerRef.current) controllerRef.current = new AppKeyboardController();
  const controller = controllerRef.current, location = useRef({ path, ownerKey });
  useEffect(() => {
    controller.setEnabled(!AppState.currentState || AppState.currentState === "active");
    const subscription = AppState.addEventListener("change", state => controller.setEnabled(state === "active"));
    return () => { subscription.remove(); controller.setEnabled(false); };
  }, [controller]);
  useEffect(() => { if (location.current.path !== path || location.current.ownerKey !== ownerKey) { location.current = { path, ownerKey }; controller.dismiss(); } }, [controller, path, ownerKey]);
  return <ControllerContext.Provider value={controller}>{children}</ControllerContext.Provider>;
}

export function AppKeyboardScope({ id, active = true, children }: { id: string; active?: boolean; children: ReactNode }) {
  const controller = useContext(ControllerContext);
  const context = useMemo(() => ({ id, active }), [id, active]);
  useEffect(() => { controller?.setScope(id, active); return () => controller?.removeScope(id); }, [controller, id, active]);
  return <ScopeContext.Provider value={context}>{children}</ScopeContext.Provider>;
}

export function useAppKeyboard() {
  const controller = useContext(ControllerContext);
  const snapshot = useSyncExternalStore(controller?.subscribe ?? noopSubscribe, controller?.getSnapshot ?? emptySnapshot, emptySnapshot);
  const lease = <T extends unknown[]>(action: ((...args: T) => void) | undefined) => (...args: T) => { const current = controller?.getSnapshot(); if (current?.visible && current.epoch === snapshot.epoch) action?.(...args); };
  return { ...snapshot, dismiss: controller?.dismiss ?? (() => {}), onText: lease(controller?.text), onBackspace: lease(controller?.backspace), onSpace: lease(controller?.space), onEnter: lease(controller?.enter), onDone: lease(controller?.done), onModeChange: lease(controller?.mode), onShift: lease(controller?.shift), onCandidate: lease(controller?.candidate), onDictation: snapshot.canDictate ? lease(controller?.dictate) : undefined, onSticker: snapshot.canSticker ? lease(controller?.sticker) : undefined, onUseSystemKeyboard: lease(controller?.system) };
}
export function useAppKeyboardVisible(scopeId?: string) { const keyboard = useAppKeyboard(); return keyboard.visible && (!scopeId || keyboard.activeHostId === scopeId); }

/** The host is a normal flex footer, never an overlay on a native keyboard.
 * Each native Modal must provide its own scope/host in its own view layer. */
export function AppKeyboardHost({ scopeId = "root" }: { scopeId?: string }) {
  const controller = useContext(ControllerContext), keyboard = useAppKeyboard();
  if (!keyboard.visible || keyboard.activeHostId !== scopeId) return null;
  const { layout, mode, shift, secure, multiline, returnKeyLabel, preedit, candidates, onText, onBackspace, onSpace, onEnter, onDone, onModeChange, onShift, onCandidate, onDictation, onSticker, onUseSystemKeyboard } = keyboard;
  const content = <KeyboardPanel {...{ layout, mode, shift, secure, multiline, returnKeyLabel, preedit, candidates, onText, onBackspace, onSpace, onEnter, onDone, onModeChange, onShift, onCandidate, onDictation, onSticker, onUseSystemKeyboard }} onHeightChange={(height: number) => controller?.height(scopeId, keyboard.epoch, height)} />;
  // Preserve the real input's selection on pointer activation. Keyboard/AX
  // navigation remains available; blur checks below also recognise this host.
  if (Platform.OS === "web") return <div data-nuri-keyboard-host={scopeId} onPointerDownCapture={event => event.preventDefault()} style={{ flexShrink: 0, width: "100%" }}>{content}</div>;
  return <View testID={`app-keyboard-host-${scopeId}`} style={{ flexShrink: 0, width: "100%" }}>{content}</View>;
}

export type NuriTextInputProps = TextInputProps & {
  appKeyboard?: boolean; keyboardActive?: boolean; keyboardId?: string;
  onAppKeyboardSubmit?: () => void; onAppKeyboardDone?: () => void; onAppKeyboardDictation?: () => void; onAppKeyboardSticker?: (id: 1 | 2 | 3 | 4 | 5) => void;
};
/** Re-export the original host-instance type for existing useRef/forwardRef
 * annotations when the wrapper is imported in place of TextInput. */
export type NuriTextInput = TextInput;
function setForwardedRef(ref: ForwardedRef<TextInput>, value: TextInput | null) { if (typeof ref === "function") ref(value); else if (ref) ref.current = value; }
function layoutFor(props: TextInputProps): AppKeyboardLayout {
  if (props.secureTextEntry) return "password";
  if (props.inputMode === "numeric" || props.keyboardType === "number-pad" || props.keyboardType === "numeric") return "numeric";
  if (props.inputMode === "decimal" || props.keyboardType === "decimal-pad") return "decimal";
  if (props.inputMode === "tel" || props.keyboardType === "phone-pad") return "phone";
  if (props.inputMode === "email" || props.keyboardType === "email-address") return "email";
  if (props.inputMode === "url" || props.keyboardType === "url") return "url";
  return "text";
}
function returnLabel(props: TextInputProps, locale: Locale) {
  if (props.returnKeyLabel) return props.returnKeyLabel;
  const hint = props.enterKeyHint ?? props.returnKeyType;
  if (hint === "send") return locale === "en" ? "Send" : translate(locale, "发送");
  if (hint === "search") return locale === "en" ? "Search" : translate(locale, "搜索");
  if (hint === "next") return locale === "en" ? "Next" : translate(locale, "下一步");
  return props.multiline ? locale === "en" ? "Return" : translate(locale, "换行") : locale === "en" ? "Done" : translate(locale, "完成");
}

/** Keep the original native/DOM TextInput instance, refs, callbacks and drafts.
 * Only soft-keyboard presentation and virtual-edit selection are adapted. */
export const NuriTextInput = forwardRef<TextInput, NuriTextInputProps>(function NuriTextInput({ appKeyboard = true, keyboardActive = true, keyboardId, onAppKeyboardSubmit, onAppKeyboardDone, onAppKeyboardDictation, onAppKeyboardSticker, ...props }, forwardedRef) {
  const controller = useContext(ControllerContext), scope = useContext(ScopeContext), { locale } = useT();
  const generatedId = useId(), id = keyboardId ?? `nuri-input-${generatedId}`;
  const ref = useRef<TextInput | null>(null), mounted = useRef(true), focusVersion = useRef(0);
  const [uncontrolled, setUncontrolled] = useState(props.defaultValue ?? ""), [selection, setSelection] = useState<KeyboardSelection | undefined>(), [system, setSystem] = useState(false);
  const [nativeEditVersion, setNativeEditVersion] = useState(0);
  const value = props.value ?? uncontrolled;
  const live = useRef({ value, selection: keyboardSelection(value, props.selection ? { start: props.selection.start, end: props.selection.end ?? props.selection.start } : { start: value.length, end: value.length }) });
  const accepted = useRef(value);
  const latest = useRef({ props, scope, locale, appKeyboard, keyboardActive, onAppKeyboardSubmit, onAppKeyboardDone, onAppKeyboardDictation, onAppKeyboardSticker });
  latest.current = { props, scope, locale, appKeyboard, keyboardActive, onAppKeyboardSubmit, onAppKeyboardDone, onAppKeyboardDictation, onAppKeyboardSticker };
  const mergedRef = useCallback((node: TextInput | null) => { ref.current = node; setForwardedRef(forwardedRef, node); }, [forwardedRef]);
  const binding = useMemo<AppKeyboardBinding>(() => ({
    id,
    read: () => {
      const current = latest.current;
      return { ...live.current, hostId: current.scope.id, active: mounted.current && current.scope.active && current.keyboardActive && current.appKeyboard, editable: current.props.editable !== false && current.props.readOnly !== true, secure: !!current.props.secureTextEntry, layout: layoutFor(current.props), locale: current.locale, multiline: !!current.props.multiline, maxLength: current.props.maxLength, returnKeyLabel: returnLabel(current.props, current.locale) };
    },
    apply: edit => {
      const current = latest.current;
      if (!mounted.current || current.props.editable === false || current.props.readOnly === true || !current.scope.active || !current.keyboardActive) return false;
      // Optimistic only in this field's private ref: multiple taps in one React
      // batch must append, not repeatedly replace the same stale props.value.
      live.current = { value: edit.value, selection: edit.selection };
      setSelection(edit.selection);
      if (current.props.value === undefined) setUncontrolled(edit.value);
      current.props.onChangeText?.(edit.value);
      return true;
    },
    blur: () => ref.current?.blur(),
    system: enabled => { if (mounted.current) setSystem(enabled); },
    get submit() { return latest.current.onAppKeyboardSubmit; },
    get done() { return latest.current.onAppKeyboardDone; },
    get dictate() { return latest.current.onAppKeyboardDictation; },
    get sticker() { return latest.current.onAppKeyboardSticker; },
  }), [id]);
  useLayoutEffect(() => { mounted.current = true; const unregister = controller?.register(binding); return () => { mounted.current = false; unregister?.(); }; }, [controller, binding]);
  useLayoutEffect(() => {
    // The declared controlled value is authoritative even when its parent
    // rejects an edit and therefore leaves value unchanged. Never let the
    // private optimistic caret/text survive as invisible "phantom" input.
    if (accepted.current !== value || props.value !== undefined && value !== live.current.value) {
      if (value !== live.current.value) controller?.externalEdit(id);
      accepted.current = value;
      live.current = { value, selection: keyboardSelection(value, live.current.selection) };
      setSelection(previous => previous ? keyboardSelection(value, previous) : previous);
    }
    controller?.refresh(id);
  }, [controller, id, value, props.value, selection, nativeEditVersion, scope.id, scope.active, keyboardActive, appKeyboard, locale, props.editable, props.readOnly, props.secureTextEntry, props.keyboardType, props.inputMode, props.returnKeyType, props.enterKeyHint, props.returnKeyLabel, onAppKeyboardDictation, onAppKeyboardSticker]);
  useLayoutEffect(() => { if (props.selection) { live.current.selection = keyboardSelection(live.current.value, { start: props.selection.start, end: props.selection.end ?? props.selection.start }); setSelection(undefined); controller?.refresh(id); } }, [controller, id, props.selection?.start, props.selection?.end]);
  useLayoutEffect(() => { if (system && mounted.current) ref.current?.focus(); }, [system]);
  const managed = !!controller && appKeyboard;
  const enabled = managed && scope.active && keyboardActive;
  return <TextInput {...props} ref={mergedRef} value={value} selection={selection ?? props.selection}
    showSoftInputOnFocus={managed && !system ? false : props.showSoftInputOnFocus}
    inputMode={Platform.OS === "web" && managed && !system ? "none" : props.inputMode}
    inputAccessoryViewID={managed && !system ? undefined : props.inputAccessoryViewID}
    onFocus={event => { focusVersion.current++; if (managed && !enabled) { ref.current?.blur(); return; } if (enabled && !system) controller?.focus(id); props.onFocus?.(event); }}
    onBlur={event => {
      props.onBlur?.(event);
      if (Platform.OS === "web") { const version = focusVersion.current; queueMicrotask(() => { if (!mounted.current || version !== focusVersion.current || typeof document !== "undefined" && document.activeElement?.closest("[data-nuri-keyboard-host]")) return; controller?.blur(id); }); }
      else controller?.blur(id);
    }}
    onChangeText={text => { live.current = { value: text, selection: keyboardSelection(text, live.current.selection) }; if (props.value === undefined) setUncontrolled(text); setSelection(undefined); setNativeEditVersion(version => version + 1); controller?.externalEdit(id); props.onChangeText?.(text); }}
    onSelectionChange={event => { const next = keyboardSelection(live.current.value, event.nativeEvent.selection); live.current.selection = next; setSelection(undefined); controller?.refresh(id); props.onSelectionChange?.(event); }}
    accessibilityActions={[...(props.accessibilityActions ?? []), ...(enabled ? [{ name: "useSystemKeyboard", label: locale === "en" ? "Use system keyboard" : translate(locale, "使用系统键盘") }] : [])]}
    onAccessibilityAction={event => { if (event.nativeEvent.actionName === "useSystemKeyboard" && enabled) { controller?.focus(id); controller?.system(); } else props.onAccessibilityAction?.(event); }}
  />;
});
