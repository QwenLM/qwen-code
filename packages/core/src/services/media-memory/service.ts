/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { createDebugLogger } from '../../utils/debugLogger.js';
import type { MediaProbeResult } from '../../omni/ffmpeg.js';
import type { OmniModality } from '../../omni/recognition.js';
import { MediaMemoryStore } from './store.js';
import type {
  FileRecognizedCommit,
  FileRecognizedEvent,
  MediaChannel,
  MediaCoverage,
  MediaExecutionOrigin,
  MediaFileId,
  MediaFileRecord,
  MediaFileVersionId,
  MediaFileVersionRecord,
  MediaMemoryEntryId,
  MediaMemorySnapshot,
  MediaPolicyExecutionRecord,
  MediaVersionRecognition,
  NormalizedPolicyOutput,
  PolicyExecutionId,
} from './types.js';

const debugLogger = createDebugLogger('omni:memory');

/** Default bound for inline text persisted on an entry (M §9,
 * `omni.memory.collection.maxInlineTextBytes`). Oversized text is
 * truncated on the entry — the full content stays reachable through the
 * artifactRef (transcripts are promoted objects). */
export const DEFAULT_MAX_INLINE_TEXT_BYTES = 65536;

/** Recognition provenance constants for the S4 detector (content sniff +
 * ffprobe). Bump when the recognition pipeline changes meaningfully. */
export const MEDIA_DETECTOR_VERSION = 'omni-sniff-ffprobe/1';

function hashId(prefix: string, material: string): string {
  return (
    prefix + createHash('sha256').update(material).digest('hex').slice(0, 24)
  );
}

/** fileId is deterministic in the fileRef: the same logical file always
 * resolves to the same identity, which makes FileRecognized an upsert. */
function fileIdFor(fileRef: string): MediaFileId {
  return hashId('f', fileRef);
}

/**
 * fileId of a POLICY DERIVATIVE, keyed by (root, object path).
 *
 * Derivatives live in the content-addressed object store, so two roots
 * that derive byte-identical output land on the same object path. Keying
 * the graph node on the path alone would make them ONE File node whose
 * `rootFileId` belongs to whichever root created it first — leaking one
 * file's lineage into another's (M §11.2: 不能把一个文件的权限或
 * provenance 泄漏给另一个文件) and putting the node outside the second
 * root's bounded traversal (M §8).
 *
 * Folding the root in gives each root its own cheap metadata rows while
 * the BYTES stay deduplicated by the object store — the reuse M §11.2
 * actually sanctions ("受管文件的物理存储块").
 */
function derivedFileIdFor(
  objectPath: string,
  rootFileId: MediaFileId,
): MediaFileId {
  return hashId('f', `${rootFileId}|${objectPath}`);
}

/** versionId is deterministic in (fileId, sha256): re-recognizing the
 * same content is a no-op, and two files sharing bytes keep two distinct
 * version records (M §11 — same hash never merges Files). */
function versionIdFor(fileId: MediaFileId, sha256: string): MediaFileVersionId {
  return hashId('v', `${fileId}|${sha256}`);
}

/** One media deliverable of a successful policy execution, as known at
 * the orchestrator's success point (validated + promoted to objects/). */
export interface PolicyMediaOutputInput {
  kind: 'media';
  /** Promoted object path (fileRef of the derivative). */
  objectPath: string;
  sha256: string;
  mediaType: OmniModality;
  metadata: MediaProbeResult;
  sizeBytes: number;
  mimeType: string;
  role?: string;
  disclosure?: string;
}

/** One non-media text artifact (transcript protocol) of a successful
 * policy execution. `text` was validated as bounded UTF-8 by the
 * orchestrator; the promoted object retains the full content. */
export interface PolicyTextOutputInput {
  kind: 'text';
  objectPath: string;
  sha256: string;
  mimeType: string;
  text: string;
  sizeBytes: number;
  role?: string;
  disclosure?: string;
}

export type PolicyOutputInput = PolicyMediaOutputInput | PolicyTextOutputInput;

/** Memory-side identity of a resource flowing through the policy
 * pipeline; returned by every commit and threaded on work items. */
export interface MediaMemoryBinding {
  fileId: MediaFileId;
  fileVersionId: MediaFileVersionId;
  rootFileId: MediaFileId;
}

