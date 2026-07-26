/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import equal from 'fast-deep-equal';
import {
  createDebugLogger,
  ApprovalMode,
  type Config,
  getMCPServerStatus,
  type MCPServerConfig,
} from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from './settings.js';
import type { SettingsWatcher } from './settingsWatcher.js';
import { assembleMcpServers } from './mcpServers.js';
import {
  getPendingGatedMcpServers,
  getPromptableMcpServers,
} from './mcpApprovals.js';
import { appEvents, AppEvent } from '../utils/events.js';

const debugLogger = createDebugLogger('MCP_HOT_RELOAD');

/**
 * The three connection-admission lists discovery consults to decide whether a
 * given MCP server may connect. Distinct from the `mcpServers` config map:
 * these govern *whether* to connect, the map governs *which servers and how*.
 */
export interface McpGating {
  excluded?: string[];
  allowed?: string[];
  pending?: string[];
}

/**
 * Whether two `mcpServers` maps are equivalent. `fast-deep-equal` is
 * insensitive to object key order (so reordering servers / fields in
 * settings.json is not a false positive) but sensitive to array order (so
 * `args` order — which is semantically meaningful — is). `undefined` ≡ `{}`.
 */
export function mcpServersEqual(
  a: Record<string, MCPServerConfig> | undefined,
  b: Record<string, MCPServerConfig> | undefined,
): boolean {
  return equal(a ?? {}, b ?? {});
}

/**
 * Whether two admission-list snapshots are equivalent. `excluded` / `pending`
 * are sets (order-irrelevant) where `undefined` ≡ `[]` (both mean "no entries").
 * `allowed` is different: an absent allow-list (`undefined`) means "allow all",
 * but an explicit empty allow-list (`[]`) means "deny all" — so for `allowed`,
 * absent and empty are NOT equal (otherwise editing `mcp.allowed` to `[]` would
 * be treated as a no-op and the deny-all never reconciles). `fast-deep-equal`
 * is array-order-sensitive, so sort copies before comparing.
 */
export function mcpGatingEqual(a: McpGating, b: McpGating): boolean {
  const norm = (xs: string[] | undefined) => [...(xs ?? [])].sort();
  const allowedEqual =
    (a.allowed === undefined) === (b.allowed === undefined) &&
    equal(norm(a.allowed), norm(b.allowed));
  return (
    equal(norm(a.excluded), norm(b.excluded)) &&
    allowedEqual &&
    equal(norm(a.pending), norm(b.pending))
  );
}

/**
 * Recompute the connection-admission lists from the *current* settings. Runtime
 * edits to `mcp.allowed` / `mcp.excluded` take effect immediately, with two
 * deliberate rules:
 *
 * - **`allowed` empty vs absent**: an absent `mcp.allowed` means "allow all"
 *   (`undefined`); an explicit `mcp.allowed: []` means "deny all" (`[]` is
 *   preserved, NOT collapsed to `undefined`), matching the boot-time semantics
 *   of `getMcpServers()` (an empty allow-list filters everything out).
 * - **CLI allow-list is an upper bound (K)**: if launched with
 *   `--allowed-mcp-server-names`, `bootAllowed` is that flag value and the
 *   settings-derived allow-list is intersected with it — a settings edit may
 *   narrow within the launch bound but never widen beyond it. With no settings
 *   allow-list, the boot bound applies in full. Without the flag (`bootAllowed`
 *   undefined), settings fully drive admission.
 *
 * The pending list is always recomputed per #4615 so a hot-reload never
 * connects an unapproved gated server.
 */
export function recomputeMcpGating(
  settings: LoadedSettings,
  assembled: Record<string, MCPServerConfig>,
  cwd: string,
  bootAllowed: readonly string[] | undefined,
  isYolo: boolean,
): McpGating {
  // Preserve `[]` (deny-all); only an absent key yields `undefined` (allow-all).
  const settingsAllowed = settings.merged.mcp?.allowed?.filter(Boolean);
  const excluded = settings.merged.mcp?.excluded?.filter(Boolean);
  let allowed = settingsAllowed;
  if (bootAllowed) {
    allowed = settingsAllowed
      ? settingsAllowed.filter((n) => bootAllowed.includes(n))
      : [...bootAllowed];
  }
  return {
    allowed,
    excluded: excluded && excluded.length > 0 ? excluded : undefined,
    pending: isYolo ? undefined : getPendingGatedMcpServers(assembled, cwd),
  };
}

/**
 * Subscribe the running {@link Config} to settings changes so MCP servers
 * reconnect / disconnect / restart without a session restart (issue #3696
 * sub-task 3). Called once at startup, after `settingsWatcher.startWatching()`;
 * returns a disposer that unsubscribes.
 *
 * On each settings change the callback rebuilds the assembled MCP map the same
 * way Config boot did (so top-tier CLI/session servers and `.mcp.json` gating
 * stay correct), recomputes the admission lists, and only reconciles when the
 * servers or the admission lists actually changed — unrelated edits (theme,
 * skills, …) are ignored. The watcher already debounces (300ms) and serializes
 * its listeners; re-entrancy during an in-flight reconcile is coalesced inside
 * `Config.reinitializeMcpServers`.
 */
