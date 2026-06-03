/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview AgentHookRunner — executes agent-type hooks by spawning a
 * headless subagent that verifies conditions and reports a structured verdict.
 *
 * This is the Qwen equivalent of Claude Code's `execAgentHook`. It follows
 * the design document's "Plan B (MVP)": after the AgentHeadless finishes,
 * we synchronously check whether `report_verdict` was called via the
 * `postToolUse` lifecycle hook.
 *
 * If the subagent finishes without calling `report_verdict` (terminate=GOAL),
 * a text-based fallback extracts the verdict from the model's final text
 * output, since many models prefer to answer in plain text rather than
 * calling a structured tool.
 *
 * Key capabilities aligned with Claude Code:
 * - **Simplified config model**: `prompt` is required; `agent` is optional
 *   (defaults to `general-purpose`).
 * - **Text fallback verdict**: If the model finishes without calling the
 *   verdict tool, its final text is parsed to infer pass/fail.
 * - **Transcript path injection**: Injects the parent conversation's
 *   transcript file path into the system prompt so the subagent can read it.
 * - **dontAsk permission mode**: Sets YOLO approval mode on the subagent
 *   context so tool execution never triggers permission dialogs.
 */

import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/config.js';
import type {
  AgentHookConfig,
  HookEventName,
  HookInput,
  HookExecutionResult,
} from './types.js';
import { DEFAULT_AGENT_HOOK_SUBAGENT } from './types.js';
import { ContextState } from '../agents/runtime/agent-headless.js';
import { AgentTerminateMode } from '../agents/runtime/agent-types.js';
import type {
  AgentHooks,
  PostToolUsePayload,
} from '../agents/runtime/agent-events.js';
import type { ToolConfig } from '../agents/runtime/agent-types.js';
import {
  VERDICT_TOOL_NAME,
  buildReportVerdictFunctionDeclaration,
} from './reportVerdictTool.js';
import type { VerdictPayload } from './reportVerdictTool.js';
import { AGENT_HOOK_DISALLOWED_TOOLS } from './agentHookDisallowedTools.js';
import { substituteHookArguments } from './hookPromptUtils.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('AGENT_HOOK_RUNNER');

/** Hard upper bound on subagent turns to prevent runaway loops. */
const MAX_AGENT_HOOK_TURNS = 50;

/** Default wall-clock timeout in seconds when hook config omits `timeout`. */
const DEFAULT_TIMEOUT_SECONDS = 720;

/**
 * Negative-signal patterns for text-based verdict fallback.
 * If the model's final text matches any of these (case-insensitive),
 * the verdict is inferred as `ok: false`.
 */
const NEGATIVE_VERDICT_PATTERNS = [
  // Match "not/never/no" followed (within 30 chars) by positive-signal words,
  // to avoid false positives like "found no failures" being classified as ok=true.
  /\b(not|never|no)\b.{0,30}\b(met|satisfied|fulfilled|passed|completed|done|successfully|complete|good|correct|fine)\b/i,
  /\bdoes\s+not\s+(meet|satisfy|pass|match)\b/i,
  /\bcondition\s+(is|was)\s+not\b/i,
  /\bnot\s+ok\b/i,
  /\bok\s*[:=]\s*false\b/i,
  // Standalone "failed/fails/failure" without a preceding "no/without/zero"
  /\b(?:^|(?<!\b(?:no|without|zero)\s+))fail(ed|s|ure)?\b/i,
];

/**
 * Positive-signal patterns for text-based verdict fallback.
 * These are only matched if NO negative pattern matched first.
 */
const POSITIVE_VERDICT_PATTERNS = [
  /\bcondition\s+(is|was)\s+(met|satisfied)\b/i,
  /\bok\s*[:=]\s*true\b/i,
  /\ball\s+(checks?\s+)?(pass|passed|good|correct)\b/i,
  /\blooks?\s+(good|correct|fine)\b/i,
  /\bsuccessfully\b/i,
];

