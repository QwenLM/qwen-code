/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';
import type { OmniModality } from '../../omni/recognition.js';
import type { MediaFileId, MediaFileVersionId } from './types.js';

/**
 * One session-scoped binding between a persistent memory identity and the
 * opaque handle the model is allowed to see (M §5.2): recall rebinds a
 * persistent `fileVersionId` into the session registry and returns the
 * `resourceId`; the model passes that handle to media-policy tools, and
 * the harness resolves it back to a real locator at execution time.
 */
export interface MediaResourceBinding {
  /** Opaque session handle — the ONLY identity the model sees. */
  resourceId: string;
  fileId: MediaFileId;
  fileVersionId: MediaFileVersionId;
  rootFileId: MediaFileId;
  /** Harness-side locator (absolute local path or promoted object path).
   * Consumed when a tool call resolves resourceId → inputPath; NEVER
   * included in a model-visible payload (M §5.2/§15). */
  fileRef: string;
  mediaType: OmniModality;
}

/**
 * Session-lifetime bidirectional binder: fileVersionId ↔ resourceId.
 * One instance per CLI session (hung off Config); bindings never persist
 * — a resourceId is only meaningful inside the session that minted it,
 * which is what keeps recall payloads free of stable path-like handles.
 *
 * Binding is idempotent per version: re-recalling the same derivative in
 * one session returns the handle already issued, so the model can
 * correlate results across recall calls.
 */
export class MediaResourceRegistry {
  private readonly byResourceId = new Map<string, MediaResourceBinding>();
  private readonly byVersionId = new Map<
    MediaFileVersionId,
    MediaResourceBinding
  >();
  private counter = 0;

  /** Bind (or return the existing binding of) one file version. */
  bind(input: Omit<MediaResourceBinding, 'resourceId'>): MediaResourceBinding {
    const existing = this.byVersionId.get(input.fileVersionId);
    if (existing) return existing;
    // Sequential prefix keeps handles readable in transcripts; the random
    // suffix stops the model from guessing handles it was never given.
    const resourceId = `media-${++this.counter}-${randomBytes(4).toString('hex')}`;
    const binding: MediaResourceBinding = { resourceId, ...input };
    this.byResourceId.set(resourceId, binding);
    this.byVersionId.set(input.fileVersionId, binding);
    return binding;
  }

  /** Resolve a model-supplied handle. Undefined = never issued in this
   * session (an unauthorized or fabricated id — callers must reject). */
  resolve(resourceId: string): MediaResourceBinding | undefined {
    return this.byResourceId.get(resourceId);
  }

  /** Look up the binding already issued for a version, if any. */
  resolveVersion(
    fileVersionId: MediaFileVersionId,
  ): MediaResourceBinding | undefined {
    return this.byVersionId.get(fileVersionId);
  }
}
