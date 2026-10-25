// app.js — camera, auto-capture, OCR queue, library, export.
import { cleanPage, appendPage, chapterize, toMarkdown, toPlainText, wordCount } from './text.js';
import { buildEpub } from './epub.js';

const $ = id => document.getElementById(id);
const el = {
  docs: $('docs'), empty: $('empty'), colophon: $('colophon'), newBtn: $('newBtn'),
  video: $('video'), frame: $('frame'), chip: $('chip'), flash: $('flash'), hint: $('hint'),
  pageCount: $('pageCount'), tallyLabel: $('tallyLabel'), shutter: $('shutter'),
  pauseBtn: $('pauseBtn'), doneBtn: $('doneBtn'), closeCam: $('closeCam'), hintOk: $('hintOk'),
  title: $('title'), meta: $('meta'), docText: $('docText'), backHome: $('backHome'),
  moreBtn: $('moreBtn'), menu: $('menu'), rescanBtn: $('rescanBtn'), deleteBtn: $('deleteBtn'),
  lang: $('lang'), toast: $('toast'),
};

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const slug = s => (String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)) || 'document';
const dayLabel = ts => {
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};
const stamp = () => new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const ID = () => (crypto.randomUUID ? crypto.randomUUID() : 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));

/* ───────────────────────── storage ───────────────────────── */

const db = new Promise((resolve, reject) => {
  const req = indexedDB.open('turn', 2);
  req.onupgradeneeded = () => {
    const d = req.result;
    if (!d.objectStoreNames.contains('docs')) d.createObjectStore('docs', { keyPath: 'id' });
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

function idb(mode, fn) {
  return db.then(d => new Promise((resolve, reject) => {
    const tx = d.transaction('docs', mode);
    const req = fn(tx.objectStore('docs'));
    tx.oncomplete = () => resolve(req && 'result' in req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}
const allDocs = () => idb('readonly', s => s.getAll()).then(r => r || []);
const putDoc = b => idb('readwrite', s => s.put({ ...b }));
const dropDoc = id => idb('readwrite', s => s.delete(id));

/* ───────────────────────── state ───────────────────────── */

let doc = null;          // active document
let screen = 'home';
let saveTimer = 0;
let autoPaused = false;
let finishing = false;

/** OCR language for new documents: remembered, and guessed from the device the first time. */
const LANGS = ['eng', 'ita'];
const LANG_NAME = { eng: 'English', ita: 'Italiano' };
let lang = (() => {
  const saved = localStorage.getItem('turn.lang');
  if (LANGS.includes(saved)) return saved;
  return (navigator.language || '').toLowerCase().startsWith('it') ? 'ita' : 'eng';
})();

function newDoc() {
  const t = Date.now();
  return { id: ID(), title: 'Scan · ' + stamp(), text: '', pages: 0, lang, createdAt: t, updatedAt: t };
}

function save() {
  if (!doc) return;
  doc.updatedAt = Date.now();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => putDoc(doc).catch(() => {}), 500);
}
async function saveNow() {
  clearTimeout(saveTimer);
  if (doc) { doc.updatedAt = Date.now(); await putDoc(doc).catch(() => {}); }
}

/* ───────────────────────── toast ───────────────────────── */

let toastTimer = 0;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2600);
}

/* ───────────────────────── screens ───────────────────────── */

async function show(name) {
  if (screen === 'capture' && name !== 'capture') await stopCam();
  screen = name;
  document.body.dataset.screen = name;
  if (name !== 'read') { el.menu.hidden = true; }
  if (name === 'capture') startCam();
  window.scrollTo(0, 0);
}

/* ───────────────────────── library ───────────────────────── */

async function renderHome() {
  const list = (await allDocs()).sort((a, b) => b.updatedAt - a.updatedAt);
  el.empty.hidden = list.length > 0;
  el.docs.innerHTML = '';
  el.colophon.textContent = list.length
    ? `${list.length} ${list.length === 1 ? 'doc' : 'docs'} on this device · nothing uploaded`
    : 'Runs on this device. Nothing is uploaded.';

  for (const b of list) {
    const li = document.createElement('li');
    const row = document.createElement('button');
    row.className = 'doc';
    const h = Math.min(56, Math.max(12, Math.round(b.pages / 8) * 4));
    row.innerHTML =
      `<span class="spine" style="height:${h}px"></span>` +
      `<span><span class="doc-name">${esc(b.title)}</span>` +
      `<span class="doc-sub">${b.pages} ${b.pages === 1 ? 'page' : 'pages'} · ${esc(dayLabel(b.updatedAt))}</span></span>` +
      `<span class="doc-go">›</span>`;
    row.onclick = () => openDoc(b.id);
    li.append(row);
    el.docs.append(li);
  }
}

async function openDoc(id) {
  const found = (await allDocs()).find(b => b.id === id);
  if (!found) return;
  doc = found;
  renderRead();
  show('read');
}

/* ───────────────────────── camera ───────────────────────── */

let stream = null, raf = 0, wake = null, lastSample = 0, lastShot = 0;
let prevGray = null, hold = 0, armed = true, moveFrames = 0, capCount = 0;

const STABLE = 2.6;      // mean abs diff (0-255) below this = still
const HOLD_MS = 620;     // stillness needed before the shutter fires
const INK_MIN = 0.02;    // edge density that counts as "there is text here"

const SC = document.createElement('canvas');
const SX = 64, SY = 48;
SC.width = SX; SC.height = SY;
const sctx = SC.getContext('2d', { willReadFrequently: true });

async function startCam() {
  if (stream) return;
  capCount = doc ? doc.pages : 0;
  el.pageCount.textContent = capCount;
  updateTally();

  if (!navigator.mediaDevices?.getUserMedia) {
    setChip('Camera needs https', 'warn');
    toast('Open this page over https — the camera is blocked on plain http');
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 2560 }, height: { ideal: 1440 },
        advanced: [{ focusMode: 'continuous' }],
      },
    });
  } catch (e) {
    setChip(e?.name === 'NotAllowedError' ? 'Camera blocked' : 'No camera', 'warn');
    toast(e?.name === 'NotAllowedError' ? 'Allow camera for this site in Settings, then reload' : 'Camera unavailable');
    return;
  }

  el.video.srcObject = stream;
  try { await el.video.play(); } catch { /* iOS sometimes needs a tap */ }

  prevGray = null; hold = 0; armed = true; moveFrames = 0; lastSample = 0;
  autoPaused = false;
  document.body.classList.remove('paused');
  el.pauseBtn.innerHTML = '&#10073;&#10073;';
  keepAwake(true);
  el.hint.hidden = !!localStorage.getItem('turn.hint');
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(tick);
}

