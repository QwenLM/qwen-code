/**
 * Session Storage
 *
 * Workspace-scoped session CRUD operations.
 * Sessions are stored at {workspaceRootPath}/sessions/{id}/session.jsonl
 * Each session folder contains:
 * - session.jsonl (main data in JSONL format: line 1 = header, lines 2+ = messages)
 * - attachments/ (file attachments)
 * - plans/ (plan files for Safe Mode)
 * - data/ (transform_data tool output: JSON files for datatable/spreadsheet blocks)
 * - long_responses/ (full tool results that were summarized due to size limits)
 * - downloads/ (binary files downloaded from API sources: PDFs, images, archives, etc.)
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'fs';
import { join, basename } from 'path';
import { getWorkspaceSessionsPath } from '../workspaces/storage.ts';
import { generateUniqueSessionId } from './slug-generator.ts';
import { toPortablePath, expandPath } from '../utils/paths.ts';
import { sanitizeSessionId } from './validation.ts';
import { perf } from '../utils/perf.ts';
import type {
  SessionConfig,
  StoredSession,
  SessionMetadata,
  SessionTokenUsage,
  SessionHeader,
  SessionStatus,
} from './types.ts';
import type { Plan } from '../agent/plan-types.ts';
import { validateSessionStatus } from '../statuses/validation.ts';
import { debug } from '../utils/debug.ts';
import { getStatusCategory } from '../statuses/storage.ts';
import { readSessionHeader, readSessionJsonl } from './jsonl.ts';
import { sessionPersistenceQueue } from './persistence-queue.ts';

// Re-export types for convenience
export type { SessionConfig } from './types.ts';

// ============================================================
// Directory Utilities
// ============================================================

/**
 * Ensure sessions directory exists for a workspace
 */
