import type { GroupPolicy, GroupConfig, Envelope } from './types.js';
import type { PairingStore } from './PairingStore.js';

export interface GroupCheckResult {
  allowed: boolean;
  reason?:
    | 'disabled'
    | 'not_allowlisted'
    | 'mention_required'
    | 'pairing_trigger_required'
    | 'pairing_required';
  pairingCode?: string | null;
}

export class GroupGate {
  private policy: GroupPolicy;
  private groups: Record<string, GroupConfig>;
  private pairingStore: PairingStore | null;

  constructor(
    policy: GroupPolicy = 'disabled',
    groups: Record<string, GroupConfig> = {},
    pairingStore?: PairingStore,
  ) {
    this.policy = policy;
    this.groups = groups;
    this.pairingStore = pairingStore ?? null;
  }

  /**
   * Full group check: policy + allowlist + mention gating.
   * Evaluation order:
   *   1. groupPolicy (disabled → drop)
   *   2. group allowlist (allowlist mode, no match → drop)
   *   3. mention gating (requireMention + not mentioned → drop silently)
   *
   * Mention gating runs before sender gate so that unmentioned messages
   * in groups don't trigger pairing flows.
   */
  check(
    envelope: Envelope,
    options: { createPairingRequest?: boolean } = {},
  ): GroupCheckResult {
    if (!envelope.isGroup) {
      return { allowed: true };
    }

    if (this.policy === 'disabled') {
      return { allowed: false, reason: 'disabled' };
    }

    if (this.policy === 'allowlist') {
      // In allowlist mode, "*" is only a default config — not a wildcard allow.
      // The group must be explicitly listed by ID.
      if (!this.groups[envelope.chatId]) {
        return { allowed: false, reason: 'not_allowlisted' };
      }
    }

    if (
      this.policy === 'pairing' &&
      !this.pairingStore?.isGroupApproved(envelope.chatId)
    ) {
      if (
        options.createPairingRequest === false ||
        (!envelope.isMentioned && !envelope.isReplyToBot)
      ) {
        return { allowed: false, reason: 'pairing_trigger_required' };
      }
      const code = this.pairingStore?.createGroupRequest(
        envelope.chatId,
        envelope.chatName || envelope.chatId,
        envelope.senderId,
        envelope.senderName,
      );
      return {
        allowed: false,
        reason: 'pairing_required',
        pairingCode: code ?? null,
      };
    }

    // Per-group config, falling back to "*" defaults, then built-in defaults
    const groupConfig = this.groups[envelope.chatId] || this.groups['*'] || {};
    const requireMention = groupConfig.requireMention ?? true;

    if (requireMention && !envelope.isMentioned && !envelope.isReplyToBot) {
      return { allowed: false, reason: 'mention_required' };
    }

    return { allowed: true };
  }
}
