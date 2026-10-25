// test.mjs — node test.mjs
import assert from 'node:assert/strict';
import { cleanPage, sameLine, appendPage, isHeading, chapterize, toMarkdown, wordCount } from './text.js';
import { buildEpub, zip } from './epub.js';

let pass = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

/* ── OCR page cleanup ── */

test('drops the folio line, joins wrapped lines into one paragraph', () => {
  const raw = '42\nthe quick brown fox\njumps over the lazy\ndog, and then it\nkept running.\n';
  assert.equal(cleanPage(raw), 'the quick brown fox jumps over the lazy dog, and then it kept running.');
});

test('repairs words hyphenated at the line end', () => {
  assert.equal(cleanPage('This was an impor-\ntant point.'), 'This was an important point.');
});

test('keeps a real word that happens to look like roman numerals', () => {
  assert.equal(cleanPage('civil\ndisobedience was required.'), 'civil disobedience was required.');
});

test('a short closed line starts a new paragraph (dialogue)', () => {
  const out = cleanPage('He stopped.\n"Who is there?"\nThe hall stayed quiet for a long while.');
  assert.equal(out, 'He stopped.\n\n"Who is there?"\n\nThe hall stayed quiet for a long while.');
});

/* ── merging pages ── */

// Verbatim output of tesseract.js on a photographed-looking 300 dpi page.
const OCR_PAGE = `CHAPTER IIT
The lamp had been lit an hour before, and
the room was still full of the smell of rain
on stone. Nobody spoke for a long while, and
the only sound was the turning of pages in
the next room, where the doctor sat with his
back to the door and read the same paragraph
over and over without understanding a word
of it. It was, he thought, a remarkable
a remarkable piece of impu-
dence, and nothing more.

57
`;

test('real OCR output: heading splits off, folio dropped, hyphen repaired', () => {
  const out = cleanPage(OCR_PAGE);
  assert.equal(out.split('\n\n')[0], 'CHAPTER IIT');
  assert.match(out, /piece of impudence, and nothing more\.$/);
  assert.ok(!/^57$/m.test(out));
  assert.ok(chapterize(out).some(c => c.title === 'CHAPTER IIT'));
});

test('a chapter that starts mid-page gets its own paragraph', () => {
  const prev = 'The line of text ended in the middle of a sentence without any closing mark at all really';
  assert.match(appendPage(prev, 'CHAPTER IV\n\nNext morning.'), /really\n\nCHAPTER IV\n\nNext morning\./);
});

test('re-reading stored shots is idempotent when shots repeat', () => {
  // Scans are kept per shot, so a re-read replays duplicates the capture pass discarded.
  const once = appendPage('', cleanPage(OCR_PAGE));
  const thrice = [OCR_PAGE, OCR_PAGE, OCR_PAGE].reduce((t, raw) => appendPage(t, cleanPage(raw)), '');
  assert.equal(thrice, once);
  assert.match(thrice, /^CHAPTER IIT\n\n/);
});

test('a re-shot page is not appended twice', () => {
  const prev = 'Chapter One\n\nIt was a dark night.\n\nThe road was empty.';
  assert.equal(appendPage(prev, 'It was a dark night.\n\nThe road was empty.'), prev);
});

test('overlapping lines are cut, the rest is appended', () => {
  const prev = 'The carriage had stopped a little short of the gate, and nobody came out to meet it.\n\nIt was a dark night.';
  assert.equal(
    appendPage(prev, 'It was a dark night.\n\nA new paragraph follows.'),
    prev + '\n\nA new paragraph follows.',
  );
});

test('a word split across the page break is rejoined', () => {
  assert.equal(appendPage('It was an impor-', 'tant point.'), 'It was an important point.');
});

test('OCR drift in the overlap still counts as the same line', () => {
  assert.ok(sameLine('The road was empty.', 'The road was empfy.'));
  assert.ok(!sameLine('The road was empty.', 'She left the house.'));
});

/* ── chapters ── */

const DOC = 'PREFACE\n\nThis is a preface.\n\nCHAPTER I\n\nThe beginning.\n\nMore text.\n\nCHAPTER II\n\nThe end.';

test('splits on chapter headings', () => {
  const ch = chapterize(DOC);
  assert.deepEqual(ch.map(c => c.title), ['PREFACE', 'CHAPTER I', 'CHAPTER II']);
  assert.deepEqual(ch[1].body, ['The beginning.', 'More text.']);
});

