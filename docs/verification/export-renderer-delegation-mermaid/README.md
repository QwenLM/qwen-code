# Export renderer delegation + Mermaid removal — verification plan (#11096 / #11091 / #11092)

**Audience:** an agent or person on a machine that can run `npm ci`, the
web-templates esbuild build, and vitest. The machine that wrote this change runs
none of them, so **every number below that is not marked "measured here" is
unverified**, and the two byte constants in `build.mjs` are deliberately left
loose until someone runs §2.

```bash
git clone --depth=1 --branch fix/export-renderer-delegation https://github.com/QwenLM/qwen-code.git
# then read docs/verification/export-renderer-delegation-mermaid/README.md
```

Commit findings next to this file as `results.md` (the `abort-controller-refactor/`
package in this directory is the shape to follow) and/or reply on the PR.

The older `docs/verification/export-html-runtime-size/README.md` covers #11038 and
is stale in several places; those corrections are tracked in #11142 and are
deliberately **not** part of this change, because this change moves the very
numbers that document would be corrected to. Fix it after §2 below produces them.

---

## 1. What changed, and what each part rests on

| Change | Rests on | Falsifiable by |
| --- | --- | --- |
| `mermaid` resolved to a stub in the document build, added to `FORBIDDEN_DOCUMENT_INPUTS` | document mode never reaching `MermaidBlock` after the `CodeBlock` guard | §3: a mermaid fence in an export that renders anything other than a plain `<pre>` |
| `QWEN_EXPORT_RENDERER_IDENTITY` / `_INTEGRITY` delegation | the envelope identity, the URL and the SRI hash all describing one published asset | §4: an export from a CI build that shows the "incompatible renderer version" page |
| `react-markdown` override to `^9` | `@datafe-open/markdown-chart-react` using only `createElement(ReactMarkdown, { components }, source)` | §5: a chart block that throws in the interactive app |

## 2. Re-measure and ratchet the budget — the first ask

`packages/web-templates/src/export-html/build.mjs` still carries
`DOCUMENT_RUNTIME_WARNING_BYTES = 7_300_000` and `MAX_DOCUMENT_RUNTIME_BYTES =
7_400_000`, measured by a reviewer on #11038 **before** mermaid was removed. This
change should drop the asset substantially, so those two constants are now a
ratchet with slack in it. They were not lowered here because lowering them
without a measurement risks failing every build; that is the trade this section
exists to close.

```bash
cd packages/web-templates && node src/export-html/build.mjs
```

Report both printed lines verbatim:

- `Document export runtime is N bytes`
- `Document export top inputs (pre-minify bytes): …`

Then set the two constants from the measured `N` — the file's own convention is a
small headroom over the measurement, not a percentage widening — and say in
`results.md` which values you chose.

**What "good" looks like:** a direction, not a target. `mermaid` (~2.88 MB
pre-minify), `@mermaid-js/parser` (~1.37 MB) and `cytoscape` (~1.11 MB) should be
gone from the top-inputs line entirely, and `lodash-es` should shrink or vanish
with them. Those three figures are quoted from the metafile a reviewer measured
on #11038's branch, not re-measured here. If `N` did not move by roughly that
order, the stub did not take effect — check the `FORBIDDEN_DOCUMENT_INPUTS`
throw fired rather than assuming the number.

The largest single remaining component is expected to be the 1,440,050 chars of
base64 KaTeX `@font-face` inside the inlined stylesheet (a reviewer's figure from
#11038, again not re-measured). Math is deliberately still rendered — see the
docblock in `src/document-mermaid-stub.ts` for why — but if §2's `N` is dominated
by that block, say so: it is the next decision, and it is not this PR's.

## 3. Mermaid in an exported document

```bash
cd packages/web-shell && npx vitest run client/components/messages/Markdown.test.tsx
cd packages/cli && npx vitest run src/ui/utils/export/formatters/html.test.ts src/ui/utils/export/export-transcript-document.test.ts
```

Working directories matter: this repo's vitest configs are per package, and a
root-level `npx vitest` does not resolve these filters (AGENTS.md, "Unit
Testing").

Then the product path: export a transcript containing a ```mermaid fence and open
the file. Expected: the fence renders as a plain `<pre>` holding its own mermaid
source, selectable and findable with the browser's own search — the same
degradation document mode already applies to syntax highlighting. Expected *not*
to happen: an empty box, a "Mermaid render failed" label, or a diagram.

The interactive app must be unaffected: the same fence in the web shell still
renders a diagram, with zoom/pan and the code toggle.

## 4. The delegated renderer actually loads

This is the part that is broken on `main` today (#11096) and the reason for the
CI wiring, so verify it end to end rather than by reading the template.

```bash
# with the CI values, i.e. what every CI lane now builds with
QWEN_EXPORT_RENDERER_IDENTITY='0.23.1-preview.0+d7962879afdccd34' \
QWEN_EXPORT_RENDERER_INTEGRITY='sha384-CVacTzaM6pEzmp3UrBJQ/WMSVZfvRxbrNJtCf1c03j4Gox5y9dqndkBoTQ3ktzzh' \
  node packages/web-templates/src/export-html/build.mjs
```

Measured here (2026-09-06, against live unpkg, no build):

- `https://unpkg.com/@qwen-code/qwen-code@0.23.1-preview.0/export-transcript-document.js`
  → HTTP 200, 19,521,168 bytes
- its embedded identity → `0.23.1-preview.0+d7962879afdccd34`
- `openssl dgst -sha384` over those bytes → the integrity value above
- the same URL at `@0.23.0` (npm `latest`) → HTTP 404

Then export an HTML file from that build and open it **with** network access.
Expected: the transcript renders. A "incompatible renderer version" page means
the identity and the asset disagree; a fail-closed load error means the SRI or
the URL does. Both are the failure this change exists to remove, so report either
as blocking.

Also confirm the negative: a build with neither variable set still derives the
URL from the root `package.json` version, and `build.mjs` throws if exactly one
of the two is set.

Note the consequence, which is intended: CI's exports render through the
**preview** renderer, which predates #11038 and still contains mermaid. So an
export produced by CI may render a diagram even though this change removed
diagrams from the renderer this branch builds. That divergence ends when a
release containing #9812 is on npm and the CI env is deleted.

## 5. The dependency override

Measured here: `npm ci --dry-run --ignore-scripts` on the modified tree plans
exactly one `react-markdown 9.1.0` and reports no lock/manifest mismatch. Not
measured here: anything that runs the code.

```bash
npm ci
cd packages/web-shell && npx vitest run client/components/messages
```

Then exercise a chart block (an ```echarts-fulldata fence) in the interactive
app. `@datafe-open/markdown-chart-react` declares `react-markdown@^10.1.0` and
now receives 9.1.0; its only use of the library is
`createElement(ReactMarkdown, { components }, props.source)` (read out of its
published `dist/index.js`), and web-shell imports `MarkdownChartBlock`,
`MarkdownChartProvider`, `createMarkdownChartComponents` and
`isRegisteredChartLanguage` from it — not the `MarkdownChart` component that
holds that call. If a chart still renders, the override is safe.

## 6. What to report back

1. §2's two printed lines, and the constants you set.
2. Pass/fail for every command in §3 and §5, with output for anything red.
3. §4's end-to-end result, including which of the two failure pages appeared if
   either did.
4. Anything in this document that turned out to be wrong. In particular: every
   byte figure quoted from #11038 is second-hand, and the claim that removing
   mermaid drops the asset "substantially" is an inference from the metafile, not
   a measurement.
