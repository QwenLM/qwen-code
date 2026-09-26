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
    const resumed = mockConfig.getResumedSessionData();
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
  async function recordBulk(
    n: number,
    text: string,
    svc = chatRecordingService,
  ) {
    for (let i = 0; i < n; i++) svc.recordUserMessage([{ text }]);
    await svc.flush();
  }
  async function finalizeAndFlush(svc = chatRecordingService) {
    svc.finalize();
    await svc.flush();
  }
  function resumedService(title: string, source?: 'manual' | 'auto') {
    vi.mocked(mockConfig.getResumedSessionData).mockReturnValue({
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
      lastCompletedUuid: null,
    });
    const getSessionTitleInfo = vi.fn().mockReturnValue({ title, source });
    (
      mockConfig as unknown as {
        getSessionService: () => {
          getSessionTitleInfo: typeof getSessionTitleInfo;
        };
      }
    ).getSessionService = () => ({ getSessionTitleInfo });
    return activateRecording(new ChatRecordingService(mockConfig));
  }

  it('should record a custom title as a system record', async () => {
    await chatRecordingService.recordCustomTitle('my-feature');

    expect(jsonl.writeLine).toHaveBeenCalledOnce();

    const writtenRecord = written()[0];
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
    await chatRecordingService.recordCustomTitle('my-feature');

    expect(jsonl.writeLine).toHaveBeenCalledTimes(2);
    const [userRecord, titleRecord] = written();
    expect(titleRecord.parentUuid).toBe(userRecord.uuid);
  });

  it('should include correct metadata in the record', async () => {
    await chatRecordingService.recordCustomTitle('test-title');

    const writtenRecord = written()[0];
    expect(writtenRecord.cwd).toBe('/test/project/root');
    expect(writtenRecord.version).toBe('1.0.0');
    expect(writtenRecord.gitBranch).toBe('main');
    expect(writtenRecord.uuid).toBeDefined();
    expect(writtenRecord.timestamp).toBeDefined();
  });

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

  it('allows legacy retry after a synchronous conversation-file failure', async () => {
    const service = new ChatRecordingService(mockConfig, undefined, false);
    vi.mocked(fs.writeFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });

    await expect(service.recordCustomTitle('retry-title')).resolves.toBe(false);
    await expect(service.flush()).resolves.toBeUndefined();
    expect(jsonl.writeLine).not.toHaveBeenCalled();

    await expect(service.recordCustomTitle('retry-title')).resolves.toBe(true);
    expect(jsonl.writeLine).toHaveBeenCalledOnce();
    expect(service.getCurrentCustomTitle()).toBe('retry-title');
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

  it('keeps durable success when the title observer throws', async () => {
    chatRecordingService.setTitleRecordedCallback(() => {
      throw new Error('observer failed');
    });

    await expect(
      chatRecordingService.recordCustomTitle('durable-title'),
    ).resolves.toBe(true);
    expect(chatRecordingService.getCurrentCustomTitle()).toBe('durable-title');
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

  it('tracks records queued behind a pending title for later finalization', async () => {
    const resolveTitle = deferWrite();
    const title = chatRecordingService.recordCustomTitle('durable-title');
    await firstWriteStarted();
    chatRecordingService.recordUserMessage([{ text: 'queued descendant' }]);

    resolveTitle();
    await expect(title).resolves.toBe(true);
    await chatRecordingService.flush();
    vi.mocked(jsonl.writeLine).mockClear();

    await finalizeAndFlush();
    expect(written()[0]).toMatchObject({
      type: 'system',
      subtype: 'custom_title',
      systemPayload: { customTitle: 'durable-title' },
    });
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

  describe('finalize', () => {
    it('should re-append cached custom title to EOF after new content', async () => {
      await titlesThenWork('my-feature');

      await finalizeAndFlush();

      expect(jsonl.writeLine).toHaveBeenCalledOnce();
      const record = written()[0];
      expect(record.type).toBe('system');
      expect(record.subtype).toBe('custom_title');
      expect(record.systemPayload).toEqual({
        customTitle: 'my-feature',
        titleSource: 'manual',
      });
    });

    it('should not write anything when the title is already the latest record', async () => {
      await titleThenClear('my-feature');
      await finalizeAndFlush();
      expect(jsonl.writeLine).not.toHaveBeenCalled();
    });

    it('should not write anything when no custom title was set', async () => {
      await finalizeAndFlush();
      expect(jsonl.writeLine).not.toHaveBeenCalled();
    });

    it('should not re-append a resumed title without new content', async () => {
      await finalizeAndFlush(resumedService('resumed-title', 'manual'));
      expect(jsonl.writeLine).not.toHaveBeenCalled();
    });

    it('should re-append the latest title after multiple renames', async () => {
      await titlesThenWork('first-name', 'second-name');

      await finalizeAndFlush();

      expect(jsonl.writeLine).toHaveBeenCalledOnce();
      expect(written()[0].systemPayload).toEqual({
        customTitle: 'second-name',
        titleSource: 'manual',
      });
    });
  });

  describe('title re-anchor invariant', () => {
    it('re-anchors the title once enough non-title bytes accumulate', async () => {
      // Once non-title bytes cross the 32KB threshold, the next record must
      // provoke a fresh custom_title append at EOF so the title stays in the
      // 64KB tail window the picker scans, even without a finalize.
      await titleThenClear('long-running-task');
      // 20 × ~2KB (+ ~200B envelope each) is well over 32KB on the wire.
      await recordBulk(20, 'x'.repeat(2000));

      const titleAppendsAfterClear = titleWrites();
      expect(titleAppendsAfterClear.length).toBeGreaterThanOrEqual(1);
      // A copy of the original title + source, not a fresh rename.
      expect(titleAppendsAfterClear[0].systemPayload).toEqual({
        customTitle: 'long-running-task',
        titleSource: 'manual',
      });
    });

    it('does not let threshold re-anchor records become the active parent tail', async () => {
      await titleThenClear('long-running-task');

      chatRecordingService.recordUserMessage([{ text: 'before bulk' }]);
      chatRecordingService.recordUserMessage([{ text: 'x'.repeat(40 * 1024) }]);
      chatRecordingService.recordUserMessage([{ text: 'after re-anchor' }]);
      await chatRecordingService.flush();

      const records = written();
      const reanchorIndex = records.findIndex(isTitle);

      expect(reanchorIndex).toBeGreaterThan(0);

      const triggeringUser = records[reanchorIndex - 1];
      const nextUser = records
        .slice(reanchorIndex + 1)
        .find((record) => record.type === 'user');
      const reanchor = records[reanchorIndex];

      expect(triggeringUser.type).toBe('user');
      expect(nextUser).toBeDefined();
      expect(nextUser?.parentUuid).toBe(triggeringUser.uuid);
      expect(nextUser?.parentUuid).not.toBe(reanchor.uuid);
    });

    it('does not re-anchor when no title has been set', async () => {
      // Sessions that never set a title shouldn't pay for spurious writes.
      await recordBulk(30, 'x'.repeat(2000));
      expect(titleWrites()).toHaveLength(0);
    });

    it('omits titleSource on re-anchor when source is unknown (legacy resumed session)', async () => {
      // Picker dim-styling depends on the persisted `titleSource`. Legacy
      // custom_title records have none (`getSessionTitleInfo` returns
      // `source: undefined`), and the re-anchor must mirror that shape:
      // `customTitle` alone, never a hardcoded 'manual', or resuming a legacy
      // session would silently reclassify it when the threshold first fires.
      const svc = resumedService('legacy-title');
      await svc.flush();
      expect(jsonl.writeLine).not.toHaveBeenCalled();

      await recordBulk(20, 'x'.repeat(2000), svc);

      const titleAppends = titleWrites();
      expect(titleAppends.length).toBeGreaterThanOrEqual(1);
      const reanchored = titleAppends[0];
      // Key must be ABSENT, not present-and-undefined: JSON.stringify would
      // drop an explicit undefined, but the contract is "no key", so pin it.
      expect(reanchored.systemPayload).toEqual({ customTitle: 'legacy-title' });
      expect(
        Object.prototype.hasOwnProperty.call(
          reanchored.systemPayload as object,
          'titleSource',
        ),
      ).toBe(false);
    });

    it('counts UTF-8 bytes, not UTF-16 code units, when measuring bulk writes', async () => {
      // CJK chars are 1 UTF-16 unit but 3 UTF-8 bytes, and the wire format is
      // UTF-8, so a `String.length` counter undercounts ~3× and would let
      // ~96KB land before the 32KB threshold fires, pushing the title past
      // the 64KB tail window. Twelve 1500-char messages ≈ 21K units (under)
      // but ≈ 57K bytes (over): the anchor fires only if bytes are counted.
      await titleThenClear('cjk-session');
      await recordBulk(12, '汉'.repeat(1500));
      expect(titleWrites().length).toBeGreaterThanOrEqual(1);
    });

    it('resets the byte counter when re-anchor fails — no retry storm', async () => {
      // If reanchorTitle throws (disk full, permission revoked) and the byte
      // counter stays pinned at the threshold, every later appendRecord
      // re-fires the failing reanchor: an unbounded retry storm on an already
      // degraded system. Resetting trades one missed anchor for bounded
      // recovery; finalize() re-emits on the next lifecycle event.
      await titleThenClear('long-running-task');

      // Make any custom_title append (a re-anchor; the initial write already
      // happened) throw, while bulk records reach the real appendRecord so
      // the byte counter accumulates exactly as in production.
      let reanchorAttempts = 0;
      const svc = chatRecordingService as unknown as {
        appendRecord(record: ChatRecord): void;
      };
      const originalAppendRecord = svc.appendRecord.bind(chatRecordingService);
      svc.appendRecord = (record: ChatRecord) => {
        if (isTitle(record)) {
          reanchorAttempts++;
          throw new Error('simulated disk-full');
        }
        return originalAppendRecord(record);
      };

      // 25 × 2KB ≈ 50KB > 32KB: the first re-anchor fires (and throws); a
      // pinned counter would re-trigger it on every later message.
      await recordBulk(25, 'x'.repeat(2000));
      expect(reanchorAttempts).toBe(1);
    });

    it('does not re-anchor on small write bursts under threshold', async () => {
      // A few small messages must not re-anchor (the cost would defeat the
      // point): five 200B messages stay well under the 32KB threshold.
      await titleThenClear('quick-session');
      await recordBulk(5, 'short');
      expect(titleWrites()).toHaveLength(0);
    });
  });
});
