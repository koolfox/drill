/**
 * Drill for VS Code (and Cursor / Windsurf / vscode-server) —
 * a single plain-JavaScript file: no dependencies, no build step.
 *
 * It talks to the local teleprompter server (127.0.0.1:4783) and provides:
 *
 *   - inline GHOST TEXT at the caret: the exact text you should type next,
 *     shown only while the typed prefix is still correct (dimmed, Copilot-style)
 *     — mapped through drill.startLine, so "file X line 12" means document
 *     line 12 shows drill line 1
 *   - a live status-bar item:  62% · 45wpm  (tooltip: file:line destination)
 *   - CARET REPORTING: every selection change inside the target block posts
 *     {cursor} to the server so the on-screen subtitle band follows your typing
 *   - a HEARTBEAT so the start hub can show "extension connected"
 *   - a notification when the drill finishes (typing or file match)
 *   - commands: Drill: Show Window / Show Status / Reset Drill /
 *     Go to Target Line
 *
 * The editor itself is never written to — the user types the file; the
 * server watches it (fs.watchFile) and reports progress.
 */
"use strict";

const vscode = require("vscode");
const http = require("http");
const path = require("path");

const PORT = Number(process.env.TELEPROMPTER_PORT || 4783);
const BASE = `http://127.0.0.1:${PORT}`;

/* توکنِ محلی (اختیاری): با TELEPROMPTER_TOKEN ست شود تا با سرورِ قفل‌شده حرف بزند */
const TOKEN = String(process.env.TELEPROMPTER_TOKEN || "");
function withToken(pathname) {
  if (!TOKEN) return pathname;
  const sep = pathname.includes("?") ? "&" : "?";
  return pathname + sep + "token=" + encodeURIComponent(TOKEN);
}
function authHeader(headers) {
  const h = Object.assign({}, headers);
  if (TOKEN) h["Authorization"] = "Bearer " + TOKEN;
  return h;
}

let state = null;
let since = Date.now();
let statusItem = null;
const timers = [];

/* ------------------------------------------------------------- http util */

