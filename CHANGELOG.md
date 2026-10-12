# Changelog — Drill (on-screen guided typing)

## [Unreleased]

### Added
- Guided typing: per-chunk `why`/`result` (`guide`) shown live in panel + subtitle band.
- Line-anchored notes: `POST /api/notes`, `teleprompter_note` (plugin + MCP) —
  model explanations pinned to the exact line being typed.
- Mission control: `/admin` gains backends picker, ask-box (`POST /api/ask`,
  plugin delivery + MCP `wait` short-circuit) and read-only target-file view
  (`GET /api/file`, drill files only).
- Drill queue: busy pushes queue with position; auto-promote on completion;
  `force:true` replaces; `/api/next`, `/api/queue/clear`, `reset {all:true}`.
- Persistence: drill, queue, progress, notifications, settings in
  `state-<port>.json` (0600); crash restarts restore everything.
- Verify: `verify:{command}` runs on file completion; result attached to the
  notification and `progress.verification`.
- Acked delivery: notifications + questions ack; unacked redeliver after restart.
- Start hub + i18n (English default, Persian, extensible) with live connection cards.
- Web admin (`/admin`): system/install status, drill+queue ops, server settings
  (persisted), install runner with log, notifications, mission control.
- Editor WPM: VS Code reports document changes; speed surfaces in band, panel,
  tray, status and `/tp`.
- Subtitle band: top/bottom toggle, drag-to-move, resize grip (persisted);
  long current lines wrap instead of `…`.
- VS Code: go-to-target with confirmed empty-file creation, new-drill prompt,
  health detail in heartbeat, editor-WPM reporting.
- Instance management: `pid/startedAt/stale` in state+health; plugin auto-replaces
  stale servers; `POST /api/shutdown {confirm:true}`.
- Universal installer: opencode, vscode/cursor/windup, Codex/Claude/Gemini MCP,
  macOS `Drill.app` bundle (ad-hoc signed, menu-bar, login item), `--only`,
  `--status` JSON for the admin panel.
- Brand: Drill/دریل display name, woodpecker app icon, light pastel theme
  (dark-first preserved), Persian digit localization for counters.
- Local token auth (`TELEPROMPTER_TOKEN`) across API, overlay, plugin, MCP, ext.

### Changed
- Plugin model-facing text fully English (OpenCode TUI renders RTL poorly);
  drill *content* stays Persian for the overlay.
- Completed drills with empty queue return to the hub (history keeps them).
- `/api/complete` only clears when no file work is pending (both-mode safety).
- MCP `wait` reports recent completions even after hub-return.

### Fixed
- Subtitle/filesystem destination drift (`startLine` mapping, positional watcher).
- Stale-heartbeat confusion (45s window + ages), tray i18n, RTL letter-spacing.
- Ack-endpoint and drill-command regressions caught and repaired same-session
  with behavioral smoke tests.
- Test isolation: per-suite state cleanup, serial ports, no cross-run pollution.
