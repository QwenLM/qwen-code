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
  type CustomTitleRecordPayload,
} from './chatRecordingService.js';
import * as jsonl from '../utils/jsonl-utils.js';
import type { SessionWriterLease } from './session-writer-lease.js';

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

describe('ChatRecordingService - recordCustomTitle', () => {
  let chatRecordingService: ChatRecordingService;
  let mockConfig: Config;
  let mockLease: SessionWriterLease;

  let uuidCounter = 0;

  beforeEach(() => {
    uuidCounter = 0;

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
      getFastModel: vi.fn().mockReturnValue(undefined),
      isInteractive: vi.fn().mockReturnValue(false),
      getDebugMode: vi.fn().mockReturnValue(false),
      getToolRegistry: vi.fn().mockReturnValue({
        getTool: vi.fn().mockReturnValue({
          displayName: 'Test Tool',
          description: 'A test tool',
          isOutputMarkdown: false,
        }),
      }),
      getResumedSessionData: vi.fn().mockReturnValue(undefined),
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

    // writeLine is async; mockResolvedValue lets the writeChain settle on flush.
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
      new ChatRecordingService(mockConfig),
    );
  });

  function activateRecording(
    service: ChatRecordingService,
  ): ChatRecordingService {
    service.activate(mockLease);
    return service;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const written = () =>
    vi.mocked(jsonl.writeLine).mock.calls.map(([, r]) => r as ChatRecord);
  const isTitle = (r: ChatRecord) =>
    r.type === 'system' && r.subtype === 'custom_title';
  const titleWrites = () => written().filter(isTitle);
  const writtenTitles = () =>
    titleWrites().map(
      (r) =>
        (r.systemPayload as CustomTitleRecordPayload | undefined)?.customTitle,
    );
  // Holds the next writeLine open until the returned resolver is called.
  function deferWrite(): () => void {
    let resolve!: () => void;
    vi.mocked(jsonl.writeLine).mockReturnValueOnce(
      new Promise<void>((r) => {
        resolve = r;
      }),
    );
    return resolve;
  }
  const firstWriteStarted = () =>
    vi.waitFor(() => expect(jsonl.writeLine).toHaveBeenCalledOnce());
  // Durable titles, then later work, flushed; writeLine history cleared.
  async function titlesThenWork(...titles: string[]) {
    for (const t of titles) await chatRecordingService.recordCustomTitle(t);
    chatRecordingService.recordUserMessage([{ text: 'new work' }]);
    await chatRecordingService.flush();
    vi.mocked(jsonl.writeLine).mockClear();
  }
  async function titleThenClear(title: string) {
    await chatRecordingService.recordCustomTitle(title);
    vi.mocked(jsonl.writeLine).mockClear();
  }

  it('does not report success or update observers before the title lands', async () => {
    const resolveWrite = deferWrite();
    const callback = vi.fn();
    chatRecordingService.setTitleRecordedCallback(callback);
    let settled = false;

    const result = chatRecordingService
      .recordCustomTitle('durable-title')
      .finally(() => {
        settled = true;
      });
    await firstWriteStarted();

    expect(settled).toBe(false);
    expect(chatRecordingService.getCurrentCustomTitle()).toBeUndefined();
    expect(callback).not.toHaveBeenCalled();

    vi.mocked(mockConfig.getSessionId).mockReturnValue('new-session-id');
    resolveWrite();
    await expect(result).resolves.toBe(true);
    expect(chatRecordingService.getCurrentCustomTitle()).toBe('durable-title');
    expect(callback).toHaveBeenCalledWith(
      'durable-title',
      'manual',
      'test-session-id',
    );
  });

  it('returns false after an async failure and permanently rejects later titles', async () => {
    const failureListener = vi.fn();
    const service = activateRecording(
      new ChatRecordingService(mockConfig, failureListener),
    );
    const callback = vi.fn();
    service.setTitleRecordedCallback(callback);
    const writeError = new Error('disk full');
    vi.mocked(jsonl.writeLine).mockRejectedValueOnce(writeError);

    await expect(service.recordCustomTitle('lost-title')).resolves.toBe(false);
    await expect(service.flush()).rejects.toBe(writeError);
    expect(service.getCurrentCustomTitle()).toBeUndefined();
    expect(callback).not.toHaveBeenCalled();
    expect(failureListener).toHaveBeenCalledOnce();

    await expect(service.recordCustomTitle('later-title')).resolves.toBe(false);
    expect(jsonl.writeLine).toHaveBeenCalledTimes(1);
    expect(failureListener).toHaveBeenCalledOnce();
  });

  it('keeps the last durable title when a later rename fails', async () => {
    await expect(
      chatRecordingService.recordCustomTitle('durable-title'),
    ).resolves.toBe(true);
    vi.mocked(jsonl.writeLine).mockRejectedValueOnce(new Error('disk full'));

    await expect(
      chatRecordingService.recordCustomTitle('failed-title'),
    ).resolves.toBe(false);

    expect(chatRecordingService.getCurrentCustomTitle()).toBe('durable-title');
    expect(chatRecordingService.getCurrentTitleSource()).toBe('manual');
  });

  it('serializes concurrent explicit titles and commits them in call order', async () => {
    const resolveFirst = deferWrite();
    const callback = vi.fn();
    chatRecordingService.setTitleRecordedCallback(callback);

    const first = chatRecordingService.recordCustomTitle('first-title');
    const second = chatRecordingService.recordCustomTitle('second-title');
    await firstWriteStarted();
    expect(chatRecordingService.getCurrentCustomTitle()).toBeUndefined();

    resolveFirst();
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);

    expect(callback.mock.calls).toEqual([
      ['first-title', 'manual', 'test-session-id'],
      ['second-title', 'manual', 'test-session-id'],
    ]);
    expect(chatRecordingService.getCurrentCustomTitle()).toBe('second-title');
  });

  it('does not let finalize re-append a stale title behind a pending rename', async () => {
    await titlesThenWork('old-title');

    const resolveRename = deferWrite();
    const rename = chatRecordingService.recordCustomTitle('new-title');
    await firstWriteStarted();

    chatRecordingService.finalize();
    resolveRename();
    await expect(rename).resolves.toBe(true);
    await chatRecordingService.flush();
    expect(writtenTitles()).toEqual(['new-title']);
  });

  it('re-anchors the new title when queued descendants cross the threshold', async () => {
    await titleThenClear('old-title');

    const resolveRename = deferWrite();
    const rename = chatRecordingService.recordCustomTitle('new-title');
    await firstWriteStarted();
    chatRecordingService.recordUserMessage([{ text: 'x'.repeat(40_000) }]);

    resolveRename();
    await expect(rename).resolves.toBe(true);
    await chatRecordingService.flush();
    expect(writtenTitles()).toEqual(['new-title', 'new-title']);
  });

  it('persists parent lineage once and links it to the preceding record', async () => {
    chatRecordingService.recordUserMessage([{ text: 'hello' }]);
    await expect(
      chatRecordingService.recordParentSession('parent'),
    ).resolves.toBe(true);
    await expect(
      chatRecordingService.recordParentSession('parent'),
    ).resolves.toBe(true);
    await chatRecordingService.flush();
    const records = written();
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({
      type: 'system',
      subtype: 'parent_session',
      parentUuid: records[0]!.uuid,
      systemPayload: { parentSessionId: 'parent' },
    });
  });

  it('does not report or retry a failed parent lineage write', async () => {
    const failure = new Error('disk full');
    vi.mocked(jsonl.writeLine).mockRejectedValueOnce(failure);
    await expect(
      chatRecordingService.recordParentSession('parent'),
    ).resolves.toBe(false);
    await expect(chatRecordingService.flush()).rejects.toBe(failure);
    await expect(
      chatRecordingService.recordParentSession('parent'),
    ).resolves.toBe(false);
    expect(jsonl.writeLine).toHaveBeenCalledOnce();
  });
});
