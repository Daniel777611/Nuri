import { useCallback, useRef } from "react";
import { useAccountScope, useAccountState } from "@/src/useAccountState";

/** Auth text is only needed at submission; UIKit/the input host owns editing.
 * Echoing every native character through the whole glass form's controlled
 * value prop needlessly repaints the material and can disturb native editing.
 * Publish only readiness transitions. Never normalize passwords/IME text here.
 *
 * The native fields MUST be keyed by generation and use initial/defaultValue,
 * not value. An account boundary then clears native text in the same commit;
 * retired event/submit callbacks cannot read or alter the new draft. */
export function useNativeAuthDraft<Values extends Record<string, string>>(
  initial: Values,
  isReady: (values: Values) => boolean,
) {
  const { generation, current } = useAccountScope();
  const first = useRef(initial);
  const draft = useRef({ generation, values: { ...first.current }, ready: isReady(first.current) });
  if (draft.current.generation !== generation) {
    draft.current = { generation, values: { ...first.current }, ready: isReady(first.current) };
  }
  const [ready, setReady] = useAccountState(() => isReady(first.current));
  const change = useCallback((field: keyof Values, text: string) => {
    if (!current(generation) || draft.current.generation !== generation) return;
    const values = { ...draft.current.values, [field]: text };
    const nextReady = isReady(values);
    draft.current.values = values;
    if (nextReady !== draft.current.ready) {
      draft.current.ready = nextReady;
      setReady(nextReady);
    }
  }, [generation, current, isReady, setReady]);
  const read = useCallback((): Values | null => {
    if (!current(generation) || draft.current.generation !== generation || !isReady(draft.current.values)) return null;
    // An in-flight request owns a snapshot, not the mutable editing draft.
    return { ...draft.current.values };
  }, [generation, current, isReady]);
  return { generation, initial: first.current, ready, change, read };
}
