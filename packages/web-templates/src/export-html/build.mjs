import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';
import { buildConfig } from './esbuild.config.mjs';
import prettier from 'prettier';

const assetsDir = dirname(fileURLToPath(import.meta.url));
const srcDir = join(assetsDir, 'src');
const assetsDistDir = join(assetsDir, 'dist');
const generatedDir = join(assetsDir, '..', 'generated');
await mkdir(generatedDir, { recursive: true });
await mkdir(assetsDistDir, { recursive: true });

const templateModulePath = join(generatedDir, 'exportHtmlTemplate.ts');
const packageJsonPath = join(assetsDir, 'package.json');
const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
const dependencyVersions = packageJson?.dependencies ?? {};

const getDependencyVersion = (name) => {
  const version = dependencyVersions[name];
  if (!version) {
    throw new Error(`Missing ${name} dependency version in package.json.`);
  }
  // Handle various version formats:
  // - "^0.1.0" -> "0.1.0"
  // - "~1.2.3" -> "1.2.3"
  // - "latest" -> "latest"
  // - "^0.1.0@latest" -> "0.1.0" (remove npm tag suffix)
  const versionWithoutPrefix = version.replace(/^[^0-9a-zA-Z]+/, '');
  // Remove npm tag suffix (e.g., "0.1.0@latest" -> "0.1.0")
  return versionWithoutPrefix.replace(/@.+$/, '');
};
const webuiVersion = getDependencyVersion('@qwen-code/webui');
const reactUmdVersion = '18.2.0';
const reactDomUmdVersion = '18.2.0';

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

const htmlOutput = htmlTemplate
  .replace('__INLINE_CSS__', css.trim())
  .replace('__INLINE_SCRIPT__', jsBundle.text.trim())
  .replaceAll('__REACT_UMD_VERSION__', reactUmdVersion)
  .replaceAll('__REACT_DOM_UMD_VERSION__', reactDomUmdVersion)
  .replaceAll('__WEBUI_VERSION__', webuiVersion)
  .replace('__FAVICON_SVG__', faviconSvg.trim())
  .replace('__FAVICON_DATA__', faviconData);

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
