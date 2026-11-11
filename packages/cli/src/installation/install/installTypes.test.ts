/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { classifyError } from './installTypes.js';

function errorWithCode(message: string, code: unknown): Error {
  return Object.assign(new Error(message), { code });
}

describe('classifyError', () => {
  it('classifies string errno codes', () => {
    expect(classifyError(errorWithCode('open failed', 'EACCES'))).toBe(
      'permission',
    );
    expect(classifyError(errorWithCode('write failed', 'ENOSPC'))).toBe(
      'disk_space',
    );
    expect(classifyError(errorWithCode('socket', 'ECONNRESET'))).toBe('network');
  });

  it('survives numeric child-process exit codes and falls back to the message', () => {
    // execSync/spawn failures carry the exit status as a numeric `code`.
    expect(classifyError(errorWithCode('Command failed: brew upgrade', 1))).toBe(
      'unknown',
    );
    expect(
      classifyError(errorWithCode('Command failed: permission denied', 126)),
    ).toBe('permission');
  });

  it('ignores nullish and non-string codes', () => {
    expect(classifyError(errorWithCode('boom', undefined))).toBe('unknown');
    expect(classifyError(errorWithCode('boom', null))).toBe('unknown');
    expect(classifyError(errorWithCode('boom', { errno: 1 }))).toBe('unknown');
    expect(classifyError('not an error')).toBe('unknown');
  });
});
