/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Permission checks for the Bash PTY companion tools.
 *
 * Writing to a PTY session is equivalent to executing commands, so it is never
 * the default allow: with no matching rule it leaves a gap-shaped ask that the
 * permission mode resolves (default/acceptEdits prompt, auto classifies,
 * bypassPermissions allows, dontAsk denies), and a tool-level allow rule fills
 * it. Reading output and resizing are observation/viewport only and stay
 * allowed, but keep their own decision points so permission reports can tell
 * them apart.
 */

import { summarizeInputForPermissionMessage } from '../../bash-pty.js';
import {
  alwaysAllowChecker,
  checkToolLevelRules,
  type HostToolChecker,
  type ToolPermissionResult,
} from '../rule-precedence.js';
import {
  BASH_OUTPUT_TOOL_NAME,
  BASH_RESIZE_TOOL_NAME,
} from '../../tool-names.js';

/**
 * Gap-shaped ask: nobody objected, the prompt exists only because nobody
 * vouched. Tool-level rules run first; without a matching rule the mode
 * layer resolves the ask. The dialog renders only the message.
 */
export function createBashInputToolChecker(toolName: string): HostToolChecker {
  return {
    check(input: Record<string, unknown>, ctx): ToolPermissionResult {
      const byRule = checkToolLevelRules(toolName, ctx.rulesForTool);
      if (byRule) {
        return byRule;
      }
      const charsValue = input['chars'];
      const chars = typeof charsValue === 'string' ? charsValue : '';
      const submit = input['submit'] === true;
      return {
        kind: 'ask',
        reason: {
          message: `Send input to Bash PTY session (PID ${input['pid']}): ${summarizeInputForPermissionMessage(chars, submit)}`,
          attribution: {
            type: 'other',
            reason: 'BashInput is independently governed by the permission pipeline',
          },
          decisionPoint: 'bash_pty.input.pass',
        },
        extra: { fillableByAllow: true },
        suggestions: [
          {
            type: 'addRules',
            destination: 'localSettings',
            rules: [{ toolName }],
            behavior: 'allow',
          },
        ],
      };
    },
  };
}

export function createBashOutputToolChecker(
  toolName: string = BASH_OUTPUT_TOOL_NAME,
): HostToolChecker {
  return alwaysAllowChecker(toolName, 'bash_pty.output.allow');
}

export function createBashResizeToolChecker(
  toolName: string = BASH_RESIZE_TOOL_NAME,
): HostToolChecker {
  return alwaysAllowChecker(toolName, 'bash_pty.resize.allow');
}
