import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, load, page } from "./test-daily-home-failure.mjs";

const tick = () => new Promise(resolve => setImmediate(resolve));
const response = (data, status = 200) => ({
  ok: status < 400, status, json: async () => data, text: async () => JSON.stringify(data),
});
const prefsPath = "/notifications/local-activities/preferences";
const feedPath = "/feed/local-activities";
const event = {
  id: "story-time", kind: "dated_event", title: "Fixture story time", summary: "Tales at the public library.",
  start_date: "2026-12-02", end_date: null, source_url: "https://library.invalid/events/storytime",
  source_label: "Fixture Library", location_label: "Springfield",
};
const place = {
  ...event, id: "playroom", kind: "ongoing_resource", title: "Fixture family playroom",
  source_url: "https://library.invalid/playroom", start_date: null,
};
const emptyPreferences = { enabled: false, city: null, region: null, country: null };

async function withActivities(run) {
  const before = process.env.EXPO_PUBLIC_LOCAL_ACTIVITIES_TEST;
  process.env.EXPO_PUBLIC_LOCAL_ACTIVITIES_TEST = "1";
  const f = fixture(), pages = [];
  try {
    await f.login("A");
    await run(f, (kind, params) => {
      const view = page(f, kind, params);
      pages.push(view);
      return view;
    });
  } finally {
    for (const view of pages) view.unmount();
    f.restore();
    if (before === undefined) delete process.env.EXPO_PUBLIC_LOCAL_ACTIVITIES_TEST;
    else process.env.EXPO_PUBLIC_LOCAL_ACTIVITIES_TEST = before;
  }
}

test("current location only fills the form; saving sends coarse fields and disabling removes the activities", async () => {
  await withActivities(async (f, open) => {
    let saved = emptyPreferences;
    let locationCalls = 0;
    f.locate = async () => {
      locationCalls += 1;
      return {
        status: "authorized",
        locality: { city: "Springfield", region: "IL", country: "US", latitude: 1.2, longitude: 3.4 },
      };
    };
    f.responder = (path, init) => {
      if (path === prefsPath) {
        if (init.method === "PATCH") {
          const patch = JSON.parse(init.body);
          if (patch.enabled) assert.deepEqual(patch, { enabled: true, city: "Springfield", region: "IL", country: "US" });
          saved = patch.enabled ? patch : emptyPreferences;
        }
        return response(saved);
      }
      if (path === feedPath) return response({
        state: saved.enabled ? "ready" : "disabled",
        items: saved.enabled ? [event, place] : [],
      });
    };
    const view = open("activities"); view.render(); await tick(); view.render();
    assert.equal(locationCalls, 0);
    view.find("local-activities-device-location").props.onPress();
    await tick(); view.render();
    assert.equal(locationCalls, 1);
    assert.equal(view.find("local-activities-city").props.value, "Springfield");
    assert.equal(f.calls.filter(call => call.init.method === "PATCH").length, 0);
    view.find("local-activities-save").props.onPress();
    await tick(); view.render();
    assert.ok(view.find("local-activity-story-time"));
    assert.ok(view.find("local-activity-playroom"));
    view.find("local-activity-story-time").props.onPress();
    assert.deepEqual(view.routes, [{ pathname: "/nearby-activities", params: { id: "story-time" } }]);
    view.find("local-activities-disable").props.onPress();
    await tick(); view.render();
    assert.deepEqual(saved, emptyPreferences);
    assert.equal(view.find("local-activity-story-time"), undefined);
    assert.equal(view.find("local-activities-area"), undefined);
  });
});

test("a pending location response cannot populate another account's settings", async () => {
  await withActivities(async (f, open) => {
    let resolveLocation;
    f.locate = () => new Promise(resolve => { resolveLocation = resolve; });
    f.responder = (path) => path === prefsPath ? response(emptyPreferences)
      : path === feedPath ? response({ state: "disabled", items: [] }) : null;
    const view = open("activities"); view.render(); await tick(); view.render();
    view.find("local-activities-device-location").props.onPress();
    await f.login("B");
    view.render(); await tick();
    resolveLocation({ status: "authorized", locality: { city: "Private City", region: "CA", country: "US" } });
    await tick(); view.render();
    assert.equal(view.find("local-activities-city").props.value, "");
    assert.equal(f.calls.some(call => call.init.method === "PATCH"), false);
  });
});

