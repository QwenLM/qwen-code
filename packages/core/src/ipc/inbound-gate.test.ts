/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { ApprovalMode } from '../config/approval-mode.js';
import {
  DEFAULT_HELD_EXPIRY_MS,
  describeHoldCause,
  InboundGate,
  peerSenderKey,
  MAX_HELD_MESSAGES,
  MAX_SETTLED_IDS,
  parseHeldExpiry,
  modeClass,
  type InboundPolicy,
  type PolicyScope,
} from './inbound-gate.js';
import {
  PEER_ADMISSION_LIMITS,
  PeerAdmission,
  type PeerDropReason,
} from './peer-admission.js';
import type { PeerControllerIdentity } from './peer-controllers.js';
import { buildUserFrame, type PeerUserFrame } from './peer-frames.js';

/**
 * A meter that admits everything, so a test of the *policy* is not also a
 * test of the rate limit.
 *
 * Most cases here send more messages than a real burst allows, or send
 * one body repeatedly, and neither is what they are about. The cases that
 * are about admission build their own meter.
 */
function unmeteredAdmission(): PeerAdmission {
  return new PeerAdmission({
    limits: {
      bucketCapacity: 1e6,
      refillPerSecond: 1e6,
      globalBucketCapacity: 1e6,
      globalRefillPerSecond: 1e6,
      dedupWindowMs: 0,
    },
  });
}

interface Harness {
  gate: InboundGate;
  setHeldExpiryMs: (ms: number | null) => void;
  delivered: PeerUserFrame[];
  /** `selfSent` as the gate reported it to `deliver`, per delivery. */
  deliveredAsSelfSent: boolean[];
  /** The controller grant the gate reported to `deliver`, per delivery. */
  deliveredControllers: Array<PeerControllerIdentity | undefined>;
  statuses: Array<{ msgId: string; status: string }>;
  /** What the gate told senders it had dropped. */
  drops: Array<{ msgId: string; reason: PeerDropReason }>;
  /** What the gate told this session's user it had dropped. */
  dropNotices: Array<{
    msgId: string;
    reason: PeerDropReason;
    selfSent: boolean;
    controller?: PeerControllerIdentity;
  }>;
  heldChanges: number;
  setMode: (mode: ApprovalMode | null) => void;
  setPolicy: (policy: InboundPolicy | undefined) => void;
  /** Deliberately un-typed: settings.json is not type-checked. */
  setRawPolicy: (policy: unknown) => void;
  setScope: (scope: PolicyScope | undefined) => void;
  throwOnMode: () => void;
  throwOnPolicy: () => void;
  throwOnExpiry: () => void;
  throwOnScope: () => void;
  failDelivery: () => void;
  recoverDelivery: () => void;
}

function harness(
  initial: {
    mode?: ApprovalMode | null;
    policy?: InboundPolicy;
    heldExpiryMs?: number | null;
    scope?: PolicyScope;
    isControllerValid?: (id: string) => boolean;
    admission?: PeerAdmission;
  } = {},
): Harness {
  let mode: ApprovalMode | null =
    initial.mode === undefined ? ApprovalMode.DEFAULT : initial.mode;
  let policy: unknown = initial.policy;
  let heldExpiryMs: number | null =
    initial.heldExpiryMs === undefined
      ? DEFAULT_HELD_EXPIRY_MS
      : initial.heldExpiryMs;
  let modeThrows = false;
  let policyThrows = false;
  let expiryThrows = false;
  let scope: PolicyScope | undefined = initial.scope;
  let scopeThrows = false;
  const delivered: PeerUserFrame[] = [];
  const deliveredAsSelfSent: boolean[] = [];
  const deliveredControllers: Array<PeerControllerIdentity | undefined> = [];
  const statuses: Array<{ msgId: string; status: string }> = [];
  const drops: Array<{ msgId: string; reason: PeerDropReason }> = [];
  const dropNotices: Array<{
    msgId: string;
    reason: PeerDropReason;
    selfSent: boolean;
    controller?: PeerControllerIdentity;
  }> = [];
  const state = { heldChanges: 0 };
  let deliveryFails = false;

  const gate = new InboundGate({
    admission: initial.admission ?? unmeteredAdmission(),
    reportDropped: (f, reason) => drops.push({ msgId: f.msgId, reason }),
    onDropped: (f, origin, reason) =>
      dropNotices.push({
        msgId: f.msgId,
        reason,
        selfSent: origin.selfSent,
        ...(origin.controller ? { controller: origin.controller } : {}),
      }),
    getApprovalMode: () => {
      if (modeThrows) throw new Error('mode getter exploded');
      return mode;
    },
    getPolicySetting: () => {
      if (policyThrows) throw new Error('settings getter exploded');
      return policy as InboundPolicy | undefined;
    },
    getHeldExpiryMs: () => {
      if (expiryThrows) throw new Error('settings read exploded');
      return heldExpiryMs;
    },
    getPolicyScope: () => {
      if (scopeThrows) throw new Error('scope getter exploded');
      return scope;
    },
    ...(initial.isControllerValid
      ? { isControllerValid: initial.isControllerValid }
      : {}),
    deliver: (frame, origin) => {
      if (deliveryFails) throw new Error('accepted-message backlog is full');
      delivered.push(frame);
      deliveredAsSelfSent.push(origin.selfSent);
      deliveredControllers.push(origin.controller);
    },
    reportStatus: (frame, status) =>
      statuses.push({ msgId: frame.msgId, status }),
    onHeldChange: () => {
      state.heldChanges += 1;
    },
  });

  return {
    gate,
    delivered,
    deliveredAsSelfSent,
    deliveredControllers,
    statuses,
    drops,
    dropNotices,
    setHeldExpiryMs: (next) => {
      heldExpiryMs = next;
    },
    get heldChanges() {
      return state.heldChanges;
    },
    setMode: (next) => {
      mode = next;
    },
    setPolicy: (next) => {
      policy = next;
    },
    setRawPolicy: (next: unknown) => {
      policy = next;
    },
    setScope: (next) => {
      scope = next;
    },
    throwOnMode: () => {
      modeThrows = true;
    },
    throwOnPolicy: () => {
      policyThrows = true;
    },
    throwOnExpiry: () => {
      expiryThrows = true;
    },
    throwOnScope: () => {
      scopeThrows = true;
    },
    failDelivery: () => {
      deliveryFails = true;
    },
    recoverDelivery: () => {
      deliveryFails = false;
    },
  } as Harness;
}

/**
 * A distinct body per call, so a test that sends several frames is not
 * incidentally testing the repeat check. Cases about that pass their own
 * `message`.
 */
let bodyCounter = 0;
function frame(over: Partial<PeerUserFrame> = {}): PeerUserFrame {
  bodyCounter += 1;
  return {
    ...buildUserFrame({ content: `do a thing ${bodyCounter}` }),
    ...over,
  };
}

describe('mode parity (no explicit setting)', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('accepts a prompting sender when the receiver prompts', () => {
    h.setMode(ApprovalMode.DEFAULT);
    const f = frame({ fromMode: 'prompting' });
    expect(h.gate.admit(f)).toBe('accept');
    expect(h.delivered).toEqual([f]);
  });

  it('holds a bypassing sender when the receiver prompts', () => {
    // The per-action prompts guard single actions, not the agenda: a
    // message nobody watched being written waits for the user here too.
    h.setMode(ApprovalMode.DEFAULT);
    expect(h.gate.admit(frame({ fromMode: 'bypass' }))).toBe('held');
    expect(h.delivered).toHaveLength(0);
    expect(h.gate.getHeld()[0].cause).toBe('mode-mismatch');
  });

  it('holds a sender that asserts no mode when the receiver prompts', () => {
    h.setMode(ApprovalMode.DEFAULT);
    expect(h.gate.admit(frame())).toBe('held');
    expect(h.gate.getHeld()[0].cause).toBe('no-mode-asserted');
  });

  it('treats plan mode as prompting', () => {
    h.setMode(ApprovalMode.PLAN);
    expect(h.gate.admit(frame({ fromMode: 'prompting' }))).toBe('accept');
    expect(h.gate.admit(frame({ fromMode: 'bypass' }))).toBe('held');
  });

  it('accepts a bypassing sender when the receiver also bypasses', () => {
    h.setMode(ApprovalMode.YOLO);
    expect(h.gate.admit(frame({ fromMode: 'bypass' }))).toBe('accept');
  });

  it('holds a prompting sender when the receiver bypasses', () => {
    h.setMode(ApprovalMode.YOLO);
    expect(h.gate.admit(frame({ fromMode: 'prompting' }))).toBe('held');
    expect(h.gate.getHeld()[0].cause).toBe('mode-mismatch');
    expect(h.delivered).toHaveLength(0);
  });

  it('holds a sender that asserts no mode when the receiver bypasses', () => {
    h.setMode(ApprovalMode.YOLO);
    expect(h.gate.admit(frame())).toBe('held');
    expect(h.gate.getHeld()[0].cause).toBe('no-mode-asserted');
  });

  it('fails closed when the mode is unknown', () => {
    h.setMode(null);
    expect(h.gate.admit(frame({ fromMode: 'bypass' }))).toBe('held');
    expect(h.gate.getHeld()[0].cause).toBe('mode-unknown');
  });

  it('fails closed when the mode getter throws', () => {
    h.throwOnMode();
    expect(h.gate.admit(frame({ fromMode: 'bypass' }))).toBe('held');
    expect(h.gate.getHeld()[0].cause).toBe('mode-unknown');
  });
});

describe('receiver modes that do not review every action', () => {
  it('holds a prompting sender when the receiver auto-approves edits', () => {
    // AUTO_EDIT applies every edit-shaped tool call with no prompt and no
    // classifier, so an accepted message can rewrite files unseen.
    const h = harness({ mode: ApprovalMode.AUTO_EDIT });
    expect(h.gate.admit(frame({ fromMode: 'prompting' }))).toBe('held');
    expect(h.gate.admit(frame())).toBe('held');
    expect(h.delivered).toHaveLength(0);
  });

  it('still accepts a bypassing sender in auto-edit', () => {
    const h = harness({ mode: ApprovalMode.AUTO_EDIT });
    expect(h.gate.admit(frame({ fromMode: 'bypass' }))).toBe('accept');
  });

  it('holds in AUTO because workspace edits bypass the classifier', () => {
    const h = harness({ mode: ApprovalMode.AUTO });
    expect(h.gate.admit(frame({ fromMode: 'prompting' }))).toBe('held');
    expect(h.gate.admit(frame())).toBe('held');
    expect(h.delivered).toHaveLength(0);
  });

  it('still accepts a bypassing sender in AUTO', () => {
    const h = harness({ mode: ApprovalMode.AUTO });
    expect(h.gate.admit(frame({ fromMode: 'bypass' }))).toBe('accept');
  });

  it('fails closed on a mode value this build does not know', () => {
    const h = harness();
    h.setMode('turbo' as ApprovalMode);
    expect(h.gate.admit(frame({ fromMode: 'bypass' }))).toBe('held');
    expect(h.gate.getHeld()[0].cause).toBe('mode-unknown');
  });
});

