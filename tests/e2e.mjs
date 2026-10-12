/**
 * Zero-dependency e2e check for the teleprompter UI.
 * Drives a real headless Chrome over CDP (Node >= 22 has global WebSocket).
 */
const DEBUG = process.env.CDP_PORT || 9222;
/* TELEPROMPTER_TEST_PORT isolates the run (e.g. 4790) so a test never touches
 * the live drill or queues notifications into a real session. */
const APP = `http://127.0.0.1:${process.env.TELEPROMPTER_TEST_PORT || 4783}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, body) {
  const res = await fetch(APP + path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  return res.json();
}

async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const tabs = await (await fetch(`http://127.0.0.1:${DEBUG}/json/list`)).json();
      const page = tabs.find((t) => t.type === "page");
      if (page) return page;
    } catch {}
    await sleep(250);
  }
  throw new Error("no CDP page");
}

const page = await connect();
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) =>
  new Promise((r) => {
    const i = ++id;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const js = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
};

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok, extra });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  :: " + extra : ""}`);
};

await send("Page.enable");
await send("Runtime.enable");

/* ---- 1. empty state ---- */
await api("/api/reset", { all: true });
await api("/api/drill", {
  id: "e2e-1",
  title: "تست e2e",
  goal: "هدف آزمایش",
  result: "تمرین تمیز تمام شد — add کار می‌کند",
  guide: [{ from: 1, to: 2, why: "دلیلِ گام اول", result: "نتیجه‌ی گام اول" }],
  language: "javascript",
  mode: "both",
  targetFile: "/tmp/tp-e2e-dest.py",
  startLine: 12,
  code: 'export function add(a, b) {\n  return a + b;\n}\n',
});
await sleep(400);
await send("Page.navigate", { url: APP + "/" });
await sleep(1500);

/* پاک‌کردن انتخابِ چیدمانِ مانده از اجرای قبلی، بعد بارگذاری دوباره */
await js(`(() => { try { for (const k of Object.keys(localStorage)) if (k.startsWith("tpLayout:")) localStorage.removeItem(k); localStorage.removeItem("tpLang"); localStorage.removeItem("tpLayoutDefault"); } catch (_) {} return true; })()`);
await send("Page.navigate", { url: APP + "/" });
await sleep(1500);

const boot = await js(`JSON.stringify({
  title: document.getElementById("dTitle")?.textContent,
  lines: document.querySelectorAll("#lines li").length,
  firstLine: document.querySelector("#lines li .txt")?.textContent,
  current: document.querySelector("#lines li.current .no")?.textContent,
  lineNo: document.getElementById("lineNo")?.textContent,
  appHidden: document.getElementById("app").classList.contains("hidden"),
  subHidden: document.getElementById("sub").classList.contains("hidden"),
  subCur: document.getElementById("subCur")?.textContent,
  subNext: document.getElementById("subNext")?.textContent,
  subGoal: document.getElementById("subGoal")?.textContent,
  subDest: document.getElementById("subDest")?.textContent,
  subRes: document.getElementById("subRes")?.textContent,
  gWhy: document.getElementById("guideWhy")?.textContent,
})`);
const b = JSON.parse(boot);
check("UI renders drill", b.lines === 3, `title=${b.title} lines=${b.lines}`);
check("subtitle band auto-opens (mode=both)", b.appHidden && !b.subHidden && /^export function add/.test(b.subCur || ""), `cur=${JSON.stringify(b.subCur)}`);
check("subtitle previews the next line too", /return a \+ b/.test(b.subNext || ""), JSON.stringify(b.subNext));
check("subtitle shows the destination file:line", /tp-e2e-dest\.py:12$/.test(b.subDest || ""), JSON.stringify(b.subDest));
check("subtitle shows the step WHY (guided typing)", b.subGoal === "دلیلِ گام اول", JSON.stringify(b.subGoal));
check("subtitle shows the step RESULT (guided typing)", b.subRes === "نتیجه‌ی گام اول", JSON.stringify(b.subRes));
check("panel guide box filled for the current line", b.gWhy === "دلیلِ گام اول", JSON.stringify(b.gWhy));
check("current line highlighted", b.current === "1", `current=${b.current} label=${b.lineNo}`);

