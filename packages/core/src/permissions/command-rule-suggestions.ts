/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { extractCommandRules } from '../utils/shellAstParser.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import type { ToolExecuteConfirmationDetails } from '../tools/tools.js';
import {
  hasUnsupportedShellSyntax,
  matchesCommandPattern,
} from './rule-parser.js';

const debugLogger = createDebugLogger('PERMISSIONS');

/** Share the same safe, reusable suggestions across shell, monitor and cron. */
export async function suggestCommandRules(
  commands: readonly string[],
  toolName: 'Bash' | 'Monitor',
): Promise<
  Pick<ToolExecuteConfirmationDetails, 'permissionRules' | 'hideAlwaysAllow'>
> {
  const allRules: string[] = [];
  for (const command of commands) {
    if (hasUnsupportedShellSyntax(command)) {
      return { permissionRules: [], hideAlwaysAllow: true };
    }
    let rules: string[] = [];
    try {
      rules = await extractCommandRules(command);
    } catch (error) {
      debugLogger.warn('Failed to extract command rules:', error);
    }
    if (!rules.some((rule) => matchesCommandPattern(rule, command))) {
      // A literal '*' in a raw fallback would become a permission glob.
      if (command.includes('*')) {
        return { permissionRules: [], hideAlwaysAllow: true };
      }
      rules.push(command);
    }
    allRules.push(...rules);
  }
  return {
    permissionRules: [...new Set(allRules)].map(
      (rule) => `${toolName}(${rule})`,
    ),
  };
}
