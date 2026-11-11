/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Process-level MCP helpers shared by AppFramework and its product subclass.

import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  createDefaultMcpConnectorMap,
  fileMcpSourceId,
  getVersionSync,
  mcpServerKey,
  McpManager,
  Storage,
  type EnvironmentSanitizationConfig,
  type MCPServerConfig,
  type McpServerRegistration,
} from '@qwen-code/core';
import type { ResourceService } from '@qwen-code/resource';
import type { LoadedSettings } from '../config/settings.js';

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function createMcpManagerSettings(
  settings: LoadedSettings,
): {
  readonly clientVersion: string;
  readonly sanitizationConfig: EnvironmentSanitizationConfig;
} {
  const redaction = settings.merged.security?.environmentVariableRedaction;
  return {
    clientVersion: getVersionSync() ?? 'unknown',
    sanitizationConfig: {
      allowedEnvironmentVariables: redaction?.allowed ?? [],
      blockedEnvironmentVariables: redaction?.blocked ?? [],
      enableEnvironmentVariableRedaction: redaction?.enabled ?? false,
    },
  };
}

export function collectUserMcpRegistrations(
  settings: LoadedSettings,
): McpServerRegistration[] {
  const userServers = settings.user.settings.mcpServers as
    | Record<string, MCPServerConfig>
    | undefined;
  if (!userServers) return [];
  const settingsPath = realpathOrSelf(Storage.getGlobalSettingsPath());
  const source = fileMcpSourceId(settingsPath);
  const rootsDir = dirname(settingsPath);
  return Object.entries(userServers)
    .filter(([, config]) => config.disabled !== true)
    .map(([name, config]) => ({
      key: mcpServerKey(source, name),
      config,
      rootsDir,
    }));
}

export function createDefaultFrameworkMcpManager(
  resourceService: ResourceService,
  clientVersion: string,
  debugMode: boolean,
  sanitizationConfig: EnvironmentSanitizationConfig,
): McpManager {
  return new McpManager(
    resourceService,
    createDefaultMcpConnectorMap(),
    clientVersion,
    debugMode,
    sanitizationConfig,
  );
}
