import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { findUnexpectedImportMeta } from './import-meta-guard.mjs';
import { TRANSCRIPT_CSS_ENTRY_FILTER } from './transcript-css-entry.mjs';

const assetsDir = dirname(fileURLToPath(import.meta.url));
const srcDir = join(assetsDir, 'src');
const assetsDistDir = join(assetsDir, 'dist');
const generatedDir = join(assetsDir, '..', 'generated');
await mkdir(generatedDir, { recursive: true });

const documentTemplateModulePath = join(
  generatedDir,
  'exportTranscriptDocumentTemplate.ts',
);
const exportTranscriptMaxBlocks = 1_000;
const exportTranscriptMaxEnvelopeBytes = 32 * 1024 * 1024;
// Since #9812 the renderer is no longer inlined into each export: the document
// loads one version-pinned, SRI-protected asset from unpkg. That moved the cost
// rather than removing it — the same bytes are now downloaded the first time
// anyone opens an exported file, on a path that must fail closed, so the size
// still needs a ceiling. Mirrors the hard bundle-size assertions in
// packages/sdk-typescript/scripts/build.js.
// Before #11031 was fixed, the document entry imported the @qwen-code/web-shell
// package root and pulled the full interactive shell into that asset:
// 19,523,259 runtime bytes.
//
// A byte cap alone is a weak ratchet — it only catches growth, and only once
// it is large. The structural guard below (FORBIDDEN_DOCUMENT_INPUTS) is the
// real one: it names the module graphs that must never reach an export and
// fails with the reason. Keep both.
//
// Re-measure and lower these two constants after any change to the document
// entry's dependencies:
//   cd packages/web-templates && node src/export-html/build.mjs
// (the build prints `Document export renderer JS is N bytes`.)
//
// Since #11478 the web-shell component stylesheet is no longer inside the
// renderer JS: the build lifts the `__qwenWebShellCss` literal out into
// `export-transcript-document.css` (loaded via a <link>), so these constants
// budget the JS bundle alone — the asset a browser must download, parse and
// compile before the transcript renders. The CSS is a separate, parallel,
// year-cached asset and is logged rather than budgeted.
//
// Last measured at 1,931,934 bytes of JS with 2,332,167 bytes of CSS moved
// out, by the Lint & Static lane on main at cc9bb98847 — #12199 and #12050
// grew only transcript-reachable first-party code (the third-party input mix
// is unchanged) past the old 1,930,000 cap (#12295), so the budget follows
// the measurement. Before the split that lane measured the combined bundle at
// 4,133,282 bytes on main at c3023b3e6d — the measurement #11372 raised these
// two constants for, and which the CSS extraction superseded because the CSS
// it counted is no longer in the JS.
//
// The bundle pulls web-shell's built transcript entry, which carries the
// whole i18n table, so every string the Web Shell adds anywhere lands here.
// Measured for #12154 by building this bundle twice against the same tree,
// once with its dictionary and once with main's: 2,021,942 against
// 2,013,739, so +8,203 bytes for forty-two keys across two locales,
// which the cap above has room for. Both figures are local and both are
// higher than the lane's; it is the difference between them that is
// comparable, and the lane's absolute number is what these constants
// track.
//
// Keep the warning close to the measurement and the hard ceiling close above
// it: a cap left far above the measurement is a ratchet with enough slack for
// a whole dependency family to come back unnoticed.
// The baseline includes reader metadata and attachment-reference checks.
// A clean build of the CI merge tree at 71161df9, including current upstream
// Web Shell inputs, measures 2,154,340 injected JS bytes. Branch-only builds
// must not replace this measured shared-tree baseline with an older estimate.
// The expansion-preserving normalization adds 42 bytes to that merged build.
// The schema-version narrowing capture adds a further 8 bytes.
// Including the merged ChatSurface inputs, local builds and the CI merge tree
// both measure 2,155,023 injected JS bytes, with 2,428,500 bytes of CSS.
// Merged main through 68388f5d41 plus the focus-stable touch-control changes
// measures 2,155,573 renderer JS bytes and 2,428,500 CSS bytes on 2026-11-22,
// across independent local transcript/export builds.
// Merging origin/main (91a14e3349, including #17918) with the overload-
// indicator slice (#18054) adds two catalog entries to the EN and ZH-CN
// catalogs the document entry inlines (sidebar.overloadPaused and the
// interpolating function sidebar.overloadDetail; zh-TW and RU are
// transcript-stubbed and contribute no document bytes), adding +445 bytes:
// rebuilt @qwen-code/web-shell transcript lib + export-html on the merged
// tree measures 2,156,018 renderer JS bytes and 2,428,500 CSS bytes
// (2,155,573 + 445 = 2,156,018 exact). A later rebuild of this branch
// merged with main, using Node v26.12.1 on 2026-11-25, measured 2,156,867
// bytes. Re-track the warning and hard ceiling to that later measurement
// while preserving the house margins of 713 and 1,713 bytes respectively.
const DOCUMENT_RUNTIME_WARNING_BYTES = 2_157_580;
// Grouped deletion plus main 159f8d0266 measures 2,041,583 JS bytes
// (CSS is separate). Per-cause loop-stop text (#14828: seven keys across two
// locales plus their mapping) adds 5,139: 2,041,583 against 2,046,722 on main
// 158ff26aeb without and with the change, leaving 3,278 below this ceiling.
// Main 8345f5ceec then measured 2,049,419. Passing Web Shell theme tokens to
// MCP Apps as standard style variables adds 820: 2,049,419 against 2,050,239
// on that main without and with the change, leaving 2,761 below this ceiling.
// Recovery UI and availability consumers (#14980) add 1,787, measured
// against merged main 65051590d9, so the merged build stays below this
// ceiling.
//
// The markdown-chart 0.1.12 -> 0.4.1 upgrade (#16021) measures 2,053,466 on
// head de6c47d879 against 2,034,760 on its merge parent: +12,947 in
// @datafe-open/markdown-chart, +4,251 in markdown-chart-echarts, +1,219 in the
// transcript entry's new echartsChart.* labels, and +289 across the adapter
// and its transitive inputs. The AG Grid graph the adapter now imports is
// dead in document mode and stubbed out below, so it contributes no bytes
// here. That head was last built before the 2026-11-09 Web Shell changes, so
// the merged tree measures 2,065,087, 11,621 above the head figure. The
// warning sits 913 above the merged measurement and the ceiling 4,913 above
// it.
//
// The patched Zod 4 upgrade (#16434) adds 43,494 bytes when rebuilt against
// the same candidate with Zod 3. Merged main 754792b8d1 measures 2,129,325
// bytes and the forbidden-input guard still passes, leaving 2,675 bytes below
// the previous 2,132,000-byte ceiling.
// Main 0eb27d3b measures 2,132,531 bytes on Node 22.23.2 and 24.19.0,
// with the forbidden-input guard passing, leaving 3,469 bytes below this cap.
// The local-files usability copy (#17198: change-directory/reconnect notices,
// the insecure-context tunnel instruction with its local-port branch, and the
// deferred-change notice, across two locales) measures 2,136,115 bytes on
// head 6286c8cb11 in CI, 115 above the previous 2,136,000 ceiling. The warning
// sits 885 above that measurement and the ceiling 1,885 above it.
// The composer task-explain side question (#17398: the explain display line,
// the "?" aria label and tooltip, and the panel copy, across two locales, plus
// the transcript-reachable explain wiring) adds 904 bytes: main d41eda5123
// measures 2,137,893 (107 below the previous 2,138,000 ceiling) and head
// d5f6a103a6 measures 2,138,797 in CI, 797 above it. The warning sits 203 above
// that measurement and the ceiling 1,203 above it.
// The document runtime measured 2,138,044 bytes on head 2ef7af8e69, 44 above
// the previous 2,138,000 ceiling. SessionGoalMarker is NOT reachable from the
// document entry (it is imported only by WebShellSidebar) and the RU catalog
// is stubbed in transcript mode, so the sidebar goal marker feature (#17515)
// contributes only its EN/ZH `sidebar.sessionGoal` label strings (~151 bytes)
// to this bundle. This PR's deliberate budget raise was folded into main's
// larger `/send` ceilings below when merging, so the CURRENT caps apply: the
// warning sits 7,056 above that measurement and the ceiling 8,056 above it.
// Those two figures price THIS feature against the caps, not the remaining
// headroom: after merging main the same tree measures 2,145,649 locally,
// already over the warning and 451 below the ceiling. Size new copy against
// that 451, and re-measure in CI before trusting it.
// The `/send` command, its composer chip and session tab copy (ten keys
// across two locales) add 1,283: 2,137,893 against 2,139,176 locally on main
// 039ed577fb without and with the change. Recording the exchange in the
// caller (the "To" and "From" lines on a user message, the waiting chip, and
// the parsing of where a message went; four keys added and one removed,
// across two locales) adds 1,497 more. Merged with the explain side question
// above, the branch measured 2,141,606 locally on main 5fc5a98ecc; marking a
// turn another session's reply starts (its card label, keeping the card in a
// folded turn, and opening that session from it) brings it to 2,142,326. The
// warning sits 774 above that measurement and the ceiling 1,774 above it.
// Generic Webhook copy (#17405: ten keys across two locales) adds 2,154:
// the same tree with main 7a9b270d's dictionary measures 2,142,233 bytes,
// against 2,144,387 with the new copy. CSS and third-party inputs are unchanged,
// and the forbidden-input guard passes. Leave 713 bytes to the warning and
// 1,713 to the ceiling.
// The Goal sidebar marker (#17515) and the background-task composer chips
// (#17398) then grew the transcript dictionary past that ceiling: the Lint &
// Static / Build lane on main d83fa2154e measures 2,146,529 JS bytes (CSS
// 2,423,645, separate), 429 over the old 2,146,100 cap, which reddened every
// PR's build. The bundle pulls web-shell's whole i18n table, so these legitimate
// first-party strings land here; the third-party input mix is unchanged and the
// forbidden-input guard passes. Re-track the lane measurement: leave 671 bytes
// to the warning and 1,671 to the ceiling. (A local build against the worktree's
// own node_modules measures lower — 2,138,797 — but the lane's absolute number
// is what these constants track.)
//
// The restart recovery inbox (#17677: panel copy and state strings across
// three locales) measures 2,145,251 bytes on the merged 0c28638cc7 tree;
// combined with the Generic Webhook copy the merged 9de5d9a311 tree measures
// 2,147,405, 1,295 above the previous 2,146,100 ceiling. Main 3d75b8ee60
// measures 2,147,740; adding the mid-batch failure notice brings the current
// tree to 2,148,000. Merging the latest main and its transcript-reachable
// additions raises the measurement to 2,148,696, so the warning sits 104
// above that figure and the ceiling 904 above it. Workspace-lock scoping,
// capped-result retry guidance, and stale-callback invalidation then add 220
// bytes, bringing that tree to 2,148,976. This merge's artifact-library stub
// registration adds 46 bytes, for 2,149,022 measured bytes. The warning sits
// 713 above that measurement, while the existing ceiling retains 1,713 bytes.
//
// The workspace artifact library copy (nine keys across three locales) is
// interactive-only: managed-artifact-library-messages.transcript-stub.ts
// replaces it in transcript mode, so it contributes no document bytes. Its
// upstream branch measured 2,148,522 JS bytes with the copy inlined and
// 2,146,575 with the stub (CSS 2,423,645, separate), 46 above the 2,146,529
// lane measurement #17746 re-tracked. The forbidden-input guard passes and
// the third-party input mix is unchanged. The merged branch's ceiling follows
// the recovery-inbox measurements above, rather than lowering that branch's
// budget or reserving space for interactive-only copy.
//
// Main 73bdaa349c's declared workflow phases add 660 bytes. This tree
// measures 2,149,682 bytes of renderer JS and 2,425,151 bytes of separate
// CSS; the third-party input mix is unchanged and the forbidden-input guard
// passes. The warning and ceiling retain 713- and 1,713-byte margins.
// The merged catalog-loading tree measures 2,149,263 JS bytes, down 419,
// with 2,425,802 bytes of separate CSS and the same third-party input mix.
// The warning and ceiling keep 713 and 1,713 bytes above that measurement.
//
// A frozen-install build of a clean detached worktree at main 82a0f3031f71
// measures 2,151,147 bytes of renderer JS on Node 22.22.2, 171 above the
// previous ceiling. CI's Build unit-test tree (Linux, Node 22.x) measures
// 2,149,864 bytes. The forbidden-input guard passes. Preserve the existing
// 713- and 1,713-byte margins above the CI measurement, leaving 430 bytes
// above the local measurement.
//
// The ChatSurface chat column (#17952) then grows the transcript dictionary
// past that ceiling: the Build lane measures 2,151,214 bytes on main
// 3911b60fc4 (run 44953143515, green) against 2,151,847 on 580108434f
// (run 44963775498), +633, with CSS unchanged at 2,427,365; the three
// subsequent main runs measure the same 2,151,847. The cause is six chat.*
// keys in the two catalogs the document entry inlines (EN and ZH-CN; zh-TW
// and RU are transcript-stubbed), the CHAT_MESSAGE_KEYS parity export, and
// the transcript-reachable pendingPermissionRevision helper. The ChatSurface
// component graph is not wired into any column and useDaemonChatController
// has no importer, so no component code reaches the document entry; the
// forbidden-input guard passes and the third-party input mix is unchanged.
// Re-track the lane measurement, preserving the 713- and 1,713-byte margins.
//
// A normal build at the measured size below is not warned; only further
// growth is warned. The identity placeholder can change byte length when it
// is replaced, so the budget measures the actual injected asset below,
// including the metadata checks: 2,155,023 bytes with ChatSurface merged.
// With the latest 2,156,867-byte measurement, the same coupled expression
// yields 2,158,580 (1,713 above it), retaining 713 bytes to the warning.
const MAX_DOCUMENT_RUNTIME_BYTES = DOCUMENT_RUNTIME_WARNING_BYTES + 1_000;

