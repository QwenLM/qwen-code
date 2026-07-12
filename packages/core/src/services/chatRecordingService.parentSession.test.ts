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

describe('ChatRecordingService - recordParentSession', () => {
  let chatRecordingService: ChatRecordingService;
  let mockConfig: Config;

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
    vi.mocked(execSync).mockReturnValue('main\n');
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    chatRecordingService = new ChatRecordingService(mockConfig);

    // writeLine is async; mockResolvedValue lets the writeChain settle on flush.
    vi.mocked(jsonl.writeLine).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records the parent session id as a parent_session system record', async () => {
    const result = await chatRecordingService.recordParentSession('parent-abc');
    await chatRecordingService.flush();

    expect(result).toBe(true);
    expect(jsonl.writeLine).toHaveBeenCalledOnce();

    const writtenRecord = vi.mocked(jsonl.writeLine).mock
      .calls[0][1] as ChatRecord;
    expect(writtenRecord.type).toBe('system');
    expect(writtenRecord.subtype).toBe('parent_session');
    expect(writtenRecord.systemPayload).toEqual({
      parentSessionId: 'parent-abc',
    });
    expect(writtenRecord.sessionId).toBe('test-session-id');
  });

  it('includes the standard record metadata', async () => {
    await chatRecordingService.recordParentSession('parent-abc');
    await chatRecordingService.flush();

    const writtenRecord = vi.mocked(jsonl.writeLine).mock
      .calls[0][1] as ChatRecord;

    expect(writtenRecord.cwd).toBe('/test/project/root');
    expect(writtenRecord.version).toBe('1.0.0');
    expect(writtenRecord.gitBranch).toBe('main');
    expect(writtenRecord.uuid).toBeDefined();
    expect(writtenRecord.timestamp).toBeDefined();
  });

  it('is idempotent for a repeated parent session id (no second record)', async () => {
    // The lineage is immutable and written once. A bridge retry (the write
    // landed but its response was lost) calls this again with the SAME id — it
    // must report success without appending a duplicate parent_session record.
    const first = await chatRecordingService.recordParentSession('parent-abc');
    const second = await chatRecordingService.recordParentSession('parent-abc');
    await chatRecordingService.flush();

    expect(first).toBe(true);
    expect(second).toBe(true);
    // Only the first call ever wrote — the second short-circuited.
    expect(jsonl.writeLine).toHaveBeenCalledOnce();

    const parentRecords = vi
      .mocked(jsonl.writeLine)
      .mock.calls.map((c) => c[1] as ChatRecord)
      .filter((r) => r.subtype === 'parent_session');
    expect(parentRecords).toHaveLength(1);
  });

  it('maintains the parent chain when recorded after other records', async () => {
    chatRecordingService.recordUserMessage([{ text: 'hello' }]);
    await chatRecordingService.recordParentSession('parent-abc');
    await chatRecordingService.flush();

    expect(jsonl.writeLine).toHaveBeenCalledTimes(2);

    const userRecord = vi.mocked(jsonl.writeLine).mock
      .calls[0][1] as ChatRecord;
    const parentRecord = vi.mocked(jsonl.writeLine).mock
      .calls[1][1] as ChatRecord;

    expect(parentRecord.parentUuid).toBe(userRecord.uuid);
  });

  it('reports failure without retrying after the recorder degrades', async () => {
    const writeError = new Error('disk full');
    vi.mocked(jsonl.writeLine)
      .mockRejectedValueOnce(writeError)
      .mockResolvedValue(undefined);

    await expect(
      chatRecordingService.recordParentSession('parent-abc'),
    ).resolves.toBe(false);
    await expect(chatRecordingService.flush()).rejects.toBe(writeError);
    await expect(
      chatRecordingService.recordParentSession('parent-abc'),
    ).resolves.toBe(false);

    expect(jsonl.writeLine).toHaveBeenCalledOnce();
  });
});
