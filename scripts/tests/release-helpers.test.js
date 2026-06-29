/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('node:fs');

import {
  getArgs,
  readJson,
  validateVersion,
  isExpectedMissingGitHubRelease,
} from '../lib/release-helpers.js';

describe('getArgs', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    process.argv = ['node', 'script.js'];
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  it('parses --key=value arguments', () => {
    process.argv = ['node', 'script.js', '--type=nightly', '--channel=preview'];
    expect(getArgs()).toEqual({ type: 'nightly', channel: 'preview' });
  });

  it('sets boolean true for flags without a value', () => {
    process.argv = ['node', 'script.js', '--dry-run', '--verbose'];
    expect(getArgs()).toEqual({ 'dry-run': true, verbose: true });
  });

  it('ignores arguments that do not start with --', () => {
    process.argv = ['node', 'script.js', 'positional', '-short', '--valid=1'];
    expect(getArgs()).toEqual({ valid: '1' });
  });

  it('preserves equals signs in argument values', () => {
    process.argv = ['node', 'script.js', '--message=hello=world'];
    expect(getArgs()).toEqual({ message: 'hello=world' });
  });

  it('returns an empty object when there are no arguments', () => {
    process.argv = ['node', 'script.js'];
    expect(getArgs()).toEqual({});
  });
});

describe('readJson', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('reads and parses a JSON file', () => {
    vi.mocked(readFileSync).mockReturnValue('{"version": "1.0.0"}');
    expect(readJson('/path/to/file.json')).toEqual({ version: '1.0.0' });
    expect(readFileSync).toHaveBeenCalledWith('/path/to/file.json', 'utf-8');
  });

  it('propagates errors from readFileSync', () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(() => readJson('/nonexistent.json')).toThrow('ENOENT');
  });
});

describe('validateVersion', () => {
  it('accepts a valid X.Y.Z version', () => {
    expect(() => validateVersion('1.2.3', 'X.Y.Z', 'test')).not.toThrow();
  });

  it('accepts a valid X.Y.Z-preview.N version', () => {
    expect(() =>
      validateVersion('1.2.3-preview.4', 'X.Y.Z-preview.N', 'test'),
    ).not.toThrow();
  });

  it('throws for an invalid X.Y.Z version', () => {
    expect(() => validateVersion('bad', 'X.Y.Z', 'test')).toThrow(
      'Invalid test: bad. Must be in X.Y.Z format.',
    );
  });

  it('throws when version does not match the requested format', () => {
    expect(() => validateVersion('1.2.3', 'X.Y.Z-preview.N', 'test')).toThrow(
      'Invalid test: 1.2.3. Must be in X.Y.Z-preview.N format.',
    );
  });

  it('throws for an unknown format key', () => {
    expect(() => validateVersion('1.2.3', 'unknown', 'test')).toThrow(
      'Invalid test: 1.2.3. Must be in unknown format.',
    );
  });
});

describe('isExpectedMissingGitHubRelease', () => {
  it('returns true when message contains "release not found"', () => {
    const error = new Error('release not found');
    expect(isExpectedMissingGitHubRelease(error)).toBe(true);
  });

  it('returns true when stderr contains "Not Found"', () => {
    const error = new Error('command failed');
    error.stderr = Buffer.from('Not Found');
    expect(isExpectedMissingGitHubRelease(error)).toBe(true);
  });

  it('returns true when stdout contains "release not found"', () => {
    const error = new Error('command failed');
    error.stdout = Buffer.from('release not found');
    expect(isExpectedMissingGitHubRelease(error)).toBe(true);
  });

  it('returns false for an unrelated error', () => {
    const error = new Error('network timeout');
    expect(isExpectedMissingGitHubRelease(error)).toBe(false);
  });

  it('handles errors without stderr or stdout properties', () => {
    const error = new Error('something went wrong');
    expect(isExpectedMissingGitHubRelease(error)).toBe(false);
  });
});
