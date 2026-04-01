/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Speculation Engine
 *
 * Speculatively executes the accepted suggestion before the user confirms,
 * using a forked GeminiChat with copy-on-write file isolation.
 *
 * Flow:
 * 1. Suggestion shown → startSpeculation() fires
 * 2. Speculative loop runs in background (read-only tools + overlay writes)
 * 3. User presses Tab/Enter → acceptSpeculation() copies overlay to real FS
 * 4. User types → abortSpeculation() cleans up
 */

import type { Content, Part } from '@google/genai';
import type { Config } from '../config/config.js';
import type { GeminiClient } from '../core/client.js';
import { StreamEventType } from '../core/geminiChat.js';
import { OverlayFs } from './overlayFs.js';
import { evaluateToolCall, rewritePathArgs } from './speculationToolGate.js';
import { getCacheSafeParams, createForkedChat } from './forkedQuery.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_SPECULATION_TURNS = 20;
const MAX_SPECULATION_MESSAGES = 100;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BoundaryInfo {
  type: string;
  detail: string;
  completedAt: number;
}

export interface SpeculationState {
  id: string;
  status: 'idle' | 'running' | 'completed' | 'boundary' | 'aborted';
  suggestion: string;
  overlayFs: OverlayFs | null;
  abortController: AbortController | null;
  messages: Content[];
  boundary?: BoundaryInfo;
  startTime: number;
  toolUseCount: number;
  pipelinedSuggestion?: string;
}

export interface SpeculationResult {
  filesApplied: string[];
  messages: Content[];
  boundary?: BoundaryInfo;
  timeSavedMs: number;
  nextSuggestion?: string;
}

export const IDLE_SPECULATION: Readonly<SpeculationState> = Object.freeze({
  id: '',
  status: 'idle' as const,
  suggestion: '',
  overlayFs: null,
  abortController: null,
  messages: [],
  startTime: 0,
  toolUseCount: 0,
});

// ---------------------------------------------------------------------------
// Start speculation
// ---------------------------------------------------------------------------

/**
 * Start speculative execution of a suggestion.
 * Called when the suggestion is first shown to the user (before acceptance).
 */
export async function startSpeculation(
  config: Config,
  suggestion: string,
  parentSignal?: AbortSignal,
): Promise<SpeculationState> {
  const cacheSafe = getCacheSafeParams();
  if (!cacheSafe) {
    throw new Error('CacheSafeParams not available for speculation');
  }

  const abortController = new AbortController();

  // Link to parent signal with cleanup to prevent memory leak (#20)
  let parentAbortHandler: (() => void) | undefined;
  if (parentSignal) {
    parentAbortHandler = () => abortController.abort();
    parentSignal.addEventListener('abort', parentAbortHandler, { once: true });
  }

  const overlayFs = new OverlayFs(config.getCwd());
  const startTime = Date.now();

  const state: SpeculationState = {
    id: Math.random().toString(36).slice(2, 10),
    status: 'running',
    suggestion,
    overlayFs,
    abortController,
    messages: [],
    startTime,
    toolUseCount: 0,
  };

  // Run the speculative loop in the background
  runSpeculativeLoop(config, state, cacheSafe)
    .then((result) => {
      if (state.status === 'running') {
        state.messages = result.messages;
        if (result.boundary) {
          state.boundary = result.boundary;
          state.status = 'boundary';
        } else {
          state.status = 'completed';
        }
      }
    })
    .catch(async () => {
      // Cleanup overlay on error (#16)
      if (state.status === 'running') {
        state.status = 'aborted';
      }
      await overlayFs.cleanup();
    })
    .finally(() => {
      // Clean up parent signal listener (#20)
      if (parentSignal && parentAbortHandler) {
        parentSignal.removeEventListener('abort', parentAbortHandler);
      }
    });

  return state;
}

// ---------------------------------------------------------------------------
// Speculative execution loop
// ---------------------------------------------------------------------------

