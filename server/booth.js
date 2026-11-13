// Voice booth: the user records a performance of a line in VideoHub; Seed-VC turns it into the character's voice.
// Takes live in <workspace>/voice-booth (takes.json + takes/<id>.*). The cast folder (config.booth.castDir, default
// ~/ComingSoonInc) gives the episodes (<ep>/<lang>/lines.json = [[lid, char, text]], current voices in
// <lang>/voices/<lid>_<char>.wav) and the characters (voices/<char>/ref-<lang>.wav). Conversions run one at a time.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { config, baseDir } from './config.js';
import { HOME, TOOLS, readJson, writeJson, run, now, isInside } from './util.js';
import { toTrash } from './platform.js';

const opts = () => config().booth || {};
export const castDir = () => opts().castDir || path.join(HOME, 'ComingSoonInc');
const seedDir = () => opts().seedVcDir || path.join(HOME, 'tools', 'seed-vc');
// performance matching (the default): OmniVoice makes many takes in the locked voice, the one closest to the user's
// delivery wins, then it is re-timed to the user's rhythm (castDir/tools/booth_match.py)
const matchPy = () => opts().matchPython || path.join(HOME, 'tools', 'omnivoice-env', '.venv', 'bin', 'python');
const matchScript = () => opts().matchScript || path.join(castDir(), 'tools', 'booth_match.py');
export const METHODS = ['match', 'seedvc'];
export const boothDir = () => path.join(baseDir(), 'voice-booth');
const takesDir = () => path.join(boothDir(), 'takes');
const indexFile = () => path.join(boothDir(), 'takes.json');
const LANGS = ['hi', 'en'];
const SAFE = /^[\w.-]+$/;
const bad = (msg, code = 400) => Object.assign(new Error(msg), { code });

const subs = new Set();
export const onBooth = fn => { subs.add(fn); return () => subs.delete(fn); };
const emit = ev => { for (const f of subs) try { f(ev); } catch { } };

// ---------- the cast folder: episodes and characters
const EP_PARENTS = () => ['episodes', 'season1'].map(d => path.join(castDir(), d));
export function episodes() {
  const out = [];
  for (const parent of EP_PARENTS()) {
    let names = []; try { names = fs.readdirSync(parent).filter(n => fs.statSync(path.join(parent, n)).isDirectory()).sort(); } catch { }
    for (const n of names) {
      const langs = LANGS.filter(l => fs.existsSync(path.join(parent, n, l, 'lines.json')));
      if (langs.length) out.push({ id: n, dir: path.join(parent, n), langs });
    }
  }
  return out;
}
export function characters() {
  const root = path.join(castDir(), 'voices'); let names = [];
  try { names = fs.readdirSync(root).filter(n => SAFE.test(n) && LANGS.some(l => fs.existsSync(path.join(root, n, `ref-${l}.wav`)))).sort(); } catch { }
  return names.map(n => ({ id: n, refs: Object.fromEntries(LANGS.map(l => [l, path.join(root, n, `ref-${l}.wav`)]).filter(([, f]) => fs.existsSync(f))) }));
}
function epById(id) { const e = episodes().find(x => x.id === id); if (!e) throw bad('No such episode: ' + id, 404); return e; }
export function lines(epId, lang) {
  const e = epById(epId); if (!e.langs.includes(lang)) throw bad(`Episode ${epId} has no ${lang} lines`, 404);
  const raw = readJson(path.join(e.dir, lang, 'lines.json'), []) || [];
  return raw.map(([lid, char, text]) => {
    const voice = path.join(e.dir, lang, 'voices', `${lid}_${char}.wav`);
    return { lid: String(lid), char, text, voice: fs.existsSync(voice) ? voice : null };
  });
}
export function refFor(char, lang) {
  const c = characters().find(x => x.id === char); if (!c) throw bad('No voice reference for character: ' + char, 404);
  return c.refs[lang] || Object.values(c.refs)[0];
}

