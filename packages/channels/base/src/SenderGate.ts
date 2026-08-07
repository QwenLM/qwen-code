import type { SenderPolicy } from './types.js';
import type {
  CreatePairingRequestResult,
  PairingStore,
} from './PairingStore.js';

export interface SenderCheckResult {
  allowed: boolean;
  /** Set when the pairing policy denies the sender. */
  pairing?: CreatePairingRequestResult;
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

  replaceAllowedUsers(users: string[]): void {
    this.allowedUsers = new Set(users);
  }

  isAllowed(senderId: string): boolean {
    switch (this.policy) {
      case 'open':
        return true;
      case 'allowlist':
        return this.allowedUsers.has(senderId);
      case 'pairing':
        return (
          this.allowedUsers.has(senderId) ||
          this.pairingStore?.isApproved(senderId) === true
        );
      default:
        throw new Error(`Unknown sender policy: ${this.policy}`);
    }
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
        const result = this.pairingStore?.createRequest(
          senderId,
          senderName || senderId,
        );
        return {
          allowed: false,
          pairing: result ?? { rejected: 'cap_reached' },
        };
      }
      default:
        throw new Error(`Unknown sender policy: ${this.policy}`);
    }
  }
}
