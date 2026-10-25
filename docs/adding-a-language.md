# Adding a language

Two edits, no build step. English (`eng`) and Italian (`ita`) are wired today.

## 1 · The OCR model

`app.js`, top of the state section:

```js
const LANGS = ['eng', 'ita', 'deu'];
const LANG_NAME = { eng: 'English', ita: 'Italiano', deu: 'Deutsch' };
```

That is the whole wiring: `newDoc()` stamps `doc.lang` from the selector, `getWorker()` creates the tesseract worker with that code, and the model downloads from jsDelivr on the first scan in that language (~4 MB each). The `<select id="lang">` in `index.html` needs a matching `<option>`.

Language is per document, so an existing document keeps reading with the language it was started in even after the selector moves.

## 2 · Section words

`text.js`, the `HEADING` regex. Without this the text still reads correctly, it just never splits into chapters. Add the words the language actually uses for chapter/part/preface/index, and one test in `test.mjs`:

```js
test('german section words split chapters', () => {
  const de = 'VORWORT\n\nEin Wort vorab.\n\nKAPITEL I\n\nDer Anfang.';
  assert.deepEqual(chapterize(de).map(c => c.title), ['VORWORT', 'KAPITEL I']);
});
```

Two rules for adding words: lowercase in the regex (it is case-insensitive) and resist words that commonly open a sentence — a false chapter split is worse than a missed one.

## 3 · Verify against a real reading

Heuristics tuned on invented strings fail on real OCR. Render a page, read it, look at the output:

```sh
mkdir -p /tmp/ocrcheck && cd /tmp/ocrcheck
npm init -y && npm i tesseract.js@7

# a page image: heading, a justified paragraph, a hyphenated line, a folio
python3 - <<'PY'
from PIL import Image, ImageDraw, ImageFont
import textwrap
img = Image.new('RGB', (1240, 1754), (252, 250, 245)); d = ImageDraw.Draw(img)
f  = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf', 32)
fs = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf', 26)
d.text((110, 150), 'KAPITEL VII', font=f, fill=(20, 18, 16))
y = 250
for line in textwrap.wrap('Ein Satz, der lang genug ist, um ueber mehrere Zeilen zu laufen und dabei die Umbruchlogik zu pruefen. ' * 2, 46)[:-1]:
    d.text((110, y), line, font=fs, fill=(20, 18, 16)); y += 52
d.text((110, y), 'und noch ein Wort, das getrennt wird, näm-', font=fs, fill=(20, 18, 16)); y += 52
d.text((110, y), 'lich genau hier.', font=fs, fill=(20, 18, 16))
d.text((600, 1630), '121', font=fs, fill=(20, 18, 16))
img.save('page.png')
PY
```

then, from the project root:

```sh
node --input-type=module -e '
import { createWorker } from "/tmp/ocrcheck/node_modules/tesseract.js/src/index.js";
import { cleanPage, chapterize } from "./text.js";
const w = await createWorker("deu", 1, { logger: () => {} });
const { data } = await w.recognize("/tmp/ocrcheck/page.png");
await w.terminate();
const out = cleanPage(data.text);
console.log("RAW\n" + data.text + "\nCLEANED\n" + out + "\nCHAPTERS " + JSON.stringify(chapterize(out).map(c => c.title)));
'
```

Check four things: the heading is on its own paragraph, the folio line is gone, the hyphenated word is whole, and `CHAPTERS` lists the heading. If a rule fails, paste the `RAW` block into `test.mjs` as a fixture before changing the rule — see `docs/text-pipeline.md`.

## Limits worth knowing before choosing a language

- Reflow assumes **whitespace-delimited words** and lines wrapped at the right margin. Chinese, Japanese and Korean have no inter-word spaces, so `cleanPage` needs a different join rule; Thai and Lao break at word boundaries too.
- Right-to-left scripts (Arabic, Hebrew) will OCR, but the line ordering and the export order are untested.
- `sameLine` compares normalised words, so scripts written without spaces de-duplicate poorly.

None of these are hard blockers, but each is real work in `text.js`, not a one-line addition.
