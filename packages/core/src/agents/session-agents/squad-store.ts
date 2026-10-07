/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Workspace squads: `<agentsDir>/squads.json`, mode 0600, under
 * the same workspace lock as the agent roster (session-multi-agent design §11.1).
 *
 * A squad is a name, a leader agent and member agents with optional roles.
 * Names share the agents' namespace (case-insensitive, same pattern), because
 * `@name` must resolve to exactly one of them.
 *
 * Agents are retired rather than deleted, but a squad must still cope with an
 * agent that is gone from the roster: on every read and write a retired or
 * missing member is dropped, and a squad whose leader is missing, retired or
 * disabled keeps existing but reports a {@link SessionSquadLeaderIssue} and
 * refuses to be activated until a person picks another leader.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { atomicWriteJSON } from '../../utils/atomicFileWrite.js';
import { isNodeError } from '../../utils/errors.js';
import {
  AGENT_NAME_PATTERN,
  STORE_DIR_MODE,
  STORE_FILE_OPTIONS,
  getAgentsDir,
  isAgentAddressable,
  withAgentStoreTransaction,
} from '../workspace-agents/store.js';
import type { WorkspaceAgent } from '../workspace-agents/types.js';
import {
  SESSION_SQUADS_SCHEMA_VERSION,
  type SessionSquad,
  type SessionSquadLeaderIssue,
  type SessionSquadMember,
  type SessionSquadView,
  type SessionSquadsFile,
} from './contract.js';

const SQUADS_FILENAME = 'squads.json';
const SQUAD_ID_PATTERN = /^sq_[A-Za-z0-9-]{1,64}$/;
const MAX_DESCRIPTION_CHARS = 2_000;
const MAX_INSTRUCTIONS_CHARS = 20_000;
const MAX_ROLE_CHARS = 200;
const MAX_MEMBERS = 32;

/** A refused squad change; the route maps `status` and `code` to HTTP. */
export class SquadStoreError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SquadStoreError';
  }
}

export function getSquadsFilePath(projectRoot: string): string {
  return path.join(getAgentsDir(projectRoot), SQUADS_FILENAME);
}

