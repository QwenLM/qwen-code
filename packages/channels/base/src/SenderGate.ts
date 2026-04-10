import type { SenderPolicy } from './types.js';
import type { PairingStore } from './PairingStore.js';

export interface SenderCheckResult {
  allowed: boolean;
  pairingCode?: string | null; // set when pairing policy returns a code (null = cap reached)
}

export class SenderGate {
  private policy: SenderPolicy;
  private allowedUsers: Set<string>;
  private pairingStore: PairingStore | null;

  constructor(
    policy: SenderPolicy,
    allowedUsers: string[] = [],
    pairingStore?: PairingStore,
  ) {
    this.policy = policy;
    this.allowedUsers = new Set(allowedUsers);
    this.pairingStore = pairingStore || null;
  }

  check(senderId: string, senderName?: string): SenderCheckResult {
    switch (this.policy) {
      case 'open':
        return { allowed: true };
      case 'allowlist':
        return { allowed: this.allowedUsers.has(senderId) };
      case 'pairing': {
        // Check static allowlist first
        if (this.allowedUsers.has(senderId)) {
          return { allowed: true };
        }
        // Check dynamic approved list
        if (this.pairingStore?.isApproved(senderId)) {
          return { allowed: true };
        }
        // Generate pairing code
        const code = this.pairingStore?.createRequest(
          senderId,
          senderName || senderId,
        );
        return { allowed: false, pairingCode: code ?? null };
      }
      default:
        throw new Error(`Unknown sender policy: ${this.policy}`);
    }
  }
}
