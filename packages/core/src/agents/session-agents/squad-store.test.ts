/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Storage } from '../../config/storage.js';
import {
  readWorkspaceAgents,
  updateWorkspaceAgents,
} from '../workspace-agents/store.js';
import type { WorkspaceAgent } from '../workspace-agents/types.js';
import {
  SquadStoreError,
  createSquad,
  getSquadsFilePath,
  listSquadViews,
  parseSquadsFile,
  pruneSquadMembers,
  readSquads,
  retireSquad,
  squadLeaderIssue,
  updateSquad,
  updateWorkspaceAgentsWithSquads,
} from './squad-store.js';
import type { SessionSquad } from './contract.js';

const agent = (id: string, name: string, extra: Partial<WorkspaceAgent> = {}) =>
  ({ id, name, createdAt: 1, ...extra }) as WorkspaceAgent;

const roster = [
  agent('ag_lead', 'lead'),
  agent('ag_a', 'alice'),
  agent('ag_b', 'bob'),
  agent('ag_off', 'paused', { enabled: false }),
  agent('ag_gone', 'gone', { retiredAt: 5 }),
];

describe('squad store', () => {
  let runtimeDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'squads-'));
    projectRoot = path.join(runtimeDir, 'project');
    Storage.setRuntimeBaseDir(runtimeDir);
    await updateWorkspaceAgents(projectRoot, () => [...roster]);
  });

  afterEach(async () => {
    Storage.setRuntimeBaseDir(null);
    await fs.rm(runtimeDir, { recursive: true, force: true });
  });

  const create = (extra: Record<string, unknown> = {}) =>
    createSquad(projectRoot, {
      name: 'review',
      leaderAgentId: 'ag_lead',
      members: [{ agentId: 'ag_a', role: 'reads diffs' }, { agentId: 'ag_b' }],
      ...extra,
    });

  async function refusal(promise: Promise<unknown>) {
    const error = await promise.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(SquadStoreError);
    return error as SquadStoreError;
  }

  it('creates a squad next to agents.json, 0600, with names resolved', async () => {
    const squad = await create({ description: ' Reviews ', instructions: '' });
    expect(squad).toMatchObject({
      name: 'review',
      description: 'Reviews',
      leaderAgentId: 'ag_lead',
      leaderName: 'lead',
      members: [
        { agentId: 'ag_a', role: 'reads diffs', name: 'alice' },
        { agentId: 'ag_b', name: 'bob' },
      ],
    });
    expect(squad.id).toMatch(/^sq_/);
    expect(squad).not.toHaveProperty('instructions');
    expect(squad).not.toHaveProperty('leaderIssue');
    const filePath = getSquadsFilePath(projectRoot);
    expect(path.basename(filePath)).toBe('squads.json');
    if (process.platform !== 'win32') {
      expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    }
    expect(await readSquads(projectRoot)).toHaveLength(1);
  });

  it('refuses names with @ or ., and names taken by an agent or a squad', async () => {
    expect((await refusal(create({ name: 'a.b' }))).code).toBe('invalid_name');
    expect((await refusal(create({ name: '@x' }))).code).toBe('invalid_name');
    // Case-insensitive, retired agents included.
    expect((await refusal(create({ name: 'Alice' }))).status).toBe(409);
    expect((await refusal(create({ name: 'gone' }))).code).toBe('name_taken');
    await create();
    expect((await refusal(create({ name: 'REVIEW' }))).code).toBe('name_taken');
  });

  it('requires an enabled, unretired leader', async () => {
    for (const leaderAgentId of ['ag_off', 'ag_gone', 'ag_nobody', undefined]) {
      expect((await refusal(create({ leaderAgentId }))).code).toBe(
        'invalid_leader',
      );
    }
  });

  it('requires distinct, existing, unretired members; the leader is optional', async () => {
    expect(
      (
        await refusal(
          create({ members: [{ agentId: 'ag_a' }, { agentId: 'ag_a' }] }),
        )
      ).code,
    ).toBe('invalid_members');
    expect(
      (await refusal(create({ members: [{ agentId: 'ag_gone' }] }))).code,
    ).toBe('invalid_members');
    const squad = await create({ members: [] });
    expect(squad.members).toEqual([]);
    // A paused agent may still be a member.
    const withPaused = await create({
      name: 'second',
      members: [{ agentId: 'ag_off' }, { agentId: 'ag_lead' }],
    });
    expect(withPaused.members.map((member) => member.agentId)).toEqual([
      'ag_off',
      'ag_lead',
    ]);
  });

  it('updates fields, clears text with null, and keeps the name rule on rename', async () => {
    const squad = await create({ description: 'd', instructions: 'i' });
    const updated = await updateSquad(projectRoot, squad.id, {
      description: null,
      instructions: 'Ship small PRs.',
      leaderAgentId: 'ag_a',
      members: [{ agentId: 'ag_b', role: 'tests' }],
    });
    expect(updated).toMatchObject({
      instructions: 'Ship small PRs.',
      leaderAgentId: 'ag_a',
      members: [{ agentId: 'ag_b', role: 'tests', name: 'bob' }],
    });
    expect(updated).not.toHaveProperty('description');
    expect(
      (await refusal(updateSquad(projectRoot, squad.id, { name: 'bob' }))).code,
    ).toBe('name_taken');
    // Renaming to its own name (any case) is not a clash with itself.
    await expect(
      updateSquad(projectRoot, squad.id, { name: 'Review' }),
    ).resolves.toMatchObject({ name: 'Review' });
    expect(
      (await refusal(updateSquad(projectRoot, 'sq_nope', {}))).status,
    ).toBe(404);
  });

  it('retires idempotently and refuses edits after', async () => {
    const squad = await create();
    const retired = await retireSquad(projectRoot, squad.id, 42);
    expect(retired.retiredAt).toBe(42);
    expect((await retireSquad(projectRoot, squad.id, 99)).retiredAt).toBe(42);
    expect(
      (await refusal(updateSquad(projectRoot, squad.id, { name: 'x' }))).code,
    ).toBe('squad_retired');
    // The name stays taken.
    expect((await refusal(create())).code).toBe('name_taken');
  });

  it('drops members that disappear and flags a leader that cannot lead', async () => {
    const squad = await create();
    await updateWorkspaceAgents(projectRoot, (agents) =>
      agents
        .filter((candidate) => candidate.id !== 'ag_b')
        .map((candidate) =>
          candidate.id === 'ag_lead'
            ? { ...candidate, retiredAt: 9 }
            : candidate,
        ),
    );
    const [view] = await listSquadViews(projectRoot);
    expect(view).toMatchObject({
      id: squad.id,
      leaderIssue: 'retired',
      members: [{ agentId: 'ag_a' }],
    });
    // Kept, not deleted; a write heals the file and a new leader fixes it.
    const fixed = await updateSquad(projectRoot, squad.id, {
      leaderAgentId: 'ag_a',
    });
    expect(fixed).not.toHaveProperty('leaderIssue');
    const raw = parseSquadsFile(
      JSON.parse(await fs.readFile(getSquadsFilePath(projectRoot), 'utf-8')),
    );
    expect(raw.squads[0]!.members).toEqual([
      { agentId: 'ag_a', role: 'reads diffs' },
    ]);
  });

  it('hands an agent roster write the squads read under the same lock', async () => {
    await create();
    const next = await updateWorkspaceAgentsWithSquads(
      projectRoot,
      (agents, squads) => {
        expect(squads.map((squad) => squad.name)).toEqual(['review']);
        return squads.some((squad) => squad.name === 'review')
          ? agents
          : [...agents, agent('ag_new', 'review')];
      },
    );
    expect(next.map((entry) => entry.id)).not.toContain('ag_new');
    // No squads file yet reads as none.
    await fs.rm(getSquadsFilePath(projectRoot));
    await updateWorkspaceAgentsWithSquads(projectRoot, (agents, squads) => {
      expect(squads).toEqual([]);
      return [...agents, agent('ag_new', 'review')];
    });
    expect((await readWorkspaceAgents(projectRoot)).at(-1)?.name).toBe(
      'review',
    );
  });

  it('refuses a malformed file instead of reading it as empty', async () => {
    await create();
    await fs.writeFile(getSquadsFilePath(projectRoot), '{"schemaVersion":2}');
    await expect(readSquads(projectRoot)).rejects.toThrow(/schema version/);
    await fs.writeFile(getSquadsFilePath(projectRoot), 'not json');
    await expect(readSquads(projectRoot)).rejects.toThrow(/Malformed JSON/);
  });
});

describe('squad helpers', () => {
  const squad: SessionSquad = {
    id: 'sq_1',
    name: 'review',
    leaderAgentId: 'ag_lead',
    members: [{ agentId: 'ag_a' }, { agentId: 'ag_gone' }, { agentId: 'ag_x' }],
    createdAt: 1,
    updatedAt: 1,
  };

  it('names why a leader cannot lead', () => {
    expect(squadLeaderIssue(squad, roster)).toBeUndefined();
    expect(squadLeaderIssue({ leaderAgentId: 'ag_off' }, roster)).toBe(
      'disabled',
    );
    expect(squadLeaderIssue({ leaderAgentId: 'ag_gone' }, roster)).toBe(
      'retired',
    );
    expect(squadLeaderIssue({ leaderAgentId: 'ag_x' }, roster)).toBe('missing');
  });

  it('prunes retired and missing members only', () => {
    expect(pruneSquadMembers(squad, roster).members).toEqual([
      { agentId: 'ag_a' },
    ]);
  });
});
