import { readFile, writeFile, mkdir } from 'node:fs/promises';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import { buildConfig } from './esbuild.config.mjs';
import prettier from 'prettier';

const require = createRequire(import.meta.url);
const assetsDir = dirname(fileURLToPath(import.meta.url));
const srcDir = join(assetsDir, 'src');
const assetsDistDir = join(assetsDir, 'dist');
const generatedDir = join(assetsDir, '..', 'generated');
const webuiDir = join(assetsDir, '..', '..', '..', 'webui');
await mkdir(generatedDir, { recursive: true });
await mkdir(assetsDistDir, { recursive: true });

const templateModulePath = join(generatedDir, 'exportHtmlTemplate.ts');
const documentTemplateModulePath = join(
  generatedDir,
  'exportTranscriptDocumentTemplate.ts',
);
const reactUmdVersion = '18.2.0';
const reactDomUmdVersion = '18.2.0';
const exportTranscriptMaxBlocks = 1_000;
const exportTranscriptMaxEnvelopeBytes = 32 * 1024 * 1024;
// The document renderer runtime is inlined into every exported file and has
// no CDN fallback by design (exports must open offline and keep rendering
// identically), so its size is bounded here instead. Mirrors the hard
// bundle-size assertions in packages/sdk-typescript/scripts/build.js.
// Before #11031 was fixed, the document entry imported the @qwen-code/web-shell
// package root and inlined the full interactive shell into every export:
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
const DOCUMENT_RUNTIME_WARNING_BYTES = 18_500_000;
const MAX_DOCUMENT_RUNTIME_BYTES = 19_000_000;

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
    pattern: /(^|\/)node_modules\/(codemirror|@codemirror)\//,
    why:
      'A read-only export has no composer. CodeMirror last reached it through ' +
      'three composer-tag getters that UserMessage imported from ' +
      'hooks/useComposerCore.ts; they now live in utils/composerTag.ts, which ' +
      'is editor-free. Import from there, not from the composer hook.',
  },
];

// `shiki` and `@shikijs/*` are replaced wholesale rather than marked external:
// the export must stay self-contained, so an external specifier would simply
// fail to resolve in the browser. See src/document-shiki-stub.ts for why this
// is dead code in an export.
const documentShikiStub = join(srcDir, 'document-shiki-stub.ts');
const stripDocumentDeadModules = {
  name: 'strip-document-dead-modules',
  setup(build) {
    build.onResolve({ filter: /^(shiki|@shikijs)(\/|$)/ }, () => ({
      path: documentShikiStub,
    }));
  },
};
const { version: exportTranscriptRendererVersion } = JSON.parse(
  await readFile(join(assetsDir, '..', '..', 'package.json'), 'utf8'),
);

// Build the @qwen-code/webui viewer as a UMD bundle from webui sources and
// inline it into the template below. The exported HTML must stay
// self-contained: @qwen-code/webui is not published as part of the release
// flow, and resolving it from a CDN at view time would retroactively change
// how every already-generated export renders. Building it here (instead of
// reading packages/webui/dist) keeps the template build independent of
// webui's own output and prevents a stale dist directory from changing the
// generated export.
const webuiDistDir = join(assetsDistDir, 'webui');
await viteBuild({
  configFile: false,
  root: webuiDir,
  logLevel: 'warn',
  css: {
    postcss: {
      plugins: [
        require('tailwindcss')({
          presets: [require(join(webuiDir, 'tailwind.preset.cjs'))],
          content: [join(webuiDir, 'src', '**', '*.{ts,tsx}')],
        }),
        require('autoprefixer'),
      ],
    },
  },
  build: {
    outDir: webuiDistDir,
    emptyOutDir: true,
    minify: true,
    sourcemap: false,
    cssCodeSplit: false,
    lib: {
      entry: join(webuiDir, 'src', 'index.ts'),
      name: 'QwenCodeWebUI',
      formats: ['umd'],
      fileName: () => 'index.umd.js',
    },
    rollupOptions: {
      external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
      output: {
        globals: {
          react: 'React',
          'react-dom': 'ReactDOM',
          'react-dom/client': 'ReactDOM',
          'react/jsx-runtime': 'ReactJSXRuntime',
        },
        assetFileNames: 'styles.[ext]',
      },
    },
  },
});
const webuiJs = (await readFile(join(webuiDistDir, 'index.umd.js'), 'utf8'))
  // Escape for inlining into a <script> block, mirroring the CLI's
  // escapeJsonForHtml: a literal "</script" would terminate the tag.
  .replace(/<\/script/gi, '<\\/script');
// The bundle inevitably contains `<!--` (markdown-it's HTML regexes). If a
// `<script` byte ever appears after it, HTML5 script-data double-escaping
// swallows the rest of the template — fail the build instead of every export.
if (/<script/i.test(webuiJs)) {
  throw new Error(
    'webui UMD bundle contains a <script sequence; refusing to inline.',
  );
}
const webuiCss = await readFile(join(webuiDistDir, 'styles.css'), 'utf8');

