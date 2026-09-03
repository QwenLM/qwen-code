/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { DaemonHttpError } from './DaemonHttpError.js';
import { DAEMON_APPROVAL_MODES, DAEMON_ERROR_KINDS } from './types.js';
import type {
  DaemonApprovalMode,
  DaemonRestoredSession,
  DaemonSession,
  DaemonSessionArchiveState,
  DaemonSessionSummary,
  DaemonWorkspaceProvidersStatus,
} from './types.js';

export const STANDALONE_SESSIONS_CAPABILITY = 'standalone_sessions_v1';
export const STANDALONE_SESSION_OPTIONS_CAPABILITY =
  'standalone_session_options_v1';

export type DaemonStandaloneSessionOptions = Omit<
  DaemonWorkspaceProvidersStatus,
  'workspaceCwd' | 'acpChannelLive'
>;

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

function validateOptionalString(
  value: JsonRecord,
  field: string,
  route: string,
): void {
  if (value[field] !== undefined && typeof value[field] !== 'string') {
    throw new DaemonStandaloneProtocolError(route, `expected ${field} string`);
  }
}

function validateStatusCell(value: JsonRecord, route: string): void {
  requireString(value, 'kind', route);
  if (
    !['ok', 'warning', 'error', 'disabled', 'not_started', 'unknown'].includes(
      String(value['status']),
    )
  ) {
    throw new DaemonStandaloneProtocolError(route, 'invalid status');
  }
  for (const field of ['error', 'hint']) {
    validateOptionalString(value, field, route);
  }
  if (
    value['errorKind'] !== undefined &&
    !DAEMON_ERROR_KINDS.includes(
      value['errorKind'] as (typeof DAEMON_ERROR_KINDS)[number],
    )
  ) {
    throw new DaemonStandaloneProtocolError(route, 'invalid errorKind');
  }
}

function validateProviderModel(value: unknown, route: string): void {
  const model = asRecord(value, route, 'provider model');
  requireString(model, 'modelId', route);
  requireString(model, 'baseModelId', route);
  requireString(model, 'name', route, true);
  if (
    model['description'] !== undefined &&
    model['description'] !== null &&
    typeof model['description'] !== 'string'
  ) {
    throw new DaemonStandaloneProtocolError(route, 'invalid description');
  }
  if (
    model['contextLimit'] !== undefined &&
    (typeof model['contextLimit'] !== 'number' ||
      !Number.isFinite(model['contextLimit']) ||
      model['contextLimit'] <= 0)
  ) {
    throw new DaemonStandaloneProtocolError(route, 'invalid contextLimit');
  }
  for (const field of ['baseUrl', 'envKey']) {
    validateOptionalString(model, field, route);
  }
  for (const field of ['isCurrent', 'isRuntime']) {
    if (typeof model[field] !== 'boolean') {
      throw new DaemonStandaloneProtocolError(
        route,
        `expected ${field} boolean`,
      );
    }
  }
  if (model['modalities'] !== undefined) {
    const modalities = asRecord(model['modalities'], route, 'modalities');
    for (const field of ['image', 'pdf', 'audio', 'video']) {
      if (
        modalities[field] !== undefined &&
        typeof modalities[field] !== 'boolean'
      ) {
        throw new DaemonStandaloneProtocolError(
          route,
          `expected modalities.${field} boolean`,
        );
      }
    }
  }
  if (
    model['configOptions'] !== undefined &&
    !Array.isArray(model['configOptions'])
  ) {
    throw new DaemonStandaloneProtocolError(route, 'expected configOptions[]');
  }
}

export function parseStandaloneSessionOptions(
  value: unknown,
  route: string,
): DaemonStandaloneSessionOptions {
  const options = asRecord(value, route);
  if (
    options['workspaceCwd'] !== undefined ||
    options['acpChannelLive'] !== undefined
  ) {
    throw new DaemonStandaloneProtocolError(
      route,
      'standalone options exposed workspace internals',
    );
  }
  if (options['v'] !== 1) {
    throw new DaemonStandaloneProtocolError(route, 'expected v=1');
  }
  if (typeof options['initialized'] !== 'boolean') {
    throw new DaemonStandaloneProtocolError(
      route,
      'expected initialized boolean',
    );
  }
  if (options['current'] !== undefined) {
    const current = asRecord(options['current'], route, 'current');
    for (const field of [
      'authType',
      'modelId',
      'baseUrl',
      'fastModelId',
      'visionModelId',
    ]) {
      validateOptionalString(current, field, route);
    }
  }
  if (
    options['approvalMode'] !== undefined &&
    !DAEMON_APPROVAL_MODES.includes(
      options['approvalMode'] as DaemonApprovalMode,
    )
  ) {
    throw new DaemonStandaloneProtocolError(route, 'invalid approvalMode');
  }
  if (!Array.isArray(options['providers'])) {
    throw new DaemonStandaloneProtocolError(route, 'expected providers[]');
  }
  for (const value of options['providers']) {
    const provider = asRecord(value, route, 'provider');
    validateStatusCell(provider, route);
    if (provider['kind'] !== 'model_provider') {
      throw new DaemonStandaloneProtocolError(
        route,
        'expected model_provider kind',
      );
    }
    requireString(provider, 'authType', route);
    if (typeof provider['current'] !== 'boolean') {
      throw new DaemonStandaloneProtocolError(
        route,
        'expected provider current boolean',
      );
    }
    if (!Array.isArray(provider['models'])) {
      throw new DaemonStandaloneProtocolError(route, 'expected models[]');
    }
    for (const model of provider['models']) {
      validateProviderModel(model, route);
    }
  }
  if (options['errors'] !== undefined) {
    if (!Array.isArray(options['errors'])) {
      throw new DaemonStandaloneProtocolError(route, 'expected errors[]');
    }
    for (const value of options['errors']) {
      validateStatusCell(asRecord(value, route, 'error'), route);
    }
  }
  return options as unknown as DaemonStandaloneSessionOptions;
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
  if (
    session['modelApplied'] !== undefined &&
    typeof session['modelApplied'] !== 'boolean'
  ) {
    throw new DaemonStandaloneProtocolError(
      route,
      'expected modelApplied boolean',
    );
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
