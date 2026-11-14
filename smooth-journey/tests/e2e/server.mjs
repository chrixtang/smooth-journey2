// End-to-end test server: a local stand-in for CloudFront + API Gateway that runs the real Lambda handler
// with an in-memory database and a fake model. Start it, then run run.py (Python + Playwright).
import http from "node:http"; import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
process.env.MODEL_ID = "test-model";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
process.env.PROMPT_LOG = process.env.PROMPT_LOG || path.join(ROOT, "tests/e2e/prompts.log");
const api = await import(ROOT + "/backend/index.mjs");
api._setDb(api.memoryDb());
api._setClient({ send: async (cmd) => { const p = cmd.input.messages[0].content[0].text;
  const t = p.includes("SSR") ? '{"codes":[{"code":"WCHS","need":"Cannot manage stairs; can walk short distances"},{"code":"WCMP","need":"Own folding wheelchair"},{"code":"DEAF","need":"Hard of hearing; prefers writing"},{"code":"MAAS","need":"Travelling alone"}],"plain_summary":"Cannot manage stairs, own wheelchair, prefers writing, travelling alone.","medif":false,"evacuation_help":true,"safety_assistant":false,"removed_diagnoses":[],"questions_for_staff":["Does she need the on-board wheelchair?"]}'
    : p.includes("cabin crew") ? "Prefers written communication. Cannot manage stairs; can walk short distances in the cabin. Own folding wheelchair to be returned at the door."
    : '{"answer":"Yes. Your own folding wheelchair travels free in the hold.","source":"P1","confidence":93,"needs_human":false}';
  fs.appendFileSync(process.env.PROMPT_LOG, JSON.stringify(p) + "\n");
  return { output: { message: { content: [{ text: t }] } } }; } });
api._setFetch(async () => ({ ok: true, json: async () => [{ date: "x", list: Array.from({ length: 60 }, (_, i) => ({ time: String(i % 24).padStart(2, "0") + ":10", flight: [{ no: "CX " + (200 + i) }], destination: [i === 55 ? "LHR" : "NRT"], gate: "2" + (i % 9), status: "Dep" })) }] }));
const types = { ".html": "text/html", ".js": "text/javascript", ".png": "image/png", ".webmanifest": "application/manifest+json" };
http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x"); let body = "";
  for await (const c of req) body += c;
  if (url.pathname === "/__seed") { const r = await api.handler({ admin: "seed", users: JSON.parse(body) }); res.end(JSON.stringify(r)); return; }
  if (url.pathname === "/__trigger") { api._setCognito({ send: async () => {} }); await api.handler(JSON.parse(body)); res.end("{}"); return; }
  if (url.pathname.startsWith("/api/")) {
    let claims;
    if (["/api/state", "/api/action"].includes(url.pathname)) {
      const tok = (req.headers.authorization || "").replace(/^Bearer /, "");
      try { claims = JSON.parse(Buffer.from(tok.split(".")[1], "base64url").toString()); } catch { res.writeHead(401); res.end('{"message":"Unauthorized"}'); return; }
      if (!claims.exp || claims.exp * 1000 < Date.now()) { res.writeHead(401); res.end('{"message":"Unauthorized"}'); return; }
      claims = { ...claims, "cognito:groups": "[" + (claims["cognito:groups"] || []).join(" ") + "]" };   // how HTTP API passes array claims
    }
    const r = await api.handler({ rawPath: url.pathname, requestContext: { http: { method: req.method }, authorizer: claims ? { jwt: { claims } } : undefined }, body, queryStringParameters: Object.fromEntries(url.searchParams) });
    res.writeHead(r.statusCode, r.headers); res.end(r.body); return;
  }
  let f = path.join(ROOT, "frontend", url.pathname === "/" ? "index.html" : url.pathname);
  if (url.pathname === "/config.js") { res.writeHead(200, { "content-type": "text/javascript" }); res.end('window.SJ_CONFIG={region:"test",clientId:"abc",demoPassword:"SmoothDemo2026"};'); return; }
  if (!fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream" }); res.end(fs.readFileSync(f));
}).listen(8787, () => console.log("ready"));
