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
      if (specifier === "./sessionBoundary") return loadTypescriptModule("../src/sessionBoundary.ts");
      throw new Error(`Unexpected runtime import from contract module: ${specifier}`);
    },
    console,
    Date,
    Map,
    URL,
  });
  new vm.Script(compiled.outputText, { filename: filename.pathname }).runInContext(
    context,
  );
  return module.exports;
}

function testHandoffPreservesResourceContextWithoutLeakingMutableInput() {
  const handoff = loadTypescriptModule("../src/recommendationDetailHandoff.ts");
  const card = {
    id: "learn_serve_and_return",
    title: "Serve and return",
    body: "Internal context that must not be republished in the external-link UI.",
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
  // 每日精选 is one source link a day, with a greeting to the parent.
  // Third-party text remains on the original site. It replaced the topic-driven
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
  assert.match(card, /\{nickname\}你好呀，一起看看这个育儿话题/, "the preview still greets the current parent by name");
  assert.match(card, /你好呀，一起看看这个育儿话题/, "the greeting also works without a nickname");
  assert.doesNotMatch(card, /其他妈妈可能会这么处理|其他家长可能会这么处理/, "our guide must not be attributed to an unread parent's source post");
  assert.match(card, /shortResourceSummary\(card\.question, 110\) \|\| shortResourceSummary\(card\.headline, 110\)/, "the preview restores supplied AI question/headline through plain-text normalization");
  assert.match(card, /return preview \|\| nuriResourceGuide\(\{ concern: card\.concern \}, t\)\.headline/, "missing AI preview falls back to NURI's own family-topic guide rather than raw excerpts");
  assert.match(card, /testID="home-daily-post-empty"/, "a day without a post needs an explicit state");

  const detail = read("../app/daily-post.tsx");
  assert.match(
    detail,
    /externalSourceUrl\(card\.source_url\)/,
    "the original post must pass the shared HTTPS source validator",
  );
  assert.match(detail, /Linking\.openURL\(source\)/, "native and web hand validated links to the OS/browser");
  assert.doesNotMatch(detail, /WebBrowser\.openBrowserAsync|<WebView/, "the source must not be republished inside a NURI browser");
  assert.doesNotMatch(detail, /\{card\.(?:excerpt|body|source_body|transcript)\}/, "verbatim third-party excerpts and full source bodies must not render");
  assert.match(detail, /shortResourceSummary\(card\.situation, 240\)/, "the supplied AI situation is a bounded plain-text preview");
  assert.match(detail, /card\.takeaways\.slice\(0, 2\)\.map\(\(value\) => shortResourceSummary\(value, 120\)\)/, "only two bounded AI points may be displayed");
  assert.match(detail, /shortResourceSummary\(card\.why_this, 200\)/, "the recommendation reason must be normalized rather than replaced with invented generic copy");
  assert.match(detail, /testID="daily-post-summary-disclosure">\{t\(RESOURCE_SUMMARY_DISCLOSURE\)\}/, "AI search previews must disclose partial-source and accuracy limitations");
  assert.match(detail, /nuriResourceGuide\(\{ concern: card\.concern \}, t\)/, "the post page's guide must not derive from source excerpts");
  assert.match(detail, /testID="daily-post-guide-disclosure">\{guide\.disclosure\}/, "the page must disclose that its original prompts are not a source summary");
  assert.match(detail, /testID="daily-post-guide-headline">\{guide\.headline\}/, "the original guide must actually be displayed");
  assert.match(detail, /guide\.actions\.map/, "the original reading and discussion prompts must remain useful");
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
    /不代替专业建议/,
    "the card must not present an external parent's experience as professional advice",
  );
}