interface LoopResult {
  messages: Content[];
  boundary?: BoundaryInfo;
}

async function runSpeculativeLoop(
  config: Config,
  state: SpeculationState,
  cacheSafe: import('./forkedQuery.js').CacheSafeParams,
): Promise<LoopResult> {
  const chat = createForkedChat(config, cacheSafe);
  const model = cacheSafe.model;
  const approvalMode = config.getApprovalMode();
  const messages: Content[] = [];

  // Add the suggestion as the initial user message
  const userMsg: Content = {
    role: 'user',
    parts: [{ text: state.suggestion }],
  };
  messages.push(userMsg);

  for (let turn = 0; turn < MAX_SPECULATION_TURNS; turn++) {
    if (state.abortController?.signal.aborted) break;
    if (messages.length >= MAX_SPECULATION_MESSAGES) break;

    // Send user message for this turn
    const lastUserMsg = messages[messages.length - 1];
    const stream = await chat.sendMessageStream(
      model,
      { message: lastUserMsg.parts ?? [] },
      'speculation',
    );

    const modelParts: Part[] = [];
    for await (const event of stream) {
      if (state.abortController?.signal.aborted) break;
      if (event.type !== StreamEventType.CHUNK) continue;
      const response = event.value;
      const parts = response.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        if (part.text) {
          modelParts.push({ text: part.text });
        }
        if (part.functionCall) {
          modelParts.push({
            functionCall: {
              name: part.functionCall.name!,
              args: part.functionCall.args,
            },
          });
        }
      }
    }

    if (state.abortController?.signal.aborted) break;
    if (modelParts.length === 0) break;

    const modelMsg: Content = { role: 'model', parts: modelParts };
    messages.push(modelMsg);

    // Extract function calls from model response
    const functionCalls = modelParts.filter(
      (p): p is Part & { functionCall: NonNullable<Part['functionCall']> } =>
        p.functionCall !== undefined,
    );

    if (functionCalls.length === 0) {
      // No tool calls — speculation complete (text-only response)
      break;
    }

    // Process each function call through the tool gate
    const functionResponses: Part[] = [];
    let hitBoundary = false;

    for (const part of functionCalls) {
      const fc = part.functionCall;
      const name = fc.name ?? '';
      const args = (fc.args ?? {}) as Record<string, unknown>;
      const gate = await evaluateToolCall(
        name,
        args,
        state.overlayFs!,
        approvalMode,
      );

      if (gate.action === 'boundary') {
        hitBoundary = true;
        break;
      }

      if (gate.action === 'redirect') {
        await rewritePathArgs(args, state.overlayFs!);
      }

      // Execute the tool directly (bypassing CoreToolScheduler)
      // SECURITY: Only reaches here for read-only tools or writes gated by approvalMode
      try {
        const toolRegistry = config.getToolRegistry();
        const tool = toolRegistry.getTool(name);
        if (!tool) {
          functionResponses.push({
            functionResponse: {
              name,
              response: { error: `Tool '${name}' not found` },
            },
          });
          continue;
        }

        const invocation = tool.build(args);
        const result = await invocation.execute(state.abortController!.signal);
        state.toolUseCount++;

        const responseContent =
          typeof result.llmContent === 'string'
            ? { output: result.llmContent }
            : { output: JSON.stringify(result.llmContent) };
        functionResponses.push({
          functionResponse: { name, response: responseContent },
        });
      } catch (error: unknown) {
        functionResponses.push({
          functionResponse: {
            name,
            response: {
              error:
                error instanceof Error
                  ? error.message
                  : 'Tool execution failed',
            },
          },
        });
      }
    }

    if (hitBoundary) {
      // Keep already-executed tool responses, strip unexecuted function calls
      // from model message, and add the partial responses we do have (#18)
      if (functionResponses.length > 0) {
        // Some tools were executed before boundary — keep their call+response pairs
        const executedNames = new Set(
          functionResponses
            .filter((p) => p.functionResponse)
            .map((p) => p.functionResponse!.name),
        );
        const keptModelParts = modelParts.filter(
          (p) =>
            !p.functionCall || executedNames.has(p.functionCall.name ?? ''),
        );
        if (keptModelParts.length > 0) {
          messages[messages.length - 1] = {
            role: 'model',
            parts: keptModelParts,
          };
          // Add the tool results we have
          messages.push({ role: 'user', parts: functionResponses });
        } else {
          messages.pop();
        }
      } else {
        // No tools were executed — remove the model message entirely
        const textOnlyParts = modelParts.filter(
          (p) => p.functionCall === undefined,
        );
        if (textOnlyParts.length > 0) {
          messages[messages.length - 1] = {
            role: 'model',
            parts: textOnlyParts,
          };
        } else {
          messages.pop();
        }
      }

      return {
        messages,
        boundary: {
          type: 'boundary',
          detail: 'speculation_boundary',
          completedAt: Date.now(),
        },
      };
    }

    // Add tool results to history for next turn
    if (functionResponses.length > 0) {
      const resultMsg: Content = { role: 'user', parts: functionResponses };
      messages.push(resultMsg);
    }
  }

  return { messages };
}

