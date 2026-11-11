import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function moduleWithMocks(path, mocks, globals = {}) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module,
    exports: module.exports,
    require: (name) => {
      assert.ok(name in mocks, `Unexpected import: ${name}`);
      return mocks[name];
    },
    ...globals,
  }, { filename: path });
  return module.exports;
}

const settle = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };

function appState() {
  const listeners = new Set();
  return {
    currentState: "active",
    addEventListener(_event, listener) {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
    emit(state) {
      this.currentState = state;
      for (const listener of [...listeners]) listener(state);
    },
    listeners,
  };
}

function voiceHarness(options = {}) {
  let now = 100_000;
  let timerId = 0;
  const timers = new Map();
  const state = appState();
  const calls = { modes: [], active: [], deletes: 0, reads: 0, recorders: [] };
  const file = { exists: true, size: options.size ?? 12, base64: options.base64 ?? "YXVkaW8=" };
  class Recorder {
    constructor(recordingOptions) {
      this.options = recordingOptions;
      this.uri = "file:///cache/voice.m4a";
      this.status = { isRecording: true, durationMillis: 0, metering: -30 };
      this.stops = 0;
      this.releases = 0;
      calls.recorders.push(this);
    }
    async prepareToRecordAsync() { await options.prepare?.(); }
    record(startOptions) { this.startOptions = startOptions; }
    getStatus() { return this.status; }
    async stop() {
      this.stops += 1;
      this.status.isRecording = false;
      if (options.stopFails) throw new Error("native stop failed");
    }
    release() { this.releases += 1; }
  }
  const AudioModule = {
    AudioRecorder: Recorder,
    requestRecordingPermissionsAsync: async () => ({ granted: options.granted !== false }),
  };
  const module = moduleWithMocks("../src/chatVoiceInput.native.ts", {
    "react-native": { AppState: state, Platform: { OS: options.platform ?? "ios", isTV: false } },
    "expo-audio": {
      AudioModule,
      RecordingPresets: { HIGH_QUALITY: { ios: { outputFormat: "aac " }, android: { outputFormat: "mpeg4", audioEncoder: "aac" } } },
      setAudioModeAsync: async (mode) => { calls.modes.push(mode); },
      setIsAudioActiveAsync: async (active) => { calls.active.push(active); },
    },
    "expo-file-system": {
      File: class {
        get exists() { return file.exists; }
        get size() { return file.size; }
        async base64() { calls.reads += 1; return options.read ? options.read() : file.base64; }
        delete() { calls.deletes += 1; file.exists = false; }
      },
    },
  }, {
    Date: class extends Date { static now() { return now; } },
    setTimeout: (callback, delay) => {
      const id = ++timerId;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    setInterval: (callback, delay) => {
      const id = ++timerId;
      timers.set(id, { callback, at: now + delay, interval: delay });
      return id;
    },
    clearInterval: (id) => timers.delete(id),
  });
  return {
    module, state, calls, timers,
    advance(milliseconds) {
      const target = now + milliseconds;
      while (true) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, timer] = due;
        now = timer.at;
        if (timer.interval) timer.at += timer.interval;
        else timers.delete(id);
        timer.callback();
      }
      now = target;
    },
  };
}

function released(harness) {
  assert.equal(harness.calls.recorders[0]?.releases, 1);
  assert.equal(harness.state.listeners.size, 0);
  assert.equal(harness.timers.size, 0);
  assert.equal(harness.calls.active.at(-1), false);
  assert.equal(harness.calls.modes.at(-1).allowsRecording, false);
}

