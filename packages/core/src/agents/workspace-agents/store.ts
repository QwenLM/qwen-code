/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Mutex } from 'async-mutex';
import lockfile from 'proper-lockfile';

import { Storage } from '../../config/storage.js';
import { atomicWriteJSON } from '../../utils/atomicFileWrite.js';
import { createDebugLogger } from '../../utils/debugLogger.js';
import { isNodeError } from '../../utils/errors.js';
import { getProjectHash } from '../../utils/paths.js';
import {
  AGENT_HOSTS_SCHEMA_VERSION,
  AGENT_HOST_REPLACEMENT_REQUIRED,
  AGENTS_SCHEMA_VERSION,
  type AgentHost,
  type AgentHostView,
  type AgentHostsFile,
  type WorkspaceAgent,
  type WorkspaceAgentsFile,
  type AgentWorkspaceState,
  type A2AGrant,
  hostOffersProgram,
  isAgentProgram,
} from './types.js';
import type { HostProgramProbe } from '../session-agents/contract.js';

const debug = createDebugLogger('WORKSPACE_AGENTS_STORE');

const AGENTS_DIRNAME = 'agent-host';
const WORKSPACE_FILENAME = 'workspace.json';
const AGENTS_FILENAME = 'agents.json';
const HOSTS_FILENAME = 'hosts.json';
const HOST_ENROLLMENT_TTL_MS = 15 * 60 * 1_000;

const LOCK_OPTIONS: lockfile.LockOptions = {
  realpath: false,
  retries: {
    retries: 10,
    minTimeout: 5,
    maxTimeout: 100,
    factor: 2,
    randomize: true,
  },
  stale: 10_000,
  // A daemon and a crashed or suspended holder can meet on the same workspace;
  // without a handler the compromise throws from proper-lockfile's timer as
  // an uncaught exception.
  onCompromised: (err) => debug.warn('workspace lock compromised:', err),
};

// The roster holds persona prompts and the session-agents files hold chat
// excerpts.
// Without an explicit mode a new file lands at 0666 & ~umask (0644 on most
// hosts), readable by any local account; forceMode also heals files written
// before this was set. Directories get 0700 so the files are not traversable
// either. Exported for the session-agents binding store, which keeps its
// files under the same directory with the same modes.
export const STORE_FILE_OPTIONS = {
  noFollow: true,
  mode: 0o600,
  forceMode: true,
} as const;
export const STORE_DIR_MODE = 0o700;

const workspaceMutexes = new Map<string, Mutex>();
const workspaceTransaction = new AsyncLocalStorage<boolean>();

export class AgentSchemaVersionError extends Error {
  constructor(
    readonly filePath: string,
    readonly foundVersion: unknown,
  ) {
    super(
      `Unsupported agent schema version ${JSON.stringify(foundVersion)} in ${filePath}; this build supports version ${AGENTS_SCHEMA_VERSION}.`,
    );
    this.name = 'AgentSchemaVersionError';
  }
}

export function getAgentsDir(projectRoot: string): string {
  return path.join(
    Storage.getGlobalTempDir(),
    getProjectHash(projectRoot),
    AGENTS_DIRNAME,
  );
}

export function getWorkspaceFilePath(projectRoot: string): string {
  return path.join(getAgentsDir(projectRoot), WORKSPACE_FILENAME);
}

export function getAgentsFilePath(projectRoot: string): string {
  return path.join(getAgentsDir(projectRoot), AGENTS_FILENAME);
}

export function getAgentHostsFilePath(projectRoot: string): string {
  return path.join(getAgentsDir(projectRoot), HOSTS_FILENAME);
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function generateAgentId(): string {
  return `ag_${randomUUID()}`;
}

function generateAgentHostId(): string {
  return `host_${randomUUID()}`;
}

export function isValidId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export const AGENT_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,47}$/u;

export function isValidAgentName(value: unknown): value is string {
  return typeof value === 'string' && AGENT_NAME_PATTERN.test(value);
}

