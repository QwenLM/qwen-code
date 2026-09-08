/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prompt: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('prompts', () => ({ default: mocks.prompt }));
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: mocks.existsSync,
    readFileSync: mocks.readFileSync,
    mkdirSync: mocks.mkdirSync,
    writeFileSync: mocks.writeFileSync,
    renameSync: mocks.renameSync,
  };
});
vi.mock('./agent-detector.js', () => ({
  detectAgents: () => [
    {
      label: 'Qwen Code',
      name: 'qwen',
      command: '/usr/local/bin/qwen',
      args: ['--acp'],
      version: '1.0.0',
    },
  ],
}));
vi.mock('./host/live-host-installer.js', () => ({
  LiveHostInstaller: class {
    refresh(): Promise<{ state: 'installed'; version: string }> {
      return Promise.resolve({ state: 'installed', version: '0.0.6' });
    }
  },
}));

import { runInit } from './init.js';
import { liveText } from './i18n/messages.js';

const originalApiKey = process.env['DASHSCOPE_API_KEY'];

beforeEach(() => {
  mocks.prompt.mockReset();
  mocks.mkdirSync.mockReset();
  mocks.writeFileSync.mockReset();
  mocks.renameSync.mockReset();
  mocks.existsSync.mockReset().mockReturnValue(false);
  mocks.readFileSync.mockReset();
  process.env['DASHSCOPE_API_KEY'] = 'sk-test';
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalApiKey === undefined) delete process.env['DASHSCOPE_API_KEY'];
  else process.env['DASHSCOPE_API_KEY'] = originalApiKey;
});

