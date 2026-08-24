import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const home = read("../app/(tabs)/index.tsx");
const api = read("../src/api.ts");
const previewApi = read("../src/preview-api.ts");

assert.match(
  api,
  /memory_preview\?: \{[\s\S]*?text: string;[\s\S]*?\} \| null;/,
  "the API contract must expose the backend-authored memory preview text",
);
assert.match(
  home,
  /preview\.memory_preview\.text\.trim\(\)/,
  "Home must consume memory_preview.text",
);
assert.doesNotMatch(
  home,
  /memory_preview\.(category|key)/,
  "Home must not expose raw memory category or key labels",
);
assert.match(
  home,
  /const hasPersonalContext = Boolean\(lastUserMessage \|\| memoryText\)/,
  "conversation history and long-term memory must both count as personal context",
);
assert.match(
  home,
  /我记得你提过“\{excerpt\}”。最近有新变化吗？/,
  "memory-only accounts must receive explainable personalized copy",
);
assert.match(
  home,
  /hasPersonalContext[\s\S]*?\? t\("继续对话"\)[\s\S]*?: t\("和我聊聊"\)/,
  "the action label must distinguish personal context from a new conversation",
);
assert.match(
  home,
  /<Pressable[\s\S]*?onPress=\{openNuriChat\}[\s\S]*?testID="home-nuri-card"/,
  "the whole NURI Home card must be the press target",
);
assert.match(
  home,
  /useFocusEffect\([\s\S]*?void loadNuriPreview\(\)/,
  "returning to a focused Home screen must refresh the preview immediately",
);
assert.match(
  home,
  /setNuriPreviewStatus\("loading"\)/,
  "refreshes must retain an explicit loading state",
);
assert.match(
  home,
  /setNuriPreviewStatus\("error"\)/,
  "failed refreshes must retain an explicit error state",
);
assert.match(
  api,
  /getOrStartMainSession: \(\) =>[\s\S]*?req\(`\/chat\/sessions`, \{ method: "POST"/,
  "canonical-session selection must be delegated to the idempotent backend endpoint",
);
assert.doesNotMatch(
  api,
  /getOrStartMainSession:[\s\S]{0,300}source_card_id/,
  "the client must not infer canonical identity from legacy source_card_id",
);
assert.match(
  previewApi,
  /memory_preview: null/,
  "preview mode must honor the memory-preview response shape",
);
assert.match(
  previewApi,
  /const mainSessions = sessions;/,
  "preview mode must not exclude a canonical session because it has legacy card provenance",
);
assert.match(
  previewApi,
  /if \(sessions\.length\) \{[\s\S]*?return latestUserMessage/,
  "preview mode must reuse an existing canonical conversation before creating one",
);

console.log("NURI Home preview contracts passed");
