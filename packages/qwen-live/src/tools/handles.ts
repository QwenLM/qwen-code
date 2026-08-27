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
  private readonly jobs = new Map<string, JobRecord>();
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
    return this.sessions.get(handle.trim());
  }

  listSessions(): ReadonlyMap<string, BackendHandle> {
    return this.sessions;
  }

  createJob(fields: {
    sessionHandle: string;
    backend: BackendHandle;
    jobRef?: string;
    task: string;
  }): JobRecord {
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
      this.jobsByRef.set(record.jobRef, record.jobHandle);
    }
    return record;
  }

  resolveJob(handle: string): JobRecord | undefined {
    return this.jobs.get(handle.trim());
  }

  /** Find the job a backend event's jobRef belongs to. */
  jobByRef(jobRef: string): JobRecord | undefined {
    const handle = this.jobsByRef.get(jobRef);
    return handle ? this.jobs.get(handle) : undefined;
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
