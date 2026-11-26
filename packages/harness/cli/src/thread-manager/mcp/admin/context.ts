/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  MCPServerConfig,
  McpManager,
  McpServerRegistration,
  OAuthToken,
} from '@qwen-code/core';
import type { McpAuthMethod, ResolvedMcpServer } from './queries.js';
import type { LoadedSettings } from '../../../config/settings.js';
import { DaemonMcpError } from './errors.js';

/** What the daemon MCP operations need from the process. */
export interface DaemonMcpContext {
  resolveEnterprise?(
    serverId: string,
    allowDisabled?: boolean,
  ): ResolvedMcpServer;
  /** The process-wide pool; undefined in modes that do not run MCP. */
  getMcpManager(): McpManager | undefined;
  /** Product classification of how a server authorizes (oauth/brokered/none). */
  authMethodOf?(config: MCPServerConfig): McpAuthMethod;
  /** User-scope settings, re-read from disk. */
  readUserSettings(): LoadedSettings;
  /** With the server's config, only that server's own identity is read. */
  hasCredentials(
    serverName: string,
    config?: MCPServerConfig,
  ): Promise<boolean>;
  /**
   * Resolves true when some credentials existed. With the config, only that
   * server's own identity (and the keys it may have been stored under) goes;
   * without it, everything stored under the name, leaving plugin identities.
   */
  deleteCredentials(
    serverName: string,
    config?: MCPServerConfig,
  ): Promise<boolean>;
  /**
   * Deletes the stored credentials only while they still hold `token`, so a
   * newer sign-in is never removed. Keeps them when they cannot be read.
   */
  deleteCredentialsIfToken(
    serverName: string,
    token: OAuthToken,
    config?: MCPServerConfig,
  ): Promise<void>;
  /**
   * The user-level registrations (settings entries and user-level plugins)
   * the daemon last gave the pool. Other sessions' servers are not in it.
   */
  userRegistrations(): readonly McpServerRegistration[];
  /**
   * Schedules the user settings after a write; never rejects. Management
   * batches collect connection work separately and wait outside coordination.
   */
  syncPool(): Promise<void>;
}

export function defaultMcpAuthMethod(config: MCPServerConfig): McpAuthMethod {
  return config.url !== undefined || config.httpUrl !== undefined
    ? 'oauth'
    : 'none';
}

export function requireManager(
  source: Pick<DaemonMcpContext, 'getMcpManager'>,
): McpManager {
  const manager = source.getMcpManager();
  if (!manager) {
    throw new DaemonMcpError(
      'MCP_UNAVAILABLE',
      'MCP is not running in this process.',
    );
  }
  return manager;
}
