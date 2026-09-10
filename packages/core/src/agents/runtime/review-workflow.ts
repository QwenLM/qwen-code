/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parsePositiveIntegerEnv } from '../../utils/env.js';
import {
  resolveConcurrencyLimit,
  resolveSubagentMaxTimeMinutes,
  resolveSubagentMaxTurns,
  MAX_WORKFLOW_CONCURRENCY_ENV,
  type WorkflowSubagentBounds,
} from './workflow-orchestrator.js';

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
  env: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now(),
): Promise<ReviewWorkflowLimits | undefined> {
  let generatedRoot: string;
  try {
    if ((await fs.lstat(generatedDir)).isSymbolicLink()) return undefined;
    generatedRoot = await fs.realpath(generatedDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const script = await fs.realpath(scriptPath);
  if (!script.startsWith(path.join(generatedRoot, 'review') + path.sep)) {
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
