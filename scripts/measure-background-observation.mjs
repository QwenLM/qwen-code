/**
 * SPDX-License-Identifier: Apache-2.0
 * Phase 3b §7 measurement (docs/design/2026-11-19-managed-runtime-owned-observation.md).
 * Run after `npm run build`. Prints a JSON report per measurement; the numbers
 * settle the §11 open-question constants (outbox budget, segment geometry,
 * partial-flush interval, drain cost). Capture lanes run over an in-memory
 * resource store so the report isolates capture overhead from store I/O; the
 * drain measurement commits through a real on-disk session authority.
 *
 *   node scripts/measure-background-observation.mjs
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const core = (p) =>
  import(path.join(repo, 'packages/core/dist/src/managed-runtime', p));
const cli = (p) => import(path.join(repo, 'packages/cli/dist/src/serve', p));

const { LocalShellStreamCapture } = await core('local-shell-stream-capture.js');
const { ResourceToolResultSegmentStore } = await core(
  'resource-tool-result-store.js',
);
const { openManagedSession } = await core('managed-session-assembly.js');
const { LocalManagedSessionResourceStore } = await core(
  'managed-session-resources.js',
);
const { createManagedHarnessHandle } = await core('managed-harness-factory.js');
const { parseToolResultManifestBytes } = await core('managed-tool-result.js');
const { MANAGED_DELIVERY_REQUEST_LIMIT_BYTES } = await core(
  'managed-delivery-entry.js',
);
const { BackgroundDeliveryRun, WorkerBackgroundCaptureSink } = await cli(
  'managed-background-delivery.js',
);
const { HostedShellPublisher } = await cli('hosted-shell-publisher.js');
const { HostedChildRunSession } = await cli('hosted-child-run-session.js');
const { HostedMonitorSession } = await cli('hosted-monitor-session.js');
const { monitorNotificationText } = await cli('hosted-monitor-notification.js');

const MB = 1024 * 1024;
const report = [];
const emit = (name, data) => {
  const line = { measurement: name, ...data };
  report.push(line);
  console.log(JSON.stringify(line));
};

/** In-memory resource store honoring client-chosen IDs (both lanes). */
function memoryStore() {
  const byId = new Map();
  return {
    async publish(kind, bytes, resourceId = randomUUID()) {
      const ref = {
        resourceId,
        kind,
        schemaVersion: 1,
        byteLength: bytes.byteLength,
        digest: createHash('sha256').update(bytes).digest('hex'),
      };
      byId.set(resourceId, Buffer.from(bytes));
      return ref;
    },
    async read(ref) {
      const bytes = byId.get(ref.resourceId);
      assert.ok(bytes, `missing resource ${ref.resourceId}`);
      return bytes;
    },
    get size() {
      return byId.size;
    },
    get totalBytes() {
      let total = 0;
      for (const bytes of byId.values()) total += bytes.byteLength;
      return total;
    },
  };
}

/** Disk store in the session resource root layout, read via the session's
 * own reader — the authority's verifyExtensionResources requires it. */
function sessionStore(baseDir, sessionId, reader) {
  return {
    async publish(kind, bytes, resourceId = randomUUID()) {
      const directory = path.join(baseDir, 'resources', sessionId, kind);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(path.join(directory, resourceId), bytes);
      return {
        resourceId,
        kind,
        schemaVersion: 1,
        byteLength: bytes.byteLength,
        digest: createHash('sha256').update(bytes).digest('hex'),
      };
    },
    read: (ref) => reader.read(ref),
  };
}

function identity(sessionId, executionCallId) {
  const sessionKey = { tenantId: 't', workspaceId: 'w', sessionId };
  return {
    tenantId: 't',
    sessionId,
    turnId: 'turn',
    executionCallId,
    callId: 'call',
    invocationDigest: `sha256:${'a'.repeat(64)}`,
    bindingGeneration: '1',
    captureId: createHash('sha256')
      .update(JSON.stringify([sessionKey, executionCallId, '1']))
      .digest('hex')
      .slice(0, 32),
    revision: 1,
  };
}

const CHUNK = 64 * 1024; // the executor's RPC write bound
function* chunks(totalBytes) {
  const chunk = Buffer.alloc(CHUNK, 0x61);
  for (let sent = 0; sent < totalBytes; sent += CHUNK) {
    yield chunk.subarray(0, Math.min(CHUNK, totalBytes - sent));
  }
}

