// text.js — pure text pipeline. No DOM, no deps. Tested by test.mjs.

/** Page number / folio line: bare digits or a bare uppercase roman numeral. */
const FOLIO = /^(?:\d{1,4}|[IVXLCDM]{1,7})$/;

const isFolio = (line, i, n) => i < 2 || i >= n - 2 ? FOLIO.test(line.replace(/[^\w]/g, '')) : false;

/**
 * OCR page text -> paragraphs.
 * Drops bare page numbers in the first/last two lines (running heads),
 * rejoins hard-wrapped lines, and repairs end-of-line hyphenation.
 */
export function cleanPage(raw) {
  const lines = String(raw ?? '')
    .replace(/\r/g, '')
    .split('\n')
    .map(l => l.replace(/[ \t]+$/, '').trim())
    .filter(Boolean)
    .filter((l, i, a) => !isFolio(l, i, a.length));
  if (!lines.length) return '';

  const longest = Math.max(...lines.map(l => l.length));
  const out = [];
  let buf = '';
  let lastLen = 0;
  for (const line of lines) {
    if (!buf) { buf = line; lastLen = line.length; continue; }
    // A heading never runs into the body text, even when OCR gives no blank line.
    if (isHeading(buf)) { out.push(buf); buf = line; lastLen = line.length; continue; }
    const hyphens = /[\p{L}]-$/u.test(buf) && /^\p{Ll}/u.test(line);
    // A line that ends its sentence *and* stops short of the measure ends the paragraph.
    const closed = /[.!?…"'\p{Pe}\p{Pf}]$/u.test(buf) && lastLen < longest * 0.92;
    if (hyphens) buf = buf.slice(0, -1) + line;
    else if (closed) { out.push(buf); buf = line; }
    else buf += ' ' + line;
    lastLen = line.length;
  }
  out.push(buf);
  return out.join('\n\n');
}

const words = s => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function distance(a, b) {
  const m = a.length, n = b.length;
  if (!m || !n) return Math.max(m, n);
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/** Same line, allowing OCR drift: >= 82 % characters agree. */
export function sameLine(a, b) {
  const x = words(a), y = words(b);
  if (!x || !y) return x === y;
  if (x === y) return true;
  const longest = Math.max(x.length, y.length);
  if (Math.abs(x.length - y.length) > longest * 0.35) return false;
  return 1 - distance(x, y) / longest >= 0.82;
}

/**
 * Append a freshly read page to the document text.
 * Removes lines already at the tail (re-shot page, overlapping shot) and stitches
 * the joint, including hyphenated words split across the page break.
 */
export function appendPage(prev, page) {
  const next = String(page ?? '').trim();
  if (!next) return prev;
  if (!prev) return next;

  const tail = prev.split('\n').filter(l => l.trim());
  const head = next.split('\n').filter(l => l.trim());

  let overlap = 0;
  for (let n = Math.min(6, tail.length, head.length); n > 0; n--) {
    let all = true;
    for (let i = 0; i < n; i++) {
      if (!sameLine(tail[tail.length - n + i], head[i])) { all = false; break; }
    }
    if (all) { overlap = n; break; }
  }

  // Drop the overlapped lines from the page, keeping its paragraph breaks.
  const rawLines = next.split('\n');
  let seen = 0, cut = 0;
  for (; cut < rawLines.length && seen < overlap; cut++) if (rawLines[cut].trim()) seen++;
  const rest = rawLines.slice(cut).join('\n').replace(/^\s*\n+/, '').trimEnd();
  if (!rest) return prev;

  const base = prev.replace(/\s+$/, '');
  const joined = /[\p{L}]-$/u.test(base) && /^\p{Ll}/u.test(rest);
  // Rule for the joint: a short, closed line ends a paragraph; anything else runs on.
  // Width reference is the whole document, not the last page — a page can be all short lines.
  const lastLine = tail[tail.length - 1] ?? '';
  const widest = prev.split('\n').reduce((n, l) => Math.max(n, l.length), 1);
  const open = !/[.!?…"'”’»)\]]$/.test(lastLine) || lastLine.length > widest * 0.94;
  const sep = joined ? '' : isHeading(rest.split('\n')[0]) ? '\n\n' : overlap ? (open ? ' ' : '\n\n') : '\n\n';

  return joined ? base.slice(0, -1) + rest : base + sep + rest;
}

// English + Italian section words. Deliberately no bare "note":
// "Note che..." opens far too many ordinary prose paragraphs.
const HEADING = /^(chapter|chap\.|part|section|canto|act|scene|prologue|epilogue|interlude|preface|foreword|introduction|contents|appendix|afterword|notes|glossary|capitolo|parte|libro|sezione|atto|scena|prologo|epilogo|prefazione|premessa|introduzione|indice|sommario|appendice|postfazione|avvertenza)\b/i;
const NUMERAL = /^(?:[IVXLCDM]{1,7}|\d{1,3})\.?$/;

/** Is this paragraph a chapter heading? Conservative on purpose: a false split is worse than a missing one. */
export function isHeading(block) {
  const lines = block.split('\n').filter(l => l.trim());
  if (lines.length > 2) return false;
  const s = lines.join(' ').trim();
  if (!s || s.length > 72) return false;
  if (HEADING.test(s)) return true;
  if (NUMERAL.test(s)) return true;
  // A short all-caps line ("THE END", "PART TWO") — headings, not prose.
  return s.length <= 48 && /^[^a-z]*$/.test(s) && /[A-Z]{3}/.test(s);
}

/** Split a document into { title, body[] } chapters. Unheaded preamble becomes chapter 0. */
export function chapterize(text) {
  const chapters = [{ title: '', body: [] }];
  for (const block of String(text ?? '').split(/\n{2,}/)) {
    const b = block.trim();
    if (!b) continue;
    if (isHeading(b)) chapters.push({ title: b.split('\n').map(s => s.trim()).filter(Boolean).join(' '), body: [] });
    else chapters[chapters.length - 1].body.push(b);
  }
  return chapters.filter(c => c.title || c.body.length);
}

export const wordCount = text => String(text ?? '').split(/\s+/).filter(Boolean).length;

export function toPlainText(title, text) {
  return `${title}\n\n${text}`.trim() + '\n';
}

export function toMarkdown(title, text) {
  const parts = [`# ${title}`, ''];
  for (const c of chapterize(text)) {
    if (c.title) parts.push(`## ${c.title}`, '');
    for (const p of c.body) parts.push(p, '');
  }
  return parts.join('\n');
}
