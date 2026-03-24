import type { SenderPolicy } from './types.js';

export class SenderGate {
  private policy: SenderPolicy;
  private allowedUsers: Set<string>;

  constructor(policy: SenderPolicy, allowedUsers: string[] = []) {
    this.policy = policy;
    this.allowedUsers = new Set(allowedUsers);
  }

  check(senderId: string): boolean {
    switch (this.policy) {
      case 'open':
        return true;
      case 'allowlist':
        return this.allowedUsers.has(senderId);
      case 'pairing':
        // Pairing will be implemented later; for now, treat as allowlist
        return this.allowedUsers.has(senderId);
    }
  }
}
