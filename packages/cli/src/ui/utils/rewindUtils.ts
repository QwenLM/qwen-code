/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import type {
  Config,
  ResumedSessionData,
  SessionService,
} from '@qwen-code/qwen-code-core';
import type {
  RewindCodeSummary,
  RewindFileChange,
  RewindHistoryEntry,
} from '../types/rewind.js';

interface RewindCheckpoint {
  createdAt: string;
  timestampMs: number;
  sessionId?: string;
  commitHash?: string;
}

type RewindSessionService = Pick<SessionService, 'loadSession'>;

interface SnapshotFileChange {
  path: string;
  additions: number;
  deletions: number;
}

interface RewindGitService {
  getSnapshotDiffSummary(
    commitHash: string,
    targetCommitHash?: string,
  ): Promise<SnapshotFileChange[]>;
}

type ConversationMessage =
  ResumedSessionData['conversation']['messages'][number];

const MAX_SESSION_REWIND_CHECKPOINTS = 500;
const MAX_CHECKPOINT_CACHE_ENTRIES = 20;
const checkpointCache = new Map<
  string,
  { directoryMtimeMs: number; checkpoints: RewindCheckpoint[] }
>();

function formatAggregateChangeText(changes: RewindFileChange[]): string {
  const additions = changes.reduce((sum, change) => sum + change.additions, 0);
  const deletions = changes.reduce((sum, change) => sum + change.deletions, 0);
  return `+${additions} -${deletions}`;
}

export function formatCodeSummary(
  changes: RewindFileChange[],
): RewindCodeSummary {
  if (changes.length === 0) {
    return {
      hasChanges: false,
      summaryText: 'No code changes',
      detailText: 'The code will be unchanged.',
      changes,
    };
  }

  if (changes.length === 1) {
    const [change] = changes;
    return {
      hasChanges: true,
      summaryText: `${change.path} +${change.additions} -${change.deletions}`,
      detailText: `The code will be restored +${change.additions} -${change.deletions} in ${change.path}.`,
      changes,
    };
  }

  return {
    hasChanges: true,
    summaryText: `${changes.length} files changed ${formatAggregateChangeText(
      changes,
    )}`,
    detailText: `The code will be restored across ${changes.length} files (${formatAggregateChangeText(changes)}).`,
    changes,
  };
}

function parseCheckpointTimestamp(
  rawCreatedAt: unknown,
  mtimeMs: number,
): { createdAt: string; timestampMs: number } {
  if (typeof rawCreatedAt === 'string') {
    const parsed = Date.parse(rawCreatedAt);
    if (!Number.isNaN(parsed)) {
      return {
        createdAt: rawCreatedAt,
        timestampMs: parsed,
      };
    }
  }

  return {
    createdAt: new Date(mtimeMs).toISOString(),
    timestampMs: mtimeMs,
  };
}

async function loadCheckpointFile(
  checkpointDir: string,
  fileName: string,
): Promise<RewindCheckpoint | undefined> {
  try {
    const filePath = `${checkpointDir}/${fileName}`;
    const [data, stats] = await Promise.all([
      fs.readFile(filePath, 'utf8'),
      fs.stat(filePath),
    ]);
    const parsed = JSON.parse(data) as Record<string, unknown>;
    const timestamp = parseCheckpointTimestamp(
      parsed['createdAt'],
      stats.mtimeMs,
    );

    return {
      createdAt: timestamp.createdAt,
      timestampMs: timestamp.timestampMs,
      sessionId:
        typeof parsed['sessionId'] === 'string'
          ? parsed['sessionId']
          : undefined,
      commitHash:
        typeof parsed['commitHash'] === 'string'
          ? parsed['commitHash']
          : undefined,
    };
  } catch {
    return undefined;
  }
}

