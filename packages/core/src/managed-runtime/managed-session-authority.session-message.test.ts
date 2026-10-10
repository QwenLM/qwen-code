/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionWriterLease } from '../services/session-writer-lease.js';
import {
  LocalManagedSessionAuthority,
  type ManagedSessionInputRequest,
} from './managed-session-authority.js';
import {
  childAttachBody,
  childContinuationBody,
  childDispatchBody,
  childFailBody,
  childLaunchBody,
  childSettleCompletedBody,
  childStopRequestedBody,
} from './managed-child-operations.js';
import {
  type ChildAgentRun,
  type ChildSessionRun,
} from './managed-child-run-record.js';
import { LocalManagedSessionResourceStore } from './managed-session-resources.js';
import { type ManagedSessionDurableRef } from './managed-session-records.js';

// H4d-a: `session_message` and child continuations are registered and
// checked but not enabled for submission. The flags below lift exactly those
// two gates (and the shell/workflow kind gates for cross-kind plantings), so
// the suite runs the commit and rebuild paths ahead of enablement.
const enablement = vi.hoisted(() => ({
  sessionMessage: true,
  continuation: true,
  shellKind: false,
  workflowKind: false,
}));

vi.mock('./managed-session-records.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./managed-session-records.js')>();
  return {
    ...actual,
    assertManagedSessionDomainEnabled: (domain: string) => {
      if (!(domain === 'session_message' && enablement.sessionMessage)) {
        actual.assertManagedSessionDomainEnabled(
          domain as Parameters<
            typeof actual.assertManagedSessionDomainEnabled
          >[0],
        );
      }
    },
    assertManagedSessionChildContinuationEnabled: () => {
      if (!enablement.continuation) {
        actual.assertManagedSessionChildContinuationEnabled();
      }
    },
    assertManagedSessionChildRunKindEnabled: (kind: string) => {
      if (
        !(kind === 'shell' && enablement.shellKind) &&
        !(kind === 'workflow' && enablement.workflowKind)
      ) {
        actual.assertManagedSessionChildRunKindEnabled(kind);
      }
    },
  };
});

const temporaryDirectories = new Set<string>();