function isValidAgent(value: unknown): value is WorkspaceAgent {
  if (!isRecord(value)) return false;
  const execution = value['execution'];
  const validExecution =
    execution === undefined ||
    (isRecord(execution) &&
      ((execution['mode'] === 'local' &&
        (execution['provider'] === undefined ||
          isAgentProgram(execution['provider']))) ||
        (execution['mode'] === 'managed-host' &&
          Array.isArray(execution['hostIds']) &&
          execution['hostIds'].length > 0 &&
          execution['hostIds'].every(isValidId) &&
          new Set(execution['hostIds']).size === execution['hostIds'].length &&
          (execution['provider'] === undefined ||
            isAgentProgram(execution['provider'])))));
  return (
    isValidId(value['id']) &&
    isValidAgentName(value['name']) &&
    isFiniteTimestamp(value['createdAt']) &&
    (value['description'] === undefined ||
      typeof value['description'] === 'string') &&
    (value['color'] === undefined ||
      (typeof value['color'] === 'string' && HEX_COLOR.test(value['color']))) &&
    (value['agentType'] === undefined ||
      isNonEmptyString(value['agentType'])) &&
    (value['model'] === undefined || isNonEmptyString(value['model'])) &&
    // An empty string is not absent: it would append a blank paragraph to the
    // persona and read as an instruction that was meant to say something.
    (value['instructions'] === undefined ||
      isNonEmptyString(value['instructions'])) &&
    (value['enabled'] === undefined || typeof value['enabled'] === 'boolean') &&
    (value['retiredAt'] === undefined ||
      isFiniteTimestamp(value['retiredAt'])) &&
    (value['maxConcurrentRuns'] === undefined ||
      isPositiveInteger(value['maxConcurrentRuns'])) &&
    validExecution
  );
}

function isValidA2AGrant(value: unknown): value is A2AGrant {
  return (
    isRecord(value) &&
    isNonEmptyString(value['callerId']) &&
    isValidId(value['agentId']) &&
    isNonEmptyString(value['secretHash']) &&
    isFiniteTimestamp(value['createdAt']) &&
    (value['expiresAt'] === undefined || isFiniteTimestamp(value['expiresAt']))
  );
}

function isValidWorkspace(value: unknown): value is AgentWorkspaceState {
  return (
    isRecord(value) &&
    value['schemaVersion'] === AGENTS_SCHEMA_VERSION &&
    isValidId(value['workspaceId']) &&
    // A malformed grant list fails the whole record rather than being dropped.
    // Dropping it would silently revoke every external caller — or, if the
    // malformed entry were the one being read past, silently admit one.
    (value['callerGrants'] === undefined ||
      (Array.isArray(value['callerGrants']) &&
        value['callerGrants'].every(isValidA2AGrant)))
  );
}

function isValidAgentHost(value: unknown): value is AgentHost {
  return (
    isRecord(value) &&
    isValidId(value['id']) &&
    isNonEmptyString(value['name']) &&
    isNonEmptyString(value['secretHash']) &&
    isNonEmptyString(value['workspaceCwd']) &&
    Array.isArray(value['providers']) &&
    value['providers'].every(isNonEmptyString) &&
    isFiniteTimestamp(value['createdAt']) &&
    (value['lastSeenAt'] === undefined ||
      isFiniteTimestamp(value['lastSeenAt'])) &&
    (value['protocol'] === undefined || isPositiveInteger(value['protocol'])) &&
    (value['programs'] === undefined ||
      (Array.isArray(value['programs']) &&
        value['programs'].every(isValidHostProgramProbe)))
  );
}

const MAX_PROGRAM_PROBE_TEXT = 200;

function isValidHostProgramProbe(value: unknown): value is HostProgramProbe {
  return (
    isRecord(value) &&
    isAgentProgram(value['program']) &&
    typeof value['available'] === 'boolean' &&
    (value['version'] === undefined ||
      (typeof value['version'] === 'string' &&
        value['version'].length <= MAX_PROGRAM_PROBE_TEXT)) &&
    (value['reason'] === undefined ||
      (typeof value['reason'] === 'string' &&
        value['reason'].length <= MAX_PROGRAM_PROBE_TEXT))
  );
}

/**
 * A Host's probe as sent over the wire, reduced to the stored shape: one
 * entry per known program (the last wins), text fields bounded. Undefined
 * when the value is not a probe list at all.
 */
export function normalizeHostProgramProbes(
  value: unknown,
): HostProgramProbe[] | undefined {
  if (!Array.isArray(value) || value.length > 20) return undefined;
  const byProgram = new Map<HostProgramProbe['program'], HostProgramProbe>();
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    const program = entry['program'];
    const available = entry['available'];
    if (!isAgentProgram(program) || typeof available !== 'boolean') {
      return undefined;
    }
    const version =
      typeof entry['version'] === 'string'
        ? entry['version'].slice(0, MAX_PROGRAM_PROBE_TEXT)
        : undefined;
    const reason =
      typeof entry['reason'] === 'string'
        ? entry['reason'].slice(0, MAX_PROGRAM_PROBE_TEXT)
        : undefined;
    byProgram.set(program, {
      program,
      available,
      ...(version ? { version } : {}),
      ...(reason ? { reason } : {}),
    });
  }
  return [...byProgram.values()];
}

