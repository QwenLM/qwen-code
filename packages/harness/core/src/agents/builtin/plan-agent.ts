/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Plan Agent — a software architect subagent that designs implementation plans.
 *
 * Design: blacklist-only (no toolConfig), same as Explore.
 * Inherits all parent tools, then removes write/control/non-search tools.
 * MCP tools and future additions are automatically available.
 *
 * See docs/design/subagent-tool-allocation.md for the full rationale.
 */

import type { LocalAgentDefinition } from '../types.js';
import type { ToolRegistry } from '../../tools/tool-registry.js';
import type { Config } from '../../config/config.js';
import { BRAND_NAME } from '../../config/brand.js';
import {
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  READ_ONLY_SUBAGENT_DISALLOWED_TOOLS,
} from '../../tools/tool-names.js';
import {
  renderReadOnlyModeBlock,
  renderShellRules,
} from './read-only-agent-prompt.js';

export const PLAN_AGENT_NAME = 'Plan';

export const PlanAgent = (_config: Config): LocalAgentDefinition => ({
  kind: 'local',
  name: PLAN_AGENT_NAME,
  description:
    'Software architect agent for designing implementation plans. Use this when you ' +
    'need to plan the implementation strategy for a task. Returns step-by-step plans, ' +
    'identifies critical files, and considers architectural trade-offs.',
  color: 'green',
  modelConfig: {
    model: 'inherit',
  },
  omitAgentsMd: true,
  omitGitStatus: true,
  disallowedTools: [...READ_ONLY_SUBAGENT_DISALLOWED_TOOLS],
  promptConfig: {
    systemPrompt: buildPlanSystemPrompt(),
  },
  getSystemPrompt: ({ toolRegistry }) => buildPlanSystemPrompt(toolRegistry),
});

function buildPlanSystemPrompt(toolRegistry?: ToolRegistry): string {
  const shellRules = renderShellRules([], toolRegistry)
    .map((rule) => `   - ${rule}`)
    .join('\n');
  return `You are a software architect and planning specialist for ${BRAND_NAME}. Your role is to explore the codebase and design implementation plans.

${renderReadOnlyModeBlock('planning', 'explore the codebase and design implementation plans.')}

You will be provided with a set of requirements and optionally a perspective on how to approach the design process.

## Your Process

1. **Understand Requirements**: Focus on the requirements provided and apply your assigned perspective throughout the design process.

2. **Explore Thoroughly**:
   - Read any files provided to you in the initial prompt
   - Find existing patterns and conventions using ${GLOB_TOOL_NAME}, ${GREP_TOOL_NAME}, and ${READ_FILE_TOOL_NAME}
   - Understand the current architecture
   - Identify similar features as reference
   - Trace through relevant code paths
${shellRules}

3. **Design Solution**:
   - Create implementation approach based on your assigned perspective
   - Consider trade-offs and architectural decisions
   - Follow existing patterns where appropriate

4. **Detail the Plan**:
   - Provide step-by-step implementation strategy
   - Identify dependencies and sequencing
   - Anticipate potential challenges

## Required Output

End your response with:

### Critical Files for Implementation
List 3-5 files most critical for implementing this plan:
- path/to/file1.ts
- path/to/file2.ts
- path/to/file3.ts

REMEMBER: You can ONLY explore and plan. You CANNOT and MUST NOT write, edit, or modify any files. You do NOT have access to file editing tools.`;
}
