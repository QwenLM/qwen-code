import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const load = (packageName, name) =>
  import(
    pathToFileURL(
      `${process.cwd()}/packages/${packageName}/dist/src/${name}.js`,
    )
  );
const { LocalManagedSessionAuthority } = await load(
  'core',
  'managed-runtime/managed-session-authority',
);
const { scanManagedSessionJournal } = await load(
  'core',
  'managed-runtime/managed-session-storage',
);
const { describeTransaction, collectNestedResourceRefs } = await load(
  'core',
  'managed-runtime/http-managed-session-store',
);
const { createManagedHarnessHandle } = await load(
  'core',
  'managed-runtime/managed-harness-factory',
);
const { ManagedSessionRecordSink } = await load(
  'core',
  'managed-runtime/managed-session-record-sink',
);
const { HostedWorkspaceToolTurn } = await load(
  'cli',
  'serve/hosted-workspace-tool-turn',
);
const { HostedWorkspaceBroker } = await load(
  'cli',
  'serve/hosted-workspace-broker',
);
const sessionKey = {
  tenantId: process.argv[2],
  workspaceId: 'workspace-1',
  sessionId: process.argv[3],
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const bodies = new Map();
const resources = {
  async publish(kind, bytes) {
    const resourceId =
      kind === 'managed-tool-outcome'
        ? 'media-outcome'
        : `${kind}-${hash(bytes)}`;
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
      throw new Error('Native media fixture resource differs');
    return bytes;
  },
};
let journalBytes = Buffer.alloc(0);
const transactions = [];
const journal = {
  sessionKey,
  async read() {
    return scanManagedSessionJournal(journalBytes, sessionKey);
  },
  async appendTransaction(records) {
    const before = await this.read();
    const bytes = Buffer.from(
      records.map((row) => JSON.stringify(row) + '\n').join(''),
    );
    const { refs, ...descriptor } = describeTransaction(
      records,
      bytes,
      before.activation?.epoch ?? 0,
      sessionKey,
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
      workspaceId: sessionKey.workspaceId,
      writerId: 'media-writer',
      writerGeneration: 1,
      expectedJournalRevision: transactions.length,
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
const authority = await LocalManagedSessionAuthority.open({
  journal,
  sessionKey,
  cwd: '/workspace',
  version: 'hosted-harness/1',
  resources,
  now: () => 1792430100000,
  create: {
    definitionRef: await resources.publish(
      'managed-definition',
      Buffer.from('{}'),
    ),
    rootSnapshotRef: await resources.publish('managed-root', Buffer.from('{}')),
    createdBy: 'native-media-retention',
  },
});
const activation = await authority.installActivation({
  activationId: 'media-activation',
  workerId: 'media-worker',
  leaseDurationMs: 60_000,
});
const sink = new ManagedSessionRecordSink(authority, resources, () => ({
  class: 'harness',
  activation,
}));
const session = { authority, resources, activation, sink };
const harness = createManagedHarnessHandle(session);
await harness.ensureCheckpoint();

// Substitute only the external Runtime boundary; the ordinary Hosted turn
// owns conversion, history, outcome publication and checkpoint references.
Object.assign(HostedWorkspaceBroker.prototype, {
  async warm() {},
  async acquire() {
    this.capability = 'native-media-capability/1';
  },
  async fileHistory() {
    return null;
  },
  async prepare() {
    return 'media-execution';
  },
  async execute() {
    return {
      executionStatus: 'success',
      responseParts: [{ inlineData: { mimeType: 'image/png', data: 'AQID' } }],
    };
  },
});
const turn = new HostedWorkspaceToolTurn(
  { baseUrl: 'http://127.0.0.1:1', token: 'native-media-runtime' },
  session,
  harness,
  'media-turn',
  async (type, parts, model) => {
    const uuid = `${type}-media-message`;
    const record = {
      uuid,
      parentUuid: null,
      sessionId: sessionKey.sessionId,
      timestamp: '2026-10-20T00:00:00Z',
      model,
      type,
      cwd: '/workspace',
      version: 'hosted-harness/1',
      daemonPromptId: 'media-turn',
      message: { role: type === 'assistant' ? 'model' : 'user', parts },
    };
    await sink.write(record);
    return uuid;
  },
  () => true,
  undefined,
  { resources, assertWritable: async () => undefined },
  undefined,
  { profile: 'hosted-workspace-shell/1' },
);
const call = {
  callId: 'media-function',
  name: 'read_file',
  args: { file_path: 'image.png' },
  isClientInitiated: false,
  prompt_id: 'media-turn',
};
await turn.execute(
  [call],
  [{ functionCall: { id: call.callId, name: call.name, args: call.args } }],
  'native-media-fixture',
  new AbortController().signal,
);
const binding = authority.latestCheckpoint;
if (!binding) throw new Error('Hosted media did not commit its checkpoint');
const checkpoint = JSON.parse(await resources.read(binding.stateRef));
const outcomeRef = checkpoint.tools?.items[0]?.outcomeRef;
if (!outcomeRef) throw new Error('Hosted media outcome is not checkpointed');
const outcome = await resources.read(outcomeRef);
const history = transactions
  .flatMap((transaction) => transaction.resources)
  .find(
    (ref) =>
      ref.kind === 'managed-message' &&
      JSON.parse(Buffer.from(ref.bytesBase64, 'base64')).type === 'tool_result',
  );
if (!history) throw new Error('Hosted media history was not committed');
const { bytesBase64: historyBytesBase64, ...historyRef } = history;
await writeFile(
  process.argv[4],
  JSON.stringify({
    sessionKey,
    transactions,
    outcomeRef,
    outcomeBytesBase64: outcome.toString('base64'),
    historyRef,
    historyBytesBase64,
  }),
);
