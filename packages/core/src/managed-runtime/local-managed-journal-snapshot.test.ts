/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getSessionWriterLockPath,
  SessionWriterLease,
} from '../services/session-writer-lease.js';
import { Storage } from '../config/storage.js';
import { SessionService } from '../services/sessionService.js';
import {
  localManagedSessionKey,
  isManagedSessionTranscriptSync,
  isManagedExecutionTranscriptSync,
  readManagedSessionTitleInfoSync,
} from '../utils/sessionStorageUtils.js';
import { LocalJsonlManagedSessionJournalStore } from './local-jsonl-managed-session-journal-store.js';
import { LocalManagedSessionAuthority } from './managed-session-authority.js';
import { openManagedSession } from './managed-session-assembly.js';
import { LocalManagedSessionResourceStore } from './managed-session-resources.js';
import { encodeChannelInputEnvelope } from './managed-channel-operations.js';
import {
  LOCAL_MANAGED_SNAPSHOT_BASE,
  LOCAL_MANAGED_SNAPSHOT_KIND,
  LOCAL_MANAGED_SNAPSHOT_PAGE_KIND,
  parseLocalJournalBase,
  readLocalJournalBytes,
  readLocalJournalManifest,
} from './local-managed-journal-snapshot.js';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
}));

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
const digest = (text: string) =>
  createHash('sha256').update(text).digest('hex');