describe('review classes', () => {
  it('sorts every known mode into one of the two classes', () => {
    expect(modeClass(ApprovalMode.DEFAULT)).toBe('prompting');
    expect(modeClass(ApprovalMode.PLAN)).toBe('prompting');
    expect(modeClass(ApprovalMode.AUTO_EDIT)).toBe('bypass');
    expect(modeClass(ApprovalMode.AUTO)).toBe('bypass');
    expect(modeClass(ApprovalMode.YOLO)).toBe('bypass');
  });

  it('auto-delivers only within a class, in both directions', () => {
    // The whole table, so a future row cannot quietly reopen the
    // prompting-receiver-accepts-everything shortcut.
    const table: Array<[ApprovalMode, 'prompting' | 'bypass', string]> = [
      [ApprovalMode.DEFAULT, 'prompting', 'accept'],
      [ApprovalMode.DEFAULT, 'bypass', 'held'],
      [ApprovalMode.PLAN, 'prompting', 'accept'],
      [ApprovalMode.PLAN, 'bypass', 'held'],
      [ApprovalMode.AUTO_EDIT, 'prompting', 'held'],
      [ApprovalMode.AUTO_EDIT, 'bypass', 'accept'],
      [ApprovalMode.AUTO, 'prompting', 'held'],
      [ApprovalMode.AUTO, 'bypass', 'accept'],
      [ApprovalMode.YOLO, 'prompting', 'held'],
      [ApprovalMode.YOLO, 'bypass', 'accept'],
    ];
    for (const [mode, sender, expected] of table) {
      const h = harness({ mode });
      const result = h.gate.admit(frame({ fromMode: sender }));
      expect({ mode, sender, result }).toEqual({
        mode,
        sender,
        result: expected,
      });
    }
  });

  it('holds an unasserted sender for every receiver mode', () => {
    for (const mode of [
      ApprovalMode.DEFAULT,
      ApprovalMode.PLAN,
      ApprovalMode.AUTO_EDIT,
      ApprovalMode.AUTO,
      ApprovalMode.YOLO,
    ]) {
      const h = harness({ mode });
      expect({ mode, result: h.gate.admit(frame()) }).toEqual({
        mode,
        result: 'held',
      });
      expect(h.gate.getHeld()[0].cause).toBe('no-mode-asserted');
    }
  });

  it('releases a bypassing sender once the receiver bypasses too', () => {
    const h = harness({ mode: ApprovalMode.DEFAULT });
    const f = frame({ fromMode: 'bypass' });
    expect(h.gate.admit(f)).toBe('held');
    h.setMode(ApprovalMode.YOLO);
    expect(h.gate.reevaluate('mode-changed')).toBe(1);
    expect(h.delivered).toEqual([f]);
  });

  it('keeps holding an unasserted sender across a mode change', () => {
    const h = harness({ mode: ApprovalMode.DEFAULT });
    h.gate.admit(frame());
    h.setMode(ApprovalMode.YOLO);
    expect(h.gate.reevaluate('mode-changed')).toBe(0);
    expect(h.gate.getHeld()).toHaveLength(1);
  });
});

describe('policy scope', () => {
  it('records which scope set a hold on the held entry', () => {
    const h = harness({ policy: 'hold', scope: 'workspace' });
    h.gate.admit(frame({ fromMode: 'prompting' }));
    expect(h.gate.getHeld()[0]).toMatchObject({
      cause: 'explicit-setting',
      policyScope: 'workspace',
    });
  });

  it('leaves the scope off the entry when the host does not report one', () => {
    const h = harness({ policy: 'hold' });
    h.gate.admit(frame({ fromMode: 'prompting' }));
    expect(h.gate.getHeld()[0]).not.toHaveProperty('policyScope');
  });

  it('records the scope of an unreadable value too', () => {
    const h = harness({ scope: 'system' });
    h.setRawPolicy('maybe');
    h.gate.admit(frame({ fromMode: 'prompting' }));
    expect(h.gate.getHeld()[0]).toMatchObject({
      cause: 'policy-unreadable',
      policyScope: 'system',
    });
  });

  it('does not let a broken scope getter change the verdict', () => {
    const h = harness({ policy: 'hold' });
    h.throwOnScope();
    expect(h.gate.admit(frame({ fromMode: 'prompting' }))).toBe('held');
    expect(h.gate.getHeld()[0]).toMatchObject({ cause: 'explicit-setting' });
    expect(h.gate.getHeld()[0]).not.toHaveProperty('policyScope');
  });

  it('refreshes the scope on reevaluate, and drops it when the cause moves on', () => {
    const h = harness({
      mode: ApprovalMode.YOLO,
      policy: 'hold',
      scope: 'user',
    });
    const f = frame({ fromMode: 'prompting' });
    h.gate.admit(f);
    expect(h.gate.getHeld()[0].policyScope).toBe('user');

    h.setScope('workspace');
    expect(h.gate.reevaluate('setting-changed')).toBe(0);
    expect(h.gate.getHeld()[0].policyScope).toBe('workspace');

    // The setting goes away; the message stays held on parity, which has
    // no scope to name.
    h.setPolicy(undefined);
    expect(h.gate.reevaluate('setting-cleared')).toBe(0);
    expect(h.gate.getHeld()[0]).toMatchObject({ cause: 'mode-mismatch' });
    expect(h.gate.getHeld()[0]).not.toHaveProperty('policyScope');
  });

  it('keeps the entry identity when nothing about the hold changed', () => {
    const h = harness({ policy: 'hold', scope: 'user' });
    h.gate.admit(frame({ fromMode: 'prompting' }));
    const before = h.gate.getHeld()[0];
    h.gate.reevaluate('no-op');
    expect(h.gate.getHeld()[0]).toBe(before);
  });
});

describe('explicit setting', () => {
  it('accept overrides a mode mismatch', () => {
    const h = harness({ mode: ApprovalMode.YOLO, policy: 'accept' });
    expect(h.gate.admit(frame({ fromMode: 'prompting' }))).toBe('accept');
  });

  it('hold overrides an otherwise-accepting parity result', () => {
    const h = harness({ mode: ApprovalMode.DEFAULT, policy: 'hold' });
    expect(h.gate.admit(frame({ fromMode: 'prompting' }))).toBe('held');
    expect(h.gate.getHeld()[0].cause).toBe('explicit-setting');
  });

  it('refuse drops the message and tells the sender nobody saw it', () => {
    const h = harness({ mode: ApprovalMode.DEFAULT, policy: 'refuse' });
    expect(h.gate.admit(frame())).toBe('refused');
    expect(h.delivered).toHaveLength(0);
    expect(h.gate.getHeld()).toHaveLength(0);
    // 'refused', not 'denied': nobody reviewed it. The sender should
    // stop rather than wait for a person to reconsider.
    expect(h.statuses.at(-1)?.status).toBe('refused');
  });

  it('refuse wins even when the mode getter is broken', () => {
    const h = harness({ mode: null, policy: 'refuse' });
    h.throwOnMode();
    expect(h.gate.admit(frame())).toBe('refused');
  });
});

describe('unreadable policy setting', () => {
  it('holds when the setting is a value we do not recognize', () => {
    // settings.json is user-edited and the CLI casts it straight through,
    // so "Accept" or `true` reaches the gate verbatim.
    const h = harness({ mode: ApprovalMode.DEFAULT });
    h.setRawPolicy('Accept');
    expect(h.gate.admit(frame())).toBe('held');
    expect(h.gate.getHeld()[0].cause).toBe('policy-unreadable');
    expect(h.delivered).toHaveLength(0);
  });

  it('holds when the setting getter throws', () => {
    const h = harness({ mode: ApprovalMode.DEFAULT });
    h.throwOnPolicy();
    expect(h.gate.admit(frame())).toBe('held');
    expect(h.gate.getHeld()[0].cause).toBe('policy-unreadable');
  });
});

describe('duplicate msgId', () => {
  it('keeps one held entry per id and repeats the verdict', () => {
    // Two entries under one id can never be decided individually: /peers
    // refuses an id that matches more than one message.
    const h = harness({ mode: ApprovalMode.YOLO });
    const first = frame({ message: { role: 'user', content: 'benign' } });
    const forgery = {
      ...first,
      message: { role: 'user' as const, content: 'rm -rf /' },
    };

    expect(h.gate.admit(first)).toBe('held');
    expect(h.gate.admit(forgery)).toBe('held');

    expect(h.gate.getHeld()).toHaveLength(1);
    expect(h.gate.getHeld()[0].frame.message.content).toBe('benign');
    expect(h.gate.decide(first.msgId, 'approve')).toBe('done');
    expect(h.delivered).toEqual([first]);
  });

  it('treats a case-variant id as the same message', () => {
    // /peers resolves case-insensitively, so 'Task-01' and 'task-01' are
    // the same handle: parking both would make neither individually
    // decidable, and approving one would release the other with it.
    const h = harness({ mode: ApprovalMode.YOLO });
    const first = frame({
      msgId: 'Task-01',
      message: { role: 'user', content: 'benign' },
    });
    const clone = {
      ...first,
      msgId: 'task-01',
      message: { role: 'user' as const, content: 'malicious' },
    };

    expect(h.gate.admit(first)).toBe('held');
    expect(h.gate.admit(clone)).toBe('held');

    expect(h.gate.getHeld()).toHaveLength(1);
    expect(h.gate.getHeld()[0].frame.message.content).toBe('benign');
  });

  it('treats a dash-variant id as the same message', () => {
    // /peers prints and resolves ids with dashes stripped, so 'task-0001'
    // and 'task0001' render the identical handle: parking both would make
    // neither individually decidable, and only accept-all/deny-all could
    // reach them.
    const h = harness({ mode: ApprovalMode.YOLO });
    const first = frame({
      msgId: 'task-0001',
      message: { role: 'user', content: 'benign' },
    });
    const clone = {
      ...first,
      msgId: 'task0001',
      message: { role: 'user' as const, content: 'malicious' },
    };

    expect(h.gate.admit(first)).toBe('held');
    expect(h.gate.admit(clone)).toBe('held');

    expect(h.gate.getHeld()).toHaveLength(1);
    expect(h.gate.getHeld()[0].frame.message.content).toBe('benign');
  });
});

