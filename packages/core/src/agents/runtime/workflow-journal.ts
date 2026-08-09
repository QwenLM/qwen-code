/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Same-session workflow resume via a JSONL journal. Every
 * `agent()` dispatch in a run appends a `started` then a `result` line to
 * `<projectDir>/workflows/<runId>/journal.jsonl`. Re-running the workflow
 * with `Workflow({resumeFromRunId})` loads the journal and serves cached
 * results for the longest UNCHANGED PREFIX of `agent()` calls — the first
 * call whose (rolling prefix + prompt + opts) hash diverges, or that has no
 * journaled result, runs live, and every call after it runs live too.
 *
 * Key derivation (matches upstream `v2`): each dispatch's key is
 * `v2:sha256(prefixHash ‖ prompt ‖ canonicalOpts)`, where `prefixHash` is
 * the PREVIOUS dispatch's key (rolling chain, empty for the first call).
 * Chaining is what gives "longest unchanged prefix" semantics: editing
 * call #3 changes its key, which changes #4's prefix, which changes #4's
 * key, and so on — so the cache naturally invalidates from the edit point.
 *
 * The `canonicalOpts` projection keeps only the dispatch-affecting opts
 * (`schema`, `model`, `isolation`, `agentType`) with object keys sorted, so
 * cosmetic opt differences (a re-ordered schema, a `label` change) don't
 * bust the cache.
 *
 * Determinism requirement: workflow scripts are deterministic (`Date.now`
 * / `Math.random` throw in the sandbox), so the sequence of `agent()`
 * calls — and therefore the key chain — is stable across runs. That is the
 * precondition that makes prefix-hash caching correct.
 */

import { createHash } from 'node:crypto';
import {
  constants as fsConstants,
  promises as fs,
  lstatSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import * as path from 'node:path';
import { parseLineTolerant } from '../../utils/jsonl-utils.js';
import { createDebugLogger } from '../../utils/debugLogger.js';
import { atomicWriteFile } from '../../utils/atomicFileWrite.js';
import type { WorkflowAgentOpts } from './workflow-sandbox.js';

const debugLogger = createDebugLogger('WORKFLOW_JOURNAL');

/** Journal-format version tag, prefixed onto every key. */
export const JOURNAL_KEY_VERSION = 'v2';

/** Durable checkpoint schema for committed journal prefixes. */
export const JOURNAL_FORMAT_VERSION = 1;

/**
 * Upper bound on a `journal.jsonl` read into memory. The journal lives under
 * `<projectDir>/workflows`, which ships with the repository, so a clone can
 * carry a multi-gigabyte journal alongside a small, structurally valid
 * `canResume` manifest — and the listing path journal-loads every such
 * manifest. Buffering that aborts the process before any `byteLength`/hash
 * check can reject it, so the size is checked first. The bound clears any
 * ordinary run — the default dispatch cap is 1000, i.e. two lines each — but
 * it is not unreachable: `QWEN_CODE_MAX_WORKFLOW_AGENTS` raises that cap to
 * `HARD_MAX_AGENTS_PER_RUN_CEILING` (10,000, so 20,000 lines) and per-line
 * result size is unbounded, so a run configured that way can cross it and
 * lose resumability with an intact journal on disk. Fixing that properly
 * means streaming the checkpoint hash and reading only up to
 * `checkpoint.byteLength` instead of buffering the whole file.
 */
export const MAX_WORKFLOW_JOURNAL_BYTES = 128 * 1024 * 1024;

export interface JournalCheckpoint {
  version: typeof JOURNAL_FORMAT_VERSION;
  keyVersion: typeof JOURNAL_KEY_VERSION;
  byteLength: number;
  sha256: string;
  integrity: 'complete' | 'failed';
  error?: string;
}

export interface JournalStartedEntry {
  type: 'started';
  key: string;
  agentId: string;
}

export interface JournalResultEntry {
  type: 'result';
  key: string;
  agentId: string;
  result: unknown;
}

export type JournalEntry = JournalStartedEntry | JournalResultEntry;

/** Parsed journal: completed results + started-but-maybe-incomplete markers. */
export interface JournalReplay {
  /** key → the completed result entry (last write wins). */
  results: Map<string, JournalResultEntry>;
  /** key → all `started` entries seen (length > 1 ⇒ prior respawns). */
  started: Map<string, JournalStartedEntry[]>;
}

/**
 * Project the dispatch-affecting opts into a stable canonical string. Only
 * `schema` / `model` / `isolation` / `agentType` change what the dispatch
 * does; `label` / `phase` / `stallMs` are cosmetic or operational and must
 * NOT bust the cache. Object keys are sorted recursively so a re-serialized
 * schema with reordered keys hashes the same.
 */
export function canonicalizeAgentOpts(opts: WorkflowAgentOpts): string {
  const projected: Record<string, unknown> = {};
  for (const k of ['schema', 'model', 'isolation', 'agentType'] as const) {
    const v = opts[k];
    if (v === undefined || typeof v === 'function') continue;
    projected[k] = v;
  }
  const sortDeep = (val: unknown): unknown => {
    if (typeof val === 'function') return undefined;
    if (Array.isArray(val)) return val.map(sortDeep);
    if (val && typeof val === 'object') {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(val as Record<string, unknown>).sort()) {
        if (key === '__proto__') continue;
        out[key] = sortDeep((val as Record<string, unknown>)[key]);
      }
      return out;
    }
    return val;
  };
  try {
    return JSON.stringify(sortDeep(projected));
  } catch {
    // A non-serializable opt (shouldn't happen — opts are JSON-revived
    // before crossing the vm boundary) falls back to an empty projection
    // so the dispatch still gets a stable (prompt-only) key.
    return '{}';
  }
}

