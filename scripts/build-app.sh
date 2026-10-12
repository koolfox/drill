#!/usr/bin/env bash
# Build a macOS app bundle for Drill (menu-bar app: no Dock icon).
# Layout trick: copy the stock Electron.app, drop our app/ tree into
# Contents/Resources/app (Electron loads it via app/package.json "main").
#   scripts/build-app.sh [--out /Applications/Drill.app] [--no-sign]
#   APP_NAME=Foo APP_ID=com.example.foo scripts/build-app.sh
# Env overrides (for tests): ELECTRON_APP=/path/to/Electron.app
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="${APP_NAME:-Drill}"
APP_ID="${APP_ID:-pro.hoosh.drill}"
OUT=""
SIGN=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --no-sign) SIGN=0; shift ;;
    *) echo "unknown flag: $1 (want --out PATH | --no-sign)" >&2; exit 2 ;;
  esac
done
if [[ -z "$OUT" ]]; then
  if [[ -w /Applications ]]; then OUT="/Applications/$APP_NAME.app";
  else OUT="$HOME/Applications/$APP_NAME.app"; fi
fi

ELEC="${ELECTRON_APP:-$SRC/app/overlay/node_modules/electron/dist/Electron.app}"
if [[ ! -d "$ELEC" ]]; then
  echo "Electron runtime not found at:" >&2
  echo "  $ELEC" >&2
  echo "Fix: ./install.sh --electron  (one-time, ~100 MB download)" >&2
  exit 1
fi
if [[ ! -f "$SRC/assets/Drill.icns" ]]; then
  echo "Missing app icon (assets/Drill.icns) — run from a full checkout" >&2
  exit 1
fi

TMP="$OUT.build-tmp"
rm -rf "$TMP"
echo "==> copying Electron runtime (~300 MB)…"
cp -R "$ELEC" "$TMP"
APP="$TMP/Contents"

echo "==> adding app files (without the electron distribution itself)…"
mkdir -p "$APP/Resources/app"
(cd "$SRC/app" && tar cf - \
  --exclude='overlay/node_modules' \
  --exclude='state-*.json' \
  --exclude='install-*.log' \
  --exclude='.DS_Store' \
  . ) | (cd "$APP/Resources/app" && tar xf -)
cp "$SRC/assets/Drill.icns" "$APP/Resources/Drill.icns"
ICON=Drill

echo "==> bundle metadata ($APP_NAME)…"
PSET() { # PSET key type value — add-or-set (stock Electron plists miss some keys)
  /usr/libexec/PlistBuddy -c "Add :$1 $2 $3" "$APP/Info.plist" 2>/dev/null || \
    /usr/libexec/PlistBuddy -c "Set :$1 $3" "$APP/Info.plist"
}
PSET CFBundleName string "$APP_NAME"
PSET CFBundleDisplayName string "$APP_NAME"
PSET CFBundleIdentifier string "$APP_ID"
PSET CFBundleShortVersionString string 1.0.0
PSET CFBundleVersion string 1
PSET CFBundleIconFile string "$ICON"
PSET LSUIElement bool true
PSET NSHighResolutionCapable bool true

if [[ "$SIGN" == 1 ]]; then
  echo "==> ad-hoc code signature (no Apple account needed)…"
  codesign --force --deep --sign - "$TMP" 2>/dev/null \
    && echo "    signed" \
    || echo "    WARNING: codesign failed — first launch needs right-click → Open"
fi
xattr -cr "$TMP" 2>/dev/null || true

echo "==> installing to $OUT"
mkdir -p "$(dirname "$OUT")"
rm -rf "$OUT"
mv "$TMP" "$OUT"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$OUT" 2>/dev/null || true

echo "==> $APP_NAME ready: $OUT"
echo "    First launch: right-click → Open (unsigned app, one time)."
echo "    It lives in the menu bar (no Dock icon)."
