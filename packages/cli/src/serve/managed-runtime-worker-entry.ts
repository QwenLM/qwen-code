/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import path from 'node:path';
import type { ManagedWorkerBoot } from './managed-runtime-activator.js';
import {
  createManagedWorkerReadyRecord,
  isManagedWorkerBoot,
  parseManagedWorkerStartup,
  readManagedWorkerBootConfig,
  writeManagedWorkerReadyRecord,
  type ManagedWorkerFileBoot,
} from './managed-runtime-worker-bootstrap.js';
import type { RunHandle } from './run-qwen-serve.js';

let handle: RunHandle | undefined;
let starting: Promise<void> | undefined;
let closing = false;
let startup: ReturnType<typeof parseManagedWorkerStartup>;
try {
  startup = parseManagedWorkerStartup(process.argv.slice(2));
} catch {
  process.exit(1);
}
const bootTimer = setTimeout(() => {
  void close();
}, 30_000);
async function close(exitCode = 0): Promise<void> {
  if (closing) return;
  closing = true;
  clearTimeout(bootTimer);
  const force = setTimeout(() => process.exit(1), 15_000);
  try {
    await starting?.catch(() => {});
    await handle?.close();
  } catch {
    exitCode = 1;
  } finally {
    clearTimeout(force);
    process.exit(exitCode);
  }
}
process.once('disconnect', () => {
  void close();
});
process.once('SIGTERM', () => {
  void close();
});
process.once('SIGINT', () => {
  void close();
});
process.once('error', () => {
  void close();
});
async function start(
  boot: ManagedWorkerBoot,
  publishReady: (url: string) => Promise<void>,
): Promise<void> {
  clearTimeout(bootTimer);
  process.env['QWEN_RUNTIME_DIR'] = boot.outputRoot;
  process.env['QWEN_CLI_ENTRY'] = boot.cliEntry;
  const { runQwenServe } = await import('./run-qwen-serve.js');
  if (closing) return;
  handle = await runQwenServe(
    {
      mode: 'http-bridge',
      hostname: '127.0.0.1',
      port: 0,
      workspace: boot.workspaceCwd,
      token: boot.token,
      requireAuth: true,
      serveWebShell: false,
      experimentalManagedRuntimeWorker: true,
    },
    {
      ownedManagedRuntime: boot,
      preheatBridge: false,
      daemonLogBaseDir: path.join(boot.outputRoot, 'debug'),
    },
  );
  await handle.runtimeReady;
  if (closing) return;
  await publishReady(handle.url);
}

function begin(
  boot: ManagedWorkerBoot,
  publishReady: (url: string) => Promise<void>,
): void {
  if (starting || closing) {
    void close(1);
    return;
  }
  starting = start(boot, publishReady);
  void starting.catch(() => {
    void close(1);
  });
}

function ipcReady(boot: ManagedWorkerBoot, url: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    process.send?.(
      {
        type: 'ready',
        version: 1,
        gatewayIncarnation: boot.gatewayIncarnation,
        leaseId: boot.leaseId,
        epoch: boot.epoch,
        tenantId: boot.tenantId,
        workspaceId: boot.workspaceId,
        workspaceCwd: boot.workspaceCwd,
        url,
      },
      (error) => {
        if (error) reject(error);
        else resolve();
      },
    );
    if (!process.send) reject(new Error('Managed Runtime IPC is unavailable.'));
  });
}

async function fileReady(
  boot: ManagedWorkerFileBoot,
  readyRecordPath: string,
  url: string,
): Promise<void> {
  const ready = createManagedWorkerReadyRecord(boot, url);
  await writeManagedWorkerReadyRecord(readyRecordPath, ready);
}

if (startup.kind === 'ipc') {
  process.on('message', (message: unknown) => {
    if ((message as { type?: unknown })?.type === 'shutdown') {
      void close();
      return;
    }
    if (!isManagedWorkerBoot(message)) {
      void close(1);
      return;
    }
    begin(message, (url) => ipcReady(message, url));
  });
  if (!process.connected) void close(1);
} else if (process.connected) {
  void close(1);
} else {
  void readManagedWorkerBootConfig(startup.bootConfigPath)
    .then((boot) => {
      begin(boot, (url) => fileReady(boot, startup.readyRecordPath, url));
    })
    .catch(() => close(1));
}