function testDetailKeepsExternalLinksAtomicWithoutRepublishingSources() {
  const detail = read("../app/detail/[id].tsx");
  assert.match(
    detail,
    /const \[card, setCard\] = useState<any>\(null\)/,
    "cross-session initial state must never retain a personalized handoff",
  );
  assert.match(detail, /const handoff = getRecommendationDetailHandoff\(handoffKey\);[\s\S]*?const guide = guideFromHandoff\(handoff\)/, "the current session still consumes the in-memory resource context before remote research");

  const guideStart = detail.indexOf("function guideFromHandoff(");
  const guideEnd = detail.indexOf("\nexport default function Detail()", guideStart);
  assert.ok(guideStart >= 0 && guideEnd > guideStart, "guide handoff mapper was not found");
  const guideMapper = detail.slice(guideStart, guideEnd);
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
    "a failed background preparation must remain retryable",
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
  assert.match(detail, /testID="detail-external-link-notice"/, "detail must explain that content remains at the source");
  assert.match(detail, /nuriResourceGuide\(\{ concern: card\.topic_label \|\| card\.topic, stage: stageLabel \}, t\)/, "detail's original guide may use only the family topic and stage, never legacy source summaries");
  assert.match(detail, /testID="detail-nuri-guide-headline">\{guide\.headline\}/, "detail must restore useful NURI-authored guidance");
  assert.match(detail, /testID="detail-external-link-notice">\{guide\.disclosure\}/, "the original guide must carry its precise non-summary disclosure");
  assert.match(detail, /externalSourceUrl\(resource\.url\)/, "every source URL must be validated before external navigation");
  assert.match(detail, /Linking\.openURL\(sourceUrl\)/, "source content must open through the operating system");
  assert.match(detail, /externalSourceHost\(resource\.url\)/, "resource provenance must remain visible as a hostname");
  assert.doesNotMatch(detail, /<Image|WebBrowser\.openBrowserAsync|testID="detail-action-steps"/, "unverified source images and source-derived action guides must not render");
  assert.doesNotMatch(detail, /\{resource\.(?:body|source_body|transcript|chinese_guide|spoken_language_evidence)\}/, "external resource source bodies, transcripts and legacy translations must not render");
  assert.match(detail, /shortResourceSummary\(resource\.description, 360\)/, "resource short introductions are normalized, bounded and distinct from full source bodies");
  assert.match(detail, /shortResourceSummary\(resource\.selection_reason, 200\)/, "source selection reasons remain short and useful");
  assert.match(detail, /这是资源短简介，不是原文或完整视频转录/, "resource previews must disclose that they do not replace the original content");
  assert.doesNotMatch(detail, /\{card\.(?:summary|body|guide|hook_line)\}/, "top-level legacy source-derived copy must not bypass the link-only presentation");
  assert.doesNotMatch(detail, /card\.action_steps\.(?:map|slice)/, "source-derived action steps must not be relabeled as our original guide");
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

function testLegacyTranslationMetadataRemainsCompatibleButUnpublished() {
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
  assert.doesNotMatch(detail, /\{resource\.chinese_guide\}/, "legacy translation payloads must not be republished by the link-only detail page");

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

function testExternalSourceValidatorFailsClosed() {
  const { externalSourceUrl, externalSourceHost } = loadTypescriptModule("../src/externalContent.ts");
  assert.equal(externalSourceUrl("https://www.facebook.com/groups/example/posts/123"), "https://www.facebook.com/groups/example/posts/123");
  assert.equal(externalSourceHost("https://www.youtube.com/watch?v=abcdefghijk"), "www.youtube.com");
  for (const source of [
    "http://example.com/page", "javascript:alert(1)", "file:///private/file",
    "https://name:secret@example.com/", "https://localhost/page", "https://127.0.0.1/page",
    "https://service.internal/page", "https://example.com:8443/page",
    "https://example.com/?access_token=secret", "https://example.com/ bad", "not a URL", null,
  ]) assert.equal(externalSourceUrl(source), null, `unsafe source must be rejected: ${source}`);
}

testHandoffPreservesResourceContextWithoutLeakingMutableInput();
testHomeDailyPostCard();
testDetailKeepsExternalLinksAtomicWithoutRepublishingSources();
testLegacyTranslationMetadataRemainsCompatibleButUnpublished();
testExternalSourceValidatorFailsClosed();
console.log("5 recommendation entry contract groups passed");
