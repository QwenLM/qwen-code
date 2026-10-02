/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import {
  ChatRecordingService,
  type ChatRecord,
} from './chatRecordingService.js';
import * as jsonl from '../utils/jsonl-utils.js';
import type { SessionWriterLease } from './session-writer-lease.js';

const tryGenerateSessionTitleMock = vi.fn();

vi.mock('./sessionTitle.js', () => ({
  tryGenerateSessionTitle: (...args: unknown[]) =>
    tryGenerateSessionTitleMock(...args),
}));

/** Success outcome `{ok: true, title, modelUsed}`, which most tests assert
 * on. Failure outcomes are spelled out where they exercise distinct reasons. */
function mockOk(title: string, modelUsed = 'qwen-turbo'): void {
  tryGenerateSessionTitleMock.mockResolvedValue({
    ok: true,
    title,
    modelUsed,
  });
}

vi.mock('node:path');
vi.mock('node:child_process');
vi.mock('node:crypto', () => ({
  randomUUID: vi.fn(),
  createHash: vi.fn(() => ({
    update: vi.fn(() => ({
      digest: vi.fn(() => 'mocked-hash'),
    })),
  })),
}));
vi.mock('../utils/jsonl-utils.js');

/** Let the fire-and-forget auto-title promise kicked off by
 * `recordAssistantTurn` settle. Awaiting the generation mock adds at least
 * one microtask hop, so one `Promise.resolve()` isn't always enough; the
 * setImmediate boundary covers mocks resolving via a deeper await chain. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
  }
}

/** Every record appended through the (mocked) jsonl writer. */
function writtenRecords(): ChatRecord[] {
  return vi.mocked(jsonl.writeLine).mock.calls.map((c) => c[1] as ChatRecord);
}

const isTitleRecord = (r: ChatRecord) =>
  r.type === 'system' && r.subtype === 'custom_title';

function findCustomTitleRecord(): ChatRecord | undefined {
  return writtenRecords().find(isTitleRecord);
}

function resumedSessionWithTitle(
  title: string,
  source?: 'manual' | 'auto',
): NonNullable<ReturnType<Config['getResumedSessionData']>> {
  return {
    conversation: {
      sessionId: 'test-session-id',
      projectHash: 'test-project',
      startTime: '2026-01-01T00:00:00.000Z',
      lastUpdated: '2026-01-01T00:00:00.000Z',
      messages: [
        {
          uuid: 'title-uuid',
          parentUuid: null,
          sessionId: 'test-session-id',
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'system',
          subtype: 'custom_title',
          cwd: '/test/project/root',
          version: '1.0.0',
          systemPayload: {
            customTitle: title,
            ...(source ? { titleSource: source } : {}),
          },
        },
      ],
    },
    filePath: '/test/session.jsonl',
    lastCompletedUuid: 'parent-uuid',
  };
}

