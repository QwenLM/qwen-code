/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  DaemonCapabilities,
  DaemonSession,
  DaemonStandaloneSession,
} from '@qwen-code/sdk/daemon';
import type {
  DaemonProductSessionContext,
  DaemonStandaloneConnectionState,
} from './types.js';

function normalizeWorkspaceCwd(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
}

export function resolveProviderSessionContext(
  sessionContext: DaemonProductSessionContext | undefined,
  workspaceCwd: string | undefined,
  inheritedWorkspaceCwd: string | undefined,
): DaemonProductSessionContext | undefined {
  if (!sessionContext) {
    const cwd = workspaceCwd ?? inheritedWorkspaceCwd;
    return cwd ? { kind: 'workspace', cwd } : undefined;
  }
  if (sessionContext.kind === 'workspace') {
    if (!sessionContext.cwd) {
      throw new Error('Workspace session context requires a cwd');
    }
    if (
      workspaceCwd !== undefined &&
      normalizeWorkspaceCwd(workspaceCwd) !==
        normalizeWorkspaceCwd(sessionContext.cwd)
    ) {
      throw new Error('sessionContext.cwd conflicts with workspaceCwd');
    }
    return sessionContext;
  }
  if (workspaceCwd !== undefined) {
    throw new Error(
      `${sessionContext.kind} session context cannot include workspaceCwd`,
    );
  }
  return sessionContext;
}

export function resolveActionSessionContext(
  sessionContext: DaemonProductSessionContext | undefined,
  workspaceCwd: string | undefined,
  fallback: DaemonProductSessionContext | undefined,
): DaemonProductSessionContext | undefined {
  return (
    resolveProviderSessionContext(
      sessionContext,
      workspaceCwd,
      sessionContext || workspaceCwd
        ? undefined
        : fallback?.kind === 'workspace'
          ? fallback.cwd
          : undefined,
    ) ?? fallback
  );
}

export function resolveLiveSessionWorkspaceCwd(
  capabilities: DaemonCapabilities,
): string {
  if (!capabilities.features.includes('multi_workspace_sessions')) {
    throw new Error(
      'Daemon does not advertise multi-workspace session routing',
    );
  }
  const liveWorkspaces = (capabilities.workspaces ?? []).filter(
    (workspace) => workspace.kind === 'live',
  );
  if (liveWorkspaces.length !== 1) {
    throw new Error(
      liveWorkspaces.length === 0
        ? 'Daemon does not advertise a Live session runtime'
        : 'Daemon advertises multiple Live session runtimes',
    );
  }
  const workspace = liveWorkspaces[0]!;
  const normalizedWorkspaceCwd = normalizeWorkspaceCwd(workspace.cwd);
  if (
    workspace.trusted !== true ||
    workspace.primary !== false ||
    !workspace.id ||
    !workspace.cwd ||
    capabilities.workspaces?.filter((entry) => entry.id === workspace.id)
      .length !== 1 ||
    capabilities.workspaces?.filter(
      (entry) => normalizeWorkspaceCwd(entry.cwd) === normalizedWorkspaceCwd,
    ).length !== 1
  ) {
    throw new Error('Daemon Live session runtime is not uniquely trusted');
  }
  return workspace.cwd;
}

export function sessionContextKey(
  context: DaemonProductSessionContext | undefined,
): string {
  return context?.kind === 'workspace'
    ? `workspace:${normalizeWorkspaceCwd(context.cwd)}`
    : (context?.kind ?? 'legacy');
}

export function restoreSessionContextMatches(
  requested: DaemonProductSessionContext | undefined,
  active: DaemonProductSessionContext | undefined,
): boolean {
  if (requested === undefined) {
    return active === undefined || active.kind === 'workspace';
  }
  return sessionContextKey(requested) === sessionContextKey(active);
}

function getDaemonErrorBody(
  error: unknown,
): Record<string, unknown> | undefined {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('body' in error) ||
    typeof error.body !== 'object' ||
    error.body === null ||
    Array.isArray(error.body)
  ) {
    return undefined;
  }
  return error.body as Record<string, unknown>;
}

export function getDaemonErrorCode(error: unknown): string | undefined {
  const code = getDaemonErrorBody(error)?.['code'];
  return typeof code === 'string' ? code : undefined;
}

export function isDaemonErrorExplicitlyNonRetryable(error: unknown): boolean {
  return getDaemonErrorBody(error)?.['retryable'] === false;
}

export function getStandaloneConnectionState(
  session: DaemonSession | undefined,
): DaemonStandaloneConnectionState | undefined {
  if (!session) return undefined;
  const standalone = session as Partial<DaemonStandaloneSession>;
  if (
    standalone.sourceType !== 'standalone' ||
    standalone.context?.kind !== 'standalone' ||
    standalone.projectlessOutputDirectory === undefined ||
    standalone.workingDirectory === undefined
  ) {
    return undefined;
  }
  return {
    projectlessOutputDirectory: standalone.projectlessOutputDirectory,
    workingDirectory: standalone.workingDirectory,
  };
}