async function loadRewindCheckpoints(
  config: Config,
  sessionId: string,
): Promise<RewindCheckpoint[]> {
  if (!config.getCheckpointingEnabled()) {
    return [];
  }

  const checkpointDir = config.storage.getProjectTempCheckpointsDir();
  try {
    const [files, dirStats] = await Promise.all([
      fs.readdir(checkpointDir),
      fs.stat(checkpointDir),
    ]);
    const cacheKey = `${checkpointDir}:${sessionId}`;
    const cached = checkpointCache.get(cacheKey);
    if (cached && cached.directoryMtimeMs === dirStats.mtimeMs) {
      return cached.checkpoints;
    }

    const checkpoints = (
      await Promise.all(
        files
          .filter((fileName) => fileName.endsWith('.json'))
          .map((fileName) => loadCheckpointFile(checkpointDir, fileName)),
      )
    ).filter(
      (checkpoint): checkpoint is RewindCheckpoint => checkpoint !== undefined,
    );

    const filteredCheckpoints = checkpoints
      .filter(
        (checkpoint) =>
          checkpoint.commitHash &&
          (checkpoint.sessionId === undefined ||
            checkpoint.sessionId === sessionId),
      )
      .sort((a, b) => b.timestampMs - a.timestampMs)
      .slice(0, MAX_SESSION_REWIND_CHECKPOINTS)
      .sort((a, b) => a.timestampMs - b.timestampMs);

    checkpointCache.set(cacheKey, {
      directoryMtimeMs: dirStats.mtimeMs,
      checkpoints: filteredCheckpoints,
    });
    if (checkpointCache.size > MAX_CHECKPOINT_CACHE_ENTRIES) {
      const oldestKey = checkpointCache.keys().next().value;
      if (oldestKey) {
        checkpointCache.delete(oldestKey);
      }
    }

    return filteredCheckpoints;
  } catch {
    return [];
  }
}

function toRewindFileChanges(
  changes: SnapshotFileChange[],
): RewindFileChange[] {
  return changes.map((change) => ({
    path: change.path,
    additions: change.additions,
    deletions: change.deletions,
  }));
}

function getBranchMessages(
  sessionData: ResumedSessionData | undefined,
): ConversationMessage[] {
  const messages = sessionData?.conversation.messages ?? [];
  if (!sessionData || messages.length === 0 || !sessionData.lastCompletedUuid) {
    return messages;
  }

  const messagesByUuid = new Map<string, ConversationMessage>();
  for (const message of messages) {
    if (!messagesByUuid.has(message.uuid)) {
      messagesByUuid.set(message.uuid, message);
    }
  }

  if (!messagesByUuid.has(sessionData.lastCompletedUuid)) {
    return messages;
  }

  const chain: ConversationMessage[] = [];
  const visited = new Set<string>();
  let currentUuid: string | null = sessionData.lastCompletedUuid;
  let foundIncompleteParentChain = false;

  while (currentUuid && !visited.has(currentUuid)) {
    visited.add(currentUuid);
    const message = messagesByUuid.get(currentUuid);
    if (!message) {
      foundIncompleteParentChain = true;
      break;
    }
    chain.push(message);
    const parentUuid = message.parentUuid;
    if (parentUuid && !messagesByUuid.has(parentUuid)) {
      foundIncompleteParentChain = true;
      break;
    }
    currentUuid = parentUuid;
  }

  if (foundIncompleteParentChain) {
    return messages;
  }

  return chain.reverse();
}

function extractHistoryNodes(messages: ConversationMessage[]): Array<{
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  prompt: string;
}> {
  return messages
    .filter((message) => message.type === 'user')
    .map((message) => {
      const prompt =
        message.message?.parts
          ?.map((part) => ('text' in part ? part.text : ''))
          .join('')
          .trim() ?? '';

      return {
        uuid: message.uuid,
        parentUuid: message.parentUuid,
        sessionId: message.sessionId,
        timestamp: message.timestamp,
        prompt,
      };
    })
    .filter((node) => node.prompt.length > 0);
}