function isValidAgentHostsFile(value: unknown): value is AgentHostsFile {
  if (
    !isRecord(value) ||
    value['schemaVersion'] !== AGENT_HOSTS_SCHEMA_VERSION ||
    !Array.isArray(value['hosts']) ||
    !value['hosts'].every(isValidAgentHost)
  ) {
    return false;
  }
  const ids = new Set((value['hosts'] as AgentHost[]).map((host) => host.id));
  if (ids.size !== value['hosts'].length) return false;
  const enrollment = value['enrollment'];
  return (
    enrollment === undefined ||
    (isRecord(enrollment) &&
      isNonEmptyString(enrollment['tokenHash']) &&
      isFiniteTimestamp(enrollment['expiresAt']) &&
      (enrollment['supersedesHostId'] === undefined ||
        isValidId(enrollment['supersedesHostId'])) &&
      (enrollment['replacementHostId'] === undefined ||
        (isValidId(enrollment['supersedesHostId']) &&
          isValidId(enrollment['replacementHostId']))))
  );
}

function hashAgentHostSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function matchesAgentHostSecret(secret: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashAgentHostSecret(secret), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function publicAgentHost(host: AgentHost): AgentHostView {
  const { secretHash: _secretHash, ...view } = host;
  return view;
}

function assertKnownVersion(value: unknown, filePath: string): void {
  if (!isRecord(value) || value['schemaVersion'] === undefined) {
    throw new AgentSchemaVersionError(filePath, undefined);
  }
  if (value['schemaVersion'] !== AGENTS_SCHEMA_VERSION) {
    throw new AgentSchemaVersionError(filePath, value['schemaVersion']);
  }
}

async function readJsonFile(filePath: string): Promise<unknown | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(
      `Malformed JSON in ${filePath} — fix or delete the file; refusing to treat it as empty.`,
    );
  }
}

async function withWorkspaceLock<T>(
  projectRoot: string,
  run: () => Promise<T>,
): Promise<T> {
  if (workspaceTransaction.getStore()) {
    throw new Error('Nested agent workspace transactions are not allowed.');
  }
  const agentsDir = getAgentsDir(projectRoot);
  let mutex = workspaceMutexes.get(agentsDir);
  if (!mutex) {
    mutex = new Mutex();
    workspaceMutexes.set(agentsDir, mutex);
  }
  return mutex
    .runExclusive(async () => {
      await fs.mkdir(agentsDir, { recursive: true, mode: STORE_DIR_MODE });
      const release = await lockfile.lock(
        getWorkspaceFilePath(projectRoot),
        LOCK_OPTIONS,
      );
      try {
        return await workspaceTransaction.run(true, run);
      } finally {
        try {
          await release();
        } catch (err) {
          // After a compromise the lock is already released (ERELEASED); the
          // transaction's own result still stands.
          debug.warn('failed to release workspace lock:', err);
        }
      }
    })
    .finally(() => {
      // runExclusive releases before this callback; keep the mutex while a
      // queued caller has already acquired it.
      const held = workspaceMutexes.get(agentsDir);
      if (held && !held.isLocked()) workspaceMutexes.delete(agentsDir);
    });
}

function agentsFileIsValid(value: unknown): value is WorkspaceAgentsFile {
  if (
    !isRecord(value) ||
    value['schemaVersion'] !== AGENTS_SCHEMA_VERSION ||
    !Array.isArray(value['agents']) ||
    !value['agents'].every(isValidAgent)
  ) {
    return false;
  }
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const agent of value['agents']) {
    const name = agent.name.toLowerCase();
    if (ids.has(agent.id) || names.has(name)) return false;
    ids.add(agent.id);
    names.add(name);
  }
  return true;
}

/**
 * Reads the workspace record, creating it (and an empty roster) on first use.
 *
 * Pre-release (v0) roster and thread files are no longer migrated: the thread
 * subsystem is gone, and a v0 roster fails validation like any other
 * malformed record.
 */
