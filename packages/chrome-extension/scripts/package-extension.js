/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

export async function packageExtension({
  source = path.join(packageRoot, 'dist/extension'),
  archive = path.join(packageRoot, 'chrome-extension.zip'),
} = {}) {
  await rm(archive, { force: true });
  await new Promise((resolve, reject) => {
    const child = spawn('zip', ['-r', archive, '.'], {
      cwd: source,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`zip exited with ${code ?? signal}`));
    });
  });
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  packageExtension().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
