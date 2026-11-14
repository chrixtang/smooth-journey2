// Run with: npm test   (Node's built-in test runner; Bedrock, DynamoDB, Cognito and HKIA are all mocked)
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.MODEL_ID = "test-model";
const api = await import("../backend/index.mjs");
api._setDb(api.memoryDb());

/* ---- mocks ---- */
const sent = [];
let replyFor = () => "";
api._setClient({ send: async (cmd) => { const p = cmd.input.messages[0].content[0].text; sent.push(p); return { output: { message: { content: [{ text: replyFor(p) }] } } }; } });
const PASSPORT_JSON = '{"codes":[{"code":"WCHS","need":"Cannot manage stairs"},{"code":"WCMP","need":"Own folding wheelchair"},{"code":"DEAF","need":"Prefers writing"},{"code":"FAKE","need":"x"},{"code":"MAAS","need":"Travelling alone"}],"plain_summary":"Has dementia. Cannot manage stairs.","medif":false,"evacuation_help":true,"safety_assistant":false,"removed_diagnoses":[],"questions_for_staff":[]}';
replyFor = (p) => p.includes("SSR") ? PASSPORT_JSON : p.includes("cabin crew") ? "Prefers written communication. Cannot manage stairs." : '{"answer":"Yes, free in the hold.","source":"P1","confidence":92,"needs_human":false}';

const users = {
  chan: { sub: "u-chan", email: "chan@example.com", name: "Mrs Chan", groups: "[passenger]" },
  mei: { sub: "u-mei", email: "mei@example.com", name: "Mei", groups: "[carer]" },
  alex: { sub: "u-alex", email: "alex@example.com", name: "Alex Wong", groups: "[staff]" },
  dan: { sub: "u-dan", email: "dan@example.com", name: "Daniel Yip", groups: "[crew]" },
  priya: { sub: "u-priya", email: "priya@example.com", name: "Priya Shah", groups: "[supervisor]" },
  nobody: { sub: "u-x", email: "x@example.com", name: "X", groups: "" }
};
async function as(who, path, body) {
  const u = users[who];
  const r = await api.handler({ rawPath: path, requestContext: { http: { method: "POST" }, authorizer: u ? { jwt: { claims: { sub: u.sub, email: u.email, name: u.name, "cognito:groups": u.groups } } } : undefined }, body: JSON.stringify(body || {}) });
  return { status: r.statusCode, body: JSON.parse(r.body) };
}
const state = async (who) => (await as(who, "/api/state")).body;
const act = (who, body) => as(who, "/api/action", body);

/* ---- public routes ---- */
test("health is public and reports AI", async () => {
  const r = await api.handler({ rawPath: "/api/health", requestContext: { http: { method: "GET" } } });
  assert.deepEqual(JSON.parse(r.body), { ok: true, ai: true, auth: true });
});

test("signed-in routes refuse missing sign-in and missing role", async () => {
  assert.equal((await api.handler({ rawPath: "/api/state", requestContext: { http: { method: "POST" } } })).statusCode, 401);
  assert.equal((await as("nobody", "/api/state")).status, 403);
});

test("sign-up trigger: carers become carers, nobody can sign up as staff", async () => {
  const calls = [];
  api._setCognito({ send: async (c) => { calls.push(c.input.GroupName); } });
  const ev = (role) => ({ triggerSource: "PostConfirmation_ConfirmSignUp", userPoolId: "p", userName: "n", request: { userAttributes: { "custom:role": role } } });
  await api.handler(ev("carer")); await api.handler(ev("staff")); await api.handler(ev("passenger"));
  await api.handler({ ...ev("carer"), triggerSource: "PostConfirmation_ConfirmForgotPassword" });
  assert.deepEqual(calls, ["carer", "passenger", "passenger"]);
});