describe('settled ids', () => {
  it('refuses a re-sent id after a refusal even when the policy flips', () => {
    // A refusal is terminal on the sender's ledger too, so re-admitting
    // the id would leave the sending transcript saying "don't re-send
    // it" while this session acts on the message: `settleSentPeerMessage`
    // returns undefined for the follow-up `delivered` receipt, and the
    // sender is never told.
    const h = harness({ policy: 'refuse' });
    const f = frame({ msgId: 'task-0002' });

    expect(h.gate.admit(f)).toBe('refused');
    h.setPolicy('accept');
    expect(h.gate.admit(f)).toBe('refused');

    expect(h.delivered).toHaveLength(0);
    expect(h.statuses.map((s) => s.status)).toEqual(['refused', 'refused']);
  });

  it('refuses a re-sent id after denial even when the policy flips', () => {
    // The user's denial is final: a peer re-sending the same id with a
    // swapped body must not get a second decision once modes change.
    const h = harness({ mode: ApprovalMode.YOLO });
    const f = frame({
      msgId: 'task-0001',
      fromMode: 'prompting',
      message: { role: 'user', content: 'benign' },
    });
    expect(h.gate.admit(f)).toBe('held');
    expect(h.gate.decide(f.msgId, 'deny')).toBe('done');

    h.setMode(ApprovalMode.DEFAULT);
    const forgery = frame({
      msgId: 'task-0001',
      fromMode: 'prompting',
      message: { role: 'user', content: 'malicious' },
    });
    expect(h.gate.admit(forgery)).toBe('refused');
    expect(h.delivered).toHaveLength(0);
    expect(h.gate.getHeld()).toHaveLength(0);
    expect(h.statuses.at(-1)).toEqual({
      msgId: 'task-0001',
      status: 'denied',
    });

    // Canonical form: a case/dash-variant resend is the same settled id.
    const variant = frame({ msgId: 'TASK0001', fromMode: 'prompting' });
    expect(h.gate.admit(variant)).toBe('refused');
  });

  it('acks but does not re-deliver an id that was already delivered', () => {
    const h = harness({ mode: ApprovalMode.DEFAULT });
    const f = frame({ msgId: 'task-0002', fromMode: 'prompting' });
    expect(h.gate.admit(f)).toBe('accept');
    expect(h.delivered).toHaveLength(1);
    expect(
      h.gate.admit(frame({ msgId: 'task-0002', fromMode: 'prompting' })),
    ).toBe('refused');
    expect(h.delivered).toHaveLength(1);
    expect(h.statuses.at(-1)).toEqual({
      msgId: 'task-0002',
      status: 'delivered',
    });
  });

  it('settles an approved id against re-sends', () => {
    const h = harness({ mode: ApprovalMode.YOLO });
    const f = frame({ msgId: 'task-0003', fromMode: 'prompting' });
    expect(h.gate.admit(f)).toBe('held');
    expect(h.gate.decide(f.msgId, 'approve')).toBe('done');

    const resend = frame({ msgId: 'task-0003', fromMode: 'prompting' });
    expect(h.gate.admit(resend)).toBe('refused');
    expect(h.delivered).toHaveLength(1);
  });

  it('keeps a reviewed handle when a flood fills the buffer', () => {
    // A full buffer turns arrivals away rather than making room, so a
    // flood can neither destroy the entry the user is looking at nor free
    // its handle for a re-sent body to occupy.
    const h = harness({ mode: ApprovalMode.YOLO });
    const first = frame({ msgId: 'task-0004', fromMode: 'prompting' });
    expect(h.gate.admit(first)).toBe('held');
    for (let i = 0; i < MAX_HELD_MESSAGES; i++) {
      h.gate.admit(frame({ msgId: `filler-${i}`, fromMode: 'prompting' }));
    }
    const isHeld = (msgId: string) =>
      h.gate.getHeld().some((e) => e.frame.msgId === msgId);
    expect(isHeld('task-0004')).toBe(true);

    const forgery = frame({ msgId: 'task-0004', fromMode: 'prompting' });
    expect(h.gate.admit(forgery)).toBe('held');
    expect(
      h.gate.getHeld().filter((e) => e.frame.msgId === 'task-0004'),
    ).toHaveLength(1);
    expect(h.gate.getHeld()[0]!.frame).toBe(first);
  });

  it('settles ids that reevaluate dropped, across a later policy flip', () => {
    const h = harness({ mode: ApprovalMode.YOLO, policy: 'hold' });
    expect(h.gate.admit(frame({ msgId: 'task-0005' }))).toBe('held');
    h.setPolicy('refuse');
    expect(h.gate.reevaluate('setting-changed')).toBe(0);

    h.setPolicy('accept');
    expect(h.gate.admit(frame({ msgId: 'task-0005' }))).toBe('refused');
    expect(h.delivered).toHaveLength(0);
  });

  it('lets an honest retry land after a transient delivery failure', () => {
    // A failed delivery is not a verdict; the retry must still land.
    const h = harness({ mode: ApprovalMode.DEFAULT });
    h.failDelivery();
    const f = frame({ msgId: 'task-0007', fromMode: 'prompting' });
    expect(h.gate.admit(f)).toBe('dropped');
    // A full queue is a drop with a reason of its own, not an expiry: no
    // decision was pending, so none can have run out.
    expect(h.drops.at(-1)).toEqual({
      msgId: 'task-0007',
      reason: 'queue-full',
    });
    expect(h.statuses).toHaveLength(0);

    h.recoverDelivery();
    expect(h.gate.admit(f)).toBe('accept');
    expect(h.delivered).toHaveLength(1);
  });

  it('lets an honest retry of the same body land after a queue-full drop', () => {
    // On a real meter the failed delivery's body is rolled back with the
    // drop: a verbatim retry once the queue drains must meet the same
    // repeat check it would have met had the first attempt never
    // arrived, not be dropped as a duplicate of a message that never
    // landed.
    const h = harness({
      mode: ApprovalMode.DEFAULT,
      admission: new PeerAdmission(),
    });
    h.failDelivery();
    const f = frame({ msgId: 'task-0007', fromMode: 'prompting' });
    expect(h.gate.admit(f)).toBe('dropped');
    expect(h.drops.at(-1)).toEqual({
      msgId: 'task-0007',
      reason: 'queue-full',
    });

    h.recoverDelivery();
    expect(h.gate.admit({ ...f, msgId: 'task-0008' })).toBe('accept');
    expect(h.delivered).toHaveLength(1);
  });

  it('prunes the oldest settled ids beyond the cap', () => {
    const h = harness({ mode: ApprovalMode.DEFAULT });
    const ids = Array.from({ length: MAX_SETTLED_IDS + 1 }, (_, i) => `s-${i}`);
    const prompting = (msgId: string) =>
      frame({ msgId, fromMode: 'prompting' });
    for (const msgId of ids) {
      expect(h.gate.admit(prompting(msgId))).toBe('accept');
    }
    // The oldest fell out of memory; the newest repeats its verdict.
    expect(h.gate.admit(prompting(ids[0]))).toBe('accept');
    expect(h.gate.admit(prompting(ids[ids.length - 1]))).toBe('refused');
  });
});

describe('a transport that throws', () => {
  it('does not strand the rest of the batch when a receipt fails', () => {
    const delivered: PeerUserFrame[] = [];
    let calls = 0;
    const gate = new InboundGate({
      getApprovalMode: () => ApprovalMode.YOLO,
      getPolicySetting: () => undefined,
      deliver: (f) => delivered.push(f),
      reportStatus: () => {
        calls += 1;
        throw new Error('peer socket is gone');
      },
    });
    const a = frame();
    const b = frame();
    expect(() => {
      gate.admit(a);
      gate.admit(b);
    }).not.toThrow();
    expect(gate.getHeld()).toHaveLength(2);

    // Both still reachable, and both get their terminal receipt attempted.
    expect(() => gate.shutdown()).not.toThrow();
    expect(gate.getHeld()).toHaveLength(0);
    expect(calls).toBe(4);
  });

  it('reports a full queue as a drop rather than as an expiry', () => {
    // 'expired' would tell the sender a decision ran out; none was ever
    // pending. The reason says what actually happened.
    const statuses: string[] = [];
    const drops: string[] = [];
    const gate = new InboundGate({
      getApprovalMode: () => ApprovalMode.DEFAULT,
      getPolicySetting: () => undefined,
      deliver: () => {
        throw new Error('queue is gone');
      },
      reportStatus: (_frame, status) => statuses.push(status),
      reportDropped: (_frame, reason) => drops.push(reason),
    });
    expect(gate.admit(frame({ fromMode: 'prompting' }))).toBe('dropped');
    expect(statuses).toEqual([]);
    expect(drops).toEqual(['queue-full']);
  });
});

describe('receipts', () => {
  it('reports delivered on accept', () => {
    const h = harness({ mode: ApprovalMode.DEFAULT });
    const f = frame({ fromMode: 'prompting' });
    h.gate.admit(f);
    expect(h.statuses).toEqual([{ msgId: f.msgId, status: 'delivered' }]);
  });

  it('reports held on hold, then delivered on approval', () => {
    const h = harness({ mode: ApprovalMode.YOLO });
    const f = frame();
    h.gate.admit(f);
    expect(h.statuses).toEqual([{ msgId: f.msgId, status: 'held' }]);

    expect(h.gate.decide(f.msgId, 'approve')).toBe('done');
    expect(h.delivered).toEqual([f]);
    expect(h.statuses.at(-1)).toEqual({ msgId: f.msgId, status: 'delivered' });
  });

  it('drops an approved hold when a session swap invalidates its pin', () => {
    let currentSessionId = 'session-a';
    const delivered: PeerUserFrame[] = [];
    const statuses: string[] = [];
    const gate = new InboundGate({
      getApprovalMode: () => ApprovalMode.YOLO,
      getPolicySetting: () => undefined,
      getSessionId: () => currentSessionId,
      deliver: (candidate) => delivered.push(candidate),
      reportStatus: (_candidate, status) => statuses.push(status),
    });
    const held = frame({
      fromMode: 'prompting',
      toSessionId: 'session-a',
    });
    expect(gate.admit(held)).toBe('held');

    currentSessionId = 'session-b';
    // 'gone', not 'done': the caller must not tell the user it was
    // released when it was dropped.
    expect(gate.decide(held.msgId, 'approve')).toBe('gone');
    expect(delivered).toEqual([]);
    expect(statuses).toEqual(['held', 'misaddressed']);
  });

  it('tombstones a misaddressed drop so a re-send repeats the verdict', () => {
    for (const path of ['decide', 'reevaluate'] as const) {
      let currentSessionId = 'session-a';
      let mode = ApprovalMode.YOLO;
      const delivered: PeerUserFrame[] = [];
      const statuses: string[] = [];
      const gate = new InboundGate({
        getApprovalMode: () => mode,
        getPolicySetting: () => undefined,
        getSessionId: () => currentSessionId,
        deliver: (candidate) => delivered.push(candidate),
        reportStatus: (_candidate, status) => statuses.push(status),
      });
      const held = frame({ fromMode: 'prompting', toSessionId: 'session-a' });
      expect(gate.admit(held)).toBe('held');
      currentSessionId = 'session-b';
      if (path === 'decide') {
        gate.decide(held.msgId, 'approve');
      } else {
        // A mode change that would release the hold reaches the pin check.
        mode = ApprovalMode.DEFAULT;
        gate.reevaluate('test');
      }
      expect(statuses).toEqual(['held', 'misaddressed']);

      // The user /resume-s session-a; a re-send of the same id with a
      // swapped body passes the arrival pin check. It must not be
      // re-decided — the drop was terminal.
      currentSessionId = 'session-a';
      const resent = {
        ...held,
        message: { role: 'user' as const, content: 'body-2' },
      };
      expect(gate.admit(resent)).toBe('refused');
      expect(delivered).toEqual([]);
      expect(gate.getHeld()).toHaveLength(0);
      expect(statuses).toEqual(['held', 'misaddressed', 'misaddressed']);
    }
  });

  it('reports denied when a held message is rejected', () => {
    const h = harness({ mode: ApprovalMode.YOLO });
    const f = frame();
    h.gate.admit(f);
    expect(h.gate.decide(f.msgId, 'deny')).toBe('done');
    expect(h.delivered).toHaveLength(0);
    expect(h.statuses.at(-1)).toEqual({ msgId: f.msgId, status: 'denied' });
  });

  it('reports a decision on an unknown id as gone rather than throwing', () => {
    const h = harness({ mode: ApprovalMode.YOLO });
    const parked = frame();
    h.gate.admit(parked);

    expect(h.gate.decide('never-seen', 'approve')).toBe('gone');
    expect(h.delivered).toHaveLength(0);
    // A miss must not fall through onto whatever else is parked: an id
    // nobody recognizes is the one case where releasing *something* is
    // worse than releasing nothing.
    expect(h.gate.getHeld().map((entry) => entry.frame.msgId)).toEqual([
      parked.msgId,
    ]);
  });

  it('survives a reportStatus that is not wired at all', () => {
    const gate = new InboundGate({
      getApprovalMode: () => ApprovalMode.YOLO,
      getPolicySetting: () => undefined,
      deliver: () => {},
    });
    expect(() => gate.admit(frame())).not.toThrow();
    expect(gate.getHeld()).toHaveLength(1);
  });
});

