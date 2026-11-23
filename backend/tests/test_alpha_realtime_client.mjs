import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../alpha_realtime.py", import.meta.url), "utf8");
const embeddedScript = source.match(/_WEBRTC_SCRIPT = r"""([\s\S]*?)"""\.strip\(\)/)?.[1];
assert(embeddedScript, "The WebRTC code served to WebKit is required");

function webKit({ deferMicrophone = false, withMeters = false } = {}) {
  let askMicCount = 0;
  let played = 0;
  let stopped = false;
  let peer;
  let resolveMicrophone;
  const audio = { srcObject: null, play: async () => { played++; }, pause: () => {} };
  const track = { enabled: true, stop: () => { stopped = true; }, addEventListener() {} };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const remoteStream = {};
  const samples = { user: 0.15, nuri: 0.01 };
  const timers = new Map();
  let timerId = 0, analyserClosed = false;
  const listeners = new Map();
  const events = [];
  const window = {
    isSecureContext: true,
    ReactNativeWebView: { postMessage: (message) => events.push(JSON.parse(message)) },
    addEventListener: (type, fn) => listeners.set(type, fn),
  };
  const document = { querySelector: () => audio, addEventListener: (type, fn) => listeners.set(type, fn) };
  class Peer {
    constructor() { peer = this; }
    createDataChannel(label) { return this.channel = { label, close() {} }; }
    iceGatheringState = "complete";
    createOffer = async () => ({ type: "offer", sdp: "v=0\nm=audio local" });
    setLocalDescription = async (offer) => { this.localDescription = offer; };
    setRemoteDescription = async (answer) => { this.remoteDescription = answer; };
    addTrack = (input, mic) => { this.sentTrack = input; this.sentStream = mic; };
    close() { this.closed = true; }
  }
  window.RTCPeerConnection = Peer;
  if (withMeters) window.AudioContext = class {
    state = "running";
    createMediaStreamSource(media) {
      return { connect: (node) => { node.actor = media === stream ? "user" : "nuri"; } };
    }
    createAnalyser() {
      return { getFloatTimeDomainData(values) { values.fill(samples[this.actor]); } };
    }
    async close() { analyserClosed = true; }
  };
  const navigator = { mediaDevices: { getUserMedia: (request) => {
    assert.equal(request.video, false);
    assert.equal(request.audio.echoCancellation, true);
    askMicCount++;
    return deferMicrophone
      ? new Promise(resolve => { resolveMicrophone = () => resolve(stream); })
      : Promise.resolve(stream);
  } } };
  vm.runInNewContext(embeddedScript, {
    window, document, navigator, RTCPeerConnection: Peer,
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: (id) => { timers.delete(id); },
  });
  return { window, events, audio, track, stream, remoteStream, samples, timers, listeners,
    stats: () => ({ askMicCount, played, stopped, peer, analyserClosed }),
    tickActivity: () => {
      for (const [id, timer] of [...timers]) {
        if (timer.delay !== 125) continue;
        timers.delete(id);
        timer.callback();
      }
    },
    resolvePermission: () => resolveMicrophone() };
}

test("a consented audio-only call negotiates SDP, receives speech and releases the microphone", async () => {
  const view = webKit();
  assert.equal(view.stats().askMicCount, 0, "mounting the secure WebView does not record");
  await view.window.nuriRealtime.start();
  const { peer } = view.stats();
  assert.equal(peer.sentTrack, view.track);
  assert.equal(peer.sentTrack.enabled, false, "first audio does not flow until the connection is ready");
  assert.equal(peer.channel.label, "oai-events");
  assert.deepEqual(view.events, [{ type: "offer", sdp: "v=0\nm=audio local" }]);
  await view.window.nuriRealtime.answer("v=0\nm=audio remote");
  assert.equal(peer.remoteDescription.type, "answer");
  peer.connectionState = "connected";
  peer.onconnectionstatechange();
  assert.equal(peer.sentTrack.enabled, true);
  peer.ontrack({ track: {}, streams: [view.stream] });
  await setImmediate();
  assert.equal(view.audio.srcObject, view.stream);
  assert.equal(view.stats().played, 1);
  peer.channel.onmessage({ data: JSON.stringify({ type: "output_audio_buffer.started" }) });
  peer.channel.onmessage({ data: JSON.stringify({ type: "input_audio_buffer.speech_started" }) });
  assert.deepEqual(view.events.slice(1).filter(e => e.type !== "activity"), [
    { type: "listening" }, { type: "speaking" }, { type: "listening" },
  ]);
  assert(view.events.some(e => e.type === "activity" && e.actor === "nuri" && e.level === 0.24 && e.active));
  view.listeners.get("pagehide")();
  assert.equal(view.stats().stopped, true);
  assert.equal(view.audio.srcObject, null);
  assert.equal(peer.closed, true);
});

test("local activity meters are bounded, prioritize interruption, and stop when idle or closed", async () => {
  const view = webKit({ withMeters: true });
  await view.window.nuriRealtime.start();
  await view.window.nuriRealtime.answer("v=0\nm=audio remote");
  const { peer } = view.stats();
  peer.connectionState = "connected";
  peer.onconnectionstatechange();
  peer.ontrack({ track: {}, streams: [view.remoteStream] });
  const signal = type => peer.channel.onmessage({ data: JSON.stringify({ type }) });
  const latest = () => view.events.filter(event => event.type === "activity").at(-1);
  view.tickActivity();
  assert.equal(latest(), undefined);
  signal("output_audio_buffer.started");
  assert.equal(latest().actor, "nuri");
  assert(latest().level > 0.035 && latest().level < 0.05);
  signal("input_audio_buffer.speech_started");
  assert.equal(latest().actor, "user");
  assert(latest().level > 0.59 && latest().level < 0.61);
  view.samples.user = 1;
  view.tickActivity();
  assert.equal(latest().level, 1);
  signal("output_audio_buffer.cleared");
  assert.equal(latest().actor, "user");
  signal("input_audio_buffer.speech_stopped");
  assert.deepEqual(latest(), { type: "activity", actor: "user", level: 0, active: false });
  const count = view.events.length;
  view.tickActivity();
  assert.equal(view.events.length, count);
  signal("output_audio_buffer.started");
  view.window.nuriRealtime.close();
  assert.deepEqual(latest(), { type: "activity", actor: "nuri", level: 0, active: false });
  assert.equal(view.timers.size, 0);
  assert.equal(view.stats().analyserClosed, true);
});

test("closing while the permission sheet is open prevents a late microphone from negotiating", async () => {
  const view = webKit({ deferMicrophone: true });
  const pending = view.window.nuriRealtime.start();
  assert.equal(view.stats().askMicCount, 1);
  view.window.nuriRealtime.close();
  view.resolvePermission();
  await pending;
  assert.equal(view.stats().stopped, true);
  assert.equal(view.stats().peer, undefined);
  assert.deepEqual(view.events, []);
});