/* «⌨» باید پنل کامل را باز کند — تایپ در همان‌جا ادامه دارد */
await js(`document.getElementById("btnPanel").click()`);
await sleep(150);
const lay = JSON.parse(await js(`JSON.stringify({
  app: !document.getElementById("app").classList.contains("hidden"),
  sub: !document.getElementById("sub").classList.contains("hidden"),
})`));
check("⌨ button opens the full panel", lay.app && !lay.sub, JSON.stringify(lay));

/* ---- 2. typing simulation: wrong char then correct ---- */
const first = JSON.parse(await js(`JSON.stringify(P.expected[0])`));
const wrong = await js(`(async () => {
  const first = ${JSON.stringify(first)};
  const t = document.getElementById("typer");
  t.value = first[0] === "e" ? "X" + first.slice(1) : first;
  t.dispatchEvent(new Event("input", { bubbles: true }));
  return JSON.stringify({
    acc: document.getElementById("sAcc").textContent,
    bad: document.querySelectorAll(".expected .bad").length,
    stillLine1: document.getElementById("lineNo").textContent,
  });
})()`);
const w = JSON.parse(wrong);
check("wrong key lowers accuracy", w.acc !== "100%", `acc=${w.acc} badSpans=${w.bad}`);

/* ---- 3. type every line correctly ---- */
const typed = await js(`(() => {
  const t = document.getElementById("typer");
  for (let i = 0; i < P.expected.length; i++) {
    t.value = P.expected[i];
    t.dispatchEvent(new Event("input", { bubbles: true }));
    t.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }
  return JSON.stringify({
    finished: P.finished,
    done: P.done.filter(Boolean).length,
    total: P.expected.length,
    pct: document.getElementById("sPct").textContent,
    lineNo: document.getElementById("lineNo").textContent,
    wpm: document.getElementById("sWpm").textContent,
    gRes: document.getElementById("guideRes")?.textContent,
    gWhyHidden: document.getElementById("guideWhyRow")?.classList.contains("hidden"),
  });
})()`);
const t = JSON.parse(typed);
check("all lines typed", t.finished && t.done === t.total, JSON.stringify(t));
check("progress hits 100%", t.pct === "100%", `pct=${t.pct}`);
check("completion label", /تمام شد|Done/.test(t.lineNo), t.lineNo);
check("guide shows the FINAL RESULT when finished", t.gWhyHidden && t.gRes === "تمرین تمیز تمام شد — add کار می‌کند", JSON.stringify({ gRes: t.gRes, gWhyHidden: t.gWhyHidden }));

await sleep(700);
const st = await api("/api/state");
check("server marks practice complete", st.progress?.practice?.done === true && st.progress?.practice?.matched === st.progress?.total,
  `matched=${st.progress?.practice?.matched}/${st.progress?.total}`);

const notes = await api(`/api/notifications?since=0`);
check("completion notification queued", (notes.notifications || []).some((n) => n.by === "practice" && n.drillId === "e2e-1"),
  JSON.stringify((notes.notifications || []).map((n) => n.by + ":" + n.drillId)));

