/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);

const scannedRoots = [
  path.join(repoRoot, 'packages', 'cli', 'src', 'serve'),
  path.join(repoRoot, 'packages', 'acp-bridge', 'src'),
];

const allowedProcessEnvFiles = new Set(
  [
    'packages/acp-bridge/src/bridge.ts',
    'packages/acp-bridge/src/bridgeOptions.ts',
    'packages/acp-bridge/src/spawnChannel.ts',
    'packages/cli/src/serve/acp-http/index.ts',
    'packages/cli/src/serve/channel-worker-supervisor.ts',
    'packages/cli/src/serve/daemon-logger.ts',
    'packages/cli/src/serve/debug-mode.ts',
    'packages/cli/src/serve/env-snapshot.ts',
    'packages/cli/src/serve/fast-path-settings.ts',
    'packages/cli/src/serve/fast-path.ts',
    'packages/cli/src/serve/fs/audit.ts',
    'packages/cli/src/serve/routes/workspace-setup-github.ts',
    'packages/cli/src/serve/run-qwen-serve.ts',
    'packages/cli/src/serve/server/fs-factory.ts',
    'packages/cli/src/serve/server/serve-features.ts',
  ].map((file) => path.normalize(file)),
);

function listTypeScriptFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listTypeScriptFiles(full).forEach((file) => out.push(file));
    } else if (entry.isFile() && full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('serve process.env guard', () => {
  it('keeps workspace-scoped serve and acp-bridge code off direct process.env reads', () => {
    const offenders: string[] = [];
    for (const root of scannedRoots) {
      for (const file of listTypeScriptFiles(root)) {
        if (file.endsWith('.test.ts')) continue;
        const relative = path.normalize(path.relative(repoRoot, file));
        if (allowedProcessEnvFiles.has(relative)) continue;
        if (
          stripComments(fs.readFileSync(file, 'utf8')).includes('process.env')
        ) {
          offenders.push(relative);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
