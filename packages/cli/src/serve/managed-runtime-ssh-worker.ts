/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { access } from 'node:fs/promises';
import type { Application } from 'express';
import { getCliVersion } from '../utils/version.js';
import {
  authorizeManagedRuntime,
  managedRuntimeJsonBody,
  managedRuntimeNoStore,
  nameManagedRuntimeIncarnation,
} from './managed-runtime-attestation-contract.js';
import type { ManagedContextBoot } from './managed-context-envelope.js';
import { ManagedRuntimeLedger } from './managed-runtime-ledger.js';
import type { ManagedToolExecutor } from './managed-runtime-tool-executor.js';
import {
  SSH_RETIRE_PATH,
  readSshPrivateJson,
  readSshRuntimeRecord,
  sshCleanProof,
  sshResourcePath,
  verifySshStorage,
  writeSshPrivateJson,
  type SshRuntimeRecord,
} from './managed-runtime-bootstrap.js';

export class ManagedSshRuntime {
  readonly route = { method: 'POST', path: SSH_RETIRE_PATH };
  readonly finished: Promise<void>;
  private finish!: () => void;
  private retirement?: Promise<unknown>;

  constructor(
    readonly record: SshRuntimeRecord,
    readonly ledger: ManagedRuntimeLedger,
  ) {
    this.finished = new Promise((resolve) => {
      this.finish = resolve;
    });
  }

  verifyStorage(): Promise<void> {
    return verifySshStorage(this.record.identity, this.record.marker);
  }

  register(
    app: Application,
    boot: ManagedContextBoot,
    executor: ManagedToolExecutor,
  ): void {
    app.post(
      this.route.path,
      managedRuntimeNoStore,
      authorizeManagedRuntime(boot),
      nameManagedRuntimeIncarnation(boot),
      managedRuntimeJsonBody(16 * 1024),
      async (req, res) => {
        try {
          const body: unknown = req.body;
          if (!body || typeof body !== 'object' || Array.isArray(body))
            throw new Error('Invalid retirement.');
          const request = body as Record<string, unknown>;
          if (
            Object.keys(request).length !== 3 ||
            request['protocolVersion'] !== 1 ||
            request['resourceId'] !== this.record.resourceId ||
            typeof request['retirementId'] !== 'string'
          )
            throw new Error('Invalid retirement.');
          const retirementId = request['retirementId'];
          const directory = sshResourcePath(this.record);
          const stop = await readSshPrivateJson(
            path.join(directory, 'stop.json'),
          );
          if (JSON.stringify(stop) !== JSON.stringify({ retirementId }))
            throw new Error('Retirement claim conflicts.');
          await this.verifyStorage();
          executor.sealAdmission(retirementId);
          this.retirement ??= (async () => {
            await executor.retireSsh(retirementId);
            await this.verifyStorage();
            const proof = sshCleanProof(
              this.record,
              retirementId,
              new Date().toISOString(),
            );
            await writeSshPrivateJson(
              path.join(directory, 'clean.json'),
              proof,
            );
            return proof;
          })().catch((error: unknown) => {
            this.retirement = undefined;
            throw error;
          });
          const proof = await this.retirement;
          res.once('finish', this.finish);
          res.once('close', this.finish);
          res.json({
            protocolVersion: 1,
            ok: true,
            result: { cleanProof: proof },
          });
        } catch {
          res.status(409).json({
            protocolVersion: 1,
            ok: false,
            error: {
              code: 'ssh_runtime_retirement_unverified',
              message: 'Original Runtime retirement is unverified.',
              retryable: true,
            },
          });
        }
      },
    );
  }
}

export async function runManagedRuntimeBootstrapWorker(
  directory: string,
): Promise<void> {
  const record = await readSshRuntimeRecord(directory);
  if (record.expectedQwenVersion !== (await getCliVersion()))
    throw new Error('Pinned Qwen version changed before Runtime startup.');
  await verifySshStorage(record.identity, record.marker);
  await writeSshPrivateJson(path.join(directory, 'pid.json'), {
    pid: process.pid,
  });
  const closing = async () => {
    try {
      await access(path.join(directory, 'stop.json'));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  };
  if (await closing())
    throw new Error('Runtime startup was fenced by retirement.');
  // Launcher metadata is private to the worker, never Shell environment.
  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith('QWEN_MANAGED_') ||
      key === 'NODE_OPTIONS' ||
      key === 'NODE_PATH'
    )
      delete process.env[key];
  }
  const ledger = ManagedRuntimeLedger.create({
    workFile: path.join(directory, 'shell-ledger.json'),
    worker: {
      pid: process.pid,
      pgid: process.pid,
      incarnation: record.boot.runtimeIncarnation,
      startedAt: Date.now(),
      uptimeMs: (await import('node:os')).uptime() * 1000,
    },
  });
  ledger.watch();
  const runtime = new ManagedSshRuntime(record, ledger);
  const { startManagedRuntimeAttestationWorker } = await import(
    './managed-runtime-attestation-worker.js'
  );
  const { ManagedShellPublisherRegistry } = await import(
    './managed-shell-publisher.js'
  );
  const worker = await startManagedRuntimeAttestationWorker(
    record.boot,
    undefined,
    new ManagedShellPublisherRegistry(),
    false,
    runtime,
  );
  if (await closing()) {
    await worker.close();
    throw new Error('Runtime startup was fenced by retirement.');
  }
  await writeSshPrivateJson(path.join(directory, 'ready.json'), worker.ready);
  const interrupted = new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  await Promise.race([runtime.finished, interrupted]);
  await worker.close();
}
