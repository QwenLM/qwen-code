/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import {
  FileManagedSessionHistory,
  ManagedHistoryQuery,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-history.js';
import {
  teamOpenBody,
  teamLifecycleBody,
  teamTaskOpenBody,
  teamTaskRevisionBody,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-team-operations.js';
import type { ManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  HostedTeamSession,
  hostedTeamArgumentError,
  type HostedTeamStore,
} from './hosted-team-session.js';

const owners: FileManagedSessionHistory[] = [];
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.close();
});

async function history(chain = false) {
  const owner = await FileManagedSessionHistory.create(tmpdir());
  owners.push(owner);
  const key = {
    tenantId: 'tenant',
    workspaceId: 'workspace',
    sessionId: 'lead',
  };
  const team = teamOpenBody({
    teamId: 'team',
    name: 'history',
    leadSessionId: key.sessionId,
  });
  const descriptionRef: ManagedSessionDurableRef = {
    resourceId: 'description',
    kind: 'managed-team-content',
    schemaVersion: 1,
    byteLength: 2,
    digest: 'a'.repeat(64),
  };
  const tasks = Array.from({ length: 257 }, (_, index) => {
    const number = 257 - index;
    const opened = teamTaskOpenBody({
      teamId: team.teamId,
      taskId: `${team.teamId}#${number}`,
      number,
      subject: `Task ${number}`,
      descriptionRef,
      activeForm: null,
      metadataRef: null,
    });
    return chain
      ? teamTaskRevisionBody(opened, {
          status: number === 1 ? 'pending' : 'completed',
          addBlockedBy: number === 1 ? [] : [`${team.teamId}#${number - 1}`],
        })
      : opened;
  });
  let head = 1;
  const taskAt = (id: string, through: number) => {
    const task = tasks.find((task) => task.taskId === id);
    return task && through > 1 && task.number === 150
      ? teamTaskRevisionBody(task, { status: 'completed' })
      : task;
  };
  const lookup = vi.fn<HostedTeamStore['authority']['extensionRecord']>(
    async (domain, id, options) => {
      const through = options?.throughSequence ?? head;
      const record =
        domain === 'team_state' && id === team.teamId
          ? through > 1
            ? teamLifecycleBody(team, 'deleted')
            : team
          : domain === 'team_task'
            ? taskAt(id, through)
            : undefined;
      return record ? { record, revision: 1 } : undefined;
    },
  );
  const commit = vi.fn(async () => {
    throw new Error('A read/refusal must not commit.');
  });
  const authority: HostedTeamStore['authority'] = {
    createQueryHistory: () => owner.emptyView(),
    get committedSequence() {
      return head;
    },
    extensionRecord: lookup,
    extensionRecordsInDomain(domain, options) {
      const through = options?.throughSequence ?? head;
      return new ManagedHistoryQuery(async function* () {
        if (domain === 'team_state') {
          yield {
            record: through > 1 ? teamLifecycleBody(team, 'deleted') : team,
          };
        } else if (domain === 'team_task') {
          for (const task of tasks)
            yield { record: taskAt(task.taskId, through)! };
        }
      });
    },
    committedExtensionOperation: async () => undefined,
    commitExtensionRecord: commit,
  };
  const session = new HostedTeamSession(
    {
      authority,
      resources: {
        read: async () => Buffer.from('{}'),
        publish: async () => {
          throw new Error('A read/refusal must not publish.');
        },
      },
    },
    key,
  );
  return {
    session,
    lookup,
    commit,
    advance: () => {
      head = 2;
    },
  };
}

const taskNumbers = (text: string) =>
  [...text.matchAll(/^#(\d+) \[/gm)].map((match) => Number(match[1]));
const nextCursor = (text: string) =>
  /with cursor "([A-Za-z0-9_-]+)"/.exec(text)?.[1];

describe('bounded team history', () => {
  it('pages after filtering/sorting and keeps the frozen prefix after the team closes', async () => {
    const fixture = await history();
    const first = await fixture.session.run(
      'task_list',
      { status: 'pending' },
      'page-1',
    );
    expect(taskNumbers(first)).toEqual(
      Array.from({ length: 100 }, (_, index) => index + 1),
    );
    const cursor = nextCursor(first)!;
    expect(JSON.parse(Buffer.from(cursor, 'base64url').toString())).toEqual({
      teamId: 'team',
      after: 100,
      throughSequence: 1,
    });
    const maximum = await fixture.session.run(
      'task_list',
      { limit: 256 },
      'maximum',
    );
    expect(taskNumbers(maximum)).toHaveLength(256);
    fixture.advance();
    const second = await fixture.session.run(
      'task_list',
      { status: 'pending', cursor },
      'page-2',
    );
    const third = await fixture.session.run(
      'task_list',
      { status: 'pending', cursor: nextCursor(second)! },
      'page-3',
    );
    expect([
      ...taskNumbers(first),
      ...taskNumbers(second),
      ...taskNumbers(third),
    ]).toEqual(Array.from({ length: 257 }, (_, index) => index + 1));
    expect(second).toContain('#150 [pending]');
    expect(nextCursor(third)).toBeUndefined();
    await expect(
      fixture.session.run('task_list', {}, 'current'),
    ).rejects.toThrow('No active team');
    expect(fixture.commit).not.toHaveBeenCalled();
  });

  it('finds a cycle through a long completed history without collecting the graph', async () => {
    const fixture = await history(true);
    const collect = vi
      .spyOn(ManagedHistoryQuery.prototype, 'collect')
      .mockImplementation(async () => {
        throw new Error('Unbounded history collection');
      });
    try {
      await expect(
        fixture.session.run(
          'task_update',
          { taskId: '1', addBlockedBy: ['257'] },
          'cycle',
        ),
      ).rejects.toThrow('dependency cycle');
      expect(
        fixture.lookup.mock.calls.filter(([domain]) => domain === 'team_task')
          .length,
      ).toBeGreaterThan(250);
      expect(collect).not.toHaveBeenCalled();
      expect(fixture.commit).not.toHaveBeenCalled();
    } finally {
      collect.mockRestore();
    }
  }, 60_000);

  it('checks page bounds and refuses malformed cursors', () => {
    for (const limit of [0, 257, 1.5])
      expect(hostedTeamArgumentError('task_list', { limit })).toContain(
        'limit',
      );
    expect(hostedTeamArgumentError('task_list', { limit: 1 })).toBeUndefined();
    expect(
      hostedTeamArgumentError('task_list', { limit: 256 }),
    ).toBeUndefined();
    expect(
      hostedTeamArgumentError('task_list', { cursor: 'broken' }),
    ).toContain('cursor');
  });
});
