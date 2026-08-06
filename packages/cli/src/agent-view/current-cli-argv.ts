/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export function getCurrentQwenCliEntrypoint(): string {
  return process.argv[1] ?? 'qwen';
}

export function buildCurrentQwenCliArgv(args: readonly string[]): string[] {
  const entrypoint = getCurrentQwenCliEntrypoint();
  if (entrypoint === 'qwen') {
    return ['qwen', ...args];
  }

  if (process.env['DEV'] === 'true' && entrypoint.endsWith('.ts')) {
    const tsxCli = findLocalTsxCli(entrypoint);
    if (tsxCli) {
      return [process.execPath, tsxCli, entrypoint, ...args];
    }
    throw new Error(
      `Cannot spawn supervisor: DEV=true with TypeScript entrypoint ${entrypoint} but tsx was not found. Run npm install.`,
    );
  }

  return [process.execPath, entrypoint, ...args];
}

function findLocalTsxCli(entrypoint: string): string | undefined {
  const root = path.resolve(path.dirname(entrypoint), '..', '..');
  const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (fs.existsSync(tsxCli)) {
    return tsxCli;
  }
  return undefined;
}
