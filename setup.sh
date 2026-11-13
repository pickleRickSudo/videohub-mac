#!/bin/bash
# VideoHub setup for macOS (the Mac version of setup.ps1). Double-click SETUP.command, or:
#   ./setup.sh [--dry-run] [--yes] [--workspace <folder>] [--watch-found yes|no] [--gpu-encoder yes|no]
#              [--global-rule yes|no] [--shortcut yes|no] [--startup yes|no] [--example yes|no]
# --dry-run asks nothing, takes the recommended answers and changes nothing outside this folder; --yes takes every
# recommended answer. The config logic lives in scripts/init-config.mjs (unit-tested); a re-run keeps every answer.
set -u
HUB="$(cd "$(dirname "$0")" && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
DRY=0; YES=0; WS=''; WATCHFOUND=ask; GPU=ask; RULE=ask; SHORTCUT=ask; STARTUP=ask; EXAMPLE=ask
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run|--test) DRY=1 ;; --yes|-y) YES=1 ;;
    --workspace) WS="$2"; shift ;; --watch-found) WATCHFOUND="$2"; shift ;; --gpu-encoder) GPU="$2"; shift ;;
    --global-rule) RULE="$2"; shift ;; --shortcut) SHORTCUT="$2"; shift ;; --startup) STARTUP="$2"; shift ;; --example) EXAMPLE="$2"; shift ;;
    -h|--help) sed -n 2,6p "$0"; exit 0 ;;
    *) echo "Unknown option: $1"; exit 2 ;;
  esac; shift
done
QUIET=$(( DRY || YES ))
c() { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }
say() { c 0 "$1"; }; ok() { c 32 "$1"; }; warn() { c 33 "$1"; }; err() { c 31 "$1"; }; head_() { c 36 "$1"; }; dim() { c 90 "$1"; }
plan() { c 36 "  [dry run] would: $1"; }
q() { echo; c 1 "$1"; }
# yesno "question" preset recommended(1/0) -> exit status 0 = yes
yesno() {
  [ "$2" = yes ] && return 0; [ "$2" = no ] && return 1
  if [ $QUIET = 1 ]; then dim "$1 -> $([ $3 = 1 ] && echo yes || echo no) (recommended)"; return $(( 1 - $3 )); fi
  local hint; [ $3 = 1 ] && hint='[Y/n]' || hint='[y/N]'
  while true; do
    read -r -p "$1 $hint " a; a=$(echo "$a" | tr '[:upper:]' '[:lower:]' | xargs)
    [ -z "$a" ] && return $(( 1 - $3 )); [[ "$a" =~ ^(y|yes)$ ]] && return 0; [[ "$a" =~ ^(n|no)$ ]] && return 1
    warn '  Please type y (yes) or n (no), or press Enter for the recommended answer.'
  done
}
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const v=process.argv[1].split(".").reduce((o,k)=>o==null?o:o[k],j);process.stdout.write(v==null?"":Array.isArray(v)?v.map(x=>typeof x==="object"?x.path:x).join("\n"):String(v))})' "$1"; }

TODO=()
CLAUDE_HOME="$HOME/.claude"
INIT="$HUB/scripts/init-config.mjs"
ANSWERS="$HUB/data/setup-answers.json"
ans() { [ -f "$ANSWERS" ] && node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(j[process.argv[2]]||"")}catch{}' "$ANSWERS" "$1"; }
A_RULE=$(ans globalRule); A_SHORT=$(ans shortcut); A_START=$(ans startup); A_EX=$(ans example)

head_ "== VideoHub setup: $HUB"
if [ $DRY = 1 ]; then warn 'Dry run: no questions, the recommended answers, nothing outside this folder is changed.'
elif [ $YES = 1 ]; then warn 'Using the recommended answer for every question.'
else say 'A few plain questions follow. Press Enter to take the recommended answer shown in [brackets].'; fi

# ---------- requirements
BREW_HINT='Homebrew (https://brew.sh) installs it with one line in Terminal'
NODE="$(command -v node || true)"; MAJOR=0
[ -n "$NODE" ] && MAJOR=$(node -v | sed 's/^v//; s/\..*//')
if [ "$MAJOR" -lt 22 ]; then
  echo; [ -n "$NODE" ] && err "Node.js is too old here (version $MAJOR; VideoHub needs 22 or newer)." || err 'Node.js is missing.'
  err 'VideoHub is a small program written for Node.js, so it cannot run without it.'
  say "Install it ($BREW_HINT):"; c 36 '    brew install node'
  say 'or download it from https://nodejs.org. Then run SETUP.command again.'; exit 1
