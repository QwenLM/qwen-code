/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import type { Config } from '../config/config.js';
import {
  mergeAutoMemoryEntry,
  parseAutoMemoryEntries,
  renderAutoMemoryBody,
} from './entries.js';
import { getAutoMemoryMetadataPath } from './paths.js';
import { planManagedAutoMemoryDreamByAgent } from './dreamAgentPlanner.js';
import { rebuildManagedAutoMemoryIndex } from './indexer.js';
import {
  scanAutoMemoryTopicDocuments,
  type ScannedAutoMemoryDocument,
} from './scan.js';
import { ensureAutoMemoryScaffold } from './store.js';
import { AUTO_MEMORY_TYPES, type AutoMemoryMetadata, type AutoMemoryType } from './types.js';

export interface AutoMemoryDreamResult {
  touchedTopics: AutoMemoryType[];
  dedupedEntries: number;
  systemMessage?: string;
}


function buildDreamedBody(body: string): { body: string; dedupedEntries: number } {
  const entries = parseAutoMemoryEntries(body);
  const mergedEntries = Array.from(
    entries.reduce((map, entry) => {
      const key = entry.summary.toLowerCase();
      const current = map.get(key);
      map.set(key, current ? mergeAutoMemoryEntry(current, entry) : entry);
      return map;
    }, new Map<string, ReturnType<typeof parseAutoMemoryEntries>[number]>()),
  )
    .map(([, entry]) => entry)
    .sort((a, b) => a.summary.localeCompare(b.summary));

  return {
    body: renderAutoMemoryBody('', mergedEntries),
    dedupedEntries: Math.max(0, entries.length - mergedEntries.length),
  };
}

async function bumpMetadata(projectRoot: string, now: Date): Promise<void> {
  const metadataPath = getAutoMemoryMetadataPath(projectRoot);
  try {
    const content = await fs.readFile(metadataPath, 'utf-8');
    const metadata = JSON.parse(content) as AutoMemoryMetadata;
    metadata.updatedAt = now.toISOString();
    metadata.lastDreamAt = now.toISOString();
    await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf-8');
  } catch {
    // Best-effort metadata bump.
  }
}

async function runDreamByAgent(
  projectRoot: string,
  config: Config,
): Promise<AutoMemoryDreamResult | null> {
  const result = await planManagedAutoMemoryDreamByAgent(config, projectRoot);
  if (result.filesTouched.length === 0) {
    return null;
  }

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

async function writeUpdatedBody(
  doc: ScannedAutoMemoryDocument,
  nextBody: string,
): Promise<boolean> {
  const current = await fs.readFile(doc.filePath, 'utf-8');
  const next = current.replace(doc.body, nextBody);
  if (next === current) {
    return false;
  }
  await fs.writeFile(doc.filePath, next, 'utf-8');
  return true;
}

export async function runManagedAutoMemoryDream(
  projectRoot: string,
  now = new Date(),
  config?: Config,
): Promise<AutoMemoryDreamResult> {
  await ensureAutoMemoryScaffold(projectRoot, now);

  if (config) {
    try {
      const agentResult = await runDreamByAgent(projectRoot, config);
      if (agentResult) {
        if (agentResult.touchedTopics.length > 0) {
          await bumpMetadata(projectRoot, now);
          await rebuildManagedAutoMemoryIndex(projectRoot);
        }
        await updateDreamMetadataResult(projectRoot, now, agentResult.touchedTopics);
        return agentResult;
      }
    } catch {
      // Fall back to the existing mechanical dream implementation.
    }
  }

  const docs = await scanAutoMemoryTopicDocuments(projectRoot);
  const touchedTopics = new Set<AutoMemoryType>();
  let dedupedEntries = 0;
  const canonicalByKey = new Map<string, ScannedAutoMemoryDocument>();

  for (const doc of docs) {
    const dreamed = buildDreamedBody(doc.body);
    if (dreamed.body !== doc.body.trim()) {
      const wrote = await writeUpdatedBody(doc, dreamed.body);
      if (wrote) {
        touchedTopics.add(doc.type);
      }
    }

    const [entry] = parseAutoMemoryEntries(dreamed.body);
    if (!entry) {
      continue;
    }

    dedupedEntries += dreamed.dedupedEntries;
    const dedupeKey = `${doc.type}:${entry.summary.toLowerCase()}`;
    const canonical = canonicalByKey.get(dedupeKey);

    if (!canonical) {
      canonicalByKey.set(dedupeKey, doc);
      continue;
    }

    const [canonicalEntry] = parseAutoMemoryEntries(canonical.body);
    const mergedEntry = mergeAutoMemoryEntry(canonicalEntry ?? entry, entry);
    const mergedBody = renderAutoMemoryBody('', [mergedEntry]);

    if (mergedBody !== canonical.body.trim()) {
      const wrote = await writeUpdatedBody(canonical, mergedBody);
      if (wrote) {
        touchedTopics.add(canonical.type);
      }
    }

    await fs.unlink(doc.filePath);
    touchedTopics.add(doc.type);
    dedupedEntries += 1;
  }

  if (touchedTopics.size > 0) {
    await bumpMetadata(projectRoot, now);
    await rebuildManagedAutoMemoryIndex(projectRoot);
  }

  await updateDreamMetadataResult(projectRoot, now, [...touchedTopics]);

  return {
    touchedTopics: [...touchedTopics],
    dedupedEntries,
    systemMessage:
      touchedTopics.size > 0
        ? `Managed auto-memory dream updated: ${[...touchedTopics].map((topic) => `${topic}.md`).join(', ')}`
        : undefined,
  };
}

async function updateDreamMetadataResult(
  projectRoot: string,
  now: Date,
  touchedTopics: AutoMemoryType[],
): Promise<void> {
  const metadataPath = getAutoMemoryMetadataPath(projectRoot);
  try {
    const content = await fs.readFile(metadataPath, 'utf-8');
    const metadata = JSON.parse(content) as AutoMemoryMetadata;
    metadata.updatedAt = now.toISOString();
    metadata.lastDreamAt = now.toISOString();
    metadata.lastDreamTouchedTopics = touchedTopics;
    metadata.lastDreamStatus = touchedTopics.length > 0 ? 'updated' : 'noop';
    await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf-8');
  } catch {
    // Best-effort metadata bump.
  }
}

/**
 * Record that the user manually ran /dream. Called from the CLI command's
 * onComplete callback after the main agent turn finishes writing memory files.
 * Writes lastDreamAt (and resets recentSessionIdsSinceDream) so that
 * /memory status reflects the correct "last dream" time.
 */
export async function writeDreamManualRunToMetadata(
  projectRoot: string,
  sessionId: string,
  now = new Date(),
): Promise<void> {
  return updateDreamMetadataResult(projectRoot, now, []);
}