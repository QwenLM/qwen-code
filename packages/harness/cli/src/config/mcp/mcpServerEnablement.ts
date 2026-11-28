/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { coreEvents, BRAND_CLI_BIN } from '@qwen-code/core';
import type { LoadedSettings } from '../settings.js';

/**
 * For UI display - combines file and session state.
 */
export interface McpServerDisplayState {
  /** Effective state (considering session override) */
  enabled: boolean;
  /** True if disabled via --session flag */
  isSessionDisabled: boolean;
  /** True if disabled in file */
  isPersistentDisabled: boolean;
}

/**
 * Callback types for enablement checks (passed from CLI to core).
 */
export interface EnablementCallbacks {
  isSessionDisabled: (serverId: string) => boolean;
  isFileEnabled: (serverId: string) => Promise<boolean>;
}

/**
 * Result of canLoadServer check.
 */
export interface ServerLoadResult {
  allowed: boolean;
  reason?: string;
  blockType?:
    | 'allowlist'
    | 'excludelist'
    | 'disabled'
    | 'session'
    | 'enablement';
}

/**
 * Normalize a server ID to canonical lowercase form.
 */
export function normalizeServerId(serverId: string): string {
  return serverId.toLowerCase().trim();
}

/**
 * Check if a server ID is in a settings list (with backward compatibility).
 * Handles case-insensitive matching and plain name fallback for ext: servers.
 */
export function isInSettingsList(
  serverId: string,
  list: string[],
): { found: boolean; deprecationWarning?: string } {
  const normalizedId = normalizeServerId(serverId);
  const normalizedList = list.map(normalizeServerId);

  // Exact canonical match
  if (normalizedList.includes(normalizedId)) {
    return { found: true };
  }

  // Backward compat: for ext: servers, check if plain name matches
  if (normalizedId.startsWith('ext:')) {
    const plainName = normalizedId.split(':').pop();
    if (plainName && normalizedList.includes(plainName)) {
      return {
        found: true,
        deprecationWarning:
          `Settings reference '${plainName}' matches extension server '${serverId}'. ` +
          `Update your settings to use the full identifier '${serverId}' instead.`,
      };
    }
  }

  return { found: false };
}

/**
 * Single source of truth for whether a server can be loaded.
 * Used by: isAllowedMcpServer(), connectServer(), CLI handlers, slash handlers.
 *
 * Uses callbacks instead of direct enablementManager reference to keep
 * packages/core independent of packages/cli.
 */
export async function canLoadServer(
  serverId: string,
  config: {
    allowedList?: string[];
    excludedList?: string[];
    enablement?: EnablementCallbacks;
    serverDisabled?: boolean;
  },
): Promise<ServerLoadResult> {
  const normalizedId = normalizeServerId(serverId);

  // 1. Allowlist check
  if (config.allowedList && config.allowedList.length > 0) {
    const { found, deprecationWarning } = isInSettingsList(
      normalizedId,
      config.allowedList,
    );
    if (deprecationWarning) {
      coreEvents.emitFeedback('warning', deprecationWarning);
    }
    if (!found) {
      return {
        allowed: false,
        reason: `Server '${serverId}' is not in mcp.allowed list. Add it to settings.json mcp.allowed array to enable.`,
        blockType: 'allowlist',
      };
    }
  }

  // 2. Excludelist check
  if (config.excludedList) {
    const { found, deprecationWarning } = isInSettingsList(
      normalizedId,
      config.excludedList,
    );
    if (deprecationWarning) {
      coreEvents.emitFeedback('warning', deprecationWarning);
    }
    if (found) {
      return {
        allowed: false,
        reason: `Server '${serverId}' is blocked by mcp.excluded. Remove it from settings.json mcp.excluded array to enable.`,
        blockType: 'excludelist',
      };
    }
  }

  // 3. Config-level disabled field
  if (config.serverDisabled) {
    return {
      allowed: false,
      reason: `Server '${serverId}' is disabled. Run '${BRAND_CLI_BIN} mcp enable ${serverId}' to enable.`,
      blockType: 'disabled',
    };
  }

  // 4. Session disable check
  if (config.enablement?.isSessionDisabled(normalizedId)) {
    return {
      allowed: false,
      reason: `Server '${serverId}' is disabled for this session. Run '${BRAND_CLI_BIN} mcp enable ${serverId} --session' to clear.`,
      blockType: 'session',
    };
  }

  // 5. File-based enablement check (legacy)
  if (
    config.enablement &&
    !(await config.enablement.isFileEnabled(normalizedId))
  ) {
    return {
      allowed: false,
      reason: `Server '${serverId}' is disabled. Run '${BRAND_CLI_BIN} mcp enable ${serverId}' to enable.`,
      blockType: 'enablement',
    };
  }

  return { allowed: true };
}

/**
 * Look up the merged settings.json view for a server, matching by
 * normalized name. Returns `undefined` if no server with that name is
 * configured. Callers supply their current settings instance.
 */
