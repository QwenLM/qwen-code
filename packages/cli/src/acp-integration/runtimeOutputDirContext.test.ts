import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { Storage } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../config/settings.js';
import { runWithAcpRuntimeOutputDir } from './runtimeOutputDirContext.js';

describe('runWithAcpRuntimeOutputDir', () => {
  beforeEach(() => {
    Storage.setRuntimeBaseDir(null);
    delete process.env['QWEN_RUNTIME_DIR'];
  });

  afterEach(() => {
    Storage.setRuntimeBaseDir(null);
    delete process.env['QWEN_RUNTIME_DIR'];
  });

  it('uses the merged runtimeOutputDir relative to cwd within the async context', async () => {
    const cwd = path.resolve('workspace', 'project-a');
    const settings = {
      merged: {
        advanced: {
          runtimeOutputDir: '.qwen-runtime',
        },
      },
    } as LoadedSettings;

    await runWithAcpRuntimeOutputDir(settings, cwd, async () => {
      expect(Storage.getRuntimeBaseDir()).toBe(path.join(cwd, '.qwen-runtime'));
    });

    expect(Storage.getRuntimeBaseDir()).toBe(Storage.getGlobalQwenDir());
  });

  it('isolates concurrent workspace runtime directories across awaits', async () => {
    const cwdA = path.resolve('workspace', 'project-a');
    const cwdB = path.resolve('workspace', 'project-b');
    const settingsA = {
      merged: { advanced: { runtimeOutputDir: '.runtime-a' } },
    } as LoadedSettings;
    const settingsB = {
      merged: { advanced: { runtimeOutputDir: '.runtime-b' } },
    } as LoadedSettings;
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waitForBoth = async () => {
      arrivals++;
      if (arrivals === 2) release();
      await barrier;
    };

    await Promise.all([
      runWithAcpRuntimeOutputDir(settingsA, cwdA, async () => {
        const storage = new Storage(cwdA);
        await waitForBoth();
        expect(Storage.getRuntimeBaseDir()).toBe(path.join(cwdA, '.runtime-a'));
        expect(storage.getRuntimeBaseDir()).toBe(path.join(cwdA, '.runtime-a'));
      }),
      runWithAcpRuntimeOutputDir(settingsB, cwdB, async () => {
        const storage = new Storage(cwdB);
        await waitForBoth();
        expect(Storage.getRuntimeBaseDir()).toBe(path.join(cwdB, '.runtime-b'));
        expect(storage.getRuntimeBaseDir()).toBe(path.join(cwdB, '.runtime-b'));
      }),
    ]);
  });
});
