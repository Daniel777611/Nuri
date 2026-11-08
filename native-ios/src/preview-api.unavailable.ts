// Data-free Metro replacement for the live iOS build. The real api.ts
// transport stays unchanged and always takes its authenticated network path.
export const isPreviewMode = false;

export async function previewRequest(_path: string, _init?: RequestInit): Promise<never> {
  throw new Error("Sample responses are unavailable in this build.");
}
