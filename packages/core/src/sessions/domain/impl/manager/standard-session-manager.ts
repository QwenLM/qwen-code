/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as nodePath from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SessionManager } from '../../interface/manager/session-manager.js';
import type { SessionDeleteOptions } from '../../interface/manager/session-delete-options.js';
import type { SessionLoadOptions } from '../../interface/manager/session-load-options.js';
import type { SessionForkOptions } from '../../interface/manager/session-fork-options.js';
import type { SessionRenameOptions } from '../../interface/manager/session-rename-options.js';
import { getConfigHomeDir } from '../../../config/sessions-config.js';
import { SessionError } from '../../interface/exception/session-error.js';
import type { Session } from '../../interface/session/session.js';
import type { SessionStamp } from '../../interface/stamp/session-stamp.js';
import type { MessageStamp } from '../../interface/stamp/message-stamp.js';
import { buildSession } from '../../../factory/session-factory.js';
import type { FileSystemSessionReader } from '../../../infra/reader/file-system-reader.js';
import type { SessionFileMetadata } from '../../../infra/entry/file-metadata-entry.js';
import type { SessionTranscriptStore } from '../../interface/writer/session-transcript-store.js';
import { isTranscriptMessageEntry } from '../../../infra/entry/transcript-entry.js';
import type { TranscriptEntry } from '../../../infra/entry/transcript-entry.js';
import type { TranscriptMessageEntry } from '../../../infra/entry/transcript-message-entry.js';
import {
  isNumericSessionIndex,
  isSafeSessionFileStem,
  isUuidSessionId,
  resolveBucketDir,
} from '../../../utils/session-utils.js';

const SESSION_FILE_EXTENSION = '.jsonl';
const LIST_READ_CONCURRENCY = 8;
const MAX_SESSION_TITLE_LENGTH = 200;

export interface StandardSessionManagerOptions {
  readonly repository: FileSystemSessionReader;
  /**
   * Required for operations that mutate transcript metadata, such as
   * {@link SessionManager.rename}.
   */
  readonly store?: SessionTranscriptStore;
}

/** Default {@link SessionManager} implementation backed by the file-system repository. */
export class StandardSessionManager implements SessionManager {
  private readonly repository: FileSystemSessionReader;
  private readonly store: SessionTranscriptStore | undefined;

  constructor(options: StandardSessionManagerOptions) {
    this.repository = options.repository;
    this.store = options.store;
  }

  async list(
    projectDir: string,
    options?: SessionLoadOptions,
  ): Promise<readonly Session[]> {
    const bucketDir = resolveBucketDir(projectDir, options?.bucketDir);
    const currentSessionId = options?.currentSessionId;
    const excludes = new Set(options?.excludeSessionIds ?? []);

    const filePaths = (await this.repository.listSessionFiles(bucketDir))
      .filter((path) => !excludes.has(nodePath.basename(path, SESSION_FILE_EXTENSION)));

    const rawSessions: Array<Session | null> = [];
    for (
      let offset = 0;
      offset < filePaths.length;
      offset += LIST_READ_CONCURRENCY
    ) {
      const batch = filePaths.slice(offset, offset + LIST_READ_CONCURRENCY);
      rawSessions.push(
        ...(await Promise.all(
          batch.map((sessionPath) =>
            this.repository
              .readSessionMetadata(sessionPath)
              .then((metadata) =>
                this.toSession(metadata, currentSessionId, projectDir),
              )
              .catch(() => null),
          ),
        )),
      );
    }

    const dedupedById = new Map<string, Session>();
    for (const session of rawSessions) {
      if (!session) continue;
      const existing = dedupedById.get(session.getSessionId());
      if (
        !existing ||
        new Date(session.getUpdatedAt()).getTime() >
          new Date(existing.getUpdatedAt()).getTime()
      ) {
        dedupedById.set(session.getSessionId(), session);
      }
    }

    const sessions = Array.from(dedupedById.values()).sort(
      (left, right) =>
        new Date(right.getUpdatedAt()).getTime() -
        new Date(left.getUpdatedAt()).getTime(),
    );

    sessions.forEach((session, index) => {
      session.setIndex(index + 1);
    });

    return sessions;
  }

