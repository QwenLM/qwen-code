import { createServer } from 'node:http';

const boot = JSON.parse(await new Promise((resolve, reject) => {
  const chunks = [];
  process.stdin.on('data', (chunk) => chunks.push(chunk));
  process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  process.stdin.on('error', reject);
}));

const server = createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method === 'POST'
        && url.pathname === '/internal/managed-runtime/v2/attest') {
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
      return;
    }
    response.writeHead(404, {
      'cache-control': 'no-store',
      'content-type': 'application/json',
    });
    response.end('{}');
  });
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  process.stdout.write(`${JSON.stringify({
    type: 'ready',
    version: 1,
    runtimeInstanceId: boot.runtimeInstanceId,
    runtimeIncarnation: boot.runtimeIncarnation,
    leaseId: boot.leaseId,
    epoch: boot.epoch,
    url: `http://127.0.0.1:${address.port}`,
  })}\n`);
});

const stop = () => server.close(() => process.exit(0));
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