// Modules that must not be reachable from the document entry, checked against
// the esbuild metafile inputs after the bundle is produced.
const FORBIDDEN_DOCUMENT_INPUTS = [
  {
    pattern: /(^|\/)node_modules\/(shiki|@shikijs)\//,
    why:
      'Shiki is unreachable in document mode (CodeBlock renders plain <pre>) ' +
      'and its Oniguruma WASM engine is blocked by the export CSP; it is ' +
      'resolved to src/document-shiki-stub.ts by the strip plugin below.',
  },
  {
    pattern: /web-shell\/dist\/index\.js$/,
    why:
      'The @qwen-code/web-shell package root drags the interactive shell ' +
      '(App, daemon providers, editor/terminal chrome) into every export. ' +
      'Import @qwen-code/web-shell/transcript instead (#11031).',
  },
  {
    pattern: /(^|\/)node_modules\/(echarts|zrender)\//,
    why:
      'The chart runtime is only reachable through the `?? () => import("echarts")` ' +
      'default inside @datafe-open/markdown-chart-echarts, which Web Shell never ' +
      'takes (MarkdownChartRenderer always passes a loadECharts). IIFE output ' +
      'cannot code-split, so that dead dynamic import was flattened in; it is ' +
      'resolved to src/document-echarts-stub.ts by the strip plugin below.',
  },
  {
    pattern:
      /(^|\/)node_modules\/(@datafe-open\/markdown-chart-table|ag-grid-community|ag-stack)\//,
    why:
      'The table data view is statically imported by ' +
      '@datafe-open/markdown-chart-react@0.4.1, but document mode never renders ' +
      'a chart (Markdown.tsx disables the integration outside the interactive ' +
      'shell), so neither the table renderer nor its AG Grid Community graph ' +
      'can run there. The import is static and IIFE output cannot code-split, ' +
      'so it was flattened into the renderer asset; `markdown-chart-table` is ' +
      'resolved to src/document-markdown-chart-table-stub.ts by the strip ' +
      'plugin below, and the two AG Grid packages are named here too so ' +
      'neither can return through another path — the same shape as the ' +
      'echarts/zrender rule.',
  },
  {
    pattern:
      /(^|\/)node_modules\/(mermaid|@mermaid-js|cytoscape)\/|web-shell[\\/]dist[\\/]mermaid\.core-[\w-]+\.js$/,
    why:
      'Exported transcripts render a ```mermaid fence as a plain <pre>, the ' +
      'same degradation CodeBlock already applies to syntax highlighting in ' +
      'document mode (#11091). Mermaid and its graph dependencies were the ' +
      'largest remaining input at ~6 MB pre-minify; `mermaid` is resolved to ' +
      'src/document-mermaid-stub.ts by the strip plugin below, and its two ' +
      'heaviest transitive graphs are named here too so neither can return ' +
      'through another path — the same shape as the echarts/zrender rule.',
  },
  {
    pattern: /(^|\/)node_modules\/(codemirror|@codemirror)\//,
    why:
      'A read-only export has no composer. CodeMirror last reached it through ' +
      'three composer-tag getters that UserMessage imported from ' +
      'hooks/useComposerCore.ts; they now live in utils/composerTag.ts, which ' +
      'is editor-free. Import from there, not from the composer hook.',
  },
];