/**
 * Derive a dispatch's resume key from the rolling prefix hash, the prompt,
 * and the canonical opts. Returns `{key}`; the caller chains by setting the
 * next `prefixHash = key`.
 */
export function deriveAgentKey(
  prefixHash: string,
  prompt: string,
  opts: WorkflowAgentOpts,
): string {
  const hash = createHash('sha256');
  hash.update(prefixHash);
  hash.update('\0');
  hash.update(prompt);
  hash.update('\0');
  hash.update(canonicalizeAgentOpts(opts));
  return `${JOURNAL_KEY_VERSION}:${hash.digest('hex')}`;
}

/**
 * Seed for the resume prefix-hash chain, derived from the run's `args`. Folding
 * `args` into the chain root means a resume with DIFFERENT args produces a
 * disjoint key space: every `agent()` call misses the journal and re-runs live
 * instead of silently replaying the previous run's results. (The tool documents
 * "pass the same args" as a user obligation; this enforces it.)
 */
export function deriveArgsSeed(args: unknown): string {
  const hash = createHash('sha256');
  let serialized: string;
  try {
    serialized = JSON.stringify(args ?? null) ?? 'null';
  } catch {
    // `args` is contractually JSON; a non-serializable value (cycle/BigInt)
    // hashes to a stable sentinel so the chain stays deterministic.
    serialized = 'non-serializable-args';
  }
  hash.update(serialized);
  return `${JOURNAL_KEY_VERSION}:${hash.digest('hex')}`;
}

/**
 * Build the replay maps from a flat list of journal entries. `result`
 * entries win last-write; `started` entries accumulate (so a key started
 * N times surfaces N prior attempts for the respawn telemetry).
 */
export function buildReplay(entries: JournalEntry[]): JournalReplay {
  const results = new Map<string, JournalResultEntry>();
  const started = new Map<string, JournalStartedEntry[]>();
  for (const e of entries) {
    if (e.type === 'result') {
      results.set(e.key, e);
    } else if (e.type === 'started') {
      const list = started.get(e.key);
      if (list) list.push(e);
      else started.set(e.key, [e]);
    }
  }
  return { results, started };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isJournalEntry(value: unknown): value is JournalEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  if (
    typeof entry['key'] !== 'string' ||
    entry['key'].length === 0 ||
    typeof entry['agentId'] !== 'string' ||
    entry['agentId'].length === 0
  ) {
    return false;
  }
  if (entry['type'] === 'started') return true;
  return entry['type'] === 'result' && Object.hasOwn(entry, 'result');
}

