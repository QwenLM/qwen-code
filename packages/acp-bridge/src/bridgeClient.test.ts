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
 *      path the 8-arg constructor's positional slot opt-outs to
 *      still works).
 *
 * Regression guard: the constructor takes 8 positional args; the
 * 6th (`fileSystem`) is optional. A subtle re-ordering (or
 * dropping the arg from `bridge.ts`'s factory
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
import { RequestError } from '@agentclientprotocol/sdk';
import {
  ClientMcpRegistrar,
  type ClientMcpFrame,
} from '@qwen-code/qwen-code-core';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { BridgeClient } from './bridgeClient.js';
import type { BridgeFileSystem } from './bridgeFileSystem.js';
import type { MidTurnQueueEntry } from './bridgeTypes.js';
import type { ClientMcpMessageSender } from './bridgeOptions.js';
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

  describe('FsError preservation over ACP wire (#4175 F4 prereq, Codex #4360 round 2)', () => {
    // The fix scope: when `BridgeFileSystem.writeText` /
    // `BridgeFileSystem.readText` throw a structured `FsError`, the
    // BridgeClient must rethrow as ACP `RequestError` with `data.
    // errorKind` / `data.hint` / `data.status` preserved. Pre-fix
    // the ACP SDK serialized only `error.message` so SDK consumers
    // lost the discriminator and had to regex-match the message.
    //
    // FsError lives in `cli/src/serve/fs/errors.ts` — acp-bridge can't
    // import it (cross-package dep inversion), so we synthesize the
    // shape directly here. The duck typing in
    // `preserveFsErrorOverAcp` keys on `err.name === 'FsError'` +
    // `typeof err.kind === 'string'`.

    function makeFsError(
      kind: string,
      message: string,
      extras: { hint?: string; status?: number } = {},
    ): Error {
      const err = new Error(message);
      err.name = 'FsError';
      (err as unknown as { kind: string }).kind = kind;
      if (extras.hint !== undefined) {
        (err as unknown as { hint: string }).hint = extras.hint;
      }
      if (extras.status !== undefined) {
        (err as unknown as { status: number }).status = extras.status;
      }
      return err;
    }

    it('writeTextFile rethrows FsError as ACP RequestError with errorKind in data', async () => {
      const writeText = vi.fn(async (): Promise<WriteTextFileResponse> => {
        throw makeFsError(
          'untrusted_workspace',
          'workspace is not trusted; write operations are forbidden',
          {
            status: 403,
            hint: 'enable trust via createWorkspaceFileSystemFactory',
          },
        );
      });
      const client = makeClient({ writeText, readText: vi.fn() });

      const err = (await client
        .writeTextFile({
          path: '/x',
          content: 'y',
          sessionId: 'sess:test',
        })
        .catch((e) => e)) as Error & { code?: number; data?: unknown };

      // Reshaped as JSON-RPC RequestError (-32603 = internal error)
      // with structured data field.
      expect(err.name).toBe('RequestError');
      expect(err.code).toBe(-32603);
      expect(err.message).toContain('not trusted');
      expect(err.data).toMatchObject({
        errorKind: 'untrusted_workspace',
        status: 403,
        hint: expect.any(String),
      });
    });

    it('readTextFile rethrows FsError preserving symlink_escape kind', async () => {
      const readText = vi.fn(async (): Promise<ReadTextFileResponse> => {
        throw makeFsError(
          'symlink_escape',
          'symlink resolves outside workspace',
          { status: 400 },
        );
      });
      const client = makeClient({ writeText: vi.fn(), readText });

      const err = (await client
        .readTextFile({ path: '/x', sessionId: 'sess:test' })
        .catch((e) => e)) as Error & { code?: number; data?: unknown };

      expect(err.name).toBe('RequestError');
      expect(err.code).toBe(-32603);
      expect(err.data).toMatchObject({
        errorKind: 'symlink_escape',
        status: 400,
      });
      // No `hint` field on this FsError → not stamped (spread guard).
      expect((err.data as { hint?: unknown }).hint).toBeUndefined();
    });

    it('passes non-FsError errors through unchanged (no RequestError wrap)', async () => {
      // Plain Error → bridgeClient must NOT wrap it. Only structured
      // FsError gets the reshape. ACP's default serialization is
      // adequate for unstructured errors.
      const writeText = vi.fn(async (): Promise<WriteTextFileResponse> => {
        throw new Error('boring generic failure');
      });
      const client = makeClient({ writeText, readText: vi.fn() });

      const err = (await client
        .writeTextFile({
          path: '/x',
          content: 'y',
          sessionId: 'sess:test',
        })
        .catch((e) => e)) as Error & { code?: number; data?: unknown };

      // Original Error preserved — no JSON-RPC code stamped.
      expect(err.name).toBe('Error');
      expect(err.message).toBe('boring generic failure');
      expect(err.code).toBeUndefined();
      expect(err.data).toBeUndefined();
    });

    it('readTextFile passes non-FsError errors through unchanged (wenshao #4360 review)', async () => {
      // Symmetric guard for the read-side `preserveFsErrorOverAcp`
      // call. The write- and read-side catch blocks are independent
      // try/catch wrappers in `bridgeClient.ts`; if a future refactor
      // diverges them (e.g. adds Error-wrapping to one but not the
      // other), this test catches the read-side regression.
      const readText = vi.fn(async (): Promise<ReadTextFileResponse> => {
        throw new Error('generic read failure');
      });
      const client = makeClient({ writeText: vi.fn(), readText });

      const err = (await client
        .readTextFile({ path: '/x', sessionId: 'sess:test' })
        .catch((e) => e)) as Error & { code?: number; data?: unknown };

      expect(err.name).toBe('Error');
      expect(err.message).toBe('generic read failure');
      expect(err.code).toBeUndefined();
      expect(err.data).toBeUndefined();
    });

    it('preserves hint field when present on the FsError', async () => {
      const writeText = vi.fn(async (): Promise<WriteTextFileResponse> => {
        throw makeFsError(
          'file_too_large',
          'file of 6 MiB exceeds write cap of 5 MiB',
          { hint: 'split large writes into bounded chunks', status: 413 },
        );
      });
      const client = makeClient({ writeText, readText: vi.fn() });

      const err = (await client
        .writeTextFile({
          path: '/x',
          content: 'y',
          sessionId: 'sess:test',
        })
        .catch((e) => e)) as Error & { code?: number; data?: unknown };

      expect((err.data as { hint?: string }).hint).toBe(
        'split large writes into bounded chunks',
      );
      expect((err.data as { errorKind?: string }).errorKind).toBe(
        'file_too_large',
      );
    });

    it('does not wrap an error that LOOKS like FsError but has wrong name', async () => {
      // Defensive: an unrelated error class with a `kind` field but
      // a different `name` should fall through to the unstructured
      // path. Prevents accidental wrapping of e.g. permission errors
      // that happen to carry a `kind` discriminator.
      const writeText = vi.fn(async (): Promise<WriteTextFileResponse> => {
        const err = new Error('looks-similar');
        err.name = 'PermissionForbiddenError';
        (err as unknown as { kind: string }).kind =
          'designated_originator_mismatch';
        throw err;
      });
      const client = makeClient({ writeText, readText: vi.fn() });

      const err = (await client
        .writeTextFile({
          path: '/x',
          content: 'y',
          sessionId: 'sess:test',
        })
        .catch((e) => e)) as Error & { code?: number };

      expect(err.name).toBe('PermissionForbiddenError');
      expect(err.code).toBeUndefined();
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

describe('BridgeClient — A2UI session update publishing', () => {
  it('publishes per-surface a2ui frames before the sanitized original frame', async () => {
    const publish = vi.fn().mockReturnValue(true);
    const fakeEntry = {
      sessionId: 'sess:a2ui',
      activePromptOriginatorClientId: 'client-1',
      events: { publish },
    };
    const noPermissionFlow = () => {
      throw new Error('test: permission flow should not run');
    };
    const client = new BridgeClient(
      ((sid: string) => (sid === 'sess:a2ui' ? fakeEntry : undefined)) as never,
      noPermissionFlow as never,
      { request: noPermissionFlow } as never,
      0,
      Infinity,
    );
    const rawText =
      '[{"version":"v0.9","createSurface":{"surfaceId":"s1","components":[]}},' +
      '{"version":"v0.9","updateComponents":{"surfaceId":"s1","components":[]}},' +
      '{"version":"v0.9","updateDataModel":{"surfaceId":"s2","path":"/","value":1}}]\n' +
      'rendered fallback';

    await client.sessionUpdate({
      sessionId: 'sess:a2ui',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        _meta: { serverId: 'a2ui-ui', toolName: 'present_choices' },
        content: [
          { type: 'content', content: { type: 'text', text: rawText } },
        ],
        rawOutput: rawText,
      },
    } as Parameters<BridgeClient['sessionUpdate']>[0]);

    type PublishedFrame = {
      type: string;
      originatorClientId?: string;
      data: {
        sessionId: string;
        update: {
          sessionUpdate: string;
          a2ui?: {
            surfaceId: string;
            callId?: string;
            commands: unknown[];
          };
          content?: Array<{ content: { text: string } }>;
          rawOutput?: string;
          _meta?: { source?: string };
        };
      };
    };
    const published = publish.mock.calls.map(
      ([frame]) => frame as PublishedFrame,
    );

    expect(published).toHaveLength(3);
    expect(published[0]).toMatchObject({
      type: 'session_update',
      originatorClientId: 'client-1',
      data: {
        sessionId: 'sess:a2ui',
        update: {
          sessionUpdate: 'a2ui',
          a2ui: {
            surfaceId: 's1',
            callId: 'call-1',
          },
          _meta: { source: 'a2ui-bridge' },
        },
      },
    });
    expect(published[0].data.update.a2ui?.commands).toHaveLength(2);
    expect(published[1].data.update.a2ui).toMatchObject({
      surfaceId: 's2',
      callId: 'call-1',
    });
    expect(published[1].data.update.a2ui?.commands).toHaveLength(1);
    expect(published[2].originatorClientId).toBe('client-1');
    expect(published[2].data.update.content?.[0].content.text).toBe(
      'rendered fallback',
    );
    expect(published[2].data.update.rawOutput).toBe('rendered fallback');
    expect(JSON.stringify(published[2].data.update)).not.toContain(
      'createSurface',
    );
  });
});

describe('BridgeClient — original timestamp preservation', () => {
  const noPermissionFlow = () => {
    throw new Error('test: permission flow should not run');
  };

  function makeClientFor(sessionId: string, publish: ReturnType<typeof vi.fn>) {
    const fakeEntry = { sessionId, events: { publish } };
    return new BridgeClient(
      ((sid: string) => (sid === sessionId ? fakeEntry : undefined)) as never,
      noPermissionFlow as never,
      { request: noPermissionFlow } as never,
      0,
      Infinity,
    );
  }

  it('lifts a replayed update._meta.timestamp to the envelope serverTimestamp', async () => {
    const publish = vi.fn().mockReturnValue(true);
    const client = makeClientFor('sess:replay', publish);
    // A previous-day epoch — must survive to the envelope so EventBus does not
    // overwrite it with publish-time Date.now().
    const original = 1_700_000_000_000;

    await client.sessionUpdate({
      sessionId: 'sess:replay',
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'hi' },
        _meta: { timestamp: original },
      },
    } as Parameters<BridgeClient['sessionUpdate']>[0]);

    expect(publish).toHaveBeenCalledTimes(1);
    const frame = publish.mock.calls[0][0] as {
      _meta?: { serverTimestamp?: number };
    };
    expect(frame._meta?.serverTimestamp).toBe(original);
  });

  it('passes no envelope _meta for live updates without a timestamp', async () => {
    const publish = vi.fn().mockReturnValue(true);
    const client = makeClientFor('sess:live', publish);

    await client.sessionUpdate({
      sessionId: 'sess:live',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'yo' },
      },
    } as Parameters<BridgeClient['sessionUpdate']>[0]);

    expect(publish).toHaveBeenCalledTimes(1);
    const frame = publish.mock.calls[0][0] as {
      _meta?: { serverTimestamp?: number };
    };
    // No envelope _meta → EventBus.publish applies its own Date.now() fallback.
    expect(frame._meta).toBeUndefined();
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

/**
 * `extMethod` is the daemon's answer to the ACP child's
 * `craft/drainMidTurnQueue` call (web-shell mid-turn drain). Desktop answers
 * the same method from its own in-memory queue; in `qwen serve` the BridgeClient
 * answers it from `SessionEntry.midTurnMessageQueue`. Without this the SDK's
 * ClientSideConnection would reject the call with -32601 and the child would
 * latch the drain as unavailable for the whole session.
 */
describe('BridgeClient — mid-turn queue drain (craft/drainMidTurnQueue)', () => {
  const thrower = () => {
    throw new Error('test: permission flow should not run');
  };

  function makeClientWithEntry(
    sessionId: string,
    entry:
      | {
          sessionId: string;
          midTurnMessageQueue: MidTurnQueueEntry[];
          events: { publish: ReturnType<typeof vi.fn> };
        }
      | undefined,
  ): BridgeClient {
    return new BridgeClient(
      ((sid: string) => (sid === sessionId ? entry : undefined)) as never,
      thrower as never,
      { request: thrower } as never,
      0,
      Infinity,
    );
  }

  it('drains the queue, returns the messages, and publishes one injected frame', async () => {
    const publish = vi.fn().mockReturnValue(true);
    const entry = {
      sessionId: 'sess:drain',
      midTurnMessageQueue: [{ text: 'first' }, { text: 'second' }],
      events: { publish },
    };
    const client = makeClientWithEntry('sess:drain', entry);

    const result = await client.extMethod('craft/drainMidTurnQueue', {
      sessionId: 'sess:drain',
    });

    expect(result).toEqual({ messages: ['first', 'second'] });
    // Queue emptied so the same messages can't be re-injected on the next batch.
    expect(entry.midTurnMessageQueue).toEqual([]);
    // Exactly one SSE frame carrying the drained text for the browser to dedupe.
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0]).toMatchObject({
      type: 'mid_turn_message_injected',
      data: { sessionId: 'sess:drain', messages: ['first', 'second'] },
    });
    // Anonymous queue entries (no originator) ⇒ no `originatorClientId` on the
    // frame, so every consumer reconciles it.
    expect(publish.mock.calls[0][0].originatorClientId).toBeUndefined();
  });

  it('publishes ONE frame per originator, each carrying its own originatorClientId', async () => {
    // A mixed-originator drain (two clients pushed into the same window) must
    // route each client its own echo so a peer can't dedupe a message it did
    // not queue. Order within an originator is preserved.
    const publish = vi.fn().mockReturnValue(true);
    const entry = {
      sessionId: 'sess:multi',
      midTurnMessageQueue: [
        { text: 'a', originatorClientId: 'client-1' },
        { text: 'b', originatorClientId: 'client-2' },
        { text: 'c', originatorClientId: 'client-1' },
      ],
      events: { publish },
    };
    const client = makeClientWithEntry('sess:multi', entry);

    // The child still receives the full drained set, in queue order.
    const result = await client.extMethod('craft/drainMidTurnQueue', {
      sessionId: 'sess:multi',
    });
    expect(result).toEqual({ messages: ['a', 'b', 'c'] });
    expect(entry.midTurnMessageQueue).toEqual([]);

    // One frame per originator: client-1 gets ['a','c'], client-2 gets ['b'].
    expect(publish).toHaveBeenCalledTimes(2);
    const frames = publish.mock.calls.map((c) => c[0]);
    const c1 = frames.find((f) => f.originatorClientId === 'client-1');
    const c2 = frames.find((f) => f.originatorClientId === 'client-2');
    expect(c1).toMatchObject({
      type: 'mid_turn_message_injected',
      data: { sessionId: 'sess:multi', messages: ['a', 'c'] },
      originatorClientId: 'client-1',
    });
    expect(c2).toMatchObject({
      type: 'mid_turn_message_injected',
      data: { sessionId: 'sess:multi', messages: ['b'] },
      originatorClientId: 'client-2',
    });
  });

  it('still returns the drained messages to the child when the echo frame is dropped (bus closed)', async () => {
    // Teardown-only degradation: `publish()` returns falsy on a closed bus. The
    // child has already been handed the messages (the model sees them), but the
    // browser never gets the echo — log it so the resend-next-turn window is
    // diagnosable. The drain itself must NOT fail.
    const publish = vi.fn().mockReturnValue(undefined);
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockReturnValue(true as never);
    try {
      const entry = {
        sessionId: 'sess:closed',
        midTurnMessageQueue: [{ text: 'still-delivered' }],
        events: { publish },
      };
      const client = makeClientWithEntry('sess:closed', entry);

      const result = await client.extMethod('craft/drainMidTurnQueue', {
        sessionId: 'sess:closed',
      });

      // (a) the child still receives the message despite the dropped echo.
      expect(result).toEqual({ messages: ['still-delivered'] });
      expect(entry.midTurnMessageQueue).toEqual([]);
      // (b) the dropped-echo degradation is logged.
      const logged = stderr.mock.calls.map((c) => String(c[0])).join('');
      expect(logged).toContain('echo frame dropped (bus closed)');
    } finally {
      stderr.mockRestore();
    }
  });

  it('returns an empty drain and publishes nothing when the queue is empty', async () => {
    const publish = vi.fn().mockReturnValue(true);
    const entry = {
      sessionId: 'sess:empty',
      midTurnMessageQueue: [] as MidTurnQueueEntry[],
      events: { publish },
    };
    const client = makeClientWithEntry('sess:empty', entry);

    const result = await client.extMethod('craft/drainMidTurnQueue', {
      sessionId: 'sess:empty',
    });

    expect(result).toEqual({ messages: [] });
    expect(publish).not.toHaveBeenCalled();
  });

  it('returns an empty drain for an unknown session without throwing', async () => {
    const client = makeClientWithEntry('sess:known', undefined);
    const result = await client.extMethod('craft/drainMidTurnQueue', {
      sessionId: 'sess:absent',
    });
    expect(result).toEqual({ messages: [] });
  });

  it('short-circuits to an empty drain when no sessionId is supplied', async () => {
    // resolveEntry(undefined) throws on a multi-session channel, so extMethod
    // must answer before ever calling it when the sessionId is missing.
    const resolveThatThrowsOnUndefined = (sid?: string) => {
      if (!sid) {
        throw new Error('resolveEntry must not run without a sessionId');
      }
      return undefined;
    };
    const client = new BridgeClient(
      resolveThatThrowsOnUndefined as never,
      thrower as never,
      { request: thrower } as never,
      0,
      Infinity,
    );
    const result = await client.extMethod('craft/drainMidTurnQueue', {});
    expect(result).toEqual({ messages: [] });
  });

  it('rejects an unknown ext-method with JSON-RPC methodNotFound (-32601)', async () => {
    const client = makeClientWithEntry('sess:x', undefined);
    const err = await client
      .extMethod('craft/somethingElse', { sessionId: 'sess:x' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RequestError);
    expect((err as RequestError).code).toBe(-32601);
  });
});

/**
 * Reverse tool channel (issue #5626, Phase 2). The ACP child's session
 * `McpClientManager` routes a client-hosted (extension) MCP server's
 * `sendSdkMcpMessage` UP to the parent via the
 * `qwen/control/client_mcp/message` ext-method. `BridgeClient.extMethod`
 * answers it by reaching the per-WS-connection `ClientMcpRegistrar` (looked up
 * by `server` name through the injected `clientMcpSender`), which carries the
 * JSON-RPC frame down the daemon WS and resolves with the correlated response.
 *
 * These tests exercise the REAL `BridgeClient.extMethod` + the REAL
 * `ClientMcpRegistrar` round-trip (the child side is simulated by calling
 * `extMethod` directly with the exact param shape `acpAgent.buildClientMcpSender`
 * sends; the WS/extension side is simulated by answering frames via
 * `resolveMessage`). Server-name routing + the `{ payload }` envelope are
 * the contract this method owns.
 */
describe('BridgeClient — reverse tool channel (qwen/control/client_mcp/message)', () => {
  const thrower = () => {
    throw new Error('test: permission flow should not run');
  };

  /**
   * Build a `BridgeClient` whose `clientMcpSender` resolves `server` to a real
   * `ClientMcpRegistrar`'s sender (mirroring `ClientMcpSenderRegistry.lookup` in
   * the serve layer). The registrar pushes outbound frames to `onFrame` so the
   * test can answer them like the extension's WS would.
   */
  function makeClientWithRegistrar(registrar: ClientMcpRegistrar): BridgeClient {
    const sender: ClientMcpMessageSender = (serverName: string) =>
      registrar.hasServer(serverName)
        ? (payload: unknown) =>
            registrar.sendSdkMcpMessage(serverName, payload as JSONRPCMessage)
        : undefined;
    return new BridgeClient(
      (() => undefined) as never, // resolveEntry: client_mcp/message is sessionless
      (() => undefined) as never, // resolvePendingRestoreEvents
      { request: thrower } as never,
      0,
      Infinity,
      undefined, // fileSystem
      undefined, // onModelPromoted
      undefined, // onModePromoted
      sender, // clientMcpSender
    );
  }

  it('round-trips a JSON-RPC request through the registrar and returns { payload }', async () => {
    const outbound: ClientMcpFrame[] = [];
    const registrar = new ClientMcpRegistrar({
      sendFrame: (frame) => {
        outbound.push(frame);
      },
    });
    registrar.registerServer('chrome-tools');
    const client = makeClientWithRegistrar(registrar);

    // Simulate the child's `buildClientMcpSender` call shape exactly.
    const callP = client.extMethod('qwen/control/client_mcp/message', {
      server: 'chrome-tools',
      payload: { jsonrpc: '2.0', id: 7, method: 'tools/list' },
    });

    // The registrar put one outbound frame on the (simulated) WS — answer it
    // like the extension would, echoing the correlation id.
    await vi.waitFor(() => expect(outbound).toHaveLength(1));
    const frame = outbound[0];
    expect(frame.server).toBe('chrome-tools');
    expect(frame.payload).toMatchObject({ method: 'tools/list', id: 7 });
    registrar.resolveMessage(frame.id, {
      jsonrpc: '2.0',
      id: 7,
      result: { tools: [{ name: 'chrome_read_page' }] },
    } as JSONRPCMessage);

    const result = await callP;
    // The ext-method wraps the client-hosted reply in `{ payload }`.
    expect(result).toEqual({
      payload: {
        jsonrpc: '2.0',
        id: 7,
        result: { tools: [{ name: 'chrome_read_page' }] },
      },
    });
  });

  it('round-trips a notification (no id) as a synthetic ack envelope', async () => {
    const outbound: ClientMcpFrame[] = [];
    const registrar = new ClientMcpRegistrar({
      sendFrame: (frame) => {
        outbound.push(frame);
      },
    });
    registrar.registerServer('chrome-tools');
    const client = makeClientWithRegistrar(registrar);

    // `notifications/initialized` has no JSON-RPC id — the registrar
    // fire-and-forgets and resolves with a synthetic ack (no WS response).
    const result = await client.extMethod('qwen/control/client_mcp/message', {
      server: 'chrome-tools',
      payload: { jsonrpc: '2.0', method: 'notifications/initialized' },
    });
    expect(outbound).toHaveLength(1);
    expect((result as { payload?: unknown }).payload).toBeDefined();
  });

  it('rejects (invalidParams) when the named server is not connected', async () => {
    const registrar = new ClientMcpRegistrar({ sendFrame: () => {} });
    // No registerServer call — the lookup returns undefined.
    const client = makeClientWithRegistrar(registrar);
    const err = await client
      .extMethod('qwen/control/client_mcp/message', {
        server: 'gone',
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RequestError);
    expect((err as RequestError).code).toBe(-32602);
  });

  it('rejects (invalidParams) on a malformed frame (missing server)', async () => {
    const registrar = new ClientMcpRegistrar({ sendFrame: () => {} });
    const client = makeClientWithRegistrar(registrar);
    const err = await client
      .extMethod('qwen/control/client_mcp/message', {
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RequestError);
    expect((err as RequestError).code).toBe(-32602);
  });

  it('rejects (methodNotFound) when no clientMcpSender is wired (Mode A / tests)', async () => {
    // The default 5-arg construction omits the sender entirely.
    const client = new BridgeClient(
      (() => undefined) as never,
      (() => undefined) as never,
      { request: thrower } as never,
      0,
      Infinity,
    );
    const err = await client
      .extMethod('qwen/control/client_mcp/message', {
        server: 'chrome-tools',
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RequestError);
    expect((err as RequestError).code).toBe(-32601);
  });
});
