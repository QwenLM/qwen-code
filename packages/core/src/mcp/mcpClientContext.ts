/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ElicitRequest,
  ElicitResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { EnvironmentSanitizationConfig } from '../services/environmentSanitization.js';
import type { Unsubscribe } from '../utils/workspaceContext.js';

export interface ElicitationBridge {
  requestElicitation(
    serverName: string,
    params: ElicitRequest['params'],
    signal?: AbortSignal,
  ): Promise<ElicitResult>;
  notifyElicitationComplete?(serverName: string, elicitationId: string): void;
}

/** Host services an MCP client needs. */
export interface McpClientContextOptions {
  readonly sanitizationConfig: EnvironmentSanitizationConfig;
  emitDiagnostic(
    severity: 'info' | 'warning' | 'error',
    message: string,
    error?: unknown,
    serverName?: string,
  ): void;
  isTrustedFolder(): boolean;
  /** MCP roots for this connection, resolved by its owner. */
  getRoots?(): readonly string[];
  /** Subscribe to root changes; owners that do not track them may omit this. */
  onRootsChanged?(listener: () => void): Unsubscribe;
}

/**
 * The MCP-side view of its host: sanitization, diagnostics, trust and roots.
 * Owned by the process pool and handed to MCP clients; it is the only surface
 * MCP reads.
 */
export class McpClientContext {
  readonly sanitizationConfig: EnvironmentSanitizationConfig;
  private readonly options: McpClientContextOptions;

  constructor(options: McpClientContextOptions) {
    this.options = options;
    this.sanitizationConfig = options.sanitizationConfig;
  }

  emitMcpDiagnostic(
    severity: 'info' | 'warning' | 'error',
    message: string,
    error?: unknown,
    serverName?: string,
  ): void {
    this.options.emitDiagnostic(severity, message, error, serverName);
  }

  isTrustedFolder(): boolean {
    return this.options.isTrustedFolder();
  }

  getRoots(): readonly string[] | undefined {
    return this.options.getRoots?.();
  }

  onRootsChanged(listener: () => void): Unsubscribe | undefined {
    return this.options.onRootsChanged?.(listener);
  }
}
