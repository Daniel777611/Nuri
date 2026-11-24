import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, load, page } from "./test-daily-home-failure.mjs";

const tick = () => new Promise(resolve => setImmediate(resolve));
const response = (data, status = 200) => ({
  ok: status < 400, status, json: async () => data, text: async () => JSON.stringify(data),
});
const feedPath = "/feed/local-activities";
const event = {
  id: "story-time", kind: "dated_event", event_source_verified: true, title: "Fixture story time",
  summary: "Tales at the public library.",
  start_date: "2026-12-02", end_date: null, source_url: "https://library.invalid/events/storytime",
  source_label: "Fixture Library", location_label: "Springfield",
  venue_name: "Fixture Library", address: "18 Main Street, Springfield, IL 62701",
  starts_at: "2026-12-02T10:00:00-06:00", ends_at: "2026-12-02T11:15:00-06:00",
  time_zone: "America/Chicago", age_label: "Ages 1–3",
  match_reason: "The advertised age range includes toddlers.",
  description: "Join the librarian for picture books, a music activity and a take-home craft.",
  registration_required: true, registration_url: "https://library.invalid/events/storytime#registration",
  registration_notes: "Reserve one place for each child.", cost: "Free",
};
const place = {
  ...event, id: "playroom", kind: "ongoing_resource", title: "Fixture family playroom",
  source_url: "https://library.invalid/playroom", start_date: null,
};

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

test("the directory displays individual verified events and never venue listings or area controls", async () => {
  await withActivities(async (f, open) => {
    const incomplete = { ...event, id: "missing-address", title: "Incomplete fixture", address: "" };
    f.responder = path => path === feedPath ? response({ state: "ready", items: [event, place, incomplete] }) : null;
    const list = open("activities"); list.render(); await tick(); list.render();
    for (const label of [event.title, event.venue_name, event.address, event.age_label, event.match_reason, "10:00 AM", "11:15 AM"]) {
      assert.ok(list.visible().includes(label), label);
    }
    assert.equal(list.find("local-activity-playroom"), undefined);
    assert.equal(list.find("local-activity-missing-address"), undefined);
    assert.equal(list.find("local-activities-area"), undefined);
    assert.equal(list.find("local-activities-edit"), undefined);
    list.find("local-activity-story-time").props.onPress();
    assert.deepEqual(list.routes, [{ pathname: "/nearby-activities", params: { id: event.id } }]);
    assert.deepEqual(list.external, []);
  });
});

test("disabled discovery points to Settings and refreshes the events on return", async () => {
  await withActivities(async (f, open) => {
    let enabled = false;
    f.responder = path => path === feedPath
      ? response(enabled ? { state: "ready", items: [event] } : { state: "disabled", items: [] }) : null;
    const list = open("activities"); list.render(); await tick(); list.render();
    assert.equal(list.find("local-activities-device-location"), undefined);
    assert.equal(list.kind("InlineState").props.action, "Open Settings");
    list.kind("InlineState").props.onPress();
    assert.deepEqual(list.routes, [{ pathname: "/(tabs)/profile", params: { section: "nearby" } }]);
    list.blur();
    enabled = true;
    list.focus(); await tick(); list.render();
    assert.ok(list.find("local-activity-story-time"));
    assert.equal(f.calls.filter(call => call.path === feedPath).length, 2);
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
    assert.ok(detail.visible().includes(event.title));
    assert.equal(detail.find("local-activity-description").props.children, event.description);
    assert.ok(detail.visible().includes(event.registration_notes));
    assert.ok(detail.visible().includes(event.cost));
    assert.deepEqual(detail.external, []);
    detail.find("local-activity-register").props.onPress();
    detail.find("local-activity-source").props.onPress();
    await tick();
    assert.deepEqual(detail.external, [event.registration_url, event.source_url]);
  });
});

test("a generic registration URL is suppressed while the verified organizer details remain available", async () => {
  await withActivities(async (f, open) => {
    f.responder = path => path === `${feedPath}/${event.id}`
      ? response({ ...event, registration_url: "https://library.invalid/events" }) : null;
    const detail = open("activities", { id: event.id }); detail.render(); await tick(); detail.render();
    assert.equal(detail.find("local-activity-register"), undefined);
    assert.ok(detail.visible().includes("Registration is required"));
    detail.find("local-activity-source").props.onPress();
    await tick();
    assert.deepEqual(detail.external, [event.source_url]);
  });
});

test("unverified or incomplete activities, invalid dates and unsafe event sources are rejected", () => {
  const { validLocalActivity, localActivityNotificationId, officialActivityUrl } =
    load("../src/localActivities.ts", { "./externalContent": load("../src/externalContent.ts") });
  assert.equal(validLocalActivity(event), true);
  assert.equal(validLocalActivity(place), false);
  assert.equal(validLocalActivity({ ...event, event_source_verified: undefined }), false);
  assert.equal(validLocalActivity({ ...event, address: "" }), false);
  assert.equal(validLocalActivity({ ...event, age_label: "" }), false);
  assert.equal(validLocalActivity({ ...event, description: "" }), false);
  assert.equal(validLocalActivity({ ...event, start_date: "2026-02-30" }), false);
  assert.equal(validLocalActivity({ ...event, end_date: "2026-12-01" }), false);
  assert.equal(validLocalActivity({ ...event, ends_at: "2026-12-02T09:00:00-06:00" }), false);
  assert.equal(validLocalActivity({ ...event, source_url: "javascript:alert(1)" }), false);
  assert.equal(validLocalActivity({ ...event, source_url: "https://library.invalid/" }), false);
  assert.equal(officialActivityUrl("https://library.invalid/calendar?utm_source=fixture"), null);
  assert.equal(officialActivityUrl("https://library.invalid/calendar?eventId=955"), "https://library.invalid/calendar?eventId=955");
  assert.equal(localActivityNotificationId({ kind: "local_activity", local_activity_id: "../profile" }), null);
  assert.equal(localActivityNotificationId({ kind: "daily_post", local_activity_id: event.id }), null);
});

test("the schedule displays the venue time zone and both dates for overnight events", () => {
  const { formatActivitySchedule } = load("../src/localActivities.ts", { "./externalContent": load("../src/externalContent.ts") });
  const sameDay = formatActivitySchedule({ ...event, starts_at: "2026-12-02T22:00:00Z", ends_at: "2026-12-03T00:15:00Z" }, "en");
  assert.match(sameDay, /Dec 2, 2026/);
  assert.match(sameDay, /4:00 PM – 6:15 PM/);
  assert.doesNotMatch(sameDay, /Dec 3/);
  const overnight = formatActivitySchedule({ ...event, starts_at: "2026-12-02T23:30:00-06:00", ends_at: "2026-12-03T01:00:00-06:00" }, "en");
  assert.match(overnight, /Dec 2, 2026 · 11:30 PM – Thu, Dec 3, 2026 · 1:00 AM/);
  assert.match(formatActivitySchedule({ ...event, starts_at: "2026-12-02T10:00", ends_at: "2026-12-02T11:15" }, "en"), /10:00 AM – 11:15 AM/);
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
