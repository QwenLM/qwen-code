/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import {
  ChatRecordingService,
  type ChatRecord,
} from './chatRecordingService.js';
import * as jsonl from '../utils/jsonl-utils.js';

const tryGenerateSessionTitleMock = vi.fn();

vi.mock('./sessionTitle.js', () => ({
  tryGenerateSessionTitle: (...args: unknown[]) =>
    tryGenerateSessionTitleMock(...args),
}));

/**
 * Most tests assert on the success-outcome path: this helper wraps
 * `{title, modelUsed}` in the new `{ok: true, ...}` shape so we don't have
 * to repeat it everywhere. Failure outcomes are spelled out where they
 * exercise distinct reasons.
 */
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

/**
 * Let the fire-and-forget auto-title promise kicked off by
 * `recordAssistantTurn` settle. The IIFE awaits the generation mock, which
 * adds at least one microtask hop; a single `Promise.resolve()` flush isn't
 * always enough. A setImmediate boundary after several microtask ticks
 * covers pathological cases where a mock resolves via a deeper await chain.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
  }
}

function findCustomTitleRecord(): ChatRecord | undefined {
  return vi
    .mocked(jsonl.writeLineSync)
    .mock.calls.map((c) => c[1] as ChatRecord)
    .find((r) => r.type === 'system' && r.subtype === 'custom_title');
}

describe('ChatRecordingService - auto-title trigger', () => {
  let chatRecordingService: ChatRecordingService;
  let mockConfig: Config;
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
    vi.mocked(execSync).mockReturnValue('main\n');
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    chatRecordingService = new ChatRecordingService(mockConfig);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes an auto-sourced title after the first assistant turn', async () => {
    mockOk('Fix login button');

    chatRecordingService.recordAssistantTurn({
      model: 'qwen-plus',
      message: [{ text: 'Looking at the button handler now.' }],
    });

    await flushMicrotasks();

    const titleRecord = findCustomTitleRecord();
    expect(titleRecord).toBeDefined();
    expect(titleRecord?.systemPayload).toEqual({
      customTitle: 'Fix login button',
      titleSource: 'auto',
    });
    expect(chatRecordingService.getCurrentTitleSource()).toBe('auto');
    expect(tryGenerateSessionTitleMock).toHaveBeenCalledOnce();
  });

  it('does not trigger when no fast model is configured', async () => {
    fastModelValue = undefined;

    chatRecordingService.recordAssistantTurn({
      model: 'qwen-plus',
      message: [{ text: 'hi' }],
    });
    await flushMicrotasks();

    expect(tryGenerateSessionTitleMock).not.toHaveBeenCalled();
    expect(findCustomTitleRecord()).toBeUndefined();
  });

  it('does not overwrite a manual title', async () => {
    chatRecordingService.recordCustomTitle('chose-this-myself', 'manual');
    vi.mocked(jsonl.writeLineSync).mockClear();

    chatRecordingService.recordAssistantTurn({
      model: 'qwen-plus',
      message: [{ text: 'reply' }],
    });
    await flushMicrotasks();

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
      chatRecordingService.recordAssistantTurn({
        model: 'qwen-plus',
        message: [{ text: `turn ${i}` }],
      });
      await flushMicrotasks();
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

    chatRecordingService.recordAssistantTurn({
      model: 'qwen-plus',
      message: [{ text: 'turn 1' }],
    });
    await flushMicrotasks();
    chatRecordingService.recordAssistantTurn({
      model: 'qwen-plus',
      message: [{ text: 'turn 2' }],
    });
    await flushMicrotasks();

    expect(tryGenerateSessionTitleMock).toHaveBeenCalledTimes(2);
    const titleRecord = findCustomTitleRecord();
    expect(titleRecord?.systemPayload).toEqual({
      customTitle: 'Recovered title',
      titleSource: 'auto',
    });
  });

  it('does not trigger when QWEN_DISABLE_AUTO_TITLE is set', async () => {
    const prev = process.env['QWEN_DISABLE_AUTO_TITLE'];
    process.env['QWEN_DISABLE_AUTO_TITLE'] = '1';
    try {
      chatRecordingService.recordAssistantTurn({
        model: 'qwen-plus',
        message: [{ text: 'reply' }],
      });
      await flushMicrotasks();
      expect(tryGenerateSessionTitleMock).not.toHaveBeenCalled();
      expect(findCustomTitleRecord()).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env['QWEN_DISABLE_AUTO_TITLE'];
      else process.env['QWEN_DISABLE_AUTO_TITLE'] = prev;
    }
  });

  it('still triggers when QWEN_DISABLE_AUTO_TITLE is falsy ("0")', async () => {
    mockOk('Fix login button');
    const prev = process.env['QWEN_DISABLE_AUTO_TITLE'];
    process.env['QWEN_DISABLE_AUTO_TITLE'] = '0';
    try {
      chatRecordingService.recordAssistantTurn({
        model: 'qwen-plus',
        message: [{ text: 'reply' }],
      });
      await flushMicrotasks();
      expect(tryGenerateSessionTitleMock).toHaveBeenCalledOnce();
    } finally {
      if (prev === undefined) delete process.env['QWEN_DISABLE_AUTO_TITLE'];
      else process.env['QWEN_DISABLE_AUTO_TITLE'] = prev;
    }
  });

  it('does not trigger in non-interactive mode', async () => {
    vi.mocked(mockConfig.isInteractive).mockReturnValue(false);

    chatRecordingService.recordAssistantTurn({
      model: 'qwen-plus',
      message: [{ text: 'reply' }],
    });
    await flushMicrotasks();

    expect(tryGenerateSessionTitleMock).not.toHaveBeenCalled();
    expect(findCustomTitleRecord()).toBeUndefined();
  });

  it('prevents concurrent in-flight generations across rapid turns', async () => {
    // Generation never resolves (simulates slow LLM); successive turns
    // within the same process must NOT start additional generations.
    tryGenerateSessionTitleMock.mockImplementation(() => new Promise(() => {}));

    for (let i = 0; i < 5; i++) {
      chatRecordingService.recordAssistantTurn({
        model: 'qwen-plus',
        message: [{ text: `turn ${i}` }],
      });
      await flushMicrotasks();
    }

    // Only the first turn should have launched a generation; subsequent
    // turns are blocked because autoTitleController is still set.
    expect(tryGenerateSessionTitleMock).toHaveBeenCalledTimes(1);
  });

  it('preserves titleSource across resume (auto stays auto)', async () => {
    const mockSessionService = {
      getSessionTitleInfo: vi.fn().mockReturnValue({
        title: 'Auto-generated title',
        source: 'auto',
      }),
      getSessionTitle: vi.fn().mockReturnValue('Auto-generated title'),
    };
    const resumedConfig = {
      ...mockConfig,
      getResumedSessionData: vi.fn().mockReturnValue({
        lastCompletedUuid: 'parent-uuid',
      }),
      getSessionService: vi.fn().mockReturnValue(mockSessionService),
    } as unknown as Config;

    const svc = new ChatRecordingService(resumedConfig);

    expect(svc.getCurrentCustomTitle()).toBe('Auto-generated title');
    expect(svc.getCurrentTitleSource()).toBe('auto');

    // finalize() was called by the constructor — the re-appended record
    // must carry titleSource: 'auto', not 'manual'.
    const finalizeRecord = vi
      .mocked(jsonl.writeLineSync)
      .mock.calls.map((c) => c[1] as ChatRecord)
      .find((r) => r.type === 'system' && r.subtype === 'custom_title');
    expect(finalizeRecord?.systemPayload).toEqual({
      customTitle: 'Auto-generated title',
      titleSource: 'auto',
    });
  });

  it('preserves titleSource across resume (manual stays manual)', async () => {
    // Symmetric to the auto-stays-auto case: if a user deliberately ran
    // /rename on a session, resuming must NOT rewrite that to auto or to
    // anything else. The worst regression path here would silently
    // reclassify a user-chosen name as a model guess.
    const mockSessionService = {
      getSessionTitleInfo: vi.fn().mockReturnValue({
        title: 'User chose this',
        source: 'manual',
      }),
      getSessionTitle: vi.fn().mockReturnValue('User chose this'),
    };
    const resumedConfig = {
      ...mockConfig,
      getResumedSessionData: vi.fn().mockReturnValue({
        lastCompletedUuid: 'parent-uuid',
      }),
      getSessionService: vi.fn().mockReturnValue(mockSessionService),
    } as unknown as Config;

    const svc = new ChatRecordingService(resumedConfig);

    expect(svc.getCurrentCustomTitle()).toBe('User chose this');
    expect(svc.getCurrentTitleSource()).toBe('manual');

    const finalizeRecord = vi
      .mocked(jsonl.writeLineSync)
      .mock.calls.map((c) => c[1] as ChatRecord)
      .find((r) => r.type === 'system' && r.subtype === 'custom_title');
    expect(finalizeRecord?.systemPayload).toEqual({
      customTitle: 'User chose this',
      titleSource: 'manual',
    });
  });

  it('preserves undefined titleSource on legacy resume (no rewrite)', async () => {
    const mockSessionService = {
      // Legacy record: only title surfaces, no source field.
      getSessionTitleInfo: vi.fn().mockReturnValue({
        title: 'Legacy title',
      }),
      getSessionTitle: vi.fn().mockReturnValue('Legacy title'),
    };
    const resumedConfig = {
      ...mockConfig,
      getResumedSessionData: vi.fn().mockReturnValue({
        lastCompletedUuid: 'parent-uuid',
      }),
      getSessionService: vi.fn().mockReturnValue(mockSessionService),
    } as unknown as Config;

    const svc = new ChatRecordingService(resumedConfig);

    expect(svc.getCurrentCustomTitle()).toBe('Legacy title');
    // Must stay undefined so the JSONL isn't upgraded to a misleading
    // `titleSource: 'manual'` we can't actually verify.
    expect(svc.getCurrentTitleSource()).toBeUndefined();

    const finalizeRecord = vi
      .mocked(jsonl.writeLineSync)
      .mock.calls.map((c) => c[1] as ChatRecord)
      .find((r) => r.type === 'system' && r.subtype === 'custom_title');
    // Payload must NOT contain a titleSource field when source is unknown.
    expect(finalizeRecord?.systemPayload).toEqual({
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

    chatRecordingService.recordAssistantTurn({
      model: 'qwen-plus',
      message: [{ text: 'reply' }],
    });
    await flushMicrotasks();

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

    chatRecordingService.recordAssistantTurn({
      model: 'qwen-plus',
      message: [{ text: 'turn' }],
    });
    await flushMicrotasks();

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
    let resolveLlm: (v: unknown) => void = () => {};
    tryGenerateSessionTitleMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLlm = resolve;
        }),
    );

    chatRecordingService.recordAssistantTurn({
      model: 'qwen-plus',
      message: [{ text: 'turn' }],
    });
    await flushMicrotasks();

    // User renames while the title LLM call is still pending.
    chatRecordingService.recordCustomTitle('user-chosen', 'manual');
    vi.mocked(jsonl.writeLineSync).mockClear();

    // Now the LLM call returns a title.
    resolveLlm({ ok: true, title: 'Auto Title', modelUsed: 'qwen-turbo' });
    await flushMicrotasks();

    // No auto-title record should have been written.
    expect(findCustomTitleRecord()).toBeUndefined();
    expect(chatRecordingService.getCurrentCustomTitle()).toBe('user-chosen');
    expect(chatRecordingService.getCurrentTitleSource()).toBe('manual');
  });
});
