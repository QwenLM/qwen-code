# `/export html` runtime size — verification plan (#11031 / PR #11038)

**Audience:** an agent (or person) on a machine that can run `npm install`, vite/esbuild
builds, vitest and Playwright. The machine that wrote the change could not, so **every
number and every test result below is unverified** — that is the whole point of this
document.

This file lives on the PR branch itself, so the only thing you need to be handed is the
branch name:

```bash
git clone --depth=1 --branch issue-11031 https://github.com/QwenLM/qwen-code.git
# then read docs/verification/export-html-runtime-size/README.md
```

Commit your findings next to it as `results.md` (the `abort-controller-refactor/`
package in this directory is the shape to follow) and/or reply on the PR.

- PR: <https://github.com/QwenLM/qwen-code/pull/11038> (branch `issue-11031`)
- Issue: <https://github.com/QwenLM/qwen-code/issues/11031>
- Commits under test:
  - `9515e5b78d` — PR author's original fix (transcript-only subpath entry + byte budget)
  - `a9ff4f485b` — follow-up: strip Shiki, drop CodeMirror, structural guard, CSS-key fix

Read §6 first if you only have time for one thing: two constants in the repo are
**known to be stale** and must be replaced with measured values.

---

## 1. What changed and why it needs measuring

| Change                                                  | Where                                                                            | What it should do                                                           |
| ------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Transcript-only entry `@qwen-code/web-shell/transcript` | `packages/web-shell/client/transcript.ts`                                        | Keeps `App`, daemon providers and app chrome out of the export              |
| Shiki resolved to a stub in the document build          | `packages/web-templates/src/export-html/build.mjs`, `src/document-shiki-stub.ts` | Removes ~9.7 MB of pre-minify input that document mode never executes       |
| Composer-tag getters moved out of the CodeMirror module | `packages/web-shell/client/utils/composerTag.ts`                                 | Removes ~1 MB of CodeMirror from the transcript graph                       |
| Structural guard on the document bundle                 | `FORBIDDEN_DOCUMENT_INPUTS` in `build.mjs`                                       | Fails the build if Shiki / the web-shell package root / CodeMirror reappear |
| Per-entry CSS injection key                             | `packages/web-shell/vite.lib.config.ts`, `client/shadowDom.ts`                   | Stops the transcript stylesheet from suppressing the full one               |

The two size claims in the table are **estimates read off the issue's triage comment**,
not measurements. Steps 3 and 4 turn them into facts.

Rationale for stubbing Shiki (verify this premise, see §5.3): `CodeBlock` in
`packages/web-shell/client/components/messages/Markdown.tsx` returns before touching the
highlighter when `renderMode === 'document'`, and its render branch always emits a plain
`<pre>` in that mode. The export's CSP (`script-src 'nonce-…'`, no `'wasm-unsafe-eval'`)
would also block Shiki's Oniguruma WASM engine from starting.

---

## 2. Setup

```bash
cd <your clone of issue-11031>
git log --oneline -2          # expect a9ff4f485b (or later) on top of 9515e5b78d
npm install                   # runs every workspace build as postinstall; ~25 min
```

If `npm install` did not build the workspaces, build the two that matter, in this order
(`web-templates` resolves `@qwen-code/web-shell/transcript` to `web-shell`'s `dist/`, so
web-shell must be built first):

```bash
npm run build --workspace=@qwen-code/web-shell
npm run build --workspace=@qwen-code/web-templates
```

`web-shell`'s build now runs **three** vite passes (app, lib, lib `--mode transcript`)
plus `tsc`. Note the wall-clock time — if the third pass adds more than ~90 s, say so;
it is a cost the PR pays on every CI build.

---

## 3. Primary measurement — export size

```bash
cd packages/web-templates
EXPORT_HTML_METAFILE=/tmp/document-metafile.json node src/export-html/build.mjs
```

The build prints three lines that matter:

```
Document export top inputs (pre-minify bytes): <pkg> <bytes>, ...
Document export runtime is <N> bytes
```

Then measure the generated templates (the actual `/export html` file is the template
plus a small data envelope):

> **Changed by #9812 (merged 2026-09-05).** The renderer is no longer inlined into
> `document.html`. That file is now a small template that loads a version-pinned,
> SRI-protected `export-transcript-document.js` from unpkg, and the legacy
> `index.html` renderer is gone. **Measure the asset, not the template** — it is the
> download every reader of an exported file now pays before the transcript renders.

```bash
wc -c src/export-html/dist/export-transcript-document.js   # the renderer asset — the number that matters
gzip -9 -c src/export-html/dist/export-transcript-document.js | wc -c
wc -c src/export-html/dist/document.html                   # template only; now small
```

