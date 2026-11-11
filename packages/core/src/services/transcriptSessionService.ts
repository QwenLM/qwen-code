/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getTranscriptProjectDir } from './transcript-paths.js';
import {
  TranscriptRepository,
  createBoundedResumeReadState,
  type ResumeTranscriptResult,
  type TranscriptResumeReadState,
} from './transcript/repository.js';
import {
  beginResumeRead,
  isResumeReadError,
  type ResumeReadAttempt,
} from './transcript/resume-read-budget.js';
import type { TranscriptMetadataView } from './transcript/index.js';
import type { ScanProfile } from './transcript/scanner.js';
import { readTranscriptSessionCatalogMetadata } from './transcript/session-catalog.js';
import { SessionStateStore } from './session-state-store.js';
import type { Message } from '../protocol/transcript/message.js';
import {
  getDisplayablePromptText,
  getDisplayableUserText,
  getRealUserPromptText,
  getUserTextBlocks,
  getUserPromptFallbackText,
  isHiddenUserMessageInDefaultHistory,
  isHumanTaskInputMessage,
  isToolResultUserMessage,
  parseBashInputPromptText,
} from '../protocol/transcript/message-utils.js';
import type { FileHistorySnapshot } from '../file-history/file-history.js';
import type {
  RuntimeConfigEntry,
  TranscriptWorktreeSession,
} from '../protocol/transcript/entry.js';
import { runLogger } from '../utils/runLogger.js';

const SESSION_LIST_READ_CONCURRENCY = 8;

export type TranscriptSessionErrorCode =
  | 'NO_SESSIONS_FOUND'
  | 'INVALID_SESSION_IDENTIFIER';

export class TranscriptSessionError extends Error {
  constructor(
    readonly code: TranscriptSessionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TranscriptSessionError';
  }

  static noSessionsFound(): TranscriptSessionError {
    return new TranscriptSessionError(
      'NO_SESSIONS_FOUND',
      'No previous sessions found for this project.',
    );
  }

  static invalidSessionIdentifier(
    identifier: string,
    projectDir?: string,
  ): TranscriptSessionError {
    const dirInfo = projectDir ? ` in ${projectDir}` : '';
    return new TranscriptSessionError(
      'INVALID_SESSION_IDENTIFIER',
      `Invalid session identifier "${identifier}".\n  Searched for sessions${dirInfo}.\n  Use --list-sessions to see available sessions, then use --continue to load the most recent conversation saved under the current project directory, or use --resume {number} / --resume {uuid} to load a specific conversation.`,
    );
  }
}

export interface TranscriptSessionTextMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface TranscriptSessionInfo {
  id: string;
  file: string;
  fileName: string;
  sessionPath: string;
  startTime: string;
  messageCount: number;
  userMessageCount: number;
  lastUpdated: string;
  displayName: string;
  firstUserMessage: string;
  isCurrentSession: boolean;
  index: number;
  summary?: string;
  customTitle?: string;
  aiTitle?: string;
  lastPrompt?: string;
  fullContent?: string;
  messages?: TranscriptSessionTextMessage[];
  directories?: string[];
  forkedFrom?: {
    sessionId: string;
    messageUuid: string;
  };
  /** The project root that owns this transcript bucket (for writer rebinding on resume). */
  transcriptProjectRoot?: string;
  /** Absolute path to the transcript project directory (~/.qwen/projects/<sanitized>). */
  transcriptProjectDir?: string;
  /** The worktree path this session came from (for scope attribution, only set for cross-worktree sessions). */
  sourceWorktreePath?: string;
  /** Logical project path shown in session pickers, independent of transcript storage. */
  displayProjectPath?: string;
  /** Most recently recorded git branch in the active transcript chain. */
  gitBranch?: string;
  /** Effective cwd after folding transcript relocation entries. */
  cwd?: string;
  /** Latest persisted main-session worktree state; null means explicitly exited. */
  worktreeSession?: TranscriptWorktreeSession | null;
  /** 从既有 Worktree 记录推导的逻辑项目根；不随退出清空，也不是物理 bucket。 */
  originalCwd?: string;
  /** Transcript file size in bytes. */
  fileSize?: number;
  /** True when the picker loaded only bounded catalog metadata. */
  isMetadataOnly?: boolean;
}

