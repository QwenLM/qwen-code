/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import type { Config } from '../config/config.js';
import type { Message } from '../protocol/transcript/message.js';
import type {
  SidechainTranscriptRecorder,
  TranscriptWriterHandle,
} from './transcript/writer-handle.js';
import { TranscriptRepository } from './transcript/repository.js';
import type { TranscriptStore } from './transcript/store.js';
import {
  isMessageInAgentScope,
  subagentResumeLeafPolicy,
} from './transcript/graph-resolver.js';
import { getTranscriptProjectDir } from './transcript-paths.js';
import { getVersion } from '../utils/version.js';
import {
  isFileAccessDeniedError,
  isNodeError,
  warnFileAccessDegraded,
} from '../utils/errors.js';
import { runLogger } from '../utils/runLogger.js';

export interface SubagentMetadata {
  agentType: string;
  toolUseId?: string;
  description?: string;
  invocationName?: string;
  teamName?: string;
  isolation?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  /** A later observation, never the branch used to create an isolated worktree. */
  gitBranchObservation?: { branch: string; cwd: string; observedAt: string };
  color?: string;
}

export interface LoadedSubagentTranscript {
  agentId: string;
  messages: Message[];
  leafUuid: string;
  metadata: SubagentMetadata | null;
}

const SUBAGENT_LOG_SCOPE = 'SubagentRun';

/** 新会话使用项目 bucket；历史副本使用 Resolver/Writer 已确定的精确路径。 */
export type SubagentArtifactContext =
  | string
  | { sessionTranscriptPath: string };

export function getSubagentArtifactContext(config: Config) {
  return { sessionTranscriptPath: config.getActiveSessionTranscriptPath() };
}

class AccessTolerantSubagentTranscriptRecorder
  implements SidechainTranscriptRecorder
{
  private unavailable = false;

  constructor(
    private readonly writer: TranscriptWriterHandle,
    private readonly agentId: string,
    private readonly taskId: string,
    private readonly onUnavailable: () => void,
  ) {}

  async recordSidechainMessages(
    messages: readonly Message[],
    agentId?: string,
    startingParentUuidHint?: string | null,
  ): Promise<string | null> {
    if (this.unavailable) {
      return startingParentUuidHint ?? null;
    }
    try {
      return await this.writer.recordSidechainMessages(
        messages,
        agentId,
        startingParentUuidHint,
      );
    } catch (error) {
      if (!isFileAccessDeniedError(error)) {
        throw error;
      }
      this.markUnavailable('record', error);
      return startingParentUuidHint ?? null;
    }
  }

  /** Always releases the lease; `TranscriptWriterHandle.close()` is idempotent. */
  async close(): Promise<void> {
    try {
      await this.writer.close();
    } catch (error) {
      if (!isFileAccessDeniedError(error)) {
        throw error;
      }
      this.markUnavailable('close', error);
    }
  }

  private markUnavailable(operation: string, error: unknown): void {
    if (this.unavailable) {
      return;
    }
    this.unavailable = true;
    this.onUnavailable();
    warnFileAccessDegraded(
      SUBAGENT_LOG_SCOPE,
      operation,
      this.writer.filePath,
      error,
      `agentId=${this.agentId}`,
      `taskId=${this.taskId}`,
    );
  }
}

function warnTranscriptUnavailable(
  operation: string,
  targetPath: string,
  error: unknown,
): void {
  warnFileAccessDegraded(SUBAGENT_LOG_SCOPE, operation, targetPath, error);
}

export function getSubagentTranscriptDir(
  projectRoot: SubagentArtifactContext,
  sessionId: string,
): string {
  return path.join(
    typeof projectRoot === 'string'
      ? getTranscriptProjectDir(projectRoot)
      : path.dirname(projectRoot.sessionTranscriptPath),
    sessionId,
    'subagents',
  );
}

export function getSubagentTranscriptPath(
  projectRoot: SubagentArtifactContext,
  sessionId: string,
  agentId: string,
): string {
  return path.join(
    getSubagentTranscriptDir(projectRoot, sessionId),
    `agent-${agentId}.jsonl`,
  );
}

export function getSubagentMetadataPath(
  projectRoot: SubagentArtifactContext,
  sessionId: string,
  agentId: string,
): string {
  return getSubagentTranscriptPath(projectRoot, sessionId, agentId).replace(
    /\.jsonl$/,
    '.meta.json',
  );
}

export async function createSubagentTranscriptRecorder(
  config: Config,
  agentId: string,
  taskId: string,
  onUnavailable: () => void,
  options: { cwd?: string; gitBranch?: string } = {},
): Promise<SidechainTranscriptRecorder> {
  const artifactContext = getSubagentArtifactContext(config);
  const writer = await config.getTranscriptStore().acquireSubagentWriter({
    filePath: getSubagentTranscriptPath(
      artifactContext,
      config.getSessionId(),
      agentId,
    ),
    sessionId: config.getSessionId(),
    cwd: options.cwd ?? config.getTargetDir(),
    entrypoint: 'cli',
    version: await getVersion(),
    ...(options.gitBranch ? { gitBranch: options.gitBranch } : {}),
  });
  return new AccessTolerantSubagentTranscriptRecorder(
    writer,
    agentId,
    taskId,
    onUnavailable,
  );
}