const buildResult = await build(buildConfig);
const documentBuildResult = await build({
  entryPoints: [join(srcDir, 'document-main.tsx')],
  bundle: true,
  minify: true,
  write: false,
  metafile: true,
  plugins: [stripDocumentDeadModules],
  outdir: join(assetsDistDir, 'document'),
  platform: 'browser',
  format: 'iife',
  target: ['chrome120'],
  legalComments: 'none',
  loader: { '.css': 'css' },
  define: {
    'process.env.NODE_ENV': '"production"',
    __EXPORT_TRANSCRIPT_RENDERER_VERSION__: JSON.stringify(
      exportTranscriptRendererVersion,
    ),
    __EXPORT_TRANSCRIPT_MAX_BLOCKS__: String(exportTranscriptMaxBlocks),
    __EXPORT_TRANSCRIPT_MAX_ENVELOPE_BYTES__: String(
      exportTranscriptMaxEnvelopeBytes,
    ),
  },
});

const jsBundle = buildResult.outputFiles.find((file) =>
  file.path.endsWith('.js'),
);
const cssBundle = buildResult.outputFiles.find((file) =>
  file.path.endsWith('.css'),
);
if (!jsBundle) {
  throw new Error('Failed to generate inline script bundle.');
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
      'The export document inlines its renderer into every generated file; ' +
      'import only what the transcript needs (see packages/web-shell/client/transcript.ts) ' +
      'or raise the budget deliberately.',
  );
}
if (documentRuntimeBytes > DOCUMENT_RUNTIME_WARNING_BYTES) {
  console.warn(
    `Document export runtime exceeds the ${DOCUMENT_RUNTIME_WARNING_BYTES}-byte warning threshold`,
  );
}
const documentJs = documentJsBundle.text
  .trim()
  .replace(/<\/script/gi, '<\\/script')
  .replace(/<script/gi, (match) => `\\x3c${match.slice(1)}`);
if (/<script/i.test(documentJs)) {
  throw new Error(
    'Document export bundle contains a <script sequence; refusing to inline.',
  );
}

const css = cssBundle
  ? cssBundle.text
  : await readFile(join(srcDir, 'styles.css'), 'utf8');
const htmlTemplate = await readFile(join(srcDir, 'index.html'), 'utf8');
const faviconSvg = await readFile(join(srcDir, 'favicon.svg'), 'utf8');
const faviconData = encodeURIComponent(faviconSvg.trim());
const documentTemplate = await readFile(
  join(srcDir, 'document-index.html'),
  'utf8',
);

// Function-form replacers: the bundles are untrusted replacement content,
// and a string replacement would interpret `$&`/`$'`/`` $` `` sequences in
// them as substitution patterns, corrupting the inlined code.
const htmlOutput = htmlTemplate
  .replace('__INLINE_CSS__', () => css.trim())
  .replace('__INLINE_SCRIPT__', () => jsBundle.text.trim())
  .replace('__WEBUI_UMD_JS__', () => webuiJs.trim())
  .replace('__WEBUI_CSS__', () => webuiCss.trim())
  .replaceAll('__REACT_UMD_VERSION__', reactUmdVersion)
  .replaceAll('__REACT_DOM_UMD_VERSION__', reactDomUmdVersion)
  .replace('__FAVICON_SVG__', () => faviconSvg.trim())
  .replace('__FAVICON_DATA__', () => faviconData);
const documentHtmlOutput = documentTemplate
  .replace('__DOCUMENT_INLINE_CSS__', () => documentCssBundle.text.trim())
  .replace('__DOCUMENT_INLINE_SCRIPT__', () => documentJs)
  .replace('__FAVICON_DATA__', () => faviconData);

// A dropped or renamed .replace() above would otherwise still exit 0 and
// ship a template that throws at view time.
const residualPlaceholder =
  /__(INLINE_CSS|INLINE_SCRIPT|WEBUI_UMD_JS|WEBUI_CSS|FAVICON_SVG|FAVICON_DATA)__/.exec(
    htmlOutput,
  );
if (residualPlaceholder) {
  throw new Error(
    `Unreplaced placeholder ${residualPlaceholder[0]} in export HTML template.`,
  );
}
const documentResidualPlaceholder =
  /__(DOCUMENT_INLINE_CSS|DOCUMENT_INLINE_SCRIPT|FAVICON_DATA)__/.exec(
    documentHtmlOutput,
  );
if (documentResidualPlaceholder) {
  throw new Error(
    `Unreplaced placeholder ${documentResidualPlaceholder[0]} in document export HTML template.`,
  );
}

const templateModule = `/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * This HTML template is code-generated; do not edit manually.
 */

export const HTML_TEMPLATE = ${JSON.stringify(htmlOutput)};
`;
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

const formattedTemplateModule = await prettier.format(templateModule, {
  parser: 'typescript',
  singleQuote: true,
  semi: true,
  trailingComma: 'all',
  printWidth: 80,
  tabWidth: 2,
});

await writeFile(join(assetsDistDir, 'index.html'), htmlOutput);
await writeFile(join(assetsDistDir, 'document.html'), documentHtmlOutput);
await writeFile(templateModulePath, formattedTemplateModule);
await writeFile(documentTemplateModulePath, documentTemplateModule);
