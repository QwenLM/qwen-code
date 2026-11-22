/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileHistoryService } from '@qwen-code/qwen-code-core/services/fileHistoryService.js';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
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
  selectRestoreCheckpointCall,
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
        f.tail.parts![0].functionCall!.name = 'read_file';
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
  describe('checkpoint selection and durable async completion', () => {
    function pendingCheckpoint(args: Record<string, unknown>) {
      const user: Content = {
        role: 'user',
        parts: [{ text: 'CHECKPOINT_USER' }],
      };
      markApiHistoryPrompt(user, 'real-user-prompt');
      const tail: Content = {
        role: 'model',
        parts: [{ functionCall: { id: 'original-edit', name: 'edit', args } }],
      };
      return { user, tail, history: [user, tail] };
    }

    it('selects the real user prompt fallback without a fabricated assistant stamp', () => {
      const f = setup();
      const saved = pendingCheckpoint(f.args);
      expect(getApiHistoryPromptId(saved.tail)).toBeUndefined();
      expect(selectRestoreCheckpointCall(saved.history, 'edit')).toEqual({
        callId: 'original-edit',
        name: 'edit',
        args: f.args,
        promptId: 'real-user-prompt',
      });
    });

    it('recovers the unique legacy logical call when a hook changed execution arguments', () => {
      const f = setup();
      const saved = pendingCheckpoint(f.args);
      f.client.setHistory(saved.history);
      expect(
        createRestoreToolResponseBinding(f.config, 'edit', {
          ...f.args,
          new_string: 'DIFFERENT',
        }),
      ).toMatchObject({
        callId: 'original-edit',
        name: 'edit',
        args: f.args,
        promptId: 'real-user-prompt',
      });
    });

    it('requires a saved call ID when modified arguments cannot distinguish sibling edits', () => {
      const f = setup();
      const saved = pendingCheckpoint(f.args);
      saved.tail.parts!.push({
        functionCall: {
          id: 'sibling-edit',
          name: 'edit',
          args: { ...f.args, new_string: 'SIBLING' },
        },
      });
      f.client.setHistory(saved.history);
      // The authorized rewrite exactly matches the sibling's original args.
      const executionArgs = { ...f.args, new_string: 'SIBLING' };
      expect(() =>
        createRestoreToolResponseBinding(f.config, 'edit', executionArgs),
      ).toThrow(/one pending/);
      expect(
        selectRestoreCheckpointCall(saved.history, 'edit', 'original-edit')
          ?.args,
      ).toEqual(f.args);
      expect(() =>
        selectRestoreCheckpointCall(saved.history, 'edit', 'absent'),
      ).toThrow(/one pending/);
    });

    it('rejects a duplicated original pending identity in the actual saved API parts', () => {
      const f = setup();
      const saved = pendingCheckpoint(f.args);
      saved.tail.parts!.push({
        functionCall: { id: 'original-edit', name: 'edit', args: f.args },
      });
      expect(() =>
        selectRestoreCheckpointCall(saved.history, 'edit'),
      ).toThrow();
    });

    it('does not select an already-paired terminal API history as a pending checkpoint', () => {
      const f = setup();
      const saved = pendingCheckpoint(f.args);
      const paired: Content[] = [
        ...saved.history,
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'original-edit',
                name: 'edit',
                response: { output: 'ALREADY_PAIRED' },
              },
            },
          ],
        },
      ];
      expect(selectRestoreCheckpointCall(paired, 'edit')).toBeUndefined();
    });

    function durableSetup() {
      const f = setup();
      const restore = vi.fn().mockResolvedValue(true);
      const recorder = { restoreToolBranch: restore } as unknown as NonNullable<
        ReturnType<typeof f.config.getChatRecordingService>
      >;
      const lookup = vi
        .spyOn(f.config, 'getChatRecordingService')
        .mockReturnValue(recorder);
      const binding = createRestoreToolResponseBinding(
        f.config,
        'edit',
        f.args,
        {
          recorder,
          truncatedCount: 1,
        },
      );
      if (!binding) throw new Error('Missing durable binding');
      const addHistory = vi.spyOn(f.client, 'addHistory');
      const execution = { callId: 'new-execution', name: 'edit', args: f.args };
      const completion = {
        toolCallResult: {
          callId: 'new-execution',
          status: 'success' as const,
          resultDisplay: 'ACTUAL_NEW_DISPLAY',
        },
      };
      return {
        ...f,
        restore,
        recorder,
        lookup,
        binding,
        addHistory,
        execution,
        completion,
      };
    }

    it('publishes approved replay arguments against the unchanged logical anchor only for the bound execution', async () => {
      const f = durableSetup();
      f.binding.executionCallId = f.execution.callId;
      const actualExecution = {
        ...f.execution,
        args: {
          ...f.args,
          new_string: 'USER_APPROVED',
          modified_by_user: true,
        },
      };
      const foreignParts = response();
      foreignParts[0].functionResponse!.id = 'foreign-execution';
      expect(
        await completeRestoreToolResponse(
          f.binding,
          { ...actualExecution, callId: 'foreign-execution' },
          foreignParts,
          () => true,
          f.completion,
        ),
      ).toBe(false);
      expect(f.restore).not.toHaveBeenCalled();
      expect(
        await completeRestoreToolResponse(
          f.binding,
          actualExecution,
          response(),
          () => true,
          f.completion,
        ),
      ).toBe(true);
      expect(f.restore).toHaveBeenCalledWith(
        expect.objectContaining({
          args: f.args,
          execution: actualExecution,
          originalCallId: 'original-edit',
        }),
      );
      expect(
        f.client.getHistoryFunctionResponseIds().has('original-edit'),
      ).toBe(true);
      expect(f.tail.parts![0].functionCall!.args).toEqual(f.args);
    });

    it('admits only one completion before an awaited strict recorder write settles', async () => {
      const f = durableSetup();
      let release!: (result: boolean) => void;
      f.restore.mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            release = resolve;
          }),
      );
      const actual = response();
      const first = completeRestoreToolResponse(
        f.binding,
        f.execution,
        actual,
        () => true,
        f.completion,
      );
      const second = completeRestoreToolResponse(
        f.binding,
        f.execution,
        actual,
        () => true,
        f.completion,
      );
      try {
        expect(f.restore).toHaveBeenCalledTimes(1);
        expect(f.restore).toHaveBeenCalledWith(
          expect.objectContaining({
            execution: f.execution,
            responseParts: actual,
            toolCallResult: f.completion.toolCallResult,
            originalCallId: 'original-edit',
          }),
        );
        expect(f.addHistory).not.toHaveBeenCalled();
        expect(await second).toBe(false);
      } finally {
        release(true);
      }
      expect(await first).toBe(true);
      expect(f.addHistory).toHaveBeenCalledTimes(1);
      expect(
        f.client.getHistoryFunctionResponseIds().has('original-edit'),
      ).toBe(true);
      expect(
        f.client.getHistoryFunctionResponseIds().has('new-execution'),
      ).toBe(false);
      expect(f.sends).not.toHaveBeenCalled();
    });

    it('refuses a captured recorder replacement before completion enters strict recording', async () => {
      const f = durableSetup();
      f.lookup.mockReturnValue({
        restoreToolBranch: vi.fn(),
      } as unknown as typeof f.recorder);
      expect(
        await completeRestoreToolResponse(
          f.binding,
          f.execution,
          response(),
          () => true,
          f.completion,
        ),
      ).toBe(false);
      expect(f.restore).not.toHaveBeenCalled();
      expect(f.addHistory).not.toHaveBeenCalled();
      expect(f.sends).not.toHaveBeenCalled();
    });

    it('does not append API response when recorder ownership changes across its async boundary', async () => {
      const f = durableSetup();
      let release!: (result: boolean) => void;
      f.restore.mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            release = resolve;
          }),
      );
      const pending = completeRestoreToolResponse(
        f.binding,
        f.execution,
        response(),
        () => true,
        f.completion,
      );
      f.lookup.mockReturnValue({
        restoreToolBranch: vi.fn(),
      } as unknown as typeof f.recorder);
      release(true);
      expect(await pending).toBe(false);
      expect(f.addHistory).not.toHaveBeenCalled();
      expect(f.sends).not.toHaveBeenCalled();
    });

    it('propagates strict persistence failure without adding an in-memory response', async () => {
      const f = durableSetup();
      const failure = new Error('ACTUAL_STRICT_WRITE_FAILED');
      f.restore.mockRejectedValue(failure);
      await expect(
        completeRestoreToolResponse(
          f.binding,
          f.execution,
          response(),
          () => true,
          f.completion,
        ),
      ).rejects.toBe(failure);
      expect(f.addHistory).not.toHaveBeenCalled();
      expect(
        f.client.getHistoryFunctionResponseIds().has('original-edit'),
      ).toBe(false);
      expect(f.sends).not.toHaveBeenCalled();
    });
  });
  it('records real file-history snapshots added and changed after binding creation, with complete backup dates and metadata', async () => {
    const f = setup();
    const history = new FileHistoryService(
      f.config.getSessionId(),
      true,
      directory,
    );
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(
      path.join(directory, 'owned-home'),
    );
    vi.spyOn(f.config, 'getFileHistoryService').mockReturnValue(history);
    const restore = vi.fn().mockResolvedValue(true);
    const recorder = { restoreToolBranch: restore } as unknown as NonNullable<
      ReturnType<typeof f.config.getChatRecordingService>
    >;
    vi.spyOn(f.config, 'getChatRecordingService').mockReturnValue(recorder);
    await history.makeSnapshot('real-initial-prompt');
    const atBinding = structuredClone(history.getSnapshots());
    const binding = createRestoreToolResponseBinding(f.config, 'edit', f.args, {
      recorder,
      truncatedCount: 1,
    });
    if (!binding) throw new Error('Missing binding');
    writeFileSync(f.args.file_path, 'REAL_BACKUP_A');
    await history.trackEdit(f.args.file_path);
    writeFileSync(f.args.file_path, 'REAL_BACKUP_B');
    await history.makeSnapshot('real-later-prompt');
    const latest = structuredClone(history.getSnapshots());
    expect(latest).toHaveLength(2);
    expect(atBinding).toHaveLength(1);
    expect(Object.keys(atBinding[0].trackedFileBackups)).toHaveLength(0);
    const key = path.relative(directory, f.args.file_path);
    const first = latest[0].trackedFileBackups[key];
    const second = latest[1].trackedFileBackups[key];
    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    for (const snapshot of latest)
      expect(snapshot.timestamp).toBeInstanceOf(Date);
    for (const backup of [first, second]) {
      expect(backup.backupTime).toBeInstanceOf(Date);
      expect(typeof backup.backupFileName).toBe('string');
    }
    expect(first.backupFileName).not.toBe(second.backupFileName);
    const backupRoot = path.join(
      directory,
      'owned-home',
      'file-history',
      f.config.getSessionId(),
    );
    expect(
      readFileSync(path.join(backupRoot, first.backupFileName!), 'utf8'),
    ).toBe('REAL_BACKUP_A');
    expect(
      readFileSync(path.join(backupRoot, second.backupFileName!), 'utf8'),
    ).toBe('REAL_BACKUP_B');
    expect(
      await completeRestoreToolResponse(
        binding,
        { callId: 'new-execution', name: 'edit', args: f.args },
        response(),
        () => true,
        {
          toolCallResult: {
            callId: 'new-execution',
            status: 'success',
            resultDisplay: 'REAL_NEW_COMPLETION',
          },
        },
      ),
    ).toBe(true);
    expect(restore).toHaveBeenCalledTimes(1);
    const captured = restore.mock.calls[0][0].survivingFileHistorySnapshots;
    expect(captured).toEqual(latest);
    expect(captured).not.toEqual(atBinding);
    expect(captured).not.toBe(history.getSnapshots());
    expect(captured[0]).not.toBe(history.getSnapshots()[0]);
    expect(captured[0].timestamp).toBeInstanceOf(Date);
    expect(captured[1].trackedFileBackups[key]).toEqual(second);
    expect(captured[1].trackedFileBackups[key].backupTime).toBeInstanceOf(Date);
  });
});