/**
 * Attempts to infer a VerdictPayload from the model's final text output.
 * Used as a fallback when the model finishes without calling `report_verdict`.
 *
 * Strategy: check for negative patterns first (they are more specific),
 * then check for positive patterns. If neither matches, return undefined
 * to signal that we cannot confidently infer a verdict.
 */
function parseVerdictFromText(text: string): VerdictPayload | undefined {
  if (!text || text.trim().length === 0) {
    return undefined;
  }

  for (const pattern of NEGATIVE_VERDICT_PATTERNS) {
    if (pattern.test(text)) {
      return { ok: false, reason: text.slice(0, 500) };
    }
  }

  for (const pattern of POSITIVE_VERDICT_PATTERNS) {
    if (pattern.test(text)) {
      return { ok: true };
    }
  }

  return undefined;
}

/**
 * Executes agent-type hooks by spawning a headless subagent.
 *
 * Lifecycle:
 * 1. Resolve subagent name (defaulting to `general-purpose`)
 * 2. Load the subagent config via SubagentManager
 * 3. Build a ToolConfig that injects `report_verdict` and disallows dangerous tools
 * 4. Create a YOLO-mode Config override (dontAsk)
 * 5. Build system prompt with transcript path injection
 * 6. Capture the verdict via postToolUse hook
 * 7. If no verdict from tool, fall back to text-based verdict parsing
 * 8. Map the verdict to HookExecutionResult
 */
export class AgentHookRunner {
  constructor(private readonly config: Config) {}

  async execute(
    hookConfig: AgentHookConfig,
    eventName: HookEventName,
    input: HookInput,
    signal?: AbortSignal,
  ): Promise<HookExecutionResult> {
    const startTime = Date.now();
    const agentName = hookConfig.agent ?? DEFAULT_AGENT_HOOK_SUBAGENT;
    const hookName = hookConfig.name || `agent:${agentName}`;

    try {
      return await this.executeInternal(
        hookConfig,
        eventName,
        input,
        signal,
        startTime,
        hookName,
        agentName,
      );
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMsg = error instanceof Error ? error.message : String(error);
      debugLogger.warn(`Agent hook "${hookName}" error: ${errorMsg}`);

      return {
        hookConfig,
        eventName,
        success: false,
        outcome: 'non_blocking_error',
        error: error instanceof Error ? error : new Error(errorMsg),
        duration,
      };
    }
  }

