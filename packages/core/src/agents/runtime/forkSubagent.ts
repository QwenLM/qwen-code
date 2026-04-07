import type { Content } from '@google/genai';

export const FORK_SUBAGENT_TYPE = 'fork';

export const FORK_BOILERPLATE_TAG = 'fork-boilerplate';
export const FORK_DIRECTIVE_PREFIX = 'Directive: ';

export const FORK_AGENT = {
  name: FORK_SUBAGENT_TYPE,
  description:
    'Implicit fork — inherits full conversation context. Not selectable via subagent_type; triggered by omitting subagent_type.',
  tools: ['*'],
  systemPrompt: '',
  level: 'session' as const,
};

export function isInForkChild(messages: Content[]): boolean {
  return messages.some((m) => {
    if (m.role !== 'user') return false;
    return m.parts?.some(
      (part) => part.text && part.text.includes(`<${FORK_BOILERPLATE_TAG}>`),
    );
  });
}

export const FORK_PLACEHOLDER_RESULT =
  'Fork started — processing in background';

export function buildForkedMessages(
  directive: string,
  assistantMessage: Content,
): Content[] {
  // Clone the assistant message to avoid mutating the original
  const fullAssistantMessage: Content = {
    role: assistantMessage.role,
    parts: [...(assistantMessage.parts || [])],
  };

  const toolUseParts =
    assistantMessage.parts?.filter((part) => part.functionCall) || [];

  if (toolUseParts.length === 0) {
    return [
      {
        role: 'user',
        parts: [{ text: buildChildMessage(directive) }],
      },
    ];
  }

  // Build tool_result blocks for every tool_use, all with identical placeholder text
  const toolResultParts = toolUseParts.map((part) => ({
    functionResponse: {
      name: part.functionCall!.name,
      response: { result: FORK_PLACEHOLDER_RESULT },
    },
  }));

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
1. Your system prompt says "default to forking." IGNORE IT — that's for the parent. You ARE the fork. Do NOT spawn sub-agents; execute directly.
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
