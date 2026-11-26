/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  PermissionDecision,
  PermissionRequest,
} from './manager/decision/index.js';
import type { SessionPermissionManager } from './manager/session-permission-manager.js';
import type { ToolPermissionReason } from '../tools/tool-checkers/checker-reasons.js';
import { agentToolDenyMatches } from '../tools/agent-tool-constraints.js';
import { MCP_CALL_TOOL_NAME } from '../tools/mcp-lazy/constants.js';
import {
  resolveToolName,
  SHELL_TOOL_NAME,
  POWERSHELL_TOOL_NAME,
} from '../tools/tool-names.js';
import {
  commandMatchesRule,
  stripSafeWrappers,
} from '../tools/shell-permissions/shellPermissions.js';
import { analyzeShellCommand } from '../tools/shell-permissions/shellCommandAnalysis.js';
import {
  getBashClampCommandSegments,
  initializeShellParsers,
} from '../utils/shell-utils.js';

/** A narrowing wrapper: the parent still decides every call that passes it. */
export function constrainAgentPermissions(
  parent: SessionPermissionManager,
  denies: readonly string[],
  bashCommandClamp?: readonly string[],
): SessionPermissionManager {
  if (!denies.length && !bashCommandClamp?.length) return parent;

  const checkConstraint = async (
    request: PermissionRequest,
  ): Promise<PermissionDecision<ToolPermissionReason> | undefined> => {
    let message: string | undefined;
    const lazyTarget = request.input['toolName'];
    const target =
      request.toolName === MCP_CALL_TOOL_NAME && typeof lazyTarget === 'string'
        ? lazyTarget
        : request.toolName;
    if (
      denies.some(
        (rule) =>
          agentToolDenyMatches(rule, request.toolName) ||
          agentToolDenyMatches(rule, target),
      )
    ) {
      message = `Permission to use ${request.toolName} has been denied by this agent's disallowedTools.`;
    } else if (
      bashCommandClamp?.length &&
      resolveToolName(request.toolName) === POWERSHELL_TOOL_NAME
    ) {
      message = `Permission to use PowerShell has been denied by this agent's bashCommandClamp: Bash command restrictions cannot authorize a different interpreter.`;
    } else if (
      bashCommandClamp?.length &&
      resolveToolName(request.toolName) === SHELL_TOOL_NAME
    ) {
      const command = request.input['command'];
      await initializeShellParsers();
      const segments =
        typeof command === 'string'
          ? getBashClampCommandSegments(command)
          : null;
      const analysis =
        typeof command === 'string' ? analyzeShellCommand(command) : null;
      const unverifiable =
        !segments?.length ||
        !analysis ||
        analysis.features.hasNestedExecution ||
        analysis.features.hasUnknownDynamicSyntax;
      const spans = unverifiable
        ? []
        : [...new Set([...analysis.topLevelSegments, ...segments])];
      const unmatched = spans.find(
        (span) =>
          !bashCommandClamp.some((rule) => {
            const content = rule.slice(SHELL_TOOL_NAME.length + 1, -1);
            return (
              commandMatchesRule(span, content, false) ||
              commandMatchesRule(stripSafeWrappers(span), content, false)
            );
          }),
      );
      if (unverifiable || unmatched !== undefined) {
        message = `Permission to use Bash has been denied by this agent's bashCommandClamp: ${unverifiable ? 'the command cannot be verified' : `command '${unmatched}' matches none of the clamped forms`}.`;
      }
    }
    if (!message) return undefined;
    return {
      kind: 'deny',
      decidedBy: 'toolCheck',
      toolName: request.toolName,
      input: request.input,
      toolUseId: request.toolUseId,
      denialMessage: message,
      reason: { message, attribution: { type: 'other', reason: message } },
      toolCheck: { kind: 'deny' },
      history: [],
      stages: [{ stage: 'toolCheck', verdict: 'deny' }],
    };
  };

  const check: SessionPermissionManager['check'] = async (request, context) => {
    const denied = await checkConstraint(request);
    if (denied) return denied;
    const decision = await parent.check(request, context);
    // Hooks/ask handlers can rewrite input; the approved command must also fit.
    if (decision.kind === 'allow') {
      return (
        (await checkConstraint({ ...request, input: decision.input })) ??
        decision
      );
    }
    return decision;
  };
  const constrained = new Proxy(parent, {
    get(target, property) {
      if (property === 'check') return check;
      if (property === 'checkWithChecker') {
        const checkWithChecker: SessionPermissionManager['checkWithChecker'] =
          async (request, checker, override) =>
            (await checkConstraint(request)) ??
            parent.checkWithChecker(request, checker, override);
        return checkWithChecker;
      }
      const value = target[property as keyof SessionPermissionManager];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return constrained;
}
