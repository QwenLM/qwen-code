/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
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
    child.once('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(
          new Error(
            'Packaging failed. Ensure the POSIX zip utility is installed AND the source directory exists: ' +
              source,
          ),
        );
      } else {
        reject(err);
      }
    });
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`zip exited with ${code ?? signal}`));
    });
  });
}

// Node realpaths the ESM main entry but not process.argv[1], so comparing the
// raw paths silently skips the packaging step under a symlinked checkout.
const isMainEntry = () =>
  Boolean(process.argv[1]) &&
  fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);

if (isMainEntry()) {
  packageExtension().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
