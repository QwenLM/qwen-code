/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  DaemonChannelsSnapshot,
  DaemonMcpDiscoveryState,
  DaemonSessionSummary,
  DaemonWorkspaceHooksStatus,
  DaemonWorkspaceMcpStatus,
  DaemonWorkspaceMemoryStatus,
  DaemonWorkspaceSkillsStatus,
  WorkspaceExtensionProjection,
} from '@qwen-code/sdk/daemon';

/**
 * Facets the sidebar can summarize per workspace. Each maps to one
 * workspace-qualified daemon route; the order here is the chip order.
 */
export const WORKSPACE_OVERVIEW_ITEMS = [
  'mcp',
  'skills',
  'extensions',
  'channels',
  'context',
  'hooks',
] as const;

export type WorkspaceOverviewItem = (typeof WORKSPACE_OVERVIEW_ITEMS)[number];

/** Hooks are opt-in: most workspaces have none and the chip would only add noise. */
export const DEFAULT_WORKSPACE_OVERVIEW_ITEMS: readonly WorkspaceOverviewItem[] =
  ['mcp', 'skills', 'extensions', 'channels', 'context'];

/** Management pages a workspace row can open for itself. */
export type WorkspaceManagementTarget =
  | 'mcp'
  | 'skills'
  | 'extensions'
  | 'channels'
  | 'settings';

export interface WorkspaceSessionStats {
  /** Sessions in the list the stats were computed from. */
  total: number;
  /** Sessions with a prompt in flight. */
  running: number;
  /** Sessions blocked on the user (permission, question, other interaction). */
  attention: number;
  /** The list was one page of a longer catalog, so `total` is a lower bound. */
  truncated: boolean;
}

export function summarizeSessions(
  sessions: readonly DaemonSessionSummary[],
  truncated = false,
): WorkspaceSessionStats {
  let running = 0;
  let attention = 0;
  for (const session of sessions) {
    if (session.hasActivePrompt) running += 1;
    if (
      session.isWaitingForPermission ||
      session.isWaitingForUserQuestion ||
      (session.pendingInteractionCount ?? 0) > 0
    ) {
      attention += 1;
    }
  }
  return { total: sessions.length, running, attention, truncated };
}

/**
 * MCP, skills, context files and hooks are discovered by the workspace's ACP
 * child. While no child is live the daemon answers with an idle placeholder
 * (`initialized: false`, empty lists); that placeholder must render as
 * "unknown", never as zero.
 */
export interface WorkspaceMcpSummary {
  initialized: boolean;
  discoveryState?: DaemonMcpDiscoveryState;
  configured: number;
  connected: number;
  /** Enabled servers the runtime reports as errored. */
  failed: number;
  disabled: number;
}

export function summarizeMcp(
  status: DaemonWorkspaceMcpStatus,
): WorkspaceMcpSummary {
  let connected = 0;
  let failed = 0;
  let disabled = 0;
  for (const server of status.servers) {
    if (server.disabled) {
      disabled += 1;
      continue;
    }
    if (server.mcpStatus === 'connected') connected += 1;
    if (server.status === 'error') failed += 1;
  }
  return {
    initialized: status.initialized,
    discoveryState: status.discoveryState,
    configured: status.servers.length,
    connected,
    failed,
    disabled,
  };
}

export interface WorkspaceSkillsSummary {
  initialized: boolean;
  total: number;
  enabled: number;
}

export function summarizeSkills(
  status: DaemonWorkspaceSkillsStatus,
): WorkspaceSkillsSummary {
  return {
    initialized: status.initialized,
    total: status.skills.length,
    enabled: status.skills.filter((skill) => !skill.disabledReason).length,
  };
}

export interface WorkspaceExtensionsSummary {
  total: number;
  active: number;
}

export function summarizeExtensions(
  projection: WorkspaceExtensionProjection,
): WorkspaceExtensionsSummary {
  return {
    total: projection.extensions.length,
    active: projection.extensions.filter(
      (extension) => extension.effectiveActivation === 'enabled',
    ).length,
  };
}

export interface WorkspaceChannelsSummary {
  configured: number;
  /** Instances whose worker is connected (fully or partially). */
  connected: number;
  failed: number;
}

export function summarizeChannels(
  snapshot: DaemonChannelsSnapshot,
): WorkspaceChannelsSummary {
  let connected = 0;
  let failed = 0;
  const instances = Object.values(snapshot.instances);
  for (const instance of instances) {
    const state = instance.runtime?.state;
    if (state === 'connected' || state === 'partial') connected += 1;
    else if (state === 'error') failed += 1;
  }
  return { configured: instances.length, connected, failed };
}

