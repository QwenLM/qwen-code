/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BridgeIdleChannelCandidate } from '@qwen-code/acp-bridge/bridgeTypes';
import type { ChildHeapPolicy } from '@qwen-code/acp-bridge/childHeapPolicy';
import type { ProcessRegistry } from '@qwen-code/acp-bridge/processRegistry';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from './workspace-registry.js';
import type { WorkspaceRemovalActivity } from './workspace-activity.js';

export type IdleAcpReclaimer = (
  requesterWorkspaceId: string,
  signal?: AbortSignal,
) => Promise<void>;

export function createIdleAcpReclaimer(options: {
  registry: WorkspaceRegistry;
  processes: ProcessRegistry;
  policy: ChildHeapPolicy;
  ownsBridge: (bridge: WorkspaceRuntime['bridge']) => boolean;
  getActivity: (
    runtime: WorkspaceRuntime,
  ) => WorkspaceRemovalActivity | undefined;
}): IdleAcpReclaimer {
  return async (requesterWorkspaceId, signal) => {
    const policy = options.policy.snapshot();
    if (
      signal?.aborted ||
      policy.mode !== 'admit' ||
      options.processes.committedProcessCount < policy.maxConcurrentChildren!
    ) {
      return;
    }
    const eligible = (runtime: WorkspaceRuntime): boolean => {
      const entry = options.registry.getEntryByWorkspaceId(runtime.workspaceId);
      if (
        entry?.state !== 'active' ||
        entry.current?.runtime !== runtime ||
        entry.current.guard.closed ||
        !runtime.trusted ||
        runtime.workspaceId === requesterWorkspaceId ||
        (runtime.provenance !== undefined &&
          runtime.provenance !== 'existing') ||
        !options.ownsBridge(runtime.bridge) ||
        !runtime.bridge.reclaimIdleChannel
      ) {
        return false;
      }
      const activity = options.getActivity(runtime);
      return (
        activity !== undefined &&
        Object.values(activity).every((count) => count === 0)
      );
    };
    const candidates: Array<{
      runtime: WorkspaceRuntime;
      channel: BridgeIdleChannelCandidate;
    }> = [];
    for (const runtime of options.registry.listManaged()) {
      if (!eligible(runtime)) continue;
      const channel = runtime.bridge.getIdleChannelCandidate?.();
      if (channel) candidates.push({ runtime, channel });
    }
    candidates.sort(
      (a, b) =>
        a.channel.lastUsedAt - b.channel.lastUsedAt ||
        a.runtime.workspaceId.localeCompare(b.runtime.workspaceId),
    );
    const selected = candidates[0];
    if (!selected || signal?.aborted || !eligible(selected.runtime)) return;
    await selected.runtime.bridge.reclaimIdleChannel!(selected.channel, signal);
  };
}