/** Drain a held run the way the Broker's staging pull does, no HTTP. */
async function drainLoop(run, isDone) {
  let acked = 0;
  let pulls = 0;
  while (!isDone() || run.pendingCount > 0) {
    const batch = await run.pullForStage({ afterSeq: acked, waitMs: 5 });
    pulls++;
    if (batch.entries.length > 0) {
      acked = batch.entries[batch.entries.length - 1].deliverySeq;
      run.acknowledgeStaged(acked);
    } else if (isDone() && run.pendingCount === 0) {
      break;
    }
  }
  return pulls;
}

// M1 — capture throughput, worker lane vs resident Harness lane (§7 item 4).
// 6 MiB stays under the worker lane's 64-page cap (see M5).
const M1_BYTES = 6 * MB;
{
  const sessionId = randomUUID();
  const id = identity(sessionId, 'exec-worker');
  const run = new BackgroundDeliveryRun('exec-worker', '1', 'child_run');
  const sink = new WorkerBackgroundCaptureSink(id, run);
  const resources = sink.resources;
  sink.setStarted(1);
  let done = false;
  const draining = drainLoop(run, () => done);
  const started = performance.now();
  for (const chunk of chunks(M1_BYTES)) await sink.write('stdout', chunk);
  await sink.finish('stdout', true);
  await sink.finish('stderr', true);
  sink.setProcessResult({ exitCode: 0, signal: null });
  const envelope = await sink.finalize('success', []);
  done = true;
  const pulls = await draining;
  const elapsedMs = performance.now() - started;
  const manifest = parseToolResultManifestBytes(
    await resources.read(envelope.capture.manifest),
  );
  emit('M1-worker-capture', {
    bytes: M1_BYTES,
    elapsedMs: Math.round(elapsedMs),
    mbPerSecond: +(M1_BYTES / MB / (elapsedMs / 1000)).toFixed(1),
    revisions: manifest.revision,
    resources: resources.watermark + 1,
    manifestBytes: (await resources.read(envelope.capture.manifest)).byteLength,
    stagingPulls: pulls,
    captureStatus: envelope.capture.captureStatus,
  });
}
{
  const sessionId = randomUUID();
  const id = identity(sessionId, 'exec-resident');
  const store = memoryStore();
  const capture = new LocalShellStreamCapture(
    new ResourceToolResultSegmentStore(store),
    store,
    id,
  );
  capture.setStarted(1);
  const started = performance.now();
  for (const chunk of chunks(M1_BYTES)) await capture.write('stdout', chunk);
  await capture.finish('stdout', true);
  await capture.finish('stderr', true);
  capture.setProcessResult({ exitCode: 0, signal: null });
  const envelope = await capture.finalize('success', []);
  const elapsedMs = performance.now() - started;
  const manifest = parseToolResultManifestBytes(
    await store.read(envelope.capture.manifest),
  );
  emit('M1-resident-capture', {
    bytes: M1_BYTES,
    elapsedMs: Math.round(elapsedMs),
    mbPerSecond: +(M1_BYTES / MB / (elapsedMs / 1000)).toFixed(1),
    revisions: manifest.revision,
    resources: store.size,
    resourceBytes: store.totalBytes,
    manifestBytes: (await store.read(envelope.capture.manifest)).byteLength,
    captureStatus: envelope.capture.captureStatus,
  });
}

