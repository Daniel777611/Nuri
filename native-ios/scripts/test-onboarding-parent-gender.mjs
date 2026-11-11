import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => resolve = done); return { promise, resolve }; }
const namespaces = { "app-store": "com.ordashtech.nuri.nativelab.v1.", alpha: "com.ordashtech.nuri.nativelab.v1.", "early-access": "com.ordashtech.nuri.earlyaccess.v1." };

function fixture(platform = "native", flavor = "app-store", shared = new Map()) {
  const calls = [], logs = [], options = Object.freeze({ keychainService: flavor === "early-access" ? "com.ordashtech.nuri.earlyaccess.credentials.v1" : "com.ordashtech.nuri.nativelab.credentials.v1", keychainAccessible: 7 });
  const f = { failRead: false, failWrite: false, dropWrite: false, wrongReadback: false, readBarrier: null, writeBarrier: null, afterRead: null, afterWrite: null };
  const key = (name, opts) => platform === "native" ? `${opts.keychainService}:${name}` : name;
  const storage = {
    getItem(name, opts) {
      calls.push(["read", name, opts]);
      const result = () => {
        if (f.failRead) throw Error("private provider body fixture-user-A fixture-token");
        f.afterRead?.();
        return f.wrongReadback ? "wrong private body" : shared.get(key(name, opts)) ?? null;
      };
      return platform === "native" ? (async () => { if (f.readBarrier) await f.readBarrier.promise; return result(); })() : result();
    },
    setItem(name, raw, opts) {
      calls.push(["write", name, opts]);
      const work = () => {
        if (f.failWrite) throw Error("private provider body fixture-user-A fixture-token");
        if (!f.dropWrite) shared.set(key(name, opts), raw);
        f.afterWrite?.();
      };
      return platform === "native" ? (async () => { if (f.writeBarrier) await f.writeBarrier.promise; work(); })() : work();
    },
  };
  const module = { exports: {} }, source = read(`src/onboardingParentGender${platform === "web" ? ".web" : ""}.ts`);
  const deps = { "expo-secure-store": { getItemAsync: storage.getItem, setItemAsync: storage.setItem }, "./utils/storage": { NATIVE_STORAGE_NAMESPACE: namespaces[flavor], NATIVE_SECURE_STORAGE_OPTIONS: options } };
  const context = { module, exports: module.exports, process: { env: { EXPO_PUBLIC_RELEASE_FLAVOR: flavor } }, localStorage: storage,
    console: Object.fromEntries(["log", "warn", "error"].map(name => [name, (...args) => logs.push([name, ...args])])),
    require: name => { assert.ok(Object.hasOwn(deps, name), `Unexpected dependency ${name}`); return deps[name]; } };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context);
  return Object.assign(f, module.exports, { calls, logs, shared, options });
}
const owns = async () => true;
const rejected = (f, promise, code) => assert.rejects(promise, error => error instanceof f.ParentGenderStorageError && error.code === code && !/fixture-user|fixture-token|provider body/.test(error.message));

