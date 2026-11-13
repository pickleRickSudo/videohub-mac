// Voice booth: pick a line, write the direction, record it (R), hear it in the character's voice (Seed-VC, ~25 s),
// then "Send to Claude". Server side: server/booth.js. Takes are stored in <workspace>/voice-booth.
import { h, api, toast, confirmBox, onHubEvent, AGO } from './app.js';

const LS = 'vh.booth';
const pref = () => { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch { return {}; } };
const setPref = o => { try { localStorage.setItem(LS, JSON.stringify({ ...pref(), ...o })); } catch { } };
const fileUrl = p => '/api/booth/file?p=' + encodeURIComponent(p);
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : '';

// one shared player: pressing another ▶ stops the previous sound
const player = new Audio(); let playingBtn = null;
function playBtn(file, label, cls = '') {
  const b = h('button', { class: 'bth-play ' + cls, disabled: !file, title: file || 'not there' }, '▶ ' + label);
  b.onclick = () => {
    if (playingBtn === b && !player.paused) { player.pause(); return; }
    player.src = fileUrl(file); player.play().catch(e => toast('Cannot play: ' + e.message, true));
    playingBtn?.classList.remove('on'); playingBtn = b; b.classList.add('on');
  };
  return b;
}
player.onpause = player.onended = () => { playingBtn?.classList.remove('on'); };

