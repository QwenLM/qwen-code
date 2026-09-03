/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import equal from 'fast-deep-equal';
import { ApprovalMode } from '@qwen-code/qwen-code-core/config/approval-mode.js';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import type { MCPServerConfig } from '@qwen-code/qwen-code-core/config/mcp-server-config.js';
import { getMCPServerStatus } from '@qwen-code/qwen-code-core/tools/mcp-status.js';
import { createDebugLogger } from '@qwen-code/qwen-code-core/utils/debugLogger.js';
import type { LoadedSettings } from './settings.js';
import type { SettingsWatcher } from './settingsWatcher.js';
import { assembleMcpServers } from './mcpServers.js';
import {
  getPendingGatedMcpServers,
  getPromptableMcpServers,
} from './mcpApprovals.js';
import { appEvents, AppEvent } from '../utils/events.js';

const debugLogger = createDebugLogger('MCP_HOT_RELOAD');
const modelProvidersDebugLogger = createDebugLogger(
  'MODEL_PROVIDERS_HOT_RELOAD',
);

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
    // Bare/safe mode: mirror loadCliConfig's own guard (config.ts) — a live
    // settings.json edit must not smuggle local/ambient MCP servers into an
    // already-running bare/safe-mode session; only the top-tier servers this
    // session started with (explicit, per-invocation, not ambient state)
    // survive.
    const next =
      config.getBareMode() || config.isSafeMode()
        ? { ...topTierMcpServers }
        : assembleMcpServers(
            settings.merged.mcpServers,
            cwd,
            topTierMcpServers,
          );
    const isYolo = config.getApprovalMode() === ApprovalMode.YOLO;
    // Same bare/safe guard as `next` above, applied to the admission lists:
    // `recomputeMcpGating` reads settings.merged.mcp.allowed/excluded
    // unconditionally, with no bare/safe check of its own — a live
    // settings.json edit during an already-running bare/safe session would
    // otherwise smuggle a local-state-sourced allow-list back in, silently
    // filtering the caller's own top-tier server out of `getMcpServers()`
    // mid-session (the same stranded-server class of bug this PR fixes at
    // boot, just reached through the gating list's SOURCE instead of the
    // mcpServers map). Only the CLI `--allowed-mcp-server-names` bound
    // (explicit, per-invocation, not ambient state) still applies, mirroring
    // topTierMcpServers' own treatment; `excluded`/`pending` are irrelevant
    // once nothing but the never-gated top-tier servers can be present.
    const bootAllowed = config.getCliAllowedMcpServerNames();
    const nextGating: McpGating =
      config.getBareMode() || config.isSafeMode()
        ? { allowed: bootAllowed ? [...bootAllowed] : undefined }
        : recomputeMcpGating(settings, next, cwd, bootAllowed, isYolo);

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

/**
 * Subscribe the running {@link Config} to settings changes so `modelProviders`
 * edits take effect without a session restart (issue #10568). Mirrors
 * {@link registerMcpHotReload}: the watcher already debounces and filters out
 * restart-required keys, so this listener only diffs the merged
 * `modelProviders` against the registry's APPLIED config (same design as the
 * MCP listener diffing against `getSettingsMcpServers()`) and calls the
 * existing reload primitive. The diff gate keeps unrelated settings edits
 * (theme, …) from rebuilding the model registry. Called once at startup,
 * after `settingsWatcher.startWatching()`; returns a disposer that
 * unsubscribes.
 *
 * Diffing against applied state (not a listener-local snapshot) keeps the
 * gate correct when other paths rewrite the registry without a watcher event
 * (provider-template updates, ACP session reloads), and means a throwing
 * reload retries on the next event — applied state never advanced. A
 * rejected `refreshAuth` is the one exception: the registry reload has
 * already advanced applied state by then, so a listener-local flag retries
 * only the auth refresh on subsequent events (never the registry reload).
 *
 * `providerProtocol` stays boot-frozen: it is `requiresRestart` in the
 * schema, so this listener does not pass it to the reload primitive.
 */
export function registerModelProvidersHotReload(
  watcher: SettingsWatcher,
  settings: LoadedSettings,
  config: Config,
): () => void {
  modelProvidersDebugLogger.debug(
    'registered modelProviders hot-reload listener on SettingsWatcher',
  );
  // Pending refreshAuth retry after a successful registry reload: the reload
  // already advanced applied state, so the modelProviders gate below would
  // skip every later unchanged event — re-attempt ONLY refreshAuth on
  // subsequent events (never the registry reload) until it succeeds.
  let refreshAuthRetryPending = false;
  const reconcile = async () => {
    const next = settings.merged.modelProviders;
    const providersUnchanged = equal(
      config.getModelProvidersConfig() ?? {},
      next ?? {},
    );
    if (providersUnchanged && !refreshAuthRetryPending) {
      return;
    }
    if (!providersUnchanged) {
      modelProvidersDebugLogger.debug(
        'modelProviders changed — reloading model registry',
      );
      try {
        config.reloadModelProvidersConfig(next);
      } catch (err) {
        // Applied state is unchanged, so the next event retries.
        modelProvidersDebugLogger.error(
          `reloadModelProvidersConfig threw: ${
            err instanceof Error ? (err.stack ?? err.message) : String(err)
          }`,
        );
        return;
      }
    }

    const authType = config.getAuthType();
    if (!authType) {
      return;
    }
    try {
      // `isInitialAuth=true` keeps a watcher-triggered refresh
      // non-interactive: with it, a QWEN_OAUTH session whose cached
      // credentials are unavailable (expired/rotated refresh token,
      // transient network error) rejects with "credentials expired" into the
      // catch below instead of falling through to `authWithQwenDeviceFlow` —
      // an unrequested device-auth prompt mid-session that also stalls
      // ACP/headless runs, where there is no terminal to answer it. Mirrors
      // boot (`performInitialAuth`, packages/cli/src/core/auth.ts).
      await config.refreshAuth(authType, true);
      refreshAuthRetryPending = false;
    } catch (err) {
      // The registry reload above already advanced applied state, so the
      // providers gate skips every later unchanged event — without a retry
      // flag the half-applied state (registry reloaded, active client stale)
      // would persist until another modelProviders edit or a restart.
      refreshAuthRetryPending = true;
      modelProvidersDebugLogger.error(
        `refreshAuth after modelProviders reload threw: ${
          err instanceof Error ? (err.stack ?? err.message) : String(err)
        }`,
      );
    }
  };
  // Reconcile once at registration: the watcher is armed before
  // loadCliConfig resolves, so an edit that lands in that window has
  // already refreshed settings.merged with no listener attached — without
  // this the registry would silently keep the pre-edit boot value.
  void reconcile();
  return watcher.addChangeListener(reconcile);
}
