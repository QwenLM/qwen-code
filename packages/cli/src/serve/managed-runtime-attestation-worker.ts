/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Readable } from 'node:stream';
import express from 'express';
import { MANAGED_TOOL_RESULT_ROUTES } from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result.js';
import {
  OWNED_MANAGED_RUNTIME_ROUTES,
  ownedManagedRuntimeRouteGate,
  registerManagedRuntimeAttestationRoute,
  type ManagedRuntimeAttestationIdentity,
} from './managed-runtime-attestation-contract.js';
import {
  createManagedContextReady,
  parseManagedContextBoot,
  type ManagedContextBoot,
  type ManagedContextReady,
} from './managed-context-envelope.js';
import {
  MANAGED_CONTEXT_WORKER_ROUTES,
  ManagedContextMount,
  registerManagedContextRoutes,
} from './managed-context-worker.js';
import {
  ManagedToolExecutor,
  type ManagedShellCapturePublisher,
} from './managed-runtime-tool-executor.js';
import { managedRuntimeLedgerFromEnvironment } from './managed-runtime-ledger.js';
import { PUBLICATION_INSTALL_ROUTE } from './remote-shell-result-publication.js';
import { WORKSPACE_CAPABILITY_DIGEST } from './managed-workspace-activation.js';
import {
  ManagedShellPublisherRegistry,
  MANAGED_SHELL_PUBLISHER_ROUTE,
} from './managed-shell-publisher.js';
import { registerManagedRuntimeToolRoutes } from './managed-runtime-tool-routes.js';
import { scrubAndReportInheritedLoaderEnv } from '../config/shared-env-keys.js';
import { MANAGED_RUNTIME_PROVIDER_ROUTE } from './managed-runtime-provider-protocol.js';
import { registerManagedRuntimeProviderRoute } from './managed-runtime-provider-worker.js';
import {
  parseManagedCsiBoot,
  type ManagedCsiBoot,
} from './managed-csi-envelope.js';
import { ManagedCsiMount } from './managed-csi-mount.js';
import {
  MANAGED_CSI_ATTEST_ROUTE,
  MANAGED_CSI_DRAIN_ROUTE,
  MANAGED_CSI_ACK_ROUTE,
  registerManagedCsiAttestationRoute,
  registerManagedCsiDrainRoute,
  registerManagedCsiAckRoute,
} from './managed-csi-worker.js';

const MANAGED_RUNTIME_WORKER_BOOT_LIMIT_BYTES = 32 * 1024;
const MANAGED_RUNTIME_WORKER_BOOT_TIMEOUT_MS = 30_000;
const INVALID_BOOT_MESSAGE = 'Managed Runtime worker boot payload is invalid.';
const BOOT_KEYS = Object.freeze([
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
] as const);

export interface ManagedRuntimeWorkerBoot
  extends ManagedRuntimeAttestationIdentity {
  readonly type: 'boot';
  readonly version: 1;
}

export interface ManagedRuntimeWorkerReady {
  readonly type: 'ready';
  readonly version: 1;
  readonly runtimeInstanceId: string;
  readonly runtimeIncarnation: string;
  readonly leaseId: string;
  readonly epoch: number;
  readonly url: string;
}

export interface ManagedRuntimeAttestationWorkerHandle {
  readonly ready: ManagedRuntimeWorkerReady | ManagedContextReady;
  close(): Promise<void>;
}

function isExactBoot(value: unknown): value is ManagedRuntimeWorkerBoot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  if (
    keys.length !== BOOT_KEYS.length ||
    !keys.every((key, index) => key === BOOT_KEYS[index])
  ) {
    return false;
  }
  const boot = value as Record<string, unknown>;
  return boot['type'] === 'boot' && boot['version'] === 1;
}

async function collectManagedRuntimeWorkerBoot(
  input: Readable,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MANAGED_RUNTIME_WORKER_BOOT_LIMIT_BYTES) {
      throw new Error(INVALID_BOOT_MESSAGE);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function parseWorkerBoot(
  document: Buffer,
): ManagedRuntimeWorkerBoot | ManagedContextBoot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(document.toString('utf8'));
  } catch {
    throw new Error(INVALID_BOOT_MESSAGE);
  }
  if (isExactBoot(parsed)) {
    return parsed;
  }
  try {
    // Boot v2 is UTF-8: bytes that are not are refused, never replaced.
    new TextDecoder('utf-8', { fatal: true }).decode(document);
    return parseManagedContextBoot(parsed);
  } catch {
    throw new Error(INVALID_BOOT_MESSAGE);
  }
}