describe('hold buffer bounds', () => {
  it('turns a newcomer away once full, keeping what the user has not read', () => {
    // An arrival must not be able to destroy a message the user has yet
    // to review: the cost of a full buffer falls on the sender that could
    // not fit, which is told so and can retry.
    const h = harness({ mode: ApprovalMode.YOLO });
    const first = frame();
    h.gate.admit(first);
    for (let i = 0; i < MAX_HELD_MESSAGES - 1; i++) h.gate.admit(frame());
    expect(h.gate.getHeld()).toHaveLength(MAX_HELD_MESSAGES);

    const late = frame();
    expect(h.gate.admit(late)).toBe('dropped');
    expect(h.gate.getHeld()).toHaveLength(MAX_HELD_MESSAGES);
    expect(
      h.gate.getHeld().some((entry) => entry.frame.msgId === first.msgId),
    ).toBe(true);
    expect(h.drops.at(-1)).toEqual({ msgId: late.msgId, reason: 'queue-full' });
    expect(h.statuses.some((s) => s.status === 'expired')).toBe(false);
  });

  it('leaves no tombstone when a full buffer turns a message away', () => {
    // The retry is honest — the message was never seen — so it must meet
    // the gate rather than a repeat of a verdict nobody gave.
    const h = harness({ mode: ApprovalMode.YOLO });
    for (let i = 0; i < MAX_HELD_MESSAGES; i++) h.gate.admit(frame());
    const late = frame();
    expect(h.gate.admit(late)).toBe('dropped');

    h.gate.decide(h.gate.getHeld()[0]!.frame.msgId, 'deny');
    expect(h.gate.admit(late)).toBe('held');
  });
});

describe('reevaluate', () => {
  it('releases messages once the modes agree', () => {
    const h = harness({ mode: ApprovalMode.YOLO });
    const f = frame({ fromMode: 'prompting' });
    h.gate.admit(f);
    expect(h.delivered).toHaveLength(0);

    h.setMode(ApprovalMode.DEFAULT);
    expect(h.gate.reevaluate('mode-changed')).toBe(1);
    expect(h.delivered).toEqual([f]);
    expect(h.gate.getHeld()).toHaveLength(0);
  });

  it('drops a releasable hold when a session swap invalidates its pin', () => {
    let mode = ApprovalMode.YOLO;
    let currentSessionId = 'session-a';
    const delivered: PeerUserFrame[] = [];
    const statuses: string[] = [];
    const gate = new InboundGate({
      getApprovalMode: () => mode,
      getPolicySetting: () => undefined,
      getSessionId: () => currentSessionId,
      deliver: (candidate) => delivered.push(candidate),
      reportStatus: (_candidate, status) => statuses.push(status),
    });
    const held = frame({
      fromMode: 'prompting',
      toSessionId: 'session-a',
    });
    expect(gate.admit(held)).toBe('held');

    currentSessionId = 'session-b';
    mode = ApprovalMode.DEFAULT;
    expect(gate.reevaluate('mode-changed')).toBe(0);
    expect(delivered).toEqual([]);
    expect(gate.getHeld()).toEqual([]);
    expect(statuses).toEqual(['held', 'misaddressed']);
  });

  it('drops the backlog when the policy becomes refuse', () => {
    const h = harness({ mode: ApprovalMode.YOLO });
    const f = frame();
    h.gate.admit(f);

    h.setPolicy('refuse');
    expect(h.gate.reevaluate('setting-changed')).toBe(0);
    expect(h.gate.getHeld()).toHaveLength(0);
    expect(h.delivered).toHaveLength(0);
    expect(h.statuses.at(-1)).toEqual({ msgId: f.msgId, status: 'denied' });
  });

  it('keeps holding and refreshes the cause when it changes', () => {
    const h = harness({ mode: ApprovalMode.YOLO });
    const f = frame();
    h.gate.admit(f);
    expect(h.gate.getHeld()[0].cause).toBe('no-mode-asserted');

    h.setPolicy('hold');
    expect(h.gate.reevaluate('setting-changed')).toBe(0);
    expect(h.gate.getHeld()).toHaveLength(1);
    expect(h.gate.getHeld()[0].cause).toBe('explicit-setting');
  });

  it('is a cheap no-op when nothing is held', () => {
    const h = harness({ mode: ApprovalMode.YOLO });
    const before = h.heldChanges;
    expect(h.gate.reevaluate('mode-changed')).toBe(0);
    expect(h.heldChanges).toBe(before);
  });
});

describe('shutdown', () => {
  it('settles everything held as expired', () => {
    const h = harness({ mode: ApprovalMode.YOLO });
    const f = frame();
    h.gate.admit(f);

    h.gate.shutdown();
    expect(h.gate.getHeld()).toHaveLength(0);
    expect(h.statuses.at(-1)).toEqual({ msgId: f.msgId, status: 'expired' });
  });

  it('expires a late arrival instead of parking it forever', () => {
    const h = harness({ mode: ApprovalMode.YOLO });
    h.gate.shutdown();

    const late = frame();
    expect(h.gate.admit(late)).toBe('refused');
    expect(h.gate.getHeld()).toHaveLength(0);
    expect(h.statuses.at(-1)).toEqual({ msgId: late.msgId, status: 'expired' });
  });

  it('expires an accepted message that arrives after shutdown', () => {
    // The input queue dies with the session, so "delivered" would be a
    // lie the sender acts on. It has to hear that nothing happened.
    const h = harness({ mode: ApprovalMode.DEFAULT });
    h.gate.shutdown();
    const late = frame();
    expect(h.gate.admit(late)).toBe('refused');
    expect(h.delivered).toHaveLength(0);
    expect(h.statuses.at(-1)).toEqual({ msgId: late.msgId, status: 'expired' });
  });
});

describe('onHeldChange', () => {
  it('fires on hold and on decision', () => {
    const h = harness({ mode: ApprovalMode.YOLO });
    const f = frame();
    h.gate.admit(f);
    expect(h.heldChanges).toBe(1);
    h.gate.decide(f.msgId, 'deny');
    expect(h.heldChanges).toBe(2);
  });

  it('does not let a throwing observer break the gate', () => {
    const deliver = vi.fn();
    const gate = new InboundGate({
      getApprovalMode: () => ApprovalMode.YOLO,
      getPolicySetting: () => undefined,
      deliver,
      onHeldChange: () => {
        throw new Error('ui exploded');
      },
    });
    const f = frame();
    expect(() => gate.admit(f)).not.toThrow();
    expect(gate.decide(f.msgId, 'approve')).toBe('done');
    expect(deliver).toHaveBeenCalledWith(f, { selfSent: false });
  });
});

describe('delivery failure after review', () => {
  it('re-holds an approved message whose delivery fails', () => {
    // A full input queue must not turn an approval into a silent,
    // unrecoverable drop: the message stays reviewable and the sender
    // hears it is still waiting, not that it expired.
    const h = harness({ mode: ApprovalMode.YOLO });
    const f = frame({ fromMode: 'prompting' });
    expect(h.gate.admit(f)).toBe('held');

    h.failDelivery();
    expect(h.gate.decide(f.msgId, 'approve')).toBe('failed');
    expect(h.delivered).toHaveLength(0);
    expect(h.gate.getHeld()).toHaveLength(1);
    expect(h.gate.getHeld()[0].frame.msgId).toBe(f.msgId);
    expect(h.statuses.at(-1)).toEqual({ msgId: f.msgId, status: 'held' });
  });

  it('lets the user retry a failed approval once delivery recovers', () => {
    const h = harness({ mode: ApprovalMode.YOLO });
    const f = frame({ fromMode: 'prompting' });
    h.gate.admit(f);
    h.failDelivery();
    expect(h.gate.decide(f.msgId, 'approve')).toBe('failed');

    h.recoverDelivery();
    expect(h.gate.decide(f.msgId, 'approve')).toBe('done');
    expect(h.delivered).toEqual([f]);
    expect(h.gate.getHeld()).toHaveLength(0);
    expect(h.statuses.at(-1)).toEqual({ msgId: f.msgId, status: 'delivered' });
  });

  it('reinserts a failed approval at its original position', () => {
    const h = harness({ mode: ApprovalMode.YOLO });
    const first = frame({ fromMode: 'prompting' });
    const second = frame({ fromMode: 'prompting' });
    h.gate.admit(first);
    h.gate.admit(second);

    h.failDelivery();
    expect(h.gate.decide(first.msgId, 'approve')).toBe('failed');
    expect(h.gate.getHeld().map((entry) => entry.frame.msgId)).toEqual([
      first.msgId,
      second.msgId,
    ]);
  });

  it('re-holds messages whose delivery fails during reevaluate', () => {
    const h = harness({ mode: ApprovalMode.YOLO });
    const f = frame({ fromMode: 'prompting' });
    h.gate.admit(f);

    h.failDelivery();
    h.setMode(ApprovalMode.DEFAULT);
    expect(h.gate.reevaluate('mode-changed')).toBe(0);
    expect(h.delivered).toHaveLength(0);
    expect(h.gate.getHeld()).toHaveLength(1);
    expect(h.gate.getHeld()[0].frame.msgId).toBe(f.msgId);
    expect(h.statuses.at(-1)).toEqual({ msgId: f.msgId, status: 'held' });
  });
});

