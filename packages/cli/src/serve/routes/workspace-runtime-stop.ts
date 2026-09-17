/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, RequestHandler, Response } from 'express';
import type {
  BridgeRuntimeStopRequest,
  BridgeRuntimeStopResult,
} from '@qwen-code/acp-bridge/bridgeTypes';
import { WorkspaceRuntimeStopError } from '@qwen-code/acp-bridge/bridgeErrors';
import {
  readCronTasks,
  taskHasLegacyCondition,
} from '@qwen-code/qwen-code-core/services/cronTasksFile.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import type { WorkspaceRemovalActivity } from '../workspace-activity.js';
import { getWorkspaceRuntimeCoordinatorIfSupported } from '../workspace-runtime-coordinator.js';
import { runWithWorkspaceRuntimeStorage } from '../workspace-runtime-storage.js';
import {
  requireTrustedWorkspaceRuntime,
  resolveWorkspaceRuntimeFromParam,
} from '../workspace-route-runtime.js';
import { isInternalWorkspaceRuntime } from '../workspace-runtime-visibility.js';
import type { SendBridgeError } from '../server/error-response.js';

export interface WorkspaceRuntimeStopDeps {
  workspaceRegistry: WorkspaceRegistry;
  mutate: (options?: { strict?: boolean }) => RequestHandler;
  safeBody: (req: Request) => Record<string, unknown>;
  sendBridgeError: SendBridgeError;
  available: () => boolean;
  ownsBridge: (runtime: WorkspaceRuntime) => boolean;
  getCapacity: () => {
    committedAcpChildren: number;
    maxConcurrentChildren: number | null;
  };
  getActivity: (
    runtime: WorkspaceRuntime,
  ) => WorkspaceRemovalActivity | undefined;
  scheduledWorkActive: (runtime: WorkspaceRuntime) => boolean;
  stopKeepalive: (runtime: WorkspaceRuntime) => void;
  startKeepalive: (runtime: WorkspaceRuntime) => void;
}

function parseConfirmation(
  body: Record<string, unknown>,
): BridgeRuntimeStopRequest | undefined {
  const {
    confirmInterruptions,
    expectedChannelId,
    expectedRuntimeEpoch,
    expectedStopToken,
    expectedSessionIds,
  } = body;
  if (
    confirmInterruptions !== true ||
    typeof expectedChannelId !== 'string' ||
    typeof expectedRuntimeEpoch !== 'number' ||
    !Number.isSafeInteger(expectedRuntimeEpoch) ||
    typeof expectedStopToken !== 'string' ||
    !Array.isArray(expectedSessionIds) ||
    !expectedSessionIds.every((id): id is string => typeof id === 'string') ||
    new Set(expectedSessionIds).size !== expectedSessionIds.length
  )
    return undefined;
  return {
    confirmInterruptions,
    expectedChannelId,
    expectedRuntimeEpoch,
    expectedStopToken,
    expectedSessionIds,
  };
}

