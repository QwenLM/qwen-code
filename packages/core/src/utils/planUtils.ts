/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { isEmpty, fileExists } from './fileUtils.js';
import { isSubpath, resolveToRealPath } from './paths.js';
import type { Config } from '../config/config.js';
import {
  getBusinessInfoFromContext,
  getRequestSetIdFromContext,
} from './sessionIdContext.js';
import { applyBusinessSubTask } from '../qoder/business-info.js';

/**
 * Standard error messages for the plan approval workflow.
 * Shared between backend tools and CLI UI for consistency.
 */
export const PlanErrorMessages = {
  PATH_ACCESS_DENIED: (planPath: string, plansDir: string) =>
    `Access denied: plan path (${planPath}) must be within the designated plans directory (${plansDir}).`,
  FILE_NOT_FOUND: (path: string) =>
    `Plan file does not exist: ${path}. You must create the plan file before requesting approval.`,
  FILE_EMPTY:
    'Plan file is empty. You must write content to the plan file before requesting approval.',
  READ_FAILURE: (detail: string) => `Failed to read plan file: ${detail}`,
} as const;

/**
 * Validates a plan file path for safety (traversal) and existence.
 * @param planPath The untrusted path to the plan file.
 * @param plansDir The authorized project plans directory.
 * @param targetDir The current working directory (project root).
 * @returns An error message if validation fails, or null if successful.
 */
export async function validatePlanPath(
  planPath: string,
  plansDir: string,
): Promise<string | null> {
  const safeFilename = path.basename(planPath);
  const resolvedPath = path.join(plansDir, safeFilename);
  const realPath = resolveToRealPath(resolvedPath);
  const realPlansDir = resolveToRealPath(plansDir);

  if (!isSubpath(realPlansDir, realPath)) {
    return PlanErrorMessages.PATH_ACCESS_DENIED(planPath, realPlansDir);
  }

  if (!(await fileExists(resolvedPath))) {
    return PlanErrorMessages.FILE_NOT_FOUND(planPath);
  }

  return null;
}

/**
 * Validates that a plan file has non-empty content.
 * @param planPath The path to the plan file.
 * @returns An error message if the file is empty or unreadable, or null if successful.
 */
export async function validatePlanContent(
  planPath: string,
): Promise<string | null> {
  try {
    if (await isEmpty(planPath)) {
      return PlanErrorMessages.FILE_EMPTY;
    }
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return PlanErrorMessages.READ_FAILURE(message);
  }
}

/**
 * Returns the plan file path for the current session, derived from
 * planStateManager using the session's storage directory and ID.
 *
 * Centralises the three-call pattern used across ExitPlanModeTool,
 * the STE pre-execution gate, and other callers.
 */
export function resolveCurrentPlanPath(config: Config): string {
  return config.planStateManager.getPlanFilePath(
    config.storage.getPlansDir(),
    config.getSessionId(),
  );
}

/**
 * Generate a 5-word-or-fewer session name from the approved plan content
 * and persist it as the active session title.
 *
 * This is called fire-and-forget from ExitPlanModeTool after approval.
 * Failures are silently ignored — a bad name is not a blocker.
 *
 * @param planContent First ~1000 chars of the plan file.
 * @param config      Active Config instance.
 * @param timeoutMs   Maximum time to wait for the LLM response (default 10 s).
 */
export async function autoNameSessionFromPlan(
  planContent: string,
  config: Config,
  timeoutMs = 10_000,
): Promise<void> {
  const prompt = `In 5 words or fewer, name this implementation task. Reply with ONLY the name — no punctuation, no quotes, no explanation.\n\n${planContent}`;

  const signal = AbortSignal.timeout(timeoutMs);
  const manager = config.getModelProviderManager();
  const resolution = await manager.select({ purpose: 'title' });
  signal.throwIfAborted();
  const parentBusiness = getBusinessInfoFromContext();
  const request = {
    resolution,
    prompt: { messages: [{ role: 'user' as const, content: prompt }] },
    signal,
    qoder: {
      identity: {
        sessionId: config.getSessionId(),
        requestSetId: getRequestSetIdFromContext(),
      },
      ...(parentBusiness ? { business: applyBusinessSubTask({ ...parentBusiness }) } : {}),
    },
  };
  const response = await manager.inference(request);
  const message = await response.completed;

  const name = message.blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
  if (name) {
    config.topicState.setTopic(name, undefined);
    await config.persistSessionTitle(name);
  }
}