export function ensureSessionsDir(workspaceRootPath: string): string {
  const dir = getWorkspaceSessionsPath(workspaceRootPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Get path to a session's directory
 *
 * SECURITY: Uses sanitizeSessionId() as defense-in-depth to prevent path traversal.
 * Callers should still validate sessionId before calling this function.
 */
export function getSessionPath(workspaceRootPath: string, sessionId: string): string {
  // Defense-in-depth: strip any path components from sessionId
  const safeSessionId = sanitizeSessionId(sessionId);
  return join(getWorkspaceSessionsPath(workspaceRootPath), safeSessionId);
}

/**
 * Get path to a session's JSONL file (inside session folder)
 */
export function getSessionFilePath(workspaceRootPath: string, sessionId: string): string {
  return join(getSessionPath(workspaceRootPath, sessionId), 'session.jsonl');
}

/**
 * Ensure session directory exists with all subdirectories
 */
export function ensureSessionDir(workspaceRootPath: string, sessionId: string): string {
  const sessionDir = getSessionPath(workspaceRootPath, sessionId);
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }
  // Also create plans, attachments, long_responses, and downloads directories
  const plansDir = join(sessionDir, 'plans');
  if (!existsSync(plansDir)) {
    mkdirSync(plansDir, { recursive: true });
  }
  const attachmentsDir = join(sessionDir, 'attachments');
  if (!existsSync(attachmentsDir)) {
    mkdirSync(attachmentsDir, { recursive: true });
  }
  const longResponsesDir = join(sessionDir, 'long_responses');
  if (!existsSync(longResponsesDir)) {
    mkdirSync(longResponsesDir, { recursive: true });
  }
  // Data directory for transform_data tool output (JSON files for datatable/spreadsheet)
  const dataDir = join(sessionDir, 'data');
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
  // Downloads directory for binary files from API responses (PDFs, images, etc.)
  const downloadsDir = join(sessionDir, 'downloads');
  if (!existsSync(downloadsDir)) {
    mkdirSync(downloadsDir, { recursive: true });
  }
  return sessionDir;
}

/**
 * Get the attachments directory for a session
 */
export function getSessionAttachmentsPath(workspaceRootPath: string, sessionId: string): string {
  return join(getSessionPath(workspaceRootPath, sessionId), 'attachments');
}

/**
 * Get the plans directory for a session
 */
export function getSessionPlansPath(workspaceRootPath: string, sessionId: string): string {
  return join(getSessionPath(workspaceRootPath, sessionId), 'plans');
}

/**
 * Get the data directory for a session (transform_data tool output)
 */
export function getSessionDataPath(workspaceRootPath: string, sessionId: string): string {
  return join(getSessionPath(workspaceRootPath, sessionId), 'data');
}

/**
 * Get the downloads directory for a session (binary files from API responses)
 */
export function getSessionDownloadsPath(workspaceRootPath: string, sessionId: string): string {
  return join(getSessionPath(workspaceRootPath, sessionId), 'downloads');
}

// ============================================================
// Session ID Generation
// ============================================================

/**
 * Get existing session IDs for collision detection
 */
function getExistingSessionIds(workspaceRootPath: string): Set<string> {
  const sessionsDir = getWorkspaceSessionsPath(workspaceRootPath);
  if (!existsSync(sessionsDir)) {
    return new Set();
  }
  const entries = readdirSync(sessionsDir, { withFileTypes: true });
  return new Set(entries.filter(e => e.isDirectory()).map(e => e.name));
}

/**
 * Generate a human-readable session ID.
 * Uses a prompt/title hint when available, otherwise falls back to a random
 * adjective-noun slug.
 */
export function generateSessionId(workspaceRootPath: string, slugHint?: string): string {
  const existingIds = getExistingSessionIds(workspaceRootPath);
  return generateUniqueSessionId(existingIds, new Date(), slugHint);
}

// ============================================================
// Session CRUD
// ============================================================

/**
 * Create a new session for a workspace
 */
export async function createSession(
  workspaceRootPath: string,
  options?: {
    name?: string;
    workingDirectory?: string;
    enabledSourceSlugs?: string[];
    model?: string;
    llmConnection?: string;
    hidden?: boolean;
    sessionStatus?: SessionConfig['sessionStatus'];
    labels?: string[];
    isFlagged?: boolean;
    slugHint?: string;
  }
): Promise<SessionConfig> {
  ensureSessionsDir(workspaceRootPath);

  const now = Date.now();
  const sessionId = generateSessionId(workspaceRootPath, options?.slugHint ?? options?.name);

  // Create session directory with all subdirectories (plans, attachments)
  ensureSessionDir(workspaceRootPath, sessionId);

  // Set sdkCwd to initial working directory or session path - this never changes
  // The backend stores session transcripts in a provider-specific per-CWD folder.
  // If workingDirectory changes later, sdkCwd stays the same to preserve session resumption
  const sdkCwd = options?.workingDirectory ?? getSessionPath(workspaceRootPath, sessionId);

  const session: SessionConfig = {
    id: sessionId,
    workspaceRootPath,
    name: options?.name,
    createdAt: now,
    lastUsedAt: now,
    workingDirectory: options?.workingDirectory,
    sdkCwd,
    enabledSourceSlugs: options?.enabledSourceSlugs,
    model: options?.model,
    llmConnection: options?.llmConnection,
    hidden: options?.hidden,
    sessionStatus: options?.sessionStatus,
    labels: options?.labels,
    isFlagged: options?.isFlagged,
  };

  // Save empty session
  const storedSession: StoredSession = {
    ...session,
    messages: [],
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextTokens: 0,
      costUsd: 0,
    },
  };
  await saveSession(storedSession);

  return session;
}

/**
 * Get or create a session with a specific ID
 * Used for --session <id> flag to allow user-defined session IDs
 */
