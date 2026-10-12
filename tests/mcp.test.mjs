/**
 * End-to-end test for the teleprompter MCP server (stdio JSON-RPC).
 *
 * Runs fully isolated on TELEPROMPTER_PORT=4790 with auto-open disabled, so it
 * never touches a real drill or pops a window.
 *
 *   node tests/mcp.test.mjs
 */
import { spawn } from "node:child_process";

const PORT = 4790;
const BASE = `http://127.0.0.1:${PORT}`;
const MCP = new URL("../app/mcp.mjs", import.meta.url).pathname;
const SERVER = new URL("../app/server.js", import.meta.url).pathname;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  :: " + extra : ""}`);
};

/* ماندگاری: هر اجرا باید از وضعیتِ تمیز شروع کند (نه state باقی‌مانده از قبل) */
try {
  const { rmSync } = await import("node:fs");
  rmSync(new URL("../app/state-4790.json", import.meta.url), { force: true });
} catch {}

const child = spawn(process.execPath, [MCP], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, TELEPROMPTER_PORT: String(PORT), TELEPROMPTER_NO_OPEN: "1" },
});

let buf = "";
const pending = new Map();
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== undefined && msg.id !== null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

let nextId = 1;
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }
    }, 30000);
  });
const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
const call = async (name, args) => {
  const r = await request("tools/call", { name, arguments: args });
  if (r.error) throw new Error(JSON.stringify(r.error));
  return r.result;
};
const firstText = (r) => (r.content || []).map((c) => c.text).join("\n");
const api = (path, body) =>
  fetch(BASE + path, body
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : undefined).then((r) => r.json());

try {
  /* 1. handshake */
  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  });
  check("initialize", init.result?.serverInfo?.name === "teleprompter", JSON.stringify(init.result?.serverInfo));
  notify("notifications/initialized");

  const ping = await request("ping", {});
  check("ping", !!ping.result);

  /* 2. tool list */
  const list = await request("tools/list", {});
  const names = (list.result?.tools || []).map((t) => t.name).sort();
  check(
    "tools/list has 5 tools",
    JSON.stringify(names) ===
      JSON.stringify(["teleprompter_note", "teleprompter_push", "teleprompter_reset", "teleprompter_status", "teleprompter_wait"]),
    JSON.stringify(names),
  );
  check("schemas are objects", (list.result?.tools || []).every((t) => t.inputSchema?.type === "object"));

  /* 3. status auto-starts the local server (port is free at this point) */
  const st0 = await call("teleprompter_status", {});
  check("status auto-starts server", /تمرین فعالی نیست/.test(firstText(st0)), firstText(st0).slice(0, 80));
  check("server healthy", (await fetch(`${BASE}/health`).then((r) => r.ok)));

  /* 4. push a drill */
  const pushed = await call("teleprompter_push", {
    title: "تست MCP",
    goal: "آزمایش مسیر MCP",
    language: "python",
    mode: "both",
    targetFile: `${BASE}-no-such-file.py`,
    code: "def add(a, b):\n    return a + b\n",
  });
  check("push accepted", /تمرین/.test(firstText(pushed)) && !pushed.isError, firstText(pushed).slice(0, 90));
  const state = await api("/api/state");
  check("drill stored", state.drill?.title === "تست MCP" && state.progress?.total === 2, `lines=${state.progress?.total}`);
  check("heartbeat → hub connections card", !!state.integrations?.mcp, JSON.stringify(state.integrations || null));

  /* 4b. line-anchored note: attached, clamped, visible in state */
  const noted = await call("teleprompter_note", { line: 99, text: "یادداشت خط دوم" });
  check("note accepted", /line 2/.test(firstText(noted)) && !noted.isError, firstText(noted).slice(0, 90));
  const state2 = await api("/api/state");
  check("note stored on the line", state2.drill?.notes?.length === 1 && state2.drill.notes[0].line === 2, JSON.stringify(state2.drill?.notes));
  const notedBad = await call("teleprompter_note", { line: 1, text: "   " });
  check("blank note rejected", !!notedBad.isError, firstText(notedBad).slice(0, 60));

  /* 5. status now reports the drill */
  const st1 = await call("teleprompter_status", {});
  check("status shows drill", /تست MCP/.test(firstText(st1)) && /0٪/.test(firstText(st1)), firstText(st1).slice(0, 120));

  /* 5b. mission control: user asks from the app → wait returns the question */
  await api("/api/ask", { text: "why this line?" });
  const asked = await call("teleprompter_wait", { timeoutSeconds: 15 });
  check("wait returns the user question", /why this line\?/.test(firstText(asked)), firstText(asked).split("\n")[0]);

  /* 6. wait -> timeout while nothing completes */
  const waited = await call("teleprompter_wait", { timeoutSeconds: 5 });
  check("wait times out", /timeout/.test(firstText(waited)), firstText(waited).split("\n")[0]);

  /* 7. complete the drill, then wait returns immediately with the result */
  await api("/api/complete", { by: "practice", wpm: 55 });
  const waited2 = await call("teleprompter_wait", { timeoutSeconds: 15 });
  check("wait sees completion", /تمام شد|تکمیل/.test(firstText(waited2)), firstText(waited2).split("\n")[0]);
  check("wait summary includes speed", /55/.test(firstText(waited2)));

  /* 8. reset */
  const reset = await call("teleprompter_reset", {});
  check("reset", /پاک شد/.test(firstText(reset)));
  const after = await api("/api/state");
  check("drill cleared", after.drill === null);

  /* 9. unknown method -> JSON-RPC error */
  const bad = await request("nope/method", {});
  check("unknown method errors", bad.error?.code === -32601, JSON.stringify(bad.error));

  /* 10. instance management: identity + self-shutdown */
  const health = await fetch(`${BASE}/health`).then((r) => r.json());
  check("health reports identity", health.ok === true && health.pid > 0 && health.stale === false, JSON.stringify({ pid: health.pid, stale: health.stale }));
  const sdNo = await fetch(`${BASE}/api/shutdown`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
  check("shutdown needs confirm", sdNo.status === 400, String(sdNo.status));
  await fetch(`${BASE}/api/shutdown`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }) });
  await sleep(800);
  const dead = await fetch(`${BASE}/health`).then(() => false).catch(() => true);
  check("shutdown stops the server", dead === true);
} catch (err) {
  check("no exceptions", false, String(err));
} finally {
  child.kill("SIGTERM");
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
// the isolated server we spawned (if any) keeps running: kill it by port
try {
  const { execSync } = await import("node:child_process");
  execSync(`lsof -ti tcp:${PORT} | xargs kill -9 2>/dev/null || true`, { stdio: "ignore" });
} catch {}
process.exit(failed ? 1 : 0);
