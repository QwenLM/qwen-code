/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseAuditArgs } from './parse-args.js';

describe('parseAuditArgs', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(
      tmpdir(),
      `audit args $(literal) ${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('preserves a quoted path with spaces and shell metacharacters', () => {
    const parsed = parseAuditArgs(`${JSON.stringify(dir)} --effort high`);
    expect(parsed).toEqual({
      targetPath: dir,
      targetPathAbsolute: dir,
      effort: 'high',
    });
  });

  it('defaults to medium and accepts the equals effort form', () => {
    expect(parseAuditArgs(JSON.stringify(dir)).effort).toBe('medium');
    expect(parseAuditArgs(`${JSON.stringify(dir)} --effort=LOW`).effort).toBe(
      'low',
    );
  });

  it('rejects missing, extra, and ambiguous input', () => {
    expect(() => parseAuditArgs('')).toThrow(/exactly one directory/);
    expect(() => parseAuditArgs(`${JSON.stringify(dir)} other`)).toThrow(
      /exactly one directory/,
    );
    expect(() => parseAuditArgs(`${JSON.stringify(dir)} --unknown`)).toThrow(
      /unknown flag/,
    );
    expect(() =>
      parseAuditArgs(`${JSON.stringify(dir)} --effort nope`),
    ).toThrow(/must be low, medium, or high/);
  });
});
