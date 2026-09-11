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
    action_steps: ["Try one small step"],
    alternate_resource_pairs: [
      {
        pair_id: "pair_backup",
        resources: [
          { id: "a2", kind: "article", title: "Backup article" },
          { id: "v2", kind: "video", title: "Backup video" },
        ],
      },
    ],
  };
  const preparationItems = [
    {
      card_id: card.id,
      recommendation_id: card.recommendation_id,
    },
  ];

  const key = handoff.storeRecommendationDetailHandoff(card, preparationItems);
  card.title = "mutated after navigation";
  card.action_steps[0] = "mutated action";
  card.alternate_resource_pairs[0].resources[0].title = "mutated backup";
  preparationItems[0].card_id = "mutated-card";
  const stored = handoff.getRecommendationDetailHandoff(key);

  assert.equal(key, "rec_contract_1");
  assert.equal(stored.card.title, "Serve and return");
  assert.equal(stored.card.resource_readiness, "retryable");
  assert.equal(stored.card.resource_pair_complete, false);
  assert.equal(stored.card.resources.length, 0);
  assert.equal(stored.card.action_steps[0], "Try one small step");
  assert.equal(
    stored.card.alternate_resource_pairs[0].resources[0].title,
    "Backup article",
  );
  assert.equal(stored.preparationItems[0].card_id, "learn_serve_and_return");
}

function testHomeDailyPostCard() {
  // 每日精选 is one card a day: a real post from another parent on Meta,
  // previewed with a greeting to the parent. It replaced the topic-driven
  // three-card carousel, which Home must no longer drive.
  const home = read("../app/(tabs)/index.tsx");
  assert.doesNotMatch(
    home,
    /HeroCarousel|getPersonalizedFeed|preparePersonalizedFeedOnce/,
    "Home must not rebuild the old per-topic carousel",
  );
  assert.match(
    home,
    /api\.getDailyPost\(\)/,
    "Home must read today's card from the daily-post endpoint",
  );
  assert.match(
    home,
    /useFocusEffect\([\s\S]*?void loadDailyPost\(\)/,
    "every focus re-reads the card, which is how the next day's card appears",
  );
  assert.match(
    home,
    /dailyPostEvent\(card\.id, "open"\)/,
    "opening the card must be recorded for the admin dashboard",
  );

  const card = read("../src/components/DailyPostCard.tsx");
  assert.match(card, /\{nickname\}你好呀，其他妈妈可能会这么处理/, "the preview greets a mom by name");
  assert.match(card, /\{nickname\}你好呀，其他家长可能会这么处理/, "and any other parent as a parent");
  assert.match(card, /testID="home-daily-post-empty"/, "a day without a post needs an explicit state");

  const detail = read("../app/daily-post.tsx");
  assert.match(
    detail,
    /\^https:\\\/\\\//,
    "the original post may only be opened over HTTPS",
  );
  assert.match(detail, /Linking\.openURL\(card\.source_url\)/, "web opens the post directly");
  assert.match(
    detail,
    /WebBrowser\.openBrowserAsync\(card\.source_url\)/,
    "native opens the post in the system browser",
  );
  assert.match(
    detail,
    /dailyPostEvent\(card\.id, "source_click"\)/,
    "tapping through to the post must be recorded",
  );
  assert.match(
    detail,
    /startSession\(\{ card_id: card\.card_id \}\)/,
    "talking it through must hand NURI the card, not start a blank chat",
  );
  assert.match(
    detail,
    /不是专业建议/,
    "the card must say it is one parent's experience, not professional advice",
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
  assert.match(
    detail,
    /testID="detail-delivery-summary"/,
    "detail must disclose source, language, time, stage and readiness",
  );
  assert.match(
    detail,
    /testID="detail-action-steps"/,
    "detail must render the prepared small actions",
  );
  assert.match(
    detail,
    /const \[nextPreparedPair,[\s\S]{0,1000}setCard\([\s\S]{0,1000}getNextResourcePair\(/,
    "a prepared backup must paint locally before persistence begins",
  );
  assert.match(
    detail,
    /nextPreparedPair\.pair_id/,
    "the exact locally selected backup must be persisted by pair id",
  );
  assert.match(detail, /too_long/, "feedback must include a too-long reason");
  assert.match(detail, /too_commercial/, "feedback must include an ad-heavy reason");
}

function testTranslatedAuthorityResourcesAreLabeledWithoutOverclaiming() {
  const presentation = loadTypescriptModule(
    "../src/recommendationPresentation.ts",
  );
  const guidedArticle = {
    id: "cdc-language-guide",
    kind: "article",
    title: "Language milestones",
    publisher: "CDC",
    language: "简体中文",
    source_language: "en",
    display_locale: "zh-CN",
    translation_type: "nuri_guide",
    chinese_guide: "NURI 整理的中文导读。",
  };

  const resourceLabel = presentation.resourceLanguageLabel(guidedArticle);
  assert.equal(resourceLabel, "英文原文 · NURI 中文导读");
  assert.doesNotMatch(
    resourceLabel,
    /官方翻译/,
    "a NURI guide must never be presented as an official translation",
  );
  assert.equal(
    presentation.recommendationLanguageLabel({
      language_label: "机构官方中文",
      resources: [guidedArticle],
    }),
    "英文原文 · NURI 中文导读",
    "resource translation metadata must override a stale card language label",
  );
  assert.equal(
    presentation.resourceLanguageLabel({
      language: "简体中文",
      translation_type: "official_translation",
    }),
    "机构官方中文",
  );
  assert.equal(
    presentation.resourceLanguageLabel({ language: "繁体中文" }),
    "繁体中文",
    "legacy resources without translation metadata must keep their old label",
  );

  const detail = read("../app/detail/[id].tsx");
  assert.match(
    detail,
    /不是发布机构的官方翻译；重要结论请以原文为准。/,
    "the detail page must disclose that a NURI guide is not an official translation",
  );
  assert.match(
    detail,
    /translation_type === "nuri_guide" && resource\.chinese_guide/,
    "the Chinese guide must only render for the explicit nuri_guide contract",
  );

  const api = read("../src/api.ts");
  for (const field of [
    "source_language?: ResourceLocale",
    "display_locale?: ResourceLocale",
    "chinese_guide?: string",
    "translation_type?: ResourceTranslationType",
    "translation_disclaimer?: string",
  ]) {
    assert.ok(api.includes(field), `prepared resources must expose ${field}`);
  }
}

testHandoffCarriesAnUnreadyGuideWithoutLeakingMutableInput();
testHomeDailyPostCard();
testDetailPaintsTheGuideWhileExternalLinksStayAtomic();
testTranslatedAuthorityResourcesAreLabeledWithoutOverclaiming();
console.log("recommendation entry contracts passed");
