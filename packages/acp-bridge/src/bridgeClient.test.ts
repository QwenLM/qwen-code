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
import { CancelSentinelCollisionError } from './bridgeErrors.js';
import { CANCEL_VOTE_SENTINEL } from './permissionMediator.js';

/**
 * Minimal-stub constructor for a `BridgeClient` whose only purpose is
 * to exercise `writeTextFile` / `readTextFile`. The 5 callback args
 * before `fileSystem` are filled with thrower-defaults so any test
 * that accidentally hits the permission path (instead of the fs path)
 * fails loudly instead of silently. F3 Commit 3 replaced the pre-F3
 * `registerPending` + `rollbackPending` callbacks with a single
 * `MultiClientPermissionMediator` reference; the test stub provides
 * a thrower-Mediator that fails any unexpected `request()` /
 * `vote()` / `forgetSession()` call.
 */
function makeClient(fileSystem?: BridgeFileSystem): BridgeClient {
  const noPermissionFlow = () => {
    throw new Error('test: permission flow should not run in fs-path tests');
  };
  // Wenshao review #4335 / 3272581569 — `BridgeClient.mediator` is
  // narrowed to `Pick<PermissionMediator, 'request'>`, so the
  // thrower stub only needs to provide `request`. Eliminates the
  // 5 unused-method placeholders the pre-narrowing version
  // required (policy/vote/forgetSession/peekSessionFor/pendingCount).
  const throwerMediator = { request: noPermissionFlow } as never;
  return new BridgeClient(
    noPermissionFlow as never, // resolveEntry
    noPermissionFlow as never, // resolvePendingRestoreEvents
    throwerMediator, // mediator (F3 Commit 3)
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

    it('does NOT touch real fs when delegating — the mock is invoked without any disk touch', async () => {
      const writeText = vi
        .fn<(p: WriteTextFileRequest) => Promise<WriteTextFileResponse>>()
        .mockResolvedValue({});
      const fakeFs: BridgeFileSystem = {
        writeText,
        readText: vi.fn(),
      };
      const client = makeClient(fakeFs);

      // A path no real disk would ever resolve to. Delegation skips
      // realpath / writeFile entirely, so the call succeeds purely
      // on the mock's resolve. Cross-platform-safe (avoiding `/proc/`
      // because macOS / Windows would treat that path differently
      // than Linux — the inline proxy's dangling-symlink fallback
      // would write through there on macOS).
      await client.writeTextFile({
        path: '/this/dir/never/exists/file.txt',
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

/**
 * Wenshao review #4335 / 3271978365 — `requestPermission`'s pre-publish
 * `CancelSentinelCollisionError` guard prevents an orphan SSE
 * `permission_request` event from being emitted when an agent's
 * `allowedOptionIds` legitimately contains '__cancelled__'. The
 * mediator-level test (`permissionMediator.test.ts:330`) covers the
 * issue-time collision detection inside `mediator.request`, but
 * BridgeClient layers a separate pre-publish check whose distinct
 * purpose — preventing orphan SSE frames — needs its own test.
 */
describe('BridgeClient — requestPermission pre-publish collision guard', () => {
  it('throws CancelSentinelCollisionError BEFORE publishing on the events bus', async () => {
    // Arrange: a fake session entry whose `events.publish` is a spy.
    // If the collision check ran AFTER publish, this would record a
    // call and the assertion below would fail.
    const publish = vi.fn().mockReturnValue(true);
    const fakeEntry = {
      sessionId: 'sess:test',
      pendingPermissionIds: new Set<string>(),
      events: { publish },
      activePromptOriginatorClientId: undefined,
    };

    const noPermissionFlow = () => {
      throw new Error('test: not reachable on collision-throw path');
    };
    // Wenshao review #4335 / 3272581569 — narrowed mediator type
    // means the stub only needs `request`.
    const throwerMediator = { request: noPermissionFlow } as never;
    const client = new BridgeClient(
      ((sid: string) => (sid === 'sess:test' ? fakeEntry : undefined)) as never,
      noPermissionFlow as never,
      throwerMediator,
      0,
      Infinity,
    );

    // Act + Assert: a sentinel-colliding option causes the bridge
    // client to throw before reaching publish.
    await expect(
      client.requestPermission({
        sessionId: 'sess:test',
        toolCall: { toolCallId: 'tc-1', title: 'rm -rf /' },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          {
            optionId: CANCEL_VOTE_SENTINEL,
            name: 'Adversarial label',
            kind: 'allow_once',
          },
        ],
      }),
    ).rejects.toThrow(CancelSentinelCollisionError);

    // The crucial post-condition: no SSE frame went out.
    expect(publish).not.toHaveBeenCalled();
    // And the cap-index was never touched (only added AFTER publish).
    expect(fakeEntry.pendingPermissionIds.size).toBe(0);
  });
});
