/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  openManagedSession,
  type ManagedSession,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import {
  decodeChildLaunchEnvelope,
  MANAGED_CHILD_LIMITS,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-child-operations.js';
import { parseChildRun } from '@qwen-code/qwen-code-core/managed-runtime/managed-child-run-record.js';
import { parseSessionMessage } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-message-record.js';
import { ManagedSessionConflictError } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import {
  CHILD_NOTIFICATION_INLINE_LIMIT,
  ChildMessagesPendingError,
  HostedChildAgentSession,
} from './hosted-child-agent-session.js';
import {
  HostedSessionMessageSession,
  memberMessageContent,
  memberMessageNotificationText,
  parseMemberMessageContent,
  SessionMessageNotReadyError,
  sessionMessageNotificationText,
  withSessionMessageConsumption,
} from './hosted-session-message-session.js';

import { HostedTeamSession } from './hosted-team-session.js';
import { teamMemberPreamble } from './hosted-member-chain.js';
import { teamLifecycleBody } from '@qwen-code/qwen-code-core/managed-runtime/managed-team-operations.js';
import { parseTeamState } from '@qwen-code/qwen-code-core/managed-runtime/managed-team-record.js';

// H4d-b: `session_message` and continuations are enabled for real, so the
// suite drives both funnels with no enablement mock.

const roots: string[] = [];
const sessions: ManagedSession[] = [];
const PARENT = randomUUID();
const CHILD = randomUUID();
const DEFINITION = {
  definitionId: 'hosted-agent/hosted-workspace-shell/1',
  definitionRevision: 1,
  definitionDigest: 'f'.repeat(64),
};
const BINDING = { runtimeBindingId: 'binding-1', generation: '1' };

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function open(sessionId: string): Promise<ManagedSession> {
  const root = await mkdtemp(path.join(tmpdir(), 'hosted-message-'));
  roots.push(root);
  const sessionKey = {
    tenantId: 'tenant',
    workspaceId: 'workspace',
    sessionId,
  };
  const resources = LocalManagedSessionResourceStore.create({
    runtimeBaseDir: root,
    sessionKey,
  });
  const session = await openManagedSession({
    runtimeBaseDir: root,
    cwd: root,
    transcriptPath: path.join(root, 'transcript.jsonl'),
    sessionId,
    sessionKey,
    version: 'test',
    workerId: 'worker',
    activationLeaseDurationMs: 60_000,
    create: {
      definitionRef: await resources.publish(
        'managed-definition',
        Buffer.from('{}'),
      ),
      rootSnapshotRef: await resources.publish(
        'managed-root',
        Buffer.from('{}'),
      ),
      createdBy: 'test',
    },
  });
  sessions.push(session);
  return session;
}

interface Side {
  readonly session: ManagedSession;
  readonly children: HostedChildAgentSession;
  readonly messages: HostedSessionMessageSession;
}

async function side(
  sessionId: string,
  lineage?: { parentSessionId: string; parentChildRunId: string },
): Promise<Side> {
  const session = await open(sessionId);
  const store = { authority: session.authority, resources: session.resources };
  const key = session.authority.sessionHeader.sessionKey;
  const children = new HostedChildAgentSession(store, key);
  return {
    session,
    children,
    messages: new HostedSessionMessageSession(store, key, children, lineage),
  };
}

async function launch(
  children: HostedChildAgentSession,
  childRunId = 'run-1',
): Promise<void> {
  await children.admit({
    childRunId,
    ownerScopeId: PARENT,
    rootSessionId: PARENT,
    completion: 'sent',
    description: 'audit the diff',
    prompt: 'review the change',
    definition: DEFINITION,
    workingDirectory: '.',
    workspaceMode: 'shared',
    executionCallId: childRunId,
  });
}

async function attach(
  children: HostedChildAgentSession,
  childRunId = 'run-1',
  childSessionId = CHILD,
): Promise<void> {
  await children.dispatchStarted(childRunId, {
    dispatchId: `dispatch-${childRunId}`,
    runtime: BINDING,
  });
  await children.attach(childRunId, childSessionId);
}

async function complete(
  children: HostedChildAgentSession,
  childRunId = 'run-1',
  messageCount = 0,
): Promise<void> {
  await children.settleCompleted(childRunId, {
    result: Buffer.from(`result of ${childRunId}`),
    receipt: Buffer.from('{}'),
    messageCount,
  });
}

function send(
  children: HostedChildAgentSession,
  text: string,
  call = 'call-9',
  closing = false,
) {
  return children.sendToChild({
    taskId: children.taskIdOf('run-1'),
    text,
    messageId: `msg_${call}`,
    continuationRunId: `prompt:${call}`,
    executionCallId: `prompt:${call}`,
    closing,
  });
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Settles the turn a message's input started, as the wake runner does. */
async function settleTurn(
  session: ManagedSession,
  turnId: string,
  state: 'completed' | 'cancelled',
): Promise<void> {
  await session.sink.write({
    uuid: randomUUID(),
    parentUuid: null,
    sessionId: session.authority.sessionHeader.sessionKey.sessionId,
    timestamp: new Date().toISOString(),
    type: 'system',
    cwd: '/workspace',
    version: 'test',
    subtype: 'turn_result',
    systemPayload: {
      promptId: turnId,
      state,
      stopReason: 'end_turn',
      endedAt: Date.now(),
    },
  });
}

function inputs(session: ManagedSession) {
  const authority = session.authority;
  return authority
    .eventsInSequenceRange(1, authority.committedSequence)
    .filter((event) => event.kind === 'input.accepted');
}

describe('send_message to a child task (H4d-b)', () => {
  it('opens the outbox entry of a running child and replays it', async () => {
    const parent = await side(PARENT);
    await launch(parent.children);
    expect(await send(parent.children, 'also check the tests')).toEqual({
      kind: 'message',
      childRunId: 'run-1',
    });
    const committed = parent.messages.message('msg_call-9')!;
    expect(committed).toMatchObject({
      direction: 'outbound',
      route: 'to_child',
      childRunId: 'run-1',
      senderSessionId: PARENT,
      targetSessionId: null,
      inputId: null,
      contentDigest: sha256('also check the tests'),
    });
    expect(committed.run.delivery?.state).toBe('planned');
    const revisions = parent.session.authority.committedSequence;
    expect(await send(parent.children, 'also check the tests')).toEqual({
      kind: 'message',
      childRunId: 'run-1',
    });
    expect(parent.session.authority.committedSequence).toBe(revisions);
    await expect(send(parent.children, 'something else')).rejects.toThrow(
      ManagedSessionConflictError,
    );
  });

  it('holds the child settlement until the message is handed over', async () => {
    const parent = await side(PARENT);
    await launch(parent.children);
    await attach(parent.children);
    await send(parent.children, 'also check the tests');
    expect(parent.children.undeliveredMessagesTo('run-1')).toBe(1);
    await expect(complete(parent.children)).rejects.toThrow(
      ChildMessagesPendingError,
    );
    await parent.messages.handover('msg_call-9', CHILD);
    await expect(complete(parent.children)).rejects.toThrow(
      ChildMessagesPendingError,
    );
    await parent.messages.accepted('msg_call-9', 'msg_call-9:message');
    expect(parent.children.undeliveredMessagesTo('run-1')).toBe(0);
    // A settlement that did not see the message (it opened after the
    // caller's read and was handed over since) is refused all the same.
    await expect(complete(parent.children, 'run-1', 0)).rejects.toThrow(
      ChildMessagesPendingError,
    );
    await complete(parent.children, 'run-1', 1);
    expect(parent.children.record('run-1')?.run.state).toBe('settled');
    // A failure chosen from the child's newest turn names what it saw; a
    // give-up names nothing and never waits.
    await launch(parent.children, 'run-2');
    await attach(parent.children, 'run-2', randomUUID());
    await parent.children.sendToChild({
      taskId: parent.children.taskIdOf('run-2'),
      text: 'stop early',
      messageId: 'msg_call-10',
      continuationRunId: 'prompt:call-10',
      executionCallId: 'prompt:call-10',
      closing: false,
    });
    await expect(
      parent.children.settleFailed('run-2', {
        stopReason: 'child_failed',
        reason: null,
        started: true,
        messageCount: 1,
      }),
    ).rejects.toThrow(ChildMessagesPendingError);
    await parent.children.settleFailed('run-2', {
      stopReason: 'child_failed',
      reason: null,
      started: true,
    });
    expect(parent.children.record('run-2')?.run.state).toBe('failed');
  });

  it('bounds the messages in flight and in all per child run', async () => {
    const parent = await side(PARENT);
    await launch(parent.children);
    for (let index = 0; index < 8; index++) {
      expect(await send(parent.children, `m${index}`, `call-${index}`)).toEqual(
        { kind: 'message', childRunId: 'run-1' },
      );
    }
    const crowded = await send(parent.children, 'one too many', 'call-8');
    expect(JSON.stringify(crowded)).toContain('count_limit');
    // A message ended or handed over frees its place, whether or not the
    // turn that reads it completes; the lifetime budget stays.
    await parent.messages.settle('msg_call-0', 'cancelled');
    expect(await send(parent.children, 'room again', 'call-9')).toEqual({
      kind: 'message',
      childRunId: 'run-1',
    });
    expect(
      JSON.stringify(await send(parent.children, 'crowded', 'call-10')),
    ).toContain('count_limit');
    await attach(parent.children);
    await parent.messages.handover('msg_call-1', CHILD);
    await parent.messages.accepted('msg_call-1', 'msg_call-1:message');
    expect(await send(parent.children, 'handed over', 'call-11')).toEqual({
      kind: 'message',
      childRunId: 'run-1',
    });
    expect(parent.children.messagesTo('run-1')).toHaveLength(10);
  });

  // #13753 I2: a continuation is a launch, and a worktree run needs a host
  // that serves child Workspaces exactly as its first launch did.
  it('continues a completed worktree child only on a host that serves child Workspaces', async () => {
    const parent = await side(PARENT);
    await parent.children.admit({
      childRunId: 'run-1',
      ownerScopeId: PARENT,
      rootSessionId: PARENT,
      completion: 'sent',
      description: 'audit the diff',
      prompt: 'review the change',
      definition: DEFINITION,
      workingDirectory: '.',
      workspaceMode: 'worktree',
      executionCallId: 'run-1',
    });
    await attach(parent.children);
    await complete(parent.children);
    const continuation = (childWorkspaces: boolean, call: string) =>
      parent.children.sendToChild({
        taskId: parent.children.taskIdOf('run-1'),
        text: 'now check the tests',
        messageId: `msg_${call}`,
        continuationRunId: `prompt:${call}`,
        executionCallId: `prompt:${call}`,
        closing: false,
        childWorkspaces,
      });
    const refused = await continuation(false, 'call-1');
    expect(refused).toMatchObject({ kind: 'refused' });
    expect(parent.children.record('prompt:call-1')).toBeUndefined();
    const continued = await continuation(true, 'call-2');
    expect(continued).toMatchObject({ kind: 'continuation' });
    expect(parent.children.record('prompt:call-2')?.workspaceMode).toBe(
      'worktree',
    );
  });

  // #13753 I3: a snapshot child has no message lane, so a message to it
  // while it runs is refused before anything commits; once it completes,
  // the message continues it as a new snapshot, on a host that serves them.
  it('refuses a running snapshot child and continues a completed one only where snapshots are served', async () => {
    const parent = await side(PARENT);
    await parent.children.admit({
      childRunId: 'run-1',
      ownerScopeId: PARENT,
      rootSessionId: PARENT,
      completion: 'sent',
      description: 'audit the diff',
      prompt: 'review the change',
      definition: DEFINITION,
      workingDirectory: '.',
      workspaceMode: 'snapshot',
      executionCallId: 'run-1',
    });
    const sendSnapshot = (
      call: string,
      childSnapshots: boolean,
      closing = false,
    ) =>
      parent.children.sendToChild({
        taskId: parent.children.taskIdOf('run-1'),
        text: 'now check the tests',
        messageId: `msg_${call}`,
        continuationRunId: `prompt:${call}`,
        executionCallId: `prompt:${call}`,
        closing,
        childWorkspaces: true,
        childSnapshots,
      });
    // A running worktree child still takes messages: only a snapshot has
    // no lane for them.
    await parent.children.admit({
      childRunId: 'run-2',
      ownerScopeId: PARENT,
      rootSessionId: PARENT,
      completion: 'sent',
      description: 'edit the code',
      prompt: 'fix the bug',
      definition: DEFINITION,
      workingDirectory: '.',
      workspaceMode: 'worktree',
      executionCallId: 'run-2',
    });
    expect(
      await parent.children.sendToChild({
        taskId: parent.children.taskIdOf('run-2'),
        text: 'also check the tests',
        messageId: 'msg_call-w',
        continuationRunId: 'prompt:call-w',
        executionCallId: 'prompt:call-w',
        closing: false,
        childWorkspaces: true,
        childSnapshots: true,
      }),
    ).toEqual({ kind: 'message', childRunId: 'run-2' });
    const running = await sendSnapshot('call-1', true);
    expect(running).toMatchObject({ kind: 'refused' });
    expect((running as { reason: string }).reason).toContain(
      'is a read-only snapshot and takes no messages while it runs',
    );
    expect(parent.messages.message('msg_call-1')).toBeUndefined();
    expect(parent.children.messagesTo('run-1')).toHaveLength(0);
    await attach(parent.children);
    expect(await sendSnapshot('call-2', true)).toMatchObject({
      kind: 'refused',
    });
    expect(parent.children.messagesTo('run-1')).toHaveLength(0);
    // A closing Session admits no continuation, so its refusal must not
    // promise one.
    const closing = await sendSnapshot('call-c', true, true);
    expect(closing).toEqual({
      kind: 'refused',
      reason: 'This Session is closing and sends no more messages.',
    });
    expect(parent.messages.message('msg_call-c')).toBeUndefined();
    expect(parent.children.messagesTo('run-1')).toHaveLength(0);
    await complete(parent.children);
    expect(await sendSnapshot('call-3', false)).toMatchObject({
      kind: 'refused',
    });
    expect(parent.children.record('prompt:call-3')).toBeUndefined();
    expect(await sendSnapshot('call-4', true)).toMatchObject({
      kind: 'continuation',
    });
    expect(parent.children.record('prompt:call-4')?.workspaceMode).toBe(
      'snapshot',
    );
  });

  it('continues a completed child with the message as its next prompt', async () => {
    const parent = await side(PARENT);
    await launch(parent.children);
    await attach(parent.children);
    await complete(parent.children);
    expect(await send(parent.children, 'now fix the tests')).toEqual({
      kind: 'continuation',
      childRunId: 'prompt:call-9',
      predecessorChildRunId: 'run-1',
    });
    const continued = parent.children.record('prompt:call-9')!;
    expect(continued).toMatchObject({
      predecessorChildRunId: 'run-1',
      completion: 'sent',
      ownerScopeId: PARENT,
      depth: 1,
    });
    expect(continued.run.definition).toEqual(DEFINITION);
    const envelope = decodeChildLaunchEnvelope(
      await parent.session.resources.read(continued.inputRef),
    );
    expect(envelope).toEqual({
      description: 'audit the diff',
      prompt: 'now fix the tests',
      definition: DEFINITION,
    });
    // The replay names the same continuation; the original task id now
    // reaches the newest run, which takes a message while it runs.
    expect(await send(parent.children, 'now fix the tests')).toEqual({
      kind: 'continuation',
      childRunId: 'prompt:call-9',
      predecessorChildRunId: 'run-1',
    });
    expect(await send(parent.children, 'and the docs', 'call-11')).toEqual({
      kind: 'message',
      childRunId: 'prompt:call-9',
    });
  });

  it('releases a predecessor whose continuation never started', async () => {
    const parent = await side(PARENT);
    await launch(parent.children);
    await attach(parent.children);
    await complete(parent.children);
    await send(parent.children, 'first try');
    await parent.children.settleFailed('prompt:call-9', {
      stopReason: 'creation_failed',
      reason: null,
      started: false,
    });
    // The next continuation says the one before it never started (H4e-b2),
    // and a replay of that one says its own message never arrived.
    const neverStarted = {
      childRunId: 'prompt:call-9',
      predecessorChildRunId: 'run-1',
      reason: 'creation_failed',
      cancelled: false,
      lostMessages: 0,
    };
    expect(await send(parent.children, 'second try', 'call-12')).toEqual({
      kind: 'continuation',
      childRunId: 'prompt:call-12',
      predecessorChildRunId: 'run-1',
      previousNeverStarted: neverStarted,
    });
    expect(await send(parent.children, 'first try')).toEqual({
      kind: 'continuation',
      childRunId: 'prompt:call-9',
      predecessorChildRunId: 'run-1',
      ownNeverStarted: neverStarted,
    });
  });

  it('refuses an ended child, an unknown task, the bound and a closing parent', async () => {
    const parent = await side(PARENT);
    await launch(parent.children);
    const unknown = await parent.children.sendToChild({
      taskId: 'task_missing',
      text: 'hello',
      messageId: 'msg_call-1',
      continuationRunId: 'prompt:call-1',
      executionCallId: 'prompt:call-1',
      closing: false,
    });
    expect(unknown).toMatchObject({ kind: 'refused' });
    expect(JSON.stringify(unknown)).toContain('No child agent task');
    const oversized = await send(parent.children, 'x'.repeat(33 * 1024));
    expect(JSON.stringify(oversized)).toContain('byte_limit');
    const closingMessage = await send(parent.children, 'more', 'call-4', true);
    expect(JSON.stringify(closingMessage)).toContain('closing');
    await attach(parent.children);
    await complete(parent.children);
    const closing = await send(parent.children, 'more', 'call-2', true);
    expect(JSON.stringify(closing)).toContain('closing');
    await launch(parent.children, 'run-3');
    await parent.children.settleFailed('run-3', {
      stopReason: 'creation_failed',
      reason: null,
      started: false,
    });
    const ended = await parent.children.sendToChild({
      taskId: parent.children.taskIdOf('run-3'),
      text: 'hello',
      messageId: 'msg_call-3',
      continuationRunId: 'prompt:call-3',
      executionCallId: 'prompt:call-3',
      closing: false,
    });
    expect(JSON.stringify(ended)).toContain('cannot receive messages');
    expect(
      parent.session.authority.extensionRecordsInDomain('session_message'),
    ).toHaveLength(0);
    expect(
      parent.session.authority
        .extensionRecordsInDomain('child_run')
        .map((entry) => parseChildRun(entry.record))
        .filter((run) => 'predecessorChildRunId' in run)
        .map((run) => run.childRunId),
    ).toEqual(['run-1', 'run-3']);
  });
});

describe('the session message funnel (H4d-b)', () => {
  it('walks the outbox entry through each relay step, step-aware', async () => {
    const parent = await side(PARENT);
    await launch(parent.children);
    await send(parent.children, 'one');
    // The target is the Session the run attached, never another.
    await expect(parent.messages.handover('msg_call-9', CHILD)).rejects.toThrow(
      'must target the Session its run attached',
    );
    await attach(parent.children);
    await parent.messages.handover('msg_call-9', CHILD);
    await parent.messages.handover('msg_call-9', CHILD);
    await expect(
      parent.messages.handover('msg_call-9', randomUUID()),
    ).rejects.toThrow(ManagedSessionConflictError);
    // Only the input the message id derives can carry it.
    await expect(
      parent.messages.accepted('msg_call-9', 'msg_call-9:other'),
    ).rejects.toThrow('is carried by msg_call-9:message');
    await parent.messages.accepted('msg_call-9', 'msg_call-9:message');
    await parent.messages.accepted('msg_call-9', 'msg_call-9:message');
    await parent.messages.settle('msg_call-9', 'consumed');
    await parent.messages.settle('msg_call-9', 'consumed');
    expect(parent.messages.message('msg_call-9')).toMatchObject({
      targetSessionId: CHILD,
      inputId: 'msg_call-9:message',
    });
    expect(parent.messages.message('msg_call-9')?.run.delivery?.state).toBe(
      'consumed',
    );
    await send(parent.children, 'two', 'call-13');
    await parent.messages.settle('msg_call-13', 'cancelled');
    await expect(
      parent.messages.handover('msg_call-13', CHILD),
    ).rejects.toThrow(ManagedSessionConflictError);
    await expect(
      parent.messages.settle('msg_call-13', 'rejected'),
    ).rejects.toThrow(ManagedSessionConflictError);
  });

  it('receives a child message with its input and wake, once, and consumes it', async () => {
    const parent = await side(PARENT);
    await launch(parent.children);
    const receipt = {
      messageId: 'msg_from-child',
      route: 'to_parent' as const,
      childRunId: 'run-1',
      senderSessionId: CHILD,
      content: Buffer.from('which branch should I use?'),
      contentDigest: sha256('which branch should I use?'),
    };
    await expect(parent.messages.receive(receipt)).rejects.toThrow(
      SessionMessageNotReadyError,
    );
    await attach(parent.children);
    expect(await parent.messages.receive(receipt)).toBe(
      'msg_from-child:message',
    );
    expect(await parent.messages.receive(receipt)).toBe(
      'msg_from-child:message',
    );
    const accepted = inputs(parent.session);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.payload).toMatchObject({
      inputId: 'msg_from-child:message',
      turnId: 'msg_from-child:message',
      source: 'session_message',
    });
    const content = JSON.parse(
      (
        await parent.session.resources.read(
          accepted[0]!.payload['contentRef'] as never,
        )
      ).toString('utf8'),
    ) as { text: string };
    expect(content.text).toContain(
      `<from>child agent ${parent.children.taskIdOf('run-1')}</from>`,
    );
    expect(content.text).toContain('which branch should I use?');
    const authority = parent.session.authority;
    expect(
      authority
        .eventsInSequenceRange(1, authority.committedSequence)
        .some(
          (event) =>
            event.kind === 'wake.requested' &&
            event.eventId === 'msg_from-child:message:wake',
        ),
    ).toBe(true);
    await expect(
      parent.messages.receive({
        ...receipt,
        content: Buffer.from('another question'),
        contentDigest: sha256('another question'),
      }),
    ).rejects.toThrow(ManagedSessionConflictError);
    // The relay's reconciliation: nothing read it yet, then its turn
    // completed and the receipt follows (the commit after it was lost).
    await expect(parent.messages.consume('msg_from-child')).rejects.toThrow(
      SessionMessageNotReadyError,
    );
    await settleTurn(parent.session, 'msg_from-child:message', 'completed');
    await parent.messages.consume('msg_from-child');
    await parent.messages.consume('msg_from-child');
    await parent.messages.markConsumed('msg_from-child:message');
    await parent.messages.markConsumed('unrelated:input');
    const inbound = parseSessionMessage(
      authority.extensionRecord('session_message', 'msg_from-child')!.record,
    );
    expect(inbound.direction).toBe('inbound');
    expect(inbound.run.delivery?.state).toBe('consumed');
  });

  it('never consumes a message whose reading turn ended otherwise', async () => {
    const parent = await side(PARENT);
    await launch(parent.children);
    await attach(parent.children);
    await parent.messages.receive({
      messageId: 'msg_q',
      route: 'to_parent',
      childRunId: 'run-1',
      senderSessionId: CHILD,
      content: Buffer.from('question'),
      contentDigest: sha256('question'),
    });
    await settleTurn(parent.session, 'msg_q:message', 'cancelled');
    await expect(parent.messages.consume('msg_q')).rejects.toThrow(
      'ended cancelled',
    );
    expect(parent.messages.message('msg_q')?.run.delivery?.state).toBe(
      'accepted',
    );
  });

  it('refuses a message from an unknown child run before publishing', async () => {
    const parent = await side(PARENT);
    await expect(
      parent.messages.receive({
        messageId: 'msg_stray',
        route: 'to_parent',
        childRunId: 'run-none',
        senderSessionId: CHILD,
        content: Buffer.from('hi'),
        contentDigest: sha256('hi'),
      }),
    ).rejects.toThrow('must name a child Session run');
    expect(inputs(parent.session)).toHaveLength(0);
  });

  it('refuses content that does not match its digest', async () => {
    const parent = await side(PARENT);
    await launch(parent.children);
    await attach(parent.children);
    await expect(
      parent.messages.receive({
        messageId: 'msg_x',
        route: 'to_parent',
        childRunId: 'run-1',
        senderSessionId: CHILD,
        content: Buffer.from('tampered'),
        contentDigest: sha256('original'),
      }),
    ).rejects.toThrow('does not match its digest');
    expect(inputs(parent.session)).toHaveLength(0);
  });

  it('lets a child message its parent and receive along its lineage only', async () => {
    const child = await side(CHILD, {
      parentSessionId: PARENT,
      parentChildRunId: 'run-1',
    });
    await child.messages.sendToParent({
      text: 'done with part one',
      messageId: 'msg_up',
      executionCallId: 'turn:call-1',
      closing: false,
    });
    await child.messages.sendToParent({
      text: 'done with part one',
      messageId: 'msg_up',
      executionCallId: 'turn:call-1',
      closing: false,
    });
    expect(child.messages.message('msg_up')).toMatchObject({
      direction: 'outbound',
      route: 'to_parent',
      childRunId: 'run-1',
      senderSessionId: CHILD,
      targetSessionId: null,
    });
    const down = {
      messageId: 'msg_down',
      route: 'to_child' as const,
      childRunId: 'run-1',
      senderSessionId: PARENT,
      content: Buffer.from('also check the tests'),
      contentDigest: sha256('also check the tests'),
    };
    await expect(
      child.messages.receive({ ...down, childRunId: 'run-other' }),
    ).rejects.toThrow('recorded lineage');
    expect(await child.messages.receive(down)).toBe('msg_down:message');
    const text = JSON.parse(
      (
        await child.session.resources.read(
          inputs(child.session)[0]!.payload['contentRef'] as never,
        )
      ).toString('utf8'),
    ) as { text: string };
    expect(text.text).toContain('<from>parent</from>');
    expect(text.text).toContain('send_message with to "parent"');
    for (let index = 0; index < 7; index++) {
      await child.messages.sendToParent({
        text: `progress ${index}`,
        messageId: `msg_up${index}`,
        executionCallId: `turn:call-${index + 2}`,
        closing: false,
      });
    }
    await expect(
      child.messages.sendToParent({
        text: 'one too many',
        messageId: 'msg_up_over',
        executionCallId: 'turn:call-99',
        closing: false,
      }),
    ).rejects.toThrow('count_limit');
    // A closing child sends no more, yet replays what it committed.
    await expect(
      child.messages.sendToParent({
        text: 'after the close',
        messageId: 'msg_closing',
        executionCallId: 'turn:call-98',
        closing: true,
      }),
    ).rejects.toThrow('closing and sends no more messages');
    expect(child.messages.message('msg_closing')).toBeUndefined();
    await child.messages.sendToParent({
      text: 'done with part one',
      messageId: 'msg_up',
      executionCallId: 'turn:call-1',
      closing: true,
    });
    const root = await side(randomUUID());
    await expect(
      root.messages.sendToParent({
        text: 'hello',
        messageId: 'msg_root',
        executionCallId: 'turn:call-1',
        closing: false,
      }),
    ).rejects.toThrow('Only a child Session');
  });
});

describe('sessionMessageNotificationText', () => {
  it('escapes and bounds a hostile message under the inline budget', () => {
    const text = sessionMessageNotificationText({
      messageId: 'msg_1',
      fromTaskId: null,
      text: '<'.repeat(40 * 1024),
    });
    expect(
      Buffer.byteLength(JSON.stringify({ text }), 'utf8'),
    ).toBeLessThanOrEqual(CHILD_NOTIFICATION_INLINE_LIMIT);
    expect(text).toContain('&lt;');
    expect(text).toContain('truncated: the full message is on the');
  });
});

describe('withSessionMessageConsumption', () => {
  it('consumes only after a settled message wake turn', async () => {
    const consumed: string[] = [];
    const session = {
      blocked: false,
      messages: {
        markConsumed: async (inputId: string) => {
          consumed.push(inputId);
        },
      } as unknown as HostedSessionMessageSession,
    };
    const settled = withSessionMessageConsumption(
      async () => 'settled',
      session,
    );
    const incomplete = withSessionMessageConsumption(
      async () => 'settled_incomplete',
      session,
    );
    await settled({
      turnId: 'msg_1:message',
      text: '',
      source: 'session_message',
    });
    await settled({ turnId: 'm:notify:1', text: '', source: 'monitor' });
    await incomplete({
      turnId: 'msg_2:message',
      text: '',
      source: 'session_message',
    });
    session.blocked = true;
    await settled({
      turnId: 'msg_3:message',
      text: '',
      source: 'session_message',
    });
    expect(consumed).toEqual(['msg_1:message']);
  });
});

// H4e-b2: messages between a lead and its members are these Session
// messages; the team adds a name, a preamble and a label on top.
describe('team members over Session messages (H4e-b2)', () => {
  async function lead(): Promise<Side & { teams: HostedTeamSession }> {
    const parent = await side(PARENT);
    const teams = new HostedTeamSession(
      {
        authority: parent.session.authority,
        resources: parent.session.resources,
      },
      parent.session.authority.sessionHeader.sessionKey,
      parent.children,
    );
    await teams.run('team_create', { team_name: 'review' }, 'prompt:call-team');
    return { ...parent, teams };
  }

  async function join(
    parent: Side & { teams: HostedTeamSession },
    name: string,
    childRunId: string,
  ): Promise<void> {
    const member = parent.teams.admitMember(name);
    await launch(parent.children, childRunId);
    await parent.teams.join({ ...member, childRunId });
  }

  function sendTo(
    children: HostedChildAgentSession,
    childRunId: string,
    text: string,
    call: string,
  ) {
    return children.sendToChild({
      taskId: children.taskIdOf(childRunId),
      text,
      messageId: `msg_${call}`,
      continuationRunId: `prompt:${call}`,
      executionCallId: `prompt:${call}`,
      closing: false,
    });
  }

  async function promptOf(parent: Side, childRunId: string): Promise<string> {
    return decodeChildLaunchEnvelope(
      await parent.session.resources.read(
        parent.children.record(childRunId)!.inputRef,
      ),
    ).prompt;
  }

  async function inputText(session: ManagedSession, inputId: string) {
    const event = inputs(session).find(
      (each) => each.payload['inputId'] === inputId,
    )!;
    return (
      JSON.parse(
        (
          await session.resources.read(event.payload['contentRef'] as never)
        ).toString('utf8'),
      ) as { text: string }
    ).text;
  }

  async function finish(
    parent: Side,
    childRunId: string,
    childSessionId: typeof CHILD,
  ): Promise<void> {
    await attach(parent.children, childRunId, childSessionId);
    await complete(parent.children, childRunId);
  }

  it('continues a finished member behind its preamble and replays by the instruction form', async () => {
    const parent = await lead();
    await join(parent, 'alice', 'run-a');
    await finish(parent, 'run-a', CHILD);
    expect(await sendTo(parent.children, 'run-a', 'fix it', 'c1')).toEqual({
      kind: 'continuation',
      childRunId: 'prompt:c1',
      predecessorChildRunId: 'run-a',
      member: { name: 'alice', teamName: 'review' },
    });
    expect(await promptOf(parent, 'prompt:c1')).toBe(
      `${teamMemberPreamble({ name: 'alice', teamName: 'review' })}fix it`,
    );
    // The replay finds the committed continuation by its form.
    expect(
      await sendTo(parent.children, 'run-a', 'fix it', 'c1'),
    ).toMatchObject({ kind: 'continuation', childRunId: 'prompt:c1' });
    await expect(
      sendTo(parent.children, 'run-a', 'something else', 'c1'),
    ).rejects.toThrow(ManagedSessionConflictError);
    // A child off every roster continues with the message alone.
    await launch(parent.children, 'run-p');
    await finish(parent, 'run-p', randomUUID());
    await sendTo(parent.children, 'run-p', 'look again', 'c2');
    expect(await promptOf(parent, 'prompt:c2')).toBe('look again');
  });

  it('refuses to continue a member of a closing team', async () => {
    const parent = await lead();
    await join(parent, 'alice', 'run-a');
    await finish(parent, 'run-a', CHILD);
    const team = parseTeamState(
      parent.session.authority.extensionRecord(
        'team_state',
        'prompt:call-team',
      )!.record,
    );
    const closing = teamLifecycleBody(team, 'closing');
    await parent.session.authority.commitExtensionRecord(
      {
        operation: 'deleteTeam',
        commandId: 'prompt:call-delete:closing',
        sessionKey: parent.session.authority.sessionHeader.sessionKey,
        contentDigest: sha256(JSON.stringify(closing)),
      },
      { domain: 'team_state', record: closing },
      { class: 'trusted_entry' },
    );
    expect(await sendTo(parent.children, 'run-a', 'more', 'c1')).toEqual({
      kind: 'refused',
      reason: `Member "alice" (task ${parent.children.taskIdOf('run-a')}) belongs to team "review", which is closing and takes no new work. Finish it with team_delete.`,
    });
    expect(parent.children.record('prompt:c1')).toBeUndefined();
  });

  it("labels a member's messages and continued results only while its team is open", async () => {
    const parent = await lead();
    await join(parent, 'alice', 'run-a');
    await attach(parent.children, 'run-a', CHILD);
    const receive = (childRunId: string, senderSessionId: string, id: string) =>
      parent.messages.receive({
        messageId: id,
        route: 'to_parent',
        childRunId,
        senderSessionId,
        content: Buffer.from('which branch?'),
        contentDigest: sha256('which branch?'),
      });
    await receive('run-a', CHILD, 'msg_from-alice');
    const labeled = await inputText(parent.session, 'msg_from-alice:message');
    expect(labeled).toContain(
      `<from>child agent ${parent.children.taskIdOf('run-a')}</from>\n<teammate>alice</teammate>\n<reply>To answer, use send_message with task_id "${parent.children.taskIdOf('run-a')}".</reply>`,
    );
    await complete(parent.children, 'run-a');
    // The continuation is the member: its result is labeled through the
    // chain root.
    await sendTo(parent.children, 'run-a', 'fix it', 'c1');
    const continuedSession = randomUUID();
    await finish(parent, 'prompt:c1', continuedSession);
    await parent.children.accept('prompt:c1', {
      notification: { description: 'alice task' },
    });
    expect(
      await inputText(parent.session, 'prompt:c1:accept:notify'),
    ).toContain('<teammate>alice</teammate>');
    // Once the team is deleted, a former member continues as a plain
    // child: no preamble, no label on its result or its messages.
    await parent.teams.run('team_delete', {}, 'prompt:call-delete');
    await sendTo(parent.children, 'run-a', 'once more', 'c2');
    expect(await promptOf(parent, 'prompt:c2')).toBe('once more');
    const formerSession = randomUUID();
    await finish(parent, 'prompt:c2', formerSession);
    await parent.children.accept('prompt:c2', {
      notification: { description: 'alice task' },
    });
    expect(
      await inputText(parent.session, 'prompt:c2:accept:notify'),
    ).not.toContain('<teammate>');
    await receive('prompt:c2', formerSession, 'msg_from-former');
    expect(
      await inputText(parent.session, 'msg_from-former:message'),
    ).not.toContain('<teammate>');
  });

  it('names the member in the bounds a send to it meets', async () => {
    const parent = await lead();
    await join(parent, 'alice', 'run-a');
    for (let index = 0; index < 8; index++)
      await sendTo(parent.children, 'run-a', `m${index}`, `m${index}`);
    expect(
      await sendTo(parent.children, 'run-a', 'one too many', 'm8'),
    ).toEqual({
      kind: 'refused',
      reason: `Member "alice" (task ${parent.children.taskIdOf('run-a')}) has 8 messages still on their way to it (count_limit); wait for them to arrive.`,
    });
    // The envelope bound counts the preamble every continuation carries.
    expect(
      await sendTo(
        parent.children,
        'run-a',
        'x'.repeat(MANAGED_CHILD_LIMITS.maxEnvelopeBytes),
        'big',
      ),
    ).toEqual({
      kind: 'refused',
      reason: `Message exceeds what a child task can carry (byte_limit): keep it under ${MANAGED_CHILD_LIMITS.maxEnvelopeBytes} bytes together with its launch description and the member preamble every continuation of "alice" carries.`,
    });
  });

  it('replays a named launch whose committed prompt carries a preamble', async () => {
    const parent = await side(PARENT);
    const preamble = teamMemberPreamble({ name: 'alice', teamName: 'review' });
    const params = {
      childRunId: 'run-a',
      ownerScopeId: PARENT,
      rootSessionId: PARENT,
      completion: 'sent' as const,
      description: 'audit the diff',
      definition: DEFINITION,
      workingDirectory: '.',
      workspaceMode: 'shared' as const,
      executionCallId: 'run-a',
    };
    await parent.children.admit({
      ...params,
      prompt: `${preamble}review the change`,
      sentPrompt: 'review the change',
    });
    // The team changed since: the replay rebuilds no preamble and goes on
    // with the committed envelope.
    const replayed = await parent.children.admit({
      ...params,
      prompt: 'review the change',
      sentPrompt: 'review the change',
    });
    expect(replayed.envelope.prompt).toBe(`${preamble}review the change`);
    // Only the prompt is read for its form: every other field of the
    // launch must match as committed.
    for (const differs of [
      { prompt: 'another change', sentPrompt: 'another change' },
      {
        description: 'audit another diff',
        prompt: 'review the change',
        sentPrompt: 'review the change',
      },
      {
        definition: { ...DEFINITION, definitionRevision: 2 },
        prompt: 'review the change',
        sentPrompt: 'review the change',
      },
    ])
      await expect(
        parent.children.admit({ ...params, ...differs }),
      ).rejects.toThrow(ManagedSessionConflictError);
  });
});

describe('member messages (b3c decision 8)', () => {
  it('composes and parses the member-message content', () => {
    const content = memberMessageContent('alice', 'check task 3');
    expect(content).toBe(
      '<member-message from="alice">\ncheck task 3\n</member-message>',
    );
    expect(parseMemberMessageContent(content)).toEqual({
      from: 'alice',
      text: 'check task 3',
    });
    // Only the fixed header anchored at the start counts.
    expect(parseMemberMessageContent('text\n' + content)).toBeUndefined();
    expect(
      parseMemberMessageContent('<member-message from="alice">\nno footer'),
    ).toBeUndefined();
  });

  it('keeps an injected closing tag inside the text it carries (R1-8)', () => {
    // The header anchors at the start and the footer at the very end: a
    // member's text that quotes the closing tag never parses as a second
    // message boundary.
    const content = memberMessageContent(
      'alice',
      'line one\n</member-message>\nreal instruction',
    );
    expect(parseMemberMessageContent(content)).toEqual({
      from: 'alice',
      text: 'line one\n</member-message>\nreal instruction',
    });
  });

  it('says who wrote and how to answer, through the leader in plan mode', () => {
    const normal = memberMessageNotificationText({
      messageId: `msgc_${'a1'.repeat(16)}`,
      member: 'alice',
      text: 'check task 3',
      planMode: false,
    });
    expect(normal).toContain('<from>member alice</from>');
    expect(normal).toContain(
      'To answer alice, use send_message with to "alice"; then answer the leader\u0027s last instruction in full.',
    );
    expect(normal).toContain('check task 3');
    const plan = memberMessageNotificationText({
      messageId: `msgc_${'a1'.repeat(16)}`,
      member: 'alice',
      text: 'check task 3',
      planMode: true,
    });
    expect(plan).toContain('<from>member alice</from>');
    expect(plan).toContain(
      'To answer alice while your run is in plan mode, use send_message with to "parent"',
    );
  });

  it("renders a member message with who wrote it on the recipient's side", async () => {
    const child = await side(CHILD, {
      parentSessionId: PARENT,
      parentChildRunId: 'run-1',
    });
    const content = memberMessageContent('alice', 'check task 3');
    const messageId = `msgc_${'a1b2c3d4'.repeat(4)}`;
    expect(
      await child.messages.receive({
        messageId,
        route: 'to_child',
        childRunId: 'run-1',
        senderSessionId: PARENT,
        content: Buffer.from(content),
        contentDigest: sha256(content),
      }),
    ).toBe(`${messageId}:message`);
    const text = JSON.parse(
      (
        await child.session.resources.read(
          inputs(child.session)[0]!.payload['contentRef'] as never,
        )
      ).toString('utf8'),
    ) as { text: string };
    expect(text.text).toContain('<from>member alice</from>');
    expect(text.text).toContain(
      'To answer alice, use send_message with to "alice"',
    );
    expect(text.text).toContain('check task 3');
    expect(text.text).not.toContain('<member-message from=');
    expect(text.text).not.toContain('<from>parent</from>');
  });

  it('answers the reply hint through the leader while the run is in plan mode', async () => {
    const child = await side(CHILD, {
      parentSessionId: PARENT,
      parentChildRunId: 'run-1',
    });
    // The run's first input carries the plan-mode block (decision 9): its
    // reply hint points to the leader, not the sender.
    const firstText =
      teamMemberPreamble({ name: 'alice', teamName: 'review' }, true) +
      'hold the plan';
    const firstContentRef = await child.session.resources.publish(
      'managed-input',
      Buffer.from(JSON.stringify([{ type: 'text', text: firstText }]), 'utf8'),
    );
    const firstAdmissionRef = await child.session.resources.publish(
      'managed-admission',
      Buffer.from('{}', 'utf8'),
    );
    await child.session.authority.submitInput(
      {
        operation: 'submitInput',
        commandId: 'first-input',
        sessionKey: child.session.authority.sessionHeader.sessionKey,
        contentDigest: createHash('sha256')
          .update(JSON.stringify({ text: firstText }))
          .digest('hex'),
      },
      {
        inputId: 'first-input',
        turnId: 'first-input',
        source: 'test',
        contentRef: firstContentRef,
        deadline: null,
        admissionRef: firstAdmissionRef,
        wakeReason: 'input',
      },
    );
    const content = memberMessageContent('bob', 'check task 3');
    const messageId = `msgc_${'c9d8e7f6'.repeat(4)}`;
    expect(
      await child.messages.receive({
        messageId,
        route: 'to_child',
        childRunId: 'run-1',
        senderSessionId: PARENT,
        content: Buffer.from(content),
        contentDigest: sha256(content),
      }),
    ).toBe(`${messageId}:message`);
    const text = JSON.parse(
      (
        await child.session.resources.read(
          inputs(child.session)[1]!.payload['contentRef'] as never,
        )
      ).toString('utf8'),
    ) as { text: string };
    expect(text.text).toContain('<from>member bob</from>');
    expect(text.text).toContain(
      'To answer bob while your run is in plan mode, use send_message with to "parent"',
    );
  });

  it('hints the sender itself when plan mode is not required (R1-12)', async () => {
    const child = await side(CHILD, {
      parentSessionId: PARENT,
      parentChildRunId: 'run-1',
    });
    // The first input carries a non-plan member preamble: the read must
    // reach the sender's own lane, never fall into the plan-mode answer.
    const firstText =
      teamMemberPreamble({ name: 'alice', teamName: 'review' }, false) +
      'hold the plan';
    const firstContentRef = await child.session.resources.publish(
      'managed-input',
      Buffer.from(JSON.stringify([{ type: 'text', text: firstText }]), 'utf8'),
    );
    const firstAdmissionRef = await child.session.resources.publish(
      'managed-admission',
      Buffer.from('{}', 'utf8'),
    );
    await child.session.authority.submitInput(
      {
        operation: 'submitInput',
        commandId: 'first-input',
        sessionKey: child.session.authority.sessionHeader.sessionKey,
        contentDigest: createHash('sha256')
          .update(JSON.stringify({ text: firstText }))
          .digest('hex'),
      },
      {
        inputId: 'first-input',
        turnId: 'first-input',
        source: 'test',
        contentRef: firstContentRef,
        deadline: null,
        admissionRef: firstAdmissionRef,
        wakeReason: 'input',
      },
    );
    const content = memberMessageContent('bob', 'check task 3');
    const messageId = `msgc_${'b1c2d3e4'.repeat(4)}`;
    expect(
      await child.messages.receive({
        messageId,
        route: 'to_child',
        childRunId: 'run-1',
        senderSessionId: PARENT,
        content: Buffer.from(content),
        contentDigest: sha256(content),
      }),
    ).toBe(`${messageId}:message`);
    const text = JSON.parse(
      (
        await child.session.resources.read(
          inputs(child.session)[1]!.payload['contentRef'] as never,
        )
      ).toString('utf8'),
    ) as { text: string };
    expect(text.text).toContain('<from>member bob</from>');
    expect(text.text).toContain(
      'To answer bob, use send_message with to "bob"',
    );
    expect(text.text).not.toContain('while your run is in plan mode');
  });

  it('hints the leader when the first input cannot be read (R1-12)', async () => {
    const child = await side(CHILD, {
      parentSessionId: PARENT,
      parentChildRunId: 'run-1',
    });
    // An unreadable first input fails closed to plan mode (R1-12): its
    // reply hint points to the leader, never opens the peer lane by
    // accident while the preamble is unknown.
    const firstContentRef = await child.session.resources.publish(
      'managed-input',
      Buffer.from('not json, deliberately', 'utf8'),
    );
    const firstAdmissionRef = await child.session.resources.publish(
      'managed-admission',
      Buffer.from('{}', 'utf8'),
    );
    await child.session.authority.submitInput(
      {
        operation: 'submitInput',
        commandId: 'first-input',
        sessionKey: child.session.authority.sessionHeader.sessionKey,
        contentDigest: createHash('sha256')
          .update(JSON.stringify({ text: 'not json, deliberately' }))
          .digest('hex'),
      },
      {
        inputId: 'first-input',
        turnId: 'first-input',
        source: 'test',
        contentRef: firstContentRef,
        deadline: null,
        admissionRef: firstAdmissionRef,
        wakeReason: 'input',
      },
    );
    const content = memberMessageContent('carol', 'check task 3');
    const messageId = `msgc_${'f6e5d4c3'.repeat(4)}`;
    expect(
      await child.messages.receive({
        messageId,
        route: 'to_child',
        childRunId: 'run-1',
        senderSessionId: PARENT,
        content: Buffer.from(content),
        contentDigest: sha256(content),
      }),
    ).toBe(`${messageId}:message`);
    const text = JSON.parse(
      (
        await child.session.resources.read(
          inputs(child.session)[1]!.payload['contentRef'] as never,
        )
      ).toString('utf8'),
    ) as { text: string };
    expect(text.text).toContain('<from>member carol</from>');
    expect(text.text).toContain(
      'while your run is in plan mode, use send_message with to "parent"',
    );
  });

  it("renders a member-id message without the header as the leader's form", async () => {
    const child = await side(CHILD, {
      parentSessionId: PARENT,
      parentChildRunId: 'run-1',
    });
    // Only the lead mints msgc_ ids, so a body mismatched to one is a
    // fault to fall back on, never a rendering branch of its own.
    const content = 'the lead asks you to check task 3';
    const messageId = `msgc_${'e5f6a1b2'.repeat(4)}`;
    expect(
      await child.messages.receive({
        messageId,
        route: 'to_child',
        childRunId: 'run-1',
        senderSessionId: PARENT,
        content: Buffer.from(content),
        contentDigest: sha256(content),
      }),
    ).toBe(`${messageId}:message`);
    const text = JSON.parse(
      (
        await child.session.resources.read(
          inputs(child.session)[0]!.payload['contentRef'] as never,
        )
      ).toString('utf8'),
    ) as { text: string };
    expect(text.text).toContain('<from>parent</from>');
    expect(text.text).toContain(content);
  });
});
