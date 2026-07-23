import { AsyncLocalStorage } from 'node:async_hooks';
import type { Content } from '@google/genai';
import type { SubagentConfig } from '../../subagents/types.js';
import { BUBBLE_APPROVAL_MODE } from '../../subagents/types.js';
import {
  getStartupContextLength,
  isSystemReminderContent,
} from '../../utils/environmentContext.js';

export const FORK_SUBAGENT_TYPE = 'fork';

/**
 * Forking is an explicit choice — the caller selects it with
 * `subagent_type: "fork"`. Omitting `subagent_type` always resolves to the
 * general-purpose subagent, never a fork. Regular top-level subagents run in
 * the background by default; callers can set `run_in_background: false` for an
 * inline result. Forks are available in both interactive and headless
 * sessions; headless forks use the background registry so the caller waits for
 * completion and non-interactive permission policy is applied.
 */
export const FORK_BOILERPLATE_TAG = 'fork-boilerplate';
export const FORK_DIRECTIVE_PREFIX = 'Directive: ';

export const FORK_AGENT = {
  name: FORK_SUBAGENT_TYPE,
  description:
    'Fork yourself — inherits parent conversation context. Selected explicitly via `subagent_type: "fork"`. Runs detached in the background; you are notified when it completes.',
  tools: ['*'],
  systemPrompt:
    'You are a forked worker process. Follow the directive in the conversation history. Execute tasks directly using available tools. Do not spawn sub-agents.',
  // `bubble` surfaces this fork's permission prompts to the parent's Background-
  // tasks UI; a detached fork has no inline UI, so 'default' would auto-deny them.
  approvalMode: BUBBLE_APPROVAL_MODE,
  level: 'session' as const,
} satisfies SubagentConfig;

// Turn cap for a detached fork — fire-and-forget background work nobody awaits,
// so an unbounded reasoning loop burns tokens silently. Matches claude-code's
// fork cap of 200.
export const FORK_DEFAULT_MAX_TURNS = 200;

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

export type ForkTurns = 'all' | `${number}`;
export type NormalizedForkTurns = 'all' | number;

export function normalizeForkTurns(
  forkTurns: ForkTurns | undefined,
): NormalizedForkTurns {
  return forkTurns === undefined || forkTurns === 'all'
    ? 'all'
    : Number(forkTurns);
}

function isSystemReminderPart(content: Content, partIndex: number): boolean {
  const part = content.parts?.[partIndex];
  return part
    ? isSystemReminderContent({ role: 'user', parts: [part] })
    : false;
}

function isRealUserTurn(content: Content): boolean {
  if (content.role !== 'user' || !content.parts?.length) return false;
  return content.parts.some((part, index) => {
    if (part.functionResponse || isSystemReminderPart(content, index)) {
      return false;
    }
    return typeof part.text !== 'string' || part.text.trim().length > 0;
  });
}

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
 * Select parent conversation history for a fork.
 *
 * A turn is a real user prompt, not a function response or a pure structural
 * reminder. A bounded selection omits synthetic prefixes; the caller can
 * reattach any saved legacy startup context that the fork still needs.
 */
export function selectForkHistory(
  history: Content[],
  forkTurns: NormalizedForkTurns,
): Content[] {
  let selected = history;

  if (typeof forkTurns === 'number') {
    // includeCompressed is load-bearing here. getHistoryForForkWindow strips
    // legacy startup context with includeCompressed:false, so a post-compression
    // summary prefix can still lead this history. Detecting it here keeps that
    // synthetic summary from being counted as a real user turn — which would
    // consume one of the requested turns and seed the fork with a prefix it
    // should not inherit.
    const syntheticPrefixLength = getStartupContextLength(history, {
      includeCompressed: true,
    });
    const realUserTurnIndexes: number[] = [];
    for (let index = syntheticPrefixLength; index < history.length; index++) {
      const content = history[index]!;
      if (isRealUserTurn(content)) {
        realUserTurnIndexes.push(index);
      }
    }

    if (realUserTurnIndexes.length === 0) {
      selected = [];
    } else {
      selected = history.slice(
        realUserTurnIndexes[
          Math.max(0, realUserTurnIndexes.length - forkTurns)
        ],
      );
    }
  }

  return structuredClone(selected);
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

/**
 * Notice injected into a subagent that has been spun up inside an isolated
 * git worktree (via `AgentTool` `isolation: 'worktree'`). Tells the agent
 * to confine all file operations to the worktree path and to re-read any
 * file inherited from the parent's context before editing it.
 *
 * Mirrors claude-code's `buildWorktreeNotice` in
 * `tools/AgentTool/forkSubagent.ts`.
 */
export function buildWorktreeNotice(
  parentCwd: string,
  worktreeCwd: string,
): string {
  return (
    `You are operating in an isolated git worktree at ${worktreeCwd}. ` +
    `The parent agent is in ${parentCwd}. Same repository, same relative file layout, separate working copy. ` +
    `All your file edits, writes, and shell commands MUST target paths under ${worktreeCwd}. ` +
    `When the inherited context references a path under ${parentCwd}, translate it to the corresponding path under ${worktreeCwd} before acting on it. ` +
    `Re-read any file you intend to edit (the parent may have modified it after the snapshot in your context). ` +
    `Your changes stay in this worktree and do not affect the parent's working tree.`
  );
}

/**
 * Notice for a sub-agent pinned to a caller-owned worktree via `working_dir`.
 *
 * Deliberately narrower than {@link buildWorktreeNotice}: that one describes a
 * freshly provisioned copy of the parent's tree, so it asks the agent to
 * translate inherited paths and to re-read files the parent may have touched.
 * A pinned worktree is instead the code the agent was asked to work on, and its
 * cwd already IS that directory — telling it to prefix absolute paths or to
 * translate the parent's paths would contradict the caller's own instructions.
 */
export function buildPinnedWorktreeNotice(worktreeCwd: string): string {
  return (
    `Your working directory is ${worktreeCwd}, a git worktree checked out to the code you have been asked to work on. ` +
    `Relative paths, shell commands, and searches already resolve there — do not \`cd\` elsewhere and do not prefix paths with the parent's directory. ` +
    `Do not operate on the parent's checkout.`
  );
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
5. If you modify files, report the files changed and verification performed. Do NOT create a commit unless the directive explicitly asks you to.
6. Do NOT emit text between tool calls. Use tools silently, then report once at the end.
7. Stay strictly within your directive's scope. If you discover related systems outside your scope, mention them in one sentence at most — other workers cover those areas.
8. Keep your report under 500 words unless the directive specifies otherwise. Be factual and concise.
9. Your response MUST begin with "Scope:". No preamble, no thinking-out-loud.
10. REPORT structured facts, then stop

Output format (plain text labels, not markdown headers):
  Scope: <echo back your assigned scope in one sentence>
  Result: <the answer or key findings, limited to the scope above>
  Key files: <relevant file paths — include for research tasks>
  Files changed: <list — include only if you modified files>
  Verification: <checks performed and their outcome — include only if you modified files>
  Issues: <list — include only if there are issues to flag>
</${FORK_BOILERPLATE_TAG}>

${FORK_DIRECTIVE_PREFIX}${directive}`;
}
