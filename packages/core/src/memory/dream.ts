/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import type { Config } from '../config/config.js';
import { getAutoMemoryMetadataPath } from './paths.js';
import { planManagedAutoMemoryDreamByAgent } from './dreamAgentPlanner.js';
import { rebuildManagedAutoMemoryIndex } from './indexer.js';
import { ensureAutoMemoryScaffold } from './store.js';
import {
  AUTO_MEMORY_TYPES,
  type AutoMemoryMetadata,
  type AutoMemoryType,
} from './types.js';
import { logMemoryDream, MemoryDreamEvent } from '../telemetry/index.js';

export interface AutoMemoryDreamResult {
  touchedTopics: AutoMemoryType[];
  dedupedEntries: number;
  systemMessage?: string;
}

async function runDreamByAgent(
  projectRoot: string,
  config: Config,
  abortSignal?: AbortSignal,
): Promise<AutoMemoryDreamResult> {
  const result = await planManagedAutoMemoryDreamByAgent(
    config,
    projectRoot,
    abortSignal,
  );

  // Infer which topics were touched from the file paths
  const touchedTopics = new Set<AutoMemoryType>();
  for (const filePath of result.filesTouched) {
    const normalized = filePath.replace(/\\/g, '/');
    for (const type of AUTO_MEMORY_TYPES) {
      if (normalized.includes(`/${type}/`)) {
        touchedTopics.add(type);
      }
    }
  }

  const summary = result.finalText
    ? result.finalText.trim().slice(0, 300)
    : `updated ${result.filesTouched.length} file(s)`;

  return {
    touchedTopics: [...touchedTopics],
    dedupedEntries: 0,
    systemMessage: `Managed auto-memory dream (agent): ${summary}`,
  };
}

export async function runManagedAutoMemoryDream(
  projectRoot: string,
  now = new Date(),
  config?: Config,
  abortSignal?: AbortSignal,
): Promise<AutoMemoryDreamResult> {
  await ensureAutoMemoryScaffold(projectRoot, now);
  const t0 = Date.now();

  if (!config) {
    throw new Error(
      'Managed auto-memory dream requires config for forked-agent execution.',
    );
  }

  const agentResult = await runDreamByAgent(projectRoot, config, abortSignal);
  // Cancel-aware ordering:
  //   1. If aborted before this point, return the agent's partial result
  //      WITHOUT rebuilding the index — index rebuild can be expensive
  //      and re-running a cancelled dream cycle next time will rebuild
  //      against the latest topic files anyway.
  //   2. If still alive, rebuild the index (informational, powers
  //      recall) — but only when topics actually changed.
  // Scheduler-gating metadata (`lastDreamAt`, `lastDreamSessionId`,
  // `lastDreamTouchedTopics`, `lastDreamStatus`) is intentionally NOT
  // written here — `MemoryManager.runDream` owns the atomic
  // status-flip + metadata-write sequence to close the cancel race
  // window where a writeFile finishing concurrently with a cancel
  // could persist gating metadata for a record the manager is about
  // to mark `'cancelled'`.
  if (abortSignal?.aborted) return agentResult;
  if (agentResult.touchedTopics.length > 0) {
    await rebuildManagedAutoMemoryIndex(projectRoot);
  }

  logMemoryDream(
    config,
    new MemoryDreamEvent({
      trigger: 'auto',
      status: agentResult.touchedTopics.length > 0 ? 'updated' : 'noop',
      deduped_entries: agentResult.dedupedEntries,
      touched_topics: agentResult.touchedTopics,
      duration_ms: Date.now() - t0,
    }),
  );
  return agentResult;
}

async function updateDreamMetadataResult(
  projectRoot: string,
  now: Date,
  touchedTopics: AutoMemoryType[],
  sessionId?: string,
): Promise<void> {
  const metadataPath = getAutoMemoryMetadataPath(projectRoot);
  try {
    const content = await fs.readFile(metadataPath, 'utf-8');
    const metadata = JSON.parse(content) as AutoMemoryMetadata;
    metadata.updatedAt = now.toISOString();
    metadata.lastDreamAt = now.toISOString();
    metadata.lastDreamTouchedTopics = touchedTopics;
    metadata.lastDreamStatus = touchedTopics.length > 0 ? 'updated' : 'noop';
    if (sessionId !== undefined) {
      metadata.lastDreamSessionId = sessionId;
      metadata.recentSessionIdsSinceDream = [];
    }
    await fs.writeFile(
      metadataPath,
      `${JSON.stringify(metadata, null, 2)}\n`,
      'utf-8',
    );
  } catch {
    // Best-effort metadata bump.
  }
}

/**
 * Record that the user manually ran /dream. Called from the CLI command's
 * onComplete callback after the main agent turn finishes writing memory files.
 * Writes lastDreamAt, lastDreamSessionId, and resets recentSessionIdsSinceDream
 * so that the scheduler's same-session dedupe check prevents a redundant
 * auto-dream from firing in the same session.
 */
export async function writeDreamManualRunToMetadata(
  projectRoot: string,
  sessionId: string,
  now = new Date(),
): Promise<void> {
  return updateDreamMetadataResult(projectRoot, now, [], sessionId);
}
