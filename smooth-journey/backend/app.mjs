// The real app: what each signed-in role may see (state) and do (actions).
// Need-to-know is enforced HERE, on the server, not in the browser.
import { randomInt, randomUUID } from "node:crypto";
import { db } from "./db.mjs";
import { AI_ENABLED, redact, clip, suggestCodes, draftBrief, answerQuestion, rulesPassport, templateBrief, EVAC_LINE, dropDx } from "./ai.mjs";

export const STAGES = [
  { name: "Check-in", post: "checkin", where: "HKIA T1 · check-in" },
  { name: "Security & immigration", post: "security", where: "HKIA T1 · escort" },
  { name: "Gate", post: "gate", where: "HKIA T1 · boarding gate" },
  { name: "On board", post: "crew", where: "On board CX 255" },
  { name: "Arrival · Heathrow", post: "arrival", where: "LHR T3 · aircraft door" },
  { name: "Baggage & meet family", post: "arrival", where: "LHR T3 · arrivals hall" }
];
export const POSTS = { checkin: "Check-in", security: "Security & immigration escort", gate: "Boarding gate", arrival: "Heathrow arrival team" };
const CARER_TEXT = [
  (n, by) => `${n} has checked in. ${by} from check-in has them.`,
  (n) => `${n} is through security and immigration.`,
  (n) => `${n} has boarded. The crew have the approved brief.`,
  (n) => `${n} has landed and been handed to the arrival team at Heathrow.`,
  (n) => `${n} is through arrival and on the way to baggage reclaim.`,
  (n) => `${n} has their bags and has met their family. Journey complete.`
];
const CONSENT_KEYS = ["carer", "crew", "partners", "analytics", "ai"];
const DEFAULT_CONSENTS = { carer: true, crew: true, partners: true, analytics: true, ai: true };
const DEMO_TEXT = "Mum can walk short distances but can't manage stairs. She brings her own folding wheelchair. She's hard of hearing when it's noisy, so writing things down works best. She gets anxious in crowds. She is flying alone. I'll drop her off at the airport.";
const OVERDUE_MIN = 15;
const DAY = 86400;

export class AppError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const forbid = () => new AppError(403, "forbidden");
const bad = (code) => new AppError(400, code);

const U = (id) => "U#" + id;
const nowIso = () => new Date().toISOString();
const ttl = (days) => Math.floor(Date.now() / 1000) + days * DAY;
const cleanName = (s, fallback) => (clip(String(s || ""), 40).replace(/[<>]/g, "") || fallback);
const strip = (item) => { if (!item) return null; const { pk, sk, gsi1pk, gsi1sk, ttl: _t, ...rest } = item; return rest; };

function hkDate(daysAhead) {
  return new Date(Date.now() + 8 * 3600e3 + daysAhead * DAY * 1000).toISOString().slice(0, 10);
}

/* ---------------- profile, logs, events ---------------- */
export async function ensureProfile(u) {
  const D = db();
  let p = await D.get(U(u.sub), "PROFILE");
  if (!p) {
    const fallback = (u.email || "Traveller").split("@")[0].replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    p = { pk: U(u.sub), sk: "PROFILE", role: u.role, name: cleanName(u.name, fallback), consents: { ...DEFAULT_CONSENTS }, createdAt: nowIso() };
    if (u.role === "staff") p.post = "checkin";
    await D.put(p);
  } else if (p.role !== u.role) {
    p.role = u.role; await D.put(p);
  }
  return p;
}
async function log(ownerId, who, what) {
  await db().put({ pk: U(ownerId), sk: "LOG#" + nowIso() + "#" + randomUUID().slice(0, 6), who, what, at: nowIso(), ttl: ttl(30) });
}
async function event(ownerId, text) {
  await db().put({ pk: U(ownerId), sk: "EVT#" + nowIso() + "#" + randomUUID().slice(0, 6), text, at: nowIso(), ttl: ttl(30) });
}
async function seenOnce(ownerId, viewer, stage, label) {
  const first = await db().putIfAbsent({ pk: U(ownerId), sk: `SEEN#${viewer.sub}#${stage}`, at: nowIso(), ttl: ttl(30) });
  if (first) await log(ownerId, viewer.name, `Opened your details for ${label}`);
}