fi
ok "Node.js $(node -v): ok"
FF="$(command -v ffmpeg || true)"
if [ -n "$FF" ]; then ok "ffmpeg: ok ($FF)"; else
  warn 'ffmpeg is missing. VideoHub still lists your films, but it needs ffmpeg to make videos (renders), previews and frame pictures.'
  warn "  Install it ($BREW_HINT):   brew install ffmpeg   - then run SETUP.command again"
  TODO+=('Install ffmpeg (renders need it):  brew install ffmpeg   - then run SETUP.command again')
fi
BROWSER=''
for APP in "/Applications/Google Chrome.app" "$HOME/Applications/Google Chrome.app" "/Applications/Microsoft Edge.app" "/Applications/Chromium.app" "/Applications/Brave Browser.app"; do [ -d "$APP" ] && { BROWSER="$APP"; break; }; done
if [ -n "$BROWSER" ]; then ok "Browser for rendering: ok ($BROWSER)"; else
  warn 'No Google Chrome (or Edge / Chromium / Brave) found. Renders draw every frame in one of them (invisibly), so they need one.'
  warn '  Install Chrome:   brew install --cask google-chrome   (or https://www.google.com/chrome)'
  TODO+=('Install Google Chrome (renders use it):  brew install --cask google-chrome')
fi
CLAUDE="$(command -v claude || true)"
[ -z "$CLAUDE" ] && for f in "$HOME/.claude/local/claude" "$HOME/.local/bin/claude" /opt/homebrew/bin/claude /usr/local/bin/claude; do [ -x "$f" ] && { CLAUDE="$f"; break; }; done
if [ -n "$CLAUDE" ]; then ok "Claude Code: ok ($CLAUDE)"; else say 'Claude Code was not found. VideoHub works without it, but Claude Code is what writes the films: https://claude.com/claude-code (the Claude tools are registered anyway).'; fi

# ---------- packages
if [ $DRY = 1 ]; then plan "npm install in $HUB"
else
  (cd "$HUB" && npm install --no-audit --no-fund --loglevel=error) || { err 'npm install failed'; exit 1; }
  ok 'Packages: ok'
fi
# a git clone: keep local files out of git status
if [ -d "$HUB/.git/info" ] && [ ! -f "$HUB/.gitignore" ] && [ $DRY = 0 ]; then
  for l in node_modules/ data/ '*.log' .test-tmp/ 'examples/*/render/' 'examples/*/.videohub/' 'examples/*/node_modules/'; do grep -qxF "$l" "$HUB/.git/info/exclude" 2>/dev/null || echo "$l" >> "$HUB/.git/info/exclude"; done
fi

# ---------- workspace, watched folders, encoder
ST="$(node "$INIT" --state)"
E=$(echo "$ST" | json error); [ -n "$E" ] && { err "$E"; exit 1; }
INSTALLED=$(echo "$ST" | json installed); WSNOW=''; WATCH=(); ENC=''
if [ "$INSTALLED" = true ]; then
  echo; ok "Your video work lives in: $(echo "$ST" | json workspace)  (already set; change single folders in VideoHub > Settings)"
else
  DEF=$(echo "$ST" | json defaultWorkspace)
  q 'Where should your video work live?'
  say '  One folder holds everything VideoHub makes: your films, every finished video (outputs), sounds, thumbnails'
  say "  and an archive for old versions. Recommended: $DEF"
  [ -z "$WS" ] && [ $QUIET = 1 ] && WS="$DEF"; FIXED="$WS"
  while true; do
    if [ -z "$WS" ]; then read -r -p '  Press Enter for the recommended folder, or type another full path: ' a; a="${a%\"}"; a="${a#\"}"; WS="${a:-$DEF}"; fi
    WS="${WS/#\~/$HOME}"
    CHK="$(node "$INIT" --check "$WS")"
    [ "$(echo "$CHK" | json ok)" = true ] && break
    warn "  $(echo "$CHK" | json why)"; { [ -n "$FIXED" ] || [ $QUIET = 1 ]; } && exit 1; WS=''
  done
  ok "  Workspace: $WS"
  FOUND="$(echo "$ST" | json discovered)"
  if [ -n "$FOUND" ]; then
    q 'VideoHub found folders that look like video work:'; echo "$FOUND" | sed 's/^/  - /'
    say '  It can list the films in them too (it never moves or changes them). You can also turn them on later in'
    say '  VideoHub > Settings > Watched folders.'
    if yesno '  Watch these folders as well?' "$WATCHFOUND" 0; then while IFS= read -r l; do WATCH+=("$l"); done <<< "$FOUND"; fi
  fi
