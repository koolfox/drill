#!/usr/bin/env node
/**
 * Teleprompter MCP server (stdio, zero dependencies, Node >= 18).
 *
 * Gives ANY MCP-capable agent (Claude Code, Codex CLI, Gemini CLI, OpenCode,
 * Cursor, ...) the same teleprompter tools the OpenCode plugin exposes:
 *
 *   teleprompter_push    show the user the exact code to type
 *   teleprompter_status  progress / speed / file state
 *   teleprompter_wait    long-poll until the user finishes (for agents that
 *                        cannot receive push notifications)
 *   teleprompter_reset   clear the current drill
 *
 * Claude Code :  claude mcp add teleprompter -- node /path/app/mcp.mjs
 * Codex CLI   :  [mcp_servers.teleprompter] command/args in ~/.codex/config.toml
 * OpenCode    :  opencode mcp add teleprompter -- node /path/app/mcp.mjs
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.TELEPROMPTER_PORT || 4783);
const BASE = `http://127.0.0.1:${PORT}`;
const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_JS = join(HERE, "server.js");
const VERSION = "1.0.0";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------- local server */

async function healthy() {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(700) });
    return res.ok;
  } catch {
    return false;
  }
}

function nodeBinary() {
  if (process.env.TELEPROMPTER_NODE) return process.env.TELEPROMPTER_NODE;
  if (process.execPath && existsSync(process.execPath)) return process.execPath;
  const candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"];
  try {
    const nvm = join(process.env.HOME || "", ".nvm/versions/node");
    if (existsSync(nvm)) {
      for (const v of readdirSync(nvm).sort().reverse()) candidates.push(join(nvm, v, "bin", "node"));
    }
  } catch {
    /* no nvm */
  }
  for (const c of candidates) if (existsSync(c)) return c;
  return "node";
}

