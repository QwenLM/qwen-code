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
      visualInput: {
        source: 'camera',
        mode: 'live-feed',
        fps: 2,
        cameraResolution: { width: 1600, height: 900 },
        cameraSnapshotResolution: { width: 3840, height: 2160 },
        liveResolution: { width: 1920, height: 1080 },
        snapshotResolution: { width: 2560, height: 1440 },
      },
      port: 4171,
    });

    const envWins = loadConfig({
      QWEN_LIVE_DATA_DIR: dataDir,
      DASHSCOPE_API_KEY: 'env-key',
      QWEN_LIVE_REALTIME_MODEL: 'env-model',
      QWEN_LIVE_VOICE: 'EnvVoice',
      QWEN_LIVE_VISUAL_SOURCE: 'screen',
      QWEN_LIVE_VISUAL_MODE: 'on-demand',
      QWEN_LIVE_VISUAL_FPS: '3',
      QWEN_LIVE_CAMERA_RESOLUTION: '1024x576',
      QWEN_LIVE_CAMERA_SNAPSHOT_RESOLUTION: '1920x1080',
      QWEN_LIVE_VISUAL_LIVE_RESOLUTION: '1024x576',
      QWEN_LIVE_VISUAL_SNAPSHOT_RESOLUTION: 'native',
      QWEN_LIVE_PORT: '4172',
    });
    expect(envWins.realtime.apiKey).toBe('env-key');
    expect(envWins.realtime.model).toBe('env-model');
    expect(envWins.realtime.voice).toBe('EnvVoice');
    expect(envWins.visualInput).toEqual({
      source: 'screen',
      mode: 'on-demand',
      fps: 3,
      cameraResolution: { width: 1024, height: 576 },
      cameraSnapshotResolution: { width: 1920, height: 1080 },
      liveResolution: { width: 1024, height: 576 },
      snapshotResolution: 'native',
    });
    expect(envWins.port).toBe(4172);

    const fileWins = loadConfig({ QWEN_LIVE_DATA_DIR: dataDir });
    expect(fileWins.realtime.apiKey).toBe('file-key');
    expect(fileWins.realtime.model).toBe('file-model');
    expect(fileWins.realtime.voice).toBe('FileVoice');
    expect(fileWins.visualInput).toEqual({
      source: 'camera',
      mode: 'live-feed',
      fps: 2,
      cameraResolution: { width: 1600, height: 900 },
      cameraSnapshotResolution: { width: 3840, height: 2160 },
      liveResolution: { width: 1920, height: 1080 },
      snapshotResolution: { width: 2560, height: 1440 },
    });
    expect(fileWins.port).toBe(4171);

    const defaults = loadConfig({
      QWEN_LIVE_DATA_DIR: await temporaryDataDir(),
      DASHSCOPE_API_KEY: 'env-key',
    });
    expect(defaults.realtime.model).toBe('qwen3.5-omni-plus-realtime');
    expect(defaults.realtime.endpoint).toBe('https://dashscope.aliyuncs.com');
    expect(defaults.visualInput).toEqual({
      source: 'screen',
      mode: 'on-demand',
      fps: 1,
      cameraResolution: { width: 1280, height: 720 },
      cameraSnapshotResolution: 'native',
      liveResolution: { width: 1280, height: 720 },
      snapshotResolution: 'native',
    });
    expect(defaults.proactive).toEqual({
      enabled: true,
      monitor: { sessionRecycleEvals: 60 },
      scheduler: {
        evalIntervalSec: 2,
        maxConcurrentTasks: 4,
        maxFailuresPerTask: 3,
        repeat: {
          cooldownSec: 3,
          maxWaitTtsSec: 30,
          clearBufferOnResume: true,
        },
      },
      vision: {
        fps: 1,
        windowSizeSec: 10,
        minEvalDurationSec: 0,
      },
      audio: { windowSizeSec: 60, minEvalDurationSec: 0 },
    });
    expect(defaults.backends).toEqual([
      {
        name: 'qwen-code',
        kind: 'qwen-code',
        baseUrl: 'http://127.0.0.1:4170',
        isDefault: true,
      },
    ]);
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

  it('rejects invalid visual frame rates from file and environment', async () => {
    for (const fps of [0, -1, 11, true, 'fast']) {
      const dataDir = await dataDirWithConfig({
        realtimeApiKey: 'k',
        visualInput: { fps },
      });
      expect(() => loadConfig({ QWEN_LIVE_DATA_DIR: dataDir })).toThrow(
        `Invalid "visualInput.fps" in ${join(dataDir, 'config.json')}`,
      );
    }

    const dataDir = await dataDirWithConfig({ realtimeApiKey: 'k' });
    expect(() =>
      loadConfig({
        QWEN_LIVE_DATA_DIR: dataDir,
        QWEN_LIVE_VISUAL_FPS: 'Infinity',
      }),
    ).toThrow('Invalid QWEN_LIVE_VISUAL_FPS');
  });

  it('rejects invalid visual modes and resolutions', async () => {
    for (const liveResolution of [
      { width: 0, height: 720 },
      { width: 1280.5, height: 720 },
      { width: 4000, height: 720 },
      'native',
      'wide',
    ]) {
      const dataDir = await dataDirWithConfig({
        realtimeApiKey: 'k',
        visualInput: { liveResolution },
      });
      expect(() => loadConfig({ QWEN_LIVE_DATA_DIR: dataDir })).toThrow(
        `Invalid "visualInput.liveResolution" in ${join(dataDir, 'config.json')}`,
      );
    }

    const dataDir = await dataDirWithConfig({ realtimeApiKey: 'k' });
    expect(() =>
      loadConfig({
        QWEN_LIVE_DATA_DIR: dataDir,
        QWEN_LIVE_CAMERA_RESOLUTION: 'native',
      }),
    ).toThrow('Invalid QWEN_LIVE_CAMERA_RESOLUTION');
    expect(() =>
      loadConfig({
        QWEN_LIVE_DATA_DIR: dataDir,
        QWEN_LIVE_VISUAL_SNAPSHOT_RESOLUTION: '9000x5000',
      }),
    ).toThrow('Invalid QWEN_LIVE_VISUAL_SNAPSHOT_RESOLUTION');
    expect(() =>
      loadConfig({
        QWEN_LIVE_DATA_DIR: dataDir,
        QWEN_LIVE_VISUAL_MODE: 'automatic',
      }),
    ).toThrow('Invalid visual input mode');
  });

  it('defaults camera snapshots independently of legacy screen settings and validates overrides', async () => {
    const dataDir = await dataDirWithConfig({
      realtimeApiKey: 'k',
      visualInput: { snapshotResolution: { width: 1024, height: 768 } },
    });
    expect(
      loadConfig({ QWEN_LIVE_DATA_DIR: dataDir }).visualInput
        .cameraSnapshotResolution,
    ).toBe('native');
    expect(
      loadConfig({
        QWEN_LIVE_DATA_DIR: dataDir,
        QWEN_LIVE_CAMERA_SNAPSHOT_RESOLUTION: 'native',
      }).visualInput.snapshotResolution,
    ).toEqual({ width: 1024, height: 768 });
    for (const resolution of ['9000x5000', '720p', '1280x0', '160x119']) {
      expect(() =>
        loadConfig({
          QWEN_LIVE_DATA_DIR: dataDir,
          QWEN_LIVE_CAMERA_SNAPSHOT_RESOLUTION: resolution,
        }),
      ).toThrow('Invalid QWEN_LIVE_CAMERA_SNAPSHOT_RESOLUTION');
    }
    const invalidFile = await dataDirWithConfig({
      realtimeApiKey: 'k',
      visualInput: { cameraSnapshotResolution: { width: 1280 } },
    });
    expect(() => loadConfig({ QWEN_LIVE_DATA_DIR: invalidFile })).toThrow(
      'Invalid "visualInput.cameraSnapshotResolution"',
    );
  });

  it('deep-merges proactive settings and lets the environment override enabled', async () => {
    const dataDir = await dataDirWithConfig({
      realtimeApiKey: 'k',
      proactive: {
        enabled: false,
        monitor: { sessionRecycleEvals: 120 },
        scheduler: {
          evalIntervalSec: 0.5,
          maxConcurrentTasks: 8,
          maxFailuresPerTask: 9,
          repeat: {
            cooldownSec: 4,
            maxWaitTtsSec: 45,
            clearBufferOnResume: false,
          },
        },
        vision: {
          fps: 2,
          windowSizeSec: 15,
          minEvalDurationSec: 5,
        },
        audio: { windowSizeSec: 90, minEvalDurationSec: 10 },
      },
    });

    expect(loadConfig({ QWEN_LIVE_DATA_DIR: dataDir }).proactive).toEqual({
      enabled: false,
      monitor: { sessionRecycleEvals: 120 },
      scheduler: {
        evalIntervalSec: 0.5,
        maxConcurrentTasks: 8,
        maxFailuresPerTask: 9,
        repeat: {
          cooldownSec: 4,
          maxWaitTtsSec: 45,
          clearBufferOnResume: false,
        },
      },
      vision: {
        fps: 2,
        windowSizeSec: 15,
        minEvalDurationSec: 5,
      },
      audio: { windowSizeSec: 90, minEvalDurationSec: 10 },
    });
    expect(
      loadConfig({
        QWEN_LIVE_DATA_DIR: dataDir,
        QWEN_LIVE_PROACTIVE_ENABLED: '1',
      }).proactive.enabled,
    ).toBe(true);
    expect(
      loadConfig({
        QWEN_LIVE_DATA_DIR: dataDir,
        QWEN_LIVE_PROACTIVE_ENABLED: 'false',
      }).proactive.enabled,
    ).toBe(false);
  });

  it('rejects malformed proactive objects and unknown settings', async () => {
    const cases: Array<[unknown, string]> = [
      [false, 'proactive'],
      [{ monitor: [] }, 'proactive.monitor'],
      [{ scheduler: 'often' }, 'proactive.scheduler'],
      [{ scheduler: { repeat: null } }, 'proactive.scheduler.repeat'],
      [{ vision: [] }, 'proactive.vision'],
      [{ audio: true }, 'proactive.audio'],
      [{ scheduler: { typo: 1 } }, 'unknown key(s): "typo"'],
    ];
    for (const [proactive, expected] of cases) {
      const dataDir = await dataDirWithConfig({
        realtimeApiKey: 'k',
        proactive,
      });
      expect(() => loadConfig({ QWEN_LIVE_DATA_DIR: dataDir })).toThrow(
        expected,
      );
    }
  });

  it('strictly validates proactive booleans and the environment switch', async () => {
    for (const proactive of [
      { enabled: 'true' },
      { scheduler: { repeat: { clearBufferOnResume: 1 } } },
    ]) {
      const dataDir = await dataDirWithConfig({
        realtimeApiKey: 'k',
        proactive,
      });
      expect(() => loadConfig({ QWEN_LIVE_DATA_DIR: dataDir })).toThrow(
        'expected a boolean',
      );
    }

    const dataDir = await dataDirWithConfig({ realtimeApiKey: 'k' });
    for (const enabled of ['', 'yes', 'TRUE', '2']) {
      expect(() =>
        loadConfig({
          QWEN_LIVE_DATA_DIR: dataDir,
          QWEN_LIVE_PROACTIVE_ENABLED: enabled,
        }),
      ).toThrow('Invalid QWEN_LIVE_PROACTIVE_ENABLED');
    }
    expect(
      loadConfig({
        QWEN_LIVE_DATA_DIR: dataDir,
        QWEN_LIVE_PROACTIVE_ENABLED: '0',
      }).proactive.enabled,
    ).toBe(false);
    expect(
      loadConfig({
        QWEN_LIVE_DATA_DIR: dataDir,
        QWEN_LIVE_PROACTIVE_ENABLED: 'true',
      }).proactive.enabled,
    ).toBe(true);
  });

  it('rejects wrong proactive number types, non-integers, and out-of-range values', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [
        { scheduler: { evalIntervalSec: '2' } },
        'proactive.scheduler.evalIntervalSec',
      ],
      [
        { monitor: { sessionRecycleEvals: 1.5 } },
        'proactive.monitor.sessionRecycleEvals',
      ],
      [
        { scheduler: { maxConcurrentTasks: 0 } },
        'proactive.scheduler.maxConcurrentTasks',
      ],
      [
        { scheduler: { maxFailuresPerTask: 1_000_001 } },
        'proactive.scheduler.maxFailuresPerTask',
      ],
      [
        { scheduler: { repeat: { cooldownSec: -1 } } },
        'proactive.scheduler.repeat.cooldownSec',
      ],
      [
        { scheduler: { repeat: { maxWaitTtsSec: 0 } } },
        'proactive.scheduler.repeat.maxWaitTtsSec',
      ],
      [{ vision: { fps: 61 } }, 'proactive.vision.fps'],
      [{ vision: { windowSizeSec: 0 } }, 'proactive.vision.windowSizeSec'],
      [{ audio: { windowSizeSec: 86_401 } }, 'proactive.audio.windowSizeSec'],
      [
        { audio: { minEvalDurationSec: -0.1 } },
        'proactive.audio.minEvalDurationSec',
      ],
    ];
    for (const [proactive, expected] of cases) {
      const dataDir = await dataDirWithConfig({
        realtimeApiKey: 'k',
        proactive,
      });
      expect(() => loadConfig({ QWEN_LIVE_DATA_DIR: dataDir })).toThrow(
        expected,
      );
    }
  });

  it('rejects proactive warm-up durations longer than their media windows', async () => {
    for (const proactive of [
      { vision: { windowSizeSec: 5, minEvalDurationSec: 6 } },
      { audio: { windowSizeSec: 10, minEvalDurationSec: 11 } },
    ]) {
      const dataDir = await dataDirWithConfig({
        realtimeApiKey: 'k',
        proactive,
      });
      expect(() => loadConfig({ QWEN_LIVE_DATA_DIR: dataDir })).toThrow(
        'must not exceed',
      );
    }
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
