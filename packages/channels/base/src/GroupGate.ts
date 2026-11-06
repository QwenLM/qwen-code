import type { GroupPolicy, GroupConfig, Envelope } from './types.js';
import type {
  CreatePairingRequestResult,
  PairingStore,
} from './PairingStore.js';

export interface GroupCheckResult {
  allowed: boolean;
  reason?:
    | 'disabled'
    | 'not_allowlisted'
    | 'mention_required'
    | 'pairing_trigger_required'
    | 'pairing_required';
  /** Set when the check denies with `pairing_required` (a pairing request was created or reused). */
  pairing?: CreatePairingRequestResult;
}

export class GroupGate {
  private policy: GroupPolicy;
  private groups: Record<string, GroupConfig>;
  private pairingStore: PairingStore | null;
  private normalizeGroupId: (groupId: string) => string;

  constructor(
    policy: GroupPolicy = 'disabled',
    groups: Record<string, GroupConfig> = {},
    pairingStore?: PairingStore,
    normalizeGroupId: (groupId: string) => string = (groupId) => groupId,
  ) {
    this.policy = policy;
    this.groups = groups;
    this.pairingStore = pairingStore ?? null;
    this.normalizeGroupId = normalizeGroupId;
  }

  /**
   * Configured groups are matched verbatim first. Platforms whose group IDs
   * are case-insensitive (GitHub repository full names) also match a
   * normalized key, so the operator's spelling admits the canonical ID the
   * platform reports.
   */
  private groupConfigFor(groupId: string): GroupConfig | undefined {
    if (Object.hasOwn(this.groups, groupId)) return this.groups[groupId];
    const normalized = this.normalizeGroupId(groupId);
    for (const [key, group] of Object.entries(this.groups)) {
      if (this.normalizeGroupId(key) === normalized) return group;
    }
    return undefined;
  }

  /**
   * Full group check: policy + allowlist + pairing + mention gating.
   * Evaluation order:
   *   1. groupPolicy (disabled → drop)
   *   2. group allowlist (allowlist mode, no match → drop)
   *   3. group pairing (pairing mode, group not approved → drop; an explicit
   *      mention or reply creates or returns a pending pairing request unless
   *      `options.createPairingRequest` is false)
   *   4. mention gating (requireMention + not mentioned → drop silently)
   *
   * Under the pairing policy the pairing step itself drops ambient
   * (unmentioned, non-reply) messages before any request is created. Mention
   * gating then runs before the sender gate so unmentioned messages in
   * approved groups don't trigger sender pairing flows.
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
      if (!this.groupConfigFor(envelope.chatId)) {
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
      const result = this.pairingStore?.createGroupRequest(
        envelope.chatId,
        envelope.chatName || envelope.chatId,
        envelope.senderId,
        envelope.senderName,
      );
      return {
        allowed: false,
        reason: 'pairing_required',
        pairing: result ?? { rejected: 'cap_reached' },
      };
    }

    const requireMention =
      this.groupConfigFor(envelope.chatId)?.requireMention ??
      this.groups['*']?.requireMention ??
      true;

    if (requireMention && !envelope.isMentioned && !envelope.isReplyToBot) {
      return { allowed: false, reason: 'mention_required' };
    }

    return { allowed: true };
  }

  isGroupApproved(groupId: string): boolean {
    return this.pairingStore?.isGroupApproved(groupId) ?? false;
  }
}

/**
 * Lowercase every per-group `allowedUsers` list in place, for platforms whose
 * user IDs are case-insensitive logins.
 */
export function lowercaseGroupAllowedUsers(
  groups: Record<string, GroupConfig>,
): void {
  for (const group of Object.values(groups)) {
    if (group.allowedUsers) {
      group.allowedUsers = group.allowedUsers.map((u) => u.toLowerCase());
    }
  }
}
