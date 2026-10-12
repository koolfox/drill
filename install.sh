#!/usr/bin/env bash
# Teleprompter universal installer — one script for every surface.
#   ./install.sh                        -> everything below
#   ./install.sh --only opencode,vscode -> just those (comma-separated)
#   ./install.sh --status               -> JSON status for the admin panel
#   ./install.sh --electron             -> also npm-install Electron (legacy flag)
#   ./install.sh --no-login             -> skip the login item
#   ./install.sh --app-out PATH         -> where Teleprompter.app goes
#
# Targets: opencode | vscode | codex | claude | gemini | app | login
# Safe to re-run: every step is idempotent (replace-in-place, never duplicate).
set -euo pipefail

# Node 18+ is required for MCP targets (merge_json) — everything else is plain bash.
# Never sudo-installs anything: either Homebrew handles it, or we print the exact
# one-liner for your system and stop (junior-friendly, no surprise password prompts).
require_node() {
  if command -v node >/dev/null 2>&1; then
    local v
    v="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    if [[ "$v" -ge 18 ]] 2>/dev/null; then return 0; fi
    echo "    (node $v found, need >= 18)"
  fi
  echo "==> node.js 18+ is required but missing."
  case "$(uname)" in
    Darwin)
      if command -v brew >/dev/null 2>&1; then
        echo "    installing via Homebrew…"
        brew install node
        hash -r 2>/dev/null || true
        command -v node >/dev/null 2>&1 && return 0
      fi
      echo "    install node first, then re-run. Pick one:"
      echo "      brew install node"
      echo "      (or https://nodejs.org — LTS installer)"
      return 1
      ;;
    Linux)
      echo "    install node 18+ first, then re-run. Pick one:"
      echo "      sudo apt-get install -y nodejs npm   # Debian/Ubuntu"
      echo "      sudo dnf install -y nodejs npm       # Fedora"
      echo "      sudo pacman -S --noconfirm nodejs npm  # Arch"
      echo "      (or https://nodejs.org — Linux binaries)"
      return 1
      ;;
    MINGW*|MSYS*|CYGWIN*)
      echo "    on Windows: winget install OpenJS.NodeJS.LTS, then run install.sh in Git Bash"
      return 1
      ;;
    *)
      echo "    install node 18+ from https://nodejs.org, then re-run."
      return 1
      ;;
  esac
}

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${OPENCODE_HOME:-$HOME/.config/opencode}/plugins/teleprompter"
PORT="${TELEPROMPTER_PORT:-4783}"
ONLY=""
STATUS=0
LOGIN=1
APP_OUT=""
ELECTRON_FLAG=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --only) ONLY="$2"; shift 2 ;;
    --status) STATUS=1; shift ;;
    --no-login) LOGIN=0; shift ;;
    --app-out) APP_OUT="$2"; shift 2 ;;
    --electron) ELECTRON_FLAG=1; shift ;;
    -h|--help)
      sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1 (see --help)" >&2; exit 2 ;;
  esac
done

if [[ -n "$ONLY" ]]; then
  IFS=',' read -ra _W <<< "$ONLY"
  for _t in "${_W[@]}"; do
    case "$_t" in
      opencode|vscode|codex|claude|gemini|app|login) ;;
      *) echo "unknown target: $_t (want: opencode,vscode,codex,claude,gemini,app,login)" >&2; exit 2 ;;
    esac
  done
fi

want() { # want <target>: true if in --only (or no filter)
  [[ -z "$ONLY" ]] && return 0
  case ",$ONLY," in *",$1,"*) return 0;; *) return 1;; esac
}
have_node() { command -v node >/dev/null 2>&1; }
jesc() { local s="$1"; s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; printf '%s' "$s"; }

# ------------------------------------------------------------ status checks

st_opencode() { [[ -f "$DEST/index.ts" ]] && echo "  \"opencode\": {\"installed\": true, \"path\": \"$(jesc "$DEST")\"}" \
                                             || echo "  \"opencode\": {\"installed\": false, \"path\": \"$(jesc "$DEST")\"}"; }
