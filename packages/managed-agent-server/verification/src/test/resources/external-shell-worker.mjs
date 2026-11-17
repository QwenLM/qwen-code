// A stand-in for the external foreground-Shell worker's own publication
// protocol (#15512 slice C). It holds a private capture per channel and exposes
// it read-only: it is never given a control-plane credential, so the Broker is
// the producer and this process only answers begin/read/renew/stop-drained.
//
// The wire shapes mirror the shipped worker in
// packages/cli/src/serve/managed-external-publication.ts. The three rules the
// Broker's copy chain depends on are enforced here rather than assumed:
//   - the EOF is its own empty sequence, so every earlier sequence has bytes;
//   - acknowledgedSequence may equal the sequence being read but never exceed
//     it, which is the only way the last one — the EOF included — is acked;
//   - the channel horizon only moves forward, and an expired channel is closed.
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import process from 'node:process';

const PREFIX = '/internal/managed-runtime/v2/publication:';
const MANAGED_CONTEXT = 'managed-context/1';
const READ_BYTES = 32 * 1024;
const CLOSED = 'managed_runtime_publication_closed';

const input = await new Promise((resolve, reject) => {
  const chunks = [];
  process.stdin.on('data', (chunk) => chunks.push(chunk));
  process.stdin.on('end', () =>
    resolve(Buffer.concat(chunks).toString('utf8')),
  );
  process.stdin.on('error', reject);
});
let boot;
try {
  boot = JSON.parse(input);
} catch {
  process.exit(1);
}
if (
  boot?.type !== 'boot' ||
  boot.version !== 2 ||
  boot.managedContext !== MANAGED_CONTEXT
) {
  process.exit(1);
}

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const found = args.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : undefined;
};
// Each stream's payload, so a case can drive a multi-block copy and an empty
// stderr without the stand-in inventing output of its own.
const stdout = Buffer.from(value('stdout') ?? 'witness\n', 'utf8');
const stderr = Buffer.from(value('stderr') ?? '', 'utf8');
const exitCode = Number(value('exit-code') ?? '0');
// A wedged channel: read answers pending for ever, so only the Broker's own
// bounded wait can end the drain.
const neverReady = flag('never-ready');

const channels = new Map();
const requests = [];
let stopped = false;

function blocks(payload) {
  const parts = [];
  for (let offset = 0; offset < payload.length; offset += READ_BYTES) {
    parts.push(payload.subarray(offset, offset + READ_BYTES));
  }
  // The EOF always exists, even for an empty stream: it is the sequence that
  // bounds the stream, and it carries no bytes.
  parts.push(Buffer.alloc(0));
  return parts;
}

function closed(response, message = 'Managed Runtime publication is closed.') {
  respond(response, 409, { code: CLOSED, error: message });
}

function respond(response, status, body) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json',
  });
  response.end(JSON.stringify(body));
}

// The drained proof and per-channel receipts are manifest references in the
// shipped worker's resource store; the stand-in mints the same closed shape
// over its own payload so the transport's drain validation is exercised.
function referenceOf(payload) {
  return {
    resourceId: randomUUID(),
    kind: 'external-publication',
    schemaVersion: 1,
    byteLength: Buffer.byteLength(payload),
    digest: createHash('sha256').update(payload).digest('hex'),
  };
}

function authenticated(request) {
  return (
    request.headers.authorization === `Bearer ${boot.token}` &&
    request.headers['x-qwen-managed-lease-id'] === boot.leaseId &&
    request.headers['x-qwen-managed-lease-epoch'] === String(boot.epoch) &&
    request.headers['x-qwen-managed-runtime-incarnation'] ===
      boot.runtimeIncarnation &&
    request.headers['cache-control'] === 'no-store'
  );
}