function validateCheckpoint(checkpoint: JournalCheckpoint): void {
  if (
    checkpoint.version !== JOURNAL_FORMAT_VERSION ||
    checkpoint.keyVersion !== JOURNAL_KEY_VERSION ||
    !Number.isSafeInteger(checkpoint.byteLength) ||
    checkpoint.byteLength < 0 ||
    !/^[0-9a-f]{64}$/.test(checkpoint.sha256) ||
    (checkpoint.integrity !== 'complete' && checkpoint.integrity !== 'failed')
  ) {
    throw new Error('Invalid workflow journal checkpoint');
  }
  if (checkpoint.integrity !== 'complete') {
    throw new Error(
      `Workflow journal checkpoint integrity failed${checkpoint.error ? `: ${checkpoint.error}` : ''}`,
    );
  }
}

function parseCommittedEntries(bytes: Buffer): JournalEntry[] {
  if (bytes.byteLength === 0) return [];
  if (bytes[bytes.byteLength - 1] !== 0x0a) {
    throw new Error('Invalid workflow journal: committed line is truncated');
  }
  const lines = bytes.toString('utf8').split('\n');
  lines.pop();
  return lines.map((line, index) => {
    if (line.length === 0) {
      throw new Error(`Invalid workflow journal entry at line ${index + 1}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`Invalid workflow journal JSON at line ${index + 1}`);
    }
    if (!isJournalEntry(parsed)) {
      throw new Error(`Invalid workflow journal entry at line ${index + 1}`);
    }
    return parsed;
  });
}

interface JournalParentGuard {
  assertUnchanged(): void;
}

function assertSafeJournalFile(stat: Stats, journalPath: string): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    // Name the invariant that failed. This message is the only thing that
    // survives into the durable checkpoint `error` and the `/workflows`
    // resumeBlockedReason, so a bare "unsafe" leaves an operator (or a CI
    // failure) with no way to tell a symlink swap from a stray hard link.
    const why = !stat.isFile()
      ? `not a regular file (mode 0o${(stat.mode & 0o170000).toString(8)})`
      : stat.isSymbolicLink()
        ? 'symbolic link'
        : `hard link count ${stat.nlink}, expected 1`;
    throw new Error(`Unsafe workflow journal path: ${journalPath} (${why})`);
  }
}

function assertSameJournalFile(
  expected: Stats,
  actual: Stats,
  journalPath: string,
): void {
  if (expected.dev !== actual.dev || expected.ino !== actual.ino) {
    throw new Error(`Workflow journal path changed: ${journalPath}`);
  }
}

async function guardJournalParents(
  journalPath: string,
  create: boolean,
): Promise<JournalParentGuard | undefined> {
  const runDir = path.dirname(journalPath);
  const root = path.dirname(runDir);
  if (create) {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
  }
  let rootStat;
  try {
    rootStat = await fs.lstat(root);
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Unsafe workflow journal root: ${root}`);
  }
  if (create) {
    await fs.mkdir(runDir, { mode: 0o700 }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
  }
  let runStat;
  try {
    runStat = await fs.lstat(runDir);
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  if (!runStat.isDirectory() || runStat.isSymbolicLink()) {
    throw new Error(`Unsafe workflow journal directory: ${runDir}`);
  }
  const [realRoot, realRunDir] = await Promise.all([
    fs.realpath(root),
    fs.realpath(runDir),
  ]);
  if (path.dirname(realRunDir) !== realRoot) {
    throw new Error(`Workflow journal directory escapes its root: ${runDir}`);
  }
  const rootIdentity = { dev: rootStat.dev, ino: rootStat.ino, realRoot };
  const runIdentity = { dev: runStat.dev, ino: runStat.ino, realRunDir };
  return {
    assertUnchanged(): void {
      const currentRoot = lstatSync(root);
      const currentRun = lstatSync(runDir);
      if (
        currentRoot.isSymbolicLink() ||
        !currentRoot.isDirectory() ||
        currentRoot.dev !== rootIdentity.dev ||
        currentRoot.ino !== rootIdentity.ino ||
        realpathSync(root) !== rootIdentity.realRoot ||
        currentRun.isSymbolicLink() ||
        !currentRun.isDirectory() ||
        currentRun.dev !== runIdentity.dev ||
        currentRun.ino !== runIdentity.ino ||
        realpathSync(runDir) !== runIdentity.realRunDir
      ) {
        throw new Error(`Workflow journal parent changed: ${runDir}`);
      }
    },
  };
}

async function guardJournalTarget(
  journalPath: string,
): Promise<JournalParentGuard> {
  let expected: Stats | undefined;
  try {
    expected = await fs.lstat(journalPath);
    assertSafeJournalFile(expected, journalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return {
    assertUnchanged(): void {
      let current: Stats | undefined;
      try {
        current = lstatSync(journalPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (!expected && !current) return;
      if (!expected || !current) {
        throw new Error(`Workflow journal path changed: ${journalPath}`);
      }
      assertSafeJournalFile(current, journalPath);
      assertSameJournalFile(expected, current, journalPath);
    },
  };
}

async function readJournalBytes(journalPath: string): Promise<Buffer> {
  const guard = await guardJournalParents(journalPath, false);
  if (!guard) return Buffer.alloc(0);
  let before: Stats;
  try {
    before = await fs.lstat(journalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      guard.assertUnchanged();
      return Buffer.alloc(0);
    }
    throw error;
  }
  assertSafeJournalFile(before, journalPath);
  let handle;
  try {
    handle = await fs.open(
      journalPath,
      fsConstants.O_RDONLY |
        (process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      guard.assertUnchanged();
      return Buffer.alloc(0);
    }
    throw error;
  }
  try {
    guard.assertUnchanged();
    const [opened, current] = await Promise.all([
      handle.stat(),
      fs.lstat(journalPath),
    ]);
    assertSafeJournalFile(opened, journalPath);
    assertSafeJournalFile(current, journalPath);
    assertSameJournalFile(before, current, journalPath);
    assertSameJournalFile(opened, current, journalPath);
    if (opened.size > MAX_WORKFLOW_JOURNAL_BYTES) {
      throw new Error(
        `Workflow journal is too large: ${journalPath} (${opened.size} bytes, limit ${MAX_WORKFLOW_JOURNAL_BYTES})`,
      );
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function appendJournalLine(
  journalPath: string,
  entry: JournalEntry,
): Promise<void> {
  const guard = await guardJournalParents(journalPath, true);
  if (!guard) throw new Error(`Workflow journal directory is unavailable.`);
  let before: Stats | undefined;
  try {
    before = await fs.lstat(journalPath);
    assertSafeJournalFile(before, journalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const handle = await fs.open(
    journalPath,
    fsConstants.O_APPEND |
      fsConstants.O_WRONLY |
      (before ? 0 : fsConstants.O_CREAT | fsConstants.O_EXCL) |
      (process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW),
    0o600,
  );
  try {
    guard.assertUnchanged();
    const [opened, current] = await Promise.all([
      handle.stat(),
      fs.lstat(journalPath),
    ]);
    assertSafeJournalFile(opened, journalPath);
    assertSafeJournalFile(current, journalPath);
    if (before) assertSameJournalFile(before, current, journalPath);
    assertSameJournalFile(opened, current, journalPath);
    await handle.chmod(0o600);
    await handle.writeFile(Buffer.from(`${JSON.stringify(entry)}\n`, 'utf8'));
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readCommittedPrefix(
  journalPath: string,
  checkpoint: JournalCheckpoint,
): Promise<{ bytes: Buffer; committed: Buffer; replay: JournalReplay }> {
  validateCheckpoint(checkpoint);
  let bytes: Buffer;
  try {
    bytes = await readJournalBytes(journalPath);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'ENOENT' &&
      checkpoint.byteLength === 0
    ) {
      bytes = Buffer.alloc(0);
    } else {
      // Only the byteLength shortfall below is genuine truncation. Safety
      // rejections (unsafe path, parent changed) and I/O errors (EACCES) reach
      // here too, and this message ends up verbatim in the durable checkpoint
      // `error` and in the `/workflows` resumeBlockedReason — calling them
      // "truncated" tells the operator they lost data when the read was in
      // fact refused.
      throw new Error(
        `Workflow journal recovery failed: ${errorMessage(error)}`,
      );
    }
  }
  if (bytes.byteLength < checkpoint.byteLength) {
    throw new Error(
      `Workflow journal is truncated: expected ${checkpoint.byteLength} bytes, got ${bytes.byteLength}`,
    );
  }
  const committed = bytes.subarray(0, checkpoint.byteLength);
  const sha256 = createHash('sha256').update(committed).digest('hex');
  if (sha256 !== checkpoint.sha256) {
    throw new Error('Workflow journal checkpoint hash mismatch');
  }
  return {
    bytes,
    committed,
    replay: buildReplay(parseCommittedEntries(committed)),
  };
}

/**
 * Append-only JSONL journal for one workflow run. Reads tolerate a missing
 * file (fresh run); appends are fire-and-forget at the call site (the
 * orchestrator does not await them on the hot path — a journal write
 * failure must not fail the dispatch).
 */
export class WorkflowJournal {
  private tail: Promise<void> = Promise.resolve();
  private writeError?: string;
  private resumeCheckpoint?: JournalCheckpoint;

  constructor(readonly path: string) {}

  /** Load + parse all entries into replay maps. Empty maps if no file. */
  async load(checkpoint?: JournalCheckpoint): Promise<JournalReplay> {
    if (checkpoint) {
      const { replay } = await readCommittedPrefix(this.path, checkpoint);
      this.resumeCheckpoint = { ...checkpoint };
      return replay;
    }
    try {
      const entries = (await readJournalBytes(this.path))
        .toString('utf8')
        .split('\n')
        .flatMap((line) =>
          line.trim().length === 0
            ? []
            : parseLineTolerant<JournalEntry>(line.trim(), this.path),
        );
      return buildReplay(entries);
    } catch (e) {
      debugLogger.warn(`WorkflowJournal.load failed for ${this.path}: ${e}`);
      return { results: new Map(), started: new Map() };
    }
  }

  /** Append one entry. Rejects only on I/O error (callers `.catch`). */
  append(entry: JournalEntry): Promise<void> {
    const write = this.tail.then(async () => {
      await this.discardUncommittedSuffix();
      await appendJournalLine(this.path, entry);
    });
    this.tail = write.catch((error: unknown) => {
      this.writeError ??= errorMessage(error);
    });
    return write;
  }

  /** Flush all preceding appends and describe their durable file prefix. */
  flush(): Promise<JournalCheckpoint> {
    const checkpoint = this.tail.then(async (): Promise<JournalCheckpoint> => {
      let bytes = Buffer.alloc(0);
      let flushError: string | undefined;
      try {
        await this.discardUncommittedSuffix();
        bytes = await readJournalBytes(this.path);
      } catch (error) {
        flushError = errorMessage(error);
      }
      const error = this.writeError ?? flushError;
      return {
        version: JOURNAL_FORMAT_VERSION,
        keyVersion: JOURNAL_KEY_VERSION,
        byteLength: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        integrity: error ? ('failed' as const) : ('complete' as const),
        ...(error ? { error } : {}),
      };
    });
    this.tail = checkpoint.then(
      () => undefined,
      (error: unknown) => {
        this.writeError ??= errorMessage(error);
      },
    );
    return checkpoint;
  }

  private async discardUncommittedSuffix(): Promise<void> {
    const checkpoint = this.resumeCheckpoint;
    if (!checkpoint) return;
    const targetGuard = await guardJournalTarget(this.path);
    const { bytes, committed } = await readCommittedPrefix(
      this.path,
      checkpoint,
    );
    targetGuard.assertUnchanged();
    if (bytes.byteLength > checkpoint.byteLength) {
      const guard = await guardJournalParents(this.path, false);
      if (!guard) {
        throw new Error('Workflow journal directory is unavailable.');
      }
      await atomicWriteFile(this.path, committed, {
        noFollow: true,
        mode: 0o600,
        forceMode: true,
        assertCanCommit: () => {
          guard.assertUnchanged();
          targetGuard.assertUnchanged();
        },
      });
    }
    this.resumeCheckpoint = undefined;
  }
}
