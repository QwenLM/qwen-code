import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

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
// (the build prints `Document export runtime is N bytes`.)
//
// Last measured at 4,083,810 bytes by the Lint & Static lane on PR #11167, with
// the mermaid stub below in place; it was 7,275,173 before that stub (measured
// by a reviewer on PR #11038) and 8,456,076 before the echarts one. Re-measure
// and lower these two again after any change to the document entry's
// dependencies — a cap left far above the measurement is a ratchet with enough
// slack for a whole dependency family to come back unnoticed.
const DOCUMENT_RUNTIME_WARNING_BYTES = 4_100_000;
const MAX_DOCUMENT_RUNTIME_BYTES = 4_200_000;

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
if (Boolean(rendererDelegateIdentity) !== Boolean(rendererDelegateIntegrity)) {
  throw new Error(
    'QWEN_EXPORT_RENDERER_IDENTITY and QWEN_EXPORT_RENDERER_INTEGRITY must be set together: ' +
      'the URL is derived from the identity and the SRI hash pins that same asset, ' +
      'so one without the other produces a document that always fails closed.',
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

const documentBuildResult = await build({
  entryPoints: [join(srcDir, 'document-main.tsx')],
  bundle: true,
  minify: true,
  write: false,
  metafile: true,
  plugins: [stripDocumentDeadModules],
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

const documentRuntimeBytes =
  Buffer.byteLength(documentJsBundle.text) +
  Buffer.byteLength(documentCssBundle.text);
console.log(`Document export runtime is ${documentRuntimeBytes} bytes`);
if (documentRuntimeBytes > MAX_DOCUMENT_RUNTIME_BYTES) {
  throw new Error(
    `Document export runtime is ${documentRuntimeBytes} bytes; expected <= ${MAX_DOCUMENT_RUNTIME_BYTES}. ` +
      'Every reader of an exported file downloads this asset before the ' +
      'transcript renders; import only what the transcript needs ' +
      '(see packages/web-shell/client/transcript.ts) or raise the budget deliberately.',
  );
}
if (documentRuntimeBytes > DOCUMENT_RUNTIME_WARNING_BYTES) {
  console.warn(
    `Document export runtime exceeds the ${DOCUMENT_RUNTIME_WARNING_BYTES}-byte warning threshold`,
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
// The asset always announces the bytes it actually is. Only the document below
// may point at a different, already-published renderer.
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
  .replace('__FAVICON_DATA__', () => faviconData);

// A dropped or renamed .replace() above would otherwise still exit 0 and
// ship a template that throws at view time.
const documentResidualPlaceholder =
  /__(DOCUMENT_INLINE_CSS|DOCUMENT_RENDERER_URL|DOCUMENT_RENDERER_INTEGRITY|FAVICON_DATA)__/.exec(
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
await writeFile(documentTemplateModulePath, documentTemplateModule);
