/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type DaemonTrustPolicySnapshot,
  type DaemonWorkspaceTrustDecision,
  evaluateDaemonWorkspaceTrust,
} from '../config/daemon-trust-policy.js';
import {
  createWorkspaceGenerationGuard,
  type WorkspaceEntry,
  type WorkspaceGenerationGuard,
  type WorkspaceRegistry,
  type WorkspaceRuntime,
} from './workspace-registry.js';

export type WorkspaceTrustReplacementReason = 'trust_reconfigured';

export interface WorkspaceTrustReconcilerOptions {
  readonly registry: WorkspaceRegistry;
  readonly readLatestSnapshot: () => Promise<DaemonTrustPolicySnapshot>;
  readonly buildRuntime: (input: {
    entry: WorkspaceEntry;
    trusted: boolean;
    snapshot: DaemonTrustPolicySnapshot;
    decision: DaemonWorkspaceTrustDecision;
    generationGuard: WorkspaceGenerationGuard;
  }) => Promise<WorkspaceRuntime>;
  readonly drainRuntime: (
    runtime: WorkspaceRuntime,
    reason: WorkspaceTrustReplacementReason,
  ) => Promise<void>;
  readonly disposeRuntime: (
    runtime: WorkspaceRuntime,
    reason: WorkspaceTrustReplacementReason,
  ) => Promise<void>;
  readonly runtimeActivated?: (
    runtime: WorkspaceRuntime,
    previous: WorkspaceRuntime | undefined,
  ) => void | Promise<void>;
  readonly materializationKey?: (input: {
    entry: WorkspaceEntry;
    snapshot: DaemonTrustPolicySnapshot;
    decision: DaemonWorkspaceTrustDecision;
  }) => string;
  readonly isTrustDecrease?: (input: {
    entry: WorkspaceEntry;
    runtime: WorkspaceRuntime;
    nextMaterialization: string;
    decision: DaemonWorkspaceTrustDecision;
  }) => boolean;
  readonly onError?: (entry: WorkspaceEntry, error: unknown) => void;
}

export interface WorkspaceTrustReconciler {
  reconcile(snapshot: DaemonTrustPolicySnapshot): Promise<void>;
}