  async listAll(
    options?: SessionLoadOptions,
  ): Promise<readonly Session[]> {
    const currentSessionId = options?.currentSessionId;
    const excludes = new Set(options?.excludeSessionIds ?? []);

    const filePaths = (
      await this.repository.listAllSessionFiles(
        getConfigHomeDir(),
        options?.filter,
      )
    ).filter((path) => !excludes.has(nodePath.basename(path, SESSION_FILE_EXTENSION)));

    const rawSessions: Array<Session | null> = [];
    for (
      let offset = 0;
      offset < filePaths.length;
      offset += LIST_READ_CONCURRENCY
    ) {
      const batch = filePaths.slice(offset, offset + LIST_READ_CONCURRENCY);
      rawSessions.push(
        ...(await Promise.all(
          batch.map((sessionPath) =>
            this.repository
              .readSessionMetadata(sessionPath)
              .then((metadata) => this.toSession(metadata, currentSessionId))
              .catch(() => null),
          ),
        )),
      );
    }

    const dedupedById = new Map<string, Session>();
    for (const session of rawSessions) {
      if (!session) continue;
      const existing = dedupedById.get(session.getSessionId());
      if (
        !existing ||
        new Date(session.getUpdatedAt()).getTime() >
          new Date(existing.getUpdatedAt()).getTime()
      ) {
        dedupedById.set(session.getSessionId(), session);
      }
    }

    const sessions = Array.from(dedupedById.values()).sort((left, right) => {
      const projectDirCompare = left.getProjectDir().localeCompare(right.getProjectDir());
      if (projectDirCompare !== 0) {
        return projectDirCompare;
      }
      return (
        new Date(right.getUpdatedAt()).getTime() -
        new Date(left.getUpdatedAt()).getTime()
      );
    });

    sessions.forEach((session, index) => {
      session.setIndex(index + 1);
    });

    return sessions;
  }

  async loadLatest(
    projectDir: string,
    options?: SessionLoadOptions,
  ): Promise<Session> {
    const sessions = await this.list(projectDir, options);
    if (sessions.length === 0) {
      throw SessionError.noSessionsFound();
    }
    return sessions[0];
  }

