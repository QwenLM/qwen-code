/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { OperationGrant } from './managed-extension-record.js';
import type { ManagedSessionKey } from './managed-session-records.js';

export const MANAGED_MCP_PROTOCOL = 'managed-mcp/1';
export const MANAGED_MCP_TOOL = 'managed_mcp_call';
export const MANAGED_MCP_ROUTE = '/internal/managed-runtime/v3/mcp';
export const MANAGED_MCP_MAX_CONNECTIONS = 16;

export type ManagedMcpDiscoveryState =
  | 'complete'
  | 'partial'
  | 'failed'
  | 'stale';

export interface ManagedMcpCatalog {
  readonly serverId: string;
  readonly serverRevision: number;
  readonly definitionDigest: string;
  readonly configRevision: number;
  readonly connectionGeneration: number;
  readonly catalogRevision: number;
  readonly tools: ReadonlyArray<{
    readonly name: string;
    readonly description?: string;
    readonly inputSchema: Record<string, unknown>;
  }>;
  readonly resources: ReadonlyArray<{
    readonly name: string;
    readonly uri: string;
    readonly description?: string;
    readonly mimeType?: string;
  }>;
  readonly prompts: ReadonlyArray<{
    readonly name: string;
    readonly description?: string;
    readonly arguments?: ReadonlyArray<{
      readonly name: string;
      readonly description?: string;
      readonly required?: boolean;
    }>;
  }>;
  readonly discovery: {
    readonly tools: ManagedMcpDiscoveryState;
    readonly resources: ManagedMcpDiscoveryState;
    readonly prompts: ManagedMcpDiscoveryState;
  };
}

interface OperationIdentity {
  readonly sessionKey: ManagedSessionKey;
  readonly operationId: string;
}

interface ServerIdentity {
  readonly serverId: string;
  readonly serverRevision: number;
}

export interface ManagedMcpConfigure extends OperationIdentity, ServerIdentity {
  readonly kind: 'mcp-configure';
  readonly configRevision: number;
  readonly definitionDigest: string;
  readonly grant: OperationGrant;
}

export interface ManagedMcpDiscover extends OperationIdentity, ServerIdentity {
  readonly kind: 'mcp-discover';
  readonly connectionGeneration: number;
  readonly grant: OperationGrant;
}

export interface ManagedMcpInvoke extends OperationIdentity, ServerIdentity {
  readonly kind: 'mcp-invoke';
  readonly configRevision: number;
  readonly connectionGeneration: number;
  readonly catalogRevision: number;
  readonly grant: OperationGrant;
  readonly request:
    | {
        readonly kind: 'tool_call';
        readonly name: string;
        readonly arguments: Record<string, unknown>;
      }
    | { readonly kind: 'resource_read'; readonly uri: string }
    | {
        readonly kind: 'prompt_get';
        readonly name: string;
        readonly arguments: Record<string, string>;
      };
}

export interface ManagedMcpLookup extends OperationIdentity {
  readonly kind: 'mcp-status' | 'mcp-cancel';
  readonly targetOperationId: string;
}

export interface ManagedMcpRelease extends OperationIdentity, ServerIdentity {
  readonly kind: 'mcp-release';
  readonly connectionGeneration: number;
  readonly grant: OperationGrant;
}

export type ManagedMcpControl =
  | ManagedMcpConfigure
  | ManagedMcpDiscover
  | ManagedMcpInvoke
  | ManagedMcpLookup
  | ManagedMcpRelease;

export interface ManagedMcpOperationView {
  readonly operationId: string;
  readonly state: 'running' | 'settled' | 'outcome_unknown';
  readonly catalog?: ManagedMcpCatalog;
  readonly response?: Record<string, unknown>;
  readonly error?: { readonly code: string };
}

export interface ManagedMcpRequest {
  readonly protocolVersion: 1;
  readonly runtimeSessionId: string;
  readonly operation: ManagedMcpControl;
}

export interface ManagedMcpResponse {
  readonly protocolVersion: 1;
  readonly runtimeSessionId: string;
  readonly operation: ManagedMcpOperationView;
}
