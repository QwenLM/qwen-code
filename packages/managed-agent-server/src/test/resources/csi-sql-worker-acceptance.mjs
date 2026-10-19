/** Real SQL/HTTP/file acceptance with explicitly mapped placement and mount provenance. */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { Server } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

const root = process.cwd();
const input = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
const coldFixture = Boolean(input.cold || input.legacyAcceptedOnly);
const output = process.argv[3];
process.env.QWEN_HOME = path.join(output, 'home');
process.env.QWEN_RUNTIME_DIR = path.join(output, 'runtime');
const key = input.sessionKey;
const core = (name) =>
  pathToFileURL(`${root}/packages/core/dist/src/${name}.js`).href;
const cli = (name) =>
  pathToFileURL(`${root}/packages/cli/dist/src/serve/${name}.js`).href;
const { createHttpManagedSessionStores } = await import(
  core('managed-runtime/http-managed-session-store')
);
const { openManagedSession } = await import(
  core('managed-runtime/managed-session-assembly')
);
const { LocalManagedSessionAuthority } = await import(
  core('managed-runtime/managed-session-authority')
);
const { ManagedSessionRecordSink } = await import(
  core('managed-runtime/managed-session-record-sink')
);
const { createManagedHarnessHandle } = await import(
  core('managed-runtime/managed-harness-factory')
);
const { ManagedHookActivationController } = await import(
  core('managed-runtime/managed-hook-activation')
);
const { TurnBudget } = await import(core('core/turn-budget'));
const { managedToolDigest, managedToolResponseParts } = await import(
  core('tools/managed-tool-protocol')
);
const { convertToFunctionResponse } = await import(
  core('core/coreToolScheduler')
);
const { ManagedCsiMount } = await import(cli('managed-csi-mount'));
const { startManagedCsiFileWorker } = await import(
  cli('managed-csi-file-worker')
);
const { computeManagedContextDigest } = await import(
  cli('managed-workspace-binding')
);

