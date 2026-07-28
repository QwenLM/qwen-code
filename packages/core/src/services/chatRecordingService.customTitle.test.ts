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
    lastCompletedUuid: null,
  };
}

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
    vi.mocked(execSync).mockReturnValue('main\n');
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

  it('should record a custom title as a system record', async () => {
    await chatRecordingService.recordCustomTitle('my-feature');

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
    await chatRecordingService.recordCustomTitle('my-feature');

    expect(jsonl.writeLine).toHaveBeenCalledTimes(2);

    const userRecord = vi.mocked(jsonl.writeLine).mock
      .calls[0][1] as ChatRecord;
    const titleRecord = vi.mocked(jsonl.writeLine).mock
      .calls[1][1] as ChatRecord;

    expect(titleRecord.parentUuid).toBe(userRecord.uuid);
  });

  it('should include correct metadata in the record', async () => {
    await chatRecordingService.recordCustomTitle('test-title');

    const writtenRecord = vi.mocked(jsonl.writeLine).mock
      .calls[0][1] as ChatRecord;

    expect(writtenRecord.cwd).toBe('/test/project/root');
    expect(writtenRecord.version).toBe('1.0.0');
    expect(writtenRecord.gitBranch).toBe('main');
    expect(writtenRecord.uuid).toBeDefined();
    expect(writtenRecord.timestamp).toBeDefined();
  });

  it('does not report success or update observers before the title lands', async () => {
    let resolveWrite!: () => void;
    vi.mocked(jsonl.writeLine).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveWrite = resolve;
      }),
    );
    const callback = vi.fn();
    chatRecordingService.setTitleRecordedCallback(callback);
    let settled = false;

    const result = chatRecordingService
      .recordCustomTitle('durable-title')
      .finally(() => {
        settled = true;
      });
    await vi.waitFor(() => expect(jsonl.writeLine).toHaveBeenCalledOnce());

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
    let resolveFirst!: () => void;
    vi.mocked(jsonl.writeLine).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveFirst = resolve;
      }),
    );
    const callback = vi.fn();
    chatRecordingService.setTitleRecordedCallback(callback);

    const first = chatRecordingService.recordCustomTitle('first-title');
    const second = chatRecordingService.recordCustomTitle('second-title');
    await vi.waitFor(() => expect(jsonl.writeLine).toHaveBeenCalledOnce());
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
    await chatRecordingService.recordCustomTitle('old-title');
    chatRecordingService.recordUserMessage([{ text: 'new work' }]);
    await chatRecordingService.flush();
    vi.mocked(jsonl.writeLine).mockClear();

    let resolveRename!: () => void;
    vi.mocked(jsonl.writeLine).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveRename = resolve;
      }),
    );
    const rename = chatRecordingService.recordCustomTitle('new-title');
    await vi.waitFor(() => expect(jsonl.writeLine).toHaveBeenCalledOnce());

    chatRecordingService.finalize();
    resolveRename();
    await expect(rename).resolves.toBe(true);
    await chatRecordingService.flush();

    const writtenTitles = vi
      .mocked(jsonl.writeLine)
      .mock.calls.map((call) => call[1] as ChatRecord)
      .filter(
        (record) =>
          record.type === 'system' && record.subtype === 'custom_title',
      )
      .map(
        (record) =>
          (record.systemPayload as CustomTitleRecordPayload | undefined)
            ?.customTitle,
      );
    expect(writtenTitles).toEqual(['new-title']);
  });

  it('tracks records queued behind a pending title for later finalization', async () => {
    let resolveTitle!: () => void;
    vi.mocked(jsonl.writeLine).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveTitle = resolve;
      }),
    );
    const title = chatRecordingService.recordCustomTitle('durable-title');
    await vi.waitFor(() => expect(jsonl.writeLine).toHaveBeenCalledOnce());
    chatRecordingService.recordUserMessage([{ text: 'queued descendant' }]);

    resolveTitle();
    await expect(title).resolves.toBe(true);
    await chatRecordingService.flush();
    vi.mocked(jsonl.writeLine).mockClear();

    chatRecordingService.finalize();
    await chatRecordingService.flush();

    const anchor = vi.mocked(jsonl.writeLine).mock.calls[0]?.[1] as ChatRecord;
    expect(anchor).toMatchObject({
      type: 'system',
      subtype: 'custom_title',
      systemPayload: { customTitle: 'durable-title' },
    });
  });

  it('re-anchors the new title when queued descendants cross the threshold', async () => {
    await chatRecordingService.recordCustomTitle('old-title');
    vi.mocked(jsonl.writeLine).mockClear();

    let resolveRename!: () => void;
    vi.mocked(jsonl.writeLine).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveRename = resolve;
      }),
    );
    const rename = chatRecordingService.recordCustomTitle('new-title');
    await vi.waitFor(() => expect(jsonl.writeLine).toHaveBeenCalledOnce());
    chatRecordingService.recordUserMessage([{ text: 'x'.repeat(40_000) }]);

    resolveRename();
    await expect(rename).resolves.toBe(true);
    await chatRecordingService.flush();

    const writtenTitles = vi
      .mocked(jsonl.writeLine)
      .mock.calls.map((call) => call[1] as ChatRecord)
      .filter(
        (record) =>
          record.type === 'system' && record.subtype === 'custom_title',
      )
      .map(
        (record) =>
          (record.systemPayload as CustomTitleRecordPayload | undefined)
            ?.customTitle,
      );
    expect(writtenTitles).toEqual(['new-title', 'new-title']);
  });

  describe('finalize', () => {
    it('should re-append cached custom title to EOF after new content', async () => {
      await chatRecordingService.recordCustomTitle('my-feature');
      chatRecordingService.recordUserMessage([{ text: 'new work' }]);
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

    it('should not write anything when the title is already the latest record', async () => {
      await chatRecordingService.recordCustomTitle('my-feature');
      vi.mocked(jsonl.writeLine).mockClear();

      chatRecordingService.finalize();
      await chatRecordingService.flush();

      expect(jsonl.writeLine).not.toHaveBeenCalled();
    });

    it('should not write anything when no custom title was set', async () => {
      chatRecordingService.finalize();
      await chatRecordingService.flush();

      expect(jsonl.writeLine).not.toHaveBeenCalled();
    });

    it('should not re-append a resumed title without new content', async () => {
      vi.mocked(mockConfig.getResumedSessionData).mockReturnValue({
        ...resumedSessionWithTitle('resumed-title', 'manual'),
      });
      const getSessionTitleInfo = vi.fn().mockReturnValue({
        title: 'resumed-title',
        source: 'manual',
      });
      (
        mockConfig as unknown as {
          getSessionService: () => {
            getSessionTitleInfo: typeof getSessionTitleInfo;
          };
        }
      ).getSessionService = () => ({ getSessionTitleInfo });

      const svc = activateRecording(new ChatRecordingService(mockConfig));
      svc.finalize();
      await svc.flush();

      expect(jsonl.writeLine).not.toHaveBeenCalled();
    });

    it('should re-append the latest title after multiple renames', async () => {
      await chatRecordingService.recordCustomTitle('first-name');
      await chatRecordingService.recordCustomTitle('second-name');
      chatRecordingService.recordUserMessage([{ text: 'new work' }]);
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

  describe('title re-anchor invariant', () => {
    it('re-anchors the title once enough non-title bytes accumulate', async () => {
      // Write a title, then keep appending bulky messages until the
      // running tally crosses the 32KB threshold. The first non-title
      // record after the threshold should provoke a fresh
      // custom_title append at EOF — keeping the title within the
      // 64KB tail window the picker scans even if no lifecycle event
      // (finalize) has fired.
      await chatRecordingService.recordCustomTitle('long-running-task');
      vi.mocked(jsonl.writeLine).mockClear();

      // Each user message carries ~2KB of text — 20 of them put well
      // over 32KB on the wire (counting the ~200B per-record envelope).
      const bulkText = 'x'.repeat(2000);
      for (let i = 0; i < 20; i++) {
        chatRecordingService.recordUserMessage([{ text: bulkText }]);
      }
      await chatRecordingService.flush();

      const writes = vi.mocked(jsonl.writeLine).mock.calls;
      const titleAppendsAfterClear = writes.filter(([, record]) => {
        const r = record as ChatRecord;
        return r.type === 'system' && r.subtype === 'custom_title';
      });

      expect(titleAppendsAfterClear.length).toBeGreaterThanOrEqual(1);
      // The re-anchored record must carry the same title + source as
      // the original — it's a copy, not a fresh rename.
      const reanchored = titleAppendsAfterClear[0][1] as ChatRecord;
      expect(reanchored.systemPayload).toEqual({
        customTitle: 'long-running-task',
        titleSource: 'manual',
      });
    });

    it('does not let threshold re-anchor records become the active parent tail', async () => {
      await chatRecordingService.recordCustomTitle('long-running-task');
      vi.mocked(jsonl.writeLine).mockClear();

      chatRecordingService.recordUserMessage([{ text: 'before bulk' }]);
      chatRecordingService.recordUserMessage([{ text: 'x'.repeat(40 * 1024) }]);
      chatRecordingService.recordUserMessage([{ text: 'after re-anchor' }]);
      await chatRecordingService.flush();

      const records = vi
        .mocked(jsonl.writeLine)
        .mock.calls.map(([, record]) => record as ChatRecord);
      const reanchorIndex = records.findIndex(
        (record) =>
          record.type === 'system' && record.subtype === 'custom_title',
      );

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
      // The counter only matters when there's a title to keep alive;
      // sessions that never set one shouldn't pay for spurious writes.
      const bulkText = 'x'.repeat(2000);
      for (let i = 0; i < 30; i++) {
        chatRecordingService.recordUserMessage([{ text: bulkText }]);
      }
      await chatRecordingService.flush();

      const titleAppends = vi
        .mocked(jsonl.writeLine)
        .mock.calls.filter(([, record]) => {
          const r = record as ChatRecord;
          return r.type === 'system' && r.subtype === 'custom_title';
        });
      expect(titleAppends).toHaveLength(0);
    });

    it('omits titleSource on re-anchor when source is unknown (legacy resumed session)', async () => {
      // The picker dim-styling depends on the persisted `titleSource`
      // discriminator. Legacy `custom_title` records (written before
      // the field existed) have no source — `getSessionTitleInfo`
      // returns `source: undefined` for those, and the writer's
      // re-anchor invariant must mirror that exact shape: emit
      // `customTitle` alone, never a hardcoded `'manual'`. Otherwise
      // resuming a legacy session on a current build would silently
      // reclassify it the first time the threshold fires.
      vi.mocked(mockConfig.getResumedSessionData).mockReturnValue({
        ...resumedSessionWithTitle('legacy-title'),
      });
      const getSessionTitleInfo = vi
        .fn()
        .mockReturnValue({ title: 'legacy-title', source: undefined });
      (
        mockConfig as unknown as {
          getSessionService: () => {
            getSessionTitleInfo: typeof getSessionTitleInfo;
          };
        }
      ).getSessionService = () => ({ getSessionTitleInfo });

      const svc = activateRecording(new ChatRecordingService(mockConfig));
      await svc.flush();
      expect(jsonl.writeLine).not.toHaveBeenCalled();

      const bulkText = 'x'.repeat(2000);
      for (let i = 0; i < 20; i++) {
        svc.recordUserMessage([{ text: bulkText }]);
      }
      await svc.flush();

      const titleAppends = vi
        .mocked(jsonl.writeLine)
        .mock.calls.filter(([, record]) => {
          const r = record as ChatRecord;
          return r.type === 'system' && r.subtype === 'custom_title';
        });

      expect(titleAppends.length).toBeGreaterThanOrEqual(1);
      const reanchored = titleAppends[0][1] as ChatRecord;
      // Key must be ABSENT, not present-and-undefined — JSON.stringify
      // would still serialize an explicit `undefined` away, but the
      // record-shape contract is "no key when no source", so pin it.
      expect(reanchored.systemPayload).toEqual({ customTitle: 'legacy-title' });
      expect(
        Object.prototype.hasOwnProperty.call(
          reanchored.systemPayload as object,
          'titleSource',
        ),
      ).toBe(false);
    });

    it('counts UTF-8 bytes, not UTF-16 code units, when measuring bulk writes', async () => {
      // CJK characters are 1 UTF-16 code unit but 3 UTF-8 bytes. The wire
      // format is UTF-8 (jsonl.writeLine emits utf8), so a per-record
      // `String.length` undercounts a multi-byte payload by ~3×. A naive
      // length-based counter would let ~96KB of CJK content land on disk
      // before the 32KB threshold thinks it has — pushing the title past
      // the 64KB tail window the picker scans.
      //
      // Twelve 1500-char CJK messages ≈ 21K UTF-16 units (under threshold)
      // but ≈ 57K UTF-8 bytes (over). Anchor fires only when the counter
      // measures bytes, not chars.
      await chatRecordingService.recordCustomTitle('cjk-session');
      vi.mocked(jsonl.writeLine).mockClear();

      const cjkText = '汉'.repeat(1500);
      for (let i = 0; i < 12; i++) {
        chatRecordingService.recordUserMessage([{ text: cjkText }]);
      }
      await chatRecordingService.flush();

      const titleAppends = vi
        .mocked(jsonl.writeLine)
        .mock.calls.filter(([, record]) => {
          const r = record as ChatRecord;
          return r.type === 'system' && r.subtype === 'custom_title';
        });
      expect(titleAppends.length).toBeGreaterThanOrEqual(1);
    });

    it('resets the byte counter when re-anchor fails — no retry storm', async () => {
      // If reanchorTitle throws (disk full, permission revoked) and we
      // leave the byte counter pinned at the threshold, every subsequent
      // appendRecord will re-fire the failing reanchor — an unbounded
      // retry storm that amplifies I/O pressure on an already-degraded
      // system. Resetting on failure trades one missed anchor for
      // bounded recovery; finalize() will re-emit on the next lifecycle
      // event.
      await chatRecordingService.recordCustomTitle('long-running-task');
      vi.mocked(jsonl.writeLine).mockClear();

      // Wrap the private appendRecord so any custom_title append (i.e.
      // a re-anchor — the initial title write already happened) throws.
      // Bulk records pass through to the real implementation so the
      // byte counter still accumulates exactly as production would.
      let reanchorAttempts = 0;
      const svc = chatRecordingService as unknown as {
        appendRecord(record: ChatRecord): void;
      };
      const originalAppendRecord = svc.appendRecord.bind(chatRecordingService);
      svc.appendRecord = (record: ChatRecord) => {
        if (record.type === 'system' && record.subtype === 'custom_title') {
          reanchorAttempts++;
          throw new Error('simulated disk-full');
        }
        return originalAppendRecord(record);
      };

      // 25 × 2KB ≈ 50KB > 32KB → first re-anchor fires (and throws).
      // With the counter-reset fix, it stays reset; without it, every
      // subsequent message would re-trigger reanchor.
      const bulkText = 'x'.repeat(2000);
      for (let i = 0; i < 25; i++) {
        chatRecordingService.recordUserMessage([{ text: bulkText }]);
      }
      await chatRecordingService.flush();

      // One failed attempt is acceptable; multiple means the counter was
      // pinned and turned a single fault into a per-record loop.
      expect(reanchorAttempts).toBe(1);
    });

    it('does not re-anchor on small write bursts under threshold', async () => {
      // A handful of small messages must not trigger a re-anchor —
      // the cost would defeat the whole point. Threshold is 32KB;
      // five 200B user messages stay safely under it.
      await chatRecordingService.recordCustomTitle('quick-session');
      vi.mocked(jsonl.writeLine).mockClear();

      for (let i = 0; i < 5; i++) {
        chatRecordingService.recordUserMessage([{ text: 'short' }]);
      }
      await chatRecordingService.flush();

      const titleAppends = vi
        .mocked(jsonl.writeLine)
        .mock.calls.filter(([, record]) => {
          const r = record as ChatRecord;
          return r.type === 'system' && r.subtype === 'custom_title';
        });
      expect(titleAppends).toHaveLength(0);
    });
  });
});
