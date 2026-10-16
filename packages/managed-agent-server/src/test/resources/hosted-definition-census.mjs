/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { Buffer } from 'node:buffer';

const { createHttpManagedSessionStores, describeTransaction } = await import(
  pathToFileURL(
    `${process.cwd()}/packages/core/dist/src/managed-runtime/http-managed-session-store.js`,
  ).href
);
const { managedSessionEventsDigest } = await import(
  pathToFileURL(
    `${process.cwd()}/packages/core/dist/src/managed-runtime/managed-session-records.js`,
  ).href
);
const { LocalManagedSessionAuthority } = await import(
  pathToFileURL(
    `${process.cwd()}/packages/core/dist/src/managed-runtime/managed-session-authority.js`,
  ).href
);
const { SessionWriterLease } = await import(
  pathToFileURL(
    `${process.cwd()}/packages/core/dist/src/services/session-writer-lease.js`,
  ).href
);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fixtures = JSON.parse(await readFile(process.argv[2], 'utf8'));
for (const fixture of fixtures) {
  const { sessionKey, nested, published } = fixture;
  const stores = createHttpManagedSessionStores({
    baseUrl: 'http://127.0.0.1:1',
    sessionKey,
    writerId: 'writer-a',
  });
  const resources = stores.resourceStore;
  const bytes = new Map(
    published.map((entry) => [
      entry.resourceId,
      Buffer.from(entry.bytesBase64, 'base64'),
    ]),
  );
  resources.bind({ readResource: async (ref) => bytes.get(ref.resourceId) });
  const publish = async (kind, value) => {
    const content = Buffer.from(JSON.stringify(value));
    const ref = await resources.publish(kind, content);
    bytes.set(ref.resourceId, content);
    return ref;
  };
  const definitionRef = await publish('managed-definition', {
    engine: 'managed',
    ...(Object.keys(nested).length
      ? {
          agentDefinition: {
            agentId: `agent_${'a'.repeat(32)}`,
            revision: '1',
            digest: 'b'.repeat(64),
            ...nested,
          },
        }
      : {}),
  });
  const rootSnapshotRef = await publish('managed-root', { cwd: '/workspace' });
  const directory = await mkdtemp(path.join(tmpdir(), 'definition-census-'));
  const transcriptPath = path.join(directory, 'session.jsonl');
  const lease = await SessionWriterLease.acquire({
    runtimeBaseDir: directory,
    sessionId: sessionKey.sessionId,
    transcriptPath,
  });
  try {
    await LocalManagedSessionAuthority.open({
      lease,
      sessionKey,
      cwd: '/workspace',
      version: 'test',
      create: { definitionRef, rootSnapshotRef, createdBy: 'test' },
    });
    const content = await readFile(transcriptPath);
    const records = content
      .toString('utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const { refs: _refs, ...transaction } = describeTransaction(
      records,
      content,
      0,
      sessionKey,
    );
    fixture.create = {
      ...transaction,
      recordCount: records.length,
      recordBytesBase64: content.toString('base64'),
      recordDigest: hash(content),
    };
  } finally {
    await lease.release();
    await rm(directory, { recursive: true, force: true });
  }
  fixture.create.resources = await resources.commitResources([
    definitionRef,
    rootSnapshotRef,
  ]);
  resources.releaseCommitted(fixture.create.resources);
  const prepared = {
    request: { model: 'fixture', contents: [], config: {} },
    history: [],
    completedToolCallIds: [],
    routeSelector: 'openai:fixture',
    providerPin: 'a'.repeat(64),
    promptTokensForClamp: 0,
  };
  const recoveryRef = await publish('hosted-model-request', {
    v: 1,
    sessionKey,
    promptId: 'prompt',
    definitionRef,
    rootSnapshotRef,
    sourceActivation: { activationId: 'activation', epoch: 1 },
    sourceBootId: 'boot',
    sourceEventEpoch: 'epoch',
    messageId: 'model-message',
    round: 0,
    throughSequence: 1,
    pendingToolResults: false,
    workspaceContext: null,
    prepared,
    requestDigest: hash(Buffer.from(JSON.stringify(prepared))),
  });
  const event = {
    v: 1,
    sequence: 1,
    eventId: 'model-event',
    sessionKey,
    kind: 'model.attempt',
    occurredAt: 1,
    subject: {
      type: 'activation',
      scopeId: 'activation',
      activationId: 'activation',
      epoch: 1,
    },
    payload: {
      attemptId: 'prompt:main:0',
      state: 'started',
      routeRef: rootSnapshotRef,
      inputCheckpointRef: null,
      usageRef: null,
      recoveryRef,
    },
  };
  const records = [
    {
      subtype: 'managed_session_event_v1',
      sessionId: sessionKey.sessionId,
      managedSession: event,
    },
    {
      subtype: 'managed_session_commit_v1',
      sessionId: sessionKey.sessionId,
      managedSession: {
        transactionId: 'later',
        commandId: 'later',
        operation: 'model.attempt',
        contentDigest: 'a'.repeat(64),
        firstSequence: 1,
        lastSequence: 1,
        eventCount: 1,
        eventsDigest: managedSessionEventsDigest([event]),
        previousCommitDigest: null,
      },
    },
  ];
  const recordBytes = Buffer.from(
    records.map((record) => JSON.stringify(record)).join('\n') + '\n',
  );
  const { refs: _refs, ...transaction } = describeTransaction(
    records,
    recordBytes,
    0,
    sessionKey,
  );
  fixture.later = {
    ...transaction,
    recordCount: records.length,
    recordBytesBase64: recordBytes.toString('base64'),
    recordDigest: hash(recordBytes),
    resources: await resources.commitResources([recoveryRef]),
  };
}
await writeFile(process.argv[3], JSON.stringify(fixtures));