/** Reads boot v1, or boot v2 of `managed-context/1`, from standard input. */
export async function readManagedRuntimeWorkerBoot(
  input: Readable,
): Promise<ManagedRuntimeWorkerBoot | ManagedContextBoot> {
  return parseWorkerBoot(await readBootDocument(input));
}

async function readBootDocument(input: Readable): Promise<Buffer> {
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      input.destroy();
      reject(new Error(INVALID_BOOT_MESSAGE));
    }, MANAGED_RUNTIME_WORKER_BOOT_TIMEOUT_MS);
    timeout.unref();
  });
  try {
    return await Promise.race([
      collectManagedRuntimeWorkerBoot(input),
      timedOut,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function startManagedRuntimeAttestationWorker(
  bootDocument: ManagedRuntimeWorkerBoot | ManagedContextBoot | ManagedCsiBoot,
  capturePublisher?: ManagedShellCapturePublisher,
  remotePublishers?: ManagedShellPublisherRegistry,
  containerMode = false,
): Promise<ManagedRuntimeAttestationWorkerHandle> {
  const resolved =
    bootDocument.version === 3
      ? parseManagedCsiBoot(bootDocument)
      : bootDocument;
  const csiBoot = resolved.version === 3 ? resolved : undefined;
  const boot = resolved.version === 3 ? resolved.context : resolved;
  if (
    (csiBoot !== undefined && !containerMode) ||
    (containerMode &&
      csiBoot === undefined &&
      (boot.version !== 1 || boot.isolationClass !== 'session'))
  ) {
    throw new Error(INVALID_BOOT_MESSAGE);
  }
  const app = express();
  app.disable('x-powered-by');
  const csiMount = csiBoot
    ? new ManagedCsiMount(csiBoot.context.mountRoot, csiBoot.storage.diskSerial)
    : undefined;
  if (csiBoot && csiMount) {
    await csiMount.observe();
    registerManagedCsiAttestationRoute(app, csiBoot, csiMount);
  }
  let executor: ManagedToolExecutor;
  if (boot.version === 2) {
    executor = registerManagedContextRoutes(
      app,
      boot,
      capturePublisher,
      remotePublishers,
      csiMount,
    );
  } else {
    registerManagedRuntimeAttestationRoute(app, boot);
    // A Managed session's host names one ledger per worker incarnation and
    // sweeps it if the worker dies; a worker that cannot keep it must not
    // answer a Shell, so a failure here fails the boot.
    const ledger = managedRuntimeLedgerFromEnvironment(boot.runtimeIncarnation);
    ledger?.watch();
    executor = ManagedToolExecutor.forWorkspace(
      boot.workspaceCwd,
      boot.runtimeInstanceId,
      { ledger },
    );
    registerManagedRuntimeToolRoutes(app, boot, executor);
    const mount = new ManagedContextMount(boot.workspaceCwd);
    registerManagedRuntimeProviderRoute(app, boot, executor, async () => {
      const directory = await mount.resolve('');
      return directory === undefined
        ? undefined
        : { directory, workspaceRoot: directory, preapproved: false };
    });
  }
  if (csiBoot) {
    registerManagedCsiDrainRoute(app, csiBoot, executor);
    registerManagedCsiAckRoute(app, csiBoot, executor);
  }
  const server = createServer(
    ownedManagedRuntimeRouteGate(
      app,
      boot.version === 2
        ? capturePublisher ||
          remotePublishers ||
          boot.capabilityDigest === WORKSPACE_CAPABILITY_DIGEST
          ? [
              ...MANAGED_CONTEXT_WORKER_ROUTES,
              ...(csiBoot
                ? [
                    MANAGED_CSI_ATTEST_ROUTE,
                    MANAGED_CSI_DRAIN_ROUTE,
                    MANAGED_CSI_ACK_ROUTE,
                  ]
                : []),
              ...MANAGED_TOOL_RESULT_ROUTES,
              ...(remotePublishers ? [MANAGED_SHELL_PUBLISHER_ROUTE] : []),
              ...(!capturePublisher &&
              boot.capabilityDigest === WORKSPACE_CAPABILITY_DIGEST
                ? [PUBLICATION_INSTALL_ROUTE]
                : []),
            ]
          : [
              ...MANAGED_CONTEXT_WORKER_ROUTES,
              ...(csiBoot
                ? [
                    MANAGED_CSI_ATTEST_ROUTE,
                    MANAGED_CSI_DRAIN_ROUTE,
                    MANAGED_CSI_ACK_ROUTE,
                  ]
                : []),
            ]
        : [...OWNED_MANAGED_RUNTIME_ROUTES, MANAGED_RUNTIME_PROVIDER_ROUTE],
    ),
  );
  server.maxHeadersCount = 32;
  server.headersTimeout = 5_000;
  server.requestTimeout = 5_000;
  server.keepAliveTimeout = 1_000;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(
      containerMode ? 43190 : 0,
      containerMode ? '0.0.0.0' : '127.0.0.1',
    );
  });

  const address = server.address() as AddressInfo | null;
  if (!address) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('Managed Runtime worker listener is unavailable.');
  }
  const ready =
    boot.version === 2
      ? createManagedContextReady(boot, address.port)
      : Object.freeze({
          type: 'ready',
          version: 1,
          runtimeInstanceId: boot.runtimeInstanceId,
          runtimeIncarnation: boot.runtimeIncarnation,
          leaseId: boot.leaseId,
          epoch: boot.epoch,
          url: `http://127.0.0.1:${address.port}`,
        } satisfies ManagedRuntimeWorkerReady);
  let closing: Promise<void> | undefined;

  return {
    ready,
    close: () => {
      closing ??= executor.close().then(
        () =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
            server.closeAllConnections();
          }),
      );
      return closing;
    },
  };
}

