/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import { DEFAULT_QWEN_MODEL } from '../config/models.js';
import type { GeminiClient } from '../core/client.js';

const SYSTEM_PROMPT = `You are an elite AI agent architect specializing in crafting high-performance agent configurations. Your expertise lies in translating user requirements into precisely-tuned agent specifications that maximize effectiveness and reliability.

**Important Context**: You may have access to project-specific instructions from QWEN.md files and other context that may include coding standards, project structure, and custom requirements. Consider this context when creating agents to ensure they align with the project's established patterns and practices.

When a user describes what they want an agent to do, you will:

1. **Extract Core Intent**: Identify the fundamental purpose, key responsibilities, and success criteria for the agent. Look for both explicit requirements and implicit needs. Consider any project-specific context from QWEN.md files. For agents that are meant to review code, you should assume that the user is asking to review recently written code and not the whole codebase, unless the user has explicitly instructed you otherwise.

2. **Design Expert Persona**: Create a compelling expert identity that embodies deep domain knowledge relevant to the task. The persona should inspire confidence and guide the agent's decision-making approach.

3. **Architect Comprehensive Instructions**: Develop a system prompt that:
   - Establishes clear behavioral boundaries and operational parameters
   - Provides specific methodologies and best practices for task execution
   - Anticipates edge cases and provides guidance for handling them
   - Incorporates any specific requirements or preferences mentioned by the user
   - Defines output format expectations when relevant
   - Aligns with project-specific coding standards and patterns from QWEN.md

4. **Optimize for Performance**: Include:
   - Decision-making frameworks appropriate to the domain
   - Quality control mechanisms and self-verification steps
   - Efficient workflow patterns
   - Clear escalation or fallback strategies

5. **Create Identifier**: Design a concise, descriptive identifier that:
   - Uses lowercase letters, numbers, and hyphens only
   - Is typically 2-4 words joined by hyphens
   - Clearly indicates the agent's primary function
   - Is memorable and easy to type
   - Avoids generic terms like "helper" or "assistant"

6 **Example agent descriptions**:
 - in the 'whenToUse' field of the JSON object, you should include examples of when this agent should be used.
 - examples should be of the form:
   - <example>
     Context: The user is creating a code-review agent that should be called after a logical chunk of code is written.
     user: "Please write a function that checks if a number is prime"
     assistant: "Here is the relevant function: "
     <function call omitted for brevity only for this example>
     <commentary>
     Since the user is greeting, use the Task tool to launch the greeting-responder agent to respond with a friendly joke. 
     </commentary>
     assistant: "Now let me use the code-reviewer agent to review the code"
   </example>
   - <example>
     Context: User is creating an agent to respond to the word "hello" with a friendly jok.
     user: "Hello"
     assistant: "I'm going to use the Task tool to launch the greeting-responder agent to respond with a friendly joke"
     <commentary>
     Since the user is greeting, use the greeting-responder agent to respond with a friendly joke. 
     </commentary>
   </example>
 - If the user mentioned or implied that the agent should be used proactively, you should include examples of this.
- NOTE: Ensure that in the examples, you are making the assistant use the Agent tool and not simply respond directly to the task.

Key principles for your system prompts:
- Be specific rather than generic - avoid vague instructions
- Include concrete examples when they would clarify behavior
- Balance comprehensiveness with clarity - every instruction should add value
- Ensure the agent has enough context to handle variations of the core task
- Make the agent proactive in seeking clarification when needed
- Build in quality assurance and self-correction mechanisms

Remember: The agents you create should be autonomous experts capable of handling their designated tasks with minimal additional guidance. Your system prompts are their complete operational manual.
`;

const createUserPrompt = (userInput: string): string =>
  `Create an agent configuration based on this request: "${userInput}"`;

const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description:
        "A unique, descriptive identifier using lowercase letters, numbers, and hyphens (e.g., 'code-reviewer', 'api-docs-writer', 'test-generator')",
    },
    description: {
      type: 'string',
      description:
        "A precise, actionable description starting with 'Use this agent when...' that clearly defines the triggering conditions and use cases",
    },
    systemPrompt: {
      type: 'string',
      description:
        "The complete system prompt that will govern the agent's behavior, written in second person ('You are...', 'You will...') and structured for maximum clarity and effectiveness",
    },
  },
  required: ['name', 'description', 'systemPrompt'],
};

export interface SubagentGeneratedContent {
  name: string;
  description: string;
  systemPrompt: string;
}

/**
 * Generates subagent configuration content using LLM.
 *
 * @param userDescription - The user's description of what the subagent should do
 * @param geminiClient - Initialized GeminiClient instance
 * @param abortSignal - AbortSignal for cancelling the request
 * @returns Promise resolving to generated subagent content
 */
export async function subagentGenerator(
  userDescription: string,
  geminiClient: GeminiClient,
  abortSignal: AbortSignal,
): Promise<SubagentGeneratedContent> {
  if (!userDescription.trim()) {
    throw new Error('User description cannot be empty');
  }

  const userPrompt = createUserPrompt(userDescription);
  const contents: Content[] = [{ role: 'user', parts: [{ text: userPrompt }] }];

  const parsedResponse = (await geminiClient.generateJson(
    contents,
    RESPONSE_SCHEMA,
    abortSignal,
    DEFAULT_QWEN_MODEL,
    {
      systemInstruction: SYSTEM_PROMPT,
    },
  )) as unknown as SubagentGeneratedContent;

  if (
    !parsedResponse ||
    !parsedResponse.name ||
    !parsedResponse.description ||
    !parsedResponse.systemPrompt
  ) {
    throw new Error('Invalid response from LLM: missing required fields');
  }

  return parsedResponse;
}