// `shiki` and `@shikijs/*` are replaced wholesale rather than marked external:
// the renderer asset is a single IIFE bundle, so an external specifier would
// simply fail to resolve in the browser. See src/document-shiki-stub.ts for why
// this is dead code in an export.
const documentShikiStub = join(srcDir, 'document-shiki-stub.ts');
const documentEchartsStub = join(srcDir, 'document-echarts-stub.ts');
const documentMermaidStub = join(srcDir, 'document-mermaid-stub.ts');
const documentMarkdownChartTableStub = join(
  srcDir,
  'document-markdown-chart-table-stub.ts',
);
const stripDocumentDeadModules = {
  name: 'strip-document-dead-modules',
  setup(build) {
    build.onResolve({ filter: /^(shiki|@shikijs)(\/|$)/ }, () => ({
      path: documentShikiStub,
    }));
    build.onResolve({ filter: /^echarts(\/|$)/ }, () => ({
      path: documentEchartsStub,
    }));
    build.onResolve({ filter: /^mermaid(\/|$)/ }, () => ({
      path: documentMermaidStub,
    }));
    build.onResolve({ filter: /^\.\/mermaid\.core-[\w-]+\.js$/ }, (args) =>
      /web-shell[\\/]dist[\\/]/.test(args.importer)
        ? { path: documentMermaidStub }
        : undefined,
    );
    build.onResolve(
      { filter: /^@datafe-open\/markdown-chart-table(\/|$)/ },
      () => ({ path: documentMarkdownChartTableStub }),
    );
  },
};

