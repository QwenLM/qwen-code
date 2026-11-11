/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Zod schema for validating hook output JSON.
 *
 * Designed to be permissive enough to accept all valid hook outputs but
 * catch obvious structural errors (e.g. `decision` is a number, `continue`
 * is a string).  Uses Zod's default strip mode — unknown fields are silently
 * discarded, not rejected.
 */

import { z } from 'zod';
import { permissionUpdateSchema } from '../permissions/permission-update-schema.js';
import type { HookDecision, HookOutput } from './types.js';

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

const hookDecisionSchema = z
  .enum(['approve', 'block', 'allow', 'deny'])
  .optional();

const elicitationActionSchema = z
  .enum(['accept', 'decline', 'cancel'])
  .optional();

const permissionBehaviorSchema = z.enum(['allow', 'deny', 'ask', 'defer']);

// ---------------------------------------------------------------------------
// hookSpecificOutput variant schemas (discriminated on hookEventName)
// ---------------------------------------------------------------------------

const preToolUseSpecific = z.object({
  hookEventName: z.literal('PreToolUse'),
  permissionDecision: permissionBehaviorSchema.optional(),
  permissionDecisionReason: z.string().optional(),
  updatedInput: z.record(z.unknown()).optional(),
  additionalContext: z.string().optional(),
});

const postToolUseSpecific = z.object({
  hookEventName: z.literal('PostToolUse'),
  additionalContext: z.string().optional(),
  updatedToolOutput: z.unknown().optional(),
  updatedMCPToolOutput: z.unknown().optional(),
});

const subagentStartSpecific = z.object({
  hookEventName: z.literal('SubagentStart'),
  additionalContext: z.string().optional(),
});

const notificationSpecific = z.object({
  hookEventName: z.literal('Notification'),
  additionalContext: z.string().optional(),
});

const subagentStopSpecific = z.object({
  hookEventName: z.literal('SubagentStop'),
  clearContext: z.boolean().optional(),
});

const sessionStartSpecific = z.object({
  hookEventName: z.literal('SessionStart'),
  additionalContext: z.string().optional(),
});

const setupSpecific = z.object({
  hookEventName: z.literal('Setup'),
  additionalContext: z.string().optional(),
});

const postToolUseFailureSpecific = z.object({
  hookEventName: z.literal('PostToolUseFailure'),
  additionalContext: z.string().optional(),
});

const postCompactSpecific = z.object({
  hookEventName: z.literal('PostCompact'),
  additionalContext: z.string().optional(),
});

const stopSpecific = z.object({
  hookEventName: z.literal('Stop'),
  clearContext: z.boolean().optional(),
});

const queryEndSpecific = z.object({
  hookEventName: z.literal('QueryEnd'),
});

const userPromptSubmitSpecific = z.object({
  hookEventName: z.literal('UserPromptSubmit'),
  prompt: z.string().optional(),
  sessionTitle: z.string().optional(),
  additionalContext: z.string().optional(),
});

const configChangeSpecific = z.object({
  hookEventName: z.literal('ConfigChange'),
});

const stopFailureSpecific = z.object({
  hookEventName: z.literal('StopFailure'),
});

const teammateIdleSpecific = z.object({
  hookEventName: z.literal('TeammateIdle'),
});

const instructionsLoadedSpecific = z.object({
  hookEventName: z.literal('InstructionsLoaded'),
});

const cwdChangedSpecific = z.object({
  hookEventName: z.literal('CwdChanged'),
  watchPaths: z.array(z.string()).optional(),
  additionalContext: z.string().optional(),
});

const fileChangedSpecific = z.object({
  hookEventName: z.literal('FileChanged'),
  watchPaths: z.array(z.string()).optional(),
  additionalContext: z.string().optional(),
});

const worktreeCreateSpecific = z.object({
  hookEventName: z.literal('WorktreeCreate'),
  worktreePath: z.string().optional(),
});

const worktreeRemoveSpecific = z.object({
  hookEventName: z.literal('WorktreeRemove'),
  status: z.enum(['removed', 'retained', 'unknown']).optional(),
});

const elicitationSpecific = z.object({
  hookEventName: z.literal('Elicitation'),
  action: elicitationActionSchema,
  content: z.record(z.unknown()).optional(),
});

