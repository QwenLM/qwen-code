/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { SessionSquad } from '@qwen-code/qwen-code-core/agents/session-agents/contract.js';
import type {
  AgentHostView,
  WorkspaceAgent,
} from '@qwen-code/qwen-code-core/agents/workspace-agents/types.js';
import {
  createHostProgramAgentEnsurer,
  planHostProgramAgents,
  sanitizeHostNameForAgent,
} from './agent-host-program-agents.js';

const host = { id: 'host_1', name: "Jin's MacBook.local" };
let ids = 0;
const options = { now: 5, newId: () => `ag_${++ids}` };

describe('planHostProgramAgents', () => {
  it('names one agent per program after the host, without @ or .', () => {
    expect(sanitizeHostNameForAgent("Jin's MacBook.local")).toBe(
      'Jin-s-MacBook-local',
    );
    expect(sanitizeHostNameForAgent('...')).toBe('host');

    const added = planHostProgramAgents([], host, ['claude', 'codex'], options);

    expect(added.map((agent) => agent.name)).toEqual([
      'claude-Jin-s-MacBook-local',
      'codex-Jin-s-MacBook-local',
    ]);
    expect(added[0]).toMatchObject({
      createdAt: 5,
      execution: {
        mode: 'managed-host',
        hostIds: ['host_1'],
        provider: 'claude',
      },
    });
  });

  it('skips a program that already has an agent on this host, retired or not', () => {
    const existing: WorkspaceAgent[] = [
      {
        id: 'ag_old',
        name: 'my-claude',
        createdAt: 1,
        retiredAt: 2,
        execution: {
          mode: 'managed-host',
          hostIds: ['host_1'],
          provider: 'claude',
        },
      },
      {
        id: 'ag_default',
        name: 'remote',
        createdAt: 1,
        // No provider: the host's default, qwen.
        execution: { mode: 'managed-host', hostIds: ['host_1'] },
      },
    ];

    expect(
      planHostProgramAgents(existing, host, ['qwen', 'claude'], options),
    ).toEqual([]);
  });

  it('finds a free name, case-insensitively and within 48 characters', () => {
    const long = { id: 'host_2', name: 'x'.repeat(80) };
    const taken: WorkspaceAgent[] = [
      { id: 'ag_a', name: `CLAUDE-${'x'.repeat(41)}`, createdAt: 1 },
    ];

    const [agent] = planHostProgramAgents(taken, long, ['claude'], options);

    expect(agent?.name).toBe(`claude-${'x'.repeat(39)}-2`);
    expect(agent?.name.length).toBeLessThanOrEqual(48);
  });

  it('does not take a name a squad holds', () => {
    const [agent] = planHostProgramAgents(
      [],
      { id: 'host_3', name: 'mac' },
      ['claude'],
      { ...options, squads: [{ name: 'Claude-mac' }] },
    );

    expect(agent?.name).toBe('claude-mac-2');
  });
});

describe('createHostProgramAgentEnsurer', () => {
  it('writes the roster only when the Host reports a new program', async () => {
    let roster: WorkspaceAgent[] = [];
    const update = vi.fn(
      async (
        _cwd: string,
        mutate: (
          agents: WorkspaceAgent[],
          squads: readonly SessionSquad[],
        ) => WorkspaceAgent[],
      ) => {
        roster = mutate(roster, [
          {
            id: 'sq_1',
            name: 'claude-mac',
            leaderAgentId: 'ag_x',
            members: [],
            createdAt: 1,
            updatedAt: 1,
          },
        ]);
        return roster;
      },
    );
    const ensure = createHostProgramAgentEnsurer(update);
    const view = (programs: Array<'qwen' | 'claude'>): AgentHostView => ({
      id: 'host_1',
      name: 'mac',
      workspaceCwd: '/remote',
      providers: programs,
      programs: programs.map((program) => ({ program, available: true })),
      protocol: 2,
      createdAt: 1,
    });

    expect((await ensure('/ws', view(['qwen']))).map((a) => a.name)).toEqual([
      'qwen-mac',
    ]);
    await ensure('/ws', view(['qwen']));
    expect(update).toHaveBeenCalledOnce();

    expect(
      (await ensure('/ws', view(['qwen', 'claude']))).map((a) => a.name),
    ).toEqual(['claude-mac-2']);
    expect(update).toHaveBeenCalledTimes(2);
    expect(roster.map((agent) => agent.name)).toEqual([
      'qwen-mac',
      'claude-mac-2',
    ]);
  });
});
