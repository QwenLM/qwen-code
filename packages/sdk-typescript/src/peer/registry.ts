/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The session registry: one small JSON file per running session, in a flat
 * directory under the Qwen home.
 *
 * A running session is found by reading this directory, and a record is
 * believed only when the process it names is still the one that wrote it
 * (see `identity.ts`). This module writes and removes this process's own
 * record and reads everyone's — and never deletes anyone else's. Clearing
 * out the records of sessions that died is left to Qwen Code sessions
 * themselves: a program that joins the directory has no business removing
 * what other processes wrote.
 */

import { randomBytes } from 'node:crypto';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  bootIdOf,
  isSameProcess,
  readLocalBootId,
  readPidNamespaceId,
  readProcStartToken,
} from './identity.js';

export const SESSION_REGISTRY_SCHEMA_VERSION = 1;

const REGISTRY_DIR_MODE = 0o700;
const RECORD_FILE_MODE = 0o600;

/** A record is a few hundred bytes; anything this large is not one. */
const MAX_RECORD_BYTES = 64 * 1024;

/**
 * `<pid>.json`, or the `<pid>-<8 hex>.json` a process holding more than one
 * record writes. Strict on purpose: a lenient match would read a stray
 * `2026-notes.json` as PID 2026.
 */
const RECORD_FILENAME = /^(\d+)(?:-[0-9a-f]{8})?\.json$/;

/** What a reader keeps in `kind`: wider than what any one build writes. */
const KIND_RE = /^[a-z][a-z0-9-]{0,15}$/;

export interface SessionRecord {
  schemaVersion: number;
  pid: number;
  /** `<boot id>:<start ticks>` on Linux; null elsewhere. */
  procStart: string | null;
  /** PID-namespace inode on Linux; null elsewhere. */
  pidNs: number | null;
  sessionId: string;
  cwd: string;
  name: string;
  /** Epoch milliseconds. */
  startedAt: number;
  qwenVersion: string | null;
  /** What registered: `tui`, `headless`, `serve`, `external`, or newer. */
  kind?: string;
  /** The inbox socket; absent means discoverable but not messageable. */
  ipcPath?: string;
  /** What a connection to `ipcPath` presents on its auth line. */
  ipcToken?: string;
}

export function isValidSessionKind(kind: string): boolean {
  return KIND_RE.test(kind);
}

/**
 * The Qwen home this process should use: `explicit`, else `QWEN_HOME`, else
 * `~/.qwen`. A leading `~` is expanded and a relative path is resolved
 * against the working directory, the way Qwen Code itself reads the
 * variable — two programs that disagree on this never see each other.
 */
export function resolveQwenHome(explicit?: string): string {
  const configured = explicit || process.env['QWEN_HOME'];
  if (configured) {
    let resolved = configured;
    if (
      resolved === '~' ||
      resolved.startsWith('~/') ||
      resolved.startsWith('~\\')
    ) {
      resolved = path.join(
        os.homedir(),
        ...resolved
          .slice(2)
          .split(/[/\\]+/)
          .filter(Boolean),
      );
    }
    return path.resolve(resolved);
  }
  const home = os.homedir();
  return home ? path.join(home, '.qwen') : path.join(os.tmpdir(), '.qwen');
}

export function sessionRegistryDir(qwenHome: string): string {
  return path.join(qwenHome, 'sessions');
}

/** The PID a record filename is keyed by, or null when it is not a record. */
export function pidOfRecordFilename(name: string): number | null {
  const match = RECORD_FILENAME.exec(name);
  if (!match) return null;
  const digits = match[1]!;
  const pid = Number.parseInt(digits, 10);
  // Canonical decimal only: nothing writes `007.json`, so a file named that
  // belongs to something else.
  return Number.isSafeInteger(pid) && pid > 0 && String(pid) === digits
    ? pid
    : null;
}

type RecordRead =
  | { status: 'ok'; record: SessionRecord }
  /** Absent. */
  | { status: 'missing' }
  /** Not a record this schema can describe: torn, malformed, oversized. */
  | { status: 'unusable' }
  /** A well-formed record from a newer schema. */
  | { status: 'newer' }
  /** The read failed for a reason other than absence; the file may be fine. */
  | { status: 'read-error' };

