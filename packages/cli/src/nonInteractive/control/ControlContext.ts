/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Control Context
 *
 * Layer 1 of the control plane architecture. Provides shared, session-scoped
 * state for all controllers and services, eliminating the need for prop
 * drilling. Mutable fields are intentionally exposed so controllers can track
 * runtime state (e.g. permission mode, active MCP clients).
 */

import type { Config, MCPServerConfig } from '@qwen-code/qwen-code-core';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { StreamJsonOutputAdapter } from '../io/StreamJsonOutputAdapter.js';
import type { PermissionMode } from '../types.js';

/**
 * Control Context interface
 *
 * Provides shared access to session-scoped resources and mutable state
 * for all controllers across both ControlDispatcher (protocol routing) and
 * ControlService (programmatic API).
 */
export interface IControlContext {
  readonly config: Config;
  readonly streamJson: StreamJsonOutputAdapter;
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
  readonly streamJson: StreamJsonOutputAdapter;
  readonly sessionId: string;
  readonly abortSignal: AbortSignal;
  readonly debugMode: boolean;

  permissionMode: PermissionMode;
  sdkMcpServers: Set<string>;
  mcpClients: Map<string, { client: Client; config: MCPServerConfig }>;

  onInterrupt?: () => void;

  constructor(options: {
    config: Config;
    streamJson: StreamJsonOutputAdapter;
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
