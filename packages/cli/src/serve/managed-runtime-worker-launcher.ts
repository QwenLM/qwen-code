/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolveManagedRuntimeWorkerLauncher(): {
  launcher: string[];
  cliEntry: string;
} {
  const self = fileURLToPath(import.meta.url);
  const dir = path.dirname(self);
  const bundled = path.basename(dir) === 'chunks' ? path.dirname(dir) : dir;
  const source = self.endsWith('.ts');
  const worker =
    path.basename(dir) === 'serve'
      ? path.join(dir, `managed-runtime-worker-entry.${source ? 'ts' : 'js'}`)
      : path.join(bundled, 'managed-runtime-worker.js');
  const cliEntry =
    path.basename(dir) === 'serve'
      ? path.resolve(dir, '../../index.' + (source ? 'ts' : 'js'))
      : path.join(bundled, 'cli.js');
  if (!existsSync(worker) || !existsSync(cliEntry))
    throw new Error(
      'Managed Runtime auto-local requires the matching worker and CLI artifacts. Build or reinstall this version.',
    );
  const launcher = source
    ? ['--import', createRequire(import.meta.url).resolve('tsx/esm'), worker]
    : [worker];
  return { launcher, cliEntry };
}