function getJson(pathname) {
  return new Promise((resolve) => {
    const req = http.get(BASE + withToken(pathname), (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (_) {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(800, () => {
      req.destroy();
      resolve(null);
    });
  });
}

function postJson(pathname) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path: withToken(pathname), method: "POST", headers: authHeader({ "Content-Length": 0 }) },
      (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 300);
      },
    );
    req.on("error", () => resolve(false));
    req.setTimeout(1200, () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

/* --------------------------------------------------------------- helpers */

function normPath(p) {
  let s = path.resolve(String(p));
  if (process.platform === "darwin" || process.platform === "win32") s = s.toLowerCase();
  return s;
}

function startLineOf(s) {
  const n = Number(s && s.drill && s.drill.startLine);
  return n > 1 ? Math.trunc(n) : 1;
}

function progressOf(s) {
  if (!s || !s.drill) return null;
  const total = (s.progress && s.progress.total) || 0;
  const file = (s.progress && s.progress.file && s.progress.file.matched) || 0;
  const prac = (s.progress && s.progress.practice && s.progress.practice.matched) || 0;
  const wpm =
    (s.progress && s.progress.practice && s.progress.practice.wpm) ||
    (s.progress && s.progress.editor && s.progress.editor.wpm) ||
    0;
  const done = s.drill.targetFile ? file : prac;
  return {
    pct: total ? Math.round((done / total) * 100) : 0,
    count: `${done}/${total}`,
    wpm,
    completed: Boolean(s.progress.completedBy),
    title: s.drill.title,
    targetFile: s.drill.targetFile || "",
    dest: s.drill.targetFile ? `${s.drill.targetFile}:${startLineOf(s)}` : "",
  };
}

function updateStatus() {
  if (!statusItem) return;
  const p = progressOf(state);
  if (p) {
    /* در حالت «کار واقعی» پیشرفتِ خودِ فایل مهم است، نه درصد تمرین تایپ */
    const body = p.targetFile ? `${p.count} · ${p.wpm}wpm` : `${p.pct}% · ${p.wpm}wpm`;
    statusItem.text = `${p.completed ? "$(check)" : "$(pulse)"} ${body}`;
    statusItem.tooltip = p.targetFile
      ? `Drill — ${p.title} — ${p.dest}`
      : `Drill — ${p.title}`;
    statusItem.show();
  } else {
    statusItem.hide();
  }
}

function expectedLines(s) {
  return String((s && s.drill && s.drill.code) || "")
    .replace(/\n+$/, "")
    .split("\n");
}

/** آیا این سند همان فایلِ مقصدِ تمرین است؟ */
function isTargetDoc(s, document) {
  return Boolean(s && s.drill && s.drill.targetFile && document && document.uri &&
    normPath(document.uri.fsPath) === normPath(s.drill.targetFile));
}

/* ---------------------------------------------- inline ghost at the caret */

const provider = {
  provideInlineCompletionItems(document, position) {
    const s = state;
    if (!isTargetDoc(s, document)) return undefined;

    const lines = expectedLines(s);
    const off = startLineOf(s) - 1; /* خطِ مقصد در فایل (صفر-محور) */
    const rel = position.line - off; /* کدام خطِ تمرین؟ */
    if (rel < 0 || rel >= lines.length) return undefined;

    const line = document.lineAt(position.line);
    const typed = line.text;
    /* only at the end of the text we are typing — never mid-line */
    if (position.character !== typed.length) return undefined;

    const expected = lines[rel];
    if (typed.length >= expected.length) return undefined;
    /* hide the ghost the moment what we typed is wrong (the panel shows the diff) */
    if (expected.slice(0, typed.length) !== typed) return undefined;

    const ghost = expected.slice(typed.length);
    if (!ghost) return undefined;

    return {
      items: [
        {
          insertText: ghost,
          range: new vscode.Range(position, line.range.end),
        },
      ],
    };
  },
};

/* ------------------------------------------- cursor → server (نوار زیرنویس) */
/* مکان‌نما را برای سرور می‌فرستیم تا زیرنویسِ شناور با تایپِ شما در
 * ویرایشگر جلو برود — دقیقاً همان «اسکرولِ حاصل از تایپ». */
let cursorTimer = null;
let lastCursor = -1;
let lastDrillId = null;

function postJsonBody(pathname, obj) {
  const data = JSON.stringify(obj);
  const req = http.request(
    {
      host: "127.0.0.1",
      port: PORT,
      path: withToken(pathname),
      method: "POST",
      headers: authHeader({ "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }),
    },
    (res) => res.resume(),
  );
  req.on("error", () => {});
  req.setTimeout(700, () => req.destroy());
  req.end(data);
}

function watchCursor(context) {
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((e) => {
      const s = state;
      if (!s || !s.drill || !s.drill.targetFile) return;
      if (s.drill.id !== lastDrillId) {
        lastDrillId = s.drill.id;
        lastCursor = -1;
      }
      const ed = e.textEditor;
      if (!ed || !ed.document || !ed.selection) return;
      if (!isTargetDoc(s, ed.document)) return;
      const line = ed.selection.active && ed.selection.active.line;
      if (typeof line !== "number" || line === lastCursor) return;
      /* فقط درون بلوکِ مقصد گزارش می‌دهیم؛ بیرون از آن نوار سر جایش می‌ماند */
      const off = startLineOf(s) - 1;
      const end = off + expectedLines(s).length;
      if (line < off || line >= end) return;
      lastCursor = line;
      clearTimeout(cursorTimer);
      cursorTimer = setTimeout(() => postJsonBody("/api/progress", { cursor: line }), 120);
    }),
  );
  /* سرعتِ تایپ در ویرایشگر (WPM زنده): هر تغییری در فایلِ مقصد شمرده می‌شود */
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      const s = state;
      if (!s || !s.drill || !s.drill.targetFile) return;
      if (!isTargetDoc(s, e.document)) return;
      let chars = 0;
      for (const ch of (e.contentChanges || [])) chars += String((ch && ch.text) || "").length;
      if (chars > 0) postJsonBody("/api/progress", { editor: { chars } });
    }),
  );
}

/* ------------------------------------------- رفتن به خطِ مقصد هنگام تمرین جدید */

function revealTarget(drill) {
  try {
    const docs = (vscode.workspace && vscode.workspace.textDocuments) || [];
    const doc = docs.find((d) => d && !d.isUntitled && d.uri && normPath(d.uri.fsPath) === normPath(drill.targetFile));
    if (!doc) return; /* فایل باز نیست — چیزی را باز نمی‌کنیم (دستور goto هست) */
    const line = Math.max(0, startLineOf({ drill }) - 1);
    const sel = new vscode.Selection(line, 0, line, 0);
    void Promise.resolve(
      vscode.window.showTextDocument(doc, { preserveFocus: true, selection: sel }),
    ).then(undefined, () => {});
  } catch (_) {
    /* بدون فوکوس‌گیری، فقط جابه‌جاییِ دید — خطاها بی‌اثرند */
  }
}

/* -------------------------------------------------------------- lifecycle */

/* رفتن به مقصد: اگر فایل هنوز نیست، با تأییدِ صریحِ خودِ کاربر خالی ساخته و باز می‌شود.
 * تایپ همچنان ۱۰۰٪ با کاربر است — این فقط «باز کردنِ درِ» مقصد است، نه نوشتنِ کد. */