for (const platform of ["native", "web"]) {
  test(`${platform}: a missing choice is hidden; each enum round-trips only for its verified account`, async () => {
    const f = fixture(platform);
    assert.equal(await f.readParentGender("fixture-user-A", owns), "hidden");
    for (const value of ["female", "male", "hidden"]) {
      await f.saveParentGender("fixture-user-A", value, owns);
      assert.equal(await f.readParentGender("fixture-user-A", owns), value);
      assert.equal(await f.readParentGender("fixture-user-B", owns), "hidden");
    }
    assert.equal(f.logs.length, 0);
  });
  test(`${platform}: invalid identities, malformed records and unsupported values never silently succeed`, async () => {
    const f = fixture(platform);
    for (const id of ["", "   ", null, undefined, 42]) {
      await rejected(f, f.readParentGender(id, owns), "invalid-user");
      await rejected(f, f.saveParentGender(id, "hidden", owns), "invalid-user");
    }
    for (const value of ["mom", "dad", "other", "", null, true]) await rejected(f, f.saveParentGender("fixture-user-A", value, owns), "invalid-value");
    assert.equal(f.calls.length, 0);
    await f.saveParentGender("fixture-user-A", "female", owns);
    const storedKey = [...f.shared.keys()][0];
    for (const raw of ["not-json", '"female"', "null", JSON.stringify({ version: 1, owner: "fixture-user-B", value: "female" }), JSON.stringify({ version: 2, owner: "fixture-user-A", value: "female" }), JSON.stringify({ version: 1, owner: "fixture-user-A", value: "mom" })]) {
      f.shared.set(storedKey, raw); await rejected(f, f.readParentGender("fixture-user-A", owns), "invalid-value");
    }
  });
  test(`${platform}: read/write failures and unconfirmed writes are explicit and sanitized, not hidden defaults or successful saves`, async () => {
    const f = fixture(platform); f.failRead = true;
    await rejected(f, f.readParentGender("fixture-user-A", owns), "storage");
    f.failRead = false; f.failWrite = true;
    await rejected(f, f.saveParentGender("fixture-user-A", "female", owns), "storage");
    f.failWrite = false; f.dropWrite = true;
    await rejected(f, f.saveParentGender("fixture-user-A", "female", owns), "storage");
    f.dropWrite = false; f.wrongReadback = true;
    await rejected(f, f.saveParentGender("fixture-user-A", "female", owns), "storage");
    assert.equal(f.logs.length, 0);
  });
  test(`${platform}: stale or rejected ownership checks prevent access and queued writes recheck their owner`, async () => {
    const f = fixture(platform);
    for (const owner of [async () => false, async () => { throw Error("private ownership body"); }]) {
      await rejected(f, f.readParentGender("fixture-user-A", owner), "stale");
      await rejected(f, f.saveParentGender("fixture-user-A", "female", owner), "stale");
    }
    assert.equal(f.calls.length, 0);
    let current = true; f.afterRead = () => { current = false; };
    await rejected(f, f.readParentGender("fixture-user-A", async () => current), "stale");
    current = true; f.afterRead = null; f.afterWrite = () => { current = false; };
    await rejected(f, f.saveParentGender("fixture-user-A", "female", async () => current), "stale");
    const writes = f.calls.filter(call => call[0] === "write").length;
    await rejected(f, f.saveParentGender("fixture-user-A", "male", async () => current), "stale");
    assert.equal(f.calls.filter(call => call[0] === "write").length, writes);
    assert.equal(await f.readParentGender("fixture-user-B", owns), "hidden");
  });
  test(`${platform}: consecutive writes preserve ordering and failed writes do not poison later saves`, async () => {
    const f = fixture(platform);
    await Promise.all([f.saveParentGender("fixture-user-A", "female", owns), f.saveParentGender("fixture-user-A", "male", owns)]);
    assert.equal(await f.readParentGender("fixture-user-A", owns), "male");
    f.failWrite = true; await rejected(f, f.saveParentGender("fixture-user-A", "female", owns), "storage");
    f.failWrite = false; await f.saveParentGender("fixture-user-A", "hidden", owns);
    assert.equal(await f.readParentGender("fixture-user-A", owns), "hidden");
  });
}
test("native: ownership switches during suspended read/write cannot return A's value or save B's choice", async () => {
  const f = fixture(), read = deferred(); f.readBarrier = read;
  let current = true;
  const pendingRead = f.readParentGender("fixture-user-A", async () => current); await tick(); current = false; read.resolve();
  await rejected(f, pendingRead, "stale");
  f.readBarrier = null; current = true; const write = deferred(); f.writeBarrier = write;
  const pendingWrite = f.saveParentGender("fixture-user-A", "female", async () => current); await tick();
  const queued = f.saveParentGender("fixture-user-A", "male", async () => current);
  current = false; write.resolve(); await rejected(f, pendingWrite, "stale"); await rejected(f, queued, "stale");
  assert.equal(f.calls.filter(call => call[0] === "write").length, 1);
  assert.equal(await f.readParentGender("fixture-user-B", owns), "hidden");
});
test("native: all three flavors reuse their exact existing namespace/options and do not mutate credentials or onboarding", async () => {
  for (const flavor of ["app-store", "alpha", "early-access"]) {
    const f = fixture("native", flavor); await f.saveParentGender("id/with:Unicode家", "female", owns);
    for (const call of f.calls) { assert.ok(call[1].startsWith(namespaces[flavor] + "onboarding_parent_gender.v1.")); assert.match(call[1], /^[\w.-]+$/); assert.equal(call[2], f.options); }
    assert.equal(f.shared.size, 1); assert.doesNotMatch([...f.shared.keys()][0], /auth_token|onboarding_completed/);
  }
  const source = read("src/onboardingParentGender.ts"); assert.doesNotMatch(source, /console\.|\bfetch\(|parent_role\s*:|setAllowed\(|setOnboarded\(/);
});
test("web: same-origin release identities and account IDs stay separate; Alpha preserves the Beta identity", async () => {
  const shared = new Map();
  const prod = fixture("web", "app-store", shared), alpha = fixture("web", "alpha", shared), preview = fixture("web", "early-access", shared);
  await prod.saveParentGender("fixture-user-A", "female", owns); await alpha.saveParentGender("fixture-user-A", "male", owns);
  assert.equal(await prod.readParentGender("fixture-user-A", owns), "female"); assert.equal(await alpha.readParentGender("fixture-user-A", owns), "male");
  assert.equal(await preview.readParentGender("fixture-user-A", owns), "hidden");
  const beta = fixture("web", "beta", shared); assert.equal(await beta.readParentGender("fixture-user-A", owns), "male");
});
