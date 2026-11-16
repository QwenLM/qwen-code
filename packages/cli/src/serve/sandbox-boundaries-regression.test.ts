/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { start_sandbox } from './sandbox.js';

let fixture: string | undefined;
afterEach(() => {
  if (fixture) fs.rmSync(fixture, { recursive: true, force: true });
});

describe('retired bwrap state grants', () => {
  it('rejects before creating or modifying host bootstrap files', async () => {
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-retired-bwrap-'));
    const marker = path.join(fixture, 'existing-config');
    fs.writeFileSync(marker, 'preserved');
    const state = path.join(fixture, 'absent-state');
    await expect(
      start_sandbox(
        { command: 'bwrap' },
        [],
        undefined,
        [process.execPath, '/installed/cli.js'],
        { QWEN_HOME: state },
      ),
    ).rejects.toThrow('tools.executionSandbox');
    expect(fs.readFileSync(marker, 'utf8')).toBe('preserved');
    expect(fs.readdirSync(fixture)).toEqual(['existing-config']);
  });
});
