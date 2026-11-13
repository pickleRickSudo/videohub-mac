#!/bin/bash
# VideoHub update (macOS): copies this folder's code over the installed VideoHub (settings, notes and data/ stay).
#   ./update.sh [--target <installed VideoHub folder>] [--no-skill] [--dry-run]
set -u
SRC="$(cd "$(dirname "$0")" && pwd)"; TARGET=''; NOSKILL=0; DRY=0
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
while [ $# -gt 0 ]; do case "$1" in --target) TARGET="$2"; shift ;; --no-skill) NOSKILL=1 ;; --dry-run) DRY=1 ;; *) echo "Unknown option: $1"; exit 2 ;; esac; shift; done
echo '== VideoHub update'
if [ -z "$TARGET" ]; then
  # the installed one: what the VideoHub app runs, else ~/VideoHub, ~/Desktop/VideoHub
  A="$HOME/Applications/VideoHub.app/Contents/Resources/Scripts/main.scpt"
  [ -f "$A" ] && TARGET="$(/usr/bin/osadecompile "$A" 2>/dev/null | sed -n 's/.*"\(\/.*\)\/open\.sh".*/\1/p' | head -1)"
  for c in "$TARGET" "$HOME/VideoHub" "$HOME/Desktop/VideoHub"; do [ -n "$c" ] && [ -f "$c/server/hub.js" ] && { TARGET="$c"; break; }; done
fi
[ -n "$TARGET" ] && [ -f "$TARGET/server/hub.js" ] || { echo 'No installed VideoHub found. For a first install use SETUP.command (or: update.sh --target <VideoHub folder>).'; exit 1; }
TARGET="$(cd "$TARGET" && pwd)"
[ "$TARGET" = "$SRC" ] && { echo 'This folder is the installed VideoHub; nothing to update.'; exit 0; }
echo "Installed VideoHub: $TARGET"
PORT=$(/usr/bin/plutil -extract port raw -o - "$TARGET/data/config.json" 2>/dev/null || true); [[ "$PORT" =~ ^[0-9]+$ ]] || PORT=7788
if curl -fs -m 3 "http://127.0.0.1:$PORT/api/ping" >/dev/null 2>&1; then
  BUSY=$(curl -fs -m 5 "http://127.0.0.1:$PORT/api/jobs" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).filter(j=>["running","queued"].includes(j.state)).length)}catch{console.log(0)}})')
  [ "${BUSY:-0}" != 0 ] && { echo "$BUSY render(s) running or queued. Run this again when they are done; nothing was changed."; exit 2; }
  curl -fs -m 5 "http://127.0.0.1:$PORT/api/disk/clean" | grep -q '"state":"running"' && { echo 'A cleanup is running. Run this again when it is done; nothing was changed.'; exit 2; }
fi
PIDS=$(pgrep -f "$TARGET/server/hub.js" || true)
ITEMS="server ui templates skill claude examples engine-hooks docs scripts CLAUDE.md README.md LICENSE SETUP.command UPDATE.command setup.sh update.sh uninstall.sh open.sh package.json package-lock.json"
STAMP=$(date +%Y%m%d-%H%M%S); BAK="$TARGET/data/update-backup/$STAMP"
if [ $DRY = 1 ]; then [ -n "$PIDS" ] && echo "  [dry run] would: stop the VideoHub server (pid $PIDS)"; echo "  [dry run] would: back up the replaced code to $BAK and copy: $ITEMS"; echo 'Dry run finished: nothing was changed.'; exit 0; fi
for p in $PIDS; do kill "$p" 2>/dev/null && echo "VideoHub server stopped (pid $p)"; done; [ -n "$PIDS" ] && sleep 0.8
LOCK_OLD=$(shasum "$TARGET/package-lock.json" 2>/dev/null | cut -d' ' -f1)
mkdir -p "$BAK"; n=0
for it in $ITEMS; do
  [ -e "$SRC/$it" ] || continue
  [ -e "$TARGET/$it" ] && { mkdir -p "$(dirname "$BAK/$it")"; cp -R "$TARGET/$it" "$BAK/$it"; }
  if [ -d "$SRC/$it" ]; then mkdir -p "$TARGET/$it"; cp -R "$SRC/$it/." "$TARGET/$it/"; else cp "$SRC/$it" "$TARGET/$it"; fi
  n=$((n+1))
done
echo "$n items copied (the old code is in $BAK)"
if [ "$(shasum "$TARGET/package-lock.json" 2>/dev/null | cut -d' ' -f1)" != "$LOCK_OLD" ] || [ ! -d "$TARGET/node_modules" ]; then
  (cd "$TARGET" && npm install --no-audit --no-fund --loglevel=error) || { echo 'npm install failed'; exit 1; }; echo 'Packages updated'
else echo 'Packages unchanged'; fi
if [ $NOSKILL = 0 ]; then
  SK="$HOME/.claude/skills/videohub"; mkdir -p "$SK"
  for f in "$TARGET/skill/videohub/"*; do [ -f "$f" ] && node -e 'const fs=require("fs");fs.writeFileSync(process.argv[2],fs.readFileSync(process.argv[1],"utf8").split("{{VIDEOHUB_DIR}}").join(process.argv[3]))' "$f" "$SK/$(basename "$f")" "$TARGET"; done
  echo "Skill updated: $SK"
fi
echo; echo '== Done. Open VideoHub with the VideoHub app (the server starts again with the new code).'
echo 'Claude sessions that are already open see the new hub_* tools after they restart them.'