const elicitationResultSpecific = z.object({
  hookEventName: z.literal('ElicitationResult'),
  action: elicitationActionSchema,
  content: z.record(z.unknown()).optional(),
});

const taskCreatedSpecific = z.object({
  hookEventName: z.literal('TaskCreated'),
});

const taskCompletedSpecific = z.object({
  hookEventName: z.literal('TaskCompleted'),
});

const permissionRequestSpecific = z.object({
  hookEventName: z.literal('PermissionRequest'),
  decision: z
    .union([
      z.object({
        behavior: z.literal('allow'),
        updatedInput: z.record(z.unknown()).optional(),
        updatedPermissions: z.array(permissionUpdateSchema).optional(),
      }),
      z.object({
        behavior: z.literal('deny'),
        message: z.string().optional(),
        interrupt: z.boolean().optional(),
      }),
    ])
    .optional(),
});

const permissionDeniedSpecific = z.object({
  hookEventName: z.literal('PermissionDenied'),
  retry: z.boolean().optional(),
});

const preCompactSpecific = z.object({
  hookEventName: z.literal('PreCompact'),
  additionalContext: z.string().optional(),
});

const sessionEndSpecific = z.object({
  hookEventName: z.literal('SessionEnd'),
});

/**
 * Discriminated union of all hookSpecificOutput variants keyed by
 * hookEventName. Missing or unknown hookEventName values cause validation to
 * fail with an actionable error rather than silently dropping event-specific
 * fields like permissionDecision / updatedToolOutput.
 */
const hookSpecificOutputSchema = z.discriminatedUnion('hookEventName', [
  preToolUseSpecific,
  postToolUseSpecific,
  subagentStartSpecific,
  notificationSpecific,
  subagentStopSpecific,
  sessionStartSpecific,
  setupSpecific,
  postToolUseFailureSpecific,
  postCompactSpecific,
  stopSpecific,
  queryEndSpecific,
  userPromptSubmitSpecific,
  configChangeSpecific,
  stopFailureSpecific,
  teammateIdleSpecific,
  instructionsLoadedSpecific,
  cwdChangedSpecific,
  fileChangedSpecific,
  worktreeCreateSpecific,
  worktreeRemoveSpecific,
  elicitationSpecific,
  elicitationResultSpecific,
  taskCreatedSpecific,
  taskCompletedSpecific,
  permissionRequestSpecific,
  permissionDeniedSpecific,
  preCompactSpecific,
  sessionEndSpecific,
]);

/**
 * Lightweight schema used to short-circuit `async: true` payloads.
 * Async hooks declare backgrounding via this top-level marker; the rest of
 * the output (hookSpecificOutput / decision / etc.) is irrelevant to the
 * dispatcher and is stripped by normalizeHookOutput. Validating async output
 * against the strict discriminated union would reject benign payloads like
 * `{async: true, hookSpecificOutput: {additionalContext: 'x'}}`, breaking
 * existing async hook contracts.
 */