// M2 — entry sizing and the forced-stop terminal closure (§11 Q1/Q3).
{
  const sessionId = randomUUID();
  const id = identity(sessionId, 'exec-stop');
  const run = new BackgroundDeliveryRun('exec-stop', '1', 'child_run');
  const sink = new WorkerBackgroundCaptureSink(id, run);
  sink.setStarted(1);
  // Fill the held outbox until the write queue parks; acknowledge nothing.
  const writing = (async () => {
    for (const chunk of chunks(16 * MB)) await sink.write('stdout', chunk);
  })();
  const deadline = Date.now() + 20_000;
  let previous = -1;
  let stable = 0;
  while (Date.now() < deadline && stable < 3) {
    await new Promise((r) => setTimeout(r, 100));
    const current = run.pendingCount;
    stable = current === previous && current > 0 ? stable + 1 : 0;
    previous = current;
  }
  assert.ok(stable >= 3, 'outbox never parked');
  const parkedEntries = run.pendingCount;
  sink.setStopRequested();
  sink.setProcessResult({ exitCode: null, signal: 9 });
  await sink.finish('stdout', true);
  await sink.finish('stderr', true);
  const envelope = await sink.finalize('error', [], { message: 'SIGKILL' });
  await writing;
  // Pull batches are themselves bounded by the request limit, so drain
  // batch by batch (acknowledging like the Broker) until the terminal lands.
  const sizes = [];
  let terminal;
  let acked = 0;
  for (;;) {
    const batch = await run.pullForStage({
      afterSeq: acked,
      waitMs: 0,
      maxEntries: 256,
    });
    if (batch.entries.length === 0) break;
    for (const entry of batch.entries) {
      if (entry.kind === 'output') {
        sizes.push(Buffer.byteLength(JSON.stringify(entry)));
      }
      if (entry.kind === 'terminal') terminal = entry;
    }
    acked = batch.entries[batch.entries.length - 1].deliverySeq;
    run.acknowledgeStaged(acked);
    if (terminal) break;
  }
  assert.ok(terminal, 'terminal entry missing');
  const terminalBytes = Buffer.byteLength(JSON.stringify(terminal));
  emit('M2-entry-sizing', {
    requestLimitBytes: MANAGED_DELIVERY_REQUEST_LIMIT_BYTES,
    parkedEntries,
    outputEntryBytes: {
      min: Math.min(...sizes),
      max: Math.max(...sizes),
      median: sizes.sort((a, b) => a - b)[Math.floor(sizes.length / 2)],
      samples: sizes.length,
    },
    terminalClosureBytes: terminalBytes,
    terminalFitsRequestLimit:
      terminalBytes <= MANAGED_DELIVERY_REQUEST_LIMIT_BYTES,
    terminalResources: terminal.resources.length,
    captureStatus: envelope.capture.captureStatus,
    captureReason: envelope.capture.captureReason,
  });
}

// M3 — backpressure engagement and drain-resume latency (§7 item 2, worker half).
{
  const sessionId = randomUUID();
  const id = identity(sessionId, 'exec-bp');
  const run = new BackgroundDeliveryRun('exec-bp', '1', 'child_run');
  const sink = new WorkerBackgroundCaptureSink(id, run);
  sink.setStarted(1);
  let done = false;
  const writing = (async () => {
    // 7 MiB: ~9.6 MiB of entries parks on the 8 MiB budget, and 56 pages
    // stays under the 64-page cap so the run completes cleanly after drain.
    for (const chunk of chunks(7 * MB)) await sink.write('stdout', chunk);
    await sink.finish('stdout', true);
    await sink.finish('stderr', true);
    sink.setProcessResult({ exitCode: 0, signal: null });
    await sink.finalize('success', []);
    done = true;
  })();
  // Let the outbox fill and park.
  const deadline = Date.now() + 20_000;
  let previous = -1;
  let stable = 0;
  while (Date.now() < deadline && stable < 3 && !done) {
    await new Promise((r) => setTimeout(r, 100));
    const current = run.pendingCount;
    stable = current === previous && current > 0 ? stable + 1 : 0;
    previous = current;
  }
  const parkedEntries = run.pendingCount;
  const resumeStarted = performance.now();
  const pulls = await drainLoop(run, () => done);
  await writing;
  emit('M3-backpressure-drain', {
    parkedEntries,
    drainResumeAndCompleteMs: Math.round(performance.now() - resumeStarted),
    stagingPulls: pulls,
    backpressureEngaged: parkedEntries > 0,
  });
}

