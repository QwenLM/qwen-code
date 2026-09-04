#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const forbidden = [/@qwen-code\/webui\b/g, /packages\/webui(?:[/'"`]|$)/g];
const historicalPrefixes = ['.qwen/e2e-tests/', 'docs/design/', 'docs/plans/'];
const intentionalReferences = new Set([
  '.github/scripts/qwen-triage-workflow.test.mjs',
  'eslint.config.js',
  'packages/web-shell/client/build-artifact.test.ts',
  'scripts/check-no-webui-dependency.js',
  'scripts/tests/vscode-companion-no-webui-config.test.js',
]);

const matches = existsSync(path.join(root, 'packages/webui'))
  ? ['packages/webui/ directory']
  : [];
const trackedFiles = execFileSync('git', ['ls-files', '-z'], {
  cwd: root,
  encoding: 'utf8',
}).split('\0');

for (const relative of trackedFiles) {
  if (
    !relative ||
    intentionalReferences.has(relative) ||
    historicalPrefixes.some((prefix) => relative.startsWith(prefix))
  ) {
    continue;
  }
  let source;
  try {
    source = readFileSync(path.join(root, relative), 'utf8');
  } catch {
    continue;
  }
  for (const pattern of forbidden) {
    pattern.lastIndex = 0;
    if (pattern.test(source)) {
      matches.push(relative);
    }
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
