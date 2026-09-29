/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import {
  deserializeSnapshots,
  serializeSnapshot,
  type SerializedFileHistorySnapshot,
} from '@qwen-code/qwen-code-core/services/fileHistoryService.js';
import type { ManagedToolFileHistoryState } from '@qwen-code/qwen-code-core/tools/managed-tool-file-history.js';
import { captureManagedToolExecutionContext } from '@qwen-code/qwen-code-core/tools/managed-tool-file-history-protocol.js';
import {
  managedToolDigest,
  type ManagedToolInvocationReference,
} from '@qwen-code/qwen-code-core/tools/managed-tool-protocol.js';
import type { ManagedToolV2Client } from '@qwen-code/qwen-code-core/tools/managed-tool-runtime.js';
import type {
  ManagedToolExecutionIdentity,
  ManagedToolSession,
  ManagedToolSessionFactory,
} from '@qwen-code/qwen-code-core/tools/managed-tool-session.js';
import type { ShellConfiguration } from '@qwen-code/qwen-code-core/utils/shell-utils.js';
import type { ManagedRuntimeProvider } from './managed-runtime-provider.js';
import type { ManagedRuntimePrepareRequest } from './managed-runtime-protocol.js';
import type { WorkspaceGenerationGuard } from './workspace-registry.js';