// The web-shell transcript entry carries its scoped component stylesheet as a
// `const __qwenWebShellCss="…"` literal that injectCssModules
// (packages/web-shell/vite.lib.config.ts) prepends to the chunk, plus a
// one-line runtime injection that appends a <style> to document.head. The
// document no longer wants either: it loads the stylesheet through a
// nonce-bearing <link> in document-index.html, so this plugin lifts the literal
// into a standalone CSS asset and hands the bundler the rest. The strip is
// keyed to the generated shape (the CSS-constant line followed by the
// runtime-injection line); if injectCssModules changes shape, the build fails
// here rather than shipping a renderer that both links and injects the same
// ~2.3 MB stylesheet. That duplicate would slip past both guards further down:
// the document nonces every <style> created through document.createElement (the
// shim in document-index.html), so the CSP admits the injected copy instead of
// blocking it, and re-adding only the 367-byte injection line keeps the bundle
// inside DOCUMENT_RUNTIME_WARNING_BYTES and MAX_DOCUMENT_RUNTIME_BYTES. So this
// throw is the only guard on that path — and the createElement shim is what the
// shipped renderer's own <style> injection still depends on.
const extractedTranscriptCss = { css: undefined };
const extractTranscriptCss = {
  name: 'extract-transcript-css',
  setup(build) {
    build.onLoad(
      // Separators and the `transcript\.js$` tail are both load-bearing; see
      // transcript-css-entry.mjs (extracted so the match is unit-testable
      // without running this build).
      { filter: TRANSCRIPT_CSS_ENTRY_FILTER },
      async (args) => {
        const source = await readFile(args.path, 'utf8');
        const cssMatch = source.match(
          /^const __qwenWebShellCss=("(?:[^"\\]|\\.)*");\n/,
        );
        if (!cssMatch) {
          throw new Error(
            'Web Shell transcript entry is missing its injected component CSS ' +
              'constant; the injectCssModules shape may have changed.',
          );
        }
        const css = JSON.parse(cssMatch[1]);
        const afterConstant = source.slice(cssMatch[0].length);
        const injectionEnd = afterConstant.indexOf('\n');
        if (
          injectionEnd === -1 ||
          !afterConstant.startsWith('if(typeof document!=="undefined"')
        ) {
          throw new Error(
            'Web Shell transcript CSS runtime-injection line is missing or moved.',
          );
        }
        extractedTranscriptCss.css = css;
        return {
          contents: afterConstant.slice(injectionEnd + 1),
          loader: 'js',
        };
      },
    );
  },
};
const { version: exportTranscriptRendererPackageVersion } = JSON.parse(
  await readFile(
    join(assetsDir, '..', '..', '..', '..', 'package.json'),
    'utf8',
  ),
);
const rendererVersionPlaceholder = '__QWEN_RENDERER_BUILD_ID__';

