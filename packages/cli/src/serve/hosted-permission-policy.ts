/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { PermissionManager } from '@qwen-code/qwen-code-core/permissions/permission-manager.js';
import { buildPermissionCheckContext } from '@qwen-code/qwen-code-core/core/permission-helpers.js';
import type { PermissionDecision } from '@qwen-code/qwen-code-core/permissions/types.js';
import type { ManagedPermissionRules } from '@qwen-code/qwen-code-core/managed-runtime/managed-permission-rules.js';
import type { ToolCallRequestInfo } from '@qwen-code/qwen-code-core/core/turn.js';

export interface HostedMcpPermissionIdentity {
  readonly serverName: string;
  readonly serverToolName: string;
}

export async function evaluateHostedPermissionRules(
  rules: ManagedPermissionRules | undefined,
  call: ToolCallRequestInfo,
  mcpIdentity?: HostedMcpPermissionIdentity,
  mcpIdentities: readonly HostedMcpPermissionIdentity[] = [],
): Promise<PermissionDecision> {
  if (!rules) return 'default';
  const manager = new PermissionManager({
    getPermissionsAllow: () => [...rules.allow],
    getPermissionsAsk: () => [...rules.ask],
    getPermissionsDeny: () => [...rules.deny],
    // The remote Shell's unresolved segments require approval. Never inspect
    // the Harness host to classify the remote filesystem or working directory.
    getShellExecutionSandbox: () => true,
    getProjectRoot: () => '/',
    getCwd: () => '/',
    getToolRegistry: () => ({
      getMcpToolIdentities: () => [...mcpIdentities],
    }),
  });
  manager.initialize();
  const name = mcpIdentity
    ? `mcp__${mcpIdentity.serverName}__${mcpIdentity.serverToolName}`
    : call.name;
  const context = buildPermissionCheckContext(
    name,
    call.args,
    '/',
    undefined,
    mcpIdentity,
  );
  return manager.hasRelevantRules(context)
    ? manager.evaluate(context)
    : 'default';
}
