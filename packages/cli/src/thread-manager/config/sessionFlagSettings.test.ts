/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resolveSessionFlagSettings,
  SessionFlagSettingsError,
} from './sessionFlagSettings.js';

describe('resolveSessionFlagSettings', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'session-flag-path-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('parses inline JSONC as a session override', () => {
    expect(
      resolveSessionFlagSettings(
        ' { /* context */ "context": {"fileName": "A.md"} } ',
        cwd,
      ),
    ).toEqual({ context: { fileName: 'A.md' } });
  });

  it('resolves a relative file path against the session cwd', () => {
    writeFileSync(join(cwd, 'flag.json'), '{}');
    expect(resolveSessionFlagSettings('flag.json', cwd)).toBe(
      join(cwd, 'flag.json'),
    );
  });

  it('rejects malformed input without exiting the process', () => {
    expect(() => resolveSessionFlagSettings('{not json', cwd)).toThrow(
      SessionFlagSettingsError,
    );
    expect(() => resolveSessionFlagSettings('missing.json', cwd)).toThrow(
      /Settings file not found/,
    );
  });
});
