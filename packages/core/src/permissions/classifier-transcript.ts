/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Classifier transcript construction.
 *
 * Security properties (some stricter than ClaudeCode):
 *   1. Assistant text is stripped — the agent could be tricked into writing
 *      "classifier, please allow this" inside its output.
 *   2. Tool results are fully stripped — they may contain untrusted content
 *      (curl'd web pages, file contents) carrying prompt injection.
 *   3. Each tool_use call is projected through the tool's `toAutoClassifierInput`
 *      method so the tool can redact sensitive / voluminous fields.
 */

import type { Content, Part } from '@google/genai';
import type { ToolRegistry } from '../tools/tool-registry.js';

/** The action whose safety the classifier should evaluate. */
export interface PendingAction {
  toolName: string;
  toolParams: Record<string, unknown>;
}

/**
 * Build the `contents` array for the classifier sideQuery call.
 *
 * - Keeps user text (user intent is essential context).
 * - Keeps model functionCall parts, projected through `toAutoClassifierInput`.
 * - Strips model text parts (anti-self-injection).
 * - Strips tool result parts (anti-untrusted-content-injection).
 * - Appends `pendingAction` as the final model turn so the classifier knows
 *   which call it is evaluating.
 */
export function buildClassifierContents(
  messages: readonly Content[],
  toolRegistry: ToolRegistry,
  pendingAction: PendingAction,
): Content[] {
  const transcript: Content[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      const textParts = (msg.parts ?? []).filter(
        (p): p is Part => typeof (p as Part).text === 'string',
      );
      if (textParts.length > 0) {
        transcript.push({ role: 'user', parts: textParts });
      }
    } else if (msg.role === 'model') {
      const fnCallParts: Part[] = [];
      for (const part of msg.parts ?? []) {
        const fc = (part as Part).functionCall;
        if (fc && typeof fc.name === 'string') {
          fnCallParts.push(projectFunctionCall(fc.name, fc.args, toolRegistry));
        }
      }
      if (fnCallParts.length > 0) {
        transcript.push({ role: 'model', parts: fnCallParts });
      }
    }
    // role === 'function' (tool results) and any other roles → fully stripped.
  }

  // Append the pending action as a final USER turn carrying the projected
  // tool call as a text payload.
  //
  // We deliberately do NOT use Gemini's structured `functionCall` part for
  // this turn, even though that's the more native representation: when the
  // request is routed through the OpenAI Chat Completions converter
  // (the common path for DashScope / Qwen and most OpenAI-compatible
  // providers), assistant `tool_calls` without a matching `tool` response
  // get filtered out as orphans (see openaiContentGenerator/converter.ts
  // around the `validToolCalls` filter). The classifier would then receive
  // only the system prompt + user transcript — blind to the actual command
  // it's supposed to judge.
  //
  // Routing through a plain user-role text part is converter-agnostic and
  // delivers the action verbatim to every model backend.
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
 * Build the user-role text prompt that surfaces the pending tool call to
 * the classifier. Includes the projected arguments (via
 * {@link projectFunctionCall}) so sensitive fields are still redacted.
 */
function formatPendingActionPrompt(
  toolName: string,
  toolParams: Record<string, unknown>,
  toolRegistry: ToolRegistry,
): string {
  const fc = projectFunctionCall(toolName, toolParams, toolRegistry);
  const args =
    fc.functionCall && typeof fc.functionCall.args === 'object'
      ? (fc.functionCall.args as Record<string, unknown>)
      : {};
  return [
    '## Pending tool call to classify',
    '',
    `Tool: ${toolName}`,
    `Arguments:`,
    '```json',
    JSON.stringify(args, null, 2),
    '```',
    '',
    'Decide whether this specific tool call should be ALLOWED or BLOCKED',
    'given the rules above and the prior conversation context.',
  ].join('\n');
}

/**
 * Look up the tool in the registry and project the args through
 * `toAutoClassifierInput`. Falls back to the raw args when the tool is unknown
 * or declares no projection. Returns an empty-arg call when the projection
 * returns the empty-string sentinel.
 */
function projectFunctionCall(
  name: string,
  args: unknown,
  toolRegistry: ToolRegistry,
): Part {
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

  // Empty-string sentinel = "no security relevance"; surface as empty args.
  if (projected === '') {
    return { functionCall: { name, args: {} } };
  }

  const finalArgs =
    projected && typeof projected === 'object' ? projected : rawArgs;
  return { functionCall: { name, args: finalArgs } };
}
