/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ApprovalMode } from '../config/approval-mode.js';
import {
  approvalModeClass,
  describeHoldCause,
  InboundGate,
  MAX_HELD_MESSAGES,
  type InboundPolicy,
} from './inbound-gate.js';
import { buildUserFrame, type PeerUserFrame } from './peer-frames.js';

interface Harness {
  gate: InboundGate;
  delivered: PeerUserFrame[];
  statuses: Array<{ msgId: string; status: string }>;
  heldChanges: number;
  setMode: (mode: ApprovalMode | null) => void;
  setPolicy: (policy: InboundPolicy | undefined) => void;
  throwOnMode: () => void;
}

function harness(
  initial: {
    mode?: ApprovalMode | null;
    policy?: InboundPolicy;
  } = {},
): Harness {
  let mode: ApprovalMode | null = initial.mode ?? ApprovalMode.DEFAULT;
  let policy: InboundPolicy | undefined = initial.policy;
  let modeThrows = false;
  const delivered: PeerUserFrame[] = [];
  const statuses: Array<{ msgId: string; status: string }> = [];
  const state = { heldChanges: 0 };

  const gate = new InboundGate({
    getApprovalMode: () => {
      if (modeThrows) throw new Error('mode getter exploded');
      return mode;
    },
    getPolicySetting: () => policy,
    deliver: (frame) => delivered.push(frame),
    reportStatus: (frame, status) =>
      statuses.push({ msgId: frame.msgId, status }),
    onHeldChange: () => {
      state.heldChanges += 1;
    },
  });

  return {
    gate,
    delivered,
    statuses,
    get heldChanges() {
      return state.heldChanges;
    },
    setMode: (next) => {
      mode = next;
    },
    setPolicy: (next) => {
      policy = next;
    },
    throwOnMode: () => {
      modeThrows = true;
    },
  } as Harness;
}

function frame(over: Partial<PeerUserFrame> = {}): PeerUserFrame {
  return { ...buildUserFrame({ content: 'do a thing' }), ...over };
}

describe('approvalModeClass', () => {
  it('treats only YOLO as bypass', () => {
    expect(approvalModeClass(ApprovalMode.YOLO)).toBe('bypass');
    for (const mode of [
      ApprovalMode.PLAN,
      ApprovalMode.DEFAULT,
      ApprovalMode.AUTO_EDIT,
      ApprovalMode.AUTO,
    ]) {
      expect(approvalModeClass(mode)).toBe('prompting');
    }
  });
});

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

  it('refuse drops the message and tells the sender', () => {
    const h = harness({ mode: ApprovalMode.DEFAULT, policy: 'refuse' });
    expect(h.gate.admit(frame())).toBe('refused');
    expect(h.delivered).toHaveLength(0);
    expect(h.gate.getHeld()).toHaveLength(0);
    expect(h.statuses.at(-1)?.status).toBe('denied');
  });

  it('refuse wins even when the mode getter is broken', () => {
    const h = harness({ mode: null, policy: 'refuse' });
    h.throwOnMode();
    expect(h.gate.admit(frame())).toBe('refused');
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
    expect(h.gate.decide('never-seen', 'approve')).toBe('gone');
    expect(h.delivered).toHaveLength(0);
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

  it('still delivers after shutdown when the policy accepts', () => {
    // Shutdown must not silently start dropping messages that were never
    // going to be held in the first place.
    const h = harness({ mode: ApprovalMode.DEFAULT });
    h.gate.shutdown();
    expect(h.gate.admit(frame())).toBe('accept');
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

  // The UI announces new holds. Without a way to tell an add from a
  // removal, approving three held messages would print two more "held a
  // message" notices as the set walks back down.
  it('reports the added message only when the change parked one', () => {
    const seen: Array<string | undefined> = [];
    const gate = new InboundGate({
      getApprovalMode: () => ApprovalMode.YOLO,
      getPolicySetting: () => undefined,
      deliver: () => {},
      onHeldChange: (_held, added) => seen.push(added?.frame.msgId),
    });

    const first = frame();
    const second = frame();
    gate.admit(first);
    gate.admit(second);
    gate.decide(first.msgId, 'approve');
    gate.decide(second.msgId, 'approve');

    expect(seen).toEqual([first.msgId, second.msgId, undefined, undefined]);
  });

  it('reports no added message when shutdown clears the set', () => {
    const seen: Array<string | undefined> = [];
    const gate = new InboundGate({
      getApprovalMode: () => ApprovalMode.YOLO,
      getPolicySetting: () => undefined,
      deliver: () => {},
      onHeldChange: (_held, added) => seen.push(added?.frame.msgId),
    });

    const f = frame();
    gate.admit(f);
    gate.shutdown();

    expect(seen).toEqual([f.msgId, undefined]);
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
    expect(deliver).toHaveBeenCalledWith(f);
  });
});

describe('describeHoldCause', () => {
  it('explains every cause in user terms', () => {
    expect(describeHoldCause('explicit-setting')).toContain(
      'crossSessionInbound',
    );
    expect(describeHoldCause('mode-mismatch')).toContain('bypasses');
    expect(describeHoldCause('no-mode-asserted')).toContain('did not say');
    expect(describeHoldCause('mode-unknown')).toContain('could not be');
  });
});
