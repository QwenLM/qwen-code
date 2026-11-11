/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tool-layer fork subagent implementation.
 *
 * When the LLM calls the Agent tool with `subagent_type: "fork"` and the fork
 * feature gate is enabled, a fork is triggered:
 * the child inherits the parent's full conversation context and system prompt
 * for prompt-cache sharing.
 *
 * Architecture: fork-based subagent execution with prompt-cache sharing.
 *
 * Infrastructure reused:
 *   - `runForkedAgent()` in `core/forkedAgent.ts` — query loop with `preProjectedMessages`
 *   - `buildForkContextMessages()` in `utils/forkContextUtils.ts` — history → MessageParam[]
 */

import { ENV_FORK_SUBAGENT } from '../config/brand.js';
import type { LocalAgentDefinition } from './types.js';
import type { Message } from '../protocol/transcript/message.js';
import type { ModelStreamTool } from '../provider/modelStreamRequest.js';
import type { Config } from '../config/config.js';
import { ToolRegistry } from '../tools/tool-registry.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FORK_BOILERPLATE_TAG = 'fork-boilerplate';
const FORK_DIRECTIVE_PREFIX = 'Your directive: ';

// ---------------------------------------------------------------------------
// Feature gate
// ---------------------------------------------------------------------------

/**
 * Fork subagent feature gate.
 *
 * When enabled:
 * - `subagent_type: "fork"` becomes selectable on the Agent tool
 * - `subagent_type: "fork"` creates a child that inherits the parent's full
 *   conversation context and system prompt
 *
 * Controlled by the `ENV_FORK_SUBAGENT` env var. Defaults to disabled.
 */
export function isForkSubagentEnabled(): boolean {
  return process.env[ENV_FORK_SUBAGENT] === '1';
}

// ---------------------------------------------------------------------------
// Synthetic fork agent definition
// ---------------------------------------------------------------------------

/** Synthetic agent type name used for analytics when the fork path fires. */
export const FORK_SUBAGENT_TYPE = 'fork';

/**
 * Synthetic agent definition for the fork path.
 *
 * Not registered in the agent registry — used only when `subagent_type` is
 * `"fork"` and the experiment is active. `tools: ['*']` means the fork child receives the
 * parent's exact tool pool (for cache-identical API prefixes).
 * `permissionMode: 'default'` inherits parent's permission mode.
 * `model: 'inherit'` keeps the parent's model for context length parity.
 *
 * The system prompt is unused: the fork path passes the parent's
 * already-rendered system prompt bytes for byte-exact prompt cache sharing.
 */
export const FORK_AGENT: LocalAgentDefinition = {
  kind: 'local',
  name: FORK_SUBAGENT_TYPE,
  description:
    'Fork — inherits full conversation context and the parent model. Select with subagent_type: "fork" when the fork feature is active.',
  promptConfig: {
    systemPrompt: '', // Unused — parent's rendered prompt is threaded via override
  },
  modelConfig: { model: 'inherit' },
  pinToParentModel: true,
  toolConfig: { tools: ['*'], inheritAgentTool: true },
  runConfig: { maxTurns: 200 },
  permissionMode: 'default', // Subagents inherit parent's default mode
  metadata: { source: 'built-in' },
};

// ---------------------------------------------------------------------------
// Anti-recursion guard
// ---------------------------------------------------------------------------

/**
 * Guard against recursive forking. Fork children keep the Agent tool in their
 * tool pool for cache-identical tool definitions, so we reject fork attempts
 * at call time by detecting the fork boilerplate tag in conversation history.
 */
export function isInForkChild(messages: readonly Message[]): boolean {
  return messages.some((m) => {
    if (m.type !== 'user') return false;
    const content = m.message.content;
    if (!Array.isArray(content)) {
      return (
        typeof content === 'string' &&
        content.includes(`<${FORK_BOILERPLATE_TAG}>`)
      );
    }
    return content.some(
      (block) =>
        block &&
        typeof block === 'object' &&
        'type' in block &&
        block.type === 'text' &&
        'text' in block &&
        typeof (block as { text: unknown }).text === 'string' &&
        (block as { text: string }).text.includes(`<${FORK_BOILERPLATE_TAG}>`),
    );
  });
}