// Source builds may delegate generated documents to a version that already
// publishes both renderer assets. All three values are required; CI serves the
// local assets and intentionally leaves delegation disabled.
const rendererDelegateIdentity =
  process.env.QWEN_EXPORT_RENDERER_IDENTITY?.trim() || undefined;
const rendererDelegateIntegrity =
  process.env.QWEN_EXPORT_RENDERER_INTEGRITY?.trim() || undefined;
const rendererDelegateCssIntegrity =
  process.env.QWEN_EXPORT_RENDERER_CSS_INTEGRITY?.trim() || undefined;
const rendererDelegateSchemaOverride =
  process.env.QWEN_EXPORT_RENDERER_SCHEMA_MAX_VERSION?.trim() || undefined;
if (rendererDelegateSchemaOverride && !rendererDelegateIdentity) {
  throw new Error(
    'QWEN_EXPORT_RENDERER_SCHEMA_MAX_VERSION requires QWEN_EXPORT_RENDERER_IDENTITY.',
  );
}
const exportTranscriptDocumentMaxSchemaVersion = rendererDelegateIdentity
  ? Number(rendererDelegateSchemaOverride ?? 1)
  : 2;
if (![1, 2].includes(exportTranscriptDocumentMaxSchemaVersion)) {
  throw new Error(
    `QWEN_EXPORT_RENDERER_SCHEMA_MAX_VERSION must be 1 or 2; got ${rendererDelegateSchemaOverride}. ` +
      'It must describe the delegated renderer actually pinned by the identity and SRI hashes.',
  );
}
if (Boolean(rendererDelegateIdentity) !== Boolean(rendererDelegateIntegrity)) {
  throw new Error(
    'QWEN_EXPORT_RENDERER_IDENTITY and QWEN_EXPORT_RENDERER_INTEGRITY must be set together: ' +
      'the URL is derived from the identity and the SRI hash pins that same asset, ' +
      'so one without the other produces a document that always fails closed.',
  );
}
if (
  Boolean(rendererDelegateIdentity) !== Boolean(rendererDelegateCssIntegrity)
) {
  throw new Error(
    'QWEN_EXPORT_RENDERER_CSS_INTEGRITY must be set together with the renderer delegation: ' +
      'a delegated renderer points the JS and CSS at the same published version, ' +
      'so the CSS SRI hash must describe that published asset too.',
  );
}
if (
  rendererDelegateIdentity &&
  !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?\+[0-9a-f]{16}$/.test(
    rendererDelegateIdentity,
  )
) {
  throw new Error(
    `QWEN_EXPORT_RENDERER_IDENTITY must look like <semver>+<16 hex build id>; got ${rendererDelegateIdentity}. ` +
      'It is interpolated into the renderer URL, so it is validated rather than trusted.',
  );
}
if (
  rendererDelegateIntegrity &&
  !/^sha384-[A-Za-z0-9+/]{64}={0,2}$/.test(rendererDelegateIntegrity)
) {
  throw new Error(
    `QWEN_EXPORT_RENDERER_INTEGRITY must be a sha384- base64 digest; got ${rendererDelegateIntegrity}.`,
  );
}
if (
  rendererDelegateCssIntegrity &&
  !/^sha384-[A-Za-z0-9+/]{64}={0,2}$/.test(rendererDelegateCssIntegrity)
) {
  throw new Error(
    `QWEN_EXPORT_RENDERER_CSS_INTEGRITY must be a sha384- base64 digest; got ${rendererDelegateCssIntegrity}.`,
  );
}