async function goToTarget() {
  const s = state;
  if (!s || !s.drill || !s.drill.targetFile) {
    vscode.window.showInformationMessage("Drill: no drill with a target file.");
    return false;
  }
  const target = s.drill.targetFile;
  const openAt = async (doc) => {
    const line = Math.max(0, startLineOf(s) - 1);
    const sel = new vscode.Selection(line, 0, line, 0);
    await vscode.window.showTextDocument(doc, { preserveFocus: false, selection: sel });
  };
  try {
    const doc = await vscode.workspace.openTextDocument(target);
    await openAt(doc);
    return true;
  } catch (_) {
    /* فایل نیست — بدون تأیید چیزی نمی‌سازیم */
    const choice = await vscode.window.showInformationMessage(
      `Drill: target file does not exist yet: ${target}`,
      "Create empty file & open",
    );
    if (choice !== "Create empty file & open") return false;
    try {
      const uri = vscode.Uri.file(target);
      await vscode.workspace.fs.writeFile(uri, new Uint8Array(0));
      const doc = await vscode.workspace.openTextDocument(uri);
      await openAt(doc);
      return true;
    } catch (e) {
      vscode.window.showWarningMessage(`Drill: could not create target file: ${target}`);
      return false;
    }
  }
}

function activate(context) {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.name = "Drill";
  context.subscriptions.push(statusItem);
  watchCursor(context);

  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider({ scheme: "file" }, provider),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("teleprompter.open", async () => {
      const ok = await postJson("/api/open");
      if (ok) vscode.window.showInformationMessage("Drill: window shown.");
      else
        vscode.window.showWarningMessage(
          "Drill: local server is not running (127.0.0.1:4783).",
        );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("teleprompter.status", () => {
      const p = progressOf(state);
      vscode.window.showInformationMessage(
        p
          ? `Drill — ${p.targetFile ? `${p.count} lines at \`${p.dest}\`` : `${p.pct}%`} · ${p.wpm} WPM — ${p.title}`
          : "Drill: no active drill.",
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("teleprompter.goto", () => void goToTarget()),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("teleprompter.reset", async () => {
      const ok = await postJson("/api/reset");
      if (ok) {
        state = null;
        updateStatus();
        vscode.window.showInformationMessage("Drill: drill cleared.");
      }
    }),
  );

  let tickN = 0;
  let lastStateOk = false;
  let lastErr = "";
  const targetOpenNow = (drill) => {
    try {
      const docs = (vscode.workspace && vscode.workspace.textDocuments) || [];
      return Boolean(
        drill && drill.targetFile &&
        docs.some((d) => d && !d.isUntitled && d.uri && normPath(d.uri.fsPath) === normPath(drill.targetFile)),
      );
    } catch (_) {
      return false;
    }
  };
  const tick = async () => {
    tickN++;
    const prevId = state && state.drill && state.drill.id;
    try {
      state = await getJson("/api/state");
      lastStateOk = !!state;
      lastErr = state ? "" : "empty state";
    } catch (e) {
      lastStateOk = false;
      lastErr = String((e && e.message) || e).slice(0, 120);
      state = null;
    }
    updateStatus();
    const cur = state && state.drill;
    if (cur && cur.id !== prevId) {
      revealTarget(cur);
      /* هدایتِ واقعی در ویرایشگر: اگر مقصد باز نیست، دکمه‌ی رفتن پیشنهاد می‌شود */
      if (cur.targetFile && !targetOpenNow(cur)) {
        try {
          void Promise.resolve(
            vscode.window.showInformationMessage(
              `Drill: "${cur.title}" → ${cur.targetFile}:${cur.startLine || 1}`,
              "Go to target",
            ),
          ).then((c) => {
            if (c === "Go to target") void goToTarget();
          });
        } catch (_) {}
      }
    }
    /* heartbeat با گزارشِ سلامت — پنل مدیریت نشان می‌دهد ویرایشگر واقعاً چه می‌بیند */
    if (tickN === 1 || tickN % 3 === 0) {
      try {
        postJsonBody("/api/heartbeat", {
          src: "vscode",
          detail: {
            drillSeen: Boolean(cur),
            drillId: (cur && cur.id) || "",
            targetOpen: targetOpenNow(cur),
            stateOk: lastStateOk,
            err: lastErr,
          },
        });
      } catch (_) {}
    }
    const res = await getJson(`/api/notifications?since=${since}`);
    if (res && Array.isArray(res.notifications)) {
      for (const n of res.notifications) {
        since = Math.max(since, n.at);
        vscode.window.showInformationMessage(String(n.message || "Drill finished."));
      }
    }
  };
  void tick();
  timers.push(setInterval(() => void tick(), 1500));
  context.subscriptions.push({
    dispose: () => {
      for (const t of timers) clearInterval(t);
      timers.length = 0;
    },
  });
}

function deactivate() {
  for (const t of timers) clearInterval(t);
  timers.length = 0;
}

module.exports = { activate, deactivate, goToTarget };