export function isValidSquadId(value: unknown): value is string {
  return typeof value === 'string' && SQUAD_ID_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isValidMember(value: unknown): value is SessionSquadMember {
  return (
    isRecord(value) &&
    typeof value['agentId'] === 'string' &&
    isOptionalString(value['role'])
  );
}

function isValidSquad(value: unknown): value is SessionSquad {
  return (
    isRecord(value) &&
    isValidSquadId(value['id']) &&
    typeof value['name'] === 'string' &&
    AGENT_NAME_PATTERN.test(value['name']) &&
    isOptionalString(value['description']) &&
    isOptionalString(value['instructions']) &&
    typeof value['leaderAgentId'] === 'string' &&
    Array.isArray(value['members']) &&
    value['members'].every(isValidMember) &&
    typeof value['createdAt'] === 'number' &&
    typeof value['updatedAt'] === 'number' &&
    (value['retiredAt'] === undefined || typeof value['retiredAt'] === 'number')
  );
}

/**
 * Parses `squads.json`. Refuses rather than repairs, like the binding store:
 * reading a malformed file as empty would let the next write erase it.
 */
export function parseSquadsFile(
  value: unknown,
  filePath = '<memory>',
): SessionSquadsFile {
  if (!isRecord(value)) {
    throw new Error(`Malformed squads file ${filePath}.`);
  }
  if (value['schemaVersion'] !== SESSION_SQUADS_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported squads schema version ${JSON.stringify(value['schemaVersion'])} in ${filePath}; this build supports version ${SESSION_SQUADS_SCHEMA_VERSION}.`,
    );
  }
  const squads = value['squads'];
  if (!Array.isArray(squads) || !squads.every(isValidSquad)) {
    throw new Error(`Malformed squads file ${filePath}.`);
  }
  return { schemaVersion: SESSION_SQUADS_SCHEMA_VERSION, squads };
}

/** For callers inside the workspace lock. Absent file = no squads. */
async function readSquadsUnlocked(
  projectRoot: string,
): Promise<SessionSquad[]> {
  const filePath = getSquadsFilePath(projectRoot);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return [];
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `Malformed JSON in ${filePath} — fix or delete the file; refusing to treat it as empty.`,
    );
  }
  return parseSquadsFile(parsed, filePath).squads;
}

async function writeSquadsUnlocked(
  projectRoot: string,
  squads: readonly SessionSquad[],
): Promise<void> {
  const record: SessionSquadsFile = {
    schemaVersion: SESSION_SQUADS_SCHEMA_VERSION,
    squads: [...squads],
  };
  // Same rules as a read, so a bad value fails here, not on the next read.
  parseSquadsFile(record);
  await fs.mkdir(getAgentsDir(projectRoot), {
    recursive: true,
    mode: STORE_DIR_MODE,
  });
  await atomicWriteJSON(
    getSquadsFilePath(projectRoot),
    record,
    STORE_FILE_OPTIONS,
  );
}

/** Why `leaderAgentId` cannot lead right now, or undefined when it can. */
export function squadLeaderIssue(
  squad: Pick<SessionSquad, 'leaderAgentId'>,
  agents: readonly WorkspaceAgent[],
): SessionSquadLeaderIssue | undefined {
  const leader = agents.find((agent) => agent.id === squad.leaderAgentId);
  if (!leader) return 'missing';
  if (leader.retiredAt !== undefined) return 'retired';
  if (!isAgentAddressable(leader)) return 'disabled';
  return undefined;
}

/**
 * Drops members whose agent is gone from the roster or retired. Pure; the
 * squad (and its possibly unusable leader) is otherwise kept as it is.
 */
export function pruneSquadMembers(
  squad: SessionSquad,
  agents: readonly WorkspaceAgent[],
): SessionSquad {
  const live = new Set(
    agents
      .filter((agent) => agent.retiredAt === undefined)
      .map((agent) => agent.id),
  );
  const members = squad.members.filter((member) => live.has(member.agentId));
  return members.length === squad.members.length
    ? squad
    : { ...squad, members };
}

/** A squad with names resolved and its leader checked, for the routes. */
export function toSquadView(
  squad: SessionSquad,
  agents: readonly WorkspaceAgent[],
): SessionSquadView {
  const pruned = pruneSquadMembers(squad, agents);
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const leaderIssue = squadLeaderIssue(pruned, agents);
  const leaderName = byId.get(pruned.leaderAgentId)?.name;
  return {
    ...pruned,
    ...(leaderName ? { leaderName } : {}),
    ...(leaderIssue ? { leaderIssue } : {}),
    members: pruned.members.map((member) => ({
      ...member,
      name: byId.get(member.agentId)?.name ?? member.agentId,
    })),
  };
}

function nameTaken(
  name: string,
  agents: readonly WorkspaceAgent[],
  squads: readonly SessionSquad[],
  exceptSquadId?: string,
): boolean {
  const lowered = name.toLowerCase();
  // Retired agents and squads keep their names: old messages name them.
  return (
    agents.some((agent) => agent.name.toLowerCase() === lowered) ||
    squads.some(
      (squad) =>
        squad.id !== exceptSquadId && squad.name.toLowerCase() === lowered,
    )
  );
}

function optionalText(
  value: unknown,
  field: string,
  max: number,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length > max) {
    throw new SquadStoreError(
      400,
      `invalid_${field}`,
      `${field} must be a string of at most ${max} characters.`,
    );
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function validateName(
  value: unknown,
  agents: readonly WorkspaceAgent[],
  squads: readonly SessionSquad[],
  exceptSquadId?: string,
): string {
  if (typeof value !== 'string' || !AGENT_NAME_PATTERN.test(value)) {
    throw new SquadStoreError(
      400,
      'invalid_name',
      'A squad name is 1-48 letters, digits, "_" or "-", starting with a letter or digit (no "@" or ".").',
    );
  }
  if (nameTaken(value, agents, squads, exceptSquadId)) {
    throw new SquadStoreError(
      409,
      'name_taken',
      `"${value}" is already the name of an agent or a squad.`,
    );
  }
  return value;
}

function validateLeader(
  value: unknown,
  agents: readonly WorkspaceAgent[],
): string {
  if (typeof value !== 'string') {
    throw new SquadStoreError(
      400,
      'invalid_leader',
      'leaderAgentId is required.',
    );
  }
  const issue = squadLeaderIssue({ leaderAgentId: value }, agents);
  if (issue) {
    throw new SquadStoreError(
      400,
      'invalid_leader',
      issue === 'missing'
        ? 'The leader must be an agent of this workspace.'
        : `The leader agent is ${issue}; pick an enabled agent.`,
    );
  }
  return value;
}

function validateMembers(
  value: unknown,
  agents: readonly WorkspaceAgent[],
): SessionSquadMember[] {
  if (!Array.isArray(value) || value.length > MAX_MEMBERS) {
    throw new SquadStoreError(
      400,
      'invalid_members',
      `members must be a list of at most ${MAX_MEMBERS} agents.`,
    );
  }
  const seen = new Set<string>();
  return value.map((entry) => {
    const agentId = isRecord(entry) ? entry['agentId'] : undefined;
    const agent =
      typeof agentId === 'string'
        ? agents.find((candidate) => candidate.id === agentId)
        : undefined;
    if (!agent || agent.retiredAt !== undefined) {
      throw new SquadStoreError(
        400,
        'invalid_members',
        'Every member must be an agent of this workspace that is not retired.',
      );
    }
    if (seen.has(agent.id)) {
      throw new SquadStoreError(
        400,
        'invalid_members',
        `${agent.name} is listed twice.`,
      );
    }
    seen.add(agent.id);
    const role = optionalText(
      (entry as Record<string, unknown>)['role'],
      'role',
      MAX_ROLE_CHARS,
    );
    return { agentId: agent.id, ...(role ? { role } : {}) };
  });
}

export interface NewSessionSquad {
  name: unknown;
  description?: unknown;
  instructions?: unknown;
  leaderAgentId: unknown;
  members?: unknown;
}

/** Absent leaves a field alone; `null` clears description / instructions. */
export interface SessionSquadPatch {
  name?: unknown;
  description?: unknown;
  instructions?: unknown;
  leaderAgentId?: unknown;
  members?: unknown;
}

/**
 * Read-modify-write under the workspace lock. Every write also drops members
 * whose agent is gone, so the file heals as the roster changes.
 */
async function mutateSquads<T>(
  projectRoot: string,
  mutate: (
    squads: SessionSquad[],
    agents: readonly WorkspaceAgent[],
  ) => { squads: SessionSquad[]; result: T },
): Promise<{ result: T; agents: WorkspaceAgent[] }> {
  return withAgentStoreTransaction(projectRoot, async (transaction) => {
    const agents = await transaction.readAgents();
    const current = (await readSquadsUnlocked(projectRoot)).map((squad) =>
      pruneSquadMembers(squad, agents),
    );
    const { squads, result } = mutate(current, agents);
    await writeSquadsUnlocked(projectRoot, squads);
    return { result, agents };
  });
}

/**
 * Read-modify-write of the agent roster that also sees the squads, under the
 * one workspace lock: an agent name checked against the squads here cannot
 * be taken by a squad before the roster is written (squad writes check the
 * agents the same way, in {@link mutateSquads}). Always writes, like
 * `updateWorkspaceAgents`.
 */
export async function updateWorkspaceAgentsWithSquads(
  projectRoot: string,
  mutate: (
    agents: WorkspaceAgent[],
    squads: readonly SessionSquad[],
  ) => WorkspaceAgent[],
): Promise<WorkspaceAgent[]> {
  return withAgentStoreTransaction(projectRoot, async (transaction) => {
    const squads = await readSquadsUnlocked(projectRoot);
    const next = mutate(await transaction.readAgents(), squads);
    await transaction.writeAgents(next);
    return next;
  });
}

/** Every squad (retired included), with gone members dropped. */
export async function readSquads(projectRoot: string): Promise<SessionSquad[]> {
  return withAgentStoreTransaction(projectRoot, async (transaction) => {
    const agents = await transaction.readAgents();
    return (await readSquadsUnlocked(projectRoot)).map((squad) =>
      pruneSquadMembers(squad, agents),
    );
  });
}

/** Squads as the routes return them, with the roster they were checked against. */
export async function listSquadViews(
  projectRoot: string,
): Promise<SessionSquadView[]> {
  return withAgentStoreTransaction(projectRoot, async (transaction) => {
    const agents = await transaction.readAgents();
    return (await readSquadsUnlocked(projectRoot)).map((squad) =>
      toSquadView(squad, agents),
    );
  });
}

export async function createSquad(
  projectRoot: string,
  input: NewSessionSquad,
  now = Date.now(),
): Promise<SessionSquadView> {
  const { result, agents } = await mutateSquads(
    projectRoot,
    (squads, roster) => {
      const name = validateName(input.name, roster, squads);
      const leaderAgentId = validateLeader(input.leaderAgentId, roster);
      const members = validateMembers(input.members ?? [], roster);
      const description = optionalText(
        input.description,
        'description',
        MAX_DESCRIPTION_CHARS,
      );
      const instructions = optionalText(
        input.instructions,
        'instructions',
        MAX_INSTRUCTIONS_CHARS,
      );
      const squad: SessionSquad = {
        id: `sq_${randomUUID()}`,
        name,
        ...(description ? { description } : {}),
        ...(instructions ? { instructions } : {}),
        leaderAgentId,
        members,
        createdAt: now,
        updatedAt: now,
      };
      return { squads: [...squads, squad], result: squad };
    },
  );
  return toSquadView(result, agents);
}

export async function updateSquad(
  projectRoot: string,
  squadId: string,
  patch: SessionSquadPatch,
  now = Date.now(),
): Promise<SessionSquadView> {
  const { result, agents } = await mutateSquads(
    projectRoot,
    (squads, roster) => {
      const existing = squads.find((squad) => squad.id === squadId);
      if (!existing) {
        throw new SquadStoreError(404, 'squad_not_found', 'No such squad.');
      }
      if (existing.retiredAt !== undefined) {
        throw new SquadStoreError(
          409,
          'squad_retired',
          'This squad is retired.',
        );
      }
      const next: SessionSquad = { ...existing, updatedAt: now };
      if (patch.name !== undefined && patch.name !== existing.name) {
        next.name = validateName(patch.name, roster, squads, squadId);
      }
      if (patch.leaderAgentId !== undefined) {
        next.leaderAgentId = validateLeader(patch.leaderAgentId, roster);
      }
      if (patch.members !== undefined) {
        next.members = validateMembers(patch.members, roster);
      }
      for (const [field, max] of [
        ['description', MAX_DESCRIPTION_CHARS],
        ['instructions', MAX_INSTRUCTIONS_CHARS],
      ] as const) {
        if (patch[field] === undefined) continue;
        const value = optionalText(patch[field], field, max);
        if (value) next[field] = value;
        else delete next[field];
      }
      return {
        squads: squads.map((squad) => (squad.id === squadId ? next : squad)),
        result: next,
      };
    },
  );
  return toSquadView(result, agents);
}

/**
 * Retires a squad: it keeps its name (old messages name it) and takes no new
 * work. An engagement already running in a session finishes on its own.
 * Idempotent.
 */
export async function retireSquad(
  projectRoot: string,
  squadId: string,
  now = Date.now(),
): Promise<SessionSquadView> {
  const { result, agents } = await mutateSquads(projectRoot, (squads) => {
    const existing = squads.find((squad) => squad.id === squadId);
    if (!existing) {
      throw new SquadStoreError(404, 'squad_not_found', 'No such squad.');
    }
    if (existing.retiredAt !== undefined) {
      return { squads, result: existing };
    }
    const retired: SessionSquad = {
      ...existing,
      retiredAt: now,
      updatedAt: now,
    };
    return {
      squads: squads.map((squad) => (squad.id === squadId ? retired : squad)),
      result: retired,
    };
  });
  return toSquadView(result, agents);
}
