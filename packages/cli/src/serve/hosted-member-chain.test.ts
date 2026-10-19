/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

const planGate = vi.hoisted(() => ({ enabled: false }));
vi.mock(
  '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js')
      >();
    return {
      ...actual,
      assertManagedSessionDomainEnabled: (
        domain: Parameters<typeof actual.assertManagedSessionDomainEnabled>[0],
      ) => {
        if (domain === 'team_plan' && planGate.enabled) return;
        actual.assertManagedSessionDomainEnabled(domain);
      },
    };
  },
);
import { sessionMessageId } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-message-operations.js';
import type { ChildSessionRun } from '@qwen-code/qwen-code-core/managed-runtime/managed-child-run-record.js';
import type { SessionMessage } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-message-record.js';
import {
  teamJoinBody,
  teamLifecycleBody,
  teamOpenBody,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-team-operations.js';
import {
  MEMBER_MESSAGE_ID_PREFIX,
  broadcastMessageId,
  broadcastRunId,
  firstInputOpensWithMemberPreamble,
  hasPlanModeBlock,
  hostedCallKey,
  hostedNeverStarted,
  hostedPromptKey,
  inputBodyText,
  isSentInstruction,
  memberMessageId,
  memberPlanModeRequired,
  memberPreambleIdentity,
  teamMemberPreamble,
} from './hosted-member-chain.js';

describe('the member preamble (H4e-b2 decision 5)', () => {
  const alice = { name: 'alice', teamName: 'review' };

  it('names the member and its team and stays under its bound', () => {
    const preamble = teamMemberPreamble(alice);
    expect(preamble).toMatch(
      /^<team-member name="alice" team="review">\n[^<]+\n<\/team-member>\n\n$/,
    );
    expect(preamble).toContain(
      'Your result is your answer to the last instruction you receive',
    );
    expect(preamble).toContain('use send_message with to "parent"');
    const longest = teamMemberPreamble({
      name: 'a'.repeat(64),
      teamName: 'b'.repeat(64),
    });
    expect(Buffer.byteLength(longest, 'utf8')).toBeLessThan(750);
  });

  it('recognizes a committed instruction by its form, not its wording', () => {
    const sent = 'fix the tests';
    expect(isSentInstruction(sent, sent)).toBe(true);
    expect(isSentInstruction(teamMemberPreamble(alice) + sent, sent)).toBe(
      true,
    );
    // A release that rewords the preamble still recognizes what an earlier
    // one committed.
    expect(
      isSentInstruction(
        '<team-member name="alice" team="review">\nAn older wording.\n</team-member>\n\n' +
          sent,
        sent,
      ),
    ).toBe(true);
    for (const committed of [
      teamMemberPreamble(alice) + 'another text',
      teamMemberPreamble(alice) + teamMemberPreamble(alice) + sent,
      '<team-member name="Alice" team="review">\nx\n</team-member>\n\n' + sent,
      '<team-member name="alice" team="review">\n<b>x</b>\n</team-member>\n\n' +
        sent,
      `${sent}\n${teamMemberPreamble(alice)}`,
    ])
      expect(isSentInstruction(committed, sent)).toBe(false);
  });
});

describe('plan mode (H4e-b3a, decisions 5 and 9)', () => {
  const alice = { name: 'alice', teamName: 'review' };

  it('composes the attribute into the preamble and the form still matches', () => {
    const required = teamMemberPreamble(alice, true);
    expect(required).toContain(' plan-mode="required">');
    expect(required).not.toContain('exit_plan_mode');
    const sent = 'fix the tests';
    expect(isSentInstruction(required + sent, sent)).toBe(true);
    expect(isSentInstruction(teamMemberPreamble(alice) + sent, sent)).toBe(
      true,
    );
    expect(isSentInstruction(required + 'other', sent)).toBe(false);
  });

  it('advertises submission only while the plan domain is enabled', () => {
    planGate.enabled = true;
    try {
      expect(teamMemberPreamble(alice, true)).toContain('exit_plan_mode');
      expect(teamMemberPreamble(alice)).not.toContain('exit_plan_mode');
    } finally {
      planGate.enabled = false;
    }
    expect(teamMemberPreamble(alice, true)).not.toContain('exit_plan_mode');
  });

  it('reads the attribute only on an unescaped well-formed line', () => {
    expect(hasPlanModeBlock('')).toBe(false);
    expect(hasPlanModeBlock(teamMemberPreamble(alice))).toBe(false);
    expect(hasPlanModeBlock(teamMemberPreamble(alice, true))).toBe(true);
    // A continuation's history is XML-escaped, so only the run's own
    // instruction matches.
    const history =
      '&lt;team-member name="alice" team="review" plan-mode="required"&gt;';
    expect(hasPlanModeBlock(history)).toBe(false);
    expect(
      hasPlanModeBlock(`${history}\n${teamMemberPreamble(alice, true)}more`),
    ).toBe(true);
    // Unknown names or a mistyped keyword never arm it.
    expect(
      hasPlanModeBlock(
        '<team-member name="Alice" team="review" plan-mode="required">\n',
      ),
    ).toBe(false);
  });

  it('holds plan mode until an approved plan of the member exists', () => {
    const team = teamJoinBody(
      teamOpenBody({
        teamId: 'prompt:team',
        name: 'review',
        leadSessionId: 'lead',
      }),
      {
        name: 'alice',
        childRunId: 'run-1',
        planModeRequired: true,
      },
    );
    const refOf = {
      resourceId: 'plan-1',
      kind: 'managed-team-content',
      schemaVersion: 1,
      byteLength: 4,
      digest: 'd'.repeat(64),
    };
    const runOf = (state: string) => ({
      state,
      reason: null,
      definition: null,
      executionCallId: null,
      effectId: null,
      dispatchId: null,
      deliveryId: null,
      execution: null,
      runtime: null,
      delivery: null,
    });
    const planOf = (over: Record<string, unknown> = {}) => ({
      record: {
        teamId: 'prompt:team',
        requestId: 'request-1',
        member: 'alice',
        planRevision: 1,
        planRef: refOf,
        decision: null,
        feedbackRef: null,
        run: runOf('waiting'),
        ...over,
      },
    });
    // No roster flag, nothing to read.
    expect(memberPlanModeRequired(team, [], 'bob')).toBe(false);
    expect(memberPlanModeRequired(team, [], 'alice')).toBe(true);
    // Waiting and rejected plans keep the mode; approval lifts it.
    expect(memberPlanModeRequired(team, [planOf()], 'alice')).toBe(true);
    expect(
      memberPlanModeRequired(
        team,
        [planOf({ decision: 'rejected', run: runOf('settled') })],
        'alice',
      ),
    ).toBe(true);
    expect(
      memberPlanModeRequired(
        team,
        [
          planOf({
            decision: 'approved',
            feedbackRef: refOf,
            run: runOf('settled'),
          }),
        ],
        'alice',
      ),
    ).toBe(false);
    // Plan mode is a rule of an open team only.
    expect(
      memberPlanModeRequired(teamLifecycleBody(team, 'deleted'), [], 'alice'),
    ).toBe(false);
  });
});

describe('the text of an input body (H4e-b3a)', () => {
  it('reads a bare {text} body and a body of content parts', () => {
    expect(inputBodyText({ text: 'fix the tests' })).toBe('fix the tests');
    expect(
      inputBodyText([
        { type: 'text', text: 'review this' },
        { type: 'text', text: 'and that' },
      ]),
    ).toBe('review this\nand that');
    expect(inputBodyText([{ type: 'text', text: 'only one' }])).toBe(
      'only one',
    );
    // Parts without a text string do not mint one.
    expect(
      inputBodyText([
        { type: 'image', url: 'data' },
        { text: 42 },
        'a bare string part',
        null,
        { type: 'text', text: 'kept' },
      ]),
    ).toBe('kept');
  });

  it('reads nothing where no part carries a text string', () => {
    expect(inputBodyText(undefined)).toBeUndefined();
    expect(inputBodyText(null)).toBeUndefined();
    expect(inputBodyText('a bare string')).toBeUndefined();
    expect(inputBodyText({})).toBeUndefined();
    expect(inputBodyText({ text: 42 })).toBeUndefined();
    expect(inputBodyText([])).toBeUndefined();
    expect(inputBodyText([{ type: 'image', url: 'data' }])).toBeUndefined();
  });
});

describe('broadcast ids (H4e-b2 decision 4)', () => {
  it('live where no single send or launch can reach them', () => {
    const runId = broadcastRunId('prompt', 'call-all', 1);
    expect(runId).toMatch(/^bcast_[0-9a-f]{32}$/);
    // Every single-send and launch run id is a call key, with a colon.
    expect(hostedCallKey('prompt', runId)).toBe(`prompt:${runId}`);
    expect(runId).not.toContain(':');
    const messageId = broadcastMessageId({
      senderSessionId: 'lead',
      turnId: 'prompt',
      callId: 'call-all',
      position: 1,
    });
    expect(messageId).toMatch(/^msgb_[0-9a-f]{32}$/);
    // A plain call whose provider id equals either derived value mints
    // ids of its own.
    for (const callId of [runId, messageId])
      expect(
        sessionMessageId({ senderSessionId: 'lead', turnId: 'prompt', callId }),
      ).toMatch(/^msg_[0-9a-f]{32}$/);
  });

  it('separate calls, positions and Turns', () => {
    const ids = new Set([
      broadcastRunId('prompt', 'call-all', 1),
      broadcastRunId('prompt', 'call-all', 2),
      broadcastRunId('prompt', 'call-other', 1),
      broadcastRunId('prompt-2', 'call-all', 1),
    ]);
    expect(ids.size).toBe(4);
    // A wake turn's prompt id collapses, as its call keys do.
    const wake = 'msg_x:message:accept:notify';
    expect(hostedPromptKey(wake)).toMatch(/^[0-9a-f]{16}$/);
    expect(broadcastRunId(wake, 'c', 1)).toBe(broadcastRunId(wake, 'c', 1));
  });

  it('collapses a blocked notification turn as a child acceptance is collapsed', () => {
    // #14387: the blocked notification's wake turn embeds the run it
    // settled (`<run>:blocked:notify`) exactly as an acceptance does.
    // Keyed verbatim, each blocked hop appends a whole run id to the next
    // launch — 66, 111, 156 chars for a 36-char Turn id and a 29-char
    // call id — and the third create meets the 128-char lineage bound.
    const callId = 'call-0123456789abcdef01234567';
    const promptId = 'b3f0c1a2-4d5e-4f60-8a91-b2c3d4e5f607';
    const run = hostedCallKey(promptId, callId);
    expect(run).toHaveLength(66);
    const blocked = `${run}:blocked:notify`;
    expect(hostedPromptKey(blocked)).toMatch(/^[0-9a-f]{16}$/);
    const hops = [hostedCallKey(blocked, callId)];
    hops.push(hostedCallKey(`${hops[0]}:blocked:notify`, callId));
    hops.push(hostedCallKey(`${hops[1]}:blocked:notify`, callId));
    // Every blocked hop stays at the acceptance's bounded length.
    expect(hops.map((hop) => hop.length)).toEqual([46, 46, 46]);
    expect(hostedCallKey(`${run}:accept:notify`, callId)).toHaveLength(46);
  });
});

describe('member-message ids (H4e-b3 decision 8, b3c)', () => {
  it('live where no send, broadcast or command id can reach them', () => {
    const id = memberMessageId({
      leadSessionId: 'lead',
      commandId: 'cmd_x',
      position: 2,
    });
    expect(id).toMatch(/^msgc_[0-9a-f]{32}$/);
    // The minter and its consumers read the one prefix constant, or the
    // member caps silently stop bounding (R1-9).
    expect(id.startsWith(MEMBER_MESSAGE_ID_PREFIX)).toBe(true);
    // Separate leads, commands and positions.
    expect(
      new Set([
        id,
        memberMessageId({
          leadSessionId: 'lead-2',
          commandId: 'cmd_x',
          position: 2,
        }),
        memberMessageId({
          leadSessionId: 'lead',
          commandId: 'cmd_y',
          position: 2,
        }),
        memberMessageId({
          leadSessionId: 'lead',
          commandId: 'cmd_x',
          position: 3,
        }),
      ]).size,
    ).toBe(4);
    expect(
      broadcastMessageId({
        senderSessionId: 'lead',
        turnId: 't',
        callId: 'c',
        position: 2,
      }),
    ).toMatch(/^msgb_/);
  });
});

describe('member messages lift the preamble sentences (b3c decision 8)', () => {
  const alice = { name: 'alice', teamName: 'review' };

  it('stops forbidding member messages once commands are enabled', () => {
    const preamble = teamMemberPreamble(alice);
    expect(preamble).not.toContain('cannot message');
    expect(preamble).not.toContain('task board');
    expect(preamble).toContain('use send_message with to "parent"');
  });

  it('separates the plan-mode sentence with exactly one space', () => {
    const preamble = teamMemberPreamble(alice, true);
    expect(preamble).toContain(' plan-mode="required"');
    const body = preamble.split('\n')[1]!;
    expect(body).toContain(
      'You are in plan mode until the leader approves your plan:',
    );
    // The junction itself stands: a zero-space composition would glue
    // "instruction" straight onto "You", and only / {2}/ never notices.
    expect(body).toContain('next instruction. You are in plan mode');
    expect(body).not.toMatch(/ {2}/);
  });

  it('ends the default commands-enabled body without trailing whitespace (R1-11)', () => {
    const body = teamMemberPreamble(alice).split('\n')[1]!;
    expect(body).not.toMatch(/\s$/);
  });
});

describe('the member preamble identity (b3c decision 5)', () => {
  const alice = { name: 'alice', teamName: 'review' };
  const identity = { name: 'alice', team: 'review' };

  it('agrees with the boolean gate on every cut (R1-9)', () => {
    for (const input of [
      teamMemberPreamble(alice),
      '[review the change]\n\n' + teamMemberPreamble(alice),
      'earlier work happened.\nYour next instruction: ' +
        teamMemberPreamble(alice, true) +
        'do the work',
      'plain text',
      'nothing to [see] here',
    ]) {
      expect(firstInputOpensWithMemberPreamble(input)).toBe(
        memberPreambleIdentity(input) !== undefined,
      );
    }
  });

  it('reads the member from the launch envelope and the continuation marker', () => {
    expect(memberPreambleIdentity(teamMemberPreamble(alice))).toEqual(identity);
    expect(
      memberPreambleIdentity(
        '[review the change]\n\n' + teamMemberPreamble(alice),
      ),
    ).toEqual(identity);
    expect(
      memberPreambleIdentity(
        'earlier work happened.\nYour next instruction: ' +
          teamMemberPreamble(alice, true) +
          'do the work',
      ),
    ).toEqual(identity);
    expect(memberPreambleIdentity('plain text')).toBeUndefined();
  });
});

describe('never-started notes (b3c decision 8)', () => {
  it('leave member messages out of the lost-messages count', () => {
    const run = {
      childRunId: 'run-1',
      predecessorChildRunId: 'run-0',
      stopReason: 'creation_failed',
      run: { state: 'failed' },
    } as unknown as ChildSessionRun;
    const msgc = {
      messageId: 'msgc_x',
      childRunId: 'run-1',
    } as unknown as SessionMessage;
    const lead = {
      messageId: 'msg_y',
      childRunId: 'run-1',
    } as unknown as SessionMessage;
    const other = {
      messageId: 'msg_z',
      childRunId: 'run-2',
    } as unknown as SessionMessage;
    expect(hostedNeverStarted(run, [msgc, lead, other]).lostMessages).toBe(1);
    expect(hostedNeverStarted(run, [msgc]).lostMessages).toBe(0);
  });
});