/** Complete payload of one OmniPolicySucceeded commit (M §6.4): the
 * execution plus every validated output, committed atomically. */
export interface PolicySucceededInput {
  invocationId: string;
  source: MediaMemoryBinding;
  executionOrigin: MediaExecutionOrigin;
  toolName: string;
  toolVersion?: string;
  /** Effective arguments the tool ran with, reserved runtime keys
   * (inputPath/outputDir/resourceId) excluded by the caller. */
  finalArguments: Record<string, unknown>;
  /** Content-identity hash of the resolved policy/tool configuration
   * (the degradation-cache fingerprint at the S4 boundary). */
  omniConfigHash: string;
  startedAt: string;
  completedAt: string;
  outputs: PolicyOutputInput[];
}

/** One recorded output of a reusable execution: where its bytes live and
 * the provenance the reusing caller must reproduce. */
export interface ReusableOutputRecord {
  kind: 'media' | 'text';
  sha256: string;
  /** Object-store path recorded for the derivative. Absent for text
   * outputs (no version node); reconstruct it from `sha256`. */
  objectPath?: string;
  mimeType: string;
  sizeBytes: number;
  role?: string;
  disclosure?: string;
}

/** Outputs of a prior execution eligible for reuse (M §11.3). */
export interface ReusableExecutionOutputs {
  /** The original execution — recorded as `reusedExecutionId` when the
   * reusing file commits its own execution. */
  executionId: PolicyExecutionId;
  outputs: ReusableOutputRecord[];
}

export interface PolicySucceededCommit {
  executionId: PolicyExecutionId;
  /** Bindings for derived media outputs, keyed by output sha256, so the
   * orchestrator can thread memory identity onto derived work items. */
  mediaBindings: Map<string, MediaMemoryBinding>;
  /** False when the execution was already recorded (content-identity
   * replay: degradation cache hit, same-invocation retry). */
  created: boolean;
}

/** Conservative v1 channel derivation by modality/role. */
function channelsFor(
  mediaType: OmniModality | undefined,
  role: string | undefined,
): MediaChannel[] {
  if (role === 'transcript') return ['speech_text'];
  if (role === 'ocr') return ['onscreen_text'];
  switch (mediaType) {
    case 'image':
      return ['visual'];
    case 'audio':
      return ['acoustic'];
    case 'video':
      return ['visual', 'acoustic'];
    default:
      return [];
  }
}

/** Conservative v1 coverage: sampled for keyframes, partial for clips,
 * complete (whole-version, degraded fidelity disclosed separately) for
 * everything else. Honesty over precision — never overclaim. */
function coverageFor(role: string | undefined): MediaCoverage {
  if (role === 'keyframe') return { mode: 'sampled', scope: {} };
  if (role === 'clip') return { mode: 'partial', scope: {} };
  return { mode: 'complete', scope: {} };
}

/** Truncate UTF-8 text to a byte budget without splitting a code point. */
export function truncateUtf8(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).byteLength <= maxBytes) return text;
  let result = '';
  let bytes = 0;
  for (const ch of text) {
    const chBytes = encoder.encode(ch).byteLength;
    if (bytes + chBytes > maxBytes) break;
    result += ch;
    bytes += chBytes;
  }
  return result;
}

/**
 * The single write facade of multimodal media memory (M §14): the omni
 * harness calls the two collection triggers below; nothing else in the
 * system writes memory. The Agent side is read-only (recall — Stage B).
 *
 * Failure stance: memory is an enhancement, not the delivery path. Every
 * public method catches its own persistence errors, logs, and reports
 * `undefined` — a failed commit must never break a delivery. Within one
 * commit, the store's transact gives all-or-nothing semantics.
 */
export class MediaMemoryService {
  private readonly store: MediaMemoryStore;
  private readonly maxInlineTextBytes: number;

  constructor(omniRootDir: string, options?: { maxInlineTextBytes?: number }) {
    this.store = new MediaMemoryStore(omniRootDir);
    this.maxInlineTextBytes =
      options?.maxInlineTextBytes ?? DEFAULT_MAX_INLINE_TEXT_BYTES;
  }