// ---------- takes
let takes = null;
const load = () => (takes ??= readJson(indexFile(), []) || []);
const save = () => writeJson(indexFile(), takes);
export const list = () => load().slice();
export const get = id => load().find(t => t.id === id) || null;
const newId = () => new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + crypto.randomBytes(2).toString('hex');
const durOf = async f => { const r = await run(TOOLS.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nk=1:nw=1', f]); return +(+r.stdout.trim() || 0).toFixed(2); };

// POST body: { audio: base64, mime, ep?, lang, lid?, char, text?, note?, convert? }
export async function addTake(b) {
  if (!b.audio) throw bad('no audio');
  if (!b.char || !SAFE.test(b.char)) throw bad('character is required');
  if (b.lang && !LANGS.includes(b.lang)) throw bad('lang must be hi or en');
  let line = null;
  if (b.ep) { line = lines(b.ep, b.lang).find(l => l.lid === String(b.lid)); if (!line) throw bad(`No line ${b.lid} in ${b.ep}/${b.lang}`, 404); }
  fs.mkdirSync(takesDir(), { recursive: true });
  const id = newId(), ext = /mp4|m4a|aac/.test(b.mime || '') ? 'm4a' : /ogg/.test(b.mime || '') ? 'ogg' : /wav/.test(b.mime || '') ? 'wav' : 'webm';
  const raw = path.join(takesDir(), `${id}.raw.${ext}`), wav = path.join(takesDir(), `${id}.wav`);
  fs.writeFileSync(raw, Buffer.from(b.audio, 'base64'));
  // mono 44.1 kHz, the silence before the first word and after the last one cut off (the click of the button too)
  const trim = 'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.12';
  const r = await run(TOOLS.ffmpeg, ['-y', '-v', 'error', '-i', raw, '-ac', '1', '-ar', '44100', '-af', `highpass=f=70,${trim},areverse,${trim},areverse`, wav]);
  if (r.code !== 0 || !fs.existsSync(wav)) throw bad('Could not read the recording: ' + r.stderr.trim().slice(-300), 500);
  const t = { id, at: now(), ep: b.ep || null, lang: b.lang || 'hi', lid: line ? line.lid : null, char: b.char, text: line ? line.text : (b.text || ''), note: (b.note || '').trim(),
    file: wav, raw, dur: await durOf(wav), original: line?.voice || null, conversions: [], status: 'new', reply: '' };
  load().push(t); save(); emit({ type: 'take', take: t });
  if (b.convert !== false) convert(id, b.char, { method: t.text ? 'match' : 'seedvc' });
  return t;
}
export function updateTake(id, b) {
  const t = get(id); if (!t) throw bad('No such take: ' + id, 404);
  if (b.note != null) t.note = String(b.note);
  if (b.status && ['new', 'claude', 'used', 'rejected'].includes(b.status)) t.status = b.status;
  if (b.reply != null) t.reply = String(b.reply);
  save(); emit({ type: 'take', take: t }); return t;
}
// the version the user picked for a line (radio buttons): one per line; file null clears it
export function kindOf(t, file) {
  if (file === t.file) return 'your recording';
  for (const c of t.conversions) {
    if ((c.method || 'seedvc') === 'match' && file === c.file) return `${c.char} matched, re-timed to you`;
    if (file === c.pick) return `${c.char} matched, untouched best take`;
    if ((c.method || 'seedvc') === 'seedvc' && file === c.file) return `${c.char} Seed-VC`;
  }
  return null;
}
export function choose(id, file) {
  const t = get(id); if (!t) throw bad('No such take: ' + id, 404);
  const kind = file ? kindOf(t, file) : null; if (file && !kind) throw bad('Not a file of this take');
  const same = x => x.id === t.id || (t.ep && x.ep === t.ep && x.lang === t.lang && x.lid === t.lid);
  for (const x of load()) if (same(x) && x.chosen) { x.chosen = null; if (x !== t) emit({ type: 'take', take: x }); }
  t.chosen = file ? { file, kind, at: now() } : null;
  if (file && t.status !== 'new') t.status = 'new';   // a new choice goes to Claude again
  save(); emit({ type: 'take', take: t }); return t;
}
export async function removeTake(id) {
  const t = get(id); if (!t) throw bad('No such take: ' + id, 404);
  const files = [t.file, t.raw, ...t.conversions.flatMap(c => [c.file, c.pick, c.report])].filter(f => f && isInside(f, takesDir()));
  await toTrash(files.filter(f => fs.existsSync(f)));
  takes = load().filter(x => x.id !== id); save(); emit({ type: 'removed', id }); return { ok: true };
}

// ---------- conversions (match / Seed-VC), one at a time
const queue = []; let running = null;
export const busy = () => !!running || queue.length > 0;
export function convert(id, char, o = {}) {
  const t = get(id); if (!t) throw bad('No such take: ' + id, 404);
  const method = METHODS.includes(o.method) ? o.method : 'match';
  if (method === 'match' && !t.text) throw bad('Matching needs the words of the take: this free take has no text. Use Seed-VC.');
  const target = method === 'seedvc' ? (o.target || refFor(char || t.char, t.lang)) : null;
  if (method === 'match') refFor(char || t.char, t.lang);   // the character must have a voice
  const c = { method, char: char || t.char, target, steps: method === 'seedvc' ? Math.max(10, Math.min(100, +o.steps || 30)) : null, n: method === 'match' ? Math.max(4, Math.min(48, +o.n || 24)) : null, state: 'queued', at: now(), file: null, error: null };
  t.conversions = t.conversions.filter(x => !(x.char === c.char && (x.method || 'seedvc') === method && x.state !== 'done'));
  t.conversions.push(c); save(); emit({ type: 'take', take: t });
  queue.push({ t, c }); pump(); return c;
}
async function pump() {
  if (running || !queue.length) return;
  running = queue.shift(); const { t, c } = running;
  c.state = 'running'; c.started = now(); save(); emit({ type: 'take', take: t });
  try { if (c.method === 'match') await runMatch(t, c); else await runSeedVc(t, c); }
  catch (e) { Object.assign(c, { state: 'failed', error: String(e.message || e) }); }
  save(); emit({ type: 'take', take: t }); running = null; pump();
}
// spawn a python, keep the last 4 KB of its output; rejects with the last lines on failure
const runPy = (py, args, cwd) => new Promise((res, rej) => {
  const p = spawn(py, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = ''; p.stdout.on('data', d => { buf = (buf + d).slice(-4000); }); p.stderr.on('data', d => { buf = (buf + d).slice(-4000); });
  p.on('error', rej); p.on('close', code => code === 0 ? res(buf) : rej(new Error(buf.trim().split('\n').filter(l => !/warn/i.test(l)).slice(-3).join(' | '))));
});
// the matcher stays loaded (models take ~15 s to load): one python per hub, started when the booth page opens,
// stopped after 15 min without work so it does not hold the GPU memory while renders run
let worker = null, idleTimer = null;
const WORKER_IDLE_MS = 15 * 60e3;
export function warm() {
  clearTimeout(idleTimer); idleTimer = setTimeout(stopWorker, WORKER_IDLE_MS); idleTimer.unref?.();
  if (worker || !fs.existsSync(matchPy()) || !fs.existsSync(matchScript())) return worker;
  const p = spawn(matchPy(), [matchScript(), '--serve'], { cwd: path.dirname(matchScript()), stdio: ['pipe', 'pipe', 'pipe'] });
  const w = worker = { p, ready: false, job: null, err: '', out: '' };
  p.stderr.on('data', d => { w.err = (w.err + d).slice(-3000); });
  p.stdout.on('data', d => {
    w.out += d; let i;
    while ((i = w.out.indexOf('\n')) >= 0) {
      const line = w.out.slice(0, i); w.out = w.out.slice(i + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.ready) { w.ready = true; continue; }
      const j = w.job; if (!j) continue;
      if (m.partial) j.onPartial(m.partial);
      else if (m.done) { w.job = null; j.res(m.done); }
      else if (m.error) { w.job = null; j.rej(new Error(m.error)); }
    }
  });
  const gone = () => { if (worker === w) worker = null; if (w.job) { const j = w.job; w.job = null; j.rej(new Error('The matcher stopped: ' + w.err.trim().split('\n').filter(l => !/warn/i.test(l)).slice(-2).join(' | '))); } };
  p.on('exit', gone); p.on('error', gone);
  return w;
}
function stopWorker() { if (worker && !worker.job) { try { worker.p.kill(); } catch { } worker = null; } }
async function runMatch(t, c) {
  const w = warm(); if (!w) throw new Error('Matching needs OmniVoice and ' + matchScript());
  const base = path.join(takesDir(), `${t.id}.${c.char}.${Date.now().toString(36).slice(-4)}`);
  const done = rep => Object.assign(c, { file: rep.shaped || rep.pick, pick: rep.pick, report: base + '.json', best: rep.best, tried: rep.tried });
  const rep = await new Promise((res, rej) => {
    w.job = { res, rej, onPartial: r => { done(r); c.partial = true; save(); emit({ type: 'take', take: t }); } };
    w.p.stdin.write(JSON.stringify({ id: t.id, take: t.file, char: c.char, lang: t.lang, text: t.text, out: base, n: c.n }) + '\n');
  });
  done(rep); Object.assign(c, { state: 'done', partial: false, dur: await durOf(c.file), done: now() });
  warm();   // restart the idle clock
}
async function runSeedVc(t, c) {
  const py = path.join(seedDir(), '.venv', 'bin', 'python'), outDir = path.join(takesDir(), '.vc-' + t.id);
  if (!fs.existsSync(py)) throw new Error('Seed-VC not found at ' + seedDir());
  fs.rmSync(outDir, { recursive: true, force: true });
  const log = await runPy(py, ['inference.py', '--source', t.file, '--target', c.target, '--output', outDir, '--diffusion-steps', String(c.steps), '--fp16', 'False'], seedDir());
  const made = fs.readdirSync(outDir).find(f => f.endsWith('.wav')); if (!made) throw new Error('Seed-VC wrote no file. ' + log.slice(-300));
  const out = path.join(takesDir(), `${t.id}.${c.char}.vc${c.steps !== 30 ? '-s' + c.steps : ''}.wav`);
  // same loudness as the other takes so A/B listening is fair
  const r = await run(TOOLS.ffmpeg, ['-y', '-v', 'error', '-i', path.join(outDir, made), '-af', 'loudnorm=I=-18:TP=-1.5:LRA=11', '-ar', '44100', out]);
  if (r.code !== 0) fs.copyFileSync(path.join(outDir, made), out);
  fs.rmSync(outDir, { recursive: true, force: true });
  Object.assign(c, { state: 'done', file: out, dur: await durOf(out), done: now() });
}

// files the booth serves: its own takes and the cast's voices (references and current line voices)
export function boothFile(p) { return isInside(p, boothDir()) || (isInside(p, castDir()) && /\.(wav|mp3|m4a)$/i.test(p)); }

// the message for "Send to Claude": the chosen versions, else every new take
export function prompt() {
  const fresh = load().filter(t => t.status === 'new'), chosen = fresh.filter(t => t.chosen);
  if (!fresh.length) return { text: '', n: 0 };
  const where = t => t.ep ? `${t.ep} ${t.lang} line ${t.lid} (${t.char})` : `free take (${t.char})`;
  const text = chosen.length
    ? `VideoHub Voice booth: I picked ${chosen.length} version${chosen.length === 1 ? '' : 's'}: ${chosen.map(t => `${where(t)} = ${t.chosen.kind}`).join('; ')}. Get them with hub_takes.`
    : `VideoHub Voice booth: ${fresh.length} new take${fresh.length === 1 ? '' : 's'} (${[...new Set(fresh.map(where))].join(', ')}), nothing picked yet. Get them with hub_takes.`;
  return { n: chosen.length || fresh.length, text };
}
export function routes(route, readBody) {
  route('GET', '/api/booth', () => { warm(); return ({ dir: boothDir(), cast: castDir(), episodes: episodes(), characters: characters(), takes: list(), busy: busy() }); });
  route('GET', '/api/booth/lines', (req, url) => lines(url.searchParams.get('ep'), url.searchParams.get('lang')));
  route('POST', '/api/booth/take', async req => addTake(await readBody(req)));
  route('POST', '/api/booth/take/:id', async (req, url, { id }) => updateTake(id, await readBody(req)));
  route('POST', '/api/booth/take/:id/convert', async (req, url, { id }) => { const b = await readBody(req); return convert(id, b.char, b); });
  route('POST', '/api/booth/take/:id/choose', async (req, url, { id }) => choose(id, (await readBody(req)).file || null));
  route('POST', '/api/booth/take/:id/remove', (req, url, { id }) => removeTake(id));
  route('POST', '/api/booth/prompt', () => prompt());
}
