#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const forbidden = [/@qwen-code\/webui\b/g, /packages\/webui(?:[/'"`]|$)/g];
const ignoredDirectories = new Set(['.git', '.qwen', 'node_modules', 'dist']);
const historicalPrefixes = ['docs/design/', 'docs/plans/'];
const ignoredFiles = new Set([
  'scripts/check-no-webui-dependency.js',
  'packages/web-shell/client/build-artifact.test.ts',
]);

async function collectFiles(directory, relative = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryRelative = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        files.push(
          ...(await collectFiles(
            path.join(directory, entry.name),
            entryRelative,
          )),
        );
      }
    } else if (
      !ignoredFiles.has(entryRelative) &&
      !historicalPrefixes.some((prefix) => entryRelative.startsWith(prefix))
    ) {
      files.push(entryRelative);
    }
  }
  return files;
}

const matches = existsSync(path.join(root, 'packages/webui'))
  ? ['packages/webui/ directory']
  : [];

for (const relative of await collectFiles(root)) {
  let source;
  try {
    source = await readFile(path.join(root, relative), 'utf8');
  } catch {
    continue;
  }
  for (const pattern of forbidden) {
    pattern.lastIndex = 0;
    if (pattern.test(source)) matches.push(relative);
  }
}

if (matches.length > 0) {
  throw new Error(
    `Retired @qwen-code/webui references found:\n${[...new Set(matches)]
      .sort()
      .map((file) => `- ${file}`)
      .join('\n')}`,
  );
}

console.log('No active @qwen-code/webui dependency references found.');
