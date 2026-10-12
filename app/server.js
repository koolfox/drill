#!/usr/bin/env node
/**
 * Teleprompter local server — zero dependencies (Node >= 18).
 *
 * Serves the overlay UI + JSON/SSE API on 127.0.0.1.
 * The OpenCode plugin pushes drills here; the overlay and the editor
 * file-watcher report progress; completion notifications are queued
 * for the plugin to poll.
 *
 * Endpoints
 *   GET  /                      overlay UI
 *   GET  /api/state             { drill, progress, history }
 *   POST /api/drill             create/replace current drill
 *   POST /api/progress          practice stats from the overlay
 *   POST /api/complete          overlay says the user finished typing
 *   POST /api/reset             clear drill/progress
 *   GET  /api/notifications?since=<ms>   queued completion events
 *   GET  /events                SSE stream (state, drill, done)
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const PORT = Number(process.env.TELEPROMPTER_PORT || 4783);
const HOST = "127.0.0.1";
const PUBLIC = path.join(__dirname, "public");
const OVERLAY = path.join(__dirname, "overlay");
const MAX_BODY = 4 * 1024 * 1024;

/* توکنِ محلی (اختیاری، کار واقعی): اگر TELEPROMPTER_TOKEN ست باشد، همه‌ی
 * ‎/apiها هدر Authorization: Bearer یا ‎?token=‎ می‌خواهند. پیش‌فرض خالی =
 * رفتار قبلی (بدون احراز هویت، فقط لوپ‌بک). */
const TOKEN = String(process.env.TELEPROMPTER_TOKEN || "");
/* فایل ماندگاری — جدا برای هر پورت تا تست (4790) با زنده (4783) قاطی نشود */
const STATE_FILE =
  process.env.TELEPROMPTER_STATE_FILE || path.join(__dirname, `state-${PORT}.json`);

/* هویتِ این نمونه (مدیریت تک‌نمونه‌ای): اگر فایلِ روی دیسک از کدِ در حال اجرا
 * تازه‌تر باشد، یعنی deploy آمده ولی ری‌استارت نه — پلاگین خودش جایگزین می‌کند. */
const START_TIME = Date.now();
const START_MTIME = (() => {
  try {
    return fs.statSync(__filename).mtimeMs;
  } catch (_) {
    return 0;
  }
})();
function codeStale() {
  try {
    return fs.statSync(__filename).mtimeMs !== START_MTIME;
  } catch (_) {
    return false;
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

const state = {
  drill: null,
  progress: null,
  /* صفِ تمرین‌های بعدی (کار واقعیِ چندمرحله‌ای): با تمام شدنِ جاری، بعدی خودکار فعال می‌شود */
  queue: [],
  history: [],
  notifications: [],
  clients: new Set(),
  /* آخرین heartbeat هر سطح اتصال — { opencode: ts, vscode: ts, mcp: ts } */
  integrations: {},
  /* جزئیاتِ سلامتِ هر سطح (اپhemeral — با heartbeat تازه می‌شود): vscode گزارش می‌دهد
   * تمرین را می‌بیند؟ فایل مقصد باز است؟ آخرین خطا چیست؟ (پنل مدیریت نشان می‌دهد) */
  integrationDetails: {},
  seq: 1,
  lastOpen: 0,
};

/* ------------------------------------------------------------------ utils */

const norm = (s) =>
  String(s).replace(/\r\n/g, "\n").split("\n").map((l) => l.replace(/\s+$/, "")).join("\n").replace(/\n+$/, "");

/* مقایسه‌ی سست (کار واقعی): تورفتگی/فاصله‌های دو سر خط نادیده گرفته می‌شود.
 * محتوا باید همان باشد؛ تستِ خودکار (verify) درستی را تأیید می‌کند. */
const loose = (l) => String(l).trim();

const splitLines = (code) => String(code).replace(/\r\n/g, "\n").split("\n");

/** Drill lines ignore trailing blank lines (a file-ending newline is not a typing step). */
function drillLines(code) {
  const a = splitLines(code);
  while (a.length && a[a.length - 1] === "") a.pop();
  return a.length ? a : [""];
}

/* ------------------------------------------------------- persistence (کار واقعی) */

/* ------------------------------------------------------- settings (پنل مدیریت) */

const DEFAULT_SETTINGS = {
  defaultMatchMode: "exact",
  queueMax: 20,
  notifyMax: 100,
  verifyTimeoutSec: 60,
};

function cleanSettings(s) {
  const c = Object.assign({}, DEFAULT_SETTINGS);
  if (!s || typeof s !== "object") return c;
  if (s.defaultMatchMode === "lenient" || s.defaultMatchMode === "exact") c.defaultMatchMode = s.defaultMatchMode;
  if (Number.isFinite(Number(s.queueMax))) c.queueMax = Math.min(100, Math.max(1, Math.trunc(Number(s.queueMax))));
  if (Number.isFinite(Number(s.notifyMax))) c.notifyMax = Math.min(500, Math.max(10, Math.trunc(Number(s.notifyMax))));
  if (Number.isFinite(Number(s.verifyTimeoutSec)))
    c.verifyTimeoutSec = Math.min(300, Math.max(5, Math.trunc(Number(s.verifyTimeoutSec))));
  return c;
}

function settings() {
  if (!state.settings) state.settings = cleanSettings(state.settings);
  return state.settings;
}

let saveTimer = null;
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      saveState();
    } catch (_) {}
  }, 300);
}