  /**
   * Collection trigger 1 — FileRecognized (M §6.1). Preconditions are the
   * caller's contract: mediaType decided, FULL sha256 computed, metadata
   * and a definite probeStatus in hand. Idempotent upsert: same fileRef +
   * same content is a no-op; new content at a known fileRef creates a new
   * immutable version and moves CURRENT_VERSION.
   *
   * Returns undefined when persistence failed (logged, never thrown).
   */
  async recordFileRecognized(
    event: FileRecognizedEvent,
  ): Promise<FileRecognizedCommit | undefined> {
    try {
      return await this.store.transact(undefined, (snapshot) => {
        const commit = upsertRecognizedFile(snapshot, event, this.now());
        return { result: commit, changed: commit.changed };
      });
    } catch (err) {
      debugLogger.debug(
        `recordFileRecognized failed for ${event.source.locator}: ` +
          `${err instanceof Error ? err.message : err}`,
      );
      return undefined;
    }
  }

  /**
   * Collection trigger 2 — OmniPolicySucceeded (M §6.4). One atomic
   * transaction commits the execution record, a file+version per derived
   * media output (DERIVED_FROM / PRODUCED_BY edges), and one entry per
   * output (HAS_OUTPUT edges). The executionId is deterministic in the
   * content-identity reuse key (source sha256 ⊕ omniConfigHash, M §11),
   * so degradation-cache hits and invocation replays converge on the
   * same execution node instead of duplicating it.
   *
   * Returns undefined when persistence failed (logged, never thrown) —
   * the delivery proceeds regardless.
   */
  async commitPolicySucceeded(
    input: PolicySucceededInput,
  ): Promise<PolicySucceededCommit | undefined> {
    try {
      return await this.store.transact(undefined, (snapshot) => {
        const result = commitExecution(
          snapshot,
          input,
          this.maxInlineTextBytes,
          this.now(),
        );
        return { result: result.commit, changed: result.changed };
      });
    } catch (err) {
      debugLogger.debug(
        `commitPolicySucceeded failed for ${input.toolName} ` +
          `(invocation ${input.invocationId}): ` +
          `${err instanceof Error ? err.message : err}`,
      );
      return undefined;
    }
  }

  /**
   * Recorded outputs of a prior execution that already performed THIS
   * computation on THESE bytes (content-identity reuse key, M §11.3) —
   * the read side of «同文件同 settings 二次触发同一 policy：直接复用，
   * 无重复执行». Covers every output shape, so multi-output tools and text
   * products (transcripts) are reusable too, unlike the S4 degradation
   * cache which maps one input to a single media derivative.
   *
   * Returns locators and recorded provenance only: the caller must verify
   * the bytes still exist and still hash to `sha256` before reusing them
   * (memory.json is project-local and hand-editable — the same stance the
   * degradation-cache hit path takes). Undefined when nothing matches or
   * the store is unreadable (logged, never thrown).
   */
  async findReusableOutputs(
    sourceSha256: string,
    omniConfigHash: string,
  ): Promise<ReusableExecutionOutputs | undefined> {
    try {
      return await this.store.read(undefined, (snapshot) => {
        // No self to exclude: this is a pre-execution lookup.
        const match = findReusableExecution(
          snapshot,
          `${sourceSha256}|${omniConfigHash}`,
          '',
        );
        if (!match) return undefined;
        const outputs: ReusableOutputRecord[] = [];
        for (const entryId of match.outputRefs) {
          const entry = snapshot.entries[entryId];
          if (!entry?.artifactRef) return undefined; // incomplete — no reuse
          const managedId = entry.artifactRef.managedId;
          const sha256 = managedId?.startsWith('sha256/')
            ? managedId.slice('sha256/'.length)
            : undefined;
          if (sha256 === undefined) return undefined;
          const version = entry.derivedVersionId
            ? snapshot.versions[entry.derivedVersionId]
            : undefined;
          // Media outputs resolve their object through the derived
          // version's file record; a text output has no version node, so
          // the caller re-derives its path from the content hash.
          const objectPath = version
            ? snapshot.files[version.fileId]?.fileRef
            : undefined;
          outputs.push({
            kind: entry.kind === 'derived_media' ? 'media' : 'text',
            sha256,
            ...(objectPath !== undefined ? { objectPath } : {}),
            mimeType: entry.artifactRef.mimeType,
            sizeBytes: entry.artifactRef.sizeBytes,
            ...(entry.role !== undefined ? { role: entry.role } : {}),
            ...(entry.disclosure !== undefined
              ? { disclosure: entry.disclosure }
              : {}),
          });
        }
        if (outputs.length === 0) return undefined;
        return { executionId: match.executionId, outputs };
      });
    } catch (err) {
      debugLogger.debug(
        `findReusableOutputs failed: ${err instanceof Error ? err.message : err}`,
      );
      return undefined;
    }
  }

