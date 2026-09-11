/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { persistScreenDisplayPreference } from './visual-preferences.js';

const directories: string[] = [];
async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'qwen-live-display-preference-'));
  directories.push(path);
  return path;
}
afterEach(async () => {
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});

describe('persistScreenDisplayPreference', () => {
  it('atomically saves only the display selection, preserving config and visual fields', async () => {
    const dataDir = await directory();
    const config = {
      realtimeApiKey: 'fixture',
      language: 'zh-CN',
      visualInput: {
        source: 'camera',
        mode: 'on-demand',
        fps: 2,
        futureField: 1,
      },
    };
    await writeFile(join(dataDir, 'config.json'), JSON.stringify(config));
    const id = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
    expect(persistScreenDisplayPreference(dataDir, id)).toBe(id.toLowerCase());
    expect(
      JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf8')),
    ).toEqual({
      ...config,
      visualInput: { ...config.visualInput, screenDisplayId: id.toLowerCase() },
    });
    expect(await readdir(dataDir)).toEqual(['config.json']);
  });

  it('fails without overwriting malformed config', async () => {
    const dataDir = await directory();
    await writeFile(join(dataDir, 'config.json'), '{bad');
    expect(() => persistScreenDisplayPreference(dataDir, 'primary')).toThrow();
    expect(await readFile(join(dataDir, 'config.json'), 'utf8')).toBe('{bad');
  });

  it('creates a minimal config when absent and rejects non-display IDs', async () => {
    const dataDir = await directory();
    expect(() => persistScreenDisplayPreference(dataDir, 'monitor-2')).toThrow(
      'Invalid screen display ID',
    );
    expect(persistScreenDisplayPreference(dataDir, 'primary')).toBe('primary');
    expect(
      JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf8')),
    ).toEqual({ visualInput: { screenDisplayId: 'primary' } });
  });
});