**Record all of these.** Known reference points, all from the PR author's machine:

All rows below were taken **before #9812**, when the runtime was still inlined, so
`document.html` raw ≈ the runtime. Compare them against the new
`export-transcript-document.js` asset, not against the new `document.html`.

| Revision                      | `document.html` raw |      gzip | inline runtime |
| ----------------------------- | ------------------: | --------: | -------------: |
| `main` (before any fix)       |          19,525,807 | 4,775,943 |     19,523,259 |
| `9515e5b78d` (PR as reviewed) |          17,966,485 | 4,512,650 |     17,963,937 |
| `a9ff4f485b` (with follow-up) |               **?** |     **?** |          **?** |
| legacy renderer `index.html`  |             311,854 |         — |              — |

To get the middle row on your own machine for a like-for-like delta:

```bash
git stash list; git -C ../.. checkout 9515e5b78d -- .   # or: git checkout 9515e5b78d && rebuild
```

Cleanest is a second clone at `9515e5b78d`, built the same way — the numbers above came
from a different machine and a different `node_modules`.

### What "good" looks like

There is no target number, only a direction: the follow-up commit should remove Shiki
and CodeMirror entirely, so **expect a multi-MB drop**, not a few hundred KB. If the
drop is under ~2 MB, something did not take effect — check the top-inputs line for
`shiki` / `@shikijs` / `codemirror` (they should be absent) and report it.

---

## 4. Input breakdown — where the remaining bytes are

```bash
node -e '
const m = require("/tmp/document-metafile.json");
const by = new Map();
for (const [k, v] of Object.entries(m.inputs)) {
  const p = k.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//);
  const key = p ? p[1] : "first-party";
  by.set(key, (by.get(key) ?? 0) + v.bytes);
}
for (const [k, v] of [...by].sort((a,b)=>b[1]-a[1]).slice(0,25))
  console.log(String(v).padStart(10), k);
'
```

**Report this whole table.** It is the input to the open product decision in §7, and it
is the first thing anyone will want when the next size regression lands.

Expected shape after the follow-up: `mermaid`, `echarts`/`zrender`, `lucide-react`,
`react-markdown` + `remark-*`/`rehype-*`, `katex`. Expected **absent**: `shiki`,
`@shikijs/*`, `codemirror`, `@codemirror/*`, `vaul`, `@qwen-code/web-shell/dist/index.js`.

---

## 5. Correctness checks

### 5.1 Tests

```bash
# web-shell — the moved module, the shadow-DOM reader, the new build assertions
npx vitest run --config vitest.config.ts \
  client/build-artifact.test.ts \
  client/utils/composerTag.test.ts \
  client/hooks/useComposerCore.test.ts \
  client/hooks/useComposerCore.dom.test.tsx \
  client/hooks/useComposerCore.mobile.dom.test.tsx \
  client/components/messages/UserMessage.test.tsx \
  client/components/messages/Markdown.test.ts \
  client/components/messages/Markdown.coldHighlight.test.ts \
  client/components/messages/Markdown.mermaid.test.ts \
  client/shadowDom.test.ts \
  client/index.test.tsx
npm run typecheck --workspace=@qwen-code/web-shell

# cli — the export formatter and document envelope
npx vitest run \
  src/ui/utils/export/formatters/html.test.ts \
  src/ui/utils/export/export-transcript-document.test.ts
npm run typecheck --workspace=@qwen-code/qwen-code
```

`client/build-artifact.test.ts` reads `packages/web-shell/dist/*.js`, so it only means
anything **after** a web-shell build. Its three new cases are the ones to watch:
they assert `dist/transcript.js` has no `@codemirror/` / `codemirror` / `vaul`, still
carries `react-markdown` and `WebShellTranscript`, and that the two entries inject their
stylesheets under distinct `data-qwen-web-shell-entry` keys.

If a `not.toContain` assertion fails, **do not relax it** — it means a module graph
reopened. Report the failing string and, from the metafile, what pulled it back in.

### 5.2 Rendering parity (the important one)

Removing Shiki and CodeMirror must be invisible in the rendered output. Reproduce the
PR's own parity method:

1. Take one export envelope containing a user message, an assistant markdown message
   with a fenced code block (with a language tag), a KaTeX expression, a list, and a
   mermaid diagram.
2. Inject it into `document.html` built at `9515e5b78d` and at `a9ff4f485b`.
3. Open both over `file://` in headless Chromium (Playwright is already a devDependency
   in `packages/web-shell`).
