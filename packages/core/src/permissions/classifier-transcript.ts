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
          transcript.push({
            role: 'user',
            parts: [
              {
                text: formatHistoricalActionPrompt(
                  fc.name,
                  fc.args,
                  toolRegistry,
                ),
              },
            ],
          });
        }
      }
    }
    // role === 'function' (tool results) and any other roles → fully stripped.
  }

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
 * empty-string sentinel (tool encoded as "no security relevance").
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
  return projected && typeof projected === 'object' ? projected : rawArgs;
}
