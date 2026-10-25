# Turn

Point the camera at a document, turn the pages, get an EPUB back. Runs entirely on the phone — no account, no upload, no server.

Web app (PWA). iOS Safari, Add to Home Screen.

**Live:** https://stockmind.github.io/turn/ · repo: https://github.com/stockmind/turn

## How it works

The capture screen watches the camera at ~9 fps on a 64×48 greyscale copy of the frame and measures two things: **motion** (mean pixel change) and **structure** (edge density). When the page is still for ~0.6 s and there is text in the frame, it fires the shutter itself, flashes the frame verdigris and says *Turn the page*. Two signals, no ML, ~40 lines.

Each shot is cropped to the crop-mark frame, encoded as JPEG and pushed onto a queue. One tesseract.js worker drains the queue in the background, so turning pages faster than OCR is fine — the tally shows `reading N` until it catches up.

Per page, then:

1. `cleanPage` drops folio/running-head lines, rejoins hard-wrapped lines, repairs end-of-line hyphenation, splits paragraphs where a line ends its sentence short of the measure.
2. `appendPage` throws away lines already at the tail of the document (re-shot page, overlapping shot), stitches the join, and rejoins words split across the page break.
3. `chapterize` (at export) splits on `CHAPTER I.`, `CAPITOLO PRIMO`, `PARTE SECONDA`, bare numerals and short all-caps lines.

**Languages:** English and Italian, picked from the `English / Italiano` selector and stored per document, so switching it later does not corrupt an export. The default follows the device language on first run. Section-word detection (`Capitolo`, `Prefazione`, `Indice`, …) is independent of the OCR language — either list works either way.

Export: **EPUB 3** (paragraphs + real chapter headings + a TOC, hand-written zip writer, no dependencies), **Markdown**, **plain text**. On iOS the export goes through the share sheet, so it lands in Files, Mail or any reader directly.

Documents are stored in IndexedDB under the app's origin. Clearing website data deletes them — export anything you care about.

## Run it

Needs HTTPS (or localhost) — the camera is unavailable on plain http.

```sh
python3 -m http.server 8080          # http://localhost:8080, camera works here
npx serve                            # ditto
```

For the phone, put the folder behind any HTTPS origin:

```sh
cloudflared tunnel --url http://localhost:8080     # quick tunnel, one-off URL
```

or push the folder to GitHub/Cloudflare Pages. There is no server component; static hosting is enough. Then Safari → Share → **Add to Home Screen**.

The OCR engine (tesseract.js + the chosen language model, ~5 MB) is fetched from jsDelivr on first scan and cached by the browser afterwards. Everything else is local and cached by the service worker.

## Develop

```
index.html          markup, three screens: library / capture / read
style.css           all styling
app.js              camera, auto-capture, OCR queue, storage, export
text.js             pure text pipeline (no DOM) — the part worth reading
epub.js             ZIP writer + EPUB 3 packaging (no DOM)
test.mjs            node test.mjs
icons/make-icons.py regenerate the PNG icons
```

`node test.mjs` covers the text pipeline against verbatim tesseract output (English and Italian) and validates the EPUB byte layout (mimetype first and stored, manifest, nav, chapter files, XML escaping).

## Known limits

- **Two languages only.** `LANGS` and `LANG_NAME` in `app.js` are the whole of it — add a tesseract code, a manifest-free extra model downloads on first use.
- **No bold/italic.** Paragraph and heading structure is recovered; character-level style is not. Detecting it needs per-word stroke-weight and slant measurement against the page median — ~a day of work, ~85% accurate, best added after a real scan and the failures are visible.
- **Two-line chapter headings** can glue to the body when OCR emits no paragraph gap. Single-line headings are handled.
- **Bare `Note` / `Nota` is not treated as a heading** — it is far more often the first word of a paragraph than a section title.
- **One column, no tables, no footnotes.** Two-column pages read across the gutter.
- Page curvature, fingers and shadow are not corrected — the crop is flat. Fill the frame, keep the page flat, avoid a shadow across the spine.
- ~1–4 s of OCR per page on a phone; the queue hides it, memory does not.
- Captures are cropped with CSS `object-fit: cover` math. If a capture ever comes out sideways on a specific iOS version, the frame's orientation disagrees with `drawImage` and `grab()` is the one function to touch.
