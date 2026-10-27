import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const {
  baseUrl,
  sessionKey,
  writerToken,
  eventCount = 1100,
  engine = 'mysql',
  revision = 'working-tree-uncommitted',
  metricsPath,
  historyDirectory,
} = JSON.parse(await readFile(process.argv[2], 'utf8'));
assert([1100, 10000, 100000].includes(eventCount));
assert(['h2', 'mysql'].includes(engine));
assert(
  /^(?:[a-f0-9]{40}|[a-f0-9]{64}|working-tree-uncommitted)$/.test(revision),
);
assert(process.execArgv.includes('--max-old-space-size=256'));
assert.equal(typeof globalThis.gc, 'function');
const moduleAt = (name) =>
  import(
    pathToFileURL(
      resolve('packages/core/dist/src/managed-runtime', `${name}.js`),
    ).href
  );
const { createHttpManagedSessionStores } = await moduleAt(
  'http-managed-session-store',
);
const { LocalManagedSessionAuthority } = await moduleAt(
  'managed-session-authority',
);
const { ManagedSessionMessageProjection } = await moduleAt(
  'managed-session-message-projection',
);
const budgets = {
  heapBytes: 256 * 1024 * 1024,
  eventEntries: 1024,
  eventBytes: 8 * 1024 * 1024,
  cacheEntries: 2048,
  cacheBytes: 4 * 1024 * 1024,
  transactionEvents: 256,
  scanBatchBytes: 8 * 1024 * 1024,
  scanConcurrentConsumers: 1,
  scanTransactions: 1,
};
const observed = { snapshot: false, query: false };
const metrics = {
  engine,
  eventCount,
  revision,
  nodeVersion: process.version,
  coreAuthoritySha256: createHash('sha256')
    .update(
      await readFile(
        resolve(
          'packages/core/dist/src/managed-runtime/managed-session-authority.js',
        ),
      ),
    )
    .digest('hex'),
  workerSha256: createHash('sha256')
    .update(await readFile(process.argv[1]))
    .digest('hex'),
  budgets,
  activeItems: null,
  contextMessages: null,
  phases: {},
  close: { first: false, second: false },
  peakHeapUsedBytes: 0,
  peakRssBytes: 0,
  peakExternalBytes: 0,
  peakArrayBuffersBytes: 0,
  scan: {
    calls: 0,
    batches: 0,
    activeConsumers: 0,
    peakConsumers: 0,
    peakSourceBytes: 0,
    peakEvents: 0,
    peakTransactions: 0,
    legacyReadCalls: 0,
  },
};
function sample() {
  const memory = process.memoryUsage();
  metrics.peakHeapUsedBytes = Math.max(
    metrics.peakHeapUsedBytes,
    memory.heapUsed,
  );
  metrics.peakRssBytes = Math.max(metrics.peakRssBytes, memory.rss);
  metrics.peakExternalBytes = Math.max(
    metrics.peakExternalBytes,
    memory.external,
  );
  metrics.peakArrayBuffersBytes = Math.max(
    metrics.peakArrayBuffersBytes,
    memory.arrayBuffers,
  );
  return memory;
}
const sampling = setInterval(sample, 250);
sampling.unref();
async function persist() {
  if (!metricsPath) return;
  await mkdir(dirname(metricsPath), { recursive: true });
  await writeFile(`${metricsPath}.pending`, JSON.stringify(metrics, null, 2));
  await rename(`${metricsPath}.pending`, metricsPath);
}
function checkResidency(authority) {
  assert.equal(authority.currentActivation, undefined);
  assert.equal(authority.activeHistoryMaintenance, undefined);
  assert.equal(authority.pendingInputEvents.length, 0);
  assert.equal(authority.lastEventOfKind('input.accepted'), undefined);
  assert.equal(authority.lastEventOfKind('message.committed'), undefined);
  const residency = authority.residency;
  assert(residency.events <= budgets.eventEntries);
  assert(residency.eventBytes <= budgets.eventBytes);
  assert(residency.cacheEntries <= budgets.cacheEntries);
  assert(residency.cacheBytes <= budgets.cacheBytes);
  return residency;
}
async function phase(name, authority, resources) {
  let state;
  if (authority) {
    const through = authority.committedSequence;
    const pendingInputs = authority.pendingInputEvents.length;
    const activationActive = authority.currentActivation !== undefined;
    const maintenanceActive = authority.activeHistoryMaintenance !== undefined;
    const projection = new ManagedSessionMessageProjection(
      authority,
      resources,
    );
    const modelContextRecords = (await projection.projectModelRecords(through))
      .length;
    const contextRecords = (await projection.projectContextRecords(through))
      .length;
    metrics.activeItems =
      pendingInputs + Number(activationActive) + Number(maintenanceActive);
    metrics.contextMessages = modelContextRecords;
    state = {
      pendingInputs,
      activationActive,
      maintenanceActive,
      modelContextRecords,
      contextRecords,
    };
    assert.equal(metrics.activeItems, 0);
    assert.equal(modelContextRecords, 0);
    assert.equal(contextRecords, 0);
    assert.equal(authority.committedSequence, through);
  }
  globalThis.gc();
  await new Promise(setImmediate);
  globalThis.gc();
  await new Promise(setImmediate);
  const memory = sample();
  assert(memory.heapUsed < budgets.heapBytes);
  metrics.phases[name] = {
    heapUsedBytes: memory.heapUsed,
    rssBytes: memory.rss,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
    maximumRssKiB: process.resourceUsage().maxRSS,
    ...(state ? { state } : {}),
    ...(authority
      ? {
          committedSequence: authority.committedSequence,
          residency: checkResidency(authority),
        }
      : {}),
  };
  await persist();
  console.log(JSON.stringify({ phase: name, ...metrics.phases[name] }));
}
const headers = {
  'X-Qwen-Tenant-Id': sessionKey.tenantId,
  'X-Qwen-Managed-Writer-Token': writerToken,
  'Content-Type': 'application/json',
};
const sessionUrl = `${baseUrl}/internal/managed-session-store/v1/sessions/${sessionKey.sessionId}`;
async function request(path, body) {
  const response = await fetch(`${sessionUrl}${path}`, {
    headers,
    ...(body === undefined
      ? {}
      : { method: 'POST', body: JSON.stringify(body) }),
  });
  const value = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value));
  return value;
}
function storesFor(writerId) {
  return createHttpManagedSessionStores({
    baseUrl,
    sessionKey,
    writerId,
    writerToken,
    fetchFn: async (input, init) => {
      const path = new URL(String(input)).pathname;
      observed.snapshot ||= path.includes(
        '/journal-snapshots/history-prefix/pages',
      );
      observed.query ||= path.endsWith('/history:query');
      return fetch(input, init);
    },
  });
}
function observeScanner(journal) {
  const originalScan = journal.scan.bind(journal);
  journal.read = () => {
    metrics.scan.legacyReadCalls++;
    throw new Error('History recovery must stream journal.scan().');
  };
  journal.scan = (consume, options) => {
    metrics.scan.calls++;
    return originalScan(async (batch) => {
      metrics.scan.batches++;
      metrics.scan.activeConsumers++;
      metrics.scan.peakConsumers = Math.max(
        metrics.scan.peakConsumers,
        metrics.scan.activeConsumers,
      );
      metrics.scan.peakSourceBytes = Math.max(
        metrics.scan.peakSourceBytes,
        batch.sourceBytes.length,
      );
      metrics.scan.peakEvents = Math.max(
        metrics.scan.peakEvents,
        batch.events.length,
      );
      metrics.scan.peakTransactions = Math.max(
        metrics.scan.peakTransactions,
        batch.transactions.size,
      );
      try {
        assert(metrics.scan.activeConsumers <= budgets.scanConcurrentConsumers);
        assert(batch.sourceBytes.length <= budgets.scanBatchBytes);
        assert(batch.events.length <= budgets.transactionEvents);
        assert(batch.transactions.size <= budgets.scanTransactions);
        if (batch.events.length === 0) assert.equal(batch.transactions.size, 0);
        await consume(batch);
      } finally {
        metrics.scan.activeConsumers--;
      }
    }, options);
  };
  return journal;
}
let authority;
let original;
let originalExecutionReceipt;
const scale = eventCount !== 1100;
try {
  const first = storesFor('history-first');
  try {
    const journal = observeScanner(
      await first.journalStore.open({ sessionKey }),
    );
    authority = await LocalManagedSessionAuthority.open({
      journal,
      resources: first.resourceStore,
      sessionKey,
      cwd: '/workspace',
      version: 'pr5-integration',
      ...(historyDirectory ? { historyDirectory } : {}),
      create: {
        definitionRef: await first.resourceStore.publish(
          'managed-session-definition',
          Buffer.from('{}'),
        ),
        rootSnapshotRef: await first.resourceStore.publish(
          'managed-root-context',
          Buffer.from('{}'),
        ),
        createdBy: 'pr5-test',
      },
    });
    const outcome = scale
      ? await first.resourceStore.publish(
          'managed-tool-outcome',
          Buffer.from('{"result":"original"}'),
        )
      : undefined;
    const batchSize = scale ? budgets.transactionEvents : 128;
    let nextProgress = 10000;
    const prefix = Math.floor((eventCount - 1) / batchSize) * batchSize;
    let batch = 0;
    while (authority.committedSequence < eventCount) {
      const count = Math.min(
        batchSize,
        eventCount - authority.committedSequence,
      );
      const result = await authority.appendExecutionEvents(
        {
          operation: 'cancelHistory',
          commandId: `history-${batch++}`,
          contentDigest: 'a'.repeat(64),
          sessionKey,
        },
        (sequence) =>
          Array.from({ length: count }, (_, index) => {
            const number = sequence + index;
            return {
              v: 1,
              sequence: number,
              eventId: `cancel:${number}`,
              sessionKey,
              kind:
                scale && (number === 2 || number === eventCount - 1)
                  ? 'tool.receipt'
                  : 'cancel.requested',
              occurredAt: 1,
              payload:
                scale && (number === 2 || number === eventCount - 1)
                  ? {
                      executionCallId: 'original-execution',
                      toolOutcomeRef: outcome,
                      resultRef: outcome,
                      resources: [outcome],
                      historyRevision: number,
                    }
                  : {
                      requestId: `cancel-${number}`,
                      reason: 'test',
                      requestedBy: 'user',
                      target: { turnId: 'test' },
                    },
            };
          }),
        { class: 'trusted_entry' },
      );
      original ??= result;
      checkResidency(authority);
      if (authority.committedSequence >= nextProgress) {
        metrics.writtenSequence = authority.committedSequence;
        sample();
        await persist();
        nextProgress += 10000;
      }
      if (authority.committedSequence === prefix) {
        const head = await request(
          `/restore?workspaceId=${sessionKey.workspaceId}`,
        );
        await request('/journal-snapshots:publish', {
          workspaceId: sessionKey.workspaceId,
          writerId: 'history-first',
          writerGeneration: head.writerGeneration,
          expectedJournalRevision: head.journalRevision,
          expectedCommittedSequence: head.committedSequence,
          expectedLastCommitDigest: head.lastCommitDigest,
          snapshotId: 'history-prefix',
        });
      }
    }
    assert.equal(authority.committedSequence, eventCount);
    assert.equal(authority.residency.events, 1024);
    if (scale) {
      originalExecutionReceipt =
        await authority.committedReceipt('original-execution');
      assert.equal(originalExecutionReceipt.sequence, 2);
    }
    await phase('live', authority, first.resourceStore);
    await authority.close();
    metrics.close.first = true;
  } finally {
    await first.stopLocal();
  }

  observed.snapshot = false;
  observed.query = false;
  const second = storesFor('history-second');
  try {
    const journal = observeScanner(
      await second.journalStore.open({ sessionKey }),
    );
    authority = await LocalManagedSessionAuthority.open({
      journal,
      resources: second.resourceStore,
      sessionKey,
      cwd: '/workspace',
      version: 'pr5-integration',
      ...(historyDirectory ? { historyDirectory } : {}),
    });
    assert.equal(authority.committedSequence, eventCount);
    assert.equal(journal.history.available, true);
    assert(observed.snapshot);
    const old = await authority.findEvent(
      'cancel.requested',
      'requestId',
      'cancel-1',
    );
    assert.equal(old.sequence, 1);
    let executions = 0;
    const replay = await authority.appendExecutionEvents(
      {
        operation: 'cancelHistory',
        commandId: 'history-0',
        contentDigest: 'a'.repeat(64),
        sessionKey,
      },
      () => {
        executions++;
        return [];
      },
      { class: 'trusted_entry' },
    );
    assert.deepEqual(replay, {
      ...original,
      committedSequence: eventCount,
      replayed: true,
    });
    assert.equal(executions, 0);
    if (scale) {
      await assert.rejects(
        authority.appendExecutionEvents(
          {
            operation: 'cancelHistory',
            commandId: 'history-0',
            contentDigest: 'b'.repeat(64),
            sessionKey,
          },
          () => {
            executions++;
            return [];
          },
          { class: 'trusted_entry' },
        ),
        { code: 'managed_session_conflict' },
      );
      assert.equal(executions, 0);
      assert.deepEqual(
        await authority.committedReceipt('original-execution'),
        originalExecutionReceipt,
      );
      assert.equal(authority.committedSequence, eventCount);
    }
    const page = await authority.readEvents({
      afterSequence: 0,
      limit: 100,
      throughSequence: 1024,
    });
    assert.equal(page.length, 100);
    assert.equal(page[0].sequence, 1);
    assert.equal(page.at(-1).sequence, 100);
    assert(observed.query);
    await phase('cold', authority, second.resourceStore);
    await authority.close();
    metrics.close.second = true;
  } finally {
    await second.stopLocal();
  }
  authority = undefined;
  await phase('closed');
  assert(metrics.close.first && metrics.close.second);
  assert.equal(metrics.scan.activeConsumers, 0);
  assert.equal(metrics.scan.legacyReadCalls, 0);
  assert.equal(metrics.scan.peakConsumers, 1);
  assert(metrics.scan.batches > 1);
  console.log('PR5_NATIVE_HISTORY_HTTP_PASS');
  if (engine === 'mysql') console.log('PR5_NATIVE_HISTORY_HTTP_MYSQL_PASS');
} catch (cause) {
  metrics.failure = String(cause);
  await persist();
  throw cause;
} finally {
  clearInterval(sampling);
}