export async function getOrCreateSessionById(
  workspaceRootPath: string,
  sessionId: string
): Promise<SessionConfig> {
  const existing = loadSession(workspaceRootPath, sessionId);
  if (existing) {
    return {
      id: existing.id,
      sdkSessionId: existing.sdkSessionId,
      workspaceRootPath: existing.workspaceRootPath,
      name: existing.name,
      createdAt: existing.createdAt,
      lastUsedAt: existing.lastUsedAt,
      sdkCwd: existing.sdkCwd,
      workingDirectory: existing.workingDirectory,
    };
  }

  // Create new session with the specified ID
  ensureSessionsDir(workspaceRootPath);

  // Create session directory with all subdirectories (plans, attachments)
  ensureSessionDir(workspaceRootPath, sessionId);

  const now = Date.now();
  // Set sdkCwd to session path - this never changes (ensures SDK can find session transcripts)
  const sdkCwd = getSessionPath(workspaceRootPath, sessionId);

  const session: SessionConfig = {
    id: sessionId,
    workspaceRootPath,
    sdkCwd,
    createdAt: now,
    lastUsedAt: now,
  };

  const storedSession: StoredSession = {
    ...session,
    messages: [],
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextTokens: 0,
      costUsd: 0,
    },
  };
  await saveSession(storedSession);

  return session;
}

/**
 * Save session immediately using the persistence queue.
 * Enqueues the session and flushes to ensure immediate write.
 *
 * This unified approach ensures all session writes go through the same
 * async code path, which is more reliable on Windows.
 *
 * Writes in JSONL format: line 1 = header, lines 2+ = messages
 */
export async function saveSession(session: StoredSession): Promise<void> {
  const existingHeader = readSessionHeader(getSessionFilePath(session.workspaceRootPath, session.id));
  const preserveProviderNativeMinimalHeader = !!existingHeader?.sdkSessionId
    && existingHeader.tokenUsage === undefined
    && existingHeader.createdAt === undefined
    && existingHeader.lastUsedAt === undefined
    && existingHeader.lastMessageAt === undefined;

  const sessionToPersist = preserveProviderNativeMinimalHeader
    ? ({
        ...session,
        name: undefined,
        createdAt: undefined,
        lastUsedAt: undefined,
        lastMessageAt: undefined,
        workingDirectory: undefined,
        sdkCwd: undefined,
        omitMessageDerivedHeaderFields: true,
        omitTranscriptDerivedHeaderFields: true,
        omitHeaderTokenUsage: true,
      } as StoredSession)
    : session;

  sessionPersistenceQueue.enqueue(sessionToPersist);
  await sessionPersistenceQueue.flush(session.id);
}

/**
 * Queue session for async persistence with debouncing.
 * Multiple rapid calls are coalesced into a single write.
 * Use this during active sessions to avoid blocking the main thread.
 */
export { sessionPersistenceQueue, getHeaderMetadataSignature } from './persistence-queue.js'

/**
 * Load session by ID
 * Loads session from folder structure in JSONL format.
 */
export function loadSession(workspaceRootPath: string, sessionId: string): StoredSession | null {
  const end = perf.start('session.loadSession', { sessionId });

  const jsonlPath = getSessionFilePath(workspaceRootPath, sessionId);
  if (existsSync(jsonlPath)) {
    const session = readSessionJsonl(jsonlPath);
    if (session) {
      end();
      return session;
    }
  }

  end();
  return null;
}

/**
 * List sessions for a workspace
 * Lists sessions from folder structure.
 *
 * Uses JSONL header for fast loading (only reads first line of each file).
 */
export function listSessions(workspaceRootPath: string): SessionMetadata[] {
  const span = perf.span('session.listSessions');
  const sessionsDir = getWorkspaceSessionsPath(workspaceRootPath);
  if (!existsSync(sessionsDir)) {
    span.end();
    return [];
  }

  const entries = readdirSync(sessionsDir, { withFileTypes: true });
  span.mark('readdir');
  const sessions: SessionMetadata[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const sessionId = entry.name;
      const sessionDir = join(sessionsDir, sessionId);
      const jsonlFile = join(sessionDir, 'session.jsonl');

      // Clean up orphaned .tmp files from crashed atomic writes.
      // These are harmless but waste disk space.
      const tmpFile = jsonlFile + '.tmp';
      if (existsSync(tmpFile)) {
        try { unlinkSync(tmpFile); } catch { /* ignore */ }
      }

      if (existsSync(jsonlFile)) {
        const header = readSessionHeader(jsonlFile);
        if (header) {
          const metadata = headerToMetadata(header, workspaceRootPath);
          if (metadata) sessions.push(metadata);
        }
      }
    }
  }
  span.mark('parsed');
  span.setMetadata('count', sessions.length);

  // Sort by lastUsedAt descending (most recent first)
  const sorted = sessions.sort(
    (a, b) => (b.lastUsedAt ?? b.lastMessageAt ?? b.createdAt ?? 0) -
      (a.lastUsedAt ?? a.lastMessageAt ?? a.createdAt ?? 0)
  );
  span.end();
  return sorted;
}

