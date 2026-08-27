/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { DaemonHttpError } from './DaemonHttpError.js';
import type {
  DaemonApprovalMode,
  DaemonRestoredSession,
  DaemonSession,
  DaemonSessionArchiveState,
  DaemonSessionSummary,
} from './types.js';

export const STANDALONE_SESSIONS_CAPABILITY = 'standalone_sessions_v1';

export interface CreateStandaloneSessionOptions {
  sessionId?: string;
  modelServiceId?: string;
  approvalMode?: DaemonApprovalMode;
}

export interface RestoreStandaloneSessionRequest {
  approvalMode?: DaemonApprovalMode;
  historyPageSize?: number;
  liveReplayMode?: 'full' | 'summary';
  hideInheritedHistory?: boolean;
  timeoutMs?: number;
}

export interface DaemonStandaloneWorkingDirectory {
  state: 'ready' | 'recreated';
  warnings?: string[];
}

export interface DaemonStandaloneFields {
  sourceType: 'standalone';
  context: { kind: 'standalone' };
  projectlessOutputDirectory: string;
  workingDirectory: DaemonStandaloneWorkingDirectory;
}

export type DaemonStandaloneSession = DaemonSession & DaemonStandaloneFields;

export type DaemonRestoredStandaloneSession = DaemonRestoredSession &
  DaemonStandaloneFields;

export interface DaemonStandaloneSessionSummary extends DaemonSessionSummary {
  sourceType: 'standalone';
  context: { kind: 'standalone' };
}

export interface DaemonStandaloneSessionCreating {
  sessionId: string;
  state: 'creating';
}

export type DaemonStandaloneSessionLookup =
  | DaemonStandaloneSessionSummary
  | DaemonStandaloneSessionCreating;

export interface DaemonStandaloneSessionListOptions {
  pageSize?: number;
  cursor?: string;
  archiveState?: DaemonSessionArchiveState;
}

export interface DaemonStandaloneSessionListPage {
  sessions: DaemonStandaloneSessionSummary[];
  nextCursor?: string;
  liveMergeFailed?: boolean;
  truncated?: boolean;
}

export interface DaemonStandaloneDirectoryResult {
  sessionId: string;
  projectlessOutputDirectory: string;
  workingDirectory: DaemonStandaloneWorkingDirectory;
}

export interface DaemonStandaloneMetadataResult {
  sessionId: string;
  displayName: string;
}

export interface DaemonStandaloneBatchError {
  sessionId: string;
  code: string;
  message: string;
}

export interface DaemonArchiveStandaloneSessionsResult {
  archived: string[];
  alreadyArchived: string[];
  notFound: string[];
  errors: DaemonStandaloneBatchError[];
}

export interface DaemonUnarchiveStandaloneSessionsResult {
  unarchived: string[];
  alreadyActive: string[];
  notFound: string[];
  errors: DaemonStandaloneBatchError[];
}

export interface DaemonDeleteStandaloneSessionsResult {
  removed: string[];
  notFound: string[];
  errors: DaemonStandaloneBatchError[];
  fileCleanupPending: string[];
}

export type DaemonStandaloneCreationRecovery =
  | { state: 'creating'; sessionId: string }
  | { state: 'existing'; session: DaemonStandaloneSessionSummary }
  | { state: 'absent'; sessionId: string }
  | { state: 'unknown'; sessionId: string; error: unknown };

export class DaemonStandaloneProtocolError extends Error {
  constructor(
    readonly route: string,
    detail: string,
  ) {
    super(`${route}: malformed standalone-session response (${detail})`);
    this.name = 'DaemonStandaloneProtocolError';
  }
}

export class DaemonStandaloneCreationOutcomeUnknownError extends Error {
  constructor(
    readonly sessionId: string,
    readonly recovery: DaemonStandaloneCreationRecovery,
    readonly originalError: unknown,
  ) {
    super(
      `Standalone session creation outcome is unknown for ${sessionId}; inspect recovery before retrying.`,
    );
    this.name = 'DaemonStandaloneCreationOutcomeUnknownError';
  }
}

