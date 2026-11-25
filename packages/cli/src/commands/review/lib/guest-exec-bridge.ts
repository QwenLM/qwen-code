/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import { createConnection } from 'node:net';
import { basename, isAbsolute, join, posix, sep } from 'node:path';
import type { ReviewTeardownStatus } from './sandbox-trust.js';

export const GUEST_EXEC_PROTOCOL = 'guest-exec-v1';
export const FRAME_HEADER_BYTES = 5;
export const DEFAULT_MAX_FRAME_BYTES = 256 * 1024;
export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_WORKSPACE_FILES = 4096;
export const DEFAULT_MAX_WORKSPACE_FILE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_WORKSPACE_TOTAL_BYTES = 32 * 1024 * 1024;

export const LINUX_MAX_UDS_BYTES = 107;
export const DARWIN_MAX_UDS_BYTES = 103;

export type GuestExecFrameKind =
  | 'H'
  | 'A'
  | 'F'
  | 'D'
  | 'V'
  | 'X'
  | 'C'
  | 'O'
  | 'E'
  | 'Z'
  | 'R';

export type GuestWorkspaceMode = 'replace' | 'sync' | 'overlay' | 'reuse';

const VALID_WORKSPACE_MODES: ReadonlySet<string> = new Set([
  'replace',
  'sync',
  'overlay',
  'reuse',
]);

const VALID_FRAME_KINDS: ReadonlySet<string> = new Set([
  'H',
  'A',
  'F',
  'D',
  'V',
  'X',
  'C',
  'O',
  'E',
  'Z',
  'R',
]);

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const SIGNAL_NAME_RE = /^SIG[A-Z0-9]+$/;
const WORKSPACE_SESSION_ID_RE = /^[a-zA-Z0-9._-]{1,64}$/;
const DEFAULT_SKIP_DIRS: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
]);

export function validateWorkspaceSessionId(id: string): boolean {
  return WORKSPACE_SESSION_ID_RE.test(id) && id !== '.' && id !== '..';
}

