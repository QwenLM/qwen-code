/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Where a session's peer-messaging socket lives, and what counts as a
 * local IPC path.
 */

import { randomBytes } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Longest usable socket path.
 *
 * `sockaddr_un.sun_path` is 108 bytes on Linux and 104 on macOS, including
 * the NUL terminator. 103 is the largest value safe on both, and bind()
 * fails with ENAMETOOLONG rather than truncating, so the check has to
 * happen before we try.
 */
export const MAX_SOCKET_PATH_BYTES = 103;

/** Directory name (or prefix, in shared temp dirs) holding a socket. */
export const SOCKET_DIR_NAME = 'qwen-socks';

/**
 * Resolve this process's socket path.
 *
 * Prefers `$XDG_RUNTIME_DIR` — a per-user tmpfs that the OS cleans up on
 * logout, which is exactly the lifetime a session socket wants. Already
 * per-user, so the directory name there needs no user key.
 *
 * Anywhere else the temp directory can be shared with other users, and a
 * fixed or uid-derived directory name is either a cross-user collision
 * (whoever creates it first locks everyone else out) or a pre-creatable
 * denial-of-service target. Use an unpredictable name there instead;
 * peers learn the address from the session registry record, not from a
 * well-known path. Falls back to `/tmp` itself when even that is too
 * long to bind.
 */
export function resolvePeerSocketPath(pid: number = process.pid): string {
  return resolvePeerSocketCandidates(pid)[0]!;
}

/**
 * Every place this process could bind its socket, best first.
 *
 * The runtime directory is preferred but is not always usable: in a
 * rootless container or a user namespace it can be absent, owned by an
 * unmapped uid, or mounted read-only, and a session whose inbox silently
 * fails there is a session nobody can reach and nobody knows why. So the
 * bind tries these in order and only gives up when the last one fails.
 * Candidates over the `sun_path` limit are dropped up front.
 */
export function resolvePeerSocketCandidates(
  pid: number = process.pid,
): string[] {
  const candidates: string[] = [];
  const runtimeDir = process.env['XDG_RUNTIME_DIR'];
  if (runtimeDir) {
    candidates.push(path.join(runtimeDir, SOCKET_DIR_NAME, `${pid}.sock`));
  }
  const nonce = randomBytes(8).toString('hex');
  candidates.push(
    path.join(os.tmpdir(), `${SOCKET_DIR_NAME}-${nonce}`, `${pid}.sock`),
  );
  candidates.push(
    path.join('/tmp', `${SOCKET_DIR_NAME}-${nonce}`, `${pid}.sock`),
  );

  const fitting = candidates.filter(
    (candidate, index) =>
      Buffer.byteLength(candidate) <= MAX_SOCKET_PATH_BYTES &&
      candidates.indexOf(candidate) === index,
  );
  // Nothing fits: keep the last (shortest) candidate so the bind can fail
  // with a path-too-long cause that names it, rather than with nothing.
  return fitting.length > 0 ? fitting : [candidates[candidates.length - 1]!];
}

/**
 * True when `candidate` is a path we are willing to connect to.
 *
 * A peer address arrives from a file another process wrote, so it is
 * input, not fact. Connecting to an arbitrary string would let a hostile
 * record point this session at a socket in someone else's tree (or, on
 * Windows, at a named pipe on a remote host — `\\server\pipe\...` is a
 * legal pipe path that `net.connect` will happily dial off-machine).
 *
 * The rule is narrow on purpose: an absolute POSIX path, or a
 * `\\.\pipe\` / `\\?\pipe\` local pipe on Windows. Nothing relative,
 * nothing UNC.
 */
export function isLocalIpcPath(candidate: string): boolean {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  // A NUL would truncate the path inside libc while passing JS checks.
  if (candidate.includes('\0')) return false;

  if (process.platform === 'win32') {
    const normalized = candidate.replace(/\//g, '\\').toLowerCase();
    return (
      normalized.startsWith('\\\\.\\pipe\\') ||
      normalized.startsWith('\\\\?\\pipe\\')
    );
  }

  // Reject UNC-looking paths even on POSIX: they are not meaningful here
  // and accepting them only widens what a malformed record can express.
  if (candidate.startsWith('//')) return false;
  return path.isAbsolute(candidate);
}