describe('ChatRecordingService - auto-title trigger', () => {
  let chatRecordingService: ChatRecordingService;
  let mockConfig: Config;
  let mockLease: SessionWriterLease;
  let fastModelValue: string | undefined;
  let uuidCounter = 0;

  beforeEach(() => {
    uuidCounter = 0;
    fastModelValue = 'qwen-turbo';
    tryGenerateSessionTitleMock.mockReset();

    mockConfig = {
      getSessionId: vi.fn().mockReturnValue('test-session-id'),
      getProjectRoot: vi.fn().mockReturnValue('/test/project/root'),
      getCliVersion: vi.fn().mockReturnValue('1.0.0'),
      storage: {
        getProjectTempDir: vi
          .fn()
          .mockReturnValue('/test/project/root/.qwen/tmp/hash'),
        getProjectDir: vi
          .fn()
          .mockReturnValue('/test/project/root/.qwen/projects/test-project'),
      },
      getModel: vi.fn().mockReturnValue('qwen-plus'),
      getFastModel: vi.fn(() => fastModelValue),
      isInteractive: vi.fn().mockReturnValue(true),
      getExperimentalZedIntegration: vi.fn().mockReturnValue(false),
      getDebugMode: vi.fn().mockReturnValue(false),
      getToolRegistry: vi.fn().mockReturnValue({
        getTool: vi.fn().mockReturnValue({
          displayName: 'Test Tool',
          description: 'A test tool',
          isOutputMarkdown: false,
        }),
      }),
      getResumedSessionData: vi.fn().mockReturnValue(undefined),
      // Default SessionService for the cross-process re-read: returns no
      // title, i.e. "nothing else has landed on disk" — tests that need
      // a specific on-disk state override this mock.
      getSessionService: vi.fn().mockReturnValue({
        getSessionTitleInfo: vi.fn().mockReturnValue({}),
        getSessionTitle: vi.fn().mockReturnValue(undefined),
      }),
    } as unknown as Config;

    vi.mocked(randomUUID).mockImplementation(
      () =>
        `00000000-0000-0000-0000-00000000000${++uuidCounter}` as `${string}-${string}-${string}-${string}-${string}`,
    );
    vi.mocked(path.join).mockImplementation((...args) => args.join('/'));
    vi.mocked(path.dirname).mockImplementation((p) => {
      const parts = p.split('/');
      parts.pop();
      return parts.join('/');
    });
    vi.mocked(execFileSync).mockReturnValue('main\n');
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    // writeLine is async; mockResolvedValue lets the writeChain settle when
    // tests await flushMicrotasks() / chatRecordingService.flush().
    vi.mocked(jsonl.writeLine).mockResolvedValue(undefined);
    mockLease = {
      sessionId: 'test-session-id',
      ownerId: 'test-owner-id',
      appendJsonLine: vi.fn((record: unknown) =>
        jsonl.writeLine('/test/session.jsonl', record),
      ),
      assertOwnedAndUnchanged: vi.fn().mockResolvedValue(undefined),
      release: vi.fn().mockResolvedValue(undefined),
    } as unknown as SessionWriterLease;
    chatRecordingService = activateRecording(
      new ChatRecordingService(mockConfig, undefined, true),
      mockConfig,
    );
  });

  function activateRecording(
    service: ChatRecordingService,
    config: Config,
  ): ChatRecordingService {
    const resumed = config.getResumedSessionData();
    service.activate(
      mockLease,
      resumed && !resumed.conversation
        ? {
            conversation: { messages: [] },
            lastCompletedUuid: resumed.lastCompletedUuid,
          }
        : resumed,
    );
    return service;
  }

  /** Records an assistant turn replying `text`, then lets auto-title settle. */
  const assistantTurn = (text = 'reply', service = chatRecordingService) => {
    service.recordAssistantTurn({ model: 'qwen-plus', message: [{ text }] });
    return flushMicrotasks();
  };

  /** A service resumed from `data`, with `overrides` on the config. */
  function resume(data: unknown, overrides: Record<string, unknown> = {}) {
    const resumedConfig = {
      ...mockConfig,
      getResumedSessionData: vi.fn().mockReturnValue(data),
      ...overrides,
    } as unknown as Config;
    const service = activateRecording(
      new ChatRecordingService(resumedConfig, undefined, true),
      resumedConfig,
    );
    return { resumedConfig, service };
  }

  /** Resumes a session whose persisted title is `title` (+ `source`). */
  function resumeWithTitle(title: string, source?: 'manual' | 'auto') {
    const sessionService = {
      getSessionTitleInfo: vi
        .fn()
        .mockReturnValue({ title, ...(source ? { source } : {}) }),
      getSessionTitle: vi.fn().mockReturnValue(title),
    };
    return resume(resumedSessionWithTitle(title, source), {
      getSessionService: vi.fn().mockReturnValue(sessionService),
    }).service;
  }

  /** Resume writes no title record by itself; the next user message
   * re-anchors the title. Returns the re-anchored record's payload. */
  async function reanchoredPayload(svc: ChatRecordingService) {
    await svc.flush();
    expect(findCustomTitleRecord()).toBeUndefined();
    svc.recordUserMessage([{ text: 'resume work' }]);
    await svc.flush();
    return findCustomTitleRecord()?.systemPayload;
  }

  /** The next generation stays pending until the returned resolver runs. */
  function holdNextGeneration(): (outcome: unknown) => void {
    let resolveLlm: (value: unknown) => void = () => {};
    tryGenerateSessionTitleMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLlm = resolve;
        }),
    );
    return (outcome) => resolveLlm(outcome);
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('writes an auto-sourced title after the first assistant turn', async () => {
    mockOk('Fix login button');

    await assistantTurn('Looking at the button handler now.');

    const titleRecord = findCustomTitleRecord();
    expect(titleRecord).toBeDefined();
    // The assistant-turn record carries the branch from the (mocked)
    // `getGitBranch` -> `execFileSync` call; pin it so a stale mock target
    // (`execSync`) surfaces as `undefined` instead of silently passing.
    const assistantRecord = writtenRecords().find(
      (r) => r.type === 'assistant',
    );
    expect(assistantRecord?.gitBranch).toBe('main');
    expect(titleRecord?.systemPayload).toEqual({
      customTitle: 'Fix login button',
      titleSource: 'auto',
    });
    expect(chatRecordingService.getCurrentTitleSource()).toBe('auto');
    expect(tryGenerateSessionTitleMock).toHaveBeenCalledOnce();
  });

  it('does not trigger when no fast model is configured', async () => {
    fastModelValue = undefined;

    await assistantTurn('hi');

    expect(tryGenerateSessionTitleMock).not.toHaveBeenCalled();
    expect(findCustomTitleRecord()).toBeUndefined();
  });

  it('does not overwrite a manual title', async () => {
    await chatRecordingService.recordCustomTitle('chose-this-myself', 'manual');
    vi.mocked(jsonl.writeLine).mockClear();

    await assistantTurn();

    expect(tryGenerateSessionTitleMock).not.toHaveBeenCalled();
    expect(findCustomTitleRecord()).toBeUndefined();
    expect(chatRecordingService.getCurrentCustomTitle()).toBe(
      'chose-this-myself',
    );
    expect(chatRecordingService.getCurrentTitleSource()).toBe('manual');
  });

  it('retries on empty_result up to the cap, then stops', async () => {
    tryGenerateSessionTitleMock.mockResolvedValue({
      ok: false,
      reason: 'empty_result',
    });

    for (let i = 0; i < 5; i++) {
      await assistantTurn(`turn ${i}`);
    }

    // Cap is 3.
    expect(tryGenerateSessionTitleMock).toHaveBeenCalledTimes(3);
    expect(findCustomTitleRecord()).toBeUndefined();
  });

  it('retries across turns after a transient thrown error (up to cap)', async () => {
    // A transient error (network blip, 429, bad UTF-16 in one turn's history)
    // must NOT permanently disable auto-titling — the next turn should retry.
    // The attempt cap bounds total waste.
    tryGenerateSessionTitleMock
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({
        ok: true,
        title: 'Recovered title',
        modelUsed: 'qwen-turbo',
      });

    await assistantTurn('turn 1');
    await assistantTurn('turn 2');

    expect(tryGenerateSessionTitleMock).toHaveBeenCalledTimes(2);
    const titleRecord = findCustomTitleRecord();
    expect(titleRecord?.systemPayload).toEqual({
      customTitle: 'Recovered title',
      titleSource: 'auto',
    });
  });

  it('does not trigger when QWEN_DISABLE_AUTO_TITLE is set', async () => {
    vi.stubEnv('QWEN_DISABLE_AUTO_TITLE', '1');
    await assistantTurn();
    expect(tryGenerateSessionTitleMock).not.toHaveBeenCalled();
    expect(findCustomTitleRecord()).toBeUndefined();
  });

  it('still triggers when QWEN_DISABLE_AUTO_TITLE is falsy ("0")', async () => {
    mockOk('Fix login button');
    vi.stubEnv('QWEN_DISABLE_AUTO_TITLE', '0');
    await assistantTurn();
    expect(tryGenerateSessionTitleMock).toHaveBeenCalledOnce();
  });

  it('does not trigger in non-interactive mode', async () => {
    vi.mocked(mockConfig.isInteractive).mockReturnValue(false);

    await assistantTurn();

    expect(tryGenerateSessionTitleMock).not.toHaveBeenCalled();
    expect(findCustomTitleRecord()).toBeUndefined();
  });

  it('triggers in ACP (daemon) mode even though isInteractive is false', async () => {
    vi.mocked(mockConfig.isInteractive).mockReturnValue(false);
    vi.mocked(mockConfig.getExperimentalZedIntegration).mockReturnValue(true);
    mockOk('Fix login button');

    await assistantTurn();

    expect(tryGenerateSessionTitleMock).toHaveBeenCalled();
    const record = findCustomTitleRecord();
    expect(record).toBeDefined();
    expect((record!.systemPayload as { customTitle: string }).customTitle).toBe(
      'Fix login button',
    );
  });

  it('passes the latest user display projection to auto-title generation', async () => {
    mockOk('Answer greeting');
    chatRecordingService.recordUserMessage(
      [{ text: 'hidden channel instructions' }],
      undefined,
      { displayText: '你好', hookContext: '' },
    );

    await assistantTurn();

    expect(tryGenerateSessionTitleMock).toHaveBeenCalledWith(
      mockConfig,
      expect.any(AbortSignal),
      ['你好'],
    );
  });

  it('restores channel display projections for automatic rename and retries', async () => {
    const messages: ChatRecord[] = [
      {
        uuid: 'user-1',
        parentUuid: null,
        sessionId: 'test-session-id',
        timestamp: '2026-01-01T00:00:00.000Z',
        type: 'user',
        provenance: 'real_user',
        cwd: '/test/project/root',
        version: '1.0.0',
        message: { role: 'user', parts: [{ text: 'hidden first prompt' }] },
        systemPayload: { displayText: '你好', hookContext: '' },
      },
      {
        uuid: 'assistant-1',
        parentUuid: 'user-1',
        sessionId: 'test-session-id',
        timestamp: '2026-01-01T00:00:01.000Z',
        type: 'assistant',
        provenance: 'assistant_output',
        cwd: '/test/project/root',
        version: '1.0.0',
        message: { role: 'model', parts: [{ text: 'First reply' }] },
      },
      {
        uuid: 'user-2',
        parentUuid: 'assistant-1',
        sessionId: 'test-session-id',
        timestamp: '2026-01-01T00:00:02.000Z',
        type: 'user',
        provenance: 'real_user',
        cwd: '/test/project/root',
        version: '1.0.0',
        message: { role: 'user', parts: [{ text: 'hidden second prompt' }] },
        systemPayload: { displayText: '再见', hookContext: '' },
      },
    ];
    const { resumedConfig, service } = resume({
      conversation: { messages },
      lastCompletedUuid: 'user-2',
    });

    expect(service.getUserDisplayTextsForTitle()).toEqual(['你好', '再见']);

    mockOk('Answer greetings');
    await assistantTurn('reply', service);

    expect(tryGenerateSessionTitleMock).toHaveBeenCalledWith(
      resumedConfig,
      expect.any(AbortSignal),
      ['你好', '再见'],
    );
  });

  it('retains only display projections relevant to recent title history', () => {
    for (let index = 0; index < 21; index++) {
      chatRecordingService.recordUserMessage(
        [{ text: `hidden ${index}` }],
        undefined,
        {
          displayText: `visible ${index}`,
          hookContext: '',
        },
      );
    }

    expect(chatRecordingService.getUserDisplayTextsForTitle()).toHaveLength(20);
    expect(chatRecordingService.getUserDisplayTextsForTitle()[0]).toBe(
      'visible 1',
    );
  });

  it('does not trigger in headless CLI mode (non-interactive, non-ACP)', async () => {
    vi.mocked(mockConfig.isInteractive).mockReturnValue(false);
    vi.mocked(mockConfig.getExperimentalZedIntegration).mockReturnValue(false);

    await assistantTurn();

    expect(tryGenerateSessionTitleMock).not.toHaveBeenCalled();
  });

  it('prevents concurrent in-flight generations across rapid turns', async () => {
    // Generation never resolves (simulates slow LLM); successive turns
    // within the same process must NOT start additional generations.
    tryGenerateSessionTitleMock.mockImplementation(() => new Promise(() => {}));

    for (let i = 0; i < 5; i++) {
      await assistantTurn(`turn ${i}`);
    }

    // Only the first turn should have launched a generation; subsequent
    // turns are blocked because autoTitleController is still set.
    expect(tryGenerateSessionTitleMock).toHaveBeenCalledTimes(1);
  });

  it('preserves titleSource across resume (auto stays auto)', async () => {
    const svc = resumeWithTitle('Auto-generated title', 'auto');

    expect(svc.getCurrentCustomTitle()).toBe('Auto-generated title');
    expect(svc.getCurrentTitleSource()).toBe('auto');
    expect(await reanchoredPayload(svc)).toEqual({
      customTitle: 'Auto-generated title',
      titleSource: 'auto',
    });
  });

  it('preserves titleSource across resume (manual stays manual)', async () => {
    // Symmetric to auto-stays-auto: resuming a session the user deliberately
    // /rename'd must NOT rewrite its source. The worst regression here would
    // silently reclassify a user-chosen name as a model guess.
    const svc = resumeWithTitle('User chose this', 'manual');

    expect(svc.getCurrentCustomTitle()).toBe('User chose this');
    expect(svc.getCurrentTitleSource()).toBe('manual');
    expect(await reanchoredPayload(svc)).toEqual({
      customTitle: 'User chose this',
      titleSource: 'manual',
    });
  });

  it('preserves undefined titleSource on legacy resume (no rewrite)', async () => {
    // Legacy record: only the title surfaces, no source field.
    const svc = resumeWithTitle('Legacy title');

    expect(svc.getCurrentCustomTitle()).toBe('Legacy title');
    // Must stay undefined so the JSONL isn't upgraded to a misleading
    // `titleSource: 'manual'` we can't actually verify.
    expect(svc.getCurrentTitleSource()).toBeUndefined();
    // Payload must NOT contain a titleSource field when source is unknown.
    expect(await reanchoredPayload(svc)).toEqual({
      customTitle: 'Legacy title',
    });
  });

  it('does not overwrite a manual title written by another process', async () => {
    // Cross-process race: this CRS instance doesn't know about a /rename
    // issued from another CLI tab, but the persisted JSONL does. Before
    // writing an auto title we must re-read and bail if the file already
    // has source='manual'.
    mockOk('Auto guess');
    const otherProcessManual = vi.fn().mockReturnValue({
      title: 'User chose this',
      source: 'manual',
    });
    vi.mocked(mockConfig.getSessionService).mockReturnValue({
      getSessionTitleInfo: otherProcessManual,
      getSessionTitle: vi.fn(),
    } as never);

    await assistantTurn();

    expect(tryGenerateSessionTitleMock).toHaveBeenCalledOnce();
    expect(otherProcessManual).toHaveBeenCalled();
    // No auto record was appended.
    expect(findCustomTitleRecord()).toBeUndefined();
    // In-memory state synced to the on-disk manual title so later turns
    // also skip the trigger.
    expect(chatRecordingService.getCurrentCustomTitle()).toBe(
      'User chose this',
    );
    expect(chatRecordingService.getCurrentTitleSource()).toBe('manual');
  });

  it('aborts the in-flight generation on finalize and suppresses the title write', async () => {
    // Model rejects when the signal fires — mirrors what a real provider's
    // fetch layer does when the AbortController aborts. Previously this
    // test only checked that `signal.aborted` flipped; but what we actually
    // care about is that NO custom_title record gets written after abort.
    let capturedSignal: AbortSignal | undefined;
    tryGenerateSessionTitleMock.mockImplementation(
      (_config: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          capturedSignal = signal;
          signal.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    );

    await assistantTurn('turn');

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(false);
    // No title yet — generation is still pending.
    expect(findCustomTitleRecord()).toBeUndefined();

    chatRecordingService.finalize();
    expect(capturedSignal?.aborted).toBe(true);

    await flushMicrotasks();
    // The aborted generation must NOT result in a custom_title record —
    // even though the mock technically "completed" (via rejection).
    expect(findCustomTitleRecord()).toBeUndefined();
    expect(chatRecordingService.getCurrentCustomTitle()).toBeUndefined();
  });

  it('respects a late /rename that lands while the LLM call is in flight', async () => {
    // Simulate slow LLM: resolves after a manual rename lands.
    const resolveLlm = holdNextGeneration();

    await assistantTurn('turn');

    // User renames while the title LLM call is still pending.
    await chatRecordingService.recordCustomTitle('user-chosen', 'manual');
    vi.mocked(jsonl.writeLine).mockClear();

    // Now the LLM call returns a title.
    resolveLlm({ ok: true, title: 'Auto Title', modelUsed: 'qwen-turbo' });
    await flushMicrotasks();

    // No auto-title record should have been written.
    expect(findCustomTitleRecord()).toBeUndefined();
    expect(chatRecordingService.getCurrentCustomTitle()).toBe('user-chosen');
    expect(chatRecordingService.getCurrentTitleSource()).toBe('manual');
  });

  it('lets an explicit auto rename cancel and outrank background auto-title', async () => {
    const resolveLlm = holdNextGeneration();
    await assistantTurn('turn');

    await expect(
      chatRecordingService.recordCustomTitle('User Auto Title', 'auto'),
    ).resolves.toBe(true);
    resolveLlm({ ok: true, title: 'Background Title', modelUsed: 'fast' });
    await flushMicrotasks();

    const titleRecords = writtenRecords().filter(isTitleRecord);
    expect(titleRecords).toHaveLength(1);
    expect(titleRecords[0]?.systemPayload).toMatchObject({
      customTitle: 'User Auto Title',
      titleSource: 'auto',
    });
    expect(chatRecordingService.getCurrentCustomTitle()).toBe(
      'User Auto Title',
    );
  });

  it('does not start background auto-title while an explicit title is pending', async () => {
    let resolveTitleWrite!: () => void;
    vi.mocked(jsonl.writeLine).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveTitleWrite = resolve;
      }),
    );
    const explicit = chatRecordingService.recordCustomTitle(
      'Pending Explicit',
      'auto',
    );
    await vi.waitFor(() => expect(jsonl.writeLine).toHaveBeenCalledOnce());

    chatRecordingService.recordAssistantTurn({
      model: 'qwen-plus',
      message: [{ text: 'turn while rename is pending' }],
    });
    expect(tryGenerateSessionTitleMock).not.toHaveBeenCalled();

    resolveTitleWrite();
    await expect(explicit).resolves.toBe(true);
    await chatRecordingService.flush();
  });

  it('does not retry background auto-title after its write degrades the recorder', async () => {
    mockOk('Failed Durable Title');
    vi.mocked(jsonl.writeLine)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('disk full'));

    await assistantTurn('first turn');
    await expect(chatRecordingService.flush()).rejects.toThrow('disk full');
    expect(tryGenerateSessionTitleMock).toHaveBeenCalledOnce();
    expect(chatRecordingService.getCurrentCustomTitle()).toBeUndefined();

    await assistantTurn('second turn');

    expect(tryGenerateSessionTitleMock).toHaveBeenCalledOnce();
    expect(jsonl.writeLine).toHaveBeenCalledTimes(2);
  });
});