export interface ResolveTranscriptSessionResult {
  sessionPath: string;
  messages: Message[];
  fileHistorySnapshots: FileHistorySnapshot[];
  runtimeConfig?: RuntimeConfigEntry;
  displayInfo: string;
  sessionInfo: TranscriptSessionInfo;
  /** 本次恢复读取派生的初始化数据，不持久化。 */
  transcriptReadState?: TranscriptResumeReadState;
  resumeCandidate?: ResumeTranscriptResult;
  resumeAttempt?: ResumeReadAttempt;
}

export interface ListTranscriptSessionsOptions {
  signal?: AbortSignal;
  resumeAttempt?: ResumeReadAttempt;
  forResume?: boolean;
  includeFullContent?: boolean;
  /** Read bounded catalog metadata instead of constructing resume graphs. */
  lightweight?: boolean;
  /** Override the transcript project directory (bypasses getTranscriptProjectDir). */
  projectDir?: string;
  /** Session files that must not be opened while building the catalog. */
  excludeSessionIds?: readonly string[];
}

interface LoadedTranscriptSession {
  sessionInfo: TranscriptSessionInfo;
  messages: Message[];
  fileHistorySnapshots: FileHistorySnapshot[];
  runtimeConfig?: RuntimeConfigEntry;
  transcriptReadState?: TranscriptResumeReadState;
  resumeCandidate?: ResumeTranscriptResult;
}

async function buildSessionResult(
  selected: TranscriptSessionInfo,
  attempt?: ResumeReadAttempt,
): Promise<ResolveTranscriptSessionResult> {
  const result = await resolveTranscriptSessionById(
    selected.transcriptProjectRoot ?? path.dirname(selected.sessionPath),
    selected.id,
    selected.isCurrentSession ? selected.id : undefined,
    {
      projectDir: path.dirname(selected.sessionPath),
      resumeAttempt: attempt,
    },
  );
  if (!result) throw TranscriptSessionError.invalidSessionIdentifier(selected.id);
  result.sessionInfo = { ...selected, ...result.sessionInfo, index: selected.index };
  result.displayInfo = `Session ${selected.index}: ${result.sessionInfo.firstUserMessage} (${result.sessionInfo.messageCount} messages, updated ${result.sessionInfo.lastUpdated})`;
  return result;
}

function getSearchTextForAssistantMessage(message: Message): string {
  if (message.type !== 'assistant') {
    return '';
  }

  return message.message.content
    .filter(
      (
        block,
      ): block is Extract<
        (typeof message.message.content)[number],
        { type: 'text' }
      > => block.type === 'text',
    )
    .map((block) => block.text)
    .join('');
}

function getSearchMessages(
  messages: readonly Message[],
): TranscriptSessionTextMessage[] {
  const normalized: TranscriptSessionTextMessage[] = [];

  for (const message of messages) {
    if (message.type === 'user') {
      if (
        isHiddenUserMessageInDefaultHistory(message) ||
        message.isCompactSummary === true
      ) {
        continue;
      }
      const content = getDisplayableUserText(message) ?? '';
      if (content.trim()) {
        normalized.push({ role: 'user', content });
      }
      continue;
    }

    if (message.type === 'assistant') {
      const content = getSearchTextForAssistantMessage(message);
      if (content.trim()) {
        normalized.push({ role: 'assistant', content });
      }
    }
  }

  return normalized;
}

function getLastGitBranch(messages: readonly Message[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const gitBranch = messages[index]?.gitBranch;
    if (gitBranch) {
      return gitBranch;
    }
  }
  return undefined;
}

export function getFirstUserMessage(messages: readonly Message[]): string {
  let fallback: string | null = null;

  for (const message of messages) {
    const prompt = getRealUserPromptText(message);
    if (prompt) {
      return prompt;
    }

    fallback ??= getUserPromptFallbackText(message);
  }

  return fallback ?? 'Empty conversation';
}