export async function readManagedRuntimeContainerBoot(
  bootPath: string,
): Promise<ManagedRuntimeWorkerBoot | ManagedCsiBoot> {
  if (!path.isAbsolute(bootPath)) throw new Error(INVALID_BOOT_MESSAGE);
  const input = createReadStream(bootPath);
  try {
    const document = await readBootDocument(input);
    const parsed: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(document),
    );
    if (
      parsed &&
      typeof parsed === 'object' &&
      'version' in parsed &&
      parsed.version === 3
    ) {
      return parseManagedCsiBoot(parsed);
    }
    const boot = parseWorkerBoot(document);
    if (boot.version !== 1 || boot.isolationClass !== 'session') {
      throw new Error(INVALID_BOOT_MESSAGE);
    }
    return boot;
  } catch {
    throw new Error(INVALID_BOOT_MESSAGE);
  } finally {
    input.destroy();
  }
}

export async function runManagedRuntimeAttestationWorker(
  containerBootPath?: string,
): Promise<void> {
  // A Managed session's host starts its worker over an IPC channel, with the
  // loader vars that only boot this process; the commands it runs must not
  // inherit them. Other launchers choose the worker's environment themselves.
  if (typeof process.send === 'function') {
    scrubAndReportInheritedLoaderEnv(
      process.env,
      'qwen',
      'Managed Runtime worker',
    );
  }
  let boot: ManagedRuntimeWorkerBoot | ManagedContextBoot | ManagedCsiBoot;
  try {
    boot =
      containerBootPath !== undefined
        ? await readManagedRuntimeContainerBoot(containerBootPath)
        : await readManagedRuntimeWorkerBoot(process.stdin);
  } catch (error) {
    if (containerBootPath === undefined) throw error;
    process.stderr.write(`${INVALID_BOOT_MESSAGE}\n`);
    process.exitCode = 1;
    return;
  }
  const contextBoot = boot.version === 3 ? boot.context : boot;
  const worker = await startManagedRuntimeAttestationWorker(
    boot,
    undefined,
    contextBoot.version === 2 &&
      contextBoot.capabilityDigest === WORKSPACE_CAPABILITY_DIGEST
      ? new ManagedShellPublisherRegistry()
      : undefined,
    containerBootPath !== undefined,
  );

  await new Promise<void>((resolve, reject) => {
    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      void worker.close().then(() => {
        // The parent's channel would otherwise keep this process alive.
        if (process.connected) process.disconnect();
        resolve();
      }, reject);
    };
    const closeAfterOutputFailure = () => {
      process.exitCode = 1;
      close();
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    // A parent that starts the worker with an IPC channel, such as a Managed
    // session's host, owns its lifetime: however the parent ends, the channel
    // closes and the worker stops its calls and exits.
    if (typeof process.send === 'function') {
      process.channel?.unref();
      process.once('disconnect', close);
      if (!process.connected) close();
    }
    process.stdout.once('error', closeAfterOutputFailure);
    process.stdout.write(`${JSON.stringify(worker.ready)}\n`, (error) => {
      if (error) closeAfterOutputFailure();
    });
  });
}
