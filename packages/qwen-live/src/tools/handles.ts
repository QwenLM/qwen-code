/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Short-handle registries. The realtime model refers to sessions as
 * `session_N`, jobs as `job_N`, and screen-capture assets as `asset_N` —
 * short, speakable, and hard to mistranscribe. These maps own the
 * bidirectional translation to the real identities.
 */

import type { BackendHandle } from '../adaptor/types.js';

export interface JobRecord {
  jobHandle: string;
  sessionHandle: string;
  backend: BackendHandle;
  /** Adaptor-side correlation id (qwen serve: promptId). */
  jobRef?: string;
  state: 'accepted' | 'running' | 'done' | 'failed' | 'cancelled';
  task: string;
  createdAt: number;
}

export interface AssetRecord {
  assetHandle: string;
  path: string;
  mimeType: string;
  createdAt: number;
}

const MAX_ASSETS = 32;

export class HandleRegistry {
  private readonly sessions = new Map<string, BackendHandle>();
  private readonly sessionsByBackendId = new Map<string, string>();
  /** Sessions whose backend reported closure — handles no longer resolve. */
  private readonly closedSessions = new Set<string>();
  private readonly jobs = new Map<string, JobRecord>();
  /**
   * Keyed by `${backend.adaptor}:${jobRef}` — jobRefs are adaptor-local
   * (qwen serve mints prompt UUIDs, an ACP adaptor counts turn-1, turn-2),
   * so the owning adaptor scopes the key or two backends collide.
   */
  private readonly jobsByRef = new Map<string, string>();
  private readonly assets = new Map<string, AssetRecord>();
  private sessionSeq = 0;
  private jobSeq = 0;
  private assetSeq = 0;

  /** Register (or return the existing handle for) a backend session. */
  session(backend: BackendHandle): string {
    const key = `${backend.adaptor}:${backend.id}`;
    const existing = this.sessionsByBackendId.get(key);
    if (existing) return existing;
    const handle = `session_${++this.sessionSeq}`;
    this.sessions.set(handle, backend);
    this.sessionsByBackendId.set(key, handle);
    return handle;
  }

  resolveSession(handle: string): BackendHandle | undefined {
    const key = handle.trim();
    if (this.closedSessions.has(key)) return undefined;
    return this.sessions.get(key);
  }

  /** Mark a session closed: its handle stops resolving from now on. */
  closeSession(handle: string): void {
    const normalized = handle.trim();
    this.closedSessions.add(normalized);
    // Clear the reverse mapping so a respawned agent reusing the same
    // backend session id gets a fresh handle, not the poisoned closed one.
    const backend = this.sessions.get(normalized);
    if (backend) {
      this.sessionsByBackendId.delete(`${backend.adaptor}:${backend.id}`);
    }
  }

  /**
   * Register a new job. Idempotent by (backend, jobRef): a jobRef already
   * registered for that backend means the backend attributed the prompt to
   * that existing turn (e.g. a steer that joined it), so the existing record
   * is returned instead of minting a second job that would orphan the first
   * in 'running'.
   */
  createJob(fields: {
    sessionHandle: string;
    backend: BackendHandle;
    jobRef?: string;
    task: string;
  }): JobRecord {
    if (fields.jobRef !== undefined) {
      const existing = this.jobByRef(fields.backend, fields.jobRef);
      if (existing) return existing;
    }
    const record: JobRecord = {
      jobHandle: `job_${++this.jobSeq}`,
      sessionHandle: fields.sessionHandle,
      backend: fields.backend,
      ...(fields.jobRef !== undefined ? { jobRef: fields.jobRef } : {}),
      state: 'accepted',
      task: fields.task,
      createdAt: Date.now(),
    };
    this.jobs.set(record.jobHandle, record);
    if (record.jobRef !== undefined) {
      this.jobsByRef.set(
        `${fields.backend.adaptor}:${record.jobRef}`,
        record.jobHandle,
      );
    }
    return record;
  }

  resolveJob(handle: string): JobRecord | undefined {
    return this.jobs.get(handle.trim());
  }

  /** Find the job a backend event's jobRef (on its backend) belongs to. */
  jobByRef(backend: BackendHandle, jobRef: string): JobRecord | undefined {
    const handle = this.jobsByRef.get(`${backend.adaptor}:${jobRef}`);
    return handle ? this.jobs.get(handle) : undefined;
  }

  /**
   * Reconcile a session's non-terminal jobs against reality: the backend
   * reports idle, so any 'accepted'/'running' record left over from a
   * missed terminal event (emitted while no pump was subscribed — pumps
   * are per-call and aborted at call end) transitions to 'done'. Gated on
   * the caller's isBusy check so a genuinely busy backend is never
   * touched.
   */
  reconcileIdleSession(sessionHandle: string): void {
    for (const job of this.jobs.values()) {
      if (job.sessionHandle !== sessionHandle) continue;
      if (job.state === 'done' || job.state === 'failed') continue;
      if (job.state === 'cancelled') continue;
      job.state = 'done';
    }
  }

  /** The most recent non-terminal job for a session, if any. */
  activeJobForSession(sessionHandle: string): JobRecord | undefined {
    let candidate: JobRecord | undefined;
    for (const job of this.jobs.values()) {
      if (job.sessionHandle !== sessionHandle) continue;
      if (job.state === 'done' || job.state === 'failed') continue;
      if (job.state === 'cancelled') continue;
      if (!candidate || job.createdAt > candidate.createdAt) candidate = job;
    }
    return candidate;
  }

  registerAsset(fields: { path: string; mimeType: string }): AssetRecord {
    const record: AssetRecord = {
      assetHandle: `asset_${++this.assetSeq}`,
      path: fields.path,
      mimeType: fields.mimeType,
      createdAt: Date.now(),
    };
    this.assets.set(record.assetHandle, record);
    // Bounded: assets reference temp files with short TTLs; keep the newest.
    while (this.assets.size > MAX_ASSETS) {
      const oldest = this.assets.keys().next().value;
      if (oldest === undefined) break;
      this.assets.delete(oldest);
    }
    return record;
  }

  resolveAsset(handle: string): AssetRecord | undefined {
    return this.assets.get(handle.trim());
  }
}