function staffNotes(passport) {
  const codes = (passport && passport.codes || []).map((c) => c.code);
  const n = [];
  if (codes.includes("DEAF")) n.push("Prefers written communication");
  if (codes.includes("WCMP")) n.push("Own folding wheelchair: return at the aircraft door");
  if (codes.includes("MAAS")) n.push("Travelling alone: meet before the carer leaves");
  if (passport && passport.evac) n.push("Will need help in an evacuation");
  for (const c of (passport && passport.codes) || []) if (c.code === "OTHS") n.push(c.desc);
  return n;
}
function tripView(t) {
  if (!t) return null;
  const v = strip(t);
  v.stageName = t.phase === "travel" ? STAGES[t.stage].name : null;
  return v;
}

/* ---------------- state per role ---------------- */
export async function getState(u) {
  const prof = await ensureProfile(u);
  const D = db();
  const me = { name: prof.name, email: u.email, role: u.role };
  if (u.role === "passenger") {
    const [passport, trip, carers, logs] = await Promise.all([D.get(U(u.sub), "PASSPORT"), D.get(U(u.sub), "TRIP"), D.query(U(u.sub), "CARER#"), D.query(U(u.sub), "LOG#")]);
    const codeValid = prof.shareCode && prof.shareCodeExpires && prof.shareCodeExpires > nowIso();
    return {
      role: "passenger", ai: AI_ENABLED, stages: STAGES.map((s) => s.name),
      me: { ...me, consents: prof.consents, shareCode: codeValid ? prof.shareCode : null, shareCodeExpires: codeValid ? prof.shareCodeExpires : null },
      passport: strip(passport), trip: tripView(trip),
      carers: carers.map((c) => ({ id: c.sk.slice(6), name: c.carerName, paused: !!c.paused })),
      log: logs.reverse().slice(0, 25).map((l) => ({ at: l.at, who: l.who, what: l.what }))
    };
  }
  if (u.role === "carer") {
    const follows = await D.query(U(u.sub), "FOLLOWS#");
    const people = [];
    for (const f of follows) {
      const pid = f.sk.slice(8);
      const [pprof, link] = await Promise.all([D.get(U(pid), "PROFILE"), D.get(U(pid), "CARER#" + u.sub)]);
      if (!pprof || !link) { people.push({ id: pid, name: f.passengerName, removed: true }); continue; }
      const sharing = pprof.consents && pprof.consents.carer && !link.paused;
      if (!sharing) { people.push({ id: pid, name: pprof.name, paused: true }); continue; }
      const [trip, evts] = await Promise.all([D.get(U(pid), "TRIP"), D.query(U(pid), "EVT#")]);
      people.push({
        id: pid, name: pprof.name, paused: false,
        trip: trip ? { flight: trip.flight, route: trip.route, date: trip.date, phase: trip.phase, stage: trip.stage, stageName: trip.phase === "travel" ? STAGES[trip.stage].name : null, delay: trip.delay || null, briefApproved: trip.brief && trip.brief.status === "approved" } : null,
        updates: evts.reverse().slice(0, 20).map((e) => ({ at: e.at, text: e.text }))
      });
    }
    return { role: "carer", stages: STAGES.map((s) => s.name), me, following: people };
  }
  if (u.role === "staff") {
    const post = POSTS[prof.post] ? prof.post : "checkin";
    const [queue, trips] = await Promise.all([D.byIndex("QUEUE"), D.byIndex("TRIPS")]);
    const assigned = [];
    for (const t of trips) {
      if (t.phase !== "travel" || STAGES[t.stage].post !== post) continue;
      const pid = t.pk.slice(2);
      const passport = await D.get(U(pid), "PASSPORT");
      await seenOnce(pid, { sub: u.sub, name: prof.name }, t.stage, STAGES[t.stage].name);
      const prev = (t.stages || [])[t.stages.length - 1];
      assigned.push({
        userId: pid, name: t.passengerName, flight: t.flight, seat: t.seat, stage: t.stage, stageName: STAGES[t.stage].name,
        from: prev ? prev.by : "Carer at drop-off", next: STAGES[t.stage + 1] ? STAGES[t.stage + 1].name : "Family in arrivals",
        codes: passport && passport.status === "verified" ? passport.codes.map((c) => c.code) : [], notes: staffNotes(passport && passport.status === "verified" ? passport : null),
        help: t.help && !t.help.ack && t.help.stage === t.stage ? t.help : null, delay: t.delay || null
      });
    }
    const upcoming = trips.filter((t) => t.phase === "booked").length;
    return {
      role: "staff", me: { ...me, post, postName: POSTS[post] }, posts: POSTS,
      queue: queue.map((p) => ({ userId: p.pk.slice(2), name: p.name, redacted: p.redacted, codes: p.codes, medif: p.medif, medifWhy: p.medifWhy, evac: p.evac, safetyAsst: p.safetyAsst, questions: p.questions || [], source: p.source, at: p.gsi1sk })),
      assigned, upcoming
    };
  }
  if (u.role === "crew") {
    const trips = (await D.byIndex("TRIPS")).filter((t) => t.flight === "CX 255" && (t.phase === "booked" || (t.phase === "travel" && t.stage <= 3)));
    const cabin = [];
    for (const t of trips) {
      const pid = t.pk.slice(2);
      const [passport, pprof] = await Promise.all([D.get(U(pid), "PASSPORT"), D.get(U(pid), "PROFILE")]);
      const shareBrief = pprof && pprof.consents && pprof.consents.crew && t.brief && t.brief.status === "approved";
      if (t.phase === "travel" && t.stage === 3) await seenOnce(pid, { sub: u.sub, name: prof.name }, 3, "the crew briefing");
      cabin.push({
        userId: pid, name: t.passengerName, seat: t.seat, phase: t.phase, stage: t.stage, onBoard: t.phase === "travel" && t.stage === 3,
        codes: passport && passport.status === "verified" ? passport.codes.map((c) => c.code) : [],
        brief: shareBrief ? t.brief.text : null, briefShared: !!shareBrief, evac: !!(passport && passport.evac),
        help: t.onboardHelp && !t.onboardHelp.ack ? t.onboardHelp : null
      });
    }
    return { role: "crew", me, flight: { no: "CX 255", route: "HKG → LHR", aircraft: "A350-1000" }, cabin };
  }
  if (u.role === "supervisor") {
    const [trips, queue] = await Promise.all([D.byIndex("TRIPS"), D.byIndex("QUEUE")]);
    const now = Date.now();
    const rows = trips.map((t) => {
      const age = t.stageStartedAt ? Math.round((now - Date.parse(t.stageStartedAt)) / 60000) : null;
      const last = (t.stages || [])[(t.stages || []).length - 1];
      return {
        userId: t.pk.slice(2), name: t.passengerName, flight: t.flight, date: t.date, phase: t.phase,
        stage: t.stage, stageName: t.phase === "travel" ? STAGES[t.stage].name : t.phase === "done" ? "Complete" : "Booked",
        lastBy: last ? last.by : "", minutes: t.phase === "travel" ? age : null, overdue: t.phase === "travel" && age != null && age > OVERDUE_MIN,
        help: !!(t.help && !t.help.ack) || !!(t.onboardHelp && !t.onboardHelp.ack), delay: t.delay || null
      };
    });
    return { role: "supervisor", me, trips: rows, queueCount: queue.length, overdueMinutes: OVERDUE_MIN };
  }
  throw forbid();
}