await rm(assetsDistDir, { recursive: true, force: true });
await mkdir(assetsDistDir, { recursive: true });
await rm(join(generatedDir, 'exportHtmlTemplate.ts'), { force: true });

const documentBuildResult = await build({
  entryPoints: [join(srcDir, 'document-main.tsx')],
  bundle: true,
  minify: true,
  // esbuild escapes every non-ASCII character in a string literal by default
  // (`charset: 'ascii'`), and this bundle carries the Web Shell's translation
  // table for both locales, so `"\u4F60"` costs six bytes where the character
  // is three in UTF-8. The escaped and literal forms are the same string value
  // to the parser, and every path that serves this asset decodes it as UTF-8 —
  // the document that loads it declares `<meta charset="UTF-8">`, and unpkg
  // serves it as `application/javascript; charset=utf-8` — so this is bytes
  // returned without changing what the renderer renders. Local main at
  // bfa7a2f52e measured 2,049,210 bytes with the default; this emits 1,956,663.
  charset: 'utf8',
  write: false,
  metafile: true,
  plugins: [stripDocumentDeadModules, extractTranscriptCss],
  outfile: join(assetsDistDir, 'export-transcript-document.js'),
  platform: 'browser',
  format: 'iife',
  target: ['chrome120'],
  legalComments: 'none',
  loader: { '.css': 'css' },
  define: {
    'process.env.NODE_ENV': '"production"',
    __EXPORT_TRANSCRIPT_RENDERER_VERSION__: JSON.stringify(
      rendererVersionPlaceholder,
    ),
    __EXPORT_TRANSCRIPT_MAX_BLOCKS__: String(exportTranscriptMaxBlocks),
    __EXPORT_TRANSCRIPT_MAX_ENVELOPE_BYTES__: String(
      exportTranscriptMaxEnvelopeBytes,
    ),
  },
});