async function fixture(ownershipPadding = 0) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-local-snapshot-'));
  roots.push(root);
  const runtimeBaseDir = path.join(root, 'runtime');
  const project = path.join(root, 'project');
  await fs.mkdir(project, { recursive: true });
  const sessionId = randomUUID();
  const sessionKey = localManagedSessionKey(project, sessionId);
  const transcriptPath = path.join(
    new Storage(project, runtimeBaseDir).getProjectDir(),
    'chats',
    `${sessionId}.jsonl`,
  );
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  if (ownershipPadding) {
    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({
        version: 'x'.repeat(ownershipPadding),
        uuid: randomUUID(),
        parentUuid: null,
        sessionId,
        type: 'system',
        subtype: 'session_execution_engine',
        cwd: project,
        systemPayload: { version: 1, engine: 'managed' },
      })}\n`,
    );
  }
  const options = { runtimeBaseDir, transcriptPath, sessionId };
  const resources = LocalManagedSessionResourceStore.create({
    runtimeBaseDir,
    sessionKey,
  });
  const create = {
    definitionRef: await resources.publish(
      'managed-session-definition',
      Buffer.from('{}'),
    ),
    rootSnapshotRef: await resources.publish(
      'managed-session-root-snapshot',
      Buffer.from('{}'),
    ),
    createdBy: 'snapshot-test',
  };
  const input = {
    inputId: 'input-1',
    turnId: 'turn-1',
    source: 'web_shell',
    contentRef: await resources.publish(
      'managed-test',
      Buffer.from('中文 input'),
    ),
    admissionRef: await resources.publish(
      'managed-test',
      Buffer.from('admission'),
    ),
    deadline: null,
    wakeReason: 'input',
  };
  const command = (id: string) => ({
    sessionKey,
    commandId: id,
    operation: 'submitInput',
    contentDigest: digest(id),
  });
  const open = async (isNew = false) => {
    const journal = await new LocalJsonlManagedSessionJournalStore(
      options,
    ).open({ sessionKey });
    const authority = await LocalManagedSessionAuthority.open({
      journal,
      sessionKey,
      resources,
      cwd: project,
      version: 'test',
      ...(isNew ? { create } : {}),
      ...(journal.takeoverCommitProof
        ? { expectedCommitProof: journal.takeoverCommitProof }
        : {}),
    });
    return { journal, authority };
  };
  const first = await open(true);
  const receipt = await first.authority.submitInput(command('input'), input);
  return {
    ...options,
    root,
    project,
    sessionKey,
    resources,
    first,
    open,
    input,
    command,
    receipt,
  };
}

async function snapshot(f: Awaited<ReturnType<typeof fixture>>) {
  const bytes = await fs.readFile(f.transcriptPath);
  const base = parseLocalJournalBase(bytes, f.sessionKey)!;
  expect(base).toBeDefined();
  return {
    bytes,
    base,
    manifest: readLocalJournalManifest(
      f.runtimeBaseDir,
      f.sessionKey,
      base.manifest,
    ),
  };
}

async function countSnapshots(f: Awaited<ReturnType<typeof fixture>>) {
  return (
    await fs.readdir(
      path.join(f.resources.sessionRoot, LOCAL_MANAGED_SNAPSHOT_KIND),
    )
  ).length;
}

describe('local native journal snapshots', () => {
  it('converts only sealed resume, preserves original bytes and command replay, then never rotates', async () => {
    const f = await fixture();
    const original = await fs.readFile(f.transcriptPath);
    expect(original.includes(LOCAL_MANAGED_SNAPSHOT_BASE)).toBe(false);
    await f.first.authority.close();
    await LocalJsonlManagedSessionJournalStore.read({
      ...f,
      sessionKey: f.sessionKey,
    });
    expect(await fs.readFile(f.transcriptPath)).toEqual(original);
    const resumed = await f.open();
    const { bytes, manifest } = await snapshot(f);
    expect(bytes.includes('managed-session/2')).toBe(true);
    expect(bytes.equals(original)).toBe(false);
    expect(
      Buffer.concat(
        await Promise.all(manifest.pages.map((ref) => f.resources.read(ref))),
      ),
    ).toEqual(original);
    expect(
      (await resumed.authority.submitInput(f.command('input'), f.input))
        .transactionId,
    ).toBe(f.receipt.transactionId);
    await expect(
      resumed.authority.submitInput(
        { ...f.command('input'), contentDigest: digest('conflict') },
        f.input,
      ),
    ).rejects.toThrow(/different content/);
    await resumed.authority.submitInput(f.command('tail'), {
      ...f.input,
      inputId: 'tail',
      turnId: 'tail',
    });
    const proof = resumed.authority.commitProof;
    await resumed.authority.close();
    const second = await f.open();
    expect(second.authority.commitProof).toEqual(proof);
    expect(await countSnapshots(f)).toBe(1);
    await second.authority.close();
  });

  it('keeps frozen offsets physical and truncates only an uncommitted tail', async () => {
    const f = await fixture();
    await f.first.authority.close();
    const resumed = await f.open();
    const frozen = (await fs.stat(f.transcriptPath)).size;
    await resumed.authority.submitInput(f.command('tail'), {
      ...f.input,
      inputId: 'tail',
      turnId: 'tail',
    });
    const historical = await LocalJsonlManagedSessionJournalStore.read({
      ...f,
      maxBytes: frozen,
    });
    expect(historical.committed).toBe(f.receipt.committedSequence);
    expect(historical.committedBytes).toBe(frozen);
    const before = await fs.readFile(f.transcriptPath);
    const committed = await resumed.journal.read();
    const event = {
      ...committed.events[0],
      sequence: committed.committed + 1,
      eventId: 'uncommitted',
      payload: {
        ...committed.events[0].payload,
        contentRef: {
          ...f.input.contentRef,
          resourceId: 'uncommitted-missing',
        },
      },
    };
    await resumed.journal.appendTransaction([
      {
        uuid: randomUUID(),
        subtype: 'managed_session_event_v1',
        managedSession: event,
      },
    ]);
    expect((await resumed.journal.read()).uncommitted).toBe(1);
    await resumed.journal.recoverUncommittedTail();
    expect(await fs.readFile(f.transcriptPath)).toEqual(before);
    await resumed.authority.close();
  });

  it('keeps a frozen prefix readable when a writer appends during the physical read', async () => {
    const f = await fixture();
    await f.first.authority.close();
    const original = await fs.readFile(f.transcriptPath);
    const readSync = fsSync.readSync;
    const spy = vi
      .spyOn(fsSync, 'readSync')
      .mockImplementationOnce((...args) => {
        const count = Reflect.apply(readSync, fsSync, args) as number;
        fsSync.appendFileSync(
          f.transcriptPath,
          'a concurrent uncommitted tail',
        );
        return count;
      });
    try {
      const frozen = await LocalJsonlManagedSessionJournalStore.read({
        ...f,
        maxBytes: original.length,
      });
      expect(frozen.committed).toBe(f.receipt.committedSequence);
      expect(frozen.uncommitted).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses a frozen prefix rewrite even when the file also grows', async () => {
    const f = await fixture();
    await f.first.authority.close();
    const original = await fs.readFile(f.transcriptPath);
    const readSync = fsSync.readSync;
    const spy = vi
      .spyOn(fsSync, 'readSync')
      .mockImplementationOnce((...args) => {
        const count = Reflect.apply(readSync, fsSync, args) as number;
        const modified = Buffer.from(original);
        modified[0] ^= 1;
        fsSync.writeFileSync(
          f.transcriptPath,
          Buffer.concat([modified, Buffer.from('a concurrent tail')]),
        );
        return count;
      });
    try {
      expect(() =>
        readLocalJournalBytes(f.transcriptPath, original.length),
      ).toThrow(/file changed while reading/);
    } finally {
      spy.mockRestore();
    }
  });

  it.each(['manifest', 'page', 'dependency'] as const)(
    'refuses a missing %s without treating the Session as empty',
    async (kind) => {
      const f = await fixture();
      await f.first.authority.close();
      const resumed = await f.open();
      const { base, manifest } = await snapshot(f);
      const ref =
        kind === 'manifest'
          ? base.manifest
          : kind === 'page'
            ? manifest.pages[0]
            : manifest.resources[0];
      await fs.unlink(
        path.join(f.resources.sessionRoot, ref.kind, ref.resourceId),
      );
      await expect(resumed.journal.read()).rejects.toThrow();
      await resumed.authority.close();
      const lock = JSON.parse(
        await fs.readFile(
          getSessionWriterLockPath(f.runtimeBaseDir, f.sessionId),
          'utf8',
        ),
      );
      expect(lock).toMatchObject({ state: 'sealed', format_version: 2 });
    },
  );

  it.each(
    (['definition', 'root', 'input', 'nested'] as const).flatMap((dependency) =>
      (['missing', 'corrupt'] as const).map((damage) => ({
        dependency,
        damage,
      })),
    ),
  )(
    'blocks an existing sealed v1 Session with a $damage $dependency before activation',
    async ({ dependency, damage }) => {
      const f = await fixture();
      let nestedRef = f.input.contentRef;
      if (dependency === 'nested') {
        const attachment = await f.resources.publish(
          'managed-channel-attachment',
          Buffer.from('nested attachment'),
        );
        nestedRef = attachment;
        const contentRef = await f.resources.publish(
          'managed-input',
          encodeChannelInputEnvelope({
            channelInstanceId: 'channel',
            accountId: 'account',
            accountGeneration: 1,
            platformEventId: 'event',
            semanticRevision: 1,
            routeId: 'route',
            routeRevision: 1,
            senderId: 'sender',
            chatId: null,
            threadId: null,
            subject: null,
            text: 'hello',
            attachments: [
              {
                fileName: 'input.txt',
                mimeType: 'text/plain',
                byteLength: attachment.byteLength,
                digest: attachment.digest,
                ref: attachment,
              },
            ],
            replyContext: {},
          }),
        );
        await f.first.authority.submitInput(f.command('channel'), {
          ...f.input,
          inputId: 'channel',
          turnId: 'channel',
          source: 'channel',
          contentRef,
        });
      }
      const ref =
        dependency === 'definition'
          ? f.first.authority.sessionHeader.definitionRef
          : dependency === 'root'
            ? f.first.authority.sessionHeader.rootSnapshotRef
            : dependency === 'nested'
              ? nestedRef
              : f.input.contentRef;
      await f.first.authority.close();
      const before = await fs.readFile(f.transcriptPath);
      expect(before.includes('managed-session/1')).toBe(true);
      expect(before.includes(LOCAL_MANAGED_SNAPSHOT_BASE)).toBe(false);
      const resourcePath = path.join(
        f.resources.sessionRoot,
        ref.kind,
        ref.resourceId,
      );
      const original = await fs.readFile(resourcePath);
      if (damage === 'missing') await fs.unlink(resourcePath);
      else await fs.writeFile(resourcePath, Buffer.alloc(0));
      await LocalJsonlManagedSessionJournalStore.read(f);
      expect(await fs.readFile(f.transcriptPath)).toEqual(before);
      const options = {
        ...f,
        cwd: f.project,
        version: 'test',
        workerId: 'test',
        activationLeaseDurationMs: 60_000,
      };
      await expect(openManagedSession(options)).rejects.toThrow(/resource/);
      expect(await fs.readFile(f.transcriptPath)).toEqual(before);
      expect(
        (await LocalJsonlManagedSessionJournalStore.read(f)).events.some(
          (event) => event.kind === 'activation.changed',
        ),
      ).toBe(false);
      expect(
        JSON.parse(
          await fs.readFile(
            getSessionWriterLockPath(f.runtimeBaseDir, f.sessionId),
            'utf8',
          ),
        ),
      ).toMatchObject({ state: 'sealed', format_version: 2 });
      for (const kind of [
        LOCAL_MANAGED_SNAPSHOT_KIND,
        LOCAL_MANAGED_SNAPSHOT_PAGE_KIND,
      ]) {
        await expect(
          fs.access(path.join(f.resources.sessionRoot, kind)),
        ).rejects.toMatchObject({ code: 'ENOENT' });
      }
      await fs.writeFile(resourcePath, original);
      const resumed = await openManagedSession(options);
      expect(
        (await resumed.authority.submitInput(f.command('input'), f.input))
          .transactionId,
      ).toBe(f.receipt.transactionId);
      await resumed.close();
    },
  );

  it('refuses cross-scope reads and a symlinked page', async () => {
    const f = await fixture();
    await f.first.authority.close();
    const resumed = await f.open();
    await expect(
      LocalJsonlManagedSessionJournalStore.read({
        ...f,
        sessionKey: { ...f.sessionKey, workspaceId: 'other' },
      }),
    ).rejects.toThrow(/scope|different session/);
    const { manifest } = await snapshot(f);
    const page = manifest.pages[0];
    const file = path.join(f.resources.sessionRoot, page.kind, page.resourceId);
    const outside = path.join(f.root, 'outside');
    await fs.copyFile(file, outside);
    await fs.unlink(file);
    await fs.symlink(outside, file);
    await expect(resumed.journal.read()).rejects.toThrow();
    await resumed.authority.close();
  });

  it('refuses a missing committed-tail dependency before a converted Session resumes', async () => {
    const f = await fixture();
    await f.first.authority.close();
    const resumed = await f.open();
    const frozen = (await fs.stat(f.transcriptPath)).size;
    const contentRef = await f.resources.publish(
      'managed-input',
      Buffer.from(JSON.stringify({ text: 'tail input' })),
    );
    await resumed.authority.submitInput(f.command('tail-resource'), {
      ...f.input,
      inputId: 'tail-resource',
      turnId: 'tail-resource',
      contentRef,
    });
    const { manifest } = await snapshot(f);
    expect(manifest.resources).not.toContainEqual(contentRef);
    await resumed.authority.close();
    const before = await fs.readFile(f.transcriptPath);
    await fs.unlink(
      path.join(
        f.resources.sessionRoot,
        contentRef.kind,
        contentRef.resourceId,
      ),
    );
    expect(
      (
        await LocalJsonlManagedSessionJournalStore.read({
          ...f,
          maxBytes: frozen,
        })
      ).committed,
    ).toBe(f.receipt.committedSequence);
    await expect(
      LocalJsonlManagedSessionJournalStore.read(f),
    ).rejects.toThrow();
    await expect(
      openManagedSession({
        ...f,
        cwd: f.project,
        version: 'test',
        workerId: 'test',
        activationLeaseDurationMs: 60_000,
      }),
    ).rejects.toThrow();
    expect(await fs.readFile(f.transcriptPath)).toEqual(before);
    expect(
      JSON.parse(
        await fs.readFile(
          getSessionWriterLockPath(f.runtimeBaseDir, f.sessionId),
          'utf8',
        ),
      ),
    ).toMatchObject({ state: 'sealed', format_version: 2 });
  });

  it('refuses a different writer scope before changing the physical layout', async () => {
    const f = await fixture();
    await f.first.authority.close();
    const before = await fs.readFile(f.transcriptPath);
    const journal = await new LocalJsonlManagedSessionJournalStore(f).open({
      sessionKey: { ...f.sessionKey, workspaceId: 'other' },
    });
    await expect(journal.read()).rejects.toThrow(/different Session/);
    expect(await fs.readFile(f.transcriptPath)).toEqual(before);
    await journal.abort();
  });

  it('never downgrades a converted file while reclaiming a lower-format stale lock', async () => {
    const f = await fixture();
    await f.first.authority.close();
    const converted = await f.open();
    await converted.authority.close();
    const lockPath = getSessionWriterLockPath(f.runtimeBaseDir, f.sessionId);
    const sealed = JSON.parse(await fs.readFile(lockPath, 'utf8')) as Record<
      string,
      unknown
    >;
    const active = Object.fromEntries(
      Object.entries(sealed).filter(
        ([key]) =>
          ![
            'transcript',
            'sealed_at',
            'last_commit_sequence',
            'committed_prefix_hash',
          ].includes(key),
      ),
    );
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        ...active,
        state: 'active',
        format_version: 1,
        pid: 999_999,
      }),
    );
    const resumed = await f.open();
    expect(JSON.parse(await fs.readFile(lockPath, 'utf8'))).toMatchObject({
      state: 'active',
      format_version: 2,
    });
    await resumed.authority.close();
    expect(JSON.parse(await fs.readFile(lockPath, 'utf8'))).toMatchObject({
      state: 'sealed',
      format_version: 2,
    });
    await expect(
      SessionWriterLease.acquire({
        ...f,
        takeoverPolicy: 'certified',
        lockSchema: { schemaVersion: 3, formatVersion: 1 },
      }),
    ).rejects.toThrow();
  });

  it('preserves the old file and a sealed barrier when publication fails', async () => {
    const f = await fixture();
    await f.first.authority.close();
    const before = await fs.readFile(f.transcriptPath);
    const publish = vi
      .spyOn(
        LocalManagedSessionResourceStore.prototype,
        'publishJournalSnapshot',
      )
      .mockRejectedValueOnce(new Error('publish failed'));
    await expect(f.open()).rejects.toThrow('publish failed');
    expect(await fs.readFile(f.transcriptPath)).toEqual(before);
    expect(
      JSON.parse(
        await fs.readFile(
          getSessionWriterLockPath(f.runtimeBaseDir, f.sessionId),
          'utf8',
        ),
      ),
    ).toMatchObject({ state: 'sealed', format_version: 2 });
    publish.mockRestore();
    const resumed = await f.open();
    await resumed.authority.close();
  });

  it('preserves a fence after an uncertain rename and rejects old writer takeover', async () => {
    const f = await fixture();
    await f.first.authority.close();
    const rename = fs.rename;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      await rename(from, to);
      if (to === f.transcriptPath) throw new Error('rename outcome unknown');
    });
    await expect(f.open()).rejects.toThrow();
    expect(
      (await fs.readFile(f.transcriptPath)).includes(
        LOCAL_MANAGED_SNAPSHOT_BASE,
      ),
    ).toBe(true);
    const lock = JSON.parse(
      await fs.readFile(
        getSessionWriterLockPath(f.runtimeBaseDir, f.sessionId),
        'utf8',
      ),
    );
    expect(lock).toMatchObject({ state: 'active', format_version: 2 });
    await expect(
      SessionWriterLease.acquire({
        ...f,
        takeoverPolicy: 'certified',
        lockSchema: { schemaVersion: 3, formatVersion: 1 },
      }),
    ).rejects.toThrow();
  });

  it('returns the latest title even when its tail update is beyond the display window', async () => {
    const f = await fixture();
    const title = (authority: LocalManagedSessionAuthority, id: string) =>
      authority.commitDomainRecord(
        f.command(id),
        {
          domain: 'session_metadata',
          content: { title: id, titleSource: 'manual' },
        },
        { class: 'trusted_entry' },
      );
    await title(f.first.authority, 'before');
    await f.first.authority.close();
    const resumed = await f.open();
    expect(
      readManagedSessionTitleInfoSync(f.transcriptPath, f.runtimeBaseDir),
    ).toMatchObject({ title: 'before' });
    await title(resumed.authority, 'after');
    for (let index = 0; index < 3; index++) {
      await resumed.authority.appendExecutionEvent(
        f.command(`padding-${index}`),
        (sequence) => ({
          v: 1,
          sequence,
          eventId: `padding-${index}`,
          sessionKey: f.sessionKey,
          kind: 'cancel.requested',
          occurredAt: 1,
          payload: {
            requestId: `padding-${index}`,
            target: { padding: 'x'.repeat(32 * 1024) },
            reason: 'test',
            requestedBy: 'test',
          },
        }),
        { class: 'trusted_entry' },
      );
    }
    expect(
      readManagedSessionTitleInfoSync(f.transcriptPath, f.runtimeBaseDir),
    ).toMatchObject({ title: 'after' });
    await resumed.authority.close();
  });

  it('classifies and reads a snapshot whose first control subtype is beyond the head window', async () => {
    const f = await fixture(100_000);
    await f.first.authority.commitDomainRecord(
      f.command('title'),
      {
        domain: 'session_metadata',
        content: { title: 'large owner', titleSource: 'manual' },
      },
      { class: 'trusted_entry' },
    );
    await f.first.authority.close();
    const resumed = await f.open();
    const { bytes } = await snapshot(f);
    expect(bytes.subarray(0, 65536).includes('session_execution_engine')).toBe(
      false,
    );
    expect(isManagedSessionTranscriptSync(f.transcriptPath)).toBe(true);
    expect(isManagedExecutionTranscriptSync(f.transcriptPath)).toBe(true);
    const service = new SessionService(f.project, {
      runtimeBaseDir: f.runtimeBaseDir,
    });
    expect(() => service.assertLegacySessionExecution(f.sessionId)).toThrow(
      /cannot execute with legacy/,
    );
    await expect(
      service.renameSession(f.sessionId, 'legacy rename'),
    ).rejects.toThrow(/rename must go through its session authority/);
    expect(
      readManagedSessionTitleInfoSync(f.transcriptPath, f.runtimeBaseDir),
    ).toMatchObject({ title: 'large owner' });
    await resumed.authority.close();
    await fs.writeFile(
      f.transcriptPath,
      bytes.subarray(0, bytes.indexOf(10) + 1),
    );
    expect(isManagedExecutionTranscriptSync(f.transcriptPath)).toBe(true);
    const owner = bytes.subarray(0, bytes.indexOf(10));
    await fs.writeFile(f.transcriptPath, owner);
    expect(isManagedExecutionTranscriptSync(f.transcriptPath)).toBe(true);
    await fs.writeFile(
      f.transcriptPath,
      Buffer.concat([
        owner,
        Buffer.from(
          `${JSON.stringify({ uuid: 'glued', type: 'system', subtype: 'turn_result' })}\n`,
        ),
      ]),
    );
    expect(isManagedExecutionTranscriptSync(f.transcriptPath)).toBe(true);
    expect(() => service.assertLegacySessionExecution(f.sessionId)).toThrow(
      /cannot execute with legacy/,
    );
  });

  it('pages large committed prefixes without guessing refs in arbitrary cancel JSON', async () => {
    const f = await fixture();
    for (let index = 0; index < 25; index++) {
      await f.first.authority.appendExecutionEvent(
        f.command(`large-${index}`),
        (sequence) => ({
          v: 1,
          sequence,
          eventId: `large-${index}`,
          sessionKey: f.sessionKey,
          kind: 'cancel.requested',
          occurredAt: 1,
          payload: {
            requestId: `large-${index}`,
            target: {
              padding: 'x'.repeat(700_000),
              resourceId: 'not-a-ref',
              kind: 'opaque',
              schemaVersion: 1,
              byteLength: 4,
              digest: 'a'.repeat(64),
            },
            reason: 'test',
            requestedBy: 'test',
          },
        }),
        { class: 'trusted_entry' },
      );
    }
    const proof = f.first.authority.commitProof;
    await f.first.authority.close();
    const resumed = await f.open();
    const { manifest } = await snapshot(f);
    expect(manifest.pages.length).toBeGreaterThan(1);
    expect(
      manifest.pages.every(
        (ref) =>
          ref.kind === LOCAL_MANAGED_SNAPSHOT_PAGE_KIND &&
          ref.byteLength <= 16 * 1024 * 1024,
      ),
    ).toBe(true);
    expect(
      manifest.resources.some((ref) => ref.resourceId === 'not-a-ref'),
    ).toBe(false);
    expect(resumed.authority.commitProof).toEqual(proof);
    await resumed.authority.close();
  }, 60_000);

  it('preserves opaque input JSON without treating a ref-shaped object as a dependency', async () => {
    const f = await fixture();
    const contentRef = await f.resources.publish(
      'managed-input',
      Buffer.from(
        JSON.stringify({
          opaque: { ...f.input.contentRef, resourceId: 'user-json-example' },
        }),
      ),
    );
    await f.first.authority.submitInput(f.command('opaque'), {
      ...f.input,
      inputId: 'opaque',
      turnId: 'opaque',
      contentRef,
    });
    await f.first.authority.close();
    const resumed = await f.open();
    const { manifest } = await snapshot(f);
    expect(manifest.resources).toContainEqual(contentRef);
    expect(
      manifest.resources.some((ref) => ref.resourceId === 'user-json-example'),
    ).toBe(false);
    await resumed.authority.close();
  });

  it('retains channel attachments while leaving opaque reply context alone', async () => {
    const f = await fixture();
    const attachment = await f.resources.publish(
      'managed-channel-attachment',
      Buffer.from('attachment'),
    );
    const contentRef = await f.resources.publish(
      'managed-input',
      encodeChannelInputEnvelope({
        channelInstanceId: 'channel',
        accountId: 'account',
        accountGeneration: 1,
        platformEventId: 'event',
        semanticRevision: 1,
        routeId: 'route',
        routeRevision: 1,
        senderId: 'sender',
        chatId: null,
        threadId: null,
        subject: null,
        text: 'hello',
        attachments: [
          {
            fileName: 'test.txt',
            mimeType: 'text/plain',
            byteLength: attachment.byteLength,
            digest: attachment.digest,
            ref: attachment,
          },
        ],
        replyContext: {
          ...f.input.contentRef,
          resourceId: 'opaque-reply-context',
        },
      }),
    );
    await f.first.authority.submitInput(f.command('channel'), {
      ...f.input,
      inputId: 'channel',
      turnId: 'channel',
      source: 'channel',
      contentRef,
    });
    await f.first.authority.close();
    const resumed = await f.open();
    const { manifest } = await snapshot(f);
    expect(manifest.resources).toContainEqual(attachment);
    expect(
      manifest.resources.some(
        (ref) => ref.resourceId === 'opaque-reply-context',
      ),
    ).toBe(false);
    await fs.unlink(
      path.join(
        f.resources.sessionRoot,
        attachment.kind,
        attachment.resourceId,
      ),
    );
    await expect(resumed.journal.read()).rejects.toThrow();
    await resumed.authority.close();
  });
});