function isResumableUserMessage(message: Message): boolean {
  if (message.type !== 'user') {
    return false;
  }
  if (message.isCompactSummary === true) {
    return true;
  }
  if (isHiddenUserMessageInDefaultHistory(message)) {
    return false;
  }
  if (
    getRealUserPromptText(message) !== null ||
    (message.origin?.kind === 'human' &&
      getDisplayableUserText(message) !== undefined)
  ) {
    return true;
  }

  // Shell commands are resumable context even when no model turn follows.
  // Slash-command wrappers alone only represent local UI actions.
  if (
    getUserTextBlocks(message).some(
      (text) => parseBashInputPromptText(text) !== null,
    )
  ) {
    return true;
  }

  // A human-submitted prompt turn is resumable context even when its text
  // blocks do not classify — e.g. a prompt led by host-injected
  // <user-pasted-image> tags — and no model reply was persisted yet. Without
  // this, a turn cancelled before the first assistant message leaves the
  // whole session unresumable.
  return isHumanTaskInputMessage(message);
}

export function hasResumableTranscriptMessages(
  messages: readonly Message[],
): boolean {
  return messages.some(
    (message) =>
      message.type === 'assistant' ||
      isResumableUserMessage(message) ||
      (message.type === 'system' && message.isCompactSummary === true),
  );
}

function getSessionIndexMessageCounts(messages: readonly Message[]): {
  assistant: number;
  displayableUser: number;
  compactSummary: number;
  hiddenUser: number;
  system: number;
} {
  let assistant = 0;
  let displayableUser = 0;
  let compactSummary = 0;
  let hiddenUser = 0;
  let system = 0;

  for (const message of messages) {
    if (message.type === 'assistant') {
      assistant++;
      continue;
    }

    if (message.type === 'system') {
      system++;
      if (message.isCompactSummary === true) {
        compactSummary++;
      }
      continue;
    }

    if (message.type !== 'user') {
      continue;
    }

    if (message.isCompactSummary === true) {
      compactSummary++;
      continue;
    }

    if (isHiddenUserMessageInDefaultHistory(message)) {
      hiddenUser++;
      continue;
    }

    displayableUser++;
  }

  return { assistant, displayableUser, compactSummary, hiddenUser, system };
}

export function countUserMessages(messages: readonly Message[]): number {
  return messages.filter(
    (message) =>
      message.type === 'user' &&
      !isHiddenUserMessageInDefaultHistory(message) &&
      message.isCompactSummary !== true,
  ).length;
}

export function countDisplayMessages(messages: readonly Message[]): number {
  return messages.filter((message) => {
    if (message.type === 'assistant') {
      return true;
    }

    if (message.type !== 'user') {
      return false;
    }

    return (
      !isHiddenUserMessageInDefaultHistory(message) &&
      message.isCompactSummary !== true &&
      !isToolResultUserMessage(message)
    );
  }).length;
}

function getSessionMetadata(
  sessionId: string,
  leafUuid: string | undefined,
  metadata: TranscriptMetadataView,
): {
  summary?: string;
  customTitle?: string;
  aiTitle?: string;
  lastPrompt?: string;
} {
  return {
    summary: leafUuid ? metadata.summaries.get(leafUuid) : undefined,
    customTitle: metadata.customTitles.get(sessionId),
    aiTitle: metadata.aiTitles.get(sessionId),
    lastPrompt: metadata.lastPrompts.get(sessionId),
  };
}

export async function getSessionWorkspaceDirectories(
  projectRoot: string,
  sessionId: string,
  legacyTranscriptDirectories?: string[],
): Promise<string[] | undefined> {
  try {
    const directories = await new SessionStateStore({
      projectRoot,
      sessionId,
    }).getWorkspaceDirectories();
    return directories ?? legacyTranscriptDirectories;
  } catch {
    return legacyTranscriptDirectories;
  }
}

