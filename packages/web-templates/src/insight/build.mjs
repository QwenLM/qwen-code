/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable no-undef */
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { build } from 'vite';

const assetsDir = dirname(fileURLToPath(import.meta.url));
const distDir = join(assetsDir, 'dist');

const generatedDir = join(assetsDir, '..', 'generated');
await mkdir(generatedDir, { recursive: true });

const templateModulePath = join(generatedDir, 'insightTemplate.ts');

console.log('Building insight assets with Vite...');
await build();

console.log('Reading generated files...');
let jsContent = '';
let cssContent = '';

try {
  jsContent = await readFile(join(distDir, 'main.js'), 'utf-8');
} catch (e) {
  console.error('Failed to read main.js from dist');
  throw e;
}

try {
  // Try style.css first (standard Vite lib mode output)
  cssContent = await readFile(join(distDir, 'style.css'), 'utf-8');
} catch (e) {
  try {
    // Try main.css (if configured via assetFileNames)
    cssContent = await readFile(join(distDir, 'main.css'), 'utf-8');
  } catch (e2) {
    console.warn(
      'No CSS file found in dist (style.css or main.css). Using empty string.',
    );
  }
}

const templateModule = `/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * This file is code-generated; do not edit manually.
 */

export const INSIGHT_JS = ${JSON.stringify(jsContent.trim())};
export const INSIGHT_CSS = ${JSON.stringify(cssContent.trim())};
`;

await writeFile(templateModulePath, templateModule);
console.log(`Successfully generated ${templateModulePath}`);
