/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const temporaryDirectories: string[] = [];

async function temporaryDataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'qwen-live-config-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function dataDirWithConfig(config: unknown): Promise<string> {
  const dataDir = await temporaryDataDir();
  await writeFile(join(dataDir, 'config.json'), JSON.stringify(config));
  return dataDir;
}

function thrownMessage(callback: () => unknown): string {
  try {
    callback();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the callback to throw');
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('loadConfig', () => {
  it('applies env over file over built-in defaults', async () => {
    const dataDir = await dataDirWithConfig({
      realtimeApiKey: 'file-key',
      realtimeModel: 'file-model',
      voice: 'FileVoice',
      port: 4171,
    });

    const envWins = loadConfig({
      QWEN_LIVE_DATA_DIR: dataDir,
      DASHSCOPE_API_KEY: 'env-key',
      QWEN_LIVE_REALTIME_MODEL: 'env-model',
      QWEN_LIVE_VOICE: 'EnvVoice',
      QWEN_LIVE_PORT: '4172',
    });
    expect(envWins.realtime.apiKey).toBe('env-key');
    expect(envWins.realtime.model).toBe('env-model');
    expect(envWins.realtime.voice).toBe('EnvVoice');
    expect(envWins.port).toBe(4172);

    const fileWins = loadConfig({ QWEN_LIVE_DATA_DIR: dataDir });
    expect(fileWins.realtime.apiKey).toBe('file-key');
    expect(fileWins.realtime.model).toBe('file-model');
    expect(fileWins.realtime.voice).toBe('FileVoice');
    expect(fileWins.port).toBe(4171);

    const defaults = loadConfig({
      QWEN_LIVE_DATA_DIR: await temporaryDataDir(),
      DASHSCOPE_API_KEY: 'env-key',
    });
    expect(defaults.realtime.model).toBe('qwen3.5-omni-plus-realtime');
    expect(defaults.realtime.endpoint).toBe('https://dashscope.aliyuncs.com');
    expect(defaults.serve.baseUrl).toBe('http://127.0.0.1:4170');
    expect(defaults.port).toBe(0);
  });

  it('fails fast when no realtime API key is configured anywhere', async () => {
    const dataDir = await temporaryDataDir();
    const message = thrownMessage(() =>
      loadConfig({ QWEN_LIVE_DATA_DIR: dataDir }),
    );
    expect(message).toContain('DASHSCOPE_API_KEY');
    expect(message).toContain(join(dataDir, 'config.json'));
  });

  it('surfaces non-ENOENT config read errors naming the path', async () => {
    // A config.json that is a DIRECTORY yields EISDIR on read — the
    // portable stand-in for an unreadable file (chmod-based denial is
    // unreliable when the suite runs as root). This must NOT be swallowed
    // as "no config file".
    const dataDir = await temporaryDataDir();
    await mkdir(join(dataDir, 'config.json'));

    const message = thrownMessage(() =>
      loadConfig({ QWEN_LIVE_DATA_DIR: dataDir, DASHSCOPE_API_KEY: 'key' }),
    );
    expect(message).toContain(
      `Could not read config file ${join(dataDir, 'config.json')}`,
    );
  });

  it('parses a config file saved with a UTF-8 BOM', async () => {
    const dataDir = await temporaryDataDir();
    await writeFile(
      join(dataDir, 'config.json'),
      '\uFEFF' + JSON.stringify({ realtimeApiKey: 'bom-key', port: 4173 }),
    );

    const config = loadConfig({ QWEN_LIVE_DATA_DIR: dataDir });
    expect(config.realtime.apiKey).toBe('bom-key');
    expect(config.port).toBe(4173);
  });

  it('rejects wrong-typed file port values instead of defaulting to 0', async () => {
    for (const port of [true, [4171], { value: 4171 }]) {
      const dataDir = await dataDirWithConfig({ realtimeApiKey: 'k', port });
      const message = thrownMessage(() =>
        loadConfig({ QWEN_LIVE_DATA_DIR: dataDir }),
      );
      expect(message).toContain(`Invalid "port" in`);
      expect(message).toContain(JSON.stringify(port));
    }
  });

  it('names config.json, not QWEN_LIVE_PORT, for a file-sourced bad port', async () => {
    const dataDir = await dataDirWithConfig({
      realtimeApiKey: 'k',
      port: 'abc',
    });
    const message = thrownMessage(() =>
      loadConfig({ QWEN_LIVE_DATA_DIR: dataDir }),
    );
    expect(message).toContain(
      `Invalid "port" in ${join(dataDir, 'config.json')}: "abc"`,
    );
    expect(message).not.toContain('QWEN_LIVE_PORT');
  });

  it('names QWEN_LIVE_PORT for an env-sourced bad port', async () => {
    const dataDir = await dataDirWithConfig({ realtimeApiKey: 'k' });
    expect(() =>
      loadConfig({ QWEN_LIVE_DATA_DIR: dataDir, QWEN_LIVE_PORT: '70000' }),
    ).toThrow('Invalid QWEN_LIVE_PORT: 70000');
  });

  it('expands a leading ~ in dataDir, defaultCwd, and discoveryDir', async () => {
    const dataDir = await dataDirWithConfig({
      realtimeApiKey: 'k',
      discoveryDir: '~/qwen-live-test-discovery',
    });

    const config = loadConfig({
      QWEN_LIVE_DATA_DIR: dataDir,
      QWEN_LIVE_CWD: '~/qwen-live-test-cwd',
    });
    expect(config.defaultCwd).toBe(join(homedir(), 'qwen-live-test-cwd'));
    expect(config.discoveryDir).toBe(
      join(homedir(), 'qwen-live-test-discovery'),
    );

    // dataDir itself expands too; the missing-key error names the real path.
    const message = thrownMessage(() =>
      loadConfig({ QWEN_LIVE_DATA_DIR: '~/qwen-live-test-nonexistent' }),
    );
    expect(message).toContain(
      join(homedir(), 'qwen-live-test-nonexistent', 'config.json'),
    );
  });

  it('defaults discoveryDir to the stable ~/.qwen base', async () => {
    const dataDir = await dataDirWithConfig({ realtimeApiKey: 'k' });
    const config = loadConfig({ QWEN_LIVE_DATA_DIR: dataDir });
    expect(config.discoveryDir).toBe(join(homedir(), '.qwen'));
  });
});