export async function buildRewindEntries(
  config: Config,
  sessionId: string,
): Promise<RewindHistoryEntry[]> {
  const sessionService: RewindSessionService = config.getSessionService();
  const resumedSessionData =
    config.getSessionId() === sessionId &&
    config.getResumedSessionData()?.conversation.sessionId === sessionId
      ? config.getResumedSessionData()
      : undefined;
  const [checkpoints, persistedSessionData] = await Promise.all([
    loadRewindCheckpoints(config, sessionId),
    sessionService.loadSession(sessionId),
  ]);

  const currentSessionData =
    resumedSessionData &&
    (!persistedSessionData ||
      Date.parse(persistedSessionData.conversation.lastUpdated) <=
        Date.parse(resumedSessionData.conversation.lastUpdated))
      ? resumedSessionData
      : persistedSessionData;

  let gitService: RewindGitService | undefined;
  if (checkpoints.length > 0) {
    try {
      gitService =
        (await config.getGitService()) as unknown as RewindGitService;
    } catch {
      gitService = undefined;
    }
  }

  const diffCache = new Map<string, RewindCodeSummary>();
  const currentBranchMessages = getBranchMessages(currentSessionData);
  const chronologicalNodes = extractHistoryNodes(currentBranchMessages).sort(
    (a, b) => a.timestamp.localeCompare(b.timestamp),
  );
  const historicalTurnChanges = new Map<string, RewindFileChange[]>();

  if (currentSessionData) {
    let activePromptUuid: string | null = null;
    for (const message of currentBranchMessages) {
      if (message.type === 'user') {
        activePromptUuid = message.uuid;
        if (!historicalTurnChanges.has(message.uuid)) {
          historicalTurnChanges.set(message.uuid, []);
        }
        continue;
      }

      if (message.type !== 'tool_result' || !activePromptUuid) {
        continue;
      }

      const resultDisplay = message.toolCallResult?.resultDisplay;
      if (!resultDisplay || typeof resultDisplay !== 'object') {
        continue;
      }

      if (!('fileName' in resultDisplay)) {
        continue;
      }

      const display = resultDisplay as {
        fileName?: string;
        diffStat?: { model_added_lines?: number; model_removed_lines?: number };
      };
      const filePath =
        typeof display.fileName === 'string' ? display.fileName : undefined;
      if (!filePath) {
        continue;
      }

      const additions = display.diffStat?.model_added_lines ?? 0;
      const deletions = display.diffStat?.model_removed_lines ?? 0;
      const existing = historicalTurnChanges.get(activePromptUuid) ?? [];
      const existingIndex = existing.findIndex(
        (change) => change.path === filePath,
      );
      if (existingIndex >= 0) {
        const current = existing[existingIndex];
        if (current) {
          current.additions += additions;
          current.deletions += deletions;
        }
      } else {
        existing.push({
          path: filePath,
          additions,
          deletions,
        });
      }
      historicalTurnChanges.set(activePromptUuid, existing);
    }
  }

  const entries: RewindHistoryEntry[] = [];
  for (const [index, node] of chronologicalNodes.entries()) {
    const nodeTimestampMs = Date.parse(node.timestamp);
    const nextNode = chronologicalNodes[index + 1];
    const nextNodeTimestampMs = nextNode
      ? Date.parse(nextNode.timestamp)
      : Number.POSITIVE_INFINITY;
    const restoreCheckpoint = checkpoints.find(
      (candidate) =>
        candidate.timestampMs > nodeTimestampMs &&
        candidate.timestampMs < nextNodeTimestampMs,
    );

    const historicalChanges = historicalTurnChanges.get(node.uuid) ?? [];
    const codeSummary = formatCodeSummary(historicalChanges);

    let restoreCodeSummary = formatCodeSummary([]);
    if (restoreCheckpoint?.commitHash && gitService) {
      const cacheKey = `${restoreCheckpoint.commitHash}..CURRENT`;
      const cached = diffCache.get(cacheKey);
      if (cached) {
        restoreCodeSummary = cached;
      } else {
        const changes = toRewindFileChanges(
          await gitService.getSnapshotDiffSummary(restoreCheckpoint.commitHash),
        );
        restoreCodeSummary = {
          ...formatCodeSummary(changes),
          checkpointCommitHash: restoreCheckpoint.commitHash,
        };
        diffCache.set(cacheKey, restoreCodeSummary);
      }
    }

    entries.push({
      key: node.uuid,
      kind: 'node',
      label: node.prompt,
      timestamp: node.timestamp,
      node,
      codeSummary,
      restoreCodeSummary,
    });
  }

  entries.push({
    key: 'current',
    kind: 'current',
    label: '(current)',
    codeSummary: formatCodeSummary([]),
    restoreCodeSummary: formatCodeSummary([]),
  });

  return entries;
}
