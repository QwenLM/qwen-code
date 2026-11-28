/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Wire-level MCP types.
 *
 * The SDK-side `McpSdkServerConfigWithInstance` (which carries a runtime
 * `McpServer` instance) is NOT here — that's SDK-local. Only configuration
 * shapes that travel across the CLI ↔ SDK JSONL boundary live in this file.
 */
export type McpStdioServerConfig = {
    type?: 'stdio';
    command: string;
    args?: string[];
    env?: Record<string, string>;
};
export type McpSSEServerConfig = {
    type: 'sse';
    url: string;
    headers?: Record<string, string>;
};
export type McpHttpServerConfig = {
    type: 'http';
    url: string;
    headers?: Record<string, string>;
};
export type McpSdkServerConfig = {
    type: 'sdk';
    name: string;
};
export type McpClaudeAIProxyServerConfig = {
    type: 'claudeai-proxy';
    url: string;
    id: string;
};
export type McpServerConfigForProcessTransport = McpStdioServerConfig | McpSSEServerConfig | McpHttpServerConfig | McpSdkServerConfig;
export type McpServerStatus = {
    name: string;
    status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
    serverInfo?: {
        name: string;
        version: string;
    };
    error?: string;
    config?: McpServerStatusConfig;
    scope?: string;
    tools?: Array<{
        name: string;
        description?: string;
        annotations?: {
            readOnly?: boolean;
            destructive?: boolean;
            openWorld?: boolean;
        };
    }>;
};
export type McpServerStatusConfig = McpServerConfigForProcessTransport | McpClaudeAIProxyServerConfig;
export type McpSetServersResult = {
    added: string[];
    removed: string[];
    errors: Record<string, string>;
};
export type OAuthToken = {
    accessToken: string;
    refreshToken?: string;
    tokenType?: string;
    expiresAt?: number;
    scope?: string;
};