/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import {
  isToolHiddenBehindToolSearch,
  toolSearchBridgeSentence,
} from '../skills/bundled-reference.js';
import {
  resolveWorkflowAuthoringSurface,
  WORKFLOW_AUTHORING_SKILL_NAME,
  type WorkflowAuthoringSurface,
} from '../skills/workflow-authoring-skill.js';
import { ToolDisplayNames, ToolNames } from '../tools/tool-names.js';
import type { WorkflowTool } from '../tools/workflow/workflow.js';
import { subagentNameContext } from '../utils/subagentNameContext.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('WORKFLOW_INTENT');

export interface HumanPromptInput {
  readonly text: string;
}

export type WorkflowIntentTrigger = 'workflow' | 'ultracode';

export interface WorkflowIntent {
  readonly trigger: WorkflowIntentTrigger;
  readonly reminder: string;
}

const EDGE_PUNCTUATION = /^[.,!?;:'"()[\]{}<>]+|[.,!?;:'"()[\]{}<>]+$/g;

export function detectWorkflowKeyword(text: string): boolean {
  return text
    .toLowerCase()
    .split(/\s+/)
    .some((token) => token.replace(EDGE_PUNCTUATION, '') === 'workflow');
}

const CLOSING_DELIMITERS: Readonly<Record<string, string>> = {
  '`': '`',
  '"': '"',
  "'": "'",
  '(': ')',
  '[': ']',
  '{': '}',
  '<': '>',
};

const isWordCharacter = (character: string | undefined): boolean =>
  character !== undefined && /[\p{L}\p{N}_]/u.test(character);

export function detectUltracodeKeyword(text: string): boolean {
  if (text.startsWith('/') || !/ultracode/i.test(text)) return false;
  const quotedRanges: Array<readonly [number, number]> = [];
  let opener: string | undefined;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (opener !== undefined) {
      if (opener === '[' && character === '[') {
        start = index;
      } else if (
        character === CLOSING_DELIMITERS[opener] &&
        !(opener === "'" && isWordCharacter(text[index + 1]))
      ) {
        quotedRanges.push([start, index]);
        opener = undefined;
      }
    } else if (
      (character === '<' && /[a-z/]/i.test(text[index + 1] ?? '')) ||
      (character === "'" && !isWordCharacter(text[index - 1])) ||
      (character !== '<' &&
        character !== "'" &&
        Object.hasOwn(CLOSING_DELIMITERS, character))
    ) {
      opener = character;
      start = index;
    }
  }

  let quotedRangeIndex = 0;
  for (const match of text.matchAll(/\bultracode\b/gi)) {
    const index = match.index;
    while (
      quotedRangeIndex < quotedRanges.length &&
      quotedRanges[quotedRangeIndex][1] < index
    ) {
      quotedRangeIndex++;
    }
    if (
      quotedRangeIndex < quotedRanges.length &&
      quotedRanges[quotedRangeIndex][0] <= index
    ) {
      continue;
    }
    const end = index + match[0].length;
    if (['/', '\\', '-'].includes(text[index - 1] ?? '')) continue;
    if (['/', '\\', '?', '-'].includes(text[end] ?? '')) continue;
    if (text[end] === '.' && isWordCharacter(text[end + 1])) continue;
    return true;
  }
  return false;
}

export function buildWorkflowSteeringNotice(
  surface?: WorkflowAuthoringSurface,
  options: {
    trigger?: WorkflowIntentTrigger;
    bridgeWorkflowTool?: boolean;
    nameOnly?: boolean;
  } = {},
): string {
  const introduction = `The user's message includes the "${options.trigger ?? 'workflow'}" keyword. `;
  const parts = [
    introduction +
      (options.nameOnly
        ? 'This session runs named workflows only: if a saved or extension workflow fits ' +
          'this request, run it with the Workflow tool as { name, args }, and ' +
          'do not write a workflow script. If none fits, proceed normally.'
        : 'If this request benefits from orchestrating multiple steps or subagents, strongly prefer ' +
          'the Workflow tool — author a script using phase(), log(), agent(), and ' +
          'parallel()/pipeline() — over ad-hoc sequential tool calls. If a workflow ' +
          'is not a good fit for this request, proceed normally.'),
  ];
  if (options.bridgeWorkflowTool) {
    parts.push(toolSearchBridgeSentence(ToolDisplayNames.WORKFLOW));
  }
  if (options.nameOnly) return parts.join(' ');
  if (surface === 'pointer' || surface === 'pointer-via-tool-search') {
    parts.push(
      `Before writing a script, load the \`${WORKFLOW_AUTHORING_SKILL_NAME}\` ` +
        'skill unless it is already in this conversation.',
    );
  }
  if (surface === 'pointer-via-tool-search') {
    parts.push(toolSearchBridgeSentence(ToolDisplayNames.SKILL));
  }
  return parts.join(' ');
}

export function resolveWorkflowIntent(
  config: Config,
  humanInput: HumanPromptInput | undefined,
): WorkflowIntent | null {
  if (!humanInput?.text?.trim() || subagentNameContext.getStore()) return null;
  try {
    if (
      !config.isWorkflowsEnabled() ||
      !config.getWorkflowKeywordTriggerEnabled()
    ) {
      return null;
    }
    const trigger = detectUltracodeKeyword(humanInput.text)
      ? 'ultracode'
      : detectWorkflowKeyword(humanInput.text)
        ? 'workflow'
        : undefined;
    if (!trigger) return null;
    const registry = config.getToolRegistry();
    const names = registry.getAllToolNames();
    if (!names.includes(ToolNames.WORKFLOW)) return null;
    const bridgeWorkflowTool = isToolHiddenBehindToolSearch(
      config,
      ToolNames.WORKFLOW,
    );
    if (
      bridgeWorkflowTool &&
      (!names.includes(ToolNames.TOOL_SEARCH) ||
        !names.includes(ToolNames.TOOL_CALL))
    ) {
      return null;
    }
    const nameOnly = config.isWorkflowNameOnly();
    const tool = registry.getTool(ToolNames.WORKFLOW) as
      | WorkflowTool
      | undefined;
    const surface = nameOnly
      ? undefined
      : (tool?.authoringSurface ?? resolveWorkflowAuthoringSurface(config));
    return {
      trigger,
      reminder: `<system-reminder>\n${buildWorkflowSteeringNotice(surface, { trigger, bridgeWorkflowTool, nameOnly })}\n</system-reminder>`,
    };
  } catch (error) {
    debugLogger.debug('Workflow keyword intent unavailable:', error);
    return null;
  }
}
