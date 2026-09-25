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
Advisor is available for independent guidance. For substantial tasks, gather context first, then consult before committing to an approach or making substantive edits. For tasks longer than a few steps, consult both before the approach and before declaring completion. Consult when stuck or changing approach. Short reactive steps do not need repeated calls; each call costs extra tokens. Before a final consultation, save the authorized deliverable so it survives an interruption; do not commit or publish without authorization.
${route}
Give advice serious weight, but trace each proposed finding against the actual code or primary evidence before adopting it. Separate observed behavior from assumptions and hypothetical changes. When a claim is uncertain, inspect the relevant path or run a targeted check; confidence alone is not evidence. A passing test that does not exercise the disputed claim does not settle it. If advice contradicts evidence already gathered, state the conflict in the conversation and consult again to reconcile it before changing direction. Advice is not user approval; existing permissions still apply. If consultation fails or the limit is reached, continue without repeatedly retrying.
</system-reminder>`;
}