function saveState() {
  const data = JSON.stringify({
    drill: state.drill,
    progress: state.progress,
    queue: state.queue,
    history: state.history,
    notifications: state.notifications,
    integrations: state.integrations,
    seq: state.seq,
    settings: state.settings || null,
  });
  try {
    const tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, STATE_FILE);
    try {
      fs.chmodSync(STATE_FILE, 0o600);
    } catch (_) {}
  } catch (_) {}
}

function loadState() {
  let raw = null;
  try {
    raw = fs.readFileSync(STATE_FILE, "utf8");
  } catch (_) {
    return false;
  }
  let s = null;
  try {
    s = JSON.parse(raw);
  } catch (_) {
    return false;
  }
  if (!s || typeof s !== "object") return false;
  try {
    if (s.drill && typeof s.drill.code === "string") {
      state.drill = s.drill;
      state.progress = s.progress && s.progress.drillId === s.drill.id ? s.progress : newProgress(s.drill);
      /* سازگاری با stateهای قدیمیِ ذخیره‌شده (قبل از WPM ویرایشگر) */
      if (state.progress && !state.progress.editor) state.progress.editor = { chars: 0, startedAt: 0, wpm: 0 };
    }
    if (Array.isArray(s.queue)) state.queue = s.queue.filter((d) => d && typeof d.code === "string").slice(0, 20);
    if (Array.isArray(s.history)) state.history = s.history.slice(0, 20);
    if (Array.isArray(s.notifications)) state.notifications = s.notifications.slice(-100);
    if (s.integrations && typeof s.integrations === "object") state.integrations = s.integrations;
    if (Number.isFinite(Number(s.seq))) state.seq = Number(s.seq);
    if (s.settings && typeof s.settings === "object") state.settings = cleanSettings(s.settings);
    return true;
  } catch (_) {
    return false;
  }
}

/* ------------------------------------------------------- auth (کار واقعی) */

function authed(req, url) {
  if (!TOKEN) return true;
  const h = req.headers && req.headers.authorization;
  if (h === `Bearer ${TOKEN}`) return true;
  try {
    if (url.searchParams.get("token") === TOKEN) return true;
  } catch (_) {}
  return false;
}

/* ------------------------------------------------------- queue (کار واقعی) */

/** تمرینِ جاری واقعاً تمام شده؟ هر جریانی که حالت می‌طلبد باید کامل باشد:
 *  - فایل لازم است وقتی targetFile هست و حالت practice نیست
 *  - تمرین لازم است وقتی حالت work نیست */
function progressDone(p) {
  if (!p) return false;
  if (p.completedBy) return true;
  const d = state.drill;
  const needsFile = !!(d && d.targetFile && d.mode !== "practice");
  const needsPractice = !d || d.mode !== "work";
  const fileOk = !needsFile || (p.file && p.total && p.file.matched >= p.total);
  const pracOk = !needsPractice || (p.practice && p.practice.done);
  return !!(fileOk && pracOk);
}

/** ساخت drill تمیز از ورودی (هم برای فعال‌سازی، هم برای صف) */
function buildDrill(body) {
  return {
    id: String(body.id || `drill-${state.seq++}`),
    title: String(body.title || "تمرین تایپ"),
    goal: String(body.goal || ""),
    language: String(body.language || "text"),
    code: body.code.replace(/\r\n/g, "\n"),
    targetFile: body.targetFile ? String(body.targetFile) : null,
    mode: ["practice", "work", "both"].includes(body.mode) ? body.mode : "both",
    /* شماره‌ی خطِ مقصد در فایل (۱-محور): تکه‌ای که باید از همین خط بنشیند */
    startLine: Math.max(1, Number(body.startLine) || 1),
    /* خلاصه‌ی نتیجه‌ی مورد انتظار وقتی تمرین تمام شود (هدایتِ تایپ) */
    result: String(body.result || ""),
    /* هدایتِ هم‌زمان با تایپ: هر ورودی یک گام از کد (خطوط from..to، ۱-محور) */
    guide: Array.isArray(body.guide)
      ? body.guide.slice(0, 40).map((g) => ({
          from: Math.max(1, Number(g && g.from) || 1),
          to: Math.max(1, Number(g && g.to) || Number(g && g.from) || 1),
          why: String((g && g.why) || ""),
          result: String((g && g.result) || ""),
        }))
      : [],
    /* تطبیقِ فایل: exact (آموزشی) یا lenient (کار واقعی) — پیش‌فرض از تنظیمات سرور (پنل مدیریت) */
    matchMode:
      body.matchMode === "lenient" || body.matchMode === "exact" ? body.matchMode : settings().defaultMatchMode,
    /* راستی‌آزماییِ خودکار بعد از تکمیل فایل: { command, cwd?, timeoutSec? } */
    verify:
      body.verify && typeof body.verify.command === "string" && body.verify.command.trim()
        ? {
            command: String(body.verify.command).slice(0, 500),
            cwd: body.verify.cwd ? String(body.verify.cwd).slice(0, 500) : "",
            timeoutSec: Math.min(300, Math.max(5, Number(body.verify.timeoutSec) || settings().verifyTimeoutSec)),
          }
        : null,
    /* یادداشت‌های لنگردار به خط (گفت‌وگو با مدل روی خطِ خاص): [{line, text}] */
    notes: Array.isArray(body.notes)
      ? body.notes
          .slice(0, 60)
          .map((n) => ({
            line: Math.min(Math.max(1, Number(n && n.line) || 1), Math.max(1, drillLines(body.code).length)),
            text: String((n && n.text) || "").slice(0, 1000),
          }))
          .filter((n) => n.text.trim() !== "")
      : [],
    hints: Array.isArray(body.hints) ? body.hints.map(String).slice(0, 20) : [],
    sessionID: body.sessionID ? String(body.sessionID) : null,
    source: String(body.source || "opencode"),
    createdAt: Date.now(),
  };
}