/* ---- the whole journey across five roles ---- */
test("full journey: passport, check, booking, brief, handovers, carer, crew, supervisor", async () => {
  // Passenger creates an Access Passport (consent required)
  assert.equal((await act("chan", { type: "passportSubmit", text: "Mrs Chan (78), phone 9123 4567, can't manage stairs", useAI: true })).status, 400);
  assert.equal((await act("chan", { type: "passportSubmit", text: "Mrs Chan (78) has dementia, phone 9123 4567, can't manage stairs, own folding wheelchair, hard of hearing, flying alone", useAI: true, consent: true })).status, 200);
  for (const leak of ["Chan", "78", "dementia", "9123"]) assert.ok(!sent.at(-1).includes(leak), "leaked to AI: " + leak);
  let s = await state("chan");
  assert.equal(s.passport.status, "draft");
  assert.deepEqual(s.passport.codes.map((c) => c.code), ["WCHS", "WCMP", "DEAF", "MAAS"]);   // FAKE dropped
  assert.ok(!JSON.stringify(s.passport).includes("dementia"));
  assert.equal(s.passport.conditionsRemoved, true);

  // Only staff can check it; staff see redacted words only
  assert.equal((await act("chan", { type: "verify", userId: "u-chan" })).status, 403);
  const st = await state("alex");
  assert.equal(st.queue.length, 1);
  assert.ok(!st.queue[0].redacted.includes("9123") && !st.queue[0].redacted.includes("78"));
  assert.equal((await act("alex", { type: "verify", userId: "u-chan", removeCodes: ["3"] })).status, 200);   // remove MAAS
  s = await state("chan");
  assert.equal(s.passport.status, "verified");
  assert.equal(s.passport.redacted, undefined);                        // original words deleted
  assert.deepEqual(s.passport.codes.map((c) => c.code), ["WCHS", "WCMP", "DEAF"]);

  // Booking drafts the crew brief; the evacuation line is always added by code
  assert.equal((await act("chan", { type: "book" })).status, 200);
  s = await state("chan");
  assert.equal(s.trip.brief.status, "draft");
  assert.ok(s.trip.brief.text.endsWith("Will need help in an evacuation."));
  await act("chan", { type: "briefSave", text: "Please write things down." });
  s = await state("chan");
  assert.ok(s.trip.brief.text.includes("Will need help in an evacuation."));
  await act("chan", { type: "briefApprove" });

  // Carer links with a one-time code
  const code = (await act("chan", { type: "shareCode" })).body.code;
  assert.equal(code.length, 6);
  assert.equal((await act("mei", { type: "linkCode", code: "ZZZZZZ" })).status, 400);
  assert.equal((await act("mei", { type: "linkCode", code })).status, 200);
  assert.equal((await act("mei", { type: "linkCode", code })).status, 400);   // single use
  let m = await state("mei");
  assert.equal(m.following[0].name, "Mrs Chan");
  assert.ok(!JSON.stringify(m).includes("WCHS"), "carer must not see service codes");

  // Travel day: staff only see passengers at their own post
  await act("chan", { type: "startTravel" });
  assert.equal((await state("alex")).assigned.length, 1);              // alex is at check-in by default
  await act("alex", { type: "setPost", post: "gate" });
  assert.equal((await state("alex")).assigned.length, 0);
  assert.equal((await act("alex", { type: "handover", userId: "u-chan" })).status, 403);
  await act("alex", { type: "setPost", post: "checkin" });

  // Help button reaches staff; ack clears it
  await act("chan", { type: "help" });
  assert.ok((await state("alex")).assigned[0].help);
  await act("alex", { type: "ackHelp", userId: "u-chan" });
  assert.equal((await state("alex")).assigned[0].help, null);

  // Handovers: check-in, security, gate by staff; crew can't skip ahead
  assert.equal((await act("dan", { type: "handover", userId: "u-chan" })).status, 403);
  for (const post of ["checkin", "security", "gate"]) {
    await act("alex", { type: "setPost", post });
    assert.equal((await act("alex", { type: "handover", userId: "u-chan" })).status, 200);
  }
  m = await state("mei");
  assert.equal(m.following[0].trip.stageName, "On board");
  assert.ok(m.following[0].updates.some((u) => u.text.includes("checked in")));

  // Crew see the approved brief; brief disappears if the passenger withdraws consent
  let c = await state("dan");
  assert.ok(c.cabin[0].brief.includes("write things down"));
  await act("chan", { type: "consent", key: "crew", value: false });
  c = await state("dan");
  assert.equal(c.cabin[0].brief, null);
  assert.equal(c.cabin[0].evac, true);                                 // safety info always shown
  await act("chan", { type: "consent", key: "crew", value: true });

  // Discreet help on board goes to crew
  await act("chan", { type: "help" });
  assert.ok((await state("dan")).cabin[0].help);
  await act("dan", { type: "ackHelp", userId: "u-chan" });
  assert.equal((await act("dan", { type: "handover", userId: "u-chan" })).status, 200);

  // Pausing Carer Mode hides everything from the carer
  const carerId = (await state("chan")).carers[0].id;
  await act("chan", { type: "carerPause", carerId, paused: true });
  m = await state("mei");
  assert.equal(m.following[0].paused, true);
  assert.equal(m.following[0].trip, undefined);
  await act("chan", { type: "carerPause", carerId, paused: false });

  // Supervisor: delay re-plan needs approval; sees all trips
  assert.equal((await act("alex", { type: "delay" })).status, 403);
  await act("priya", { type: "delay" });
  assert.equal((await state("chan")).trip.delay.status, "pending");
  await act("priya", { type: "approveDelay" });
  assert.equal((await state("chan")).trip.delay.status, "approved");
  assert.equal((await state("priya")).trips[0].stageName, "Arrival · Heathrow");

  // Arrival team finishes the journey
  await act("alex", { type: "setPost", post: "arrival" });
  await act("alex", { type: "handover", userId: "u-chan", stage: 4 });
  assert.equal((await act("alex", { type: "handover", userId: "u-chan", stage: 4 })).status, 409); // double-tap safe
  await act("alex", { type: "handover", userId: "u-chan", stage: 5 });
  s = await state("chan");
  assert.equal(s.trip.phase, "done");
  assert.ok(s.log.some((l) => l.who === "Alex Wong"));                // every staff action is in her access log

  // Report a problem, then ask a question (safety questions skip the AI)
  assert.ok((await act("chan", { type: "report", kind: "damage", detail: "bent footrest" })).body.ref.startsWith("SJ-"));
  const before = sent.length;
  const a = await act("chan", { type: "ask", question: "Can I bring a lithium battery?" });
  assert.equal(a.body.answer.needs_human, true);
  assert.equal(sent.length, before);
  assert.equal((await act("chan", { type: "ask", question: "Can I bring my folding wheelchair?" })).body.answer.source, "P1");

  // Delete everything
  await act("chan", { type: "deleteMyData" });
  s = await state("chan");
  assert.equal(s.passport, null); assert.equal(s.trip, null); assert.equal(s.carers.length, 0);
  assert.equal((await state("mei")).following.length, 0);
});

