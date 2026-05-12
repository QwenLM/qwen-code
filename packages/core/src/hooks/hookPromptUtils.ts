/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Default prompt template for agent hooks when no custom prompt is provided.
 * Instructs the subagent to verify the stop condition using the hook input JSON.
 */
export const DEFAULT_AGENT_HOOK_PROMPT = `You are verifying a stop condition. Analyze the following context and verify that the agent completed the given task correctly.

Context:
$ARGUMENTS

Use the available tools to inspect the codebase and verify the condition.
Use as few steps as possible — be efficient and direct.

When done, return your result using the report_verdict tool with:
- ok: true if the condition is met
- ok: false with reason if the condition is not met`;

/**
 * Replaces the \`$ARGUMENTS\` placeholder in a hook prompt template with the
 * serialized JSON input. This mirrors Claude Code's \`addArgumentsToPrompt\`.
 *
 * @param prompt - The prompt template potentially containing \`$ARGUMENTS\`.
 * @param jsonInput - The JSON string to substitute in place of \`$ARGUMENTS\`.
 * @returns The prompt with \`$ARGUMENTS\` replaced by the JSON input.
 */
export function substituteHookArguments(
  prompt: string,
  jsonInput: string,
): string {
  return prompt.replace(/\$ARGUMENTS/g, jsonInput);
}