/**
 * Convert SessionHeader to SessionMetadata
 * Used for fast session list loading from JSONL format.
 */
function headerToMetadata(header: SessionHeader, workspaceRootPath: string): SessionMetadata | null {
  try {
    // Migration: accept old 'todoState' field from pre-rename session files
    const rawStatus = header.sessionStatus ?? (header as unknown as { todoState?: string }).todoState;
    // Validate sessionStatus against workspace status config
    const validatedStatus = validateSessionStatus(workspaceRootPath, rawStatus);

    // Count plan files for this session
    const planCount = listPlanFiles(workspaceRootPath, header.id).length;

    // Migration: For sessions created before sdkCwd was added, use workingDirectory as fallback.
    const workingDir = header.workingDirectory ? expandPath(header.workingDirectory) : undefined;
    const sdkCwd = header.sdkCwd ? expandPath(header.sdkCwd) : workingDir;

    // Destructure fields that don't exist on SessionMetadata or need overrides
    const {
      enabledSourceSlugs: _es, pendingPlanExecution: _pp,
      sessionStatus: _ss, workingDirectory: _wd, sdkCwd: _sc,
      model: _model,
      workspaceRootPath: _wrp, ...headerFields
    } = header;

    return {
      ...headerFields,
      workspaceRootPath,
      sessionStatus: validatedStatus,
      planCount: planCount > 0 ? planCount : undefined,
      workingDirectory: workingDir,
      sdkCwd,
    } as SessionMetadata;
  } catch (error) {
    debug(`[sessions] Failed to convert header to metadata for session "${header?.id}" in ${workspaceRootPath}:`, error);
    return null;
  }
}

/**
 * Delete a session and its associated files
 * Deletes session folder and all associated files
 */
