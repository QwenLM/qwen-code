/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { threadId } from 'node:worker_threads';

import { InstalledPluginsFileSchemaV2, type PluginScope } from '../schemas.js';
import {
  getInstalledPluginsPath,
  getInstalledPluginsV2Path,
} from '../pluginDirectories.js';
import { writeFileSyncAtomic } from '../../utils/fileWriteUtils.js';
import { runLogger } from '../../utils/runLogger.js';
import {
  logPluginStateReadFailure,
  pluginStateWriteDiagnostics,
} from './pluginStateDiagnostics.js';

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

let cachedState: InstalledPluginsState | null = null;

/**
 * 缓存建立时刻的两文件磁盘指纹（mtime+size，缺失记 absent）。
 *
 * daemon 是跨安装事件常驻的进程，而 installed_plugins_v2.json 的写者可以在
 * 别的进程里（app main 的插件事务、sibling IDE）——它们没有通道调用
 * invalidateInstalledPluginsCache()。缺少跨进程失效协议时，模块级缓存会在
 * 进程启动后冻结：新会话重跑整条 plugins_load 流程，最后一跳却命中冻结快照。
 * 因此读侧在返回缓存前自校验指纹：变了就重读，把「外部写盘」纳入失效通道。
 */
let cachedFingerprint: string | null = null;

/**
 * 两文件协议的磁盘指纹。任一文件 stat 出现 ENOENT 以外的错误时返回 null：
 * 无法判断新鲜度就信任现有缓存（与读路径对瞬态 IO 错误的降级同向），
 * 不让一次 stat 抖动把满缓存打成空状态。
 */
function diskFingerprint(): string | null {
  const segments: string[] = [];
  for (const filePath of [
    getInstalledPluginsV2Path(),
    getInstalledPluginsPath(),
  ]) {
    try {
      const stats = statSync(filePath);
      segments.push(`${stats.mtimeMs}:${stats.size}`);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        segments.push('absent');
        continue;
      }
      return null;
    }
  }
  return segments.join('|');
}

/**
 * Invalidate the in-memory cache.
 * Call after external writes to installed_plugins.json (e.g., reconciler).
 */
export function invalidateInstalledPluginsCache(): void {
  cachedState = null;
  cachedFingerprint = null;
}

/**
 * V2 installation entry for a single scope of a plugin.
 *
 * NOTE: `installed_plugins_v2.json` is shared with the sibling IDE, which may
 * write extra fields the CLI does not model (e.g. `source`). Those unknown
 * fields are intentionally NOT typed here, but are preserved at runtime by the
 * `.passthrough()` on `PluginInstallationEntrySchema` so a whole-state rewrite
 * in `saveInstalledPluginsToDisk` doesn't silently drop them.
 */
export interface PluginInstallationEntry {
  scope: PluginScope;
  installPath: string;
  version?: string;
  installedAt?: string;
  lastUpdated?: string;
  gitCommitSha?: string;
  /** Required for project/local scopes */
  projectPath?: string;
  // ── Enterprise-managed (scope='managed') metadata ──
  /** Organization ID this enterprise plugin belongs to. */
  orgId?: string;
  /** Display name from the installed manifest or enterprise administrator. */
  displayName?: string;
  /** Missing → visible. */
  userVisible?: boolean;
  /** Missing → toggleable. */
  userCanDisable?: boolean;
  /** Package hash as `"sha256:..."`. */
  fileHash?: string;
  /** Downloaded zip size in bytes (informational). */
  fileSize?: number;
}

/**
 * Full installed plugins state (V2 format).
 */
export interface InstalledPluginsState {
  version: 2;
  plugins: Record<string, PluginInstallationEntry[]>;
}

/**
 * Load CLI-owned installed plugins state from disk.
 *
 * Two-file protocol (see `pluginDirectories.getInstalledPluginsV2Path` for
 * the why):
 *
 *  1. **V2 file exists** (`installed_plugins_v2.json`) → parse and return.
 *  2. **V2 missing** → read the legacy shared `installed_plugins.json` ONCE
 *     and migrate **only the array-valued entries** out into V2. Object
 *     entries (written by sibling IDE in V1 shape) are left strictly
 *     untouched in the legacy file. After migration the legacy file is
 *     never written to again.
 *  3. Either file invalid or absent → empty state.
 *
 * Returns empty state on any error so the caller never has to special-case.
 */
