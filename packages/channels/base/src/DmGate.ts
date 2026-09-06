import type { DmPolicy, Envelope } from './types.js';

export interface DmCheckResult {
  allowed: boolean;
  reason?: 'disabled';
}

export class DmGate {
  private policy: DmPolicy;

  constructor(policy: DmPolicy = 'open') {
    this.policy = policy;
  }

  /**
   * DM check: policy gating for private/non-group messages.
   * Evaluation order:
   *   1. Group messages bypass this gate (handled by GroupGate)
   *   2. dmPolicy (disabled → drop)
   *
   * Symmetric with GroupGate — GroupGate owns group messages,
   * DmGate owns DM messages.
   */
  check(envelope: Envelope): DmCheckResult {
    if (envelope.isGroup) {
      return { allowed: true };
    }

    if (this.policy === 'disabled') {
      return { allowed: false, reason: 'disabled' };
    }

    return { allowed: true };
  }
}