async function stopCam() {
  cancelAnimationFrame(raf);
  raf = 0;
  prevGray = null;
  keepAwake(false);
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
  el.video.srcObject = null;
}

async function keepAwake(on) {
  try {
    if (on) {
      if (!wake && navigator.wakeLock) {
        wake = await navigator.wakeLock.request('screen');
        wake.addEventListener('release', () => { wake = null; });
      }
    } else if (wake) {
      await wake.release();
      wake = null;
    }
  } catch { /* not fatal */ }
}

/** Downscale a frame and measure motion plus edge density. */
function sample() {
  if (!el.video.videoWidth) return null;
  sctx.drawImage(el.video, 0, 0, SX, SY);
  const px = sctx.getImageData(0, 0, SX, SY).data;
  const g = new Uint8Array(SX * SY);
  for (let i = 0, p = 0; p < g.length; i += 4, p++) g[p] = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000;

  let diff = 0, edges = 0;
  if (prevGray) {
    for (let p = 0; p < g.length; p++) diff += Math.abs(g[p] - prevGray[p]);
    diff /= g.length;
  }
  for (let y = 0; y < SY; y++) for (let x = 1; x < SX; x++) {
    const p = y * SX + x;
    if (Math.abs(g[p] - g[p - 1]) > 16) edges++;
  }
  prevGray = g;
  return { diff, ink: edges / g.length };
}

let chipText = '', chipTone = '';
function setChip(text, tone = 'idle') {
  if (text === chipText && tone === chipTone) return;
  chipText = text; chipTone = tone;
  el.chip.textContent = text;
  el.chip.dataset.tone = tone;
}

function tick(ts) {
  raf = requestAnimationFrame(tick);
  if (!stream || ts - lastSample < 110) return;
  const dt = lastSample ? Math.min(500, ts - lastSample) : 0;
  lastSample = ts;

  const s = sample();
  if (!s) return;

  const moving = s.diff > STABLE;
  if (moving) {
    hold = 0;
    if (!armed && ++moveFrames > 2) { armed = true; moveFrames = 0; }
  } else {
    hold += dt;
    moveFrames = 0;
  }

  const hintOpen = !el.hint.hidden;
  const ready = armed && !autoPaused && !hintOpen && !finishing && hold >= HOLD_MS && s.ink > INK_MIN;
  const progress = Math.min(1, hold / HOLD_MS);
  el.frame.style.setProperty('--p', (moving || !armed || autoPaused ? 0 : progress).toFixed(3));
  el.frame.classList.toggle('locked', !autoPaused && (!armed || (hold >= HOLD_MS * 0.55 && s.ink > INK_MIN)));

  if (autoPaused) setChip('Paused', 'warn');
  else if (finishing) setChip('Finishing…', 'warn');
  else if (!worker && queue.length) setChip(prepText || 'Preparing reader', 'warn');
  else if (!armed) setChip('Turn the page →', 'ok');
  else if (s.ink <= INK_MIN) setChip('Fill the frame with the page', 'warn');
  else if (moving) setChip('Hold steady');
  else if (hold < HOLD_MS) setChip('Hold…');
  else setChip('Page captured', 'ok');

  if (ready) capture('auto');
}

