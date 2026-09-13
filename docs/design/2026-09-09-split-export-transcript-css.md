# Split the export transcript renderer's embedded CSS into a versioned asset

[English](2026-09-09-split-export-transcript-css.md) | [简体中文](2026-09-09-split-export-transcript-css.zh-CN.md)

Status: proposed (implemented, pending review). Issue: #11478.

## Problem statement

Every `/export html` chat document loads a single renderer asset,
`export-transcript-document.js`, from unpkg before it can render. At 0.23.2 that
asset is 4,134,210 bytes (~1.5 MB gzip), and more than half of it is not code:
the `injectCssModules` Vite plugin inlines the web-shell transcript component
stylesheet as a `const __qwenWebShellCss="…"` string literal at the top of
`packages/web-shell/dist/transcript.js`, and the export build
(`packages/web-templates/src/export-html/build.mjs`) bundles that literal
unchanged into the renderer.

Measured on this branch before the change:

| Part                                              |                         Bytes |
| ------------------------------------------------- | ----------------------------: |
| `dist/transcript.js` total                        |                     3,531,656 |
| CSS string literal (`__qwenWebShellCss`)          | 2,305,152 (2,302,457 decoded) |
| `export-transcript-document.js` (minified bundle) |                     4,136,297 |
| `document.html` template                          |                         6,606 |

Consequences:

- The size budget in `build.mjs` is already tripped: warning at 4,100,000, hard
  cap at 4,200,000, current build at ~4,139,302 — about 60 KB of headroom before
  every build fails.
- Browsers must download, parse and compile ~4 MB of JS before a transcript can
  render, even though 56% of those bytes are a string literal that only becomes
  CSS at injection time.

## Goal

At export build time, lift the web-shell component stylesheet out of the JS
bundle into a separate, version-pinned, SRI-protected
`export-transcript-document.css` asset served from unpkg alongside the renderer,
and reference it from the exported document with a nonce-bearing
`<link rel="stylesheet">`. The renderer JS drops to ~1.8 MB raw (~0.5 MB gzip),
and the CSS is fetched, parsed and cached separately.

## Scope boundaries

- **No changes to `@qwen-code/web-shell`** source or runtime behavior. The
  web-shell build still inlines the stylesheet for the interactive app and for
  any other consumer of `@qwen-code/web-shell/transcript`; only the export build
  strips it.
- The transform happens entirely in the export build via an esbuild `onLoad`
  plugin that intercepts `dist/transcript.js`, lifts the CSS literal, and feeds
  the bundler a stub.
- KaTeX, the transcript component graph, the document CSP and the
  `document-main.tsx` renderer all stay as they are.
