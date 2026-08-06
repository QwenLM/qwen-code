/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveOutputPath } from '../generate-settings-schema.js';

vi.setConfig({ testTimeout: 30_000 });

const script = resolve('scripts/generate-settings-schema.ts');
const temporaryDirectories: string[] = [];

function runGenerator(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx/esm', script, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('generate-settings-schema output', () => {
  it('writes valid JSON to an explicit output path', () => {
    const directory = mkdtempSync(join(tmpdir(), 'qwen-settings-schema-'));
    temporaryDirectories.push(directory);
    const output = join(directory, 'settings.schema.json');

    const result = runGenerator(['--output', output]);

    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
    });
    expect(result.stdout).toContain(resolve(output));
  });

  it.each([['--output'], ['--output', '--other-option']])(
    'rejects a missing output path: %j',
    (...args) => {
      const result = runGenerator(args);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('--output requires a path');
    },
  );

  it('preserves the canonical default output path', () => {
    expect(resolveOutputPath([])).toBe(
      resolve('packages/vscode-ide-companion/schemas/settings.schema.json'),
    );
  });
});