function activateDrill(drill) {
  stopWatch();
  state.drill = drill;
  state.progress = newProgress(drill);
  broadcast("drill", drill);
  broadcast("state", snapshot());
  if (drill.targetFile) startWatch(drill.targetFile);
  openUi(false);
}

/** تمرینِ بعدیِ صف را فعال کن (بعد از اتمامِ جاری) */
function promoteNext() {
  if (!state.queue.length) return null;
  const next = state.queue.shift();
  activateDrill(next);
  return next;
}

/* --------------------------------------------- verify خودکار (کار واقعی) */

function runVerify(drill) {
  return new Promise((resolve) => {
    const v = drill && drill.verify;
    const cmd = v && String(v.command || "").trim();
    if (!cmd) return resolve(null);
    const cwd = (v.cwd && String(v.cwd)) || (drill.targetFile ? path.dirname(drill.targetFile) : __dirname);
    const timeoutMs = Math.min(300000, Math.max(5000, (Number(v.timeoutSec) || 60) * 1000));
    let out = "";
    let child = null;
    try {
      child = spawn(cmd, {
        shell: true,
        cwd,
        timeout: timeoutMs,
        env: Object.assign({}, process.env, {
          TELEPROMPTER_FILE: drill.targetFile || "",
          TELEPROMPTER_DRILL: drill.id || "",
        }),
      });
    } catch (e) {
      return resolve({ ok: false, code: -1, output: String((e && e.message) || e).slice(0, 4000), command: cmd, at: Date.now() });
    }
    if (child.stdout) child.stdout.on("data", (c) => {
      out += c;
      if (out.length > 6000) out = out.slice(-6000);
    });
    if (child.stderr) child.stderr.on("data", (c) => {
      out += c;
      if (out.length > 6000) out = out.slice(-6000);
    });
    child.on("error", (e) =>
      resolve({ ok: false, code: -1, output: String((e && e.message) || e).slice(0, 4000), command: cmd, at: Date.now() }),
    );
    child.on("close", (code) =>
      resolve({ ok: code === 0, code: code == null ? -1 : code, output: out.slice(-4000), command: cmd, at: Date.now() }),
    );
  });
}

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of state.clients) {
    try {
      res.write(msg);
    } catch (_) {
      state.clients.delete(res);
    }
  }
  /* هر تغییرِ وضعیت = ذخیره‌ی تنبل روی دیسک (ماندگاریِ کار واقعی) */
  saveSoon();
}

function snapshot() {
  return {
    drill: state.drill,
    progress: state.progress,
    queue: state.queue,
    queueLen: state.queue.length,
    /* هویتِ نمونه برای مدیریت تک‌نمونه‌ای */
    pid: process.pid,
    startedAt: START_TIME,
    stale: codeStale(),
    /* سؤال‌های بی‌پاسخِ تمرینِ جاری (اتاق فرمان → مدلِ راهنما) */
    askPending: state.drill
      ? (state.asked || []).filter((q) => !q.answered && q.drillId === state.drill.id)
      : [],
    /* گزارشِ سلامتِ هر سطح (از heartbeat می‌آید؛ پنل مدیریت نشان می‌دهد) */
    integrationDetails: state.integrationDetails,
    history: state.history,
    integrations: state.integrations,
    seq: state.seq,
  };
}

function pushNotification(n) {
  state.notifications.push(n);
  const max = settings().notifyMax;
  while (state.notifications.length > max) state.notifications.shift();
  broadcast("done", n);
}

