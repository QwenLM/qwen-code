/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Content, Part } from '@google/genai';
import { makeFakeConfig } from '@qwen-code/qwen-code-core/test-utils/config.js';
import { LlmClient } from '@qwen-code/qwen-code-core/core/client.js';
import { LlmChat } from '@qwen-code/qwen-code-core/core/llm-chat.js';
import {
  markApiHistoryPrompt,
  getApiHistoryPromptId,
} from '@qwen-code/qwen-code-core/utils/api-history-metadata.js';
import {
  createRestoreToolResponseBinding,
  completeRestoreToolResponse,
} from './restore-tool-response.js';

describe('restored tool response binding with real client and chat', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'restore-binding-'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  function setup(history?: Content[]) {
    const config = makeFakeConfig({
      targetDir: directory,
      cwd: directory,
      usageStatisticsEnabled: false,
      disableAllHooks: true,
    });
    const client = new LlmClient(config);
    const chat = new LlmChat(config);
    const getChat = vi.spyOn(client, 'getChat').mockReturnValue(chat);
    vi.spyOn(config, 'getLlmClient').mockReturnValue(client);
    const sends = vi.spyOn(client, 'sendMessageStream');
    const args = {
      file_path: path.join(directory, 'owned.txt'),
      old_string: 'A',
      new_string: 'B',
    };
    const tail: Content = {
      role: 'model',
      parts: [{ functionCall: { id: 'original-edit', name: 'edit', args } }],
    };
    markApiHistoryPrompt(tail, 'session########0');
    client.setHistory(
      history ?? [{ role: 'user', parts: [{ text: 'original input' }] }, tail],
    );
    return { config, client, chat, getChat, sends, args, tail };
  }

  const response = (error = false): Part[] => [
    {
      functionResponse: {
        id: 'new-execution',
        name: 'edit',
        response: error
          ? { error: 'REAL_REPLAY_ERROR' }
          : { output: 'NEW_ACTUAL_REPLAY_SUCCESS_NOT_INITIAL' },
      },
    },
    { inlineData: { mimeType: 'image/png', data: 'TkVXX01FRElB' } },
    { text: 'actual replay attachment ordering' },
  ];

  it.each([false, true])(
    'pairs actual replay parts without changing media or fabricating success: error=%s',
    async (error) => {
      const f = setup();
      const binding = createRestoreToolResponseBinding(
        f.config,
        'edit',
        f.args,
      );
      expect(binding).toBeDefined();
      const actual = response(error);
      const original = structuredClone(actual);
      const result = await completeRestoreToolResponse(
        binding!,
        { callId: 'new-execution', name: 'edit', args: f.args },
        actual,
        () => true,
      );
      expect(result).toBe(true);
      const history = f.client.getHistoryShallow();
      expect(history).toHaveLength(3);
      expect(history[2].parts).toEqual([
        {
          ...original[0],
          functionResponse: {
            ...original[0].functionResponse!,
            id: 'original-edit',
            name: 'edit',
          },
        },
        ...original.slice(1),
      ]);
      expect(actual).toEqual(original);
      expect(getApiHistoryPromptId(history[2])).toBe('session########0');
      expect(
        f.client.getHistoryFunctionResponseIds().has('original-edit'),
      ).toBe(true);
      expect(
        f.client.getHistoryFunctionResponseIds().has('new-execution'),
      ).toBe(false);
      expect(f.sends).not.toHaveBeenCalled();
    },
  );

  it('publishes exactly once under concurrent duplicate completion', async () => {
    const f = setup();
    const binding = createRestoreToolResponseBinding(f.config, 'edit', f.args)!;
    expect(
      await Promise.all([
        completeRestoreToolResponse(
          binding,
          { callId: 'new-execution', name: 'edit', args: f.args },
          response(),
          () => true,
        ),
        completeRestoreToolResponse(
          binding,
          { callId: 'new-execution', name: 'edit', args: f.args },
          response(),
          () => true,
        ),
      ]),
    ).toEqual([true, false]);
    expect(f.client.getHistoryShallow()).toHaveLength(3);
    expect(f.sends).not.toHaveBeenCalled();
  });

  it.each([
    'wrong execution',
    'wrong name',
    'two results',
    'wrong execution args',
  ] as const)('rejects malformed actual completion: %s', async (mode) => {
    const f = setup();
    const binding = createRestoreToolResponseBinding(f.config, 'edit', f.args)!;
    const parts = response();
    if (mode === 'wrong execution')
      parts[0].functionResponse!.id = 'other-execution';
    if (mode === 'wrong name') parts[0].functionResponse!.name = 'read_file';
    if (mode === 'two results') parts.push(structuredClone(parts[0]));
    const execution = {
      callId: 'new-execution',
      name: 'edit',
      args:
        mode === 'wrong execution args'
          ? { ...f.args, new_string: 'WRONG_TARGET_CONTENT' }
          : f.args,
    };
    expect(
      await completeRestoreToolResponse(binding, execution, parts, () => true),
    ).toBe(false);
    expect(f.client.getHistoryShallow()).toHaveLength(2);
  });

  it.each([
    'owner',
    'session',
    'client',
    'chat',
    'history reset',
    'append',
    'tail mutation',
  ] as const)(
    'does not publish into a successor after %s changes',
    async (mode) => {
      const f = setup();
      const binding = createRestoreToolResponseBinding(
        f.config,
        'edit',
        f.args,
      )!;
      if (mode === 'session')
        vi.spyOn(f.config, 'getSessionId').mockReturnValue('successor-session');
      if (mode === 'client')
        vi.mocked(f.config.getLlmClient).mockReturnValue(
          new LlmClient(f.config),
        );
      if (mode === 'chat') f.getChat.mockReturnValue(new LlmChat(f.config));
      if (mode === 'history reset') {
        const revision = f.chat.getHistoryReplacementRevision();
        f.client.setHistory(f.client.getHistory());
        expect(f.chat.getHistoryReplacementRevision()).toBeGreaterThan(
          revision,
        );
      }
      if (mode === 'append')
        await f.client.addHistory({
          role: 'user',
          parts: [{ text: 'healthy next turn' }],
        });
      if (mode === 'tail mutation')
        f.chat.peekLastHistoryEntry()!.parts![0].functionCall!.args = {
          file_path: 'other',
        };
      const before = f.chat.getHistory();
      expect(
        await completeRestoreToolResponse(
          binding,
          { callId: 'new-execution', name: 'edit', args: f.args },
          response(),
          () => mode !== 'owner',
        ),
      ).toBe(false);
      expect(f.chat.getHistory()).toEqual(before);
      expect(f.sends).not.toHaveBeenCalled();
    },
  );

  it.each(['mismatch', 'ambiguous', 'paired'] as const)(
    'fails closed for an unresolved identity that is %s',
    (mode) => {
      const f = setup();
      if (mode === 'mismatch')
        f.tail.parts![0].functionCall!.args = {
          file_path: 'not the checkpoint',
        };
      if (mode === 'ambiguous')
        f.tail.parts!.push({
          functionCall: { id: 'second-edit', name: 'edit', args: f.args },
        });
      if (mode === 'paired')
        f.client.setHistory([
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'original-edit',
                  name: 'edit',
                  response: { output: 'OLD_SUCCESS' },
                },
              },
            ],
          },
          f.tail,
        ]);
      expect(() =>
        createRestoreToolResponseBinding(f.config, 'edit', f.args),
      ).toThrow(/pending|paired|ambiguous/);
    },
  );

  it('keeps legacy nonpending history unbound', () => {
    const f = setup([
      { role: 'user', parts: [{ text: 'no pending model tool' }] },
    ]);
    expect(
      createRestoreToolResponseBinding(f.config, 'edit', f.args),
    ).toBeUndefined();
    expect(f.sends).not.toHaveBeenCalled();
  });
});
