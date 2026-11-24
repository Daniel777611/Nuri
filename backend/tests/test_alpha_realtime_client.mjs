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
  const events = [], commands = [];
  const window = {
    isSecureContext: true,
    ReactNativeWebView: { postMessage: (message) => events.push(JSON.parse(message)) },
    addEventListener: (type, fn) => listeners.set(type, fn),
  };
  const document = { querySelector: () => audio, addEventListener: (type, fn) => listeners.set(type, fn) };
  class Peer {
    constructor() { peer = this; }
    createDataChannel(label) {
      return this.channel = {
        label, readyState: "connecting",
        send(data) { assert.equal(this.readyState, "open"); commands.push(JSON.parse(data)); },
        close() { this.readyState = "closed"; },
      };
    }
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
    window, document, navigator, RTCPeerConnection: Peer, TextEncoder,
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: (id) => { timers.delete(id); },
  });
  return { window, events, commands, audio, track, stream, remoteStream, samples, timers, listeners,
    stats: () => ({ askMicCount, played, stopped, peer, analyserClosed }),
    tickActivity: () => {
      for (const [id, timer] of [...timers]) {
        if (timer.delay !== 125) continue;
        timers.delete(id);
        timer.callback();
      }
    },
    openChannel() {
      peer.channel.readyState = "open";
      peer.channel.onopen();
    },
    connectPeer() {
      peer.connectionState = "connected";
      peer.onconnectionstatechange();
    },
    model(detail) { peer.channel.onmessage({ data: JSON.stringify(detail) }); },
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
  assert.deepEqual(view.events, [{ type: "offer", sdp: "v=0\nm=audio local", manualTurns: true }]);
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

test("waits for both connection and data channel, greets in the call language once, then enables the microphone", async () => {
  for (const [locale, opening, connectFirst] of [
    ["zh-CN", "嗨，我是 Nuri。你可以直接说，我在听。", true],
    ["zh-TW", "嗨，我是 Nuri。你可以直接說，我在聽。", false],
    ["en", "Hi, I’m Nuri. Go ahead whenever you’re ready. I’m listening.", true],
  ]) {
    const view = webKit();
    await view.window.nuriRealtime.start();
    await view.window.nuriRealtime.answer("v=0\nm=audio remote", true, locale, true);
    if (connectFirst) view.connectPeer();
    else view.openChannel();
    assert.equal(view.commands.length, 0);
    assert.equal(view.track.enabled, false);
    if (connectFirst) view.openChannel();
    else view.connectPeer();
    assert.equal(view.commands.length, 1);
    const [request] = view.commands;
    assert.equal(request.type, "response.create");
    assert.equal(request.response.conversation, "none");
    assert.equal(request.response.metadata.nuri_kind, "greeting");
    assert.equal(request.response.instructions.endsWith(opening), true);
    const responseId = "resp_greeting";
    const item = { type: "message", role: "assistant", id: "item_greeting", content: [{ transcript: opening }] };
    view.model({ type: "response.created", response: { id: responseId, metadata: request.response.metadata } });
    view.model({ type: "response.output_item.added", response_id: responseId, item });
    view.model({ type: "output_audio_buffer.started", response_id: responseId });
    assert(view.events.some(event => event.type === "speaking"));
    view.model({ type: "response.done", response: { id: responseId, status: "completed", output: [item] } });
    assert.equal(view.track.enabled, false);
    view.model({ type: "output_audio_buffer.stopped", response_id: responseId });
    assert.equal(view.track.enabled, true);
    assert.equal(view.events.some(event => event.type === "transcript"), false);
    view.connectPeer();
    view.openChannel();
    assert.equal(view.commands.length, 1, "reconnect may not replay the greeting");
  }
});

test("completes audio playback before answering a queued parent turn and saves the full heard transcript", async () => {
  const view = webKit();
  await view.window.nuriRealtime.start();
  await view.window.nuriRealtime.answer("v=0\nm=audio remote", true, "zh-CN", true);
  view.openChannel();
  view.connectPeer();
  // A failed opening still lets the parent start the call normally.
  view.model({ type: "error", error: { event_id: view.commands[0].event_id, code: "fixture_error" } });
  assert.equal(view.track.enabled, true);

  view.model({ type: "input_audio_buffer.speech_started" });
  view.model({ type: "input_audio_buffer.speech_stopped" });
  view.model({ type: "input_audio_buffer.committed", item_id: "item_first_user" });
  assert.equal(view.commands.length, 2);
  assert.deepEqual(view.commands[1].response, {});
  const responseId = "resp_first_turn";
  const words = "她睡前想多靠你一会儿。你可以先轻声告诉她你就在旁边。".repeat(40);
  const item = { type: "message", role: "assistant", id: "item_first_answer", content: [{ transcript: words }] };
  view.model({ type: "response.created", response: { id: responseId } });
  assert.equal([...view.timers.values()].some(timer => timer.delay === 12000), false);
  view.model({ type: "response.output_item.added", response_id: responseId, item });
  view.model({ type: "output_audio_buffer.started", response_id: responseId });
  view.model({ type: "input_audio_buffer.speech_started" });
  view.model({ type: "input_audio_buffer.speech_stopped" });
  view.model({ type: "input_audio_buffer.committed", item_id: "item_second_user" });
  assert.equal(view.commands.length, 2, "parent audio is queued without an interruption command");
  view.model({ type: "conversation.item.input_audio_transcription.completed", item_id: "item_first_user", transcript: "最近宝宝总是夜醒。" });
  view.model({ type: "response.done", response: { id: responseId, status: "completed", output: [item] } });
  assert.equal(view.commands.length, 2, "model generation finishing does not mean playback is done");
  view.model({ type: "output_audio_buffer.stopped", response_id: responseId });
  assert.equal(view.commands.length, 3);
  assert(view.commands.every(command => command.type === "response.create"));
  const transcript = view.events.filter(event => event.type === "transcript").at(-1);
  assert.deepEqual(transcript.entries.map(entry => entry.text), ["最近宝宝总是夜醒。", words]);
});

test("a consented call bridges final transcripts in turn order and omits cancelled replies", async () => {
  const view = webKit();
  await view.window.nuriRealtime.start();
  await view.window.nuriRealtime.answer("v=0\nm=audio remote", true);
  const { peer } = view.stats();
  peer.connectionState = "connected";
  peer.onconnectionstatechange();
  const emit = (detail) => peer.channel.onmessage({ data: JSON.stringify(detail) });
  const transcript = () => view.events.filter(event => event.type === "transcript").at(-1);

  emit({ type: "input_audio_buffer.committed", item_id: "item_user" });
  const cancelled = { id: "item_cancelled", type: "message", role: "assistant" };
  emit({ type: "response.output_item.added", item: cancelled });
  emit({ type: "response.output_audio_transcript.done", item_id: cancelled.id, transcript: "Unspoken text" });
  emit({ type: "response.done", response: { id: "resp_cancelled", status: "cancelled", output: [cancelled] } });
  assert.equal(transcript(), undefined);

  const buffered = { id: "item_buffered", type: "message", role: "assistant" };
  emit({ type: "response.output_item.added", item: buffered });
  emit({ type: "response.output_audio_transcript.done", item_id: buffered.id, transcript: "Still buffered" });
  emit({ type: "response.done", response: { id: "resp_buffered", status: "completed", output: [buffered] } });
  emit({ type: "output_audio_buffer.cleared", response_id: "resp_buffered" });
  emit({ type: "output_audio_buffer.stopped", response_id: "resp_buffered" });
  assert.equal(transcript(), undefined);

  const reply = { id: "item_answer", type: "message", role: "assistant" };
  emit({ type: "response.output_item.added", item: reply });
  emit({ type: "response.output_audio_transcript.done", item_id: reply.id, transcript: "Try a short routine." });
  emit({ type: "response.done", response: { id: "resp_answer", status: "completed", output: [reply] } });
  assert.equal(transcript(), undefined, "wait for audio to finish streaming");
  emit({ type: "output_audio_buffer.stopped", response_id: "resp_answer" });
  assert.equal(transcript().entries[0].text, "Try a short routine.");
  view.window.nuriRealtime.finish();
  assert.equal(view.stats().stopped, true, "hangup stops microphone before waiting for ASR");
  const parent = { type: "conversation.item.input_audio_transcription.completed",
    item_id: "item_user", transcript: " Our child wakes up at night. " };
  emit(parent);
  const expected = [
    { item_id: "item_user", role: "user", order: 0, text: "Our child wakes up at night." },
    { item_id: "item_answer", role: "ai", order: 3, text: "Try a short routine." },
  ];
  assert.deepEqual(transcript().entries, expected);
  const eventCount = view.events.length;
  emit(parent);
  assert.equal(view.events.length, eventCount);
  const finish = [...view.timers.values()].find(timer => timer.delay === 1800);
  finish.callback();
  assert.deepEqual(view.events.find(event => event.type === "transcript_end"), { type: "transcript_end", entries: expected });
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
