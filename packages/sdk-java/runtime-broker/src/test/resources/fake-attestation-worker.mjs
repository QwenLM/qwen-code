import { Buffer } from 'node:buffer';
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import process from 'node:process';
import { setTimeout } from 'node:timers';

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
  // Refuse without echoing the document, which carries the token.
  process.exit(1);
}

// The closed key sets of boot v1 and of boot v2 (managed-context/1), sorted.
// Like the real worker, anything else is refused before the ready line. Only
// the key sets, `type`, the version and the protocol token are checked, not
// the other values.
const V1_KEYS = [
  'capabilityDigest',
  'epoch',
  'isolationClass',
  'leaseId',
  'provisionRequestId',
  'runtimeIncarnation',
  'runtimeInstanceId',
  'tenantId',
  'token',
  'type',
  'version',
  'workspaceCwd',
  'workspaceGeneration',
  'workspaceId',
];
const BOOT_KEYS = {
  1: V1_KEYS,
  2: [
    ...V1_KEYS.filter((key) => key !== 'workspaceCwd'),
    'managedContext',
    'mountRoot',
    'storageId',
  ].sort(),
};
const MANAGED_CONTEXT = 'managed-context/1';
const bootVersion =
  boot !== null &&
  typeof boot === 'object' &&
  !Array.isArray(boot) &&
  boot.type === 'boot' &&
  (boot.version === 1 ||
    (boot.version === 2 && boot.managedContext === MANAGED_CONTEXT)) &&
  JSON.stringify(Object.keys(boot).sort()) ===
    JSON.stringify(BOOT_KEYS[boot.version])
    ? boot.version
    : 0;
if (bootVersion === 0) {
  process.exit(1);
}

const args = process.argv.slice(2);
const chatty = args.includes('--chatty');
const foreignUrl = args.includes('--foreign-url');
const portArg = args.find((arg) => arg.startsWith('--port='));
const port = portArg ? Number(portArg.slice('--port='.length)) : 0;
const probeArg = args.find((arg) => arg.startsWith('--probe='));
const probePath = probeArg ? probeArg.slice('--probe='.length) : '';
if (args.includes('--big-ready')) {
  // Never finish the line: only the broker's 32 KiB bound can end the read
  // before its 30 s ready timeout. The broker kills this process on
  // rejection; the exit below only bounds an orphan.
  process.stdout.write('a'.repeat(40 * 1024));
  setTimeout(() => process.exit(1), 60_000);
  await new Promise(() => {});
}
if (chatty) {
  // Mirror the real worker: a stdout write failure is fatal.
  process.stdout.once('error', () => process.exit(1));
}

const server = createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    if (probePath) {
      appendFileSync(probePath, 'hit\n');
    }
    const path = request.url.split('?')[0];
    if (
      bootVersion === 2 &&
      request.method === 'POST' &&
      path === '/internal/managed-runtime/v3/attest'
    ) {
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
    if (
      bootVersion === 2 &&
      request.method === 'POST' &&
      path === '/internal/managed-runtime/v3/context'
    ) {
      let installed;
      try {
        installed = receipt(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        respond(response, 400, {
          code: 'managed_runtime_attestation_invalid',
          error: 'Managed Runtime attestation request is invalid.',
        });
        return;
      }
      respond(response, 200, installed);
      return;
    }
    if (
      bootVersion === 1 &&
      request.method === 'POST' &&
      path === '/internal/managed-runtime/v2/attest'
    ) {
      const body = JSON.stringify({
        protocolVersion: 2,
        runtimeInstanceId: boot.runtimeInstanceId,
        runtimeIncarnation: boot.runtimeIncarnation,
        leaseId: boot.leaseId,
        epoch: boot.epoch,
        provisionRequestId: boot.provisionRequestId,
        tenantId: boot.tenantId,
        workspaceId: boot.workspaceId,
        workspaceGeneration: boot.workspaceGeneration,
        workspaceCwd: boot.workspaceCwd,
        capabilityDigest: boot.capabilityDigest,
        isolationClass: boot.isolationClass,
      });
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'application/json',
      });
      response.end(body);
      if (chatty) {
        process.stdout.write('post-ready chatter\n');
      }
      return;
    }
    response.writeHead(404, {
      'cache-control': 'no-store',
      'content-type': 'application/json',
    });
    response.end('{}');
  });
});

server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  const host = foreignUrl ? '172.16.1.234' : '127.0.0.1';
  process.stdout.write(
    `${JSON.stringify({
      type: 'ready',
      version: bootVersion,
      ...(bootVersion === 2 ? { managedContext: MANAGED_CONTEXT } : {}),
      runtimeInstanceId: boot.runtimeInstanceId,
      runtimeIncarnation: boot.runtimeIncarnation,
      leaseId: boot.leaseId,
      epoch: boot.epoch,
      url: `http://${host}:${address.port}`,
    })}\n`,
  );
});

function respond(response, status, body) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json',
  });
  response.end(JSON.stringify(body));
}

/** Echoes an installation as its receipt; the real worker checks it. */
function receipt(installation) {
  return {
    protocolVersion: 3,
    managedContext: MANAGED_CONTEXT,
    operationId: installation.operationId,
    sessionId: installation.sessionId,
    runtimeInstanceId: boot.runtimeInstanceId,
    runtimeIncarnation: boot.runtimeIncarnation,
    epoch: boot.epoch,
    contextDigest: installation.contextDigest,
    contextRevision: installation.binding.contextRevision,
    workspaceGeneration: installation.binding.workspaceGeneration,
  };
}

const stop = () => server.close(() => process.exit(0));
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
