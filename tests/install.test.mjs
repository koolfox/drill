/**
 * Installer tests: status shape + idempotent per-target installs.
 * Slow paths (npm, real app bundle) are NOT run here — build-app.sh is
 * covered by its own offline fake-runtime check during development.
 *   node tests/install.test.mjs
 */
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..");
const sh = path.join(repo, "install.sh");

const results = [];
const check = (name, ok, extra = "") => {
  results.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  :: " + extra : ""}`);
};

const run = (args, env = {}) =>
  execFileSync("bash", [sh, ...args], {
    encoding: "utf8",
    timeout: 60000,
    env: { ...process.env, ...env },
  });

/* 1. --status is valid JSON with all seven targets */
const out = run(["--status"]);
let st = null;
try {
  st = JSON.parse(out);
} catch {}
check("status is JSON with 7 targets", st && ["opencode", "vscode", "codex", "claude", "gemini", "app", "login"].every((k) => st[k] && typeof st[k].installed === "boolean" && typeof st[k].path === "string"), Object.keys(st || {}).join(","));

/* 2. codex install into a fake HOME: correct block, idempotent */
const fake = mkdtempSync(path.join(tmpdir(), "tp-home-"));
run(["--only", "codex"], { HOME: fake });
const cfg = path.join(fake, ".codex", "config.toml");
const once = readFileSync(cfg, "utf8");
check("codex block written", /^\[mcp_servers\.teleprompter\]/m.test(once) && once.includes("app/mcp.mjs"), once.split("\n")[0]);
run(["--only", "codex"], { HOME: fake });
const twice = readFileSync(cfg, "utf8");
check("codex install idempotent", twice === once, `bytes=${twice.length}`);

/* 3. claude + gemini merge into fake HOME without touching the real one */
run(["--only", "claude,gemini"], { HOME: fake });
const cl = JSON.parse(readFileSync(path.join(fake, ".claude.json"), "utf8"));
const gm = JSON.parse(readFileSync(path.join(fake, ".muse", "settings.json"), "utf8"));
check("claude merged", cl.mcpServers?.teleprompter?.command === "node", JSON.stringify(cl.mcpServers?.teleprompter || null));
check("gemini merged", gm.mcpServers?.teleprompter?.timeout === 30000, JSON.stringify(gm.mcpServers?.teleprompter || null));

/* 4. unknown target fails loudly */
let bad = false;
try {
  run(["--only", "bogus"]);
} catch {
  bad = true;
}
check("unknown target errors", bad);

/* 5. build-app.sh wiring: fake runtime builds a valid bundle offline */
const fakeElec = path.join(fake, "Electron.app");
mkdirSync(path.join(fakeElec, "Contents", "MacOS"), { recursive: true });
mkdirSync(path.join(fakeElec, "Contents", "Frameworks"), { recursive: true });
mkdirSync(path.join(fakeElec, "Contents", "Resources"), { recursive: true });
writeFileSync(path.join(fakeElec, "Contents", "MacOS", "Electron"), "#!/bin/sh\n");
writeFileSync(
  path.join(fakeElec, "Contents", "Info.plist"),
  '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleName</key><string>Electron</string><key>CFBundleExecutable</key><string>Electron</string><key>CFBundleIdentifier</key><string>com.github.electron</string><key>CFBundleIconFile</key><string>electron</string><key>CFBundleShortVersionString</key><string>0</string><key>CFBundleVersion</key><string>0</string></dict></plist>',
);
execSync(`ELECTRON_APP="${fakeElec}" bash "${path.join(repo, "scripts", "build-app.sh")}" --out "${path.join(fake, "Drill.app")}" --no-sign`, { encoding: "utf8", timeout: 120000 });
const appPlist = path.join(fake, "Drill.app", "Contents", "Info.plist");
const plist = readFileSync(appPlist, "utf8");
check("bundle metadata", plist.includes("pro.hoosh.drill") && plist.includes("LSUIElement"), "id+lsui");
check(
  "bundle tree",
  ["Contents/Resources/Drill.icns", "Contents/Resources/app/server.js", "Contents/Resources/app/overlay/main.js", "Contents/Resources/app/overlay/preload.js"].every((p) => {
    try {
      readFileSync(path.join(fake, "Drill.app", p));
      return true;
    } catch {
      return false;
    }
  }),
);
rmSync(fake, { recursive: true, force: true });

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