interface PlannedReplacement {
  readonly entry: WorkspaceEntry;
  readonly previous: WorkspaceRuntime | undefined;
  readonly decision: DaemonWorkspaceTrustDecision;
  readonly materialization: string;
  readonly decrease: boolean;
  drainResult?: Promise<unknown | undefined>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createWorkspaceTrustReconciler(
  options: WorkspaceTrustReconcilerOptions,
): WorkspaceTrustReconciler {
  let pendingSnapshot: DaemonTrustPolicySnapshot | undefined;
  let running: Promise<void> | undefined;

  const materializationKey = (
    entry: WorkspaceEntry,
    snapshot: DaemonTrustPolicySnapshot,
    decision: DaemonWorkspaceTrustDecision,
  ): string =>
    options.materializationKey?.({ entry, snapshot, decision }) ??
    String(decision.targetTrusted);

  const drainRuntime = async (
    runtime: WorkspaceRuntime,
  ): Promise<unknown | undefined> => {
    try {
      await options.drainRuntime(runtime, 'trust_reconfigured');
      return undefined;
    } catch (error) {
      return error;
    }
  };

  const replace = async (
    planned: PlannedReplacement,
    snapshot: DaemonTrustPolicySnapshot,
  ): Promise<void> => {
    const { entry, previous } = planned;
    if (planned.decrease) {
      if (
        entry.state !== 'transitioning' ||
        entry.current?.runtime !== previous
      ) {
        return;
      }
    } else {
      if (!options.registry.beginReplacement(entry, snapshot.revision)) return;
    }

    let contained = previous === undefined;
    try {
      if (previous) {
        const drainError = await (planned.drainResult ??
          drainRuntime(previous));
        await options.disposeRuntime(previous, 'trust_reconfigured');
        contained = true;
        if (drainError) options.onError?.(entry, drainError);
      }

      let desiredSnapshot = snapshot;
      let desiredDecision = planned.decision;
      for (;;) {
        const generationGuard = createWorkspaceGenerationGuard();
        let candidate: WorkspaceRuntime;
        let candidateActivated = false;
        try {
          candidate = await options.buildRuntime({
            entry,
            trusted: desiredDecision.targetTrusted,
            snapshot: desiredSnapshot,
            decision: desiredDecision,
            generationGuard,
          });
        } catch (error) {
          generationGuard.close();
          if (!desiredDecision.targetTrusted) throw error;

          const fallbackGuard = createWorkspaceGenerationGuard();
          let fallback: WorkspaceRuntime | undefined;
          let fallbackActivated = false;
          try {
            fallback = await options.buildRuntime({
              entry,
              trusted: false,
              snapshot: desiredSnapshot,
              decision: { ...desiredDecision, targetTrusted: false },
              generationGuard: fallbackGuard,
            });
            const latest = await options.readLatestSnapshot();
            if (latest.revision !== desiredSnapshot.revision) {
              pendingSnapshot = latest;
              desiredSnapshot = latest;
              desiredDecision = evaluateDaemonWorkspaceTrust(
                latest,
                entry.workspaceCwd,
              );
              entry.configuredRevision = latest.revision;
              continue;
            }
            options.registry.activateReplacement(
              entry,
              fallback,
              desiredSnapshot.revision,
            );
            fallbackActivated = true;
            entry.appliedRevision = null;
            entry.applyError = errorMessage(error);
            try {
              await options.runtimeActivated?.(fallback, previous);
            } catch (activationError) {
              options.onError?.(entry, activationError);
            }
            options.onError?.(entry, error);
            return;
          } catch (fallbackError) {
            throw new AggregateError(
              [error, fallbackError],
              'Trusted runtime and untrusted fallback both failed to build.',
            );
          } finally {
            if (!fallbackActivated) {
              fallbackGuard.close();
              if (fallback) {
                await options.disposeRuntime(fallback, 'trust_reconfigured');
              }
            }
          }
        }

        try {
          const latest = await options.readLatestSnapshot();
          if (latest.revision !== desiredSnapshot.revision) {
            pendingSnapshot = latest;
            desiredSnapshot = latest;
            desiredDecision = evaluateDaemonWorkspaceTrust(
              latest,
              entry.workspaceCwd,
            );
            entry.configuredRevision = latest.revision;
            continue;
          }

          options.registry.activateReplacement(
            entry,
            candidate,
            desiredSnapshot.revision,
          );
          candidateActivated = true;
          try {
            await options.runtimeActivated?.(candidate, previous);
          } catch (activationError) {
            options.onError?.(entry, activationError);
          }
          return;
        } finally {
          if (!candidateActivated) {
            generationGuard.close();
            await options.disposeRuntime(candidate, 'trust_reconfigured');
          }
        }
      }
    } catch (error) {
      if (contained) {
        entry.current = undefined;
        options.registry.blockReplacement(entry, errorMessage(error));
      } else {
        options.registry.blockReplacement(
          entry,
          `Runtime containment failed: ${errorMessage(error)}`,
        );
      }
      options.onError?.(entry, error);
    }
  };

  const applySnapshot = async (
    snapshot: DaemonTrustPolicySnapshot,
  ): Promise<void> => {
    const planned: PlannedReplacement[] = [];
    for (const entry of options.registry.listEntries()) {
      const current = entry.current;
      if (
        entry.state === 'active' &&
        current?.runtime.provenance === 'managed-scratch'
      ) {
        options.registry.advancePolicyRevision(entry, snapshot.revision);
        continue;
      }
      if (entry.state === 'blocked') {
        const decision = evaluateDaemonWorkspaceTrust(
          snapshot,
          entry.workspaceCwd,
        );
        planned.push({
          entry,
          previous: current?.runtime,
          decision,
          materialization: materializationKey(entry, snapshot, decision),
          decrease: false,
        });
        continue;
      }
      if (!current || entry.state !== 'active') {
        entry.configuredRevision = snapshot.revision;
        continue;
      }
      const decision = evaluateDaemonWorkspaceTrust(
        snapshot,
        entry.workspaceCwd,
      );
      const materialization = materializationKey(entry, snapshot, decision);
      if (
        current.runtime.trusted === decision.targetTrusted &&
        current.runtime.trustMaterialization === materialization
      ) {
        options.registry.advancePolicyRevision(entry, snapshot.revision);
        continue;
      }
      const decrease =
        options.isTrustDecrease?.({
          entry,
          runtime: current.runtime,
          nextMaterialization: materialization,
          decision,
        }) ??
        (current.runtime.trusted && !decision.targetTrusted);
      planned.push({
        entry,
        previous: current.runtime,
        decision,
        materialization,
        decrease,
      });
    }

    for (const item of planned) {
      if (item.decrease) {
        options.registry.beginReplacement(item.entry, snapshot.revision);
      }
    }
    for (const item of planned) {
      if (item.decrease && item.previous) {
        item.drainResult = drainRuntime(item.previous);
      }
    }
    for (const item of planned) {
      await replace(item, snapshot);
    }
  };

  const drain = async (): Promise<void> => {
    while (pendingSnapshot) {
      const snapshot = pendingSnapshot;
      pendingSnapshot = undefined;
      await applySnapshot(snapshot);
    }
  };

  const ensureRunning = (): Promise<void> => {
    if (!running) {
      running = drain().finally(() => {
        running = undefined;
        if (pendingSnapshot) return ensureRunning();
        return undefined;
      });
    }
    return running;
  };

  return {
    reconcile(snapshot) {
      pendingSnapshot = snapshot;
      return ensureRunning();
    },
  };
}
