/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  isNumericSessionIndex,
  isSafeSessionFileStem,
  isUuidSessionId,
  resolveBucketDir,
  sanitizePath,
} from './session-utils.js';
import {
  setConfigHomeDir,
  resetConfigHomeDirCache,
} from '../config/sessions-config.js';

describe('isSafeSessionFileStem', () => {
  it('accepts safe file stems', () => {
    expect(isSafeSessionFileStem('abc-123')).toBe(true);
    expect(isSafeSessionFileStem('session.v1')).toBe(true);
  });

  it('rejects path traversal and unsafe characters', () => {
    expect(isSafeSessionFileStem('..')).toBe(false);
    expect(isSafeSessionFileStem('/etc/passwd')).toBe(false);
    expect(isSafeSessionFileStem('a b')).toBe(false);
  });
});

describe('isUuidSessionId', () => {
  it('accepts canonical UUIDs', () => {
    expect(isUuidSessionId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });

  it('rejects non-UUID strings', () => {
    expect(isUuidSessionId('abc-123')).toBe(false);
    expect(isUuidSessionId('')).toBe(false);
  });
});

describe('isNumericSessionIndex', () => {
  it('accepts positive base-10 integers', () => {
    expect(isNumericSessionIndex('3')).toBe(true);
    expect(isNumericSessionIndex('42')).toBe(true);
  });

  it('rejects zero, negatives, and non-numeric values', () => {
    expect(isNumericSessionIndex('0')).toBe(false);
    expect(isNumericSessionIndex('-1')).toBe(false);
    expect(isNumericSessionIndex('abc')).toBe(false);
    expect(isNumericSessionIndex('1.5')).toBe(false);
  });
});

describe('sanitizePath', () => {
  it('replaces non-alphanumeric characters with dashes', () => {
    expect(sanitizePath('/Users/me/project')).toBe('-Users-me-project');
  });

  it('preserves case to match core behavior', () => {
    expect(sanitizePath('/My/Projects/App')).toBe('-My-Projects-App');
  });

  it('does not trim leading or trailing dashes', () => {
    expect(sanitizePath('--foo--')).toBe('--foo--');
  });

  it('handles Windows-style paths', () => {
    expect(sanitizePath('C:\\Users\\me\\project')).toBe('C--Users-me-project');
  });

  it('truncates long paths and appends a djb2 hash', () => {
    const longPath = '/Users/me/' + 'very-long-project-name/'.repeat(20);
    const sanitized = sanitizePath(longPath);
    expect(sanitized.length).toBeLessThanOrEqual(200 + 1 + 10);
    expect(sanitized).toMatch(/^-Users-me-very-long-project-name.*-[a-z0-9]+$/);
  });

  it('produces different hashes for different long paths with the same prefix', () => {
    const prefix = '/a/'.repeat(80);
    const a = sanitizePath(prefix + 'suffix-one');
    const b = sanitizePath(prefix + 'suffix-two');
    expect(a).not.toBe(b);
  });
});

describe('resolveBucketDir', () => {
  it('uses the caller-provided bucket override when given', () => {
    expect(resolveBucketDir('/any', '/override/dir')).toBe('/override/dir');
  });

  it('falls back to the sanitized default bucket', () => {
    const dir = resolveBucketDir('/Users/me/project');
    expect(dir).toContain('-Users-me-project');
  });

  it('honors the configured config home root', () => {
    setConfigHomeDir('/custom/config');
    try {
      expect(resolveBucketDir('/Users/me/project')).toBe(
        '/custom/config/projects/-Users-me-project',
      );
    } finally {
      setConfigHomeDir(undefined);
      resetConfigHomeDirCache();
    }
  });
});