async function loadTranscriptSession(
  projectRoot: string,
  filePath: string,
  currentSessionId: string | undefined,
  options: ListTranscriptSessionsOptions,
  repository: TranscriptRepository,
  profile: ScanProfile = { kind: 'full' },
  attempt?: ResumeReadAttempt,
): Promise<LoadedTranscriptSession | null> {
  const sessionId = path.basename(filePath, '.jsonl');
  const bounded = attempt
    ? await repository.readForResume(filePath, { sessionId, attempt })
    : undefined;
  const full = attempt ? undefined : await repository.resolveSession(filePath, { profile });
  const loadResult = bounded ?? full;
  if (!loadResult) return null;
  const metadata = bounded?.metadata ?? full!.index.metadata;
  const transcriptChain = loadResult.chain;
  const messages = [...loadResult.messages];
  const emptyLeaf = metadata.activeLeaves.get(sessionId);
  const hasEmptyCheckpoint = emptyLeaf?.explicit === true && emptyLeaf.leafUuid === null;
  if (
    !hasResumableTranscriptMessages(messages) &&
    !hasEmptyCheckpoint &&
    !metadata.worktreeSessions.get(sessionId)
  ) {
    const counts = getSessionIndexMessageCounts(messages);
    runLogger.warn(
      'transcript.session.unindexable',
      `session=${sessionId}`,
      `current_session=${currentSessionId === sessionId}`,
      `entries=${bounded?.retainedEntries ?? full!.index.entriesInFileOrder.length}`,
      `transcript_messages=${bounded?.retainedMessageCount ?? full!.compatible.messagesByUuid.size}`,
      `chain_messages=${transcriptChain.length}`,
      `assistant_messages=${counts.assistant}`,
      `displayable_user_messages=${counts.displayableUser}`,
      `compact_summary_messages=${counts.compactSummary}`,
      `hidden_user_messages=${counts.hiddenUser}`,
      `system_messages=${counts.system}`,
      `has_compact_boundary=${bounded?.hasCompactBoundary ?? full!.compatible.hasCompactBoundary}`,
      `path=${filePath}`,
    );
    return null;
  }
  const stat = bounded
    ? { mtime: new Date(bounded.snapshot.modifiedTimeMs), size: bounded.snapshot.size }
    : await fs.stat(filePath);
  const firstTimestamp = messages[0]?.timestamp ?? stat.mtime.toISOString();
  const lastUpdated = stat.mtime.toISOString();
  const directories = await getSessionWorkspaceDirectories(
    projectRoot,
    sessionId,
    metadata.workspaceDirectories.get(sessionId)
      ? [...metadata.workspaceDirectories.get(sessionId)!]
      : undefined,
  );
  attempt?.check();
  const leafUuid = messages.at(-1)?.uuid;
  const { summary, customTitle, aiTitle, lastPrompt } = getSessionMetadata(sessionId, leafUuid, metadata);
  const displayableLastPrompt = getDisplayablePromptText(lastPrompt);
  const firstUserMessage = getFirstUserMessage(messages);
  const userMessageCount = countUserMessages(messages);
  const displayName = customTitle ?? aiTitle ?? displayableLastPrompt ?? summary ?? firstUserMessage;
  const forkedFrom = transcriptChain.at(-1)?.forkedFrom;
  const searchMessages = options.includeFullContent ? getSearchMessages(messages) : undefined;
  const worktreeSession = metadata.worktreeSessions.get(sessionId);
  const lastWorktreeEntry = full?.index.entriesInFileOrder.findLast(
    ({ entry }) => entry.type === 'worktree-state' && entry.sessionId === sessionId && entry.worktreeSession !== null,
  )?.entry;
  const originalCwd = bounded?.originalCwd ?? (
    lastWorktreeEntry?.type === 'worktree-state' ? lastWorktreeEntry.worktreeSession?.originalCwd : undefined
  );
  const sessionInfo: TranscriptSessionInfo = {
    id: sessionId,
    file: sessionId,
    fileName: path.basename(filePath),
    sessionPath: filePath,
    startTime: firstTimestamp,
    lastUpdated,
    fileSize: stat.size,
    gitBranch: worktreeSession?.worktreeBranch ?? getLastGitBranch(messages),
    cwd:
      worktreeSession?.worktreeCwd ??
      worktreeSession?.worktreePath ??
      (worktreeSession === null ? originalCwd : undefined) ??
      metadata.relocatedCwds.get(sessionId) ?? transcriptChain.at(-1)?.cwd,
    ...(metadata.worktreeSessions.has(sessionId) ? { worktreeSession } : {}),
    ...(originalCwd ? { originalCwd } : {}),
    messageCount: countDisplayMessages(messages),
    userMessageCount,
    displayName,
    firstUserMessage,
    isCurrentSession: currentSessionId === sessionId,
    index: 0,
    summary,
    customTitle,
    aiTitle,
    lastPrompt: displayableLastPrompt,
    directories,
    ...(forkedFrom ? { forkedFrom } : {}),
    ...(searchMessages ? {
      messages: searchMessages,
      fullContent: searchMessages.map((message) => message.content).join(' '),
    } : {}),
  };
  return {
    sessionInfo,
    messages,
    fileHistorySnapshots: [...loadResult.fileHistorySnapshots],
    runtimeConfig: metadata.runtimeConfigs.get(sessionId),
    ...(bounded ? { transcriptReadState: createBoundedResumeReadState(bounded), resumeCandidate: bounded } : {}),
  };
}