/* ---------------- actions ---------------- */
async function getTrip(pid) { return db().get(U(pid), "TRIP"); }
async function saveTrip(t) { await db().put(t); }

async function maybeDraftBrief(pid, trip, passport, prof) {
  if (!trip || !passport || passport.status !== "verified") return;
  if (trip.brief && trip.brief.status !== "none") return;
  const useAI = !!(prof && prof.consents && prof.consents.ai);
  const b = await draftBrief(passport, useAI);
  trip.brief = { text: b.text, status: "draft", source: b.source, note: b.note || "" };
  await saveTrip(trip);
}

export async function doAction(u, body) {
  const D = db();
  const prof = await ensureProfile(u);
  const type = body && body.type;
  const role = u.role;
  const need = (...roles) => { if (!roles.includes(role)) throw forbid(); };

  switch (type) {
    /* ----- everyone ----- */
    case "setName": {
      prof.name = cleanName(body.name, prof.name); await D.put(prof);
      const trip = await getTrip(u.sub); if (trip) { trip.passengerName = prof.name; await saveTrip(trip); }
      return { ok: true };
    }

    /* ----- passenger ----- */
    case "passportSubmit": {
      need("passenger");
      if (body.consent !== true) throw bad("consent_required");
      const text = clip(body.text, 1500);
      if (text.length < 10) throw bad("text_required");
      const redacted = redact(text);
      const useAI = !!body.useAI && !!prof.consents.ai;
      const s = await suggestCodes(redacted, useAI);
      s.conditionsRemoved = s.conditionsRemoved || /\[condition\]/.test(redacted);   // store that names were removed, never the words
      const at = nowIso();
      await D.put({ pk: U(u.sub), sk: "PASSPORT", status: "draft", redacted, ...s, name: prof.name, consentAt: at, createdAt: at, gsi1pk: "QUEUE", gsi1sk: at });
      const trip = await getTrip(u.sub);
      if (trip && trip.brief && trip.brief.status !== "none") { trip.brief = { text: "", status: "none", source: "", note: "" }; await saveTrip(trip); }
      if (s.source === "ai") await log(u.sub, "AI (Amazon Nova on Amazon Bedrock)", "Suggested codes from your redacted words. Nothing kept by the AI.");
      return { ok: true };
    }
    case "passportReset": {
      need("passenger");
      await D.del(U(u.sub), "PASSPORT");
      const trip = await getTrip(u.sub);
      if (trip) { trip.brief = { text: "", status: "none", source: "", note: "" }; await saveTrip(trip); }
      return { ok: true };
    }
    case "book": {
      need("passenger");
      const existing = await getTrip(u.sub);
      if (existing && existing.phase !== "done") throw bad("already_booked");
      const date = hkDate(3);
      const trip = { pk: U(u.sub), sk: "TRIP", flight: "CX 255", route: "HKG → LHR", date, depart: "23:50", seat: "41C", passengerName: prof.name,
        phase: "booked", stage: 0, stages: [], brief: { text: "", status: "none", source: "", note: "" }, help: null, onboardHelp: null, delay: null, issues: [],
        bookedAt: nowIso(), gsi1pk: "TRIPS", gsi1sk: date + "#" + u.sub };
      await saveTrip(trip);
      await log(u.sub, "You", `Booked CX 255 on ${date}, seat 41C`);
      await event(u.sub, `${prof.name} booked CX 255 to London on ${date}.`);
      await maybeDraftBrief(u.sub, trip, await D.get(U(u.sub), "PASSPORT"), prof);
      return { ok: true };
    }
    case "briefSave": {
      need("passenger");
      const trip = await getTrip(u.sub); if (!trip || !trip.brief || trip.brief.status === "none") throw bad("no_brief");
      const passport = await D.get(U(u.sub), "PASSPORT");
      let t = dropDx(clip(body.text, 700).replace(/\s+/g, " "));
      if (!t) throw bad("text_required");
      let note = "";
      if (passport && passport.evac && !/evacuat/i.test(t)) { t = t.replace(/\.?$/, ".") + " " + EVAC_LINE; note = "The evacuation line was added back because it's safety information."; }
      trip.brief = { text: t, status: "draft", source: "you", note }; await saveTrip(trip);
      return { ok: true };
    }
    case "briefRedraft": {
      need("passenger");
      const trip = await getTrip(u.sub); const passport = await D.get(U(u.sub), "PASSPORT");
      if (!trip || !passport || passport.status !== "verified") throw bad("not_ready");
      trip.brief = { text: "", status: "none", source: "", note: "" };
      await maybeDraftBrief(u.sub, trip, passport, prof);
      return { ok: true };
    }
    case "briefApprove": {
      need("passenger");
      const trip = await getTrip(u.sub); if (!trip || !trip.brief || trip.brief.status !== "draft") throw bad("no_brief");
      trip.brief.status = "approved"; trip.brief.note = ""; await saveTrip(trip);
      await log(u.sub, "You", "Approved the exact wording crew will see");
      await event(u.sub, `${prof.name} approved what the crew will be told.`);
      return { ok: true };
    }
    case "startTravel": {
      need("passenger");
      const trip = await getTrip(u.sub); const passport = await D.get(U(u.sub), "PASSPORT");
      if (!trip || trip.phase !== "booked") throw bad("not_booked");
      if (!passport || passport.status !== "verified") throw bad("passport_not_checked");
      Object.assign(trip, { phase: "travel", stage: 0, stages: [], stageStartedAt: nowIso(), help: null, onboardHelp: null });
      await saveTrip(trip);
      await event(u.sub, `${prof.name}'s travel day has started. Next: check-in.`);
      return { ok: true };
    }
    case "help": {
      need("passenger");
      const trip = await getTrip(u.sub); if (!trip || trip.phase !== "travel") throw bad("not_travelling");
      if (trip.stage === 3) trip.onboardHelp = { at: nowIso(), ack: false };
      else trip.help = { at: nowIso(), stage: trip.stage, ack: false };
      await saveTrip(trip);
      return { ok: true };
    }
    case "consent": {
      need("passenger");
      if (!CONSENT_KEYS.includes(body.key)) throw bad("unknown_consent");
      prof.consents = { ...DEFAULT_CONSENTS, ...prof.consents, [body.key]: !!body.value };
      await D.put(prof);
      const labels = { carer: "Carer Mode", crew: "crew brief", partners: "partner sharing", analytics: "anonymous feedback", ai: "AI drafting" };
      await log(u.sub, "You", `Turned ${body.value ? "on" : "off"}: ${labels[body.key]}`);
      return { ok: true };
    }
    case "shareCode": {
      need("passenger");
      const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
      let code = ""; for (let i = 0; i < 6; i++) code += alphabet[randomInt(alphabet.length)];
      const expires = new Date(Date.now() + DAY * 1000).toISOString();
      if (prof.shareCode) await D.del("CODE#" + prof.shareCode, "CODE");
      await D.put({ pk: "CODE#" + code, sk: "CODE", owner: u.sub, expires, ttl: ttl(1) });
      prof.shareCode = code; prof.shareCodeExpires = expires; await D.put(prof);
      return { ok: true, code };
    }
    case "carerPause": case "carerRemove": {
      need("passenger");
      const cid = clip(body.carerId, 80);
      const link = await D.get(U(u.sub), "CARER#" + cid); if (!link) throw bad("no_such_carer");
      if (type === "carerPause") { link.paused = !!body.paused; await D.put(link); await log(u.sub, "You", `${link.paused ? "Paused" : "Resumed"} sharing with ${link.carerName}`); }
      else { await D.del(U(u.sub), "CARER#" + cid); await D.del(U(cid), "FOLLOWS#" + u.sub); await log(u.sub, "You", `Stopped sharing with ${link.carerName}`); }
      return { ok: true };
    }
    case "report": {
      need("passenger");
      const kinds = { damage: "Damaged wheelchair or mobility aid", late: "Help was late", missed: "A handover didn't happen" };
      if (!kinds[body.kind]) throw bad("unknown_kind");
      const trip = await getTrip(u.sub); if (!trip) throw bad("no_trip");
      const ref = "SJ-" + String(randomInt(10000, 99999));
      const detail = redact(clip(body.detail, 300));
      trip.issues = [...(trip.issues || []), { ref, kind: kinds[body.kind], detail, at: nowIso(), stage: trip.phase === "travel" ? STAGES[trip.stage].name : trip.phase, goodwill: "8,000 Asia Miles + lounge access on your return" }];
      await saveTrip(trip);
      await log(u.sub, "You", `Reported: ${kinds[body.kind]} (${ref}). Sent to a claims specialist.`);
      await event(u.sub, `${prof.name} reported a problem. A claims specialist has it.`);
      return { ok: true, ref };
    }
    case "ask": {
      need("passenger", "carer");
      const r = await answerQuestion(body.question, body.history, !!(prof.consents && prof.consents.ai !== false));
      if (!r) throw bad("question_required");
      return { ok: true, answer: r };
    }
    case "deleteMyData": {
      const mine = await D.query(U(u.sub));
      for (const it of mine) {
        if (it.sk.startsWith("CARER#")) await D.del(U(it.sk.slice(6)), "FOLLOWS#" + u.sub);
        if (it.sk.startsWith("FOLLOWS#")) await D.del(U(it.sk.slice(8)), "CARER#" + u.sub);
        await D.del(it.pk, it.sk);
      }
      if (prof.shareCode) await D.del("CODE#" + prof.shareCode, "CODE");
      return { ok: true };
    }

    /* ----- carer ----- */
    case "linkCode": {
      need("carer");
      const code = clip(String(body.code || "").toUpperCase().replace(/[^A-Z0-9]/g, ""), 6);
      const item = code.length === 6 ? await D.get("CODE#" + code, "CODE") : null;
      if (!item || item.expires < nowIso()) throw bad("code_invalid");
      if (item.owner === u.sub) throw bad("code_invalid");
      const owner = await D.get(U(item.owner), "PROFILE"); if (!owner) throw bad("code_invalid");
      await D.put({ pk: U(item.owner), sk: "CARER#" + u.sub, carerName: prof.name, paused: false, since: nowIso() });
      await D.put({ pk: U(u.sub), sk: "FOLLOWS#" + item.owner, passengerName: owner.name, since: nowIso() });
      await D.del("CODE#" + code, "CODE");
      owner.shareCode = null; owner.shareCodeExpires = null; await D.put(owner);
      await log(item.owner, prof.name, "Started following your journey (Carer Mode)");
      return { ok: true, name: owner.name };
    }
    case "unfollow": {
      need("carer");
      const pid = clip(body.passengerId, 80);
      await D.del(U(u.sub), "FOLLOWS#" + pid); await D.del(U(pid), "CARER#" + u.sub);
      return { ok: true };
    }

    /* ----- staff ----- */
    case "setPost": {
      need("staff");
      if (!POSTS[body.post]) throw bad("unknown_post");
      prof.post = body.post; await D.put(prof);
      return { ok: true };
    }
    case "verify": {
      need("staff", "supervisor");
      const pid = clip(body.userId, 80);
      const p = await D.get(U(pid), "PASSPORT");
      if (!p || p.status !== "draft") throw bad("nothing_to_check");
      const remove = new Set(Array.isArray(body.removeCodes) ? body.removeCodes.map(String) : []);
      let codes = p.codes.filter((c, i) => !remove.has(String(i)));
      if (!codes.length) throw bad("needs_one_code");
      const removedCodes = p.codes.filter((c, i) => remove.has(String(i))).map((c) => c.code);
      const evacCodes = ["WCHS", "WCHC", "STCR"], medCodes = ["MEDA", "OXYG", "STCR"];
      p.evac = p.source === "ai" ? p.evac : codes.some((c) => evacCodes.includes(c.code));
      p.medif = codes.some((c) => medCodes.includes(c.code)) || (p.medif && !removedCodes.some((c) => medCodes.includes(c)));
      Object.assign(p, { codes, status: "verified", verifiedBy: prof.name, verifiedAt: nowIso() });
      delete p.redacted; delete p.gsi1pk; delete p.gsi1sk;
      await D.put(p);
      await log(pid, prof.name, "Checked your Passport codes. Your original words were deleted.");
      const pprof = await D.get(U(pid), "PROFILE");
      await maybeDraftBrief(pid, await getTrip(pid), p, pprof);
      return { ok: true };
    }
    case "handover": {
      need("staff", "crew", "supervisor");
      const pid = clip(body.userId, 80);
      const trip = await getTrip(pid);
      if (!trip || trip.phase !== "travel") throw bad("not_travelling");
      if (typeof body.stage === "number" && body.stage !== trip.stage) throw new AppError(409, "already_moved");
      const s = trip.stage;
      if (role === "staff" && STAGES[s].post !== prof.post) throw forbid();
      if (role === "crew" && s !== 3) throw forbid();
      trip.stages = [...(trip.stages || []), { stage: s, by: prof.name, at: nowIso() }];
      if (trip.help && trip.help.stage === s) trip.help = null;
      if (s === 3) trip.onboardHelp = null;
      trip.stage = s + 1; trip.stageStartedAt = nowIso();
      if (trip.stage >= STAGES.length) { trip.phase = "done"; trip.stage = STAGES.length - 1; }
      await saveTrip(trip);
      await log(pid, prof.name, `Confirmed your handover: ${STAGES[s].name}`);
      await event(pid, CARER_TEXT[s](trip.passengerName, prof.name));
      return { ok: true };
    }
    case "ackHelp": {
      need("staff", "crew", "supervisor");
      const pid = clip(body.userId, 80);
      const trip = await getTrip(pid); if (!trip) throw bad("no_trip");
      if (role === "crew") { if (trip.onboardHelp) trip.onboardHelp = { ...trip.onboardHelp, ack: true, by: prof.name }; }
      else if (trip.help) trip.help = { ...trip.help, ack: true, by: prof.name };
      await saveTrip(trip);
      return { ok: true };
    }

    /* ----- supervisor ----- */
    case "delay": case "approveDelay": {
      need("supervisor");
      const trips = (await D.byIndex("TRIPS")).filter((t) => t.flight === "CX 255" && t.phase !== "done");
      for (const t of trips) {
        if (type === "delay") t.delay = { status: "pending", minutes: 55, newTime: "00:45", by: prof.name };
        else if (t.delay) {
          t.delay = { ...t.delay, status: "approved", approvedBy: prof.name };
          await event(t.pk.slice(2), `CX 255 is delayed 55 minutes. All of ${t.passengerName}'s assistance has moved to the new time.`);
        }
        await saveTrip(t);
      }
      return { ok: true, count: trips.length };
    }
    case "resetDemo": {
      need("supervisor");
      const cfg = await D.get("CONFIG", "DEMO");
      if (!cfg) throw bad("no_demo");
      await seedDemo(cfg.users);
      return { ok: true };
    }
    default:
      throw bad("unknown_action");
  }
}

