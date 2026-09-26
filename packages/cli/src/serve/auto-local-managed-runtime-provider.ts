/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  RemoteManagedRuntimeProvider,
  ManagedRuntimeProviderError,
  type ManagedRuntimeProvider,
  type ManagedRuntimeHandle,
  type ManagedRuntimeReleaseOptions,
} from './managed-runtime-provider.js';
import type { ManagedToolV2Client } from '@qwen-code/acp-bridge/bridgeTypes';
import {
  ManagedRuntimeReleasedError,
  type ManagedRuntimeUse,
} from './managed-runtime-activator.js';
import {
  sameManagedRuntimeIdentity,
  type ManagedRuntimePrepareRequest,
} from './managed-runtime-protocol.js';
import type { LocalProcessRuntimeActivator } from './local-process-runtime-activator.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from './workspace-registry.js';

interface Binding {
  readonly request: ManagedRuntimePrepareRequest;
  readonly use: ManagedRuntimeUse;
  readonly handle: Promise<ManagedRuntimeHandle>;
  readonly runtime: WorkspaceRuntime;
  readonly operations: Map<string, (certain: boolean) => void>;
  client?: Promise<ManagedToolV2Client>;
  retiring?: boolean;
  release?: Promise<boolean>;
  terminal?: boolean;
  delegate?: RemoteManagedRuntimeProvider;
  unsubscribe?: () => void;
}
export class AutoLocalManagedRuntimeProvider implements ManagedRuntimeProvider {
  private readonly delegates = new Map<string, RemoteManagedRuntimeProvider>();
  private readonly bindings = new Map<string, Binding>();
  private readonly terminalSessions = new Map<
    string,
    { request: ManagedRuntimePrepareRequest; completed: boolean }
  >();
  private disposed = false;
  constructor(
    private readonly registry: WorkspaceRegistry,
    readonly activator: LocalProcessRuntimeActivator,
    private readonly onLost: (
      request: ManagedRuntimePrepareRequest,
      released: boolean,
    ) => void,
  ) {}

  prepare(request: ManagedRuntimePrepareRequest): ManagedRuntimeHandle {
    const notificationRequest = request;
    request = structuredClone(request);
    if (this.terminalSession(request.sessionId, request)) {
      throw new ManagedRuntimeProviderError(
        'managed_runtime_unavailable',
        'Managed Runtime Session is permanently closed.',
        false,
      );
    }
    const runtime = this.registry.getByWorkspaceId(request.workspaceId);
    if (
      this.disposed ||
      !runtime?.trusted ||
      runtime.workspaceCwd !== request.workspaceCwd ||
      runtime.generationGuard?.closed
    )
      throw new ManagedRuntimeProviderError(
        'managed_runtime_identity_conflict',
        'Managed Runtime workspace binding is unavailable.',
        false,
      );
    const previous = this.bindings.get(request.sessionId);
    if (previous && !sameManagedRuntimeIdentity(previous.request, request))
      throw new ManagedRuntimeProviderError(
        'managed_runtime_identity_conflict',
        'Managed Runtime Session identity changed.',
        false,
      );
    if (previous?.retiring || previous?.client) {
      throw new ManagedRuntimeProviderError(
        'managed_runtime_unavailable',
        'Managed Runtime Session already has an owned binding.',
        false,
      );
    }
    previous?.unsubscribe?.();
    const use = this.activator.activate({
      tenantId: request.tenantId,
      runtime,
    });
    const handle = use.endpoint.then((endpoint) => {
      use.signal.throwIfAborted();
      let delegate = this.delegates.get(endpoint.boot.leaseId);
      if (!delegate) {
        delegate = new RemoteManagedRuntimeProvider({
          baseUrl: endpoint.url,
          token: endpoint.boot.token,
          lease: endpoint.boot,
          prepareRetryWindowMs: Math.max(0, endpoint.deadline - Date.now()),
        });
        this.delegates.set(endpoint.boot.leaseId, delegate);
        const captured = delegate;
        use.signal.addEventListener(
          'abort',
          () => {
            captured.dispose();
            this.delegates.delete(endpoint.boot.leaseId);
          },
          { once: true },
        );
      }
      binding.delegate = delegate;
      return delegate.prepare(
        request,
        Math.max(0, endpoint.deadline - Date.now()),
      );
    });
    const binding: Binding = {
      request: structuredClone(request),
      use,
      handle,
      runtime,
      operations: new Map(),
    };
    this.bindings.set(request.sessionId, binding);
    const onAbort = () => {
      if (this.bindings.get(request.sessionId) !== binding) return;
      binding.retiring = true;
      void use.exited.then(
        () => {
          if (
            !binding.client &&
            !binding.release &&
            this.bindings.get(request.sessionId) === binding
          ) {
            this.bindings.delete(request.sessionId);
          }
        },
        () => {},
      );
      if (!this.disposed)
        this.onLost(
          notificationRequest,
          use.signal.reason instanceof ManagedRuntimeReleasedError,
        );
    };
    use.signal.addEventListener('abort', onAbort, { once: true });
    binding.unsubscribe = () =>
      use.signal.removeEventListener('abort', onAbort);
    const ready = handle
      .then((h) => h.ready)
      .then(() => {
        use.signal.throwIfAborted();
      });
    void ready.catch(() => {});
    const operation = (signal: AbortSignal) =>
      AbortSignal.any([signal, use.signal]);
    return {
      ready,
      finish: (reason) => use.release(reason),
      getManifest: async (signal) => {
        const combined = operation(signal);
        const h = await this.wait(handle, combined);
        combined.throwIfAborted();
        const manifest = await h.getManifest(combined);
        combined.throwIfAborted();
        return manifest;
      },
      execute: async (request, signal) => {
        const combined = operation(signal);
        const h = await this.wait(handle, combined);
        await this.wait(ready, combined);
        combined.throwIfAborted();
        const finish = use.beginOperation();
        try {
          const result = await h.execute(request, combined);
          combined.throwIfAborted();
          finish(true);
          return result;
        } catch (error) {
          finish(false);
          throw error;
        }
      },
    };
  }

