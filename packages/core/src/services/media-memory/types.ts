/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Multimodal media memory — persistent record types (upstream design M
 * §5–§8). Everything here is data shape only: collection semantics live
 * in the collector, persistence in the store, and read access in the
 * recall service. Two invariants shape every type in this file:
 *
 * - Persistent identity is separate from filesystem reality. These
 *   persistent IDs are never model-visible; locators are sanitized before
 *   they enter a record. (Separately, the SESSION registry may surface a
 *   model-visible local file's own absolute path in its 【媒体资源】
 *   annotation — see `formatResourcePathText` — but that is the live path
 *   the model already read, never one of these persistent identifiers.)
 * - Only two collection triggers exist — FileRecognized and
 *   OmniPolicySucceeded — so every record traces back to a completed
 *   recognition or a fully-committed policy execution.
 */

import type { MediaProbeResult } from '../../omni/ffmpeg.js';
import type { OmniModality } from '../../omni/recognition.js';

// ─── Persistent IDs (M §5.1) ────────────────────────────────────────────
// String aliases, not branded types: records cross a JSON boundary where
// brands cannot survive, and the alias names keep signatures readable.

/** Stable identity of one logical media file (a fileRef the user or a
 * tool introduced). Survives content changes — versions hang off it. */
export type MediaFileId = string;

/** Immutable identity of one content state (full SHA-256) of a file. */
export type MediaFileVersionId = string;

/** Identity of one memory entry (a normalized policy output or metadata
 * record surfaced by recall). */
export type MediaMemoryEntryId = string;

/** Identity of one committed policy execution. */
export type PolicyExecutionId = string;

// ─── Scope / channel / coverage (M §5.4) ────────────────────────────────

/** Region of a media version an entry or execution covers. An empty
 * object means the whole version. */
export interface MediaScope {
  temporal?: { startMs: number; endMs: number };
  spatial?: {
    x: number;
    y: number;
    width: number;
    height: number;
    unit: 'normalized';
  };
  frameRange?: { start: number; end: number };
  streamIndexes?: number[];
  audioChannels?: number[];
}

/** Information channel an entry speaks for. */
export type MediaChannel =
  | 'technical_metadata'
  | 'visual'
  | 'acoustic'
  | 'speech_text'
  | 'onscreen_text';

/** How completely an entry covers its scope. */
export interface MediaCoverage {
  mode: 'complete' | 'continuous' | 'sampled' | 'partial' | 'summary';
  scope: MediaScope;
}

// ─── File / version records (M §5.2) ────────────────────────────────────

/** Where a media file entered the system. */
export type MediaFileOrigin = 'user' | 'tool' | 'policy';

export interface MediaFileRecord {
  fileId: MediaFileId;
  /** Harness-internal locator: absolute path for local user/tool files
   * (identity = localPath + sha256, storage design S §4 — the bytes stay
   * in place), managed object path for derivatives. Keys the idempotent
   * FileRecognized upsert and lets recall detect deleted local files
   * (artifact_unavailable gap). This PERSISTENT locator is never surfaced
   * through recall payloads. (The live SESSION registry separately shows a
   * model-visible local file its own absolute path in the annotation — the
   * path it already read — but that is not this record field.) */
  fileRef: string;
  /** Root of the derivation tree this file belongs to. A user/tool file
   * is its own root; a policy derivative inherits its source's root.
   * Bounds every graph traversal (M §7). */
  rootFileId: MediaFileId;
  origin: MediaFileOrigin;
  currentVersionId: MediaFileVersionId;
  createdAt: string;
}

/** Sanitized description of where a version's bytes came from. Never a
 * raw filesystem path for user files — recall consumers must not learn
 * real paths (M §5.2/§15). */
export interface MediaVersionSource {
  /** 'local' user/tool file, 'managed' promoted object, 'url' download. */
  protocol: 'local' | 'managed' | 'url';
  /** Sanitized locator: basename for local files, sha256-addressed
   * object key for managed content, origin host for URLs. */
  locator: string;
}

/** Recognition summary persisted with a version (M §5.2): enough to
 * decide whether a past recognition is still trustworthy under today's
 * configuration without re-probing. */
export interface MediaVersionRecognition {
  ingestionConfigHash: string;
  detectorVersion: string;
  probeStatus: 'complete' | 'partial' | 'unavailable';
}

export interface MediaFileVersionRecord {
  fileVersionId: MediaFileVersionId;
  fileId: MediaFileId;
  /** Full content SHA-256 — the sole version-identity criterion (M §11). */
  sha256: string;
  mediaType: OmniModality;
  metadata: MediaProbeResult;
  sizeBytes: number;
  mimeType: string;
  source: MediaVersionSource;
  recognition: MediaVersionRecognition;
  /** DERIVED_FROM edge: the source version a policy derived this from. */
  parentVersionId?: MediaFileVersionId;
  /** PRODUCED_BY edge: the execution that produced this version. */
  producedByExecutionId?: PolicyExecutionId;
  createdAt: string;
}

// ─── Policy execution records (M §5.3) ──────────────────────────────────

/** Who initiated the execution. Mirrors core's ToolExecutionOrigin but
 * persists independently — wire types must stay free to evolve. */
export type MediaExecutionOrigin =
  | {
      kind: 'fixed_policy';
      policyId: string;
      stage: 'preprocessing' | 'transport_guard';
    }
  | { kind: 'model' }
  | { kind: 'client' };

