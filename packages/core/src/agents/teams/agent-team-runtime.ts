/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isSameBusiness,
  type BusinessInfo,
} from '../../qoder/business-info.js';
import { existsSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { lock } from 'proper-lockfile';
import { getConfigHomeDir } from '../../utils/paths.js';
import { isNodeError } from '../../utils/errors.js';
import { runLogger } from '../../utils/runLogger.js';
import { AGENT_COLORS, type AgentColor } from '../types.js';

export const TEAM_LEAD_MEMBER_NAME = 'team-lead';

export type TeamMemberStatus = 'running' | 'idle' | 'stopped';

export interface AgentTeamMember {
  name: string;
  agentId: string;
  taskId?: string;
  agentType: string;
  /** Teammate 首次启动时解析出的模型。 */
  resolvedModel?: string;
  sessionId: string;
  status: TeamMemberStatus;
  color?: AgentColor;
  description?: string;
  prompt?: string;
  cwd?: string;
  worktreePath?: string;
  joinedAt: string;
  updatedAt: string;
  idleSince?: string;
}

export interface AgentTeamConfig {
  name: string;
  leadSessionId: string;
  createdAt: string;
  updatedAt: string;
  members: AgentTeamMember[];
}

export interface TeamMailboxMessage {
  businessInfo?: Readonly<BusinessInfo>;
  customContext?: Readonly<Record<string, string>>;
  id: string;
  from: string;
  to: string;
  text: string;
  summary?: string;
  timestamp: string;
  read: boolean;
  color?: AgentColor;
}

export type AgentTeamReservationFailureStage =
  | 'lock_prepare'
  | 'lock_acquire'
  | 'roster_read'
  | 'roster_validate'
  | 'roster_write'
  | 'reservation_invariant'
  | 'lock_release';

export type AgentTeamReservationErrorCode =
  | 'roster_lock_prepare_failed'
  | 'roster_lock_timeout'
  | 'roster_lock_acquire_failed'
  | 'team_not_found'
  | 'roster_parse_failed'
  | 'roster_read_failed'
  | 'roster_schema_invalid'
  | 'lead_session_mismatch'
  | 'invalid_member_name'
  | 'reserved_member_name'
  | 'roster_write_failed'
  | 'reservation_invariant_failed'
  | 'roster_lock_release_failed';

export type AgentTeamReservationCommitState =
  | 'not_written'
  | 'unknown'
  | 'written';

const SAFE_FILESYSTEM_ERROR_CODES = new Set([
  'EACCES',
  'EBUSY',
  'EDQUOT',
  'EEXIST',
  'EIO',
  'EISDIR',
  'ELOCKED',
  'EMFILE',
  'ENFILE',
  'ENOENT',
  'ENOSPC',
  'ENOTDIR',
  'EPERM',
  'EROFS',
]);

function getSafeFilesystemErrorCode(error: unknown): string | undefined {
  if (
    !isNodeError(error) ||
    typeof error.code !== 'string' ||
    !SAFE_FILESYSTEM_ERROR_CODES.has(error.code)
  ) {
    return undefined;
  }
  return error.code;
}

/**
 * Provides stable, content-free fields for roster reservation errors.
 * The user-facing message and cause remain local and must not be reported.
 */
export class AgentTeamReservationError extends Error {
  readonly stage: AgentTeamReservationFailureStage;
  readonly code: AgentTeamReservationErrorCode;
  readonly commitState: AgentTeamReservationCommitState;
  readonly filesystemErrorCode?: string;
  readonly #reservedAgentId?: string;

  constructor(params: {
    message: string;
    stage: AgentTeamReservationFailureStage;
    code: AgentTeamReservationErrorCode;
    commitState: AgentTeamReservationCommitState;
    cause?: unknown;
    reservedAgentId?: string;
  }) {
    super(params.message, { cause: params.cause });
    this.name = 'AgentTeamReservationError';
    this.stage = params.stage;
    this.code = params.code;
    this.commitState = params.commitState;
    this.filesystemErrorCode = getSafeFilesystemErrorCode(params.cause);
    this.#reservedAgentId = params.reservedAgentId;
  }

  getReservedAgentIdForRollback(): string | undefined {
    return this.#reservedAgentId;
  }
}

const LOCK_OPTIONS = {
  retries: {
    retries: 30,
    minTimeout: 5,
    maxTimeout: 100,
  },
  realpath: false,
};

function nowIso(): string {
  return new Date().toISOString();
}

export function sanitizeTeamPathComponent(value: string): string {
  const encoded = Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  return `v-${encoded}`;
}

export function getAgentTeamsDir(): string {
  return path.join(getConfigHomeDir(), 'teams');
}

export function getAgentTeamDir(teamName: string): string {
  return path.join(getAgentTeamsDir(), sanitizeTeamPathComponent(teamName));
}

export function getAgentTeamConfigPath(teamName: string): string {
  return path.join(getAgentTeamDir(teamName), 'config.json');
}

function getTeamLockPath(teamName: string): string {
  return path.join(getAgentTeamDir(teamName), '.lock');
}

function getTeamInboxDir(teamName: string): string {
  return path.join(getAgentTeamDir(teamName), 'inboxes');
}

function getTeamInboxPath(teamName: string, memberName: string): string {
  return path.join(
    getTeamInboxDir(teamName),
    `${sanitizeTeamPathComponent(memberName)}.json`,
  );
}

async function ensureLockFile(lockPath: string): Promise<void> {
  await mkdir(path.dirname(lockPath), { recursive: true });
  if (!existsSync(lockPath)) {
    try {
      await writeFile(lockPath, '', { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') {
        throw error;
      }
    }
  }
}

async function withFileLock<T>(
  lockPath: string,
  action: () => Promise<T>,
): Promise<T> {
  await ensureLockFile(lockPath);
  const release = await lock(lockPath, LOCK_OPTIONS);
  try {
    return await action();
  } finally {
    await release();
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function upsertMember(
  config: AgentTeamConfig,
  member: Omit<AgentTeamMember, 'joinedAt' | 'updatedAt'>,
): AgentTeamConfig {
  const timestamp = nowIso();
  const index = config.members.findIndex(
    (entry) => entry.name.toLowerCase() === member.name.toLowerCase(),
  );
  const nextMember: AgentTeamMember =
    index >= 0
      ? {
          ...config.members[index],
          ...member,
          updatedAt: timestamp,
        }
      : {
          ...member,
          joinedAt: timestamp,
          updatedAt: timestamp,
        };
  if (nextMember.status !== 'idle') {
    delete nextMember.idleSince;
  }
  const members = [...config.members];
  if (index >= 0) {
    members[index] = nextMember;
  } else {
    members.push(nextMember);
  }
  return {
    ...config,
    members,
    updatedAt: timestamp,
  };
}

function hasValidReservationRosterShape(
  value: AgentTeamConfig,
): boolean {
  return (
    typeof value.leadSessionId === 'string' &&
    Array.isArray(value.members) &&
    value.members.every(
      (member) =>
        typeof member === 'object' &&
        member !== null &&
        typeof member.name === 'string' &&
        typeof member.agentId === 'string',
    )
  );
}

export async function ensureAgentTeam(params: {
  teamName: string;
  leadSessionId: string;
}): Promise<AgentTeamConfig> {
  return withFileLock(getTeamLockPath(params.teamName), async () => {
    const configPath = getAgentTeamConfigPath(params.teamName);
    const existing = await readJsonFile<AgentTeamConfig>(configPath);
    const timestamp = nowIso();
    const base: AgentTeamConfig =
      existing ?? {
        name: params.teamName,
        leadSessionId: params.leadSessionId,
        createdAt: timestamp,
        updatedAt: timestamp,
        members: [],
      };
    const next = upsertMember(base, {
      name: TEAM_LEAD_MEMBER_NAME,
      agentId: params.leadSessionId,
      agentType: 'team-lead',
      sessionId: params.leadSessionId,
      status: 'running',
    });
    await writeJsonFile(configPath, next);
    return next;
  });
}

export async function readAgentTeamConfig(
  teamName: string,
): Promise<AgentTeamConfig | null> {
  return readJsonFile<AgentTeamConfig>(getAgentTeamConfigPath(teamName));
}

export async function upsertAgentTeamMember(params: {
  teamName: string;
  leadSessionId: string;
  member: Omit<AgentTeamMember, 'joinedAt' | 'updatedAt'>;
}): Promise<AgentTeamConfig> {
  return withFileLock(getTeamLockPath(params.teamName), async () => {
    const timestamp = nowIso();
    const current =
      (await readJsonFile<AgentTeamConfig>(
        getAgentTeamConfigPath(params.teamName),
      )) ??
      {
        name: params.teamName,
        leadSessionId: params.leadSessionId,
        createdAt: timestamp,
        updatedAt: timestamp,
        members: [
          {
            name: TEAM_LEAD_MEMBER_NAME,
            agentId: params.leadSessionId,
            agentType: 'team-lead',
            sessionId: params.leadSessionId,
            status: 'running',
            joinedAt: timestamp,
            updatedAt: timestamp,
          },
        ],
      };
    const next = upsertMember(current, params.member);
    await writeJsonFile(getAgentTeamConfigPath(params.teamName), next);
    return next;
  });
}

export async function reserveAgentTeamMember(params: {
  teamName: string;
  leadSessionId: string;
  member: Omit<
    AgentTeamMember,
    'agentId' | 'joinedAt' | 'updatedAt' | 'color'
  > & { agentId?: string };
}): Promise<{ config: AgentTeamConfig; member: AgentTeamMember }> {
  const lockPath = getTeamLockPath(params.teamName);
  try {
    await ensureLockFile(lockPath);
  } catch (error) {
    throw new AgentTeamReservationError({
      message: 'Failed to prepare the Agent Team roster lock.',
      stage: 'lock_prepare',
      code: 'roster_lock_prepare_failed',
      commitState: 'not_written',
      cause: error,
    });
  }

  let release: () => Promise<void>;
  try {
    release = await lock(lockPath, LOCK_OPTIONS);
  } catch (error) {
    throw new AgentTeamReservationError({
      message: 'Failed to acquire the Agent Team roster lock.',
      stage: 'lock_acquire',
      code:
        getSafeFilesystemErrorCode(error) === 'ELOCKED'
          ? 'roster_lock_timeout'
          : 'roster_lock_acquire_failed',
      commitState: 'not_written',
      cause: error,
    });
  }

  let result: { config: AgentTeamConfig; member: AgentTeamMember } | undefined;
  let reservationError: unknown;
  let generatedAgentId: string | undefined;
  let rosterWritten = false;
  try {
    const configPath = getAgentTeamConfigPath(params.teamName);
    let current: AgentTeamConfig | null;
    try {
      current = await readJsonFile<AgentTeamConfig>(configPath);
    } catch (error) {
      throw new AgentTeamReservationError({
        message:
          error instanceof SyntaxError
            ? 'The Agent Team roster contains invalid JSON.'
            : 'Failed to read the Agent Team roster.',
        stage: 'roster_read',
        code:
          error instanceof SyntaxError
            ? 'roster_parse_failed'
            : 'roster_read_failed',
        commitState: 'not_written',
        cause: error,
      });
    }
    if (!current) {
      throw new AgentTeamReservationError({
        message: `Agent Team "${params.teamName}" is not initialized for session "${params.leadSessionId}".`,
        stage: 'roster_read',
        code: 'team_not_found',
        commitState: 'not_written',
      });
    }
    if (!hasValidReservationRosterShape(current)) {
      throw new AgentTeamReservationError({
        message: 'The Agent Team roster has an invalid structure.',
        stage: 'roster_validate',
        code: 'roster_schema_invalid',
        commitState: 'not_written',
      });
    }
    if (current.leadSessionId !== params.leadSessionId) {
      throw new AgentTeamReservationError({
        message: `Agent Team "${params.teamName}" belongs to a different session.`,
        stage: 'roster_validate',
        code: 'lead_session_mismatch',
        commitState: 'not_written',
      });
    }
    if (/\p{Cc}/u.test(params.member.name)) {
      throw new AgentTeamReservationError({
        message:
          'Invalid name: control characters are not allowed in agent names.',
        stage: 'roster_validate',
        code: 'invalid_member_name',
        commitState: 'not_written',
      });
    }
    const normalizedName = params.member.name.replaceAll('@', '-');
    if (normalizedName === 'main') {
      throw new AgentTeamReservationError({
        message:
          '"main" is a reserved recipient name because SendMessage routes it to the main conversation.',
        stage: 'roster_validate',
        code: 'reserved_member_name',
        commitState: 'not_written',
      });
    }
    const existingNames = new Set(
      current.members.map((member) => member.name.toLowerCase()),
    );
    let assignedName = normalizedName;
    if (existingNames.has(assignedName.toLowerCase())) {
      let suffix = 2;
      while (existingNames.has(`${normalizedName}-${suffix}`.toLowerCase())) {
        suffix++;
      }
      assignedName = `${normalizedName}-${suffix}`;
    }

    const assignedCount = current.members.filter(
      (member) => member.name !== TEAM_LEAD_MEMBER_NAME,
    ).length;
    const color = AGENT_COLORS[assignedCount % AGENT_COLORS.length];
    const agentId =
      params.member.agentId ?? `${assignedName}@${params.teamName}`;
    generatedAgentId = agentId;
    const next = upsertMember(current, {
      ...params.member,
      name: assignedName,
      agentId,
      color,
    });
    try {
      await writeJsonFile(configPath, next);
    } catch (error) {
      throw new AgentTeamReservationError({
        message: 'Failed to write the Agent Team roster.',
        stage: 'roster_write',
        code: 'roster_write_failed',
        commitState: 'unknown',
        cause: error,
        reservedAgentId: agentId,
      });
    }
    rosterWritten = true;
    const reserved = next.members.find((member) => member.agentId === agentId);
    if (!reserved) {
      throw new AgentTeamReservationError({
        message: `Failed to reserve teammate "${assignedName}" in team "${params.teamName}".`,
        stage: 'reservation_invariant',
        code: 'reservation_invariant_failed',
        commitState: 'written',
        reservedAgentId: agentId,
      });
    }
    result = { config: next, member: reserved };
  } catch (error) {
    reservationError =
      error instanceof AgentTeamReservationError
        ? error
        : new AgentTeamReservationError({
            message: 'The Agent Team reservation failed unexpectedly.',
            stage: 'reservation_invariant',
            code: 'reservation_invariant_failed',
            commitState: rosterWritten ? 'written' : 'not_written',
            cause: error,
            reservedAgentId: rosterWritten ? generatedAgentId : undefined,
          });
  }

  try {
    await release();
  } catch (error) {
    if (reservationError !== undefined) {
      runLogger.warn(
        '[AgentTeamRuntime] Failed to release the roster lock after a reservation error:',
        error,
      );
    } else {
      throw new AgentTeamReservationError({
        message: 'Failed to release the Agent Team roster lock.',
        stage: 'lock_release',
        code: 'roster_lock_release_failed',
        commitState: 'written',
        cause: error,
        reservedAgentId: result?.member.agentId,
      });
    }
  }

  if (reservationError !== undefined) {
    throw reservationError;
  }
  if (!result) {
    throw new AgentTeamReservationError({
      message: 'The Agent Team reservation completed without a result.',
      stage: 'reservation_invariant',
      code: 'reservation_invariant_failed',
      commitState: 'unknown',
    });
  }
  return result;
}

export async function updateAgentTeamMemberStatus(params: {
  teamName: string;
  memberName: string;
  status: TeamMemberStatus;
}): Promise<AgentTeamConfig | null> {
  return withFileLock(getTeamLockPath(params.teamName), async () => {
    const current = await readAgentTeamConfig(params.teamName);
    if (!current) return null;
    const timestamp = nowIso();
    const members = current.members.map((member) =>
      member.name === params.memberName
        ? {
            ...member,
            status: params.status,
            updatedAt: timestamp,
            idleSince: params.status === 'idle' ? timestamp : undefined,
          }
        : member,
    );
    const next = { ...current, members, updatedAt: timestamp };
    await writeJsonFile(getAgentTeamConfigPath(params.teamName), next);
    return next;
  });
}

export async function removeAgentTeamMember(params: {
  teamName: string;
  agentId?: string;
  memberName?: string;
}): Promise<boolean> {
  if (!params.agentId && !params.memberName) {
    throw new Error('agentId or memberName is required to remove a teammate.');
  }
  return withFileLock(getTeamLockPath(params.teamName), async () => {
    const configPath = getAgentTeamConfigPath(params.teamName);
    const current = await readJsonFile<AgentTeamConfig>(configPath);
    if (!current) return false;
    const members = current.members.filter((member) => {
      if (params.agentId && member.agentId === params.agentId) return false;
      if (params.memberName && member.name === params.memberName) return false;
      return true;
    });
    if (members.length === current.members.length) return false;
    await writeJsonFile(configPath, {
      ...current,
      members,
      updatedAt: nowIso(),
    });
    return true;
  });
}

export async function claimAgentTeamMemberWake(params: {
  teamName: string;
  memberName: string;
  allowStaleRunning?: boolean;
}): Promise<
  | { claimed: true; member: AgentTeamMember }
  | {
      claimed: false;
      reason: 'team_not_found' | 'member_not_found' | 'already_running';
      member?: AgentTeamMember;
    }
> {
  return withFileLock(getTeamLockPath(params.teamName), async () => {
    const configPath = getAgentTeamConfigPath(params.teamName);
    const existing = await readJsonFile<AgentTeamConfig>(configPath);
    if (!existing) {
      return { claimed: false, reason: 'team_not_found' };
    }
    const memberIndex = existing.members.findIndex(
      (member) => member.name === params.memberName,
    );
    if (memberIndex < 0) {
      return { claimed: false, reason: 'member_not_found' };
    }

    const member = existing.members[memberIndex];
    if (member.status === 'stopped') {
      return { claimed: false, reason: 'member_not_found' };
    }
    if (member.status === 'running' && !params.allowStaleRunning) {
      return { claimed: false, reason: 'already_running', member };
    }

    const timestamp = nowIso();
    const nextMember: AgentTeamMember = {
      ...member,
      status: 'running',
      updatedAt: timestamp,
      idleSince: undefined,
    };
    const members = [...existing.members];
    members[memberIndex] = nextMember;
    await writeJsonFile(configPath, {
      ...existing,
      members,
      updatedAt: timestamp,
    });
    return { claimed: true, member: nextMember };
  });
}

export async function removeAgentTeam(teamName: string): Promise<void> {
  await rm(getAgentTeamDir(teamName), { recursive: true, force: true });
}

function isSameCustomContext(
  a: Readonly<Record<string, string>> | undefined,
  b: Readonly<Record<string, string>> | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => a[key] === b[key])
  );
}

export async function sendTeamMessage(params: {
  businessInfo?: Readonly<BusinessInfo>;
  customContext?: Readonly<Record<string, string>>;
  teamName: string;
  from: string;
  to: string;
  text: string;
  summary?: string;
  color?: AgentColor;
}): Promise<TeamMailboxMessage> {
  const inboxPath = getTeamInboxPath(params.teamName, params.to);
  return withFileLock(`${inboxPath}.lock`, async () => {
    const current =
      (await readJsonFile<TeamMailboxMessage[]>(inboxPath)) ?? [];
    const message: TeamMailboxMessage = {
      id: randomUUID(),
      businessInfo: params.businessInfo
        ? { ...params.businessInfo }
        : undefined,
      customContext: params.customContext
        ? { ...params.customContext }
        : undefined,
      from: params.from,
      to: params.to,
      text: params.text,
      summary: params.summary,
      timestamp: nowIso(),
      read: false,
      color: params.color,
    };
    await writeJsonFile(inboxPath, [...current, message]);
    return message;
  });
}

export async function readTeamInbox(params: {
  teamName: string;
  memberName: string;
  unreadOnly?: boolean;
  markRead?: boolean;
  oneBusinessBatch?: boolean;
}): Promise<TeamMailboxMessage[]> {
  const inboxPath = getTeamInboxPath(params.teamName, params.memberName);
  return withFileLock(`${inboxPath}.lock`, async () => {
    const current =
      (await readJsonFile<TeamMailboxMessage[]>(inboxPath)) ?? [];
    const available = params.unreadOnly
      ? current.filter((message) => !message.read)
      : current;
    const selected = params.oneBusinessBatch
      ? available.filter(
          (message) =>
            isSameBusiness(message.businessInfo, available[0]?.businessInfo) &&
            isSameCustomContext(
              message.customContext,
              available[0]?.customContext,
            ),
        )
      : available;
    if (params.markRead && current.length > 0) {
      const selectedIds = new Set(selected.map((message) => message.id));
      await writeJsonFile(
        inboxPath,
        current.filter(
          (message) => !message.read && !selectedIds.has(message.id),
        ),
      );
    }
    return selected;
  });
}

export async function markTeamMessageRead(params: {
  teamName: string;
  memberName: string;
  messageId: string;
}): Promise<void> {
  const inboxPath = getTeamInboxPath(params.teamName, params.memberName);
  await withFileLock(`${inboxPath}.lock`, async () => {
    const current =
      (await readJsonFile<TeamMailboxMessage[]>(inboxPath)) ?? [];
    const remaining = current.filter(
      (message) => !message.read && message.id !== params.messageId,
    );
    if (remaining.length === current.length) return;
    await writeJsonFile(inboxPath, remaining);
  });
}