  async getToolV2Client(
    request: ManagedRuntimePrepareRequest,
  ): Promise<ManagedToolV2Client> {
    let binding = this.bound(request.sessionId, request);
    if (!binding) {
      this.prepare(request);
      binding = this.bindings.get(request.sessionId)!;
    }
    const owned = binding;
    if (!owned.client) {
      this.assertBinding(owned, false);
      owned.client = (async () => {
        await owned.handle;
        const client = await owned.delegate!.getToolV2Client(owned.request);
        this.assertBinding(owned, false);
        const call = async <T>(
          operation: () => Promise<T>,
          allowDraining = false,
        ): Promise<T> => {
          this.assertBinding(owned, allowDraining);
          return operation();
        };
        const settled = (invocationId: string) => {
          owned.operations.get(invocationId)?.(true);
          owned.operations.delete(invocationId);
        };
        const history = client.fileHistory;
        return {
          fileHistory: history
            ? {
                bind: (binding) => call(() => history.bind(binding)),
                checkpoint: (promptId) =>
                  call(() => history.checkpoint(promptId)),
                snapshot: () => call(() => history.snapshot(), true),
              }
            : undefined,
          manifest: () => call(() => client.manifest()),
          beginTurn: (identity) => call(() => client.beginTurn(identity)),
          prepare: (...args) => call(() => client.prepare(...args)),
          confirmation: (reference) =>
            call(() => client.confirmation(reference)),
          confirm: (reference, outcome, payload, phase) =>
            call(() => client.confirm(reference, outcome, payload, phase)),
          preflight: (reference) => call(() => client.preflight(reference)),
          execute: (reference) =>
            call(async () => {
              const invocationId = reference.invocationId;
              let finish = owned.operations.get(invocationId);
              if (!finish) {
                finish = owned.use.beginOperation();
                owned.operations.set(invocationId, finish);
              }
              try {
                const result = await client.execute(reference);
                settled(invocationId);
                return result;
              } catch (error) {
                owned.retiring = true;
                finish(false);
                throw error;
              }
            }),
          status: (reference, afterSeq) =>
            call(async () => {
              const invocationId = reference.invocationId;
              const status = await client.status(reference, afterSeq);
              if (status.state === 'settled') settled(invocationId);
              return status;
            }, true),
          cancel: (reference) =>
            call(async () => {
              const invocationId = reference.invocationId;
              const status = await client.cancel(reference);
              if (status.state === 'settled') settled(invocationId);
              return status;
            }, true),
        } satisfies ManagedToolV2Client;
      })();
    }
    return owned.client;
  }

