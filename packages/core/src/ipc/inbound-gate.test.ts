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
  MAX_HELD_MESSAGES,
  MAX_SETTLED_IDS,
  parseHeldExpiry,
  type InboundPolicy,
} from './inbound-gate.js';
import { buildUserFrame, type PeerUserFrame } from './peer-frames.js';

interface Harness {
  gate: InboundGate;
  setHeldExpiryMs: (ms: number | null) => void;
  delivered: PeerUserFrame[];
  /** `selfSent` as the gate reported it to `deliver`, per delivery. */
  deliveredAsSelfSent: boolean[];
  statuses: Array<{ msgId: string; status: string }>;
  heldChanges: number;
  setMode: (mode: ApprovalMode | null) => void;
  setPolicy: (policy: InboundPolicy | undefined) => void;
  /** Deliberately un-typed: settings.json is not type-checked. */
  setRawPolicy: (policy: unknown) => void;
  throwOnMode: () => void;
  throwOnPolicy: () => void;
  failDelivery: () => void;
  recoverDelivery: () => void;
}

function harness(
  initial: {
    mode?: ApprovalMode | null;
    policy?: InboundPolicy;
    heldExpiryMs?: number | null;
  } = {},
): Harness {
  let mode: ApprovalMode | null = initial.mode ?? ApprovalMode.DEFAULT;
  let policy: unknown = initial.policy;
  let heldExpiryMs: number | null =
    initial.heldExpiryMs === undefined
      ? DEFAULT_HELD_EXPIRY_MS
      : initial.heldExpiryMs;
  let modeThrows = false;
  let policyThrows = false;
  const delivered: PeerUserFrame[] = [];
  const deliveredAsSelfSent: boolean[] = [];
  const statuses: Array<{ msgId: string; status: string }> = [];
  const state = { heldChanges: 0 };
  let deliveryFails = false;

  const gate = new InboundGate({
    getApprovalMode: () => {
      if (modeThrows) throw new Error('mode getter exploded');
      return mode;
    },
    getPolicySetting: () => {
      if (policyThrows) throw new Error('settings getter exploded');
      return policy as InboundPolicy | undefined;
    },
    getHeldExpiryMs: () => heldExpiryMs,
    deliver: (frame, origin) => {
      if (deliveryFails) throw new Error('accepted-message backlog is full');
      delivered.push(frame);
      deliveredAsSelfSent.push(origin.selfSent);
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
    statuses,
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
    throwOnMode: () => {
      modeThrows = true;
    },
    throwOnPolicy: () => {
      policyThrows = true;
    },
    failDelivery: () => {
      deliveryFails = true;
    },
    recoverDelivery: () => {
      deliveryFails = false;
    },
  } as Harness;
}

function frame(over: Partial<PeerUserFrame> = {}): PeerUserFrame {
  return { ...buildUserFrame({ content: 'do a thing' }), ...over };
}

describe('mode parity (no explicit setting)', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('accepts anything when the receiver still prompts', () => {
    h.setMode(ApprovalMode.DEFAULT);
    expect(h.gate.admit(frame({ fromMode: 'prompting' }))).toBe('accept');
    expect(h.gate.admit(frame({ fromMode: 'bypass' }))).toBe('accept');
    expect(h.gate.admit(frame())).toBe('accept');
    expect(h.delivered).toHaveLength(3);
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
    const f = frame({ msgId: 'task-0002' });
    expect(h.gate.admit(f)).toBe('accept');
    expect(h.delivered).toHaveLength(1);
    expect(h.gate.admit(frame({ msgId: 'task-0002' }))).toBe('refused');
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

  it('settles evicted ids so a flood cannot recycle a handle', () => {
    const h = harness({ mode: ApprovalMode.YOLO });
    const first = frame({ msgId: 'task-0004', fromMode: 'prompting' });
    expect(h.gate.admit(first)).toBe('held');
    for (let i = 0; i < MAX_HELD_MESSAGES; i++) {
      h.gate.admit(frame({ msgId: `filler-${i}`, fromMode: 'prompting' }));
    }
    const isHeld = (msgId: string) =>
      h.gate.getHeld().some((e) => e.frame.msgId === msgId);
    expect(isHeld('task-0004')).toBe(false);

    const forgery = frame({ msgId: 'task-0004', fromMode: 'prompting' });
    expect(h.gate.admit(forgery)).toBe('refused');
    expect(isHeld('task-0004')).toBe(false);
    expect(h.statuses.at(-1)).toEqual({
      msgId: 'task-0004',
      status: 'expired',
    });
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
    const f = frame({ msgId: 'task-0007' });
    expect(h.gate.admit(f)).toBe('refused');
    expect(h.statuses.at(-1)).toEqual({
      msgId: 'task-0007',
      status: 'expired',
    });

    h.recoverDelivery();
    expect(h.gate.admit(f)).toBe('accept');
    expect(h.delivered).toHaveLength(1);
  });

  it('prunes the oldest settled ids beyond the cap', () => {
    const h = harness({ mode: ApprovalMode.DEFAULT });
    const ids = Array.from({ length: MAX_SETTLED_IDS + 1 }, (_, i) => `s-${i}`);
    for (const msgId of ids) {
      expect(h.gate.admit(frame({ msgId }))).toBe('accept');
    }
    // The oldest fell out of memory; the newest repeats its verdict.
    expect(h.gate.admit(frame({ msgId: ids[0] }))).toBe('accept');
    expect(h.gate.admit(frame({ msgId: ids[ids.length - 1] }))).toBe('refused');
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

  it('reports expired rather than delivered when delivery fails', () => {
    const statuses: string[] = [];
    const gate = new InboundGate({
      getApprovalMode: () => ApprovalMode.DEFAULT,
      getPolicySetting: () => undefined,
      deliver: () => {
        throw new Error('queue is gone');
      },
      reportStatus: (_frame, status) => statuses.push(status),
    });
    expect(gate.admit(frame())).toBe('refused');
    expect(statuses).toEqual(['expired']);
  });
});

describe('receipts', () => {
  it('reports delivered on accept', () => {
    const h = harness({ mode: ApprovalMode.DEFAULT });
    const f = frame();
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
  it('evicts the oldest as expired once full', () => {
    const h = harness({ mode: ApprovalMode.YOLO });
    const first = frame();
    h.gate.admit(first);
    for (let i = 0; i < MAX_HELD_MESSAGES; i++) h.gate.admit(frame());

    expect(h.gate.getHeld()).toHaveLength(MAX_HELD_MESSAGES);
    expect(
      h.gate.getHeld().some((entry) => entry.frame.msgId === first.msgId),
    ).toBe(false);
    expect(h.statuses).toContainEqual({
      msgId: first.msgId,
      status: 'expired',
    });
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
    expect(describeHoldCause('no-mode-asserted')).toContain('did not say');
    expect(describeHoldCause('mode-unknown')).toContain('could not be');
    expect(describeHoldCause('policy-unreadable')).toContain(
      'crossSessionInbound',
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
    vi.advanceTimersByTime(60_001);
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

  it('keeps the delay inside setTimeout range after a far-backward clock step', () => {
    // A stale VM restore or a `date -s` moves Date.now() back far enough
    // that `expiryMs - wallAge` passes setTimeout's 32-bit ceiling. Node
    // clamps such a delay to 1 ms and warns, so the callback re-arms the
    // same oversized value and spins at ~1 kHz -- pegging a core and
    // tearing the Ink render -- until the buffer drains.
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
      delays.length = 0;
      vi.setSystemTime(Date.now() - 30 * 24 * 60 * 60_000);
      // Any re-arm against the stepped clock, with the single parked
      // entry still the one the timer is armed for.
      h.gate.reevaluate('clock-step');
      expect(delays.length).toBeGreaterThan(0);
      for (const delay of delays) {
        expect(delay).toBeGreaterThanOrEqual(1);
        expect(delay).toBeLessThanOrEqual(2 ** 31 - 1);
      }
    } finally {
      spy.mockRestore();
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
    // `harness({ mode: null })` would coalesce back to DEFAULT.
    const h = harness({ heldExpiryMs: 60_000 });
    h.setMode(null);
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