  private async executeInternal(
    hookConfig: AgentHookConfig,
    eventName: HookEventName,
    input: HookInput,
    signal: AbortSignal | undefined,
    startTime: number,
    hookName: string,
    agentName: string,
  ): Promise<HookExecutionResult> {
    // ── Step A: Load subagent configuration ──────────────────
    const subagentManager = this.config.getSubagentManager();
    const subagentConfig = await subagentManager.loadSubagent(agentName);

    if (!subagentConfig) {
      debugLogger.warn(
        `Agent hook "${hookName}": subagent "${agentName}" not found`,
      );
      return {
        hookConfig,
        eventName,
        success: false,
        outcome: 'non_blocking_error',
        error: new Error(`Subagent "${agentName}" not found`),
        duration: Date.now() - startTime,
      };
    }

    // ── Step B: Build prompt with $ARGUMENTS substitution ────
    const jsonInput = JSON.stringify(input);
    const processedPrompt = substituteHookArguments(
      hookConfig.prompt,
      jsonInput,
    );
    debugLogger.debug(
      `Agent hook "${hookName}": processed prompt length=${processedPrompt.length}`,
    );

    // ── Step C: Build merged disallowed tools ────────────────
    const existingDisallowed = subagentConfig.disallowedTools ?? [];
    const mergedDisallowedSet = new Set([
      ...existingDisallowed,
      ...AGENT_HOOK_DISALLOWED_TOOLS,
    ]);
    const mergedDisallowed = Array.from(mergedDisallowedSet);

    // ── Step D: Build ToolConfig with verdict tool injected ──
    const verdictDeclaration = buildReportVerdictFunctionDeclaration();
    const toolConfigOverride: ToolConfig = {
      tools: ['*', verdictDeclaration],
      disallowedTools: mergedDisallowed,
    };

    // ── Step E: Set up verdict capture via postToolUse ───────
    // Note: report_verdict is injected as a FunctionDeclaration (not in
    // ToolRegistry), so the tool execution may report success=false in
    // postToolUse. We therefore do NOT gate on payload.success — instead
    // we validate the args structure at runtime.
    const captured: { verdict?: VerdictPayload } = {};
    const agentHooks: AgentHooks = {
      postToolUse(payload: PostToolUsePayload): void {
        if (payload.toolName === VERDICT_TOOL_NAME) {
          if (captured.verdict) {
            debugLogger.warn(
              `Agent hook "${hookName}": report_verdict called multiple times, ignoring subsequent call`,
            );
            return;
          }
          const args = payload.args as Record<string, unknown> | undefined;
          if (args && typeof args['ok'] === 'boolean') {
            captured.verdict = {
              ok: args['ok'],
              reason:
                typeof args['reason'] === 'string' ? args['reason'] : undefined,
            };
          } else {
            debugLogger.warn(
              `Agent hook "${hookName}": report_verdict args missing or invalid ok field`,
            );
          }
        }
      },
    };

    // ── Step F: Configure timeout + abort signal ─────────────
    const rawTimeout = hookConfig.timeout ?? DEFAULT_TIMEOUT_SECONDS;
    const timeoutSeconds = Math.max(1, Math.min(rawTimeout, 86400));
    const timeoutMs = timeoutSeconds * 1000;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;

    // ── Step G: Create YOLO-mode Config override (Gap 4: dontAsk) ──
    // Mirrors Claude Code's `mode: 'dontAsk'` — the hook subagent should
    // never trigger permission dialogs; all tools are auto-approved.
    // Using spread pattern instead of Object.create for robustness —
    // Object.create only works if getApprovalMode is a prototype method;
    // if it's ever changed to an instance property/arrow, the override
    // would silently fail.
    const hookAgentConfig = {
      ...this.config,
      getApprovalMode: () => ApprovalMode.YOLO,
    } as unknown as Config;
    if (hookAgentConfig.getApprovalMode() !== ApprovalMode.YOLO) {
      debugLogger.error(
        `Agent hook "${hookName}": failed to set YOLO approval mode`,
      );
    }
    debugLogger.debug(
      `Agent hook "${hookName}": using YOLO approval mode (dontAsk)`,
    );

    // ── Step H: Inject transcript path into system prompt (Gap 3) ──
    // Mirrors Claude Code's transcript path injection — the subagent can
    // read the parent conversation's transcript file to analyze history.
    const transcriptPath = this.config.getTranscriptPath();
    const transcriptSection = transcriptPath
      ? `\nThe conversation transcript is available at: ${transcriptPath}\nYou can read this file to analyze the conversation history if needed.\n`
      : '';

    // ── Step I: Build system prompt with transcript info ─────
    // The prompt strongly emphasises that report_verdict MUST be called.
    // Without this, models often finish with a plain text response instead
    // of calling the tool, which causes the hook to be treated as failed.
    const systemPromptOverride = `You are a verification agent. Your ONLY job is to verify a condition and report the result using the ${VERDICT_TOOL_NAME} tool.${transcriptSection}

CRITICAL INSTRUCTIONS:
1. Use the available tools to inspect the codebase and verify the condition.
2. Be efficient — use as few steps as possible.
3. You MUST call the ${VERDICT_TOOL_NAME} tool EXACTLY ONCE before finishing.
4. Do NOT respond with plain text. Your final action MUST be a ${VERDICT_TOOL_NAME} tool call.
5. Call ${VERDICT_TOOL_NAME} with: ok=true if the condition is met, or ok=false with a reason if not.

IMPORTANT: If you do not call ${VERDICT_TOOL_NAME}, your verification will be considered FAILED.`;

    // ── Step J: Create and execute the headless subagent ─────
    const maxTurns = hookConfig.maxTurns ?? MAX_AGENT_HOOK_TURNS;
    const modelConfigOverrides = hookConfig.model
      ? { model: hookConfig.model }
      : undefined;

    const headless = await subagentManager.createAgentHeadless(
      subagentConfig,
      hookAgentConfig,
      {
        hooks: agentHooks,
        promptConfigOverrides: {
          // Use renderedSystemPrompt to bypass buildChatSystemPrompt's
          // non-interactive append, which contradicts the hook's instruction
          // that the model MUST call report_verdict (not respond with text).
          renderedSystemPrompt: systemPromptOverride,
        },
        runConfigOverrides: {
          max_turns: maxTurns,
        },
        toolConfigOverride,
        ...(modelConfigOverrides ? { modelConfigOverrides } : {}),
      },
    );

    const context = new ContextState();
    context.set('task_prompt', processedPrompt);

    await headless.execute(context, combinedSignal);

    // ── Step K: Text-based verdict fallback ─────────────────
    // Many models finish with a plain text conclusion instead of calling
    // the report_verdict tool. When that happens, we parse the final text
    // to infer the verdict rather than failing outright.
    const terminateMode = headless.getTerminateMode();

    if (!captured.verdict && terminateMode === AgentTerminateMode.GOAL) {
      const finalText = headless.getFinalText();
      const inferredVerdict = parseVerdictFromText(finalText);
      if (inferredVerdict) {
        captured.verdict = inferredVerdict;
        debugLogger.debug(
          `Agent hook "${hookName}": inferred verdict from text (ok=${inferredVerdict.ok})`,
        );
      } else {
        debugLogger.warn(
          `Agent hook "${hookName}": could not infer verdict from text, defaulting to ok=${hookConfig.defaultVerdict ?? false}`,
        );
        // Default to blocking when the verdict cannot be inferred —
        // failing safe is better than silently allowing an action
        // that the model may have intended to block.
        // Users can override via `defaultVerdict: true` in AgentHookConfig
        // if they prefer lenient behavior.
        const fallbackOk = hookConfig.defaultVerdict ?? false;
        captured.verdict = {
          ok: fallbackOk,
          reason: fallbackOk
            ? 'Verdict could not be inferred from model output; defaulted to ok=true via defaultVerdict config'
            : 'Verdict could not be inferred from model output',
        };
      }
    }

    // ── Step L: Map verdict to HookExecutionResult ───────────
    const duration = Date.now() - startTime;

    if (!captured.verdict) {
      const reason =
        terminateMode === AgentTerminateMode.TIMEOUT
          ? `Agent hook timed out after ${timeoutSeconds}s`
          : terminateMode === AgentTerminateMode.MAX_TURNS
            ? `Agent hook exceeded max turns (${hookConfig.maxTurns ?? MAX_AGENT_HOOK_TURNS})`
            : `Agent hook cancelled (terminate=${terminateMode})`;
      debugLogger.warn(`Agent hook "${hookName}": ${reason}`);
      return {
        hookConfig,
        eventName,
        success: false,
        outcome: 'cancelled',
        error: new Error(reason),
        duration,
      };
    }

    // Verdict was captured
    if (!captured.verdict.ok) {
      debugLogger.debug(
        `Agent hook "${hookName}": verdict NOT OK — ${captured.verdict.reason}`,
      );

      if (hookConfig.advisoryOnly) {
        debugLogger.warn(
          `Agent hook "${hookName}": advisoryOnly=true, treating blocking verdict as non-blocking`,
        );
        return {
          hookConfig,
          eventName,
          success: false,
          outcome: 'non_blocking_error',
          output: {
            continue: false,
            stopReason: `Agent hook condition was not met: ${captured.verdict.reason ?? 'no reason provided'}`,
          },
          duration: Date.now() - startTime,
        };
      }

      return {
        hookConfig,
        eventName,
        success: false,
        outcome: 'blocking',
        output: {
          continue: false,
          stopReason: `Agent hook condition was not met: ${captured.verdict.reason ?? 'no reason provided'}`,
        },
        duration: Date.now() - startTime,
      };
    }

    // ok: true
    debugLogger.debug(`Agent hook "${hookName}": verdict OK`);
    return {
      hookConfig,
      eventName,
      success: true,
      outcome: 'success',
      output: { continue: true },
      duration: Date.now() - startTime,
    };
  }
}
