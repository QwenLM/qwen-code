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
  subject: PairingSubject;
  code: string;
  createdAt: number; // epoch ms
}

export interface PairingSubject {
  type: 'user' | 'group';
  id: string;
  name: string;
}

export type CreatePairingRequestResult =
  | { code: string }
  | { rejected: 'sender_pending' | 'cap_reached' };

type StoredPairingRequest = Omit<PairingRequest, 'subject'> & {
  subject?: PairingSubject;
};

export class PairingStore {
  private dir: string;
  private pendingPath: string;
  private allowlistPath: string;
  private groupAllowlistPath: string;
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
    this.groupAllowlistPath = path.join(
      this.dir,
      `${safeChannelName}-groups.json`,
    );
    this.migratedSentinelPath = path.join(
      this.dir,
      `${safeChannelName}.migrated`,
    );
    if (workspaceCwd) {
      this.migrateLegacyState(channelsRoot, channelName);
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
   * Revocation therefore means removing entries from this store's allowlist,
   * not deleting files or mutating the legacy global baseline.
   */
  private migrateLegacyState(channelsRoot: string, channelName: string): void {
    try {
      if (fs.existsSync(this.migratedSentinelPath)) {
        return;
      }
      // Legacy files were written by pre-scoping code under the RAW channel
      // name; the encoded name is only used for the scoped destinations. The
      // containment check keeps a traversal-style raw name (e.g. `../x`)
      // from reading files outside the channels root.
      const legacyPairs: Array<[string, string]> = [
        [
          path.join(channelsRoot, `${channelName}-pairing.json`),
          this.pendingPath,
        ],
        [
          path.join(channelsRoot, `${channelName}-allowlist.json`),
          this.allowlistPath,
        ],
        [
          path.join(channelsRoot, `${channelName}-groups.json`),
          this.groupAllowlistPath,
        ],
      ];
      this.ensureDir();
      let allSucceeded = true;
      for (const [legacyPath, scopedPath] of legacyPairs) {
        try {
          if (path.dirname(path.resolve(legacyPath)) !== channelsRoot) {
            continue;
          }
          if (fs.existsSync(scopedPath) || !fs.existsSync(legacyPath)) {
            continue;
          }
          const tmpPath = `${scopedPath}.${process.pid}.migrating`;
          fs.copyFileSync(legacyPath, tmpPath);
          fs.renameSync(tmpPath, scopedPath);
        } catch (err) {
          // Best-effort per file: an unreadable legacy file must not block
          // the other file or prevent the channel from starting. Leave the
          // sentinel unwritten so the next construction retries this file.
          allSucceeded = false;
          process.stderr.write(
            `[PairingStore] legacy migration of ${path.basename(legacyPath)} ` +
              `failed for channel "${channelName}": ` +
              `${(err as Error)?.message}; will retry on next start\n`,
          );
        }
      }
      // The sentinel closes the gate permanently, so it is only written once
      // every present legacy file has been copied (or was already there): a
      // partial failure (ENOSPC, transient I/O) must not lock in incomplete
      // state and silently drop previously-approved senders.
      if (allSucceeded) {
        fs.writeFileSync(this.migratedSentinelPath, '');
      }
    } catch (err) {
      // Best-effort: migration problems must not prevent the channel from
      // starting; the scoped store just starts empty and the migration is
      // retried on the next construction.
      process.stderr.write(
        `[PairingStore] legacy migration failed for channel ` +
          `"${channelName}": ${(err as Error)?.message}; scoped store starts empty\n`,
      );
    }
  }

  isApproved(senderId: string): boolean {
    const list = this.readAllowlist();
    return list.includes(senderId);
  }

  isGroupApproved(groupId: string): boolean {
    return this.readGroupAllowlist().includes(groupId);
  }

  /**
   * Create a pairing request for an unknown sender.
   * Returns the code if created; if the subject already has a non-expired
   * pending request, returns that code. Rejects with `sender_pending` when
   * the sender already holds a request for another subject, or
   * `cap_reached` when the pending cap is reached.
   */
  createRequest(
    senderId: string,
    senderName: string,
  ): CreatePairingRequestResult {
    return this.createSubjectRequest(
      { type: 'user', id: senderId, name: senderName },
      senderId,
      senderName,
    );
  }

  createGroupRequest(
    groupId: string,
    groupName: string,
    senderId: string,
    senderName: string,
  ): CreatePairingRequestResult {
    return this.createSubjectRequest(
      { type: 'group', id: groupId, name: groupName },
      senderId,
      senderName,
    );
  }

  private createSubjectRequest(
    subject: PairingSubject,
    senderId: string,
    senderName: string,
  ): CreatePairingRequestResult {
    const pending = this.readPending();

    // Purge expired
    const now = Date.now();
    const active = pending.filter((r) => now - r.createdAt < EXPIRY_MS);

    // Check if the same user or group already has a pending request
    const existing = active.find(
      (request) =>
        request.subject.type === subject.type &&
        request.subject.id === subject.id,
    );
    if (existing) {
      return { code: existing.code };
    }

    // One sender may hold only one pending request at a time: without this
    // limit one sender could occupy every shared slot and block all other
    // pairing requests until expiry. Subject-keyed dedup (above) keeps
    // re-mentions of the same group returning its existing code instead of
    // tripping this check.
    if (active.some((request) => request.senderId === senderId)) {
      return { rejected: 'sender_pending' };
    }

    // Cap check
    if (active.length >= MAX_PENDING) {
      return { rejected: 'cap_reached' };
    }

    const code = generateCode();
    active.push({ senderId, senderName, subject, code, createdAt: now });
    this.writePending(active);
    return { code };
  }

  /**
   * Approve a pairing request by code.
   * Returns the request if found, or null if not found / expired.
   */
  approve(code: string): PairingRequest | null {
    const pending = this.readPending();
    const now = Date.now();
    const idx = pending.findIndex(
      (r) => r.code === code.toUpperCase() && now - r.createdAt < EXPIRY_MS,
    );
    if (idx === -1) return null;

    const request = pending[idx]!;

    // Persist the approval BEFORE consuming the request: if the allowlist
    // write fails (or an existing allowlist file is unreadable and we refuse
    // to rebuild it from []), the request stays pending and the code remains
    // usable instead of being silently burned.
    if (request.subject.type === 'group') {
      const groups = this.readGroupAllowlist(true);
      if (!groups.includes(request.subject.id)) {
        groups.push(request.subject.id);
        this.writeGroupAllowlist(groups);
      }
    } else {
      const users = this.readAllowlist();
      if (!users.includes(request.subject.id)) {
        users.push(request.subject.id);
        this.writeAllowlist(users);
      }
    }

    pending.splice(idx, 1);
    this.writePending(pending);

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

  getGroupAllowlist(): string[] {
    return this.readGroupAllowlist();
  }

  revoke(senderId: string): boolean {
    const list = this.readAllowlist();
    const next = list.filter((id) => id !== senderId);
    if (next.length === list.length) {
      return false;
    }
    this.writeAllowlist(next);
    return true;
  }

  revokeGroup(groupId: string): boolean {
    const list = this.readGroupAllowlist();
    const next = list.filter((id) => id !== groupId);
    if (next.length === list.length) {
      return false;
    }
    this.writeGroupAllowlist(next);
    return true;
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
  }

  private readPending(): PairingRequest[] {
    try {
      const data = fs.readFileSync(this.pendingPath, 'utf-8');
      const requests = JSON.parse(data) as StoredPairingRequest[];
      return requests.map((request) => ({
        ...request,
        subject: request.subject ?? {
          type: 'user',
          id: request.senderId,
          name: request.senderName,
        },
      }));
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

  private readGroupAllowlist(strict = false): string[] {
    try {
      const data = fs.readFileSync(this.groupAllowlistPath, 'utf-8');
      return JSON.parse(data) as string[];
    } catch (err) {
      const exists = fs.existsSync(this.groupAllowlistPath);
      if (strict && exists) {
        // An existing-but-unreadable allowlist (torn write, permissions)
        // must not be silently rebuilt from []: that would permanently
        // discard every stored group approval on the next write.
        throw new Error(
          `refusing to rewrite unreadable group allowlist ` +
            `"${path.basename(this.groupAllowlistPath)}": ` +
            `${(err as Error)?.message}`,
        );
      }
      if (exists) {
        process.stderr.write(
          `[PairingStore] group allowlist ` +
            `"${path.basename(this.groupAllowlistPath)}" is unreadable ` +
            `(${(err as Error)?.message}); treating as empty — stored group ` +
            `approvals are not in effect and will be lost on the next approve\n`,
        );
      }
      return [];
    }
  }

  private writeGroupAllowlist(list: string[]): void {
    this.ensureDir();
    // Atomic temp+rename: this file is an authorization artifact, and a torn
    // write left behind by a crash mid-write would read as "no approvals".
    const tmpPath = `${this.groupAllowlistPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(list, null, 2));
    fs.renameSync(tmpPath, this.groupAllowlistPath);
  }
}

function generateCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += SAFE_ALPHABET[crypto.randomInt(SAFE_ALPHABET.length)];
  }
  return code;
}
