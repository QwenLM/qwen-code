/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  DaemonWorkspaceRuntimeStatus,
  DaemonWorkspaceSkillsStatus,
  WorkspaceDaemonClient,
} from '@qwen-code/sdk/daemon';

export async function loadReadyWorkspaceSkills(
  client: Pick<
    WorkspaceDaemonClient,
    'runtimeStatus' | 'workspaceRuntimeSkills'
  >,
  initialRuntime: DaemonWorkspaceRuntimeStatus,
  cancelled: () => boolean,
): Promise<DaemonWorkspaceSkillsStatus | undefined> {
  let runtime = initialRuntime;
  while (
    !cancelled() &&
    runtime.runtimeLive &&
    runtime.capabilities?.skills?.state === 'starting'
  ) {
    runtime = await client.runtimeStatus();
    if (runtime.capabilities?.skills?.state === 'starting') {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  const skills = runtime.capabilities?.skills;
  if (
    cancelled() ||
    !runtime.runtimeLive ||
    skills?.state !== 'ready' ||
    skills.runtimeEpoch !== runtime.runtimeEpoch
  ) {
    return undefined;
  }
  const status = await client.workspaceRuntimeSkills();
  return !cancelled() &&
    status.initialized &&
    status.runtimeEpoch === runtime.runtimeEpoch
    ? status
    : undefined;
}