export function loadInstalledPluginsFromDisk(): InstalledPluginsState {
  if (cachedState) {
    const fingerprint = diskFingerprint();
    if (fingerprint === null || fingerprint === cachedFingerprint) {
      return cachedState;
    }
    // 磁盘被本进程之外的写者改过：快照作废，走下面的重读。
    cachedState = null;
    cachedFingerprint = null;
  }

  const read = readStateFromDisk();
  if (read.status === 'loaded') {
    cachedState = read.state;
    cachedFingerprint = diskFingerprint();
    return read.state;
  }
  return read.status === 'reset' ? read.state : emptyState();
}

/**
 * Read state straight from disk, bypassing the cached snapshot.
 *
 * Every **write** path must use this. `installed_plugins_v2.json` is shared
 * across concurrently running CLI processes (and the sibling IDE), so a write
 * built on top of `cachedState` can resurrect entries another process already
 * removed: the stale snapshot gets written back wholesale.
 *
 * Returns `null` when the file is present but unreadable. Callers must abandon
 * the write in that case — persisting an empty state would erase every install
 * record over a transient IO error.
 *
 * Note this only bypasses the cache on the way *in*;
 * `saveInstalledPluginsToDisk` still refreshes `cachedState` afterwards.
 */
export function loadInstalledPluginsFresh(): InstalledPluginsState | null {
  const read = readStateFromDisk();
  return read.status === 'unreadable' ? null : read.state;
}

/**
 * `loaded`   — parsed cleanly; safe to cache and to build a write on.
 * `reset`    — file holds nothing recoverable, so overwriting loses nothing,
 *              but don't cache it: a repaired file should be picked up later.
 * `unreadable` — the bytes may be fine and simply couldn't be read right now.
 */
type DiskRead =
  | { status: 'loaded'; state: InstalledPluginsState }
  | { status: 'reset'; state: InstalledPluginsState }
  | { status: 'unreadable' };

function readStateFromDisk(): DiskRead {
  const v2Path = getInstalledPluginsV2Path();

  let raw: string | undefined;
  // Single try/catch with ENOENT recovery — no separate `existsSync` (the
  // TOCTOU window between stat and read is the same code path either way).
  try {
    raw = readFileSync(v2Path, 'utf-8');
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logPluginStateReadFailure(v2Path, undefined, code ?? 'UNKNOWN');
      runLogger.warn(
        `[InstalledPlugins] Failed to load V2: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { status: 'unreadable' };
    }
    // ENOENT → fall through to one-time legacy migration.
  }

  if (raw !== undefined) {
    // Parse failures are classified separately from read failures: content we
    // can't parse holds nothing worth preserving, so writes may heal the file.
    let json: unknown;
    try {
      json = JSON.parse(raw) as unknown;
    } catch (error: unknown) {
      logPluginStateReadFailure(v2Path, raw, 'JSON_INVALID');
      runLogger.warn(
        `[InstalledPlugins] V2 file is not valid JSON, starting fresh: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { status: 'reset', state: emptyState() };
    }

    const v2Result = InstalledPluginsFileSchemaV2.safeParse(json);
    if (v2Result.success) {
      return {
        status: 'loaded',
        state: v2Result.data as InstalledPluginsState,
      };
    }
    // Whole-file parse failed. A single invalid key or entry must NOT wipe
    // every install record ("starting fresh") — salvage the valid ones and
    // only skip the offending keys. See salvageV2State for details.
    logPluginStateReadFailure(v2Path, raw, 'V2_INVALID');
    const salvaged = salvageV2State(json, v2Path);
    if (salvaged) {
      return { status: 'loaded', state: salvaged };
    }
    runLogger.warn(
      `[InstalledPlugins] V2 file present but unparseable, starting fresh: ${v2Path}`,
    );
    return { status: 'reset', state: emptyState() };
  }

  // ── one-time migration from the legacy shared file ──
  const migrated = migrateLegacyArrayEntriesToV2();
  if (migrated !== null) {
    saveInstalledPluginsToDisk(migrated, 'legacy-migration');
    return { status: 'loaded', state: migrated };
  }

  // No V2, nothing to migrate from legacy. Cache empty state so the next
  // call (and there are many — every plugin install/list/sync query goes
  // through here) doesn't re-issue ENOENT syscalls for both files. CLI only
  // ever writes V2 in this process, so the legacy file can't grow new
  // array-shaped entries we'd want to migrate later.
  return { status: 'loaded', state: emptyState() };
}

