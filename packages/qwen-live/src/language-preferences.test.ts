/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  persistLanguagePreference,
  resolveLiveLanguage,
} from './language-preferences.js';
import { loadConfig } from './config.js';

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, renameSync: vi.fn(fs.renameSync) };
});
const directories: string[] = [];
function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'live-language-'));
  directories.push(dir);
  return dir;
}
afterEach(() => {
  vi.mocked(renameSync).mockClear();
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('Live language preference', () => {
  it('defaults existing configurations to English and reads an explicit language', () => {
    const dataDir = directory();
    const path = join(dataDir, 'config.json');
    writeFileSync(path, '{"realtimeApiKey":"fixture-key"}');
    expect(loadConfig({ QWEN_LIVE_DATA_DIR: dataDir }).language).toBe('en');
    persistLanguagePreference(dataDir, 'zh-CN');
    expect(loadConfig({ QWEN_LIVE_DATA_DIR: dataDir }).language).toBe('zh-CN');
    expect(resolveLiveLanguage(undefined)).toBe('en');
  });

  it('atomically merges language without replacing credentials or unrelated preferences', () => {
    const dataDir = directory();
    const path = join(dataDir, 'config.json');
    const raw = {
      realtimeApiKey: 'private-fixture',
      memory: { enabled: false },
      visualInput: { source: 'camera' },
      custom: [1, 2],
    };
    writeFileSync(path, JSON.stringify(raw));
    expect(persistLanguagePreference(dataDir, 'zh-CN')).toBe('zh-CN');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      ...raw,
      language: 'zh-CN',
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dataDir)).toEqual(['config.json']);
  });

  it('rejects invalid language before writing and preserves config on atomic rename failure', () => {
    const dataDir = directory();
    const path = join(dataDir, 'config.json');
    const raw = '{"realtimeApiKey":"private-fixture","language":"en"}';
    writeFileSync(path, raw);
    for (const value of [undefined, 'zh', '', null, 1, true])
      expect(() => persistLanguagePreference(dataDir, value)).toThrow();
    expect(readFileSync(path, 'utf8')).toBe(raw);
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error('fixture rename failure');
    });
    expect(() => persistLanguagePreference(dataDir, 'zh-CN')).toThrow(
      'fixture rename failure',
    );
    expect(readFileSync(path, 'utf8')).toBe(raw);
    expect(readdirSync(dataDir)).toEqual(['config.json']);
  });
});
