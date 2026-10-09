/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const load = (name) =>
  import(pathToFileURL(`${process.cwd()}/packages/core/dist/src/${name}.js`));
const { LocalManagedSessionAuthority } = await load(
  'managed-runtime/managed-session-authority',
);
const { ManagedHookActivationController } = await load(
  'managed-runtime/managed-hook-activation',
);
const { ManagedSessionRecordSink } = await load(
  'managed-runtime/managed-session-record-sink',
);
const { scanManagedSessionJournal } = await load(
  'managed-runtime/managed-session-storage',
);
const { describeTransaction, collectNestedResourceRefs } = await load(
  'managed-runtime/http-managed-session-store',
);
const { createManagedHarnessHandle } = await load(
  'managed-runtime/managed-harness-factory',
);
const { TurnBudget } = await load('core/turn-budget');
const seed = JSON.parse(
  await readFile(
    'packages/sdk-java/runtime-broker/src/test/resources/csi-native-read-continuation-fixture.json',
    'utf8',
  ),
);
const seedTransactions = seed.transactions.slice(0, 18);
let journalBytes = Buffer.concat(
  [seed.sessionCreate, ...seedTransactions].map((tx) =>
    Buffer.from(tx.recordBytesBase64, 'base64'),
  ),
);
const bodies = new Map();
for (const tx of [seed.sessionCreate, ...seedTransactions]) {
  for (const ref of tx.resources) {
    if (ref.bytesBase64)
      bodies.set(ref.resourceId, Buffer.from(ref.bytesBase64, 'base64'));
  }
}
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const resources = {
  async publish(kind, bytes) {
    const resourceId = randomUUID();
    bodies.set(resourceId, bytes);
    return {
      resourceId,
      kind,
      schemaVersion: 1,
      byteLength: bytes.length,
      digest: hash(bytes),
    };
  },
  async read(ref) {
    const bytes = bodies.get(ref.resourceId);
    if (!bytes || bytes.length !== ref.byteLength || hash(bytes) !== ref.digest)
      throw new Error('Fixture resource differs');
    return bytes;
  },
};
const transactions = [];
const journal = {
  sessionKey: seed.sessionKey,
  async read() {
    return scanManagedSessionJournal(journalBytes, seed.sessionKey);
  },
  async appendTransaction(records) {
    const before = await this.read();
    const bytes = Buffer.from(
      records.map((row) => JSON.stringify(row) + '\n').join(''),
    );
    const { refs, ...descriptor } = describeTransaction(
      records,
      bytes,
      1,
      seed.sessionKey,
    );
    const closure = new Map();
    const pending = [...refs];
    while (pending.length) {
      const ref = pending.pop();
      if (closure.has(ref.resourceId)) continue;
      const body = await resources.read(ref);
      closure.set(ref.resourceId, {
        ...ref,
        bytesBase64: body.toString('base64'),
      });
      pending.push(...collectNestedResourceRefs(ref, body));
    }
    transactions.push({
      workspaceId: seed.sessionKey.workspaceId,
      writerId: seed.writerId,
      writerGeneration: 1,
      expectedJournalRevision: 19 + transactions.length,
      expectedCommittedSequence: before.committed,
      ...descriptor,
      recordCount: records.length,
      recordBytesBase64: bytes.toString('base64'),
      recordDigest: hash(bytes),
      resources: [...closure.values()],
    });
    journalBytes = Buffer.concat([journalBytes, bytes]);
  },
  async seal() {},
  async abort() {},
};
const instant = 1791518307000;
const realNow = Date.now;
Date.now = () => instant;
try {
  const authority = await LocalManagedSessionAuthority.open({
    journal,
    sessionKey: seed.sessionKey,
    cwd: seed.cwd,
    version: 'hosted-harness/1',
    resources,
    now: () => instant,
  });
  const { activationId, epoch } = authority.currentActivation;
  const activation = { activationId, epoch };
  const session = { authority, resources, activation };
  session.sink = new ManagedSessionRecordSink(authority, resources, () => ({
    class: 'harness',
    activation,
  }));
  const projected = await session.sink.project();
  const input = authority
    .eventsInSequenceRange(1, authority.committedSequence)
    .find((event) => event.kind === 'input.accepted');
  const promptId = input.payload.inputId;
  const messageId = randomUUID();
  const text = 'Original complete output';
  const record = {
    ...authority.recordEnvelope,
    uuid: messageId,
    parentUuid: projected.at(-1).uuid,
    sessionId: seed.sessionKey.sessionId,
    timestamp: new Date(instant).toISOString(),
    type: 'assistant',
    daemonPromptId: promptId,
    model: 'owned-model',
    message: {
      role: 'model',
      parts: [
        {
          text: '思考'.repeat(17000),
          thought: true,
          thoughtSignature: 'original-signature',
        },
        { text },
        { inlineData: { mimeType: 'image/png', data: 'AQID' } },
      ],
    },
  };
  await new ManagedHookActivationController(session).runTurn(
    promptId,
    async (scope) => {
      await scope.bindBudget(new TurnBudget());
      const complete = await scope.beginMainAttempt(record.model);
      await authority.appendExecutionEvent(
        {
          operation: 'assistantDelta',
          commandId: `assistant-delta:${promptId}:${messageId}:1`,
          sessionKey: seed.sessionKey,
          contentDigest: hash(Buffer.from(text)),
        },
        (sequence) => ({
          v: 1,
          sequence,
          eventId: `assistant-delta:${promptId}:${messageId}:1`,
          sessionKey: seed.sessionKey,
          kind: 'message.delta',
          occurredAt: instant,
          subject: {
            type: 'activation',
            scopeId: activation.activationId,
            activationId: activation.activationId,
            epoch: activation.epoch,
          },
          payload: { messageId, turnId: promptId, role: 'assistant', text },
        }),
        { class: 'harness', activation },
      );
      const usage = [
        {
          promptTokenCount: 7,
          candidatesTokenCount: 30,
          thoughtsTokenCount: 4,
          totalTokenCount: 37,
          cachedContentTokenCount: 0,
        },
      ];
      await complete(true, usage, record);
      await complete(true, usage, record);
      const harness = createManagedHarnessHandle(session);
      await harness.consumeRuntimeResults();
      await harness.settleConsumedRuntimeContinuation();
    },
  );
  process.stdout.write(
    JSON.stringify(
      {
        provenance:
          'Actual built TypeScript authority/model completion and descriptors; original Read fixture prefix, memory journal/resources and fixed clock. No SQL, process takeover or C8 acceptance.',
        seedPrefixTransactions: 18,
        transactions,
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  Date.now = realNow;
}