/* ---- 4. auto-advance + live refresh after new drill ---- */
await api("/api/drill", { id: "e2e-2", title: "تمرین دوم", goal: "هدف دوم", language: "go", mode: "practice", force: true, code: "func main() {}\n" });
await sleep(700);
const after = await js(`JSON.stringify({
  title: document.getElementById("dTitle").textContent,
  lines: document.querySelectorAll("#lines li").length,
  finished: P.finished,
  appHidden: document.getElementById("app").classList.contains("hidden"),
  subHidden: document.getElementById("sub").classList.contains("hidden"),
  goal: document.getElementById("dGoal")?.textContent,
  guideShown: !document.getElementById("guideBox")?.classList.contains("hidden"),
})`);
const a = JSON.parse(after);
check("new drill replaces old", a.title === "تمرین دوم" && a.lines === 1 && a.finished === false, after);
check("practice drill opens the panel (typing inside)", !a.appHidden && a.subHidden, after);
check("drill without guide: box hidden, goal shown", a.guideShown === false && a.goal === "هدف دوم", JSON.stringify({ goal: a.goal, guideShown: a.guideShown }));

/* ---- 4b. real work: queue, lenient match, verify, ack, persistence (API-level) ---- */
await api("/api/reset", { all: true });
await api("/api/drill", { id: "e2e-q1", title: "Q1", language: "text", mode: "practice", code: "aaa\n" });
const q2 = await api("/api/drill", { id: "e2e-q2", title: "Q2", language: "text", mode: "practice", code: "bbb\n" });
check("busy drill queues the newcomer", q2.queued === true && q2.position === 1, JSON.stringify({ queued: q2.queued, position: q2.position }));
await api("/api/complete", { by: "practice" });
await sleep(400);
const qs = await api("/api/state");
check("completion promotes the queued drill", qs.drill && qs.drill.id === "e2e-q2", qs.drill && qs.drill.id);

await api("/api/reset", { all: true });
await api("/api/drill", { id: "e2e-len", title: "LEN", language: "python", mode: "work", matchMode: "lenient", targetFile: "/tmp/tp-e2e-lenient.py", startLine: 1, code: "    indented\n" });
await sleep(300);
(await import("node:fs")).writeFileSync("/tmp/tp-e2e-lenient.py", "indented\n");
await sleep(1000);
const ls = await api("/api/state");
await sleep(600);
const ln = await api("/api/notifications?since=0");
check("lenient whole-file completes", (ln.notifications || []).some((n) => n.by === "file" && n.drillId === "e2e-len"), JSON.stringify((ln.notifications || []).map((n) => n.by + ":" + n.drillId)));

await api("/api/reset", { all: true });
await api("/api/drill", { id: "e2e-ver", title: "VER", language: "text", mode: "work", targetFile: "/tmp/tp-e2e-verify.txt", startLine: 1, code: "hello\n", verify: { command: "true", timeoutSec: 10 } });
(await import("node:fs")).writeFileSync("/tmp/tp-e2e-verify.txt", "hello\n");
await sleep(2500);
const vs = await api("/api/state");
check("finished drill returns to hub", vs.drill === null, JSON.stringify(vs.drill));
const ns = await api("/api/notifications?since=0");
check("completion notification has verify result", (ns.notifications || []).some((n) => n.params && n.params.verify && n.params.verify.ok === true), JSON.stringify((ns.notifications || []).map((n) => n.by + ":" + n.drillId)));
const nids = (ns.notifications || []).map((n) => n.id);
await api("/api/notifications/ack", { ids: nids });
const ns2 = await api("/api/notifications?since=0");
check("acked notifications are filtered", (ns2.notifications || []).length === 0, String((ns2.notifications || []).length));
const persisted = JSON.parse((await import("node:fs")).readFileSync("/Users/hesam/Desktop/teleprompter/app/state-4790.json", "utf8"));
check("hub + history persisted to disk", persisted.drill === null && persisted.history[0] && persisted.history[0].id === "e2e-ver", JSON.stringify({ drill: persisted.drill, hist0: persisted.history[0] }));