- This does **not** reduce the total bytes an export downloads — it moves them
  out of the JS so each layer caches and parses separately. Deeper reductions
  (#11100 component-graph refactor, a KaTeX product decision) are out of scope.

## Feasibility already verified

- The transcript document uses no shadow DOM (`attachShadow` /
  `ShadowDomBoundary` do not appear in `dist/transcript.js`), so a `<link>` in
  `document.head` styles everything the export renders.
- `style-src-elem 'nonce-…'` already covers a nonce-bearing `<link>`; the
  per-export nonce is generated in
  `packages/cli/src/ui/utils/export/formatters/html.ts` and replaces every
  `__EXPORT_NONCE__` slot. No CSP relaxation.
- The injection shape is stable: `dist/transcript.js` starts with exactly two
  generated lines — the `const __qwenWebShellCss=…;` line and a 366-byte
  `if(typeof document!=="undefined"…)}` runtime-injection line — before the real
  transcript code. `client/build-artifact.test.ts` already parses the same shape.

## Proposed changes

### 1. `packages/web-templates/src/export-html/build.mjs`

- Add an esbuild `onLoad` plugin that reads the resolved file, matches
  `^const __qwenWebShellCss=("(?:[^"\\]|\\.)*");\n`, `JSON.parse`s the literal,
  strips the CSS constant line and the immediately-following runtime-injection
  line, and returns the remainder as `{ contents, loader: 'js' }`. Fail the
  build if either line is missing or moved.
- The plugin's filter lives in a new module,
  `packages/web-templates/src/export-html/transcript-css-entry.mjs`, which
  `build.mjs` imports:

  ```js
  export const TRANSCRIPT_CSS_ENTRY_FILTER =
    /web-shell[\\/]dist[\\/]transcript\.js$/;
  ```

  It is extracted because `build.mjs` is a top-level-await script with no
  harness, and the match decision is the part that determines whether the
  stylesheet is lifted at all — `scripts/tests/transcript-css-entry-filter.test.js`
  can only pin it if it is importable without running a full bundle.
  Both separators are in the character class because esbuild hands plugin
  callbacks the platform-native absolute path; on Windows that is
  `C:\repo\packages\web-shell\dist\transcript.js`, so a forward-slash-only
  pattern never matches there: the callback never runs, the extracted CSS stays
  `undefined`, and the mandatory guard below aborts every export build —
  including the one `npm ci` runs through the root `prepare` script. The
  `transcript\.js$` tail is load-bearing too, because a bare
  `web-shell[\\/]dist[\\/]` prefix would also match `web-shell/dist/index.js`,
  which `FORBIDDEN_DOCUMENT_INPUTS` bars from every export.

- Write the decoded CSS to `dist/export-transcript-document.css`.
- Derive `export-transcript-document.css`'s URL and `sha384-` SRI exactly as the
  JS asset does today, and add the two placeholders to the template replace
  chain and to the residual-placeholder guard.
- Re-measure and ratchet the budget constants against the JS bundle alone (the
  parse/compile-critical asset), and log the CSS asset size separately.

### 2. `packages/web-templates/src/export-html/src/document-index.html`

- Add, after the existing inline `<style>`, a
  `<link rel="stylesheet" nonce="__EXPORT_NONCE__" id="transcript-stylesheet" integrity="__DOCUMENT_RENDERER_CSS_INTEGRITY__" crossorigin="anonymous" href="__DOCUMENT_RENDERER_CSS_URL__" />`.
  The `<link>` goes _after_ the inline `<style>` so the component sheet wins
  every equal-specificity tie by document order (`:where(...)` scoping
  contributes zero specificity).
- Extend the existing fail-closed `showLoadError` listener in the body script to
  also treat `event.target.id === 'transcript-stylesheet'` as a load failure.
- **Latch the stylesheet failure in `<head>`, ahead of the `<link>`.** The body
  listener alone is not sufficient: Chromium parser-blocks the inline body
  script on the pending head stylesheet, so on a large document a CSS failure
  that settles before the parser is released is dispatched while no listener
  exists yet — nothing marks the render as failed and the transcript renders
  unstyled while stamping `data-render-complete="true"`. So a
  `<script nonce="__EXPORT_NONCE__">` immediately before the `<link>` registers a
  **capture-phase** `error` listener (resource error events do not bubble) that
  sets `window.__transcriptStyleFailed = true` when the failing element's id is
  `transcript-stylesheet`, and the existing body IIFE ends with
  `if (window.__transcriptStyleFailed) { showLoadError(); }`.
  Two constraints shape it: the script must carry the nonce because `script-src`
  has no `'unsafe-inline'` (and `formatters/html.ts` replaces every
  `__EXPORT_NONCE__` slot), and it must be **record-only** — `showLoadError`
  writes `document.body.dataset` and `#app`, neither of which exists while the
  parser is still in `<head>`. The latch's position ahead of the `<link>` is the
  whole fix; `scripts/tests/export-transcript-document-template.test.js` pins
  that position, the nonce, the capture phase, the record-only shape, and that
  both listeners compare against the id the `<link>` actually carries.

### 3. `packages/web-templates/src/export-html/src/document-main.tsx`

- Guard the mount itself at module scope: `createRoot` / `root.render` only run
  when `document.body.dataset.renderComplete !== 'error'`. This is the guard
  that decides whether the transcript renders at all after an asset failed to
  load, leaving the inline `showLoadError` alert in place rather than replacing
  it with an unstyled transcript.

### 4. Packaging scripts

- `scripts/copy_bundle_assets.js`: copy
  `packages/web-templates/src/export-html/dist/export-transcript-document.css`
  into `dist/` alongside the JS renderer.
- `scripts/prepare-package.js`: require the CSS in `verifyBundleArtifacts` and
  list it in the published `files`.
- `scripts/create-standalone-package.js`: add the CSS to
  `DIST_NPM_PACKAGE_ONLY_ENTRIES` (standalone archives do not ship the renderer;
  exported files load it from unpkg).

### 5. Tests and docs

- `packages/cli/src/ui/utils/export/formatters/html.test.ts`: assert the `<link>`
  URL, integrity and nonce.
- `integration-tests/chat-transcript-document.test.ts`: fulfil the CSS request
  from the built asset, assert it is the only stylesheet request, and add a
  fail-closed case for a missing stylesheet.
- `scripts/tests/package-assets.test.js` / `scripts/tests/install-script.test.js`:
  cover the CSS in the copy / publish / standalone-skip paths.
- `scripts/tests/transcript-css-entry-filter.test.js`: pin the `onLoad` filter
  (both path separators, and that the barred `web-shell/dist/index.js` entry does
  not match) without running a bundle.
- `scripts/tests/export-transcript-document-template.test.js`: pin the `<head>`
  latch — position ahead of the `<link>`, nonce, capture phase, record-only
  shape, body-side consumption, and that both listeners compare the id the
  `<link>` carries.
- `docs/verification/export-html-runtime-size/README.md`: update the measurement
  instructions to cover both assets.

## Files affected

- `packages/web-templates/src/export-html/build.mjs`
- `packages/web-templates/src/export-html/transcript-css-entry.mjs`
- `packages/web-templates/src/export-html/src/document-index.html`
- `packages/web-templates/src/export-html/src/document-main.tsx`
- `scripts/copy_bundle_assets.js`
- `scripts/prepare-package.js`
- `scripts/create-standalone-package.js`
- `packages/cli/src/ui/utils/export/formatters/html.test.ts`
- `integration-tests/chat-transcript-document.test.ts`
- `scripts/tests/package-assets.test.js`
- `scripts/tests/install-script.test.js`
- `scripts/tests/export-transcript-document-template.test.js`
- `scripts/tests/transcript-css-entry-filter.test.js`
- `docs/verification/export-html-runtime-size/README.md`

## Design decisions and rationale

- **`onLoad` strip instead of changing the web-shell build.** The issue's
  constraint is that web-shell keep its runtime behavior (it still needs to
  inject its own stylesheet into the interactive app and any other consumer).
  Stripping at the export-build boundary keeps the two consumers independent and
  leaves the web-shell contract untouched.
- **Keep the document shell's own `document-styles.css` inlined.** It is a few KB
  and specific to the export chrome; the target is only the ~2.3 MB web-shell
  component stylesheet.
- **CSS published verbatim (already scoped).** `injectCssModules` already scopes
  and de-duplicates the CSS via `scopeComponentCss`; the export build just lifts
  that exact string, so no re-minification or re-scoping risk is introduced.
- **SRI per asset.** The JS and CSS are distinct published bytes, so each gets
  its own `sha384-` digest; the CSS is version-pinned by the same unpkg
  `@<version>` path as the JS.

## Acceptance criteria

- `node src/export-html/build.mjs` succeeds, prints the renderer JS size (~1.8 MB)
  and the CSS asset size (~2.3 MB), and writes `export-transcript-document.css`.
- `export-transcript-document.js` no longer contains the `__qwenWebShellCss`
  literal; `export-transcript-document.css` contains the scoped stylesheet.
- The exported document renders with full styling in a real browser
  (`integration-tests/chat-transcript-document.test.ts` passes), and a missing
  CSS asset fails closed with the load-error page.
- Packaging tests pass; the CSS is published in the npm package and excluded from
  standalone archives.

## Open questions

None blocking. The delegate knob (`QWEN_EXPORT_RENDERER_IDENTITY` /
`QWEN_EXPORT_RENDERER_INTEGRITY`) gains a parallel
`QWEN_EXPORT_RENDERER_CSS_INTEGRITY` so a delegated build points both assets at
the same published version.