/**
 * Read the legacy `installed_plugins.json` once and pick out **only** the
 * entries whose value is an array — those are CLI-style V2 records left
 * behind by an earlier session before the V2 file split. Object-valued
 * entries (IDE / V1 shape) are intentionally skipped and remain in the
 * legacy file. Returns `null` if there is nothing to migrate.
 *
 * **Critical**: do NOT guess record ownership by pluginId / marketplace /
 * version field — IDE and CLI may share those — only by the runtime shape.
 */
function migrateLegacyArrayEntriesToV2(): InstalledPluginsState | null {
  const legacyPath = getInstalledPluginsPath();
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(legacyPath, 'utf-8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    runLogger.warn(
      `[InstalledPlugins] Legacy file unreadable, skipping migration: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }

  const root = json as { plugins?: Record<string, unknown> } | null;
  const legacyPlugins = root?.plugins;
  if (!legacyPlugins || typeof legacyPlugins !== 'object') return null;

  const state = emptyState();
  let migratedCount = 0;
  for (const [pluginId, value] of Object.entries(legacyPlugins)) {
    if (Array.isArray(value)) {
      // V2-shaped record left in the shared file by an older CLI build.
      // Re-parse defensively via the schema; drop entries the schema rejects.
      const parsed = InstalledPluginsFileSchemaV2.safeParse({
        version: 2,
        plugins: { [pluginId]: value },
      });
      if (parsed.success) {
        state.plugins[pluginId] = parsed.data.plugins[pluginId] as
          | PluginInstallationEntry[];
        migratedCount++;
      } else {
        runLogger.warn(
          `[InstalledPlugins] Legacy array entry for "${pluginId}" failed V2 schema; skipping`,
        );
      }
    } else if (value && typeof value === 'object') {
      // IDE / V1 plain-object record — leave for IDE.
    } else {
      runLogger.warn(
        `[InstalledPlugins] Legacy entry for "${pluginId}" has unexpected shape (${typeof value}); skipping`,
      );
    }
  }

  if (migratedCount === 0) return null;
  runLogger.debug(
    `[InstalledPlugins] Migrated ${migratedCount} array-shaped entries from legacy file to V2`,
  );
  return state;
}

/**
 * Best-effort recovery when the whole-file V2 schema parse fails.
 *
 * A malformed or forward-written plugin id / entry must not make one bad key
 * erase the entire installed state. Rejecting the whole file caused startup
 * reconciliation to treat every enabled plugin as missing and reinstall it.
 *
 * Strategy: if the root still looks like a V2 state (`version: 2` plus a
 * `plugins` object), re-validate each key individually through the schema
 * and keep the valid ones. Invalid keys are skipped (with a warning) but are
 * NOT deleted from disk here — they survive until the next legitimate
 * whole-state save.
 *
 * Returns `null` when the root shape is not V2-like or nothing is
 * salvageable, in which case the caller falls back to "starting fresh".
 */
function salvageV2State(
  json: unknown,
  filePath: string,
): InstalledPluginsState | null {
  const root = json as { version?: unknown; plugins?: unknown } | null;
  if (
    !root ||
    typeof root !== 'object' ||
    root.version !== 2 ||
    !root.plugins ||
    typeof root.plugins !== 'object' ||
    Array.isArray(root.plugins)
  ) {
    return null;
  }

  const state = emptyState();
  const skipped: string[] = [];
  for (const [pluginId, value] of Object.entries(
    root.plugins as Record<string, unknown>,
  )) {
    const parsed = InstalledPluginsFileSchemaV2.safeParse({
      version: 2,
      plugins: { [pluginId]: value },
    });
    if (parsed.success) {
      state.plugins[pluginId] = parsed.data.plugins[
        pluginId
      ] as PluginInstallationEntry[];
    } else {
      skipped.push(pluginId);
    }
  }

  if (Object.keys(state.plugins).length === 0) return null;
  if (skipped.length > 0) {
    runLogger.warn(
      `[InstalledPlugins] V2 file has ${skipped.length} invalid entr${skipped.length === 1 ? 'y' : 'ies'} (${skipped.join(', ')}); keeping the ${Object.keys(state.plugins).length} valid one(s): ${filePath}`,
    );
  }
  return state;
}

/**
 * Save installed plugins state to the CLI-owned V2 file.
 *
 * **Never writes to `installed_plugins.json`** — that file is owned by the
 * sibling IDE product (see `loadInstalledPluginsFromDisk` for the rationale).
 */
export function saveInstalledPluginsToDisk(
  state: InstalledPluginsState,
  reason = 'direct-save',
): void {
  const filePath = getInstalledPluginsV2Path();
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    // Atomic write (temp + rename) — the V2 file is the canonical CLI plugin
    // state. A crash mid-write would otherwise truncate it and trigger the
    // "V2 unparseable, starting fresh" branch in `loadInstalledPluginsFromDisk`,
    // silently wiping every install record.
    writeFileSyncAtomic(filePath, JSON.stringify(state, null, 2), {
      encoding: 'utf8',
      onDiagnostic: pluginStateWriteDiagnostics(reason),
    });
    cachedState = state;
    cachedFingerprint = diskFingerprint();
  } catch (error) {
    runLogger.warn(
      `[InstalledPlugins] Failed to save: ${error instanceof Error ? error.message : String(error)}`,
      {
        reason,
        pid: process.pid,
        threadId,
        errorCode: (error as NodeJS.ErrnoException)?.code ?? 'UNKNOWN',
      },
    );
  }
}

/**
 * Add or update a plugin installation entry.
 *
 * If the plugin already has an entry at the same scope (and projectPath
 * for project/local scopes), it is replaced. Otherwise a new entry is added.
 *
 * @returns false when the state file could not be read, meaning nothing was
 * recorded. Callers reporting installation success must not swallow this.
 */
export function addPluginInstallation(
  pluginId: string,
  entry: PluginInstallationEntry,
): boolean {
  const state = loadInstalledPluginsFresh();
  if (!state) return false;

  if (!state.plugins[pluginId]) {
    state.plugins[pluginId] = [];
  }

  const entries = state.plugins[pluginId];

  // Find existing entry for same scope+projectPath
  const existingIdx = entries.findIndex(
    (e) =>
      e.scope === entry.scope &&
      (entry.scope === 'project' || entry.scope === 'local'
        ? e.projectPath === entry.projectPath
        : true),
  );

  const previous = entries[existingIdx];
  const reason = !previous
    ? 'plugin-install'
    : previous.version !== entry.version ||
        previous.installPath !== entry.installPath
      ? 'plugin-update'
      : 'plugin-metadata';
  if (existingIdx >= 0) {
    entries[existingIdx] = entry;
  } else {
    entries.push(entry);
  }

  saveInstalledPluginsToDisk(
    state,
    entry.scope === 'managed' ? `enterprise-${reason}` : reason,
  );
  return true;
}

/**
 * Remove a plugin installation entry.
 *
 * @returns true if the plugin has no more installations (fully uninstalled)
 */
export function removePluginInstallation(
  pluginId: string,
  scope: PluginScope,
  projectPath?: string,
): boolean {
  const state = loadInstalledPluginsFresh();
  if (!state) return false;

  if (!state.plugins[pluginId]) return true;

  const entries = state.plugins[pluginId];
  const filtered = entries.filter(
    (e) =>
      !(
        e.scope === scope &&
        (scope === 'project' || scope === 'local'
          ? e.projectPath === projectPath
          : true)
      ),
  );

  if (filtered.length === 0) {
    delete state.plugins[pluginId];
  } else {
    state.plugins[pluginId] = filtered;
  }

  saveInstalledPluginsToDisk(
    state,
    scope === 'managed' ? 'enterprise-uninstall' : 'plugin-uninstall',
  );
  return filtered.length === 0;
}

/**
 * Remove every installed plugin whose id belongs to a marketplace.
 *
 * @returns removed plugin ids and install paths that should be marked orphaned,
 * or `null` when the state file could not be read. `null` must not be treated
 * as "this marketplace had no plugins": callers that go on to forget the
 * marketplace would leave records behind that nothing ever cleans up.
 */
export function removeAllPluginsForMarketplace(
  marketplace: string,
  isPluginExcluded: (pluginId: string) => boolean = () => false,
): {
  removedPluginIds: string[];
  orphanedPaths: string[];
} | null {
  const state = loadInstalledPluginsFresh();
  if (!state) return null;

  const suffix = `@${marketplace}`;
  const { pluginIds: removedPluginIds, orphanedPaths } =
    getInstalledPluginsForMarketplaceFromState(
      state,
      marketplace,
      isPluginExcluded,
    );

  for (const pluginId of Object.keys(state.plugins)) {
    if (!pluginId.endsWith(suffix)) continue;
    if (isPluginExcluded(pluginId)) continue;

    delete state.plugins[pluginId];
  }

  if (removedPluginIds.length > 0) {
    saveInstalledPluginsToDisk(state, 'marketplace-remove');
  }

  return { removedPluginIds, orphanedPaths };
}

export function getInstalledPluginsForMarketplace(
  marketplace: string,
  isPluginExcluded: (pluginId: string) => boolean = () => false,
): {
  pluginIds: string[];
  orphanedPaths: string[];
  installationCount: number;
} {
  return getInstalledPluginsForMarketplaceFromState(
    loadInstalledPluginsFromDisk(),
    marketplace,
    isPluginExcluded,
  );
}

function getInstalledPluginsForMarketplaceFromState(
  state: InstalledPluginsState,
  marketplace: string,
  isPluginExcluded: (pluginId: string) => boolean,
): {
  pluginIds: string[];
  orphanedPaths: string[];
  installationCount: number;
} {
  const suffix = `@${marketplace}`;
  const pluginIds: string[] = [];
  const orphanedPaths = new Set<string>();
  let installationCount = 0;

  for (const [pluginId, entries] of Object.entries(state.plugins)) {
    if (!pluginId.endsWith(suffix)) continue;
    if (isPluginExcluded(pluginId)) continue;

    pluginIds.push(pluginId);
    installationCount += entries.length;
    for (const entry of entries) {
      if (entry.installPath) {
        orphanedPaths.add(entry.installPath);
      }
    }
  }

  return {
    pluginIds,
    orphanedPaths: [...orphanedPaths],
    installationCount,
  };
}

/**
 * Check if a plugin is installed at any scope.
 */
export function isPluginInstalled(pluginId: string): boolean {
  const state = loadInstalledPluginsFromDisk();
  return !!state.plugins[pluginId] && state.plugins[pluginId].length > 0;
}

/**
 * Check if a plugin is installed with a scope applicable to the given cwd.
 *
 * Unlike {@link isPluginInstalled} which returns true for ANY record
 * regardless of scope/projectPath, this function only returns true when at
 * least one installation entry applies to the current working directory:
 *  - `user` / `managed` / `builtin` / `flag` entries always apply
 *  - `project` / `local` entries apply only when their `projectPath` matches
 *    (or is a parent of) `cwd`
 *
 * This is used by the Discover tab and `plugins list` available-rows builder
 * so that a plugin installed with `-s local` in project A is NOT hidden from
 * Discover in project B (it is only "installed" for project A, not B).
 */
export function isPluginInstalledForCwd(
  pluginId: string,
  cwd: string,
): boolean {
  const state = loadInstalledPluginsFromDisk();
  const entries = state.plugins[pluginId];
  if (!entries || entries.length === 0) return false;
  return entries.some((entry) => {
    if (entry.scope !== 'project' && entry.scope !== 'local') return true;
    return projectPathMatches(entry.projectPath, cwd);
  });
}

/**
 * Get all installation entries for a plugin.
 */
export function getPluginInstallations(
  pluginId: string,
): PluginInstallationEntry[] {
  const state = loadInstalledPluginsFromDisk();
  return state.plugins[pluginId] ?? [];
}

/**
 * Mutation entrypoints must gate on this: deciding whether to update or
 * uninstall from a cached snapshot can act on a plugin another process already
 * removed.
 */
export function getPluginInstallationsFresh(
  pluginId: string,
): PluginInstallationEntry[] {
  return loadInstalledPluginsFresh()?.plugins[pluginId] ?? [];
}

// ---------------------------------------------------------------------------
// Enterprise plugin helpers
// ---------------------------------------------------------------------------

/**
 * Whether a plugin entry should appear in user-facing plugin lists.
 *
 * Enterprise plugins with `userVisible === false` are silently active —
 * hooks/rules/MCP run, but they don't show up in the TUI plugin browser
 * or `plugins list`.
 */
export function isPluginUserVisibleInList(
  entry: PluginInstallationEntry,
): boolean {
  if (entry.scope !== 'managed') return true;
  return entry.userVisible !== false;
}

/**
 * Whether a managed plugin entry is "locked" — i.e. the user has no way to
 * toggle its disabled state.
 *
 * `userVisible=false` implies locked because there's no UI affordance to
 * re-enable it; `userCanDisable=false` is the explicit admin signal.
 * For non-managed entries this always returns false.
 *
 * Single source of truth for the rule applied by the loader (force enabled),
 * `setPluginEnabledOp` (reject disable), and the list renderers (show as
 * "enabled" regardless of settings).
 */
export function isManagedLocked(entry: PluginInstallationEntry): boolean {
  if (entry.scope !== 'managed') return false;
  return entry.userCanDisable === false || entry.userVisible === false;
}

/**
 * Bare names ("foo" in `foo@marketplace`) that are claimed by a managed entry
 * for the given `(orgId, enterpriseMarketplace)` namespace.
 *
 * Used by list renderers to hide user/project plugins that are shadowed by an
 * enterprise plugin of the same bare name (the user copy is inert because
 * `loadEnterprisePluginForCurrentOrg` always wins). Returns an empty set when
 * `orgId` is null so the caller can short-circuit the filter.
 */
export function getManagedShadowedNames(
  orgId: string | null,
  enterpriseMarketplace: string | null,
  state = loadInstalledPluginsFromDisk(),
): Set<string> {
  const names = new Set<string>();
  if (!orgId || !enterpriseMarketplace) return names;
  const suffix = `@${enterpriseMarketplace}`;
  for (const [pluginId, entries] of Object.entries(state.plugins)) {
    if (!pluginId.endsWith(suffix)) continue;
    if (!entries.some((e) => e.scope === 'managed' && e.orgId === orgId))
      continue;
    names.add(pluginId.slice(0, pluginId.length - suffix.length));
  }
  return names;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Check whether an installation entry's projectPath applies to the given cwd.
 *
 * Mirrors the `projectPathApplies` logic in `pluginRuntimeState.ts`:
 * `undefined` projectPath → applies everywhere; otherwise the cwd must be
 * equal to or a subdirectory of the entry's projectPath.
 */
function projectPathMatches(
  entryProjectPath: string | undefined,
  cwd: string,
): boolean {
  if (!entryProjectPath) return true;
  const entryPath = resolve(entryProjectPath);
  const currentPath = resolve(cwd);
  return (
    currentPath === entryPath ||
    currentPath.startsWith(`${entryPath}${sep}`)
  );
}

function emptyState(): InstalledPluginsState {
  return { version: 2, plugins: {} };
}

/** Refresh metadata without replacing concurrently updated installation records. */
export function refreshPluginDisplayName(
  pluginId: string,
  installPath: string,
  displayName: string | undefined,
): void {
  const state = loadInstalledPluginsFresh();
  if (!state) return;
  let changed = false;
  for (const entry of state.plugins[pluginId] ?? []) {
    if (
      entry.scope === 'managed' ||
      entry.installPath !== installPath ||
      entry.displayName === displayName
    )
      continue;
    if (displayName === undefined) delete entry.displayName;
    else entry.displayName = displayName;
    changed = true;
  }
  if (changed) saveInstalledPluginsToDisk(state, 'display-name-refresh');
}
