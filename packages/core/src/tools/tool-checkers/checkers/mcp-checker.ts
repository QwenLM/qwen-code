/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Permission check for one directly registered (eager) MCP tool.
 *
 * MCP rules are written against a tool's qualified name — `mcp__server__tool`,
 * `mcp__server__*`, `mcp__*` — and that name is not always the name the call is
 * made under: a directly registered tool carries its identity on the instance,
 * and the lazy dispatcher (see `mcp-call-checker.ts`) is invoked as one tool
 * with the qualified name in its input. Both therefore re-filter the rule set
 * under the qualified name rather than trusting the name the request arrived
 * with; otherwise `mcp__server__*` rules would be filtered out before the
 * check ever saw them.
 *
 * The two suggestions offered on the prompt are why MCP needs a check of its own
 * rather than a bare ask: approving one tool and trusting a whole server are
 * different grants, and only this module knows how to spell either.
 */

import {
  composeMcpRuleName,
  composeMcpServerWildcard,
  rulesForToolName,
} from '../../../permissions/manager/decision/index.js';
import type { ToolCheckContext } from '../../../permissions/manager/decision/index.js';
import { suggestAllow, type ToolPermissionReason } from '../checker-reasons.js';
import { normalizeMcpSegment } from '../../../mcp/tools/mcp-names.js';
import {
  askByRule,
  checkManagedToolRules,
  denyByRule,
  firstRule,
  type HostToolChecker,
  type HostToolCheckContext,
  type ToolPermissionResult,
} from '../rule-precedence.js';

/** The identity of one MCP tool, as its rules name it. */
export interface McpToolIdentity {
  serverName: string;
  toolName: string;
}

/**
 * Decide a call whose qualified name is known. Rules apply under that name;
 * absent one, the prompt offers this tool or the whole server. Shared with the
 * lazy dispatcher's check.
 */
export function judgeQualified(
  qualifiedName: string,
  serverName: string,
  toolName: string,
  context: Pick<HostToolCheckContext, 'rules' | 'globalRules'>,
): ToolPermissionResult {
  const managed = checkManagedToolRules(qualifiedName, context.globalRules);
  if (managed?.kind === 'deny') return managed;
  const rulesForQualified = rulesForToolName(context.rules, qualifiedName);
  const deny = firstRule(rulesForQualified.toolLevel.deny);
  if (deny) {
    return denyByRule(qualifiedName, deny);
  }
  if (managed) return managed;
  const ask = firstRule(rulesForQualified.toolLevel.ask);
  if (ask) {
    return askByRule(qualifiedName, ask);
  }
  if (firstRule(rulesForQualified.toolLevel.allow)) {
    return { kind: 'allow', extra: { decisionPoint: 'mcp.rule.allow' } };
  }

  return {
    kind: 'ask',
    reason: {
      message: `Allow MCP tool ${serverName}/${toolName}?`,
      attribution: { type: 'other', reason: 'no rule covers this MCP tool' },
      decisionPoint: 'mcp.no_rule.ask',
    },
    suggestions: [
      suggestAllow({ toolName: qualifiedName }),
      suggestAllow({
        toolName: composeMcpServerWildcard(normalizeMcpSegment(serverName)),
      }),
    ],
  };
}

/**
 * Refuse a call that cannot name the MCP tool it targets. Shared with the lazy
 * dispatcher's check.
 */
export function denyWithoutIdentity(
  message: string,
  decisionPoint: string,
): ToolPermissionResult {
  return {
    kind: 'deny',
    extra: {
      decisionPoint,
      denialReason: {
        message,
        attribution: { type: 'other', reason: message },
        denialKind: 'permission-rule',
        decisionPoint,
      },
    },
  };
}

/**
 * The check for one directly registered MCP tool. Its identity comes from the
 * tool instance and is closed over at registration — MCP arguments follow the
 * server's own schema and never carry it.
 */
export function createMcpToolChecker(
  identity: McpToolIdentity,
): HostToolChecker {
  const qualifiedName = composeMcpRuleName(
    normalizeMcpSegment(identity.serverName),
    normalizeMcpSegment(identity.toolName),
  );
  return {
    check(
      _input: Record<string, unknown>,
      ctx: ToolCheckContext<ToolPermissionReason>,
    ): ToolPermissionResult {
      return judgeQualified(
        qualifiedName,
        identity.serverName,
        identity.toolName,
        ctx,
      );
    },
  };
}
