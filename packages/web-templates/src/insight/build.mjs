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

// Load translations for embedding
const translationsDir = join(assetsDir, 'translations');
const translationFiles = ['en', 'zh', 'ja', 'pt', 'ru', 'de'];
const embeddedTranslations = {};

for (const lang of translationFiles) {
  try {
    // Read the TypeScript file and extract the default export
    const translationPath = join(translationsDir, `${lang}.ts`);
    const translationContent = await readFile(translationPath, 'utf-8');
    
    // Parse the TypeScript file to extract the object
    // The file format is: export default { ... } as Record<string, string>;
    const match = translationContent.match(/export default\s+({[\s\S]*?})\s+as\s+Record/);
    if (match && match[1]) {
      // Use Function constructor to safely evaluate the object literal
      // eslint-disable-next-line no-new-func
      const parseObject = new Function(`return ${match[1]}`);
      embeddedTranslations[lang] = parseObject();
    } else {
      throw new Error('Could not parse translation object');
    }
  } catch (e) {
    console.warn(`Failed to load translation for ${lang}:`, e.message);
    embeddedTranslations[lang] = {};
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
export const INSIGHT_TRANSLATIONS = ${JSON.stringify(embeddedTranslations)};
`;

await writeFile(templateModulePath, templateModule);
console.log(`Successfully generated ${templateModulePath}`);