/**
 * Context files are read from disk by the daemon itself (no ACP child), so
 * the route always answers definitively: `initialized: false` is its way of
 * saying no context file exists, and renders as a count of 0.
 */
export interface WorkspaceContextSummary {
  initialized: boolean;
  fileCount: number;
  ruleCount: number;
}

export function summarizeContext(
  status: DaemonWorkspaceMemoryStatus,
): WorkspaceContextSummary {
  return {
    initialized: status.initialized,
    fileCount: status.fileCount,
    ruleCount: status.ruleCount,
  };
}

export interface WorkspaceHooksSummary {
  initialized: boolean;
  count: number;
  disabled: boolean;
}

export function summarizeHooks(
  status: DaemonWorkspaceHooksStatus,
): WorkspaceHooksSummary {
  return {
    initialized: status.initialized,
    count: status.hooks.length,
    disabled: status.disabled,
  };
}

/**
 * One workspace's facet summaries. A facet is `undefined` when it was not
 * requested or its fetch failed (older daemon without the route, network
 * blip); the hook keeps the previous value of a facet across a transient
 * failure so a chip does not blank for a whole poll interval.
 */
export interface WorkspaceOverviewSnapshot {
  mcp?: WorkspaceMcpSummary;
  skills?: WorkspaceSkillsSummary;
  extensions?: WorkspaceExtensionsSummary;
  channels?: WorkspaceChannelsSummary;
  context?: WorkspaceContextSummary;
  hooks?: WorkspaceHooksSummary;
  fetchedAt: number;
}

/**
 * Facets the workspace's ACP child discovers, which stay unknown until it
 * reports; extensions, channels and context files are answered by the daemon
 * itself and are known as soon as the route responds.
 */
export function isRuntimeDiscoveredFacet(item: WorkspaceOverviewItem): boolean {
  return item === 'mcp' || item === 'skills' || item === 'hooks';
}

/**
 * Whether a facet carries a countable value. Runtime-discovered facets are
 * unknown until the ACP child reports `initialized`; the rest are known as
 * soon as the daemon answers.
 */
export function isOverviewFacetKnown(
  snapshot: WorkspaceOverviewSnapshot | undefined,
  item: WorkspaceOverviewItem,
): boolean {
  if (!snapshot) return false;
  switch (item) {
    case 'mcp':
      return snapshot.mcp?.initialized === true;
    case 'skills':
      return snapshot.skills?.initialized === true;
    case 'extensions':
      return snapshot.extensions !== undefined;
    case 'channels':
      return snapshot.channels !== undefined;
    case 'context':
      return snapshot.context !== undefined;
    case 'hooks':
      return snapshot.hooks?.initialized === true;
    default:
      return false;
  }
}

/** Facets that warrant the warning tone on their chip. */
export function overviewFacetHasIssue(
  snapshot: WorkspaceOverviewSnapshot | undefined,
  item: WorkspaceOverviewItem,
): boolean {
  if (!isOverviewFacetKnown(snapshot, item)) return false;
  switch (item) {
    case 'mcp': {
      const mcp = snapshot?.mcp;
      if (!mcp) return false;
      if (mcp.failed > 0) return true;
      // Discovery finished but some enabled server never came up.
      return (
        mcp.discoveryState === 'completed' &&
        mcp.connected < mcp.configured - mcp.disabled
      );
    }
    case 'channels':
      return (snapshot?.channels?.failed ?? 0) > 0;
    default:
      return false;
  }
}

/**
 * Merge a fresh snapshot over the previous one, keeping a facet's last known
 * value when the new round did not answer for it — unless the facet is in
 * `expired`: a route that keeps failing (an older daemon after a rollback)
 * must eventually show as unavailable instead of a frozen count.
 */
export function mergeOverviewSnapshots(
  previous: WorkspaceOverviewSnapshot | undefined,
  next: WorkspaceOverviewSnapshot,
  requested: ReadonlySet<WorkspaceOverviewItem>,
  expired: ReadonlySet<WorkspaceOverviewItem> = new Set(),
): WorkspaceOverviewSnapshot {
  if (!previous) return next;
  const merged: WorkspaceOverviewSnapshot = { fetchedAt: next.fetchedAt };
  for (const item of WORKSPACE_OVERVIEW_ITEMS) {
    if (!requested.has(item)) continue;
    const value =
      next[item] ?? (expired.has(item) ? undefined : previous[item]);
    // Facet keys and their summary types line up one-to-one; the loop is
    // over the literal union, so assigning through Object.assign only
    // sidesteps the per-key narrowing TypeScript cannot express here.
    if (value !== undefined) Object.assign(merged, { [item]: value });
  }
  return merged;
}