afterEach(async () => {
  enablement.sessionMessage = true;
  enablement.continuation = true;
  enablement.shellKind = false;
  enablement.workflowKind = false;
  for (const directory of temporaryDirectories) {
    await fs.rm(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

const sessionId = '550e8400-e29b-41d4-a716-446655440000';
const sessionKey = {
  tenantId: 'tenant-1',
  workspaceId: 'workspace-1',
  sessionId,
};
const CHILD_SESSION = 'session-child';

interface Harness {
  readonly runtimeBaseDir: string;
  readonly transcriptPath: string;
  readonly store: LocalManagedSessionResourceStore;
  now: number;
}

async function createHarness(): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-managed-agent-'));
  temporaryDirectories.add(root);
  const runtimeBaseDir = path.join(root, 'runtime');
  const transcriptPath = path.join(root, 'chats', `${sessionId}.jsonl`);
  await fs.mkdir(runtimeBaseDir, { recursive: true });
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  return {
    runtimeBaseDir,
    transcriptPath,
    store: LocalManagedSessionResourceStore.create({
      runtimeBaseDir,
      sessionKey,
    }),
    now: 1_000,
  };
}

async function withAuthority<T>(
  harness: Harness,
  run: (authority: LocalManagedSessionAuthority) => Promise<T>,
  options: { create?: boolean } = {},
): Promise<T> {
  const lease = await SessionWriterLease.acquire({
    runtimeBaseDir: harness.runtimeBaseDir,
    sessionId,
    transcriptPath: harness.transcriptPath,
  });
  try {
    const create =
      options.create === false
        ? undefined
        : {
            definitionRef: await harness.store.publish(
              'managed-definition',
              Buffer.from('{}', 'utf8'),
            ),
            rootSnapshotRef: await harness.store.publish(
              'managed-root',
              Buffer.from('{}', 'utf8'),
            ),
            createdBy: 'daemon',
          };
    const authority = await LocalManagedSessionAuthority.open({
      lease,
      sessionKey,
      cwd: '/workspace',
      version: 'test',
      resources: harness.store,
      now: () => harness.now,
      ...(create === undefined ? {} : { create }),
    });
    return await run(authority);
  } finally {
    await lease.release().catch(() => undefined);
  }
}

const TRUSTED = { class: 'trusted_entry' } as const;
const DEFINITION = {
  definitionId: 'agent-def-1',
  definitionRevision: 1,
  definitionDigest: 'f'.repeat(64),
};
const BINDING = { runtimeBindingId: 'binding-1', generation: '1' };

function command(commandId: string) {
  return {
    operation: 'commitSessionMessage',
    commandId,
    sessionKey,
    contentDigest: 'd'.repeat(64),
  };
}

interface Refs {
  readonly input: ManagedSessionDurableRef;
  readonly result: ManagedSessionDurableRef;
  readonly receipt: ManagedSessionDurableRef;
  readonly content: ManagedSessionDurableRef;
}

async function publishRefs(harness: Harness): Promise<Refs> {
  return {
    input: await harness.store.publish(
      'managed-input',
      Buffer.from('{"prompt":"audit the diff"}', 'utf8'),
    ),
    result: await harness.store.publish(
      'managed-child-result',
      Buffer.from('{"summary":"clean"}', 'utf8'),
    ),
    receipt: await harness.store.publish(
      'managed-runtime-receipt',
      Buffer.from('{"outcome":"settled"}', 'utf8'),
    ),
    content: await harness.store.publish(
      'managed-message-content',
      Buffer.from('also check the tests', 'utf8'),
    ),
  };
}

/** A child run's revisions, from launch to its settled result. */
function childLife(refs: Refs, childRunId = 'run-1'): ChildAgentRun[] {
  const launched = childLaunchBody({
    childRunId,
    ownerScopeId: 'scope-main',
    rootSessionId: sessionId,
    completion: 'sent',
    inputRef: refs.input,
    workspaceMode: 'shared',
    workingDirectory: '.',
    executionCallId: `call-${childRunId}`,
    definition: DEFINITION,
  });
  const dispatched = childDispatchBody(launched, {
    dispatchId: `dispatch-${childRunId}`,
    runtime: BINDING,
  });
  const attached = childAttachBody(dispatched, {
    childSessionId: CHILD_SESSION,
  });
  const settled = childSettleCompletedBody(attached, {
    resultRef: refs.result,
    terminalReceiptRef: refs.receipt,
  });
  return [launched, dispatched, attached, settled];
}

/** Commits the first `count` revisions of a child run. */
async function commitChild(
  authority: LocalManagedSessionAuthority,
  life: readonly ChildAgentRun[],
  count: number,
): Promise<void> {
  for (const [index, record] of life.slice(0, count).entries()) {
    await authority.commitExtensionRecord(
      command(`${record.childRunId}:${index + 1}`),
      { domain: 'child_run', record },
      TRUSTED,
    );
  }
}

function messageRun(executionCallId: string | null, state: string) {
  return {
    state: 'settled',
    reason: null,
    definition: null,
    executionCallId,
    effectId: null,
    dispatchId: null,
    deliveryId: null,
    execution: null,
    runtime: null,
    delivery: { target: 'session', state },
  };
}

/** The parent's outbox entry for a message to its child run `run-1`. */
function toChild(
  refs: Refs,
  state = 'planned',
  overrides: Record<string, unknown> = {},
) {
  return {
    direction: 'outbound',
    messageId: 'message-1',
    route: 'to_child',
    childRunId: 'run-1',
    senderSessionId: sessionId,
    targetSessionId: state === 'planned' ? null : CHILD_SESSION,
    contentRef: refs.content,
    contentDigest: refs.content.digest,
    inputId:
      state === 'accepted' || state === 'consumed' ? 'message-1:input' : null,
    run: messageRun('call-send-1', state),
    ...overrides,
  };
}

/** The parent's receipt of a message its child run `run-1` sent. */
function fromChild(
  refs: Refs,
  state: 'accepted' | 'consumed' = 'accepted',
  overrides: Record<string, unknown> = {},
) {
  return {
    direction: 'inbound',
    messageId: 'message-9',
    route: 'to_parent',
    childRunId: 'run-1',
    senderSessionId: CHILD_SESSION,
    targetSessionId: sessionId,
    contentRef: refs.content,
    contentDigest: refs.content.digest,
    inputId: 'message-9:input',
    run: messageRun(null, state),
    ...overrides,
  };
}

async function inputFor(
  harness: Harness,
  inputId: string,
): Promise<ManagedSessionInputRequest> {
  return {
    inputId,
    turnId: inputId,
    source: 'session_message',
    contentRef: await harness.store.publish(
      'managed-input',
      Buffer.from('{"text":"also check the tests"}', 'utf8'),
    ),
    deadline: null,
    admissionRef: await harness.store.publish(
      'managed-admission',
      Buffer.from('{}', 'utf8'),
    ),
    wakeReason: 'input',
  };
}

async function publishedBodies(
  harness: Harness,
  domain: string,
): Promise<number> {
  try {
    return (
      await fs.readdir(
        path.join(
          harness.runtimeBaseDir,
          'resources',
          sessionId,
          `managed-${domain}`,
        ),
      )
    ).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

function inputEventsOf(authority: LocalManagedSessionAuthority): number {
  return authority
    .eventsInSequenceRange(1, authority.committedSequence)
    .filter((event) => event.kind === 'input.accepted').length;
}

describe('managed session authority session_message records (H4d)', () => {
  it('refuses a message while the domain is disabled, publishing nothing', async () => {
    enablement.sessionMessage = false;
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    await withAuthority(harness, async (authority) => {
      await commitChild(authority, childLife(refs), 3);
      await expect(
        authority.commitExtensionRecord(
          command('message-1:1'),
          { domain: 'session_message', record: toChild(refs) },
          TRUSTED,
        ),
      ).rejects.toThrow(
        'domain session_message is registered but not enabled for submission.',
      );
      expect(await publishedBodies(harness, 'session_message')).toBe(0);
    });
  });

  it('chains a message to an attached child from planned to consumed and rebuilds it', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    await withAuthority(harness, async (authority) => {
      await commitChild(authority, childLife(refs), 3);
      const states = ['planned', 'accepting', 'accepted', 'consumed'];
      for (const [index, state] of states.entries()) {
        const committed = await authority.commitExtensionRecord(
          command(`message-1:${index + 1}`),
          { domain: 'session_message', record: toChild(refs, state) },
          TRUSTED,
        );
        expect(committed).toMatchObject({
          domain: 'session_message',
          recordId: 'message-1',
          taskId: null,
          revision: index + 1,
        });
      }
      expect(
        authority.extensionRecord('session_message', 'message-1'),
      ).toMatchObject({ revision: 4, task: null });
    });
    await withAuthority(
      harness,
      async (authority) => {
        const rebuilt = authority.extensionRecord(
          'session_message',
          'message-1',
        );
        expect(rebuilt?.revision).toBe(4);
        expect(rebuilt?.record).toEqual(toChild(refs, 'consumed'));
      },
      { create: false },
    );
  });

  it('holds a message to an unattached child until the child attaches', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    const life = childLife(refs);
    await withAuthority(harness, async (authority) => {
      await commitChild(authority, life, 1);
      await authority.commitExtensionRecord(
        command('message-1:1'),
        { domain: 'session_message', record: toChild(refs) },
        TRUSTED,
      );
      // The target is fixed only at handover, so nothing can claim the
      // message before the child Session exists.
      await expect(
        authority.commitExtensionRecord(
          command('message-1:2'),
          { domain: 'session_message', record: toChild(refs, 'accepting') },
          TRUSTED,
        ),
      ).rejects.toThrow(
        'Session message to a child must target the Session its run attached.',
      );
      await authority.commitExtensionRecord(
        command('run-1:2'),
        { domain: 'child_run', record: life[1] },
        TRUSTED,
      );
      await authority.commitExtensionRecord(
        command('run-1:3'),
        { domain: 'child_run', record: life[2] },
        TRUSTED,
      );
      await expect(
        authority.commitExtensionRecord(
          command('message-1:2'),
          { domain: 'session_message', record: toChild(refs, 'accepting') },
          TRUSTED,
        ),
      ).resolves.toMatchObject({ revision: 2 });
    });
  });

  it('refuses a message to another Session than the one the child attached', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    await withAuthority(harness, async (authority) => {
      await commitChild(authority, childLife(refs), 3);
      await expect(
        authority.commitExtensionRecord(
          command('message-1:1'),
          {
            domain: 'session_message',
            record: toChild(refs, 'planned', {
              targetSessionId: 'session-other',
            }),
          },
          TRUSTED,
        ),
      ).rejects.toThrow(
        'Session message to a child must target the Session its run attached.',
      );
    });
  });

  it('refuses a message to a missing or ended child, and to a Shell', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    await withAuthority(harness, async (authority) => {
      await expect(
        authority.commitExtensionRecord(
          command('message-1:1'),
          { domain: 'session_message', record: toChild(refs) },
          TRUSTED,
        ),
      ).rejects.toThrow(
        'Session message must name a child Session run of this Session.',
      );
      enablement.shellKind = true;
      await authority.commitExtensionRecord(
        command('shell-1:1'),
        {
          domain: 'child_run',
          record: {
            kind: 'shell',
            shellId: 'shell-1',
            ownerScopeId: 'scope-main',
            commandRef: refs.input,
            startReceiptRef: null,
            outputRef: null,
            stopReason: null,
            stopRequested: false,
            exitCode: null,
            exitSignal: null,
            run: {
              state: 'admitted',
              reason: null,
              definition: null,
              executionCallId: 'call-shell-1',
              effectId: null,
              dispatchId: null,
              deliveryId: null,
              execution: 'intent',
              runtime: null,
              delivery: null,
            },
          },
        },
        TRUSTED,
      );
      await expect(
        authority.commitExtensionRecord(
          command('message-1:1'),
          {
            domain: 'session_message',
            record: toChild(refs, 'planned', { childRunId: 'shell-1' }),
          },
          TRUSTED,
        ),
      ).rejects.toThrow(
        'Session message must name a child Session run of this Session.',
      );
      await commitChild(authority, childLife(refs), 4);
      await expect(
        authority.commitExtensionRecord(
          command('message-1:1'),
          { domain: 'session_message', record: toChild(refs) },
          TRUSTED,
        ),
      ).rejects.toThrow(
        'Session message to a child must name a run that has not ended.',
      );
      expect(await publishedBodies(harness, 'session_message')).toBe(0);
    });
  });

  it('keeps delivering a message sent before its child ended', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    const life = childLife(refs);
    await withAuthority(harness, async (authority) => {
      await commitChild(authority, life, 3);
      await authority.commitExtensionRecord(
        command('message-1:1'),
        { domain: 'session_message', record: toChild(refs) },
        TRUSTED,
      );
      await authority.commitExtensionRecord(
        command('run-1:4'),
        { domain: 'child_run', record: life[3] },
        TRUSTED,
      );
      await expect(
        authority.commitExtensionRecord(
          command('message-1:2'),
          { domain: 'session_message', record: toChild(refs, 'accepting') },
          TRUSTED,
        ),
      ).resolves.toMatchObject({ revision: 2 });
    });
    // The opening rule replays against the run as it stood then.
    await withAuthority(
      harness,
      async (authority) => {
        expect(
          authority.extensionRecord('session_message', 'message-1')?.revision,
        ).toBe(2);
      },
      { create: false },
    );
  });

  it('refuses an outbox entry another Session sent', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    await withAuthority(harness, async (authority) => {
      await commitChild(authority, childLife(refs), 3);
      await expect(
        authority.commitExtensionRecord(
          command('message-1:1'),
          {
            domain: 'session_message',
            record: toChild(refs, 'planned', {
              senderSessionId: 'session-other',
            }),
          },
          TRUSTED,
        ),
      ).rejects.toThrow(
        'Outbound session message must be sent by this Session.',
      );
    });
  });

  it('accepts a child message together with its input and wake, then consumes it', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    await withAuthority(harness, async (authority) => {
      await commitChild(authority, childLife(refs), 3);
      const accepted = await authority.commitExtensionRecord(
        command('message-9:accept'),
        {
          domain: 'session_message',
          record: fromChild(refs),
          input: await inputFor(harness, 'message-9:input'),
        },
        TRUSTED,
      );
      const events = authority.eventsInSequenceRange(
        accepted.receipt.firstSequence,
        accepted.receipt.lastSequence,
      );
      expect(events.map((event) => event.kind)).toEqual([
        'domain.committed',
        'input.accepted',
        'wake.requested',
      ]);
      expect(events[1].payload).toMatchObject({ inputId: 'message-9:input' });
      await expect(
        authority.commitExtensionRecord(
          command('message-9:consume'),
          { domain: 'session_message', record: fromChild(refs, 'consumed') },
          TRUSTED,
        ),
      ).resolves.toMatchObject({ revision: 2 });
      expect(inputEventsOf(authority)).toBe(1);
    });
    await withAuthority(
      harness,
      async (authority) => {
        expect(
          authority.extensionRecord('session_message', 'message-9')?.record,
        ).toEqual(fromChild(refs, 'consumed'));
      },
      { create: false },
    );
  });

  it('binds the receipt to exactly its input, so a redelivery adds none', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    const refusal =
      'An inbound session message opens together with its input, and no other revision carries one.';
    await withAuthority(harness, async (authority) => {
      await commitChild(authority, childLife(refs), 3);
      await expect(
        authority.commitExtensionRecord(
          command('message-9:accept'),
          { domain: 'session_message', record: fromChild(refs) },
          TRUSTED,
        ),
      ).rejects.toThrow(refusal);
      await expect(
        authority.commitExtensionRecord(
          command('message-9:accept'),
          {
            domain: 'session_message',
            record: fromChild(refs),
            input: await inputFor(harness, 'message-8:input'),
          },
          TRUSTED,
        ),
      ).rejects.toThrow(refusal);
      expect(await publishedBodies(harness, 'session_message')).toBe(0);
      await authority.commitExtensionRecord(
        command('message-9:accept'),
        {
          domain: 'session_message',
          record: fromChild(refs),
          input: await inputFor(harness, 'message-9:input'),
        },
        TRUSTED,
      );
      // A redelivery under a new command brings the same input, whose event
      // the log already holds.
      await expect(
        authority.commitExtensionRecord(
          command('message-9:redelivered'),
          {
            domain: 'session_message',
            record: fromChild(refs),
            input: await inputFor(harness, 'message-9:input'),
          },
          TRUSTED,
        ),
      ).rejects.toThrow(
        'event id message-9:input:accepted is already committed.',
      );
      // Under any other input it finds the receipt: it cannot open the
      // message again, so it cannot bring an input at all.
      await expect(
        authority.commitExtensionRecord(
          command('message-9:redelivered'),
          {
            domain: 'session_message',
            record: fromChild(refs),
            input: await inputFor(harness, 'message-9:input-2'),
          },
          TRUSTED,
        ),
      ).rejects.toThrow(refusal);
      // Nor can any outbox entry carry an input.
      await expect(
        authority.commitExtensionRecord(
          command('message-1:1'),
          {
            domain: 'session_message',
            record: toChild(refs),
            input: await inputFor(harness, 'message-1:input'),
          },
          TRUSTED,
        ),
      ).rejects.toThrow(refusal);
      expect(inputEventsOf(authority)).toBe(1);
    });
  });

  it('refuses a redelivery that changes the message under its id', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    await withAuthority(harness, async (authority) => {
      await commitChild(authority, childLife(refs), 3);
      await authority.commitExtensionRecord(
        command('message-9:accept'),
        {
          domain: 'session_message',
          record: fromChild(refs),
          input: await inputFor(harness, 'message-9:input'),
        },
        TRUSTED,
      );
      const other = await harness.store.publish(
        'managed-message-content',
        Buffer.from('a different message', 'utf8'),
      );
      await expect(
        authority.commitExtensionRecord(
          command('message-9:changed'),
          {
            domain: 'session_message',
            record: fromChild(refs, 'consumed', {
              contentRef: other,
              contentDigest: other.digest,
            }),
          },
          TRUSTED,
        ),
      ).rejects.toThrow('session_message record message-9 cannot follow');
      // Carrying its own input changes nothing: the taken id answers as
      // the chain conflict, never as the input rule a redelivery meets.
      await expect(
        authority.commitExtensionRecord(
          command('message-9:changed'),
          {
            domain: 'session_message',
            record: fromChild(refs, 'accepted', {
              contentRef: other,
              contentDigest: other.digest,
            }),
            input: await inputFor(harness, 'message-9:input-2'),
          },
          TRUSTED,
        ),
      ).rejects.toThrow('session_message record message-9 cannot follow');
      // A retried command answers with what it committed.
      await expect(
        authority.commitExtensionRecord(
          command('message-9:accept'),
          {
            domain: 'session_message',
            record: fromChild(refs),
            input: await inputFor(harness, 'message-9:input'),
          },
          TRUSTED,
        ),
      ).resolves.toMatchObject({ revision: 1, receipt: { replayed: true } });
    });
  });

  it('accepts a child message only from the Session its run attached', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    const life = childLife(refs);
    const refusal =
      'Session message from a child must come from the Session its run attached.';
    await withAuthority(harness, async (authority) => {
      await expect(
        authority.commitExtensionRecord(
          command('message-9:accept'),
          {
            domain: 'session_message',
            record: fromChild(refs),
            input: await inputFor(harness, 'message-9:input'),
          },
          TRUSTED,
        ),
      ).rejects.toThrow(
        'Session message must name a child Session run of this Session.',
      );
      await commitChild(authority, life, 2);
      // Before the attach the delivery waits; it is not a forgery.
      await expect(
        authority.commitExtensionRecord(
          command('message-9:accept'),
          {
            domain: 'session_message',
            record: fromChild(refs),
            input: await inputFor(harness, 'message-9:input'),
          },
          TRUSTED,
        ),
      ).rejects.toThrow(
        'Session message from a child arrives only once its run attached.',
      );
      await authority.commitExtensionRecord(
        command('run-1:3'),
        { domain: 'child_run', record: life[2] },
        TRUSTED,
      );
      await expect(
        authority.commitExtensionRecord(
          command('message-9:accept'),
          {
            domain: 'session_message',
            record: fromChild(refs, 'accepted', {
              senderSessionId: 'session-other',
            }),
            input: await inputFor(harness, 'message-9:input'),
          },
          TRUSTED,
        ),
      ).rejects.toThrow(refusal);
      await expect(
        authority.commitExtensionRecord(
          command('message-9:accept'),
          {
            domain: 'session_message',
            record: fromChild(refs, 'accepted', {
              targetSessionId: 'session-other',
            }),
            input: await inputFor(harness, 'message-9:input'),
          },
          TRUSTED,
        ),
      ).rejects.toThrow(
        'Inbound session message must be addressed to this Session.',
      );
      expect(inputEventsOf(authority)).toBe(0);
    });
  });

  it('accepts a message its child sent before the child ended', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    await withAuthority(harness, async (authority) => {
      await commitChild(authority, childLife(refs), 4);
      await expect(
        authority.commitExtensionRecord(
          command('message-9:accept'),
          {
            domain: 'session_message',
            record: fromChild(refs),
            input: await inputFor(harness, 'message-9:input'),
          },
          TRUSTED,
        ),
      ).resolves.toMatchObject({ revision: 1 });
    });
  });

  it("commits a child's own routes, whose lineage only the control plane holds", async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    await withAuthority(harness, async (authority) => {
      const toParent = {
        ...toChild(refs, 'accepting'),
        messageId: 'message-2',
        route: 'to_parent',
        targetSessionId: 'session-parent',
      };
      await authority.commitExtensionRecord(
        command('message-2:1'),
        {
          domain: 'session_message',
          record: { ...toParent, run: messageRun('call-send-1', 'planned') },
        },
        TRUSTED,
      );
      await expect(
        authority.commitExtensionRecord(
          command('message-2:2'),
          { domain: 'session_message', record: toParent },
          TRUSTED,
        ),
      ).resolves.toMatchObject({ revision: 2 });
      await expect(
        authority.commitExtensionRecord(
          command('message-3:accept'),
          {
            domain: 'session_message',
            record: {
              ...fromChild(refs),
              messageId: 'message-3',
              route: 'to_child',
              senderSessionId: 'session-parent',
              inputId: 'message-3:input',
            },
            input: await inputFor(harness, 'message-3:input'),
          },
          TRUSTED,
        ),
      ).resolves.toMatchObject({ revision: 1 });
    });
  });

  it('refuses a message whose content this Session does not hold', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    await withAuthority(harness, async (authority) => {
      await commitChild(authority, childLife(refs), 3);
      await expect(
        authority.commitExtensionRecord(
          command('message-1:1'),
          {
            domain: 'session_message',
            record: toChild(refs, 'planned', {
              contentRef: { ...refs.content, resourceId: 'never-published' },
            }),
          },
          TRUSTED,
        ),
      ).rejects.toThrow('resource never-published is not present');
    });
  });
});

