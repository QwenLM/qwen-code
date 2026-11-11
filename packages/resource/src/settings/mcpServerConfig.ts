/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MCPOAuthConfig } from './settingsValueTypes.js';
import type { AuthProviderType } from './settingsEnums.js';

// Structural settings view; constructors and SDK helpers remain in Core.
export interface McpPluginOwner {
  name: string;
  path: string;
  id: string;
  mcpServers?: Record<string, MCPServerConfig>;
}

export type McpServerScope = 'user' | 'local' | 'project' | 'flag' | 'dynamic';

export interface McpToolRuntimeOverride {
  exposedName?: string;
  alwaysLoad?: boolean;
}

export interface MCPServerConfig {
  readonly command?: string;
  readonly args?: string[];
  readonly env?: Record<string, string>;
  readonly cwd?: string;
  readonly url?: string;
  readonly httpUrl?: string;
  readonly headers?: Record<string, string>;
  readonly tcp?: string;
  readonly type?: 'sse' | 'http' | 'ws' | 'sdk';
  readonly timeout?: number;
  readonly trust?: boolean;
  readonly description?: string;
  readonly includeTools?: string[];
  readonly excludeTools?: string[];
  readonly plugin?: McpPluginOwner;
  readonly oauth?: MCPOAuthConfig;
  readonly authProviderType?: AuthProviderType;
  readonly headersHelper?: string;
  readonly disabled?: boolean;
  readonly deferred?: boolean;
  readonly alwaysAllow?: string[];
  readonly scope?: McpServerScope;
  readonly toolOverrides?: Record<string, McpToolRuntimeOverride>;
}