// M4 — applier drain cost at 1/100/10,000 staged observations (§7 item 3).
// Commits through a real on-disk session authority, exactly as the drain-only
// wake does: one observation revision plus one notification input each.
{
  const root = await mkdtemp(path.join(tmpdir(), 'qwen-bg-measure-'));
  try {
    const key = {
      tenantId: 't',
      workspaceId: 'w',
      sessionId: randomUUID(),
    };
    const local = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: root,
      sessionKey: key,
    });
    const session = await openManagedSession({
      runtimeBaseDir: root,
      cwd: root,
      transcriptPath: path.join(root, 'transcript.jsonl'),
      sessionId: key.sessionId,
      sessionKey: key,
      version: 'measure',
      workerId: 'worker-m',
      activationLeaseDurationMs: 600_000,
      create: {
        definitionRef: await local.publish(
          'managed-definition',
          Buffer.from('{}'),
        ),
        rootSnapshotRef: await local.publish('managed-root', Buffer.from('{}')),
        createdBy: 'measure',
      },
    });
    await createManagedHarnessHandle(session).ensureRunnable();
    const resources = sessionStore(root, key.sessionId, session.resources);
    const monitors = new HostedMonitorSession(
      { authority: session.authority, resources },
      key,
    );
    const childRuns = new HostedChildRunSession(
      { authority: session.authority, resources },
      key,
    );
    const EXEC = 'exec-monitor';
    await monitors.admit({
      monitorId: EXEC,
      ownerScopeId: key.sessionId,
      executionCallId: EXEC,
      args: { command: 'tail -f build.log', description: 'measure' },
      maxEvents: 10_000,
      idleTimeoutMs: 600_000,
      debounceMs: 1_000,
    });
    await monitors.dispatchStarted(EXEC, {
      runtimeBindingId: 'binding-m',
      generation: '1',
    });
    await monitors.attach(
      EXEC,
      { runtimeBindingId: 'binding-m', generation: '1' },
      { pid: 1 },
    );
    for (const count of [1, 100, 10_000]) {
      const publisher = new HostedShellPublisher(
        session,
        resources,
        async () => {},
        childRuns,
        monitors,
      );
      publisher.restoreBackgroundCapture(EXEC, 'monitor_run', null);
      // Reset the record's observation watermark between runs by settling
      // nothing: each batch continues the same record, so measure cumulative
      // commits at 1, then 100, then 10,000 total observations.
      const entries = [];
      const base = monitors.record(EXEC).observationSequence;
      for (let i = 1; i <= count - base; i++) {
        const sequence = base + i;
        const inputId = `${EXEC}:notify:${sequence}`;
        const lines = [`line ${sequence}`];
        const contentRef = await resources.publish(
          'managed-input',
          Buffer.from(
            JSON.stringify({
              text: monitorNotificationText({
                monitorId: EXEC,
                toolUseId: EXEC,
                description: 'measure',
                eventCount: sequence,
                lines,
              }),
            }),
          ),
        );
        const admissionRef = await resources.publish(
          'managed-admission',
          Buffer.from('{}'),
        );
        entries.push({
          deliverySeq: sequence,
          executionCallId: EXEC,
          bindingGeneration: '1',
          kind: 'observation',
          sequence,
          lines,
          notification: { inputId, turnId: inputId, contentRef, admissionRef },
          resources: [
            {
              ref: contentRef,
              bytesBase64: (await resources.read(contentRef)).toString(
                'base64',
              ),
              shape: 'referenced',
            },
            {
              ref: admissionRef,
              bytesBase64: (await resources.read(admissionRef)).toString(
                'base64',
              ),
              shape: 'referenced',
            },
          ],
        });
      }
      const started = performance.now();
      await publisher.applyStagedDeliveries(entries, {}, async () => {});
      const elapsedMs = performance.now() - started;
      emit('M4-applier-drain', {
        observations: entries.length,
        cumulativeObservations: count,
        elapsedMs: Math.round(elapsedMs),
        msPerObservation: +(elapsedMs / Math.max(1, entries.length)).toFixed(2),
      });
      await publisher.close();
    }
    await session.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// M5 — total output cap of the worker lane (§11 Q3 finding).
{
  const sessionId = randomUUID();
  const id = identity(sessionId, 'exec-cap');
  const run = new BackgroundDeliveryRun('exec-cap', '1', 'child_run');
  const sink = new WorkerBackgroundCaptureSink(id, run);
  sink.setStarted(1);
  let done = false;
  const draining = drainLoop(run, () => done);
  const started = performance.now();
  for (const chunk of chunks(16 * MB)) {
    await sink.write('stdout', chunk);
    if (sink.capture.brokenReason) break;
  }
  await sink.finish('stdout', true);
  await sink.finish('stderr', true);
  sink.setProcessResult({ exitCode: 0, signal: null });
  const envelope = await sink.finalize('success', []);
  done = true;
  await draining;
  // At the cap every later publish retries the over-cap page and refuses,
  // so the envelope degrades to unavailable and the last durable revision
  // (currentManifest) is the one that stands.
  const lastRef = envelope.capture.manifest ?? sink.capture.currentManifest;
  const manifest = parseToolResultManifestBytes(
    await sink.resources.read(lastRef),
  );
  const stdout = manifest.contents.find((c) => c.streamId === 'stdout');
  emit('M5-total-output-cap', {
    attemptedBytes: 16 * MB,
    admittedBytes: stdout.byteLength,
    pages: stdout.body.pages.length,
    brokenReason: sink.capture.brokenReason,
    envelopeCaptureStatus: envelope.capture.captureStatus,
    lastDurableRevision: manifest.revision,
    manifestBytes: (await sink.resources.read(lastRef)).byteLength,
    elapsedMs: Math.round(performance.now() - started),
    note: 'maxPagesPerStream(64) x segmentsPerPage(1) x segmentBytes(128KiB) = 8MiB total cap; foreground lane reaches ~32GiB',
  });
}

console.log(JSON.stringify({ summary: { measurements: report.length } }));
