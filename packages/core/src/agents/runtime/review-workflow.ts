/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createDebugLogger } from '../../utils/debugLogger.js';
import { parsePositiveIntegerEnv } from '../../utils/env.js';
import {
  resolveConcurrencyLimit,
  resolveSubagentMaxTimeMinutes,
  resolveSubagentMaxTurns,
  MAX_WORKFLOW_CONCURRENCY_ENV,
  type WorkflowSubagentBounds,
} from './workflow-orchestrator.js';

const debugLogger = createDebugLogger('REVIEW_WORKFLOW');

export function resolveReviewWorkflowConcurrency(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const configured =
    parsePositiveIntegerEnv(env[MAX_WORKFLOW_CONCURRENCY_ENV], 0) ||
    parsePositiveIntegerEnv(env['QWEN_CODE_MAX_TOOL_CONCURRENCY'], 10);
  return resolveConcurrencyLimit({
    [MAX_WORKFLOW_CONCURRENCY_ENV]: String(configured),
  });
}

export interface ReviewWorkflowLimits {
  subagent: WorkflowSubagentBounds;
  concurrency: number;
  maxWallClockMs: number;
}

export async function resolveReviewWorkflowLimits(
  scriptPath: string,
  generatedDir: string,
  scriptContent: string,
  env: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now(),
): Promise<ReviewWorkflowLimits | undefined> {
  let canonicalScript: string;
  try {
    if ((await fs.lstat(generatedDir)).isSymbolicLink()) return undefined;
    const generatedRoot = await fs.realpath(generatedDir);
    canonicalScript = await fs.realpath(scriptPath);
    if (
      !canonicalScript.startsWith(path.join(generatedRoot, 'review') + path.sep)
    ) {
      return undefined;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      debugLogger.warn(
        'Cannot classify review workflow; using generic limits:',
        error,
      );
    }
    return undefined;
  }
  const digest = /^qwen-review-[a-f0-9]{10}-([a-f0-9]{64})\.js$/.exec(
    path.basename(canonicalScript),
  )?.[1];
  // Hash the source already loaded for execution, not a second filesystem read.
  if (
    !digest ||
    createHash('sha256').update(scriptContent).digest('hex') !== digest
  ) {
    return undefined;
  }

  const seconds = Number(env['QWEN_CODE_MAX_WORKFLOW_SECONDS']);
  let maxWallClockMs =
    (Number.isFinite(seconds) && seconds > 0 ? seconds : 6 * 60 * 60) * 1000;
  const deadline = Number(env['QWEN_REVIEW_DEADLINE_EPOCH']);
  if (Number.isFinite(deadline) && deadline > 0) {
    const rawFloor = env['QWEN_REVIEW_DEADLINE_COMPOSE_FLOOR_SECONDS'];
    const floor = Number(rawFloor);
    const floorSeconds =
      rawFloor?.trim() && Number.isFinite(floor) && floor >= 0 ? floor : 1200;
    const remainingMs = deadline * 1000 - nowMs - floorSeconds * 1000;
    if (remainingMs <= 0) {
      throw new Error(
        'Review workflow was not launched: the review deadline has reached ' +
          'the compose reserve floor. Recover completed findings and compose now.',
      );
    }
    maxWallClockMs = Math.min(maxWallClockMs, remainingMs);
  }
  return {
    subagent: {
      max_turns: resolveSubagentMaxTurns(env, 500),
      max_time_minutes: resolveSubagentMaxTimeMinutes(env, 100),
    },
    concurrency: resolveReviewWorkflowConcurrency(env),
    maxWallClockMs,
  };
}