test("demo seed and reset", async () => {
  const seedUsers = { passenger: { sub: "d-p", name: "Mrs Chan" }, carer: { sub: "d-c", name: "Mei" }, staff: [{ sub: "u-alex", name: "Alex Wong" }], crew: { sub: "u-dan", name: "Daniel Yip" }, supervisor: { sub: "u-priya", name: "Priya Shah" } };
  await api.handler({ admin: "seed", users: seedUsers });
  users.dp = { sub: "d-p", email: "p@example.com", name: "Mrs Chan", groups: "[passenger]" };
  users.dc = { sub: "d-c", email: "c@example.com", name: "Mei", groups: "[carer]" };
  let s = await state("dp");
  assert.equal(s.passport.status, "verified"); assert.equal(s.trip.brief.status, "approved");
  assert.equal((await state("dc")).following[0].name, "Mrs Chan");
  await act("dp", { type: "startTravel" });
  assert.equal((await act("priya", { type: "resetDemo" })).status, 200);
  assert.equal((await state("dp")).trip.phase, "booked");
});

/* ---- public demo AI + guards ---- */
const pub = (body) => api.handler({ rawPath: "/api/ai", requestContext: { http: { method: "POST" } }, body: typeof body === "string" ? body : JSON.stringify(body) });
test("demo AI: whitelist, limits, safety routing, throttling, no content in logs", async () => {
  replyFor = () => PASSPORT_JSON;
  const r = JSON.parse((await pub({ task: "passport", text: "can't manage stairs" })).body).result;
  assert.ok(!r.codes.some((c) => c.code === "FAKE"));
  assert.equal((await pub({ task: "write me a poem" })).statusCode, 400);
  assert.equal((await pub("{oops")).statusCode, 400);
  assert.equal((await pub({ task: "ask", question: "x".repeat(13000) })).statusCode, 413);
  assert.equal(JSON.parse((await pub({ task: "ask", question: "lithium battery?" })).body).result.needs_human, true);
  const logs = []; const orig = console.error; console.error = (...a) => logs.push(a.join(" "));
  api._setClient({ send: async () => { throw Object.assign(new Error("slow"), { name: "ThrottlingException" }); } });
  assert.equal((await pub({ task: "ask", question: "secret seat question" })).statusCode, 429);
  console.error = orig;
  assert.ok(logs.every((l) => !l.includes("secret")));
});

test("flights: parses HKIA open data in either key casing; yesterday in HK time", async () => {
  const sample = [{ date: "2026-11-13", list: [
    { time: "23:50", flight: [{ no: "CX 255", airline: "CPA" }], status: "Dep 00:02", destination: ["LHR"], terminal: "T1", aisle: "J", gate: "23" },
    { time: "09:10", flight: [{ no: "CX 501", airline: "CPA" }], status: "Dep 09:15", destination: ["NRT"] },
    { time: "10:00", flight: [{ no: "BA 32", airline: "BAW" }, { no: "CX 7720", airline: "CPA" }], status: "Dep 10:05", destination: ["LHR"] }
  ]}];
  const upper = JSON.parse(JSON.stringify(sample).replace(/"(\w+)":/g, (m, k) => '"' + k[0].toUpperCase() + k.slice(1) + '":'));
  for (const body of [sample, upper]) {
    const s = api.summariseFlights(body, "2026-11-13");
    assert.equal(s.total, 2); assert.equal(s.hourly[23], 1); assert.equal(s.london[0].gate, "23");
  }
  assert.equal(api.yesterdayHK(Date.parse("2026-11-14T17:00:00Z")), "2026-11-14");
  assert.equal(api.yesterdayHK(Date.parse("2026-11-14T15:00:00Z")), "2026-11-13");
});
