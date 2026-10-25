// app.js — camera, auto-capture, OCR queue, library, export.
import { cleanPage, appendPage, chapterize, toMarkdown, toPlainText, wordCount } from './text.js';
import { buildEpub } from './epub.js';

const $ = id => document.getElementById(id);
const el = {
  docs: $('docs'), empty: $('empty'), lede: $('lede'), colophon: $('colophon'), newBtn: $('newBtn'),
  video: $('video'), frame: $('frame'), chip: $('chip'), flash: $('flash'), hint: $('hint'),
  pageCount: $('pageCount'), tallyLabel: $('tallyLabel'), shutter: $('shutter'),
  pauseBtn: $('pauseBtn'), doneBtn: $('doneBtn'), closeCam: $('closeCam'), hintOk: $('hintOk'),
  title: $('title'), meta: $('meta'), docText: $('docText'), backHome: $('backHome'),
  moreBtn: $('moreBtn'), lang: $('lang'), toast: $('toast'),
  sheet: $('sheet'), sheetTitle: $('sheetTitle'), sheetText: $('sheetText'),
  sheetActions: $('sheetActions'), sheetCancel: $('sheetCancel'),
  progress: $('progress'), progressTitle: $('progressTitle'), progressText: $('progressText'),
  meterFill: $('meterFill'), progressCancel: $('progressCancel'),
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
const fmtBytes = n => {
  if (!n) return '0 KB';
  if (n >= 1073741824) return (n / 1073741824).toFixed(1) + ' GB';
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  return Math.max(1, Math.round(n / 1024)) + ' KB';
};
const ID = () => (crypto.randomUUID ? crypto.randomUUID() : 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));

/* ───────────────────────── storage ───────────────────────── */

