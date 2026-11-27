/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addPromptUuidToBloom,
  buildPromptUuidBloom,
  createPromptUuidBloom,
  decodePromptUuidBloom,
  encodePromptUuidBloom,
  moveSessionPromptTimeSidecar,
  promptUuidBloomMayContain,
  readSessionPromptTimeSidecarAsync,
  removeSessionPromptTimeSidecar,
  sessionPromptTimeSidecarPath,
  writeSessionPromptTimeSidecar,
} from './session-prompt-time-sidecar.js';

describe('session-prompt-time-sidecar', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-time-sidecar-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('round-trips valid sidecars including null timestamps, managed flag, and >2^53 Windows inodes', async () => {
    const p1 = sessionPromptTimeSidecarPath(tmpDir, 'sess-1');
    const windowsIno = Number.MAX_SAFE_INTEGER + 1024;
    expect(
      writeSessionPromptTimeSidecar(p1, {
        fileIdentity: { dev: 12, ino: windowsIno },
        snapshotSize: 4096,
        lastUpdated: '2026-06-01T12:00:00.000Z',
        lastUserPromptAt: '2026-06-01T11:59:00.000Z',
        leafUuid: 'leaf-1',
        firstRecordOwner: { sessionId: 'sess-1', cwd: '/repo' },
      }),
    ).toBe(true);
    expect(await readSessionPromptTimeSidecarAsync(p1)).toEqual({
      version: 1,
      fileIdentity: { dev: 12, ino: windowsIno },
      snapshotSize: 4096,
      lastUpdated: '2026-06-01T12:00:00.000Z',
      lastUserPromptAt: '2026-06-01T11:59:00.000Z',
      leafUuid: 'leaf-1',
      firstRecordOwner: { sessionId: 'sess-1', cwd: '/repo' },
    });

    const p2 = sessionPromptTimeSidecarPath(tmpDir, 'sess-2');
    const bloom = buildPromptUuidBloom(['u1', 'a1', 'u2'], 3);
    expect(bloom).toBeDefined();
    expect(
      writeSessionPromptTimeSidecar(p2, {
        fileIdentity: { dev: 1, ino: 2 },
        snapshotSize: 128,
        lastUpdated: '2026-06-01T12:00:00.000Z',
        lastUserPromptAt: null,
        leafUuid: 'leaf-2',
        firstRecordOwner: { sessionId: 'sess-2', cwd: '/repo' },
        prefixUuidBloom: bloom,
        managed: true,
      }),
    ).toBe(true);
    expect(await readSessionPromptTimeSidecarAsync(p2)).toEqual({
      version: 1,
      fileIdentity: { dev: 1, ino: 2 },
      snapshotSize: 128,
      lastUpdated: '2026-06-01T12:00:00.000Z',
      lastUserPromptAt: null,
      leafUuid: 'leaf-2',
      firstRecordOwner: { sessionId: 'sess-2', cwd: '/repo' },
      prefixUuidBloom: bloom,
      managed: true,
    });
  });

  it('builds a zero-false-negative prefix UUID Bloom filter and drops saturated or oversized filters', () => {
    const uuids = Array.from({ length: 500 }, (_, i) => `uuid-${i}`);
    const encoded = buildPromptUuidBloom(uuids, uuids.length);
    expect(encoded).toBeDefined();
    const decoded = decodePromptUuidBloom(encoded!);
    expect(decoded).toBeDefined();
    for (const uuid of uuids) {
      expect(promptUuidBloomMayContain(decoded!, uuid)).toBe(true);
    }
    let falsePositives = 0;
    for (let i = 0; i < 500; i += 1) {
      if (promptUuidBloomMayContain(decoded!, `unseen-${i}`)) {
        falsePositives += 1;
      }
    }
    expect(falsePositives).toBeLessThan(20);

    // Saturated filter (count > buffer.length) returns undefined from encode so
    // the next append triggers a lightweight scan and resizes.
    const small = createPromptUuidBloom(10)!;
    for (let i = 0; i <= small.buffer.length; i += 1) {
      addPromptUuidToBloom(small, `sat-${i}`);
    }
    expect(encodePromptUuidBloom(small)).toBeUndefined();
    expect(createPromptUuidBloom(200_000)).toBeUndefined();
  });

  it('rejects malformed, corrupt, or invalid-field sidecars and honors AbortSignal', async () => {
    const missing = sessionPromptTimeSidecarPath(tmpDir, 'missing');
    expect(await readSessionPromptTimeSidecarAsync(missing)).toBeUndefined();

    const controller = new AbortController();
    controller.abort(new DOMException('aborted', 'AbortError'));
    await expect(
      readSessionPromptTimeSidecarAsync(missing, { signal: controller.signal }),
    ).rejects.toThrow();

    const badPayloads = [
      '{not json',
      JSON.stringify({ version: 2 }),
      JSON.stringify({
        version: 1,
        fileIdentity: { dev: -1, ino: 1 },
        snapshotSize: 100,
        lastUpdated: '2026-06-01T12:00:00.000Z',
        lastUserPromptAt: null,
        leafUuid: 'u1',
        firstRecordOwner: { sessionId: 's', cwd: '/r' },
      }),
      JSON.stringify({
        version: 1,
        fileIdentity: { dev: 1, ino: 1 },
        snapshotSize: 0,
        lastUpdated: '2026-06-01T12:00:00.000Z',
        lastUserPromptAt: null,
        leafUuid: 'u1',
        firstRecordOwner: { sessionId: 's', cwd: '/r' },
      }),
      JSON.stringify({
        version: 1,
        fileIdentity: { dev: 1, ino: 1 },
        snapshotSize: 100,
        lastUpdated: 'not-iso',
        lastUserPromptAt: null,
        leafUuid: 'u1',
        firstRecordOwner: { sessionId: 's', cwd: '/r' },
      }),
      JSON.stringify({
        version: 1,
        fileIdentity: { dev: 1, ino: 1 },
        snapshotSize: 100,
        lastUpdated: '2026-06-01T12:00:00.000Z',
        lastUserPromptAt: '2026-02-30T12:00:00.000Z',
        leafUuid: 'u1',
        firstRecordOwner: { sessionId: 's', cwd: '/r' },
      }),
      JSON.stringify({
        version: 1,
        fileIdentity: { dev: 1, ino: 1 },
        snapshotSize: 100,
        lastUpdated: '2026-06-01T12:00:00.000Z',
        lastUserPromptAt: null,
        leafUuid: '',
        firstRecordOwner: { sessionId: 's', cwd: '/r' },
      }),
      JSON.stringify({
        version: 1,
        fileIdentity: { dev: 1, ino: 1 },
        snapshotSize: 100,
        lastUpdated: '2026-06-01T12:00:00.000Z',
        lastUserPromptAt: null,
        leafUuid: 'u1',
        firstRecordOwner: { sessionId: 's', cwd: '' },
      }),
      JSON.stringify({
        version: 1,
        fileIdentity: { dev: 1, ino: 1 },
        snapshotSize: 100,
        lastUpdated: '2026-06-01T12:00:00.000Z',
        lastUserPromptAt: null,
        leafUuid: 'u1',
        firstRecordOwner: { sessionId: 's', cwd: '/r' },
        tailHex: 'not-hex',
      }),
      JSON.stringify({
        version: 1,
        fileIdentity: { dev: 1, ino: 1 },
        snapshotSize: 100,
        lastUpdated: '2026-06-01T12:00:00.000Z',
        lastUserPromptAt: null,
        leafUuid: 'u1',
        firstRecordOwner: { sessionId: 's', cwd: '/r' },
        tailHex: 'abc',
      }),
      JSON.stringify({
        version: 1,
        fileIdentity: { dev: 1, ino: 1 },
        snapshotSize: 100,
        lastUpdated: '2026-06-01T12:00:00.000Z',
        lastUserPromptAt: null,
        leafUuid: 'u1',
        firstRecordOwner: { sessionId: 's', cwd: '/r' },
        prefixUuidBloom: {
          bits: Buffer.alloc(300).toString('base64'),
          hashes: 7,
          count: 1,
        },
      }),
      JSON.stringify({
        version: 1,
        fileIdentity: { dev: 1, ino: 1 },
        snapshotSize: 100,
        lastUpdated: '2026-06-01T12:00:00.000Z',
        lastUserPromptAt: null,
        leafUuid: 'u1',
        firstRecordOwner: { sessionId: 's', cwd: '/r' },
        prefixUuidBloom: {
          bits: `${Buffer.alloc(256).toString('base64')}!`,
          hashes: 7,
          count: 1,
        },
      }),
      JSON.stringify({
        version: 1,
        fileIdentity: { dev: 1, ino: 1 },
        snapshotSize: 100,
        lastUpdated: '2026-06-01T12:00:00.000Z',
        lastUserPromptAt: null,
        leafUuid: 'u1',
        firstRecordOwner: { sessionId: 's', cwd: '/r' },
        prefixUuidBloom: {
          bits: Buffer.alloc(256).toString('base64'),
          hashes: 0,
          count: 1,
        },
      }),
    ];
    for (const [index, payload] of badPayloads.entries()) {
      const p = sessionPromptTimeSidecarPath(tmpDir, `bad-${index}`);
      fs.writeFileSync(p, payload, 'utf8');
      expect(await readSessionPromptTimeSidecarAsync(p)).toBeUndefined();
    }

    expect(
      writeSessionPromptTimeSidecar(
        sessionPromptTimeSidecarPath(tmpDir, 'bad-write'),
        {
          fileIdentity: { dev: 1, ino: 1 },
          snapshotSize: 0,
          lastUpdated: '2026-06-01T12:00:00.000Z',
          lastUserPromptAt: null,
          leafUuid: 'u1',
          firstRecordOwner: { sessionId: 's', cwd: '/r' },
        },
      ),
    ).toBe(false);
  });

  it('moves and removes sidecars cleanly', () => {
    const archiveDir = path.join(tmpDir, 'archive');
    fs.mkdirSync(archiveDir, { recursive: true });
    const src = sessionPromptTimeSidecarPath(tmpDir, 'sess-move');
    const dst = sessionPromptTimeSidecarPath(archiveDir, 'sess-move');
    // Moving a missing sidecar is a no-op.
    moveSessionPromptTimeSidecar(src, dst);
    expect(fs.existsSync(dst)).toBe(false);

    writeSessionPromptTimeSidecar(src, {
      fileIdentity: { dev: 1, ino: 2 },
      snapshotSize: 50,
      lastUpdated: '2026-06-01T12:00:00.000Z',
      lastUserPromptAt: '2026-06-01T11:00:00.000Z',
      leafUuid: 'u1',
      firstRecordOwner: { sessionId: 'sess-move', cwd: '/repo' },
    });
    moveSessionPromptTimeSidecar(src, dst);
    expect(fs.existsSync(src)).toBe(false);
    expect(fs.existsSync(dst)).toBe(true);

    removeSessionPromptTimeSidecar(dst);
    expect(fs.existsSync(dst)).toBe(false);
  });
});
