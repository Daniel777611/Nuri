// Pure, monotonic identity boundary. Separate from push's token event stream:
// beginning a Keychain replacement must invalidate UI without fake sign-out.
let generation = 0;
let identityGeneration = 0;
const listeners = new Set<() => void>();
export function getSessionGeneration() { return generation; }
export function getIdentityGeneration() { return identityGeneration; }
export function invalidateSession(identityChange = false) {
  generation++;
  if (identityChange) identityGeneration++;
  listeners.forEach((listener) => { try { listener(); } catch { /* No observer owns authentication. */ } });
}
export function subscribeSessionBoundary(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export class SessionChangedError extends Error {
  readonly sessionChanged = true;
  constructor() { super("Session changed; the old result was discarded."); this.name = "SessionChangedError"; }
}
export function assertSessionGeneration(expected: number) {
  if (expected !== generation) throw new SessionChangedError();
}
