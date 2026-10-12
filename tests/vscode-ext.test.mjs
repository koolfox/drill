/**
 * Unit test for the VS Code extension's core feature: inline ghost text.
 *
 * Runs the real extension.js against a stubbed `vscode` module and a real
 * (isolated) teleprompter server on port 4790 — no VS Code needed.
 *
 *   node tests/vscode-ext.test.mjs
 */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 4790;
const BASE = `http://127.0.0.1:${PORT}`;
const TARGET = "/tmp/tp-vscode-ext-test.py";
const CODE = ["def parse_config(raw):", "    if raw is None:", "    return {}"].join("\n") + "\n";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  :: " + extra : ""}`);
};

/* ------------------------------------------------- stub the vscode module */

let provider = null;
let statusItem = null;

class Range {
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }
}

const fakeVscode = {
  Range,
  StatusBarAlignment: { Right: 2 },
  Uri: { file: (p) => ({ fsPath: p, scheme: "file" }) },
  Selection: class Selection {
    constructor(anchorLine, anchorChar, activeLine, activeChar) {
      this.anchor = { line: anchorLine, character: anchorChar };
      this.active = { line: activeLine, character: activeChar };
    }
  },
  window: {
    createStatusBarItem: () => {
      statusItem = { text: "", tooltip: "", visible: false, show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} };
      return statusItem;
    },
    showInformationMessage: (..._a) => Promise.resolve(globalThis.__tpChoice),
    showWarningMessage: () => Promise.resolve(undefined),
    showTextDocument: async (doc) => {
      globalThis.__tpShownDoc = doc;
      return doc;
    },
    onDidChangeTextEditorSelection: (cb) => {
      globalThis.__tpSelection = cb;
      return { dispose() {} };
    },
  },
  workspace: {
    textDocuments: [],
    onDidChangeTextDocument: (cb) => {
      globalThis.__tpDocChange = cb;
      return { dispose() {} };
    },
    openTextDocument: async (arg) => {
      const fp = typeof arg === "string" ? arg : arg && arg.fsPath;
      if (globalThis.__tpFiles && globalThis.__tpFiles[fp]) return globalThis.__tpFiles[fp];
      throw new Error("ENOENT: " + fp);
    },
    fs: {
      stat: async (uri) => {
        if (globalThis.__tpFiles && globalThis.__tpFiles[uri.fsPath]) return { type: 1 };
        throw new Error("ENOENT");
      },
      writeFile: async (uri) => {
        globalThis.__tpFiles = globalThis.__tpFiles || {};
        globalThis.__tpFiles[uri.fsPath] = { uri, isUntitled: false };
      },
    },
  },
  languages: {
    registerInlineCompletionItemProvider: (_sel, p) => {
      provider = p;
      return { dispose() {} };
    },
  },
  commands: { registerCommand: () => ({ dispose() {} }) },
};

const Module = require("module");
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "vscode") return fakeVscode;
  return originalLoad.call(this, request, ...rest);
};

/* ----------------------------------------------------- isolated server */

process.env.TELEPROMPTER_PORT = String(PORT);
process.env.TELEPROMPTER_NO_OPEN = "1";

/* ماندگاری: هر اجرا باید از وضعیتِ تمیز شروع کند (نه state باقی‌مانده از قبل) */
try {
  require("fs").rmSync(path.join(here, "..", "app", "state-4790.json"), { force: true });
} catch {}

const server = spawn(process.execPath, [path.join(here, "..", "app", "server.js")], {
  env: { ...process.env },
  stdio: "ignore",
});

async function api(pathname, body) {
  const res = await fetch(BASE + pathname, body
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : undefined);
  return res.json();
}

/* ------------------------------------------------------------- fakes */

const fakeDoc = (fsPath, lines) => ({
  uri: { fsPath },
  lineAt: (i) => {
    const text = lines[i] ?? "";
    return { text, range: { start: { line: i, character: 0 }, end: { line: i, character: text.length } } };
  },
});
const pos = (line, character) => ({ line, character });
const ghostOf = (doc, p) => {
  const r = provider.provideInlineCompletionItems(doc, p);
  if (!r || !r.items || !r.items.length) return null;
  return r.items[0].insertText;
};