export interface MediaPolicyExecutionRecord {
  executionId: PolicyExecutionId;
  /** Orchestrator staging invocation id (= scheduler callId). */
  invocationId: string;
  /** EXECUTED_ON edge: the version the tool ran against. */
  sourceVersionId: MediaFileVersionId;
  rootFileId: MediaFileId;
  executionOrigin: MediaExecutionOrigin;
  toolName: string;
  /** Media-policy descriptor version of the tool implementation; absent
   * when the tool declares none (the descriptor field is optional). */
  toolVersion?: string;
  /** Arguments after defaults/locked/runtime resolution — the values the
   * tool actually ran with (reserved runtime keys like inputPath are
   * excluded: they are per-invocation filesystem details, not
   * reproducible tool configuration). */
  finalArguments: Record<string, unknown>;
  /** Region of the source version the execution consumed. */
  inputScope: MediaScope;
  /** Hash of the resolved omni configuration relevant to this run. */
  omniConfigHash: string;
  /** HAS_OUTPUT edges. */
  outputRefs: MediaMemoryEntryId[];
  /** Set when this record is a reuse of an earlier execution (same
   * content-identity cache key, M §11): points at the execution whose
   * outputs were reused instead of duplicating nodes. */
  reusedExecutionId?: PolicyExecutionId;
  startedAt: string;
  completedAt: string;
}

// ─── Memory entries (M §5.5 / §6.3) ─────────────────────────────────────

/** Media-typed roles a v1 policy output may carry. Free-form strings are
 * accepted from tools; these are the ones recall understands natively. */
export type KnownMediaMemoryRole =
  | 'transcript'
  | 'ocr'
  | 'caption'
  | 'summary'
  | 'keyframe'
  | 'clip'
  | 'extracted_audio';

/** Reference to a stored artifact backing a derived_media entry. */
export interface MediaArtifactRef {
  storage: 'managed' | 'workspace';
  /** Content-addressed object key when managed, as `sha256/<hex>` — the
   * form the object store resolves and the only field an entry's bytes can
   * be re-found by after the producing run is gone. */
  managedId?: string;
  workspacePath?: string;
  mimeType: string;
  sizeBytes: number;
}

/** One normalized policy output as committed to memory. Sourced ONLY
 * from a PolicyArtifactBatch (M §6.3) — never llmContent/returnDisplay
 * or hook-injected artifacts. */
export interface NormalizedPolicyOutput {
  outputId: MediaMemoryEntryId;
  kind: 'derived_media' | 'policy_result';
  role?: string;
  artifactRef?: MediaArtifactRef;
  /** Bounded inline text (transcripts, OCR). Never larger than
   * `collection.maxInlineTextBytes`. */
  inlineText?: string;
  disclosure?: string;
  scope: MediaScope;
  channels: MediaChannel[];
  coverage: MediaCoverage;
  /** Version of the SOURCE media this output describes. */
  parentVersionId: MediaFileVersionId;
  producedByExecutionId: PolicyExecutionId;
  /** For derived_media outputs: the fileVersionId of the derivative's
   * own version record (the DERIVED_FROM child). */
  derivedVersionId?: MediaFileVersionId;
  createdAt: string;
}

// ─── Store snapshot shape (v1 JSON backend) ─────────────────────────────

/** Whole-store snapshot persisted as one JSON document. v1 keeps the
 * entire graph in one file (`.qwen/omni/memory.json`) — swapping the
 * backend later changes only the store internals (S4 precedent D2). */
export interface MediaMemorySnapshot {
  schemaVersion: 1;
  files: Record<MediaFileId, MediaFileRecord>;
  versions: Record<MediaFileVersionId, MediaFileVersionRecord>;
  executions: Record<PolicyExecutionId, MediaPolicyExecutionRecord>;
  entries: Record<MediaMemoryEntryId, NormalizedPolicyOutput>;
}

// ─── Collection inputs (collector-facing) ───────────────────────────────

/** Everything the FileRecognized trigger point knows about a file at the
 * moment recognition completes (M §6.1 preconditions: mediaType decided,
 * full SHA-256 available, metadata + definite probeStatus). */
export interface FileRecognizedEvent {
  /** Identity key for the logical file. For user/tool local files this
   * is the absolute path (identity = localPath + sha256, storage design
   * S §4 — the bytes are NOT copied into the object store); for managed
   * derivatives it is the object path. Used only to derive/lookup the
   * fileId — persisted records carry the sanitized `source` instead. */
  fileRef: string;
  sha256: string;
  mediaType: OmniModality;
  metadata: MediaProbeResult;
  sizeBytes: number;
  mimeType: string;
  origin: MediaFileOrigin;
  source: MediaVersionSource;
  recognition: MediaVersionRecognition;
  /** For policy derivatives: lineage edges known at recognition time. */
  parentVersionId?: MediaFileVersionId;
  /** For policy derivatives: root inherited from the source file. */
  rootFileId?: MediaFileId;
}

/** Result of committing (or staging) a FileRecognized event. */
export interface FileRecognizedCommit {
  fileId: MediaFileId;
  fileVersionId: MediaFileVersionId;
  rootFileId: MediaFileId;
  /** False when the version already existed (idempotent re-recognition). */
  created: boolean;
}
