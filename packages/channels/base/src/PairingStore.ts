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
  private migratedSentinelPath: string;

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
    // Channel names come from user configuration keys and are not otherwise
    // restricted; encode them so a name like `../support` cannot climb out
    // of the scope directory and land both workspaces on one shared file —
    // that would silently undo the workspace isolation this store exists
    // for. Mirrors the GroupHistoryStore file-name encoding. Common names
    // (letters, digits, `-`, `_`, `.`) encode to themselves, so existing
    // layouts are unaffected.
    const safeChannelName = encodeURIComponent(channelName);
    this.pendingPath = path.join(this.dir, `${safeChannelName}-pairing.json`);
    this.allowlistPath = path.join(
      this.dir,
      `${safeChannelName}-allowlist.json`,
    );
    this.migratedSentinelPath = path.join(
      this.dir,
      `${safeChannelName}.migrated`,
    );
    if (workspaceCwd) {
      this.migrateLegacyState(channelsRoot, safeChannelName);
    }
  }

  /**
   * One-time grandfathering of pre-scoping state: the first time this
   * (workspace, channel) pair is constructed, copy the legacy GLOBAL files in
   * so senders that were already approved stay approved after upgrading.
   *
   * Gated by a per-channel sentinel file inside the scope directory — NOT by
   * the directory itself: one workspace can start several channels in turn,
   * and a directory-level gate would let only the first channel ever migrate.
   * The sentinel is written even when there was nothing to copy, so a legacy
   * file written later (e.g. by an older version still running concurrently)
   * is never absorbed into a scope that already went through this decision.
   *
   * Each file is copied independently and best-effort (an unreadable pairing
   * file must not block the allowlist, and vice versa), via a
   * uniquely-named temp file + atomic rename so a crash mid-copy cannot
   * leave a truncated scoped file behind the closed gate. A file the scoped
   * store already has is never overwritten.
   *
   * Copy, not move: another workspace upgrading later must be able to
   * grandfather the same baseline, and an older qwen version running
   * concurrently still reads the global files.
   *
   * Revocation therefore means REMOVING ENTRIES from the scoped allowlist
   * (and from the legacy global file, while it exists) — not deleting files.
   */
  private migrateLegacyState(
    channelsRoot: string,
    safeChannelName: string,
  ): void {
    try {
      if (fs.existsSync(this.migratedSentinelPath)) {
        return;
      }
      const legacyPairs: Array<[string, string]> = [
        [
          path.join(channelsRoot, `${safeChannelName}-pairing.json`),
          this.pendingPath,
        ],
        [
          path.join(channelsRoot, `${safeChannelName}-allowlist.json`),
          this.allowlistPath,
        ],
      ];
      this.ensureDir();
      for (const [legacyPath, scopedPath] of legacyPairs) {
        try {
          // Defense in depth: the encoded name cannot contain separators,
          // but never read a legacy source from outside the channels root.
          if (path.dirname(path.resolve(legacyPath)) !== channelsRoot) {
            continue;
          }
          if (fs.existsSync(scopedPath) || !fs.existsSync(legacyPath)) {
            continue;
          }
          const tmpPath = `${scopedPath}.${process.pid}.migrating`;
          fs.copyFileSync(legacyPath, tmpPath);
          fs.renameSync(tmpPath, scopedPath);
        } catch {
          // Best-effort per file: an unreadable legacy file must not block
          // the other file or prevent the channel from starting.
        }
      }
      fs.writeFileSync(this.migratedSentinelPath, '');
    } catch {
      // Best-effort: if even the sentinel cannot be written, the next
      // construction simply retries the migration.
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
