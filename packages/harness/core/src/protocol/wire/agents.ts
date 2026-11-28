/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Agent definition / info shapes (WIRE).
 */
import type { McpServerConfigForProcessTransport } from './mcp.js';
import type { EffortLevel } from './common.js';
import type { PermissionMode } from './permissions.js';
export type AgentMcpServerSpec = string | Record<string, McpServerConfigForProcessTransport>;
export type AgentDefinition = {
    description: string;
    tools?: string[];
    disallowedTools?: string[];
    prompt: string;
    model?: string;
    mcpServers?: AgentMcpServerSpec[];
    criticalSystemReminder_EXPERIMENTAL?: string;
    skills?: string[];
    initialPrompt?: string;
    maxTurns?: number;
    background?: boolean;
    memory?: 'user' | 'project' | 'local';
    effort?: EffortLevel;
    permissionMode?: PermissionMode;
};
export type AgentInfo = {
    name: string;
    description: string;
    model?: string;
};