function assertPositiveSafeInt(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer (got ${value})`);
  }
  return value;
}

export interface GuestExecFrame {
  kind: GuestExecFrameKind;
  payload: Buffer;
}

export interface WorkspaceFileEntry {
  path: string;
  content: Buffer;
  sha256: string;
}

export interface PackWorkspaceOptions {
  skipDirs?: ReadonlySet<string>;
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

export type PackWorkspaceResult =
  | { ok: true; files: WorkspaceFileEntry[]; totalBytes: number }
  | { ok: false; reason: string };

export interface GuestExecRequest {
  runId?: string;
  command: string;
  workdir?: string;
  kind: 'install' | 'build' | 'test';
  timeoutMs: number;
  env: Record<string, string>;
  /** Optional host worktree directory packed by content (never RW-mounted). */
  workspaceDir?: string;
  /**
   * Optional guest-side session identifier so `install` -> `build` -> `test`
   * (or mutation probe overlays) share the same guest-resident workspace
   * without ever mounting or writing back to the host worktree.
   */
  workspaceSessionId?: string;
  /**
   * How the guest updates `workspaceSessionId`:
   * - `replace` (default when uploading): create/reset session dir with uploaded files.
   * - `sync`: remove all non-`node_modules` entries in session dir, then write uploaded files (preserves guest `node_modules` while reflecting deletions).
   * - `overlay`: write uploaded files on top of existing session dir without deleting existing files.
   * - `reuse`: upload no files; execute in the already-populated session dir.
   */
  workspaceMode?: GuestWorkspaceMode;
  packOptions?: PackWorkspaceOptions;
  maxFrameBytes?: number;
  maxOutputBytes?: number;
}

export interface GuestExecResult {
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  protocolError?: string;
}

export interface VmWorkerReapOptions {
  pid?: number;
  pidFile?: string;
  expectedExeTokens: readonly string[];
  killWaitMs?: number;
  psSpawn?: typeof spawnSync;
  signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
  sleepMs?: (ms: number) => void;
}

export interface VmWorkerReapResult {
  status: ReviewTeardownStatus;
  pid?: number;
  detail?: string;
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function validateUdsPathLength(
  socketPath: string,
  platform: NodeJS.Platform = process.platform,
): { ok: true } | { ok: false; reason: string } {
  const byteLen = Buffer.byteLength(socketPath, 'utf8');
  const limit =
    platform === 'darwin' ? DARWIN_MAX_UDS_BYTES : LINUX_MAX_UDS_BYTES;
  if (byteLen === 0) {
    return { ok: false, reason: 'socket path is empty' };
  }
  if (socketPath.includes('\0')) {
    return { ok: false, reason: 'socket path contains NUL byte' };
  }
  if (byteLen > limit) {
    return {
      ok: false,
      reason: `socket path is ${byteLen} UTF-8 bytes, exceeding ${platform} sun_path limit of ${limit}`,
    };
  }
  return { ok: true };
}

/**
 * Verifies a bridge UDS endpoint without following symlinks so a repository or
 * compromised directory cannot redirect the client to an unrelated host socket.
 */
export function validateBridgeSocketEndpoint(
  socketPath: string,
  platform: NodeJS.Platform = process.platform,
): { ok: true } | { ok: false; reason: string } {
  const len = validateUdsPathLength(socketPath, platform);
  if (!len.ok) return len;
  if (!isAbsolute(socketPath)) {
    return {
      ok: false,
      reason: `bridge socket path must be absolute: ${socketPath}`,
    };
  }
  let st: Stats;
  try {
    st = lstatSync(socketPath);
  } catch (err) {
    return {
      ok: false,
      reason: `bridge socket unavailable (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`,
    };
  }
  if (st.isSymbolicLink()) {
    return {
      ok: false,
      reason: `refusing symlinked bridge socket path: ${socketPath}`,
    };
  }
  if (!st.isSocket()) {
    return {
      ok: false,
      reason: `bridge endpoint is not a Unix domain socket: ${socketPath}`,
    };
  }
  return { ok: true };
}

export function encodeFrame(
  kind: GuestExecFrameKind,
  payload: Buffer | string = Buffer.alloc(0),
  maxFrameBytes: number = DEFAULT_MAX_FRAME_BYTES,
): Buffer {
  assertPositiveSafeInt(maxFrameBytes, 'maxFrameBytes');
  const body =
    typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (body.length > maxFrameBytes) {
    throw new Error(
      `guest-exec frame "${kind}" payload (${body.length} bytes) exceeds maxFrameBytes (${maxFrameBytes})`,
    );
  }
  const header = Buffer.allocUnsafe(FRAME_HEADER_BYTES);
  header[0] = kind.charCodeAt(0);
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

export class GuestExecFrameDecoder {
  private buf: Buffer = Buffer.alloc(0);
  private totalBytes = 0;

  constructor(
    private readonly maxFrameBytes: number = DEFAULT_MAX_FRAME_BYTES,
    private readonly maxTotalBytes: number = DEFAULT_MAX_OUTPUT_BYTES +
      DEFAULT_MAX_FRAME_BYTES,
  ) {
    assertPositiveSafeInt(maxFrameBytes, 'maxFrameBytes');
    assertPositiveSafeInt(maxTotalBytes, 'maxTotalBytes');
  }

  push(chunk: Buffer): { frames: GuestExecFrame[]; error?: string } {
    this.totalBytes += chunk.length;
    if (this.totalBytes > this.maxTotalBytes) {
      return {
        frames: [],
        error: `bridge stream exceeded maxTotalBytes (${this.maxTotalBytes})`,
      };
    }
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const frames: GuestExecFrame[] = [];

    while (this.buf.length >= FRAME_HEADER_BYTES) {
      const kind = String.fromCharCode(this.buf[0]!);
      if (!VALID_FRAME_KINDS.has(kind)) {
        return {
          frames,
          error: `invalid guest-exec frame kind byte 0x${this.buf[0]!.toString(16)}`,
        };
      }
      const len = this.buf.readUInt32BE(1);
      if (len > this.maxFrameBytes) {
        return {
          frames,
          error: `guest-exec frame "${kind}" length ${len} exceeds maxFrameBytes (${this.maxFrameBytes})`,
        };
      }
      const frameEnd = FRAME_HEADER_BYTES + len;
      if (this.buf.length < frameEnd) {
        break;
      }
      const payload = Buffer.from(
        this.buf.subarray(FRAME_HEADER_BYTES, frameEnd),
      );
      this.buf = this.buf.subarray(frameEnd);
      frames.push({ kind: kind as GuestExecFrameKind, payload });
    }
    return { frames };
  }

  hasTrailingBytes(): boolean {
    return this.buf.length > 0;
  }
}

export function validateWorkspaceRelativePath(relPath: string): boolean {
  if (!relPath || relPath.includes('\0') || relPath.includes('\\')) {
    return false;
  }
  if (relPath.startsWith('/') || relPath.endsWith('/')) {
    return false;
  }
  const segments = relPath.split('/');
  return segments.every((s) => s.length > 0 && s !== '.' && s !== '..');
}

/**
 * Packs regular workspace files by content for upload to an isolated guest.
 *
 * Security invariants (D5):
 * - Uses `lstatSync` on every entry and refuses symlinks, FIFOs, sockets, and
 *   device nodes so a PR cannot point the packer outside the worktree.
 * - Enforces file count, per-file size, and aggregate byte budgets.
 */
export function packWorkspaceFiles(
  workspaceDir: string,
  opts: PackWorkspaceOptions = {},
): PackWorkspaceResult {
  const skipDirs = opts.skipDirs ?? DEFAULT_SKIP_DIRS;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_WORKSPACE_FILES;
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_WORKSPACE_FILE_BYTES;
  const maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_WORKSPACE_TOTAL_BYTES;
  try {
    assertPositiveSafeInt(maxFiles, 'maxFiles');
    assertPositiveSafeInt(maxFileBytes, 'maxFileBytes');
    assertPositiveSafeInt(maxTotalBytes, 'maxTotalBytes');
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }

  let rootStat: Stats;
  try {
    rootStat = lstatSync(workspaceDir);
  } catch (err) {
    return {
      ok: false,
      reason: `workspace directory unreadable: ${(err as Error).message}`,
    };
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return {
      ok: false,
      reason: `workspace root must be a regular directory (not a symlink): ${workspaceDir}`,
    };
  }
  let rootReal: string;
  try {
    rootReal = realpathSync(workspaceDir);
  } catch (err) {
    return {
      ok: false,
      reason: `workspace root realpath failed: ${(err as Error).message}`,
    };
  }

  const files: WorkspaceFileEntry[] = [];
  let totalBytes = 0;

  const walk = (absDir: string, relPrefix: string): string | null => {
    const dirReal = realpathSync(absDir);
    if (dirReal !== rootReal && !dirReal.startsWith(rootReal + sep)) {
      return `refusing escaped workspace directory outside root: ${relPrefix || '.'}`;
    }
    const entries = readdirSync(absDir).sort();
    for (const name of entries) {
      if (relPrefix === '' && skipDirs.has(name)) continue;
      if (skipDirs.has(name)) continue;
      const absPath = join(absDir, name);
      const relPath = relPrefix ? posix.join(relPrefix, name) : name;
      if (!validateWorkspaceRelativePath(relPath)) {
        return `disallowed workspace relative path: ${relPath}`;
      }
      const st = lstatSync(absPath);
      if (st.isSymbolicLink()) {
        return `refusing symlink in content-only workspace pack: ${relPath}`;
      }
      if (st.isDirectory()) {
        const err = walk(absPath, relPath);
        if (err) return err;
        continue;
      }
      if (!st.isFile()) {
        return `refusing non-regular file in content-only workspace pack: ${relPath}`;
      }
      if (files.length >= maxFiles) {
        return `workspace file count exceeds budget (${maxFiles})`;
      }
      if (st.size > maxFileBytes) {
        return `workspace file ${relPath} (${st.size} bytes) exceeds per-file budget (${maxFileBytes})`;
      }
      if (totalBytes + st.size > maxTotalBytes) {
        return `workspace total bytes exceeds budget (${maxTotalBytes})`;
      }
      let content: Buffer;
      const openFlags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
      const fd = openSync(absPath, openFlags);
      try {
        const fdStat = fstatSync(fd);
        if (!fdStat.isFile()) {
          return `refusing non-regular file in content-only workspace pack: ${relPath}`;
        }
        if (fdStat.size > maxFileBytes) {
          return `workspace file ${relPath} (${fdStat.size} bytes) exceeds per-file budget (${maxFileBytes})`;
        }
        if (totalBytes + fdStat.size > maxTotalBytes) {
          return `workspace total bytes exceeds budget (${maxTotalBytes})`;
        }
        content = readFileSync(fd);
      } finally {
        closeSync(fd);
      }
      if (
        content.length > maxFileBytes ||
        totalBytes + content.length > maxTotalBytes
      ) {
        return `workspace bytes grew past budget while reading ${relPath}`;
      }
      totalBytes += content.length;
      files.push({
        path: relPath,
        content,
        sha256: sha256Hex(content),
      });
    }
    return null;
  };

  try {
    const err = walk(workspaceDir, '');
    if (err) return { ok: false, reason: err };
  } catch (err) {
    return {
      ok: false,
      reason: `workspace pack failed: ${(err as Error).message}`,
    };
  }

  return { ok: true, files, totalBytes };
}

export function buildOutgoingWireBuffer(
  request: GuestExecRequest,
): { ok: true; wire: Buffer; runId: string } | { ok: false; reason: string } {
  const maxFrameBytes = request.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const runId = request.runId ?? `rev-${randomBytes(6).toString('hex')}`;
  if (
    request.workspaceSessionId !== undefined &&
    !validateWorkspaceSessionId(request.workspaceSessionId)
  ) {
    return {
      ok: false,
      reason: `invalid workspaceSessionId: ${JSON.stringify(request.workspaceSessionId)}`,
    };
  }
  if (
    request.workspaceMode !== undefined &&
    !VALID_WORKSPACE_MODES.has(request.workspaceMode)
  ) {
    return {
      ok: false,
      reason: `invalid workspaceMode: ${JSON.stringify(request.workspaceMode)}`,
    };
  }
  if (request.workspaceMode === 'reuse' && !request.workspaceSessionId) {
    return {
      ok: false,
      reason: 'workspaceMode "reuse" requires workspaceSessionId',
    };
  }
  const chunks: Buffer[] = [
    encodeFrame('H', GUEST_EXEC_PROTOCOL, maxFrameBytes),
  ];

  const shouldUpload =
    request.workspaceMode !== 'reuse' && Boolean(request.workspaceDir);
  if (shouldUpload && request.workspaceDir) {
    const packed = packWorkspaceFiles(
      request.workspaceDir,
      request.packOptions,
    );
    if (!packed.ok) return packed;
    for (const file of packed.files) {
      chunks.push(
        encodeFrame(
          'F',
          JSON.stringify({
            path: file.path,
            size: file.content.length,
            sha256: file.sha256,
          }),
          maxFrameBytes,
        ),
      );
      for (let off = 0; off < file.content.length; off += maxFrameBytes) {
        chunks.push(
          encodeFrame(
            'D',
            file.content.subarray(
              off,
              Math.min(off + maxFrameBytes, file.content.length),
            ),
            maxFrameBytes,
          ),
        );
      }
      chunks.push(encodeFrame('V', file.sha256, maxFrameBytes));
    }
  }

  const execPayload = JSON.stringify({
    runId,
    command: request.command,
    workdir: request.workdir ?? '.',
    kind: request.kind,
    network: request.kind === 'install' ? 'restricted' : 'none',
    timeoutMs: Math.max(1, Math.round(request.timeoutMs)),
    env: request.env,
    ...(request.workspaceSessionId !== undefined
      ? {
          workspaceSessionId: request.workspaceSessionId,
          workspaceMode:
            request.workspaceMode ?? (shouldUpload ? 'replace' : 'reuse'),
        }
      : {}),
  });
  try {
    chunks.push(encodeFrame('X', execPayload, maxFrameBytes));
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }

  return { ok: true, wire: Buffer.concat(chunks), runId };
}

interface GuestEndPayload {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdoutSha256: string;
  stderrSha256: string;
}

function parseEndPayload(payload: Buffer): GuestEndPayload | null {
  try {
    const parsed = JSON.parse(payload.toString('utf8')) as Record<
      string,
      unknown
    >;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const exitCode = parsed['exitCode'];
    const signal = parsed['signal'];
    const timedOut = parsed['timedOut'];
    const stdoutSha256 = parsed['stdoutSha256'];
    const stderrSha256 = parsed['stderrSha256'];
    if (
      !(
        exitCode === null ||
        (typeof exitCode === 'number' &&
          Number.isSafeInteger(exitCode) &&
          exitCode >= 0 &&
          exitCode <= 255)
      )
    ) {
      return null;
    }
    if (
      !(
        signal === null ||
        (typeof signal === 'string' && SIGNAL_NAME_RE.test(signal))
      )
    ) {
      return null;
    }
    if (exitCode !== null && signal !== null) {
      return null;
    }
    if (typeof timedOut !== 'boolean') return null;
    if (
      typeof stdoutSha256 !== 'string' ||
      !SHA256_HEX_RE.test(stdoutSha256) ||
      typeof stderrSha256 !== 'string' ||
      !SHA256_HEX_RE.test(stderrSha256)
    ) {
      return null;
    }
    return {
      exitCode,
      signal: signal as NodeJS.Signals | null,
      timedOut,
      stdoutSha256,
      stderrSha256,
    };
  } catch {
    return null;
  }
}

/**
 * Validates and interprets the complete sequence of frames returned by a guest
 * over the bridge socket. Rejects missing handshake ack, truncated streams (no
 * `Z` frame), trailing partial bytes, output overruns, and SHA-256 mismatches.
 */
export function evaluateGuestResponseWire(
  wire: Buffer,
  opts: { maxFrameBytes?: number; maxOutputBytes?: number } = {},
): GuestExecResult {
  const maxFrameBytes = opts.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const decoder = new GuestExecFrameDecoder(
    maxFrameBytes,
    maxOutputBytes + maxFrameBytes * 2,
  );
  const decoded = decoder.push(wire);
  if (decoded.error) {
    return {
      ok: false,
      exitCode: null,
      signal: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      protocolError: decoded.error,
    };
  }
  if (decoder.hasTrailingBytes()) {
    return {
      ok: false,
      exitCode: null,
      signal: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      protocolError: 'truncated guest-exec frame at EOF',
    };
  }

  let acked = false;
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let outputBytes = 0;
  let endPayload: GuestEndPayload | null = null;

  for (const frame of decoded.frames) {
    if (frame.kind === 'R') {
      const reason = frame.payload.toString('utf8').trim() || 'guest refused';
      return {
        ok: false,
        exitCode: null,
        signal: null,
        timedOut: false,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        protocolError: `guest-exec refused: ${reason}`,
      };
    }
    if (!acked) {
      if (
        frame.kind !== 'A' ||
        frame.payload.toString('utf8') !== GUEST_EXEC_PROTOCOL
      ) {
        return {
          ok: false,
          exitCode: null,
          signal: null,
          timedOut: false,
          stdout: '',
          stderr: '',
          protocolError: `expected handshake ack "${GUEST_EXEC_PROTOCOL}", got frame "${frame.kind}"`,
        };
      }
      acked = true;
      continue;
    }
    if (endPayload) {
      return {
        ok: false,
        exitCode: null,
        signal: null,
        timedOut: false,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        protocolError: `unexpected trailing frame "${frame.kind}" after end frame`,
      };
    }
    if (frame.kind === 'O' || frame.kind === 'E') {
      outputBytes += frame.payload.length;
      if (outputBytes > maxOutputBytes) {
        return {
          ok: false,
          exitCode: null,
          signal: null,
          timedOut: false,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          protocolError: `guest output exceeded maxOutputBytes (${maxOutputBytes})`,
        };
      }
      if (frame.kind === 'O') stdoutChunks.push(frame.payload);
      else stderrChunks.push(frame.payload);
      continue;
    }
    if (frame.kind === 'Z') {
      const parsed = parseEndPayload(frame.payload);
      if (!parsed) {
        return {
          ok: false,
          exitCode: null,
          signal: null,
          timedOut: false,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          protocolError: 'malformed guest-exec end frame',
        };
      }
      endPayload = parsed;
      continue;
    }
    return {
      ok: false,
      exitCode: null,
      signal: null,
      timedOut: false,
      stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      stderr: Buffer.concat(stderrChunks).toString('utf8'),
      protocolError: `unexpected guest-exec response frame "${frame.kind}"`,
    };
  }

  const stdoutBuf = Buffer.concat(stdoutChunks);
  const stderrBuf = Buffer.concat(stderrChunks);
  const stdout = stdoutBuf.toString('utf8');
  const stderr = stderrBuf.toString('utf8');

  if (!acked || !endPayload) {
    return {
      ok: false,
      exitCode: null,
      signal: null,
      timedOut: false,
      stdout,
      stderr,
      protocolError: !acked
        ? 'guest closed bridge before handshake ack'
        : 'guest closed bridge before end frame (truncated execution)',
    };
  }

  const actualStdoutSha = sha256Hex(stdoutBuf);
  const actualStderrSha = sha256Hex(stderrBuf);
  if (
    actualStdoutSha !== endPayload.stdoutSha256 ||
    actualStderrSha !== endPayload.stderrSha256
  ) {
    return {
      ok: false,
      exitCode: null,
      signal: null,
      timedOut: false,
      stdout,
      stderr,
      protocolError:
        'guest-exec output digest mismatch (corrupted or forged stream)',
    };
  }

  return {
    ok:
      !endPayload.timedOut &&
      endPayload.signal === null &&
      endPayload.exitCode === 0,
    exitCode: endPayload.exitCode,
    signal: endPayload.signal,
    timedOut: endPayload.timedOut,
    stdout,
    stderr,
  };
}

/**
 * Asynchronous guest-exec client over a per-round Unix domain socket.
 */
export async function executeViaGuestBridge(
  socketPath: string,
  request: GuestExecRequest,
): Promise<GuestExecResult> {
  const endpointCheck = validateBridgeSocketEndpoint(socketPath);
  if (!endpointCheck.ok) {
    return {
      ok: false,
      exitCode: null,
      signal: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      protocolError: endpointCheck.reason,
    };
  }

  const built = buildOutgoingWireBuffer(request);
  if (!built.ok) {
    return {
      ok: false,
      exitCode: null,
      signal: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      protocolError: built.reason,
    };
  }

  const maxFrameBytes = request.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const maxOutputBytes = request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const maxWireBytes = maxOutputBytes + maxFrameBytes * 2;
  const deadlineMs = Math.max(1, Math.round(request.timeoutMs));

  return new Promise<GuestExecResult>((resolvePromise) => {
    const received: Buffer[] = [];
    let totalReceived = 0;
    let settled = false;
    let exceeded = false;

    const finish = (res: GuestExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolvePromise(res);
    };

    const socket = createConnection({ path: socketPath });
    const timer = setTimeout(() => {
      finish({
        ok: false,
        exitCode: null,
        signal: 'SIGKILL',
        timedOut: true,
        stdout: '',
        stderr: '',
        protocolError: `guest-exec bridge timed out after ${deadlineMs}ms`,
      });
    }, deadlineMs);

    socket.on('connect', () => {
      socket.write(built.wire);
    });

    socket.on('data', (chunk: Buffer) => {
      totalReceived += chunk.length;
      if (totalReceived > maxWireBytes) {
        exceeded = true;
        finish({
          ok: false,
          exitCode: null,
          signal: null,
          timedOut: false,
          stdout: '',
          stderr: '',
          protocolError: `bridge stream exceeded maxTotalBytes (${maxWireBytes})`,
        });
        return;
      }
      received.push(chunk);
    });

    socket.on('error', (err) => {
      finish({
        ok: false,
        exitCode: null,
        signal: null,
        timedOut: false,
        stdout: '',
        stderr: '',
        protocolError: `guest-exec bridge socket error: ${err.message}`,
      });
    });

    socket.on('end', () => {
      if (exceeded) return;
      finish(
        evaluateGuestResponseWire(Buffer.concat(received), {
          maxFrameBytes,
          maxOutputBytes,
        }),
      );
    });

    socket.on('close', () => {
      if (settled) return;
      finish({
        ok: false,
        exitCode: null,
        signal: null,
        timedOut: false,
        stdout: '',
        stderr: '',
        protocolError: 'guest-exec bridge closed unexpectedly before EOF',
      });
    });
  });
}

// Minimal raw byte pump for synchronous CLI callers (`build-test`,
// `test-efficacy`, `test-delta`). Contains zero protocol semantics — all frame
// decoding, digest verification, and truncation checks run in the parent.
const RAW_UDS_PUMP_SCRIPT = `
import { createConnection } from 'node:net';
const [socketPath, maxWireRaw] = process.argv.slice(1);
const maxWire = Number(maxWireRaw);
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const outgoing = Buffer.concat(chunks);
let total = 0;
const s = createConnection({ path: socketPath });
s.on('connect', () => s.write(outgoing));
s.on('data', (d) => {
  total += d.length;
  if (total > maxWire) {
    process.stderr.write('bridge stream exceeded maxTotalBytes');
    s.destroy();
    process.exitCode = 2;
    process.stdout.end();
    return;
  }
  if (!process.stdout.write(d)) {
    s.pause();
    process.stdout.once('drain', () => s.resume());
  }
});
s.on('error', (e) => {
  process.stderr.write(String(e?.message || e));
  process.exitCode = 3;
  process.stdout.end();
});
s.on('end', () => {
  process.stdout.end();
});
`;

/**
 * Synchronous guest-exec adapter for `build-test`, `test-efficacy`, and
 * `test-delta`. Runs the raw UDS byte pump in a bounded child process so
 * `spawnSync` timeout semantics apply cleanly without duplicating protocol
 * verification logic.
 */
export function executeViaGuestBridgeSync(
  socketPath: string,
  request: GuestExecRequest,
): GuestExecResult {
  const endpointCheck = validateBridgeSocketEndpoint(socketPath);
  if (!endpointCheck.ok) {
    return {
      ok: false,
      exitCode: null,
      signal: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      protocolError: endpointCheck.reason,
    };
  }

  const built = buildOutgoingWireBuffer(request);
  if (!built.ok) {
    return {
      ok: false,
      exitCode: null,
      signal: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      protocolError: built.reason,
    };
  }

  const maxFrameBytes = request.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const maxOutputBytes = request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const maxWireBytes = maxOutputBytes + maxFrameBytes * 2;
  const deadlineMs = Math.max(1, Math.round(request.timeoutMs));

  const r = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      RAW_UDS_PUMP_SCRIPT,
      socketPath,
      String(maxWireBytes),
    ],
    {
      input: built.wire,
      maxBuffer: maxWireBytes + 65_536,
      timeout: deadlineMs,
      killSignal: 'SIGKILL',
    },
  );

  const errCode = (r.error as NodeJS.ErrnoException | undefined)?.code;
  if (
    errCode === 'ETIMEDOUT' ||
    (r.status === null && r.signal === 'SIGKILL')
  ) {
    return {
      ok: false,
      exitCode: null,
      signal: 'SIGKILL',
      timedOut: true,
      stdout: '',
      stderr: '',
      protocolError: `guest-exec bridge timed out after ${deadlineMs}ms`,
    };
  }

  if (r.error) {
    return {
      ok: false,
      exitCode: null,
      signal: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      protocolError: `guest-exec bridge spawn failed: ${r.error.message}`,
    };
  }

  if (r.status !== 0) {
    const errMsg =
      (Buffer.isBuffer(r.stderr)
        ? r.stderr.toString('utf8')
        : String(r.stderr ?? '')
      ).trim() || `bridge pump exited ${String(r.status)}`;
    return {
      ok: false,
      exitCode: null,
      signal: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      protocolError: errMsg,
    };
  }

  const wire = Buffer.isBuffer(r.stdout)
    ? r.stdout
    : Buffer.from(String(r.stdout ?? ''), 'utf8');
  return evaluateGuestResponseWire(wire, { maxFrameBytes, maxOutputBytes });
}

function defaultSleepMs(ms: number): void {
  if (ms <= 0) return;
  const arr = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(arr, 0, 0, ms);
}

function readPidFromFile(
  pidFile: string,
): { ok: true; pid: number } | { ok: false; reason: string } {
  let st: Stats;
  try {
    st = lstatSync(pidFile);
  } catch (err) {
    return {
      ok: false,
      reason: `pid file unreadable (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`,
    };
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    return {
      ok: false,
      reason: `refusing non-regular or symlinked pid file: ${pidFile}`,
    };
  }
  const raw = readFileSync(pidFile, 'utf8').trim();
  if (!/^[1-9][0-9]*$/.test(raw)) {
    return {
      ok: false,
      reason: `invalid pid in ${pidFile}: ${JSON.stringify(raw)}`,
    };
  }
  const pid = Number(raw);
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    return { ok: false, reason: `disallowed pid ${pid}` };
  }
  return { ok: true, pid };
}

interface ProcessIdentity {
  alive: boolean;
  state: string;
  /** Basenames of the executable itself (`comm`, `argv[0]`, and Linux `/proc/<pid>/exe`) — never `argv[1..]`. */
  executableNames: string[];
}

function normalizeExeBasename(raw: string): string | null {
  // Linux `/proc/<pid>/exe` appends this suffix after a binary is unlinked or
  // replaced. It describes the inode's deleted name, not a different program.
  const trimmed = raw
    .trim()
    .replace(/\s+\(deleted\)$/, '')
    .replace(/^-+/, '');
  if (!trimmed) return null;
  const base = basename(trimmed).toLowerCase();
  return base || null;
}

function inspectProcessIdentity(
  pid: number,
  psSpawn: typeof spawnSync,
): ProcessIdentity | null {
  const commProbe = psSpawn('ps', ['-p', String(pid), '-o', 'state=,comm='], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  if (commProbe.error) return null;
  if (commProbe.status !== 0) {
    return { alive: false, state: '', executableNames: [] };
  }
  const line = String(commProbe.stdout ?? '').trim();
  if (!line) {
    return { alive: false, state: '', executableNames: [] };
  }
  const match = /^(\S+)\s+(.+)$/.exec(line);
  const state = match?.[1] ?? '';
  const commRaw = match?.[2] ?? '';
  // Zombie ('Z') and dead ('X') processes are no longer executing.
  const firstState = state[0]?.toUpperCase() ?? '';
  if (firstState === 'Z' || firstState === 'X') {
    return { alive: false, state, executableNames: [] };
  }

  const names = new Set<string>();
  const commBase = normalizeExeBasename(commRaw);
  if (commBase) names.add(commBase);

  // Also inspect argv[0] only (first whitespace-delimited token, never argv[1..]).
  const argsProbe = psSpawn('ps', ['-p', String(pid), '-o', 'args='], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  if (!argsProbe.error && argsProbe.status === 0) {
    const argv0 =
      String(argsProbe.stdout ?? '')
        .trim()
        .split(/\s+/)[0] ?? '';
    const argv0Base = normalizeExeBasename(argv0);
    if (argv0Base) names.add(argv0Base);
  }

  // On Linux, also read the kernel's `/proc/<pid>/exe` target when readable.
  if (process.platform === 'linux') {
    try {
      const exeBase = normalizeExeBasename(readlinkSync(`/proc/${pid}/exe`));
      if (exeBase) names.add(exeBase);
    } catch {
      // Unreadable or non-procfs environment; fall back to `comm` + `argv[0]`.
    }
  }

  return { alive: true, state, executableNames: [...names] };
}

function executableIdentityMatches(
  executableNames: readonly string[],
  expectedExeTokens: readonly string[],
): boolean {
  for (const rawToken of expectedExeTokens) {
    const token = normalizeExeBasename(rawToken);
    if (!token) continue;
    for (const exe of executableNames) {
      if (exe === token) return true;
      // Linux TASK_COMM_LEN truncates `comm` to 15 bytes.
      if (token.length > 15 && exe === token.slice(0, 15)) return true;
    }
  }
  return false;
}

/**
 * Best-effort cleanup frame asking the guest peer to delete a persisted
 * `workspaceSessionId` directory once a review phase finishes.
 */
export function closeGuestSessionSync(
  socketPath: string,
  workspaceSessionId: string,
  timeoutMs: number = 5_000,
): boolean {
  if (!validateWorkspaceSessionId(workspaceSessionId)) return false;
  if (!validateBridgeSocketEndpoint(socketPath).ok) return false;
  const runId = `close-${randomBytes(6).toString('hex')}`;
  const wire = Buffer.concat([
    encodeFrame('H', GUEST_EXEC_PROTOCOL),
    encodeFrame(
      'C',
      JSON.stringify({
        runId,
        workspaceSessionId,
        sessionSha256: sha256Hex(workspaceSessionId),
      }),
    ),
  ]);
  const r = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      RAW_UDS_PUMP_SCRIPT,
      socketPath,
      String(DEFAULT_MAX_FRAME_BYTES),
    ],
    {
      input: wire,
      maxBuffer: DEFAULT_MAX_FRAME_BYTES + 65_536,
      timeout: Math.max(1, Math.round(timeoutMs)),
      killSignal: 'SIGKILL',
    },
  );
  if (r.error || r.status !== 0) return false;
  const wireOut = Buffer.isBuffer(r.stdout)
    ? r.stdout
    : Buffer.from(String(r.stdout ?? ''), 'utf8');
  const decoder = new GuestExecFrameDecoder();
  const decoded = decoder.push(wireOut);
  if (decoded.error || decoder.hasTrailingBytes()) return false;
  const frames = decoded.frames;
  if (
    frames.length !== 2 ||
    frames[0]?.kind !== 'A' ||
    frames[0].payload.toString('utf8') !== GUEST_EXEC_PROTOCOL ||
    frames[1]?.kind !== 'Z'
  ) {
    return false;
  }
  try {
    const ack = JSON.parse(frames[1].payload.toString('utf8')) as {
      runId?: unknown;
      workspaceSessionId?: unknown;
      sessionSha256?: unknown;
      exitCode?: unknown;
      signal?: unknown;
      timedOut?: unknown;
    };
    return (
      ack.runId === runId &&
      ack.workspaceSessionId === workspaceSessionId &&
      ack.sessionSha256 === sha256Hex(workspaceSessionId) &&
      ack.exitCode === 0 &&
      ack.signal === null &&
      ack.timedOut === false
    );
  } catch {
    return false;
  }
}

/**
 * Verifies executable identity of a VMM/bridge worker PID and terminates it
 * cleanly (`SIGTERM` -> bounded wait -> `SIGKILL` -> confirmed absence).
 * Matches ONLY executable names (`comm`, `argv[0]`, Linux `/proc/<pid>/exe`),
 * never arbitrary command-line arguments.
 */
export function reapVmWorker(opts: VmWorkerReapOptions): VmWorkerReapResult {
  const psSpawn = opts.psSpawn ?? spawnSync;
  const signalProcess =
    opts.signalProcess ?? ((pid, sig) => process.kill(pid, sig));
  const sleep = opts.sleepMs ?? defaultSleepMs;
  const killWaitMs = opts.killWaitMs ?? 1500;

  let pid = opts.pid;
  if (pid === undefined && opts.pidFile) {
    const parsed = readPidFromFile(opts.pidFile);
    if (!parsed.ok) {
      return { status: 'failed', detail: parsed.reason };
    }
    pid = parsed.pid;
  }
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 1) {
    return {
      status: 'failed',
      detail: 'no valid worker pid or pidFile provided for VMM teardown',
    };
  }
  if (pid === process.pid) {
    return {
      status: 'failed',
      pid,
      detail: `refusing to signal current host process pid ${pid}`,
    };
  }
  if (opts.expectedExeTokens.length === 0) {
    return {
      status: 'failed',
      pid,
      detail: 'refusing to signal worker pid without expectedExeTokens',
    };
  }

  const initial = inspectProcessIdentity(pid, psSpawn);
  if (initial === null) {
    return {
      status: 'failed',
      pid,
      detail: `unable to inspect worker pid ${pid} via ps`,
    };
  }
  if (!initial.alive) {
    return { status: 'clean', pid };
  }

  if (
    !executableIdentityMatches(initial.executableNames, opts.expectedExeTokens)
  ) {
    return {
      status: 'failed',
      pid,
      detail: `worker pid ${pid} executable identity mismatch (observed: ${JSON.stringify(initial.executableNames)}); refusing to kill unrelated process`,
    };
  }

  const sendSignal = (sig: NodeJS.Signals): boolean => {
    try {
      signalProcess(pid, sig);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
        return true;
      }
      return false;
    }
  };

  const waitUntilGone = (budgetMs: number): boolean => {
    const deadline = Date.now() + budgetMs;
    while (true) {
      const check = inspectProcessIdentity(pid, psSpawn);
      if (check && !check.alive) return true;
      if (Date.now() >= deadline) return false;
      sleep(Math.min(50, Math.max(1, deadline - Date.now())));
    }
  };

  sendSignal('SIGTERM');
  if (waitUntilGone(killWaitMs)) {
    return { status: 'clean', pid };
  }

  sendSignal('SIGKILL');
  if (waitUntilGone(1000)) {
    return { status: 'clean', pid };
  }

  return {
    status: 'failed',
    pid,
    detail: `worker pid ${pid} remained alive after SIGTERM and SIGKILL`,
  };
}
