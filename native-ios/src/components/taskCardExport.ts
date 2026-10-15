type PhotoExportDependencies = {
  requestWritePermission: () => Promise<{ granted: boolean }>;
  captureCard: () => Promise<string>;
  saveToPhotos: (uri: string) => Promise<void>;
  releaseCapture: (uri: string) => void;
};

export class TaskCardExportError extends Error {
  readonly code: "permission_denied" | "empty_image";
  constructor(code: "permission_denied" | "empty_image") {
    super(code);
    this.code = code;
  }
}

/** Only report success after the captured card has been written to Photos. */
export async function saveTaskCardToPhotos(deps: PhotoExportDependencies): Promise<void> {
  const permission = await deps.requestWritePermission();
  if (!permission.granted) throw new TaskCardExportError("permission_denied");
  let uri = "";
  try {
    uri = await deps.captureCard();
    if (!uri) throw new TaskCardExportError("empty_image");
    await deps.saveToPhotos(uri);
  } finally {
    if (uri) deps.releaseCapture(uri);
  }
}

export function firstShareableResource(resources: unknown): { title: string; url: string } | null {
  if (!Array.isArray(resources)) return null;
  for (const resource of resources) {
    if (!resource || typeof resource.url !== "string") continue;
    try {
      const url = new URL(resource.url);
      if (url.protocol !== "https:" || url.username || url.password) continue;
      return { title: typeof resource.title === "string" ? resource.title : "NURI", url: url.toString() };
    } catch { /* Skip malformed source links. */ }
  }
  return null;
}