describe('describeHoldCause', () => {
  it('explains every cause in user terms', () => {
    expect(describeHoldCause('explicit-setting')).toContain(
      'crossSessionInbound',
    );
    expect(describeHoldCause('mode-mismatch')).toContain('without per-action');
    expect(describeHoldCause('mode-mismatch')).toContain(
      'different review modes',
    );
    expect(describeHoldCause('no-mode-asserted')).toContain('did not say');
    expect(describeHoldCause('mode-unknown')).toContain('could not be');
    expect(describeHoldCause('policy-unreadable')).toContain(
      'crossSessionInbound',
    );
  });

  it('names who set the policy instead of blaming the user', () => {
    expect(describeHoldCause('explicit-setting', 'user')).toContain('your ');
    expect(describeHoldCause('explicit-setting', 'workspace')).toContain(
      'repository',
    );
    expect(describeHoldCause('explicit-setting', 'workspace')).not.toContain(
      'your ',
    );
    expect(describeHoldCause('explicit-setting', 'system')).toContain(
      'system setting',
    );
    expect(describeHoldCause('policy-unreadable', 'workspace')).toContain(
      'workspace settings',
    );
    expect(describeHoldCause('policy-unreadable', 'system')).toContain(
      'system settings',
    );
    // The parity causes have no scope to name; passing one is harmless.
    expect(describeHoldCause('mode-mismatch', 'workspace')).toBe(
      describeHoldCause('mode-mismatch'),
    );
  });
});

describe('self-sent messages (child token)', () => {
  const own = { selfSent: true };

  it('accepts a message a peer would be held for', () => {
    // Bypassing receiver, sender asserting no mode: the parity rule holds
    // an unknown peer here, and does not apply to the session's own process.
    const h = harness({ mode: ApprovalMode.YOLO });
    const f = frame();
    expect(h.gate.admit(f, own)).toBe('accept');
    expect(h.delivered).toEqual([f]);
    expect(h.deliveredAsSelfSent).toEqual([true]);
    expect(h.statuses).toEqual([{ msgId: f.msgId, status: 'delivered' }]);
  });

  it('holds the same frame when the transport does not vouch for it', () => {
    const h = harness({ mode: ApprovalMode.YOLO });
    expect(h.gate.admit(frame())).toBe('held');
    expect(h.gate.getHeld()[0].cause).toBe('no-mode-asserted');
    expect(h.gate.getHeld()[0].selfSent).toBeUndefined();
  });

  it('does not depend on the receiver mode being known', () => {
    const h = harness({ mode: null });
    expect(h.gate.admit(frame(), own)).toBe('accept');
  });

  it('yields to an explicit hold, and is released as itself later', () => {
    const h = harness({ mode: ApprovalMode.YOLO, policy: 'hold' });
    const f = frame();
    expect(h.gate.admit(f, own)).toBe('held');
    expect(h.gate.getHeld()[0]).toMatchObject({
      cause: 'explicit-setting',
      selfSent: true,
    });

    h.setPolicy(undefined);
    expect(h.gate.reevaluate('setting cleared')).toBe(1);
    expect(h.delivered).toEqual([f]);
    expect(h.deliveredAsSelfSent).toEqual([true]);
  });

  it('yields to an explicit refuse', () => {
    const h = harness({ policy: 'refuse' });
    const f = frame();
    expect(h.gate.admit(f, own)).toBe('refused');
    expect(h.statuses).toEqual([{ msgId: f.msgId, status: 'refused' }]);
  });

  it('keeps its origin through a manual approval', () => {
    const h = harness({ policy: 'hold' });
    const f = frame();
    h.gate.admit(f, own);
    expect(h.gate.decide(f.msgId, 'approve')).toBe('done');
    expect(h.deliveredAsSelfSent).toEqual([true]);
  });

  it('is decided by the transport, never by the frame', () => {
    // A frame cannot spell "self-sent" in any field; the flag is a
    // separate argument the inbox supplies. Omitting it means peer.
    const h = harness({ mode: ApprovalMode.YOLO });
    const f = frame({ from: '/tmp/own-session.sock' });
    expect(h.gate.admit(f)).toBe('held');
  });
});

describe('controller grants', () => {
  const VOICE: PeerControllerIdentity = { id: 'c_0123abcd', label: 'voice' };
  const viaController = { selfSent: false, controller: VOICE };

  it('accepts a message a peer would be held for', () => {
    // No `fromMode` at all: an external program has no review class to
    // assert, and under parity alone this is held for every receiver.
    const h = harness({ mode: ApprovalMode.DEFAULT });
    const f = frame();
    expect(h.gate.admit(f, viaController)).toBe('accept');
    expect(h.delivered).toEqual([f]);
    expect(h.deliveredControllers).toEqual([VOICE]);
    expect(h.statuses).toEqual([{ msgId: f.msgId, status: 'delivered' }]);
  });

  it('accepts into either review class', () => {
    for (const mode of [
      ApprovalMode.DEFAULT,
      ApprovalMode.AUTO,
      ApprovalMode.YOLO,
    ]) {
      const h = harness({ mode });
      expect(h.gate.admit(frame(), viaController)).toBe('accept');
    }
  });

  it('does not depend on the receiver mode being known', () => {
    // Parity cannot speak for an unrecognized mode, but a grant is not a
    // parity judgement: the user authorized this program directly.
    const h = harness({ mode: null });
    expect(h.gate.admit(frame(), viaController)).toBe('accept');
  });

  it('yields to an explicit hold and keeps the grant on the entry', () => {
    const h = harness({ mode: ApprovalMode.DEFAULT, policy: 'hold' });
    const f = frame();
    expect(h.gate.admit(f, viaController)).toBe('held');
    expect(h.gate.getHeld()[0]).toMatchObject({
      cause: 'explicit-setting',
      controller: VOICE,
    });
    expect(h.gate.getHeld()[0].selfSent).toBeUndefined();
  });

  it('yields to an explicit refuse', () => {
    const h = harness({ policy: 'refuse' });
    const f = frame();
    expect(h.gate.admit(f, viaController)).toBe('refused');
    expect(h.statuses).toEqual([{ msgId: f.msgId, status: 'refused' }]);
  });

  it('fails closed when the configured policy is invalid', () => {
    const h = harness();
    h.setRawPolicy('invalid');
    expect(h.gate.admit(frame(), viaController)).toBe('held');
    expect(h.gate.getHeld()[0]).toMatchObject({
      cause: 'policy-unreadable',
      controller: VOICE,
    });
  });

  it('keeps its origin through a manual approval', () => {
    // Releasing a parked message has to rebuild the envelope it would
    // have had on arrival, controller attribution included.
    const h = harness({ policy: 'hold' });
    const f = frame();
    h.gate.admit(f, viaController);
    expect(h.gate.decide(f.msgId, 'approve')).toBe('done');
    expect(h.deliveredControllers).toEqual([VOICE]);
    expect(h.deliveredAsSelfSent).toEqual([false]);
  });

  it('keeps its origin through a re-evaluation', () => {
    const h = harness({ mode: ApprovalMode.DEFAULT, policy: 'hold' });
    const f = frame();
    h.gate.admit(f, viaController);
    h.setPolicy(undefined);
    expect(h.gate.reevaluate('setting cleared')).toBe(1);
    expect(h.delivered).toEqual([f]);
    expect(h.deliveredControllers).toEqual([VOICE]);
  });

  it('forgets a revoked grant before automatic re-evaluation', () => {
    const h = harness({ mode: ApprovalMode.DEFAULT, policy: 'hold' });
    const f = frame();
    h.gate.admit(f, viaController);

    expect(h.gate.forgetController(VOICE.id)).toBe(1);
    expect(h.gate.getHeld()).toMatchObject([{ cause: 'explicit-setting' }]);
    expect(h.gate.getHeld()[0].controller).toBeUndefined();

    h.setPolicy(undefined);
    expect(h.gate.reevaluate('setting cleared')).toBe(0);
    expect(h.delivered).toHaveLength(0);
    expect(h.gate.getHeld()).toMatchObject([{ cause: 'no-mode-asserted' }]);
  });

  it('forgets every invalid id removed with the same credential', () => {
    let isValid = true;
    const h = harness({
      policy: 'hold',
      isControllerValid: () => isValid,
    });
    const other: PeerControllerIdentity = {
      id: 'c_9999ffff',
      label: 'voice alias',
    };
    h.gate.admit(frame(), viaController);
    h.gate.admit(frame(), { selfSent: false, controller: other });

    isValid = false;
    expect(h.gate.forgetController(VOICE.id)).toBe(2);
    expect(h.gate.getHeld()).toHaveLength(2);
    expect(h.gate.getHeld().every((entry) => !entry.controller)).toBe(true);
  });

  it('forgets a grant that is no longer valid before automatic re-evaluation', () => {
    let isValid = true;
    const h = harness({
      mode: ApprovalMode.DEFAULT,
      policy: 'hold',
      isControllerValid: () => isValid,
    });
    const f = frame();
    h.gate.admit(f, viaController);

    isValid = false;
    h.setPolicy(undefined);
    expect(h.gate.reevaluate('setting cleared')).toBe(0);
    expect(h.delivered).toHaveLength(0);
    expect(h.gate.getHeld()).toMatchObject([{ cause: 'no-mode-asserted' }]);
    expect(h.gate.getHeld()[0].controller).toBeUndefined();
  });

  it('does not attribute a manually approved message to an invalid grant', () => {
    let isValid = true;
    const h = harness({
      policy: 'hold',
      isControllerValid: () => isValid,
    });
    const f = frame();
    h.gate.admit(f, viaController);

    isValid = false;
    expect(h.gate.decide(f.msgId, 'approve')).toBe('done');
    expect(h.delivered).toEqual([f]);
    expect(h.deliveredControllers).toEqual([undefined]);
  });

  it('keeps its origin when re-evaluation changes only the hold cause', () => {
    const h = harness({ mode: ApprovalMode.DEFAULT, policy: 'hold' });
    const f = frame();
    h.gate.admit(f, viaController);
    h.throwOnPolicy();
    expect(h.gate.reevaluate('policy became unreadable')).toBe(0);
    expect(h.gate.getHeld()[0]).toMatchObject({
      cause: 'policy-unreadable',
      controller: VOICE,
    });
  });

  it('is decided by the transport, never by the frame', () => {
    // Nothing a sender can write into a frame names a grant; the
    // identity is a separate argument the inbox supplies from the auth
    // line. Omitting it means an ordinary peer.
    const h = harness({ mode: ApprovalMode.DEFAULT });
    const f = frame({
      fromName: 'voice',
      from: '/tmp/voice.sock',
    } as Partial<PeerUserFrame>);
    expect(h.gate.admit(f)).toBe('held');
    expect(h.gate.getHeld()[0].cause).toBe('no-mode-asserted');
    expect(h.gate.getHeld()[0].controller).toBeUndefined();
  });

  it('ranks below an explicit setting but above parity', () => {
    // The order that matters: `hold` beats the grant, and the grant
    // beats a class mismatch.
    const h = harness({ mode: ApprovalMode.DEFAULT });
    expect(h.gate.admit(frame({ fromMode: 'bypass' }), viaController)).toBe(
      'accept',
    );
    h.setPolicy('hold');
    expect(h.gate.admit(frame({ fromMode: 'bypass' }), viaController)).toBe(
      'held',
    );
  });
});