  async loadById(
    projectDir: string,
    sessionId: string,
    options?: SessionLoadOptions,
  ): Promise<Session | null> {
    if (!isSafeSessionFileStem(sessionId)) {
      return null;
    }

    if (options?.excludeSessionIds?.includes(sessionId)) {
      throw SessionError.sessionNotFound(
        sessionId,
        resolveBucketDir(projectDir, options?.bucketDir),
      );
    }

    const bucketDir = resolveBucketDir(projectDir, options?.bucketDir);
    const sessionPath = nodePath.join(bucketDir, `${sessionId}${SESSION_FILE_EXTENSION}`);

    let metadata: SessionFileMetadata;
    try {
      metadata = await this.repository.readSessionMetadata(sessionPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }

    const session = this.toSession(
      metadata,
      options?.currentSessionId,
      projectDir,
    );
    session.setIndex(0);
    return session;
  }

  async loadByIndex(
    projectDir: string,
    index: number,
    options?: SessionLoadOptions,
  ): Promise<Session> {
    const sessions = await this.list(projectDir, options);
    if (sessions.length === 0) {
      throw SessionError.noSessionsFound();
    }
    if (index <= 0 || index > sessions.length) {
      throw SessionError.invalidSessionIdentifier(
        String(index),
        resolveBucketDir(projectDir, options?.bucketDir),
      );
    }
    return sessions[index - 1];
  }

  async loadByIdOrIndex(
    projectDir: string,
    idOrIndex: string,
    options?: SessionLoadOptions,
  ): Promise<Session> {
    const trimmed = idOrIndex.trim();

    if (!isNumericSessionIndex(trimmed)) {
      const direct = await this.loadById(projectDir, trimmed, options);
      if (direct) {
        return direct;
      }
      throw SessionError.invalidSessionIdentifier(
        trimmed,
        resolveBucketDir(projectDir, options?.bucketDir),
      );
    }

    const sessions = await this.list(projectDir, options);
    if (sessions.length === 0) {
      throw SessionError.noSessionsFound();
    }

    const byId = sessions.find((session) => session.getSessionId() === trimmed);
    if (byId) {
      return byId;
    }

    const index = Number.parseInt(trimmed, 10);
    if (index > 0 && index <= sessions.length) {
      return sessions[index - 1];
    }

    throw SessionError.invalidSessionIdentifier(
      trimmed,
      resolveBucketDir(projectDir, options?.bucketDir),
    );
  }

  async create(stamp?: SessionStamp): Promise<Session> {
    return buildSession(
      stamp ?? {
        sessionId: randomUUID(),
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    );
  }

  async loadByStamp(stamp: SessionStamp): Promise<Session> {
    if (stamp.sessionPath) {
      try {
        const metadata = await this.repository.readSessionMetadata(
          stamp.sessionPath,
        );
        return this.toSession(
          metadata,
          stamp.isCurrentSession ? stamp.sessionId : undefined,
          stamp.projectDir,
        );
      } catch {
        // Fall through to construction from stamp.
      }
    }
    return buildSession(stamp);
  }

  async delete(
    projectDir: string,
    sessionId: string,
    options?: SessionDeleteOptions,
  ): Promise<boolean> {
    if (!isSafeSessionFileStem(sessionId)) {
      return false;
    }
    const bucketDir = resolveBucketDir(projectDir, options?.bucketDir);
    const sessionPath = nodePath.join(bucketDir, `${sessionId}${SESSION_FILE_EXTENSION}`);
    return this.repository.deleteSessionFile(sessionPath);
  }

  async rename(
    projectDir: string,
    sessionId: string,
    title: string,
    options?: SessionRenameOptions,
  ): Promise<Session> {
    if (!this.store) {
      throw new Error(
        'SessionTranscriptStore is required to rename a session.',
      );
    }

    const normalizedTitle = normalizeSessionTitle(title);
    const bucketDir = resolveBucketDir(projectDir, options?.bucketDir);
    const session = await this.loadById(projectDir, sessionId, {
      bucketDir,
    });
    if (!session) {
      throw SessionError.sessionNotFound(sessionId, bucketDir);
    }

    const writer = await this.store.acquireWriter(session, { bucketDir });
    try {
      await writer.recordCustomTitle(normalizedTitle);
      await writer.flush();
    } finally {
      await writer.close();
    }

    const reloaded = await this.loadById(projectDir, sessionId, { bucketDir });
    return reloaded ?? session;
  }

  async info(
    projectDir: string,
    sessionId: string,
    options?: SessionLoadOptions,
  ): Promise<Session> {
    const session = await this.loadById(projectDir, sessionId, options);
    if (!session) {
      throw SessionError.sessionNotFound(
        sessionId,
        resolveBucketDir(projectDir, options?.bucketDir),
      );
    }
    return session;
  }

  async fork(
    projectDir: string,
    sessionId: string,
    options?: SessionForkOptions,
  ): Promise<Session> {
    if (!isSafeSessionFileStem(sessionId)) {
      throw SessionError.invalidSessionIdentifier(
        sessionId,
        resolveBucketDir(projectDir, options?.bucketDir),
      );
    }

    const targetSessionId = options?.targetSessionId ?? randomUUID();
    if (
      !isSafeSessionFileStem(targetSessionId) ||
      !isUuidSessionId(targetSessionId)
    ) {
      throw SessionError.invalidSessionIdentifier(
        targetSessionId,
        resolveBucketDir(projectDir, options?.bucketDir),
      );
    }
    if (targetSessionId === sessionId) {
      throw SessionError.invalidSessionIdentifier(
        targetSessionId,
        resolveBucketDir(projectDir, options?.bucketDir),
      );
    }

    const bucketDir = resolveBucketDir(projectDir, options?.bucketDir);
    const sourceSession = await this.loadById(projectDir, sessionId, {
      bucketDir,
    });
    if (!sourceSession) {
      throw SessionError.sessionNotFound(sessionId, bucketDir);
    }

    const sourcePath = nodePath.join(
      bucketDir,
      `${sessionId}${SESSION_FILE_EXTENSION}`,
    );
    const targetPath = nodePath.join(
      bucketDir,
      `${targetSessionId}${SESSION_FILE_EXTENSION}`,
    );

    const sourceEntries = await this.repository.readSessionEntries(sourcePath);
    if (sourceEntries.length === 0) {
      throw SessionError.sessionNotFound(sessionId, bucketDir);
    }

    let messages = sourceEntries.filter(isTranscriptMessageEntry);
    if (options?.resumeSessionAt) {
      const cutoffIndex = messages.findIndex(
        (message) => message.uuid === options!.resumeSessionAt,
      );
      if (cutoffIndex === -1) {
        throw SessionError.invalidSessionIdentifier(
          options.resumeSessionAt,
          bucketDir,
        );
      }
      messages = messages.slice(0, cutoffIndex + 1);
    }

    if (messages.length === 0) {
      throw new Error('No conversation to branch.');
    }

    // Aligned with ForkSessionService.buildForkEntries:
    // each copied message gets its own forkedFrom pointing at itself, and
    // isSidechain is explicitly reset to false.  When the caller supplies
    // an explicit forkedFrom override (e.g. interactive re-branch) every
    // message shares that single provenance instead.
    const explicitForkedFrom = options?.forkedFrom;

    const forkedMessageEntries: TranscriptMessageEntry[] = messages.map(
      (message) =>
        ({
          ...(message as Record<string, unknown>),
          sessionId: targetSessionId,
          isSidechain: false,
          forkedFrom: explicitForkedFrom ?? {
            sessionId,
            messageUuid: message.uuid,
          },
        }) as TranscriptMessageEntry,
    );

    const forkEntries: TranscriptEntry[] = [...forkedMessageEntries];

    forkEntries.push({
      type: 'relocated',
      sessionId: targetSessionId,
      relocatedCwd: sourceSession.getCwd(),
    });

    forkEntries.push({
      type: 'worktree-state',
      sessionId: targetSessionId,
      worktreeSession: null,
    });

    const tag = sourceSession.getTag();
    if (tag) {
      forkEntries.push({
        type: 'tag',
        sessionId: targetSessionId,
        tag,
      });
    }

    const targetTitle = options?.targetTitle?.trim();
    if (targetTitle) {
      forkEntries.push({
        type: 'custom-title',
        sessionId: targetSessionId,
        customTitle: targetTitle,
      });
    }

    await this.repository.writeSessionEntries(targetPath, forkEntries);

    const forkedMessageStamps = buildMessageStampsFromTranscriptEntries(
      forkedMessageEntries,
    );
    return buildSession({
      sessionId: targetSessionId,
      projectDir: sourceSession.getProjectDir(),
      sessionPath: targetPath,
      cwd: sourceSession.getCwd(),
      transcriptProjectDir: sourceSession.getTranscriptProjectDir(),
      transcriptBucketDir: bucketDir,
      startedAt: messages[0].timestamp,
      updatedAt: messages[messages.length - 1].timestamp,
      messages: forkedMessageStamps,
      customTitle: targetTitle || sourceSession.getCustomTitle(),
      aiTitle: sourceSession.getAiTitle(),
      lastPrompt: sourceSession.getLastPrompt(),
      summary: sourceSession.getSummary(),
      tag,
    });
  }

  private toSession(
    metadata: SessionFileMetadata,
    currentSessionId: string | undefined,
    explicitProjectDir?: string,
  ): Session {
    const projectDir =
      explicitProjectDir ?? metadata.directories?.[0] ?? metadata.cwd ?? '';

    return buildSession({
      sessionId: metadata.sessionId,
      projectDir,
      sessionPath: metadata.sessionPath,
      cwd: metadata.cwd,
      gitBranch: metadata.gitBranch,
      startedAt: metadata.startedAt,
      updatedAt: metadata.updatedAt,
      fileSize: metadata.fileSize,
      transcriptProjectDir: projectDir,
      transcriptBucketDir: metadata.transcriptBucketDir,
      directories: metadata.directories,
      isCurrentSession: currentSessionId === metadata.sessionId,
      customTitle: metadata.customTitle,
      aiTitle: metadata.aiTitle,
      lastPrompt: metadata.lastPrompt,
      summary: metadata.summary,
      tag: metadata.tag,
    });
  }
}

function buildMessageStampsFromTranscriptEntries(
  entries: readonly TranscriptMessageEntry[],
): MessageStamp[] {
  return entries.map((entry) => ({
    uuid: entry.uuid,
    sessionId: entry.sessionId,
    parent: entry.parentUuid,
    logicalParent: entry.logicalParentUuid,
    timestamp: entry.timestamp,
    role: entry.type,
    payload: entry.message ?? (entry.attachment ? { attachment: entry.attachment } : undefined),
    promptId: entry.promptId,
    requestSetId: entry.requestSetId,
    agentId: entry.agentId,
    forkedFrom: entry.forkedFrom,
    isMeta: entry['isMeta'] as boolean | undefined,
    isSidechain: entry.isSidechain,
    origin: entry['origin'] as { readonly kind: string } | undefined,
  }));
}

function normalizeSessionTitle(title: string): string {
  const normalized = title.replace(/[\r\n]+/g, ' ').trim();
  if (!normalized) {
    throw SessionError.invalidSessionTitle(title, MAX_SESSION_TITLE_LENGTH);
  }
  if (normalized.length > MAX_SESSION_TITLE_LENGTH) {
    throw SessionError.invalidSessionTitle(title, MAX_SESSION_TITLE_LENGTH);
  }
  return normalized;
}
