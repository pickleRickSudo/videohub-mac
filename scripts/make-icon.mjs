// Draws VideoHub's app icon (a golden play button on a dark rounded square) and writes it as an .icns file.
// No packages: the picture is computed pixel by pixel (4x4 supersampling), written as PNGs with zlib, and macOS's own
// `iconutil` packs them. Usage: node scripts/make-icon.mjs <out.icns> [--png <preview.png>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';

const mix = (a, b, t) => a.map((x, i) => x + (b[i] - x) * t);
const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
// vertical gold ramp: light top, rich middle, deep bottom
const ramp = (stops, t) => { t = clamp(t); for (let i = 1; i < stops.length; i++) if (t <= stops[i][0]) return mix(stops[i - 1][1], stops[i][1], (t - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0])); return stops.at(-1)[1]; };
const GOLD = [[0, hex('#fff3b0')], [0.35, hex('#ffd54a')], [0.7, hex('#e0a516')], [1, hex('#9a6a08')]];
const GOLD_RIM = [[0, hex('#ffe680')], [0.5, hex('#c98f0c')], [1, hex('#fff0a0')]];   // the bevel: light at the bottom edge too
const BG = [[0, hex('#3a2e20')], [1, hex('#0e0a06')]];

const sdRoundBox = (x, y, hw, r) => { const qx = Math.abs(x) - hw + r, qy = Math.abs(y) - hw + r; return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r; };
function sdTriangle(px, py, A, B, C) {   // iq's exact triangle distance
  const e0 = [B[0] - A[0], B[1] - A[1]], e1 = [C[0] - B[0], C[1] - B[1]], e2 = [A[0] - C[0], A[1] - C[1]];
  const v0 = [px - A[0], py - A[1]], v1 = [px - B[0], py - B[1]], v2 = [px - C[0], py - C[1]];
  const d = (v, e) => { const t = clamp((v[0] * e[0] + v[1] * e[1]) / (e[0] * e[0] + e[1] * e[1])); return [v[0] - e[0] * t, v[1] - e[1] * t]; };
  const p0 = d(v0, e0), p1 = d(v1, e1), p2 = d(v2, e2);
  const s = Math.sign(e0[0] * e2[1] - e0[1] * e2[0]);
  const q = [[p0[0] * p0[0] + p0[1] * p0[1], s * (v0[0] * e0[1] - v0[1] * e0[0])], [p1[0] * p1[0] + p1[1] * p1[1], s * (v1[0] * e1[1] - v1[1] * e1[0])], [p2[0] * p2[0] + p2[1] * p2[1], s * (v2[0] * e2[1] - v2[1] * e2[0])]];
  const dd = Math.min(q[0][0], q[1][0], q[2][0]), sg = Math.min(q[0][1], q[1][1], q[2][1]);
  return -Math.sqrt(dd) * Math.sign(sg);
}

