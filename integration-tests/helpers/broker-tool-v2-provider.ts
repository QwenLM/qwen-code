/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Test-only adapter from the Managed Runtime Broker client to the
// ManagedToolV2Client surface used by the provider-media M4 driver.

import { setTimeout as delay } from 'node:timers/promises';
import type {
  ManagedToolExecutionResult,
  ManagedToolInvocationStatus,
  ManagedToolV2Client,
} from '@qwen-code/qwen-code-core/tools/managed-tool-runtime.js';
import type { ManagedToolInvocationReference } from '@qwen-code/qwen-code-core/tools/managed-tool-protocol.js';
import {
  ManagedRuntimeBrokerClient,
  type ManagedRuntimeBrokerClientOptions,
} from '../../packages/cli/src/serve/managed-runtime-broker-client.js';
import type { ManagedRuntimePrepareRequest } from '../../packages/cli/src/serve/managed-runtime-protocol.js';
import {
  parseManagedRuntimeProviderOperation,
  parseManagedRuntimeProviderResult,
  type ManagedRuntimeProviderOperation,
} from '../../packages/cli/src/serve/managed-runtime-provider-protocol.js';

const REQUEST_TIMEOUT_MS = 60_000;
const POLL_DELAY_MS = 100;

interface SessionEntry {
  readonly request: ManagedRuntimePrepareRequest;
  readonly harnessSessionId: string;
  readonly executions: Map<string, string>;
}

interface ExecutionIdentity {
  harnessSessionId: string;
  runtimeSessionId: string;
  executionCallId: string;
  afterSeq?: number;
}

type Inspection =
  | { outcome: 'known'; status: ManagedToolInvocationStatus }
  | { outcome: 'unknown' };

export class BrokerManagedRuntimeProvider {
  private readonly client: ManagedRuntimeBrokerClient;
  private readonly lifetime = new AbortController();
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly released = new Set<string>();

  constructor(options: ManagedRuntimeBrokerClientOptions) {
    this.client = new ManagedRuntimeBrokerClient(options);
  }

  async getToolV2Client(
    request: ManagedRuntimePrepareRequest,
    context?: { harnessSessionId?: string },
  ): Promise<ManagedToolV2Client> {
    const harnessSessionId = context?.harnessSessionId?.trim();
    if (!harnessSessionId) {
      throw new Error('Harness Session identity is required.');
    }
    await this.client.acquire(request, harnessSessionId, this.signal());
    const entry: SessionEntry = {
      request,
      harnessSessionId,
      executions: new Map(),
    };
    this.sessions.set(request.sessionId, entry);
    return this.createClient(entry);
  }

  async release(
    sessionId: string,
    request?: ManagedRuntimePrepareRequest,
    _options?: { terminal?: boolean },
  ): Promise<boolean> {
    if (this.released.has(sessionId)) return true;
    const entry = this.sessions.get(sessionId);
    const harnessSessionId = entry?.harnessSessionId ?? request?.sessionId;
    if (!harnessSessionId) return false;
    const released = await this.client.release(
      sessionId,
      harnessSessionId,
      this.signal(),
    );
    if (released) {
      this.released.add(sessionId);
      this.sessions.delete(sessionId);
    }
    return released;
  }

  async inspectExecution(identity: ExecutionIdentity): Promise<Inspection> {
    const status = await this.client.getExecution(
      identity.runtimeSessionId,
      identity.harnessSessionId,
      identity.executionCallId,
      identity.afterSeq,
      this.signal(),
    );
    return { outcome: 'known', status };
  }

  dispose(): void {
    this.lifetime.abort();
  }

  private signal(): AbortSignal {
    return AbortSignal.any([
      this.lifetime.signal,
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ]);
  }

  private createClient(entry: SessionEntry): ManagedToolV2Client {
    const control = async (operation: ManagedRuntimeProviderOperation) => {
      const session = {
        harnessSessionId: entry.harnessSessionId,
        runtimeSessionId: entry.request.sessionId,
        turnKind: entry.request.turnKind,
      };
      const parsed = parseManagedRuntimeProviderOperation(operation, session);
      return parseManagedRuntimeProviderResult(
        parsed,
        await this.client.control(
          entry.request.sessionId,
          entry.harnessSessionId,
          parsed,
          this.signal(),
        ),
        session,
      );
    };
    const executionCallId = (
      reference: ManagedToolInvocationReference,
    ): string => {
      const id = entry.executions.get(reference.invocationId);
      if (!id) {
        throw new Error('Managed Runtime execution was not prepared.');
      }
      return id;
    };
    return {
      fileHistory: {
        bind: (binding) => control({ kind: 'bind-history', binding }),
        checkpoint: (promptId) => control({ kind: 'checkpoint', promptId }),
        snapshot: () => control({ kind: 'history' }),
      },
      manifest: () => control({ kind: 'manifest' }),
      beginTurn: async (identity) => {
        await control({ kind: 'begin-turn', identity });
      },
      prepare: (identity, toolName, input, modification, mediaContext) =>
        control({
          kind: 'prepare',
          identity,
          toolName,
          input,
          ...(modification === undefined ? {} : { modification }),
          ...(mediaContext === undefined ? {} : { mediaContext }),
        }),
      confirmation: (reference) => control({ kind: 'confirmation', reference }),
      confirm: async (reference, outcome, payload, phase) => {
        await control({
          kind: 'confirm',
          reference,
          outcome,
          ...(payload === undefined ? {} : { payload }),
          ...(phase === undefined ? {} : { phase }),
        });
      },
      preflight: (reference) => control({ kind: 'preflight', reference }),
      prepareExecution: async (reference) => {
        const reservation = await this.client.prepareExecution(
          entry.request.sessionId,
          entry.harnessSessionId,
          reference,
          this.signal(),
        );
        entry.executions.set(
          reference.invocationId,
          reservation.executionCallId,
        );
        return {
          executionCallId: reservation.executionCallId,
          invocationBindingId: entry.request.sessionId,
        };
      },
      execute: async (reference) => {
        const callId = executionCallId(reference);
        let status = await this.client.startExecution(
          entry.request.sessionId,
          entry.harnessSessionId,
          callId,
          this.signal(),
        );
        while (status.state !== 'settled') {
          await delay(POLL_DELAY_MS, undefined, {
            signal: this.lifetime.signal,
          });
          status = await this.client.getExecution(
            entry.request.sessionId,
            entry.harnessSessionId,
            callId,
            undefined,
            this.signal(),
          );
        }
        return status.result as ManagedToolExecutionResult;
      },
      status: (reference, afterSeq) =>
        this.client.getExecution(
          entry.request.sessionId,
          entry.harnessSessionId,
          executionCallId(reference),
          afterSeq,
          this.signal(),
        ),
      cancel: (reference) =>
        // The broker client has no execution-cancel route, and the M4 driver
        // only cancels after settlement; return the same settled observation.
        this.client.getExecution(
          entry.request.sessionId,
          entry.harnessSessionId,
          executionCallId(reference),
          undefined,
          this.signal(),
        ),
    } as ManagedToolV2Client;
  }
}