const headers = {
  authorization: `Bearer ${input.operatorToken}`,
  'content-type': 'application/json',
  'cache-control': 'no-store',
};
const checks = [];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const wires = [];
async function observedFetch(url, options = {}) {
  if (!coldFixture || new URL(url).pathname.startsWith('/fixture:'))
    return fetch(url, options);
  const wire = {
    url: String(url),
    method: options.method ?? 'GET',
    headers: Object.fromEntries(new Headers(options.headers)),
    body: options.body ?? null,
    startedAt: Date.now(),
  };
  wires.push(wire);
  try {
    const response = await fetch(url, options);
    wire.status = response.status;
    wire.responseHeaders = Object.fromEntries(response.headers);
    wire.responseBase64 = Buffer.from(
      await response.clone().arrayBuffer(),
    ).toString('base64');
    return response;
  } catch (error) {
    wire.failure = String(error);
    throw error;
  } finally {
    wire.endedAt = Date.now();
  }
}
async function post(
  origin,
  route,
  body,
  supplied = headers,
  expected = 200,
  label = route,
) {
  const response = await observedFetch(new URL(route, origin), {
    method: 'POST',
    headers: supplied,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const answer = await response.json();
  assert.equal(
    response.status,
    expected,
    `${label} (${route}): ${JSON.stringify(answer)}`,
  );
  return answer;
}
const fixture = (route, body = {}) => post(input.adapter, route, body);
const broker = (route, body = {}) =>
  post(input.broker, `/internal/runtime-broker/v1${route}`, {
    protocolVersion: 1,
    requestId: randomUUID(),
    harnessSessionId: key.sessionId,
    runtimeSessionId: key.sessionId,
    ...body,
  });

const binaryTypes = new Set([-2, -3, -4, 2004]);
const rowCells = (row) => JSON.parse(row);
const cell = (row, column) => {
  const [, type, value] = rowCells(row).find(([name]) => name === column);
  return value === null || !binaryTypes.has(type)
    ? value
    : Buffer.from(value, 'base64').toString('utf8');
};
const changedRow = (row, fields, clear = false) =>
  JSON.stringify(
    rowCells(row).map(([name, type, original]) => {
      const value = Object.hasOwn(fields, name)
        ? fields[name]
        : clear
          ? null
          : undefined;
      return [
        name,
        type,
        value === undefined
          ? original
          : value === null
            ? null
            : binaryTypes.has(type)
              ? Buffer.from(String(value)).toString('base64')
              : String(value),
      ];
    }),
  );
function tupleKey(...parts) {
  const digest = createHash('sha256');
  for (const part of parts) {
    const bytes = Buffer.from(part);
    const length = Buffer.alloc(4);
    length.writeInt32BE(bytes.length);
    digest.update(length).update(bytes);
  }
  return digest.digest('hex');
}
const wireJson = (wire) =>
  JSON.parse(Buffer.from(wire.responseBase64, 'base64').toString('utf8'));
const wirePath = (wire) => new URL(wire.url).pathname;
const writerWires = (id, suffix) =>
  wires.filter(
    (wire) =>
      wirePath(wire).endsWith(suffix) &&
      wire.body &&
      JSON.parse(wire.body).writerId === id,
  );
async function fileImage() {
  const image = [];
  async function walk(relative) {
    const file = path.join(workspace, relative);
    const stat = await fs.lstat(file, { bigint: true });
    image.push({
      path: relative,
      dev: String(stat.dev),
      ino: String(stat.ino),
      mode: String(stat.mode),
      bytes: stat.isFile()
        ? (await fs.readFile(file)).toString('base64')
        : null,
    });
    if (stat.isDirectory())
      for (const name of (await fs.readdir(file)).sort())
        await walk(path.join(relative, name));
  }
  await walk('');
  return image;
}
async function coldImage(label) {
  const snapshot = await fixture('/fixture:cold-observe');
  snapshot.files = await fileImage();
  snapshot.worker = structuredClone(worker.ready);
  assert.equal(Object.keys(snapshot.image).length, 35);
  await fs.writeFile(
    path.join(output, `${label}.json`),
    JSON.stringify(snapshot, null, 2),
  );
  return snapshot;
}
function sameSideEffects(before, after) {
  assert.deepEqual(after.files, before.files);
  assert.deepEqual(after.worker, before.worker);
  assert.deepEqual(after.counters, before.counters);
}
function unchanged(before, after) {
  sameSideEffects(before, after);
  assert.deepEqual(after.image, before.image);
}
function timeBetween(value, before, after) {
  assert.ok(
    Number.isSafeInteger(value) && value >= before.now && value <= after.now,
  );
  return value;
}
function publicationImage(before, after, ref, bytes) {
  const expected = structuredClone(before.image);
  const scope = tupleKey(key.tenantId, key.sessionId);
  const added = after.image.ma_resource.filter(
    (row) => !before.image.ma_resource.includes(row),
  );
  assert.equal(added.length, 1);
  const created = timeBetween(
    Number(cell(added[0], 'gmt_create')),
    before,
    after,
  );
  expected.ma_resource.push(
    changedRow(
      before.image.ma_resource[0],
      {
        resource_key: tupleKey(scope, ref.resourceId),
        session_scope_key: scope,
        tenant_id: key.tenantId,
        workspace_id: key.workspaceId,
        session_id: key.sessionId,
        resource_id: ref.resourceId,
        kind: ref.kind,
        schema_version: ref.schemaVersion,
        byte_length: bytes.length,
        sha256: hash(bytes),
        storage_kind: 'MYSQL_INLINE',
        inline_bytes: bytes.toString('utf8'),
        publish_command_id: ref.resourceId,
        state: 'PUBLISHED',
        gmt_create: created,
        last_verified_at: created,
      },
      true,
    ),
  );
  expected.ma_resource.sort();
  sameSideEffects(before, after);
  assert.deepEqual(after.image, expected);
}
function installedImage(
  before,
  after,
  wire,
  activation,
  writerId,
  writerToken,
) {
  const request = JSON.parse(wire.body);
  const receipt = wireJson(wire);
  const expected = structuredClone(before.image);
  const revision = request.expectedJournalRevision + 1;
  assert.equal(
    Number(cell(before.image.ma_session_head[0], 'journal_revision')),
    request.expectedJournalRevision,
  );
  assert.equal(
    Number(cell(before.image.ma_session_head[0], 'wake_head_revision')),
    request.expectedJournalRevision,
  );
  assert.equal(request.operation, 'installActivation');
  assert.equal(request.writerGeneration, 2);
  assert.equal(request.activationEpoch, 2);
  assert.equal(request.eventCount, 1);
  assert.equal(receipt.journalRevision, revision);
  assert.equal(receipt.replayed, false);
  const records = Buffer.from(request.recordBytesBase64, 'base64')
    .toString('utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const events = records
    .map((record) => record.managedSession)
    .filter((record) => record.kind === 'activation.changed');
  assert.equal(events.length, 1);
  const event = events[0].payload;
  assert.equal(event.activationId, activation.activationId);
  assert.equal(event.epoch, 2);
  assert.equal(event.workerId, writerId);
  assert.equal(event.phase, 'active');
  assert.equal(event.boundaryRef, null);
  const head = after.image.ma_session_head[0];
  const now = timeBetween(Number(cell(head, 'gmt_modified')), before, after);
  expected.ma_session_head = [
    changedRow(before.image.ma_session_head[0], {
      journal_revision: revision,
      wake_head_revision: revision,
      committed_sequence: request.lastSequence,
      last_commit_digest: request.commitDigest,
      activation_epoch: 2,
      activation_id: activation.activationId,
      activation_phase: 'active',
      activation_event_epoch: 2,
      activation_expires_at: event.expiresAt,
      activation_head_revision: revision,
      gmt_modified: now,
    }),
  ];
  const recordBytes = Buffer.from(request.recordBytesBase64, 'base64');
  assert.equal(hash(recordBytes), request.recordDigest);
  expected.ma_session_journal_tx.push(
    changedRow(
      before.image.ma_session_journal_tx[0],
      {
        tenant_id: key.tenantId,
        workspace_id: key.workspaceId,
        session_id: key.sessionId,
        journal_revision: revision,
        command_key_hash: hash(`${request.operation}\0${request.commandId}`),
        transaction_id: request.transactionId,
        operation: request.operation,
        command_id: request.commandId,
        content_digest: request.contentDigest,
        first_sequence: request.firstSequence,
        last_sequence: request.lastSequence,
        event_count: request.eventCount,
        events_digest: request.eventsDigest,
        previous_commit_digest: request.previousCommitDigest,
        commit_digest: request.commitDigest,
        writer_generation: 2,
        writer_id: writerId,
        writer_token_hash: hash(writerToken),
        activation_epoch: 2,
        latest_checkpoint_resource_id: request.latestCheckpointResourceId,
        record_encoding: 'identity',
        record_bytes: recordBytes.toString('utf8'),
        byte_length: recordBytes.length,
        record_digest: request.recordDigest,
        gmt_create: now,
      },
      true,
    ),
  );
  assert.equal(request.resources.length, 1);
  const resource = request.resources[0];
  assert.equal(resource.resourceId, event.installRef.resourceId);
  assert.equal(resource.kind, 'managed-activation-install');
  const scope = tupleKey(key.tenantId, key.sessionId);
  const bytes = Buffer.from(resource.bytesBase64, 'base64');
  assert.equal(hash(bytes), resource.digest);
  assert.equal(bytes.length, resource.byteLength);
  expected.ma_resource.push(
    changedRow(
      before.image.ma_resource[0],
      {
        resource_key: tupleKey(scope, resource.resourceId),
        session_scope_key: scope,
        tenant_id: key.tenantId,
        workspace_id: key.workspaceId,
        session_id: key.sessionId,
        resource_id: resource.resourceId,
        kind: resource.kind,
        schema_version: resource.schemaVersion,
        byte_length: resource.byteLength,
        sha256: resource.digest,
        storage_kind: 'MYSQL_INLINE',
        inline_bytes: bytes.toString('utf8'),
        publish_command_id: request.commandId,
        state: 'REFERENCED',
        gmt_create: now,
        last_verified_at: now,
      },
      true,
    ),
  );
  expected.ma_resource_ref.push(
    changedRow(
      before.image.ma_resource_ref[0],
      {
        session_scope_key: scope,
        owner_kind: 'JOURNAL',
        owner_key: scope,
        owner_revision: revision,
        resource_key: tupleKey(scope, resource.resourceId),
        tenant_id: key.tenantId,
        workspace_id: key.workspaceId,
        session_id: key.sessionId,
        journal_revision: revision,
        resource_id: resource.resourceId,
        gmt_create: now,
      },
      true,
    ),
  );
  for (const rows of Object.values(expected)) rows.sort();
  sameSideEffects(before, after);
  assert.deepEqual(after.image, expected);
}

async function coldTakeover(cut, writerId, writerToken) {
  await stopActivation();
  await stores.assertWritable();
  const renewal = writerWires(writerId, '/writers:renew').at(-1);
  assert.equal(renewal.status, 200);
  const transaction = writerWires(writerId, '/transactions:commit').at(-1);
  assert.equal(transaction.status, 200);
  const preparation = wires.find(
    (wire) =>
      wirePath(wire).endsWith('/executions:prepare') && wire.status === 200,
  );
  assert.ok(preparation);
  const { resultJson } = await fixture('/fixture:cold-result', {
    executionCallId: cut.executionCallId,
  });
  assert.deepEqual(JSON.parse(resultJson), cut.result);
  const beforePublication = await coldImage('cold-before-publication');
  const bytes = Buffer.from(resultJson, 'utf8');
  const resourceId = randomUUID();
  const ref = await stores.toolResultResources.publish(
    'managed-tool-result-content',
    bytes,
    resourceId,
  );
  const published = await coldImage('cold-published');
  publicationImage(beforePublication, published, ref, bytes);
  const publication = writerWires(writerId, '/tool-results:publish').at(-1);
  assert.equal(publication.status, 200);
  assert.deepEqual(
    await stores.toolResultResources.publish(ref.kind, bytes, resourceId),
    ref,
  );
  const retried = await coldImage('cold-publication-retried');
  unchanged(published, retried);
  await stores.stopLocal();
  assert.ok(
    writerWires(writerId, '/writers:renew').every(
      (wire) => wire.status === 200 && wire.endedAt,
    ),
  );
  assert.equal(writerWires(writerId, '/writers:renew').at(-1), renewal);
  const quiet = await coldImage('cold-renewals-joined');
  unchanged(retried, quiet);
  assert.equal(
    Number(cell(quiet.image.ma_session_head[0], 'writer_generation')),
    1,
  );
  assert.equal(
    Number(cell(quiet.image.ma_session_head[0], 'activation_epoch')),
    1,
  );
  const expiry = Math.max(
    Number(cell(quiet.image.ma_session_head[0], 'writer_lease_until')),
    Number(cell(quiet.image.ma_session_head[0], 'activation_expires_at')),
  );
  const clock = [{ now: quiet.now, expiry }];
  const deadline = Date.now() + 20000;
  let now = quiet.now;
  while (now <= expiry) {
    const sample = await fixture('/fixture:cold-observe');
    now = sample.now;
    clock.push({ now: sample.now, expiry });
    assert.deepEqual(sample.image, quiet.image);
    assert.deepEqual(sample.counters, quiet.counters);
    if (sample.now > expiry) break;
    assert.ok(Date.now() < deadline, 'Natural database lease expiry timed out');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await fs.writeFile(
    path.join(output, 'cold-clock.json'),
    JSON.stringify(clock, null, 2),
  );
  const expired = await coldImage('cold-expired');
  unchanged(quiet, expired);
  const candidates = [randomUUID(), randomUUID()];
  const client = (id) => {
    const result = createHttpManagedSessionStores({
      baseUrl: input.adapter,
      sessionKey: key,
      writerId: id,
      writerToken,
      leaseDurationMs: 300000,
      requestTimeoutMs: 20000,
      fetchFn: observedFetch,
    });
    coldStores.push(result);
    return result;
  };
  const clients = candidates.map(client);
  await fixture('/fixture:cold-arm', { writers: candidates });
  const acquiring = Promise.allSettled(
    clients.map((candidate) =>
      candidate.journalStore.open({ sessionKey: key }),
    ),
  );
  let contention;
  let outcomes;
  try {
    contention = await fixture('/fixture:cold-release');
  } finally {
    outcomes = await acquiring;
  }
  await fs.writeFile(
    path.join(output, 'cold-contention.json'),
    JSON.stringify(contention, null, 2),
  );
  assert.equal(
    outcomes.filter((outcome) => outcome.status === 'fulfilled').length,
    1,
  );
  const winner = outcomes.findIndex(
    (outcome) => outcome.status === 'fulfilled',
  );
  const loser = 1 - winner;
  const journal = outcomes[winner].value;
  assert.equal(journal.takeoverCommitProof, undefined);
  const claims = candidates.flatMap((id) =>
    writerWires(id, '/writers:acquire'),
  );
  assert.equal(claims.length, 2);
  assert.deepEqual(claims.map((wire) => wire.status).sort(), [200, 409]);
  assert.equal(
    wireJson(claims.find((wire) => wire.status === 409)).error.code,
    'managed_session_writer_conflict',
  );
  const grant = wireJson(
    writerWires(candidates[winner], '/writers:acquire')[0],
  );
  assert.equal(grant.writerGeneration, 2);
  assert.equal(grant.activationEpoch, 1);
  assert.equal(grant.replayed, false);
  const claimed = await coldImage('cold-claimed');
  const expected = structuredClone(expired.image);
  const head = expired.image.ma_session_head[0];
  assert.equal(grant.journalRevision, Number(cell(head, 'journal_revision')));
  assert.equal(
    grant.committedSequence,
    Number(cell(head, 'committed_sequence')),
  );
  assert.equal(grant.lastCommitDigest, cell(head, 'last_commit_digest'));
  const claimedAt = timeBetween(grant.leaseUntil - 300000, expired, claimed);
  expected.ma_session_head = [
    changedRow(head, {
      writer_id: candidates[winner],
      writer_generation: 2,
      writer_lease_until: grant.leaseUntil,
      gmt_modified: claimedAt,
    }),
  ];
  sameSideEffects(expired, claimed);
  assert.deepEqual(claimed.image, expected);
  for (const warm of Object.values(contention.warmed)) {
    assert.equal(warm.isolation, input.cold);
    assert.equal(warm.autoCommit, false);
    assert.equal(warm.writerId, writerId);
    assert.equal(warm.writerGeneration, 1);
    assert.equal(warm.journalRevision, grant.journalRevision);
    assert.equal(warm.committedSequence, grant.committedSequence);
    assert.equal(warm.lastCommitDigest, grant.lastCommitDigest);
    assert.equal(warm.activationEpoch, 1);
  }
  await assert.rejects(
    client(candidates[loser]).journalStore.open({ sessionKey: key }),
    (error) =>
      error.status === 409 &&
      error.remoteCode === 'managed_session_writer_conflict',
  );
  unchanged(claimed, await coldImage('cold-loser-retried'));
  async function replay(original, label, code) {
    const before = await coldImage(`${label}-before`);
    const response = await observedFetch(original.url, {
      method: original.method,
      headers: original.headers,
      body: original.body,
      signal: AbortSignal.timeout(20000),
    });
    assert.equal(response.status, 409);
    const answer = await response.json();
    if (wirePath(original).startsWith('/internal/runtime-broker/')) {
      assert.equal(answer.code, code);
      assert.equal(typeof answer.error, 'string');
      assert.equal(answer.retryable, false);
    } else {
      assert.equal(answer.error.code, code);
    }
    const expected = structuredClone(before);
    if (wirePath(original).endsWith('/writers:renew')) expected.counters[3]++;
    unchanged(expected, await coldImage(`${label}-after`));
  }
  await replay(
    preparation,
    'cold-before-install-prepare',
    'csi_original_activation_unavailable',
  );
  const restoreStart = wires.length;
  const authority = await LocalManagedSessionAuthority.open({
    journal,
    resources: clients[winner].resourceStore,
    sessionKey: key,
    cwd: '/workspace',
    version: 'hosted-harness/1',
  });
  const restored = await coldImage('cold-restored');
  const restoration = wires.slice(restoreStart);
  assert.equal(
    restoration.filter((wire) => wirePath(wire).endsWith('/restore')).length,
    1,
  );
  assert.ok(
    restoration.some((wire) => wirePath(wire).endsWith('/transactions')),
  );
  assert.ok(
    restoration.every(
      (wire) =>
        wire.method === 'GET' &&
        wire.status === 200 &&
        (wirePath(wire).endsWith('/restore') ||
          wirePath(wire).endsWith('/transactions')),
    ),
  );
  unchanged(claimed, restored);
  assert.equal(authority.currentActivation.epoch, 1);
  const activation = await authority.installActivation({
    activationId: randomUUID(),
    workerId: candidates[winner],
    leaseDurationMs: 300000,
  });
  assert.equal(activation.epoch, 2);
  const installed = await coldImage('cold-installed');
  const installs = writerWires(candidates[winner], '/transactions:commit');
  assert.equal(installs.length, 1);
  assert.equal(installs[0].status, 200);
  installedImage(
    restored,
    installed,
    installs[0],
    activation,
    candidates[winner],
    writerToken,
  );
  for (const [label, request] of [
    ['transaction', transaction],
    ['renewal', renewal],
    ['publication', publication],
  ])
    await replay(
      request,
      `cold-stale-${label}`,
      'managed_session_writer_conflict',
    );
  assert.ok(
    candidates.every((id) => writerWires(id, '/writers:renew').length === 0),
  );
  assert.equal(writerWires(writerId, '/writers:seal').length, 0);
  assert.equal(
    Number(cell(installed.image.ma_session_head[0], 'activation_epoch')),
    2,
  );
  return {
    isolation: input.cold,
    writerGeneration: 2,
    activationEpoch: 2,
    publication: ref,
    originalWriterId: writerId,
    winner: candidates[winner],
    loser: candidates[loser],
    contention,
    resourceReads:
      restored.image.ma_request_receipt.length -
      claimed.image.ma_request_receipt.length,
  };
}

// This platform facade delegates all file operations to real handles/inodes.
// It does not intercept authentication, SQL native fetch, composition, tools or results.
const native = Object.fromEntries(
  ['open', 'lstat', 'mkdir', 'readdir', 'unlink', 'realpath', 'access'].map(
    (name) => [name, fs[name]],
  ),
);
const actualPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const workspace = await fs.realpath(
  await fs.mkdtemp(path.join(output, 'workspace-')),
);
const rootHandle = await native.open(
  workspace,
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
);
const stats = await rootHandle.stat({ bigint: true });
const dev = stats.dev;
const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n);
const minor = (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n);
const mount = {
  mountId: '9',
  device: `${major}:${minor}`,
  source: '/dev/nvme1n1',
  diskSerial: 'owned-serial',
  rootDevice: dev.toString(),
  rootInode: stats.ino.toString(),
};
const handles = new Map([[rootHandle.fd, workspace]]);
const opened = new Set();
// Translate unconditionally, as managed-csi-mount.test.ts does: this fixture
// fakes the mount, so the owned descriptors are the ones in `handles` whether
// or not the host really exposes /proc/self/fd.
const mappedAddress = (file) => {
  if (process.platform !== 'linux' || typeof file !== 'string') return file;
  if (file === '/workspace' || file.startsWith('/workspace/'))
    return path.join(workspace, file.slice('/workspace'.length));
  const matched = /^\/proc\/self\/fd\/(\d+)(?:\/(.*))?$/.exec(file);
  if (!matched) return file;
  const address = handles.get(Number(matched[1]));
  assert.ok(address, 'Unknown owned proc-fd address');
  return matched[2] ? path.join(address, matched[2]) : address;
};
const originalMount = Object.getOwnPropertyDescriptors(
  ManagedCsiMount.prototype,
);
const nativeListen = Server.prototype.listen;
let worker,
  stores,
  session,
  retirementJoined = false;
const coldStores = [];
let stopActivation = async () => {};
let recoveredLegacySession;
try {
  await fs.writeFile(path.join(workspace, 'marker.txt'), 'alpha\n', {
    mode: 0o640,
  });
  const { boot, pod } = await fixture('/fixture:setup', { mount });
  Object.defineProperty(process, 'platform', {
    value: 'linux',
    configurable: true,
  });
  for (const name of [
    'open',
    'lstat',
    'mkdir',
    'readdir',
    'unlink',
    'realpath',
    'access',
  ]) {
    fs[name] = async (file, ...args) => {
      const address = mappedAddress(file);
      const result = await native[name](address, ...args);
      if (name === 'open') {
        handles.set(result.fd, String(address));
        opened.add(result);
        const close = result.close.bind(result);
        const fd = result.fd;
        result.close = async () => {
          await close();
          handles.delete(fd);
          opened.delete(result);
        };
      }
      if (
        name === 'realpath' &&
        typeof file === 'string' &&
        (file === '/workspace' || file.startsWith('/workspace/'))
      )
        return file;
      return result;
    };
  }
  ManagedCsiMount.prototype.kernelObservation = async () => ({
    mountId: mount.mountId,
    device: mount.device,
    source: mount.source,
  });
  Server.prototype.listen = function () {
    return Reflect.apply(nativeListen, this, [0, '127.0.0.1']);
  };
  process.env.QWEN_POD_UID = pod.uid;
  process.env.QWEN_POD_NAMESPACE = pod.namespace;
  process.env.QWEN_NODE_NAME = pod.nodeName;
  worker = await startManagedCsiFileWorker(boot);
  Server.prototype.listen = nativeListen;
  await fixture('/fixture:worker', { url: worker.ready.context.url });
  await broker('/tool-sessions:acquire', { turnKind: 'bootstrap' });
  const writerId = randomUUID();
  const writerToken = randomBytes(32).toString('base64url');
  const leaseDurationMs = coldFixture
    ? 15000
    : input.coldRecovery
      ? 10000
      : 300000;
  let originalReceiptRequest;
  let coldRefusalChecks = 0;
  stores = createHttpManagedSessionStores({
    baseUrl: input.adapter,
    sessionKey: key,
    writerId,
    writerToken,
    leaseDurationMs,
    requestTimeoutMs: 20000,
    fetchFn: async (url, options) => {
      const response = await observedFetch(url, options);
      if (
        input.coldRecovery &&
        response.ok &&
        /\/transactions:commit(?:-v2)?$/u.test(new URL(url).pathname) &&
        JSON.parse(options.body).operation === 'recordToolResult'
      )
        originalReceiptRequest = { url, options };
      return response;
    },
  });
  const definitionRef = await stores.resourceStore.publish(
    'managed-definition',
    Buffer.from(
      JSON.stringify({
        engine: 'managed',
        sessionId: key.sessionId,
        toolProfile: 'csi-files-retirement/1',
      }),
    ),
  );
  const rootSnapshotRef = await stores.resourceStore.publish(
    'managed-root',
    Buffer.from(JSON.stringify({ cwd: '/workspace' })),
  );
  const sessionOptions = {
    runtimeBaseDir: output,
    transcriptPath: '',
    sessionId: key.sessionId,
    sessionKey: key,
    cwd: '/workspace',
    version: 'hosted-harness/1',
    workerId: writerId,
    activationLeaseDurationMs: leaseDurationMs,
    journalStore: stores.journalStore,
    resourceStore: stores.resourceStore,
    requireNew: true,
    create: { definitionRef, rootSnapshotRef, createdBy: 'hosted-harness' },
  };
  if (coldFixture) {
    const journal = await stores.journalStore.open({ sessionKey: key });
    const authority = await LocalManagedSessionAuthority.open({
      journal,
      resources: stores.resourceStore,
      sessionKey: key,
      cwd: sessionOptions.cwd,
      version: sessionOptions.version,
      requireNew: true,
      create: sessionOptions.create,
    });
    const activation = await authority.installActivation({
      activationId: randomUUID(),
      workerId: writerId,
      leaseDurationMs: 15000,
    });
    const deny = async () => assert.fail('Cold cut must not close or release');
    session = {
      authority,
      resources: stores.resourceStore,
      activation,
      sink: new ManagedSessionRecordSink(
        authority,
        stores.resourceStore,
        () => ({
          class: 'harness',
          activation,
        }),
      ),
      close: deny,
      releaseActivation: deny,
      replaceActivation: deny,
    };
    let stopped = false;
    let renewal;
    const failures = [];
    const timer = setInterval(() => {
      if (stopped || renewal) return;
      const pending = authority.renewActivation({ leaseDurationMs: 15000 });
      renewal = pending;
      void pending.then(
        (value) => {
          if (!value) failures.push('Activation renewal returned no outcome');
          renewal = undefined;
        },
        (error) => {
          failures.push(String(error));
          renewal = undefined;
        },
      );
    }, 5000);
    timer.unref();
    stopActivation = async () => {
      stopped = true;
      clearInterval(timer);
      await renewal;
      assert.deepEqual(failures, []);
      assert.equal(authority.currentActivation.phase, 'active');
      assert.equal(authority.currentActivation.epoch, 1);
    };
  } else {
    session = await openManagedSession(sessionOptions);
  }
  const initialActivation = { ...session.activation };
  let expectedActivation = initialActivation;
  const control = async (action, extra = {}) =>
    (
      await broker(`/tool-sessions/${key.sessionId}/control`, {
        operation: { kind: 'csi-file-history', version: 1, action, ...extra },
      })
    ).result.observation;
  let observation = await control('bind');
  let parent = null;
  const record = (type, fields = {}) => ({
    uuid: randomUUID(),
    parentUuid: parent,
    sessionId: key.sessionId,
    timestamp: new Date().toISOString(),
    type,
    cwd: '/workspace',
    version: 'hosted-harness/1',
    ...fields,
  });
  const actor = { class: 'harness', activation: session.activation };
  async function history(commandId, preparation, value) {
    const digestContent = {
      schemaVersion: 2,
      profile: 'csi-files-retirement/1',
      runtimeSessionId: key.sessionId,
      ...value,
      preparation,
    };
    const content = {
      ...digestContent,
      record: record('system', {
        subtype: 'file_history_snapshot',
        systemPayload: { snapshots: value.state.snapshots },
      }),
    };
    return session.authority.commitDomainRecord(
      {
        operation: 'commitFileHistory',
        commandId,
        sessionKey: key,
        contentDigest: managedToolDigest(digestContent),
      },
      { domain: 'file_history', content },
      { class: 'trusted_entry' },
    );
  }
  const bound = await history(
    `csi-file-history:bind:${key.sessionId}`,
    null,
    observation,
  );
  const resourceUrl = new URL(
    `/internal/managed-session-store/v1/sessions/${key.sessionId}/resources/${bound.recordRef.resourceId}`,
    input.adapter,
  );
  resourceUrl.searchParams.set('workspaceId', key.workspaceId);
  const resourceResponse = await fetch(resourceUrl, {
    headers: { 'X-Qwen-Managed-Writer-Token': writerToken },
    signal: AbortSignal.timeout(20000),
  });
  assert.equal(resourceResponse.status, 200);
  assert.equal(resourceResponse.headers.get('cache-control'), 'no-store');
  assert.equal(
    hash(Buffer.from(await resourceResponse.arrayBuffer())),
    bound.recordRef.digest,
  );
  await createManagedHarnessHandle(session).ensureCheckpoint();
  const declarations = JSON.parse(
    await fs.readFile(path.join(output, 'declarations.json'), 'utf8'),
  );
  const usage = [
    {
      promptTokenCount: 1,
      candidatesTokenCount: 1,
      thoughtsTokenCount: 0,
      totalTokenCount: 2,
      cachedContentTokenCount: 0,
    },
  ];
  const invocations = [];
  let firstPins;
  let completedTurns = 0;
  let firstSettled;
  let coldResult;
  let reachCut;
  const cutReached = new Promise((resolve) => {
    reachCut = resolve;
  });
  let producerState;
  async function legacyTakeover(cut, originalWriterId, token) {
    const acceptedIds = input.legacyMissingValid
      ? ['legacy-read-0']
      : ['legacy-read-0', 'legacy-read-2'];
    assert.deepEqual(
      cut.members.map((member) => member.fc.id),
      acceptedIds,
    );
    assert.deepEqual(
      cut.members.map((member) => member.reference.ordinal),
      input.legacyMissingValid ? [0] : [0, 2],
    );
    const projected = await session.sink.project();
    const assistant = projected.find((entry) => entry.uuid === cut.batchId);
    assert.deepEqual(
      assistant.message.parts.flatMap((part) =>
        part.functionCall ? [part.functionCall.id] : [],
      ),
      ['legacy-read-0', 'legacy-invalid-1', 'legacy-read-2'],
    );
    assert.ok(
      !projected.some(
        (entry) =>
          entry.type === 'tool_result' &&
          entry.message.parts.some(
            (part) => part.functionResponse?.id === 'legacy-invalid-1',
          ),
      ),
    );
    const events = session.authority.eventsInSequenceRange(
      1,
      session.authority.committedSequence,
    );
    assert.equal(
      events.filter((event) => event.kind === 'tool.intent').length,
      acceptedIds.length,
    );
    assert.equal(
      events.filter((event) => event.kind === 'tool.receipt').length,
      acceptedIds.length,
    );
    const oldExecutions = (await fixture('/fixture:inspect')).executions;
    assert.equal(oldExecutions.length, acceptedIds.length);
    assert.ok(
      oldExecutions.every((row) => row.native_authorization_json !== null),
    );
    const originalOwner = await stores.publication.owner();
    await stopActivation();
    await stores.assertWritable();
    await stores.stopLocal();
    const quiet = await coldImage('legacy-joined');
    const prefix = `/internal/managed-session-store/v1/sessions/${key.sessionId}`;
    const storeHeaders = {
      ...headers,
      'X-Qwen-Managed-Writer-Token': token,
      'X-Qwen-Tenant-Id': key.tenantId,
    };
    await post(
      input.adapter,
      `${prefix}/writers:acquire`,
      {
        workspaceId: key.workspaceId,
        writerId: randomUUID(),
        leaseMillis: 300000,
      },
      storeHeaders,
      409,
    );
    const liveRefused = await coldImage('legacy-live-refused');
    unchanged(quiet, liveRefused);
    const clock = [];
    const deadline = Date.now() + 30000;
    for (;;) {
      const lease = await fixture('/fixture:leases');
      clock.push(lease);
      if (
        lease.databaseNow >
        Math.max(lease.writerLeaseUntil, lease.activationExpiresAt)
      )
        break;
      assert.ok(
        Date.now() < deadline,
        'Original writer/activation must expire in real DB time',
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await fs.writeFile(
      path.join(output, 'legacy-clock.json'),
      JSON.stringify(clock, null, 2),
    );
    const expired = await coldImage('legacy-expired');
    unchanged(quiet, expired);
    let evidenceRefusals = 0;
    if (!input.legacyMissingValid) {
      const checked = await fixture('/fixture:cold-refusals', {
        writerToken: token,
      });
      assert.equal(checked.refusals, 4);
      evidenceRefusals = checked.refusals;
      unchanged(expired, await coldImage('legacy-negative-controls-restored'));
    }
    const successorWriter = randomUUID();
    const grant = await post(
      input.adapter,
      `${prefix}/writers:acquire`,
      {
        workspaceId: key.workspaceId,
        writerId: successorWriter,
        leaseMillis: 300000,
      },
      storeHeaders,
      input.legacyMissingValid ? 409 : 200,
      'legacy accepted-only cold acquisition',
    );
    if (input.legacyMissingValid) {
      unchanged(expired, await coldImage('legacy-missing-valid-refused'));
      return {
        legacyAcceptedOnly: true,
        missingValid: true,
        acquireStatus: 409,
        writerGeneration: originalOwner.writerGeneration,
        activationEpoch: initialActivation.epoch,
        originalCallCount: 3,
        acceptedCount: acceptedIds.length,
        recoveredCount: 0,
      };
    }
    assert.equal(grant.writerGeneration, 2);
    const successor = createHttpManagedSessionStores({
      baseUrl: input.adapter,
      sessionKey: key,
      writerId: successorWriter,
      writerToken: token,
      leaseDurationMs: 300000,
      requestTimeoutMs: 20000,
      fetchFn: observedFetch,
    });
    coldStores.push(successor);
    const recoveredSession = await openManagedSession({
      runtimeBaseDir: output,
      transcriptPath: '',
      sessionId: key.sessionId,
      sessionKey: key,
      cwd: '/workspace',
      version: 'hosted-harness/1',
      workerId: successorWriter,
      activationLeaseDurationMs: 300000,
      journalStore: successor.journalStore,
      resourceStore: successor.resourceStore,
    });
    recoveredLegacySession = recoveredSession;
    const { recoverHostedCsiReceipts } = await import(
      cli('hosted-csi-cold-recovery')
    );
    const recovered = await recoverHostedCsiReceipts(
      recoveredSession,
      { baseUrl: input.broker, token: input.operatorToken },
      cut.promptId,
      cut.prompt,
    );
    assert.deepEqual(
      recovered.parts.map((part) => part.functionResponse.id),
      acceptedIds,
    );
    assert.equal(recovered.finalOutput, undefined);
    assert.deepEqual(
      (await fixture('/fixture:inspect')).executions,
      oldExecutions,
    );
    assert.equal(
      await fs.readFile(path.join(workspace, 'marker.txt'), 'utf8'),
      'alpha\n',
    );
    return {
      legacyAcceptedOnly: true,
      missingValid: false,
      acquireStatus: 200,
      writerGeneration: (await successor.publication.owner()).writerGeneration,
      activationEpoch: recoveredSession.activation.epoch,
      originalCallCount: 3,
      acceptedCount: acceptedIds.length,
      recoveredCount: recovered.parts.length,
      evidenceRefusals,
    };
  }
  for (const [index, mutation] of [
    {
      name: 'write_file',
      args: { file_path: 'marker.txt', content: 'beta\n' },
    },
    {
      name: 'edit',
      args: {
        file_path: 'marker.txt',
        old_string: 'beta',
        new_string: 'gamma',
      },
    },
  ].entries()) {
    const promptId = randomUUID();
    const prompt = `owned file turn ${index + 1}`;
    const bytes = Buffer.from(JSON.stringify([{ type: 'text', text: prompt }]));
    const digest = hash(bytes);
    const contentRef = await session.resources.publish('managed-input', bytes);
    const admissionRef = await session.resources.publish(
      'managed-admission',
      Buffer.from(JSON.stringify({ promptId, digest: `sha256:${digest}` })),
    );
    await session.authority.submitInput(
      {
        operation: 'submitInput',
        commandId: promptId,
        sessionKey: key,
        contentDigest: digest,
      },
      {
        inputId: promptId,
        turnId: promptId,
        source: 'hosted-harness',
        contentRef,
        admissionRef,
        deadline: null,
        wakeReason: 'input',
      },
    );
    if (input.hostedProducer) {
      const { runHostedFileTurn } = await import('./csi-hosted-file-turns.mjs');
      const actual = await runHostedFileTurn({
        root,
        output,
        session,
        promptId,
        prompt,
        index,
        mutation,
        recoveryCut: input.recoveryCut,
        files: {
          broker: { baseUrl: input.broker, token: input.operatorToken },
          runtime: input.runtime,
        },
        ...(input.coldRecovery && index === 0
          ? {
              recover: async () => {
                assert.ok(
                  originalReceiptRequest,
                  'Capture an actual old-writer receipt transaction',
                );
                const originalExecutions = (await fixture('/fixture:inspect'))
                  .executions;
                const working = await fs.readFile(
                  path.join(workspace, 'marker.txt'),
                );
                await assert.rejects(
                  session.close({ releaseActivation: false }),
                  (error) =>
                    [
                      'csi_finalize_required',
                      'csi_managed_mutation_unavailable',
                    ].includes(error.remoteCode),
                );
                await stores.stopLocal();
                session = undefined;
                stores = undefined;
                const storeHeaders = {
                  ...headers,
                  'X-Qwen-Managed-Writer-Token': writerToken,
                  'X-Qwen-Tenant-Id': key.tenantId,
                };
                const prefix = `/internal/managed-session-store/v1/sessions/${key.sessionId}`;
                const beforeLive = await fixture('/fixture:image');
                await post(
                  input.adapter,
                  `${prefix}/writers:acquire`,
                  {
                    workspaceId: key.workspaceId,
                    writerId: randomUUID(),
                    leaseMillis: 1000,
                  },
                  storeHeaders,
                  409,
                  'Live original writer must refuse replacement',
                );
                assert.deepEqual(await fixture('/fixture:image'), beforeLive);
                coldRefusalChecks++;
                const waitForExpiry = async () => {
                  const deadline = Date.now() + 30000;
                  for (;;) {
                    const lease = await fixture('/fixture:leases');
                    if (
                      lease.databaseNow >=
                      Math.max(
                        lease.writerLeaseUntil,
                        lease.activationExpiresAt,
                      )
                    )
                      break;
                    assert.ok(
                      Date.now() < deadline,
                      'Original leases must expire naturally',
                    );
                    await new Promise((resolve) => setTimeout(resolve, 100));
                  }
                };
                await waitForExpiry();
                const refused = await fixture('/fixture:cold-refusals', {
                  writerToken,
                });
                assert.equal(refused.refusals, 4);
                coldRefusalChecks += refused.refusals;
                const abandonedWriter = randomUUID();
                const abandoned = await post(
                  input.adapter,
                  `${prefix}/writers:acquire`,
                  {
                    workspaceId: key.workspaceId,
                    writerId: abandonedWriter,
                    leaseMillis: 1000,
                  },
                  storeHeaders,
                );
                assert.equal(abandoned.writerGeneration, 2);
                assert.equal(abandoned.activationEpoch, 1);
                const beforeUninstalled = await fixture('/fixture:image');
                await post(
                  input.adapter,
                  '/fixture:publication',
                  {
                    writerId: abandonedWriter,
                    writerGeneration: 2,
                    writerToken,
                  },
                  storeHeaders,
                  409,
                  'Uninstalled writer cannot publish',
                );
                assert.deepEqual(
                  await fixture('/fixture:image'),
                  beforeUninstalled,
                );
                coldRefusalChecks++;
                await waitForExpiry();
                let successorWriter = randomUUID();
                if (input.isolation) {
                  const writers = [successorWriter, randomUUID()];
                  await fixture('/fixture:cold-arm', { writers });
                  const pending = writers.map(async (candidate) => {
                    const response = await fetch(
                      `${input.adapter}${prefix}/writers:acquire`,
                      {
                        method: 'POST',
                        headers: storeHeaders,
                        signal: AbortSignal.timeout(20000),
                        body: JSON.stringify({
                          workspaceId: key.workspaceId,
                          writerId: candidate,
                          leaseMillis: 300000,
                        }),
                      },
                    );
                    return {
                      writerId: candidate,
                      status: response.status,
                      body: await response.json(),
                    };
                  });
                  const contention = await fixture('/fixture:cold-release');
                  const responses = await Promise.all(pending);
                  assert.deepEqual(
                    responses.map((response) => response.status).sort(),
                    [200, 409],
                  );
                  const winner = responses.find(
                    (response) => response.status === 200,
                  );
                  successorWriter = winner.writerId;
                  assert.equal(winner.body.writerGeneration, 3);
                  assert.equal(winner.body.activationEpoch, 1);
                  const warmed = Object.values(contention.warmed);
                  assert.equal(warmed.length, 2);
                  assert.ok(
                    warmed.every(
                      (entry) =>
                        entry.isolation === input.isolation &&
                        entry.autoCommit === false &&
                        entry.writerGeneration === 2,
                    ),
                  );
                  await fs.writeFile(
                    path.join(output, 'cold-contention.json'),
                    JSON.stringify({ contention, responses }, null, 2),
                  );
                }
                stores = createHttpManagedSessionStores({
                  baseUrl: input.adapter,
                  sessionKey: key,
                  writerId: successorWriter,
                  writerToken,
                  leaseDurationMs: 300000,
                  requestTimeoutMs: 20000,
                });
                session = await openManagedSession({
                  runtimeBaseDir: output,
                  transcriptPath: '',
                  sessionId: key.sessionId,
                  sessionKey: key,
                  cwd: '/workspace',
                  version: 'hosted-harness/1',
                  workerId: successorWriter,
                  activationLeaseDurationMs: 300000,
                  journalStore: stores.journalStore,
                  resourceStore: stores.resourceStore,
                });
                assert.equal(
                  (await stores.publication.owner()).writerGeneration,
                  3,
                );
                assert.equal(session.activation.epoch, 2);
                expectedActivation = { ...session.activation };
                const beforeStale = await fixture('/fixture:image');
                const replay = await fetch(originalReceiptRequest.url, {
                  ...originalReceiptRequest.options,
                  signal: AbortSignal.timeout(20000),
                });
                assert.equal(replay.status, 409);
                await replay.arrayBuffer();
                await post(
                  input.adapter,
                  `${prefix}/writers:renew`,
                  {
                    workspaceId: key.workspaceId,
                    writerId,
                    writerGeneration: 1,
                    leaseMillis: 10000,
                  },
                  storeHeaders,
                  409,
                  'Original writer cannot renew after takeover',
                );
                await post(
                  input.adapter,
                  '/fixture:publication',
                  {
                    writerId,
                    writerGeneration: 1,
                    writerToken,
                  },
                  storeHeaders,
                  409,
                  'Original writer cannot publish after takeover',
                );
                assert.deepEqual(await fixture('/fixture:image'), beforeStale);
                coldRefusalChecks += 3;
                const { recoverHostedCsiReceipts } = await import(
                  cli('hosted-csi-cold-recovery')
                );
                const recovered = await recoverHostedCsiReceipts(
                  session,
                  { baseUrl: input.broker, token: input.operatorToken },
                  promptId,
                  prompt,
                  {
                    ...input.runtime,
                    ...(await stores.publication.owner()),
                    activationId: session.activation.activationId,
                    activationEpoch: session.activation.epoch,
                  },
                );
                assert.deepEqual(
                  (await fixture('/fixture:inspect')).executions,
                  originalExecutions,
                );
                assert.deepEqual(
                  await fs.readFile(path.join(workspace, 'marker.txt')),
                  working,
                );
                return { session, ...recovered };
              },
            }
          : {}),
      });
      invocations.push(...actual);
      observation = await control('snapshot');
      assert.deepEqual(session.activation, expectedActivation);
      if (index === 0) firstPins = structuredClone(observation.retainedBackups);
      else
        for (const pin of firstPins)
          assert.deepEqual(
            observation.retainedBackups.find(
              (current) => current.name === pin.name,
            ),
            pin,
          );
      const issued = await fixture('/fixture:inspect');
      const grant = issued.executions
        .filter((row) => row.native_authorization_json)
        .map((row) => JSON.parse(row.native_authorization_json))
        .at(-1);
      assert.ok(grant, 'Hosted execution must mint a native SQL grant');
      const request = {
        protocolVersion: 1,
        requestId: randomUUID(),
        action: 'execute',
        subject: grant.executionCallId,
        identity: grant.identity,
        context: grant.context,
        installedContext: grant.installedContext,
      };
      const workerHeaders = {
        ...headers,
        authorization: `Bearer ${boot.context.token}`,
        'x-qwen-managed-lease-id': boot.context.leaseId,
        'x-qwen-managed-lease-epoch': String(boot.context.epoch),
      };
      const workingBefore = await fs.readFile(
        path.join(workspace, 'marker.txt'),
      );
      for (const [name, override, code] of [
        ['Hosted wrong token', { authorization: 'Bearer foreign' }, 401],
        ['Hosted wrong lease', { 'x-qwen-managed-lease-epoch': '99' }, 409],
      ]) {
        await post(
          worker.ready.context.url,
          '/internal/managed-runtime/csi/v2/execute',
          request,
          { ...workerHeaders, ...override },
          code,
          name,
        );
        assert.deepEqual(
          await fs.readFile(path.join(workspace, 'marker.txt')),
          workingBefore,
          name,
        );
        assert.deepEqual(await fixture('/fixture:inspect'), issued, name);
        checks.push(name);
      }
      completedTurns++;
      continue;
    }
    const harness = createManagedHarnessHandle(session);
    const producer = new ManagedHookActivationController(session).runTurn(
      promptId,
      async (scope) =>
        harness.run(async () => {
          const user = record('user', {
            daemonPromptId: promptId,
            message: { role: 'user', parts: [{ text: prompt }] },
          });
          await session.sink.write(user);
          parent = user.uuid;
          await scope.bindBudget(new TurnBudget(), prompt);
          const complete = await scope.beginMainAttempt('owned-model');
          await complete(true, usage);
          const functions = input.legacyAcceptedOnly
            ? [
                {
                  id: 'legacy-read-0',
                  name: 'read_file',
                  args: { file_path: 'marker.txt' },
                },
                {
                  id: 'legacy-invalid-1',
                  name: 'read_file',
                  args: { file_path: '../outside' },
                },
                {
                  id: 'legacy-read-2',
                  name: 'read_file',
                  args: { file_path: 'marker.txt' },
                },
              ]
            : [
                {
                  id: `owned-read-${index}`,
                  name: 'read_file',
                  args: { file_path: 'marker.txt' },
                },
                { id: `owned-mutate-${index}`, ...mutation },
              ];
          const assistant = record('assistant', {
            daemonPromptId: promptId,
            model: 'owned-model',
            message: {
              role: 'model',
              parts: [
                { text: 'owned tool batch' },
                ...functions.map((functionCall) => ({ functionCall })),
              ],
            },
          });
          await session.sink.write(assistant);
          parent = assistant.uuid;
          const batchId = assistant.uuid;
          const members = [];
          for (const [ordinal, fc] of functions.entries()) {
            if (
              input.legacyAcceptedOnly &&
              (ordinal === 1 || (input.legacyMissingValid && ordinal === 2))
            )
              continue;
            const payloadJson = JSON.stringify({
              toolName: fc.name,
              input: fc.args,
            });
            const inputBytes = Buffer.from(
              JSON.stringify({
                harnessSessionId: key.sessionId,
                runtimeSessionId: key.sessionId,
                payloadJson,
              }),
            );
            const definitionBytes = Buffer.from(
              JSON.stringify(
                declarations.find((value) => value.name === fc.name),
              ),
            );
            const inputRef = await session.resources.publish(
              'managed-tool-input',
              inputBytes,
            );
            const toolDefinitionRef = await session.resources.publish(
              'managed-tool-definition',
              definitionBytes,
            );
            const reference = {
              sessionId: key.sessionId,
              promptId,
              callId: randomUUID(),
              argsDigest: `sha256:${hash(payloadJson)}`,
              batchId,
              functionCallId: fc.id,
              ordinal,
              partIndex: ordinal + 1,
              inputRef,
              toolDefinitionRef,
            };
            const request = {
              idempotencyKey: `${key.sessionId}:${reference.callId}`,
              turnId: promptId,
              toolCallId: reference.callId,
              requestDigest: reference.argsDigest,
              reference,
              inputBytesBase64: inputBytes.toString('base64'),
              toolDefinitionBytesBase64: definitionBytes.toString('base64'),
            };
            const prepared = await broker('/executions:prepare', request);
            const repeated = await broker('/executions:prepare', request);
            assert.equal(repeated.executionCallId, prepared.executionCallId);
            members.push({
              executionCallId: prepared.executionCallId,
              reference,
              fc,
              payloadJson,
            });
          }
          const preparation = {
            stage: 'intent',
            turnId: promptId,
            promptId,
            batchId,
            invocations: members.map(({ executionCallId, reference, fc }) => ({
              executionCallId,
              callId: reference.callId,
              functionCallId: fc.id,
              toolName: fc.name,
              partIndex: reference.partIndex,
              ordinal: reference.ordinal,
              requestDigest: reference.argsDigest,
              inputRef: reference.inputRef,
              toolDefinitionRef: reference.toolDefinitionRef,
            })),
            paths: ['marker.txt'],
          };
          if (!input.legacyAcceptedOnly) {
            const intent = await history(
              `csi-file-history:intent:${batchId}`,
              preparation,
              observation,
            );
            observation = await control('prepare', {
              preparationRef: intent.recordRef,
            });
            await history(
              `csi-file-history:prepared:${batchId}`,
              {
                ...preparation,
                stage: 'prepared',
                intentRef: intent.recordRef,
              },
              observation,
            );
          }
          for (const member of members) {
            const { executionCallId, reference } = member;
            await session.authority.appendExecutionEvent(
              {
                operation: 'toolIntent',
                commandId: `tool-intent:${executionCallId}`,
                sessionKey: key,
                contentDigest: reference.inputRef.digest,
              },
              (sequence) => ({
                v: 1,
                sequence,
                eventId: `tool-intent:${executionCallId}`,
                sessionKey: key,
                kind: 'tool.intent',
                occurredAt: Date.now(),
                subject: {
                  type: 'activation',
                  scopeId: session.activation.activationId,
                  ...session.activation,
                },
                payload: {
                  executionCallId,
                  batchId,
                  ordinal: reference.ordinal,
                  toolDefinitionRef: reference.toolDefinitionRef,
                  argsRef: reference.inputRef,
                  outcomeSource: 'runtime',
                },
              }),
              actor,
            );
          }
          await harness.commitAwaitRuntimeBatch(
            members.map(({ executionCallId, reference, fc }) => ({
              executionCallId,
              functionCallId: fc.id,
              toolName: fc.name,
              invocationBindingId: executionCallId,
              capabilityVersion: boot.identity.capabilityDigest,
              policyVersion: 'csi-files-retirement-policy/1',
              mediaVersion: null,
              modelMessageId: batchId,
              partIndex: reference.partIndex,
              ordinal: reference.ordinal,
              inputDigest: reference.argsDigest.slice(7),
              progressCursor: null,
              attemptId: batchId,
              routeRef: members[0].reference.inputRef,
            })),
            { turnId: promptId, promptId },
          );
          for (const member of members) {
            const { executionCallId, payloadJson, fc } = member;
            // Use the production native request returned by SQL grant for all post-dispatch comparisons.
            const before = await fixture('/fixture:inspect');
            assert.ok(
              before.executions.every(
                (row) =>
                  row.native_authorization_json === null ||
                  typeof row.native_authorization_json === 'string',
              ),
            );
            const started = await broker(
              `/executions/${executionCallId}:start`,
              { payloadJson },
            );
            let status = started.status;
            const deadline = Date.now() + 20000;
            while (status.state !== 'settled' && Date.now() < deadline) {
              await new Promise((resolve) => setTimeout(resolve, 30));
              const url = new URL(
                `/internal/runtime-broker/v1/executions/${executionCallId}`,
                input.broker,
              );
              for (const [name, value] of Object.entries({
                requestId: randomUUID(),
                harnessSessionId: key.sessionId,
                runtimeSessionId: key.sessionId,
              }))
                url.searchParams.set(name, value);
              const response = await fetch(url, {
                headers,
                signal: AbortSignal.timeout(20000),
              });
              assert.equal(response.status, 200);
              status = (await response.json()).status;
            }
            assert.equal(status.state, 'settled', JSON.stringify(status));
            firstSettled ??= { executionCallId, result: status.result };
            assert.equal(
              status.result.executionStatus,
              'success',
              JSON.stringify(status.result),
            );
            const issued = await fixture('/fixture:inspect');
            const grants = issued.executions.filter(
              (row) => row.native_authorization_json !== null,
            );
            assert.equal(grants.length, invocations.length + 1);
            const grant = grants
              .map((row) => JSON.parse(row.native_authorization_json))
              .find((value) => value.executionCallId === executionCallId);
            assert.ok(grant, 'SQL dispatch must mint the grant');
            const workerHeaders = {
              ...headers,
              authorization: `Bearer ${boot.context.token}`,
              'x-qwen-managed-lease-id': boot.context.leaseId,
              'x-qwen-managed-lease-epoch': String(boot.context.epoch),
            };
            const request = {
              protocolVersion: 1,
              requestId: randomUUID(),
              action: 'execute',
              subject: executionCallId,
              identity: grant.identity,
              context: grant.context,
              installedContext: grant.installedContext,
            };
            const workingBefore = await fs.readFile(
              path.join(workspace, 'marker.txt'),
            );
            const repeated = await broker(
              `/executions/${executionCallId}:start`,
              { payloadJson },
            );
            assert.deepEqual(repeated.status.result, status.result);
            assert.deepEqual(await fixture('/fixture:inspect'), issued);
            assert.deepEqual(
              await fs.readFile(path.join(workspace, 'marker.txt')),
              workingBefore,
            );
            if (!input.retirement && !coldFixture) {
              const bindRequest = { ...request, action: 'bind', subject: null };
              const nativeRoute = '/internal/runtime-broker/csi/v1/native:read';
              await post(input.broker, nativeRoute, bindRequest, workerHeaders);
              const foreignBinding = {
                ...bindRequest.installedContext.binding,
                workspaceId: 'foreign-workspace',
              };
              for (const [name, changed, override, code] of [
                [
                  'SQL wrong token',
                  bindRequest,
                  { authorization: 'Bearer foreign' },
                  401,
                ],
                [
                  'SQL wrong owner',
                  {
                    ...bindRequest,
                    identity: {
                      ...bindRequest.identity,
                      sessionId: input.foreignOwnerSessionId,
                    },
                    installedContext: {
                      ...bindRequest.installedContext,
                      sessionId: input.foreignOwnerSessionId,
                      operationId: input.foreignOwnerOperationId,
                    },
                  },
                  {},
                  409,
                ],
                [
                  'SQL wrong context',
                  {
                    ...bindRequest,
                    context: {
                      ...bindRequest.context,
                      workspaceId: foreignBinding.workspaceId,
                    },
                    installedContext: {
                      ...bindRequest.installedContext,
                      binding: foreignBinding,
                      contextDigest:
                        computeManagedContextDigest(foreignBinding),
                    },
                  },
                  {},
                  409,
                ],
              ]) {
                await post(
                  input.broker,
                  nativeRoute,
                  changed,
                  { ...workerHeaders, ...override },
                  code,
                  name,
                );
                assert.deepEqual(
                  await fs.readFile(path.join(workspace, 'marker.txt')),
                  workingBefore,
                  name,
                );
                checks.push(name);
              }
              for (const [name, changed, override, code] of [
                [
                  'wrong token',
                  request,
                  { authorization: 'Bearer foreign' },
                  401,
                ],
                [
                  'wrong lease',
                  request,
                  { 'x-qwen-managed-lease-epoch': '99' },
                  409,
                ],
                [
                  'wrong owner',
                  {
                    ...request,
                    identity: { ...request.identity, sessionId: randomUUID() },
                  },
                  {},
                  409,
                ],
                [
                  'wrong context',
                  {
                    ...request,
                    installedContext: {
                      ...request.installedContext,
                      binding: {
                        ...request.installedContext.binding,
                        contextRevision: 99,
                      },
                    },
                  },
                  {},
                  409,
                ],
                [
                  'ungranted execution',
                  { ...request, subject: randomUUID() },
                  {},
                  409,
                ],
              ]) {
                await post(
                  worker.ready.context.url,
                  '/internal/managed-runtime/csi/v2/execute',
                  changed,
                  { ...workerHeaders, ...override },
                  code,
                  name,
                );
                assert.deepEqual(
                  await fs.readFile(path.join(workspace, 'marker.txt')),
                  workingBefore,
                  name,
                );
                checks.push(name);
              }
            }
            const parts = convertToFunctionResponse(
              fc.name,
              fc.id,
              managedToolResponseParts(status.result.responseParts),
            );
            for (const part of parts)
              if (part.functionResponse)
                part.functionResponse.response.executionStatus =
                  status.result.executionStatus;
            const tool = record('tool_result', {
              daemonPromptId: promptId,
              model: 'owned-model',
              message: { role: 'user', parts },
            });
            const outcomeRef = await session.resources.publish(
              'managed-tool-outcome',
              Buffer.from(
                JSON.stringify({
                  schemaVersion: 1,
                  executionCallId,
                  envelope: status.result,
                  history: {
                    messageId: tool.uuid,
                    timestamp: tool.timestamp,
                    model: 'owned-model',
                    parts,
                  },
                }),
              ),
            );
            await session.authority.appendExecutionEvent(
              {
                operation: 'recordToolResult',
                commandId: executionCallId,
                sessionKey: key,
                contentDigest: outcomeRef.digest,
              },
              (sequence) => ({
                v: 1,
                sequence,
                eventId: `tool-receipt:${executionCallId}`,
                sessionKey: key,
                kind: 'tool.receipt',
                occurredAt: Date.now(),
                payload: {
                  executionCallId,
                  toolOutcomeRef: outcomeRef,
                  resultRef: null,
                  resources: [],
                  historyRevision: sequence,
                },
              }),
              { class: 'trusted_entry' },
            );
            if (coldFixture && member === members.at(-1)) {
              invocations.push({
                tool: fc.name,
                executionCallId,
                grantDigest: hash(JSON.stringify(grant)),
                responseParts: status.result.responseParts,
              });
              reachCut(
                input.legacyAcceptedOnly
                  ? { promptId, prompt, batchId, functions, members }
                  : firstSettled,
              );
              await new Promise(() => {});
            }
            await session.sink.write(tool);
            parent = tool.uuid;
            await harness.resolveAwaitRuntime(executionCallId, outcomeRef);
            invocations.push({
              tool: fc.name,
              executionCallId,
              grantDigest: hash(JSON.stringify(grant)),
              responseParts: status.result.responseParts,
            });
          }
          observation = await control('snapshot');
          await history(
            `csi-file-history:result:${batchId}`,
            null,
            observation,
          );
          const continued = await scope.beginMainAttempt('owned-model');
          await continued(true, usage);
          await harness.consumeRuntimeResults();
          const final = record('assistant', {
            daemonPromptId: promptId,
            model: 'owned-model',
            message: {
              role: 'model',
              parts: [{ text: 'owned continuation complete' }],
            },
          });
          await session.sink.write(final);
          parent = final.uuid;
          await harness.settleConsumedRuntimeContinuation();
          await session.sink.write(
            record('system', {
              parentUuid: null,
              subtype: 'turn_result',
              systemPayload: {
                promptId,
                state: 'completed',
                stopReason: 'end_turn',
                endedAt: Date.now(),
              },
            }),
          );
        }),
    );
    if (coldFixture) {
      producerState = 'pending';
      void producer.then(
        () => {
          producerState = 'completed';
        },
        (error) => {
          producerState = String(error);
        },
      );
      const cut = await Promise.race([
        cutReached,
        producer.then(() => assert.fail('Producer completed before cold cut')),
      ]);
      coldResult = input.legacyAcceptedOnly
        ? await legacyTakeover(cut, writerId, writerToken)
        : await coldTakeover(cut, writerId, writerToken);
      assert.equal(producerState, 'pending');
      break;
    }
    await producer;
    assert.deepEqual(session.activation, expectedActivation);
    if (index === 0) firstPins = structuredClone(observation.retainedBackups);
    else
      for (const pin of firstPins)
        assert.deepEqual(
          observation.retainedBackups.find(
            (current) => current.name === pin.name,
          ),
          pin,
        );
    completedTurns++;
  }
  if (input.legacyAcceptedOnly) {
    assert.equal(
      await fs.readFile(path.join(workspace, 'marker.txt'), 'utf8'),
      'alpha\n',
    );
    const workerUrl = worker.ready.context.url;
    await worker.close();
    await assert.rejects(
      fetch(workerUrl, { signal: AbortSignal.timeout(2000) }),
      TypeError,
    );
    await fs.writeFile(
      path.join(output, 'result.json'),
      JSON.stringify(
        {
          ...coldResult,
          finalBytes: 'alpha\n',
          workerClosed: true,
          nativeSqlGrant: true,
          nativeGrantInsertedByFixture: false,
          workerRepliesStubbed: false,
          nativeCsiDeployment: false,
          fixture: 'H2/HTTP with actual worker and explicit mount facade',
        },
        null,
        2,
      ),
    );
  } else {
    const retained = [];
    for (const pin of observation.retainedBackups) {
      const bytes = await fs.readFile(
        path.join(workspace, '.qwen-csi-file-history', key.sessionId, pin.name),
      );
      assert.equal(hash(bytes), pin.digest);
      assert.equal(pin.mode, 0o640);
      retained.push(bytes.toString());
    }
    assert.deepEqual(
      retained.sort(),
      input.cold ? ['alpha\n'] : ['alpha\n', 'beta\n'],
    );
    const finalBytes = await fs.readFile(
      path.join(workspace, 'marker.txt'),
      'utf8',
    );
    assert.equal(finalBytes, input.cold ? 'beta\n' : 'gamma\n');
    assert.equal(observation.state.snapshots.length, input.cold ? 1 : 2);
    const writerGeneration =
      coldResult?.writerGeneration ??
      (await stores.publication.owner()).writerGeneration;
    let retirementResult = {};
    if (input.retirement) {
      retirementJoined = true;
      await stores.csiRetirement.joinWriter();
      const terminalRecords =
        await session.authority.prepareOriginalCsiRelease();
      await stores.csiRetirement.prepare(terminalRecords);
      const retirement = await fixture('/fixture:retire');
      const drained = await stores.csiRetirement.complete(
        retirement.retirementId,
      );
      assert.equal(drained.stage, 'DRAINED');
      assert.equal(drained.progressVersion, 4);
      const retainedBeforeClose = await fixture('/fixture:retained', {
        token: writerToken,
        label: 'worker-open',
      });
      retirementResult = { retirement: drained, retainedBeforeClose };
      await stores.stopLocal();
    }
    const workerUrl = worker.ready.context.url;
    await worker.close();
    worker = undefined;
    if (input.retirement) {
      retirementResult.retainedAfterClose = await fixture('/fixture:retained', {
        token: writerToken,
        label: 'worker-closed',
      });
      retirementResult.retainedMatrix = await fixture(
        '/fixture:retained-matrix',
        {
          token: writerToken,
        },
      );
      assert.equal(retirementResult.retainedMatrix.length, 12);
    }
    await assert.rejects(
      fetch(workerUrl, { signal: AbortSignal.timeout(2000) }),
      TypeError,
    );
    await fs.writeFile(
      path.join(output, 'result.json'),
      JSON.stringify(
        {
          ...retirementResult,
          ...coldResult,
          completedTurns,
          hostedProducer: input.hostedProducer === true,
          nativeSqlGrant: true,
          workerClosed: true,
          finalBytes,
          retained,
          invocations,
          refusalChecks: checks.length,
          writerGeneration,
          coldRecovery: input.coldRecovery === true,
          coldRefusalChecks,
          recoveryCut: input.recoveryCut,
          originalActivation: initialActivation,
          platformFixture: `${actualPlatform.value} real inodes; explicit mount/proc-fd and placement mapping`,
          nativeCsiDeployment: false,
          nativeGrantInsertedByFixture: false,
          workerRepliesStubbed: false,
        },
        null,
        2,
      ),
    );
  }
} catch (error) {
  console.error(error);
  throw error;
} finally {
  const cleanupErrors = [];
  for (const close of [
    () => stopActivation(),
    () => recoveredLegacySession?.close({ releaseActivation: false }),
    ...coldStores.map((candidate) => () => candidate.stopLocal()),
    () =>
      coldFixture || retirementJoined
        ? stores?.stopLocal()
        : session?.close({ releaseActivation: false }),
    () =>
      coldFixture || retirementJoined ? stores?.stopLocal() : stores?.close(),
  ]) {
    try {
      await close();
    } catch (error) {
      if (
        !['csi_finalize_required', 'csi_managed_mutation_unavailable'].includes(
          error.remoteCode,
        )
      )
        cleanupErrors.push(error);
    }
  }
  try {
    await worker?.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  Server.prototype.listen = nativeListen;
  Object.defineProperties(ManagedCsiMount.prototype, originalMount);
  Object.defineProperty(process, 'platform', actualPlatform);
  Object.assign(fs, native);
  for (const handle of opened) await handle.close();
  await rootHandle.close();
  if (coldFixture)
    await fs.writeFile(
      path.join(output, 'cold-wires.json'),
      JSON.stringify(wires, null, 2),
    );
  await fs.rm(workspace, { recursive: true, force: true });
  assert.deepEqual(cleanupErrors, [], 'Unexpected private cleanup refusal');
}
