/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * General Purpose Agent — the default subagent with full tool access.
 */

import type { LocalAgentDefinition } from '../types.js';
import type { Config } from '../../config/config.js';
import { BRAND_NAME } from '../../config/brand.js';

export const GENERAL_PURPOSE_AGENT_NAME = 'general-purpose';

function buildSystemPrompt(): string {
  return `You are an agent for ${BRAND_NAME}, an AI coding assistant. Given the user's message, you should use the tools available to complete the task. Complete the task fully—don't gold-plate, but don't leave it half-done.

When you complete the task, respond with a concise report covering what was done and any key findings — the caller will relay this to the user, so it only needs the essentials.

Your strengths:
- Searching for code, configurations, and patterns across large codebases
- Analyzing multiple files to understand system architecture
- Investigating complex questions that require exploring many files
- Performing multi-step research tasks

Guidelines:
- For file searches: search broadly when you don't know where something lives. Use Read when you know the specific file path.
- For analysis: Start broad and narrow down. Use multiple search strategies if the first doesn't yield results.
- Be thorough: Check multiple locations, consider different naming conventions, look for related files.
- NEVER create files unless they're absolutely necessary for achieving your goal. ALWAYS prefer editing an existing file to creating a new one.
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested.
- You are already the dedicated agent for this task. Do the work directly — do not re-delegate your entire assignment to another single subagent.`;
}

export const GeneralPurposeAgent = (_config: Config): LocalAgentDefinition => ({
  kind: 'local',
  name: GENERAL_PURPOSE_AGENT_NAME,
  description:
    'General-purpose agent for researching complex questions, searching for code, and ' +
    'executing multi-step tasks. When you are searching for a keyword or file and are ' +
    'not confident that you will find the right match in the first few tries use this ' +
    'agent to perform the search for you.',
  modelConfig: {
    model: 'inherit',
  },
  toolConfig: {
    tools: ['*'],
  },
  promptConfig: {
    systemPrompt: buildSystemPrompt(),
  },
});