// esbuild lowers import.meta to {} under iife, and the export document
// evaluates the bundle top-level, so any stray import.meta read (e.g.
// import.meta.env) would throw in every exported file. Tolerate exactly the
// deliberate guarded read inside the prebuilt web-shell transcript entry and
// fail on anything else. No logLevel/logOverride here: silencing the warning
// class would also hide every other warning this build emits, and
// logOverride 'silent' would empty result.warnings and vacate this check.
const unexpectedImportMeta = findUnexpectedImportMeta(
  documentBuildResult.warnings,
);
if (unexpectedImportMeta.length > 0) {
  throw new Error(
    'export-transcript-document build: unexpected import.meta use in ' +
      unexpectedImportMeta.join(', '),
  );
}

const documentJsBundle = documentBuildResult.outputFiles.find((file) =>
  file.path.endsWith('.js'),
);
const documentCssBundle = documentBuildResult.outputFiles.find((file) =>
  file.path.endsWith('.css'),
);
if (!documentJsBundle || !documentCssBundle) {
  throw new Error('Failed to generate document export bundles.');
}
if (!extractedTranscriptCss.css) {
  throw new Error(
    'Failed to extract the Web Shell transcript stylesheet: the ' +
      'extract-transcript-css plugin never matched dist/transcript.js.',
  );
}
// Re-measuring the budget should not require editing this file. The size line
// below says *how much*; this says *what of*, which is the question a
// regression actually raises.
const documentInputs = documentBuildResult.metafile.inputs;
const inputBytesByPackage = new Map();
for (const [input, { bytes }] of Object.entries(documentInputs)) {
  const match = input.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//);
  const key = match ? match[1] : 'first-party';
  inputBytesByPackage.set(key, (inputBytesByPackage.get(key) ?? 0) + bytes);
}
const topInputs = [...inputBytesByPackage]
  .sort(([, left], [, right]) => right - left)
  .slice(0, 8)
  .map(([name, bytes]) => `${name} ${bytes}`)
  .join(', ');
console.log(`Document export top inputs (pre-minify bytes): ${topInputs}`);
if (process.env.EXPORT_HTML_METAFILE) {
  await writeFile(
    process.env.EXPORT_HTML_METAFILE,
    JSON.stringify(documentBuildResult.metafile),
  );
  console.log(
    `Document export metafile written to ${process.env.EXPORT_HTML_METAFILE}`,
  );
}

const forbiddenInputs = Object.keys(documentInputs)
  .map((input) => ({
    input,
    rule: FORBIDDEN_DOCUMENT_INPUTS.find(({ pattern }) => pattern.test(input)),
  }))
  .filter((entry) => entry.rule);
if (forbiddenInputs.length > 0) {
  const reasons = [...new Set(forbiddenInputs.map(({ rule }) => rule.why))];
  const examples = forbiddenInputs.slice(0, 5).map(({ input }) => `  ${input}`);
  throw new Error(
    `The document export bundle reached ${forbiddenInputs.length} forbidden input(s):\n` +
      `${examples.join('\n')}\n` +
      `${reasons.map((why) => `- ${why}`).join('\n')}`,
  );
}

const transcriptCssBytes = Buffer.byteLength(extractedTranscriptCss.css);
const rendererBuildId = createHash('sha256')
  .update(documentJsBundle.contents)
  .digest('hex')
  .slice(0, 16);
const localRendererVersion = `${exportTranscriptRendererPackageVersion}+${rendererBuildId}`;
if (!documentJsBundle.text.includes(rendererVersionPlaceholder)) {
  throw new Error('Document renderer build identity placeholder is missing.');
}
// Delegation changes generated documents, not the identity of this asset.
const documentJs = documentJsBundle.text.replaceAll(
  rendererVersionPlaceholder,
  localRendererVersion,
);
const documentRendererJsBytes = Buffer.byteLength(documentJs);
console.log(
  `Document export renderer JS is ${documentRendererJsBytes} bytes; ` +
    `component CSS moved to export-transcript-document.css is ${transcriptCssBytes} bytes`,
);
if (documentRendererJsBytes > MAX_DOCUMENT_RUNTIME_BYTES) {
  throw new Error(
    `Document export renderer JS is ${documentRendererJsBytes} bytes; expected <= ${MAX_DOCUMENT_RUNTIME_BYTES}. ` +
      'Every reader of an exported file downloads and compiles this asset before the ' +
      'transcript renders; import only what the transcript needs ' +
      '(see packages/web-shell/client/transcript.ts) or raise the budget deliberately.',
  );
}
if (documentRendererJsBytes > DOCUMENT_RUNTIME_WARNING_BYTES) {
  console.warn(
    `Document export renderer JS exceeds the ${DOCUMENT_RUNTIME_WARNING_BYTES}-byte warning threshold`,
  );
}
const exportTranscriptRendererVersion =
  rendererDelegateIdentity ?? localRendererVersion;