export function createManagedToolSessionFactory(options: {
  provider: ManagedRuntimeProvider;
  tenantId: string;
  workspaceId: string;
  workspaceCwd: string;
  workspaceTrusted: boolean;
  generationGuard: WorkspaceGenerationGuard;
  shellConfiguration: ShellConfiguration;
  platform: NodeJS.Platform;
}): ManagedToolSessionFactory {
  const {
    provider,
    tenantId,
    workspaceId,
    workspaceCwd,
    workspaceTrusted,
    generationGuard,
    platform,
  } = options;
  const shellConfiguration = structuredClone(options.shellConfiguration);
  if (!provider.getToolV2Client) {
    throw new Error('Managed Agent requires a v2 tool Runtime provider.');
  }
  const acquire = provider.getToolV2Client.bind(provider);

  return (rootConfig) => {
    let revision = -1;
    let rootAcquired = false;
    let historyTail: Promise<void> = Promise.resolve();
    let persistenceTail: Promise<void> = Promise.resolve();
    const recordState = (state: ManagedToolFileHistoryState): Promise<void> => {
      const pending = persistenceTail.then(async () => {
        if (state.ownerSessionId !== rootConfig.getSessionId())
          throw new Error('Managed file history owner changed.');
        if (state.revision <= revision) return;
        const service = rootConfig.getFileHistoryService();
        const previous = new Map(
          service
            .getSnapshots()
            .map((snapshot) => [
              snapshot.promptId,
              JSON.stringify(serializeSnapshot(snapshot)),
            ]),
        );
        const snapshots = deserializeSnapshots(state.snapshots);
        const changed = snapshots.filter(
          (snapshot) =>
            previous.get(snapshot.promptId) !==
            JSON.stringify(serializeSnapshot(snapshot)),
        );
        if (changed.length)
          await rootConfig
            .getChatRecordingService()
            ?.recordFileHistorySnapshotBatchStrict(changed);
        service.restoreFromSnapshots(snapshots);
        revision = state.revision;
      });
      persistenceTail = pending.then(
        () => {},
        () => {},
      );
      return pending;
    };
    const enqueueHistory = (operation: () => Promise<void>) => {
      // A failed checkpoint must prevent later tools from crossing that boundary.
      historyTail = historyTail.then(operation);
      void historyTail.catch(() => {});
      return historyTail;
    };

    const create = (
      config: Config,
      isRoot: boolean,
    ): {
      session: ManagedToolSession;
      raw: () => Promise<ManagedToolV2Client>;
    } => {
      const executionCwd = config.getTargetDir();
      const executionContext = captureManagedToolExecutionContext(config);
      Object.freeze(executionContext.workspaceDirectories);
      Object.freeze(executionContext.fileFilteringOptions.customIgnoreFiles);
      Object.freeze(executionContext.fileFilteringOptions);
      Object.freeze(executionContext.grepOptions);
      Object.freeze(executionContext.outputLimits);
      Object.freeze(executionContext);
      const contextDigest = managedToolDigest(executionContext);
      const request: ManagedRuntimePrepareRequest = Object.freeze({
        protocolVersion: 1,
        tenantId,
        workspaceId,
        workspaceCwd,
        sessionId: randomUUID(),
        turnKind: 'bootstrap',
      });
      let acquisition: Promise<ManagedToolV2Client> | undefined;
      let client: ManagedToolV2Client | undefined;
      let wrapped: ManagedToolV2Client | undefined;
      let dispatched = false;
      let historyBound = false;
      let released = false;
      let closing = false;
      let cleanup: Promise<void> | undefined;
      const executions = new Map<
        ManagedToolInvocationReference,
        Promise<unknown>
      >();
      const assertOpen = () => {
        generationGuard.assertOpen();
        if (closing) throw new Error('Managed tool Session is closing.');
        if (
          !workspaceTrusted ||
          config.getTargetDir() !== executionCwd ||
          rootConfig.getTargetDir() !== workspaceCwd
        )
          throw new Error('Managed tool Session workspace binding changed.');
        if (
          managedToolDigest(captureManagedToolExecutionContext(config)) !==
          contextDigest
        )
          throw new Error('Managed tool Session execution context changed.');
      };
      const sync = async () => {
        if (historyBound && !released && client?.fileHistory)
          await recordState(await client.fileHistory.snapshot());
      };
      const raw = () => {
        assertOpen();
        acquisition ??= (async () => {
          if (
            (await realpath(workspaceCwd)) !== workspaceCwd ||
            (await realpath(executionCwd)) !== executionCwd
          )
            throw new Error('Managed tool Session workspace is not canonical.');
          if (!isRoot) await root.raw();
          assertOpen();
          dispatched = true;
          const acquired = await acquire(request, {
            harnessSessionId: rootConfig.getSessionId(),
          });
          assertOpen();
          if (!acquired.fileHistory)
            throw new Error(
              'Managed Agent requires Runtime file history control.',
            );
          client = acquired;
          const snapshots = isRoot
            ? (JSON.parse(
                JSON.stringify(
                  rootConfig
                    .getFileHistoryService()
                    .getSnapshots()
                    .map(serializeSnapshot),
                ),
              ) as SerializedFileHistorySnapshot[])
            : [];
          await recordState(
            await acquired.fileHistory.bind({
              ownerSessionId: rootConfig.getSessionId(),
              ownerRuntimeSessionId: root.session.sessionId,
              executionCwd,
              executionContext,
              snapshots,
            }),
          );
          historyBound = true;
          assertOpen();
          if (isRoot) rootAcquired = true;
          return acquired;
        })();
        return acquisition;
      };
      const session: ManagedToolSession = {
        sessionId: request.sessionId,
        shellConfiguration: structuredClone(shellConfiguration),
        platform,
        ...(isRoot && provider.inspectExecution
          ? {
              inspectExecution: (identity) =>
                provider.inspectExecution!({
                  harnessSessionId: rootConfig.getSessionId(),
                  ...identity,
                }),
            }
          : {}),
        ...(isRoot && provider.reconcileExecution
          ? {
              reconcileExecution: (identity: ManagedToolExecutionIdentity) =>
                provider.reconcileExecution!({
                  harnessSessionId: rootConfig.getSessionId(),
                  ...identity,
                }),
            }
          : {}),
        ...(isRoot && provider.cancelExecution
          ? {
              cancelExecution: (identity: ManagedToolExecutionIdentity) =>
                provider.cancelExecution!({
                  harnessSessionId: rootConfig.getSessionId(),
                  ...identity,
                }),
            }
          : {}),
        createChild: (childConfig) => {
          assertOpen();
          return create(childConfig, false).session;
        },
        getClient: () => {
          assertOpen();
          return (async () => {
            await historyTail;
            const acquired = await raw();
            await historyTail;
            assertOpen();
            const active = async <T>(
              operation: () => T | Promise<T>,
            ): Promise<T> => {
              assertOpen();
              return operation();
            };
            const execute = <T>(
              reference: ManagedToolInvocationReference,
              operation: () => Promise<T>,
            ): Promise<T> => {
              const pending = (async () => {
                await historyTail;
                assertOpen();
                try {
                  return await operation();
                } finally {
                  await sync();
                }
              })();
              executions.set(reference, pending);
              void pending.then(
                () => executions.delete(reference),
                () => {},
              );
              return pending;
            };
            wrapped ??= {
              ...acquired,
              manifest: () => active(() => acquired.manifest()),
              beginTurn: (identity) =>
                active(() => acquired.beginTurn(identity)),
              prepare: (...args) => active(() => acquired.prepare(...args)),
              confirmation: (reference) =>
                active(() => acquired.confirmation(reference)),
              confirm: (reference, outcome, payload, phase) =>
                active(() =>
                  acquired.confirm(reference, outcome, payload, phase),
                ),
              preflight: (reference) =>
                active(() => acquired.preflight(reference)),
              ...(acquired.prepareExecution
                ? {
                    prepareExecution: (reference) =>
                      active(() => acquired.prepareExecution!(reference)),
                  }
                : {}),
              ...(acquired.startExecution
                ? {
                    startExecution: (reference, executionCallId) =>
                      execute(reference, () =>
                        acquired.startExecution!(reference, executionCallId),
                      ),
                  }
                : {}),
              execute: (reference) =>
                execute(reference, () => acquired.execute(reference)),
              status: async (reference, afterSeq) => {
                const result = await acquired.status(reference, afterSeq);
                await sync();
                if (result.state === 'settled') executions.delete(reference);
                return result;
              },
              cancel: async (reference) => {
                const result = await acquired.cancel(reference);
                await sync();
                if (result.state === 'settled') executions.delete(reference);
                return result;
              },
            };
            return wrapped;
          })();
        },
        beginFileHistoryTurn: isRoot
          ? async (promptId) => {
              assertOpen();
              const empty =
                !rootAcquired &&
                !acquisition &&
                !rootConfig
                  .getFileHistoryService()
                  .getSnapshots()
                  .some(
                    (snapshot) =>
                      Object.keys(snapshot.trackedFileBackups).length,
                  );
              const pending = enqueueHistory(async () => {
                assertOpen();
                const service = rootConfig.getFileHistoryService();
                if (
                  !rootAcquired &&
                  !acquisition &&
                  !service
                    .getSnapshots()
                    .some(
                      (snapshot) =>
                        Object.keys(snapshot.trackedFileBackups).length,
                    )
                ) {
                  await service.makeSnapshot(promptId);
                  const latest = service.getSnapshots().at(-1);
                  if (latest)
                    await rootConfig
                      .getChatRecordingService()
                      ?.recordFileHistorySnapshotBatchStrict([latest]);
                  return;
                }
                const acquired = await raw();
                await recordState(
                  await acquired.fileHistory!.checkpoint(promptId),
                );
              });
              // Model inference may proceed; every following tool awaits historyTail.
              if (empty) await pending;
            }
          : async () => {},
        flushFileHistory: sync,
        close: () => {
          closing = true;
          cleanup ??= (async () => {
            try {
              await acquisition;
            } catch {
              // A failed acquire can still have allocated a remote Session.
            }
            if (isRoot) {
              try {
                await historyTail;
              } catch {
                // Synchronize the last durable state before releasing a failed turn.
              }
            }
            if (client) {
              const cancellations = await Promise.allSettled(
                [...executions.keys()].map(async (reference) => {
                  let status = await client!.cancel(reference);
                  while (status.state !== 'settled') {
                    await delay(50);
                    status = await client!.status(reference);
                  }
                }),
              );
              await Promise.allSettled([...executions.values()]);
              const failures = cancellations.filter(
                (result) => result.status === 'rejected',
              );
              if (failures.length)
                throw new AggregateError(
                  failures.map((result) => result.reason),
                  'Managed tool cancellation failed.',
                );
              await sync();
            }
            if (
              dispatched &&
              !(await provider.release(request.sessionId, request, {
                terminal: true,
              }))
            )
              throw new Error(
                'Managed tool Runtime Session release is unproven.',
              );
            released = true;
          })();
          const current = cleanup;
          void current.catch(() => {
            if (cleanup === current) cleanup = undefined;
          });
          return current;
        },
      };
      return { session, raw };
    };
    const root = create(rootConfig, true);
    return root.session;
  };
}
