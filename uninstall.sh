#!/bin/bash
# VideoHub uninstall (macOS): stops the server and removes what setup added outside this folder (MCP server, skill,
# the CLAUDE.md rule block, the app + Desktop shortcut, the log-in LaunchAgent). Folders go to the Trash.
#   ./uninstall.sh [--dry-run]
HUB="$(cd "$(dirname "$0")" && pwd)"; DRY=0; [ "${1:-}" = --dry-run ] && DRY=1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
doit() { if [ $DRY = 1 ]; then echo "  [dry run] would: $1"; else eval "$2" && echo "done: $1"; fi; }
totrash() { if [ -x /usr/bin/trash ]; then /usr/bin/trash "$1"; else /usr/bin/osascript -e "on run argv
tell application \"Finder\" to delete (POSIX file (item 1 of argv) as alias)
end run" "$1" >/dev/null; fi; }
echo "== VideoHub uninstall: $HUB"
PLIST="$HOME/Library/LaunchAgents/com.videohub.hub.plist"
[ -f "$PLIST" ] && grep -q "$HUB" "$PLIST" && doit 'remove the "start at log-in" LaunchAgent' "launchctl bootout gui/$(id -u) '$PLIST' 2>/dev/null; rm -f '$PLIST'"
for p in $(pgrep -f "$HUB/server/hub.js"); do doit "stop the VideoHub server (pid $p)" "kill $p"; done
CJ="$HOME/.claude.json"
if [ -f "$CJ" ] && grep -qF "$HUB/server/mcp.js" "$CJ"; then
  CL="$(command -v claude || true)"
  [ -n "$CL" ] && doit 'remove the MCP server "videohub" (claude mcp remove --scope user videohub)' "'$CL' mcp remove videohub --scope user >/dev/null 2>&1; true"
  doit "remove videohub from $CJ" "node -e 'const fs=require(\"fs\"),f=process.argv[1];const j=JSON.parse(fs.readFileSync(f,\"utf8\"));if(j.mcpServers&&j.mcpServers.videohub){delete j.mcpServers.videohub;fs.writeFileSync(f,JSON.stringify(j,null,2))}' '$CJ'"
else echo 'The registered MCP server "videohub" is not this install (or none is registered): left alone.'; fi
SK="$HOME/.claude/skills/videohub"
if [ -f "$SK/SKILL.md" ] && ! grep -qF "$HUB" "$SK/SKILL.md"; then echo "The skill in $SK belongs to another install: left alone."
elif [ -d "$SK" ]; then doit "move the skill folder $SK to the Trash" "totrash '$SK'"; fi
CM="$HOME/.claude/CLAUDE.md"
if [ -f "$CM" ] && grep -q '<!-- videohub:begin' "$CM" && grep -qF "$HUB" "$CM"; then
  doit "remove the VideoHub rule block from $CM" "cp '$CM' '$CM.videohub-backup' && node -e 'const fs=require(\"fs\"),f=process.argv[1];fs.writeFileSync(f,fs.readFileSync(f,\"utf8\").replace(/\\n?<!-- videohub:begin[\\s\\S]*?<!-- videohub:end -->\\n?/,\"\\n\"))' '$CM'"
fi
APP="$HOME/Applications/VideoHub.app"
if [ -d "$APP" ] && /usr/bin/osadecompile "$APP/Contents/Resources/Scripts/main.scpt" 2>/dev/null | grep -qF "$HUB"; then
  doit "move $APP to the Trash" "totrash '$APP'"
  [ -L "$HOME/Desktop/VideoHub" ] && doit 'delete the Desktop shortcut' "rm -f '$HOME/Desktop/VideoHub'"
fi
echo
echo '== Done. Left in place: this folder (with data/), your films and their .videohub notes, the outputs folder,'
echo '   and ~/Library/Application Support/RenderGuard (render protection settings). Delete them yourself if you want them gone.'
