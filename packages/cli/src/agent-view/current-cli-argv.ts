/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

export function getCurrentQwenCliEntrypoint(): string {
  return process.argv[1] ?? 'qwen';
}

export function buildCurrentQwenCliArgv(args: readonly string[]): string[] {
  const entrypoint = getCurrentQwenCliEntrypoint();
  if (entrypoint === 'qwen') {
    return ['qwen', ...args];
  }

  if (process.env['DEV'] === 'true' && entrypoint.endsWith('.ts')) {
    const tsxRuntimeArgs = findLocalTsxRuntimeArgs(entrypoint);
    if (tsxRuntimeArgs) {
      return [process.execPath, ...tsxRuntimeArgs, entrypoint, ...args];
    }
    throw new Error(
      `Cannot spawn supervisor: DEV=true with TypeScript entrypoint ${entrypoint} but tsx was not found. Run npm install.`,
    );
  }

  return [process.execPath, entrypoint, ...args];
}

function findLocalTsxRuntimeArgs(entrypoint: string): string[] | undefined {
  const root = path.resolve(path.dirname(entrypoint), '..', '..');
  const tsxDist = path.join(root, 'node_modules', 'tsx', 'dist');
  const preflight = path.join(tsxDist, 'preflight.cjs');
  const loader = path.join(tsxDist, 'loader.mjs');
  if (fs.existsSync(preflight) && fs.existsSync(loader)) {
    return ['--require', preflight, '--import', pathToFileURL(loader).href];
  }
  return undefined;
}
