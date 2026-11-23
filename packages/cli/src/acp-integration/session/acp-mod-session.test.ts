/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import {
  StreamEventType,
  type StreamEvent,
} from '@qwen-code/qwen-code-core/core/llm-chat.js';
import { LlmEventType } from '@qwen-code/qwen-code-core/core/turn.js';
import type { GenerateContentResponse } from '@google/genai';
import type { LoadedSettings } from '../../config/settings.js';
import type { ModAcpHost, ModTurn } from '../../services/mod-session.js';
import { AcpDisplayTranslationRows } from './acp-display-translation-rows.js';
import {
  ACP_MODS_FAILED,
  AcpModSession,
  MOD_LOG_NOTIFICATION,
  acpModRowSites,
} from './acp-mod-session.js';

const mocks = vi.hoisted(() => ({
  host: undefined as ModAcpHost | undefined,
  initialize: vi.fn<(signal: AbortSignal) => Promise<void>>(),
  flushLogs: vi.fn(),
  startTurn: vi.fn(),
  syncSession: vi.fn(),
  askRow: vi.fn(),
  close: vi.fn(),
}));

vi.mock('../../services/mod-session.js', () => ({
  ModSession: {
    create: (_config: unknown, _settings: unknown, host: ModAcpHost) => {
      mocks.host = host;
      return {
        initialize: mocks.initialize,
        flushLogs: mocks.flushLogs,
        startTurn: mocks.startTurn,
        syncSession: mocks.syncSession,
        canTranslateRow: () => false,
        askRow: mocks.askRow,
        close: mocks.close,
      };
    },
  },
}));

const settings = (mods: boolean) =>
  ({ merged: { experimental: { mods } } }) as unknown as LoadedSettings;
const config = {} as Config;

it('settles a row only when a preparing tool creates a card', async () => {
  let sessionId = 'session-1';
  const rows = new AcpDisplayTranslationRows({
    getSessionId: () => sessionId,
    getChatRecordingService: () => undefined,
  } as unknown as Config);
  const firstAttempt = {};
  rows.observe('Before the tool.', 'AssistantMessage', firstAttempt);
  rows.observeRootToolCall('read-report', true);
  const completed = await rows.authorize(
    'AssistantMessage',
    'Before the tool.',
  );
  expect(completed?.()).toBe(true);

  const nextAttempt = {};
  rows.observe('During the next attempt.', 'AssistantMessage', nextAttempt);
  rows.observeRootToolCall('read-report', true);
  await expect(
    rows.authorize('AssistantMessage', 'During the next attempt.'),
  ).resolves.toBeUndefined();

  sessionId = 'session-2';
  rows.observe('A different session.', 'AssistantMessage', nextAttempt);
  rows.observeRootToolCall('read-report', true);
  const next = await rows.authorize('AssistantMessage', 'A different session.');
  expect(next?.()).toBe(true);
});

it('keeps earlier live rows eligible in non-recorded sessions', async () => {
  const rows = new AcpDisplayTranslationRows({
    getSessionId: () => 'session',
    getChatRecordingService: () => undefined,
  } as unknown as Config);
  for (let index = 0; index < 40; index++) {
    rows.rememberCompleted('AssistantMessage', `Model reply ${index}.`);
  }
  const earliest = await rows.authorize('AssistantMessage', 'Model reply 0.');
  expect(earliest?.()).toBe(true);
});

it('drops live translation rows when a session clears without a recorder', async () => {
  let sessionId = 'before-clear';
  const rows = new AcpDisplayTranslationRows({
    getSessionId: () => sessionId,
    getChatRecordingService: () => undefined,
  } as unknown as Config);
  const attempt = {};
  rows.observe('A completed model reply.', 'AssistantMessage', attempt);
  rows.settleAttempt(attempt, true);
  const isAuthorized = await rows.authorize(
    'AssistantMessage',
    'A completed model reply.',
  );
  expect(isAuthorized?.()).toBe(true);

  sessionId = 'after-clear';
  expect(isAuthorized?.()).toBe(false);
  await expect(
    rows.authorize('AssistantMessage', 'A completed model reply.'),
  ).resolves.toBeUndefined();
});