/** Crop the guide rectangle out of the camera frame (CSS cover mapping). */
function grab() {
  const vw = el.video.videoWidth, vh = el.video.videoHeight;
  if (!vw || !vh) return null;
  const vr = el.video.getBoundingClientRect();
  const fr = el.frame.getBoundingClientRect();
  const scale = Math.max(vr.width / vw, vr.height / vh);
  const offX = (vw * scale - vr.width) / 2, offY = (vh * scale - vr.height) / 2;

  let sx = (fr.left - vr.left + offX) / scale;
  let sy = (fr.top - vr.top + offY) / scale;
  let sw = fr.width / scale, sh = fr.height / scale;
  sx = Math.max(0, Math.min(vw - 1, sx));
  sy = Math.max(0, Math.min(vh - 1, sy));
  sw = Math.min(sw, vw - sx);
  sh = Math.min(sh, vh - sy);
  if (sw < 120 || sh < 120) return null;

  const c = document.createElement('canvas');
  c.width = Math.round(sw);
  c.height = Math.round(sh);
  c.getContext('2d').drawImage(el.video, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}

const queue = [];

function capture(reason) {
  const now = performance.now();
  if (now - lastShot < 380 || finishing) return;
  const canvas = grab();
  if (!canvas) return;
  lastShot = now;
  armed = false;
  hold = 0;
  moveFrames = 0;

  canvas.toBlob(blob => {
    if (!blob) return;
    queue.push(blob);
    pump();
  }, 'image/jpeg', 0.92);

  capCount++;
  el.pageCount.textContent = capCount;
  updateTally();
  flash();
  blip();
  if (navigator.vibrate) navigator.vibrate(12);
}

function flash() {
  el.flash.classList.remove('go');
  void el.flash.offsetWidth;
  el.flash.classList.add('go');
}

let audio = null;
function blip() {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const t = audio.currentTime;
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(1240, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.07, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.085);
    o.connect(g).connect(audio.destination);
    o.start(t); o.stop(t + 0.1);
  } catch { /* silence is fine */ }
}

function updateTally() {
  const pending = queue.length;
  el.tallyLabel.textContent = pending ? `reading ${pending}` : 'pages';
}

/* ───────────────────────── OCR ───────────────────────── */

const CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@7/dist/tesseract.min.js';
let libPromise = null, worker = null, workerLang = '', pumping = false, prepText = '';

function loadLib() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (!libPromise) {
    libPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = CDN;
      s.async = true;
      s.onload = () => resolve(window.Tesseract);
      s.onerror = () => reject(new Error('reader unavailable'));
      document.head.append(s);
    });
  }
  return libPromise;
}

async function getWorker() {
  const want = doc?.lang || lang;
  if (worker && workerLang === want) return worker;
  if (worker) { await worker.terminate().catch(() => {}); worker = null; }
  const T = await loadLib();
  if (!T) throw new Error('reader unavailable');
  setChip('Preparing reader', 'warn');
  worker = await T.createWorker(want, 1, {
    logger: m => {
      if (m.progress != null && m.progress < 1) {
        prepText = `Preparing reader ${Math.round(m.progress * 100)}%`;
        setChip(prepText, 'warn');
      }
    },
  });
  workerLang = want;
  prepText = '';
  chipText = '';
  return worker;
}

async function pump() {
  if (pumping) return;
  pumping = true;
  while (queue.length) {
    const blob = queue[0];
    try {
      const w = await getWorker();
      const { data } = await w.recognize(blob);
      queue.shift();
      addPage(data.text);
    } catch (e) {
      queue.shift();
      toast('A page could not be read — scan it again');
    }
    updateTally();
    chipText = '';
  }
  pumping = false;
  updateTally();
}

function addPage(raw) {
  if (!doc) return;
  const page = cleanPage(raw);
  if (!page) return;
  const merged = appendPage(doc.text, page);
  if (merged === doc.text) return; // duplicate shot
  doc.text = merged;
  doc.pages = (doc.pages || 0) + 1;
  save();
}

async function waitForQueue() {
  const until = Date.now() + 120000;
  while ((queue.length || pumping) && Date.now() < until) await sleep(120);
}

/* ───────────────────────── finish / read ───────────────────────── */

