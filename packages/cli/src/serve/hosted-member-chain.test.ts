/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { sessionMessageId } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-message-operations.js';
import {
  teamJoinBody,
  teamLifecycleBody,
  teamOpenBody,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-team-operations.js';
import {
  broadcastMessageId,
  broadcastRunId,
  hasPlanModeBlock,
  hostedCallKey,
  hostedPromptKey,
  isSentInstruction,
  memberPlanModeRequired,
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
});