export function registerWorkspaceRuntimeStopRoutes(
  app: Application,
  deps: WorkspaceRuntimeStopDeps,
): void {
  const current = (runtime: WorkspaceRuntime): boolean => {
    const entry = deps.workspaceRegistry.getEntryByWorkspaceId(
      runtime.workspaceId,
    );
    return (
      entry?.state === 'active' &&
      entry.current?.runtime === runtime &&
      !entry.current.guard.closed &&
      runtime.trusted
    );
  };
  const blockers = (runtime: WorkspaceRuntime): string[] => {
    const reasons: string[] = [];
    if (!current(runtime)) reasons.push('runtime_unavailable');
    if (runtime.provenance && runtime.provenance !== 'existing')
      reasons.push('special_runtime');
    if (
      !deps.ownsBridge(runtime) ||
      !runtime.bridge.getRuntimeStopSnapshot ||
      !runtime.bridge.stopWorkspaceRuntime
    )
      reasons.push('unsupported');
    const activity = deps.getActivity(runtime);
    if (!activity) reasons.push('activity_unknown');
    else
      for (const key of [
        'pendingSessionStarts',
        'acpConnections',
        'memoryTasks',
        'channelWorkers',
        'voiceSessions',
      ] as const) {
        if (activity[key] > 0) reasons.push(key);
      }
    if (getWorkspaceRuntimeCoordinatorIfSupported(runtime)?.hasManagementWork())
      reasons.push('management_pending');
    if (deps.scheduledWorkActive(runtime)) reasons.push('scheduler_pending');
    return reasons;
  };
  const preview = async (runtime: WorkspaceRuntime) => {
    let enabledTaskCount: number | null = null;
    const reasons = blockers(runtime);
    if (current(runtime) && deps.ownsBridge(runtime)) {
      try {
        const tasks = await runWithWorkspaceRuntimeStorage(runtime, () =>
          readCronTasks(runtime.workspaceCwd),
        );
        enabledTaskCount = tasks.filter(
          (task) => task.enabled !== false && !taskHasLegacyCondition(task),
        ).length;
        if (enabledTaskCount > 0) reasons.push('enabled_scheduled_tasks');
      } catch {
        reasons.push('scheduled_tasks_unknown');
      }
    }
    const snapshot = current(runtime)
      ? runtime.bridge.getRuntimeStopSnapshot?.()
      : undefined;
    const blockedReasons = [
      ...new Set([
        ...reasons,
        ...blockers(runtime),
        ...(snapshot?.blockedReasons ?? ['unsupported']),
      ]),
    ];
    return {
      workspaceId: runtime.workspaceId,
      cwd: runtime.workspaceCwd,
      displayName: runtime.displayName,
      primary: runtime.primary,
      state:
        runtime.bridge.getWorkspaceRuntimeLifecycleSnapshot?.().state ??
        'unknown',
      canStop: blockedReasons.length === 0,
      enabledTaskCount,
      activity: deps.getActivity(runtime),
      runtimeEpoch: snapshot?.runtimeEpoch ?? 0,
      stopToken: snapshot?.stopToken ?? '',
      sessions: snapshot?.sessions ?? [],
      ...snapshot,
      blockedReasons,
    };
  };
  const unavailable = (res: Response) =>
    res.status(501).json({
      code: 'workspace_runtime_stop_not_supported',
      error: 'Workspace runtime stop is not supported by this daemon.',
    });

  app.get('/workspaces/runtime-stop-options', async (_req, res) => {
    if (!deps.available()) {
      unavailable(res);
      return;
    }
    const workspaces = await Promise.all(
      deps.workspaceRegistry
        .listManaged()
        .filter((runtime) => !isInternalWorkspaceRuntime(runtime))
        .map(preview),
    );
    res.json({ ...deps.getCapacity(), workspaces });
  });

  app.post(
    '/workspaces/:workspace/runtime/stop',
    deps.mutate({ strict: true }),
    async (req, res) => {
      if (!deps.available()) {
        unavailable(res);
        return;
      }
      const runtime = resolveWorkspaceRuntimeFromParam(
        deps.workspaceRegistry,
        req,
        res,
      );
      if (!runtime || !requireTrustedWorkspaceRuntime(runtime, res)) return;
      const confirmation = parseConfirmation(deps.safeBody(req));
      if (!confirmation) {
        res.status(400).json({
          code: 'invalid_runtime_stop_confirmation',
          error:
            'Confirm the exact workspace and affected sessions before stopping.',
        });
        return;
      }
      const coordinator = getWorkspaceRuntimeCoordinatorIfSupported(runtime);
      if (
        !coordinator ||
        !deps.ownsBridge(runtime) ||
        !runtime.bridge.stopWorkspaceRuntime
      ) {
        unavailable(res);
        return;
      }
      const sendOutcome = (result: BridgeRuntimeStopResult) => {
        const code =
          result.state === 'stopping'
            ? 'workspace_runtime_stop_in_progress'
            : result.state === 'failed'
              ? 'workspace_runtime_stop_failed'
              : 'workspace_runtime_stop_incomplete';
        res
          .status(
            result.state === 'stopped'
              ? 200
              : result.state === 'incomplete'
                ? 409
                : 503,
          )
          .json({
            ...result,
            workspaceId: runtime.workspaceId,
            ...deps.getCapacity(),
            ...(result.state === 'stopped'
              ? {}
              : {
                  code,
                  error: result.error ?? 'Workspace stop is still in progress.',
                }),
          });
      };
      try {
        const before = await preview(runtime);
        if (!current(runtime)) {
          res.status(409).json({
            code: 'workspace_runtime_stop_stale',
            error: 'Workspace generation changed. Refresh the preview.',
          });
          return;
        }
        if (
          before.lastStop?.stopToken === confirmation.expectedStopToken &&
          before.lastStop.channelId === confirmation.expectedChannelId &&
          before.lastStop.runtimeEpoch === confirmation.expectedRuntimeEpoch
        ) {
          sendOutcome(before.lastStop);
          return;
        }
        if (!before.canStop) {
          res.status(409).json({
            code: 'workspace_runtime_stop_blocked',
            error: 'Workspace has independent runtime work.',
            preview: before,
          });
          return;
        }
        const finishStop = coordinator.beginStop();
        let operation: Promise<BridgeRuntimeStopResult>;
        const finish = () => {
          if (finishStop() && current(runtime)) deps.startKeepalive(runtime);
        };
        try {
          deps.stopKeepalive(runtime);
          if (blockers(runtime).length)
            throw new WorkspaceRuntimeStopError(
              'workspace_runtime_stop_blocked',
            );
          operation = runtime.bridge
            .stopWorkspaceRuntime(confirmation)
            .finally(finish);
        } catch (error) {
          finish();
          throw error;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([
            operation,
            new Promise<undefined>((resolve) => {
              timer = setTimeout(() => resolve(undefined), 60_000);
              timer.unref?.();
            }),
          ]);
          const observed =
            result ?? runtime.bridge.getRuntimeStopSnapshot?.().lastStop;
          if (observed) sendOutcome(observed);
          else
            res.status(503).json({
              code: 'workspace_runtime_stop_in_progress',
              error: 'Workspace stop outcome is not yet known.',
            });
        } finally {
          if (timer) clearTimeout(timer);
        }
      } catch (error) {
        if (error instanceof WorkspaceRuntimeStopError)
          res.status(409).json({ code: error.code, error: error.message });
        else
          deps.sendBridgeError(res, error, {
            route: 'POST /workspaces/:workspace/runtime/stop',
          });
      }
    },
  );
}