export function registerMcpHotReload(
  watcher: SettingsWatcher,
  settings: LoadedSettings,
  config: Config,
  topTierMcpServers: Record<string, MCPServerConfig> | undefined,
): () => void {
  debugLogger.debug('registered MCP hot-reload listener on SettingsWatcher');
  return watcher.addChangeListener(async (events) => {
    debugLogger.debug(
      `settings change fired (${events.length} event(s)): ${events
        .map((e) => `${e.scope}:${e.changeType}`)
        .join(', ')}`,
    );
    const cwd = config.getTargetDir();
    // Rebuild exactly the way Config boot did — including top-tier
    // (CLI / session-injected) servers layered above settings + `.mcp.json`.
    const next = assembleMcpServers(
      settings.merged.mcpServers,
      cwd,
      topTierMcpServers,
    );
    const isYolo = config.getApprovalMode() === ApprovalMode.YOLO;
    const nextGating = recomputeMcpGating(
      settings,
      next,
      cwd,
      config.getCliAllowedMcpServerNames(),
      isYolo,
    );

    const prevServers = config.getSettingsMcpServers();
    const prevGating = config.getMcpGating();
    debugLogger.debug(
      `assembled servers: prev=[${Object.keys(prevServers ?? {}).join(
        ', ',
      )}] next=[${Object.keys(next).join(', ')}]`,
    );
    debugLogger.debug(
      `gating next: excluded=[${(nextGating.excluded ?? []).join(
        ', ',
      )}] allowed=[${(nextGating.allowed ?? []).join(
        ', ',
      )}] pending=[${(nextGating.pending ?? []).join(', ')}]`,
    );

    // Gate: reconcile only if the servers OR the admission lists changed.
    // Both unchanged ⇒ this was an MCP-irrelevant edit; bail.
    const serversChanged = !mcpServersEqual(prevServers, next);
    const gatingChanged = !mcpGatingEqual(prevGating, nextGating);
    // Surface the admission lists — a gated server whose config hash changed
    // lands in `pending` and is skipped by discovery (left disconnected), which
    // is otherwise invisible from the server-name diff above. See #4615.
    if (!serversChanged && !gatingChanged) {
      debugLogger.debug(
        'no MCP-relevant change (servers + gating unchanged) — skipping reconcile',
      );
      return;
    }
    debugLogger.debug(
      `MCP-relevant change detected (serversChanged=${serversChanged} gatingChanged=${gatingChanged}) — reconciling`,
    );

    // Gated servers awaiting a (re-)decision after this edit — strictly
    // `pending`, NOT the rejected-inclusive `nextGating.pending`. The startup
    // approval dialog (`useMcpApproval`) only computes its queue on mount, so
    // without this signal a mid-session pend would be silently skipped by
    // discovery with no prompt. We deliberately do NOT diff against the prior
    // pending set by name: a server already listed as `pending` because it was
    // *rejected* must still re-prompt once an edit invalidates that rejection's
    // hash (issue #6 in the hot-reload review). The dialog's `computePending`
    // is the authoritative filter; this is only the "re-evaluate" nudge. See
    // #4615.
    const promptable = getPromptableMcpServers(next, cwd);

    // Push the admission lists BEFORE reconcile — the discovery pass inside
    // reinitializeMcpServers reads them to skip excluded / non-allowed /
    // pending servers.
    config.setExcludedMcpServers(nextGating.excluded ?? []);
    config.setAllowedMcpServers(nextGating.allowed);
    config.setPendingMcpServers(nextGating.pending);

    try {
      await config.reinitializeMcpServers(next);
      const finalStatuses = Object.keys(next)
        .map((name) => `${name}=${getMCPServerStatus(name)}`)
        .join(', ');
      debugLogger.debug(
        `reinitializeMcpServers resolved; final statuses=[${finalStatuses}]`,
      );
    } catch (err) {
      // Keep the full stack on the debug channel for diagnosis…
      debugLogger.error(
        `reinitializeMcpServers threw: ${
          err instanceof Error ? (err.stack ?? err.message) : String(err)
        }`,
      );
      // …but also surface a concise, user-visible notice. `debugLogger.error`
      // only shows under `--debug`, so a failed settings edit would otherwise
      // silently do nothing with no indication anything went wrong. `LogError`
      // is the same channel the CLI already renders to the user.
      appEvents.emit(
        AppEvent.LogError,
        'Failed to reload MCP server settings; existing MCP state may be unchanged. Run with --debug for details.',
      );
    }

    // Prompt for approval AFTER reconcile, so `config.getMcpServers()` (which
    // the dialog reads) already reflects the new map. Emit regardless of
    // reconcile success — a server left pending still needs the user's decision.
    if (!isYolo && promptable.length > 0) {
      debugLogger.debug(
        `gated servers awaiting approval → emitting ${AppEvent.McpPendingApprovalChanged}: [${promptable.join(
          ', ',
        )}]`,
      );
      appEvents.emit(AppEvent.McpPendingApprovalChanged);
    }
  });
}
