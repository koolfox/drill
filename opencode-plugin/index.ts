/**
 * OpenCode teleprompter plugin
 * ----------------------------
 * Turns OpenCode into a "teleprompter" for code:
 *
 *   /drill <task>        asks the agent to build a typing drill for you
 *   teleprompter_push    the agent pushes the exact code you should type
 *   teleprompter_status  read the current progress
 *
 * The plugin hosts nothing itself: it starts app/server.js (zero-dep Node
 * server) if it is not already running, pushes drills to it, and polls the
 * completion queue so the session gets a synthetic message when you finish
 * typing (in the overlay or in your own editor).
 */
import type { Plugin } from "@opencode/plugin";
import { spawn } from "child_process";
import { appendFileSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";

const PORT = Number(process.env.TELEPROMPTER_PORT || 4783);
const BASE = `http://127.0.0.1:${PORT}`;

const DRILL_GUIDE = `You are running with the **teleprompter** plugin. The user wants a teleprompter
typing drill: code they will TYPE THEMSELVES — as typing practice and/or as the real change —
while the plugin watches the target file and reports progress back to you.

Rules:
1. Do the real investigation first (read files, decide the fix/test), but DO NOT write the
   target file yourself — the user types it. Reading is fine; writing the target file is not.
2. Produce the FINAL content the user should type, and say exactly WHERE it goes:
   - Editing an existing file -> set \`targetFile\` AND \`startLine\` = the 1-based line where
     the block begins; \`code\` must be exactly the lines that belong there (the watcher
     verifies them in place and completes when they all sit at file:startLine).
   - Creating a new file -> \`targetFile\` only (startLine defaults to 1), code = full file.
   - Pure practice (no target file): a compact, self-contained snippet of ~10-60 lines.
3. \`goal\` carries the OVERALL REASON (why this change matters / what it teaches) — the
   on-screen subtitle band shows it right above the code, so the user understands while typing.
4. GUIDE the typing — this is the point of the product: you coordinate the USER like an agent,
   so they type knowing the place, the purpose and the outcome:
   - \`result\` (one sentence): what will be TRUE when the drill is finished.
   - \`guide\` (2-5 entries): split the code into logical chunks; for each give
      \`from\`/\`to\` (1-based line numbers WITHIN \`code\`), \`why\` (why they type this now)
      and \`result\` (what this chunk accomplishes). The UI shows WHY/RESULT live beside the
      current line — in the panel and in the subtitle band.
5. Call the tool \`teleprompter_push\` with: title (Persian), goal (one Persian sentence),
   language, code, targetFile (absolute path, optional), startLine (optional number),
   mode, result, guide, and optional hints:
     mode "practice" -> typing practice only
     mode "work"     -> real change the user types into their own editor
     mode "both"     -> both at once (default)
6. Answer briefly in Persian: what the drill is, WHERE to type it (file:line), and WHY —
   then say you will be notified when it is done.
7. When the plugin notifies you that the drill completed: verify the result (read the file,
   run the tests) and continue the task. Give one short line of feedback on their typing
   (speed/accuracy) to reinforce learning. If only practice finished and the file was not
   written, ask the user whether you should apply the change yourself.
Keep each drill under ~120 lines; split bigger work into several sequential drills.
   Push all steps up front: while one drill is unfinished, new pushes QUEUE automatically
   (nothing is lost) and each step activates when the previous finishes — one
   \`targetFile\` per step. Pass force:true only to replace the current drill right now.
   For real work set matchMode:"lenient" (indentation-insensitive file matching) and
   verify:{command} (e.g. pytest -q, run in the target file's directory by default) so
   checks run automatically on completion and their result comes back to this session.
   ASK BOX (mission control): the user may also ask you from inside the Drill app
   (it arrives framed as their question about the current drill). Answer it, then
   continue with a drill or a note — that is the in-app conversation loop.
   LINE-ANCHORED CHAT (annotating): the user types line by line and may ask about a
   specific line ("explain line 3", "make line 5 cleaner"). When they do:
   - Answer in chat, quoting the line.
   - ALSO call teleprompter_note with that 1-based line number and a 1-2 sentence
     explanation/improvement, so it appears right on the line in their overlay
     while they type it. Proactively annotate the 1-2 trickiest lines of every
     drill the same way. Keep notes short; the code itself stays the teacher.
   BASICS MODE: when the user is learning from zero (or says "teach me"),
   keep every line short, attach a teleprompter_note to every line, use
   matchMode lenient, and celebrate each completion in one short line.`;

const TOUR_GUIDE = `You are giving a newcomer (onboarding to this repo, or a junior
learning from zero) a GUIDED TYPING TOUR. They TYPE everything themselves in
their own editor; you coordinate them file by file, like a senior sitting next
to them.
Rules:
1. Map the repo first: README, project files, top-level layout. Pick the 3-6
   files that explain the system (entry point, core logic, config, one test).
2. Per stop, push ONE drill (teleprompter_push, mode work): targetFile AND
   startLine = the exact region; code = exactly those lines (a small, real,
   meaningful chunk); goal = what this file/region does; guide = why + outcome
   per chunk; result = what works afterwards.
3. Order stops so each builds on the last; push all steps up front (they queue).
   Keep each drill under ~40 lines.
4. BASICS MODE (young learners / first contact): short lines, a
   teleprompter_note on EVERY line, matchMode lenient, one line of
   encouragement per completion. Never skip the why.
5. On each completion notice: verify (read the file, run the relevant test),
   then bridge to the next stop in one sentence.`;

let lastSessionID: string | undefined;
const drillSessions = new Map<string, string>();
let lastNotifiedAt = Date.now();
let serverTried = false;

async function healthy(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(700) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Locate app/server.js. `ctx.location.directory` is the *project* directory, so
 * the install location is resolved from this module first, then from the usual
 * OpenCode config roots.
 */
function findServer(directory: string): string | null {
  const roots: string[] = [];
  try {
    roots.push(join(fileURLToPath(new URL(".", import.meta.url)), "app"));
  } catch {
    /* import.meta unavailable — fall through */
  }
  const home = process.env.HOME || "";
  const xdg = process.env.XDG_CONFIG_HOME;
  if (process.env.OPENCODE_HOME) roots.push(join(process.env.OPENCODE_HOME, "plugins/teleprompter/app"));
  roots.push(join(xdg || join(home, ".config"), "opencode/plugins/teleprompter/app"));
  roots.push(join(directory, "app"));
  roots.push(join(directory, "plugins/teleprompter/app"));

  for (const root of roots) {
    try {
      const candidate = join(root, "server.js");
      if (existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** The OpenCode service may run with a minimal PATH (nvm node is invisible), so
 *  resolve a JS runtime explicitly instead of trusting `spawn("node", ...)`. */
function nodeBinary(): string {
  if (process.env.TELEPROMPTER_NODE) return process.env.TELEPROMPTER_NODE;
  const candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"];
  try {
    const nvm = join(process.env.HOME || "", ".nvm/versions/node");
    if (existsSync(nvm)) {
      const versions = readdirSync(nvm).sort();
      for (let i = versions.length - 1; i >= 0; i--) candidates.push(join(nvm, versions[i], "bin", "node"));
    }
  } catch {
    /* no nvm */
  }
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  try {
    if (process.execPath && existsSync(process.execPath)) return process.execPath;
  } catch {
    /* ignore */
  }
  return "node";
}

async function ensureServer(directory: string): Promise<boolean> {
  if (await healthy()) {
    /* سرورِ سالم ولی کهنه (deploy بدون ری‌استارت) را خودمان جایگزین می‌کنیم */
    try {
      const st = await get("/api/state").catch(() => null);
      if (st && (st as { stale?: boolean }).stale) {
        await post("/api/shutdown", { confirm: true }).catch(() => {});
        await new Promise((r) => setTimeout(r, 400));
      } else {
        return true;
      }
    } catch {
      return true;
    }
  }
  const server = findServer(directory);
  const bin = nodeBinary();
  const debug = (msg: string) => {
    try {
      appendFileSync(join(tmpdir(), "opencode-teleprompter.log"), `${new Date().toISOString()} ${msg}\n`);
    } catch {
      /* ignore */
    }
  };
  if (!server) {
    debug("server.js not found");
    return false;
  }
  debug(`spawning ${bin} ${server}`);
  try {
    const child = spawn(bin, [server], { detached: true, stdio: "ignore" });
    child.on("error", (err) => debug(`spawn error: ${String(err)}`));
    child.on("exit", (code, signal) => debug(`child exit code=${code} signal=${signal}`));
    child.unref();
  } catch (err) {
    debug(`spawn threw: ${String(err)}`);
    return false;
  }
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await healthy()) {
      debug("healthy");
      return true;
    }
  }
  debug("health check timed out");
  return false;
}

/* توکنِ محلی (اختیاری): با TELEPROMPTER_TOKEN ست شود تا همه‌ی فراخوانی‌ها احراز هویت شوند */
const TOKEN = String(process.env.TELEPROMPTER_TOKEN || "");
const authHeaders: Record<string, string> = { "Content-Type": "application/json" };
if (TOKEN) authHeaders["Authorization"] = `Bearer ${TOKEN}`;
const withToken = (p: string) => (TOKEN ? p + (p.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(TOKEN) : p);

async function post(pathname: string, body: unknown, signal?: AbortSignal) {
  const res = await fetch(`${BASE}${withToken(pathname)}`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify(body),
    signal,
  });
  return res.json();
}

async function get(pathname: string) {
  const res = await fetch(`${BASE}${withToken(pathname)}`);
  return res.json();
}

const plugin: Plugin.Plugin = {
  id: "teleprompter",
  async setup(ctx) {
    const directory = ctx.location.directory;

    /* remember which session asked for the drill, so completion lands there */
    await ctx.session.hook("prompt", (event) => {
      lastSessionID = event.sessionID;
    });

    /* ---------------- tools ---------------- */
    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "teleprompter",
        description:
          "On-screen coding teleprompter: show the user the exact code to type (practice and/or real work) and watch the target file until they finish.",
      });

      editor.add({
        name: "push",
        description:
          "Push a teleprompter drill: code the user will type themselves (typing practice and/or the real fix/test). The code appears in an on-screen teleprompter overlay; if targetFile is given the file is watched until the user writes it, then this session is notified.",
        input: {
          type: "object",
          properties: {
            title: { type: "string", description: "Short drill title (shown to the user; Persian is fine)" },
            goal: { type: "string", description: "One sentence for the user: what this code does and why it matters (user language is fine)" },
            language: { type: "string", description: "Code language, e.g. typescript, python, go" },
            code: { type: "string", description: "The EXACT final code the user will type" },
            targetFile: { type: "string", description: "Absolute path of the file to watch (real work). Optional for pure practice." },
            startLine: {
              type: "number",
              description:
                "1-based line in targetFile where this block begins (edits to existing files). Default 1 = new file / whole file.",
            },
            result: {
              type: "string",
              description: "One sentence: what will be TRUE when the user finishes (the expected outcome)",
            },
            guide: {
              type: "array",
              description: "Guided-typing steps (2-5): why each chunk is typed now and what it does — shown beside the current line (user language is fine)",
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
            mode: { type: "string", enum: ["practice", "work", "both"], description: "practice = typing only, work = user types into their editor, both = default" },
            hints: { type: "array", items: { type: "string" }, description: "Short tips for the user, shown above the code (user language is fine)" },
            matchMode: {
              type: "string",
              enum: ["exact", "lenient"],
              description: "exact = byte-precise line matching (default, teaching); lenient = ignore indentation (real work)",
            },
            verify: {
              type: "object",
              properties: {
                command: { type: "string", description: "Command run after the file completes, e.g. pytest -q" },
                cwd: { type: "string", description: "Working directory (default: target file's directory)" },
                timeoutSec: { type: "number", description: "Cap in seconds (default 60, max 300)" },
              },
              description: "Automatic check after file completion; the result comes back to this session",
            },
            force: {
              type: "boolean",
              description: "Replace the unfinished current drill now; default false = new drill queues",
            },
          },
          required: ["title", "code"],
          additionalProperties: false,
        },
        options: { namespace: "teleprompter" },
        execute: async (input, context) => {
          const i = input as {
            title: string;
            goal?: string;
            language?: string;
            code: string;
            targetFile?: string;
            startLine?: number;
            result?: string;
            guide?: { from: number; to?: number; why: string; result?: string }[];
            mode?: "practice" | "work" | "both";
            hints?: string[];
            matchMode?: "exact" | "lenient";
            verify?: { command: string; cwd?: string; timeoutSec?: number };
            force?: boolean;
          };

          if (!(await ensureServer(directory))) {
            const hint = findServer(directory) || join(directory, "app", "server.js");
            return {
              content: "Teleprompter server did not start. Run it manually: `node " + hint + "`",
            };
          }

          const id = `drill-${Date.now()}`;
          const sessionID = String(context.sessionID || lastSessionID || "");
          const result = await post(
            "/api/drill",
            {
              id,
              title: i.title,
              goal: i.goal || "",
              language: i.language || "text",
              code: i.code,
              targetFile: i.targetFile || null,
              startLine: Math.max(1, Number(i.startLine) || 1),
              result: i.result || "",
              guide: i.guide || [],
              mode: i.mode || "both",
              hints: i.hints || [],
              matchMode: i.matchMode === "lenient" ? "lenient" : "exact",
              verify: i.verify && i.verify.command ? i.verify : null,
              force: i.force === true,
              sessionID: sessionID || null,
              source: "opencode",
            },
            context.signal,
          );

          if (!result || result.error) {
            return { content: `Failed to push drill: ${result?.error || "unknown"}` };
          }

          const drill = result.drill;
          if (sessionID) drillSessions.set(drill.id, sessionID);
          lastNotifiedAt = Date.now();

          const lines = String(drill.code).split("\n").length;
          if (result.queued) {
            return {
              content:
                `A drill is still in progress, so "${drill.title}" (${lines} lines) was queued (position ${result.position}). ` +
                "It activates automatically when the current drill finishes; pass force:true to replace it right now.",
            };
          }
          const where = drill.targetFile
            ? `Watching \`${drill.targetFile}\` — type it in your editor and progress is tracked.`
            : "Type it in the teleprompter window.";
          return {
            content:
              `Drill "${drill.title}" (${lines} lines, ${drill.mode}) is on the teleprompter: ${BASE}/ — ${where} ` +
              "I will be notified when it is done.",
          };
        },
      });

      editor.add({
        name: "status",
        description: "Current teleprompter drill: progress %, typing speed, target file state",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: "teleprompter" },
        execute: async (_input, context) => {
          if (!(await ensureServer(directory))) return { content: "Teleprompter server is unreachable." };
          const s = await get("/api/state").catch(() => null);
          if (!s || !s.drill) {
            const q = (s && s.queueLen) || 0;
            return { content: q ? `No active drill; ${q} drill(s) queued.` : "No active drill." };
          }
          const p = s.progress || {};
          const total = p.total || 0;
          const file = p.file || { matched: 0, exists: false };
          const practice = p.practice || { wpm: 0 };
          const pct = total ? Math.round((Math.max(file.matched || 0, practice.matched || 0) / total) * 100) : 0;
          return {
            content:
              `"${s.drill.title}" — ${pct}% (${total} lines) · ` +
              `file: ${s.drill.targetFile ? `${file.matched}/${total}${file.exists ? "" : " (not created yet)"}` : "none"} · ` +
              `speed: ${(practice.wpm || (p.editor && p.editor.wpm) || 0)} wpm` +
              (p.completedBy ? ` · done (${p.completedBy})` : "") +
              (s.queueLen ? ` · queue: ${s.queueLen} more` : "") +
              (p.verification ? (p.verification.ok ? " · checks green ✓" : " · checks red ✗") : ""),
          };
        },
      });

      editor.add({
        name: "note",
        description:
          "Attach a line-anchored explanation to the current teleprompter drill. The user types the drill line by line; use this when they ask about a specific line (explain it, improve it) so your answer appears right on that line in their overlay.",
        input: {
          type: "object",
          properties: {
            line: { type: "number", description: "1-based line number WITHIN the drill code the note belongs to" },
            text: { type: "string", description: "The explanation (user language is fine) — shown on that line" },
            replace: { type: "boolean", description: "Replace all notes (default false = append)" },
          },
          required: ["line", "text"],
          additionalProperties: false,
        },
        options: { namespace: "teleprompter" },
        execute: async (input, context) => {
          const i = input as { line?: number; text?: string; replace?: boolean };
          if (!(await ensureServer(directory))) {
            return { content: "Teleprompter server is unreachable." };
          }
          if (!i.text || !String(i.text).trim()) return { content: "text is required." };
          const res = await post(
            "/api/notes",
            { notes: [{ line: i.line || 1, text: i.text }], replace: i.replace === true },
            context.signal,
          );
          if (!res || res.error) return { content: `Failed to attach note: ${res?.error || "unknown"}` };
          const at = res.notes && res.notes.length ? res.notes[res.notes.length - 1].line : i.line || 1;
          return {
            content: `Note attached to drill line ${at}. The user now sees it on that line in the teleprompter.`,
          };
        },
      });
    });

    /* ---------------- /drill command ---------------- */
    await ctx.command.transform((editor) => {
      editor.add({
        name: "drill",
        description: "Create a teleprompter drill: code the user types themselves (practice and/or real work)",
        execute: async ({ sessionID, prompt, delivery }) => {
          lastSessionID = sessionID;
          await ctx.session.prompt({
            sessionID,
            delivery,
            text: `${DRILL_GUIDE}\n\nTask: ${prompt.text || "Create a short typing drill from this project"}`,
          });
        },
      });
      editor.add({
        name: "tour",
        description: "Onboarding tour: the model reads this repo and guides you file-by-file through how it works, as typing drills",
        execute: async ({ sessionID, prompt, delivery }) => {
          lastSessionID = sessionID;
          await ctx.session.prompt({
            sessionID,
            delivery,
            text: `${TOUR_GUIDE}\n\nFocus: ${prompt.text || "the whole project"}`,
          });
        },
      });
    });

    /* ---------------- completion -> session ---------------- */
    const timer = setInterval(async () => {
      if (serverTried && !(await healthy())) return;
      try {
        const res = await get(`/api/notifications?since=${lastNotifiedAt}`);
        const notes: Array<{ id: number; at: number; drillId: string; message: string; by: string; title: string }> =
          res?.notifications || [];
        if (!notes.length) return;
        const delivered = [];
        for (const n of notes) {
          lastNotifiedAt = Math.max(lastNotifiedAt, n.at);
          const sessionID = drillSessions.get(n.drillId) || lastSessionID;
          if (!sessionID) continue;
          try {
            await ctx.session.synthetic({ sessionID, text: n.message });
            delivered.push(n.id);
          } catch {
            /* تحویل نشد → ack نمی‌شود تا در پولِ بعدی دوباره برسد */
          }
        }
        if (delivered.length) {
          void post("/api/notifications/ack", { ids: delivered }).catch(() => {});
        }
        /* اتاق فرمان: سؤال‌های کاربر از داخل اپ → جلسه‌ی همان تمرین */
        try {
          const aq = await get("/api/ask");
          const qs: Array<{ id: number; drillId: string; drillTitle: string; text: string }> =
            aq?.questions || [];
          const qDone: number[] = [];
          for (const q of qs) {
            const sessionID = drillSessions.get(q.drillId) || lastSessionID;
            if (!sessionID) continue;
            try {
              await ctx.session.synthetic({
                sessionID,
                text: `[User question from the Drill app — reply to them] (re: "${q.drillTitle}"): ${q.text}`,
              });
              qDone.push(q.id);
            } catch {
              /* تحویل نشد → بی‌پاسخ می‌ماند تا پولِ بعدی */
            }
          }
          if (qDone.length) {
            void post("/api/ask/ack", { ids: qDone }).catch(() => {});
          }
        } catch {
          /* صف سؤال خالی یا سرور در دسترس نیست */
        }
      } catch {
        serverTried = true;
      }
    }, 2500);

    /* ---------------- heartbeat → کارت «اتصال‌ها» در صفحه‌ی شروع ---------------- */
    const beat = () => void post("/api/heartbeat", { src: "opencode" }).catch(() => {});
    beat();
    const hbTimer = setInterval(beat, 15000);

    return () => {
      clearInterval(timer);
      clearInterval(hbTimer);
    };
  },
};

export default plugin;