type JsonRecord = Record<string, unknown>;

function asRecord(
  value: unknown,
  route: string,
  field = 'response',
): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DaemonStandaloneProtocolError(route, `expected ${field} object`);
  }
  return value as JsonRecord;
}

function requireString(
  value: JsonRecord,
  field: string,
  route: string,
  allowEmpty = false,
): string {
  const result = value[field];
  if (typeof result !== 'string' || (!allowEmpty && result.length === 0)) {
    throw new DaemonStandaloneProtocolError(route, `expected ${field} string`);
  }
  return result;
}

function requireStringArray(
  value: JsonRecord,
  field: string,
  route: string,
): void {
  const result = value[field];
  if (
    !Array.isArray(result) ||
    !result.every((item) => typeof item === 'string')
  ) {
    throw new DaemonStandaloneProtocolError(route, `expected ${field}[]`);
  }
}

function requireSessionId(
  value: JsonRecord,
  route: string,
  expected?: string,
): string {
  const sessionId = requireString(value, 'sessionId', route);
  if (expected !== undefined && sessionId !== expected) {
    throw new DaemonStandaloneProtocolError(
      route,
      `expected sessionId ${expected}, received ${sessionId}`,
    );
  }
  return sessionId;
}

function validateContext(value: JsonRecord, route: string): void {
  if (asRecord(value['context'], route, 'context')['kind'] !== 'standalone') {
    throw new DaemonStandaloneProtocolError(
      route,
      'expected standalone context',
    );
  }
}

function validateWorkingDirectory(value: unknown, route: string): void {
  const directory = asRecord(value, route, 'workingDirectory');
  if (directory['state'] !== 'ready' && directory['state'] !== 'recreated') {
    throw new DaemonStandaloneProtocolError(
      route,
      'invalid workingDirectory.state',
    );
  }
  if (directory['warnings'] !== undefined) {
    requireStringArray(directory, 'warnings', route);
  }
}

function validateStandaloneFields(value: JsonRecord, route: string): void {
  if (value['sourceType'] !== 'standalone') {
    throw new DaemonStandaloneProtocolError(
      route,
      'expected standalone sourceType',
    );
  }
  validateContext(value, route);
  requireString(value, 'projectlessOutputDirectory', route);
  validateWorkingDirectory(value['workingDirectory'], route);
}

export function parseStandaloneSession(
  value: unknown,
  route: string,
  expectedSessionId?: string,
): DaemonStandaloneSession {
  const session = asRecord(value, route);
  requireSessionId(session, route, expectedSessionId);
  requireString(session, 'workspaceCwd', route);
  if (typeof session['attached'] !== 'boolean') {
    throw new DaemonStandaloneProtocolError(route, 'expected attached boolean');
  }
  validateStandaloneFields(session, route);
  return session as unknown as DaemonStandaloneSession;
}

export function parseRestoredStandaloneSession(
  value: unknown,
  route: string,
  expectedSessionId: string,
): DaemonRestoredStandaloneSession {
  const raw = asRecord(value, route);
  parseStandaloneSession(raw, route, expectedSessionId);
  asRecord(raw['state'], route, 'state');
  return raw as unknown as DaemonRestoredStandaloneSession;
}

export function parseStandaloneSummary(
  value: unknown,
  route: string,
  expectedSessionId?: string,
): DaemonStandaloneSessionSummary {
  const summary = asRecord(value, route);
  requireSessionId(summary, route, expectedSessionId);
  requireString(summary, 'workspaceCwd', route);
  if (summary['sourceType'] !== 'standalone') {
    throw new DaemonStandaloneProtocolError(
      route,
      'expected standalone sourceType',
    );
  }
  validateContext(summary, route);
  return summary as unknown as DaemonStandaloneSessionSummary;
}

export function parseStandaloneLookup(
  value: unknown,
  route: string,
  expectedSessionId: string,
): DaemonStandaloneSessionLookup {
  const lookup = asRecord(value, route);
  if (lookup['state'] === 'creating') {
    const sessionId = requireSessionId(lookup, route, expectedSessionId);
    return { sessionId, state: 'creating' };
  }
  return parseStandaloneSummary(lookup, route, expectedSessionId);
}