// colour + alpha at (u, v) in 0..1 (y down). Layers are composited over each other, bottom first.
const TRI = [[0.425, 0.355], [0.425, 0.645], [0.675, 0.5]];
function shade(u, v) {
  let c = [0, 0, 0], a = 0;
  const over = (col, al) => { if (al <= 0) return; const na = al + a * (1 - al); c = c.map((x, i) => (col[i] * al + x * a * (1 - al)) / na); a = na; };
  const x = u - 0.5, y = v - 0.5;
  // the tile: macOS icon proportions (an 824/1024 rounded square)
  const dt = sdRoundBox(x, y, 0.402, 0.18);
  const tileA = 1 - smooth(-0.0015, 0.0015, dt);
  if (tileA <= 0) return [0, 0, 0, 0];
  over(ramp(BG, (y + 0.4) / 0.8), tileA);
  over([1, 0.85, 0.4], tileA * 0.10 * smooth(0.12, 0.0, Math.abs(dt + 0.004)) * smooth(0.1, -0.3, y));   // faint top edge light
  // soft shadow under the disc
  const ds = Math.hypot(x, y - 0.03) - 0.315;
  over([0, 0, 0], tileA * 0.45 * (1 - smooth(-0.02, 0.07, ds)));
  // the gold disc: rim, then the face
  const r = Math.hypot(x, y), AA = 0.0015;
  over(ramp(GOLD_RIM, (y + 0.32) / 0.64), tileA * (1 - smooth(-AA, AA, r - 0.315)));
  const face = tileA * (1 - smooth(-AA, AA, r - 0.282));
  over(ramp(GOLD, (y + 0.28) / 0.56), face);
  // gloss: a light cap over the top half of the face
  const gl = Math.hypot((x) / 0.24, (y + 0.17) / 0.12);
  over([1, 0.98, 0.85], face * 0.32 * (1 - smooth(0.85, 1, gl)));
  // the play triangle: dark gold-brown, slightly rounded
  const dtri = sdTriangle(u, v, TRI[0], TRI[1], TRI[2]) - 0.018;
  // a thin light edge just below the triangle: the engraved look
  const dtri2 = sdTriangle(u, v - 0.007, TRI[0], TRI[1], TRI[2]) - 0.018;
  over([1, 0.95, 0.65], face * 0.7 * (1 - smooth(-AA, AA, dtri2)));
  over(ramp([[0, hex('#5a3a02')], [1, hex('#2c1a00')]], (v - 0.33) / 0.34), face * (1 - smooth(-AA, AA, dtri)));
  return [...c, a];
}

function render(size, ss = 4) {
  const px = Buffer.alloc(size * size * 4);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sj = 0; sj < ss; sj++) for (let si = 0; si < ss; si++) {
      const [cr, cg, cb, ca] = shade((i + (si + 0.5) / ss) / size, (j + (sj + 0.5) / ss) / size);
      r += cr * ca; g += cg * ca; b += cb * ca; a += ca;
    }
    const n = ss * ss, o = (j * size + i) * 4;
    px[o] = a ? Math.round(255 * r / a) : 0; px[o + 1] = a ? Math.round(255 * g / a) : 0; px[o + 2] = a ? Math.round(255 * b / a) : 0; px[o + 3] = Math.round(255 * a / n);
  }
  return px;
}

const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = buf => { let c = -1; for (const b of buf) c = crcT[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => { const t = Buffer.from(type), len = Buffer.alloc(4), cr = Buffer.alloc(4); len.writeUInt32BE(data.length); cr.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, cr]); };
function png(size, px) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let j = 0; j < size; j++) { raw[j * (size * 4 + 1)] = 0; px.copy(raw, j * (size * 4 + 1) + 1, j * size * 4, (j + 1) * size * 4); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const args = process.argv.slice(2);
const previewAt = args.indexOf('--png');
const out = args.find((a, i) => !a.startsWith('--') && (previewAt < 0 || i !== previewAt + 1));
if (previewAt >= 0) fs.writeFileSync(args[previewAt + 1], png(512, render(512)));
if (out) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-icon-')), set = path.join(dir, 'VideoHub.iconset');
  fs.mkdirSync(set);
  const cache = new Map(), at = s => { if (!cache.has(s)) cache.set(s, png(s, render(s))); return cache.get(s); };
  for (const s of [16, 32, 128, 256, 512]) { fs.writeFileSync(path.join(set, `icon_${s}x${s}.png`), at(s)); fs.writeFileSync(path.join(set, `icon_${s}x${s}@2x.png`), at(s * 2)); }
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  const r = spawnSync('/usr/bin/iconutil', ['-c', 'icns', set, '-o', path.resolve(out)], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  if (r.status !== 0) { console.error('iconutil failed: ' + (r.stderr || r.error?.message || r.status)); process.exit(1); }
}
if (!out && previewAt < 0) { console.error('usage: node scripts/make-icon.mjs <out.icns> [--png preview.png]'); process.exit(2); }
