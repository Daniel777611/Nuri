import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from "react";
import { auth } from "./api";

/** Old render closures own their epoch, including A → B → A. */
export function useAccountScope() {
  const generation = useSyncExternalStore(auth.subscribeSessionBoundary, auth.getSessionGeneration, auth.getSessionGeneration);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const capture = useCallback(() => mounted.current && generation === auth.getSessionGeneration() ? generation : null, [generation]);
  const current = useCallback((ticket: number | null) => mounted.current && ticket !== null && ticket === generation && ticket === auth.getSessionGeneration(), [generation]);
  const isMounted = useCallback(() => mounted.current, []);
  return { generation, capture, current, isMounted };
}

/** A session change renders the initial value immediately, not old private
 * data until an effect clears it. Old setters/unmounted callbacks are ignored. */
export function useAccountState<S>(initial: S | (() => S)): [S, Dispatch<SetStateAction<S>>] {
  const scope = useAccountScope();
  const first = useRef<{ value: S } | null>(null);
  if (!first.current) first.current = { value: typeof initial === "function" ? (initial as () => S)() : initial };
  const [cell, setCell] = useState(() => ({ generation: scope.generation, value: first.current!.value }));
  const generation = scope.generation;
  const current = scope.current;
  const setValue = useCallback<Dispatch<SetStateAction<S>>>((next) => {
    if (!current(generation)) return;
    setCell((previous) => {
      if (!current(generation)) return previous;
      const value = previous.generation === generation ? previous.value : first.current!.value;
      return { generation, value: typeof next === "function" ? (next as (previous: S) => S)(value) : next };
    });
  }, [current, generation]);
  return [cell.generation === generation ? cell.value : first.current.value, setValue];
}