export async function boothPage(page) {
  page.classList.add('booth');
  let B = await api('/api/booth');
  const p0 = pref();
  let ep = p0.ep && (p0.ep === '~free' || B.episodes.some(e => e.id === p0.ep)) ? p0.ep : (B.episodes.at(-1)?.id || '~free');
  let lang = p0.lang || 'hi', lid = p0.lid || null, lines = [];
  let freeChar = p0.freeChar || B.characters.find(c => c.id === 'iyer')?.id || B.characters[0]?.id;

  // ---------- header
  const epSel = h('select', { onchange: () => { ep = epSel.value; lid = null; setPref({ ep, lid }); loadLines(); } },
    B.episodes.map(e => h('option', { value: e.id, selected: e.id === ep }, e.id)), h('option', { value: '~free', selected: ep === '~free' }, 'Free takes (no line)'));
  const langSel = h('select', { onchange: () => { lang = langSel.value; setPref({ lang }); loadLines(); } }, ['hi', 'en'].map(l => h('option', { value: l, selected: l === lang }, l === 'hi' ? 'Hindi' : 'English')));
  const sendBtn = h('button', { class: 'primary', onclick: send }, 'Send to Claude');
  page.append(
    h('div', { class: 'row' }, h('h1', {}, 'Voice booth'), h('span', { class: 'spacer' }), sendBtn),
    h('div', { class: 'sub' }, 'Perform a line the way you want it. VideoHub makes many takes in the character\'s own voice, keeps the one closest to your delivery and re-times it to your rhythm. Then press Send to Claude.'),
    h('div', { class: 'row', style: { margin: '14px 0 12px' } }, epSel, langSel, h('span', { class: 'dim bth-keys' }, 'R record / stop · Enter save · Esc discard · ↑↓ line')));
  const linesEl = h('div', { class: 'bth-lines panel' }), side = h('div', { class: 'bth-side' });
  page.append(h('div', { class: 'bth-grid' }, linesEl, side));

  // ---------- lines list
  async function loadLines() {
    lines = ep === '~free' ? [] : await api(`/api/booth/lines?ep=${encodeURIComponent(ep)}&lang=${lang}`).catch(e => { toast(e.message, true); return []; });
    if (ep !== '~free' && !lines.some(l => l.lid === lid)) lid = lines[0]?.lid || null;
    drawLines(); drawSide();
  }
  const takesOf = l => B.takes.filter(t => ep === '~free' ? !t.ep && t.lang === lang : t.ep === ep && t.lang === lang && t.lid === l?.lid);
  function drawLines() {
    if (ep === '~free') { linesEl.replaceChildren(h('div', { class: 'empty' }, 'Free takes are not tied to a line: mood samples, a new line, anything. Pick the character on the right.')); return; }
    if (!lines.length) { linesEl.replaceChildren(h('div', { class: 'empty' }, 'No lines.')); return; }
    linesEl.replaceChildren(...lines.map(l => {
      const n = takesOf(l).length;
      return h('div', { class: 'bth-line' + (l.lid === lid ? ' on' : ''), 'data-lid': l.lid, onclick: e => { if (e.target.closest('button')) return; pick(l.lid); } },
        h('span', { class: 'mono dim' }, l.lid), h('span', { class: 'bth-who' }, cap(l.char)), h('span', { class: 'bth-text' }, l.text),
        n ? h('span', { class: 'bth-n', title: n + ' take(s)' }, n) : h('span'), playBtn(l.voice, '', 'ghost'));
    }));
  }
  function pick(id) { if (rec.state !== 'idle') return; lid = id; setPref({ lid }); drawLines(); drawSide(); linesEl.querySelector('.bth-line.on')?.scrollIntoView({ block: 'nearest' }); }

  // ---------- recorder
  const rec = { state: 'idle', stream: null, mr: null, chunks: [], blob: null, mime: '', t0: 0, ctx: null, an: null, raf: 0 };
  const busyMark = h('div', { class: 'booth-rec', hidden: true });   // app.js does not reload the page while this exists
  const setBusy = on => { busyMark.remove(); if (on) page.append(busyMark); };
  // the mic is open only while recording: an open mic makes other apps think a call started (Notion offers to transcribe)
  function releaseMic() { rec.stream?.getTracks().forEach(t => t.stop()); rec.stream = null; rec.ctx?.close().catch(() => { }); rec.ctx = null; rec.an = null; }
  async function micStream() {
    if (rec.stream) return rec.stream;
    rec.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
    rec.ctx = new AudioContext(); rec.an = rec.ctx.createAnalyser(); rec.an.fftSize = 1024;
    rec.ctx.createMediaStreamSource(rec.stream).connect(rec.an);
    return rec.stream;
  }
  // Record: the recorder starts at once (the mic's warm-up is recorded too and trimmed later), waits until real sound
  // comes through, counts 3·2·1, then says "Speak now". Stop keeps 0.35 s more so the last word is not cut.
  const wait = ms => new Promise(r => setTimeout(r, ms));
  async function start() {
    if (rec.state === 'arming') { cancelArm(); return; }
    if (rec.state === 'recording' || rec.state === 'stopping' || rec.state === 'saving') return;
    player.pause(); rec.state = 'arming'; rec.count = 'mic…'; rec.cancelled = false; setBusy(true); drawSide();
    try { await micStream(); } catch (e) { toast('Microphone not available: ' + e.message, true); rec.state = 'idle'; setBusy(false); drawSide(); return; }
    if (rec.cancelled) return;
    rec.mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find(m => window.MediaRecorder?.isTypeSupported?.(m)) || '';
    rec.mr = new MediaRecorder(rec.stream, rec.mime ? { mimeType: rec.mime, audioBitsPerSecond: 192000 } : {});
    rec.chunks = []; rec.mr.ondataavailable = e => e.data.size && rec.chunks.push(e.data);
    rec.mr.onstop = () => { rec.blob = new Blob(rec.chunks, { type: rec.mr.mimeType || rec.mime }); releaseMic(); rec.state = 'review'; drawSide(); };
    rec.mr.start(250); rec.peak = 0; meter();
    // the mic is live once samples stop being exact zeros (at most 1.5 s)
    const buf = new Float32Array(rec.an.fftSize), t0 = performance.now();
    while (performance.now() - t0 < 1500) { rec.an.getFloatTimeDomainData(buf); if (buf.some(v => v !== 0)) break; await wait(30); if (rec.cancelled) return; }
    for (const n of ['3', '2', '1']) { rec.count = n; drawCount(); await wait(330); if (rec.cancelled) return; }
    rec.state = 'recording'; rec.t0 = performance.now(); rec.peak = 0; drawSide();   // the meter loop from arming keeps running
  }
  function cancelArm() { rec.cancelled = true; if (rec.mr && rec.mr.state !== 'inactive') { rec.mr.onstop = null; rec.mr.stop(); } cancelAnimationFrame(rec.raf); releaseMic(); rec.state = 'idle'; setBusy(false); drawSide(); }
  function drawCount() { const c = side.querySelector('.bth-count'); if (c) c.textContent = rec.count; }
  async function stop() {
    if (rec.state === 'arming') return cancelArm();
    if (rec.state !== 'recording') return;
    rec.state = 'stopping'; drawSide(); await wait(350); cancelAnimationFrame(rec.raf); rec.mr.stop();
  }
  function discard() { rec.blob = null; rec.state = 'idle'; setBusy(false); drawSide(); }
  function meter() {
    const buf = new Float32Array(rec.an.fftSize);
    const tick = () => {
      if (!['arming', 'recording', 'stopping'].includes(rec.state) || !rec.an) return;
      rec.an.getFloatTimeDomainData(buf); let pk = 0; for (const v of buf) pk = Math.max(pk, Math.abs(v));
      rec.peak = Math.max(rec.peak, pk);
      const bar = side.querySelector('.bth-meter i'), tm = side.querySelector('.bth-time');
      if (bar) { bar.style.width = Math.min(100, pk * 100) + '%'; bar.classList.toggle('hot', pk > 0.97); }
      if (tm && rec.state === 'recording') tm.textContent = ((performance.now() - rec.t0) / 1000).toFixed(1) + ' s';
      rec.raf = requestAnimationFrame(tick);
    };
    tick();
  }
  async function saveTake(noteEl, convSel) {
    if (!rec.blob) return;
    const line = lines.find(l => l.lid === lid), char = convSel.value;
    const b64 = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(',')[1]); fr.readAsDataURL(rec.blob); });
    rec.state = 'saving'; drawSide();
    try {
      const t = await api('/api/booth/take', { method: 'POST', body: { audio: b64, mime: rec.blob.type, ep: ep === '~free' ? null : ep, lang, lid: line?.lid, char, text: ep === '~free' ? (side.querySelector('.bth-freetext')?.value || '') : undefined, note: noteEl.value } });
      if (!B.takes.some(x => x.id === t.id)) B.takes.push(t);
      setPref({ ['note:' + ep + lang + lid]: '' });
      toast(`Saved. Finding the ${cap(char)} take closest to yours… (~1 min)`);
      if (rec.peak < 0.08) toast('That take was very quiet: move closer to the mic for the next one.', true);
    } catch (e) { toast('Could not save: ' + e.message, true); rec.state = 'review'; drawSide(); return; }
    rec.blob = null; rec.state = 'idle'; setBusy(false); drawSide(); drawLines(); updateSend();
  }

  // ---------- right side: the line, the direction, record, the takes
  function drawSide() {
    const line = lines.find(l => l.lid === lid), free = ep === '~free';
    if (!free && !line) { side.replaceChildren(h('div', { class: 'panel empty' }, 'Pick a line.')); return; }
    const char = free ? freeChar : line.char, key = 'note:' + ep + lang + lid;
    const note = h('textarea', { class: 'bth-note', rows: 2, placeholder: 'Direction for this take (optional): e.g. weary, stress "1998", pause before "process"', oninput: () => setPref({ [key]: note.value }) });
    note.value = pref()[key] || '';
    const convSel = h('select', { title: 'Whose voice the take is turned into' }, B.characters.map(c => h('option', { value: c.id, selected: c.id === char }, cap(c.id))));
    if (free) convSel.onchange = () => { freeChar = convSel.value; setPref({ freeChar }); drawSide(); };
    const s = rec.state;
    const recBtn = h('button', { class: 'bth-rec' + (s === 'recording' ? ' on' : ''), disabled: s === 'saving' || s === 'stopping', onclick: () => s === 'recording' || s === 'arming' ? stop() : start() },
      s === 'recording' ? '■ Stop' : s === 'arming' ? '✕ Cancel' : s === 'stopping' ? '■ …' : s === 'review' ? '● Record again' : '● Record');
    const head = free
      ? h('div', {}, h('div', { class: 'row' }, h('b', {}, 'Free take as'), convSel), h('input', { class: 'bth-freetext', placeholder: 'What you say (optional, helps Claude)', value: pref().freeText || '', oninput: e => setPref({ freeText: e.target.value }) }))
      : h('div', {}, h('div', { class: 'row' }, h('span', { class: 'mono dim' }, line.lid), h('b', {}, cap(line.char)), h('span', { class: 'spacer' }), playBtn(line.voice, 'Current voice')),
        h('div', { class: 'bth-big' }, line.text));
    const recRow = h('div', { class: 'row bth-recrow' }, recBtn,
      s === 'arming' ? h('span', { class: 'bth-count' }, rec.count) : null, s === 'recording' ? h('span', { class: 'bth-speak' }, 'Speak now') : null,
      ['arming', 'recording', 'stopping'].includes(s) ? h('span', { class: 'bth-meter' }, h('i')) : null, s === 'recording' || s === 'stopping' ? h('span', { class: 'bth-time mono' }, '0.0 s') : null,
      s === 'review' ? h('audio', { controls: true, src: URL.createObjectURL(rec.blob), class: 'bth-audio' }) : null);
    const saveRow = s === 'review' || s === 'saving' ? h('div', { class: 'row' }, h('button', { class: 'primary', disabled: s === 'saving', onclick: () => saveTake(note, convSel) }, s === 'saving' ? 'Saving…' : 'Save & convert to'), free ? h('b', {}, cap(convSel.value)) : convSel, h('button', { class: 'ghost', onclick: discard }, 'Discard')) : null;
    const ts = takesOf(line).slice().reverse();
    side.replaceChildren(h('div', { class: 'panel bth-recpanel' }, head, note, recRow, saveRow),
      h('h2', {}, ts.length ? `Takes (${ts.length})` : 'No takes yet'), ...ts.map(takeCard));
    side._save = () => saveTake(note, convSel);
  }
  function takeCard(t) {
    const again = h('select', {}, B.characters.map(c => h('option', { value: c.id, selected: c.id === t.char }, cap(c.id))));
    const how = h('select', { title: 'Match: the character\'s own voice, the take closest to yours. Seed-VC: your recording turned into their voice.' },
      h('option', { value: 'match', disabled: !t.text }, 'Match'), h('option', { value: 'seedvc', selected: !t.text }, 'Seed-VC'));
    // a radio button beside every version: one choice per line (all takes of the line share the group)
    const group = 'pick-' + (t.ep ? `${t.ep}-${t.lang}-${t.lid}` : t.id);
    const opt = (file, label, cls) => h('label', { class: 'bth-opt' + (t.chosen?.file === file ? ' on' : ''), title: 'Use this version' },
      h('input', { type: 'radio', name: group, checked: t.chosen?.file === file, onchange: () => api(`/api/booth/take/${t.id}/choose`, { method: 'POST', body: { file } }).catch(e => toast(e.message, true)) }),
      playBtn(file, label, cls));
    const seen = {};   // repeat attempts of the same kind get a number: "your timing ②"
    const conv = t.conversions.flatMap(c => {
      const m = c.method || 'seedvc', key = m + c.char, nth = seen[key] = (seen[key] || 0) + 1;
      const who = cap(c.char), tag = nth > 1 ? ' ' + String.fromCharCode(0x2460 + nth - 1) : '';
      const busy = c.state === 'running' && c.partial ? h('span', { class: 'bth-state running' }, `⏳ improving… ${c.tried || ''}/${c.n}`) : null;
      if (c.state === 'done' || (c.partial && c.file)) return m === 'match'
        ? [opt(c.file, who + ' · your timing' + tag, 'vc'), c.pick && c.pick !== c.file ? opt(c.pick, who + ' · best take' + tag, 'vc') : null, busy]
        : [opt(c.file, who + ' · Seed-VC' + tag + (c.steps !== 30 ? ` (${c.steps})` : ''), 'vc2')];
      return [h('span', { class: 'bth-state ' + c.state, title: c.error || '' }, c.state === 'failed' ? `✕ ${who} ${m === 'match' ? 'match' : 'Seed-VC'} failed` + (c.error ? ': ' + c.error.slice(0, 120) : '')
        : c.state === 'running' ? (m === 'match' ? `⏳ ${who}: first version in ~20 s…` : `⏳ Seed-VC to ${who}…`) : `… queued: ${who}`)];
    });
    return h('div', { class: 'panel bth-take' + (t.chosen ? ' chosen' : '') },
      h('div', { class: 'row' }, h('span', { class: 'dim' }, AGO(t.at) + ' · ' + t.dur + ' s'), h('span', { class: 'bth-st ' + t.status }, { new: 'new', claude: 'with Claude', used: 'used ✓', rejected: 'not used' }[t.status] || t.status),
        t.chosen ? h('span', { class: 'bth-chosen' }, '✓ picked: ' + t.chosen.kind) : null,
        h('span', { class: 'spacer' }),
        t.chosen ? h('button', { class: 'ghost', title: 'Clear the pick', onclick: () => api(`/api/booth/take/${t.id}/choose`, { method: 'POST', body: { file: null } }) }, 'Clear') : null,
        h('button', { class: 'ghost danger', title: 'Move this take to the Trash', onclick: async () => { if (await confirmBox('Delete this take?', 'The recording and its conversions go to the Trash.', 'Delete')) api(`/api/booth/take/${t.id}/remove`, { method: 'POST' }).catch(e => toast(e.message, true)); } }, '🗑')),
      t.note ? h('div', { class: 'bth-dir' }, '“' + t.note + '”') : null,
      !t.ep && t.text ? h('div', { class: 'dim' }, t.text) : null,
      h('div', { class: 'row bth-opts' }, opt(t.file, 'You'), ...conv),
      h('div', { class: 'row bth-again' }, h('span', { class: 'dim' }, 'Again:'), how, h('span', { class: 'dim' }, 'as'), again,
        h('button', { onclick: () => api(`/api/booth/take/${t.id}/convert`, { method: 'POST', body: { char: again.value, method: how.value } }).catch(e => toast(e.message, true)) }, 'Go')),
      t.reply ? h('div', { class: 'bth-reply' }, 'Claude: ' + t.reply) : null);
  }

  // ---------- send to Claude
  function updateSend() {
    const fresh = B.takes.filter(t => t.status === 'new'), picked = fresh.filter(t => t.chosen).length;
    sendBtn.textContent = picked ? `Send to Claude (${picked} picked)` : `Send to Claude (${fresh.length})`; sendBtn.disabled = !fresh.length;
    sendBtn.title = picked ? 'Sends the versions you picked' : 'Nothing picked yet: pick a version with its round button first, or send all new takes';
  }
  async function send() {
    const { text } = await api('/api/booth/prompt', { method: 'POST', body: {} });
    try { await navigator.clipboard.writeText(text); toast('Message copied. Paste it into the Claude chat.'); }
    catch { await confirmBox('Paste into the Claude chat', h('textarea', { style: { width: '100%', minHeight: '70px' } }, text), 'OK'); }
  }

  // ---------- keys and live updates
  const onKey = e => {
    if (e.target.matches('input, textarea, select') && e.key !== 'Escape') return;
    if (e.key === 'r' || e.key === 'R') { e.preventDefault(); rec.state === 'recording' || rec.state === 'arming' ? stop() : start(); }
    else if (e.key === 'Enter' && rec.state === 'review') { e.preventDefault(); side._save?.(); }
    else if (e.key === 'Escape' && rec.state !== 'idle' && rec.state !== 'saving') { e.preventDefault(); if (['arming', 'recording', 'stopping'].includes(rec.state)) cancelArm(); else discard(); }
    else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && lines.length) { e.preventDefault(); const i = lines.findIndex(l => l.lid === lid); pick(lines[Math.max(0, Math.min(lines.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))].lid); }
  };
  document.addEventListener('keydown', onKey);
  const off = onHubEvent('booth', ev => {
    if (ev?.type === 'take') { const i = B.takes.findIndex(t => t.id === ev.take.id); if (i >= 0) B.takes[i] = ev.take; else B.takes.push(ev.take); }
    else if (ev?.type === 'removed') B.takes = B.takes.filter(t => t.id !== ev.id);
    const done = ev?.take?.conversions?.at(-1); if (done?.state === 'done' && Date.parse(done.done) > Date.now() - 4000) toast(`${cap(done.char)} version ready`);
    updateSend(); drawLines(); if (rec.state === 'idle' || ev?.type === 'removed') drawSide(); else redrawTakesOnly();
  });
  function redrawTakesOnly() { const line = lines.find(l => l.lid === lid), ts = takesOf(line).slice().reverse(); side.querySelectorAll('.bth-take, h2').forEach(e => e.remove()); side.append(h('h2', {}, ts.length ? `Takes (${ts.length})` : 'No takes yet'), ...ts.map(takeCard)); }
  updateSend(); await loadLines();
  return () => { document.removeEventListener('keydown', onKey); off(); player.pause(); rec.cancelled = true; if (rec.mr && rec.mr.state !== 'inactive') { rec.mr.onstop = null; rec.mr.stop(); } releaseMic(); };
}
