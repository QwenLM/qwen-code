/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  BridgeManagedRuntimeToolExecuteRequest,
  BridgeManagedRuntimeToolExecuteResult,
  BridgeManagedRuntimeToolManifest,
  ManagedToolV2Client,
} from '@qwen-code/acp-bridge/bridgeTypes';
import type { ManagedToolInvocationStatus } from '@qwen-code/qwen-code-core/tools/managed-tool-runtime.js';
import {
  MANAGED_LEASE_ID_HEADER,
  MANAGED_LEASE_EPOCH_HEADER,
  type RuntimeFinishReason,
} from './managed-runtime-activator.js';
import type { AcpSessionBridge } from './acp-session-bridge.js';
import {
  isManagedMediaOperation,
  managedToolResponseMediaBytes,
  MAX_MANAGED_MEDIA_RESPONSE_BYTES,
} from '../acp-integration/managed-tool-media.js';
import { isLoopbackBind } from './loopback-binds.js';

interface ManagedGatewayToolRuntime {
  getManifest(signal: AbortSignal): Promise<BridgeManagedRuntimeToolManifest>;
  execute(
    request: BridgeManagedRuntimeToolExecuteRequest,
    signal: AbortSignal,
  ): Promise<BridgeManagedRuntimeToolExecuteResult>;
}
import {
  MANAGED_RUNTIME_PROTOCOL_VERSION,
  type ManagedRuntimeCancelResponse,
  type ManagedRuntimeExecuteResponse,
  type ManagedRuntimeManifestResponse,
  type ManagedRuntimePrepareRequest,
  type ManagedRuntimeReadyResponse,
  sameManagedRuntimeIdentity,
} from './managed-runtime-protocol.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from './workspace-registry.js';

const MAX_REMOTE_MANIFEST_BYTES = 1024 * 1024;
const MAX_REMOTE_TOOL_RESULT_BYTES = 8 * 1024 * 1024;
const MAX_REMOTE_CONTROL_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_PREPARE_RETRY_WINDOW_MS = 5 * 60_000;
const DEFAULT_PREPARE_RETRY_DELAY_MS = 100;
const DEFAULT_PREPARE_RETRY_MAX_DELAY_MS = 2_000;
const CONTROL_REQUEST_TIMEOUT_MS = 5_000;
const TOOL_REQUEST_TIMEOUT_MS = 10 * 60_000;

type BridgeSession = Awaited<ReturnType<AcpSessionBridge['spawnOrAttach']>>;

export interface ManagedRuntimeHandle extends ManagedGatewayToolRuntime {
  readonly ready: Promise<void>;
  finish(reason: RuntimeFinishReason): void;
}

export interface ManagedRuntimeReleaseOptions {
  terminal?: boolean;
}

export interface ManagedRuntimeToolClientContext {
  readonly harnessSessionId: string;
}

export interface ManagedRuntimeExecutionIdentity {
  readonly harnessSessionId: string;
  readonly runtimeSessionId: string;
  readonly executionCallId: string;
  readonly afterSeq?: number;
}

export type ManagedRuntimeExecutionInspection =
  | {
      readonly outcome: 'known';
      readonly status: ManagedToolInvocationStatus;
    }
  | { readonly outcome: 'unknown' };

export type ManagedRuntimeUnknownResolution =
  | 'confirmed_not_executed'
  | 'accepted_unknown';

export interface ManagedRuntimeProvider {
  getToolV2Client?(
    request: ManagedRuntimePrepareRequest,
    context?: ManagedRuntimeToolClientContext,
  ): Promise<ManagedToolV2Client>;
  inspectExecution?(
    identity: ManagedRuntimeExecutionIdentity,
  ): Promise<ManagedRuntimeExecutionInspection>;
  reconcileExecution?(
    identity: ManagedRuntimeExecutionIdentity,
  ): Promise<ManagedRuntimeExecutionInspection>;
  cancelExecution?(
    identity: ManagedRuntimeExecutionIdentity,
  ): Promise<ManagedRuntimeExecutionInspection>;
  resolveExecution?(
    identity: ManagedRuntimeExecutionIdentity,
    resolution: ManagedRuntimeUnknownResolution,
  ): Promise<ManagedRuntimeExecutionInspection>;
  prepare(request: ManagedRuntimePrepareRequest): ManagedRuntimeHandle;
  cancel(
    sessionId: string,
    executionId: string,
    expected?: ManagedRuntimePrepareRequest,
  ): Promise<boolean>;
  release(
    sessionId: string,
    expected?: ManagedRuntimePrepareRequest,
    options?: ManagedRuntimeReleaseOptions,
  ): Promise<boolean>;
  dispose(): void | Promise<void>;
}

export class ManagedRuntimeProviderError extends Error {
  constructor(
    readonly code:
      | 'managed_runtime_identity_conflict'
      | 'managed_runtime_unavailable'
      | 'managed_runtime_disposed'
      | 'managed_runtime_capacity_exhausted',
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ManagedRuntimeProviderError';
  }
}

interface LocalBinding {
  readonly request: ManagedRuntimePrepareRequest;
  readonly runtime: WorkspaceRuntime;
  readonly runtimeClientId: string;
  readonly controller: AbortController;
}

interface LocalWarmup {
  readonly request: ManagedRuntimePrepareRequest;
  readonly runtime: WorkspaceRuntime;
  readonly controller: AbortController;
  readonly promise: Promise<LocalBinding>;
}

interface LocalRelease {
  readonly request: ManagedRuntimePrepareRequest;
  warmup?: LocalWarmup;
  binding?: LocalBinding;
  pending?: Promise<boolean>;
  cleanup?: () => Promise<void>;
  terminal?: boolean;
  completed?: boolean;
}

class ManagedRuntimeSessionCleanupError extends Error {
  constructor(
    readonly cleanup: () => Promise<void>,
    cause: unknown,
  ) {
    super('Managed Runtime Session cleanup failed.', { cause });
  }
}