export function parseStandaloneListPage(
  value: unknown,
  route: string,
): DaemonStandaloneSessionListPage {
  const page = asRecord(value, route);
  if (!Array.isArray(page['sessions'])) {
    throw new DaemonStandaloneProtocolError(route, 'expected sessions[]');
  }
  if (
    page['nextCursor'] !== undefined &&
    typeof page['nextCursor'] !== 'string'
  ) {
    throw new DaemonStandaloneProtocolError(
      route,
      'expected nextCursor string',
    );
  }
  for (const field of ['liveMergeFailed', 'truncated']) {
    if (page[field] !== undefined && typeof page[field] !== 'boolean') {
      throw new DaemonStandaloneProtocolError(
        route,
        `expected ${field} boolean`,
      );
    }
  }
  for (const session of page['sessions'])
    parseStandaloneSummary(session, route);
  return page as unknown as DaemonStandaloneSessionListPage;
}

export function parseStandaloneDirectoryResult(
  value: unknown,
  route: string,
  expectedSessionId: string,
): DaemonStandaloneDirectoryResult {
  const result = asRecord(value, route);
  requireSessionId(result, route, expectedSessionId);
  requireString(result, 'projectlessOutputDirectory', route);
  validateWorkingDirectory(result['workingDirectory'], route);
  return result as unknown as DaemonStandaloneDirectoryResult;
}

export function parseStandaloneMetadataResult(
  value: unknown,
  route: string,
  expectedSessionId: string,
): DaemonStandaloneMetadataResult {
  const result = asRecord(value, route);
  requireSessionId(result, route, expectedSessionId);
  requireString(result, 'displayName', route, true);
  return result as unknown as DaemonStandaloneMetadataResult;
}

function validateBatch(
  value: unknown,
  route: string,
  fields: string[],
): JsonRecord {
  const result = asRecord(value, route);
  for (const field of fields) requireStringArray(result, field, route);
  if (!Array.isArray(result['errors'])) {
    throw new DaemonStandaloneProtocolError(route, 'expected errors[]');
  }
  for (const item of result['errors']) {
    const error = asRecord(item, route, 'batch error');
    for (const field of ['sessionId', 'code', 'message']) {
      requireString(error, field, route);
    }
  }
  return result;
}

export function parseArchiveStandaloneSessionsResult(
  value: unknown,
  route: string,
): DaemonArchiveStandaloneSessionsResult {
  return validateBatch(value, route, [
    'archived',
    'alreadyArchived',
    'notFound',
  ]) as unknown as DaemonArchiveStandaloneSessionsResult;
}

export function parseUnarchiveStandaloneSessionsResult(
  value: unknown,
  route: string,
): DaemonUnarchiveStandaloneSessionsResult {
  return validateBatch(value, route, [
    'unarchived',
    'alreadyActive',
    'notFound',
  ]) as unknown as DaemonUnarchiveStandaloneSessionsResult;
}

export function parseDeleteStandaloneSessionsResult(
  value: unknown,
  route: string,
): DaemonDeleteStandaloneSessionsResult {
  return validateBatch(value, route, [
    'removed',
    'notFound',
    'fileCleanupPending',
  ]) as unknown as DaemonDeleteStandaloneSessionsResult;
}

export function isStandaloneSessionNotFoundError(error: unknown): boolean {
  return (
    error instanceof DaemonHttpError &&
    error.status === 404 &&
    recordCode(error.body) === 'standalone_session_not_found'
  );
}

export function isStandaloneCreationOutcomeUnknown(error: unknown): boolean {
  return (
    error instanceof DaemonStandaloneCreationOutcomeUnknownError ||
    (error instanceof DaemonHttpError &&
      recordCode(error.body) === 'standalone_creation_outcome_unknown')
  );
}

function recordCode(value: unknown): unknown {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)['code']
    : undefined;
}