describe('runInit', () => {
  it.each([false, true])(
    'asks for a consolidation model only when Memory is enabled (%s)',
    async (enabled) => {
      mocks.prompt.mockImplementation(
        async (question: { message?: string }) => {
          switch (question.message) {
            case liveText('en', 'language.choose'):
              return { value: true };
            case 'Which agent should be the default backend?':
              return { value: 'qwen' };
            case 'Use DASHSCOPE_API_KEY from the environment?':
              return { value: true };
            case 'DashScope Realtime API name:':
              return { value: 'qwen3.5-omni-plus-realtime' };
            case 'Enable Memory for cross-call recall?':
              return { value: enabled };
            case 'DashScope Memory consolidation model:':
              return { value: 'custom-memory-model' };
            case 'Default working directory for coding sessions:':
              return { value: '/tmp/memory-init' };
            default:
              throw new Error(`Unexpected prompt: ${question.message}`);
          }
        },
      );
      await runInit();
      const questions = mocks.prompt.mock.calls.map(
        ([question]) => question as Record<string, unknown>,
      );
      expect(
        questions.find(
          (question) =>
            question['message'] === 'Enable Memory for cross-call recall?',
        ),
      ).toMatchObject({ initial: true });
      const modelQuestion = questions.find(
        (question) =>
          question['message'] === 'DashScope Memory consolidation model:',
      );
      if (enabled)
        expect(modelQuestion).toMatchObject({ initial: 'qwen3.7-plus' });
      else expect(modelQuestion).toBeUndefined();
      const saved = JSON.parse(String(mocks.writeFileSync.mock.calls[0]?.[1]));
      expect(saved.memory.enabled).toBe(enabled);
      expect(saved.memory.updater.model).toBe(
        enabled ? 'custom-memory-model' : 'qwen3.7-plus',
      );
      expect(saved.memory.observer).not.toHaveProperty('model');
    },
  );

  it('writes the selected API name without prompting for visual settings', async () => {
    mocks.prompt.mockImplementation(
      async (question: { message?: string }): Promise<{ value: unknown }> => {
        switch (question.message) {
          case liveText('en', 'language.choose'):
            return { value: true };
          case 'Which agent should be the default backend?':
            return { value: 'qwen' };
          case 'Use DASHSCOPE_API_KEY from the environment?':
            return { value: true };
          case 'DashScope Realtime API name:':
            return { value: 'qwen3.5-omni-plus-realtime' };
          case 'Enable Memory for cross-call recall?':
            return { value: true };
          case 'DashScope Memory consolidation model:':
            return { value: 'qwen3.7-plus' };
          case 'Default working directory for coding sessions:':
            return { value: '/tmp/qwen-live-project' };
          default:
            throw new Error(`Unexpected prompt: ${question.message}`);
        }
      },
    );

    await runInit();

    const modelQuestion = mocks.prompt.mock.calls
      .map(([question]) => question as Record<string, unknown>)
      .find(
        (question) => question['message'] === 'DashScope Realtime API name:',
      );
    expect(modelQuestion).toMatchObject({
      type: 'text',
      initial: 'qwen3.5-omni-plus-realtime',
    });

    const serialized = mocks.writeFileSync.mock.calls[0]?.[1];
    expect(typeof serialized).toBe('string');
    expect(JSON.parse(String(serialized))).toMatchObject({
      language: 'en',
      realtimeApiKey: 'sk-test',
      realtimeModel: 'qwen3.5-omni-plus-realtime',
      memory: {
        enabled: true,
        updater: { model: 'qwen3.7-plus' },
        observer: { enabled: false },
      },
      visualInput: {
        source: 'screen',
        mode: 'on-demand',
        fps: 1,
        cameraResolution: { width: 1280, height: 720 },
        cameraSnapshotResolution: 'native',
        liveResolution: { width: 1280, height: 720 },
        snapshotResolution: 'native',
      },
      proactive: {
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
      },
      defaultCwd: '/tmp/qwen-live-project',
    });
  });

  it.each(['en', 'zh-CN'] as const)(
    'localizes every fixed wizard prompt and saves %s after choosing language first',
    async (language) => {
      mocks.prompt.mockImplementation(
        async (question: { type: string; message: string }) => {
          if (question.message === liveText('en', 'language.choose')) {
            expect(console.log).not.toHaveBeenCalled();
            return { value: language === 'en' };
          }
          const choices = new Map<string, string | boolean>([
            [liveText(language, 'init.defaultAgent'), 'qwen'],
            [
              liveText(language, 'init.useEnv', { name: 'DASHSCOPE_API_KEY' }),
              true,
            ],
            [liveText(language, 'init.apiName'), 'fixture-realtime'],
            [liveText(language, 'init.memoryEnabled'), true],
            [liveText(language, 'init.memoryModel'), 'fixture-memory'],
            [liveText(language, 'init.cwd'), '/tmp/live-language'],
          ]);
          expect(choices.has(question.message)).toBe(true);
          return { value: choices.get(question.message) };
        },
      );
      await runInit();
      expect(mocks.prompt.mock.calls[0]?.[0]).toMatchObject({
        type: 'toggle',
        inactive: '简体中文',
        active: 'English',
        initial: false,
      });
      const questions = mocks.prompt.mock.calls.map(
        ([question]) => question as Record<string, unknown>,
      );
      for (const question of questions.filter(
        (entry) => entry['type'] === 'confirm',
      )) {
        expect(question['yes']).toBe(liveText(language, 'init.yes'));
        expect(question['no']).toBe(liveText(language, 'init.no'));
      }
      expect(
        questions.find((entry) => entry['type'] === 'select')?.['hint'],
      ).toBe(liveText(language, 'init.selectHint'));
      expect(
        JSON.parse(String(mocks.writeFileSync.mock.calls[0]?.[1])).language,
      ).toBe(language);
      expect(console.log).toHaveBeenCalledWith(
        `\n  ${liveText(language, 'init.run')}\n`,
      );
    },
  );

  it('uses the saved language for the initial choice and leaves existing config intact when overwrite is declined', async () => {
    mocks.existsSync.mockReturnValue(true);
    mocks.readFileSync.mockReturnValue(
      '{"language":"en","realtimeApiKey":"private"}',
    );
    mocks.prompt
      .mockResolvedValueOnce({ value: false })
      .mockResolvedValueOnce({ value: false });
    await runInit();
    expect(mocks.prompt.mock.calls[0]?.[0]).toMatchObject({
      type: 'toggle',
      initial: true,
    });
    expect(mocks.prompt.mock.calls[1]?.[0]).toMatchObject({
      message: liveText('zh-CN', 'init.overwrite'),
    });
    expect(mocks.writeFileSync).not.toHaveBeenCalled();
    expect(mocks.renameSync).not.toHaveBeenCalled();
  });

  it.each([0, 1, 2, 3, 4, 5, 6])(
    'does not write config if prompt %s is cancelled',
    async (cancelAt) => {
      const answers = [
        true,
        'qwen',
        true,
        'fixture-model',
        true,
        'fixture-memory',
        '/tmp/live-language',
      ];
      let index = 0;
      mocks.prompt.mockImplementation(async () => {
        const current = index++;
        return current === cancelAt ? {} : { value: answers[current] };
      });
      await runInit();
      expect(mocks.writeFileSync).not.toHaveBeenCalled();
      expect(index).toBe(cancelAt + 1);
    },
  );
});