const db = new Promise((resolve, reject) => {
  const req = indexedDB.open('turn', 3);
  req.onupgradeneeded = () => {
    const d = req.result;
    if (!d.objectStoreNames.contains('docs')) d.createObjectStore('docs', { keyPath: 'id' });
    if (!d.objectStoreNames.contains('pages')) {
      d.createObjectStore('pages', { keyPath: 'id' }).createIndex('docId', 'docId');
    }
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

function idb(mode, fn, store = 'docs') {
  return db.then(d => new Promise((resolve, reject) => {
    const tx = d.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req && 'result' in req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}
const allDocs = () => idb('readonly', s => s.getAll()).then(r => r || []);
const putDoc = d => idb('readwrite', s => s.put({ ...d }));
const dropDoc = id => idb('readwrite', s => s.delete(id));

// Page scans, kept so a document can be read again without shooting it again.
const SCAN_CAP = 80 * 1024 * 1024; // ponytail: flat per-document ceiling, no eviction policy
const putScan = (id, no, blob) => idb('readwrite', s => s.put({ id: id + ':' + no, docId: id, no, blob }), 'pages');
const scansOf = id => idb('readonly', s => s.index('docId').getAll(id), 'pages')
  .then(r => (r || []).sort((a, b) => a.no - b.no));
const dropScans = id => idb('readwrite', s => {
  const cur = s.index('docId').openKeyCursor(IDBKeyRange.only(id));
  cur.onsuccess = () => { const c = cur.result; if (c) { s.delete(c.primaryKey); c.continue(); } };
}, 'pages');

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
  return { id: ID(), title: 'Scan · ' + stamp(), text: '', pages: 0, lang, createdAt: t, updatedAt: t, shots: 0, scanBytes: 0, scanCount: 0 };
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
  if (name === 'capture') startCam();
  window.scrollTo(0, 0);
}

/* ───────────────────────── library ───────────────────────── */

async function renderHome() {
  const list = (await allDocs()).sort((a, b) => b.updatedAt - a.updatedAt);
  el.empty.hidden = list.length > 0;
  el.lede.hidden = list.length > 0;
  el.docs.innerHTML = '';
  const kept = list.reduce((n, d) => n + (d.scanBytes || 0), 0);
  el.colophon.textContent = list.length
    ? `${list.length} ${list.length === 1 ? 'document' : 'documents'} · ${fmtBytes(kept)} stored · nothing uploaded`
    : 'Runs on this device. Nothing is uploaded.';

  for (const d of list) {
    const li = document.createElement('li');
    li.className = 'doc-row';

    const row = document.createElement('button');
    row.className = 'doc';
    const h = Math.min(56, Math.max(12, Math.round(d.pages / 8) * 4));
    row.innerHTML =
      `<span class="spine" style="height:${h}px"></span>` +
      `<span><span class="doc-name">${esc(d.title)}</span>` +
      `<span class="doc-sub">${d.pages} ${d.pages === 1 ? 'page' : 'pages'} · ` +
      `${d.scanBytes ? fmtBytes(d.scanBytes) : 'no scans'} · ${esc(dayLabel(d.updatedAt))}</span></span>`;
    row.onclick = () => openDoc(d.id);

    const more = document.createElement('button');
    more.className = 'doc-more';
    more.setAttribute('aria-label', 'Actions for this document');
    more.innerHTML = '&#8943;';
    more.onclick = () => docActions(d);

    li.append(row, more);
    el.docs.append(li);
  }
}

async function openDoc(id) {
  await saveNow();
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
  capCount = doc ? Math.max(doc.shots || 0, doc.pages || 0) : 0;
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

  const no = ++capCount;
  if (doc) doc.shots = no;
  canvas.toBlob(blob => {
    if (!blob) return;
    if (doc) {
      if ((doc.scanBytes || 0) + blob.size <= SCAN_CAP) {
        doc.scanBytes = (doc.scanBytes || 0) + blob.size;
        doc.scanCount = (doc.scanCount || 0) + 1;
        putScan(doc.id, no, blob).catch(() => {});
      } else if (!doc.full) {
        doc.full = true;
        toast('Scan storage full for this document — the text is still saved');
      }
      save();
    }
    queue.push({ blob, no });
    pump();
  }, 'image/jpeg', 0.92);

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
  el.tallyLabel.textContent = pending ? `reading ${pending}` : capCount === 1 ? 'page' : 'pages';
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

async function getWorker(want = doc?.lang || lang) {
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
  updateTally();   // the tally reports the in-flight page too, not just queued ones
  while (queue.length) {
    const job = queue[0];
    try {
      const w = await getWorker();
      const { data } = await w.recognize(job.blob);
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
    if (doc) { await dropScans(doc.id).catch(() => {}); await dropDoc(doc.id); }
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
  const chapters = ch.filter(c => c.title).length;
  el.meta.innerHTML =
    `<span>${doc.pages} ${doc.pages === 1 ? 'page' : 'pages'} · ${words.toLocaleString()} words · ` +
    `${chapters} ${chapters === 1 ? 'chapter' : 'chapters'}</span>` +
    `<span class="meta-sub">${doc.scanBytes ? fmtBytes(doc.scanBytes) + ' of scans kept' : 'no scans kept'}` +
    ` · ${LANG_NAME[doc.lang || lang] || 'English'} reader</span>`;

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

/* ───────────────────────── sheets ───────────────────────── */

function openSheet({ title, text = '', actions = [], cancel = 'Cancel' }) {
  el.sheetTitle.textContent = title;
  el.sheetText.textContent = text;
  el.sheetText.hidden = !text;
  el.sheetActions.innerHTML = '';
  for (const a of actions) {
    const b = document.createElement('button');
    b.textContent = a.label;
    if (a.kind) b.className = a.kind;
    b.onclick = () => { closeSheet(); a.run?.(); };
    el.sheetActions.append(b);
  }
  el.sheetCancel.textContent = cancel;
  el.sheet.hidden = false;
}

const closeSheet = () => { el.sheet.hidden = true; };

function confirmSheet({ title, text, yes = 'Confirm', run }) {
  openSheet({ title, text, actions: [{ label: yes, kind: 'danger', run }] });
}

function openProgress(title, total) {
  el.progressTitle.textContent = title;
  el.progressText.textContent = `0 of ${total}`;
  el.meterFill.style.width = '0%';
  el.progressCancel.disabled = false;
  el.progressCancel.textContent = 'Cancel';
  el.progress.hidden = false;
}

function setProgress(n, total) {
  el.progressText.textContent = `${n} of ${total}`;
  el.meterFill.style.width = (total ? (n / total) * 100 : 0).toFixed(1) + '%';
}

const closeProgress = () => { el.progress.hidden = true; };

/* ───────────────────────── document actions ───────────────────────── */

let rereadJob = null;

function docActions(d) {
  const scans = d.scanCount || 0;
  const size = fmtBytes(d.scanBytes || 0);
  const other = LANGS.find(l => l !== (d.lang || 'eng'));
  const actions = [
    { label: 'Keep scanning', run: () => { doc = d; show('capture'); } },
  ];

  if (scans) {
    actions.push({
      label: 'Re-read scans',
      run: () => confirmSheet({
        title: `Read ${scans} kept ${scans === 1 ? 'page' : 'pages'} again?`,
        text: `Runs each one through the ${LANG_NAME[d.lang || 'eng']} reader again. Takes a few minutes; the current text stays until it finishes.`,
        yes: 'Re-read',
        run: () => reread(d),
      }),
    });
    if (other) {
      actions.push({
        label: `Read in ${LANG_NAME[other]}`,
        run: () => confirmSheet({
          title: `Re-read in ${LANG_NAME[other]}?`,
          text: `For when the language was wrong. ${scans} ${scans === 1 ? 'page' : 'pages'}, a few minutes, and the text is replaced only if something comes back.`,
          yes: `Re-read in ${LANG_NAME[other]}`,
          run: () => reread(d, other),
        }),
      });
    }
    actions.push({
      label: `Discard scans · ${size}`,
      kind: 'danger',
      run: () => confirmSheet({
        title: 'Discard page scans?',
        text: `Frees ${size}. The text is kept, but the pages can no longer be read again.`,
        yes: `Discard ${size}`,
        run: () => discardScans(d),
      }),
    });
  }

  actions.push({
    label: 'Delete document',
    kind: 'danger',
    run: () => confirmSheet({
      title: 'Delete this document?',
      text: `Removes the text${scans ? ` and ${size} of scans` : ''}. This cannot be undone.`,
      yes: 'Delete',
      run: () => deleteDoc(d),
    }),
  });

  openSheet({
    title: d.title,
    text: `${d.pages} ${d.pages === 1 ? 'page' : 'pages'} · ${scans ? size + ' of scans kept' : 'no scans kept'}`,
    actions,
  });
}

async function discardScans(d) {
  await saveNow();
  await dropScans(d.id).catch(() => {});
  d.scanBytes = 0;
  d.scanCount = 0;
  d.full = false;
  await putDoc(d).catch(() => {});
  if (doc && doc.id === d.id) { doc = d; renderRead(); }
  await renderHome();
  toast('Scans discarded · text kept');
}

async function deleteDoc(d) {
  await dropScans(d.id).catch(() => {});
  await dropDoc(d.id).catch(() => {});
  if (doc && doc.id === d.id) doc = null;
  await show('home');
  await renderHome();
  toast('Document deleted');
}

async function reread(d, target = d.lang || 'eng') {
  if (rereadJob) { toast('Already re-reading'); return; }
  await saveNow();
  const pages = await scansOf(d.id).catch(() => []);
  if (!pages.length) { toast('No scans kept for this document'); return; }

  const job = { cancel: false };
  rereadJob = job;
  openProgress(`Re-reading in ${LANG_NAME[target] || target}`, pages.length);

  let text = '', done = 0, failed = 0, seen = 0;
  try {
    const w = await getWorker(target);
    for (const page of pages) {
      if (job.cancel) break;
      try {
        const { data } = await w.recognize(page.blob);
        const clean = cleanPage(data.text);
        const merged = clean ? appendPage(text, clean) : text;
        if (merged !== text) { text = merged; done++; }
      } catch { failed++; }
      seen++;
      setProgress(seen, pages.length);
    }
  } catch {
    failed = pages.length - seen;
  }
  rereadJob = null;
  closeProgress();

  if (job.cancel) { toast('Re-read cancelled · text unchanged'); return; }
  if (!done) { toast('Re-read produced nothing · text unchanged'); return; }

  d.text = text;
  d.pages = done;
  d.lang = target;
  await putDoc(d).catch(() => {});
  if (doc && doc.id === d.id) { doc = d; renderRead(); }
  await renderHome();
  toast(`Re-read ${done} ${done === 1 ? 'page' : 'pages'}${failed ? ` · ${failed} failed` : ''}`);
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

el.moreBtn.onclick = () => { if (doc) docActions(doc); };

el.sheetCancel.onclick = closeSheet;
el.sheet.onclick = e => { if (e.target === el.sheet) closeSheet(); };
el.progressCancel.onclick = () => {
  if (!rereadJob) return;
  rereadJob.cancel = true;
  el.progressCancel.disabled = true;
  el.progressCancel.textContent = 'Cancelling…';
};
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !el.sheet.hidden) closeSheet(); });

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