async function finish() {
  if (finishing) return;
  finishing = true;
  autoPaused = true;
  if (queue.length || pumping) setChip(`Finishing · ${queue.length} left`, 'warn');

  await waitForQueue();
  await saveNow();
  finishing = false;
  autoPaused = false;

  if (!doc || !doc.text) {
    if (doc) await dropDoc(doc.id);
    doc = null;
    await show('home');
    await renderHome();
    return;
  }
  if (/^Scan · /.test(doc.title)) {
    const first = chapterize(doc.text)[0];
    const line = (first?.title || first?.body?.[0] || '').split('\n')[0].trim();
    if (line) doc.title = line.length > 64 ? line.slice(0, 61).trimEnd() + '…' : line;
    await saveNow();
  }
  renderRead();
  await show('read');
}

function renderRead() {
  if (!doc) return;
  el.title.value = doc.title;
  const ch = chapterize(doc.text);
  const words = wordCount(doc.text);
  el.meta.textContent = [
    `${doc.pages} ${doc.pages === 1 ? 'page' : 'pages'}`,
    `${words.toLocaleString()} words`,
    `${ch.filter(c => c.title).length} ${ch.filter(c => c.title).length === 1 ? 'chapter' : 'chapters'}`,
    LANG_NAME[doc.lang || lang] || 'English',
  ].join(' · ');

  const html = ch.map(c =>
    (c.title ? `<h2>${esc(c.title)}</h2>` : '') +
    c.body.map(p => `<p>${esc(p).replace(/\n+/g, ' ')}</p>`).join('')
  ).join('');
  el.docText.innerHTML = html || '<p class="blank">Nothing read yet.</p>';
}

/* ───────────────────────── export ───────────────────────── */

async function deliver(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return;
    } catch (e) {
      if (e?.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function exportAs(kind) {
  if (!doc || !doc.text.trim()) { toast('Nothing to export yet'); return; }
  const base = slug(doc.title);
  try {
    if (kind === 'epub') {
      const bytes = buildEpub({ title: doc.title, chapters: chapterize(doc.text) });
      await deliver(new Blob([bytes], { type: 'application/epub+zip' }), base + '.epub');
    } else if (kind === 'md') {
      await deliver(new Blob([toMarkdown(doc.title, doc.text)], { type: 'text/markdown' }), base + '.md');
    } else {
      await deliver(new Blob([toPlainText(doc.title, doc.text)], { type: 'text/plain' }), base + '.txt');
    }
  } catch {
    toast('Export failed');
  }
}

/* ───────────────────────── wiring ───────────────────────── */

el.newBtn.onclick = () => {
  doc = newDoc();
  putDoc(doc).catch(() => {});
  show('capture');
};

el.shutter.onclick = () => capture('manual');

el.closeCam.onclick = () => finish();

el.doneBtn.onclick = () => finish();

el.pauseBtn.onclick = () => {
  autoPaused = !autoPaused;
  document.body.classList.toggle('paused', autoPaused);
  el.pauseBtn.innerHTML = autoPaused ? '&#9654;' : '&#10073;&#10073;';
  el.pauseBtn.setAttribute('aria-label', autoPaused ? 'Resume capture' : 'Pause capture');
};

el.hintOk.onclick = () => {
  el.hint.hidden = true;
  localStorage.setItem('turn.hint', '1');
};

el.backHome.onclick = async () => { await saveNow(); await show('home'); await renderHome(); };

el.moreBtn.onclick = () => { el.menu.hidden = !el.menu.hidden; };

document.addEventListener('click', e => {
  if (!el.menu.hidden && !el.menu.contains(e.target) && e.target !== el.moreBtn) el.menu.hidden = true;
});

el.rescanBtn.onclick = async () => {
  el.menu.hidden = true;
  await saveNow();
  await show('capture');
};

el.deleteBtn.onclick = async () => {
  el.menu.hidden = true;
  if (!doc) return;
  if (!confirm('Delete this document? This cannot be undone.')) return;
  await dropDoc(doc.id);
  doc = null;
  await show('home');
  await renderHome();
};

el.title.addEventListener('input', () => {
  if (!doc) return;
  doc.title = el.title.value.trim() || 'Untitled';
  save();
});
el.title.addEventListener('blur', () => { if (doc) saveNow(); });

el.lang.value = lang;
el.lang.onchange = () => {
  lang = el.lang.value;
  localStorage.setItem('turn.lang', lang);
  workerLang = '';                     // next capture builds a reader for the new language
  toast('Reading ' + LANG_NAME[lang]);
};

document.querySelectorAll('[data-export]').forEach(b => {
  b.onclick = () => exportAs(b.dataset.export);
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (screen === 'capture' && stream) { stopCam(); return; }
    saveNow();
  } else if (screen === 'capture' && !stream) {
    startCam();
  }
});

window.addEventListener('pagehide', () => { saveNow(); });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

renderHome().catch(() => toast('Storage is unavailable in this browser'));