/* ---- 4c. admin panel API: system, settings roundtrip, install log ---- */
const sys = await api("/api/admin/system");
check("admin system reports install status", sys.ok === true && sys.install && typeof sys.port === "number" && ["codex", "claude", "gemini", "app", "login"].every((k) => sys.install[k] && typeof sys.install[k].ok === "boolean"), JSON.stringify({ port: sys.port, vscode: sys.install && sys.install.vscode && sys.install.vscode.ok }));
const cfg0 = await api("/api/admin/settings");
check("admin settings readable", cfg0.ok === true && cfg0.settings && cfg0.settings.defaultMatchMode === "exact", JSON.stringify(cfg0.settings));
const cfg1 = await api("/api/admin/settings", { defaultMatchMode: "lenient", queueMax: 7 });
check("admin settings saved", cfg1.ok === true && cfg1.settings.defaultMatchMode === "lenient" && cfg1.settings.queueMax === 7, JSON.stringify(cfg1.settings));
await api("/api/drill", { id: "e2e-deflen", title: "DEFLEN", language: "text", mode: "practice", force: true, code: "zzz\n" });
const ds = await api("/api/state");
check("server default matchMode applies", ds.drill && ds.drill.matchMode === "lenient", ds.drill && ds.drill.matchMode);
await api("/api/admin/settings", { defaultMatchMode: "exact", queueMax: 20 });
const ilog = await api("/api/admin/install/log");
check("install log endpoint answers", ilog.ok === true && typeof ilog.log === "string", String((ilog.log || "").length));
const btns = JSON.parse(await js(`JSON.stringify({ hub: !!document.getElementById("btnOpenAdmin"), drill: !!document.getElementById("btnAdmin") })`));
check("admin buttons exist in hub + drill header", btns.hub === true && btns.drill === true, JSON.stringify(btns));

/* ---- 4d. heartbeat detail: the editor reports what it really sees ---- */
await api("/api/heartbeat", { src: "vscode-test", detail: { drillSeen: true, drillId: "e2e-deflen", targetOpen: false, stateOk: true, err: "" } });
const dt = await api("/api/state");
const det = dt.integrationDetails && dt.integrationDetails["vscode-test"];
check("heartbeat detail visible in state", !!det && det.drillId === "e2e-deflen" && det.drillSeen === true, JSON.stringify(det));

/* ---- 4e. line-anchored notes (chat with the model about a line) ---- */
const nq = await api("/api/notes", { notes: [{ line: 99, text: "note-one" }, { line: 1, text: "  " }, { line: 1, text: "note-two" }] });
check("notes clamped + blanks dropped", nq.ok === true && nq.notes.length === 2 && nq.notes[0].line === 1 && nq.notes[1].line === 1, JSON.stringify(nq.notes));
const nrep = await api("/api/notes", { notes: [{ line: 1, text: "solo" }], replace: true });
check("notes replace", nrep.notes.length === 1 && nrep.notes[0].text === "solo", JSON.stringify(nrep.notes));

