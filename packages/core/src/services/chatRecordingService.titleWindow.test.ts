/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * End-to-end guard for the clear-tombstone re-anchor invariant (#8977):
 * a real ChatRecordingService writing a real JSONL file, read back through
 * the real windowed title reader. No write-path mocks — the whole point is
 * that the tombstone stays physically inside the reader's 64KB tail window
 * no matter how much transcript accumulates after the clear.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../config/config.js';
import { ChatRecordingService } from './chatRecordingService.js';
import {
  LITE_READ_BUF_SIZE,
  readSessionTitleInfoFromFileSync,
} from '../utils/sessionStorageUtils.js';

describe('ChatRecordingService - clear-tombstone title window (real fs)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-title-window-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const SESSION_ID = 'title-window-session';

  function makeConfig(): Config {
    return {
      getSessionId: () => SESSION_ID,
      getProjectRoot: () => tmpDir,
      getCliVersion: () => '1.0.0',
      storage: {
        getProjectDir: () => path.join(tmpDir, 'projects'),
      },
      getModel: () => 'qwen-plus',
      getFastModel: () => undefined,
      isInteractive: () => false,
      getDebugMode: () => false,
      getResumedSessionData: () => undefined,
    } as unknown as Config;
  }

  function sessionFile(): string {
    return path.join(tmpDir, 'projects', 'chats', `${SESSION_ID}.jsonl`);
  }

  /** ~4.3KB per record once serialized. */
  function appendBulk(svc: ChatRecordingService, count: number): void {
    const chunk = 'x'.repeat(4096);
    for (let i = 0; i < count; i++) {
      svc.recordUserMessage([{ text: chunk }]);
    }
  }

  it('keeps a cleared title dead past 64KB of post-clear transcript', async () => {
    const svc = new ChatRecordingService(makeConfig(), undefined, false);

    // Manual rename early — lands in the file's head window.
    await svc.recordCustomTitle('Deleted Name', 'manual');
    // ~116KB of transcript before the clear (the witness shape).
    appendBulk(svc, 28);
    await svc.flush();

    // /clear persists the empty-string tombstone at EOF.
    await svc.recordCustomTitle('', 'manual');

    // ~77KB more transcript after the clear — enough to push a
    // write-once tombstone out of the reader's 64KB tail window.
    appendBulk(svc, 18);
    await svc.flush();

    const filePath = sessionFile();
    const size = fs.statSync(filePath).size;
    // Sanity: the witness really outgrew both reader windows combined.
    expect(size).toBeGreaterThan(2 * LITE_READ_BUF_SIZE);

    const info = readSessionTitleInfoFromFileSync(filePath);
    // The deleted name must never come back. The latest visible title
    // record is a re-anchored tombstone: empty-but-present.
    expect(info.title ?? '').toBe('');
    expect(info.source).toBe('manual');

    // Direct evidence of the invariant: a tombstone record sits inside
    // the final 64KB of the file (the re-anchor appended it there).
    const fd = fs.openSync(filePath, 'r');
    try {
      const tailBuffer = Buffer.alloc(LITE_READ_BUF_SIZE);
      const read = fs.readSync(
        fd,
        tailBuffer,
        0,
        LITE_READ_BUF_SIZE,
        size - LITE_READ_BUF_SIZE,
      );
      expect(tailBuffer.toString('utf8', 0, read)).toContain(
        '"customTitle":""',
      );
    } finally {
      fs.closeSync(fd);
    }
  });

  it('keeps re-anchoring the tombstone across a cold restore', async () => {
    const svc = new ChatRecordingService(makeConfig(), undefined, false);
    await svc.recordCustomTitle('Deleted Name', 'manual');
    appendBulk(svc, 28);
    await svc.flush();
    await svc.recordCustomTitle('', 'manual');
    appendBulk(svc, 18);
    await svc.flush();

    // Cold restore: the daemon seeds a fresh recorder from the projected
    // state, whose title fields come from the windowed reader. With the
    // tombstone still inside the tail window the reader reports the
    // empty-but-present title, and the restored recorder must keep
    // re-anchoring it as more transcript accumulates.
    const restored = readSessionTitleInfoFromFileSync(sessionFile());
    expect(restored.title ?? '').toBe('');

    const svc2 = new ChatRecordingService(makeConfig(), undefined, false, {
      lastCompletedUuid: 'restored-tail',
      turnParentUuids: [],
      ...(restored.title !== undefined ? { customTitle: restored.title } : {}),
      ...(restored.source !== undefined
        ? { titleSource: restored.source }
        : {}),
    });
    appendBulk(svc2, 18);
    await svc2.flush();

    // Second cold restore: the deleted name must still be gone.
    const reread = readSessionTitleInfoFromFileSync(sessionFile());
    expect(reread.title ?? '').toBe('');
    expect(svc2.getCurrentCustomTitle()).toBe('');
  });
});