describe('held message expiry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('expires a held message and tells the sender nobody answered', () => {
    const h = harness({ policy: 'hold', heldExpiryMs: 60_000 });
    const f = frame();
    expect(h.gate.admit(f)).toBe('held');
    expect(h.statuses).toEqual([{ msgId: f.msgId, status: 'held' }]);

    vi.advanceTimersByTime(60_001);

    expect(h.gate.getHeld()).toHaveLength(0);
    expect(h.statuses.at(-1)).toEqual({ msgId: f.msgId, status: 'expired' });
    expect(h.delivered).toHaveLength(0);
  });

  it('leaves a message alone until its hold actually runs out', () => {
    const h = harness({ policy: 'hold', heldExpiryMs: 60_000 });
    h.gate.admit(frame());
    vi.advanceTimersByTime(59_000);
    expect(h.gate.getHeld()).toHaveLength(1);
    vi.advanceTimersByTime(2_000);
    expect(h.gate.getHeld()).toHaveLength(0);
  });

  it('notifies the UI when a message expires', () => {
    const h = harness({ policy: 'hold', heldExpiryMs: 60_000 });
    h.gate.admit(frame());
    const before = h.heldChanges;
    vi.advanceTimersByTime(60_001);
    expect(h.heldChanges).toBeGreaterThan(before);
  });

  it('never expires when the lifetime is null', () => {
    const h = harness({ policy: 'hold', heldExpiryMs: null });
    h.gate.admit(frame());
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(h.gate.getHeld()).toHaveLength(1);
    expect(h.statuses.map((s) => s.status)).toEqual(['held']);
  });

  it('expires each message on its own clock, oldest first', () => {
    const h = harness({ policy: 'hold', heldExpiryMs: 60_000 });
    const first = frame();
    h.gate.admit(first);
    vi.advanceTimersByTime(30_000);
    const second = frame();
    h.gate.admit(second);

    // The first is 60 s old here, the second only 30 s.
    vi.advanceTimersByTime(30_001);
    expect(h.gate.getHeld().map((e) => e.frame.msgId)).toEqual([second.msgId]);
    expect(h.statuses.at(-1)).toEqual({
      msgId: first.msgId,
      status: 'expired',
    });

    vi.advanceTimersByTime(30_000);
    expect(h.gate.getHeld()).toHaveLength(0);
    expect(h.statuses.at(-1)).toEqual({
      msgId: second.msgId,
      status: 'expired',
    });
  });

  it('is gone rather than releasable once it has expired', () => {
    const h = harness({ policy: 'hold', heldExpiryMs: 60_000 });
    const f = frame();
    h.gate.admit(f);
    // `setSystemTime`, not `advanceTimersByTime`: advancing fires the
    // armed timer, which sweeps before `decide()` is even called, so the
    // guard at the top of `decide()` would never run and deleting it
    // would leave this test green. A suspended or starved clock is the
    // case the guard exists for -- and the one where a user who ran
    // /peers (which does not sweep) would otherwise have an overdue
    // message injected and receipted 'delivered'.
    vi.setSystemTime(Date.now() + 60_001);
    expect(h.gate.decide(f.msgId, 'approve')).toBe('gone');
    expect(h.delivered).toHaveLength(0);
  });

  it('applies a shortened lifetime to messages already waiting', () => {
    const h = harness({ policy: 'hold', heldExpiryMs: 10 * 60_000 });
    const f = frame();
    h.gate.admit(f);
    vi.advanceTimersByTime(2 * 60_000);
    expect(h.gate.getHeld()).toHaveLength(1);

    // The user shortens the hold to a minute; this message is already
    // two minutes old and should settle at once, not wait eight more.
    h.setHeldExpiryMs(60_000);
    h.gate.reevaluate('setting changed');

    expect(h.gate.getHeld()).toHaveLength(0);
    expect(h.statuses.at(-1)).toEqual({ msgId: f.msgId, status: 'expired' });
  });

  it('gives a longer lifetime to messages already waiting', () => {
    const h = harness({ policy: 'hold', heldExpiryMs: 60_000 });
    h.gate.admit(frame());
    vi.advanceTimersByTime(30_000);
    h.setHeldExpiryMs(10 * 60_000);
    h.gate.reevaluate('setting changed');

    vi.advanceTimersByTime(60_000);
    expect(h.gate.getHeld()).toHaveLength(1);
  });

  it('stops expiring once the lifetime becomes null', () => {
    const h = harness({ policy: 'hold', heldExpiryMs: 60_000 });
    h.gate.admit(frame());
    h.setHeldExpiryMs(null);
    h.gate.reevaluate('setting changed');

    vi.advanceTimersByTime(10 * 60_000);
    expect(h.gate.getHeld()).toHaveLength(1);
  });

  it('does not restart the clock when a release fails', () => {
    const h = harness({ policy: 'hold', heldExpiryMs: 60_000 });
    const f = frame();
    h.gate.admit(f);
    vi.advanceTimersByTime(50_000);

    h.failDelivery();
    expect(h.gate.decide(f.msgId, 'approve')).toBe('failed');
    h.recoverDelivery();

    // Ten seconds of its minute are left, not a fresh minute.
    vi.advanceTimersByTime(10_001);
    expect(h.gate.getHeld()).toHaveLength(0);
    expect(h.statuses.at(-1)).toEqual({ msgId: f.msgId, status: 'expired' });
  });

  it('sweeps on arrival even if the timer never fired', () => {
    const h = harness({ policy: 'hold', heldExpiryMs: 60_000 });
    const old = frame();
    h.gate.admit(old);
    // A suspended machine: the clock moves without timers running.
    vi.setSystemTime(Date.now() + 120_000);

    const fresh = frame();
    h.gate.admit(fresh);
    expect(h.gate.getHeld().map((e) => e.frame.msgId)).toEqual([fresh.msgId]);
    expect(
      h.statuses.some((s) => s.msgId === old.msgId && s.status === 'expired'),
    ).toBe(true);
  });

  it('clamps the delay for an entry with no monotonic anchor', () => {
    // The clamp is only reachable through the wall-clock fallback: every
    // entry `admit()` builds carries `monotonicAt`, so its age is never
    // negative and the delay never exceeds the lifetime. An entry
    // without the anchor -- an older caller, or a hand-built one -- ages
    // on the wall clock alone, and a far-backward step then makes
    // `expiryMs - age` overflow setTimeout's 32-bit ceiling. Node clamps
    // such a delay to 1 ms and warns, so the callback re-arms the same
    // oversized value and spins at ~1 kHz until the buffer drains.
    //
    // `vi.setSystemTime` cannot be used to reach this through `ageOf`:
    // vitest's faked `performance.now` moves with it, so the monotonic
    // side never diverges and the age stays ~0.
    const delays: number[] = [];
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
      ms?: number,
    ) => {
      delays.push(ms ?? 0);
      return { unref: () => {} } as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout);
    try {
      const h = harness({ policy: 'hold', heldExpiryMs: 60_000 });
      h.gate.admit(frame());
      // Strip the anchor, then step the wall clock back 30 days.
      const entry = h.gate.getHeld()[0] as { monotonicAt?: number };
      delete entry.monotonicAt;
      vi.setSystemTime(Date.now() - 30 * 24 * 60 * 60_000);
      delays.length = 0;

      h.gate.reevaluate('clock-step');

      expect(delays.length).toBeGreaterThan(0);
      // Unclamped this would be ~2.592e12; the ceiling is what stops the
      // 1 ms re-arm loop.
      expect(delays[0]).toBe(2 ** 31 - 1);
    } finally {
      spy.mockRestore();
    }
  });

  it('expires on the monotonic clock when the wall clock steps backward', () => {
    // The reason `monotonicAt` exists. A backward NTP correction makes
    // the wall age negative, so a wall-only reading never sees the hold
    // as overdue and the message is parked past its lifetime with no
    // receipt. The clocks have to be driven apart explicitly: under fake
    // timers `vi.setSystemTime` moves both.
    let monotonic = 0;
    const perf = vi
      .spyOn(performance, 'now')
      .mockImplementation(() => monotonic);
    try {
      const h = harness({ policy: 'hold', heldExpiryMs: 60_000 });
      const f = frame();
      h.gate.admit(f);

      // An hour backward, four seconds in: wall age is now about -1h.
      monotonic += 4_000;
      vi.setSystemTime(Date.now() - 60 * 60_000);
      expect(Date.now() - h.gate.getHeld()[0].heldAt).toBeLessThan(0);

      // A full lifetime of monotonic time passes.
      monotonic += 60_001;
      h.gate.admit(frame());

      expect(
        h.statuses.some((s) => s.msgId === f.msgId && s.status === 'expired'),
      ).toBe(true);
    } finally {
      perf.mockRestore();
    }
  });

  it('keeps the buffer oldest-first when a failed release re-parks', () => {
    // `reevaluate` walks the buffer in order but appends a failed release
    // at the END, keeping its original (older) timestamp -- so the buffer
    // stops being oldest-first. That misaims two things that read it
    // positionally: the expiry timer armed from the head, and the
    // `held.shift()` eviction at MAX_HELD_MESSAGES, which would then
    // evict the newest message instead of the oldest.
    //
    // Park both under an unknown mode, then resolve it to one that
    // releases exactly one of them: `bypass` is accepted by an auto-edit
    // receiver, `prompting` is still held on the mode mismatch.
    const h = harness({ mode: null, heldExpiryMs: 60_000 });
    const older = frame({ fromMode: 'bypass' });
    expect(h.gate.admit(older)).toBe('held');
    vi.advanceTimersByTime(10_000);
    const newer = frame({ fromMode: 'prompting' });
    expect(h.gate.admit(newer)).toBe('held');

    h.failDelivery();
    h.setMode(ApprovalMode.AUTO_EDIT);
    h.gate.reevaluate('approval-mode-changed');

    // `older` was released, failed, and re-parked; `newer` never left.
    // Appending the failure would leave [newer, older].
    expect(h.gate.getHeld().map((e) => e.frame.msgId)).toEqual([
      older.msgId,
      newer.msgId,
    ]);
  });

  it('falls back to the default lifetime when the setting cannot be read', () => {
    // Fail-closed, matching the mode and policy getters beside it. A
    // throw here would escape `getHeldExpiryMs` through `expireOverdue`
    // into the first statement of `admit()` and drop every inbound frame
    // with no receipt at all.
    const h = harness({ policy: 'hold', heldExpiryMs: 10 * 60_000 });
    h.throwOnExpiry();
    expect(h.gate.getHeldExpiryMs()).toBe(DEFAULT_HELD_EXPIRY_MS);
    // And a frame still gets through the gate rather than throwing.
    const f = frame();
    expect(h.gate.admit(f)).toBe('held');
    expect(h.gate.getHeld()).toHaveLength(1);
  });

  it('falls back to the default lifetime when no getter is supplied', () => {
    // Unreachable from the one production caller today, which always
    // supplies it -- kept fail-closed so a future caller that omits it
    // gets a bounded hold rather than one that never expires.
    const gate = new InboundGate({
      getApprovalMode: () => ApprovalMode.YOLO,
      getPolicySetting: () => 'hold',
      deliver: () => {},
    });
    expect(gate.getHeldExpiryMs()).toBe(DEFAULT_HELD_EXPIRY_MS);
  });

  it('evicts by age, not by wall clock, after the clocks diverge', () => {
    // The buffer is ordered so `held.shift()` evicts the oldest at the
    // cap. Sorting on `heldAt` alone reintroduces the inversion the sort
    // exists to prevent: after a backward wall-clock step, an entry
    // admitted since the step carries a smaller `heldAt` and would sort
    // ahead of a genuinely older one -- so the newer message is evicted
    // and its sender receipted `expired` early.
    //
    // `vi.setSystemTime` alone cannot diverge the clocks: it moves
    // Date.now() while the fake timers also move performance.now(). The
    // monotonic side is pinned separately so only the wall clock steps.
    let monotonic = 0;
    const perf = vi
      .spyOn(performance, 'now')
      .mockImplementation(() => monotonic);
    try {
      const h = harness({ policy: 'hold', heldExpiryMs: null });
      const older = frame();
      h.gate.admit(older);
      monotonic += 60_000;
      // The wall clock steps back an hour; the monotonic clock does not.
      vi.setSystemTime(Date.now() - 60 * 60_000);
      const newer = frame();
      h.gate.admit(newer);

      // By `heldAt` the newer entry now looks older and would sort first.
      const held = h.gate.getHeld();
      expect(held[0].frame.msgId).toBe(older.msgId);
      expect(held[1].heldAt).toBeLessThan(held[0].heldAt);

      h.gate.reevaluate('test');
      expect(h.gate.getHeld().map((e) => e.frame.msgId)).toEqual([
        older.msgId,
        newer.msgId,
      ]);

      // Fill to the cap. Nothing is evicted any more, so what the order
      // still decides is what `/peers` shows first — and that must be the
      // genuinely oldest entry, not the one with the smaller wall-clock
      // stamp.
      for (let i = 0; i < MAX_HELD_MESSAGES - 2; i++) h.gate.admit(frame());
      expect(h.gate.getHeld()).toHaveLength(MAX_HELD_MESSAGES);
      expect(h.gate.admit(frame())).toBe('dropped');
      expect(h.gate.getHeld()[0]!.frame.msgId).toBe(older.msgId);
      expect(h.statuses.some((s) => s.status === 'expired')).toBe(false);
    } finally {
      perf.mockRestore();
    }
  });

  it('takes a still-unexpired message through the gate normally', () => {
    const h = harness({ policy: 'hold', heldExpiryMs: 60_000 });
    const f = frame();
    h.gate.admit(f);
    vi.advanceTimersByTime(30_000);
    expect(h.gate.decide(f.msgId, 'approve')).toBe('done');
    expect(h.delivered).toHaveLength(1);
  });
});

