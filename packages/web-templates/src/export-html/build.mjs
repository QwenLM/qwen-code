import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { TRANSCRIPT_CSS_ENTRY_FILTER } from './transcript-css-entry.mjs';

const assetsDir = dirname(fileURLToPath(import.meta.url));
const srcDir = join(assetsDir, 'src');
const assetsDistDir = join(assetsDir, 'dist');
const generatedDir = join(assetsDir, '..', 'generated');
await mkdir(generatedDir, { recursive: true });
await rm(assetsDistDir, { recursive: true, force: true });
await mkdir(assetsDistDir, { recursive: true });
await rm(join(generatedDir, 'exportHtmlTemplate.ts'), { force: true });

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
const DOCUMENT_RUNTIME_WARNING_BYTES = 1_870_000;
const MAX_DOCUMENT_RUNTIME_BYTES = 1_930_000;

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
    pattern: /(^|\/)node_modules\/(mermaid|@mermaid-js|cytoscape)\//,
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

// Delegate the *document's* renderer to an already-published version (#11096).
//
// Since #9812 an exported file loads the renderer from
// unpkg.com/@qwen-code/qwen-code@<version>, and document-main.tsx refuses to
// render unless the envelope's `rendererVersion` equals the identity compiled
// into the asset it just loaded. Both derive from the root package.json
// version, so any build of a version that is not on npm yet — every source
// build, every fork, every pre-publish CI job — produces a file whose renderer
// URL 404s. `latest` is 0.23.0, published before #9812, which is the state of
// main today.
//
// Publishing fixes the steady state. These two variables are how a build that
// cannot wait for a release points its documents at a version that *is*
// published. Set both or neither:
//
//   QWEN_EXPORT_RENDERER_IDENTITY   the `<version>+<buildId>` string the
//                                   published asset announces, read out of the
//                                   asset itself.
//   QWEN_EXPORT_RENDERER_INTEGRITY  `sha384-<base64>` over that asset's bytes:
//                                   openssl dgst -sha384 -binary <file> |
//                                   openssl base64 -A
//
// The URL, the envelope identity and the SRI hash then all describe the same
// published bytes, which is the only combination that renders. The asset built
// here keeps its own true identity and is still what this version publishes;
// only the generated document points elsewhere.
//
// Deliberately NOT wired into CI. The only lane that opens an exported document
// is the transcript browser gate, and it fulfils the renderer request itself
// from this build's `dist/` — it never reaches the CDN, so delegating there
// buys nothing and actively breaks it: the envelope would announce the
// delegated identity while the asset running in the page announces its own, and
// `document-main.tsx` fails closed on exactly that mismatch. This knob is for a
// human who needs a source build's exports to open before the release lands.
const rendererDelegateIdentity =
  process.env.QWEN_EXPORT_RENDERER_IDENTITY?.trim() || undefined;
const rendererDelegateIntegrity =
  process.env.QWEN_EXPORT_RENDERER_INTEGRITY?.trim() || undefined;
const rendererDelegateCssIntegrity =
  process.env.QWEN_EXPORT_RENDERER_CSS_INTEGRITY?.trim() || undefined;
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

const documentBuildResult = await build({
  entryPoints: [join(srcDir, 'document-main.tsx')],
  bundle: true,
  minify: true,
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

const documentRendererJsBytes = Buffer.byteLength(documentJsBundle.text);
const transcriptCssBytes = Buffer.byteLength(extractedTranscriptCss.css);
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
const rendererBuildId = createHash('sha256')
  .update(documentJsBundle.contents)
  .digest('hex')
  .slice(0, 16);
const localRendererVersion = `${exportTranscriptRendererPackageVersion}+${rendererBuildId}`;
if (!documentJsBundle.text.includes(rendererVersionPlaceholder)) {
  throw new Error('Document renderer build identity placeholder is missing.');
}
// The asset always announces the bytes it actually is. Delegation is usable
// only after the target version publishes both renderer assets.
const documentJs = documentJsBundle.text.replaceAll(
  rendererVersionPlaceholder,
  localRendererVersion,
);
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