test('recognises numeral and all-caps headings, ignores prose', () => {
  assert.ok(isHeading('XIV'));
  assert.ok(isHeading('THE END'));
  assert.ok(!isHeading('He walked into the room and found nobody there at all, which was strange.'));
  assert.ok(!isHeading('It is not a heading\nnor is this a heading\nnor this'));
});

test('markdown carries headings through', () => {
  assert.match(toMarkdown('Notes', DOC), /^# Notes\n\n## PREFACE\n\nThis is a preface\./);
  assert.equal(wordCount('one two  three\nfour'), 4);
});

/* ── italian ── */

test('italian section words split chapters', () => {
  const it = 'PREFAZIONE\n\nQuesta è la prefazione.\n\nCAPITOLO PRIMO\n\nIl principio di tutto.\n\nParte seconda\n\nLa fine, finalmente.';
  assert.deepEqual(chapterize(it).map(c => c.title), ['PREFAZIONE', 'CAPITOLO PRIMO', 'Parte seconda']);
});

test('italian prose starting with "Note che" is not a heading', () => {
  // Bare "Note"/"Nota" is a real section title sometimes, but far more often the
  // first word of a paragraph, so it is deliberately not a heading word.
  assert.ok(!isHeading('Note che il tempo passa'));
  assert.ok(!isHeading('Nota'));
});

test('italian hyphen join keeps accents intact', () => {
  assert.equal(cleanPage('La situa-\nzione è chiara.'), 'La situazione è chiara.');
  assert.equal(cleanPage('Un\'altra occa-\nsione, però.'), 'Un\'altra occasione, però.');
});

/* ── epub ── */

function entries(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();
  const out = [];
  let p = 0;
  while (p + 4 <= bytes.length && dv.getUint32(p, true) === 0x04034b50) {
    const method = dv.getUint16(p + 8, true);
    const size = dv.getUint32(p + 18, true);
    const nameLen = dv.getUint16(p + 26, true);
    const extraLen = dv.getUint16(p + 28, true);
    const start = p + 30 + nameLen + extraLen;
    out.push({
      name: dec.decode(bytes.subarray(p + 30, p + 30 + nameLen)),
      method, extraLen,
      text: dec.decode(bytes.subarray(start, start + size)),
    });
    p = start + size;
  }
  return out;
}

test('zip round-trips names and data', () => {
  const bytes = zip([{ name: 'a/b.txt', data: 'hello' }, { name: 'c.txt', data: 'there' }]);
  const e = entries(bytes);
  assert.deepEqual(e.map(x => x.name), ['a/b.txt', 'c.txt']);
  assert.equal(e[1].text, 'there');
});

test('epub: mimetype is the first entry, stored and unfiltered', () => {
  const e = entries(buildEpub({ title: 'Test Document', chapters: chapterize(DOC) }));
  assert.equal(e[0].name, 'mimetype');
  assert.equal(e[0].method, 0);
  assert.equal(e[0].extraLen, 0);
  assert.equal(e[0].text, 'application/epub+zip');
  assert.ok(e.every(x => x.method === 0));
});

test('epub: package, nav and chapter files are complete', () => {
  const e = entries(buildEpub({ title: 'Test Document', chapters: chapterize(DOC) }));
  const at = n => e.find(x => x.name === n).text;

  assert.ok(e.some(x => x.name === 'META-INF/container.xml'));
  assert.match(at('OEBPS/content.opf'), /<dc:title>Test Document<\/dc:title>/);
  assert.match(at('OEBPS/content.opf'), /dcterms:modified/);
  assert.match(at('OEBPS/content.opf'), /properties="nav"/);
  assert.match(at('OEBPS/nav.xhtml'), /CHAPTER II/);
  assert.match(at('OEBPS/c2.xhtml'), /<h1>CHAPTER I<\/h1>/);
  assert.match(at('OEBPS/c3.xhtml'), /The end\./);
});

test('epub: markup in scanned text is escaped, not injected', () => {
  const e = entries(buildEpub({ title: 'A & B', chapters: [{ title: 'x < y', body: ['Tom & Jerry <script>'] }] }));
  const at = n => e.find(x => x.name === n).text;
  assert.match(at('OEBPS/content.opf'), /<dc:title>A &amp; B<\/dc:title>/);
  assert.match(at('OEBPS/c1.xhtml'), /&lt;script&gt;/);
});

console.log(`\n${pass} passed${process.exitCode ? ', some failed' : ''}`);