st_vscode() {
  local d
  for d in "$HOME/.vscode/extensions" "$HOME/.vscode-server/extensions" "$HOME/.cursor/extensions" "$HOME/.windsurf/extensions"; do
    [[ -f "$d/teleprompter-1.0.0/extension.js" ]] && { echo "  \"vscode\": {\"installed\": true, \"path\": \"$(jesc "$d/teleprompter-1.0.0")\"}"; return; }
  done
  echo "  \"vscode\": {\"installed\": false, \"path\": \"$(jesc "$HOME/.vscode/extensions/teleprompter-1.0.0")\"}"
}
st_codex() {
  if grep -q "^\[mcp_servers\.teleprompter" "$HOME/.codex/config.toml" 2>/dev/null; then
    echo "  \"codex\": {\"installed\": true, \"path\": \"$(jesc "$HOME/.codex/config.toml")\"}"
  else
    echo "  \"codex\": {\"installed\": false, \"path\": \"$(jesc "$HOME/.codex/config.toml")\"}"
  fi
}
st_claude() {
  if grep -q '"teleprompter"' "$HOME/.claude.json" 2>/dev/null; then
    echo "  \"claude\": {\"installed\": true, \"path\": \"$(jesc "$HOME/.claude.json")\"}"
  else
    echo "  \"claude\": {\"installed\": false, \"path\": \"$(jesc "$HOME/.claude.json")\"}"
  fi
}
st_gemini() {
  if grep -q '"teleprompter"' "$HOME/.muse/settings.json" 2>/dev/null; then
    echo "  \"gemini\": {\"installed\": true, \"path\": \"$(jesc "$HOME/.muse/settings.json")\"}"
  else
    echo "  \"gemini\": {\"installed\": false, \"path\": \"$(jesc "$HOME/.muse/settings.json")\"}"
  fi
}
resolve_app() {
  if [[ -n "$APP_OUT" ]]; then printf '%s' "$APP_OUT"; return; fi
  if [[ -w /Applications ]]; then printf '/Applications/Drill.app';
  else printf '%s/Applications/Drill.app' "$HOME"; fi
}
st_app() {
  local a; a="$(resolve_app)"
  if [[ -x "$a/Contents/MacOS/Electron" && -f "$a/Contents/Resources/app/overlay/main.js" ]]; then
    echo "  \"app\": {\"installed\": true, \"path\": \"$(jesc "$a")\"}"
  else
    echo "  \"app\": {\"installed\": false, \"path\": \"$(jesc "$a")\"}"
  fi
}
st_login() {
  local p="$HOME/Library/LaunchAgents/pro.hoosh.drill.plist"
  if [[ -f "$p" ]]; then echo "  \"login\": {\"installed\": true, \"path\": \"$(jesc "$p")\"}";
  else echo "  \"login\": {\"installed\": false, \"path\": \"$(jesc "$p")\"}"; fi
}

if [[ "$STATUS" == 1 ]]; then
  echo "{"
  st_opencode; echo ","
  st_vscode; echo ","
  st_codex; echo ","
  st_claude; echo ","
  st_gemini; echo ","
  st_app; echo ","
  st_login
  echo "}"
  exit 0
fi

# ---------------------------------------------------------------- installs

install_opencode() {
  echo "==> opencode plugin → $DEST"
  mkdir -p "$DEST/app"
  cp -R "$SRC/opencode-plugin/." "$DEST/"
  cp -R "$SRC/app/." "$DEST/app/"
  # never ship runtime state/logs into the install:
  rm -f "$DEST/app"/state-*.json "$DEST/app"/install-*.log "$DEST"/__check.ts 2>/dev/null || true
  if [[ "$ELECTRON_FLAG" == 1 ]]; then
    echo "==> installing Electron (one-time, ~100 MB + ~300 MB on disk)"
    (cd "$DEST/app/overlay" && npm install)
    echo "    overlay window ready"
  fi
  echo "    then: restart OpenCode (\`opencode service restart\`) to load the plugin"
}

install_vscode() {
  local d done=0
  for d in "$HOME/.vscode/extensions" "$HOME/.vscode-server/extensions" "$HOME/.cursor/extensions" "$HOME/.windsurf/extensions"; do
    if [[ -d "$d" ]]; then
      rm -rf "$d/teleprompter-1.0.0"
      mkdir -p "$d/teleprompter-1.0.0"
      cp -R "$SRC/vscode-extension/." "$d/teleprompter-1.0.0/"
      echo "==> editor extension → $d/teleprompter-1.0.0"
      done=1
    fi
  done
  if [[ "$done" == 1 ]]; then
    echo "    then inside the editor:  Developer: Reload Window"
  else
    echo "    (no editor extension dir found — skipped)"
  fi
}

need_dest() { # MCP targets reference the installed server; ensure it exists
  if [[ ! -f "$DEST/app/mcp.mjs" ]]; then
    echo "    (installing opencode files first — MCP needs the server)"
    install_opencode
  fi
}

install_codex() {
  have_node || { echo "    (node not found — codex MCP skipped)"; return 0; }
  need_dest
  local cfg="$HOME/.codex/config.toml" tmp
  mkdir -p "$(dirname "$cfg")"; touch "$cfg"
  tmp="$(mktemp)"
  awk 'BEGIN{skip=0} /^\[mcp_servers\.teleprompter(\.|])/ {skip=1; next} /^\[/ {skip=0} !skip {print}' "$cfg" > "$tmp"
  cat >> "$tmp" <<EOF
[mcp_servers.teleprompter]
command = "node"
args = ["$DEST/app/mcp.mjs"]

[mcp_servers.teleprompter.env]
TELEPROMPTER_PORT = "$PORT"
EOF
  mv "$tmp" "$cfg"
  echo "==> Codex CLI MCP → $cfg  ([mcp_servers.teleprompter])"
}

