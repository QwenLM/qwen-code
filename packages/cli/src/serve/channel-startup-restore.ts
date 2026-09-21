/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { sanitizeLogText } from '@qwen-code/channel-base';
import { normalizeServeChannelSelection } from './channel-selection.js';
import type { ServeChannelSelection } from './types.js';

/** A registered workspace that may contribute a startup channel selection. */
export interface StartupChannelWorkspace {
  readonly workspaceCwd: string;
  readonly primary: boolean;
}

export type StartupChannelDiagnosticCode =
  /** The workspace's settings could not be read at all. */
  | 'settings_unreadable'
  /** `serve.channels` is present but not a usable channel list. */
  | 'invalid_setting'
  /** One entry of an otherwise usable list is unusable. */
  | 'invalid_entry'
  /** `all` was selected outside the primary workspace, or alongside one. */
  | 'all_is_primary_only'
  /** Several workspaces list the same channel name. */
  | 'claimed_by_multiple_workspaces';

export interface StartupChannelDiagnostic {
  readonly code: StartupChannelDiagnosticCode;
  readonly workspaceCwd: string;
  readonly message: string;
  readonly channel?: string;
}

export interface StartupChannelSelection {
  readonly selection: ServeChannelSelection | undefined;
  /**
   * Names a non-primary workspace asked for, mapped to that workspace, for
   * `resolveChannelWorkspaceGroups`'s `preferredOwners`. A name claimed by
   * more than one workspace is deliberately absent: the claim is itself
   * ambiguous, so ownership resolution decides it or reports it.
   */
  readonly ownerHints: ReadonlyMap<string, string>;
  /**
   * Names contributed by a non-primary workspace. Their grouping failure must
   * not strand the channels every other workspace asked for, so they are the
   * `tolerant` set. The primary workspace's own names keep failing the whole
   * restore, which is what a single-workspace daemon does today.
   */
  readonly tolerantNames: ReadonlySet<string>;
  readonly diagnostics: readonly StartupChannelDiagnostic[];
}

export interface ResolveStartupChannelSelectionInput {
  /** Registered workspaces, primary first, in registration order. */
  readonly workspaces: readonly StartupChannelWorkspace[];
  /**
   * Reads one workspace's `serve.channels` as stored, or `undefined` when it
   * sets none. Injected so this stays pure; it may throw, and a throw only
   * disqualifies that one workspace.
   */
  readonly loadStartupChannels: (workspaceCwd: string) => unknown;
}

interface Claim {
  readonly workspaceCwd: string;
  readonly primary: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUsableEntry(name: string): boolean {
  return (
    Boolean(name) &&
    name === name.trim() &&
    sanitizeLogText(name, name.length) === name
  );
}

/**
 * Build the boot-time channel selection from every registered workspace's own
 * `serve.channels`, rather than the primary workspace's alone.
 *
 * The daemon hosts one flat selection and resolves each name back to its
 * owning workspace, so this returns that flat list plus the attribution the
 * resolver needs: which workspace asked for a name, and which names may be
 * dropped rather than failing the whole restore.
 *
 * `all` stays a primary-workspace concept: the flat selection cannot express
 * "every channel in A plus two in B", so a primary `all` wins outright and an
 * `all` anywhere else is reported and ignored.
 */
export function resolveStartupChannelSelection(
  input: ResolveStartupChannelSelectionInput,
): StartupChannelSelection {
  const diagnostics: StartupChannelDiagnostic[] = [];
  const claimsByName = new Map<string, Claim[]>();
  const names: string[] = [];
  let primaryAllWorkspace: string | undefined;

  for (const workspace of input.workspaces) {
    const workspaceCwd = workspace.workspaceCwd;
    let raw: unknown;
    try {
      raw = input.loadStartupChannels(workspaceCwd);
    } catch (error) {
      diagnostics.push({
        code: 'settings_unreadable',
        workspaceCwd,
        message: errorMessage(error),
      });
      continue;
    }
    if (raw === undefined) continue;
    if (
      !Array.isArray(raw) ||
      !raw.every((name): name is string => typeof name === 'string')
    ) {
      diagnostics.push({
        code: 'invalid_setting',
        workspaceCwd,
        message: 'serve.channels must be a string array.',
      });
      continue;
    }
    const entries = raw.filter((name, index) => {
      if (isUsableEntry(name)) return true;
      diagnostics.push({
        code: 'invalid_entry',
        workspaceCwd,
        // Keep the operator-facing wording the single-workspace restore has
        // always logged; the workspace it came from is a log field.
        message: `ignored invalid workspace serve.channels entry at index ${index}`,
      });
      return false;
    });

    let selection: ServeChannelSelection | undefined;
    try {
      selection = normalizeServeChannelSelection(entries, 'serve.channels');
    } catch (error) {
      diagnostics.push({
        code: 'invalid_setting',
        workspaceCwd,
        message: errorMessage(error),
      });
      continue;
    }
    if (!selection) continue;
    if (selection.mode === 'all') {
      if (workspace.primary) {
        primaryAllWorkspace = workspaceCwd;
        continue;
      }
      diagnostics.push({
        code: 'all_is_primary_only',
        workspaceCwd,
        message: `serve.channels selection "all" is primary-workspace only; workspace "${workspaceCwd}" was not restored.`,
      });
      continue;
    }
    for (const name of selection.names) {
      const claims = claimsByName.get(name);
      if (claims) {
        claims.push({ workspaceCwd, primary: workspace.primary });
        continue;
      }
      claimsByName.set(name, [{ workspaceCwd, primary: workspace.primary }]);
      names.push(name);
    }
  }

  if (primaryAllWorkspace !== undefined) {
    if (names.length > 0) {
      diagnostics.push({
        code: 'all_is_primary_only',
        workspaceCwd: primaryAllWorkspace,
        message: `serve.channels selection "all" is primary-workspace only; channels listed by other workspaces were not restored: ${names.join(
          ', ',
        )}.`,
      });
    }
    return {
      selection: { mode: 'all' },
      ownerHints: new Map(),
      tolerantNames: new Set(),
      diagnostics,
    };
  }

  const ownerHints = new Map<string, string>();
  const tolerantNames = new Set<string>();
  for (const [name, claims] of claimsByName) {
    if (claims.length > 1) {
      diagnostics.push({
        code: 'claimed_by_multiple_workspaces',
        workspaceCwd: claims[0]!.workspaceCwd,
        channel: name,
        message: `Channel "${name}" is listed in the serve.channels of several workspaces (${claims
          .map((claim) => claim.workspaceCwd)
          .join(', ')}); its owner is resolved from the channel config alone.`,
      });
    }
    // Only a name no primary claim covers is droppable. A name the primary
    // listed keeps the existing fail-fast behavior even when another workspace
    // lists it too, so copying `serve.channels` into a second workspace cannot
    // quietly turn the primary's own restore into a skip.
    if (claims.every((claim) => !claim.primary)) tolerantNames.add(name);
    if (claims.length === 1 && !claims[0]!.primary) {
      ownerHints.set(name, claims[0]!.workspaceCwd);
    }
  }

  return {
    selection: names.length > 0 ? { mode: 'names', names } : undefined,
    ownerHints,
    tolerantNames,
    diagnostics,
  };
}
