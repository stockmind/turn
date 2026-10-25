# Architecture

Three screens in one document, switched by `document.body.dataset.screen`: `home` (library), `capture`, `read`. CSS shows one `.screen` at a time, so no router and no view framework.

```
index.html   markup for all three screens
style.css    everything visual
app.js       camera, auto-capture, OCR queue, IndexedDB, export, wiring
text.js      pure text pipeline (no DOM)
epub.js      zip writer + EPUB 3 packaging (no DOM)
sw.js        app-shell cache
```

## State

`app.js` keeps one mutable `doc`:

```js
{ id, title, text, pages, lang, createdAt, updatedAt }
```

`text` is the whole document as paragraphs separated by blank lines, plus chapter heading paragraphs inline. Nothing else is persisted: chapters and exported files are derived at export time, so a text edit never has to migrate a structure. `pages` counts **successfully read** pages, not shots — a duplicate shot does not increment it.

Persistence is a single IndexedDB store `docs` (DB `turn`, keyPath `id`). Every mutation calls `save()`, which debounces 500 ms; `saveNow()` flushes on screen change, `visibilitychange` and `pagehide`.

## Capture loop

`startCam()` asks for `facingMode: environment` at 2560×1440 (iOS caps it), then runs `tick()` on `requestAnimationFrame`, throttled to ~9 fps.

Each tick draws the video into a 64×48 canvas and computes two numbers:

| Signal | How | Meaning |
|---|---|---|
| `diff` | mean absolute pixel change vs the previous frame | is the page still? |
| `ink` | fraction of horizontally adjacent pixels differing by >16 | is there text in frame? |

Constants at the top of the camera section:

```js
const STABLE  = 2.6;   // diff below this counts as still
const HOLD_MS = 620;   // stillness required before the shutter fires
const INK_MIN = 0.02;  // edge density that counts as text
```

When `diff < STABLE` continuously for `HOLD_MS` **and** `ink > INK_MIN` **and** the loop is armed, `capture()` fires: it crops the guide rectangle out of the frame (`grab()`), JPEG-encodes it, pushes it onto `queue`, flashes the frame, plays a tone and re-arms only after it sees the page move again (`moveFrames`). Re-arming on motion is what prevents a second shot of the same page; the 380 ms `lastShot` guard prevents double-taps.

Status text and the verdict of the loop come from the same four signals, so the chip never contradicts the shutter: `Turn the page` (just captured), `Fill the frame with the page` (no ink), `Hold steady` (moving), `Hold…` (accumulating stillness).

Feel free to retune `STABLE` and `HOLD_MS`; they trade missed pages against blurry ones. `INK_MIN` is the only one that affects what the shutter will accept as "a page".

## OCR

One `tesseract.js` worker, created lazily by `getWorker()` with the language of the active document (`doc.lang`), so switching the selector never re-reads a document in the wrong language. `pump()` drains `queue` serially and calls `addPage()` per result, which runs `cleanPage` → `appendPage` and saves.

The queue decouples capture pace from OCR pace: at 1–4 s per page the tally shows `reading N` while the camera keeps accepting pages. `finish()` awaits `waitForQueue()` before opening the read screen, so nothing is lost by leaving capture.

OCRing a `Blob` (not a data URL) keeps memory flat; the worker is never recreated per page.

## Export

`exportAs()` builds the file in memory and hands it to `deliver()`, which prefers `navigator.share({ files })` (on iOS this is the share sheet: Files, Mail, any reader) and falls back to an `<a download>` object URL. No server is involved at any point.

## Offline

`sw.js` caches the shell (`./`, `index.html`, `style.css`, `app.js`, `text.js`, `epub.js`, manifest, icons) cache-first, and passes cross-origin requests straight through. The OCR engine and language model come from jsDelivr and are cached by the browser's HTTP cache, not the service worker — so the shell works offline, the first scan needs a network.

`CACHE` in `sw.js` must be bumped whenever a cached asset changes; `activate` deletes every cache whose name is not the current one.

## Deployment

GitHub Pages, branch `main`, root. Static hosting is the whole story: no build artifacts, no server. The site lives under a subpath (`/turn/`), which is why every URL in the app is relative.

First run on a phone: Safari → Share → Add to Home Screen. The manifest is `standalone`, portrait, `#16130f` to match the capture screen.