merge_json() { # merge_json FILE TOPKEY NAME JSONVALUE  (needs node)
  node -e 'const fs=require("fs"),path=require("path");const [f,k,n,v]=process.argv.slice(1);let o={};try{o=JSON.parse(fs.readFileSync(f,"utf8"))}catch(e){}o[k]=o[k]||{};o[k][n]=JSON.parse(v);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify(o,null,2)+"\n");' \
    "$1" "$2" "$3" "$4"
}

install_claude() {
  have_node || { echo "    (node not found — claude MCP skipped)"; return 0; }
  need_dest
  if command -v claude >/dev/null 2>&1; then
    # remove-then-add keeps it idempotent across CLI versions
    claude mcp remove --scope user teleprompter >/dev/null 2>&1 || true
    if claude mcp add --scope user teleprompter --env "TELEPROMPTER_PORT=$PORT" -- node "$DEST/app/mcp.mjs" >/dev/null 2>&1; then
      echo "==> Claude Code MCP → user scope (via cli)"
      return 0
    fi
    echo "    (claude mcp add failed — falling back to ~/.claude.json)"
  fi
  merge_json "$HOME/.claude.json" "mcpServers" "teleprompter" \
    "{\"command\":\"node\",\"args\":[\"$DEST/app/mcp.mjs\"],\"env\":{\"TELEPROMPTER_PORT\":\"$PORT\"}}"
  echo "==> Claude Code MCP → $HOME/.claude.json  (mcpServers.teleprompter)"
}

install_gemini() {
  have_node || { echo "    (node not found — gemini MCP skipped)"; return 0; }
  need_dest
  merge_json "$HOME/.muse/settings.json" "mcpServers" "teleprompter" \
    "{\"command\":\"node\",\"args\":[\"$DEST/app/mcp.mjs\"],\"env\":{\"TELEPROMPTER_PORT\":\"$PORT\"},\"timeout\":30000}"
  echo "==> Gemini CLI MCP → $HOME/.muse/settings.json"
}

install_app() {
  [[ "$(uname)" == "Darwin" ]] || { echo "    (macOS app bundle is darwin-only — skipped)"; return 0; }
  local elec="$SRC/app/overlay/node_modules/electron/dist/Electron.app"
  if [[ ! -d "$elec" ]]; then
    echo "==> fetching Electron runtime (one-time download)…"
    (cd "$SRC/app/overlay" && npm install)
  fi
  local out; out="$(resolve_app)"
  APP_OUT="$out" bash "$SRC/scripts/build-app.sh" --out "$out"
}

install_login() {
  [[ "$(uname)" == "Darwin" ]] || { echo "    (login item is darwin-only — skipped)"; return 0; }
  local app; app="$(resolve_app)"
  if [[ ! -d "$app" ]]; then
    echo "    (app bundle not found at $app — install the app first)"; return 0
  fi
  # drop legacy login items from earlier eras (else they error every login)
  for legacy in "$HOME/Library/LaunchAgents/com.teleprompter.app.plist" "$HOME/Library/LaunchAgents/com.drill.app.plist"; do
    if [[ -f "$legacy" ]]; then
      launchctl bootout "gui/$(id -u)" "$legacy" 2>/dev/null || true
      rm -f "$legacy"
      echo "    (removed legacy login item $(basename "$legacy" .plist))"
    fi
  done
  local p="$HOME/Library/LaunchAgents/com.drill.app.plist"
  mkdir -p "$(dirname "$p")"
  cat > "$p" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>pro.hoosh.drill</string>
  <key>ProgramArguments</key><array><string>/usr/bin/open</string><string>-a</string><string>$app</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
EOF
  launchctl bootstrap "gui/$(id -u)" "$p" 2>/dev/null \
    || launchctl load -w "$p" 2>/dev/null \
    || echo "    (launchctl load needs one manual run after reboot — plist is in place)"
  echo "==> login item → $p  (overlay starts at login)"
}

need_node=0
want codex && need_node=1
want claude && need_node=1
want gemini && need_node=1
if [[ "$need_node" == 1 ]]; then require_node || exit 1; fi

want opencode && install_opencode
want vscode && install_vscode
want codex && install_codex
want claude && install_claude
want gemini && install_gemini
want app && install_app
if want login && [[ "$LOGIN" == 1 ]]; then install_login; fi

echo "==> done. Server: http://127.0.0.1:$PORT/  ·  Admin: http://127.0.0.1:$PORT/admin"
echo "    Restart OpenCode to load a fresh plugin copy."
