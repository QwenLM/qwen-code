/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Control Context
 *
 * Shared context for control plane communication, providing access to
 * session state, configuration, and I/O without prop drilling.
 */

import type { Config, MCPServerConfig } from '@qwen-code/qwen-code-core';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { StreamJson } from '../StreamJson.js';
import type { PermissionMode } from '../../types/protocol.js';

/**
 * Control Context interface
 *
 * Provides shared access to session-scoped resources and mutable state
 * for all controllers.
 */
export interface IControlContext {
  readonly config: Config;
  readonly streamJson: StreamJson;
  readonly sessionId: string;
  readonly abortSignal: AbortSignal;
  readonly debugMode: boolean;

  permissionMode: PermissionMode;
  sdkMcpServers: Set<string>;
  mcpClients: Map<string, { client: Client; config: MCPServerConfig }>;

  onInterrupt?: () => void;
}

/**
 * Control Context implementation
 */
export class ControlContext implements IControlContext {
  readonly config: Config;
  readonly streamJson: StreamJson;
  readonly sessionId: string;
  readonly abortSignal: AbortSignal;
  readonly debugMode: boolean;

  permissionMode: PermissionMode;
  sdkMcpServers: Set<string>;
  mcpClients: Map<string, { client: Client; config: MCPServerConfig }>;

  onInterrupt?: () => void;

  constructor(options: {
    config: Config;
    streamJson: StreamJson;
    sessionId: string;
    abortSignal: AbortSignal;
    permissionMode?: PermissionMode;
    onInterrupt?: () => void;
  }) {
    this.config = options.config;
    this.streamJson = options.streamJson;
    this.sessionId = options.sessionId;
    this.abortSignal = options.abortSignal;
    this.debugMode = options.config.getDebugMode();
    this.permissionMode = options.permissionMode || 'default';
    this.sdkMcpServers = new Set();
    this.mcpClients = new Map();
    this.onInterrupt = options.onInterrupt;
  }
}
