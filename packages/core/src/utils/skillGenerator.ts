/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import { DEFAULT_QWEN_MODEL } from '../config/models.js';
import type { Config } from '../config/config.js';

const SYSTEM_PROMPT = `You are an elite skill architect specializing in crafting high-quality, reusable skills for Qwen Code.

### About Skills
Skills are modular, self-contained packages that extend the agent's capabilities by providing specialized knowledge, workflows, and tools. They transform a general-purpose agent into a specialized expert.

### Core Principles
1. **Concise is Key**: The context window is a shared resource. Instructions should be lean and high-value.
2. **Set Appropriate Degrees of Freedom**:
   - High freedom (text-based instructions) for variable tasks.
   - Low freedom (specific scripts) for fragile, deterministic tasks.

### Your Task
When a user describes a skill, you will:

1. **Analyze Intent**: Understand the specific domain, workflow, or tool integration required.
2. **Design the Skill**:
   - **Name**: Create a concise, kebab-case identifier (e.g., 'git-commit-msg-generator', 'react-component-builder').
   - **Description**: A precise, actionable description starting with "Use this skill when..." that clearly defines the triggering conditions. This is CRITICAL as it's the only part the agent sees to decide whether to use the skill.
   - **Instructions**: Comprehensive Markdown instructions (the body of SKILL.md).
     - Use imperative/infinitive form.
     - Focus on procedural knowledge and workflow guidance.
     - Differentiate between metadata (always loaded) and body (loaded on trigger).
     - If the skill requires reusable resources (scripts, templates), mention them in the instructions as if they exist in \`scripts/\` or \`assets/\` directories (e.g., "Run the script \`scripts/rotate_pdf.py\`").

### Instruction Guidelines
- **Be Specific**: Avoid vague instructions.
- **Progressive Disclosure**: Keep the main instructions under 500 lines.
- **No Fluff**: Do not include auxiliary files like README or CHANGELOG.
`;

const createUserPrompt = (userInput: string): string =>
  `Create a skill configuration based on this request: "${userInput}"`;

const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description:
        "A unique, descriptive identifier using lowercase letters, numbers, and hyphens (e.g., 'code-reviewer', 'api-docs-writer')",
    },
    description: {
      type: 'string',
      description:
        "A precise, actionable description starting with 'Use this skill when...' that clearly defines the triggering conditions",
    },
    instructions: {
      type: 'string',
      description:
        'The complete instructions for the skill in Markdown format, detailing the steps, rules, and constraints for execution.',
    },
  },
  required: ['name', 'description', 'instructions'],
};

export interface SkillGeneratedContent {
  name: string;
  description: string;
  instructions: string;
}

/**
 * Generates skill configuration content using LLM.
 *
 * @param userDescription - The user's description of what the skill should do
 * @param config - Configuration object containing LLM client
 * @param abortSignal - AbortSignal for cancelling the request
 * @returns Promise resolving to generated skill content
 */
export async function skillGenerator(
  userDescription: string,
  config: Config,
  abortSignal: AbortSignal,
): Promise<SkillGeneratedContent> {
  if (!userDescription.trim()) {
    throw new Error('User description cannot be empty');
  }

  const userPrompt = createUserPrompt(userDescription);
  const contents: Content[] = [{ role: 'user', parts: [{ text: userPrompt }] }];

  const parsedResponse = (await config.getBaseLlmClient().generateJson({
    model: config.getModel() || DEFAULT_QWEN_MODEL,
    contents,
    schema: RESPONSE_SCHEMA,
    abortSignal,
    systemInstruction: SYSTEM_PROMPT,
  })) as unknown as SkillGeneratedContent;

  if (
    !parsedResponse ||
    !parsedResponse.name ||
    !parsedResponse.description ||
    !parsedResponse.instructions
  ) {
    throw new Error('Invalid response from LLM: missing required fields');
  }

  return parsedResponse;
}
