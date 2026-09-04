#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const forbidden = [/@qwen-code\/webui\b/g, /packages\/webui\b/g];
const historicalPrefixes = ['.qwen/e2e-tests/', 'docs/design/', 'docs/plans/'];
const intentionalReferences = new Set([
  '.github/scripts/qwen-triage-workflow.test.mjs',
  'eslint.config.js',
  'packages/web-shell/client/build-artifact.test.ts',
  'scripts/check-no-webui-dependency.js',
  'scripts/tests/check-no-webui-dependency.test.js',
  'scripts/tests/vscode-companion-no-webui-config.test.js',
]);

/**
 * Returns true when `source` mentions a retired webui package or workspace
 * path. Uses word boundaries so bare references (followed by a space, end of
 * line, or punctuation) are caught, while lookalikes such as
 * `packages/webuix` are not.
 */
export function containsForbiddenReference(source) {
  for (const pattern of forbidden) {
    pattern.lastIndex = 0;
    if (pattern.test(source)) {
      return true;
    }
  }
  return false;
}

function main() {
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
    if (containsForbiddenReference(source)) {
      matches.push(relative);
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
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