  /**
   * The `memory.*` fixed-policy condition namespace (policy design
   * §4.1/4.4): the set of output ROLES recorded anywhere in the
   * subgraph rooted at the binding's version — the version itself plus
   * every version derived from it (DERIVED_FROM child edges), bounded to
   * the binding's root graph. This is what lets a `when` condition ask
   * "does memory already hold a transcript/OCR/caption for this file"
   * before deciding to run a policy — e.g. the §4.1 chain parents the
   * transcript entry to the EXTRACTED-AUDIO version, a child of the
   * video version being matched, so a same-version-only lookup would
   * never see it.
   *
   * Returns an EMPTY set when the version is unknown (nothing recorded
   * yet — a determinate "no roles"), and undefined only when the store
   * itself is unreadable (the caller maps that to condition
   * `unavailable`, never silently false). Persistence errors are logged,
   * never thrown (same failure stance as the rest of the facade).
   */
  async collectVersionOutputRoles(
    binding: MediaMemoryBinding,
  ): Promise<Set<string> | undefined> {
    try {
      return await this.store.read(undefined, (snapshot) => {
        const start = snapshot.versions[binding.fileVersionId];
        if (!start) return new Set<string>();
        // Iterative DERIVED_FROM walk, root-bounded (M §8: a version
        // filed under another root is never followed).
        const roles = new Set<string>();
        const visited = new Set<string>();
        const queue: string[] = [start.fileVersionId];
        while (queue.length > 0) {
          const versionId = queue.shift() as string;
          if (visited.has(versionId)) continue;
          visited.add(versionId);
          const version = snapshot.versions[versionId];
          if (!version) continue;
          const file = snapshot.files[version.fileId];
          if (!file || file.rootFileId !== binding.rootFileId) continue;
          for (const entry of Object.values(snapshot.entries)) {
            if (entry.parentVersionId === versionId && entry.role) {
              roles.add(entry.role);
            }
          }
          for (const child of Object.values(snapshot.versions)) {
            if (child.parentVersionId === versionId) {
              queue.push(child.fileVersionId);
            }
          }
        }
        return roles;
      });
    } catch (err) {
      debugLogger.debug(
        `collectVersionOutputRoles failed: ${err instanceof Error ? err.message : err}`,
      );
      return undefined;
    }
  }

  /**
   * Read-side lookup by LOCATOR, for the harness only (design M §9.2.1:
   * path/hash lookup is a harness capability; the model is confined to
   * session handles). Returns the CURRENT version of the File recorded at
   * this locator, whether or not the bytes are still on disk — which is
   * the point: it lets a remembered-but-missing file be re-anchored into a
   * session so its memory stays reachable.
   */
  async findBindingByFileRef(fileRef: string): Promise<
    | {
        binding: MediaMemoryBinding;
        mediaType: OmniModality;
        sha256: string;
      }
    | undefined
  > {
    try {
      return await this.store.read(undefined, (snapshot) => {
        for (const file of Object.values(snapshot.files)) {
          if (file.fileRef !== fileRef) continue;
          const version = snapshot.versions[file.currentVersionId];
          if (!version) return undefined;
          return {
            binding: {
              fileId: file.fileId,
              fileVersionId: version.fileVersionId,
              rootFileId: file.rootFileId,
            },
            mediaType: version.mediaType,
            sha256: version.sha256,
          };
        }
        return undefined;
      });
    } catch (err) {
      debugLogger.debug(
        `findBindingByFileRef failed: ${err instanceof Error ? err.message : err}`,
      );
      return undefined;
    }
  }

