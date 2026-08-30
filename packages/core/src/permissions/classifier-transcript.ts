/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Classifier transcript construction.
 *
 * Mirrors ClaudeCode's `buildTranscriptEntries` (yoloClassifier.ts) in two
 * ways:
 *   1. Assistant text is stripped — the agent could be tricked into writing
 *      "classifier, please allow this" inside its output.
 *   2. Tool results are fully stripped — they may contain untrusted content
 *      (curl'd web pages, file contents) carrying prompt injection.
 *   3. Each tool_use call is projected through the tool's
 *      `toAutoClassifierInput` method so the tool can redact sensitive /
 *      voluminous fields.
 *
 * Where this differs from ClaudeCode: claude serializes the whole transcript
 * (including historical tool_use calls) as plain text and sends it inside a
 * single user-role message wrapped in `<transcript>` tags. We do the same —
 * historical `model.functionCall` parts are rendered as user-role text turns
 * rather than left as Gemini-native function-call parts. The motivation is
 * backend-agnostic delivery: the OpenAI Chat Completions converter drops
 * assistant `tool_calls` that lack a matching `tool` response (an orphan
 * filter at converter.ts:1429-1454). Because step 2 strips tool results,
 * every retained historical function-call would become orphan on the
 * default Qwen / DashScope backend and the entire prior-action chain would
 * be wiped before the classifier saw it.
 */

import type { Content, Part } from '@google/genai';
import type { ToolRegistry } from '../tools/tool-registry.js';

/** Registered-name prefix every discovered MCP tool carries. */
const MCP_TOOL_NAME_PREFIX = 'mcp__';

/** The action whose safety the classifier should evaluate. */
export interface PendingAction {
  toolName: string;
  toolParams: Record<string, unknown>;
}

/**
 * Maximum number of recent messages to include in the classifier transcript.
 * Long autonomous sessions are AUTO mode's primary use case, so unbounded
 * history will eventually overflow the fast classifier model's context
 * window. After 2 consecutive overflow-induced unavailable verdicts the
 * session falls back to manual approval, defeating the mode's purpose.
 *
 * 40 messages keeps the prompt comfortably within fast-model context budgets
 * while preserving enough of the recent action chain for the classifier to
 * apply its "untrusted tool-output" rule across a multi-step interaction.
 */
/**
 * Maximum number of session messages forwarded to the classifier as
 * context. Exported so the scheduler / ACP session paths can request
 * exactly this slice via `getHistoryTail(MAX_TRANSCRIPT_MESSAGES)`
 * rather than hardcoding `40` — keeping the constant single-sourced
 * means tuning the window doesn't require lockstep edits across
 * three files.
 */
export const MAX_TRANSCRIPT_MESSAGES = 40;

/**
 * Max characters kept for a single rendered historical action
 * (`Prior action: name({...})`). Projections are already bounded per
 * tool, but a tool may legitimately forward a large payload (a shell
 * command, an agent prompt, an MCP call); the transcript does not need
 * all of it to establish what happened earlier.
 */
export const MAX_HISTORICAL_ACTION_CHARS = 4_000;

/**
 * Aggregate character budget across all rendered historical actions in
 * the window. Newest actions are kept first; once the budget is spent,
 * older actions keep only their tool name plus an omission marker so the
 * sequence of steps stays visible without overflowing the fast
 * classifier's context.
 */
export const MAX_HISTORICAL_ACTIONS_TOTAL_CHARS = 40_000;

/**
 * Build the `contents` array for the classifier sideQuery call.
 *
 * - Keeps user text (user intent is essential context).
 * - Renders each historical model functionCall as a user-role text turn
 *   (projected through `toAutoClassifierInput`).
 * - Strips model text parts (anti-self-injection).
 * - Strips tool result parts (anti-untrusted-content-injection).
 * - Truncates to the most recent {@link MAX_TRANSCRIPT_MESSAGES} messages
 *   so very long sessions don't overflow the classifier context.
 * - Appends `pendingAction` as the final user-role text turn.
 *
 * Result: the classifier request only contains user-role text — no
 * Gemini-native functionCall parts, no assistant tool_calls. Backend-
 * agnostic by construction.
 */
export function buildClassifierContents(
  messages: readonly Content[],
  toolRegistry: ToolRegistry,
  pendingAction: PendingAction,
): Content[] {
  const transcript: Content[] = [];
  // Indices into `transcript` of rendered historical actions, with the
  // tool name kept for the omission form.
  const historical: Array<{ index: number; toolName: string }> = [];

  // Slice to the recent window before processing. Truncating after the
  // assistant/user/function filtering would produce uneven windows when a
  // session accumulates many tool-result records.
  const recent =
    messages.length > MAX_TRANSCRIPT_MESSAGES
      ? messages.slice(-MAX_TRANSCRIPT_MESSAGES)
      : messages;

  for (const msg of recent) {
    if (msg.role === 'user') {
      const textParts = (msg.parts ?? []).filter(
        (p): p is Part => typeof (p as Part).text === 'string',
      );
      if (textParts.length > 0) {
        transcript.push({ role: 'user', parts: textParts });
      }
    } else if (msg.role === 'model') {
      // Render each historical functionCall as a user-role text turn so it
      // survives every converter path. See module-level comment for why we
      // do not keep functionCall parts here.
      for (const part of msg.parts ?? []) {
        const fc = (part as Part).functionCall;
        if (fc && typeof fc.name === 'string') {
          historical.push({ index: transcript.length, toolName: fc.name });
          transcript.push({
            role: 'user',
            parts: [
              {
                text: boundHistoricalAction(
                  formatHistoricalActionPrompt(fc.name, fc.args, toolRegistry),
                ),
              },
            ],
          });
        }
      }
    }
    // role === 'function' (tool results) and any other roles → fully stripped.
  }

  applyHistoricalActionsBudget(transcript, historical);

  // Append the pending action as the final user-role turn.
  transcript.push({
    role: 'user',
    parts: [
      {
        text: formatPendingActionPrompt(
          pendingAction.toolName,
          pendingAction.toolParams,
          toolRegistry,
        ),
      },
    ],
  });

  return transcript;
}

/** Cap one rendered historical action, marking the cut in place. */
function boundHistoricalAction(text: string): string {
  if (text.length <= MAX_HISTORICAL_ACTION_CHARS) return text;
  const omitted = text.length - MAX_HISTORICAL_ACTION_CHARS;
  return `${text.slice(0, MAX_HISTORICAL_ACTION_CHARS)}…[truncated ${omitted} chars])`;
}

/**
 * Enforce {@link MAX_HISTORICAL_ACTIONS_TOTAL_CHARS} across the rendered
 * historical actions, newest first. Actions that no longer fit are
 * replaced by `Prior action: name([omitted: transcript budget exhausted])`
 * — the tool name stays so the step sequence remains legible.
 */
function applyHistoricalActionsBudget(
  transcript: Content[],
  historical: ReadonlyArray<{ index: number; toolName: string }>,
): void {
  let remaining = MAX_HISTORICAL_ACTIONS_TOTAL_CHARS;
  for (let i = historical.length - 1; i >= 0; i--) {
    const { index, toolName } = historical[i];
    const part = transcript[index].parts?.[0];
    const text = part && typeof part.text === 'string' ? part.text : '';
    if (remaining > 0 && text.length <= remaining) {
      remaining -= text.length;
      continue;
    }
    remaining = 0;
    transcript[index] = {
      role: 'user',
      parts: [
        {
          text: `Prior action: ${toolName}([omitted: transcript budget exhausted])`,
        },
      ],
    };
  }
}

/**
 * Format a prior tool call as user-role text. Compact form so multi-step
 * histories don't balloon the prompt: `Prior action: shell({"command":"ls"})`.
 */
function formatHistoricalActionPrompt(
  toolName: string,
  toolArgs: unknown,
  toolRegistry: ToolRegistry,
): string {
  const projected = projectFunctionArgs(toolName, toolArgs, toolRegistry);
  return `Prior action: ${toolName}(${JSON.stringify(projected)})`;
}

/**
 * Build the user-role text prompt that surfaces the pending tool call to
 * the classifier. Includes the projected arguments so sensitive fields are
 * still redacted.
 */
function formatPendingActionPrompt(
  toolName: string,
  toolParams: Record<string, unknown>,
  toolRegistry: ToolRegistry,
): string {
  const projected = projectFunctionArgs(toolName, toolParams, toolRegistry);
  return [
    '## Pending tool call to classify',
    '',
    `Tool: ${toolName}`,
    `Arguments:`,
    '```json',
    JSON.stringify(projected, null, 2),
    '```',
    '',
    'Decide whether this specific tool call should be ALLOWED or BLOCKED',
    'given the rules above and the prior conversation context.',
  ].join('\n');
}

/**
 * Look up the tool in the registry and project the args through
 * `toAutoClassifierInput`. Falls back to the raw args when the tool is unknown
 * or declares no projection. Returns `{}` when the projection returns the
 * empty-string sentinel (tool encoded as "no security relevance"), and for an
 * `mcp__*` name the registry cannot resolve — see below.
 */
function projectFunctionArgs(
  name: string,
  args: unknown,
  toolRegistry: ToolRegistry,
): Record<string, unknown> {
  const tool = toolRegistry.getTool(name);
  const rawArgs =
    args && typeof args === 'object' ? (args as Record<string, unknown>) : {};

  let projected: Record<string, unknown> | string | undefined;
  if (tool) {
    try {
      projected = tool.toAutoClassifierInput(rawArgs as never);
    } catch {
      projected = undefined;
    }
  }

  if (projected === '') return {};
  if (projected && typeof projected === 'object') return projected;
  // The `forwardArguments` opt-out lives on the tool object, so an `mcp__*`
  // call the registry cannot resolve — its server was removed from settings,
  // or the session was resumed without it — has nothing left to express it,
  // and its raw arguments are third-party payload that may carry secrets.
  // Fail closed to the same `{}` an opted-out MCP tool projects to rather
  // than forwarding them unbounded. Applies equally when a resolved MCP
  // tool's projection threw: the fallback must not be the unbounded one.
  if (name.startsWith(MCP_TOOL_NAME_PREFIX)) return {};
  return rawArgs;
}