const asyncOnlyHookOutputSchema = z
  .object({
    async: z.literal(true),
    asyncTimeout: z.number().optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Top-level HookOutput schema
// ---------------------------------------------------------------------------

/**
 * Zod schema that validates the top-level shape of a HookOutput object.
 *
 * All fields are optional (a bare `{}` is a valid hook output).
 * Uses Zod's default strip mode — unknown keys are silently discarded.
 */
export const hookOutputSchema = z.object({
  async: z.literal(true).optional(),
  asyncTimeout: z.number().optional(),
  continue: z.boolean().optional(),
  stopReason: z.string().optional(),
  suppressOutput: z.boolean().optional(),
  systemMessage: z.string().optional(),
  decision: hookDecisionSchema,
  reason: z.string().optional(),
  rewakeSummary: z.string().optional(),
  hookSpecificOutput: hookSpecificOutputSchema.optional(),
});

export type ValidatedHookOutput = z.infer<typeof hookOutputSchema>;

type RawHookDecision = z.infer<typeof hookDecisionSchema>;

function normalizeHookDecision(decision: RawHookDecision): HookDecision {
  switch (decision) {
    case 'approve':
      return 'allow';
    case 'block':
      return 'deny';
    default:
      return decision;
  }
}

export function normalizeHookOutput(output: ValidatedHookOutput): HookOutput {
  if (output.async === true) {
    const result: HookOutput = { async: true };
    if (output.asyncTimeout !== undefined) {
      result.asyncTimeout = output.asyncTimeout;
    }
    return result;
  }

  const normalized = { ...output } as HookOutput;
  const decision = normalizeHookDecision(output.decision);
  if (decision === undefined) {
    delete normalized.decision;
  } else {
    normalized.decision = decision;
  }
  return normalized;
}

const REDACTED_RAW_DUMP_MAX_CHARS = 2000;
const SECRET_KEY_PATTERN =
  /(token|secret|password|api[_-]?key|authorization)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Stringify hook output for inclusion in user-facing error messages.
 * Redacts values whose key looks like a credential and truncates the dump
 * to keep TUI / SDK / log payloads bounded.
 */
function redactedRawDump(
  value: unknown,
  maxChars: number = REDACTED_RAW_DUMP_MAX_CHARS,
): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(
      value,
      (key, val: unknown): unknown =>
        SECRET_KEY_PATTERN.test(key) ? '[REDACTED]' : val,
      2,
    );
  } catch {
    serialized = String(value);
  }
  if (serialized.length > maxChars) {
    return (
      serialized.slice(0, maxChars) +
      `\n…[truncated, total ${serialized.length} chars]`
    );
  }
  return serialized;
}

export function validateHookOutput(
  value: unknown,
): { success: true; output: HookOutput } | { success: false; error: string } {
  // 1) async:true short-circuit — bypass the strict discriminated union so
  //    that async hooks keep their long-standing strip-sync-fields contract
  //    (validateHookOutput({async: true, hookSpecificOutput: {...}}) returns
  //    just `{async: true, asyncTimeout?}`). Async hooks NEVER get
  //    hookEventName strictness applied to their stdout — see
  //    hookEventHandler.ts pendingAsyncContexts injection path.
  if (isRecord(value) && value['async'] === true) {
    const lite = asyncOnlyHookOutputSchema.safeParse(value);
    if (!lite.success) {
      const issue = lite.error.issues[0];
      const detail = issue
        ? `${issue.path.join('.') || '(root)'}: ${issue.message}`
        : 'unknown error';
      return {
        success: false,
        error:
          `Hook JSON output validation failed — async: ${detail}\n` +
          `The hook's output was: ${redactedRawDump(value)}`,
      };
    }
    return {
      success: true,
      output: normalizeHookOutput({
        async: true,
        asyncTimeout: lite.data.asyncTimeout,
      } as ValidatedHookOutput),
    };
  }

  // 2) Sync path: friendly precheck for missing hookEventName so the error
  //    points the developer directly at the missing field instead of
  //    surfacing a generic "Invalid discriminator value" from zod.
  if (isRecord(value)) {
    const hso = value['hookSpecificOutput'];
    if (isRecord(hso) && !('hookEventName' in hso)) {
      const onlyAdditionalContext =
        Object.keys(hso).length === 1 && 'additionalContext' in hso;
      const recoveryHint = onlyAdditionalContext
        ? ' Did you mean hookSpecificOutput.additionalContext (with a hookEventName)?'
        : '';
      return {
        success: false,
        error:
          `hookSpecificOutput is missing required field "hookEventName"${recoveryHint}\n` +
          `The hook's output was: ${redactedRawDump(value)}`,
      };
    }
  }

  // 3) Full strict schema validation.
  const validation = hookOutputSchema.safeParse(value);
  if (!validation.success) {
    const issues = validation.error.issues;
    const head = issues[0]
      ? `${issues[0].path.join('.') || '(root)'}: ${issues[0].message}`
      : 'unknown error';
    const rest = issues
      .slice(1)
      .map(
        (issue) =>
          `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`,
      )
      .join('\n');
    return {
      success: false,
      error:
        `Hook JSON output validation failed — ${head}` +
        (rest ? `\n${rest}` : '') +
        `\nThe hook's output was: ${redactedRawDump(value)}`,
    };
  }

  return { success: true, output: normalizeHookOutput(validation.data) };
}
