/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface JournalRecord {
  seq: number;
  kind: 'agent';
  promptHash: string;
  optsHash: string;
  result: unknown; // the agent envelope { kind: 'text'|'structured'|'null', ... }
  tokens: number;
  error?: string;
}

interface RunFile {
  meta: unknown;
  scriptHash: string;
  args: unknown;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt: string | null;
  tokensSpent: number;
}

/** Sort object keys recursively so the hash is order-independent. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** SHA-256 (hex) of canonicalized JSON. */
export function canonicalHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

/**
 * Per-run journal (design: "journal.ts"). JSONL at `<dir>/journal.jsonl`, run
 * metadata at `<dir>/run.json`. On resume, replays the longest prefix whose
 * seq + prompt/opts hashes match; the first divergence LATCHES so nothing after
 * it is served from cache even if it happens to match.
 */
export class Journal {
  private seqCounter = 0;
  private diverged = false;
  private readonly cached = new Map<number, JournalRecord>();
  private runFile: RunFile;

  private constructor(
    private readonly dir: string,
    init: { meta: unknown; scriptHash: string; args: unknown },
  ) {
    this.runFile = {
      meta: init.meta,
      scriptHash: init.scriptHash,
      args: init.args,
      status: 'running',
      startedAt: new Date(0).toISOString(),
      finishedAt: null,
      tokensSpent: 0,
    };
  }

  static async open(
    dir: string,
    init: {
      meta: unknown;
      scriptHash: string;
      args: unknown;
      resumeDir?: string;
    },
  ): Promise<Journal> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const j = new Journal(dir, init);
    // startedAt uses a real wall clock host-side (NOT inside the sandbox).
    j.runFile.startedAt = new Date().toISOString();
    if (init.resumeDir) {
      try {
        const raw = await readFile(
          join(init.resumeDir, 'journal.jsonl'),
          'utf8',
        );
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue;
          const rec = JSON.parse(line) as JournalRecord;
          j.cached.set(rec.seq, rec);
        }
      } catch {
        // No prior journal → nothing cached; every call runs live.
      }
    }
    await j.persistRun();
    return j;
  }

  /** Synchronous, monotonic seq assignment at agent() entry (deterministic). */
  nextSeq(): number {
    return this.seqCounter++;
  }

  lookup(
    seq: number,
    kind: 'agent',
    promptHash: string,
    optsHash: string,
  ): JournalRecord | undefined {
    if (this.diverged) return undefined;
    const rec = this.cached.get(seq);
    if (
      rec &&
      rec.kind === kind &&
      rec.promptHash === promptHash &&
      rec.optsHash === optsHash
    ) {
      // Re-journal the replayed record so the resumed run stays self-contained.
      // Fire-and-forget: a write failure here (ENOSPC/permissions) must not
      // surface as an unhandled promise rejection and crash the process.
      void this.append(rec).catch(() => {});
      return rec;
    }
    this.diverged = true;
    return undefined;
  }

  async append(rec: JournalRecord): Promise<void> {
    await appendFile(
      join(this.dir, 'journal.jsonl'),
      JSON.stringify(rec) + '\n',
      {
        mode: 0o600,
      },
    );
  }

  async setStatus(
    status: RunFile['status'],
    tokensSpent: number,
  ): Promise<void> {
    this.runFile.status = status;
    this.runFile.tokensSpent = tokensSpent;
    this.runFile.finishedAt =
      status === 'running' ? null : new Date().toISOString();
    await this.persistRun();
  }

  log(_message: string): void {
    // Best-effort sink; intentionally a no-op here (surfaced via the tool's
    // background-task activity in Task 11). Never throws into the sandbox.
  }

  phase(_title: string, _index: number): void {
    // Handled by the caller's onPhase; no-op journal side (never throws).
  }

  private async persistRun(): Promise<void> {
    await writeFile(
      join(this.dir, 'run.json'),
      JSON.stringify(this.runFile, null, 2),
      {
        mode: 0o600,
      },
    );
  }
}
