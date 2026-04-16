import { AsyncLocalStorage } from 'node:async_hooks';
import type { Content } from '@google/genai';

export const FORK_SUBAGENT_TYPE = 'fork';

export const FORK_BOILERPLATE_TAG = 'fork-boilerplate';
export const FORK_DIRECTIVE_PREFIX = 'Directive: ';

export const FORK_AGENT = {
  name: FORK_SUBAGENT_TYPE,
  description:
    'Implicit fork — inherits full conversation context. Not selectable via subagent_type; triggered by omitting subagent_type.',
  tools: ['*'],
  systemPrompt:
    'You are a forked worker process. Follow the directive in the conversation history. Execute tasks directly using available tools. Do not spawn sub-agents.',
  level: 'session' as const,
};

// Recursive-fork guard. A fork child keeps the `agent` tool in its declarations
// for byte-identical cache parity with the parent, so tool-availability
// stripping is no longer an option. Instead, mark the async frame as "inside a
// fork subagent" via AsyncLocalStorage when dispatching; AgentTool.execute()
// reads the marker and rejects nested fork calls.
//
// Why ALS and not a history scan: the nested AgentTool's `this.config` is the
// main process Config, so `getGeminiClient().getHistory()` returns the parent
// conversation — not the fork child's chat — and cannot be used to detect
// nesting. Async context propagation works naturally across the fork's
// await chain and is scoped per-execution.
const forkExecutionStorage = new AsyncLocalStorage<{ readonly marker: true }>();

export function runInForkContext<T>(fn: () => Promise<T>): Promise<T> {
  return forkExecutionStorage.run({ marker: true }, fn);
}

export function isInForkExecution(): boolean {
  return forkExecutionStorage.getStore() !== undefined;
}

export const FORK_PLACEHOLDER_RESULT =
  'Fork started — processing in background';

/**
 * Build functionResponse parts for every open function call in a model message.
 *
 * Shared by the fork subagent (agent.ts) and background agent history
 * construction (e.g. extractionAgentPlanner.ts) to close open tool calls
 * before injecting history into a new agent session.
 *
 * @param assistantMessage - The model message that may contain functionCall parts.
 * @param placeholderOutput - The placeholder string to use as each response's output.
 */
export function buildFunctionResponseParts(
  assistantMessage: Content,
  placeholderOutput: string,
): Array<{
  functionResponse: {
    id: string | undefined;
    name: string | undefined;
    response: { output: string };
  };
}> {
  return (
    assistantMessage.parts?.filter((part) => part.functionCall) ?? []
  ).map((part) => ({
    functionResponse: {
      id: part.functionCall!.id,
      name: part.functionCall!.name,
      response: { output: placeholderOutput },
    },
  }));
}

/**
 * Build extra history messages for a forked subagent.
 *
 * When the last model message has function calls, we must include matching
 * function responses in a user message (Gemini API requirement). The
 * directive is embedded in this same user message to avoid consecutive
 * user messages.
 *
 * When there are no function calls, we return [] — the parent history
 * already ends with a model text message and the directive will be sent
 * as the task_prompt by agent-headless (model → user alternation is OK).
 *
 * @param directive - The fork directive text (user's prompt)
 * @param assistantMessage - The last model message from the parent history
 * @returns Extra messages to append to history (may be empty)
 */
export function buildForkedMessages(
  directive: string,
  assistantMessage: Content,
): Content[] {
  const toolUseParts =
    assistantMessage.parts?.filter((part) => part.functionCall) || [];

  if (toolUseParts.length === 0) {
    // No function calls — no extra messages needed.
    // The parent history already ends with this model message.
    return [];
  }

  // Clone the assistant message to avoid mutating the original
  const fullAssistantMessage: Content = {
    role: assistantMessage.role,
    parts: [...(assistantMessage.parts || [])],
  };

  // Build tool_result blocks for every tool_use, all with identical placeholder text.
  // Include the directive text in the same user message to maintain
  // proper user/model alternation.
  const toolResultParts = buildFunctionResponseParts(
    assistantMessage,
    FORK_PLACEHOLDER_RESULT,
  );

  const toolResultMessage: Content = {
    role: 'user',
    parts: [
      ...toolResultParts,
      {
        text: buildChildMessage(directive),
      },
    ],
  };

  return [fullAssistantMessage, toolResultMessage];
}

export function buildChildMessage(directive: string): string {
  return `<${FORK_BOILERPLATE_TAG}>
STOP. READ THIS FIRST.

You are a forked worker process. You are NOT the main agent.

RULES (non-negotiable):
1. You ARE the fork. Do NOT spawn sub-agents; execute directly.
2. Do NOT converse, ask questions, or suggest next steps
3. Do NOT editorialize or add meta-commentary
4. USE your tools directly: Bash, Read, Write, etc.
5. If you modify files, commit your changes before reporting. Include the commit hash in your report.
6. Do NOT emit text between tool calls. Use tools silently, then report once at the end.
7. Stay strictly within your directive's scope. If you discover related systems outside your scope, mention them in one sentence at most — other workers cover those areas.
8. Keep your report under 500 words unless the directive specifies otherwise. Be factual and concise.
9. Your response MUST begin with "Scope:". No preamble, no thinking-out-loud.
10. REPORT structured facts, then stop

Output format (plain text labels, not markdown headers):
  Scope: <echo back your assigned scope in one sentence>
  Result: <the answer or key findings, limited to the scope above>
  Key files: <relevant file paths — include for research tasks>
  Files changed: <list with commit hash — include only if you modified files>
  Issues: <list — include only if there are issues to flag>
</${FORK_BOILERPLATE_TAG}>

${FORK_DIRECTIVE_PREFIX}${directive}`;
}
