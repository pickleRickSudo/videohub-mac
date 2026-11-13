#!/bin/bash
# Opens VideoHub: starts the server if it is not running, then an app window (Chrome or Edge in app mode, else the
# default browser). --server: just the server, no window. The server runs the render protection itself.
HUB="$(cd "$(dirname "$0")" && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
PORT=$(/usr/bin/plutil -extract port raw -o - "$HUB/data/config.json" 2>/dev/null || true)
[[ "$PORT" =~ ^[0-9]+$ ]] || PORT=7788
URL="http://127.0.0.1:$PORT"
alive() { /usr/bin/curl -fs -m 1 "$URL/api/ping" >/dev/null 2>&1; }
if ! alive; then
  NODE="$(command -v node)"
  if [ -z "$NODE" ]; then /usr/bin/osascript -e 'display alert "VideoHub" message "Node.js was not found. Run SETUP.command in the VideoHub folder."'; exit 1; fi
  mkdir -p "$HUB/data"
  (cd "$HUB" && nohup "$NODE" server/hub.js >>"$HUB/data/hub.log" 2>&1 &)
  for i in $(seq 1 40); do alive && break; sleep 0.25; done
fi
[ "$1" = "--server" ] && exit 0
for APP in "/Applications/Google Chrome.app" "$HOME/Applications/Google Chrome.app" "/Applications/Microsoft Edge.app" "/Applications/Chromium.app" "/Applications/Brave Browser.app"; do
  if [ -d "$APP" ]; then
    EXE="$APP/Contents/MacOS/$(/usr/bin/defaults read "$APP/Contents/Info" CFBundleExecutable)"
    nohup "$EXE" --app="$URL" --user-data-dir="$HUB/data/app-window-profile" --no-first-run --no-default-browser-check --window-size=1500,950 >/dev/null 2>&1 &
    exit 0
  fi
done
/usr/bin/open "$URL"
