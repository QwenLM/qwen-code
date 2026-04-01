/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared permission-evaluation and persistence helpers.
 *
 * These are used by both `coreToolScheduler` (CLI mode) and the ACP
 * `Session` (VS Code / webui mode) so that the L3→L4→L5 permission flow
 * and the "Always Allow" persistence logic stay in sync.
 */

import * as path from 'node:path';
import type { PermissionCheckContext } from '../permissions/types.js';
import type { PermissionManager } from '../permissions/permission-manager.js';
import type {
  ToolCallConfirmationDetails,
  ToolConfirmationPayload,
} from '../tools/tools.js';
import { ToolConfirmationOutcome } from '../tools/tools.js';
import { buildPermissionRules } from '../permissions/rule-parser.js';

// ─────────────────────────────────────────────────────────────────────────────
// Context building
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a {@link PermissionCheckContext} from raw tool invocation parameters.
 *
 * Extracts `command`, `filePath`, `domain`, and `specifier` fields from the
 * tool's params, resolving relative paths against `targetDir`.
 */
export function buildPermissionCheckContext(
  toolName: string,
  toolParams: Record<string, unknown>,
  targetDir: string,
): PermissionCheckContext {
  const command =
    'command' in toolParams ? String(toolParams['command']) : undefined;

  // Extract file path — tools use 'file_path' or 'path' (LS / grep / glob).
  let filePath =
    typeof toolParams['file_path'] === 'string'
      ? toolParams['file_path']
      : undefined;
  if (filePath === undefined && typeof toolParams['path'] === 'string') {
    // LS uses absolute paths; grep/glob may be relative to targetDir.
    filePath = path.isAbsolute(toolParams['path'])
      ? toolParams['path']
      : path.resolve(targetDir, toolParams['path']);
  }

  let domain: string | undefined;
  if (typeof toolParams['url'] === 'string') {
    try {
      domain = new URL(toolParams['url']).hostname;
    } catch {
      // malformed URL — leave domain undefined
    }
  }

  // Generic specifier for literal matching (Skill name, Task subagent type, etc.)
  const specifier =
    typeof toolParams['skill'] === 'string'
      ? toolParams['skill']
      : typeof toolParams['subagent_type'] === 'string'
        ? toolParams['subagent_type']
        : undefined;

  return { toolName, command, filePath, domain, specifier };
}

// ─────────────────────────────────────────────────────────────────────────────
// PM evaluation
// ─────────────────────────────────────────────────────────────────────────────

/** Result of {@link evaluatePermissionRules}. */
export interface PermissionEvalResult {
  /** The final permission after PM override. */
  finalPermission: string;
  /**
   * `true` when PM explicitly forces `'ask'`.  In that case "Always Allow"
   * buttons should be hidden because allow rules can never override the
   * higher-priority ask rule.
   */
  pmForcedAsk: boolean;
}

/**
 * L4 — evaluate {@link PermissionManager} rules against the given context.
 *
 * Returns the final permission decision and whether PM forced 'ask'.
 * When `defaultPermission` is already `'deny'`, PM evaluation is skipped.
 */
export async function evaluatePermissionRules(
  pm: PermissionManager | null | undefined,
  defaultPermission: string,
  pmCtx: PermissionCheckContext,
): Promise<PermissionEvalResult> {
  let finalPermission = defaultPermission;
  let pmForcedAsk = false;

  if (pm && defaultPermission !== 'deny') {
    if (pm.hasRelevantRules(pmCtx)) {
      const pmDecision = await pm.evaluate(pmCtx);
      if (pmDecision !== 'default') {
        finalPermission = pmDecision;
        // If PM explicitly forces 'ask', adding allow rules won't help
        // because ask has higher priority. Hide "Always allow" options.
        if (pmDecision === 'ask' && pm.hasMatchingAskRule(pmCtx)) {
          pmForcedAsk = true;
        }
      }
    }
  }

  return { finalPermission, pmForcedAsk };
}

// ─────────────────────────────────────────────────────────────────────────────
// Centralised rule injection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Inject centralized permission rules into confirmation details when the tool
 * doesn't provide its own.  This ensures "Always Allow" persists a properly
 * scoped rule rather than nothing.
 *
 * Only `exec` / `mcp` / `info` types support the `permissionRules` field.
 * Mutates `confirmationDetails` in place.
 */
export function injectPermissionRulesIfMissing(
  confirmationDetails: ToolCallConfirmationDetails,
  pmCtx: PermissionCheckContext,
): void {
  if (
    (confirmationDetails.type === 'exec' ||
      confirmationDetails.type === 'mcp' ||
      confirmationDetails.type === 'info') &&
    !confirmationDetails.permissionRules
  ) {
    confirmationDetails.permissionRules = buildPermissionRules(pmCtx);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Permission persistence
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persist permission rules for `ProceedAlwaysProject` / `ProceedAlwaysUser`
 * outcomes.
 *
 * Reads rules from `confirmationDetails.permissionRules` (set by the tool or
 * by {@link injectPermissionRulesIfMissing}), falling back to
 * `payload.permissionRules` for backward compatibility.
 *
 * Writes to disk via `persistFn` and updates the in-memory
 * {@link PermissionManager}.  No-op for other outcomes.
 */
export async function persistPermissionOutcome(
  outcome: ToolConfirmationOutcome,
  confirmationDetails: ToolCallConfirmationDetails,
  persistFn:
    | ((
        scope: 'project' | 'user',
        ruleType: 'allow' | 'ask' | 'deny',
        rule: string,
      ) => Promise<void>)
    | undefined,
  pm: PermissionManager | null | undefined,
  payload?: ToolConfirmationPayload,
): Promise<void> {
  if (
    outcome !== ToolConfirmationOutcome.ProceedAlwaysProject &&
    outcome !== ToolConfirmationOutcome.ProceedAlwaysUser
  ) {
    return;
  }

  const scope =
    outcome === ToolConfirmationOutcome.ProceedAlwaysProject
      ? 'project'
      : 'user';

  // Read permissionRules from the stored confirmation details first,
  // falling back to payload for backward compatibility.
  const detailsRules = (
    confirmationDetails as unknown as Record<string, unknown>
  )?.['permissionRules'] as string[] | undefined;
  const payloadRules = payload?.permissionRules;
  const rules = payloadRules ?? detailsRules ?? [];

  if (rules.length > 0) {
    for (const rule of rules) {
      // 1. Persist to disk (settings.json)
      if (persistFn) {
        await persistFn(scope, 'allow', rule);
      }
      // 2. Immediately update in-memory PermissionManager so the
      //    new rule takes effect without restart.
      pm?.addPersistentRule(rule, 'allow');
    }
  }
}