class ManagedRuntimeReleaseAbortError extends Error {
  constructor() {
    super('Managed Runtime Session released.');
    this.name = 'ManagedRuntimeReleaseAbortError';
  }
}

function abortError(signal: AbortSignal, fallback: string): unknown {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException(fallback, 'AbortError');
}

function waitForValue<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(abortError(signal, 'Managed Runtime wait aborted.'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(abortError(signal, 'Managed Runtime wait aborted.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void pending.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function cleanupLocalSession(
  bridge: AcpSessionBridge,
  session: BridgeSession,
): Promise<void> {
  if (session.attached && session.clientId) {
    await bridge.detachClient(session.sessionId, session.clientId);
    return;
  }
  await bridge.closeSession(
    session.sessionId,
    session.clientId ? { clientId: session.clientId } : undefined,
  );
}

function waitForLocalSession(
  bridge: AcpSessionBridge,
  pending: Promise<BridgeSession>,
  request: ManagedRuntimePrepareRequest,
  signal: AbortSignal,
  allowAttached: boolean,
): Promise<{ session: BridgeSession; runtimeClientId: string }> {
  if (signal.aborted) {
    return Promise.reject(abortError(signal, 'Runtime preparation aborted.'));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      if (signal.reason instanceof ManagedRuntimeReleaseAbortError) return;
      reject(abortError(signal, 'Runtime preparation aborted.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void pending
      .then(
        async (session) => {
          signal.removeEventListener('abort', onAbort);
          const matchesIdentity =
            session.sessionId === request.sessionId &&
            session.workspaceCwd === request.workspaceCwd &&
            session.sourceType === 'managed-gateway' &&
            session.sourceId === request.sessionId;
          if (
            signal.reason instanceof ManagedRuntimeReleaseAbortError &&
            matchesIdentity &&
            (allowAttached || !session.attached) &&
            session.clientId
          ) {
            resolve({ session, runtimeClientId: session.clientId });
            return;
          }
          const valid =
            !signal.aborted &&
            (allowAttached || !session.attached) &&
            matchesIdentity &&
            session.hasActivePrompt !== true &&
            Boolean(session.clientId);
          if (!valid) {
            const cleanup = () => cleanupLocalSession(bridge, session);
            try {
              await cleanup();
            } catch (error) {
              throw new ManagedRuntimeSessionCleanupError(cleanup, error);
            }
            reject(
              signal.aborted
                ? abortError(signal, 'Runtime preparation aborted.')
                : new ManagedRuntimeProviderError(
                    'managed_runtime_identity_conflict',
                    'Managed Runtime Session identity did not match its binding.',
                    false,
                  ),
            );
            return;
          }
          resolve({ session, runtimeClientId: session.clientId! });
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      )
      .catch(reject);
  });
}

function isSessionNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'session_not_found'
  );
}

export class LocalManagedRuntimeProvider implements ManagedRuntimeProvider {
  private readonly bindings = new Map<string, LocalBinding>();
  private readonly warmups = new Map<string, LocalWarmup>();
  private readonly releases = new Map<string, LocalRelease>();
  private readonly lifetime = new AbortController();

  constructor(private readonly workspaceRegistry: WorkspaceRegistry) {}

  prepare(request: ManagedRuntimePrepareRequest): ManagedRuntimeHandle {
    this.assertNotReleasing(request.sessionId);
    if (this.lifetime.signal.aborted) {
      throw new ManagedRuntimeProviderError(
        'managed_runtime_disposed',
        'Managed Runtime provider is disposed.',
        false,
      );
    }
    const runtime = this.workspaceRegistry.getByWorkspaceId(
      request.workspaceId,
    );
    if (!runtime || !runtime.trusted) {
      throw new ManagedRuntimeProviderError(
        'managed_runtime_unavailable',
        'Managed Runtime workspace is unavailable or untrusted.',
        true,
      );
    }
    if (runtime.workspaceCwd !== request.workspaceCwd) {
      throw new ManagedRuntimeProviderError(
        'managed_runtime_identity_conflict',
        'Managed Runtime workspace identity changed.',
        false,
      );
    }
    const readyBinding = this.startWarmup(runtime, request);
    return {
      ready: readyBinding.then(() => undefined),
      finish: () => {},
      getManifest: async (signal) => {
        const binding = await waitForValue(readyBinding, signal);
        const operationSignal = AbortSignal.any([
          signal,
          binding.controller.signal,
          this.lifetime.signal,
        ]);
        operationSignal.throwIfAborted();
        return waitForValue(
          binding.runtime.bridge.getManagedRuntimeToolManifest(
            request.sessionId,
            { clientId: binding.runtimeClientId },
          ),
          operationSignal,
        );
      },
      execute: async (toolRequest, signal) => {
        const binding = await waitForValue(readyBinding, signal);
        const operationSignal = AbortSignal.any([
          signal,
          binding.controller.signal,
          this.lifetime.signal,
        ]);
        operationSignal.throwIfAborted();
        return binding.runtime.bridge.executeManagedRuntimeTool(
          request.sessionId,
          toolRequest,
          operationSignal,
          { clientId: binding.runtimeClientId },
        );
      },
    };
  }

  async getToolV2Client(
    request: ManagedRuntimePrepareRequest,
  ): Promise<ManagedToolV2Client> {
    const releasing = this.releases.get(request.sessionId);
    if (!releasing) await this.prepare(request).ready;
    const binding =
      releasing?.binding ??
      this.bindings.get(request.sessionId) ??
      (await this.warmups.get(request.sessionId)?.promise);
    if (!binding || !sameManagedRuntimeIdentity(binding.request, request)) {
      throw new ManagedRuntimeProviderError(
        'managed_runtime_identity_conflict',
        'Managed Runtime Session binding changed.',
        false,
      );
    }
    const assertBinding = (allowDraining: boolean) => {
      this.lifetime.signal.throwIfAborted();
      const release = this.releases.get(request.sessionId);
      const retained = release?.binding === binding;
      const runtime = this.workspaceRegistry.getByWorkspaceId(
        request.workspaceId,
      );
      if (
        (this.bindings.get(request.sessionId) !== binding && !retained) ||
        runtime !== binding.runtime ||
        runtime.workspaceCwd !== request.workspaceCwd
      ) {
        throw new ManagedRuntimeProviderError(
          'managed_runtime_identity_conflict',
          'Managed Runtime Session binding changed.',
          false,
        );
      }
      if (!allowDraining) {
        this.assertNotReleasing(request.sessionId);
        if (!runtime.trusted)
          throw new ManagedRuntimeProviderError(
            'managed_runtime_unavailable',
            'Managed Runtime workspace is untrusted.',
            false,
          );
      }
      if (
        !(
          allowDraining &&
          retained &&
          binding.controller.signal.reason instanceof
            ManagedRuntimeReleaseAbortError
        )
      ) {
        binding.controller.signal.throwIfAborted();
      }
    };
    assertBinding(true);
    const client = binding.runtime.bridge.getManagedToolV2Client(
      request.sessionId,
      {
        clientId: binding.runtimeClientId,
      },
    );
    const call = async <T>(
      operation: () => Promise<T>,
      allowDraining = false,
    ): Promise<T> => {
      assertBinding(allowDraining);
      return operation();
    };
    const history = client.fileHistory;
    return {
      fileHistory: history
        ? {
            bind: (binding) => call(() => history.bind(binding)),
            checkpoint: (promptId) => call(() => history.checkpoint(promptId)),
            snapshot: () => call(() => history.snapshot(), true),
          }
        : undefined,
      manifest: () => call(() => client.manifest()),
      beginTurn: (identity) => call(() => client.beginTurn(identity)),
      prepare: (...args) => call(() => client.prepare(...args)),
      confirmation: (reference) => call(() => client.confirmation(reference)),
      confirm: (reference, outcome, payload, phase) =>
        call(() => client.confirm(reference, outcome, payload, phase)),
      preflight: (reference) => call(() => client.preflight(reference)),
      execute: (reference) => call(() => client.execute(reference)),
      status: (reference, afterSeq) =>
        call(() => client.status(reference, afterSeq), true),
      cancel: (reference) => call(() => client.cancel(reference), true),
    };
  }

  private assertNotReleasing(sessionId: string): void {
    if (this.releases.has(sessionId))
      throw new ManagedRuntimeProviderError(
        'managed_runtime_unavailable',
        'Managed Runtime Session is closing.',
        false,
      );
  }

  async cancel(
    sessionId: string,
    executionId: string,
    expected?: ManagedRuntimePrepareRequest,
  ): Promise<boolean> {
    const binding = this.bindings.get(sessionId);
    const warmup = this.warmups.get(sessionId);
    const current = binding?.request ?? warmup?.request;
    if (expected && current && !sameManagedRuntimeIdentity(current, expected)) {
      throw new ManagedRuntimeProviderError(
        'managed_runtime_identity_conflict',
        'Managed Runtime Session identity changed.',
        false,
      );
    }
    if (!binding) return false;
    const result = await binding.runtime.bridge.cancelManagedRuntimeTool(
      sessionId,
      executionId,
      { clientId: binding.runtimeClientId },
    );
    return result.cancelled;
  }

  async release(
    sessionId: string,
    expected?: ManagedRuntimePrepareRequest,
    options?: ManagedRuntimeReleaseOptions,
  ): Promise<boolean> {
    const warmup = this.warmups.get(sessionId);
    const binding = this.bindings.get(sessionId);
    let release = this.releases.get(sessionId);
    const current = release?.request ?? warmup?.request ?? binding?.request;
    if (
      expected &&
      (expected.sessionId !== sessionId ||
        (current && !sameManagedRuntimeIdentity(current, expected)))
    ) {
      throw new ManagedRuntimeProviderError(
        'managed_runtime_identity_conflict',
        'Managed Runtime Session identity changed.',
        false,
      );
    }
    this.lifetime.signal.throwIfAborted();
    if (!release) {
      const request = current ?? expected;
      if (!request) return false;
      release = { request: structuredClone(request), binding, warmup };
      this.releases.set(sessionId, release);
      warmup?.controller.abort(new ManagedRuntimeReleaseAbortError());
      binding?.controller.abort(new ManagedRuntimeReleaseAbortError());
    }
    release.terminal ||= options?.terminal === true;
    if (release.completed) return true;
    if (release.pending) return release.pending;
    const retained = release;
    const pending = this.finishRelease(sessionId, retained)
      .then((released) => {
        if (this.releases.get(sessionId) === retained) {
          if (this.bindings.get(sessionId) === retained.binding)
            this.bindings.delete(sessionId);
          if (this.warmups.get(sessionId) === retained.warmup)
            this.warmups.delete(sessionId);
          if (retained.terminal) {
            retained.completed = true;
            delete retained.binding;
            delete retained.warmup;
            delete retained.cleanup;
          } else this.releases.delete(sessionId);
        }
        return released;
      })
      .finally(() => {
        retained.pending = undefined;
      });
    retained.pending = pending;
    return pending;
  }

  private async finishRelease(
    sessionId: string,
    release: LocalRelease,
  ): Promise<boolean> {
    if (release.cleanup) {
      await release.cleanup();
      return true;
    }
    if (!release.binding && release.warmup) {
      try {
        release.binding = await release.warmup.promise;
      } catch (error) {
        if (error instanceof ManagedRuntimeReleaseAbortError) return true;
        if (error instanceof ManagedRuntimeSessionCleanupError)
          release.cleanup = error.cleanup;
        throw error;
      }
    }
    if (!release.binding) {
      this.lifetime.signal.throwIfAborted();
      const expected = release.request;
      const runtime = this.workspaceRegistry.getByWorkspaceId(
        expected.workspaceId,
      );
      if (!runtime || !runtime.trusted) {
        throw new ManagedRuntimeProviderError(
          'managed_runtime_unavailable',
          'Managed Runtime workspace is unavailable or untrusted.',
          true,
        );
      }
      if (runtime.workspaceCwd !== expected.workspaceCwd) {
        throw new ManagedRuntimeProviderError(
          'managed_runtime_identity_conflict',
          'Managed Runtime workspace identity changed.',
          false,
        );
      }
      try {
        const restored = await waitForLocalSession(
          runtime.bridge,
          runtime.bridge.resumeSession({
            sessionId,
            workspaceCwd: expected.workspaceCwd,
            sourceType: 'managed-gateway',
            sourceId: sessionId,
          }),
          expected,
          this.lifetime.signal,
          true,
        );
        const controller = new AbortController();
        controller.abort(new ManagedRuntimeReleaseAbortError());
        release.binding = {
          request: expected,
          runtime,
          runtimeClientId: restored.runtimeClientId,
          controller,
        };
      } catch (error) {
        if (error instanceof ManagedRuntimeSessionCleanupError)
          release.cleanup = error.cleanup;
        if (isSessionNotFound(error)) return true;
        throw error;
      }
    }
    await release.binding.runtime.bridge.closeSession(sessionId, {
      clientId: release.binding.runtimeClientId,
    });
    return true;
  }

  dispose(): void {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort(new Error('Managed Runtime provider disposed.'));
    for (const warmup of this.warmups.values()) {
      warmup.controller.abort(new Error('Managed Runtime provider disposed.'));
    }
    for (const binding of this.bindings.values()) {
      binding.controller.abort(new Error('Managed Runtime provider disposed.'));
    }
    this.warmups.clear();
    this.bindings.clear();
    this.releases.clear();
  }

  private startWarmup(
    runtime: WorkspaceRuntime,
    request: ManagedRuntimePrepareRequest,
  ): Promise<LocalBinding> {
    const existingWarmup = this.warmups.get(request.sessionId);
    if (existingWarmup) {
      if (
        existingWarmup.runtime !== runtime ||
        !sameManagedRuntimeIdentity(existingWarmup.request, request)
      ) {
        throw new ManagedRuntimeProviderError(
          'managed_runtime_identity_conflict',
          'Managed Runtime warmup changed Session identity.',
          false,
        );
      }
      return waitForValue(
        existingWarmup.promise,
        AbortSignal.any([
          this.lifetime.signal,
          existingWarmup.controller.signal,
        ]),
      );
    }

    const controller = new AbortController();
    const signal = AbortSignal.any([this.lifetime.signal, controller.signal]);
    const promise = this.prepareBinding(runtime, request, signal, controller);
    const warmup: LocalWarmup = { request, runtime, controller, promise };
    this.warmups.set(request.sessionId, warmup);
    void promise.then(
      (binding) => {
        if (signal.aborted || this.warmups.get(request.sessionId) !== warmup) {
          return;
        }
        this.warmups.delete(request.sessionId);
        this.bindings.set(request.sessionId, binding);
      },
      (error: unknown) => {
        if (
          this.warmups.get(request.sessionId) === warmup &&
          !(error instanceof ManagedRuntimeSessionCleanupError)
        ) {
          this.warmups.delete(request.sessionId);
        }
      },
    );
    return waitForValue(promise, signal);
  }

  private async prepareBinding(
    runtime: WorkspaceRuntime,
    request: ManagedRuntimePrepareRequest,
    signal: AbortSignal,
    controller: AbortController,
  ): Promise<LocalBinding> {
    const cached = this.bindings.get(request.sessionId);
    if (cached) {
      if (!sameManagedRuntimeIdentity(cached.request, request)) {
        this.forgetBinding(request.sessionId, cached);
        throw new ManagedRuntimeProviderError(
          'managed_runtime_identity_conflict',
          'Managed Runtime live Session identity changed.',
          false,
        );
      }
      if (cached.runtime !== runtime) {
        this.forgetBinding(request.sessionId, cached);
      } else {
        let summary:
          | ReturnType<AcpSessionBridge['getSessionSummary']>
          | undefined;
        try {
          summary = runtime.bridge.getSessionSummary(request.sessionId);
        } catch {
          this.forgetBinding(request.sessionId, cached);
        }
        if (
          summary &&
          (summary.workspaceCwd !== request.workspaceCwd ||
            summary.sourceType !== 'managed-gateway' ||
            summary.sourceId !== request.sessionId)
        ) {
          this.forgetBinding(request.sessionId, cached);
          throw new ManagedRuntimeProviderError(
            'managed_runtime_identity_conflict',
            'Managed Runtime live Session identity changed.',
            false,
          );
        }
        if (summary) {
          if (summary.hasActivePrompt) {
            this.forgetBinding(request.sessionId, cached);
            throw new ManagedRuntimeProviderError(
              'managed_runtime_identity_conflict',
              'Managed Runtime already has an active Prompt.',
              false,
            );
          }
          try {
            runtime.bridge.recordHeartbeat(request.sessionId, {
              clientId: cached.runtimeClientId,
            });
            return cached;
          } catch {
            this.forgetBinding(request.sessionId, cached);
          }
        }
      }
    }

    const waitForSession = (
      pending: Promise<BridgeSession>,
      allowAttached: boolean,
    ) =>
      waitForLocalSession(
        runtime.bridge,
        pending,
        request,
        signal,
        allowAttached,
      );
    let result: Awaited<ReturnType<typeof waitForSession>>;
    if (request.turnKind === 'continuation') {
      try {
        result = await waitForSession(
          runtime.bridge.resumeSession({
            sessionId: request.sessionId,
            workspaceCwd: request.workspaceCwd,
            sourceType: 'managed-gateway',
            sourceId: request.sessionId,
          }),
          true,
        );
      } catch (error) {
        if (!isSessionNotFound(error)) throw error;
        result = await waitForSession(
          runtime.bridge.spawnOrAttach({
            workspaceCwd: request.workspaceCwd,
            sessionScope: 'thread',
            sessionId: request.sessionId,
            sourceType: 'managed-gateway',
            sourceId: request.sessionId,
          }),
          false,
        );
      }
    } else {
      result = await waitForSession(
        runtime.bridge.spawnOrAttach({
          workspaceCwd: request.workspaceCwd,
          sessionScope: 'thread',
          sessionId: request.sessionId,
          sourceType: 'managed-gateway',
          sourceId: request.sessionId,
        }),
        false,
      );
    }
    return {
      request: structuredClone(request),
      runtime,
      runtimeClientId: result.runtimeClientId,
      controller,
    };
  }

  private forgetBinding(sessionId: string, binding: LocalBinding): void {
    if (this.bindings.get(sessionId) === binding) {
      this.bindings.delete(sessionId);
    }
    binding.controller.abort(new Error('Managed Runtime binding changed.'));
  }
}

interface RemoteProviderEntry {
  request: ManagedRuntimePrepareRequest;
  readonly controller: AbortController;
  readonly ready: Promise<void>;
  releasing?: boolean;
  release?: Promise<boolean>;
  v2?: ManagedToolV2Client;
  terminal?: boolean;
}

class RemoteResponseError extends Error {
  constructor(readonly status: number) {
    super(`Managed Runtime returned HTTP ${status}.`);
    this.name = 'RemoteResponseError';
  }
}

export interface RemoteManagedRuntimeProviderOptions {
  readonly baseUrl: string;
  readonly lease?: { readonly leaseId: string; readonly epoch: number };
  readonly token: string;
  readonly fetch?: typeof fetch;
  readonly prepareRetryWindowMs?: number;
  readonly prepareRetryDelayMs?: number;
  readonly prepareRetryMaxDelayMs?: number;
}

function resolveRemoteBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Managed Runtime URL is invalid.');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new Error('Managed Runtime URL must be an HTTP(S) origin.');
  }
  if (url.protocol === 'http:' && !isLoopbackBind(url.hostname)) {
    throw new Error(
      'Managed Runtime URL must use HTTPS outside the loopback interface.',
    );
  }
  url.pathname = '/';
  return url;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(abortError(signal, 'Managed Runtime retry aborted.'));
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref();
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(abortError(signal, 'Managed Runtime retry aborted.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function validRetryOption(
  value: number | undefined,
  fallback: number,
  minimum: number,
): number {
  return value !== undefined && Number.isFinite(value) && value >= minimum
    ? value
    : fallback;
}

async function readBoundedResponseText(
  response: Response,
  maxResponseBytes: number,
): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxResponseBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error('Managed Runtime response exceeded its size limit.');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8');
}

export class RemoteManagedRuntimeProvider implements ManagedRuntimeProvider {
  private readonly baseUrl: URL;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly retryWindowMs: number;
  private readonly retryDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly entries = new Map<string, RemoteProviderEntry>();
  private readonly closedSessions = new Map<
    string,
    ManagedRuntimePrepareRequest
  >();
  private readonly lifetime = new AbortController();
  private readonly lease?: { readonly leaseId: string; readonly epoch: number };

  constructor(options: RemoteManagedRuntimeProviderOptions) {
    this.lease = options.lease && { ...options.lease };
    this.baseUrl = resolveRemoteBaseUrl(options.baseUrl);
    this.token = options.token.trim();
    if (!this.token) throw new Error('Managed Runtime token is required.');
    this.fetchImpl = options.fetch ?? fetch;
    this.retryWindowMs = validRetryOption(
      options.prepareRetryWindowMs,
      DEFAULT_PREPARE_RETRY_WINDOW_MS,
      0,
    );
    this.retryDelayMs = validRetryOption(
      options.prepareRetryDelayMs,
      DEFAULT_PREPARE_RETRY_DELAY_MS,
      0,
    );
    this.retryMaxDelayMs = validRetryOption(
      options.prepareRetryMaxDelayMs,
      DEFAULT_PREPARE_RETRY_MAX_DELAY_MS,
      1,
    );
  }

  prepare(
    request: ManagedRuntimePrepareRequest,
    retryWindowMs = this.retryWindowMs,
  ): ManagedRuntimeHandle {
    request = structuredClone(request);
    if (this.lifetime.signal.aborted) {
      throw new ManagedRuntimeProviderError(
        'managed_runtime_disposed',
        'Managed Runtime provider is disposed.',
        false,
      );
    }
    const closed = this.closedSessions.get(request.sessionId);
    if (closed) {
      throw new ManagedRuntimeProviderError(
        sameManagedRuntimeIdentity(closed, request)
          ? 'managed_runtime_unavailable'
          : 'managed_runtime_identity_conflict',
        'Managed Runtime Session is permanently closed.',
        false,
      );
    }
    let entry = this.entries.get(request.sessionId);
    if (entry && !sameManagedRuntimeIdentity(entry.request, request)) {
      throw new ManagedRuntimeProviderError(
        'managed_runtime_identity_conflict',
        'Managed Runtime Session identity changed.',
        false,
      );
    }
    if (entry?.releasing) {
      throw new ManagedRuntimeProviderError(
        'managed_runtime_unavailable',
        'Managed Runtime Session is being released.',
        false,
      );
    }
    if (entry) {
      entry.request = structuredClone(request);
    }
    if (!entry) {
      const controller = new AbortController();
      // Release must await preparation before sending close. Aborting only its
      // HTTP response would leave a late-created Session without an owner.
      const signal = this.lifetime.signal;
      const ready = this.prepareRemote(request, signal, retryWindowMs);
      entry = { request: structuredClone(request), controller, ready };
      this.entries.set(request.sessionId, entry);
      void ready.catch(() => {
        if (
          this.entries.get(request.sessionId) === entry &&
          !entry?.v2 &&
          !entry?.releasing
        ) {
          this.entries.delete(request.sessionId);
        }
      });
    }
    const active = entry;
    return {
      ready: active.ready,
      finish: () => {},
      getManifest: async (signal) => {
        const operationSignal = AbortSignal.any([
          signal,
          active.controller.signal,
          this.lifetime.signal,
        ]);
        await waitForValue(active.ready, operationSignal);
        const response =
          await this.postIdempotentJson<ManagedRuntimeManifestResponse>(
            'manifest',
            active.request,
            operationSignal,
            MAX_REMOTE_MANIFEST_BYTES,
          );
        if (
          response.protocolVersion !== MANAGED_RUNTIME_PROTOCOL_VERSION ||
          !response.manifest
        ) {
          throw new Error(
            'Managed Runtime returned an invalid manifest response.',
          );
        }
        return response.manifest;
      },
      execute: async (toolRequest, signal) => {
        const operationSignal = AbortSignal.any([
          signal,
          active.controller.signal,
          this.lifetime.signal,
        ]);
        await waitForValue(active.ready, operationSignal);
        try {
          const response = await this.postJson<ManagedRuntimeExecuteResponse>(
            'execute',
            { ...active.request, toolRequest },
            operationSignal,
            MAX_REMOTE_TOOL_RESULT_BYTES,
          );
          if (
            response.protocolVersion !== MANAGED_RUNTIME_PROTOCOL_VERSION ||
            !response.result
          ) {
            throw new Error(
              'Managed Runtime returned an invalid Tool execution response.',
            );
          }
          return response.result;
        } catch (error) {
          if (signal.aborted) {
            void this.cancel(request.sessionId, toolRequest.executionId).catch(
              () => undefined,
            );
          }
          throw error;
        }
      },
    };
  }

  async getToolV2Client(
    request: ManagedRuntimePrepareRequest,
  ): Promise<ManagedToolV2Client> {
    if (!this.lease) {
      throw new ManagedRuntimeProviderError(
        'managed_runtime_unavailable',
        'Managed Tool v2 requires an owned Runtime lease.',
        false,
      );
    }
    const current = this.entries.get(request.sessionId);
    if (!current?.releasing) this.prepare(request);
    const entry = this.entries.get(request.sessionId);
    if (!entry || !sameManagedRuntimeIdentity(entry.request, request)) {
      throw new ManagedRuntimeProviderError(
        'managed_runtime_identity_conflict',
        'Managed Runtime Session binding changed.',
        false,
      );
    }
    entry.v2 ??= this.createToolV2Client(entry);
    await entry.ready;
    this.lifetime.signal.throwIfAborted();
    return entry.v2;
  }

  private createToolV2Client(entry: RemoteProviderEntry): ManagedToolV2Client {
    const call = async <T>(
      operation: string,
      params: Record<string, unknown> = {},
      allowDraining = false,
    ): Promise<T> => {
      // Leaf modules, not the core barrel: a dynamic import of the barrel
      // keeps every core export, and with it the encoding tables and other
      // runtime the serve fast path must not load
      // (scripts/check-serve-fast-path-bundle.js).
      const [{ managedToolDigest }, { MANAGED_TOOL_FILE_HISTORY_MAX_BYTES }] =
        await Promise.all([
          import('@qwen-code/qwen-code-core/tools/managed-tool-protocol.js'),
          import(
            '@qwen-code/qwen-code-core/tools/managed-tool-file-history-protocol.js'
          ),
        ]);
      this.lifetime.signal.throwIfAborted();
      if (this.entries.get(entry.request.sessionId) !== entry) {
        throw new ManagedRuntimeProviderError(
          'managed_runtime_identity_conflict',
          'Managed Runtime Session binding changed.',
          false,
        );
      }
      if (!allowDraining) entry.controller.signal.throwIfAborted();
      const identity = params['identity'] ?? params['reference'];
      if (
        identity !== undefined &&
        (identity as { sessionId?: unknown }).sessionId !==
          entry.request.sessionId
      ) {
        throw new ManagedRuntimeProviderError(
          'managed_runtime_identity_conflict',
          'Managed Runtime invocation belongs to another Session.',
          false,
        );
      }
      const body = { ...entry.request, protocolVersion: 2, ...params };
      managedToolDigest(
        body,
        operation === 'bind-history'
          ? MANAGED_TOOL_FILE_HISTORY_MAX_BYTES
          : 1024 * 1024,
      );
      const response = await this.postJson<{
        protocolVersion?: unknown;
        result?: T;
      }>(
        operation,
        body,
        AbortSignal.any([
          this.lifetime.signal,
          // Release closes admission, but an admitted execute must retain its
          // physical result until the worker has drained the operation.
          ...(allowDraining || operation === 'execute'
            ? []
            : [entry.controller.signal]),
          AbortSignal.timeout(TOOL_REQUEST_TIMEOUT_MS),
        ]),
        operation === 'manifest'
          ? MAX_REMOTE_MANIFEST_BYTES
          : isManagedMediaOperation(operation)
            ? MAX_MANAGED_MEDIA_RESPONSE_BYTES
            : MAX_REMOTE_TOOL_RESULT_BYTES,
        2,
      );
      const empty = operation === 'begin-turn' || operation === 'confirm';
      if (
        response.protocolVersion !== 2 ||
        (empty
          ? response.result !== null
          : !response.result ||
            typeof response.result !== 'object' ||
            Array.isArray(response.result))
      ) {
        throw new Error('Managed Runtime returned an invalid v2 response.');
      }
      const validResult = (value: unknown) =>
        value !== null &&
        typeof value === 'object' &&
        ['not_started', 'success', 'error', 'cancelled'].includes(
          (value as { executionStatus?: string }).executionStatus ?? '',
        );
      if (operation === 'execute' && !validResult(response.result)) {
        throw new Error('Managed Runtime did not confirm physical execution.');
      }
      if (operation === 'status' || operation === 'cancel') {
        const status = response.result as { state?: string; result?: unknown };
        if (
          !['prepared', 'executing', 'cancel_requested', 'settled'].includes(
            status.state ?? '',
          ) ||
          (status.state === 'settled' && !validResult(status.result))
        ) {
          throw new Error(
            'Managed Runtime returned an invalid invocation status.',
          );
        }
      }
      return response.result as T;
    };
    return {
      fileHistory: {
        bind: async (binding) => {
          const [
            {
              parseManagedToolFileHistoryBinding,
              parseManagedToolFileHistoryState,
            },
            { ManagedToolProtocolError },
          ] = await Promise.all([
            import(
              '@qwen-code/qwen-code-core/tools/managed-tool-file-history-protocol.js'
            ),
            import('@qwen-code/qwen-code-core/tools/managed-tool-protocol.js'),
          ]);
          const parsed = parseManagedToolFileHistoryBinding(binding);
          const state = parseManagedToolFileHistoryState(
            await call('bind-history', { binding: parsed }),
          );
          if (state.ownerSessionId !== parsed.ownerSessionId)
            throw new ManagedToolProtocolError(
              'Managed file history owner changed.',
            );
          return state;
        },
        checkpoint: async (promptId) => {
          const {
            parseManagedToolFileHistoryPromptId,
            parseManagedToolFileHistoryState,
          } = await import(
            '@qwen-code/qwen-code-core/tools/managed-tool-file-history-protocol.js'
          );
          return parseManagedToolFileHistoryState(
            await call('checkpoint', {
              promptId: parseManagedToolFileHistoryPromptId(promptId),
            }),
          );
        },
        snapshot: async () => {
          const { parseManagedToolFileHistoryState } = await import(
            '@qwen-code/qwen-code-core/tools/managed-tool-file-history-protocol.js'
          );
          return parseManagedToolFileHistoryState(
            await call('history', {}, true),
          );
        },
      },
      manifest: () => call('manifest'),
      beginTurn: async (identity) => {
        await call('begin-turn', { identity });
      },
      prepare: (identity, toolName, input, modification, mediaContext) =>
        call('prepare', {
          identity,
          toolName,
          input,
          ...(modification === undefined ? {} : { modification }),
          ...(mediaContext === undefined ? {} : { mediaContext }),
        }),
      confirmation: (reference) => call('confirmation', { reference }),
      confirm: async (reference, outcome, payload, phase) => {
        await call('confirm', {
          reference,
          outcome,
          ...(payload === undefined ? {} : { payload }),
          ...(phase === undefined ? {} : { phase }),
        });
      },
      preflight: (reference) => call('preflight', { reference }),
      execute: (reference) => call('execute', { reference }),
      status: (reference, afterSeq) =>
        call(
          'status',
          {
            reference,
            ...(afterSeq === undefined ? {} : { afterSeq }),
          },
          true,
        ),
      cancel: (reference) => call('cancel', { reference }, true),
    };
  }

  async cancel(
    sessionId: string,
    executionId: string,
    expected?: ManagedRuntimePrepareRequest,
  ): Promise<boolean> {
    const entry = this.entries.get(sessionId);
    if (!entry || this.lifetime.signal.aborted) return false;
    if (expected && !sameManagedRuntimeIdentity(entry.request, expected)) {
      throw new ManagedRuntimeProviderError(
        'managed_runtime_identity_conflict',
        'Managed Runtime Session identity changed.',
        false,
      );
    }
    const response = await this.postJson<ManagedRuntimeCancelResponse>(
      'cancel',
      { ...entry.request, executionId },
      AbortSignal.timeout(CONTROL_REQUEST_TIMEOUT_MS),
      MAX_REMOTE_CONTROL_RESPONSE_BYTES,
    );
    if (response.protocolVersion !== MANAGED_RUNTIME_PROTOCOL_VERSION) {
      throw new Error('Managed Runtime returned an invalid cancel response.');
    }
    return response.cancelled === true;
  }

  async release(
    sessionId: string,
    expected?: ManagedRuntimePrepareRequest,
    options?: ManagedRuntimeReleaseOptions,
  ): Promise<boolean> {
    let entry = this.entries.get(sessionId);
    const closed = this.closedSessions.get(sessionId);
    const terminal = options?.terminal === true || entry?.v2 !== undefined;
    if (terminal && !this.lease) {
      throw new Error(
        'Terminal Session release requires an owned Runtime lease.',
      );
    }
    if (
      expected &&
      (expected.sessionId !== sessionId ||
        (closed && !sameManagedRuntimeIdentity(closed, expected)))
    ) {
      throw new ManagedRuntimeProviderError(
        'managed_runtime_identity_conflict',
        'Managed Runtime Session identity changed.',
        false,
      );
    }
    this.lifetime.signal.throwIfAborted();
    if (closed) return true;
    if (!entry) {
      if (!expected) return false;
      entry = {
        request: structuredClone(expected),
        controller: new AbortController(),
        ready: Promise.resolve(),
      };
      this.entries.set(sessionId, entry);
    }
    if (expected && !sameManagedRuntimeIdentity(entry.request, expected)) {
      throw new ManagedRuntimeProviderError(
        'managed_runtime_identity_conflict',
        'Managed Runtime Session identity changed.',
        false,
      );
    }
    entry.terminal ||= terminal;
    entry.releasing = true;
    entry.controller.abort(new Error('Managed Runtime Session released.'));
    if (entry.release) return entry.release;
    const retained = entry;
    const release = (async () => {
      await retained.ready.catch(() => {});
      this.lifetime.signal.throwIfAborted();
      let sentTerminal: boolean;
      do {
        sentTerminal = retained.terminal === true;
        const protocolVersion = sentTerminal ? 2 : 1;
        const response = await this.postIdempotentJson<{
          protocolVersion: unknown;
          released: unknown;
        }>(
          'release',
          { ...retained.request, protocolVersion },
          AbortSignal.any([
            this.lifetime.signal,
            AbortSignal.timeout(CONTROL_REQUEST_TIMEOUT_MS),
          ]),
          MAX_REMOTE_CONTROL_RESPONSE_BYTES,
          protocolVersion,
        );
        if (
          response.protocolVersion !== protocolVersion ||
          response.released !== true
        ) {
          throw new Error('Managed Runtime did not confirm Session release.');
        }
      } while (retained.terminal && !sentTerminal);
      if (sentTerminal) {
        this.closedSessions.set(sessionId, retained.request);
      }
      if (this.entries.get(sessionId) === retained)
        this.entries.delete(sessionId);
      return true;
    })().finally(() => {
      retained.release = undefined;
    });
    retained.release = release;
    return release;
  }

  dispose(): void {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort(new Error('Managed Runtime provider disposed.'));
    for (const entry of this.entries.values()) {
      entry.controller.abort(new Error('Managed Runtime provider disposed.'));
    }
    this.entries.clear();
    this.closedSessions.clear();
  }

  private async prepareRemote(
    request: ManagedRuntimePrepareRequest,
    signal: AbortSignal,
    retryWindowMs: number,
  ): Promise<void> {
    const startedAt = Date.now();
    let retryDelayMs = this.retryDelayMs;
    const deadline = new AbortController();
    const deadlineTimer = setTimeout(
      () =>
        deadline.abort(
          new ManagedRuntimeProviderError(
            'managed_runtime_unavailable',
            'Managed Runtime preparation timed out.',
            true,
          ),
        ),
      retryWindowMs,
    );
    deadlineTimer.unref();
    const prepareSignal = AbortSignal.any([signal, deadline.signal]);
    try {
      while (true) {
        prepareSignal.throwIfAborted();
        try {
          const response = await this.postJson<ManagedRuntimeReadyResponse>(
            'prepare',
            request,
            prepareSignal,
            MAX_REMOTE_CONTROL_RESPONSE_BYTES,
          );
          if (
            response.protocolVersion !== MANAGED_RUNTIME_PROTOCOL_VERSION ||
            response.ready !== true
          ) {
            throw new Error(
              'Managed Runtime returned an invalid ready response.',
            );
          }
          return;
        } catch (error) {
          if (prepareSignal.aborted) {
            throw abortError(prepareSignal, 'Runtime preparation aborted.');
          }
          const retryable =
            error instanceof TypeError ||
            (error instanceof RemoteResponseError &&
              (error.status === 429 || error.status === 503));
          if (!retryable || Date.now() - startedAt >= retryWindowMs) {
            throw error;
          }
          await delay(retryDelayMs, prepareSignal);
          retryDelayMs = Math.min(
            Math.max(retryDelayMs * 2, 1),
            this.retryMaxDelayMs,
          );
        }
      }
    } finally {
      clearTimeout(deadlineTimer);
    }
  }

  private async postJson<T>(
    operation: string,
    body: unknown,
    signal: AbortSignal,
    maxResponseBytes: number,
    protocolVersion: 1 | 2 = 1,
  ): Promise<T> {
    const response = await this.fetchImpl(
      new URL(
        `internal/managed-runtime/v${protocolVersion}/${operation}`,
        this.baseUrl,
      ),
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
          ...(this.lease
            ? {
                [MANAGED_LEASE_ID_HEADER]: this.lease.leaseId,
                [MANAGED_LEASE_EPOCH_HEADER]: String(this.lease.epoch),
              }
            : {}),
        },
        body: JSON.stringify(body),
        signal,
      },
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new RemoteResponseError(response.status);
    }
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('Managed Runtime response exceeded its size limit.');
    }
    const text = await readBoundedResponseText(response, maxResponseBytes);
    let parsed: T;
    try {
      parsed = JSON.parse(text) as T;
    } catch {
      throw new Error('Managed Runtime returned invalid JSON.');
    }
    if (protocolVersion === 2 && isManagedMediaOperation(operation)) {
      const mediaBytes = managedToolResponseMediaBytes(
        (parsed as { result?: unknown } | null)?.result,
        operation,
      );
      if (Buffer.byteLength(text) - mediaBytes > MAX_REMOTE_TOOL_RESULT_BYTES) {
        throw new Error(
          'Managed Runtime control response exceeded its size limit.',
        );
      }
    }
    return parsed;
  }

  private async postIdempotentJson<T>(
    operation: string,
    body: unknown,
    signal: AbortSignal,
    maxResponseBytes: number,
    protocolVersion: 1 | 2 = 1,
  ): Promise<T> {
    try {
      return await this.postJson<T>(
        operation,
        body,
        signal,
        maxResponseBytes,
        protocolVersion,
      );
    } catch (error) {
      const retryable =
        !signal.aborted &&
        (error instanceof TypeError ||
          (error instanceof RemoteResponseError && error.status === 503));
      if (!retryable) throw error;
      return this.postJson<T>(
        operation,
        body,
        signal,
        maxResponseBytes,
        protocolVersion,
      );
    }
  }
}

export type {
  BridgeManagedRuntimeToolExecuteRequest,
  BridgeManagedRuntimeToolExecuteResult,
  BridgeManagedRuntimeToolManifest,
};