test("a notification opens its owned activity without writing to chat", async () => {
  await withActivities(async (f, open) => {
    const id = "5f5a3778-db2f-42c0-87f7-828f00c5339c";
    f.responder = (path) => path === `/notifications/${id}`
      ? response({ id, kind: "local_activity", local_activity_id: event.id })
      : path === `${feedPath}/${event.id}` ? response(event) : null;
    const notification = open("notification", { id }); notification.render(); await tick(); notification.render();
    assert.deepEqual(notification.routes, [{ pathname: "/nearby-activities", params: { id: event.id } }]);
    assert.equal(f.calls.some(call => call.path.endsWith("/open")), false);
    const detail = open("activities", { id: event.id }); detail.render(); await tick(); detail.render();
    assert.match(detail.visible(), /Fixture story time/);
    assert.deepEqual(detail.external, []);
    detail.find("local-activity-source").props.onPress();
    await tick();
    assert.deepEqual(detail.external, [event.source_url]);
  });
});

test("unverifiable dates, insecure sources and invalid notification targets are rejected", () => {
  const { normalizedActivityArea, validLocalActivity, localActivityNotificationId, formatActivityDate } =
    load("../src/localActivities.ts", { "./externalContent": load("../src/externalContent.ts") });
  assert.equal(normalizedActivityArea({ city: "18 Main Street", region: "NY", country: "US" }), null);
  assert.equal(normalizedActivityArea({ city: "New York", region: "", country: "" }), null);
  assert.equal(validLocalActivity({ ...event, start_date: "2026-02-30" }), false);
  assert.equal(validLocalActivity({ ...event, end_date: "2026-12-01" }), false);
  assert.equal(validLocalActivity({ ...event, source_url: "javascript:alert(1)" }), false);
  assert.equal(validLocalActivity({ ...place, start_date: "2026-12-01" }), false);
  assert.equal(validLocalActivity(place), true);
  assert.match(formatActivityDate(event, "en"), /Dec 2/);
  assert.equal(localActivityNotificationId({ kind: "local_activity", local_activity_id: "../profile" }), null);
  assert.equal(localActivityNotificationId({ kind: "daily_post", local_activity_id: event.id }), null);
});

test("home carousel exposes the nearby activities entry in the test build", async () => {
  await withActivities(async (f, open) => {
    await f.permit();
    const home = open("home"); home.render(); await tick(); home.render();
    home.find("home-local-activities-card").props.onPress();
    assert.deepEqual(home.routes, ["/nearby-activities"]);
  });
});

test("the multi-source daily article renders citations, preserves their index and opens only the chosen source", async () => {
  await withActivities(async (f, open) => {
    await f.permit();
    const sources = [
      { n: 1, label: "Fixture library", platform: "web", url: "https://library.invalid/article" },
      { n: 2, label: "Fixture unsafe", platform: "web", url: "javascript:alert(1)" },
      { n: 3, label: "Fixture city", platform: "web", url: "https://city.invalid/resources" },
      { n: 4, label: "Fixture duplicate", platform: "web", url: "https://city.invalid/resources" },
    ].map((source) => ({ ...source, title: "Fixture article" }));
    const card = {
      id: "summary-A", card_id: "dailypost:summary-A", format: "summary", summary_source: "summary",
      locale: "en", headline: "Fixture shared report", question: "Fixture question", concern: "Activity",
      situation: "Fixture context", platform: "Web", source_url: sources[0].url, sources,
      takeaways: ["First takeaway", "", "Third takeaway"], takeaway_sources: [[1], [2], [3, 4]],
      why_this: "Your chosen family setup",
    };
    f.responder = path => path.startsWith("/feed/daily-post") && !path.endsWith("/events")
      ? response({ state: "ready", card }) : null;
    const home = open("home"); home.render(); await tick(); home.render();
    assert.match(home.find("home-daily-post-source-line").props.children, /2/);
    const post = open("daily", { id: card.id }); post.render(); await tick(); post.render();
    assert.equal(post.find("daily-post-media-region"), undefined);
    assert.equal(post.find("daily-post-source-caption"), undefined);
    assert.equal(post.find("daily-post-source-2"), undefined);
    assert.equal(post.find("daily-post-source-4"), undefined);
    assert.match(JSON.stringify(post.find("daily-post-summary-point-sources-1")), /"Sources"," ","3"/);
    assert.match(post.find("daily-post-summary-reason").props.children, /Your chosen family setup/);
    post.find("daily-post-source-3").props.onPress();
    await tick();
    assert.deepEqual(post.external, ["https://city.invalid/resources"]);
    const takeaway = open("daily", { id: card.id, uiState: "takeaway", point: "2" });
    takeaway.render(); await tick(); takeaway.render();
    assert.equal(takeaway.find("social-takeaway-card").props.title, "Third takeaway");
  });
});