export function deleteSession(workspaceRootPath: string, sessionId: string): boolean {
  try {
    // Delete session directory (includes session.json, attachments, plans)
    const sessionDir = getSessionPath(workspaceRootPath, sessionId);
    if (existsSync(sessionDir)) {
      rmSync(sessionDir, { recursive: true });
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Clear messages from a session while preserving metadata.
 * Used for /clear command to reset conversation without creating a new session.
 * Also clears the SDK session ID to start a fresh backend conversation.
 */
export async function clearSessionMessages(workspaceRootPath: string, sessionId: string): Promise<void> {
  const session = loadSession(workspaceRootPath, sessionId);
  if (session) {
    // Clear messages and SDK session ID but preserve metadata
    session.messages = [];
    session.sdkSessionId = undefined;
    // Reset token usage to zero
    session.tokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextTokens: 0,
      costUsd: 0,
    };
    await saveSession(session);
  }
}

/**
 * Get or create the latest session for a workspace
 * Uses listActiveSessions to exclude archived sessions
 */
export async function getOrCreateLatestSession(workspaceRootPath: string): Promise<SessionConfig> {
  const sessions = listActiveSessions(workspaceRootPath);
  if (sessions.length > 0 && sessions[0]) {
    const latest = sessions[0];
    return {
      id: latest.id,
      sdkSessionId: latest.sdkSessionId,
      workspaceRootPath: latest.workspaceRootPath,
      name: latest.name,
      createdAt: latest.createdAt ?? Date.now(),
      lastUsedAt: latest.lastUsedAt ?? latest.lastMessageAt ?? Date.now(),
    };
  }
  return createSession(workspaceRootPath);
}

// ============================================================
// Session Metadata Updates
// ============================================================

/**
 * Update SDK session ID for a session
 */
export async function updateSessionSdkId(
  workspaceRootPath: string,
  sessionId: string,
  sdkSessionId: string
): Promise<void> {
  const session = loadSession(workspaceRootPath, sessionId);
  if (session) {
    session.sdkSessionId = sdkSessionId;
    await saveSession(session);
  }
}

/**
 * Check if sdkCwd can be safely updated for a session.
 *
 * sdkCwd is normally immutable because the SDK stores session transcripts at
 * provider-specific per-CWD session folder. However, it's safe to update sdkCwd if
 * no SDK interaction has occurred yet (no transcripts to preserve).
 *
 * @returns true if sdkCwd can be updated (no messages and no SDK session ID)
 */
export function canUpdateSdkCwd(session: StoredSession): boolean {
  // Safe to update if:
  // 1. No messages have been sent yet (no conversation to preserve)
  // 2. No SDK session ID (no transcript exists at the sdkCwd path)
  return session.messages.length === 0 && !session.sdkSessionId;
}

/**
 * Update session metadata
 */
export async function updateSessionMetadata(
  workspaceRootPath: string,
  sessionId: string,
  updates: Partial<Pick<SessionConfig,
    | 'isFlagged'
    | 'name'
    | 'sessionStatus'
    | 'labels'
    | 'lastReadMessageId'
    | 'hasUnread'
    | 'enabledSourceSlugs'
    | 'workingDirectory'
    | 'sdkCwd'
    | 'sharedUrl'
    | 'sharedId'
    | 'model'
    | 'llmConnection'
    | 'isArchived'
    | 'archivedAt'
  >>
): Promise<void> {
  const session = loadSession(workspaceRootPath, sessionId);
  if (!session) return;

  if (updates.isFlagged !== undefined) session.isFlagged = updates.isFlagged;
  if (updates.name !== undefined) session.name = updates.name;
  if (updates.sessionStatus !== undefined) session.sessionStatus = updates.sessionStatus;
  if (updates.labels !== undefined) session.labels = updates.labels;
  if (updates.enabledSourceSlugs !== undefined) session.enabledSourceSlugs = updates.enabledSourceSlugs;
  if (updates.workingDirectory !== undefined) session.workingDirectory = updates.workingDirectory;
  if (updates.sdkCwd !== undefined) session.sdkCwd = updates.sdkCwd;
  if ('lastReadMessageId' in updates) session.lastReadMessageId = updates.lastReadMessageId;
  if ('hasUnread' in updates) session.hasUnread = updates.hasUnread;
  if ('sharedUrl' in updates) session.sharedUrl = updates.sharedUrl;
  if ('sharedId' in updates) session.sharedId = updates.sharedId;
  if ('model' in updates) session.model = updates.model;
  if (updates.llmConnection !== undefined) session.llmConnection = updates.llmConnection;
  if (updates.isArchived !== undefined) session.isArchived = updates.isArchived;
  if ('archivedAt' in updates) session.archivedAt = updates.archivedAt;

  await saveSession(session);
}

/**
 * Flag a session
 */
export async function flagSession(workspaceRootPath: string, sessionId: string): Promise<void> {
  await updateSessionMetadata(workspaceRootPath, sessionId, { isFlagged: true });
}

/**
 * Unflag a session
 */
export async function unflagSession(workspaceRootPath: string, sessionId: string): Promise<void> {
  await updateSessionMetadata(workspaceRootPath, sessionId, { isFlagged: false });
}

/**
 * Set session status
 */
export async function setSessionStatus(
  workspaceRootPath: string,
  sessionId: string,
  sessionStatus: SessionStatus
): Promise<void> {
  await updateSessionMetadata(workspaceRootPath, sessionId, { sessionStatus });
}

/**
 * Set labels for a session
 */
export async function setSessionLabels(
  workspaceRootPath: string,
  sessionId: string,
  labels: string[]
): Promise<void> {
  await updateSessionMetadata(workspaceRootPath, sessionId, { labels });
}

/**
 * Archive a session
 */
export async function archiveSession(workspaceRootPath: string, sessionId: string): Promise<void> {
  await updateSessionMetadata(workspaceRootPath, sessionId, {
    isArchived: true,
    archivedAt: Date.now(),
  });
}

/**
 * Unarchive a session
 */
export async function unarchiveSession(workspaceRootPath: string, sessionId: string): Promise<void> {
  await updateSessionMetadata(workspaceRootPath, sessionId, {
    isArchived: false,
    archivedAt: undefined,
  });
}

// ============================================================
// Pending Plan Execution (Accept & Compact flow)
// ============================================================

/**
 * Set pending plan execution state.
 * Called when user clicks "Accept & Compact" - stores the plan path
 * so it can be executed after compaction, even if the page reloads.
 */
export async function setPendingPlanExecution(
  workspaceRootPath: string,
  sessionId: string,
  planPath: string,
  draftInputSnapshot?: string,
): Promise<void> {
  const session = loadSession(workspaceRootPath, sessionId);
  if (!session) return;

  session.pendingPlanExecution = {
    planPath,
    draftInputSnapshot,
    awaitingCompaction: true,
    executionDispatched: false,
  };
  await saveSession(session);
}

/**
 * Mark compaction as complete for pending plan execution.
 * Called when compaction_complete event fires - sets awaitingCompaction to false
 * so reload recovery knows compaction finished and can trigger execution.
 */
export async function markCompactionComplete(
  workspaceRootPath: string,
  sessionId: string
): Promise<void> {
  const session = loadSession(workspaceRootPath, sessionId);
  if (!session?.pendingPlanExecution) return;

  session.pendingPlanExecution.awaitingCompaction = false;
  await saveSession(session);
}

/**
 * Mark pending plan execution as already dispatched from the UI.
 * This prevents reload recovery from sending the same approval message twice
 * if cleanup fails after the send has already been kicked off.
 */
export async function markPendingPlanExecutionDispatched(
  workspaceRootPath: string,
  sessionId: string
): Promise<void> {
  const session = loadSession(workspaceRootPath, sessionId);
  if (!session?.pendingPlanExecution) return;

  session.pendingPlanExecution.executionDispatched = true;
  await saveSession(session);
}

/**
 * Clear pending plan execution state.
 * Called after plan execution is sent, on new user message, or when
 * the pending execution is no longer relevant.
 */
export async function clearPendingPlanExecution(
  workspaceRootPath: string,
  sessionId: string
): Promise<void> {
  const session = loadSession(workspaceRootPath, sessionId);
  if (!session) return;

  delete session.pendingPlanExecution;
  await saveSession(session);
}

/**
 * Get pending plan execution state for a session.
 * Used on reload to check if we need to resume plan execution.
 */
export function getPendingPlanExecution(
  workspaceRootPath: string,
  sessionId: string
): { planPath: string; draftInputSnapshot?: string; awaitingCompaction: boolean; executionDispatched: boolean } | null {
  const session = loadSession(workspaceRootPath, sessionId);
  if (!session?.pendingPlanExecution) return null;
  return {
    ...session.pendingPlanExecution,
    executionDispatched: session.pendingPlanExecution.executionDispatched === true,
  };
}

// ============================================================
// Session Filtering
// ============================================================

/**
 * List flagged sessions (excludes archived)
 */
export function listFlaggedSessions(workspaceRootPath: string): SessionMetadata[] {
  return listActiveSessions(workspaceRootPath).filter(s => s.isFlagged === true);
}

/**
 * List completed sessions (category: closed)
 * Includes done, cancelled, and any custom "closed" statuses
 * Excludes archived sessions
 */
export function listCompletedSessions(workspaceRootPath: string): SessionMetadata[] {
  return listActiveSessions(workspaceRootPath).filter(s => {
    const category = getStatusCategory(workspaceRootPath, s.sessionStatus || 'todo');
    return category === 'closed';
  });
}

/**
 * List inbox sessions (category: open)
 * Includes todo, in-progress, needs-review, and any custom "open" statuses
 * Excludes archived sessions
 */
export function listInboxSessions(workspaceRootPath: string): SessionMetadata[] {
  return listActiveSessions(workspaceRootPath).filter(s => {
    const category = getStatusCategory(workspaceRootPath, s.sessionStatus || 'todo');
    return category === 'open';
  });
}

/**
 * List archived sessions
 */
export function listArchivedSessions(workspaceRootPath: string): SessionMetadata[] {
  return listSessions(workspaceRootPath).filter(s => s.isArchived === true);
}

/**
 * List active (non-archived) sessions
 */
export function listActiveSessions(workspaceRootPath: string): SessionMetadata[] {
  return listSessions(workspaceRootPath).filter(s => s.isArchived !== true);
}

/**
 * Delete archived sessions older than the specified number of days
 * Returns the number of sessions deleted
 */
export function deleteOldArchivedSessions(workspaceRootPath: string, retentionDays: number): number {
  const cutoffTime = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
  const archivedSessions = listArchivedSessions(workspaceRootPath);
  let deletedCount = 0;

  for (const session of archivedSessions) {
    // Use archivedAt if available, otherwise fall back to lastUsedAt
    const archiveTime = session.archivedAt ?? session.lastUsedAt ?? session.lastMessageAt ?? session.createdAt ?? 0;
    if (archiveTime < cutoffTime) {
      if (deleteSession(workspaceRootPath, session.id)) {
        deletedCount++;
      }
    }
  }

  return deletedCount;
}

// ============================================================
// Plan Storage (Session-Scoped)
// ============================================================

/**
 * Slugify a string for file names
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[/\\:*?"<>|]/g, '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .trim();
}

/**
 * Generate a unique, readable file name for a plan
 */
function generatePlanFileName(plan: Plan, plansDir: string): string {
  let name = plan.title || plan.context?.substring(0, 50) || 'untitled';
  let slug = slugify(name);

  if (slug.length > 40) {
    slug = slug.substring(0, 40).replace(/-$/, '');
  }

  const date = new Date().toISOString().split('T')[0];
  const baseName = `${date}-${slug}`;

  let fileName = baseName;
  let counter = 2;

  while (existsSync(join(plansDir, `${fileName}.md`))) {
    fileName = `${baseName}-${counter}`;
    counter++;
  }

  return fileName;
}

/**
 * Ensure the plans directory exists
 */
function ensurePlansDir(workspaceRootPath: string, sessionId: string): string {
  const plansDir = getSessionPlansPath(workspaceRootPath, sessionId);
  if (!existsSync(plansDir)) {
    mkdirSync(plansDir, { recursive: true });
  }
  return plansDir;
}

/**
 * Format a plan as markdown
 */
export function formatPlanAsMarkdown(plan: Plan): string {
  const lines: string[] = [];

  lines.push(`# ${plan.title}`);
  lines.push('');
  lines.push(`**Status:** ${plan.state}`);
  lines.push(`**Created:** ${new Date(plan.createdAt).toISOString()}`);
  if (plan.updatedAt !== plan.createdAt) {
    lines.push(`**Updated:** ${new Date(plan.updatedAt).toISOString()}`);
  }
  lines.push('');

  if (plan.context) {
    lines.push('## Summary');
    lines.push('');
    lines.push(plan.context);
    lines.push('');
  }

  lines.push('## Steps');
  lines.push('');
  for (const step of plan.steps) {
    const checkbox = step.status === 'completed' ? '[x]' : '[ ]';
    const status = step.status === 'in_progress' ? ' *(in progress)*' : '';
    lines.push(`- ${checkbox} ${step.description}${status}`);
    if (step.details) {
      lines.push(`  - Tools: ${step.details}`);
    }
  }
  lines.push('');

  if (plan.refinementHistory && plan.refinementHistory.length > 0) {
    lines.push('## Refinement History');
    lines.push('');
    for (const entry of plan.refinementHistory) {
      lines.push(`### Round ${entry.round}`);
      lines.push(`**Feedback:** ${entry.feedback}`);
      if (entry.questions && entry.questions.length > 0) {
        lines.push(`**Questions:** ${entry.questions.join(', ')}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Parse a markdown plan file back to a Plan object
 */
export function parsePlanFromMarkdown(content: string, planId: string): Plan | null {
  try {
    const lines = content.split('\n');

    const titleLine = lines.find(l => l.startsWith('# '));
    const title = titleLine ? titleLine.substring(2).trim() : 'Untitled Plan';

    const statusLine = lines.find(l => l.startsWith('**Status:**'));
    const stateStr = statusLine ? statusLine.replace('**Status:**', '').trim() : 'ready';
    const state = (['creating', 'refining', 'ready', 'executing', 'completed', 'cancelled'].includes(stateStr)
      ? stateStr
      : 'ready') as Plan['state'];

    const summaryIdx = lines.findIndex(l => l === '## Summary');
    const stepsIdx = lines.findIndex(l => l === '## Steps');
    let context = '';
    if (summaryIdx !== -1 && stepsIdx !== -1) {
      context = lines.slice(summaryIdx + 2, stepsIdx).join('\n').trim();
    }

    const steps: Plan['steps'] = [];
    if (stepsIdx !== -1) {
      for (let i = stepsIdx + 2; i < lines.length; i++) {
        const line = lines[i];
        if (!line || line.startsWith('##')) break;
        if (line.startsWith('- [')) {
          const isCompleted = line.startsWith('- [x]');
          const isInProgress = line.includes('*(in progress)*');
          const description = line
            .replace(/^- \[[ x]\] /, '')
            .replace(' *(in progress)*', '')
            .trim();
          steps.push({
            id: `step-${steps.length + 1}`,
            description,
            status: isCompleted ? 'completed' : isInProgress ? 'in_progress' : 'pending',
          });
        }
      }
    }

    return {
      id: planId,
      title,
      state,
      context,
      steps,
      refinementRound: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

/**
 * Save a plan to a markdown file
 */
export function savePlanToFile(
  workspaceRootPath: string,
  sessionId: string,
  plan: Plan,
  fileName?: string
): string {
  const plansDir = ensurePlansDir(workspaceRootPath, sessionId);
  const name = fileName || generatePlanFileName(plan, plansDir);
  const filePath = join(plansDir, `${name}.md`);
  const content = formatPlanAsMarkdown(plan);

  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

/**
 * Load a plan from a markdown file by name
 */
export function loadPlanFromFile(
  workspaceRootPath: string,
  sessionId: string,
  fileName: string
): Plan | null {
  const plansDir = getSessionPlansPath(workspaceRootPath, sessionId);
  const filePath = join(plansDir, `${fileName}.md`);
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    return parsePlanFromMarkdown(content, fileName);
  } catch {
    return null;
  }
}

/**
 * Load a plan from a full file path
 */
export function loadPlanFromPath(filePath: string): Plan | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const fileName = basename(filePath).replace('.md', '') || 'unknown';
    return parsePlanFromMarkdown(content, fileName);
  } catch {
    return null;
  }
}

/**
 * List all plan files in a session
 */
export function listPlanFiles(
  workspaceRootPath: string,
  sessionId: string
): Array<{ name: string; path: string; modifiedAt: number }> {
  const plansDir = getSessionPlansPath(workspaceRootPath, sessionId);
  if (!existsSync(plansDir)) {
    return [];
  }

  try {
    const files = readdirSync(plansDir)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        const filePath = join(plansDir, f);
        const stats = existsSync(filePath) ? statSync(filePath) : null;
        return {
          name: f.replace('.md', ''),
          path: filePath,
          modifiedAt: stats?.mtimeMs || 0,
        };
      })
      .sort((a, b) => b.modifiedAt - a.modifiedAt);

    return files;
  } catch {
    return [];
  }
}

/**
 * Delete a plan file
 */
export function deletePlanFile(
  workspaceRootPath: string,
  sessionId: string,
  fileName: string
): boolean {
  const plansDir = getSessionPlansPath(workspaceRootPath, sessionId);
  const filePath = join(plansDir, `${fileName}.md`);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
    return true;
  }
  return false;
}

/**
 * Get the most recent plan file for a session
 */
export function getMostRecentPlanFile(
  workspaceRootPath: string,
  sessionId: string
): { name: string; path: string } | null {
  const files = listPlanFiles(workspaceRootPath, sessionId);
  return files.length > 0 ? files[0]! : null;
}

// ============================================================
// Attachments Directory
// ============================================================

/**
 * Ensure attachments directory exists
 */
export function ensureAttachmentsDir(workspaceRootPath: string, sessionId: string): string {
  const dir = getSessionAttachmentsPath(workspaceRootPath, sessionId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}
