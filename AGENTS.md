# AGENTS.md

`Turn` — a PWA that photographs pages, OCRs them locally, and exports text, Markdown or EPUB. Vanilla ES modules, no framework, no build step, no bundler. `tesseract.js` is the only runtime dependency and it loads from a CDN inside `loadLib()`.

Deployed from `main` to GitHub Pages at `https://stockmind.github.io/turn/`.

## Commands

```sh
node test.mjs                 # 21 tests: text pipeline + EPUB byte layout. Must stay green.
python3 -m http.server 8080   # http://localhost:8080 — camera works on localhost
```

Deployment is `git push origin main`; Pages rebuilds itself. Nothing to build, nothing to publish by hand.

## Rules

- **`text.js` and `epub.js` stay DOM-free and node-testable.** New text logic and new packaging logic go there, with a test in `test.mjs`. `app.js` owns the DOM, the camera and storage.
- **Reuse over addition.** No new dependency without a measurement that a few lines cannot do the job. No framework, no CSS library, no build pipeline.
- **Relative URLs only** (`./app.js`, `./icons/…`). The site is served from a subpath, so `/app.js` breaks it.
- **Bump `CACHE` in `sw.js` in the same commit as any asset change.** The service worker is cache-first, so an installed phone otherwise keeps the old shell forever.
- **EPUB invariants:** `mimetype` is the first entry, stored (method 0) with no extra field; every text node is XML-escaped; `dcterms:modified` is present. `test.mjs` asserts all four.
- **IndexedDB schema changes bump the DB version** in `app.js` and create the store inside `onupgradeneeded`. Never assume a fresh database.
- **Camera requires HTTPS** (or localhost). The capture crop maps the on-screen guide onto the video frame with `object-fit: cover` math in `grab()`; that function is the single place to touch for orientation problems.
- Every step ends verifiable: a change is done when `node test.mjs` passes and the file it touches is the one described by the docs below. Timings and camera behaviour can only be verified on a device — say which claims are untested.

## Reference

- `docs/architecture.md` — screens, capture loop and its thresholds, OCR queue, storage, offline shell, deployment.
- `docs/text-pipeline.md` — reflow, de-duplication, chapter detection: the heuristics, their thresholds, and how to tune them.
- `docs/adding-a-language.md` — adding an OCR language and its section words, with the fixture procedure.
- `README.md` — user-facing overview and known limits.

Conventional Commits, single-line messages.
