# VideoHub

**A local review studio and render queue for videos that Claude Code writes as code.**
You ask Claude Code for a video; it builds the film as a web page that draws every frame in code. VideoHub plays that
film straight from its code — no render — so you can watch it, step through frames, draw on a frame and write what is
wrong. One click sends your notes to Claude, Claude fixes the code, the open preview reloads by itself, and only when
you are happy do you render — once, in a queue that keeps your Mac usable, and later re-rendering only the seconds that
changed. It is for people who make explainers, shorts and animations with Claude Code and are tired of rendering a
whole film to check one fix.

> **macOS port.** This fork runs on macOS (Apple Silicon and Intel) using only tools that ship with the Mac: Finder,
> the Trash, Notification Center, `renice`/`taskpolicy`, LaunchAgents and VideoToolbox. The original project is
> Windows-only: <https://github.com/TensaikunYT/Videohub>. The screenshots are from the Windows build.

![Live preview with a note on a frame](docs/screenshots/review-live-preview.png)

## Features
- **Projects** — every film in your watched folders with its videos, versions, notes and disk use; a live cover for
  films that have no video yet.
- **Live preview, no render** — plays a film from its page (`window.renderOut(t)`), frame-accurate, with its sound,
  scenes and narration on a timeline. Changing the code reloads the open preview in place.
- **Review notes** — click or draw on any frame (or pick a frame range), type what is wrong. **Send to Claude** copies
  a short message; Claude reads the notes (time, frame, chunk, a close-up picture of your drawing) with `hub_notes`.
- **Check fixes** — a tour through the notes Claude marked fixed, with before/after; "Still there" sends one back.
- **Render queue** — one render at a time on the Mac, waits for renders started elsewhere, progress and ETA, a
  render dialog with size/fps/workers/encoder, a copy to any folder, a macOS notification when it is done.
- **Partial re-render** — a film rendered in 2-second chunks re-renders only the chunks your notes touched, joins the
  film again and saves `film_vN.mp4` with the changed ranges; **Watch only the changes** plays just those.
- **Render protection** (optional agent) — see below.
- **Recent renders & outputs folder** — every finished render, newest first; each one also hard-linked into one
  outputs folder (a folder per day, no extra disk space).
- **Disk cleanup** — what can safely go (old chunks, silent copies, browser profiles, check frames, old versions) and
  why; always to the Trash or the archive, never deleted outright, always with your approval.
- **Sound** — mute/solo/levels per stem, remove the music, duck it under a range, add sounds from your library or
  disk on the timeline; renders use the rebuilt mix.
- **Thumbnail Studio** — sketch a thumbnail (posed mannequins, objects, text, camera/depth/light), send the brief to
  Claude, which makes the variants; annotate a variant, add the final text in code.
- **Claude tools (MCP)** — `hub_live`, `hub_notes`, `hub_note_update`, `hub_render`, `hub_job`, `hub_project`, `hub_workspace`,
  `hub_register_version`, `hub_cleanup`, `hub_thumb_*`; the same tools work from a shell (`node server/cli.js`).

![Projects](docs/screenshots/projects.png)

