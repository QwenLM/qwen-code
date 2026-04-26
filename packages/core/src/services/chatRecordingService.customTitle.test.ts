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

describe('ChatRecordingService - recordCustomTitle', () => {
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

  it('should record a custom title as a system record', async () => {
    chatRecordingService.recordCustomTitle('my-feature');
    await chatRecordingService.flush();

    expect(jsonl.writeLine).toHaveBeenCalledOnce();

    const writtenRecord = vi.mocked(jsonl.writeLine).mock
      .calls[0][1] as ChatRecord;
    expect(writtenRecord.type).toBe('system');
    expect(writtenRecord.subtype).toBe('custom_title');
    expect(writtenRecord.systemPayload).toEqual({
      customTitle: 'my-feature',
      titleSource: 'manual',
    });
    expect(writtenRecord.sessionId).toBe('test-session-id');
  });

  it('should maintain parent chain when recording title after other records', async () => {
    chatRecordingService.recordUserMessage([{ text: 'hello' }]);
    chatRecordingService.recordCustomTitle('my-feature');
    await chatRecordingService.flush();

    expect(jsonl.writeLine).toHaveBeenCalledTimes(2);

    const userRecord = vi.mocked(jsonl.writeLine).mock
      .calls[0][1] as ChatRecord;
    const titleRecord = vi.mocked(jsonl.writeLine).mock
      .calls[1][1] as ChatRecord;

    expect(titleRecord.parentUuid).toBe(userRecord.uuid);
  });

  it('should include correct metadata in the record', async () => {
    chatRecordingService.recordCustomTitle('test-title');
    await chatRecordingService.flush();

    const writtenRecord = vi.mocked(jsonl.writeLine).mock
      .calls[0][1] as ChatRecord;

    expect(writtenRecord.cwd).toBe('/test/project/root');
    expect(writtenRecord.version).toBe('1.0.0');
    expect(writtenRecord.gitBranch).toBe('main');
    expect(writtenRecord.uuid).toBeDefined();
    expect(writtenRecord.timestamp).toBeDefined();
  });

  describe('finalize', () => {
    it('should re-append cached custom title to EOF', async () => {
      chatRecordingService.recordCustomTitle('my-feature');
      await chatRecordingService.flush();
      vi.mocked(jsonl.writeLine).mockClear();

      chatRecordingService.finalize();
      await chatRecordingService.flush();

      expect(jsonl.writeLine).toHaveBeenCalledOnce();
      const record = vi.mocked(jsonl.writeLine).mock.calls[0][1] as ChatRecord;
      expect(record.type).toBe('system');
      expect(record.subtype).toBe('custom_title');
      expect(record.systemPayload).toEqual({
        customTitle: 'my-feature',
        titleSource: 'manual',
      });
    });

    it('should not write anything when no custom title was set', async () => {
      chatRecordingService.finalize();
      await chatRecordingService.flush();

      expect(jsonl.writeLine).not.toHaveBeenCalled();
    });

    it('should re-append the latest title after multiple renames', async () => {
      chatRecordingService.recordCustomTitle('first-name');
      chatRecordingService.recordCustomTitle('second-name');
      await chatRecordingService.flush();
      vi.mocked(jsonl.writeLine).mockClear();

      chatRecordingService.finalize();
      await chatRecordingService.flush();

      expect(jsonl.writeLine).toHaveBeenCalledOnce();
      const record = vi.mocked(jsonl.writeLine).mock.calls[0][1] as ChatRecord;
      expect(record.systemPayload).toEqual({
        customTitle: 'second-name',
        titleSource: 'manual',
      });
    });
  });
});
