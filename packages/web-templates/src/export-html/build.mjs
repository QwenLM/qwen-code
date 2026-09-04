import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
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
const { version: exportTranscriptRendererPackageVersion } = JSON.parse(
  await readFile(
    join(assetsDir, '..', '..', '..', '..', 'package.json'),
    'utf8',
  ),
);
const rootPackageLock = JSON.parse(
  await readFile(join(assetsDir, '..', '..', '..', '..', 'package-lock.json')),
);
const reactVersion = rootPackageLock.packages['node_modules/react']?.version;
const reactDomVersion =
  rootPackageLock.packages['node_modules/react-dom']?.version;
if (!reactVersion || !reactDomVersion) {
  throw new Error('Failed to resolve React versions for document export.');
}
const cdnBaseUrl = 'https://cdn.jsdelivr.net/npm';
const documentRendererUrl = `${cdnBaseUrl}/@qwen-code/qwen-code@${exportTranscriptRendererPackageVersion}/export-transcript-document.js`;
const rendererVersionPlaceholder = '__QWEN_RENDERER_BUILD_ID__';
const documentImportMap = JSON.stringify({
  imports: {
    react: `${cdnBaseUrl}/react@${reactVersion}/+esm`,
    'react/jsx-runtime': `${cdnBaseUrl}/react@${reactVersion}/jsx-runtime/+esm`,
    'react-dom': `${cdnBaseUrl}/react-dom@${reactDomVersion}/+esm`,
    'react-dom/client': `${cdnBaseUrl}/react-dom@${reactDomVersion}/client/+esm`,
  },
});

const documentBuildResult = await build({
  entryPoints: [join(srcDir, 'document-main.tsx')],
  bundle: true,
  minify: true,
  write: false,
  outfile: join(assetsDistDir, 'export-transcript-document.js'),
  platform: 'browser',
  format: 'esm',
  target: ['chrome120'],
  legalComments: 'none',
  loader: { '.css': 'css' },
  external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
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
const rendererBuildId = createHash('sha256')
  .update(documentJsBundle.contents)
  .digest('hex')
  .slice(0, 16);
const exportTranscriptRendererVersion = `${exportTranscriptRendererPackageVersion}+${rendererBuildId}`;
if (!documentJsBundle.text.includes(rendererVersionPlaceholder)) {
  throw new Error('Document renderer build identity placeholder is missing.');
}
const documentJs = documentJsBundle.text.replaceAll(
  rendererVersionPlaceholder,
  exportTranscriptRendererVersion,
);

const faviconSvg = await readFile(join(srcDir, 'favicon.svg'), 'utf8');
const faviconData = encodeURIComponent(faviconSvg.trim());
const documentTemplate = await readFile(
  join(srcDir, 'document-index.html'),
  'utf8',
);

const documentHtmlOutput = documentTemplate
  .replace('__DOCUMENT_INLINE_CSS__', () => documentCssBundle.text.trim())
  .replace('__DOCUMENT_IMPORT_MAP__', () => documentImportMap)
  .replace('__DOCUMENT_RENDERER_URL__', () => documentRendererUrl)
  .replace('__FAVICON_DATA__', () => faviconData);

// A dropped or renamed .replace() above would otherwise still exit 0 and
// ship a template that throws at view time.
const documentResidualPlaceholder =
  /__(DOCUMENT_INLINE_CSS|DOCUMENT_IMPORT_MAP|DOCUMENT_RENDERER_URL|FAVICON_DATA)__/.exec(
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