function parseRecordText(raw: string): RecordRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'unusable' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { status: 'unusable' };
  }
  const value = parsed as Record<string, unknown>;
  const schemaVersion = value['schemaVersion'];
  if (typeof schemaVersion !== 'number') return { status: 'unusable' };
  if (schemaVersion > SESSION_REGISTRY_SCHEMA_VERSION) {
    return { status: 'newer' };
  }
  const { pid, sessionId, cwd, name, startedAt } = value;
  if (
    typeof pid !== 'number' ||
    !Number.isInteger(pid) ||
    pid <= 0 ||
    typeof sessionId !== 'string' ||
    typeof cwd !== 'string' ||
    typeof name !== 'string' ||
    typeof startedAt !== 'number' ||
    !Number.isFinite(startedAt)
  ) {
    return { status: 'unusable' };
  }
  const { procStart, pidNs, qwenVersion, kind, ipcPath, ipcToken } = value;
  return {
    status: 'ok',
    record: {
      schemaVersion,
      pid,
      procStart: typeof procStart === 'string' ? procStart : null,
      pidNs: typeof pidNs === 'number' && Number.isFinite(pidNs) ? pidNs : null,
      sessionId,
      cwd,
      name,
      startedAt,
      qwenVersion: typeof qwenVersion === 'string' ? qwenVersion : null,
      // Absent means a writer older than the field, which reads differently
      // from a malformed one; a kind this build does not know is kept.
      ...(typeof kind === 'string' && KIND_RE.test(kind) ? { kind } : {}),
      ...(typeof ipcPath === 'string' && ipcPath.length > 0 ? { ipcPath } : {}),
      ...(typeof ipcToken === 'string' && ipcToken.length > 0
        ? { ipcToken }
        : {}),
    },
  };
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

async function readRecordFile(filePath: string): Promise<RecordRead> {
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile() || stats.size > MAX_RECORD_BYTES) {
      return { status: 'unusable' };
    }
    return parseRecordText(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    return isMissing(error) ? { status: 'missing' } : { status: 'read-error' };
  }
}

function readRecordFileSync(filePath: string): RecordRead {
  try {
    const stats = fsSync.statSync(filePath);
    if (!stats.isFile() || stats.size > MAX_RECORD_BYTES) {
      return { status: 'unusable' };
    }
    return parseRecordText(fsSync.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return isMissing(error) ? { status: 'missing' } : { status: 'read-error' };
  }
}

/**
 * Every record whose process is still the one that wrote it, newest first.
 *
 * A record is skipped — never deleted — when its file name and `pid`
 * disagree, when it was written from another PID namespace or another boot
 * (its PIDs resolve to different processes here), or when its process is
 * gone. An unreadable directory is an empty list.
 */
export async function readLiveSessionRecords(
  dir: string,
): Promise<SessionRecord[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const ownNamespace = readPidNamespaceId();
  const ownBootId = readLocalBootId();
  const live: SessionRecord[] = [];
  await Promise.all(
    entries.map(async (name) => {
      const pid = pidOfRecordFilename(name);
      if (pid === null) return;
      const read = await readRecordFile(path.join(dir, name));
      if (read.status !== 'ok') return;
      const record = read.record;
      if (record.pid !== pid) return;
      if (record.pidNs !== ownNamespace) return;
      const recordBootId =
        record.procStart === null ? null : bootIdOf(record.procStart);
      if (recordBootId !== null && recordBootId !== ownBootId) return;
      if (!isSameProcess(record.pid, record.procStart)) return;
      live.push(record);
    }),
  );
  return live.sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * True when a record at this process's PID-keyed path was left by an
 * earlier process that held the same PID number, in this namespace and this
 * boot. Only that record is provably nobody's now: a record from this very
 * process belongs to whatever else in it registered, and one without a start
 * token cannot be told apart from a live one.
 */
function isDeadPredecessor(record: SessionRecord): boolean {
  if (record.pid !== process.pid) return false;
  if (record.pidNs !== readPidNamespaceId()) return false;
  if (record.procStart === null) return false;
  const current = readProcStartToken(process.pid);
  if (current === null) return false;
  return (
    bootIdOf(record.procStart) === bootIdOf(current) &&
    record.procStart !== current
  );
}

async function isClaimable(
  filePath: string,
  shared: boolean,
): Promise<boolean> {
  let stats: fsSync.Stats;
  try {
    stats = await fs.lstat(filePath);
  } catch (error) {
    return isMissing(error);
  }
  // A minted name is never reused, and nothing but a plain file is ever
  // replaced: a symlink here was planted, not written by a session.
  if (!shared || !stats.isFile()) return false;
  const existing = await readRecordFile(filePath);
  switch (existing.status) {
    case 'missing':
    case 'unusable':
      return true;
    case 'ok':
      return isDeadPredecessor(existing.record);
    default:
      return false;
  }
}

async function ensureRegistryDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: REGISTRY_DIR_MODE });
  try {
    // mkdir's mode is masked by the umask and ignored for an existing
    // directory; chmod is what actually makes it 0700.
    await fs.chmod(dir, REGISTRY_DIR_MODE);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Filesystems without POSIX permissions cannot honour it at all.
    if (code !== 'ENOSYS' && code !== 'ENOTSUP') throw error;
  }
}