  /**
   * The GC root set (storage design §6.2): every object hash any memory
   * record still references. Three distinct reference kinds exist and ALL
   * count — `entries[].artifactRef.managedId` (policy outputs),
   * managed-protocol `versions[].source.locator` (tool media anchor
   * their file identity in the object store), and versions of files
   * whose `fileRef` points INTO the object store while their source
   * keeps a different protocol (URL media: `source.locator` is the
   * original URL, but the staging download is deleted the turn it
   * lands, so the store copy named by the file's `fileRef` is the only
   * persistent bytes). The last kind is rooted by content hash: each
   * such version's bytes live in the store under its own sha256.
   *
   * Returns null when the store exists but cannot be read — the caller
   * must treat that as "roots unknown" and delete NOTHING (fail-closed:
   * an unreadable ledger must never read as an empty one). A store that
   * has never been written returns an empty set: nothing was ever
   * recorded, so nothing is referenced.
   */
  async collectManagedRefs(): Promise<Set<string> | null> {
    const UNREADABLE = null;
    // The store copy lives under `<omniRoot>/objects/` — matching on the
    // objects prefix (not exact equality with objectPathFor) keeps this
    // robust to extension differences.
    const objectsPrefix = this.store.omniObjectsPrefix();
    try {
      return await this.store.read<Set<string> | null>(
        UNREADABLE,
        (snapshot) => {
          const refs = new Set<string>();
          const add = (locator: string | undefined) => {
            if (locator?.startsWith('sha256/')) {
              refs.add(locator.slice('sha256/'.length));
            }
          };
          for (const entry of Object.values(snapshot.entries)) {
            if (entry.artifactRef?.storage === 'managed') {
              add(entry.artifactRef.managedId);
            }
          }
          for (const version of Object.values(snapshot.versions)) {
            if (version.source.protocol === 'managed') {
              add(version.source.locator);
            }
            // A file anchored in the object store (URL/tool media whose
            // staging copy is gone) roots every ledger-vouched version's
            // bytes by content hash.
            const file = snapshot.files[version.fileId];
            if (file?.fileRef.startsWith(objectsPrefix)) {
              refs.add(version.sha256);
            }
          }
          return refs;
        },
      );
    } catch (err) {
      debugLogger.debug(
        `collectManagedRefs failed: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  }

  /**
   * Read-side lookup for callers that hold bytes but no identity (the
   * reactive degradation ladder re-recognizes a stored object without
   * knowing which memory version it is). Returns the binding of the
   * newest version whose content hash matches, or undefined when memory
   * has never seen the content (or the store is unreadable — logged,
   * never thrown).
   */
  async findBindingBySha256(
    sha256: string,
  ): Promise<MediaMemoryBinding | undefined> {
    try {
      return await this.store.read(undefined, (snapshot) => {
        let found: { binding: MediaMemoryBinding; createdAt: string } | null =
          null;
        for (const version of Object.values(snapshot.versions)) {
          if (version.sha256 !== sha256) continue;
          const file = snapshot.files[version.fileId];
          if (!file) continue;
          if (found && found.createdAt >= version.createdAt) continue;
          found = {
            binding: {
              fileId: version.fileId,
              fileVersionId: version.fileVersionId,
              rootFileId: file.rootFileId,
            },
            createdAt: version.createdAt,
          };
        }
        return found?.binding;
      });
    } catch (err) {
      debugLogger.debug(
        `findBindingBySha256 failed: ${err instanceof Error ? err.message : err}`,
      );
      return undefined;
    }
  }

  /** Injectable for tests via subclassing; records are stamped once per
   * commit so all records of a transaction share one timestamp. */
  protected now(): string {
    return new Date().toISOString();
  }
}

/** Shared by both triggers: upsert the (file, version) pair for one
 * recognized content state and move CURRENT_VERSION onto it. */
function upsertRecognizedFile(
  snapshot: MediaMemorySnapshot,
  event: FileRecognizedEvent,
  now: string,
): FileRecognizedCommit & { changed: boolean } {
  // Policy derivatives are identified per root (see derivedFileIdFor);
  // user/tool files by their locator alone.
  const fileId =
    event.origin === 'policy' && event.rootFileId !== undefined
      ? derivedFileIdFor(event.fileRef, event.rootFileId)
      : fileIdFor(event.fileRef);
  const fileVersionId = versionIdFor(fileId, event.sha256);
  let changed = false;

  let file: MediaFileRecord | undefined = snapshot.files[fileId];
  if (!file) {
    file = {
      fileId,
      rootFileId: event.rootFileId ?? fileId,
      fileRef: event.fileRef,
      origin: event.origin,
      currentVersionId: fileVersionId,
      createdAt: now,
    };
    snapshot.files[fileId] = file;
    changed = true;
  }

  let version: MediaFileVersionRecord | undefined =
    snapshot.versions[fileVersionId];
  const created = !version;
  if (!version) {
    version = {
      fileVersionId,
      fileId,
      sha256: event.sha256,
      mediaType: event.mediaType,
      metadata: event.metadata,
      sizeBytes: event.sizeBytes,
      mimeType: event.mimeType,
      source: event.source,
      recognition: event.recognition,
      ...(event.parentVersionId !== undefined
        ? { parentVersionId: event.parentVersionId }
        : {}),
      createdAt: now,
    };
    snapshot.versions[fileVersionId] = version;
    changed = true;
  }

  // CURRENT_VERSION follows what is on disk NOW — a re-recognition of an
  // older content state (user reverted the file) moves the pointer back.
  if (file.currentVersionId !== fileVersionId) {
    file.currentVersionId = fileVersionId;
    changed = true;
  }

  return {
    fileId,
    fileVersionId,
    rootFileId: file.rootFileId,
    created,
    changed,
  };
}

/**
 * Content-identity reuse key of a recorded execution, or undefined when
 * its source version is no longer in the graph. Recomputed from the
 * record rather than persisted, so executions written before this key
 * existed participate too.
 */
function reuseKeyOf(
  snapshot: MediaMemorySnapshot,
  execution: MediaPolicyExecutionRecord,
): string | undefined {
  const sha = snapshot.versions[execution.sourceVersionId]?.sha256;
  return sha === undefined ? undefined : `${sha}|${execution.omniConfigHash}`;
}

/**
 * The earliest execution whose content-identity key matches — one that
 * already performed this exact computation on identical bytes, through
 * another File. Deterministic (completion time, then id) so the same
 * graph always attributes reuse to the same original. Reuse records are
 * skipped as candidates: a chain always points at the ORIGINAL.
 */
function findReusableExecution(
  snapshot: MediaMemorySnapshot,
  reuseKey: string,
  selfExecutionId: PolicyExecutionId,
): MediaPolicyExecutionRecord | undefined {
  let best: MediaPolicyExecutionRecord | undefined;
  for (const candidate of Object.values(snapshot.executions)) {
    if (candidate.executionId === selfExecutionId) continue;
    if (candidate.reusedExecutionId !== undefined) continue;
    if (reuseKeyOf(snapshot, candidate) !== reuseKey) continue;
    if (
      !best ||
      candidate.completedAt < best.completedAt ||
      (candidate.completedAt === best.completedAt &&
        candidate.executionId < best.executionId)
    ) {
      best = candidate;
    }
  }
  return best;
}

function commitExecution(
  snapshot: MediaMemorySnapshot,
  input: PolicySucceededInput,
  maxInlineTextBytes: number,
  now: string,
): { commit: PolicySucceededCommit; changed: boolean } {
  // Per-File execution identity (M §11.2/§11.3 «每个 File 仍写入自己的
  // PolicyExecution 与 provenance … 不共享图节点»): keyed on the SOURCE
  // VERSION, so two Files that happen to share bytes each record their
  // own execution instead of the second one silently adopting the first's
  // node (which left it with zero records of its own and rebound the
  // first's derivatives under the second's root).
  const sourceVersion = snapshot.versions[input.source.fileVersionId];
  const sourceSha = sourceVersion?.sha256 ?? input.source.fileVersionId;
  const executionId = hashId(
    'x',
    `${input.source.fileVersionId}|${input.omniConfigHash}`,
  );
  // Content-identity reuse key (M §11.3): the same bytes under the same
  // resolved tool configuration produce byte-identical output no matter
  // which File they were derived through. Deliberately NOT the execution
  // id — it spans Files, which is exactly what makes cross-File reuse
  // possible while provenance stays separate.
  const reuseKey = `${sourceSha}|${input.omniConfigHash}`;

  const mediaBindings = new Map<string, MediaMemoryBinding>();
  const existing = snapshot.executions[executionId];
  if (existing) {
    // Idempotent replay: THIS File already has this execution (same
    // source version, same configuration) — rebuild the bindings from its
    // own recorded derivatives instead of duplicating nodes.
    for (const entryId of existing.outputRefs) {
      const entry = snapshot.entries[entryId];
      if (!entry?.derivedVersionId) continue;
      const version = snapshot.versions[entry.derivedVersionId];
      if (!version) continue;
      mediaBindings.set(version.sha256, {
        fileId: version.fileId,
        fileVersionId: version.fileVersionId,
        rootFileId:
          snapshot.files[version.fileId]?.rootFileId ?? input.source.rootFileId,
      });
    }
    return {
      commit: { executionId, mediaBindings, created: false },
      changed: false,
    };
  }

  // Cross-File reuse (M §11.3): another File already ran this exact
  // computation on identical bytes. Record OUR own execution pointing at
  // it via `reusedExecutionId` and materialize our own entry/version rows
  // over the same content-addressed objects — no re-derivation, no shared
  // graph nodes, no borrowed lineage.
  const reused = findReusableExecution(snapshot, reuseKey, executionId);

  const outputRefs: MediaMemoryEntryId[] = [];
  for (const [index, output] of input.outputs.entries()) {
    const entryId = hashId('e', `${executionId}|${index}|${output.sha256}`);
    outputRefs.push(entryId);

    let derivedVersionId: MediaFileVersionId | undefined;
    if (output.kind === 'media') {
      // Every derived media output becomes a policy-origin file with its
      // own version, rooted at the source's root (M §7 lineage graph).
      const commit = upsertRecognizedFile(
        snapshot,
        {
          fileRef: output.objectPath,
          sha256: output.sha256,
          mediaType: output.mediaType,
          metadata: output.metadata,
          sizeBytes: output.sizeBytes,
          mimeType: output.mimeType,
          origin: 'policy',
          rootFileId: input.source.rootFileId,
          parentVersionId: input.source.fileVersionId,
          source: {
            protocol: 'managed',
            locator: `sha256/${output.sha256}`,
          },
          recognition: {
            ingestionConfigHash: input.omniConfigHash,
            detectorVersion: MEDIA_DETECTOR_VERSION,
            probeStatus: 'complete',
          } satisfies MediaVersionRecognition,
        },
        now,
      );
      derivedVersionId = commit.fileVersionId;
      // Only the execution that FIRST materialized this content owns the
      // provenance pointer. A later execution landing on the same version
      // (identical bytes from a differently-configured run) would otherwise
      // rewrite history, and the version would name an execution whose
      // outputs it is not.
      if (commit.created) {
        snapshot.versions[commit.fileVersionId].producedByExecutionId =
          executionId;
      }
      mediaBindings.set(output.sha256, {
        fileId: commit.fileId,
        fileVersionId: commit.fileVersionId,
        rootFileId: commit.rootFileId,
      });
    }

    const entry: NormalizedPolicyOutput = {
      outputId: entryId,
      kind: output.kind === 'media' ? 'derived_media' : 'policy_result',
      ...(output.role !== undefined ? { role: output.role } : {}),
      artifactRef: {
        storage: 'managed',
        managedId: `sha256/${output.sha256}`,
        mimeType: output.mimeType,
        sizeBytes: output.sizeBytes,
      },
      ...(output.kind === 'text'
        ? { inlineText: truncateUtf8(output.text, maxInlineTextBytes) }
        : {}),
      ...(output.disclosure !== undefined
        ? { disclosure: output.disclosure }
        : {}),
      scope: {},
      channels: channelsFor(
        output.kind === 'media' ? output.mediaType : undefined,
        output.role,
      ),
      coverage: coverageFor(output.role),
      parentVersionId: input.source.fileVersionId,
      producedByExecutionId: executionId,
      ...(derivedVersionId !== undefined ? { derivedVersionId } : {}),
      createdAt: now,
    };
    snapshot.entries[entryId] = entry;
  }

  const execution: MediaPolicyExecutionRecord = {
    executionId,
    invocationId: input.invocationId,
    sourceVersionId: input.source.fileVersionId,
    rootFileId: input.source.rootFileId,
    executionOrigin: input.executionOrigin,
    toolName: input.toolName,
    toolVersion: input.toolVersion,
    finalArguments: input.finalArguments,
    inputScope: {},
    omniConfigHash: input.omniConfigHash,
    outputRefs,
    ...(reused !== undefined ? { reusedExecutionId: reused.executionId } : {}),
    startedAt: input.startedAt,
    completedAt: input.completedAt,
  };
  snapshot.executions[executionId] = execution;

  return {
    commit: { executionId, mediaBindings, created: true },
    changed: true,
  };
}
