# Text pipeline

Everything here lives in `text.js` and is testable without a browser: `node test.mjs`. OCR output is a flat stream of hard-wrapped lines, and this file turns it back into paragraphs and chapters.

```
raw OCR text
   │  cleanPage()      drop folios, rejoin wrapped lines, repair hyphenation, split paragraphs
   ▼
page text
   │  appendPage()     drop lines already at the tail, stitch the joint (document-level)
   ▼
document text (paragraphs separated by blank lines, headings inline)
   │  chapterize()     split on section words / numerals / short all-caps, at export time
   ▼
EPUB · Markdown · plain text
```

## cleanPage

1. **Folios.** A line in the first or last two lines of the page that is nothing but digits or an uppercase roman numeral is dropped (`FOLIO`). The uppercase restriction is what keeps a line reading `civil` — which looks like roman numerals — alive.
2. **Reflow.** Lines are appended to a buffer until one ends its sentence *and* stops short of the measure: `/[.!?…"'\p{Pe}\p{Pf}]$/` plus `lastLen < longest * 0.92`, where `longest` is the widest line on the page and `lastLen` is the length of the last original line, not of the buffer. Using the buffer length instead is a bug that shows up as paragraphs swallowing each other after a hyphen join.
3. **Hyphenation.** `impu-` + `dence` → `impudence`, using `\p{L}` / `\p{Ll}` so accented continuations (`è`, `à`) join too.
4. **Headings.** If the buffer already looks like a heading when the next line arrives, it is flushed on its own. This matters because tesseract only emits a blank line where the vertical gap is large; tight leading otherwise glues `CAPITOLO PRIMO` onto the body.

## appendPage

Three things can go wrong at a page boundary, and each has a rule:

- **Same lines again.** The largest overlap `n ∈ 1..6` where the last `n` lines of the document match the first `n` lines of the page (fuzzy, ≥ 82 % character agreement via `sameLine`) is removed from the page. A whole repeated page removes everything and the document is unchanged.
- **The joint.** A word split across the break is rejoined. Otherwise a page that ends with a short, closed line starts a new paragraph; anything else runs on with a space. The width reference is the widest line in the **whole document**, not the page — a page of short lines would otherwise look like a page of full ones.
- **A section starting mid-page.** If the first line of the incoming page is a heading, the separator is always a paragraph break.

Fuzzy matching tolerates OCR drift (`empfy` matches `empty`), which is why `appendPage` compares normalised words rather than raw strings.

## chapterize / isHeading

A paragraph is a heading when it is at most two lines, at most 72 characters, and one of:

- starts with a section word — `chapter`, `part`, `section`, `canto`, `act`, `scene`, `prologue`, `epilogue`, `interlude`, `preface`, `foreword`, `introduction`, `contents`, `appendix`, `afterword`, `notes`, `glossary` and the Italian `capitolo`, `parte`, `libro`, `sezione`, `atto`, `scena`, `prologo`, `epilogo`, `prefazione`, `premessa`, `introduzione`, `indice`, `sommario`, `appendice`, `postfazione`, `avvertenza`;
- is a bare numeral (`XIV`, `7`);
- is short and all-caps (`THE END`, `PART TWO`).

Deliberate tradeoff: bare `Note` / `Nota` is **not** a heading word. It opens ordinary prose far more often than it titles a section, and a false split damages the export more than a missed one.

## Tuning

- Thresholds live next to the code they affect (`FOLIO`, the `0.92` measure factor, the `0.82` similarity, `HEADING`). Change one at a time and re-run `node test.mjs`.
- Every heuristic has a test built from **verbatim tesseract output**, not invented strings. When a real page reads wrong, paste the raw `data.text` into `test.mjs` as `OCR_PAGE`, write the expected result, then fix the rule. Fixtures invented from tidy prose hide exactly the failures that matter.
- Prefer a conservative rule. An un-split paragraph is a cosmetic defect; a chapter split in the middle of a sentence is a broken export.
