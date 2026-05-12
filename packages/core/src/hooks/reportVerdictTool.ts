/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Structured verdict tool for agent hooks.
 *
 * This tool is injected into agent hook subagents so they can report a
 * structured pass/fail verdict. It is analogous to Claude Code's
 * `createStructuredOutputTool` / `SyntheticOutputTool` with `hookResponseSchema`.
 *
 * The tool is NOT registered in the global ToolRegistry — it is only
 * injected into the subagent's `ToolConfig.tools` as an inline
 * `FunctionDeclaration` by `AgentHookRunner`.
 */
import type { FunctionDeclaration } from '@google/genai';

/**
 * Canonical name for the verdict tool. Must not collide with any name in ToolNames.
 */
export const VERDICT_TOOL_NAME = 'report_verdict';

/**
 * Payload shape returned by the verdict tool call.
 */
export interface VerdictPayload {
  /** Whether the verified condition was met */
  ok: boolean;
  /** Explanation when ok is false */
  reason?: string;
}

/**
 * Builds the FunctionDeclaration for `report_verdict`.
 *
 * Uses `parametersJsonSchema` (JSON Schema draft-07) which is the standard
 * format used across the qwen-code tool declarations (see exitPlanMode.ts,
 * todoWrite.ts, etc.).
 *
 * This declaration is designed for inline injection into
 * `ToolConfig.tools` as a `FunctionDeclaration` (not a string reference).
 * `AgentCore.prepareTools` passes non-string entries through as-is.
 */
export function buildReportVerdictFunctionDeclaration(): FunctionDeclaration {
  return {
    name: VERDICT_TOOL_NAME,
    description:
      'Report the final verdict of the verification. ' +
      'You MUST call this tool exactly once before finishing. ' +
      'Set ok=true if the condition is satisfied, or ok=false with a reason if not.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        ok: {
          type: 'boolean',
          description: 'true if the verified condition is met, false otherwise',
        },
        reason: {
          type: 'string',
          description:
            'Explanation of why the condition was not met (required when ok is false)',
        },
      },
      required: ['ok'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
  };
}