export async function loadTranscriptSessionInfo(
  projectRoot: string,
  filePath: string,
  currentSessionId: string | undefined,
  options: ListTranscriptSessionsOptions,
  repository: TranscriptRepository = new TranscriptRepository(),
): Promise<TranscriptSessionInfo | null> {
  return (
    (
      await loadTranscriptSession(
        projectRoot,
        filePath,
        currentSessionId,
        options,
        repository,
        { kind: 'compact-tail' },
      )
    )?.sessionInfo ?? null
  );
}

interface TranscriptFileCandidate {
  fileName: string;
  filePath: string;
  size: number;
  mtime: Date;
}

async function listTranscriptFileCandidates(
  projectDir: string,
  fileNames: readonly string[],
): Promise<TranscriptFileCandidate[]> {
  const candidates: TranscriptFileCandidate[] = [];
  for (
    let offset = 0;
    offset < fileNames.length;
    offset += SESSION_LIST_READ_CONCURRENCY
  ) {
    const batch = fileNames.slice(
      offset,
      offset + SESSION_LIST_READ_CONCURRENCY,
    );
    const stats = await Promise.all(
      batch.map(async (fileName): Promise<TranscriptFileCandidate | null> => {
        const filePath = path.join(projectDir, fileName);
        try {
          const stat = await fs.stat(filePath);
          return stat.isFile()
            ? { fileName, filePath, size: stat.size, mtime: stat.mtime }
            : null;
        } catch (error) {
          runLogger.debug(
            `transcript.session.stat_failed file=${fileName} path=${filePath} error=${error instanceof Error ? error.message : String(error)}`,
          );
          return null;
        }
      }),
    );
    candidates.push(
      ...stats.filter(
        (candidate): candidate is TranscriptFileCandidate => candidate !== null,
      ),
    );
  }

  return candidates.sort((left, right) =>
    right.mtime.getTime() !== left.mtime.getTime()
      ? right.mtime.getTime() - left.mtime.getTime()
      : right.fileName.localeCompare(left.fileName),
  );
}

async function loadLightweightTranscriptSessionInfo(
  projectRoot: string,
  candidate: TranscriptFileCandidate,
  currentSessionId: string | undefined,
): Promise<TranscriptSessionInfo | null> {
  const sessionId = path.basename(candidate.fileName, '.jsonl');
  const metadata = await readTranscriptSessionCatalogMetadata(
    candidate.filePath,
    sessionId,
    candidate.size,
  );
  if (metadata.resumability === 'no' && !metadata.worktreeSession) {
    return null;
  }
  const directories = await getSessionWorkspaceDirectories(
    projectRoot,
    sessionId,
    metadata.directories,
  );

  return {
    id: sessionId,
    file: sessionId,
    fileName: candidate.fileName,
    sessionPath: candidate.filePath,
    startTime: metadata.startTime ?? candidate.mtime.toISOString(),
    lastUpdated: candidate.mtime.toISOString(),
    fileSize: candidate.size,
    gitBranch: metadata.gitBranch,
    cwd: metadata.cwd,
    ...(metadata.worktreeSession !== undefined
      ? { worktreeSession: metadata.worktreeSession }
      : {}),
    messageCount: 0,
    userMessageCount: 0,
    displayName: metadata.displayName,
    firstUserMessage: metadata.firstUserMessage,
    isCurrentSession: currentSessionId === sessionId,
    index: 0,
    summary: metadata.summary,
    customTitle: metadata.customTitle,
    aiTitle: metadata.aiTitle,
    lastPrompt: metadata.lastPrompt,
    directories,
    ...(metadata.forkedFrom ? { forkedFrom: metadata.forkedFrom } : {}),
    isMetadataOnly: true,
  };
}