describe('parseHeldExpiry', () => {
  it('maps each accepted value', () => {
    expect(parseHeldExpiry('1m')).toBe(60_000);
    expect(parseHeldExpiry('5m')).toBe(DEFAULT_HELD_EXPIRY_MS);
    expect(parseHeldExpiry('10m')).toBe(10 * 60_000);
    expect(parseHeldExpiry('never')).toBeNull();
  });

  it('falls back to the default rather than to never', () => {
    // Failing closed here means bounding how long a sender waits, so an
    // unreadable value must not become an unbounded hold.
    expect(parseHeldExpiry(undefined)).toBe(DEFAULT_HELD_EXPIRY_MS);
    expect(parseHeldExpiry('forever')).toBe(DEFAULT_HELD_EXPIRY_MS);
    expect(parseHeldExpiry('constructor')).toBe(DEFAULT_HELD_EXPIRY_MS);
    expect(parseHeldExpiry(600)).toBe(DEFAULT_HELD_EXPIRY_MS);
    expect(parseHeldExpiry(null)).toBe(DEFAULT_HELD_EXPIRY_MS);
  });
});

describe('admission', () => {
  /** A clock the test drives, so the minute-wide limits stay instant. */
  function stubClock() {
    let value = 0;
    return {
      now: () => value,
      advance(ms: number) {
        value += ms;
      },
    };
  }

  it('drops a sender that outruns its burst, before any policy runs', () => {
    const h = harness({
      policy: 'accept',
      admission: new PeerAdmission({ limits: { bucketCapacity: 2 } }),
    });

    expect(h.gate.admit(frame({ from: '/tmp/a.sock' }))).toBe('accept');
    expect(h.gate.admit(frame({ from: '/tmp/a.sock' }))).toBe('accept');
    expect(h.gate.admit(frame({ from: '/tmp/a.sock' }))).toBe('dropped');

    expect(h.delivered).toHaveLength(2);
    expect(h.drops).toHaveLength(1);
    expect(h.drops[0]?.reason).toBe('rate-limited');
    expect(h.dropNotices).toHaveLength(1);
  });

  it('meters before it looks the id up, so a re-sent id cannot draw a receipt each time', () => {
    // The settled and held lookups both answer with a receipt, and
    // receipts are the first thing a flood starves.
    const h = harness({
      policy: 'hold',
      admission: new PeerAdmission({ limits: { bucketCapacity: 1 } }),
    });
    const f = frame({ from: '/tmp/a.sock' });

    expect(h.gate.admit(f)).toBe('held');
    expect(h.gate.admit(f)).toBe('dropped');
    expect(h.gate.admit(f)).toBe('dropped');

    // One 'held' receipt for the message that landed, and nothing more.
    expect(h.statuses).toEqual([{ msgId: f.msgId, status: 'held' }]);
    expect(h.drops).toHaveLength(2);
  });

  it('meters a sender a refusing session would have turned away anyway', () => {
    // Otherwise `refuse` is the cheapest way to make a session generate
    // one outbound connection per inbound frame.
    const h = harness({
      policy: 'refuse',
      admission: new PeerAdmission({ limits: { bucketCapacity: 1 } }),
    });

    expect(h.gate.admit(frame({ from: '/tmp/a.sock' }))).toBe('refused');
    expect(h.gate.admit(frame({ from: '/tmp/a.sock' }))).toBe('dropped');
    expect(h.statuses.filter((s) => s.status === 'refused')).toHaveLength(1);
  });

  it('leaves no tombstone, so the sender can retry once the burst is over', () => {
    const clock = stubClock();
    const h = harness({
      policy: 'accept',
      admission: new PeerAdmission({
        now: clock.now,
        // A retry is the same body by definition; this case is about the
        // tombstone, so the repeat check is out of the way.
        limits: { bucketCapacity: 1, refillPerSecond: 0.5, dedupWindowMs: 0 },
      }),
    });

    h.gate.admit(frame({ from: '/tmp/a.sock', msgId: 'first' }));
    const rejected = frame({ from: '/tmp/a.sock', msgId: 'second' });
    expect(h.gate.admit(rejected)).toBe('dropped');

    clock.advance(2000);
    expect(h.gate.admit(rejected)).toBe('accept');
    expect(h.delivered).toHaveLength(2);
  });

  /** The same words twice, under a fresh id each time. */
  function repeat(over: Partial<PeerUserFrame> = {}): PeerUserFrame {
    return frame({
      from: '/tmp/a.sock',
      message: { role: 'user', content: 'are you done yet' },
      ...over,
    });
  }

  it('drops a peer repeating itself, and says which it was', () => {
    // A fresh id every time, which is what a model in a retry loop mints:
    // the id guard cannot see it, so the body is what has to.
    const h = harness({ policy: 'accept', admission: new PeerAdmission() });

    expect(h.gate.admit(repeat())).toBe('accept');
    expect(h.gate.admit(repeat({ msgId: 'fresh-id' }))).toBe('dropped');
    expect(h.drops.at(-1)?.reason).toBe('duplicate');
  });

  it('does not call a repeat from this session own processes a duplicate', () => {
    // A hook that reports the same line twice is reporting two facts.
    const h = harness({ policy: 'accept', admission: new PeerAdmission() });

    expect(h.gate.admit(repeat(), { selfSent: true })).toBe('accept');
    expect(
      h.gate.admit(repeat({ msgId: 'fresh-id' }), { selfSent: true }),
    ).toBe('accept');
    expect(h.drops).toHaveLength(0);
  });

  it('does not call a repeat from a trusted controller a duplicate', () => {
    const controller = { id: 'c_1234abcd', label: 'voice' };
    const h = harness({ policy: 'accept', admission: new PeerAdmission() });

    expect(h.gate.admit(repeat(), { selfSent: false, controller })).toBe(
      'accept',
    );
    expect(
      h.gate.admit(repeat({ msgId: 'fresh-id' }), {
        selfSent: false,
        controller,
      }),
    ).toBe('accept');
    expect(h.drops).toHaveLength(0);
  });

  it('still rate limits a sender that is exempt from the repeat check', () => {
    const h = harness({
      policy: 'accept',
      admission: new PeerAdmission({ limits: { bucketCapacity: 1 } }),
    });

    h.gate.admit(frame({ from: '/tmp/a.sock' }), { selfSent: true });
    expect(
      h.gate.admit(frame({ from: '/tmp/a.sock' }), { selfSent: true }),
    ).toBe('dropped');
    expect(h.drops.at(-1)?.reason).toBe('rate-limited');
  });

  it('meters each sender separately', () => {
    const h = harness({
      policy: 'accept',
      admission: new PeerAdmission({ limits: { bucketCapacity: 1 } }),
    });

    expect(h.gate.admit(frame({ from: '/tmp/a.sock' }))).toBe('accept');
    expect(h.gate.admit(frame({ from: '/tmp/a.sock' }))).toBe('dropped');
    // A noisy peer must not mute a quiet one.
    expect(h.gate.admit(frame({ from: '/tmp/b.sock' }))).toBe('accept');
  });

  it('tells both audiences which origin the dropped message came from', () => {
    const h = harness({
      policy: 'accept',
      admission: new PeerAdmission({ limits: { bucketCapacity: 1 } }),
    });

    h.gate.admit(frame({ from: '/tmp/a.sock' }), { selfSent: true });
    h.gate.admit(frame({ from: '/tmp/a.sock' }), { selfSent: true });

    expect(h.dropNotices.at(-1)?.selfSent).toBe(true);
  });

  it('does not hold, deliver or announce a dropped message', () => {
    const h = harness({
      policy: 'hold',
      admission: new PeerAdmission({ limits: { bucketCapacity: 0 } }),
    });

    expect(h.gate.admit(frame({ from: '/tmp/a.sock' }))).toBe('dropped');
    expect(h.gate.getHeld()).toHaveLength(0);
    expect(h.delivered).toHaveLength(0);
    expect(h.heldChanges).toBe(0);
  });

  it('survives a reporter that throws, and still runs the other one', () => {
    // Each is wrapped on its own: one try around both would let a
    // throwing receipt silently cost the user the transcript line.
    const reported: string[] = [];
    const announced: string[] = [];
    const gate = new InboundGate({
      admission: new PeerAdmission({ limits: { bucketCapacity: 0 } }),
      getApprovalMode: () => ApprovalMode.DEFAULT,
      getPolicySetting: () => 'accept',
      deliver: () => {},
      reportDropped: (_frame, reason) => {
        reported.push(reason);
        throw new Error('receipt exploded');
      },
      onDropped: (_frame, _origin, reason) => {
        announced.push(reason);
        throw new Error('notice exploded');
      },
    });

    expect(() => gate.admit(frame({ from: '/tmp/a.sock' }))).not.toThrow();
    expect(reported).toEqual(['rate-limited']);
    expect(announced).toEqual(['rate-limited']);
  });

  it('meters with the shipped limits when none is injected', () => {
    const gate = new InboundGate({
      getApprovalMode: () => ApprovalMode.DEFAULT,
      getPolicySetting: () => 'accept',
      deliver: () => {},
    });

    for (let i = 0; i < PEER_ADMISSION_LIMITS.bucketCapacity; i++) {
      expect(gate.admit(frame({ from: '/tmp/a.sock' }))).toBe('accept');
    }
    expect(gate.admit(frame({ from: '/tmp/a.sock' }))).toBe('dropped');
  });
});

