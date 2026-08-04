import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");

function read(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function loadTypescriptModule(relativePath) {
  const filename = new URL(relativePath, import.meta.url);
  const source = read(relativePath);
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: filename.pathname,
    reportDiagnostics: true,
  });
  const errors = (compiled.diagnostics || []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  assert.deepEqual(errors, [], `TypeScript transpilation failed for ${relativePath}`);

  const module = { exports: {} };
  const context = vm.createContext({
    module,
    exports: module.exports,
    require(specifier) {
      throw new Error(`Unexpected runtime import from contract module: ${specifier}`);
    },
    console,
    Date,
    Map,
  });
  new vm.Script(compiled.outputText, { filename: filename.pathname }).runInContext(
    context,
  );
  return module.exports;
}

function testHandoffCarriesAnUnreadyGuideWithoutLeakingMutableInput() {
  const handoff = loadTypescriptModule("../src/recommendationDetailHandoff.ts");
  const card = {
    id: "learn_serve_and_return",
    title: "Serve and return",
    body: "A guide that must render before external resources are ready.",
    content_category: "authority",
    recommendation_id: "rec_contract_1",
    resource_readiness: "retryable",
    resource_pair_complete: false,
    resources: [],
  };
  const preparationItems = [
    {
      card_id: card.id,
      recommendation_id: card.recommendation_id,
    },
  ];

  const key = handoff.storeRecommendationDetailHandoff(card, preparationItems);
  card.title = "mutated after navigation";
  preparationItems[0].card_id = "mutated-card";
  const stored = handoff.getRecommendationDetailHandoff(key);

  assert.equal(key, "rec_contract_1");
  assert.equal(stored.card.title, "Serve and return");
  assert.equal(stored.card.resource_readiness, "retryable");
  assert.equal(stored.card.resource_pair_complete, false);
  assert.equal(stored.card.resources.length, 0);
  assert.equal(stored.preparationItems[0].card_id, "learn_serve_and_return");
}

function testHomeClickNavigatesBeforeBackgroundPreparation() {
  const home = read("../app/(tabs)/index.tsx");
  const start = home.indexOf("const openHeroCard = useCallback(");
  const end = home.indexOf("\n  return (", start);
  assert.ok(start >= 0 && end > start, "openHeroCard callback was not found");
  const handler = home.slice(start, end);

  assert.doesNotMatch(
    handler,
    /if\s*\(\s*!isReadyHeroCard\(card\)\s*\)/,
    "an unready card must not return before navigation",
  );
  const handoffAt = handler.indexOf("storeRecommendationDetailHandoff(");
  const navigateAt = handler.indexOf("router.push({");
  const prepareAt = handler.indexOf("preparePersonalizedFeedOnce(");
  assert.ok(handoffAt >= 0, "the guide handoff must be stored before route change");
  assert.ok(navigateAt > handoffAt, "every visible recommendation must navigate");
  assert.ok(
    prepareAt < 0 || prepareAt > navigateAt,
    "background preparation must not block the route transition",
  );

  const carousel = read("../src/components/HeroCarousel.tsx");
  assert.doesNotMatch(
    carousel,
    /disabled=\{cardDisabled\}/,
    "preparing/retryable cards must remain navigable",
  );
  assert.match(
    carousel,
    /pointerEvents="none"[\s\S]{0,180}styles\.refreshingOverlay/,
    "the refresh overlay must never intercept a card click",
  );
}

function testDetailPaintsTheGuideWhileExternalLinksStayAtomic() {
  const detail = read("../app/detail/[id].tsx");
  assert.match(
    detail,
    /const initialHandoff = getRecommendationDetailHandoff\(handoffKey\);[\s\S]{0,180}useState<any>\(\(\) => guideFromHandoff\(initialHandoff\)\)/,
    "the destination must paint the in-memory guide on its first render",
  );

  const guideStart = detail.indexOf("function guideFromHandoff(");
  const guideEnd = detail.indexOf("\nexport default function Detail()", guideStart);
  assert.ok(guideStart >= 0 && guideEnd > guideStart, "guide handoff mapper was not found");
  const guideMapper = detail.slice(guideStart, guideEnd);
  assert.match(
    guideMapper,
    /body:\s*ready\s*\?[^:]+:\s*card\.summary\s*\|\|\s*""/,
    "an unready handoff must still contain readable guide copy",
  );
  assert.match(
    guideMapper,
    /resources:\s*ready\s*\?\s*card\.resources\s*\|\|\s*\[\]\s*:\s*\[\]/,
    "unverified external resources must be stripped from the handoff shell",
  );

  assert.match(
    detail,
    /const resourcePairComplete\s*=\s*card\.resource_readiness === "ready"\s*&&\s*card\.resource_pair_complete === true\s*&&\s*visibleResources\.length === 2/,
    "external links require both ready flags and an exact article/video pair",
  );
  assert.match(
    detail,
    /\{resourcePairComplete \? visibleResources\.map\(\(resource, resourceIndex\) => \([\s\S]*?onPress=\{\(\) => openResource\(resource, resourceIndex \+ 1\)\}/,
    "external-link controls must only render inside the atomic ready branch",
  );
  assert.match(
    detail,
    /testID="detail-prepare-retry"/,
    "a failed background preparation must be retryable from the guide",
  );
  assert.match(
    detail,
    /\(status !== 409 && status !== 404\)[\s\S]{0,180}handoff\?\.preparationItems\.length/,
    "both an unready 409 and a just-prepared stale-link 404 must join shared preparation",
  );
  assert.match(
    detail,
    /await preparePersonalizedFeedOnce\(handoff\.preparationItems\)[\s\S]{0,900}fetchDetail\(preparedItem\.prepared_content_set_id\)/,
    "detail must use the newly prepared set id before fetching external links",
  );
  assert.match(
    detail,
    /isReadyDetail\(current, contentCategory\)[\s\S]{0,120}status !== 404[\s\S]{0,120}status !== 409[\s\S]{0,120}\?\s*current\s*:/,
    "a transient detail GET failure must not erase an already-ready handoff",
  );
}

testHandoffCarriesAnUnreadyGuideWithoutLeakingMutableInput();
testHomeClickNavigatesBeforeBackgroundPreparation();
testDetailPaintsTheGuideWhileExternalLinksStayAtomic();
console.log("recommendation entry contracts passed");