/* ---------------- demo data (run by the setup script, or "Reset demo") ---------------- */
export async function seedDemo(users) {
  const D = db();
  await D.put({ pk: "CONFIG", sk: "DEMO", users });
  const at = nowIso();
  const P = users.passenger, C = users.carer;
  // wipe the demo passenger's and carer's data
  for (const id of [P.sub, C.sub]) for (const it of await D.query(U(id))) await D.del(it.pk, it.sk);
  const mk = (x, role, extra) => D.put({ pk: U(x.sub), sk: "PROFILE", role, name: x.name, consents: { ...DEFAULT_CONSENTS }, createdAt: at, ...extra });
  await mk(P, "passenger"); await mk(C, "carer");
  for (const s of users.staff || []) await mk(s, "staff", { post: "checkin" });
  if (users.crew) await mk(users.crew, "crew");
  if (users.supervisor) await mk(users.supervisor, "supervisor");
  const r = rulesPassport(DEMO_TEXT);
  const passport = { pk: U(P.sub), sk: "PASSPORT", status: "verified", ...r, source: "rules", note: "", name: P.name, consentAt: at, createdAt: at, verifiedBy: (users.staff && users.staff[0] && users.staff[0].name) || "Staff", verifiedAt: at };
  await D.put(passport);
  const date = hkDate(3);
  await D.put({ pk: U(P.sub), sk: "TRIP", flight: "CX 255", route: "HKG → LHR", date, depart: "23:50", seat: "41C", passengerName: P.name,
    phase: "booked", stage: 0, stages: [], brief: { text: templateBrief(passport), status: "approved", source: "rules", note: "" },
    help: null, onboardHelp: null, delay: null, issues: [], bookedAt: at, gsi1pk: "TRIPS", gsi1sk: date + "#" + P.sub });
  await D.put({ pk: U(P.sub), sk: "CARER#" + C.sub, carerName: C.name, paused: false, since: at });
  await D.put({ pk: U(C.sub), sk: "FOLLOWS#" + P.sub, passengerName: P.name, since: at });
  await log(P.sub, passport.verifiedBy, "Checked your Passport codes. Your original words were deleted.");
  await event(P.sub, `${P.name} booked CX 255 to London on ${date}. The plan is confirmed.`);
  return { ok: true };
}
