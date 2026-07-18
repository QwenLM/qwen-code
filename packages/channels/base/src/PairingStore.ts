import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getGlobalQwenDir, getWorkspaceScopeDirName } from './paths.js';

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

  /**
   * @param channelName Channel name the state is keyed by.
   * @param workspaceCwd Workspace working directory to scope the state to.
   *   When provided, files live under
   *   `<qwen-home>/channels/<workspace-scope>/` so two workspaces using the
   *   same channel name never share pairing requests or allowlist entries
   *   (see #7017 — sharing them is an authorization-boundary violation in
   *   multi-workspace daemon deployments). Omitting it preserves the legacy
   *   global layout (`<qwen-home>/channels/`).
   */
  constructor(channelName: string, workspaceCwd?: string) {
    const channelsRoot = path.join(getGlobalQwenDir(), 'channels');
    this.dir = workspaceCwd
      ? path.join(channelsRoot, getWorkspaceScopeDirName(workspaceCwd))
      : channelsRoot;
    this.pendingPath = path.join(this.dir, `${channelName}-pairing.json`);
    this.allowlistPath = path.join(this.dir, `${channelName}-allowlist.json`);
    if (workspaceCwd) {
      this.migrateLegacyState(channelsRoot, channelName);
    }
  }

  /**
   * One-time grandfathering of pre-scoping state: the first time a scope
   * directory would come into existence, copy the legacy GLOBAL files in so
   * senders that were already approved stay approved after upgrading.
   *
   * Gated at the scope-DIRECTORY level, not per file: once the scoped
   * directory exists — because this migration ran or because the workspace
   * wrote any state of its own — legacy files are never consulted again. A
   * per-file gate would let a legacy allowlist silently re-approve senders
   * that an operator revoked by deleting the scoped allowlist file, and
   * would let an in-use scope absorb a legacy file that appears later.
   *
   * Copy, not move: another workspace upgrading later must be able to
   * grandfather the same baseline, and an older qwen version running
   * concurrently still reads the global files. This is a snapshot — the
   * scoped stores diverge from each other immediately afterwards, so the
   * ongoing cross-workspace sharing that motivated #7017 is not reintroduced.
   *
   * Revocation therefore means REMOVING ENTRIES from the scoped allowlist
   * (and from the legacy global file, while it exists) — not deleting files.
   */
  private migrateLegacyState(channelsRoot: string, channelName: string): void {
    try {
      if (fs.existsSync(this.dir)) {
        return;
      }
      const legacyPairs: Array<[string, string]> = [
        [
          path.join(channelsRoot, `${channelName}-pairing.json`),
          this.pendingPath,
        ],
        [
          path.join(channelsRoot, `${channelName}-allowlist.json`),
          this.allowlistPath,
        ],
      ];
      const present = legacyPairs.filter(([legacyPath]) =>
        fs.existsSync(legacyPath),
      );
      if (present.length === 0) {
        return;
      }
      // Creating the directory is what marks the migration as done, even if
      // only one of the two files existed.
      this.ensureDir();
      for (const [legacyPath, scopedPath] of present) {
        fs.copyFileSync(legacyPath, scopedPath);
      }
    } catch {
      // Best-effort: an unreadable legacy file must not prevent the channel
      // from starting; the scoped store just starts empty.
    }
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
    code += SAFE_ALPHABET[crypto.randomInt(SAFE_ALPHABET.length)];
  }
  return code;
}
