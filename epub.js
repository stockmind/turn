// epub.js — EPUB 3 builder with a minimal stored (uncompressed) zip writer.
// No dependencies; output validates as an ordinary zip with the required
// `mimetype` first entry. Tested in test.mjs.

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const utf8 = new TextEncoder();

/** files: [{ name, data: Uint8Array|string }] -> Uint8Array (all entries stored). */
export function zip(files) {
  const parts = [];
  const dir = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  for (const f of files) {
    const name = utf8.encode(f.name);
    const data = typeof f.data === 'string' ? utf8.encode(f.data) : f.data;
    const crc = crc32(data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);          // version needed
    local.setUint16(6, 0x0800, true);      // UTF-8 names
    local.setUint16(8, 0, true);           // stored
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);             // version made by
    cd.setUint16(6, 20, true);             // version needed
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, dosTime, true);
    cd.setUint16(14, dosDate, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    dir.push(new Uint8Array(cd.buffer), name);

    offset += 30 + name.length + data.length;
  }

  const dirSize = dir.reduce((n, a) => n + a.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, dirSize, true);
  end.setUint32(16, offset, true);
  parts.push(...dir, new Uint8Array(end.buffer));

  const total = parts.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const a of parts) { out.set(a, at); at += a.length; }
  return out;
}

const esc = s => String(s ?? '')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const XHTML = (title, body, extra = '') => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en">
<head>
<meta charset="utf-8"/>
<title>${esc(title)}</title>
<link rel="stylesheet" type="text/css" href="style.css"/>
${extra}</head>
<body>
${body}
</body>
</html>`;

const CSS = `body{font-family:"Iowan Old Style",Palatino,Georgia,serif;line-height:1.6;margin:5% 7%}
h1{font-size:1.5em;font-weight:600;letter-spacing:.02em;margin:2.2em 0 1em;page-break-before:always;break-before:page}
h1:first-child{margin-top:0;page-break-before:auto;break-before:auto}
p{margin:0 0 .75em;text-align:justify;hyphens:auto}
.title{font-size:2em;letter-spacing:.02em}`;

/**
 * buildEpub({ title, author, language, chapters }) -> Uint8Array
 * chapters: [{ title, body: string[] }]
 */
export function buildEpub({ title = 'Untitled', author = '', language = 'en', chapters = [] }) {
  const doc = chapters.length ? chapters : [{ title: '', body: [''] }];
  const id = 'urn:uuid:' + (globalThis.crypto?.randomUUID?.() ?? '00000000-0000-4000-8000-' + Date.now().toString(16).padStart(12, '0'));

  const files = doc.map((c, i) => ({
    href: `c${i + 1}.xhtml`,
    html: XHTML(c.title || title,
      (c.title ? `<h1>${esc(c.title)}</h1>\n` : '') + c.body.map(p => `<p>${esc(p).replace(/\n/g, '<br/>')}</p>`).join('\n')),
  }));

  const nav = XHTML('Contents',
    `<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>` +
    files.map((f, i) => `<li><a href="${f.href}">${esc(doc[i].title || (i === 0 ? 'Start' : 'Section ' + (i + 1)))}</a></li>`).join('') +
    `</ol></nav>`);

  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="${esc(language)}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="pub-id">${esc(id)}</dc:identifier>
<dc:title>${esc(title)}</dc:title>
<dc:language>${esc(language)}</dc:language>
${author ? `<dc:creator>${esc(author)}</dc:creator>\n` : ''}<meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="css" href="style.css" media-type="text/css"/>
${files.map((f, i) => `<item id="i${i + 1}" href="${f.href}" media-type="application/xhtml+xml"/>`).join('\n')}
</manifest>
<spine>
${files.map((_, i) => `<itemref idref="i${i + 1}"/>`).join('\n')}
</spine>
</package>`;

  return zip([
    { name: 'mimetype', data: 'application/epub+zip' }, // must be first, stored, no extra field
    {
      name: 'META-INF/container.xml',
      data: `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
    },
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/nav.xhtml', data: nav },
    { name: 'OEBPS/style.css', data: CSS },
    ...files.map(f => ({ name: 'OEBPS/' + f.href, data: f.html })),
  ]);
}