it('keeps persisted prefixes untranslated until the full live continuation ends', async () => {
  const readActiveTranscriptChain = vi.fn().mockResolvedValue([
    {
      uuid: 'earlier',
      parentUuid: null,
      sessionId: 'session',
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'assistant',
      message: { role: 'model', parts: [{ text: 'An earlier reply.' }] },
    },
    {
      uuid: 'prefix',
      parentUuid: 'earlier',
      sessionId: 'session',
      timestamp: '2026-01-01T00:00:01.000Z',
      type: 'assistant',
      message: { role: 'model', parts: [{ text: 'First half' }] },
    },
  ]);
  const recorder = {
    getBranchGeneration: () => 1,
    getTranscriptCursor: () => ({ recordId: 'prefix' }),
    readActiveTranscriptChain,
  };
  const rows = new AcpDisplayTranslationRows({
    getSessionId: () => 'session',
    getChatRecordingService: () => recorder,
  } as unknown as Config);
  const attempt = {};
  rows.observe('First half', 'AssistantMessage', attempt);
  await expect(
    rows.authorize('AssistantMessage', 'First half'),
  ).resolves.toBeUndefined();
  expect(readActiveTranscriptChain).not.toHaveBeenCalled();

  const earlier = await rows.authorize('AssistantMessage', 'An earlier reply.');
  expect(earlier?.()).toBe(true);
  rows.observe(' and remainder.', 'AssistantMessage', attempt);
  await expect(
    rows.authorize('AssistantMessage', 'First half'),
  ).resolves.toBeUndefined();
  rows.settleAttempt(attempt, true);
  const completed = await rows.authorize(
    'AssistantMessage',
    'First half and remainder.',
  );
  expect(completed?.()).toBe(true);
});