const server = createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const path = request.url.split('?')[0];
    if (request.method !== 'POST') {
      respond(response, 404, {});
      return;
    }
    if (path === '/internal/managed-runtime/v3/attest') {
      respond(response, 200, {
        protocolVersion: 3,
        managedContext: MANAGED_CONTEXT,
        runtimeInstanceId: boot.runtimeInstanceId,
        runtimeIncarnation: boot.runtimeIncarnation,
        leaseId: boot.leaseId,
        epoch: boot.epoch,
        provisionRequestId: boot.provisionRequestId,
        tenantId: boot.tenantId,
        workspaceId: boot.workspaceId,
        workspaceGeneration: boot.workspaceGeneration,
        storageId: boot.storageId,
        mountRoot: boot.mountRoot,
        capabilityDigest: boot.capabilityDigest,
        isolationClass: boot.isolationClass,
      });
      return;
    }
    if (!path.startsWith(PREFIX)) {
      respond(response, 404, {});
      return;
    }
    if (!authenticated(request)) {
      respond(response, 401, {
        code: 'managed_runtime_unauthorized',
        error: 'Managed Runtime authorization failed.',
      });
      return;
    }
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      respond(response, 400, {
        code: 'managed_runtime_publication_invalid',
        error: 'Managed Runtime publication request is invalid.',
      });
      return;
    }
    if (body.protocolVersion !== 2) {
      respond(response, 400, {
        code: 'managed_runtime_publication_invalid',
        error: 'Managed Runtime publication request is invalid.',
      });
      return;
    }
    requests.push({ route: path.slice(PREFIX.length), body });
    // The diagnostic route is not a publication operation: a case reads it
    // after the drained stop to see which exchanges actually arrived.
    if (path.slice(PREFIX.length) === 'requests') {
      respond(response, 200, { protocolVersion: 2, requests });
      return;
    }
    if (stopped) {
      closed(response);
      return;
    }
    try {
      switch (path.slice(PREFIX.length)) {
        case 'begin':
          begin(response, body);
          return;
        case 'read':
          read(response, body);
          return;
        case 'renew':
          renew(response, body);
          return;
        case 'stop-drained':
          stopDrained(response, body);
          return;
        default:
          respond(response, 404, {});
      }
    } catch (refused) {
      respond(response, refused.status ?? 409, {
        code: refused.code ?? CLOSED,
        error: refused.message,
      });
    }
  });
});

function refusal(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status });
}

/** Idempotent per execution: a recovered dispatch gets the same channel. */
function begin(response, body) {
  const { reference, capture, expiresAt, captureId } = body;
  if (
    !reference ||
    !capture ||
    capture.capturePolicy !== 'complete_required' ||
    typeof captureId !== 'string' ||
    !/^[a-z0-9_-]{1,128}$/.test(captureId) ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= 0
  ) {
    throw refusal(
      'managed_runtime_publication_invalid',
      'Publication begin is invalid.',
      400,
    );
  }
  const key = `${capture.executionCallId}:${capture.bindingGeneration}`;
  const existing = [...channels.values()].find(
    (channel) => channel.key === key,
  );
  if (existing) {
    // The captured input is fixed at begin; only the horizon may move.
    if (
      existing.captureId !== captureId ||
      existing.requestDigest !== digestOf(reference, capture, captureId)
    ) {
      throw refusal(
        CLOSED,
        'Publication channel was opened for another capture.',
      );
    }
    existing.horizon = Math.max(existing.horizon, expiresAt);
    respond(response, 200, {
      protocolVersion: 2,
      channelId: existing.channelId,
    });
    return;
  }
  const channelId = randomUUID();
  channels.set(channelId, {
    key,
    channelId,
    captureId,
    requestDigest: digestOf(reference, capture, captureId),
    horizon: expiresAt,
    streams: { stdout: blocks(stdout), stderr: blocks(stderr) },
    delivered: { stdout: -1, stderr: -1 },
    acknowledged: { stdout: -1, stderr: -1 },
    finalReceipt: referenceOf(
      JSON.stringify({ type: 'final', channelId, captureId }),
    ),
  });
  respond(response, 200, { protocolVersion: 2, channelId });
}

function digestOf(reference, capture, captureId) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        reference.sessionId,
        reference.promptId,
        reference.callId,
        reference.argsDigest,
        capture.tenantId,
        capture.sessionId,
        capture.turnId,
        capture.executionCallId,
        capture.bindingGeneration,
        capture.capturePolicy,
        captureId,
      ]),
    )
    .digest('hex');
}