  private assertBinding(binding: Binding, allowDraining: boolean): void {
    const runtime = this.registry.getByWorkspaceId(binding.request.workspaceId);
    if (
      this.disposed ||
      this.bindings.get(binding.request.sessionId) !== binding ||
      runtime !== binding.runtime ||
      runtime.workspaceCwd !== binding.request.workspaceCwd ||
      (!allowDraining &&
        (!runtime.trusted ||
          runtime.generationGuard?.closed ||
          binding.retiring))
    ) {
      throw new ManagedRuntimeProviderError(
        'managed_runtime_unavailable',
        'Managed Runtime Session binding is unavailable.',
        false,
      );
    }
    binding.use.signal.throwIfAborted();
  }
  async cancel(
    sessionId: string,
    executionId: string,
    expected?: ManagedRuntimePrepareRequest,
  ): Promise<boolean> {
    const binding = this.bound(sessionId, expected);
    if (!binding?.delegate) return false;
    return binding.delegate.cancel(sessionId, executionId, expected);
  }
  async release(
    sessionId: string,
    expected?: ManagedRuntimePrepareRequest,
    options?: ManagedRuntimeReleaseOptions,
  ): Promise<boolean> {
    const binding = this.bound(sessionId, expected);
    let terminal = this.terminalSession(sessionId, expected);
    if (options?.terminal || binding?.client) {
      const request = binding?.request ?? expected;
      if (!terminal && request) {
        terminal = { request: structuredClone(request), completed: !binding };
        this.terminalSessions.set(sessionId, terminal);
      }
      if (binding) binding.terminal = true;
    }
    if (terminal?.completed) return true;
    if (!binding) return expected !== undefined;
    binding.retiring = true;
    if (binding.release) return binding.release;
    const release = (async () => {
      await binding.handle.catch(() => {});
      if (binding.use.signal.aborted || !binding.delegate) {
        await binding.use.exited;
      } else {
        try {
          let sentTerminal: boolean;
          do {
            sentTerminal = binding.terminal === true;
            if (
              !(await binding.delegate.release(sessionId, binding.request, {
                terminal: sentTerminal,
              }))
            ) {
              throw new Error(
                'Managed Runtime did not confirm Session release.',
              );
            }
          } while (binding.terminal && !sentTerminal);
        } catch (error) {
          if (!binding.use.signal.aborted) throw error;
          await binding.use.exited;
        }
      }
      for (const finish of binding.operations.values()) finish(true);
      binding.operations.clear();
      binding.use.release('cancelled');
      binding.unsubscribe?.();
      const completed = this.terminalSessions.get(sessionId);
      if (completed) completed.completed = true;
      if (this.bindings.get(sessionId) === binding)
        this.bindings.delete(sessionId);
      return true;
    })().finally(() => {
      binding.release = undefined;
    });
    binding.release = release;
    return release;
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    const closing = this.activator.close();
    for (const delegate of this.delegates.values()) delegate.dispose();
    await closing;
    this.bindings.clear();
    this.delegates.clear();
    this.terminalSessions.clear();
  }
  private terminalSession(
    sessionId: string,
    expected?: ManagedRuntimePrepareRequest,
  ) {
    const terminal = this.terminalSessions.get(sessionId);
    if (
      expected &&
      (expected.sessionId !== sessionId ||
        (terminal && !sameManagedRuntimeIdentity(terminal.request, expected)))
    ) {
      throw new ManagedRuntimeProviderError(
        'managed_runtime_identity_conflict',
        'Managed Runtime Session identity changed.',
        false,
      );
    }
    return terminal;
  }
  private bound(
    sessionId: string,
    expected?: ManagedRuntimePrepareRequest,
  ): Binding | undefined {
    const binding = this.bindings.get(sessionId);
    if (
      binding &&
      expected &&
      !sameManagedRuntimeIdentity(binding.request, expected)
    )
      throw new ManagedRuntimeProviderError(
        'managed_runtime_identity_conflict',
        'Managed Runtime Session identity changed.',
        false,
      );
    return binding;
  }
  private async wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    let abort: () => void = () => {};
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
        }),
      ]);
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
}