describe('AcpModSession', () => {
  afterEach(() => {
    vi.resetAllMocks();
    mocks.host = undefined;
  });

  const create = () => {
    const client = { extNotification: vi.fn().mockResolvedValue(undefined) };
    const mods = AcpModSession.create(config, settings(true), 'acp-1', client)!;
    return { client, mods };
  };

  it('is off unless the settings turn Mods on', () => {
    const client = { extNotification: vi.fn() };
    expect(
      AcpModSession.create(config, settings(false), 'acp-1', client),
    ).toBeUndefined();
    expect(mocks.host).toBeUndefined();
    // The display translation alone starts them.
    mocks.initialize.mockResolvedValue();
    expect(
      AcpModSession.create(
        config,
        {
          merged: { general: { displayLanguage: 'en' } },
        } as unknown as LoadedSettings,
        'acp-1',
        client,
      ),
    ).toBeInstanceOf(AcpModSession);
  });

  it("sends each log line under the session's ACP id", async () => {
    mocks.initialize.mockResolvedValue();
    const { client, mods } = create();
    await mods.admit(new AbortController().signal);
    expect(mocks.flushLogs).toHaveBeenCalled();
    expect(mocks.host!.surface).toBeNull();
    // A Config id that /clear rotated still reaches the same ACP session.
    mocks.host!.log({ to: 'transcript', text: 'hi' }, 'zh-display', 'rotated');
    expect(client.extNotification).toHaveBeenCalledWith(MOD_LOG_NOTIFICATION, {
      sessionId: 'acp-1',
      plugin: 'zh-display',
      text: 'hi',
    });
  });

  it('draws on the desktop for a client that draws reply rows', () => {
    mocks.initialize.mockResolvedValue();
    expect(acpModRowSites(undefined)).toEqual([]);
    expect(acpModRowSites({ _meta: { 'qwen.modRows': 'yes' } })).toEqual([]);
    const sites = acpModRowSites({
      _meta: { 'qwen.modRows': ['Thinking', 'AssistantMessage', 'Pane'] },
    });
    // Rows this host answers, of those the client draws.
    expect(sites).toEqual(['AssistantMessage', 'Thinking']);
    expect(
      acpModRowSites({ _meta: { 'qwen.modRows': ['AssistantMessage'] } }),
    ).toEqual(['AssistantMessage']);
    const client = { extNotification: vi.fn() };
    AcpModSession.create(config, settings(true), 'acp-1', client, sites);
    expect(mocks.host!.surface).toBe('desktop');
    expect(mocks.host!.sites!()).toEqual(['AssistantMessage', 'Thinking']);
  });

  it('asks the Mods for a row once they loaded, checking what the client sent', async () => {
    let finishLoad!: () => void;
    mocks.initialize.mockReturnValue(
      new Promise<void>((resolve) => (finishLoad = resolve)),
    );
    mocks.askRow.mockResolvedValue({
      status: 'answered',
      props: { text: '译', isFirstOfReply: true },
    });
    const { mods } = create();
    const props = { text: 'Hi', isFirstOfReply: true };
    const asked = mods.askRow('AssistantMessage', props);
    await Promise.resolve();
    expect(mocks.askRow).not.toHaveBeenCalled();
    finishLoad();
    await expect(asked).resolves.toEqual({
      status: 'answered',
      props: { text: '译', isFirstOfReply: true },
    });
    expect(mocks.askRow).toHaveBeenCalledWith(
      'AssistantMessage',
      props,
      expect.any(AbortSignal),
      undefined,
    );
    await expect(mods.askRow('Pane', {})).resolves.toEqual({
      status: 'unhooked',
    });
    await mods.askRow('Thinking', { text: 'Hm' });
    expect(mocks.askRow).toHaveBeenLastCalledWith(
      'Thinking',
      { text: 'Hm' },
      expect.any(AbortSignal),
      undefined,
    );
    for (const [component, bad] of [
      [7, props],
      ['AssistantMessage', null],
      ['AssistantMessage', { text: 'Hi' }],
      ['AssistantMessage', { text: 1, isFirstOfReply: true }],
      ['AssistantMessage', { ...props, extra: true }],
      ['Thinking', props],
      ['Thinking', { text: 1 }],
    ])
      await expect(mods.askRow(component, bad)).rejects.toMatchObject({
        code: -32602,
        data: { errorKind: 'invalid_mod_row' },
      });
    expect(mocks.askRow).toHaveBeenCalledTimes(2);
  });

  it('answers unhooked once the Mods failed to load', async () => {
    mocks.initialize.mockRejectedValue(new Error('Mod broken: bad hook'));
    const { mods } = create();
    await expect(
      mods.askRow('AssistantMessage', { text: 'Hi', isFirstOfReply: true }),
    ).resolves.toEqual({ status: 'unhooked' });
    expect(mocks.askRow).not.toHaveBeenCalled();
  });

  it('refuses every prompt once the Mods failed to load', async () => {
    mocks.initialize.mockRejectedValue(new Error('Mod broken: bad hook'));
    const { mods } = create();
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(mods.admit(new AbortController().signal)).rejects.toThrow(
        `${ACP_MODS_FAILED} Error: Mod broken: bad hook`,
      );
    expect(mocks.flushLogs).toHaveBeenCalled();
  });

  it.each([false, true])(
    'cancels a waiting prompt without interrupting the load (failure=%s)',
    async (failure) => {
      let finishLoad!: () => void;
      mocks.initialize.mockReturnValue(
        new Promise<void>((resolve, reject) => {
          finishLoad = () => {
            if (failure) reject(new Error('Mod broken: bad hook'));
            else resolve();
          };
        }),
      );
      const { mods } = create();
      const first = new AbortController();
      const waiting = mods.admit(first.signal);
      first.abort();
      await expect(waiting).resolves.toBeUndefined();

      const next = mods.admit(new AbortController().signal);
      finishLoad();
      if (failure) await expect(next).rejects.toThrow(ACP_MODS_FAILED);
      else await expect(next).resolves.toBeUndefined();
      expect(mocks.initialize).toHaveBeenCalledTimes(1);
    },
  );

  it('reads a legacy stream as the model events a turn hears', async () => {
    mocks.initialize.mockResolvedValue();
    const turn = {
      id: 'turn-1',
      saw: vi.fn(),
      complete: vi.fn().mockResolvedValue(undefined),
    } satisfies ModTurn;
    mocks.startTurn.mockReturnValue(turn);
    const { mods } = create();
    const abort = () => true;
    const signal = new AbortController().signal;
    const running = mods.startTurn('Fix it', signal, abort, 'p-1')!;
    expect(mocks.startTurn).toHaveBeenCalledWith(
      'Fix it',
      signal,
      abort,
      'p-1',
    );
    const chunk = (parts: Array<{ text: string; thought?: boolean }>) =>
      ({
        type: StreamEventType.CHUNK,
        value: {
          candidates: [{ content: { parts } }],
        } as unknown as GenerateContentResponse,
      }) satisfies StreamEvent;
    running.sawStream(
      chunk([{ text: 'Thinking', thought: true }, { text: 'Hel' }]),
    );
    running.sawStream({ type: StreamEventType.RETRY, isContinuation: true });
    running.sawStream(chunk([{ text: 'lo' }]));
    running.sawStream({ type: StreamEventType.RETRY });
    running.sawStream({
      type: StreamEventType.MODEL_FALLBACK,
      info: {} as never,
    });
    const usage = { promptTokenCount: 3 };
    running.finishStream(usage);
    expect(turn.saw.mock.calls.map(([event]) => event)).toEqual([
      { type: LlmEventType.Content, value: 'Hel' },
      { type: LlmEventType.Retry, isContinuation: true },
      { type: LlmEventType.Content, value: 'lo' },
      { type: LlmEventType.Retry },
      { type: LlmEventType.Retry },
      {
        type: LlmEventType.Finished,
        value: { reason: undefined, usageMetadata: usage },
      },
    ]);
  });

  it.each([
    [false, false, undefined],
    [false, true, 'error'],
    [true, true, 'aborted'],
  ] as const)(
    'ends a turn aborted %s and failed %s as %s',
    async (aborted, failed, ending) => {
      const turn = {
        id: 'turn-1',
        saw: vi.fn(),
        complete: vi.fn().mockResolvedValue(undefined),
      };
      mocks.initialize.mockResolvedValue();
      mocks.startTurn.mockReturnValue(turn);
      const { mods } = create();
      const running = mods.startTurn(
        '',
        new AbortController().signal,
        () => false,
        'p-1',
      )!;
      if (failed) running.fail();
      await running.complete(aborted);
      expect(turn.complete).toHaveBeenCalledWith(ending);
    },
  );
});