function findConfiguredServer(
  serverName: string,
  settings: LoadedSettings,
): { name: string; disabled?: boolean } | undefined {
  const merged = settings.merged;
  const servers = merged.mcpServers ?? {};
  const target = normalizeServerId(serverName);
  for (const [name, config] of Object.entries(servers)) {
    if (normalizeServerId(name) === target) {
      return { name, disabled: config.disabled };
    }
  }
  return undefined;
}

/**
 * Read the persistent (file-backed) enabled state for a server. Backed
 * by settings.json's `mcpServers[name].disabled` field — there used to
 * be a separate `mcp-server-enablement.json` file but it has been
 * removed in favour of a single source of truth.
 */
function isPersistentlyEnabled(
  serverName: string,
  settings: LoadedSettings,
): boolean {
  const found = findConfiguredServer(serverName, settings);
  if (!found) return true; // unknown server defaults to enabled
  return found.disabled !== true;
}

/**
 * McpServerEnablementManager
 *
 * Owns the in-memory session-disable state for MCP servers and exposes
 * a small API for UI/runtime checks. Persistent enable/disable goes
 * through `persistentEnableMcpServer` / `persistentDisableMcpServer`,
 * which write the `disabled` field directly into settings.json.
 *
 * NOTE: Use getInstance() to get the singleton instance. This ensures
 * session state (sessionDisabled Set) is shared across all code paths.
 */
export class McpServerEnablementManager {
  private static instance: McpServerEnablementManager | null = null;

  private readonly sessionDisabled = new Set<string>();

  /**
   * Listeners notified when *session* enablement state changes. Consumers
   * (e.g. the MCP browser TUI) use this to re-render without polling.
   *
   * Note: persistent (settings.json) changes go through
   * `persistentEnable/DisableMcpServer` in `localSettings.ts` and do NOT
   * trigger this bus directly. Callers that mutate persistent state
   * should usually follow up with `restartServer()`, which fires the
   * core MCP status listener — UIs should subscribe to both buses.
   */
  private readonly listeners = new Set<() => void>();

  /**
   * Get the singleton instance.
   */
  static getInstance(): McpServerEnablementManager {
    if (!McpServerEnablementManager.instance) {
      McpServerEnablementManager.instance = new McpServerEnablementManager();
    }
    return McpServerEnablementManager.instance;
  }

  /**
   * Reset the singleton instance (for testing only).
   */
  static resetInstance(): void {
    McpServerEnablementManager.instance = null;
  }

  /**
   * Subscribe to session enablement changes. Returns an unsubscribe fn.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  /**
   * Check if server is session-disabled.
   */
  isSessionDisabled(serverName: string): boolean {
    return this.sessionDisabled.has(normalizeServerId(serverName));
  }

  /**
   * Disable a server for current session only (in-memory).
   */
  disableForSession(serverName: string): void {
    const id = normalizeServerId(serverName);
    if (this.sessionDisabled.has(id)) return;
    this.sessionDisabled.add(id);
    this.notify();
  }

  /**
   * Clear session disable for a server.
   */
  clearSessionDisable(serverName: string): void {
    const id = normalizeServerId(serverName);
    if (!this.sessionDisabled.has(id)) return;
    this.sessionDisabled.delete(id);
    this.notify();
  }

  /**
   * Get display state for a specific server (for UI).
   */
  getDisplayState(
    serverName: string,
    settings: LoadedSettings,
  ): McpServerDisplayState {
    const isSessionDisabled = this.isSessionDisabled(serverName);
    const isPersistentDisabled = !isPersistentlyEnabled(serverName, settings);

    return {
      enabled: !isSessionDisabled && !isPersistentDisabled,
      isSessionDisabled,
      isPersistentDisabled,
    };
  }

  /**
   * Get all display states (for UI listing).
   */
  getAllDisplayStates(
    serverIds: string[],
    settings: LoadedSettings,
  ): Record<string, McpServerDisplayState> {
    const result: Record<string, McpServerDisplayState> = {};
    for (const serverId of serverIds) {
      result[normalizeServerId(serverId)] = this.getDisplayState(
        serverId,
        settings,
      );
    }
    return result;
  }

  /**
   * Get enablement callbacks for passing to core.
   *
   * `isFileEnabled` is kept for callback-shape compatibility with the
   * core's mcp-client-manager — it now reads the merged settings.json
   * `disabled` field instead of the legacy enablement.json file.
   */
  getEnablementCallbacks(settings: LoadedSettings): EnablementCallbacks {
    // 回调延迟执行时仍读取创建 Config 时的原项目，不能跟随 Worktree 切换。
    return {
      isSessionDisabled: (id) => this.isSessionDisabled(id),
      isFileEnabled: (id) =>
        Promise.resolve(isPersistentlyEnabled(id, settings)),
    };
  }
}