/* ---- 4f. mission control: ask queue + read-only file view ---- */
await api("/api/drill", { id: "e2e-ask", title: "ASK", language: "text", mode: "work", force: true, targetFile: "/tmp/tp-e2e-ask.txt", startLine: 1, code: "hello ask\n" });
(await import("node:fs")).writeFileSync("/tmp/tp-e2e-ask.txt", "hello ask\n");
const askBad = await api("/api/ask", {});
check("ask needs text", askBad.error === "text is required", JSON.stringify(askBad));
const ask = await api("/api/ask", { text: "why this line?" });
check("ask queued", ask.ok === true && typeof ask.id === "number", JSON.stringify(ask));
const pend = await api("/api/state");
check("ask visible in snapshot", (pend.askPending || []).length === 1 && pend.askPending[0].text === "why this line?", JSON.stringify(pend.askPending));
const fileView = await fetch(`${BASE}/api/file?path=${encodeURIComponent("/tmp/tp-e2e-ask.txt")}&center=1&context=5`).then((r) => r.json());
check("file view reads the target", fileView.ok === true && fileView.exists === true && fileView.lines[0] === "hello ask", JSON.stringify(fileView));
const fileNo = await fetch(`${BASE}/api/file?path=${encodeURIComponent("/etc/passwd")}`).then((r) => r.json());
check("file view refuses unknown paths", fileNo.error === "unknown file", JSON.stringify(fileNo));
const ackQ = await api("/api/ask/ack", { ids: [ask.id] });
check("ask acked", ackQ.acked === 1, JSON.stringify(ackQ));
const idn = await api("/api/state");
check("instance identity reported", idn.pid > 0 && Number.isFinite(idn.startedAt) && idn.stale === false, JSON.stringify({ pid: idn.pid, stale: idn.stale }));
await api("/api/progress", { editor: { chars: 60 } });
await sleep(3500);
await api("/api/progress", { editor: { chars: 60 } });
const ew = await api("/api/state");
check("editor WPM measured from document changes", ew.progress && ew.progress.editor && ew.progress.editor.chars === 120 && ew.progress.editor.wpm > 0, JSON.stringify(ew.progress && ew.progress.editor));
const sub = JSON.parse(await js(`JSON.stringify({ pos: !!document.getElementById("btnSubPos"), grip: !!document.getElementById("btnSubSize") })`));
check("subtitle has move + resize controls", sub.pos === true && sub.grip === true, JSON.stringify(sub));
await js(`setSubPos("bottom")`);
await sleep(150);
const cls = await js(`document.body.classList.contains("sub-top") === false && localStorage.getItem("tpSubPos")`);
check("subtitle position toggles + persists", cls === "bottom", String(cls));
await js(`setSubPos("top")`);

/* ---- 5. hub (start & settings) + i18n: default English, switchable ---- */
await api("/api/reset", {}); /* body → POST (بدون body می‌شود GET و reset اجرا نمی‌شود) */
await sleep(700);
const hub = JSON.parse(await js(`JSON.stringify({
  shown: !document.getElementById("empty").classList.contains("hidden"),
  appHidden: document.getElementById("app").classList.contains("hidden"),
  lang: document.documentElement.lang,
  dir: document.documentElement.dir,
  title: document.querySelector("#empty h1")?.textContent,
  steps: document.querySelectorAll("#empty .steps li").length,
  conns: document.querySelectorAll("#connList li").length,
})`));
check("reset shows the start & settings hub", hub.shown && hub.appHidden && hub.steps === 4 && hub.conns === 3, JSON.stringify(hub));
check("default language is English (ltr)", hub.lang === "en" && hub.dir === "ltr" && hub.title === "Teleprompter", JSON.stringify(hub));

/* heartbeat → کارت «اتصال‌ها» — idleTick هر۳ثانیه S را تازه و کارت را رندر می‌کند */
const t0 = Date.now();
await api("/api/heartbeat", { src: "vscode" });
await sleep(3600);
const integ = await api("/api/state");
check("heartbeat tracked for the hub", (integ.integrations?.vscode || 0) >= t0, JSON.stringify(integ.integrations || null));
const card = JSON.parse(await js(`(() => { const st = document.querySelector('#connList li[data-conn="vscode"] .st'); return JSON.stringify({ cls: st.className, txt: st.textContent }); })()`));
check("connections card shows Connected", /on/.test(card.cls) && /Connected/.test(card.txt), JSON.stringify(card));

/* سوییچ زبان: فارسی → راست‌به‌چپ + متن‌های ترجمه‌شده */
await js(`document.querySelector('[data-setlang="fa"]').click()`);
await sleep(150);
const fa = JSON.parse(await js(`JSON.stringify({
  lang: document.documentElement.lang,
  dir: document.documentElement.dir,
  title: document.querySelector("#empty h1")?.textContent,
  stored: localStorage.getItem("tpLang"),
})`));
check("language switch to Persian (rtl)", fa.lang === "fa" && fa.dir === "rtl" && fa.title === "تله‌پرامپتر" && fa.stored === "fa", JSON.stringify(fa));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
ws.close();
process.exit(failed.length ? 1 : 0);