async function ensureWorkspaceUnlocked(
  projectRoot: string,
): Promise<AgentWorkspaceState> {
  const workspacePath = getWorkspaceFilePath(projectRoot);
  const currentWorkspace = await readJsonFile(workspacePath);
  if (currentWorkspace !== undefined && isValidWorkspace(currentWorkspace)) {
    return currentWorkspace;
  }
  if (currentWorkspace !== undefined) {
    assertKnownVersion(currentWorkspace, workspacePath);
    throw new Error(`Malformed agent workspace record in ${workspacePath}.`);
  }

  const agentsPath = getAgentsFilePath(projectRoot);
  const currentAgents = await readJsonFile(agentsPath);
  if (currentAgents === undefined) {
    await atomicWriteJSON(
      agentsPath,
      {
        schemaVersion: AGENTS_SCHEMA_VERSION,
        agents: [],
      } satisfies WorkspaceAgentsFile,
      STORE_FILE_OPTIONS,
    );
  } else if (!agentsFileIsValid(currentAgents)) {
    assertKnownVersion(currentAgents, agentsPath);
    throw new Error(`Malformed workspace agents record in ${agentsPath}.`);
  }

  const workspace: AgentWorkspaceState = {
    schemaVersion: AGENTS_SCHEMA_VERSION,
    workspaceId: `ws_${randomUUID()}`,
  };
  await atomicWriteJSON(workspacePath, workspace, STORE_FILE_OPTIONS);
  const reread = await readJsonFile(workspacePath);
  if (!isValidWorkspace(reread)) {
    throw new Error(
      `Agent workspace record failed validation: ${workspacePath}.`,
    );
  }
  return workspace;
}

async function readAgentsUnlocked(
  projectRoot: string,
): Promise<WorkspaceAgent[]> {
  const filePath = getAgentsFilePath(projectRoot);
  const parsed = await readJsonFile(filePath);
  if (parsed === undefined) return [];
  assertKnownVersion(parsed, filePath);
  if (!agentsFileIsValid(parsed)) {
    throw new Error(`Malformed workspace agents record in ${filePath}.`);
  }
  return parsed.agents;
}

async function writeAgentsUnlocked(
  projectRoot: string,
  agents: readonly WorkspaceAgent[],
): Promise<void> {
  const record = {
    schemaVersion: AGENTS_SCHEMA_VERSION,
    agents: [...agents],
  } satisfies WorkspaceAgentsFile;
  if (!agentsFileIsValid(record)) {
    throw new Error('Refusing to write malformed workspace agents.');
  }
  await atomicWriteJSON(
    getAgentsFilePath(projectRoot),
    record,
    STORE_FILE_OPTIONS,
  );
}

/** Serialized workspace access; each file commits independently, without rollback. */
export interface AgentStoreTransaction {
  readonly projectRoot: string;
  readonly workspaceId: string;
  readAgents(): Promise<WorkspaceAgent[]>;
  writeAgents(agents: readonly WorkspaceAgent[]): Promise<void>;
}

function makeTransaction(
  projectRoot: string,
  workspace: AgentWorkspaceState,
): AgentStoreTransaction {
  return {
    projectRoot,
    workspaceId: workspace.workspaceId,
    readAgents: () => readAgentsUnlocked(projectRoot),
    writeAgents: (agents) => writeAgentsUnlocked(projectRoot, agents),
  };
}

export async function withAgentStoreTransaction<T>(
  projectRoot: string,
  run: (transaction: AgentStoreTransaction) => Promise<T>,
): Promise<T> {
  return withWorkspaceLock(projectRoot, async () => {
    const workspace = await ensureWorkspaceUnlocked(projectRoot);
    return run(makeTransaction(projectRoot, workspace));
  });
}

export async function readAgentWorkspace(
  projectRoot: string,
): Promise<AgentWorkspaceState> {
  return withAgentStoreTransaction(projectRoot, async () => {
    const filePath = getWorkspaceFilePath(projectRoot);
    const parsed = await readJsonFile(filePath);
    if (!isValidWorkspace(parsed)) {
      assertKnownVersion(parsed, filePath);
      throw new Error('Malformed agent workspace record.');
    }
    return parsed;
  });
}

/** For callers already inside the workspace lock (a store transaction). */
export async function readAgentHostsUnlocked(
  projectRoot: string,
): Promise<AgentHostsFile> {
  const filePath = getAgentHostsFilePath(projectRoot);
  const parsed = await readJsonFile(filePath);
  if (parsed === undefined) {
    return { schemaVersion: AGENT_HOSTS_SCHEMA_VERSION, hosts: [] };
  }
  if (!isValidAgentHostsFile(parsed)) {
    throw new Error(`Malformed Agent Host registry in ${filePath}.`);
  }
  return parsed;
}

async function writeAgentHostsUnlocked(
  projectRoot: string,
  registry: AgentHostsFile,
): Promise<void> {
  if (!isValidAgentHostsFile(registry)) {
    throw new Error('Refusing to write malformed Agent Host registry.');
  }
  await atomicWriteJSON(
    getAgentHostsFilePath(projectRoot),
    registry,
    STORE_FILE_OPTIONS,
  );
}