function live(body) {
  const channel = channels.get(body.channelId);
  if (!channel) {
    throw refusal(CLOSED, 'Managed Runtime publication is closed.');
  }
  if (channel.horizon <= Date.now()) {
    throw refusal(CLOSED, 'Managed Runtime publication channel expired.');
  }
  return channel;
}

function read(response, body) {
  const channel = live(body);
  const { streamId, sequence, acknowledgedSequence } = body;
  if (
    !(streamId === 'stdout' || streamId === 'stderr') ||
    !Number.isSafeInteger(sequence) ||
    sequence < 0 ||
    !Number.isSafeInteger(acknowledgedSequence) ||
    acknowledgedSequence < -1 ||
    // Mirror the shipped worker: an ack may not exceed the bytes already
    // delivered on this stream, and the next read may not skip past the
    // acknowledged cursor. (managed-external-publication.ts:354-358)
    acknowledgedSequence > channel.delivered[streamId] ||
    sequence >
      Math.max(channel.acknowledged[streamId], acknowledgedSequence) + 1
  ) {
    throw refusal(CLOSED, 'Managed Runtime publication is closed.');
  }
  const parts = channel.streams[streamId];
  if (sequence >= parts.length) {
    throw refusal(CLOSED, 'Managed Runtime publication is closed.');
  }
  if (neverReady) {
    // The shipped worker answers pending above both cursor writes, so a
    // pending read mutates no cursor state.
    respond(response, 200, { protocolVersion: 2, state: 'pending' });
    return;
  }
  channel.acknowledged[streamId] = Math.max(
    channel.acknowledged[streamId],
    acknowledgedSequence,
  );
  if (sequence > channel.delivered[streamId]) {
    channel.delivered[streamId] = sequence;
  }
  const block = parts[sequence];
  respond(response, 200, {
    protocolVersion: 2,
    state: 'ready',
    bytes: block.toString('base64'),
    exitCode,
    signal: null,
    receipt: {
      channelId: channel.channelId,
      streamId,
      sequence,
      byteLength: block.length,
      digest: createHash('sha256').update(block).digest('hex'),
      eof: block.length === 0,
    },
  });
}

function renew(response, body) {
  const channel = live(body);
  if (!Number.isSafeInteger(body.expiresAt) || body.expiresAt <= Date.now()) {
    throw refusal(CLOSED, 'Managed Runtime publication is closed.');
  }
  // Only ever forward: a stale renewal must not shorten a live channel.
  channel.horizon = Math.max(channel.horizon, body.expiresAt);
  respond(response, 200, { protocolVersion: 2, renewed: true });
}

/**
 * The lane's only retirement proof. Every stream's EOF must have been
 * acknowledged, or the captured bytes are still owed and the stop is undrained.
 */
function stopDrained(response, body) {
  if (body.channel !== 'all') {
    throw refusal(
      'managed_runtime_publication_invalid',
      'Publication stop is invalid.',
      400,
    );
  }
  const undrained = [...channels.values()].filter(
    (channel) =>
      channel.acknowledged.stdout < channel.streams.stdout.length - 1 ||
      channel.acknowledged.stderr < channel.streams.stderr.length - 1,
  );
  if (undrained.length > 0) {
    respond(response, 200, {
      protocolVersion: 2,
      state: 'undrained',
      channels: undrained.map((channel) => channel.channelId),
    });
    return;
  }
  stopped = true;
  const payload = JSON.stringify(
    [...channels.values()]
      .map((channel) => [
        channel.channelId,
        channel.captureId,
        channel.requestDigest,
      ])
      .sort(),
  );
  respond(response, 200, {
    protocolVersion: 2,
    state: 'drained',
    proof: referenceOf(payload),
    receipts: [...channels.values()].map((channel) => ({
      channelId: channel.channelId,
      receipt: channel.finalReceipt,
    })),
  });
}

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(
    `${JSON.stringify({
      type: 'ready',
      version: 2,
      managedContext: MANAGED_CONTEXT,
      runtimeInstanceId: boot.runtimeInstanceId,
      runtimeIncarnation: boot.runtimeIncarnation,
      leaseId: boot.leaseId,
      epoch: boot.epoch,
      url: `http://127.0.0.1:${server.address().port}`,
    })}\n`,
  );
});

const stop = () => server.close(() => process.exit(0));
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
