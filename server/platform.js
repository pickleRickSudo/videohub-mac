// macOS stand-ins for what the Windows build did through Explorer, PowerShell, taskkill and the Recycle Bin.
// Everything here uses tools that ship with macOS (open, ps, kill, renice, taskpolicy, osascript, /usr/bin/trash,
// launchctl), so nothing is compiled or installed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { HOME, HUB_DIR, TOOLS, run, osascript } from './util.js';

const quiet = (cmd, args) => { try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(); } catch { } };

// ---------- Finder: open a file with its default app, show a file selected in its folder, open a folder
export const openInFinder = (target, select = false) => quiet('/usr/bin/open', select ? ['-R', target] : [target]);
export const openUrl = url => quiet('/usr/bin/open', [url]);
// VideoHub's own window: Chrome/Edge in app mode (no tabs, no address bar), else the default browser
export function openAppWindow(url) {
  const exe = TOOLS.chrome || TOOLS.edge;
  if (!exe) return openUrl(url);
  // a separate profile so the app window opens even while the user's own Chrome is running with other flags
  const prof = path.join(HUB_DIR, 'data', 'app-window-profile');
  quiet(exe, ['--app=' + url, '--user-data-dir=' + prof, '--no-first-run', '--no-default-browser-check', '--window-size=1500,950']);
}

// ---------- processes
// every process: { pid, ppid, rss (bytes), cmd }
export async function processList() {
  const r = await run('/bin/ps', ['-axo', 'pid=,ppid=,rss=,comm=']);
  const out = [];
  for (const l of r.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l); if (!m) continue;
    out.push({ pid: +m[1], ppid: +m[2], rss: +m[3] * 1024, cmd: m[4].trim() });
  }
  return out;
}
export async function argsOf(pid) { const r = await run('/bin/ps', ['-o', 'args=', '-p', String(pid)]); return r.stdout.trim(); }
// the pid and all its descendants (root first)
export async function processTree(rootPid, list = null) {
  list = list || await processList();
  const ids = [rootPid]; let n;
  do { n = ids.length; for (const p of list) if (ids.includes(p.ppid) && !ids.includes(p.pid)) ids.push(p.pid); } while (ids.length > n);
  return ids;
}
// the Windows build's `taskkill /T /F`: children first (they would be re-parented to launchd and keep running)
export async function killTree(rootPid, signal = 'SIGKILL') {
  const ids = await processTree(rootPid).catch(() => [rootPid]);
  for (const id of ids.reverse()) { try { process.kill(id, signal); } catch { } }
}

// ---------- the Trash (the Windows build's Recycle Bin). /usr/bin/trash ships with macOS 15+ and keeps "Put Back";
// older macOS: Finder through AppleScript (asks once for Automation permission). Never deletes outright.
// results: [{ path, ok, code, error }] with code 0 ok, -1 failed (same codes the Windows build used)
export async function toTrash(paths) {
  const out = [];
  for (const p of paths) {
    if (!fs.existsSync(p)) { out.push({ path: p, ok: true, code: 0, gone: true }); continue; }
    let r = fs.existsSync('/usr/bin/trash') ? await run('/usr/bin/trash', [p]) : { code: 1 };
    if (r.code !== 0 || fs.existsSync(p)) r = await osascript('on run argv\ntell application "Finder" to delete (POSIX file (item 1 of argv) as alias)\nend run', [p]);
    const ok = !fs.existsSync(p);
    out.push({ path: p, ok, code: ok ? 0 : -1, error: ok ? null : (r.stderr || 'Could not move to the Trash').trim() });
  }
  return out;
}

// ---------- a notification in Notification Center
export function notify(title, text) {
  if (process.env.VIDEOHUB_NO_WINDOW) return;
  try { spawn('/usr/bin/osascript', ['-e', 'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run', String(title), String(text || '')], { detached: true, stdio: 'ignore' }).unref(); } catch { }
}

// ---------- "Start VideoHub when I log in": a LaunchAgent (the Windows build used the HKCU Run key)
export const LAUNCH_LABEL = 'com.videohub.hub';
const PLIST = path.join(HOME, 'Library', 'LaunchAgents', LAUNCH_LABEL + '.plist');
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const startupEnabled = () => fs.existsSync(PLIST);
export async function setStartup(on) {
  if (!on) { await run('/bin/launchctl', ['bootout', `gui/${os.userInfo().uid}`, PLIST]); try { fs.unlinkSync(PLIST); } catch { } return false; }
  const env = { PATH: [...new Set([path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':'), VIDEOHUB_NO_WINDOW: '1' };
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
 <key>Label</key><string>${LAUNCH_LABEL}</string>
 <key>ProgramArguments</key><array><string>${esc(process.execPath)}</string><string>${esc(path.join(HUB_DIR, 'server', 'hub.js'))}</string></array>
 <key>WorkingDirectory</key><string>${esc(HUB_DIR)}</string>
 <key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${k}</key><string>${esc(v)}</string>`).join('')}</dict>
 <key>RunAtLoad</key><true/>
 <key>StandardOutPath</key><string>${esc(path.join(HUB_DIR, 'data', 'hub.log'))}</string>
 <key>StandardErrorPath</key><string>${esc(path.join(HUB_DIR, 'data', 'hub.log'))}</string>
</dict></plist>
`;
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  fs.writeFileSync(PLIST, xml);
  return true;
}

// ---------- memory that programs can still get. os.freemem() on macOS counts only untouched pages (a Mac keeps RAM
// full of cache on purpose), so it reads "almost none free" all day; what matters is free + inactive + speculative +
// purgeable pages (what Activity Monitor's memory pressure is based on). Refreshed in the background, read at once.
let avail = { at: 0, mb: Math.round(os.freemem() / 1048576) }, availBusy = false;
export function availableMB(maxAgeMs = 2500) {
  if (Date.now() - avail.at > maxAgeMs && !availBusy) {
    availBusy = true;
    run('/usr/bin/vm_stat', []).then(r => {
      const page = +(/page size of (\d+)/.exec(r.stdout)?.[1] || 16384), n = k => +(new RegExp('Pages ' + k + ':\\s+(\\d+)').exec(r.stdout)?.[1] || 0);
      const mb = Math.round((n('free') + n('inactive') + n('speculative') + n('purgeable')) * page / 1048576);
      if (r.code === 0 && mb > 0) avail = { at: Date.now(), mb };
    }).finally(() => { availBusy = false; });
  }
  return avail.mb;
}
