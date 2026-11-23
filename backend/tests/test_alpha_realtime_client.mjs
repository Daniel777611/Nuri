import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../alpha_realtime.py", import.meta.url), "utf8");
const embeddedScript = source.match(/_WEBRTC_SCRIPT = r"""([\s\S]*?)"""\.strip\(\)/)?.[1];
assert(embeddedScript, "The WebRTC code served to WebKit is required");

function webKit({ deferMicrophone = false } = {}) {
  let askMicCount = 0;
  let played = 0;
  let stopped = false;
  let peer;
  let resolveMicrophone;
  const audio = { srcObject: null, play: async () => { played++; }, pause: () => {} };
  const track = { enabled: true, stop: () => { stopped = true; }, addEventListener() {} };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
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
    setTimeout: () => 0, clearTimeout() {},
  });
  return { window, events, audio, track, stream, listeners, stats: () => ({ askMicCount, played, stopped, peer }),
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
  assert.deepEqual(view.events.slice(1), [{ type: "listening" }, { type: "speaking" }, { type: "listening" }]);
  view.listeners.get("pagehide")();
  assert.equal(view.stats().stopped, true);
  assert.equal(view.audio.srcObject, null);
  assert.equal(peer.closed, true);
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
