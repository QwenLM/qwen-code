import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Alphabet without ambiguous chars: 0/O, 1/I
const SAFE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const EXPIRY_MS = 60 * 60 * 1000; // 1 hour
const MAX_PENDING = 3;

export interface PairingRequest {
  senderId: string;
  senderName: string;
  code: string;
  createdAt: number; // epoch ms
}

export class PairingStore {
  private dir: string;
  private pendingPath: string;
  private allowlistPath: string;

  constructor(channelName: string) {
    this.dir = path.join(os.homedir(), '.qwen', 'channels');
    this.pendingPath = path.join(this.dir, `${channelName}-pairing.json`);
    this.allowlistPath = path.join(this.dir, `${channelName}-allowlist.json`);
  }

  isApproved(senderId: string): boolean {
    const list = this.readAllowlist();
    return list.includes(senderId);
  }

  /**
   * Create a pairing request for an unknown sender.
   * Returns the code if created, or null if the pending cap is reached.
   * If the sender already has a non-expired pending request, returns that code.
   */
  createRequest(senderId: string, senderName: string): string | null {
    const pending = this.readPending();

    // Purge expired
    const now = Date.now();
    const active = pending.filter((r) => now - r.createdAt < EXPIRY_MS);

    // Check if sender already has a pending request
    const existing = active.find((r) => r.senderId === senderId);
    if (existing) {
      return existing.code;
    }

    // Cap check
    if (active.length >= MAX_PENDING) {
      return null;
    }

    const code = generateCode();
    active.push({ senderId, senderName, code, createdAt: now });
    this.writePending(active);
    return code;
  }

  /**
   * Approve a pairing request by code.
   * Returns the sender ID if found, or null if not found / expired.
   */
  approve(code: string): PairingRequest | null {
    const pending = this.readPending();
    const now = Date.now();
    const idx = pending.findIndex(
      (r) => r.code === code.toUpperCase() && now - r.createdAt < EXPIRY_MS,
    );
    if (idx === -1) return null;

    const request = pending[idx]!;
    pending.splice(idx, 1);
    this.writePending(pending);

    // Add to allowlist
    const list = this.readAllowlist();
    if (!list.includes(request.senderId)) {
      list.push(request.senderId);
      this.writeAllowlist(list);
    }

    return request;
  }

  listPending(): PairingRequest[] {
    const pending = this.readPending();
    const now = Date.now();
    return pending.filter((r) => now - r.createdAt < EXPIRY_MS);
  }

  getAllowlist(): string[] {
    return this.readAllowlist();
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
  }

  private readPending(): PairingRequest[] {
    try {
      const data = fs.readFileSync(this.pendingPath, 'utf-8');
      return JSON.parse(data) as PairingRequest[];
    } catch {
      return [];
    }
  }

  private writePending(requests: PairingRequest[]): void {
    this.ensureDir();
    fs.writeFileSync(this.pendingPath, JSON.stringify(requests, null, 2));
  }

  private readAllowlist(): string[] {
    try {
      const data = fs.readFileSync(this.allowlistPath, 'utf-8');
      return JSON.parse(data) as string[];
    } catch {
      return [];
    }
  }

  private writeAllowlist(list: string[]): void {
    this.ensureDir();
    fs.writeFileSync(this.allowlistPath, JSON.stringify(list, null, 2));
  }
}

function generateCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += SAFE_ALPHABET[Math.floor(Math.random() * SAFE_ALPHABET.length)];
  }
  return code;
}
