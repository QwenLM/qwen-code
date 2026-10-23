import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const core = pathToFileURL(
  path.join(process.cwd(), 'packages/core/dist/src/managed-runtime/'),
);
const { LocalManagedSessionAuthority } = await import(
  new URL('managed-session-authority.js', core)
);
const { LocalJsonlManagedSessionJournalStore } = await import(
  new URL('local-jsonl-managed-session-journal-store.js', core)
);
const { LocalManagedSessionResourceStore } = await import(
  new URL('managed-session-resources.js', core)
);
const { describeTransaction } = await import(
  new URL('http-managed-session-store.js', core)
);
const sessionKey = {
  tenantId: 'initial-tenant',
  workspaceId: 'initial-workspace',
  sessionId: process.argv[2],
};
const directory = await mkdtemp(path.join(tmpdir(), 'qwen-recovery-initial-'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
let journal;
try {
  const options = {
    runtimeBaseDir: directory,
    sessionId: sessionKey.sessionId,
    transcriptPath: path.join(directory, 'session.jsonl'),
  };
  const resources = LocalManagedSessionResourceStore.create({
    runtimeBaseDir: directory,
    sessionKey,
  });
  journal = await new LocalJsonlManagedSessionJournalStore(options).open({
    sessionKey,
  });
  const commits = [];
  let activationEpoch = 0;
  const observed = {
    sessionKey,
    read: () => journal.read(),
    async appendTransaction(records) {
      const bytes = Buffer.from(
        records.map((record) => JSON.stringify(record)).join('\n') + '\n',
      );
      const descriptor = describeTransaction(
        records,
        bytes,
        activationEpoch,
        sessionKey,
      );
      const published = await Promise.all(
        descriptor.refs.map(async (ref) => ({
          ...ref,
          bytesBase64: (await resources.read(ref)).toString('base64'),
        })),
      );
      await journal.appendTransaction(records);
      commits.push({
        ...descriptor,
        recordBytesBase64: bytes.toString('base64'),
        recordDigest: sha256(bytes),
        resources: published,
      });
      activationEpoch = descriptor.activationEpoch;
    },
    seal: (proof) => journal.seal(proof),
    abort: () => journal.abort(),
  };
  const definitionRef = await resources.publish(
    'managed-definition',
    Buffer.from(
      JSON.stringify({ engine: 'managed', sessionId: sessionKey.sessionId }),
    ),
  );
  const rootSnapshotRef = await resources.publish(
    'managed-root',
    Buffer.from(JSON.stringify({ cwd: '/workspace' })),
  );
  const authority = await LocalManagedSessionAuthority.open({
    journal: observed,
    resources,
    sessionKey,
    cwd: '/workspace',
    version: 'hosted-harness/1',
    create: { definitionRef, rootSnapshotRef, createdBy: 'hosted-harness' },
  });
  await authority.installActivation({
    activationId: 'activation',
    workerId: 'writer',
    leaseDurationMs: 60_000,
  });
  await authority.commitDomainRecord(
    {
      operation: 'renameSession',
      commandId: 'rename',
      sessionKey,
      contentDigest: sha256('Renamed'),
    },
    {
      domain: 'session_metadata',
      content: {
        title: 'Renamed',
        titleSource: 'manual',
        managedRenameRevision: '1',
      },
    },
    { class: 'trusted_entry' },
  );
  await journal.abort();
  journal = await new LocalJsonlManagedSessionJournalStore(options).open({
    sessionKey,
  });
  const reopened = await LocalManagedSessionAuthority.open({
    journal,
    resources: LocalManagedSessionResourceStore.create({
      runtimeBaseDir: directory,
      sessionKey,
    }),
    sessionKey,
    cwd: '/workspace',
    version: 'hosted-harness/1',
  });
  assert.equal(reopened.committedSequence, 2);
  assert.equal(reopened.domainRecord('session_metadata').revision, 1);
  assert.equal((await reopened.restoreBundle()).restoreBasis, 'initial');
  process.stdout.write(JSON.stringify({ coldOpened: true, commits }));
} finally {
  await journal?.abort();
  await rm(directory, { recursive: true, force: true });
}
