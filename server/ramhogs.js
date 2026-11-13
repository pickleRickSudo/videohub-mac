// Programs that hold a lot of RAM next to a render (an Android emulator once held 7.4 GB of a 16 GB PC during a render).
// Renders, macOS itself, the Claude app and VideoHub are left out; nothing is ever closed from here, the user decides.
import { execFile } from 'node:child_process';

// macOS port: the process list comes from `ps` (resident memory per process); a program is grouped by its .app bundle
const NAMES = {
  'google chrome': 'Chrome (browser)', 'microsoft edge': 'Edge (browser)', firefox: 'Firefox', opera: 'Opera', 'brave browser': 'Brave', safari: 'Safari', arc: 'Arc',
  discord: 'Discord', steam: 'Steam', obs: 'OBS', spotify: 'Spotify', telegram: 'Telegram', whatsapp: 'WhatsApp', 'microsoft teams': 'Teams', slack: 'Slack', zoom: 'Zoom',
  code: 'VS Code', 'visual studio code': 'VS Code', cursor: 'Cursor', 'adobe photoshop': 'Photoshop', 'adobe premiere pro': 'Premiere Pro', 'adobe after effects': 'After Effects',
  'davinci resolve': 'DaVinci Resolve', resolve: 'DaVinci Resolve', 'final cut pro': 'Final Cut Pro', capcut: 'CapCut', blender: 'Blender', docker: 'Docker', 'docker desktop': 'Docker',
  'android studio': 'Android Studio', qemu: 'Android emulator', 'qemu-system-aarch64': 'Android emulator', 'utm': 'UTM (virtual machine)', 'parallels desktop': 'Parallels', xcode: 'Xcode', simulator: 'iOS Simulator',
};
// never listed: macOS itself, the Claude app, the render tools themselves
const SKIP = new Set(['kernel_task', 'launchd', 'windowserver', 'finder', 'dock', 'systemuiserver', 'loginwindow', 'mds', 'mds_stores', 'mdworker', 'mdworker_shared',
  'spotlight', 'controlcenter', 'notificationcenter', 'coreaudiod', 'cfprefsd', 'distnoted', 'trustd', 'opendirectoryd', 'logd', 'syslogd', 'powerd', 'bluetoothd',
  'claude', 'node', 'ffmpeg', 'ffprobe', 'osascript', 'ps', 'zsh', 'bash', 'sh', 'login', 'terminal', 'iterm2', 'electron']);
const appOf = cmd => { const m = /\/([^/]+)\.app\//.exec(cmd); return m ? m[1] : null; };
const baseOf = cmd => cmd.split('/').pop();

let cache = { at: 0, list: [] }, running = null;

function scan() {
  return new Promise(resolve => {
    // two lists: comm = the executable path (may hold spaces), args = the full command line (headless/app-window check)
    execFile('/bin/ps', ['-axo', 'pid=,ppid=,rss=,comm='], { maxBuffer: 16 << 20, timeout: 20000 }, (err, out) => {
      if (err) return resolve(null);
      execFile('/bin/ps', ['-axo', 'pid=,args='], { maxBuffer: 16 << 20, timeout: 20000 }, (e2, argsOut) => {
      const args = new Map(); for (const l of String(argsOut || '').split('\n')) { const m = /^\s*(\d+)\s+(.*)$/.exec(l); if (m) args.set(+m[1], m[2]); }
      const rows = [];
      for (const l of String(out).split('\n')) { const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l); if (m) rows.push({ p: +m[1], pp: +m[2], m: +m[3] * 1024, e: m[4].trim(), a: args.get(+m[1]) || m[4] }); }
      const byPid = new Map(rows.map(r => [r.p, r]));
      // a browser process belongs to a headless render (or the VideoHub window) when a process up its tree says so
      const ours = r => { let x = r, k = 0; while (x && k++ < 30) { if (/--headless|--app=http:\/\/127\.0\.0\.1|app-window-profile|videohub/i.test(x.a)) return true; x = byPid.get(x.pp); } return false; };
      const groups = new Map();
      for (const r of rows) {
        const exe = r.e, app = appOf(exe), key = (app || baseOf(exe)).toLowerCase();
        if (!key || SKIP.has(key) || SKIP.has(baseOf(exe).toLowerCase()) || /^\/(System|usr\/(libexec|sbin))\//.test(exe)) continue;
        if (/chrome|edge|brave|chromium/.test(key) && ours(r)) continue;
        const name = NAMES[key] || app || baseOf(exe);
        const g = groups.get(name) || { name, bytes: 0, procs: 0 };
        g.bytes += r.m || 0; g.procs++; groups.set(name, g);
      }
      resolve([...groups.values()].sort((a, b) => b.bytes - a.bytes));
      });
    });
  });
}

// cached list of programs over minBytes; refreshes in the background when older than maxAgeMs
export function ramHogs({ minBytes = 600 * 2 ** 20, maxAgeMs = 30e3 } = {}) {
  if (Date.now() - cache.at > maxAgeMs && !running) running = scan().then(l => { if (l) cache = { at: Date.now(), list: l }; running = null; });
  return cache.list.filter(g => g.bytes >= minBytes);
}

// the same, fresh (waits for a scan up to ~20 s)
export async function ramHogsNow(opts = {}) {
  if (Date.now() - cache.at > 10e3) { if (!running) running = scan().then(l => { if (l) cache = { at: Date.now(), list: l }; running = null; }); await running; }
  return ramHogs({ ...opts, maxAgeMs: 1e9 });
}

const gb = b => (b / 2 ** 30).toFixed(1) + ' GB';
// one sentence for the job log / Claude: big programs only (≥ 1.5 GB), or null
export function ramNote(list, availMB) {
  const big = list.filter(g => g.bytes >= 1.5 * 2 ** 30);
  if (!big.length) return null;
  return `Programs using RAM: ${big.map(g => `${g.name} ${gb(g.bytes)}`).join(', ')}${availMB ? ` (free RAM ${gb(availMB * 2 ** 20)})` : ''}. ` +
    'Closing them during rendering can speed up the render and keep your computer responsive (the user decides what to close).';
}