function newProgress(drill) {
  const lines = drillLines(drill.code);
  return {
    drillId: drill.id,
    mode: drill.mode || "both",
    total: lines.length,
    file: { exists: false, states: lines.map(() => false), matched: 0, path: drill.targetFile || null },
    practice: { matched: 0, keys: 0, correct: 0, wpm: 0, done: false },
    /* سرعتِ تایپ در ویرایشگر (WPM زنده برای کار واقعی — از تغییرات سند می‌آید) */
    editor: { chars: 0, startedAt: 0, wpm: 0 },
    completedBy: null,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function bestRatio() {
  const p = state.progress;
  if (!p || !p.total) return 0;
  const file = p.file.matched / p.total;
  const prac = p.practice.matched / p.total;
  return Math.max(file, prac);
}

/* ------------------------------------------------------------- file watch */

let watching = null;

function stopWatch() {
  if (watching) {
    fs.unwatchFile(watching);
    watching = null;
  }
}

function evaluateFile() {
  const drill = state.drill;
  const p = state.progress;
  if (!drill || !p || !drill.targetFile) return;

  let content = null;
  try {
    content = fs.readFileSync(drill.targetFile, "utf8");
  } catch (_) {}

  const expected = drillLines(drill.code);
  const exists = content !== null;
  const start = Math.max(1, Number(drill.startLine) || 1) - 1; /* خطِ مقصد، صفر-محور */
  const actual = exists ? splitLines(content) : [];

  /* دو حالت:
   *  - «تکه‌ای» (startLine > 1 یا فایل از تمرین بلندتر است): هر خط باید دقیقاً
   *    سرِ خطِ مقصدِ خودش بنشیند — یعنی «فایل X، خط Y».
   *  - «کل فایل»: همان جستجوی حریصانه‌ی در-ترتیب (خطوط خالیِ اضافه را تحمل می‌کند). */
  const positional = start > 0 || (exists && actual.length > expected.length);
  const states = expected.map(() => false);
  const lenient = drill.matchMode === "lenient";
  if (exists && positional) {
    for (let i = 0; i < expected.length; i++) {
      const want = expected[i].trimEnd();
      if (want === "") { states[i] = true; continue; }
      const j = start + i;
      /* کار واقعی (lenient): تورفتگی نادیده گرفته می‌شود، محتوا باید همان باشد */
      const same = lenient
        ? j < actual.length && loose(actual[j]) === loose(want)
        : j < actual.length && actual[j].trimEnd() === want;
      if (same) states[i] = true;
    }
  } else if (exists) {
    let cursor = 0;
    for (let i = 0; i < expected.length; i++) {
      const want = expected[i].trimEnd();
      if (want === "") { states[i] = true; continue; }
      for (let j = cursor; j < actual.length; j++) {
        /* کار واقعی (lenient): تورفتگی نادیده گرفته می‌شود، محتوا باید همان باشد */
        const same = lenient
          ? loose(actual[j]) === loose(want)
          : actual[j].trimEnd() === want;
        if (same) {
          states[i] = true;
          cursor = j + 1;
          break;
        }
      }
    }
  }

  p.file = { exists, states, matched: states.filter(Boolean).length, path: drill.targetFile, startLine: start + 1 };
  p.updatedAt = Date.now();

  const wholeSame = lenient
    ? splitLines(content).map(loose).filter((l) => l !== "").join("\n") ===
      splitLines(drill.code).map(loose).filter((l) => l !== "").join("\n")
    : norm(content) === norm(drill.code);
  const done = exists && (positional ? states.every(Boolean) : wholeSame);
  if (done && !p.fileNotified) {
    p.fileNotified = true;
    p.completedBy = p.completedBy || "file";
    broadcast("state", snapshot());
    /* کار واقعی: اول راستی‌آزماییِ خودکار، بعد اعلان (همراه با نتیجه‌ی تست)، بعد مرحله‌ی بعد */
    void (async () => {
      let verification = null;
      try {
        verification = await runVerify(drill);
      } catch (_) {
        verification = null;
      }
      if (verification && state.progress && state.progress.drillId === p.drillId) {
        state.progress.verification = verification;
      }
      pushNotification({
        id: state.seq++,
        drillId: drill.id,
        title: drill.title,
        by: "file",
        at: Date.now(),
        acked: false,
        key: "notify.fileDone",
        params: Object.assign(
          { file: `${drill.targetFile}:${start + 1}`, lines: p.total },
          verification
            ? { verify: { ok: verification.ok, code: verification.code, output: String(verification.output || "").slice(0, 2000) } }
            : null,
        ),
        message:
          `Real work done: \`${drill.targetFile}:${start + 1}\` now matches the teleprompter code (${p.total} lines).` +
          (verification
            ? verification.ok
              ? ` Checks passed (\`${verification.command}\`). Continue the task.`
              : ` BUT checks failed (\`${verification.command}\`, exit ${verification.code}) — inspect the output and guide the user to fix it.`
            : ` Review it (run the tests) and continue the task.`),
      });
      /* صف خالی است؟ کارِ فایل تمام شده (fileDone) پس تمرین به تاریخچه می‌رود و هاب برمی‌گردد */
      if (!promoteNext() && state.drill) {
        state.history.unshift({ id: state.drill.id, title: state.drill.title, finishedAt: Date.now(), ratio: 100 });
        state.history = state.history.slice(0, 20);
        stopWatch();
        state.drill = null;
        state.progress = null;
        broadcast("state", snapshot());
      }
    })();
  }
  broadcast("state", snapshot());
}

function startWatch(file) {
  stopWatch();
  if (!file) return;
  watching = file;
  fs.watchFile(file, { interval: 400 }, () => evaluateFile());
  evaluateFile();
}

/* -------------------------------------------------------------- auto-open */

function findElectron() {
  const electronBins = [
    path.join(OVERLAY, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron"),
    path.join(OVERLAY, "node_modules", "electron", "dist", "electron"),
    path.join(OVERLAY, "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron"),
  ];
  for (const bin of electronBins) {
    try {
      if (fs.existsSync(bin)) return bin;
    } catch (_) {}
  }
  return null;
}

/**
 * Bring the overlay up.
 *   force=false -> on drill push: only when nothing is on screen yet (15s cooldown)
 *   force=true  -> explicit request (TUI /teleprompter open): Electron single-instance
 *                  lock shows/focuses the window, browser fallback skipped if visible.
 */
function openUi(force) {
  if (process.env.TELEPROMPTER_NO_OPEN) return false;
  const now = Date.now();
  if (!force && (state.clients.size > 0 || now - state.lastOpen < 15000)) return false;
  state.lastOpen = now;

  const electron = findElectron();
  if (electron) {
    try {
      spawn(electron, [OVERLAY], { detached: true, stdio: "ignore" }).unref();
      return true;
    } catch (_) {
      /* fall through to browser */
    }
  }

  if (state.clients.size > 0) return false;
  const url = `http://${HOST}:${PORT}/`;
  const opts = { detached: true, stdio: "ignore" };
  try {
    if (process.platform === "darwin") spawn("/usr/bin/open", [url], opts).unref();
    else if (process.platform === "win32") spawn("cmd", ["/c", "start", "", url], opts).unref();
    else spawn("xdg-open", [url], opts).unref();
    return true;
  } catch (_) {
    return false;
  }
}

/* -------------------------------------------------------------- http bits */

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function serveStatic(req, res) {
  let rel = decodeURIComponent(req.url.split("?")[0]);
  if (rel === "/" || rel === "") rel = "/index.html";
  if (rel === "/admin") rel = "/admin.html";
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) return json(res, 403, { error: "forbidden" });
  fs.readFile(file, (err, buf) => {
    if (err) return json(res, 404, { error: "not found" });
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      /* بدون کش تا اوورلی همیشه کدِ تازه‌ی پلاگین را بگیرد (نصب بدون ری‌استارت) */
      "Cache-Control": "no-store",
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const route = url.pathname;

  /* CORS — the overlay/plugin may live on another origin in dev. */
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }

  /* کار واقعی: وقتی TELEPROMPTER_TOKEN ست است، همه‌ی ‎/apiها و ‎/events‎ احراز هویت می‌خواهند */
  if ((route.startsWith("/api/") || route === "/events") && !authed(req, url)) {
    if (route === "/events") {
      res.writeHead(401, { "Content-Type": "text/plain" });
      return res.end("unauthorized");
    }
    return json(res, 401, { error: "unauthorized" });
  }

  try {
    if (route === "/api/state" && req.method === "GET") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      return json(res, 200, snapshot());
    }

    if (route === "/api/notifications" && req.method === "GET") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      const since = Number(url.searchParams.get("since") || 0);
      /* کار واقعی: فقط اعلان‌های تحویل‌نشده — تحویل‌شده‌ها با ack علامت می‌خورند */
      return json(res, 200, {
        notifications: state.notifications.filter((n) => n.at > since && !n.acked),
      });
    }

    /* تأیید تحویل اعلان‌ها — تحویل‌نشده‌ها در پولِ بعدی/ری‌استارت دوباره می‌رسند */
    if (route === "/api/notifications/ack" && req.method === "POST") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      const body = await readBody(req);
      const ids = new Set(Array.isArray(body.ids) ? body.ids.map(Number) : []);
      let acked = 0;
      for (const n of state.notifications) {
        if (ids.has(Number(n.id)) && !n.acked) {
          n.acked = true;
          acked++;
        }
      }
      if (acked) saveSoon();
      return json(res, 200, { ok: true, acked });
    }

    /* یادداشتِ لنگردار به خط (گفت‌وگو با مدل روی خطِ خاص) */
    if (route === "/api/notes" && req.method === "POST") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      if (!state.drill) return json(res, 404, { error: "no drill" });
      const body = await readBody(req).catch(() => ({}));
      const total = Math.max(1, drillLines(state.drill.code).length);
      const incoming = Array.isArray(body.notes) ? body.notes : [];
      const clean = incoming
        .slice(0, 60)
        .map((n) => ({
          line: Math.min(Math.max(1, Number(n && n.line) || 1), total),
          text: String((n && n.text) || "").slice(0, 1000),
        }))
        .filter((n) => n.text.trim() !== "");
      state.drill.notes = body.replace === true ? clean : [...(state.drill.notes || []), ...clean].slice(-60);
      broadcast("drill", state.drill);
      broadcast("state", snapshot());
      return json(res, 200, { ok: true, notes: state.drill.notes });
    }

    /* اتاق فرمان: سؤالِ کاربر از مدلِ راهنما (موقتی، در حافظه نگه داشته می‌شود) */
    if (route === "/api/ask" && req.method === "POST") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      if (!state.drill) return json(res, 400, { error: "no drill" });
      const body = await readBody(req).catch(() => ({}));
      const text = String((body && body.text) || "").trim().slice(0, 2000);
      if (!text) return json(res, 400, { error: "text is required" });
      state.asked = state.asked || [];
      const q = { id: state.seq++, drillId: state.drill.id, drillTitle: state.drill.title, text, at: Date.now(), answered: false };
      state.asked.push(q);
      while (state.asked.length > 20) state.asked.shift();
      broadcast("state", snapshot());
      return json(res, 200, { ok: true, id: q.id, drillId: q.drillId });
    }

    if (route === "/api/ask" && req.method === "GET") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      return json(res, 200, { questions: (state.asked || []).filter((q) => !q.answered) });
    }

    if (route === "/api/ask/ack" && req.method === "POST") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      const body = await readBody(req).catch(() => ({}));
      const ids = new Set(Array.isArray(body.ids) ? body.ids.map(Number) : []);
      let acked = 0;
      for (const q of state.asked || []) {
        if (ids.has(Number(q.id)) && !q.answered) {
          q.answered = true;
          acked++;
        }
      }
      broadcast("state", snapshot());
      return json(res, 200, { ok: true, acked });
    }

    /* نمای فقط-خواندنیِ فایلِ تمرین برای اتاق فرمان (فقط فایل‌های شناخته‌شده‌ی drill/صف) */
    if (route === "/api/file" && req.method === "GET") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      const known = new Set(
        [...(state.queue || []).map((d) => d.targetFile), state.drill && state.drill.targetFile].filter(Boolean),
      );
      const p = String(url.searchParams.get("path") || "");
      if (!p || !known.has(p)) return json(res, 403, { error: "unknown file" });
      let content = null;
      try {
        content = fs.readFileSync(p, "utf8");
      } catch (_) {}
      if (content === null) return json(res, 200, { ok: true, exists: false });
      const lines = splitLines(content);
      const center = Math.max(1, Number(url.searchParams.get("center") || (state.drill && state.drill.startLine) || 1));
      const ctx = Math.min(200, Math.max(5, Number(url.searchParams.get("context") || 40)));
      const from = Math.max(1, center - ctx);
      const to = Math.min(lines.length, center + ctx);
      return json(res, 200, {
        ok: true, exists: true, path: p, total: lines.length, from,
        lines: lines.slice(from - 1, to).map((t) => t.slice(0, 500)),
      });
    }

    if (route === "/api/drill" && req.method === "POST") {
      if (!authed(req, url)) return json(res, 401, { error: "unauthorized" });
      res.setHeader("Access-Control-Allow-Origin", "*");
      const body = await readBody(req);
      if (!body || typeof body.code !== "string" || !body.code.trim()) {
        return json(res, 400, { error: "code is required" });
      }
      const drill = buildDrill(body);
      const busy = state.drill && state.progress && !progressDone(state.progress);
      if (busy && body.force !== true) {
        /* کار واقعی: تمرینِ ناتمامِ جاری هست → تازه‌وارد در صف می‌نشیند، جایگزین نمی‌شود */
        if (state.queue.length >= settings().queueMax) return json(res, 429, { error: "queue full" });
        state.queue.push(drill);
        broadcast("state", snapshot());
        return json(res, 200, { ok: true, queued: true, position: state.queue.length, drill });
      }
      if (state.drill) {
        state.history.unshift({
          id: state.drill.id,
          title: state.drill.title,
          finishedAt: Date.now(),
          ratio: Math.round(bestRatio() * 100),
        });
        state.history = state.history.slice(0, 20);
      }
      activateDrill(drill);
      return json(res, 200, { ok: true, drill });
    }

    if (route === "/api/progress" && req.method === "POST") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      const body = await readBody(req);
      let changed = false;
      /* مکان‌نما در ویرایشگر: نوار زیرنویس را با تایپِ شما جلو می‌برد */
      if (state.progress && body.cursor != null && Number.isFinite(Number(body.cursor))) {
        state.progress.cursor = Math.max(0, Math.trunc(Number(body.cursor)));
        state.progress.cursorAt = Date.now();
        state.progress.updatedAt = Date.now();
        changed = true;
      }
      /* سرعتِ تایپ در ویرایشگر: کاراکترهای تغییرِ سند انباشته و WPM زنده حساب می‌شود */
      if (state.progress && body.editor && Number.isFinite(Number(body.editor.chars))) {
        const ed = state.progress.editor || (state.progress.editor = { chars: 0, startedAt: 0, wpm: 0 });
        ed.chars += Math.max(0, Math.trunc(Number(body.editor.chars)));
        const now = Date.now();
        if (!ed.startedAt) ed.startedAt = now;
        const elapsedSec = (now - ed.startedAt) / 1000;
        if (elapsedSec >= 3) ed.wpm = Math.min(250, Math.round((ed.chars / 5 / (elapsedSec / 60))));
        state.progress.updatedAt = now;
        changed = true;
      }
      if (state.progress && body.practice) {
        const p = state.progress.practice;
        p.matched = Number(body.practice.matched) || 0;
        p.keys = Number(body.practice.keys) || 0;
        p.correct = Number(body.practice.correct) || 0;
        p.wpm = Number(body.practice.wpm) || 0;
        if (body.practice.done) p.done = true;
        state.progress.updatedAt = Date.now();
        changed = true;
      }
      if (changed) broadcast("state", snapshot());
      return json(res, 200, { ok: true, ratio: bestRatio() });
    }

    if (route === "/api/complete" && req.method === "POST") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      const body = await readBody(req);
      if (!state.drill || !state.progress) return json(res, 404, { error: "no drill" });
      const by = body.by === "file" ? "file" : "practice";
      if (by === "practice") {
        Object.assign(state.progress.practice, {
          matched: state.progress.total,
          done: true,
          wpm: Number(body.wpm) || state.progress.practice.wpm,
        });
      }
      if (!state.progress.completedBy) state.progress.completedBy = by;
      const key = `notify_${by}`;
      if (!state.progress[key]) {
        state.progress[key] = true;
        const pr = state.progress.practice;
        const accPct = pr.keys ? Math.round((pr.correct / pr.keys) * 100) : 100;
        const n = {
          id: state.seq++,
          drillId: state.drill.id,
          title: state.drill.title,
          by,
          at: Date.now(),
          acked: false,
          key: by === "file" ? "notify.fileDone" : "notify.practiceDone",
          params:
            by === "file"
              ? { file: `${state.drill.targetFile}:${state.drill.startLine || 1}`, lines: state.progress.total }
              : {
                  wpm: state.progress.practice.wpm,
                  acc: accPct,
                  file: state.drill.targetFile ? `${state.drill.targetFile}:${state.drill.startLine || 1}` : "",
                },
          message:
            by === "file"
              ? `Real work done: \`${state.drill.targetFile}:${state.drill.startLine || 1}\` matches the teleprompter code (${state.progress.total} lines). Review it (run the tests) and continue.`
              : `Typing drill finished: "${state.drill.title}" — ${state.progress.practice.wpm} WPM · ${accPct}% accuracy. ` +
                (state.drill.targetFile
                  ? `If this was real work, the same code still has to go into \`${state.drill.targetFile}:${state.drill.startLine || 1}\`.`
                  : "No target file was set."),
        };
        pushNotification(n);
        /* کار واقعی: verifyِ اجرا-نشده را ناهمگام اجرا و نتیجه را به همان اعلان بچسبان */
        if (by === "file" && state.drill.verify && !state.progress.verification) {
          const drillId = state.drill.id;
          void runVerify(state.drill).then((v) => {
            if (!v) return;
            if (state.progress && state.progress.drillId === drillId) state.progress.verification = v;
            n.params.verify = { ok: v.ok, code: v.code, output: String(v.output || "").slice(0, 2000) };
            n.message += v.ok ? ` Checks passed (\`${v.command}\`).` : ` BUT checks failed (\`${v.command}\`, exit ${v.code}).`;
            broadcast("state", snapshot());
          });
        }
      }
      /* مرحله‌ی بعدِ صف فقط وقتی فعال می‌شود که همین تمرین واقعاً تمام شده باشد */
      if (progressDone(state.progress)) {
        const nx = promoteNext();
        /* به هاب فقط وقتی برمی‌گردیم که کارِ فایل معطل نمانده باشد (تمرینِ تایپِ تنها،
         * یا فایلی که نوشته شده). وگرنه تمرین برای اتمامِ فایل می‌ماند. */
        const d = state.drill, p = state.progress;
        const filePending =
          d && p && d.targetFile && d.mode !== "practice" &&
          !(p.file && p.total && p.file.matched >= p.total) && p.completedBy !== "file";
        if (!nx && d && !filePending) {
          state.history.unshift({ id: d.id, title: d.title, finishedAt: Date.now(), ratio: 100 });
          state.history = state.history.slice(0, 20);
          stopWatch();
          state.drill = null;
          state.progress = null;
          broadcast("state", snapshot());
        }
      } else broadcast("state", snapshot());
      return json(res, 200, { ok: true, ratio: bestRatio() });
    }

    /* heartbeat: کدام سطح‌ها زنده‌اند؟ (کارت «اتصال‌ها» در صفحه‌ی شروع) */ 
    if (route === "/api/heartbeat" && req.method === "POST") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      const body = await readBody(req);
      const src = String(body.src || "").replace(/[^\w.-]/g, "").slice(0, 24);
      if (src) {
        state.integrations[src] = Date.now();
        /* گزارشِ سلامتِ سطح (اختیاری): پنل مدیریت نشان می‌دهد آن‌طرف واقعاً چه می‌بیند */
        const dt = body.detail && typeof body.detail === "object" ? body.detail : null;
        if (dt) {
          state.integrationDetails[src] = {
            at: Date.now(),
            drillSeen: dt.drillSeen === true,
            drillId: String(dt.drillId || "").slice(0, 80),
            targetOpen: dt.targetOpen === true,
            stateOk: dt.stateOk !== false,
            err: String(dt.err || "").slice(0, 160),
          };
        }
      }
      /* عمداً broadcast نمی‌شود — صفحه‌ی شروع خودش وضعیت را می‌خواند */
      return json(res, 200, { ok: true });
    }

    if (route === "/api/open" && req.method === "POST") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      const opened = openUi(true);
      return json(res, 200, { ok: opened, clients: state.clients.size });
    }

    /* باز کردن پنل مدیریت در مرورگر (از هاب و هدر تمرین) */
    if (route === "/api/admin/open" && req.method === "POST") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      const url = `http://${HOST}:${PORT}/admin`;
      try {
        const opts = { detached: true, stdio: "ignore" };
        if (process.platform === "darwin") spawn("/usr/bin/open", [url], opts).unref();
        else if (process.platform === "win32") spawn("cmd", ["/c", "start", "", url], opts).unref();
        else spawn("xdg-open", [url], opts).unref();
        return json(res, 200, { ok: true, url });
      } catch (e) {
        return json(res, 500, { error: String((e && e.message) || e), url });
      }
    }

    if (route === "/api/reset" && req.method === "POST") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      const body = await readBody(req).catch(() => ({}));
      stopWatch();
      state.drill = null;
      state.progress = null;
      /* کار واقعی: reset یعنی رد شدن از تمرینِ جاری — اگر صف هست، بعدی فعال می‌شود.
       * با ‎{all:true}‎ هم جاری و هم صف پاک می‌شود. */
      let cleared = 0;
      let next = null;
      if (body && body.all === true) {
        cleared = state.queue.length;
        state.queue = [];
      } else if (state.queue.length) {
        next = promoteNext();
      }
      if (!next) broadcast("state", snapshot());
      return json(res, 200, { ok: true, promoted: next ? next.id : null, cleared });
    }

    /* پرشِ دستی به مرحله‌ی بعدِ صف (حتی اگر جاری ناتمام است) */
    if (route === "/api/next" && req.method === "POST") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      if (!state.queue.length) return json(res, 200, { ok: true, drill: null });
      const next = promoteNext();
      return json(res, 200, { ok: true, drill: next });
    }

    /* خالی کردنِ صفِ تمرین‌ها */
    if (route === "/api/queue/clear" && req.method === "POST") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      const n = state.queue.length;
      state.queue = [];
      broadcast("state", snapshot());
      return json(res, 200, { ok: true, cleared: n });
    }

    /* ---------------- پنل مدیریتی وب (/admin) ---------------- */

    if (route === "/api/admin/system" && req.method === "GET") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      const home = process.env.HOME || "";
      const exists = (p) => {
        try {
          return fs.existsSync(p);
        } catch (_) {
          return false;
        }
      };
      const fsize = (p) => {
        try {
          return fs.statSync(p).size;
        } catch (_) {
          return 0;
        }
      };
      const pluginDir = path.join(home, ".config", "opencode", "plugins", "teleprompter");
      const vscodeExt = path.join(home, ".vscode", "extensions", "teleprompter-1.0.0", "extension.js");
      const electronBin = path.join(
        OVERLAY, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron",
      );
      const cands = [path.join(__dirname, "..", "install.sh")];
      if (home) cands.push(path.join(home, "Desktop", "teleprompter", "install.sh"));
      let installSh = "";
      for (const c of cands) {
        try {
          if (fs.existsSync(c)) {
            installSh = c;
            break;
          }
        } catch (_) {}
      }
      return json(res, 200, {
        ok: true,
        platform: process.platform,
        node: process.version,
        uptimeSec: Math.round(process.uptime()),
        port: PORT,
        tokenSet: TOKEN !== "",
        stateFile: { path: STATE_FILE, exists: exists(STATE_FILE), size: fsize(STATE_FILE) },
        install: (() => {
          const hit = (f, s) => {
            try {
              return fs.readFileSync(f, "utf8").includes(s);
            } catch (_) {
              return false;
            }
          };
          const appP =
            process.platform === "darwin"
              ? path.join(home, "Applications", "Drill.app")
              : "";
          const sysAppP = process.platform === "darwin" ? "/Applications/Drill.app" : "";
          const appFound = [sysAppP, appP].find((p) => p && exists(path.join(p, "Contents", "Resources", "app", "overlay", "main.js"))) || "";
          return {
            plugin: { path: pluginDir, ok: exists(path.join(pluginDir, "index.ts")) },
            vscode: { path: vscodeExt, ok: exists(vscodeExt) },
            electron: { path: electronBin, ok: exists(electronBin) },
            installSh: { path: installSh, ok: installSh !== "" },
            codex: { path: path.join(home, ".codex", "config.toml"), ok: hit(path.join(home, ".codex", "config.toml"), "[mcp_servers.teleprompter") },
            claude: { path: path.join(home, ".claude.json"), ok: hit(path.join(home, ".claude.json"), '"teleprompter"') },
            gemini: { path: path.join(home, ".muse", "settings.json"), ok: hit(path.join(home, ".muse", "settings.json"), '"teleprompter"') },
            app: { path: appFound || sysAppP || appP, ok: appFound !== "" },
            login: { path: path.join(home, "Library", "LaunchAgents", "pro.hoosh.drill.plist"), ok: exists(path.join(home, "Library", "LaunchAgents", "pro.hoosh.drill.plist")) },
          };
        })(),
        live: {
          drill: state.drill ? { id: state.drill.id, title: state.drill.title } : null,
          queueLen: state.queue.length,
          unacked: state.notifications.filter((n) => !n.acked).length,
          integrations: state.integrations,
        },
      });
    }

    if (route === "/api/admin/settings" && req.method === "GET") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      return json(res, 200, { ok: true, settings: settings() });
    }

    if (route === "/api/admin/settings" && req.method === "POST") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      const body = await readBody(req).catch(() => ({}));
      state.settings = cleanSettings(Object.assign({}, settings(), body));
      saveSoon();
      return json(res, 200, { ok: true, settings: settings() });
    }

    if (route === "/api/admin/install" && req.method === "POST") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      const body = await readBody(req).catch(() => ({}));
      const rawT = body && typeof body.target === "string" ? body.target : "all";
      const allowed = ["all", "opencode", "vscode", "codex", "claude", "gemini", "app", "login"];
      if (!allowed.includes(rawT)) return json(res, 400, { error: "unknown target" });
      const cands = [path.join(__dirname, "..", "install.sh")];
      if (process.env.HOME) cands.push(path.join(process.env.HOME, "Desktop", "teleprompter", "install.sh"));
      let sh = "";
      for (const c of cands) {
        try {
          if (fs.existsSync(c)) {
            sh = c;
            break;
          }
        } catch (_) {}
      }
      if (!sh) return json(res, 404, { error: "install.sh not found" });
      try {
        const log = path.join(__dirname, `install-${PORT}.log`);
        try {
          fs.appendFileSync(log, `\n=== install${rawT === "all" ? "" : " [" + rawT + "]"} started ${new Date().toISOString()} (${sh}) ===\n`);
        } catch (_) {}
        const out = fs.openSync(log, "a");
        const args = rawT === "all" ? [sh] : [sh, "--only", rawT];
        const child = spawn("bash", args, { detached: true, stdio: ["ignore", out, out] });
        child.unref();
        return json(res, 200, { ok: true, started: true, target: rawT });
      } catch (e) {
        return json(res, 500, { error: String((e && e.message) || e) });
      }
    }

    if (route === "/api/admin/install/log" && req.method === "GET") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      let txt = "";
      try {
        txt = fs.readFileSync(path.join(__dirname, `install-${PORT}.log`), "utf8").slice(-8000);
      } catch (_) {}
      return json(res, 200, { ok: true, log: txt });
    }

    if (route === "/events" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
      state.clients.add(res);
      const ping = setInterval(() => {
        try {
          res.write(": ping\n\n");
        } catch (_) {}
      }, 15000);
      req.on("close", () => {
        clearInterval(ping);
        state.clients.delete(res);
      });
      return;
    }

    /* خاموش کردنِ خود برای جایگزینی با کد تازه (پلاگین وقتی stale می‌بیند صدا می‌زند) */
    if (route === "/api/shutdown" && req.method === "POST") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      const body = await readBody(req).catch(() => ({}));
      if (!body || body.confirm !== true) return json(res, 400, { error: "confirm required" });
      json(res, 200, { ok: true, pid: process.pid });
      setTimeout(() => process.exit(0), 150);
      return;
    }

    if (route === "/health") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      return json(res, 200, {
        ok: true,
        clients: state.clients.size,
        pid: process.pid,
        startedAt: START_TIME,
        stale: codeStale(),
      });
    }

    if (req.method === "GET") return serveStatic(req, res);
    return json(res, 404, { error: "not found" });
  } catch (e) {
    return json(res, 500, { error: String((e && e.message) || e) });
  }
});

/* کار واقعی: بازیابیِ تمرین/صف/اعلان‌ها از دیسک، بعد شروعِ گوش دادن */
loadState();
if (state.drill && state.drill.targetFile) startWatch(state.drill.targetFile);

server.listen(PORT, HOST, () => {
  console.log(`[teleprompter] http://${HOST}:${PORT}/`);
  if (state.drill) console.log(`[teleprompter] restored drill ${state.drill.id} (queue: ${state.queue.length})`);
});

process.on("SIGINT", () => {
  stopWatch();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stopWatch();
  process.exit(0);
});