export async function listTranscriptSessions(
  projectRoot: string,
  currentSessionId?: string,
  options: ListTranscriptSessionsOptions = {},
): Promise<TranscriptSessionInfo[]> {
  const projectDir = options.projectDir ?? getTranscriptProjectDir(projectRoot);

  let fileNames: string[];
  try {
    fileNames = await fs.readdir(projectDir);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const transcriptFileNames = fileNames
    .filter(
      (fileName) =>
        fileName.endsWith('.jsonl') &&
        !options.excludeSessionIds?.includes(path.basename(fileName, '.jsonl')),
    )
    .sort();
  const rawSessions: Array<TranscriptSessionInfo | null> = [];

  if (options.lightweight && !options.includeFullContent) {
    const candidates = await listTranscriptFileCandidates(
      projectDir,
      transcriptFileNames,
    );
    let skippedUnresumable = 0;
    for (
      let offset = 0;
      offset < candidates.length;
      offset += SESSION_LIST_READ_CONCURRENCY
    ) {
      const batch = candidates.slice(
        offset,
        offset + SESSION_LIST_READ_CONCURRENCY,
      );
      const loaded = await Promise.all(
        batch.map((candidate) =>
          loadLightweightTranscriptSessionInfo(
            projectRoot,
            candidate,
            currentSessionId,
          ).catch((error) => {
            runLogger.debug(
              `transcript.session.catalog_failed file=${candidate.fileName} path=${candidate.filePath} error=${error instanceof Error ? error.message : String(error)}`,
            );
            return null;
          }),
        ),
      );
      skippedUnresumable += loaded.filter((session) => session === null).length;
      for (const session of loaded) {
        if (session && options.forResume && options.resumeAttempt) {
          let bytes = 512;
          for (const value of Object.values(session)) {
            if (typeof value === 'string') bytes += Buffer.byteLength(value, 'utf8') * 2;
            else if (Array.isArray(value)) {
              for (const item of value) if (typeof item === 'string') bytes += Buffer.byteLength(item, 'utf8') * 2;
            }
          }
          options.resumeAttempt.addStructure(bytes);
        }
        rawSessions.push(session);
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (skippedUnresumable > 0) {
      runLogger.debug(
        `transcript.session.catalog_filtered count=${skippedUnresumable} project_dir=${projectDir}`,
      );
    }
  } else {
    const repository = new TranscriptRepository();
    for (
      let offset = 0;
      offset < transcriptFileNames.length;
      offset += SESSION_LIST_READ_CONCURRENCY
    ) {
      const batch = transcriptFileNames.slice(
        offset,
        offset + SESSION_LIST_READ_CONCURRENCY,
      );
      rawSessions.push(
        ...(await Promise.all(
          batch.map((fileName) =>
            loadTranscriptSessionInfo(
              projectRoot,
              path.join(projectDir, fileName),
              currentSessionId,
              options,
              repository,
            ).catch((err) => {
              if (options.forResume && isResumeReadError(err)) throw err;
              runLogger.warn(
                'transcript.session.load_failed',
                `file=${fileName}`,
                `path=${path.join(projectDir, fileName)}`,
                `error=${err instanceof Error ? err.message : String(err)}`,
              );
              return null;
            }),
          ),
        )),
      );
    }
  }

  const dedupedById = new Map<string, TranscriptSessionInfo>();
  for (const session of rawSessions) {
    if (!session) {
      continue;
    }

    const existing = dedupedById.get(session.id);
    if (
      !existing ||
      new Date(session.lastUpdated).getTime() >
        new Date(existing.lastUpdated).getTime()
    ) {
      dedupedById.set(session.id, session);
    }
  }

  const sessions = Array.from(dedupedById.values()).sort(
    (left, right) =>
      new Date(right.lastUpdated).getTime() -
      new Date(left.lastUpdated).getTime(),
  );

  sessions.forEach((session, index) => {
    session.index = index + 1;
  });

  return sessions;
}

export function isSafeSessionFileStem(sessionId: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId) && !sessionId.includes('..')
  );
}

function isNumericSessionIndex(value: string): boolean {
  const index = Number.parseInt(value, 10);
  return !Number.isNaN(index) && String(index) === value && index > 0;
}

export async function resolveTranscriptSessionById(
  projectRoot: string,
  sessionId: string,
  currentSessionId?: string,
  options: ListTranscriptSessionsOptions = {},
): Promise<ResolveTranscriptSessionResult | null> {
  if (!isSafeSessionFileStem(sessionId)) {
    return null;
  }

  const projectDir = options.projectDir ?? getTranscriptProjectDir(projectRoot);
  const sessionPath = path.join(projectDir, `${sessionId}.jsonl`);

  try {
    const stats = await fs.stat(sessionPath);
    if (!stats.isFile()) {
      return null;
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }

  const attempt =
    options.resumeAttempt ?? (await beginResumeRead({ signal: options.signal }));
  try {
    const loaded = await loadTranscriptSession(
      projectRoot, sessionPath, currentSessionId, options,
      new TranscriptRepository(), { kind: 'full' }, attempt,
    );
    if (!loaded) {
      if (!options.resumeAttempt) attempt.finish();
      return null;
    }
    const info = loaded.sessionInfo;
    info.transcriptProjectRoot = projectRoot;
    info.transcriptProjectDir = projectDir;
    info.isMetadataOnly = false;
    return {
      ...loaded,
      sessionPath,
      displayInfo: `Session ${sessionId}: ${info.firstUserMessage} (${info.messageCount} messages, updated ${info.lastUpdated})`,
      resumeAttempt: attempt,
    };
  } catch (error) {
    if (!options.resumeAttempt) attempt.finish();
    throw error;
  }
}

export async function resolveTranscriptSession(
  projectRoot: string,
  resumeArg: string,
  currentSessionId?: string,
): Promise<ResolveTranscriptSessionResult> {
  const trimmed = resumeArg.trim();
  if (!isNumericSessionIndex(trimmed)) {
    const direct = await resolveTranscriptSessionById(
      projectRoot,
      trimmed,
      currentSessionId,
    );
    if (direct) {
      return direct;
    }
    throw TranscriptSessionError.invalidSessionIdentifier(
      trimmed,
      getTranscriptProjectDir(projectRoot),
    );
  }

  const attempt = await beginResumeRead();
  try {
  const sessions = await listTranscriptSessions(projectRoot, currentSessionId, { lightweight: true, forResume: true, resumeAttempt: attempt });
  if (sessions.length === 0) {
    throw TranscriptSessionError.noSessionsFound();
  }

  let selected: TranscriptSessionInfo | undefined;

  selected = sessions.find((session) => session.id === trimmed);
  if (!selected) {
    const index = Number.parseInt(trimmed, 10);
    if (
      !Number.isNaN(index) &&
      String(index) === trimmed &&
      index > 0 &&
      index <= sessions.length
    ) {
      selected = sessions[index - 1];
    }
  }

  if (!selected) {
    throw TranscriptSessionError.invalidSessionIdentifier(
      trimmed,
      getTranscriptProjectDir(projectRoot),
    );
  }

  sessions.length = 0;
  return await buildSessionResult(selected, attempt);
  } catch (error) {
    attempt.finish();
    throw error;
  }
}

export async function resolveLatestTranscriptSession(
  projectRoot: string,
  currentSessionId?: string,
): Promise<ResolveTranscriptSessionResult> {
  const attempt = await beginResumeRead();
  try {
    const sessions = await listTranscriptSessions(projectRoot, currentSessionId, { lightweight: true, forResume: true, resumeAttempt: attempt });
    const selected = sessions[0];
    if (!selected) throw TranscriptSessionError.noSessionsFound();
    sessions.length = 0;
    return await buildSessionResult(selected, attempt);
  } catch (error) {
    attempt.finish();
    throw error;
  }
}