describe('managed session authority child continuations (H4d)', () => {
  async function completed(
    harness: Harness,
    authority: LocalManagedSessionAuthority,
  ): Promise<{ refs: Refs; predecessor: ChildAgentRun }> {
    const refs = await publishRefs(harness);
    const life = childLife(refs);
    await commitChild(authority, life, 4);
    return { refs, predecessor: life[3]! };
  }

  function continuation(
    predecessor: ChildAgentRun,
    refs: Refs,
    childRunId = 'run-2',
  ): ChildSessionRun {
    return childContinuationBody(predecessor, {
      childRunId,
      completion: 'sent',
      inputRef: refs.input,
      executionCallId: `call-${childRunId}`,
    });
  }

  it('refuses a continuation while its gate is off, publishing nothing', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      const { refs, predecessor } = await completed(harness, authority);
      enablement.continuation = false;
      const published = await publishedBodies(harness, 'child_run');
      await expect(
        authority.commitExtensionRecord(
          command('run-2:1'),
          { domain: 'child_run', record: continuation(predecessor, refs) },
          TRUSTED,
        ),
      ).rejects.toThrow(
        'child_run continuations are registered but not enabled for submission.',
      );
      expect(await publishedBodies(harness, 'child_run')).toBe(published);
    });
  });

  it('continues a completed run once, and rebuilds the chain', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      const { refs, predecessor } = await completed(harness, authority);
      await expect(
        authority.commitExtensionRecord(
          command('run-2:1'),
          { domain: 'child_run', record: continuation(predecessor, refs) },
          TRUSTED,
        ),
      ).resolves.toMatchObject({ recordId: 'run-2', revision: 1 });
      await expect(
        authority.commitExtensionRecord(
          command('run-3:1'),
          {
            domain: 'child_run',
            record: continuation(predecessor, refs, 'run-3'),
          },
          TRUSTED,
        ),
      ).rejects.toThrow(
        'Child continuation must name a predecessor no other run continues.',
      );
    });
    await withAuthority(
      harness,
      async (authority) => {
        const refs = await publishRefs(harness);
        const predecessor = childLife(refs)[3]!;
        expect(
          authority.extensionRecord('child_run', 'run-2')?.record,
        ).toMatchObject({ predecessorChildRunId: 'run-1' });
        // The rebuilt index still holds the chain linear.
        await expect(
          authority.commitExtensionRecord(
            command('run-3:1'),
            {
              domain: 'child_run',
              record: continuation(predecessor, refs, 'run-3'),
            },
            TRUSTED,
          ),
        ).rejects.toThrow(
          'Child continuation must name a predecessor no other run continues.',
        );
      },
      { create: false },
    );
  });

  it('refuses a continuation of a missing, unfinished or failed run', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      const refs = await publishRefs(harness);
      const life = childLife(refs);
      const settled = life[3]!;
      await expect(
        authority.commitExtensionRecord(
          command('run-2:1'),
          { domain: 'child_run', record: continuation(settled, refs) },
          TRUSTED,
        ),
      ).rejects.toThrow(
        'Child continuation must name a child run of this Session of its own kind.',
      );
      await commitChild(authority, life, 3);
      await expect(
        authority.commitExtensionRecord(
          command('run-2:1'),
          { domain: 'child_run', record: continuation(settled, refs) },
          TRUSTED,
        ),
      ).rejects.toThrow(
        'Child continuation must follow a run that completed with its result.',
      );
      await authority.commitExtensionRecord(
        command('run-1:4'),
        {
          domain: 'child_run',
          record: childFailBody(life[2]!, {
            stopReason: 'child_failed',
            reason: null,
            started: true,
          }),
        },
        TRUSTED,
      );
      await expect(
        authority.commitExtensionRecord(
          command('run-2:1'),
          { domain: 'child_run', record: continuation(settled, refs) },
          TRUSTED,
        ),
      ).rejects.toThrow(
        'Child continuation must follow a run that completed with its result.',
      );
    });
  });

  it('refuses a continuation of another kind', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      const { refs, predecessor } = await completed(harness, authority);
      enablement.workflowKind = true;
      await expect(
        authority.commitExtensionRecord(
          command('run-2:1'),
          {
            domain: 'child_run',
            record: { ...continuation(predecessor, refs), kind: 'workflow' },
          },
          TRUSTED,
        ),
      ).rejects.toThrow(
        'Child continuation must name a child run of this Session of its own kind.',
      );
    });
  });

  it.each([
    ['scope', { ownerScopeId: 'scope-other' }],
    ['depth', { depth: 2 }],
    ['workspace mode', { workspaceMode: 'snapshot' }],
    ['working directory', { workingDirectory: 'packages' }],
  ])('refuses a continuation that changes its %s', async (_label, change) => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      const { refs, predecessor } = await completed(harness, authority);
      await expect(
        authority.commitExtensionRecord(
          command('run-2:1'),
          {
            domain: 'child_run',
            record: { ...continuation(predecessor, refs), ...change },
          },
          TRUSTED,
        ),
      ).rejects.toThrow(
        "Child continuation must keep its predecessor's scope, tree, workspace and definition.",
      );
    });
  });

  it('refuses a continuation that changes or drops the definition', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      const { refs, predecessor } = await completed(harness, authority);
      const base = continuation(predecessor, refs);
      for (const definition of [
        { ...DEFINITION, definitionDigest: 'e'.repeat(64) },
        null,
      ]) {
        await expect(
          authority.commitExtensionRecord(
            command('run-2:1'),
            {
              domain: 'child_run',
              record: { ...base, run: { ...base.run, definition } },
            },
            TRUSTED,
          ),
        ).rejects.toThrow(
          "Child continuation must keep its predecessor's scope, tree, workspace and definition.",
        );
      }
    });
  });

  it('releases a predecessor whose continuation never started', async () => {
    const harness = await createHarness();
    const taken =
      'Child continuation must name a predecessor no other run continues.';
    await withAuthority(harness, async (authority) => {
      const { refs, predecessor } = await completed(harness, authority);
      const first = continuation(predecessor, refs) as ChildAgentRun;
      await authority.commitExtensionRecord(
        command('run-2:1'),
        { domain: 'child_run', record: first },
        TRUSTED,
      );
      // While the continuation may still start, the predecessor is taken.
      await expect(
        authority.commitExtensionRecord(
          command('run-3:1'),
          {
            domain: 'child_run',
            record: continuation(predecessor, refs, 'run-3'),
          },
          TRUSTED,
        ),
      ).rejects.toThrow(taken);
      await authority.commitExtensionRecord(
        command('run-2:2'),
        {
          domain: 'child_run',
          record: childFailBody(first, {
            stopReason: 'creation_failed',
            reason: null,
            started: false,
          }),
        },
        TRUSTED,
      );
      await expect(
        authority.commitExtensionRecord(
          command('run-3:1'),
          {
            domain: 'child_run',
            record: continuation(predecessor, refs, 'run-3'),
          },
          TRUSTED,
        ),
      ).resolves.toMatchObject({ recordId: 'run-3' });
      await expect(
        authority.commitExtensionRecord(
          command('run-4:1'),
          {
            domain: 'child_run',
            record: continuation(predecessor, refs, 'run-4'),
          },
          TRUSTED,
        ),
      ).rejects.toThrow(taken);
    });
    await withAuthority(
      harness,
      async (authority) => {
        expect(authority.extensionRecord('child_run', 'run-3')).toBeDefined();
      },
      { create: false },
    );
  });

  it('keeps a predecessor taken by a continuation that started and failed', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      const { refs, predecessor } = await completed(harness, authority);
      const first = continuation(predecessor, refs) as ChildAgentRun;
      const dispatched = childDispatchBody(first, {
        dispatchId: 'dispatch-run-2',
        runtime: BINDING,
      });
      const attached = childAttachBody(dispatched, {
        childSessionId: 'session-child-2',
      });
      for (const [index, record] of [
        first,
        dispatched,
        attached,
        childFailBody(attached, {
          stopReason: 'child_failed',
          reason: null,
          started: true,
        }),
      ].entries()) {
        await authority.commitExtensionRecord(
          command(`run-2:${index + 1}`),
          { domain: 'child_run', record },
          TRUSTED,
        );
      }
      await expect(
        authority.commitExtensionRecord(
          command('run-3:1'),
          {
            domain: 'child_run',
            record: continuation(predecessor, refs, 'run-3'),
          },
          TRUSTED,
        ),
      ).rejects.toThrow(
        'Child continuation must name a predecessor no other run continues.',
      );
    });
  });

  it('refuses to revive a run whose stop was requested', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      const refs = await publishRefs(harness);
      const life = childLife(refs);
      const stopping = childStopRequestedBody(life[2]!);
      const settled = childSettleCompletedBody(stopping, {
        resultRef: refs.result,
        terminalReceiptRef: refs.receipt,
      });
      await commitChild(authority, [...life.slice(0, 3), stopping, settled], 5);
      await expect(
        authority.commitExtensionRecord(
          command('run-2:1'),
          { domain: 'child_run', record: continuation(settled, refs) },
          TRUSTED,
        ),
      ).rejects.toThrow(
        'Child continuation cannot revive a run whose stop was requested.',
      );
    });
  });

  it('keeps a nested run continuation in its own tree', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      const refs = await publishRefs(harness);
      // Past the first level, the tree root is not this Session, so only
      // the continuation rule binds the continuation to it.
      const nested = childLife(refs).map((record) => ({
        ...record,
        depth: 2,
        rootSessionId: 'session-root',
      }));
      await commitChild(authority, nested, 4);
      await expect(
        authority.commitExtensionRecord(
          command('run-2:1'),
          {
            domain: 'child_run',
            record: {
              ...continuation(nested[3]!, refs),
              rootSessionId: 'session-other',
            },
          },
          TRUSTED,
        ),
      ).rejects.toThrow(
        "Child continuation must keep its predecessor's scope, tree, workspace and definition.",
      );
      await expect(
        authority.commitExtensionRecord(
          command('run-2:1'),
          { domain: 'child_run', record: continuation(nested[3]!, refs) },
          TRUSTED,
        ),
      ).resolves.toMatchObject({ recordId: 'run-2' });
    });
  });
});