4. Compare: `document.body.dataset.renderComplete === 'true'`, the metadata sidebar,
   theme toggle, expand/collapse, the code block **and its language label**, the KaTeX
   output, the mermaid diagram, and full-page screenshots (md5).

**Mermaid is the one to watch.** Unlike Shiki, mermaid _is_ used in document mode
(`Markdown.tsx` has an explicit `documentMode` branch around `mermaid.render`), and
nothing in these commits should have touched it. If a mermaid diagram renders on
`9515e5b78d` but not on `a9ff4f485b`, that is a blocking regression — report it with the
console output.

Also confirm the **console is clean**: no `shiki is not bundled into /export html
documents` error. That string appearing means document mode reached the highlighter
after all and the premise in §5.3 is wrong.

### 5.3 Premise check — is Shiki really dead in document mode?

Independent of the screenshots, confirm the claim directly on `9515e5b78d`
(i.e. _before_ the stub, where the real Shiki is still bundled):

- Open an export containing a fenced code block with a language tag.
- Inspect the code block's DOM. It should be a plain `<pre><code>` with no per-token
  `<span style="color:…">` markup.
- Check the console for a CSP violation mentioning WebAssembly.

If instead you find highlighted tokens, **stop and report** — the Shiki stub would then
be a behaviour change, not dead-code removal, and the follow-up commit needs reverting
in part.

### 5.4 The interactive app still works

`shadowDom.ts` and `UserMessage.tsx`/`useComposerCore.ts` are on the live app path:

```bash
npm run test:e2e:smoke --workspace=@qwen-code/web-shell
```

Manual smoke, if the harness is available: open the web shell, type an `@` mention (the
CodeMirror composer and its tag chips), send it, and confirm the sent user message
renders its tag chips with the right labels — those chips go through the three getters
that moved.

---

## 6. Two constants that are known stale — please fix

`packages/web-templates/src/export-html/build.mjs`:

```js
const DOCUMENT_RUNTIME_WARNING_BYTES = 18_500_000;
const MAX_DOCUMENT_RUNTIME_BYTES = 19_000_000;
```

These were set against the `9515e5b78d` baseline of 17,963,937 and are now far above the
real size. Once you have the measured `Document export runtime is N bytes` from §3:

- `MAX_DOCUMENT_RUNTIME_BYTES` → roughly `N * 1.05`, rounded up to a readable number
- `DOCUMENT_RUNTIME_WARNING_BYTES` → roughly `N * 1.02`

and update the comment block above them with the measured baseline and the commit it was
measured at. A cap that sits 6 % above the truth is a ratchet; one that sits 40 % above
it is decoration.

---

## 7. Open decision to inform, not to make

After Shiki and CodeMirror are gone, the remaining payload is dominated by **mermaid
(~6 MB) and echarts (~4.3 MB)** — both genuinely used by document mode. Removing them
(rendering diagrams and charts as their source fences in exports) is the only remaining
way to approach the legacy renderer's 311,854 bytes without the CDN/release-asset
direction the issue proposed, which collides with the export's deliberate
offline/self-contained/nonce-only CSP design.

That is a product call, not a build fix. What is needed from this run is just the §4
table: the real cost of each, measured, so the call can be made on numbers.

---

## 8. What to report back

Write it to `docs/verification/export-html-runtime-size/results.md` on the branch (and
commit it — that is what makes the next person's job cheap), then summarise on the PR.

1. The filled-in row of the §3 table, plus the delta against `9515e5b78d`.
2. The §4 top-25 input table verbatim.
3. Pass/fail for every command in §5.1, with output for anything red.
4. §5.2 parity result: identical / different (with screenshots or a diff).
5. §5.3 premise: confirmed dead / **not** dead.
6. The two values you chose in §6, and whether you pushed that change.
7. Anything in the PR description at
   <https://github.com/QwenLM/qwen-code/pull/11038> that your numbers contradict — the
   current description's before/after table and its claim that the editor chrome and
   daemon SDK client "no longer ship" are both known to be wrong and need rewriting.

### Known-wrong claims in the current PR description

- "the remaining interactive-shell dead weight (App, daemon SDK client, editor/terminal
  chrome, app-only stylesheet portion) no longer ships" — **CodeMirror did still ship**
  at `9515e5b78d` (via `UserMessage → hooks/useComposerCore`); the follow-up commit is
  what removes it.
- The **daemon React SDK still ships** even after the follow-up. It is reachable from
  the transcript at five points, including `client/hooks/useMessages.ts`, which
  `WebShellTranscript` imports directly. Roughly 236 KB; deliberately left alone.
- The before/after size table is stale as of `a9ff4f485b`.