export async function writeSubagentMetadata(
  config: Config,
  agentId: string,
  metadata: SubagentMetadata,
): Promise<void> {
  const projectRoot = getSubagentArtifactContext(config);
  const sessionId = config.getSessionId();
  const metadataPath = getSubagentMetadataPath(projectRoot, sessionId, agentId);
  await fs.mkdir(path.dirname(metadataPath), { recursive: true });
  const temporaryPath = `${metadataPath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, JSON.stringify(metadata), 'utf8');
    await fs.rename(temporaryPath, metadataPath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
  await config.getTranscriptStore().publishCommittedEntries(
    getSubagentTranscriptPath(projectRoot, sessionId, agentId),
    [
      {
        type: 'agent_metadata',
        ...metadata,
      },
    ],
  );
}

export async function readSubagentMetadata(
  projectRoot: SubagentArtifactContext,
  sessionId: string,
  agentId: string,
): Promise<SubagentMetadata | null> {
  const metadataPath = getSubagentMetadataPath(projectRoot, sessionId, agentId);
  try {
    const raw = await fs.readFile(metadataPath, 'utf8');
    return JSON.parse(raw) as SubagentMetadata;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return null;
    }
    if (isFileAccessDeniedError(error)) {
      warnTranscriptUnavailable('read-metadata', metadataPath, error);
      return null;
    }
    throw error;
  }
}

export async function deleteSubagentTranscriptArtifacts(
  store: TranscriptStore,
  projectRoot: SubagentArtifactContext,
  sessionId: string,
  agentId: string,
): Promise<void> {
  const transcriptPath = getSubagentTranscriptPath(
    projectRoot,
    sessionId,
    agentId,
  );
  const metadataPath = getSubagentMetadataPath(projectRoot, sessionId, agentId);

  await Promise.all([
    store.deleteTranscript(transcriptPath),
    fs.rm(metadataPath, { force: true }),
  ]);
}

export async function readSubagentTranscript(
  projectRoot: SubagentArtifactContext,
  sessionId: string,
  agentId: string,
  repository: TranscriptRepository = new TranscriptRepository(),
): Promise<LoadedSubagentTranscript | null> {
  const transcriptPath = getSubagentTranscriptPath(
    projectRoot,
    sessionId,
    agentId,
  );
  // Read transcript and metadata concurrently — they are independent I/O.
  const [resolved, metadata] = await Promise.all([
    repository
      .resolveSession(transcriptPath, {
        leafPolicy: subagentResumeLeafPolicy(agentId),
      })
      .catch((error: unknown) => {
        if (isFileAccessDeniedError(error)) {
          warnTranscriptUnavailable('read', transcriptPath, error);
          return null;
        }
        throw error;
      }),
    readSubagentMetadata(projectRoot, sessionId, agentId),
  ]);

  const messages = [...(resolved?.messages ?? [])];

  if (messages.length === 0 || !resolved?.leafUuid) {
    return null;
  }

  let rootCount = 0;
  for (const message of resolved.compatible.messagesByUuid.values()) {
    if (
      message.parentUuid === null &&
      (message.type === 'user' || message.type === 'assistant') &&
      isMessageInAgentScope(message, agentId)
    ) {
      rootCount += 1;
    }
  }
  if (rootCount > 1) {
    runLogger.warn(
      'subagent.transcript.unchained',
      `session=${sessionId}`,
      `agent=${agentId}`,
      `roots=${rootCount}`,
    );
  }

  return {
    agentId,
    messages,
    leafUuid: resolved.leafUuid,
    metadata,
  };
}

export async function loadAllSubagentTranscripts(
  projectRoot: SubagentArtifactContext,
  sessionId: string,
): Promise<LoadedSubagentTranscript[]> {
  const dir = getSubagentTranscriptDir(projectRoot, sessionId);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return [];
    }
    if (isFileAccessDeniedError(error)) {
      warnTranscriptUnavailable('list', dir, error);
      return [];
    }
    throw error;
  }

  const agentIds = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.startsWith('agent-') &&
        entry.name.endsWith('.jsonl'),
    )
    .map((entry) => entry.name.slice('agent-'.length, -'.jsonl'.length));

  const transcripts = await Promise.all(
    agentIds.map((agentId) =>
      readSubagentTranscript(projectRoot, sessionId, agentId),
    ),
  );

  return transcripts.filter(
    (transcript): transcript is LoadedSubagentTranscript => transcript !== null,
  );
}