{
  const h = voiceHarness({ granted: false });
  await assert.rejects(h.module.startVoiceRecording(), { code: "permission_denied" });
  assert.equal(h.calls.recorders.length, 0);
  assert.equal(h.calls.modes.length, 0);
}
{
  const h = voiceHarness({ platform: "web" });
  assert.equal(h.module.isVoiceInputSupported(), false);
  await assert.rejects(h.module.startVoiceRecording(), { code: "unsupported" });
}
{
  const h = voiceHarness();
  const recording = await h.module.startVoiceRecording();
  await assert.rejects(h.module.startVoiceRecording(), { code: "failed" });
  assert.equal(h.calls.recorders.length, 1);
  assert.equal(h.calls.recorders[0].options.outputFormat, "aac ");
  assert.equal(h.calls.recorders[0].options.extension, ".m4a");
  assert.equal(h.calls.recorders[0].options.isMeteringEnabled, true);
  assert.equal(h.calls.recorders[0].startOptions.forDuration, 60);
  assert.equal(h.calls.modes[0].allowsBackgroundRecording, false);
  assert.ok(recording.level() > 0 && recording.level() <= 1);
  h.advance(700);
  assert.equal(await recording.stop(), "data:audio/m4a;base64,YXVkaW8=");
  assert.equal(h.calls.deletes, 1);
  assert.equal(recording.level(), null);
  released(h);
  await assert.rejects(recording.stop(), { code: "failed" });
}
{
  let finishRead;
  const h = voiceHarness({ read: () => new Promise((resolve) => { finishRead = resolve; }) });
  const recording = await h.module.startVoiceRecording();
  h.advance(1000);
  const pending = recording.stop();
  await settle();
  recording.cancel();
  finishRead("YXVkaW8=");
  await assert.rejects(pending, { code: "failed" });
  assert.equal(h.calls.deletes, 1);
  released(h);
}
{
  const h = voiceHarness();
  const recording = await h.module.startVoiceRecording();
  h.advance(699);
  await assert.rejects(recording.stop(), { code: "too_short" });
  assert.equal(h.calls.reads, 0);
  assert.equal(h.calls.deletes, 1);
  released(h);
}
for (const cancel of ["manual", "background", "media-reset"]) {
  const h = voiceHarness();
  const recording = await h.module.startVoiceRecording();
  h.advance(1000);
  if (cancel === "manual") recording.cancel();
  else if (cancel === "background") h.state.emit("background");
  else { h.calls.recorders[0].status.mediaServicesDidReset = true; h.advance(200); }
  await settle();
  await assert.rejects(recording.stop(), { code: "failed" });
  assert.equal(h.calls.reads, 0);
  assert.equal(h.calls.deletes, 1);
  released(h);
}
{
  const h = voiceHarness();
  const recording = await h.module.startVoiceRecording();
  h.advance(60_000);
  await settle();
  released(h);
  assert.equal(await recording.stop(), "data:audio/m4a;base64,YXVkaW8=");
  assert.equal(h.calls.recorders[0].stops, 1);
}
for (const options of [{ size: 3_000_001 }, { base64: "a".repeat(4_000_001) }, { stopFails: true }]) {
  const h = voiceHarness(options);
  const recording = await h.module.startVoiceRecording();
  h.advance(1000);
  await assert.rejects(recording.stop(), { code: "failed" });
  assert.equal(h.calls.deletes, 1);
  released(h);
}
{
  let finishPreparation;
  const h = voiceHarness({ prepare: () => new Promise((resolve) => { finishPreparation = resolve; }) });
  const pending = h.module.startVoiceRecording();
  await settle();
  h.state.emit("background");
  finishPreparation();
  await assert.rejects(pending, { code: "failed" });
  assert.equal(h.calls.recorders[0].startOptions, undefined);
  released(h);
}

function hookHarness() {
  const slots = [];
  const effects = [];
  let cursor = 0;
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (value) => { slots[index] = value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect(effect) {
      const index = cursor++;
      if (!(index in slots)) { slots[index] = true; effects.push(effect()); }
    },
  };
  return { react, render: (fn) => { cursor = 0; return fn(); }, unmount: () => effects.forEach((cleanup) => cleanup?.()) };
}
{
  const state = appState();
  const hooks = hookHarness();
  let country = " usa ";
  const native = { AppState: state, Platform: { OS: "ios" }, NativeModules: { NuriPushBridge: { getStorefront: async () => country } } };
  const module = moduleWithMocks("../src/nativeShell.ts", { "react-native": native, react: hooks.react });
  assert.equal(module.shellKind(), "ios");
  assert.equal(module.isNativeShell(), true);
  assert.equal(await module.getStorefront(), "USA");
  assert.equal(hooks.render(module.usePurchaseAllowed), false);
  await settle();
  assert.equal(hooks.render(module.usePurchaseAllowed), true);
  country = "CAN";
  state.emit("background");
  state.emit("active");
  assert.equal(hooks.render(module.usePurchaseAllowed), false);
  await settle();
  assert.equal(hooks.render(module.usePurchaseAllowed), false);
  hooks.unmount();
  assert.equal(state.listeners.size, 0);
  delete native.NativeModules.NuriPushBridge;
  assert.equal(await module.getStorefront(), null);
}
{
  const state = appState();
  const hooks = hookHarness();
  const module = moduleWithMocks("../src/nativeShell.ts", {
    "react-native": { AppState: state, Platform: { OS: "ios" }, NativeModules: {} }, react: hooks.react,
  });
  let calls = 0;
  hooks.render(() => module.useOnReturnToApp(() => { calls += 1; }));
  hooks.render(() => module.useOnReturnToApp(() => { calls += 10; }));
  state.emit("active");
  assert.equal(calls, 0);
  state.emit("inactive");
  state.emit("active");
  state.emit("active");
  assert.equal(calls, 10);
  hooks.unmount();
  assert.equal(state.listeners.size, 0);
}

console.log("native voice and platform behavior checks passed");
