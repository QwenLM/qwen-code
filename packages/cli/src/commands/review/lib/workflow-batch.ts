/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import type { WorkflowAgentSpec } from '../workflow-script.js';
import { readRecordedPrompts } from './prompt-record.js';

interface WorkflowBatch {
  plan: string;
  epoch: number;
  agents: Array<{ key: string; digest: string }>;
}

const digest = (prompt: string): string =>
  createHash('sha256').update(prompt).digest('hex');

export function createWorkflowBatch(
  planPath: string,
  keys: string[],
): WorkflowBatch {
  const epoch = statSync(planPath).mtimeMs;
  const records = readRecordedPrompts(planPath, epoch);
  if (keys.length === 0 || new Set(keys).size !== keys.length) {
    throw new Error(
      'review batch: expected a nonempty set of unique agent keys',
    );
  }
  return {
    plan: realpathSync(planPath),
    epoch,
    agents: keys.map((key) => {
      const prompt = records.get(key);
      if (!prompt?.trim()) {
        throw new Error(`review batch: missing or stale prompt for ${key}`);
      }
      return { key, digest: digest(prompt) };
    }),
  };
}

export function readWorkflowBatches(
  planPath: string,
  manifestPaths: string[],
): WorkflowAgentSpec[] {
  const plan = realpathSync(planPath);
  const epoch = statSync(planPath).mtimeMs;
  const records = readRecordedPrompts(planPath, epoch);
  const seen = new Set<string>();
  const agents: WorkflowAgentSpec[] = [];
  if (manifestPaths.length === 0) {
    throw new Error('review batch: no manifests selected');
  }
  for (const file of manifestPaths) {
    const batch = JSON.parse(
      readFileSync(file, 'utf8'),
    ) as WorkflowBatch | null;
    if (
      batch?.plan !== plan ||
      batch.epoch !== epoch ||
      !Array.isArray(batch.agents) ||
      batch.agents.length === 0
    ) {
      throw new Error(
        `review batch: ${file} is empty or belongs to another plan/run`,
      );
    }
    for (const entry of batch.agents) {
      if (typeof entry?.key !== 'string' || seen.has(entry.key)) {
        throw new Error(
          `review batch: invalid or duplicate agent key in ${file}`,
        );
      }
      const prompt = records.get(entry.key);
      if (!prompt?.trim() || digest(prompt) !== entry.digest) {
        throw new Error(
          `review batch: missing, stale or changed prompt for ${entry.key}`,
        );
      }
      seen.add(entry.key);
      agents.push({ key: entry.key, prompt });
    }
  }
  return agents;
}