async function ensureServer() {
  if (await healthy()) {
    await heartbeat();
    return true;
  }
  if (!existsSync(SERVER_JS)) return false;
  try {
    const child = spawn(nodeBinary(), [SERVER_JS], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    return false;
  }
  for (let i = 0; i < 24; i++) {
    await sleep(250);
    if (await healthy()) {
      await heartbeat();
      return true;
    }
  }
  return false;
}

/* گزارشِ زنده بودنِ MCP — کارت «اتصال‌ها» در صفحه‌ی شروعِ تله‌پرامپتر */
async function heartbeat() {
  try {
    await fetch(`${BASE}/api/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ src: "mcp" }),
      signal: AbortSignal.timeout(700),
    });
  } catch {
    /* سرور بالا نیست — بعداً خودش را می‌گیرد */
  }
}

/* توکنِ محلی (اختیاری): با TELEPROMPTER_TOKEN ست شود تا با سرورِ قفل‌شده حرف بزند */
const TOKEN = String(process.env.TELEPROMPTER_TOKEN || "");
const withToken = (p) => (TOKEN ? p + (p.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(TOKEN) : p);
const authHeaders = { "Content-Type": "application/json" };
if (TOKEN) authHeaders["Authorization"] = `Bearer ${TOKEN}`;

async function get(pathname) {
  const res = await fetch(`${BASE}${withToken(pathname)}`);
  return res.json();
}

async function post(pathname, body) {
  const res = await fetch(`${BASE}${withToken(pathname)}`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify(body ?? {}),
  });
  return res.json();
}

/* ------------------------------------------------------------------ helpers */

function summary(s) {
  if (!s?.drill) return "تمرین فعالی نیست.";
  const total = s.progress?.total || 0;
  const file = s.progress?.file?.matched || 0;
  const prac = s.progress?.practice?.matched || 0;
  const pct = total ? Math.round((Math.max(file, prac) / total) * 100) : 0;
  const wpm = s.progress?.practice?.wpm || 0;
  const exists = s.progress?.file?.exists;
  const dest = s.drill.targetFile ? `${s.drill.targetFile}:${s.drill.startLine || 1}` : "";
  const filePart = s.drill.targetFile
    ? `فایل ${file}/${total}${exists ? "" : " (هنوز ساخته نشده)"} ← ${dest}`
    : "بدون فایل هدف";
  const done = s.progress?.completedBy ? ` · تکمیل شد (${s.progress.completedBy})` : "";
  return (
    `«${s.drill.title}» — پیشرفت ${pct}٪ (${total} خط) · سرعت ${wpm} کلمه/دقیقه · ${filePart}${done}` +
    `\nرابط: ${BASE}/`
  );
}

function text(t, isError = false) {
  return { content: [{ type: "text", text: t }], isError };
}

/* -------------------------------------------------------------------- tools */

const TOOLS = [
  {
    name: "teleprompter_push",
    description:
      "Push a teleprompter typing drill to the user's on-screen teleprompter. Use when the user wants to PRACTICE typing code and/or wants to type the real fix/test THEMSELVES instead of you writing the file. Do not write targetFile yourself afterwards — the user types it while the file is watched. After pushing, call teleprompter_wait (or teleprompter_status later) so you learn when the user finished.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short drill title (Persian is fine)" },
        goal: { type: "string", description: "One sentence: what this code does and why it matters" },
        language: { type: "string", description: "Language, e.g. typescript, python, go" },
        code: { type: "string", description: "The EXACT final code the user will type" },
        targetFile: {
          type: "string",
          description: "Absolute path of the file to watch (real work). Optional for pure practice.",
        },
        startLine: {
          type: "number",
          description:
            "1-based line number in targetFile where this block begins (for edits to existing files). Default 1 = new file / whole file.",
        },
        result: {
          type: "string",
          description: "One sentence: what will be TRUE when the user finishes typing this drill (the outcome).",
        },
        guide: {
          type: "array",
          description:
            "Guided-typing steps (2-5): why each chunk is typed now and what it accomplishes. Shown live beside the current line.",
          items: {
            type: "object",
            properties: {
              from: { type: "number", description: "First line of the chunk (1-based, within code)" },
              to: { type: "number", description: "Last line of the chunk (default = from)" },
              why: { type: "string", description: "Why the user types this chunk right now" },
              result: { type: "string", description: "What this chunk accomplishes once typed" },
            },
            required: ["from", "why"],
          },
        },
        mode: {
          type: "string",
          enum: ["practice", "work", "both"],
          description: "practice = typing only, work = user types into their editor, both = default",
        },
        hints: { type: "array", items: { type: "string" }, description: "Short tips shown above the code" },
        matchMode: {
          type: "string",
          enum: ["exact", "lenient"],
          description: "exact = byte-precise lines (default, teaching); lenient = ignore indentation (real work)",
        },
        verify: {
          type: "object",
          properties: {
            command: { type: "string", description: "Command run after the file completes, e.g. pytest -q" },
            cwd: { type: "string", description: "Working directory (default: target file's directory)" },
            timeoutSec: { type: "number", description: "Cap in seconds (default 60, max 300)" },
          },
          description: "Automatic check after file completion; the result comes back to the session",
        },
        force: {
          type: "boolean",
          description: "Replace the unfinished current drill now; default false = new drill queues",
        },
      },
      required: ["title", "code"],
      additionalProperties: false,
    },
  },
  {
    name: "teleprompter_note",
    description:
      "Attach a line-anchored explanation to the current teleprompter drill. The user types line by line; when they ask about a specific line, call this so your answer appears right on that line in their overlay.",
    inputSchema: {
      type: "object",
      properties: {
        line: { type: "number", description: "1-based line number WITHIN the drill code" },
        text: { type: "string", description: "The explanation (user language is fine) — shown on that line" },
        replace: { type: "boolean", description: "Replace all notes (default false = append)" },
      },
      required: ["line", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "teleprompter_status",
    description: "Current teleprompter drill: progress %, typing speed, target file state, completion flag.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "teleprompter_wait",
    description:
      "Block until the user finishes the current teleprompter drill (typing in the overlay OR writing the watched file), or until the timeout. Returns a summary either way. Call this after teleprompter_push instead of polling. If the user asks a question from the Drill app mid-drill, it returns early with their question — reply, then continue.",
    inputSchema: {
      type: "object",
      properties: {
        timeoutSeconds: { type: "number", description: "5-300, default 60" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "teleprompter_reset",
    description: "Clear the current teleprompter drill and progress.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

async function callTool(name, args) {
  if (!(await ensureServer())) {
    return text(
      `سرور تله‌پرامپتر بالا نیامد. دستی اجرا کن و دوباره تلاش کن:\nnode ${SERVER_JS}`,
      true,
    );
  }

  if (name === "teleprompter_push") {
    const i = args || {};
    if (!i.code || !String(i.code).trim()) return text("code الزامی است", true);
    const id = `drill-${Date.now()}`;
    const result = await post("/api/drill", {
      id,
      title: i.title,
      goal: i.goal || "",
      language: i.language || "text",
      code: i.code,
      targetFile: i.targetFile || null,
      startLine: Math.max(1, Number(i.startLine) || 1),
      result: i.result || "",
      guide: Array.isArray(i.guide) ? i.guide : [],
      matchMode: i.matchMode === "lenient" ? "lenient" : "exact",
      verify: i.verify && i.verify.command ? i.verify : null,
      force: i.force === true,
      mode: ["practice", "work", "both"].includes(i.mode) ? i.mode : "both",
      hints: i.hints || [],
      sessionID: null,
      source: "mcp",
    });
    if (result?.error) return text(`خطا در فرستادن تمرین: ${result.error}`, true);
    const d = result.drill;
    const lines = String(d.code).replace(/\n+$/, "").split("\n").length;
    const dest = d.targetFile ? `${d.targetFile}:${d.startLine || 1}` : "";
    return text(
      `تمرین «${d.title}» (${lines} خط، حالت ${d.mode}) در تله‌پرامپتر نمایش داده شد: ${BASE}/\n` +
        (d.targetFile
          ? `مقصد: \`${dest}\` — روی آن نظارت می‌شود؛ به کاربر بگو در ویرایشگر خودش از همان خط بنویسد.\n`
          : "کاربر در پنجره‌ی تله‌پرامپتر تایپ می‌کند.\n") +
        `حالا teleprompter_wait را صدا بزن تا وقتی تمام شد خبردار شوی.`,
    );
  }

  if (name === "teleprompter_note") {
    const i = args || {};
    if (!i.text || !String(i.text).trim()) return text("text is required", true);
    const res = await post("/api/notes", {
      notes: [{ line: i.line || 1, text: i.text }],
      replace: i.replace === true,
    });
    if (res?.error) return text(`note failed: ${res.error}`, true);
    const at = res.notes && res.notes.length ? res.notes[res.notes.length - 1].line : i.line || 1;
    return text(`Note attached to drill line ${at}; the user now sees it on that line.`);
  }

  if (name === "teleprompter_status") {
    return text(summary(await get("/api/state")));
  }

  if (name === "teleprompter_wait") {
    const timeoutSec = Math.min(300, Math.max(5, Number(args?.timeoutSeconds) || 60));
    const s0 = await get("/api/state");
    if (!s0.drill) {
      /* تمرین ممکن است همین‌تازه تمام و به هاب رفته باشد — خلاصه‌ی پایان را از اعلان بده */
      const n0 = await get(`/api/notifications?since=${Date.now() - timeoutSec * 1000}`).catch(() => null);
      const done = (n0.notifications || []).find((x) => x.by === "file" || x.by === "practice");
      if (done) {
        const p = done.params || {};
        const detail =
          done.by === "file" ? `فایل \`${p.file || ""}\` نوشته شد.` : `تمرین تایپ شد (${p.wpm || 0} WPM · ${p.acc ?? 100}٪ دقت).`;
        return text(`✅ کاربر تمام کرد («${done.title}»).\n${detail}`);
      }
      return text("تمرین فعالی نیست؛ اول teleprompter_push را صدا بزن.");
    }
    if (s0.progress?.completedBy) return text(`از قبل تمام شده بود.\n${summary(s0)}`);

    const since = s0.drill.createdAt || Date.now();
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
      await sleep(1000);
      try {
        const n = await get(`/api/notifications?since=${since}`);
        if (n.notifications?.length) {
          const first = n.notifications[0];
          const s = await get("/api/state");
          return text(`✅ کاربر تمام کرد (${first.by === "file" ? "فایل نوشته شد" : "تمرین تایپ شد"}).\n${summary(s)}`);
        }
        const s = await get("/api/state");
        if (s.progress?.completedBy) return text(`✅ تکمیل شد (${s.progress.completedBy}).\n${summary(s)}`);
        /* اتاق فرمان: اگر کاربر از داخل اپ سؤالی پرسیده، همان را برگردان */
        if (s.askPending?.length) {
          const q = s.askPending[0];
          await post("/api/ask/ack", { ids: [q.id] }).catch(() => {});
          return text(
            `The user asks about this drill (from the Drill app): "${q.text}"\n` +
              `Reply to them in chat, then continue: push the next drill, attach a note, or wait again.`,
          );
        }
      } catch {
        /* server briefly unavailable */
      }
    }
    const s = await get("/api/state").catch(() => null);
    return text(`⏰ timeout بعد از ${timeoutSec} ثانیه — هنوز تمام نشده.\n${summary(s)}`);
  }

  if (name === "teleprompter_reset") {
    await post("/api/reset");
    return text("تمرین فعلی پاک شد.");
  }

  return text(`ابزار ناشناخته: ${name}`, true);
}

/* --------------------------------------------------------------- json-rpc */

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  try {
    if (method === "initialize") {
      return reply(id, {
        protocolVersion: params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "teleprompter", version: VERSION },
        instructions:
          "Teleprompter for code: push a drill with teleprompter_push, then call teleprompter_wait so you are notified when the user finished typing (in the overlay or in their own editor). Do not write the target file yourself while a drill is active.",
      });
    }
    if (method === "notifications/initialized" || method === "notifications/cancelled") return;
    if (method === "ping") return reply(id, {});
    if (method === "tools/list") return reply(id, { tools: TOOLS });
    if (method === "tools/call") {
      const result = await callTool(params?.name, params?.arguments || {});
      return reply(id, result);
    }
    if (isNotification) return;
    replyError(id, -32601, `Method not found: ${method}`);
  } catch (err) {
    if (isNotification) return;
    replyError(id, -32000, String((err && err.message) || err));
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) void handle(line);
  }
});
process.stdin.on("end", () => process.exit(0));