/**
 * Write `contents` beside `filePath` and rename it into place, so a reader
 * sees either the old file or the whole new one. The temporary is created
 * exclusively, which also refuses to follow a symlink planted at its name.
 */
async function writeAtomically(
  filePath: string,
  contents: string,
): Promise<void> {
  const temporary = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(temporary, 'wx', RECORD_FILE_MODE);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, filePath);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

/**
 * Registrations in this process, one at a time.
 *
 * Claiming the PID-keyed name is a read and then a rename. Two claims that
 * overlap inside one process would both find the name free and both take
 * it, the second silently replacing the first and leaving that endpoint in
 * no file at all. In sequence, the second finds the first's record and
 * mints a name of its own. Other processes cannot collide on the name: it
 * is keyed by this PID.
 */
let registrations: Promise<unknown> = Promise.resolve();

/**
 * Publish `record` for this process and return where it went.
 *
 * The PID-keyed `<pid>.json` is the name every reader understands, so it is
 * taken when it is free. When it is held — by another registration in this
 * same process, by a record from another namespace or machine that shares
 * this PID number, by a newer schema — the record goes to a freshly minted
 * `<pid>-<8 hex>.json` instead of overwriting something that may be live.
 */
export function writeOwnRecord(
  dir: string,
  record: SessionRecord,
): Promise<string> {
  const run = () => claimAndWrite(dir, record);
  const written = registrations.then(run, run);
  registrations = written.catch(() => {});
  return written;
}

async function claimAndWrite(
  dir: string,
  record: SessionRecord,
): Promise<string> {
  await ensureRegistryDir(dir);
  const contents = JSON.stringify(record, null, 2);
  const shared = path.join(dir, `${record.pid}.json`);
  if (await isClaimable(shared, true)) {
    await writeAtomically(shared, contents);
    return shared;
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const minted = path.join(
      dir,
      `${record.pid}-${randomBytes(4).toString('hex')}.json`,
    );
    if (await isClaimable(minted, false)) {
      await writeAtomically(minted, contents);
      return minted;
    }
  }
  throw new Error(`no free record name for PID ${record.pid} in ${dir}`);
}

function isOwnRecord(read: RecordRead, sessionId: string): boolean {
  return (
    read.status === 'ok' &&
    read.record.pid === process.pid &&
    read.record.sessionId === sessionId
  );
}

/**
 * Remove this process's record for `sessionId`. Anything else found at the
 * path — a record another registration has since written there — stays.
 */
export async function removeOwnRecord(
  filePath: string,
  sessionId: string,
): Promise<void> {
  if (!isOwnRecord(await readRecordFile(filePath), sessionId)) return;
  await fs.unlink(filePath).catch(() => {});
}

/** {@link removeOwnRecord} for an exit handler, where nothing can await. */
export function removeOwnRecordSync(filePath: string, sessionId: string): void {
  if (!isOwnRecord(readRecordFileSync(filePath), sessionId)) return;
  try {
    fsSync.unlinkSync(filePath);
  } catch {
    // Already gone.
  }
}
