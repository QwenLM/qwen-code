/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourceRoot = path.join(packageRoot, 'src');
const forbidden = '@qwen-code/webui';
const violations = [];

function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      visit(entryPath);
    } else if (/\.(?:ts|tsx|js|jsx)$/.test(entry.name)) {
      if (fs.readFileSync(entryPath, 'utf8').includes(forbidden)) {
        violations.push(path.relative(packageRoot, entryPath));
      }
    }
  }
}

visit(sourceRoot);
const packageJson = JSON.parse(
  fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
);
if (packageJson.dependencies?.[forbidden]) {
  violations.push('package.json dependencies');
}

if (violations.length > 0) {
  console.error(
    `VS Code companion must not depend on ${forbidden}:\n${violations.join('\n')}`,
  );
  process.exitCode = 1;
}
