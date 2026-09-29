import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = process.cwd();
const workerEntry = path.join(root, 'dist', 'managed-runtime-worker.js');
const cliEntry = path.join(root, 'dist', 'cli.js');
if (!existsSync(workerEntry) || !existsSync(cliEntry)) {
  throw new Error(
    'Managed Runtime worker env E2E requires dist/cli.js and dist/managed-runtime-worker.js; run the CLI build and bundle first.',
  );
}

const temporary = realpathSync(
  mkdtempSync(path.join(tmpdir(), 'managed-runtime-worker-env-e2e-')),
);
const workspace = path.join(temporary, 'workspace');
const runtimeHome = path.join(temporary, 'home');
const qwenHome = path.join(runtimeHome, '.qwen');
const outputRoot = path.join(temporary, 'output');
mkdirSync(workspace, { recursive: true });
mkdirSync(qwenHome, { recursive: true });
mkdirSync(outputRoot, { recursive: true });
writeFileSync(
  path.join(qwenHome, 'settings.json'),
  JSON.stringify({ ui: { enableFollowupSuggestions: false } }),
);
const canonicalWorkspace = realpathSync(workspace);
const workspaceId = createHash('sha256')
  .update(canonicalWorkspace)
  .digest('hex')
  .slice(0, 16);
const port = await availablePort();
const token = randomBytes(24).toString('base64url');
const leaseId = randomUUID();
const sessionId = randomUUID();
const boot = {
  type: 'boot',
  version: 1,
  runtimeInstanceId: randomUUID(),
  gatewayIncarnation: randomUUID(),
  leaseId,
  epoch: 1,
  tenantId: 'tenant-e2e',
  workspaceId,
  workspaceCwd: canonicalWorkspace,
  token,
  outputRoot,
  cliEntry,
  listenHostname: '0.0.0.0',
  listenPort: port,
};
const child = spawn(process.execPath, [workerEntry, '--boot-env'], {
  cwd: canonicalWorkspace,
  detached: process.platform !== 'win32',
  env: {
    HOME: runtimeHome,
    LANG: process.env['LANG'] ?? 'C.UTF-8',
    PATH: process.env['PATH'],
    QWEN_HOME: qwenHome,
    QWEN_MANAGED_RUNTIME_BOOT: JSON.stringify(boot),
    TMPDIR: process.env['TMPDIR'] ?? tmpdir(),
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
child.stderr?.on('data', (chunk) => {
  stderr += chunk.toString();
});

try {
  const ready = await waitForPrepare(child, {
    port,
    token,
    leaseId,
    sessionId,
    workspaceId,
    workspaceCwd: canonicalWorkspace,
  });
  if (ready.protocolVersion !== 1 || ready.ready !== true) {
    throw new Error(
      'Managed Runtime worker returned an invalid prepare response.',
    );
  }
  const fenced = await prepare({
    port,
    token,
    leaseId: randomUUID(),
    sessionId,
    workspaceId,
    workspaceCwd: canonicalWorkspace,
  });
  if (
    fenced.status !== 409 ||
    fenced.body['code'] !== 'managed_runtime_identity_conflict'
  ) {
    throw new Error('Managed Runtime worker did not fence a mismatched lease.');
  }
  process.stdout.write(
    `${JSON.stringify({ remoteWorkerReady: true, leaseFencing: true, workspaceId })}\n`,
  );
} finally {
  await stopProcessTree(child);
  rmSync(temporary, { recursive: true, force: true });
}

interface PrepareIdentity {
  port: number;
  token: string;
  leaseId: string;
  sessionId: string;
  workspaceId: string;
  workspaceCwd: string;
}

async function prepare(identity: PrepareIdentity): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const response = await fetch(
    `http://127.0.0.1:${identity.port}/internal/managed-runtime/v1/prepare`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${identity.token}`,
        'Content-Type': 'application/json',
        'X-Qwen-Managed-Lease-Epoch': '1',
        'X-Qwen-Managed-Lease-Id': identity.leaseId,
      },
      body: JSON.stringify({
        protocolVersion: 1,
        tenantId: 'tenant-e2e',
        workspaceId: identity.workspaceId,
        workspaceCwd: identity.workspaceCwd,
        sessionId: identity.sessionId,
        turnKind: 'bootstrap',
      }),
    },
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function waitForPrepare(
  childProcess: ChildProcess,
  identity: PrepareIdentity,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 30_000;
  let lastFailure = 'worker did not accept a connection';
  while (Date.now() < deadline) {
    if (childProcess.exitCode !== null || childProcess.signalCode !== null) {
      throw new Error(
        `Managed Runtime worker exited during startup: ${stderr.slice(-2_000)}`,
      );
    }
    try {
      const response = await prepare(identity);
      if (response.status === 200) return response.body;
      lastFailure = `HTTP ${response.status} ${JSON.stringify(response.body)}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `Managed Runtime worker did not become ready: ${lastFailure}; ${stderr.slice(-2_000)}`,
  );
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function stopProcessTree(childProcess: ChildProcess): Promise<void> {
  if (childProcess.exitCode !== null || childProcess.signalCode !== null)
    return;
  if (process.platform !== 'win32' && childProcess.pid !== undefined) {
    try {
      process.kill(-childProcess.pid, 'SIGTERM');
    } catch {
      childProcess.kill('SIGTERM');
    }
  } else {
    childProcess.kill('SIGTERM');
  }
  const exited = await Promise.race([
    new Promise<boolean>((resolve) =>
      childProcess.once('exit', () => resolve(true)),
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!exited) {
    if (process.platform !== 'win32' && childProcess.pid !== undefined) {
      try {
        process.kill(-childProcess.pid, 'SIGKILL');
        return;
      } catch {
        // Fall through to the direct child handle.
      }
    }
    childProcess.kill('SIGKILL');
  }
}