fi
CUR_ENC=$(echo "$ST" | json encoder)
if [ -n "$CUR_ENC" ]; then ok "Render speed: $CUR_ENC (already set; change it in VideoHub > Settings > Render speed)"
elif [ -z "$FF" ]; then ENC=auto; warn 'Render speed: decided once ffmpeg is installed (run setup again then).'
else
  if [ $DRY = 1 ]; then DET="$(node "$INIT" --detect --ffmpeg "$FF" --dry-run)"; else DET="$(node "$INIT" --detect --ffmpeg "$FF")"; fi
  if echo "$DET" | json available | grep -qx vt; then
    GPUNAME=$(echo "$DET" | json gpus | head -1); q "Your Mac's video engine (${GPUNAME:-hardware encoder}) can encode video."
    if yesno '  Use it for renders? Same picture quality, usually faster, and your processor stays free.' "$GPU" 1; then ENC=auto; else ENC=x264; fi
  else ENC=auto; echo; say 'Renders will use the processor (no hardware video encoder was found on this Mac).'; fi
fi
ARGS=()
[ -n "$WS" ] && [ "$INSTALLED" != true ] && ARGS+=(--workspace "$WS")
for w in ${WATCH[@]+"${WATCH[@]}"}; do ARGS+=(--watch "$w"); done
[ -n "$ENC" ] && ARGS+=(--encoder "$ENC")
[ $DRY = 1 ] && ARGS+=(--dry-run)
RES="$(node "$INIT" ${ARGS[@]+"${ARGS[@]}"})"
E=$(echo "$RES" | json error); [ -n "$E" ] && { err "$E"; exit 1; }
echo "$RES" | json actions | while IFS= read -r l; do case "$l" in would\ *) plan "${l#would }" ;; *) dim "  $l" ;; esac; done
WSNOW=$(echo "$RES" | json workspace)

# ---------- Claude: MCP server, skill, global rule
MCP="$HUB/server/mcp.js"
if [ $DRY = 1 ]; then plan "register the MCP server: claude mcp add --scope user videohub -- node \"$MCP\"  (or write it into ~/.claude.json)"
else
  REG=1
  if [ -n "$CLAUDE" ]; then "$CLAUDE" mcp remove videohub --scope user >/dev/null 2>&1; "$CLAUDE" mcp add --scope user videohub -- "$(command -v node)" "$MCP" >/dev/null 2>&1; REG=$?; fi
  if [ $REG != 0 ]; then
    CJ="$HOME/.claude.json"; [ -f "$CJ" ] && cp "$CJ" "$CJ.videohub-backup"
    node -e 'const fs=require("fs"),f=process.argv[1];let j={};if(fs.existsSync(f)){try{j=JSON.parse(fs.readFileSync(f,"utf8"))}catch{process.exit(2)}}j.mcpServers=j.mcpServers||{};j.mcpServers.videohub={type:"stdio",command:process.argv[3],args:[process.argv[2]],env:{}};fs.writeFileSync(f,JSON.stringify(j,null,2))' "$CJ" "$MCP" "$(command -v node)"; REG=$?
  fi
  if [ $REG = 0 ]; then ok 'Claude tools (MCP server "videohub") registered; new Claude Code sessions will see the hub_* tools'
  else TODO+=("The MCP server could not be registered: claude mcp add --scope user videohub -- node \"$MCP\""); fi
fi
SK="$CLAUDE_HOME/skills/videohub"
if [ $DRY = 1 ]; then plan "copy skill/videohub to $SK (with {{VIDEOHUB_DIR}} = $HUB)"
else
  mkdir -p "$SK"
  for f in "$HUB/skill/videohub/"*; do [ -f "$f" ] && node -e 'const fs=require("fs");fs.writeFileSync(process.argv[2],fs.readFileSync(process.argv[1],"utf8").split("{{VIDEOHUB_DIR}}").join(process.argv[3]))' "$f" "$SK/$(basename "$f")" "$HUB"; done
  ok "Skill installed: $SK"
