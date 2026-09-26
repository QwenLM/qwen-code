/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Readable } from 'node:stream';
import express from 'express';
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
  registerManagedContextRoutes,
} from './managed-context-worker.js';
import { ManagedToolExecutor } from './managed-runtime-tool-executor.js';
import { registerManagedRuntimeToolRoutes } from './managed-runtime-tool-routes.js';

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
): Promise<ManagedRuntimeWorkerBoot | ManagedContextBoot> {
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error(INVALID_BOOT_MESSAGE);
  }
  if (isExactBoot(parsed)) {
    return parsed;
  }
  try {
    return parseManagedContextBoot(parsed);
  } catch {
    throw new Error(INVALID_BOOT_MESSAGE);
  }
}

/** Reads boot v1, or boot v2 of `managed-context/1`, from standard input. */
export async function readManagedRuntimeWorkerBoot(
  input: Readable,
): Promise<ManagedRuntimeWorkerBoot | ManagedContextBoot> {
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
  boot: ManagedRuntimeWorkerBoot | ManagedContextBoot,
): Promise<ManagedRuntimeAttestationWorkerHandle> {
  const app = express();
  app.disable('x-powered-by');
  let executor: ManagedToolExecutor;
  if (boot.version === 2) {
    executor = registerManagedContextRoutes(app, boot);
  } else {
    registerManagedRuntimeAttestationRoute(app, boot);
    executor = ManagedToolExecutor.forWorkspace(
      boot.workspaceCwd,
      boot.runtimeInstanceId,
    );
    registerManagedRuntimeToolRoutes(app, boot, executor);
  }
  const server = createServer(
    ownedManagedRuntimeRouteGate(
      app,
      boot.version === 2
        ? MANAGED_CONTEXT_WORKER_ROUTES
        : OWNED_MANAGED_RUNTIME_ROUTES,
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
    server.listen(0, '127.0.0.1');
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

export async function runManagedRuntimeAttestationWorker(): Promise<void> {
  const boot = await readManagedRuntimeWorkerBoot(process.stdin);
  const worker = await startManagedRuntimeAttestationWorker(boot);

  await new Promise<void>((resolve, reject) => {
    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      void worker.close().then(resolve, reject);
    };
    const closeAfterOutputFailure = () => {
      process.exitCode = 1;
      close();
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    process.stdout.once('error', closeAfterOutputFailure);
    process.stdout.write(`${JSON.stringify(worker.ready)}\n`, (error) => {
      if (error) closeAfterOutputFailure();
    });
  });
}
