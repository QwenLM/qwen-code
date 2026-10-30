/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Application } from 'express';
import { atomicWriteJSON } from '@qwen-code/qwen-code-core/utils/atomicFileWrite.js';
import {
  parseOperationGrant,
  type OperationGrant,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-record.js';
import { ManagedOperationGrantGate } from '@qwen-code/qwen-code-core/managed-runtime/managed-operation-grant-gate.js';
import {
  authorizeManagedRuntime,
  managedRuntimeJsonBody,
  managedRuntimeNoStore,
  nameManagedRuntimeIncarnation,
  type ManagedRuntimeRequestIdentity,
} from './managed-runtime-attestation-contract.js';
import {
  ManagedMcpToolUnknownError,
  type ManagedToolReference,
  type ManagedToolResultPayload,
} from './managed-runtime-tool-executor.js';

export const MANAGED_EXTENSION_COMMAND_ROUTE = Object.freeze({
  key: 'extension-command',
  method: 'POST',
  path: '/internal/managed-runtime/v3/extensions/commands',
});

export interface ManagedExtensionCommand {
  readonly kind: 'extension-command';
  readonly operationId: string;
  readonly action: 'execute' | 'status' | 'cancel';
  readonly grant: OperationGrant;
  readonly toolName: 'read_file' | 'shell';
  readonly input: Record<string, unknown>;
  readonly revision: number;
  readonly extensionId: string;
}

interface View {
  readonly operationId: string;
  readonly state: 'running' | 'settled' | 'outcome_unknown';
  readonly result?: ManagedToolResultPayload;
}

interface Receipt {
  readonly operationId: string;
  readonly fingerprint: string;
  readonly state: 'running' | 'settled';
  readonly result?: ManagedToolResultPayload;
}

export interface ManagedExtensionCommandDependencies {
  readonly directory: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly workspaceGeneration: string;
  readonly prepareInput: (
    runtimeSessionId: string,
    operation: ManagedExtensionCommand,
  ) => Promise<Record<string, unknown>>;
  readonly execute: (
    reference: ManagedToolReference,
    toolName: string,
    input: Record<string, unknown>,
  ) => Promise<ManagedToolResultPayload>;
  readonly cancel: (reference: ManagedToolReference) => unknown;
}

/** An intent surviving its process is unknown. It can never dispatch twice. */
export class ManagedExtensionCommandRuntime {
  private readonly gates = new ManagedOperationGrantGate();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly running = new Map<
    string,
    {
      reference: ManagedToolReference;
      controller: AbortController;
      done: Promise<void>;
    }
  >();

  constructor(
    private readonly dependencies: ManagedExtensionCommandDependencies,
  ) {
    if (!path.isAbsolute(dependencies.directory))
      throw new Error('Invalid command receipt directory.');
  }

  async control(runtimeSessionId: string, value: unknown): Promise<View> {
    const operation = this.parse(runtimeSessionId, value);
    const key = digest([operation.grant.sessionKey, operation.operationId]);
    const previous = this.locks.get(key) ?? Promise.resolve();
    const pending = previous
      .catch(() => undefined)
      .then(() => this.controlLocked(key, runtimeSessionId, operation));
    this.locks.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.locks.get(key) === pending) this.locks.delete(key);
    }
  }

  private async controlLocked(
    key: string,
    runtimeSessionId: string,
    operation: ManagedExtensionCommand,
  ): Promise<View> {
    const filename = path.join(this.dependencies.directory, `${key}.json`);
    const fingerprint = digest({
      runtimeSessionId,
      harnessSessionId: operation.grant.sessionKey.sessionId,
      operationId: operation.operationId,
      toolName: operation.toolName,
      input: operation.input,
      revision: operation.revision,
      extensionId: operation.extensionId,
    });
    const stored = await this.read(filename);
    if (
      stored &&
      (stored.operationId !== operation.operationId ||
        stored.fingerprint !== fingerprint)
    )
      throw new Error('Original extension command identity conflicts.');
    if (stored?.state === 'settled')
      return {
        operationId: operation.operationId,
        state: 'settled',
        result: stored.result!,
      };
    const active = this.running.get(key);
    if (operation.action === 'cancel') {
      if (active) {
        active.controller.abort();
        if (active.reference.argsDigest)
          await this.dependencies.cancel(active.reference);
      }
      return {
        operationId: operation.operationId,
        state: active ? 'running' : 'outcome_unknown',
      };
    }
    if (stored || operation.action === 'status')
      return {
        operationId: operation.operationId,
        state: active ? 'running' : 'outcome_unknown',
      };
    await fs.mkdir(this.dependencies.directory, {
      recursive: true,
      mode: 0o700,
    });
    await atomicWriteJSON(
      filename,
      { operationId: operation.operationId, fingerprint, state: 'running' },
      { mode: 0o600, forceMode: true, noFollow: true },
    );
    const reference = {
      sessionId: runtimeSessionId,
      promptId: `extension-command:${operation.operationId}`,
      callId: operation.operationId,
      argsDigest: '',
    };
    const controller = new AbortController();
    const work = Promise.resolve()
      .then(async () => {
        let started = false;
        try {
          const input = await this.dependencies.prepareInput(
            runtimeSessionId,
            operation,
          );
          controller.signal.throwIfAborted();
          reference.argsDigest = createHash('sha256')
            .update(JSON.stringify(input))
            .digest('hex');
          started = true;
          const result = await this.dependencies.execute(
            reference,
            operation.toolName === 'shell' ? 'run_shell_command' : 'read_file',
            input,
          );
          // Command expansion has the same bounded inline result contract as its persisted resource.
          const bounded: ManagedToolResultPayload =
            Buffer.byteLength(JSON.stringify(result)) <= 48 * 1024
              ? result
              : {
                  executionStatus: 'error',
                  responseParts: [
                    {
                      text: 'Command preprocessing output exceeds the inline limit.',
                    },
                  ],
                };
          await atomicWriteJSON(
            filename,
            {
              operationId: operation.operationId,
              fingerprint,
              state: 'settled',
              result: bounded,
            },
            { mode: 0o600, forceMode: true, noFollow: true },
          );
        } catch (error) {
          if (started || error instanceof ManagedMcpToolUnknownError) return;
          await atomicWriteJSON(
            filename,
            {
              operationId: operation.operationId,
              fingerprint,
              state: 'settled',
              result: {
                executionStatus: 'not_started',
                responseParts: [
                  { text: 'Extension command admission failed.' },
                ],
              },
            },
            { mode: 0o600, forceMode: true, noFollow: true },
          );
        }
      })
      .finally(() => this.running.delete(key));
    this.running.set(key, { reference, controller, done: work });
    void work.catch(() => undefined);
    return { operationId: operation.operationId, state: 'running' };
  }

  private parse(
    runtimeSessionId: string,
    value: unknown,
  ): ManagedExtensionCommand {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid command control.');
    const op = value as Record<string, unknown>;
    if (
      Object.keys(op).sort().join(',') !==
        'action,extensionId,grant,input,kind,operationId,revision,toolName' ||
      op['kind'] !== 'extension-command' ||
      !['execute', 'status', 'cancel'].includes(String(op['action'])) ||
      typeof op['operationId'] !== 'string' ||
      !/^command-step-[a-f0-9]{64}$/u.test(op['operationId']) ||
      !['read_file', 'shell'].includes(String(op['toolName'])) ||
      !op['input'] ||
      typeof op['input'] !== 'object' ||
      Array.isArray(op['input']) ||
      !Number.isSafeInteger(op['revision']) ||
      Number(op['revision']) < 1 ||
      typeof op['extensionId'] !== 'string' ||
      !/^ext_[a-f0-9-]{36}$/u.test(op['extensionId'])
    )
      throw new Error('Invalid command control.');
    const grant = parseOperationGrant(op['grant']);
    if (
      grant.domain !== 'tool_stage' ||
      grant.operationId !== op['operationId'] ||
      grant.ownerId !== runtimeSessionId ||
      grant.sessionKey.tenantId !== this.dependencies.tenantId ||
      grant.sessionKey.workspaceId !== this.dependencies.workspaceId ||
      grant.workspaceGeneration !== this.dependencies.workspaceGeneration
    )
      throw new Error('Command owner conflicts.');
    this.gates.install(grant);
    if (
      !this.gates.admits(
        grant.sessionKey,
        grant.operationId,
        String(op['action']),
        Date.now(),
      )
    )
      throw new Error('Command grant does not admit this action.');
    return { ...op, grant } as unknown as ManagedExtensionCommand;
  }

  private async read(filename: string): Promise<Receipt | undefined> {
    try {
      const stat = await fs.lstat(filename);
      if (!stat.isFile() || stat.size > 64 * 1024)
        throw new Error('Invalid command receipt.');
      const value = JSON.parse(await fs.readFile(filename, 'utf8')) as Receipt;
      if (
        !['running', 'settled'].includes(value.state) ||
        typeof value.fingerprint !== 'string' ||
        (value.state === 'settled' &&
          (!value.result || !Array.isArray(value.result.responseParts)))
      )
        throw new Error('Invalid command receipt.');
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
}

export function registerManagedExtensionCommandRoute(
  app: Application,
  identity: ManagedRuntimeRequestIdentity & { runtimeIncarnation: string },
  runtime: ManagedExtensionCommandRuntime,
): void {
  app.post(
    MANAGED_EXTENSION_COMMAND_ROUTE.path,
    managedRuntimeNoStore,
    authorizeManagedRuntime(identity),
    nameManagedRuntimeIncarnation(identity),
    managedRuntimeJsonBody(64 * 1024),
    async (req, res) => {
      try {
        const body = req.body as Record<string, unknown>;
        if (
          !body ||
          Object.keys(body).sort().join(',') !==
            'operation,protocolVersion,runtimeSessionId' ||
          body['protocolVersion'] !== 1 ||
          typeof body['runtimeSessionId'] !== 'string'
        )
          throw new Error('Invalid command envelope.');
        const result = await runtime.control(
          body['runtimeSessionId'],
          body['operation'],
        );
        res.json({
          protocolVersion: 1,
          runtimeSessionId: body['runtimeSessionId'],
          result,
        });
      } catch {
        res.status(409).json({ code: 'managed_extension_command_refused' });
      }
    },
  );
}

function digest(value: unknown): string {
  const canonical = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(canonical)
      : item && typeof item === 'object'
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, child]) => [key, canonical(child)]),
          )
        : item;
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