fi
CM="$CLAUDE_HOME/CLAUDE.md"
HAS_BLOCK=0; [ -f "$CM" ] && grep -q '<!-- videohub:begin' "$CM" && HAS_BLOCK=1
WANT="$RULE"
if [ "$WANT" = ask ] && [ $HAS_BLOCK = 1 ]; then WANT=yes; elif [ "$WANT" = ask ] && [ "$A_RULE" = no ]; then WANT=no; fi
if [ "$WANT" = ask ]; then
  q 'Should Claude show you every new film in VideoHub before it renders?'
  say '  This adds a short rule to your Claude instructions (~/.claude/CLAUDE.md): Claude opens each new film in'
  say "  VideoHub's live preview and waits for your notes before making the video. uninstall.sh removes it again."
  if yesno '  Add the rule?' ask 1; then WANT=yes; else WANT=no; fi
fi
A_RULE=$WANT
if [ "$WANT" = yes ]; then
  if [ $DRY = 1 ]; then plan "write the VideoHub rule block into $CM (replacing an older VideoHub block if there is one)"
  else
    mkdir -p "$CLAUDE_HOME"; [ -f "$CM" ] && cp "$CM" "$CM.videohub-backup"
    node -e '
const fs=require("fs"),[cm,ruleF,hub]=process.argv.slice(1);
const b="<!-- videohub:begin (added by VideoHub setup; remove with uninstall.sh) -->",e="<!-- videohub:end -->";
const block=b+"\n"+fs.readFileSync(ruleF,"utf8").split("{{VIDEOHUB_DIR}}").join(hub).trim()+"\n"+e;
const cur=fs.existsSync(cm)?fs.readFileSync(cm,"utf8"):"",rx=/<!-- videohub:begin[\s\S]*?<!-- videohub:end -->/;
fs.writeFileSync(cm, rx.test(cur)?cur.replace(rx,()=>block):cur.trim()?cur.trimEnd()+"\n\n"+block+"\n":block+"\n");' "$CM" "$HUB/claude/global-rule.md" "$HUB"
    ok "Global rule added to $CM (backup: CLAUDE.md.videohub-backup)"
  fi
else say 'Global rule skipped (run setup again with --global-rule yes to add it later).'; fi

# ---------- the VideoHub app (~/Applications/VideoHub.app, Spotlight and Launchpad find it) + Desktop alias
APPDIR="$HOME/Applications/VideoHub.app"; DESK="$HOME/Desktop/VideoHub"
if [ "$SHORTCUT" != ask ]; then WANTAPP=$SHORTCUT; elif [ -e "$DESK" ]; then WANTAPP=yes; elif [ "$A_SHORT" = no ]; then WANTAPP=no
else q 'A VideoHub app (in ~/Applications, with a Desktop shortcut) opens VideoHub with a double-click.'; yesno '  Make the app and shortcut?' ask 1 && WANTAPP=yes || WANTAPP=no; fi
A_SHORT=$WANTAPP
if [ "$WANTAPP" = yes ]; then
  if [ $DRY = 1 ]; then plan "create $APPDIR (runs $HUB/open.sh) and the Desktop shortcut $DESK"
  else
    rm -rf "$APPDIR"; mkdir -p "$HOME/Applications"
    /usr/bin/osacompile -o "$APPDIR" -e "do shell script quoted form of \"$HUB/open.sh\" & \" >/dev/null 2>&1 &\"" >/dev/null
    /usr/bin/defaults write "$APPDIR/Contents/Info" CFBundleIdentifier com.videohub.app 2>/dev/null
    if [ -f "$HUB/scripts/make-icon.mjs" ] && node "$HUB/scripts/make-icon.mjs" "$APPDIR/Contents/Resources/applet.icns" >/dev/null 2>&1; then
      /usr/bin/plutil -remove CFBundleIconName "$APPDIR/Contents/Info.plist" 2>/dev/null; rm -f "$APPDIR/Contents/Resources/Assets.car"   # else macOS shows the stock script icon from Assets.car
      /usr/bin/codesign --force --deep --sign - "$APPDIR" >/dev/null 2>&1; touch "$APPDIR"
    fi
    ln -sfn "$APPDIR" "$DESK"
    ok "VideoHub app: $APPDIR  (Desktop shortcut: $DESK)"
  fi