try {
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) break;
    } catch {}
    await sleep(250);
  }

  await api("/api/drill", {
    id: "drill-vscode-test",
    title: "تست افزونه VS Code",
    code: CODE,
    targetFile: TARGET,
    mode: "work",
    language: "python",
    startLine: 12,
  });

  const ext = require(path.join(here, "..", "vscode-extension", "extension.js"));
  const context = { subscriptions: [] };
  ext.activate(context);

  /* wait for the first /api/state tick */
  for (let i = 0; i < 40 && (!statusItem || !statusItem.visible); i++) await sleep(100);

  check("activate registered a provider", typeof provider?.provideInlineCompletionItems === "function");
  check("status bar visible", !!statusItem?.visible, statusItem?.text);
  check(
    "status shows FILE progress (not practice %)",
    /0\/3/.test(statusItem?.text || ""),
    statusItem?.text || "",
  );

  /* startLine=12 → خط ۱۲ فایل = خط ۱ تمرین (فایکس باید محتوا را سرِ خط ۱۱ بگذارد) */
  const pad = Array(11).fill("");
  const doc = fakeDoc(TARGET, [...pad, ""]);

  const g0 = ghostOf(doc, pos(11, 0));
  check("ghost = full first line at startLine (file line 12)", g0 === "def parse_config(raw):", JSON.stringify(g0));

  const doc2 = fakeDoc(TARGET, [...pad, "def par", "", ""]);
  const g1 = ghostOf(doc2, pos(11, 7));
  check("ghost shrinks while typing correctly", g1 === "se_config(raw):", JSON.stringify(g1));

  const doc3 = fakeDoc(TARGET, [...pad, "dx", "", ""]);
  check("ghost hidden after a wrong character", ghostOf(doc3, pos(11, 2)) === null);

  const doc4 = fakeDoc("/tmp/some-other-file.py", ["", "", ""]);
  check("ghost hidden in a non-target file", ghostOf(doc4, pos(11, 0)) === null);

  const doc5 = fakeDoc(TARGET, [...pad, "def parse_config(raw):", "", ""]);
  check("ghost hidden when the line is complete", ghostOf(doc5, pos(11, 22)) === null);

  check("no ghost mid-line (cursor not at end)", ghostOf(doc, pos(11, 1)) === null);

  check("no ghost above the destination line", ghostOf(doc, pos(0, 0)) === null);

  const doc6 = fakeDoc(TARGET, [...pad, "def parse_config(raw):", "", ""]);
  const gNext = ghostOf(doc6, pos(12, 0));
  check("ghost moves to the next line (file line 13)", gNext === "    if raw is None:", JSON.stringify(gNext));

  /* progress is read live from the server */
  check("state came from the isolated server", /تست افزونه VS Code/.test(statusItem?.tooltip || ""), statusItem?.tooltip);

  /* مکان‌نما برای سرور فرستاده می‌شود تا نوار زیرنویس با تایپ جلو برود */
  if (typeof globalThis.__tpSelection !== "function") {
    check("selection listener registered", false);
  } else {
    /* خطِ خامِ فایل (۱۲) همان‌طور ثبت می‌شود — رندرر آن را به خطِ تمرین تبدیل می‌کند */
    globalThis.__tpSelection({
      textEditor: { document: { uri: { fsPath: TARGET } }, selection: { active: { line: 12 } } },
    });
    await sleep(500);
    const st = await api("/api/state");
    check("caret line posted to the server", st.progress?.cursor === 12, `cursor=${st.progress?.cursor}`);
    check("heartbeat → hub connections card", !!st.integrations?.vscode, JSON.stringify(st.integrations || null));

    /* بیرون از بلوکِ مقصد (خط ۲ < startLine) چیزی فرستاده نمی‌شود */
    globalThis.__tpSelection({
      textEditor: { document: { uri: { fsPath: TARGET } }, selection: { active: { line: 2 } } },
    });
    await sleep(400);
    const mid = await api("/api/state");
    check("caret ignored above the destination block", mid.progress?.cursor === 12, `cursor=${mid.progress?.cursor}`);

    globalThis.__tpSelection({
      textEditor: { document: { uri: { fsPath: "/tmp/some-other-file.py" } }, selection: { active: { line: 0 } } },
    });
    await sleep(400);
    const st2 = await api("/api/state");
    check("caret ignored outside the target file", st2.progress?.cursor === 12, `cursor=${st2.progress?.cursor}`);

    /* رفتن به مقصد وقتی فایل نیست: بدون تأیید هیچی ساخته نمی‌شود */
    globalThis.__tpFiles = {};
    globalThis.__tpChoice = undefined;
    globalThis.__tpShownDoc = null;
    await api("/api/drill", { id: "vx-goto", title: "GOTO", language: "python", mode: "work", force: true, targetFile: "/tmp/tp-vx-goto-missing.py", code: "x = 1\n" });
    await sleep(2200);
    const gNo = await ext.goToTarget();
    check("goto without confirmation creates nothing", gNo === false && !globalThis.__tpFiles["/tmp/tp-vx-goto-missing.py"], JSON.stringify({ r: gNo, files: Object.keys(globalThis.__tpFiles) }));
    globalThis.__tpChoice = "Create empty file & open";
    const gYes = await ext.goToTarget();
    check(
      "goto with confirmation creates + opens",
      gYes === true && !!globalThis.__tpFiles["/tmp/tp-vx-goto-missing.py"] && !!globalThis.__tpShownDoc,
      JSON.stringify({ r: gYes }),
    );
    /* heartbeat حاملِ گزارش سلامتِ ویرایشگر است (پنل مدیریت نشان می‌دهد) */
    await sleep(5000);
    const hs = await api("/api/state");
    const det = hs.integrationDetails && hs.integrationDetails.vscode;
    check("heartbeat carries editor health detail", !!det && det.drillSeen === true && det.drillId === "vx-goto", JSON.stringify(det));
    /* تغییرِ سند در فایل مقصد → شمارش کاراکتر برای WPM زنده */
    globalThis.__tpDocChange({
      document: { uri: { fsPath: "/tmp/tp-vx-goto-missing.py" } },
      contentChanges: [{ text: "x = " }, { text: "1" }],
    });
    await sleep(600);
    const es = await api("/api/state");
    check("editor keystrokes counted for live WPM", es.progress && es.progress.editor && es.progress.editor.chars >= 5, JSON.stringify(es.progress && es.progress.editor));
  }

  ext.deactivate();
} catch (err) {
  check("no exceptions", false, String(err));
} finally {
  server.kill("SIGKILL");
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