// ---------------------------------------------------------------------------
// Accept speculation
// ---------------------------------------------------------------------------

/**
 * Accept speculation results: copy overlay files to real filesystem and
 * return messages to inject into the main conversation.
 */
export async function acceptSpeculation(
  state: SpeculationState,
  geminiClient: GeminiClient,
): Promise<SpeculationResult> {
  const timeSavedMs = state.boundary
    ? Math.max(0, state.boundary.completedAt - state.startTime)
    : Math.max(0, Date.now() - state.startTime);

  // Copy overlay files to real filesystem
  const filesApplied = state.overlayFs
    ? await state.overlayFs.applyToReal()
    : [];

  // Ensure tool result pairing is complete before injection
  const cleanMessages = ensureToolResultPairing(state.messages);

  // Inject into main conversation
  for (const msg of cleanMessages) {
    await geminiClient.addHistory(msg);
  }

  // Cleanup
  if (state.overlayFs) {
    await state.overlayFs.cleanup();
  }
  state.status = 'completed';

  return {
    filesApplied,
    messages: cleanMessages,
    boundary: state.boundary,
    timeSavedMs,
    nextSuggestion: state.pipelinedSuggestion,
  };
}

// ---------------------------------------------------------------------------
// Abort speculation
// ---------------------------------------------------------------------------

/**
 * Abort a running or completed speculation and clean up resources.
 */
export async function abortSpeculation(state: SpeculationState): Promise<void> {
  state.abortController?.abort();
  state.status = 'aborted';
  if (state.overlayFs) {
    await state.overlayFs.cleanup();
  }
}

// ---------------------------------------------------------------------------
// Utility: ensure tool result pairing
// ---------------------------------------------------------------------------

/**
 * Ensure all functionCall parts have matching functionResponse parts.
 * If the last model message has unpaired function calls (boundary truncation),
 * remove those function call parts to keep the history API-legal.
 */
function ensureToolResultPairing(messages: Content[]): Content[] {
  if (messages.length === 0) return messages;

  const result = [...messages];
  const lastMsg = result[result.length - 1];

  // If last message is model with function calls but no following user response
  if (lastMsg.role === 'model' && lastMsg.parts) {
    const hasFunctionCalls = lastMsg.parts.some(
      (p) => p.functionCall !== undefined,
    );
    if (hasFunctionCalls) {
      const textParts = lastMsg.parts.filter(
        (p) => p.functionCall === undefined,
      );
      if (textParts.length > 0) {
        result[result.length - 1] = { role: 'model', parts: textParts };
      } else {
        result.pop();
      }
    }
  }

  return result;
}
