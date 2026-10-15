/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionWriterLease } from '../services/session-writer-lease.js';
import { LocalManagedSessionResourceStore } from './managed-session-resources.js';
import type { ManagedSessionKey } from './managed-session-records.js';
import {
  isToolResultManifestSuccessor,
  parseToolResultManifest,
  type ToolResultManifest,
  type ToolResultPage,
  type ToolResultStoreOutcome,
} from './managed-tool-result.js';
import { LocalToolResultSegmentStore } from './local-managed-tool-result-store.js';
import type { ToolResultExpectedIdentity } from './managed-tool-result-store.js';

type Bytes =
  | { readonly base64: string }
  | { readonly fill: { readonly byte: number; readonly length: number } };

interface Step {
  readonly op: 'publish' | 'seal' | 'prefix';
  readonly request: Record<string, unknown>;
  readonly expected: ToolResultStoreOutcome<unknown>;
}

interface Fixtures {
  readonly segmentSequences: ReadonlyArray<{
    readonly id: string;
    readonly steps: readonly Step[];
  }>;
  readonly manifest: unknown;
  readonly pages: readonly unknown[];
  readonly stdout: Bytes;
}

const fixtures = JSON.parse(
  await fs.readFile(
    fileURLToPath(
      new URL(
        './contracts/managed-tool-result-v1.fixtures.json',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
) as Fixtures;

const helperPath = fileURLToPath(
  new URL('./local-managed-tool-result-store.test-helper.ts', import.meta.url),
);
const children = new Set<ChildProcess>();
let childRequestId = 0;

function startChild(): ChildProcess {
  const child = fork(helperPath, [], {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  children.add(child);
  child.once('close', () => children.delete(child));
  return child;
}

async function childCommand(
  child: ChildProcess,
  command: Record<string, unknown>,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const id = ++childRequestId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('child command timed out')),
      15_000,
    );
    const receive = (response: {
      id: number;
      ok: boolean;
      result?: unknown;
      error?: string;
    }) => {
      if (response.id !== id) return;
      clearTimeout(timer);
      child.off('message', receive);
      resolve(response);
    };
    child.on('message', receive);
    child.send({ ...command, id }, (error) => {
      if (!error) return;
      clearTimeout(timer);
      child.off('message', receive);
      reject(error);
    });
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) =>
    child.once('close', () => resolve()),
  );
  child.kill('SIGKILL');
  await closed;
}

const sessionKey: ManagedSessionKey = {
  tenantId: 'tenant-a',
  workspaceId: 'workspace-a',
  sessionId: 'session-a',
};

const roots = new Set<string>();
const opened = new Set<{
  store: LocalToolResultSegmentStore;
  lease: SessionWriterLease;
}>();

afterEach(async () => {
  await Promise.all([...children].map(stopChild));
  for (const { store, lease } of opened) {
    await store.close();
    await lease.release();
  }
  opened.clear();
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
  roots.clear();
});

async function harness(key = sessionKey) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'qwen-tool-result-o1b-'),
  );
  roots.add(root);
  const runtimeBaseDir = path.join(root, 'runtime');
  const transcriptPath = path.join(
    runtimeBaseDir,
    'chats',
    `${key.sessionId}.jsonl`,
  );
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  const lease = await SessionWriterLease.acquire({
    runtimeBaseDir,
    sessionId: key.sessionId,
    transcriptPath,
  });
  const store = await LocalToolResultSegmentStore.openWritable({
    lease,
    sessionKey: key,
  });
  const item = { root, runtimeBaseDir, transcriptPath, lease, store };
  opened.add(item);
  return item;
}

