/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the `BridgeFileSystem` injection seam introduced in
 * #4175 PR F1 step 5. The wider 174-test `httpAcpBridge.test.ts` suite
 * exercises BridgeClient end-to-end via the lifted factory, but none
 * of those tests wire `fileSystem` — they all exercise the inline
 * `fs.writeFile` / `fs.readFile` proxy. These tests close that gap
 * (wenshao #4319 Critical fold-in): they directly assert that
 *
 *   1. when `fileSystem` is provided, both `writeTextFile` and
 *      `readTextFile` delegate every call to it (and the inline
 *      proxy is fully bypassed — no `fs.writeFile` syscall);
 *   2. when `fileSystem` is omitted, the inline proxy runs and
 *      reads / writes real disk (sanity check that the fallback
 *      path the 7-arg constructor's positional slot opt-outs to
 *      still works).
 *
 * Regression guard: the constructor takes 7 positional args; the
 * 7th (`fileSystem`) is optional and at the tail. A subtle re-
 * ordering (or dropping the arg from `bridge.ts:773` factory's
 * `new BridgeClient(..., opts.fileSystem)` call) would silently
 * bypass the adapter in production. Test #1 + #2 catch that
 * because the mock fileSystem would never be called.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk';
import { BridgeClient } from './bridgeClient.js';
import type { BridgeFileSystem } from './bridgeFileSystem.js';

/**
 * Minimal-stub constructor for a `BridgeClient` whose only purpose is
 * to exercise `writeTextFile` / `readTextFile`. The 6 callback args
 * before `fileSystem` are filled with thrower-defaults so any test
 * that accidentally hits the permission path (instead of the fs path)
 * fails loudly instead of silently.
 */
function makeClient(fileSystem?: BridgeFileSystem): BridgeClient {
  const noPermissionFlow = () => {
    throw new Error('test: permission flow should not run in fs-path tests');
  };
  return new BridgeClient(
    noPermissionFlow as never, // resolveEntry
    noPermissionFlow as never, // resolvePendingRestoreEvents
    noPermissionFlow, // registerPending
    noPermissionFlow, // rollbackPending
    0, // permissionTimeoutMs (disabled)
    Infinity, // maxPendingPerSession (disabled)
    fileSystem,
  );
}

describe('BridgeClient — BridgeFileSystem injection seam (F1 step 5)', () => {
  describe('writeTextFile', () => {
    it('delegates to the injected fileSystem.writeText, bypassing the inline fs proxy', async () => {
      const writeText = vi
        .fn<(p: WriteTextFileRequest) => Promise<WriteTextFileResponse>>()
        .mockResolvedValue({});
      const readText =
        vi.fn<(p: ReadTextFileRequest) => Promise<ReadTextFileResponse>>();
      const fakeFs: BridgeFileSystem = { writeText, readText };

      const client = makeClient(fakeFs);
      const params: WriteTextFileRequest = {
        path: '/this/path/never/touches/disk',
        content: 'injected-content',
        sessionId: 'sess:test',
      };

      const response = await client.writeTextFile(params);

      expect(response).toEqual({});
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(writeText).toHaveBeenCalledWith(params);
      expect(readText).not.toHaveBeenCalled();
    });

    it('does NOT touch real fs when delegating — invalid path never reaches fs.realpath', async () => {
      const writeText = vi
        .fn<(p: WriteTextFileRequest) => Promise<WriteTextFileResponse>>()
        .mockResolvedValue({});
      const fakeFs: BridgeFileSystem = {
        writeText,
        readText: vi.fn(),
      };
      const client = makeClient(fakeFs);

      // A path the inline proxy would choke on (no parent, no read
      // permission, no existing target). Delegation skips realpath,
      // so the call succeeds purely on the mock's resolve.
      await client.writeTextFile({
        path: '/proc/no-such-file',
        content: '',
        sessionId: 'sess:test',
      });

      expect(writeText).toHaveBeenCalled();
    });
  });

  describe('readTextFile', () => {
    it('delegates to the injected fileSystem.readText, bypassing the inline fs proxy', async () => {
      const writeText =
        vi.fn<(p: WriteTextFileRequest) => Promise<WriteTextFileResponse>>();
      const readText = vi
        .fn<(p: ReadTextFileRequest) => Promise<ReadTextFileResponse>>()
        .mockResolvedValue({ content: 'injected-content' });
      const fakeFs: BridgeFileSystem = { writeText, readText };

      const client = makeClient(fakeFs);
      const params: ReadTextFileRequest = {
        path: '/this/path/never/touches/disk',
        sessionId: 'sess:test',
      };

      const response = await client.readTextFile(params);

      expect(response).toEqual({ content: 'injected-content' });
      expect(readText).toHaveBeenCalledTimes(1);
      expect(readText).toHaveBeenCalledWith(params);
      expect(writeText).not.toHaveBeenCalled();
    });

    it('propagates fileSystem.readText errors to the caller', async () => {
      const readText = vi.fn(async (): Promise<ReadTextFileResponse> => {
        throw new Error('adapter-rejected');
      });
      const client = makeClient({ writeText: vi.fn(), readText });

      await expect(
        client.readTextFile({ path: '/x', sessionId: 'sess:test' }),
      ).rejects.toThrow('adapter-rejected');
    });
  });

  describe('inline fallback when fileSystem is omitted (regression guard)', () => {
    let tmpDir: string;
    beforeEach(async () => {
      tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bridgeclient-test-'));
    });
    afterEach(async () => {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    });

    it('writeTextFile actually writes to disk through the inline proxy', async () => {
      const client = makeClient(/* no fileSystem */);
      const target = path.join(tmpDir, 'inline.txt');

      await client.writeTextFile({
        path: target,
        content: 'inline-content',
        sessionId: 'sess:test',
      });

      const onDisk = await fsp.readFile(target, 'utf8');
      expect(onDisk).toBe('inline-content');
    });

    it('readTextFile actually reads from disk through the inline proxy', async () => {
      const client = makeClient(/* no fileSystem */);
      const target = path.join(tmpDir, 'src.txt');
      await fsp.writeFile(target, 'on-disk-content', 'utf8');

      const response = await client.readTextFile({
        path: target,
        sessionId: 'sess:test',
      });

      expect(response.content).toBe('on-disk-content');
    });
  });
});
