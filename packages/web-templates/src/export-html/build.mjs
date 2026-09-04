import { readFile, writeFile, mkdir } from 'node:fs/promises';
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
const reactUmdVersion = '18.2.0';
const reactDomUmdVersion = '18.2.0';

// Build the @qwen-code/webui viewer as a UMD bundle from webui sources and
// inline it into the template below. The exported HTML must stay
// self-contained: @qwen-code/webui is not published as part of the release
// flow, and resolving it from a CDN at view time would retroactively change
// how every already-generated export renders. Building it here (instead of
// reading packages/webui/dist) keeps the template build independent of
// webui's own build, which runs after web-templates in scripts/build.js and
// is skipped entirely by --cli-only builds.
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

const jsBundle = buildResult.outputFiles.find((file) =>
  file.path.endsWith('.js'),
);
const cssBundle = buildResult.outputFiles.find((file) =>
  file.path.endsWith('.css'),
);
if (!jsBundle) {
  throw new Error('Failed to generate inline script bundle.');
}

const css = cssBundle
  ? cssBundle.text
  : await readFile(join(srcDir, 'styles.css'), 'utf8');
const htmlTemplate = await readFile(join(srcDir, 'index.html'), 'utf8');
const faviconSvg = await readFile(join(srcDir, 'favicon.svg'), 'utf8');
const faviconData = encodeURIComponent(faviconSvg.trim());

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

const templateModule = `/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * This HTML template is code-generated; do not edit manually.
 */

export const HTML_TEMPLATE = ${JSON.stringify(htmlOutput)};
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
await writeFile(templateModulePath, formattedTemplateModule);
