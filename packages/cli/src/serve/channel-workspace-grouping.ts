/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { canonicalizeWorkspace } from '@qwen-code/acp-bridge/workspacePaths';
import { resolveChannelCwd } from '../commands/channel/channel-cwd.js';
import type { WorkspaceRuntimeProvenance } from './managed-scratch-workspace.js';
import type { ServeChannelSelection } from './types.js';

/**
 * A registered workspace runtime, reduced to the fields channel grouping needs.
 */
export interface ChannelWorkspaceInput {
  /** Canonical workspace cwd (as registered on the daemon). */
  readonly workspaceCwd: string;
  readonly primary: boolean;
  readonly trusted: boolean;
  readonly provenance?: WorkspaceRuntimeProvenance;
}

/** A channel selection scoped to a single owning workspace. */
export interface ChannelWorkspaceGroup {
  readonly workspaceCwd: string;
  readonly selection: ServeChannelSelection;
}

export type ChannelWorkspaceGroupingErrorCode =
  | 'channel_workspace_mismatch'
  | 'ambiguous_channel_workspace'
  | 'untrusted_workspace'
  | 'no_primary_workspace';

export interface ChannelWorkspaceGroupingError {
  readonly code: ChannelWorkspaceGroupingErrorCode;
  readonly message: string;
  readonly channel?: string;
}

/**
 * A per-channel resolution failure that `tolerant` downgraded to a skip
 * instead of failing the whole selection.
 */
export interface ChannelWorkspaceGroupingSkip
  extends ChannelWorkspaceGroupingError {
  readonly channel: string;
}

export type ChannelWorkspaceGroupingResult =
  | {
      readonly ok: true;
      readonly groups: readonly ChannelWorkspaceGroup[];
      /** Present only when `tolerant` actually skipped a name. */
      readonly skipped?: readonly ChannelWorkspaceGroupingSkip[];
    }
  | { readonly ok: false; readonly error: ChannelWorkspaceGroupingError };

export interface ResolveChannelWorkspaceGroupsInput {
  readonly workspaces: readonly ChannelWorkspaceInput[];
  readonly selection: ServeChannelSelection;
  /**
   * Returns a workspace's merged channel config map (`settings.merged.channels`
   * style). Injected so the resolver stays pure and unit-testable.
   */
  readonly loadChannelsConfig: (
    workspaceCwd: string,
  ) => Record<string, unknown>;
  /**
   * Maps a selected channel name to the workspace that asked for it, used only
   * to break an otherwise ambiguous ownership tie: when several workspaces own
   * the name, the hinted one wins instead of `ambiguous_channel_workspace`.
   * The hint only selects among owners the predicate already accepted, so it
   * can never hand a channel to a workspace that does not own it, and the
   * owner's trust check still applies afterwards.
   *
   * Callers must not register a hint for a name that more than one workspace
   * claims: a map can hold only one owner per name, so a silently overwritten
   * hint would pick a claimant arbitrarily. Drop the hint instead and let the
   * ambiguity surface.
   */
  readonly preferredOwners?: ReadonlyMap<string, string>;
  /**
   * Names whose resolution failure must not fail the whole selection. A
   * tolerated name that cannot be resolved is dropped and reported in
   * `skipped`, leaving every other name grouped as usual. Names outside this
   * set stay fail-fast, which is what an explicit `--channel` selection needs.
   */
  readonly tolerant?: ReadonlySet<string>;
}

/**
 * Resolve the workspace a channel's configured cwd belongs to. Relative paths
 * resolve against the owning workspace via `resolveChannelCwd`, then use the
 * worker-side `validateChannelWorkspaces` canonicalization so the serve-layer
 * grouping and the worker's own validation always agree.
 */
export function resolveChannelOwnerCwd(
  rawCwd: string | undefined,
  workspaceCwd: string,
): string {
  return canonicalizeWorkspace(resolveChannelCwd(rawCwd, workspaceCwd));
}

function rawChannelCwd(entry: unknown): string | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const cwd = (entry as { cwd?: unknown }).cwd;
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined;
}

/**
 * Group a `--channel` selection by the registered workspace that owns each
 * channel. A channel belongs to workspace `W` iff its resolved cwd
 * (`explicit || W`) canonicalizes back to `W` — i.e. it would pass the
 * worker's `validateChannelWorkspaces` under `W`. Because `loadChannelsConfig`
 * reads merged settings (system + user + workspace scopes), a user/system-scope
 * channel with no `cwd` matches every workspace and is reported as ambiguous.
 *
 * `preferredOwners` breaks that ambiguity for a caller that knows which
 * workspace asked for the name — a workspace listing it in its own
 * `serve.channels` — and `tolerant` turns a single name's failure into a
 * `skipped` entry so one workspace's bad entry cannot strand every other
 * workspace's channels.
 *
 * `--channel all` stays primary-only in v1 to avoid implicit cross-workspace
 * process fan-out.
 */
