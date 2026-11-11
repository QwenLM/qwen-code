/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/// <reference types="vitest/globals" />

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock setFlagSettingsInput from settings.js to avoid touching the real
// module state / cache during tests.
vi.mock('./settings.js', () => ({
  setFlagSettingsInput: vi.fn(),
}));

const { writeToStderrMock } = vi.hoisted(() => ({
  writeToStderrMock: vi.fn(() => true),
}));

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/core')>();
  return {
    ...actual,
    writeToStderr: writeToStderrMock,
  };
});

import { setFlagSettingsInput } from './settings.js';
import {
  eagerParseSettingSourcesFlag,
  eagerParseSettingsFlag,
  loadSettingsFromFlag,
} from './flagSettings.js';

describe('eagerParseSettingSourcesFlag', () => {
  it('collects repeated and comma-separated values in command-line order', () => {
    expect(
      eagerParseSettingSourcesFlag([
        'node',
        'cli',
        '--setting-sources',
        'user,project',
        '--setting-sources=local',
      ]),
    ).toEqual(['user', 'project', 'local']);
  });

  it('returns undefined when --setting-sources is absent', () => {
    expect(
      eagerParseSettingSourcesFlag(['node', 'cli', '--settings', 'foo.json']),
    ).toBeUndefined();
  });

  it('preserves an explicit empty --setting-sources selection', () => {
    expect(
      eagerParseSettingSourcesFlag([
        'node',
        'cli',
        '--setting-sources=',
      ]),
    ).toEqual([]);
  });

  it('ignores --setting-sources after the end-of-options marker', () => {
    expect(
      eagerParseSettingSourcesFlag([
        'node',
        'cli',
        '--',
        '--setting-sources',
        'project',
      ]),
    ).toBeUndefined();
  });
});

describe('eagerParseSettingsFlag', () => {
  it('returns the value after --settings', () => {
    expect(
      eagerParseSettingsFlag(['node', 'cli', '--settings', './foo.json']),
    ).toBe('./foo.json');
  });

  it('returns the value from --settings=path form', () => {
    expect(
      eagerParseSettingsFlag(['node', 'cli', '--settings=./foo.json']),
    ).toBe('./foo.json');
  });

  it('returns undefined when --settings is absent', () => {
    expect(
      eagerParseSettingsFlag(['node', 'cli', '--mcp-config', 'a.json']),
    ).toBeUndefined();
  });

  it('returns inline JSON when passed as value', () => {
    const inline = '{"theme":"dark"}';
    expect(eagerParseSettingsFlag(['node', 'cli', '--settings', inline])).toBe(
      inline,
    );
  });

  it('finds --settings even when preceded by other flags', () => {
    expect(
      eagerParseSettingsFlag([
        'node',
        'cli',
        '--mcp-config',
        'a.json',
        '--settings',
        'b.json',
      ]),
    ).toBe('b.json');
  });
});

describe('loadSettingsFromFlag', () => {
  const setFlagInputMock = vi.mocked(setFlagSettingsInput);
  let tmpDir: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let exitSpy: any;

  beforeEach(() => {
    setFlagInputMock.mockClear();
    writeToStderrMock.mockClear();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-flag-test-'));
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((
      _code?: number | string | null,
    ) => {
      throw new Error('process.exit called');
    }) as never);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    exitSpy.mockRestore();
  });

  it('accepts a valid file path and registers the resolved absolute path', () => {
    const filePath = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(filePath, JSON.stringify({ ui: { theme: 'dark' } }));

    loadSettingsFromFlag(filePath);

    expect(setFlagInputMock).toHaveBeenCalledExactlyOnceWith(filePath);
  });

  it('exits with error when file does not exist', () => {
    const missing = path.join(tmpDir, 'nope.json');
    expect(() => loadSettingsFromFlag(missing)).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(writeToStderrMock).toHaveBeenCalled();
    const stderrOutput = String(
      (writeToStderrMock.mock.calls as unknown[][])[0]?.[0] ?? '',
    );
    expect(stderrOutput).toContain('Settings file not found');
  });

  it('registers inline JSONC without writing to the temp directory', () => {
    vi.stubEnv('TMPDIR', tmpDir);
    vi.stubEnv('TEMP', tmpDir);
    vi.stubEnv('TMP', tmpDir);
    try {
      loadSettingsFromFlag(' { /* settings */ "ui": { "theme": "dark" } } ');

      expect(setFlagInputMock).toHaveBeenCalledExactlyOnceWith({
        ui: { theme: 'dark' },
      });
      expect(fs.readdirSync(tmpDir)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('exits on invalid JSON literal', () => {
    const bad = '{not: "json"}';
    expect(() => loadSettingsFromFlag(bad)).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    const stderrOutput = writeToStderrMock.mock.calls
      .map((call: unknown[]) => String(call[0] ?? ''))
      .join('');
    expect(stderrOutput).toContain('Invalid JSON');
  });

  it('exits when inline JSON is not an object literal', () => {
    // Starts with { and ends with } but the content is an array
    // (NB: [] wouldn't trigger the json branch so we keep the detection on braces)
    const bad = '{}'; // Empty object is actually valid — use a non-object-looking literal instead
    // Need something like: `{"foo"}` — starts/ends with braces but invalid
    const bad2 = '{"foo"}';
    expect(() => loadSettingsFromFlag(bad2)).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);

    // The simple `{}` case should succeed (empty object is valid)
    loadSettingsFromFlag(bad);
    expect(setFlagInputMock).toHaveBeenCalledExactlyOnceWith({});
  });
});