const documentRendererUrl = `https://unpkg.com/@qwen-code/qwen-code@${exportTranscriptRendererVersion.split('+')[0]}/export-transcript-document.js`;
const documentRendererIntegrity =
  rendererDelegateIntegrity ??
  `sha384-${createHash('sha384').update(documentJs).digest('base64')}`;
const documentRendererCssUrl = `https://unpkg.com/@qwen-code/qwen-code@${exportTranscriptRendererVersion.split('+')[0]}/export-transcript-document.css`;
const documentRendererCssIntegrity =
  rendererDelegateCssIntegrity ??
  `sha384-${createHash('sha384').update(extractedTranscriptCss.css).digest('base64')}`;
if (rendererDelegateIdentity) {
  console.log(
    `Document export delegates its renderer to ${documentRendererUrl} ` +
      `(this build's own asset is ${localRendererVersion})`,
  );
}

const faviconSvg = await readFile(join(srcDir, 'favicon.svg'), 'utf8');
const faviconData = encodeURIComponent(faviconSvg.trim());
const documentTemplate = await readFile(
  join(srcDir, 'document-index.html'),
  'utf8',
);

// Function-form replacers preserve `$&`/`$'`/`` $` `` sequences in generated
// CSS instead of interpreting them as replacement patterns.
const documentHtmlOutput = documentTemplate
  .replace('__DOCUMENT_INLINE_CSS__', () => documentCssBundle.text.trim())
  .replace('__DOCUMENT_RENDERER_URL__', () => documentRendererUrl)
  .replace('__DOCUMENT_RENDERER_INTEGRITY__', () => documentRendererIntegrity)
  .replace('__DOCUMENT_RENDERER_CSS_URL__', () => documentRendererCssUrl)
  .replace(
    '__DOCUMENT_RENDERER_CSS_INTEGRITY__',
    () => documentRendererCssIntegrity,
  )
  .replace('__FAVICON_DATA__', () => faviconData);

// A dropped or renamed .replace() above would otherwise still exit 0 and
// ship a template that throws at view time.
const documentResidualPlaceholder =
  /__(DOCUMENT_INLINE_CSS|DOCUMENT_RENDERER_URL|DOCUMENT_RENDERER_INTEGRITY|DOCUMENT_RENDERER_CSS_URL|DOCUMENT_RENDERER_CSS_INTEGRITY|FAVICON_DATA)__/.exec(
    documentHtmlOutput,
  );
if (documentResidualPlaceholder) {
  throw new Error(
    `Unreplaced placeholder ${documentResidualPlaceholder[0]} in document export HTML template.`,
  );
}

const documentTemplateModule = `/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * This HTML template is code-generated; do not edit manually.
 */

export const DOCUMENT_HTML_TEMPLATE = ${JSON.stringify(documentHtmlOutput)};
export const EXPORT_TRANSCRIPT_RENDERER_VERSION = ${JSON.stringify(exportTranscriptRendererVersion)};
export const EXPORT_TRANSCRIPT_DOCUMENT_MAX_SCHEMA_VERSION: 1 | 2 = ${exportTranscriptDocumentMaxSchemaVersion};
export const EXPORT_TRANSCRIPT_RENDERER_LIMITS = Object.freeze({
  maxBlocks: ${exportTranscriptMaxBlocks},
  maxEnvelopeBytes: ${exportTranscriptMaxEnvelopeBytes},
});
`;

await writeFile(join(assetsDistDir, 'document.html'), documentHtmlOutput);
await writeFile(
  join(assetsDistDir, 'export-transcript-document.js'),
  documentJs,
);
await writeFile(
  join(assetsDistDir, 'export-transcript-document.css'),
  extractedTranscriptCss.css,
);
await writeFile(documentTemplateModulePath, documentTemplateModule);