export async function readAgentHosts(
  projectRoot: string,
): Promise<AgentHostView[]> {
  return withWorkspaceLock(projectRoot, async () => {
    await ensureWorkspaceUnlocked(projectRoot);
    const registry = await readAgentHostsUnlocked(projectRoot);
    return registry.hosts.map(publicAgentHost);
  });
}

function pendingAgentHostReplacementError(registry: AgentHostsFile): Error {
  const oldId = registry.enrollment?.supersedesHostId;
  const old = registry.hosts.find((host) => host.id === oldId);
  return new Error(
    `Retry the pending Agent Host replacement first: select "${old?.name ?? oldId}" (${oldId}) in Runtimes, choose Replace, generate a fresh join command and run it on the replacement machine. Link expiry does not cancel the pending replacement.`,
  );
}

export async function issueAgentHostEnrollment(
  projectRoot: string,
  supersedesHostId?: string,
): Promise<{ token: string; expiresAt: number; replacementHostId?: string }> {
  return withWorkspaceLock(projectRoot, async () => {
    await ensureWorkspaceUnlocked(projectRoot);
    const registry = await readAgentHostsUnlocked(projectRoot);
    if (
      supersedesHostId !== undefined &&
      !registry.hosts.some((host) => host.id === supersedesHostId)
    ) {
      throw new Error('Agent Host to replace not found.');
    }
    const pending = registry.enrollment?.replacementHostId;
    if (pending && supersedesHostId !== registry.enrollment?.supersedesHostId) {
      throw pendingAgentHostReplacementError(registry);
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + HOST_ENROLLMENT_TTL_MS;
    await writeAgentHostsUnlocked(projectRoot, {
      ...registry,
      enrollment: {
        tokenHash: hashAgentHostSecret(token),
        expiresAt,
        ...(supersedesHostId !== undefined ? { supersedesHostId } : {}),
        ...(pending ? { replacementHostId: pending } : {}),
      },
    });
    return {
      token,
      expiresAt,
      ...(pending ? { replacementHostId: pending } : {}),
    };
  });
}

export async function enrollAgentHost(
  projectRoot: string,
  input: {
    token: string;
    name: string;
    workspaceCwd: string;
    providers: string[];
  },
): Promise<{ host: AgentHostView; secret: string }> {
  const name = input.name.trim();
  const workspaceCwd = input.workspaceCwd.trim();
  const providers = [...new Set(input.providers.map((value) => value.trim()))];
  if (!input.token || !name || name.length > 80) {
    throw new Error('Invalid Agent Host enrollment.');
  }
  if (!workspaceCwd || workspaceCwd.length > 4_096) {
    throw new Error('Invalid Agent Host workspace.');
  }
  if (
    providers.length === 0 ||
    providers.length > 20 ||
    providers.some((provider) => !provider || provider.length > 80)
  ) {
    throw new Error('Invalid Agent Host providers.');
  }
  return withAgentStoreTransaction(projectRoot, async (transaction) => {
    const registry = await readAgentHostsUnlocked(projectRoot);
    if (
      !registry.enrollment ||
      registry.enrollment.expiresAt < Date.now() ||
      !matchesAgentHostSecret(input.token, registry.enrollment.tokenHash)
    ) {
      throw new Error('Invalid or expired Agent Host enrollment token.');
    }
    const supersedesHostId = registry.enrollment.supersedesHostId;
    if (
      supersedesHostId !== undefined &&
      !registry.hosts.some((host) => host.id === supersedesHostId)
    ) {
      throw new Error('Agent Host to replace not found.');
    }
    const secret = randomBytes(32).toString('base64url');
    const host: AgentHost = {
      id: registry.enrollment.replacementHostId ?? generateAgentHostId(),
      name,
      secretHash: hashAgentHostSecret(secret),
      workspaceCwd,
      providers,
      createdAt: Date.now(),
    };
    if (supersedesHostId !== undefined) {
      // Files commit independently. Persist the new identity before moving
      // bindings, and retain its id in the token so an I/O failure is retryable.
      await writeAgentHostsUnlocked(projectRoot, {
        ...registry,
        hosts: [
          ...registry.hosts.filter((entry) => entry.id !== host.id),
          host,
        ],
        enrollment: { ...registry.enrollment, replacementHostId: host.id },
      });
      await replaceAgentHostInTransaction(
        transaction,
        supersedesHostId,
        host.id,
      );
    }
    const { enrollment: _used, ...rest } = registry;
    await writeAgentHostsUnlocked(projectRoot, {
      ...rest,
      hosts: [
        ...registry.hosts.filter(
          (entry) => entry.id !== supersedesHostId && entry.id !== host.id,
        ),
        host,
      ],
    });
    return { host: publicAgentHost(host), secret };
  });
}

export async function heartbeatAgentHost(
  projectRoot: string,
  hostId: string,
  secret: string,
  input: {
    workspaceCwd: string;
    providers: string[];
    enrollmentToken?: string;
    /** Protocol v2: the Host's program probe, stored as reported. */
    programs?: HostProgramProbe[];
    protocol?: number;
  },
): Promise<AgentHostView | undefined> {
  return withWorkspaceLock(projectRoot, async () => {
    await ensureWorkspaceUnlocked(projectRoot);
    const registry = await readAgentHostsUnlocked(projectRoot);
    const current = registry.hosts.find((host) => host.id === hostId);
    if (!current || !matchesAgentHostSecret(secret, current.secretHash)) {
      return undefined;
    }
    if (
      input.enrollmentToken !== undefined &&
      (!registry.enrollment ||
        registry.enrollment.expiresAt < Date.now() ||
        !matchesAgentHostSecret(
          input.enrollmentToken,
          registry.enrollment.tokenHash,
        ))
    ) {
      return undefined;
    }
    if (
      input.enrollmentToken !== undefined &&
      registry.enrollment?.supersedesHostId !== undefined
    ) {
      throw new Error(AGENT_HOST_REPLACEMENT_REQUIRED);
    }
    const workspaceCwd = input.workspaceCwd.trim();
    const providers = [
      ...new Set(input.providers.map((value) => value.trim())),
    ];
    const programs =
      input.programs === undefined
        ? undefined
        : normalizeHostProgramProbes(input.programs);
    if (
      !workspaceCwd ||
      workspaceCwd.length > 4_096 ||
      // A v2 Host with nothing installed but its probe still checks in; a
      // v1 Host always names at least its one program.
      (providers.length === 0 && programs === undefined) ||
      providers.length > 20 ||
      providers.some((provider) => !provider || provider.length > 80) ||
      (input.programs !== undefined && programs === undefined) ||
      (input.protocol !== undefined && !isPositiveInteger(input.protocol))
    ) {
      throw new Error('Invalid Agent Host heartbeat.');
    }
    const next: AgentHost = {
      ...current,
      workspaceCwd,
      providers,
      ...(programs !== undefined ? { programs } : {}),
      ...(input.protocol !== undefined ? { protocol: input.protocol } : {}),
      lastSeenAt: Date.now(),
    };
    // A Host that drops back to v1 must not keep advertising its v2 probe.
    if (programs === undefined) delete next.programs;
    if (input.protocol === undefined) delete next.protocol;
    const { enrollment: _used, ...withoutEnrollment } = registry;
    await writeAgentHostsUnlocked(projectRoot, {
      ...(input.enrollmentToken === undefined ? registry : withoutEnrollment),
      hosts: registry.hosts.map((host) =>
        host.id === current.id ? next : host,
      ),
    });
    return publicAgentHost(next);
  });
}

/**
 * Checks a Host's credential without the workspace lock.
 *
 * The registry is replaced atomically, so a read outside the lock sees either
 * the old or the new file, never a torn one; and a request with a wrong secret
 * must not be able to queue on the lock every store writer shares.
 */
export async function authenticateAgentHost(
  projectRoot: string,
  hostId: string,
  secret: string,
): Promise<AgentHostView | undefined> {
  const host = (await readAgentHostsUnlocked(projectRoot)).hosts.find(
    (candidate) => candidate.id === hostId,
  );
  return host && matchesAgentHostSecret(secret, host.secretHash)
    ? publicAgentHost(host)
    : undefined;
}

/**
 * Drops a Host from the registry, which revokes its secret. For callers inside
 * the workspace lock; `removeAgentHost` also unbinds agents.
 */
async function removeAgentHostUnlocked(
  projectRoot: string,
  hostId: string,
): Promise<boolean> {
  const registry = await readAgentHostsUnlocked(projectRoot);
  if (!registry.hosts.some((host) => host.id === hostId)) return false;
  if (
    registry.enrollment?.replacementHostId &&
    (registry.enrollment.supersedesHostId === hostId ||
      registry.enrollment.replacementHostId === hostId)
  ) {
    throw pendingAgentHostReplacementError(registry);
  }
  await writeAgentHostsUnlocked(projectRoot, {
    ...registry,
    hosts: registry.hosts.filter((host) => host.id !== hostId),
  });
  return true;
}

/**
 * Removes a Host: its secret stops authenticating and agents bound to it lose
 * it.
 *
 * An agent whose only Host this was falls back to running locally — the other
 * choice, leaving it bound to nothing, would queue its work forever. Returned
 * so the caller can say which agents moved. Runs the Host holds are the
 * session-agents orchestrator's to end (lease expiry), not this store's.
 */
export async function removeAgentHost(
  projectRoot: string,
  hostId: string,
): Promise<{ removed: false } | { removed: true; agentsMadeLocal: string[] }> {
  return withAgentStoreTransaction(projectRoot, async (transaction) => {
    if (!(await removeAgentHostUnlocked(projectRoot, hostId))) {
      return { removed: false as const };
    }
    const agentsMadeLocal: string[] = [];
    let agentsChanged = false;
    const agents = (await transaction.readAgents()).map(
      (agent): WorkspaceAgent => {
        const execution = agent.execution;
        if (
          execution?.mode !== 'managed-host' ||
          !execution.hostIds.includes(hostId)
        ) {
          return agent;
        }
        agentsChanged = true;
        const hostIds = execution.hostIds.filter((id) => id !== hostId);
        if (hostIds.length > 0) {
          return { ...agent, execution: { ...execution, hostIds } };
        }
        agentsMadeLocal.push(agent.id);
        return { ...agent, execution: { mode: 'local' } };
      },
    );
    if (agentsChanged) await transaction.writeAgents(agents);
    return { removed: true as const, agentsMadeLocal };
  });
}

/** Moves every agent bound to `oldHostId` onto `newHostId`. */
async function replaceAgentHostInTransaction(
  transaction: AgentStoreTransaction,
  oldHostId: string,
  newHostId: string,
): Promise<void> {
  const agents = await transaction.readAgents();
  if (
    !agents.some(
      (agent) =>
        agent.execution?.mode === 'managed-host' &&
        agent.execution.hostIds.includes(oldHostId),
    )
  ) {
    return;
  }
  await transaction.writeAgents(
    agents.map((agent): WorkspaceAgent => {
      const execution = agent.execution;
      if (
        execution?.mode !== 'managed-host' ||
        !execution.hostIds.includes(oldHostId)
      ) {
        return agent;
      }
      const hostIds = [
        ...new Set(
          execution.hostIds.map((id) => (id === oldHostId ? newHostId : id)),
        ),
      ];
      return { ...agent, execution: { ...execution, hostIds } };
    }),
  );
}

/**
 * Read-modify-write the caller grants under the workspace lock.
 *
 * A read followed by a separate write would let two concurrent issues drop one
 * another — and a dropped grant is a caller who thinks it has access and does
 * not, or worse, one whose revocation silently did not take.
 */
export async function updateAgentWorkspaceCallerGrants(
  projectRoot: string,
  update: (grants: readonly A2AGrant[]) => A2AGrant[],
): Promise<AgentWorkspaceState> {
  return withWorkspaceLock(projectRoot, async () => {
    const workspace = await ensureWorkspaceUnlocked(projectRoot);
    const grants = update(workspace.callerGrants ?? []);
    const next: AgentWorkspaceState =
      grants.length > 0
        ? { ...workspace, callerGrants: grants }
        : (() => {
            const { callerGrants: _dropped, ...rest } = workspace;
            return rest;
          })();
    await atomicWriteJSON(
      getWorkspaceFilePath(projectRoot),
      next,
      STORE_FILE_OPTIONS,
    );
    return next;
  });
}

export async function readWorkspaceAgents(
  projectRoot: string,
): Promise<WorkspaceAgent[]> {
  return withAgentStoreTransaction(projectRoot, (transaction) =>
    transaction.readAgents(),
  );
}

export async function updateWorkspaceAgents(
  projectRoot: string,
  mutate: (agents: WorkspaceAgent[]) => WorkspaceAgent[],
): Promise<WorkspaceAgent[]> {
  return withAgentStoreTransaction(projectRoot, async (transaction) => {
    // Always written: `mutate` may edit the roster in place and return the
    // same array, and skipping on identity would drop that change silently.
    const next = mutate(await transaction.readAgents());
    await transaction.writeAgents(next);
    return next;
  });
}

type WorkspaceAgentRosterChange =
  | 'updated'
  | 'not_found'
  | 'retired'
  | 'host_not_found'
  | 'program_unavailable'
  | 'managed_host_persona_unsupported';

export async function updateWorkspaceAgent(
  projectRoot: string,
  agentId: string,
  patch: {
    enabled?: boolean;
    execution?: WorkspaceAgent['execution'];
    applyConfig?: (agent: WorkspaceAgent) => WorkspaceAgent;
  },
): Promise<WorkspaceAgentRosterChange> {
  return withAgentStoreTransaction(projectRoot, async (transaction) => {
    const agents = await transaction.readAgents();
    const agent = agents.find((candidate) => candidate.id === agentId);
    if (!agent) return 'not_found';
    if (agent.retiredAt !== undefined) return 'retired';
    let next = patch.applyConfig ? patch.applyConfig(agent) : agent;
    if ('execution' in patch) next = { ...next, execution: patch.execution };
    if (
      patch.enabled !== undefined &&
      (agent.enabled !== false) !== patch.enabled
    ) {
      next = { ...next, enabled: patch.enabled };
    }
    if (
      (patch.applyConfig || 'execution' in patch) &&
      next.execution?.mode === 'managed-host' &&
      (next.agentType || next.model)
    ) {
      return 'managed_host_persona_unsupported';
    }
    // Live session-agent runs are checked by the caller (the daemon route),
    // which owns the orchestrator; the store cannot see in-memory runs.
    if ('execution' in patch) {
      const execution = next.execution;
      if (execution?.mode === 'managed-host') {
        const hosts = (await readAgentHostsUnlocked(projectRoot)).hosts;
        const placed = hosts.filter((host) =>
          execution.hostIds.includes(host.id),
        );
        if (placed.length !== execution.hostIds.length) return 'host_not_found';
        const { provider } = execution;
        if (
          provider &&
          !placed.some((host) => hostOffersProgram(host, provider))
        ) {
          return 'program_unavailable';
        }
      }
    }
    if (next !== agent) {
      await transaction.writeAgents(
        agents.map((candidate) =>
          candidate.id === agentId ? next : candidate,
        ),
      );
    }
    return 'updated';
  });
}

export async function setWorkspaceAgentEnabled(
  projectRoot: string,
  agentId: string,
  enabled: boolean,
): Promise<WorkspaceAgentRosterChange> {
  return updateWorkspaceAgent(projectRoot, agentId, { enabled });
}

/**
 * Retires an identity: it takes no new work and keeps everything it did.
 *
 * Deleting the roster entry was the obvious implementation and the wrong one.
 * Every message an agent wrote names it, and a chat session is read long after
 * the agent stops working: removing the entry turns its side of a conversation
 * into an author nobody can look up, and a mention of it into a typo. So the
 * entry stays, `retiredAt` is stamped, and `isAgentAddressable` refuses new
 * work from then on.
 *
 * The consequences are deliberate. The name stays taken, because a second
 * agent under a retired one's name would make the old messages read as that
 * new agent's. Retiring twice is idempotent rather than an error. Refusing
 * while the agent has live runs is the caller's job: the runs live in the
 * daemon's session-agents orchestrator, which this store cannot see.
 */
export async function retireWorkspaceAgent(
  projectRoot: string,
  agentId: string,
): Promise<WorkspaceAgentRosterChange> {
  return withAgentStoreTransaction(projectRoot, async (transaction) => {
    const agents = await transaction.readAgents();
    const existing = agents.find((candidate) => candidate.id === agentId);
    if (!existing) return 'not_found';
    if (existing.retiredAt !== undefined) return 'updated';
    await transaction.writeAgents(
      agents.map((candidate) =>
        candidate.id === agentId
          ? { ...candidate, retiredAt: Date.now() }
          : candidate,
      ),
    );
    return 'updated';
  });
}

export function findAgentByName(
  agents: readonly WorkspaceAgent[],
  name: string,
): WorkspaceAgent | undefined {
  const lowered = name.toLowerCase();
  return agents.find((agent) => agent.name.toLowerCase() === lowered);
}

export function isAgentLocal(agent: WorkspaceAgent): boolean {
  return agent.execution === undefined || agent.execution.mode === 'local';
}

/** How many runs this agent may execute at once. Absent means one. */
export function maxConcurrentRunsFor(agent: WorkspaceAgent): number {
  return agent.maxConcurrentRuns ?? 1;
}

/**
 * Whether this identity can still be given work.
 *
 * Retired and disabled are different refusals with the same answer here, and
 * both are kept apart from "unknown": a retired agent's name still resolves,
 * so a mention of it can say the agent is gone rather than that the name was
 * mistyped. Enabling a retired agent is itself refused.
 */
export function isAgentAddressable(agent: WorkspaceAgent): boolean {
  return agent.retiredAt === undefined && agent.enabled !== false;
}
