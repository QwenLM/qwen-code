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
        askRow: mocks.askRow,
        close: mocks.close,
      };
    },
  },
}));

const settings = (mods: boolean) =>
  ({ merged: { experimental: { mods } } }) as unknown as LoadedSettings;
const config = {} as Config;

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
    expect(sites).toEqual(['AssistantMessage']);
    const client = { extNotification: vi.fn() };
    AcpModSession.create(config, settings(true), 'acp-1', client, sites);
    expect(mocks.host!.surface).toBe('desktop');
    expect(mocks.host!.sites!()).toEqual(['AssistantMessage']);
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
    );
    await expect(mods.askRow('Pane', {})).resolves.toEqual({
      status: 'unhooked',
    });
    for (const [component, bad] of [
      [7, props],
      ['AssistantMessage', null],
      ['AssistantMessage', { text: 'Hi' }],
      ['AssistantMessage', { text: 1, isFirstOfReply: true }],
      ['AssistantMessage', { ...props, extra: true }],
    ])
      await expect(mods.askRow(component, bad)).rejects.toMatchObject({
        code: -32602,
        data: { errorKind: 'invalid_mod_row' },
      });
    expect(mocks.askRow).toHaveBeenCalledOnce();
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