export function resolveChannelWorkspaceGroups(
  input: ResolveChannelWorkspaceGroupsInput,
): ChannelWorkspaceGroupingResult {
  const { selection, loadChannelsConfig } = input;
  const workspaces = input.workspaces.filter(
    (workspace) => workspace.provenance !== 'live-conversation',
  );
  const primary = workspaces.find((workspace) => workspace.primary);
  if (!primary) {
    return {
      ok: false,
      error: {
        code: 'no_primary_workspace',
        message: 'No primary workspace is registered.',
      },
    };
  }

  if (selection.mode === 'all') {
    if (!primary.trusted) {
      return {
        ok: false,
        error: {
          code: 'untrusted_workspace',
          message: `Primary workspace "${primary.workspaceCwd}" is not trusted; cannot host channels.`,
        },
      };
    }
    return {
      ok: true,
      groups: [
        { workspaceCwd: primary.workspaceCwd, selection: { mode: 'all' } },
      ],
    };
  }

  // Load each workspace's merged channel config once, rather than once per
  // selected channel name.
  const channelsConfigByWorkspace = new Map<string, Record<string, unknown>>();
  for (const workspace of workspaces) {
    channelsConfigByWorkspace.set(
      workspace.workspaceCwd,
      loadChannelsConfig(workspace.workspaceCwd),
    );
  }

  const namesByWorkspace = new Map<string, string[]>();
  const skipped: ChannelWorkspaceGroupingSkip[] = [];
  const { preferredOwners, tolerant } = input;
  // A tolerated name is dropped with its diagnostic; every other name keeps
  // failing the whole selection.
  const reject = (
    name: string,
    code: ChannelWorkspaceGroupingErrorCode,
    message: string,
  ): ChannelWorkspaceGroupingResult | undefined => {
    if (!tolerant?.has(name)) {
      return { ok: false, error: { code, channel: name, message } };
    }
    skipped.push({ code, channel: name, message });
    return undefined;
  };
  for (const name of selection.names) {
    const owners: ChannelWorkspaceInput[] = [];
    for (const workspace of workspaces) {
      const entry = (channelsConfigByWorkspace.get(workspace.workspaceCwd) ??
        {})[name];
      if (!entry || typeof entry !== 'object') continue;
      let ownerCwd: string;
      try {
        ownerCwd = resolveChannelOwnerCwd(
          rawChannelCwd(entry),
          workspace.workspaceCwd,
        );
      } catch {
        // A configured cwd that cannot be canonicalized (e.g. EACCES) cannot
        // own the channel; treat this workspace as a non-owner. If no
        // workspace matches, the channel falls through to the 0-owner
        // mismatch error below.
        continue;
      }
      if (ownerCwd === workspace.workspaceCwd) {
        owners.push(workspace);
      }
    }

    if (owners.length === 0) {
      const rejected = reject(
        name,
        'channel_workspace_mismatch',
        `Channel "${name}" is not configured in any registered workspace, or its "cwd" points outside them.`,
      );
      if (rejected) return rejected;
      continue;
    }
    let owner = owners[0]!;
    if (owners.length > 1) {
      const preferred = preferredOwners?.get(name);
      const hinted =
        preferred === undefined
          ? undefined
          : owners.find((candidate) => candidate.workspaceCwd === preferred);
      if (!hinted) {
        const rejected = reject(
          name,
          'ambiguous_channel_workspace',
          `Channel "${name}" is configured in multiple registered workspaces (${owners
            .map((candidate) => candidate.workspaceCwd)
            .join(
              ', ',
            )}). Define it in one workspace's settings or set an explicit "cwd".`,
        );
        if (rejected) return rejected;
        continue;
      }
      owner = hinted;
    }
    if (!owner.trusted) {
      const rejected = reject(
        name,
        'untrusted_workspace',
        `Channel "${name}" targets untrusted workspace "${owner.workspaceCwd}".`,
      );
      if (rejected) return rejected;
      continue;
    }
    const names = namesByWorkspace.get(owner.workspaceCwd) ?? [];
    names.push(name);
    namesByWorkspace.set(owner.workspaceCwd, names);
  }

  return {
    ok: true,
    groups: [...namesByWorkspace.entries()].map(([workspaceCwd, names]) => ({
      workspaceCwd,
      selection: { mode: 'names', names },
    })),
    // Omitted when nothing was skipped so a caller that never passes
    // `tolerant` keeps seeing the exact result shape it saw before.
    ...(skipped.length > 0 ? { skipped } : {}),
  };
}
