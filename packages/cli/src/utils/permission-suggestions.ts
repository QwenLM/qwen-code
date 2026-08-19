/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PermissionSuggestion } from '../nonInteractive/types.js';

function withWarnings(
  description: string,
  details: Record<string, unknown>,
): string {
  const prefixes: string[] = [];
  // A PreToolUse hook escalated this call (#9434): surface the hook's
  // reason on the non-TUI permission surfaces too, so a hook-forced
  // prompt is distinguishable from an ordinary one off-TUI.
  const hookAskReason = details['hookAskReason'];
  if (typeof hookAskReason === 'string' && hookAskReason.length > 0) {
    prefixes.push(`Hook requested confirmation: ${hookAskReason}`);
  }
  const warnings = Array.isArray(details['warnings'])
    ? details['warnings'].filter(
        (warning): warning is string => typeof warning === 'string',
      )
    : [];
  if (warnings.length > 0) {
    prefixes.push(warnings.join('\n'));
  }
  return prefixes.length > 0
    ? `${prefixes.join('\n')}\n${description}`
    : description;
}

export function buildPermissionSuggestions(
  confirmationDetails: unknown,
): PermissionSuggestion[] | null {
  if (
    !confirmationDetails ||
    typeof confirmationDetails !== 'object' ||
    !('type' in confirmationDetails)
  ) {
    return null;
  }

  const details = confirmationDetails as Record<string, unknown>;
  const type = String(details['type'] ?? '');
  const title =
    typeof details['title'] === 'string' ? details['title'] : undefined;

  switch (type) {
    case 'exec':
      return [
        {
          type: 'allow',
          label: 'Allow Command',
          description: withWarnings(`Execute: ${details['command']}`, details),
        },
        {
          type: 'deny',
          label: 'Deny',
          description: 'Block this command execution',
        },
      ];
    case 'edit':
      return [
        {
          type: 'allow',
          label: 'Allow Edit',
          description: withWarnings(
            `Edit file: ${details['fileName']}`,
            details,
          ),
        },
        {
          type: 'deny',
          label: 'Deny',
          description: 'Block this file edit',
        },
        ...(details['hideModify'] === true
          ? []
          : [
              {
                type: 'modify' as const,
                label: 'Review Changes',
                description: 'Review the proposed changes before applying',
              },
            ]),
      ];
    case 'plan':
      return [
        {
          type: 'allow',
          label: 'Approve Plan',
          description: title || 'Execute the proposed plan',
        },
        {
          type: 'deny',
          label: 'Reject Plan',
          description: 'Do not execute this plan',
        },
      ];
    case 'mcp':
      return [
        {
          type: 'allow',
          label: 'Allow MCP Call',
          description: `${details['serverName']}: ${details['toolName']}`,
        },
        {
          type: 'deny',
          label: 'Deny',
          description: 'Block this MCP server call',
        },
      ];
    case 'info':
      return [
        {
          type: 'allow',
          label: 'Allow Info Request',
          description: title || 'Allow information request',
        },
        {
          type: 'deny',
          label: 'Deny',
          description: 'Block this information request',
        },
      ];
    default:
      return [
        {
          type: 'allow',
          label: 'Allow',
          description: title || `Allow ${type} operation`,
        },
        {
          type: 'deny',
          label: 'Deny',
          description: `Block ${type} operation`,
        },
      ];
  }
}
