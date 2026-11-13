// Shared helpers: paths, JSON files, child processes, ffprobe with a cache.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const HUB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// VIDEOHUB_DATA_DIR: npm test keeps its config, caches and queue out of the install's own data folder
export const DATA_DIR = process.env.VIDEOHUB_DATA_DIR ? path.resolve(process.env.VIDEOHUB_DATA_DIR) : path.join(HUB_DIR, 'data');
export const HOME = os.homedir();
export const DESKTOP = (() => {
  // OneDrive can move the Desktop; prefer the one that exists
  for (const d of [path.join(HOME, 'Desktop'), path.join(HOME, 'OneDrive', 'Desktop'), path.join(HOME, 'OneDrive', 'Masa\u00fcst\u00fc')]) if (fs.existsSync(d)) return d;
  return path.join(HOME, 'Desktop');
})();
export const DOCUMENTS = (() => {
  for (const d of [path.join(HOME, 'Documents'), path.join(HOME, 'OneDrive', 'Documents')]) if (fs.existsSync(d)) return d;
  return path.join(HOME, 'Documents');
})();
// macOS port: per-user app settings live in ~/Library/Application Support (the Windows build used %APPDATA%)
export const APPDATA = process.env.VIDEOHUB_APPDATA || path.join(HOME, 'Library', 'Application Support');
export const TEMP = os.tmpdir();
fs.mkdirSync(DATA_DIR, { recursive: true });

export const idOf = p => crypto.createHash('sha1').update(path.resolve(p).toLowerCase()).digest('hex').slice(0, 12);
export const norm = p => path.resolve(p).toLowerCase();
// Folders that were moved can leave junctions at their old paths, so compare real paths (cached)
const realCache = new Map();
// a path that does not exist yet: the real path of its nearest existing folder + the rest (macOS: /var and /tmp are
// symlinks into /private, so a new file in a temp folder must compare against the temp folder's real path)
const realNorm = p => {
  const k = norm(p); let r = realCache.get(k); if (r !== undefined) return r;
  try { r = fs.realpathSync.native(k).toLowerCase(); realCache.set(k, r); return r; } catch { }
  let up = k, rest = '';
  while (path.dirname(up) !== up) { rest = path.join(path.basename(up), rest); up = path.dirname(up); try { return path.join(fs.realpathSync.native(up).toLowerCase(), rest); } catch { } }
  return k;
};
export const isInside = (child, parent) => { const c = realNorm(child), p = realNorm(parent); return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep); };
// does a command line or path refer to a path inside this install? Never by folder name: films live in Documents\VideoHub\films
// and the install folder can have any name (a GitHub ZIP unpacks as VideoHub-main). Case-insensitive, both slash styles.
const slashes = s => String(s || '').toLowerCase().replace(/[\\/]+/g, '/');
export const refersToHub = (s, hub = HUB_DIR) => new RegExp(slashes(hub).replace(/\/$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:/|["\'\\s]|$)').test(slashes(s));
export const shortPath = p => (isInside(p, DESKTOP) ? path.relative(DESKTOP, p) : isInside(p, HOME) ? '~/' + path.relative(HOME, p) : p) || p;

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
}
// write via a temp file so readers never see half a file
export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
}

export function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 64 << 20, ...opts }, (err, stdout, stderr) =>
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

// AppleScript through osascript (the macOS stand-in for the Windows build's PowerShell helper); args reach the script's
// `on run argv` handler, so paths never need quoting inside the script
export function osascript(script, args = [], opts = {}) {
  return run('/usr/bin/osascript', ['-e', script, ...args.map(String)], opts);
}

export async function pLimit(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

// ---------- tools on this PC
function which(name, extra = []) {
  const dirs = (process.env.PATH || '').split(path.delimiter).concat(extra);
  for (const d of dirs) { const f = path.join(d, name); if (d && fs.existsSync(f)) return f; }
  return null;
}
// Homebrew (Apple Silicon and Intel) and MacPorts folders are added because apps started from Finder / launchd get a
// short PATH without them
const BREW = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin'];
// render scripts and commands the hub starts inherit this PATH (a hub started at login by launchd has only /usr/bin:/bin)
{ const have = (process.env.PATH || '').split(':'); process.env.PATH = [...have, ...BREW.filter(d => !have.includes(d) && fs.existsSync(d))].filter(Boolean).join(':'); }
const app = (...names) => names.flatMap(n => ['/Applications', path.join(HOME, 'Applications')].map(d => path.join(d, n))).find(f => fs.existsSync(f)) || null;
export const TOOLS = {
  ffmpeg: which('ffmpeg', BREW) || 'ffmpeg',
  ffprobe: which('ffprobe', BREW) || 'ffprobe',
  node: process.execPath,
  edge: app('Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
  chrome: app('Google Chrome.app/Contents/MacOS/Google Chrome', 'Chromium.app/Contents/MacOS/Chromium', 'Brave Browser.app/Contents/MacOS/Brave Browser'),
};

// ---------- ffprobe with a persistent cache (path + size + mtime)
const PROBE_CACHE = path.join(DATA_DIR, 'probe-cache.json');
let probeCache = readJson(PROBE_CACHE, {});
let probeDirty = false;
export function flushProbeCache() { if (probeDirty) { writeJson(PROBE_CACHE, probeCache); probeDirty = false; } }
export async function probe(file, st) {
  st = st || fs.statSync(file);
  const key = norm(file), sig = st.size + ':' + Math.round(st.mtimeMs);
  const hit = probeCache[key];
  if (hit && hit.sig === sig) return hit.info;
  const r = await run(TOOLS.ffprobe, ['-v', 'error', '-show_entries', 'format=duration,bit_rate:stream=codec_type,width,height,r_frame_rate', '-of', 'json', file]);
  let info = { ok: false };
  try {
    const j = JSON.parse(r.stdout), v = (j.streams || []).find(s => s.codec_type === 'video');
    const [a, b] = String(v?.r_frame_rate || '0/1').split('/').map(Number);
    info = {
      ok: !!v, dur: +(+j.format?.duration || 0).toFixed(2), bitrate: +j.format?.bit_rate || 0,
      w: v?.width || 0, h: v?.height || 0, fps: b ? Math.round(a / b * 100) / 100 : 0,
      audio: (j.streams || []).some(s => s.codec_type === 'audio'),
    };
  } catch { }
  probeCache[key] = { sig, info }; probeDirty = true;
  return info;
}

// quick content fingerprint for duplicate detection: size + first and last 1 MB
export async function fingerprint(file, size) {
  const fd = await fsp.open(file, 'r');
  try {
    const n = Math.min(size, 1 << 20), a = Buffer.alloc(n), b = Buffer.alloc(n);
    await fd.read(a, 0, n, 0); await fd.read(b, 0, n, Math.max(0, size - n));
    return crypto.createHash('sha1').update(a).update(b).update(String(size)).digest('hex');
  } finally { await fd.close(); }
}

export function processAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

export const fmtGB = b => (b / 1073741824).toFixed(b >= 10 * 1073741824 ? 0 : 1) + ' GB';
export const now = () => new Date().toISOString();