fi

# ---------- start at log-in (a LaunchAgent that starts the server without a window)
PLIST="$HOME/Library/LaunchAgents/com.videohub.hub.plist"
HASRUN=0; [ -f "$PLIST" ] && HASRUN=1
if [ "$STARTUP" != ask ]; then WANTRUN=$STARTUP; elif [ $HASRUN = 1 ]; then WANTRUN=yes; elif [ -n "$A_START" ]; then WANTRUN=$A_START
else q "VideoHub can start quietly when you log in (no window), so Claude's tools and the render queue are always ready."; yesno '  Start VideoHub when you log in?' ask 0 && WANTRUN=yes || WANTRUN=no; fi
A_START=$WANTRUN
if [ "$WANTRUN" = yes ] && [ $HASRUN = 0 ]; then
  if [ $DRY = 1 ]; then plan "add the LaunchAgent $PLIST"
  else (cd "$HUB" && node --input-type=module -e "import('./server/platform.js').then(m => m.setStartup(true))") && ok 'VideoHub starts when you log in (server only, no window)'; fi
elif [ "$WANTRUN" = yes ]; then ok 'VideoHub starts when you log in (already set).'; fi

# ---------- the example film
EXDEST="$WSNOW/films/hello-film"; EXHAVE=0; [ -f "$EXDEST/index.html" ] && EXHAVE=1
if [ "$EXAMPLE" != ask ]; then WANTEX=$EXAMPLE; elif [ $EXHAVE = 1 ] || [ -n "$A_EX" ]; then WANTEX=no
else q 'Add the example film so you can try VideoHub right away? (a 10-second film; delete it whenever you like)'; yesno '  Add it?' ask 1 && WANTEX=yes || WANTEX=no; fi
if [ -z "$A_EX" ]; then if [ "$WANTEX" = yes ] || [ $EXHAVE = 1 ]; then A_EX=yes; else A_EX=no; fi; fi
if [ "$WANTEX" = yes ]; then
  if [ $DRY = 1 ]; then plan "copy examples/hello-film into $WSNOW/films (unless it is there already)"
  else
    EX="$(node "$INIT" --example 2>/dev/null)"
    if [ -n "$(echo "$EX" | json error)" ]; then warn "The example film could not be added: $(echo "$EX" | json error)  (the Welcome panel in VideoHub offers it too)"
    elif [ "$(echo "$EX" | json kept)" = true ]; then ok "The example film is already there: $(echo "$EX" | json target)"
    else ok "Example film added: $(echo "$EX" | json path)"; fi
  fi
fi

if [ $DRY = 1 ]; then plan "remember the answers in $ANSWERS"
else mkdir -p "$HUB/data"; node -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify({globalRule:process.argv[2],shortcut:process.argv[3],startup:process.argv[4],example:process.argv[5]},null,1))' "$ANSWERS" "$A_RULE" "$A_SHORT" "$A_START" "$A_EX"; fi

echo; head_ '== Done. What now:'
say "  Your video work lives in  $WSNOW  (films, outputs, sounds, thumbnails, archive; README.txt says what each is)."
if [ "$WANTAPP" = yes ]; then say '  Open VideoHub with the VideoHub app (Desktop shortcut, Spotlight or ~/Applications).'; else say "  Open VideoHub: double-click open.sh in $HUB (or run it in Terminal)"; fi
say '  Start a NEW Claude Code session (sessions already open do not see VideoHub'"'"'s tools).'
if [ "$WANTEX" = yes ] || [ $EXHAVE = 1 ]; then say '  First thing to try: click the "hello-film" card in VideoHub, press Space to play it, click a frame to leave a note.'
else say '  First thing to try: ask Claude Code "make me a 10-second animated title as a VideoHub film" and watch it appear in VideoHub.'; fi
[ $DRY = 1 ] && { echo; warn 'Dry run finished: nothing outside this folder was changed.'; }
if [ ${#TODO[@]} -gt 0 ]; then echo; warn 'Left for you to do:'; for t in "${TODO[@]}"; do warn " - $t"; done; fi
exit 0