describe('the metering key', () => {
  const controller = { id: 'c_1234abcd', label: 'voice' };

  it('keeps a peer out of the identities the transport establishes', () => {
    // `from` is a field in a frame. A peer writing `own-process` there
    // would otherwise spend the bucket this session's own scripts use,
    // and its flood would be announced to the user as coming from a
    // process they started.
    const squat = peerSenderKey({ from: 'own-process' }, { selfSent: false });
    const genuine = peerSenderKey({ from: undefined }, { selfSent: true });
    expect(squat).not.toBe(genuine);

    expect(
      peerSenderKey(
        { from: `controller:${controller.id}` },
        { selfSent: false },
      ),
    ).not.toBe(
      peerSenderKey({ from: undefined }, { selfSent: false, controller }),
    );
  });

  it('meters a squatting peer apart from the session own processes', () => {
    const h = harness({ policy: 'accept', admission: new PeerAdmission() });
    for (let i = 0; i < PEER_ADMISSION_LIMITS.bucketCapacity; i++) {
      h.gate.admit(frame({ from: 'own-process' }));
    }
    expect(h.gate.admit(frame({ from: 'own-process' }))).toBe('dropped');

    // The session's own child process is untouched by that flood.
    expect(h.gate.admit(frame({ from: undefined }), { selfSent: true })).toBe(
      'accept',
    );
  });

  it('meters a squatting peer apart from a trusted controller', () => {
    const h = harness({ policy: 'accept', admission: new PeerAdmission() });
    for (let i = 0; i < PEER_ADMISSION_LIMITS.bucketCapacity; i++) {
      h.gate.admit(frame({ from: `controller:${controller.id}` }));
    }
    expect(h.gate.admit(frame({ from: `controller:${controller.id}` }))).toBe(
      'dropped',
    );

    expect(
      h.gate.admit(frame({ from: undefined }), { selfSent: false, controller }),
    ).toBe('accept');
  });

  it('gives two controllers their own meters', () => {
    const other = { id: 'c_beefcafe', label: 'dictation' };
    const h = harness({
      policy: 'accept',
      admission: new PeerAdmission({ limits: { bucketCapacity: 1 } }),
    });
    h.gate.admit(frame({ from: undefined }), { selfSent: false, controller });
    expect(
      h.gate.admit(frame({ from: undefined }), { selfSent: false, controller }),
    ).toBe('dropped');
    expect(
      h.gate.admit(frame({ from: undefined }), {
        selfSent: false,
        controller: other,
      }),
    ).toBe('accept');
  });

  it('bounds what a self-asserted address can make this session hold', () => {
    // No address that can be dialled comes near this; the cap exists so a
    // megabyte of peer-chosen bytes cannot be retained as a map key.
    const key = peerSenderKey({ from: 'x'.repeat(4096) }, { selfSent: false });
    expect(key.length).toBeLessThanOrEqual(300);
  });

  it('forwards the grant a dropped controller message came in on', () => {
    const h = harness({
      policy: 'accept',
      admission: new PeerAdmission({ limits: { bucketCapacity: 0 } }),
    });
    h.gate.admit(frame({ from: '/tmp/a.sock' }), {
      selfSent: false,
      controller,
    });
    expect(h.dropNotices.at(-1)?.controller).toEqual(controller);
  });
});

describe('a message settled without the far model seeing it', () => {
  /** The same words under a fresh id, as an honest retry sends them. */
  function retry(over: Partial<PeerUserFrame> = {}): PeerUserFrame {
    return frame({
      from: '/tmp/a.sock',
      fromMode: 'prompting',
      message: { role: 'user', content: 'please run the tests' },
      ...over,
    });
  }

  it('lets an honest retry land after a queue-full drop', () => {
    const h = harness({
      mode: ApprovalMode.DEFAULT,
      admission: new PeerAdmission(),
    });
    h.failDelivery();
    expect(h.gate.admit(retry())).toBe('dropped');
    h.recoverDelivery();
    expect(h.gate.admit(retry({ msgId: 'again-0001' }))).toBe('accept');
  });

  it('lets an honest retry land after a full hold buffer turned it away', () => {
    const h = harness({
      policy: 'hold',
      admission: new PeerAdmission({
        limits: { globalBucketCapacity: MAX_HELD_MESSAGES + 2 },
      }),
    });
    for (let i = 0; i < MAX_HELD_MESSAGES; i++) {
      h.gate.admit(frame({ from: `/tmp/filler-${i}.sock` }));
    }
    expect(h.gate.admit(retry())).toBe('dropped');
    expect(h.drops.at(-1)?.reason).toBe('queue-full');

    h.gate.decide(h.gate.getHeld()[0]!.frame.msgId, 'deny');
    expect(h.gate.admit(retry({ msgId: 'again-0002' }))).toBe('held');
    expect(h.drops.at(-1)?.reason).toBe('queue-full');
  });

  it('keeps telling a refusing session refuses, rather than calling it a repeat', () => {
    // 'refused' says stop; 'duplicate' says fold it into a later message,
    // which invites a session that turns everything away to be tried again.
    const h = harness({ policy: 'refuse', admission: new PeerAdmission() });
    expect(h.gate.admit(retry())).toBe('refused');
    expect(h.gate.admit(retry({ msgId: 'again-0003' }))).toBe('refused');
    expect(h.drops).toHaveLength(0);
  });

  it('lets a denied message be sent again for review', () => {
    const h = harness({ policy: 'hold', admission: new PeerAdmission() });
    const f = retry();
    h.gate.admit(f);
    h.gate.decide(f.msgId, 'deny');
    expect(h.gate.admit(retry({ msgId: 'again-0004' }))).toBe('held');
  });

  it('lets an honest retry land after its hold expired unread', () => {
    // The sender is told "retry once it is idle". A record left behind
    // for a message nobody read answers that retry `duplicate`, whose
    // whole premise is that the content is already over there.
    vi.useFakeTimers();
    try {
      const h = harness({
        policy: 'hold',
        heldExpiryMs: 1_000,
        admission: new PeerAdmission(),
      });
      expect(h.gate.admit(retry())).toBe('held');
      vi.advanceTimersByTime(1_001);
      expect(h.statuses.at(-1)?.status).toBe('expired');

      expect(h.gate.admit(retry({ msgId: 'again-0010' }))).toBe('held');
      expect(h.drops).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets an honest retry land after a policy change denied the backlog', () => {
    // Nobody read it either: the setting changed while it waited, and
    // the sender may reasonably send the same thing again once the
    // setting is put back.
    const h = harness({ policy: 'hold', admission: new PeerAdmission() });
    expect(h.gate.admit(retry())).toBe('held');

    h.setPolicy('refuse');
    h.gate.reevaluate('setting-changed');
    expect(h.statuses.at(-1)?.status).toBe('denied');

    h.setPolicy('hold');
    expect(h.gate.admit(retry({ msgId: 'again-0011' }))).toBe('held');
    expect(h.drops).toHaveLength(0);
  });

  it('starts a fresh conversation when the session id changes, and only then', () => {
    // `/clear` mints a new session id in the same process. The meter is
    // scoped to the conversation: a peer that spent its burst before the
    // clear must not go on being dropped afterwards, and its message
    // must not be called a repeat of one this session never saw.
    let currentSessionId = 'session-a';
    const drops: PeerDropReason[] = [];
    const gate = new InboundGate({
      admission: new PeerAdmission({ limits: { bucketCapacity: 1 } }),
      getApprovalMode: () => ApprovalMode.YOLO,
      getPolicySetting: () => undefined,
      getSessionId: () => currentSessionId,
      deliver: () => {},
      reportStatus: () => {},
      reportDropped: (_frame, reason) => drops.push(reason),
    });
    const arriving = (msgId: string, content: string): PeerUserFrame =>
      frame({
        msgId,
        from: '/tmp/a.sock',
        fromMode: 'bypass',
        message: { role: 'user', content },
      });

    expect(gate.admit(arriving('swap-0001', 'one'))).toBe('accept');
    expect(gate.admit(arriving('swap-0002', 'two'))).toBe('dropped');

    currentSessionId = 'session-b';
    expect(gate.admit(arriving('swap-0003', 'three'))).toBe('accept');
    // And the reset is not firing on every arrival: the new
    // conversation's own burst is still one message.
    expect(gate.admit(arriving('swap-0004', 'four'))).toBe('dropped');
    expect(drops).toEqual(['rate-limited', 'rate-limited']);
  });

  it('keeps the token spent, so a full queue still bounds the attempts', () => {
    const h = harness({
      mode: ApprovalMode.DEFAULT,
      admission: new PeerAdmission({ limits: { bucketCapacity: 1 } }),
    });
    h.failDelivery();
    expect(h.gate.admit(frame({ fromMode: 'prompting' }))).toBe('dropped');
    expect(h.drops.at(-1)?.reason).toBe('queue-full');

    h.recoverDelivery();
    // A different body from the same sender: the rollback returns the
    // repeat memory, never the allowance.
    expect(h.gate.admit(frame({ fromMode: 'prompting' }))).toBe('dropped');
    expect(h.drops.at(-1)?.reason).toBe('rate-limited');
  });
});