### Render protection and speed
Built into the VideoHub server (plain Node and macOS's own tools, no extra program), it keeps long renders from
freezing the Mac:
- **Low priority** — every render VideoHub starts runs below normal priority, together with the Chrome and ffmpeg
  processes it starts, so the apps you are using always win the processor. (macOS cannot pin a program to a share of
  the cores the way Windows can; the *Full power / Balanced / Quiet* presets switch this priority on and off.)
- **RAM slow mode** — when free RAM falls below a threshold, the newest render drops to the lowest priority and
  macOS's background mode (on Apple Silicon: the efficiency cores only, with throttled disk use) instead of being
  killed; it speeds up again when RAM frees.
- **Slow down / Normal speed / Stop** per render on the Renders page, or for all of them at once.
- **One render at a time**; the Renders page also lists programs holding a lot of RAM (it never closes anything).
- **Partial re-renders** of only the fixed chunks, and per-render workers / encoder and fps options.
- **Faster renders** — the film template reads frames straight from the canvas (lossless, no JPEG) and encodes with
  the Mac's hardware encoder (Apple VideoToolbox) when it can, else x264. Settings → *Render speed*.

![Renders](docs/screenshots/renders.png)

## Requirements
- macOS 13 or newer (Apple Silicon or Intel). macOS 15+ moves files to the Trash with "Put Back"; older versions
  go through Finder and ask once for permission to control it.
- [Node.js 22+](https://nodejs.org) — `brew install node`
- ffmpeg on PATH — `brew install ffmpeg`
  (setup checks both and tells you the exact command if one is missing; then run SETUP.command again)
- Google Chrome (or Microsoft Edge / Chromium / Brave) — renders drive it headless
- [Claude Code](https://claude.com/claude-code) — for the Claude side

## Install
### The easy way: let Claude Code install it
1. `git clone` this repository anywhere you like.
2. Open that folder in [Claude Code](https://claude.com/claude-code) and say: **"Install VideoHub for me."**
3. Claude checks what your Mac has, asks you a few plain questions (where your video work should live, whether to
   use the hardware encoder, whether to add the example film …), then runs the setup once with your answers.
4. Open the **VideoHub** app (Desktop shortcut, Spotlight or `~/Applications`) and start a **new** Claude Code
   session so it sees the tools.

### By hand (3 steps)
1. `git clone` this repository anywhere you like.
2. Double-click **`SETUP.command`** (or run `./setup.sh` in Terminal). It checks the requirements, installs the
   packages, registers the `videohub` MCP server for Claude Code and installs the `videohub` skill, then asks a few
   plain questions — press Enter for the recommended answer:
   - **Where should your video work live?** One workspace folder (default `~/Documents/VideoHub`) with `films`,
     `outputs` (every finished render), `sounds`, `thumbnails` and `archive`, and a `README.txt` saying what each is.
   - Video folders it found on your Desktop / in Documents: watch them too? (default no)
   - Your Mac can encode video in hardware: use it for renders? (default yes; only asked when it can)
   - Add the review-before-render rule to `~/.claude/CLAUDE.md`? · VideoHub app + Desktop shortcut? · Start when
     you log in? (default no) · Add the example film?
   Running it again keeps every answer and never moves or overwrites your folders or settings. `./setup.sh --yes`
   takes every recommended answer, each question also has an option (see the top of `setup.sh`, e.g.
   `--workspace ~/Movies/VideoHub`), and `./setup.sh --dry-run` prints every step without changing anything.
3. Open the **VideoHub** app. Start a new Claude Code session so it sees the tools.

## Your first film
1. If setup added the example film, its card is on the Projects page. Otherwise the page shows **Welcome to
   VideoHub** with your workspace and films folder (`<workspace>/films`): click **▶ Add the example film**.
2. Click its card: it opens in the **live preview**. Press Space, step with ← →, click on the video to leave a note.
3. Press **🎬 Render** → *Full film*: the queue renders 5 two-second chunks and saves `hello-film_v1.mp4` with sound.
4. Leave a note on a frame, change `film.js` (e.g. a colour), then **🎬 Render** → *Only the fixed parts*: only the
   touched chunks are rendered again → `hello-film_v2.mp4`, and **Watch only the changes** plays them.
What a film folder must contain for each feature: [docs/PROJECT-CONTRACT.md](docs/PROJECT-CONTRACT.md). New films start
from [templates/new-film](templates/new-film).

## How working with Claude goes
1. **Ask** Claude Code for a video. It builds the film as code from the template (the `videohub` skill tells it how).
2. **Preview** — when it plays, Claude calls `hub_live`: VideoHub jumps to the film. Claude stops and waits; it does
   not render.
3. **Notes** — you watch, leave notes on frames, press **Send to Claude** and paste the message into the chat.
4. **Fix** — Claude reads them with `hub_notes`, fixes the code (your open preview updates by itself) and marks each
   note fixed with a one-line reply. Repeat 3–4 as often as you like.
5. **Render** — when you say so, Claude renders once through `hub_render` (or you press 🎬 Render). Later fixes
   re-render only the changed chunks. You check them with *Watch only the changes* and the *Check fixes* tour.
If the MCP tools are not loaded in a session, Claude uses `node <VideoHub>/server/cli.js <tool> '<json>'`.

## Optional integrations
| Feature | Needs | Without it |
|---|---|---|
| Ready-made sound effects | a 3D studio engine with `engine/audio/synth.js` (`studioDir` in Settings) | your own sound folder and files from disk |
| Scene editor / 2D layers in the preview | the page includes the hooks from `engine-hooks/` | those editors are hidden |
| Snipp export status | Snipp writing `.renders/*.json` in a watched folder | not shown |
Settings → *Optional parts on this computer* shows what was found.

## Security
VideoHub is a local tool. The server listens on **127.0.0.1 only** and refuses requests with a foreign Host, cross-site
requests from other web pages and writes with a foreign Origin. Its render queue can run shell commands for your
projects, so **never expose port 7788** (no port forwarding, no tunnels, no `0.0.0.0` proxies). It only serves files
inside your watched folders, the archive and its own folders.

## Uninstall
Run `./uninstall.sh` (`--dry-run` first to see what it would do). It stops this install's server and removes the MCP
server, the skill and the rule block it added (only if they belong to this install), the VideoHub app, the Desktop
shortcut and the log-in item. Your films, their notes, the outputs folder and this folder stay; delete them yourself
if you want.

## Troubleshooting
- **The page is blank** — open it in a browser and look at the console; a missing Node 22 or a broken update are the
  usual causes. Restart with the VideoHub app. The server's log is `data/hub.log`.
- **Claude does not see `hub_*` tools** — start a new Claude Code session; `claude mcp list` should show `videohub`.
  Run SETUP.command again if not.
- **"This folder is not a project VideoHub knows"** — put the film inside a watched folder or add its parent folder
  in Settings → Watched folders.
- **"The live preview could not open"** — the page lacks `window.renderOut(t)` / `window.READY`; see
  PROJECT-CONTRACT.md. The message says what is missing.
- **Partial renders refused** — the render script is not chunked (family A) or the film length is unknown:
  `hub_project({set:{render:{env:{DUR:"…"}}}})`.
- **Renders fail at once** — ffmpeg or Chrome missing (Settings → Tools), or `puppeteer-core` missing for a
  film's render script (VideoHub ships one; run `npm install` in VideoHub's folder).
- **Port 7788 is taken** — set `"port"` in `data/config.json`.
- **Coming from an older (Turkish) build** — see [docs/MIGRATING.md](docs/MIGRATING.md).

## Development
`npm test` runs the suites; see [CLAUDE.md](CLAUDE.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License
[MIT](LICENSE) © 2026 VideoHub contributors.
