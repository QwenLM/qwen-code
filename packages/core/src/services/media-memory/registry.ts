/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';
import type { OmniModality } from '../../omni/recognition.js';
import { unescapeAnnotationName } from '../../omni/disclosure.js';
import type { MediaFileId, MediaFileVersionId } from './types.js';

/**
 * One session-scoped binding between a persistent memory identity and the
 * reference the model is allowed to see (M §5.2): recall rebinds a
 * persistent `fileVersionId` into the session registry and returns the
 * `resourceId`; the model passes that reference to media-policy tools, and
 * the harness resolves it back to a real locator at execution time. The
 * model-visible reference is the opaque handle for path-less media, or the
 * absolute path for a model-visible local file (see `formatResourcePathText`).
 */
export interface MediaResourceBinding {
  /** Opaque session handle. For a path-less source (tool/URL/recall media)
   * this is the ONLY identity the model sees; for a model-visible LOCAL
   * source the annotation surfaces `fileRef` (the absolute path) instead,
   * and recall reverses that path back to this handle (see
   * `formatResourcePathText` / `resolveMediaReference`). */
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
 * — a resourceId is only meaningful inside the session that minted it, so a
 * handle can never be replayed across sessions. (A model-visible local
 * source is additionally addressable by its absolute path, which recall
 * reverses back to the session handle via `resolveByFileRef`.)
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
    if (existing) {
      // Re-delivery of a version already bound this session (idempotent per
      // version). Refresh its position so `byVersionId` iteration order is
      // DELIVERY order, not first-mint order: after bytes at a path change
      // and later revert to a previously-seen version (git checkout, undo, a
      // regenerator reproducing old bytes), that version is re-delivered and
      // must become the one `resolveByFileRef` returns for the path — it is
      // what the model is now looking at. A Map preserves insertion order and
      // does not move a key on overwrite, so delete-then-set to move it last.
      this.byVersionId.delete(input.fileVersionId);
      this.byVersionId.set(input.fileVersionId, existing);
      return existing;
    }
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
   * the LATEST-DELIVERED binding wins: a path names "the file at this path",
   * and the most recently delivered version is the one the model is
   * currently looking at — including after a revert to previously-seen bytes,
   * because `bind` refreshes a re-delivered version's position. A path cannot
   * name an older version — that ambiguity is the price of showing the path
   * instead of the version-specific handle, and two path annotations for two
   * versions in ONE request collapse to the latest. */
  resolveByFileRef(fileRef: string): MediaResourceBinding | undefined {
    let latest: MediaResourceBinding | undefined;
    // `bind` keeps byVersionId in delivery order (re-delivery moves a version
    // last), so the last match is the most recently delivered.
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

/**
 * Resolve one model-supplied media reference to its session binding, or
 * undefined when it matches nothing this session issued. Accepts either
 * annotation form the model may echo back (M §5.2):
 *
 *  - the opaque `media-<n>-<hex>` HANDLE (path-less media), matched verbatim;
 *  - the absolute PATH shown for a model-visible local file. The model sees
 *    that path in its ESCAPED annotation form (`escapeAnnotationName` doubles
 *    every `\` and escapes `：`), so a reference copied verbatim off a native
 *    Windows path or a `：`-bearing name arrives escaped. Try the unescaped
 *    form first so it matches the raw `fileRef` the registry stores, then the
 *    string as given (covers a model that already unescaped it).
 *
 * Shared by the active recall gate (`resolveBindings`) and the media-policy
 * call gate so both surfaces accept whichever form the annotation displayed.
 */
export function resolveMediaReference(
  registry: Pick<MediaResourceRegistry, 'resolve' | 'resolveByFileRef'>,
  reference: string,
): MediaResourceBinding | undefined {
  return (
    registry.resolve(reference) ??
    registry.resolveByFileRef(unescapeAnnotationName(reference)) ??
    registry.resolveByFileRef(reference)
  );
}
