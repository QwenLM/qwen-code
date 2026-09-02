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
   * Consumed when a tool call resolves resourceId → inputPath. For a
   * model-visible LOCAL source the annotation surfaces this path in place
   * of the handle (see `formatResourcePathText`); for path-less sources
   * (tool/URL/recall media) it is an internal object-store path and stays
   * off the model-visible payload (M §5.2/§15). */
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

  /** Look up a binding by its harness-side locator. Lets collection paths
   * that only hold a resolved `inputPath` (a gated model call, where the
   * gate already turned the handle back into a path) recover the memory
   * identity without re-hashing the file, and lets recall reverse a
   * path-form annotation back to its handle.
   *
   * When the same locator has been bound more than once this session (the
   * same file re-read after its bytes changed, minting a distinct version),
   * the LATEST binding wins: a path names "the file at this path", and the
   * most recently delivered version is the one the model is currently
   * looking at. A path cannot name an older version — that ambiguity is the
   * price of showing the path instead of the version-specific handle, and
   * two path annotations for two versions in ONE request collapse to the
   * latest. */
  resolveByFileRef(fileRef: string): MediaResourceBinding | undefined {
    let latest: MediaResourceBinding | undefined;
    // Insertion order === mint order, so the last match is the newest.
    for (const binding of this.byVersionId.values()) {
      if (binding.fileRef === fileRef) latest = binding;
    }
    return latest;
  }

  /** Every locator this session currently has a handle for. GC treats
   * these as roots alongside the memory snapshot: a resource delivered
   * THIS turn may be bound here before its memory commit lands, and the
   * sweep must not win that race. */
  activeFileRefs(): string[] {
    const refs = new Set<string>();
    for (const binding of this.byVersionId.values()) {
      refs.add(binding.fileRef);
    }
    return [...refs];
  }
}

/** Structural view of the Config accessor (same pattern as
 * `OmniMemoryConfigView`): a config without the accessor — stub configs,
 * embedders skipping initialize — reads as "no session registry". */
export interface OmniMediaRegistryView {
  getOmniMediaResourceRegistry?: () => MediaResourceRegistry;
}
