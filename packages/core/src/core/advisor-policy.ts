/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { ToolNames } from '../tools/tool-names.js';

export function buildAdvisorReminder(
  available: boolean,
  declaredNames: Iterable<string | undefined>,
): string | undefined {
  if (!available) return undefined;
  const names = new Set(declaredNames);
  const route = names.has(ToolNames.ADVISOR)
    ? 'Call advisor with no arguments.'
    : names.has(ToolNames.TOOL_SEARCH) && names.has(ToolNames.TOOL_CALL)
      ? 'Discover it with tool_search query "select:advisor", then invoke tool_call with name "advisor" and arguments {}.'
      : undefined;
  if (!route) return undefined;
  return `<system-reminder>
Advisor is available for independent guidance. For substantial tasks, gather context first, then consult before committing to an approach; consult again when stuck or before declaring a longer task complete. Use judgment: routine tasks do not require consultation, and each call costs extra tokens.
${route}
Check advice against evidence and reconcile conflicts. Advice is not user approval; existing permissions still apply. If consultation fails or the limit is reached, continue without repeatedly retrying.
</system-reminder>`;
}