// ---------------------------------------------------------------------------
// Fork message construction
// ---------------------------------------------------------------------------

/**
 * Builds the child directive message with boilerplate rules.
 *
 * The marker also lets the runtime identify fork children and prevent
 * recursive fork spawning.
 */
export function buildForkDirectivePrompt(directive: string): string {
  return `<${FORK_BOILERPLATE_TAG}>
You are a worker fork. The transcript above is the parent's history — inherited reference, not your situation. You are NOT a continuation of that agent. Execute ONE directive, then stop.

Hard rules:
- Do NOT spawn subagents with the Agent tool. The "default to forking" guidance is for the parent; you ARE the fork, execute directly.
- One shot: report once and stop. No follow-up questions, no proposed next steps, no waiting for the user.

Guidelines (your directive may override any of these):
- Stay in scope. Other forks may be handling adjacent work; if you spot something outside your directive, note it in a sentence and move on.
- Open with one line restating your task, so the parent can spot scope drift at a glance.
- Be concise — as short as the answer allows, no shorter. Plain text, no preamble, no meta-commentary.
- If you committed changes, list the paths and commit hashes in your report.
</${FORK_BOILERPLATE_TAG}>

${FORK_DIRECTIVE_PREFIX}${directive}`;
}

// ---------------------------------------------------------------------------
// Directive → label helpers (for the /subtask command)
// ---------------------------------------------------------------------------

/**
 * Derive a short runtime name from a directive: first ~3 words → slug,
 * ≤24 chars, fallback "subtask".
 *
 * Unicode-aware (`\p{L}\p{N}`) so CJK directives (the product ships a CN
 * edition) keep signal instead of collapsing to the fallback.
 */
export function deriveForkName(directive: string): string {
  const slug = directive
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .slice(0, 3)
    .join('-')
    .replace(/[^\p{L}\p{N}-]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/g, '');
  return slug || 'subtask';
}

/**
 * Collapse whitespace and truncate a directive to a short label used for the
 * background-task panel and the task notification. The Agent tool schema
 * requires a `description`, and `/subtask` only supplies a free-form directive,
 * so we synthesize one here.
 */
export function truncateDirectiveLabel(directive: string, maxLen = 60): string {
  const collapsed = directive.trim().replace(/\s+/g, ' ');
  return collapsed.length <= maxLen
    ? collapsed
    : `${collapsed.slice(0, maxLen - 1).trimEnd()}…`;
}

/**
 * Notice injected into fork children running in an isolated worktree.
 * Tells the child to translate paths from the inherited context, re-read
 * potentially stale files, and that its changes are isolated.
 */
export function buildWorktreeNotice(
  parentCwd: string,
  worktreeCwd: string,
): string {
  return `You've inherited the conversation context above from a parent agent working in ${parentCwd}. You are operating in an isolated git worktree at ${worktreeCwd} — same repository, same relative file structure, separate working copy. Paths in the inherited context refer to the parent's working directory; translate them to your worktree root. Re-read files before editing if the parent may have modified them since they appear in the context. Your changes stay in this worktree and will not affect the parent's files.`;
}

// ---------------------------------------------------------------------------
// querySource — metadata-level anti-recursion guard
// ---------------------------------------------------------------------------

/**
 * Query source identifier for fork subagent invocations.
 *
 * Unlike the message-scan fallback (`isInForkChild()`), this metadata tag
 * survives auto-compact because it lives on the query options / invocation
 * context, not inside conversation messages.
 *
 * Equivalent: `context.options.querySource === 'agent:builtin:fork'`
 */
export const FORK_QUERY_SOURCE = 'agent:builtin:fork';

// ---------------------------------------------------------------------------
// Schema override — useExactTools for prompt cache sharing
// ---------------------------------------------------------------------------

export function wrapWithParentToolSchemas(
  parentToolSchemas: readonly ModelStreamTool[] | undefined,
  config: Config,
  childRegistry?: ToolRegistry,
): ToolRegistry | undefined {
  if (!parentToolSchemas || parentToolSchemas.length === 0) {
    return childRegistry;
  }
  return new ToolRegistry(config, false, {
    schemaOverride: [...parentToolSchemas],
  });
}
