import { Buffer } from 'node:buffer';
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import process from 'node:process';
import { setTimeout } from 'node:timers';

const boot = JSON.parse(
  await new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () =>
      resolve(Buffer.concat(chunks).toString('utf8')),
    );
    process.stdin.on('error', reject);
  }),
);

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
      version: 1,
      runtimeInstanceId: boot.runtimeInstanceId,
      runtimeIncarnation: boot.runtimeIncarnation,
      leaseId: boot.leaseId,
      epoch: boot.epoch,
      url: `http://${host}:${address.port}`,
    })}\n`,
  );
});

const stop = () => server.close(() => process.exit(0));
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