function bytesOf(value: Bytes): Buffer {
  return 'base64' in value
    ? Buffer.from(value.base64, 'base64')
    : Buffer.alloc(value.fill.length, value.fill.byte);
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function identityOf(manifest: ToolResultManifest): ToolResultExpectedIdentity {
  const {
    tenantId,
    sessionId,
    turnId,
    executionCallId,
    callId,
    invocationDigest,
    bindingGeneration,
    captureId,
    revision,
  } = manifest;
  return {
    tenantId,
    sessionId,
    turnId,
    executionCallId,
    callId,
    invocationDigest,
    bindingGeneration,
    captureId,
    revision,
  };
}

describe('local managed tool-result segments', () => {
  it.each(fixtures.segmentSequences)('replays $id', async ({ steps }) => {
    const { store } = await harness();
    for (const step of steps) {
      const request =
        step.op === 'publish'
          ? {
              ...step.request,
              bytes: bytesOf(step.request['bytes'] as Bytes),
            }
          : step.request;
      expect(await store[step.op](request)).toStrictEqual(step.expected);
    }
  });

  it('reads fixed manifest revisions across pages and binary boundaries', async () => {
    const { store, runtimeBaseDir } = await harness();
    const resources = LocalManagedSessionResourceStore.create({
      runtimeBaseDir,
      sessionKey,
    });
    const stdout = bytesOf(fixtures.stdout);
    let position = 0;
    for (const [ordinal, size] of [3, 2, 4].entries()) {
      expect(
        await store.publish({
          captureId: 'capture-01',
          streamId: 'stdout',
          ordinal,
          bytes: stdout.subarray(position, position + size),
        }),
      ).toMatchObject({ status: 'ok' });
      position += size;
    }
    expect(
      await store.seal({
        captureId: 'capture-01',
        streamId: 'stdout',
        segmentCount: 3,
        byteLength: stdout.byteLength,
        digest: digest(stdout),
      }),
    ).toMatchObject({ status: 'ok' });
    const pages = fixtures.pages.map((raw) => raw as ToolResultPage);
    const pageRefs = await Promise.all(
      pages.map(async (page) => {
        const bytes = Buffer.from(JSON.stringify(page));
        return {
          ref: await resources.publish('managed-tool-result-page', bytes),
          segmentCount: page.segments.length,
          byteLength: page.segments.reduce(
            (total, segment) => total + segment.byteLength,
            0,
          ),
        };
      }),
    );
    const base = parseToolResultManifest(fixtures.manifest);
    const first = base.contents[0];
    const initial: ToolResultManifest = {
      ...base,
      revision: 1,
      captureStatus: 'pending',
      contents: [
        {
          ...first,
          state: 'open',
          byteLength: 5,
          digest: digest(stdout.subarray(0, 5)),
          body: { pages: pageRefs.slice(0, 1) },
        },
        ...base.contents.slice(1),
      ],
    };
    const final: ToolResultManifest = {
      ...base,
      contents: [
        { ...first, body: { pages: pageRefs } },
        ...base.contents.slice(1),
      ],
    };
    expect(isToolResultManifestSuccessor(initial, final)).toBe(true);
    const oldRef = await resources.publish(
      'managed-tool-result-manifest',
      Buffer.from(JSON.stringify(initial)),
    );
    const finalRef = await resources.publish(
      'managed-tool-result-manifest',
      Buffer.from(JSON.stringify(final)),
    );
    const reader = await LocalToolResultSegmentStore.openReadOnly({
      runtimeBaseDir,
      sessionKey,
    });
    expect(
      await reader.readRange({
        manifestRef: oldRef,
        expectedIdentity: identityOf(initial),
        streamId: 'stdout',
        offset: 1,
        length: 4,
      }),
    ).toEqual({ status: 'ok', result: stdout.subarray(1, 5) });
    await reader.close();
    expect(
      await store.readRange({
        manifestRef: finalRef,
        expectedIdentity: identityOf(final),
        streamId: 'stdout',
        offset: 1,
        length: 7,
      }),
    ).toEqual({ status: 'ok', result: stdout.subarray(1, 8) });
    expect(
      await store.readRange({
        manifestRef: oldRef,
        expectedIdentity: identityOf(initial),
        streamId: 'stdout',
        offset: 5,
        length: 0,
      }),
    ).toEqual({ status: 'ok', result: Buffer.alloc(0) });
    expect(
      await store.readRange({
        manifestRef: oldRef,
        expectedIdentity: identityOf(initial),
        streamId: 'stdout',
        offset: 5,
        length: 1,
      }),
    ).toEqual({ status: 'refused', code: 'managed_tool_result_invalid' });
    expect(
      await store.readRange({
        manifestRef: finalRef,
        expectedIdentity: identityOf(final),
        streamId: 'stdout',
        offset: 0,
        length: 16 * 1024 * 1024 + 1,
      }),
    ).toEqual({ status: 'refused', code: 'managed_tool_result_invalid' });
    expect(
      await store.readRange({
        manifestRef: finalRef,
        expectedIdentity: { ...identityOf(final), callId: 'foreign' },
        streamId: 'stdout',
        offset: 0,
        length: 1,
      }),
    ).toEqual({ status: 'refused', code: 'managed_tool_result_conflict' });

    const shifted = { ...pages[0], offset: 1 };
    const shiftedRef = await resources.publish(
      'managed-tool-result-page',
      Buffer.from(JSON.stringify(shifted)),
    );
    const wrongPage = {
      ...initial,
      contents: [
        {
          ...initial.contents[0],
          body: { pages: [{ ...pageRefs[0], ref: shiftedRef }] },
        },
        ...initial.contents.slice(1),
      ],
    };
    const wrongPageRef = await resources.publish(
      'managed-tool-result-manifest',
      Buffer.from(JSON.stringify(wrongPage)),
    );
    expect(
      await store.readRange({
        manifestRef: wrongPageRef,
        expectedIdentity: identityOf(initial),
        streamId: 'stdout',
        offset: 1,
        length: 1,
      }),
    ).toEqual({ status: 'refused', code: 'managed_tool_result_conflict' });

    const changedDigestPage = {
      ...pages[0],
      segments: [
        { ...pages[0].segments[0], digest: digest(Buffer.from('wrong')) },
        ...pages[0].segments.slice(1),
      ],
    };
    const changedDigestRef = await resources.publish(
      'managed-tool-result-page',
      Buffer.from(JSON.stringify(changedDigestPage)),
    );
    const changedDigestManifest: ToolResultManifest = {
      ...initial,
      contents: [
        {
          ...initial.contents[0],
          body: { pages: [{ ...pageRefs[0], ref: changedDigestRef }] },
        },
        ...initial.contents.slice(1),
      ],
    };
    const changedDigestManifestRef = await resources.publish(
      'managed-tool-result-manifest',
      Buffer.from(JSON.stringify(changedDigestManifest)),
    );
    expect(
      await store.readRange({
        manifestRef: changedDigestManifestRef,
        expectedIdentity: identityOf(initial),
        streamId: 'stdout',
        offset: 0,
        length: 1,
      }),
    ).toEqual({
      status: 'refused',
      code: 'managed_tool_result_digest_mismatch',
    });

    const segment = path.join(
      store.root,
      'capture-capture-01',
      'stream-stdout',
      'segment-00001',
      'bytes',
    );
    await fs.writeFile(segment, Buffer.from('XX'));
    expect(
      await store.readRange({
        manifestRef: finalRef,
        expectedIdentity: identityOf(final),
        streamId: 'stdout',
        offset: 3,
        length: 1,
      }),
    ).toEqual({
      status: 'refused',
      code: 'managed_tool_result_digest_mismatch',
    });
    await expect(
      fs.stat(path.join(path.dirname(path.dirname(segment)), 'corrupt-00001')),
    ).resolves.toBeDefined();
    await fs.rm(
      path.join(
        store.root,
        'capture-capture-01',
        'stream-stdout',
        'segment-00002',
      ),
      { recursive: true },
    );
    expect(
      await store.readRange({
        manifestRef: finalRef,
        expectedIdentity: identityOf(final),
        streamId: 'stdout',
        offset: 6,
        length: 1,
      }),
    ).toEqual({
      status: 'refused',
      code: 'managed_tool_result_digest_mismatch',
    });
  });

  it('streams validation for a whole-content ref and keeps only the range', async () => {
    const { store, runtimeBaseDir } = await harness();
    const resources = LocalManagedSessionResourceStore.create({
      runtimeBaseDir,
      sessionKey,
    });
    const content = Buffer.alloc(1024 * 1024, 0xff);
    const contentRef = await resources.publish(
      'managed-tool-result-content',
      content,
    );
    const base = parseToolResultManifest(fixtures.manifest);
    const manifest: ToolResultManifest = {
      ...base,
      contents: [
        {
          streamId: 'native',
          role: 'result',
          mimeType: 'application/octet-stream',
          state: 'sealed',
          byteLength: content.byteLength,
          digest: digest(content),
          missingRanges: [],
          body: { ref: contentRef },
        },
      ],
    };
    const manifestRef = await resources.publish(
      'managed-tool-result-manifest',
      Buffer.from(JSON.stringify(manifest)),
    );
    expect(
      await store.readRange({
        manifestRef,
        expectedIdentity: identityOf(manifest),
        streamId: 'native',
        offset: 65530,
        length: 20,
      }),
    ).toEqual({ status: 'ok', result: Buffer.alloc(20, 0xff) });
    const reader = await LocalToolResultSegmentStore.openReadOnly({
      runtimeBaseDir,
      sessionKey,
    });
    let finished = false;
    const pending = reader
      .readRange({
        manifestRef,
        expectedIdentity: identityOf(manifest),
        streamId: 'native',
        offset: 65530,
        length: 20,
      })
      .then((result) => {
        finished = true;
        return result;
      });
    await reader.close();
    expect(finished).toBe(true);
    expect(await pending).toEqual({
      status: 'ok',
      result: Buffer.alloc(20, 0xff),
    });
  });

  it('reopens a sealed stream and enforces owner scope', async () => {
    const item = await harness();
    const request = {
      captureId: 'capture-01',
      streamId: 'stdout',
      ordinal: 0,
      bytes: Buffer.from('durable'),
    };
    const result = await item.store.publish(request);
    expect(result.status).toBe('ok');
    await item.store.close();
    await item.lease.release();
    opened.delete(item);
    const newLease = await SessionWriterLease.acquire({
      runtimeBaseDir: item.runtimeBaseDir,
      sessionId: sessionKey.sessionId,
      transcriptPath: item.transcriptPath,
    });
    const reopened = await LocalToolResultSegmentStore.openWritable({
      lease: newLease,
      sessionKey,
    });
    opened.add({ store: reopened, lease: newLease });
    expect(await reopened.publish(request)).toEqual(result);
    expect(
      await reopened.seal({
        captureId: 'capture-01',
        streamId: 'stdout',
        segmentCount: 1,
        byteLength: 7,
        digest: digest(request.bytes),
      }),
    ).toMatchObject({ status: 'ok' });
    await expect(
      LocalToolResultSegmentStore.openReadOnly({
        runtimeBaseDir: item.runtimeBaseDir,
        sessionKey: { ...sessionKey, tenantId: 'other' },
      }),
    ).rejects.toThrow(/owner does not match/);
    await expect(
      LocalToolResultSegmentStore.openWritable({ lease: newLease, sessionKey }),
    ).rejects.toThrow(/writer already open/);
  });

  it('rejects a lease for a different Session and checks it on every operation', async () => {
    const { store, transcriptPath } = await harness();
    const { lease: otherLease } = await harness({
      ...sessionKey,
      sessionId: 'session-b',
    });
    await expect(
      LocalToolResultSegmentStore.openWritable({
        lease: otherLease,
        sessionKey,
      }),
    ).rejects.toThrow(/lease belongs to another Session/);
    await fs.writeFile(transcriptPath, 'changed outside the writer');
    await expect(
      store.publish({
        captureId: 'capture',
        streamId: 'stdout',
        ordinal: 0,
        bytes: Buffer.from('blocked'),
      }),
    ).rejects.toThrow(/session transcript changed/i);
  });

  it('recovers staged, unacknowledged published, and unacknowledged sealed states across processes', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-tool-result-process-'),
    );
    roots.add(root);
    const runtimeBaseDir = path.join(root, 'runtime');
    const transcriptPath = path.join(
      runtimeBaseDir,
      'chats',
      `${sessionKey.sessionId}.jsonl`,
    );
    await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
    const open = { type: 'open', runtimeBaseDir, transcriptPath, sessionKey };
    const published = {
      type: 'publish',
      captureId: 'crash',
      streamId: 'stdout',
      ordinal: 0,
      base64: Buffer.from('durable').toString('base64'),
    };
    const first = startChild();
    expect(await childCommand(first, open)).toMatchObject({ ok: true });
    expect(
      await childCommand(first, {
        type: 'staging',
        captureId: 'crash',
        streamId: 'stdout',
      }),
    ).toMatchObject({ ok: true });
    await stopChild(first);

    const second = startChild();
    expect(await childCommand(second, open)).toMatchObject({ ok: true });
    expect(await childCommand(second, published)).toMatchObject({
      ok: true,
      result: { status: 'ok' },
    });
    const lostReply = { ...published, type: 'publishWithoutReply', ordinal: 1 };
    const closed = new Promise<void>((resolve) =>
      second.once('close', () => resolve()),
    );
    second.send({ ...lostReply, id: ++childRequestId });
    await closed;

    const third = startChild();
    expect(await childCommand(third, open)).toMatchObject({ ok: true });
    const same = await childCommand(third, { ...published, ordinal: 1 });
    expect(same).toMatchObject({
      ok: true,
      result: { status: 'ok', result: { ordinal: 1 } },
    });
    await stopChild(third);

    const lease = await SessionWriterLease.acquire({
      runtimeBaseDir,
      sessionId: sessionKey.sessionId,
      transcriptPath,
    });
    const store = await LocalToolResultSegmentStore.openWritable({
      lease,
      sessionKey,
    });
    opened.add({ store, lease });
    expect(
      await store.prefix({ captureId: 'crash', streamId: 'stdout' }),
    ).toMatchObject({
      status: 'ok',
      result: { segmentCount: 2, sealed: false },
    });
    await store.close();
    await lease.release();
    opened.clear();

    const fourth = startChild();
    expect(await childCommand(fourth, open)).toMatchObject({ ok: true });
    const seal = {
      type: 'sealWithoutReply',
      captureId: 'crash',
      streamId: 'stdout',
      segmentCount: 2,
      byteLength: 14,
      digest: digest(Buffer.from('durabledurable')),
    };
    const sealedClose = new Promise<void>((resolve) =>
      fourth.once('close', () => resolve()),
    );
    fourth.send({ ...seal, id: ++childRequestId });
    await sealedClose;
    const readOnly = await LocalToolResultSegmentStore.openReadOnly({
      runtimeBaseDir,
      sessionKey,
    });
    expect(
      await readOnly.prefix({ captureId: 'crash', streamId: 'stdout' }),
    ).toMatchObject({
      status: 'ok',
      result: { segmentCount: 2, sealed: true },
    });
    await readOnly.close();
  }, 60_000);

  it('rejects corrupted published bytes without replacing an ordinal', async () => {
    const { store } = await harness();
    const request = {
      captureId: 'capture-01',
      streamId: 'stdout',
      ordinal: 0,
      bytes: Buffer.from('original'),
    };
    expect((await store.publish(request)).status).toBe('ok');
    const segment = path.join(
      store.root,
      'capture-capture-01',
      'stream-stdout',
      'segment-00000',
      'bytes',
    );
    await fs.writeFile(segment, 'tampered');
    expect(await store.publish(request)).toEqual({
      status: 'refused',
      code: 'managed_tool_result_digest_mismatch',
    });
    expect(await fs.readFile(segment, 'utf8')).toBe('tampered');
    await expect(
      fs.stat(path.join(path.dirname(path.dirname(segment)), 'corrupt-00000')),
    ).resolves.toBeDefined();
  });

  it('keeps a conflicting candidate isolated from the original segment', async () => {
    const { store } = await harness();
    const original = {
      captureId: 'capture',
      streamId: 'stdout',
      ordinal: 0,
      bytes: Buffer.from('original'),
    };
    expect((await store.publish(original)).status).toBe('ok');
    expect(
      await store.publish({ ...original, bytes: Buffer.from('different') }),
    ).toEqual({ status: 'refused', code: 'managed_tool_result_conflict' });
    const stream = path.join(store.root, 'capture-capture', 'stream-stdout');
    const names = await fs.readdir(stream);
    expect(names.filter((name) => name.startsWith('quarantine-'))).toHaveLength(
      1,
    );
    expect(
      await fs.readFile(path.join(stream, 'segment-00000', 'bytes'), 'utf8'),
    ).toBe('original');
    expect(
      (await store.prefix({ captureId: 'capture', streamId: 'stdout' })).status,
    ).toBe('ok');
  });

  it('does not replace a missing acknowledged segment or stream', async () => {
    const { store } = await harness();
    const request = {
      captureId: 'capture',
      streamId: 'stdout',
      ordinal: 0,
      bytes: Buffer.from('original'),
    };
    expect((await store.publish(request)).status).toBe('ok');
    const stream = path.join(store.root, 'capture-capture', 'stream-stdout');
    await fs.rm(path.join(stream, 'segment-00000'), { recursive: true });
    expect(
      await store.publish({ ...request, bytes: Buffer.from('different') }),
    ).toEqual({
      status: 'refused',
      code: 'managed_tool_result_digest_mismatch',
    });
    await expect(
      fs.stat(path.join(stream, 'corrupt-00000')),
    ).resolves.toBeDefined();
    await fs.rm(stream, { recursive: true });
    expect(
      await store.prefix({ captureId: 'capture', streamId: 'stdout' }),
    ).toEqual({
      status: 'refused',
      code: 'managed_tool_result_digest_mismatch',
    });
    expect(await store.publish(request)).toEqual({
      status: 'refused',
      code: 'managed_tool_result_digest_mismatch',
    });
    await expect(fs.stat(stream)).rejects.toMatchObject({ code: 'ENOENT' });
    const capture = path.dirname(stream);
    await fs.rm(capture, { recursive: true });
    expect(
      await store.publish({ ...request, bytes: Buffer.from('replacement') }),
    ).toEqual({
      status: 'refused',
      code: 'managed_tool_result_digest_mismatch',
    });
    await expect(fs.stat(capture)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not forget an acknowledged seal when its directory is removed', async () => {
    const { store } = await harness();
    const bytes = Buffer.from('original');
    expect(
      (
        await store.publish({
          captureId: 'capture',
          streamId: 'stdout',
          ordinal: 0,
          bytes,
        })
      ).status,
    ).toBe('ok');
    const seal = {
      captureId: 'capture',
      streamId: 'stdout',
      segmentCount: 1,
      byteLength: bytes.byteLength,
      digest: digest(bytes),
    };
    expect((await store.seal(seal)).status).toBe('ok');
    await fs.rm(
      path.join(store.root, 'capture-capture', 'stream-stdout', 'seal'),
      { recursive: true },
    );
    expect(
      await store.prefix({ captureId: 'capture', streamId: 'stdout' }),
    ).toEqual({
      status: 'refused',
      code: 'managed_tool_result_digest_mismatch',
    });
    expect(await store.seal(seal)).toEqual({
      status: 'refused',
      code: 'managed_tool_result_digest_mismatch',
    });
    expect(
      await store.publish({
        captureId: 'capture',
        streamId: 'stdout',
        ordinal: 1,
        bytes: Buffer.from('later'),
      }),
    ).toEqual({
      status: 'refused',
      code: 'managed_tool_result_digest_mismatch',
    });
  });

  it('does not seal past an acknowledged tail segment whose directory vanished', async () => {
    const { store } = await harness();
    const request = { captureId: 'capture', streamId: 'stdout' };
    for (let ordinal = 0; ordinal < 3; ordinal++) {
      expect(
        (
          await store.publish({
            ...request,
            ordinal,
            bytes: Buffer.from(String(ordinal)),
          })
        ).status,
      ).toBe('ok');
    }
    await fs.rm(
      path.join(
        store.root,
        'capture-capture',
        'stream-stdout',
        'segment-00002',
      ),
      { recursive: true },
    );
    expect(
      await store.seal({
        ...request,
        segmentCount: 2,
        byteLength: 2,
        digest: digest(Buffer.from('01')),
      }),
    ).toEqual({ status: 'refused', code: 'managed_tool_result_conflict' });
    await expect(
      fs.stat(
        path.join(store.root, 'capture-capture', 'stream-stdout', 'seal'),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('copies queued bytes and drains accepted work before close', async () => {
    const { store } = await harness();
    const bytes = Buffer.from('before');
    const first = store.publish({
      captureId: 'capture',
      streamId: 'stdout',
      ordinal: 0,
      bytes,
    });
    bytes.fill(0x61);
    const second = store.prefix({ captureId: 'capture', streamId: 'stdout' });
    const closing = store.close();
    expect(await first).toMatchObject({
      status: 'ok',
      result: { digest: digest(Buffer.from('before')) },
    });
    expect(await second).toMatchObject({
      status: 'ok',
      result: { segmentCount: 1 },
    });
    await closing;
    await expect(
      store.publish({
        captureId: 'capture',
        streamId: 'stdout',
        ordinal: 1,
        bytes: Buffer.from('later'),
      }),
    ).rejects.toThrow(/not writable/);
    expect(
      await fs.readFile(
        path.join(
          store.root,
          'capture-capture',
          'stream-stdout',
          'segment-00000',
          'bytes',
        ),
        'utf8',
      ),
    ).toBe('before');
  });

  it('serializes concurrent tool submissions through one writable handle', async () => {
    const { store } = await harness();
    const requests = Array.from({ length: 4 }, (_, index) => ({
      captureId: `capture-${index}`,
      streamId: 'stdout',
      ordinal: 0,
      bytes: Buffer.from(`tool-${index}`),
    }));
    const results = await Promise.all(
      requests.map((request) => store.publish(request)),
    );
    expect(results.every((result) => result.status === 'ok')).toBe(true);
    for (const request of requests) {
      expect(
        await store.prefix({
          captureId: request.captureId,
          streamId: request.streamId,
        }),
      ).toMatchObject({
        status: 'ok',
        result: { segmentCount: 1, byteLength: request.bytes.byteLength },
      });
    }
  });

  it('allows parallel read-only handles and rejects another workspace owner', async () => {
    const { store, runtimeBaseDir } = await harness();
    const first = await LocalToolResultSegmentStore.openReadOnly({
      runtimeBaseDir,
      sessionKey,
    });
    const second = await LocalToolResultSegmentStore.openReadOnly({
      runtimeBaseDir,
      sessionKey,
    });
    expect(
      await first.prefix({ captureId: 'absent', streamId: 'stdout' }),
    ).toMatchObject({ status: 'ok', result: { segmentCount: 0 } });
    expect(
      await second.prefix({ captureId: 'absent', streamId: 'stdout' }),
    ).toMatchObject({ status: 'ok', result: { segmentCount: 0 } });
    await first.close();
    await second.close();
    await expect(
      LocalToolResultSegmentStore.openReadOnly({
        runtimeBaseDir,
        sessionKey: { ...sessionKey, workspaceId: 'other' },
      }),
    ).rejects.toThrow(/owner does not match/);
    expect(store.root).toContain('managed-tool-result-segments-v1');
  });

  it('rejects a symlinked namespace parent', async () => {
    const { store, root } = await harness();
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(store.root, 'capture-linked'), 'dir');
    await expect(
      store.publish({
        captureId: 'linked',
        streamId: 'stdout',
        ordinal: 0,
        bytes: Buffer.from('data'),
      }),
    ).rejects.toThrow(/not private/);
    await expect(
      store.prefix({ captureId: 'linked', streamId: 'stdout' }),
    ).rejects.toThrow(/not private/);
  });

  it('publishes a 100 MiB or 1 GiB stream without retaining its chunks', async () => {
    const { store } = await harness();
    const count = process.env['O1B_STRESS'] === '1' ? 256 : 25;
    const size = 4 * 1024 * 1024;
    const expected = createHash('sha256');
    let peakRss = process.memoryUsage().rss;
    const initialBuffers = process.memoryUsage().arrayBuffers;
    let peakBuffers = initialBuffers;
    for (let ordinal = 0; ordinal < count; ordinal++) {
      const chunk = Buffer.alloc(size, ordinal % 251);
      expected.update(chunk);
      expect(
        (
          await store.publish({
            captureId: 'large',
            streamId: 'stdout',
            ordinal,
            bytes: chunk,
          })
        ).status,
      ).toBe('ok');
      const usage = process.memoryUsage();
      peakRss = Math.max(peakRss, usage.rss);
      peakBuffers = Math.max(peakBuffers, usage.arrayBuffers);
    }
    const sealed = await store.seal({
      captureId: 'large',
      streamId: 'stdout',
      segmentCount: count,
      byteLength: count * size,
      digest: expected.digest('hex'),
    });
    expect(sealed.status).toBe('ok');
    const result = await store.prefix({
      captureId: 'large',
      streamId: 'stdout',
    });
    expect(result).toMatchObject({
      status: 'ok',
      result: { segmentCount: count, byteLength: count * size, sealed: true },
    });
    expect(peakBuffers - initialBuffers).toBeLessThan(80 * 1024 * 1024);
    if (process.env['O1B_METRICS_PATH']) {
      await fs.writeFile(
        process.env['O1B_METRICS_PATH'],
        JSON.stringify({ byteLength: count * size, peakRss, peakBuffers }),
      );
    }
  }, 180_000);
});
