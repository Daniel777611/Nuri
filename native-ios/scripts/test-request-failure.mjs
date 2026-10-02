import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

function load(path, dependencies = {}, jsx = false) {
  const output = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: jsx ? ts.JsxEmit.ReactJSX : undefined },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", output)((name) => {
    assert.ok(name in dependencies, `unexpected dependency ${name}`);
    return dependencies[name];
  }, module, module.exports);
  return module.exports;
}

const failure = load("../src/requestFailure.ts");
const consent = load("../src/aiConsent.ts");
const session = load("../src/sessionBoundary.ts");

test("actual permission, changed-session and expired-session errors have distinct classifications", () => {
  assert.equal(failure.requestFailureKind(new consent.AIConsentError("AI_CONSENT_REQUIRED")), "permission");
  assert.equal(failure.requestFailureKind(new consent.AIConsentError("AI_CONSENT_STORAGE_FAILED")), "permission");
  assert.equal(failure.requestFailureKind(new consent.AIConsentError("AI_SESSION_CHANGED")), "session");
  assert.equal(failure.requestFailureKind(new session.SessionChangedError()), "session");
  assert.equal(failure.requestFailureKind({ status: 401, aiConsentRequired: true }), "session");
  assert.equal(failure.requestFailureKind({ aiConsentRequired: true, status: 503 }), "permission");
});

test("timeouts, HTTP failures and unclassified transport errors are not mislabeled AI denial or logout", () => {
  assert.equal(failure.requestFailureKind({ name: "AbortError" }), "timeout");
  for (const status of [400, 403, 404, 422, 429, 500, 503]) {
    assert.equal(failure.requestFailureKind({ status }), "service");
  }
  for (const error of [null, undefined, false, 401, "private-response-body", new Error("private-response-body"), { status: "401" }]) {
    assert.equal(failure.requestFailureKind(error), "connection");
  }
});

test("localized fixed copy explains permission separately and never consumes private error fields", () => {
  const secret = "mock-private-jwt-and-child-name";
  const kind = failure.requestFailureKind({ aiConsentRequired: true, detail: secret, message: secret, token: secret });
  for (const locale of ["zh-CN", "zh-TW", "en"]) {
    for (const type of ["permission", "session", "timeout", "service", "connection"]) {
      const copy = failure.requestFailureCopy(locale, type);
      assert.deepEqual(Object.keys(copy).sort(), ["action", "detail", "title"]);
      assert.ok(Object.values(copy).every((text) => typeof text === "string" && text.length > 0));
      assert.ok(!JSON.stringify(copy).includes(secret));
    }
    const copy = failure.requestFailureCopy(locale, kind);
    assert.match(copy.detail, /OpenAI/);
    assert.match(copy.detail, /not a backend connection failure|不是後端連線失敗|不是后端连接失败/);
  }
  assert.deepEqual(failure.requestFailureCopy("unsupported", "permission"), failure.requestFailureCopy("zh-CN", "permission"));
});

function notice(locale, kind) {
  const calls = [];
  const Component = load("../src/components/RequestFailureNotice.tsx", {
    "react/jsx-runtime": { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    "react-native": { Pressable: "Pressable", View: "View", Text: "Text", StyleSheet: { create: (styles) => styles } },
    "@/src/i18n": { useT: () => ({ locale }) },
    "@/src/theme": { colors: {} },
    "@/src/requestFailure": failure,
  }, true).default;
  const tree = Component({ error: kind, onRetry: () => calls.push("retry"), onPermission: () => calls.push("permission"), onLogin: () => calls.push("login") });
  const find = (node) => {
    if (!node || typeof node !== "object") return null;
    if (node.props?.testID === "request-failure-action") return node;
    for (const child of Array.isArray(node.props?.children) ? node.props.children.flat(Infinity) : [node.props?.children]) {
      const found = find(child); if (found) return found;
    }
    return null;
  };
  return { tree, calls, action: find(tree) };
}

for (const locale of ["zh-CN", "zh-TW", "en"]) test(`actual ${locale} notice invokes permission/login/retry only for the corresponding category`, () => {
  for (const kind of ["permission", "session", "timeout", "service", "connection"]) {
    const ui = notice(locale, kind);
    assert.equal(ui.tree.props.testID, `request-failure-${kind}`);
    assert.ok(ui.action);
    assert.equal(ui.action.props.accessibilityLabel, failure.requestFailureCopy(locale, kind).action);
    ui.action.props.onPress();
    assert.deepEqual(ui.calls, [kind === "permission" ? "permission" : kind === "session" ? "login" : "retry"]);
  }
});
