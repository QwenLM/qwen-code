/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ENV_CONFIG_DIR } from '../../config/brand.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetConfigHomeDirCache } from '../../utils/paths.js';

const properLockfileMocks = vi.hoisted(() => ({
  lock: vi.fn(),
}));

vi.mock('proper-lockfile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('proper-lockfile')>();
  properLockfileMocks.lock.mockImplementation(actual.lock);
  return {
    ...actual,
    lock: properLockfileMocks.lock,
  };
});

import {
  AgentTeamReservationError,
  ensureAgentTeam,
  getAgentTeamConfigPath,
  markTeamMessageRead,
  readAgentTeamConfig,
  readTeamInbox,
  reserveAgentTeamMember,
  sendTeamMessage,
} from './agent-team-runtime.js';

describe('agent team runtime', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'test-agent-team-'));
    vi.stubEnv(ENV_CONFIG_DIR, tempDir);
    _resetConfigHomeDirCache();
    await ensureAgentTeam({
      teamName: 'session-team',
      leadSessionId: 'session-root',
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    _resetConfigHomeDirCache();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('persists business snapshots and reads only one billing batch atomically', async () => {
    const first = { version: '1', id: 'turn-1', model_key: 'ultimate' };
    const second = { version: '1', id: 'turn-2', model_key: 'auto' };
    const firstContext = { tenant: 'one' };
    const secondContext = { tenant: 'two' };
    const batches = [
      { businessInfo: first, customContext: firstContext },
      { businessInfo: second, customContext: secondContext },
      { businessInfo: first, customContext: firstContext },
    ];
    for (const batch of batches) {
      await sendTeamMessage({
        teamName: 'session-team',
        from: 'team-lead',
        to: 'worker',
        text: 'task',
        ...batch,
      });
    }
    const batch = await readTeamInbox({
      teamName: 'session-team',
      memberName: 'worker',
      unreadOnly: true,
      markRead: true,
      oneBusinessBatch: true,
    });
    expect(batch.map((message) => message.businessInfo)).toEqual([
      first,
      first,
    ]);
    expect(batch.map((message) => message.customContext)).toEqual([
      firstContext,
      firstContext,
    ]);
    const remaining = await readTeamInbox({
      teamName: 'session-team',
      memberName: 'worker',
      unreadOnly: true,
    });
    expect(remaining.map((message) => message.businessInfo)).toEqual([second]);
    expect(remaining.map((message) => message.customContext)).toEqual([
      secondContext,
    ]);
  });

  it('does not batch messages with different customContext under one business snapshot', async () => {
    const business = { version: '1', id: 'turn-1', model_key: 'auto' };
    for (const [text, customContext] of [
      ['first', { tenant: 'one' }],
      ['second', { tenant: 'two' }],
    ] as const) {
      await sendTeamMessage({
        teamName: 'session-team',
        from: 'team-lead',
        to: 'worker',
        text,
        businessInfo: business,
        customContext,
      });
    }
    const batch = await readTeamInbox({
      teamName: 'session-team',
      memberName: 'worker',
      unreadOnly: true,
      markRead: true,
      oneBusinessBatch: true,
    });
    expect(batch.map((message) => message.text)).toEqual(['first']);
    const remaining = await readTeamInbox({
      teamName: 'session-team',
      memberName: 'worker',
      unreadOnly: true,
    });
    expect(remaining.map((message) => message.text)).toEqual(['second']);
  });

  it('assigns teammate colors in roster order and cycles after eight members', async () => {
    const colors = [];
    for (let index = 0; index < 9; index++) {
      const reservation = await reserveAgentTeamMember({
        teamName: 'session-team',
        leadSessionId: 'session-root',
        member: {
          name: `worker-${index + 1}`,
          agentId: `agent-${index + 1}`,
          agentType: 'general-purpose',
          sessionId: 'session-root',
          status: 'running',
        },
      });
      colors.push(reservation.member.color);
    }

    expect(colors).toEqual([
      'red',
      'blue',
      'green',
      'yellow',
      'purple',
      'orange',
      'pink',
      'cyan',
      'red',
    ]);
    expect((await readAgentTeamConfig('session-team'))?.members).toHaveLength(
      10,
    );
  });

  it('normalizes names and appends a suffix for duplicates', async () => {
    await reserveAgentTeamMember({
      teamName: 'session-team',
      leadSessionId: 'session-root',
      member: {
        name: 'reviewer',
        agentId: 'agent-1',
        agentType: 'general-purpose',
        sessionId: 'session-root',
        status: 'running',
      },
    });

    const duplicate = await reserveAgentTeamMember({
      teamName: 'session-team',
      leadSessionId: 'session-root',
      member: {
        name: 'Reviewer',
        agentId: 'agent-2',
        agentType: 'general-purpose',
        sessionId: 'session-root',
        status: 'running',
      },
    });
    const normalized = await reserveAgentTeamMember({
      teamName: 'session-team',
      leadSessionId: 'session-root',
      member: {
        name: 'code@reviewer',
        agentId: 'agent-3',
        agentType: 'general-purpose',
        sessionId: 'session-root',
        status: 'running',
      },
    });
    const spaced = await reserveAgentTeamMember({
      teamName: 'session-team',
      leadSessionId: 'session-root',
      member: {
        name: 'code reviewer',
        agentId: 'agent-4',
        agentType: 'general-purpose',
        sessionId: 'session-root',
        status: 'running',
      },
    });

    expect(duplicate.member.name).toBe('Reviewer-2');
    expect(normalized.member.name).toBe('code-reviewer');
    expect(spaced.member.name).toBe('code reviewer');
  });

  it('rejects control characters and the main recipient name', async () => {
    const reserve = (name: string, agentId: string) =>
      reserveAgentTeamMember({
        teamName: 'session-team',
        leadSessionId: 'session-root',
        member: {
          name,
          agentId,
          agentType: 'general-purpose',
          sessionId: 'session-root',
          status: 'running',
        },
      });

    await expect(reserve('bad\nname', 'agent-1')).rejects.toMatchObject({
      name: 'AgentTeamReservationError',
      stage: 'roster_validate',
      code: 'invalid_member_name',
      commitState: 'not_written',
    });
    await expect(reserve('main', 'agent-2')).rejects.toMatchObject({
      name: 'AgentTeamReservationError',
      stage: 'roster_validate',
      code: 'reserved_member_name',
      commitState: 'not_written',
    });
  });

  it('rejects member registration before the session team is initialized', async () => {
    await expect(
      reserveAgentTeamMember({
        teamName: 'missing-team',
        leadSessionId: 'session-root',
        member: {
          name: 'reviewer',
          agentId: 'agent-1',
          agentType: 'general-purpose',
          sessionId: 'session-root',
          status: 'running',
        },
      }),
    ).rejects.toMatchObject({
      name: 'AgentTeamReservationError',
      stage: 'roster_read',
      code: 'team_not_found',
      commitState: 'not_written',
    });
  });

  it('classifies a roster owned by a different lead session', async () => {
    await expect(
      reserveAgentTeamMember({
        teamName: 'session-team',
        leadSessionId: 'another-session',
        member: {
          name: 'reviewer',
          agentId: 'agent-1',
          agentType: 'general-purpose',
          sessionId: 'another-session',
          status: 'running',
        },
      }),
    ).rejects.toMatchObject({
      name: 'AgentTeamReservationError',
      stage: 'roster_validate',
      code: 'lead_session_mismatch',
      commitState: 'not_written',
    });
  });

  it('classifies invalid roster JSON without exposing file contents', async () => {
    await writeFile(getAgentTeamConfigPath('session-team'), '{invalid', 'utf8');

    try {
      await reserveAgentTeamMember({
        teamName: 'session-team',
        leadSessionId: 'session-root',
        member: {
          name: 'reviewer',
          agentId: 'agent-1',
          agentType: 'general-purpose',
          sessionId: 'session-root',
          status: 'running',
        },
      });
      throw new Error('Expected teammate reservation to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(AgentTeamReservationError);
      expect(error).toMatchObject({
        stage: 'roster_read',
        code: 'roster_parse_failed',
        commitState: 'not_written',
        filesystemErrorCode: undefined,
      });
      expect((error as Error).message).not.toContain('{invalid');
    }
  });

  it('exposes a committed reservation for rollback when lock release fails', async () => {
    properLockfileMocks.lock.mockResolvedValueOnce(async () => {
      throw Object.assign(new Error('release failed'), { code: 'EIO' });
    });

    try {
      await reserveAgentTeamMember({
        teamName: 'session-team',
        leadSessionId: 'session-root',
        member: {
          name: 'reviewer',
          agentId: 'agent-1',
          agentType: 'general-purpose',
          sessionId: 'session-root',
          status: 'running',
        },
      });
      throw new Error('Expected teammate reservation to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(AgentTeamReservationError);
      expect(error).toMatchObject({
        stage: 'lock_release',
        code: 'roster_lock_release_failed',
        commitState: 'written',
        filesystemErrorCode: 'EIO',
      });
      expect(
        (error as AgentTeamReservationError).getReservedAgentIdForRollback(),
      ).toBe('agent-1');
    }

    expect(await readAgentTeamConfig('session-team')).toMatchObject({
      members: expect.arrayContaining([
        expect.objectContaining({ agentId: 'agent-1' }),
      ]),
    });
  });

  it('uses a UUID for each mailbox message identity', async () => {
    const message = await sendTeamMessage({
      teamName: 'session-team',
      from: 'team-lead',
      to: 'reviewer',
      text: 'Review the current implementation.',
    });

    expect(message.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('removes messages consumed while reading the inbox', async () => {
    const first = await sendTeamMessage({
      teamName: 'session-team',
      from: 'team-lead',
      to: 'reviewer',
      text: 'Review the API contract.',
    });
    const second = await sendTeamMessage({
      teamName: 'session-team',
      from: 'team-lead',
      to: 'reviewer',
      text: 'Review the tests.',
    });

    await expect(
      readTeamInbox({
        teamName: 'session-team',
        memberName: 'reviewer',
        unreadOnly: true,
        markRead: true,
      }),
    ).resolves.toEqual([first, second]);
    await expect(
      readTeamInbox({
        teamName: 'session-team',
        memberName: 'reviewer',
      }),
    ).resolves.toEqual([]);
  });

  it('removes one delivered message and preserves other unread messages', async () => {
    const delivered = await sendTeamMessage({
      teamName: 'session-team',
      from: 'team-lead',
      to: 'reviewer',
      text: 'Review the API contract.',
    });
    const pending = await sendTeamMessage({
      teamName: 'session-team',
      from: 'team-lead',
      to: 'reviewer',
      text: 'Review the tests.',
    });

    await markTeamMessageRead({
      teamName: 'session-team',
      memberName: 'reviewer',
      messageId: delivered.id,
    });

    await expect(
      readTeamInbox({
        teamName: 'session-team',
        memberName: 'reviewer',
      }),
    ).resolves.toEqual([pending]);
  });

  it('does not drop a message sent while another message is acknowledged', async () => {
    const delivered = await sendTeamMessage({
      teamName: 'session-team',
      from: 'team-lead',
      to: 'reviewer',
      text: 'Review the API contract.',
    });

    const [, pending] = await Promise.all([
      markTeamMessageRead({
        teamName: 'session-team',
        memberName: 'reviewer',
        messageId: delivered.id,
      }),
      sendTeamMessage({
        teamName: 'session-team',
        from: 'team-lead',
        to: 'reviewer',
        text: 'Review the tests.',
      }),
    ]);

    await expect(
      readTeamInbox({
        teamName: 'session-team',
        memberName: 'reviewer',
      }),
    ).resolves.toEqual([pending]);
  });
});
