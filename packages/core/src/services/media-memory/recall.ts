/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import { createDebugLogger } from '../../utils/debugLogger.js';
import type { OmniModality } from '../../omni/recognition.js';
import type {
  NormalizedOmniMemoryRecall,
  OmniMemoryRecallKind,
} from './config.js';
import type { MediaResourceRegistry } from './registry.js';
import { MediaMemoryStore } from './store.js';
import type {
  MediaChannel,
  MediaCoverage,
  MediaFileId,
  MediaFileVersionId,
  MediaFileVersionRecord,
  MediaMemoryEntryId,
  MediaMemorySnapshot,
  MediaPolicyExecutionRecord,
  MediaScope,
  NormalizedPolicyOutput,
  PolicyExecutionId,
} from './types.js';

const debugLogger = createDebugLogger('omni:memory');

// ─── Recall protocol (M §9.2 request / §9.4 minimal return) ──────────────

/** One recall request, active tool and sideQuery alike (M §9.2). Every
 * resourceId must have been issued by THIS session's registry — an
 * unknown handle rejects the whole request (never partial fulfilment of
 * a request that references resources the session was not given). */
export interface MediaMemoryRecallRequest {
  resourceIds: string[];
  /** Free-text information need. v1 has no semantic index: the query
   * only orders structurally-matched entries (term overlap), it never
   * widens or narrows the match set. */
  query: string;
  kinds?: OmniMemoryRecallKind[];
  roles?: string[];
  scope?: MediaScope;
  includeHistoricalVersions?: boolean;
  limit?: number;
}

export interface MediaMemoryRecallFile {
  fileId: MediaFileId;
  fileVersionId: MediaFileVersionId;
  /** Whether this is the file's CURRENT_VERSION. A stale bound version
   * listed with `current: false` is the explicit history hint of §9.5. */
  current: boolean;
  mediaType: OmniModality;
}

export interface MediaMemoryRecallProvenance {
  toolName?: string;
  toolVersion?: string;
  policyId?: string;
  stage?: 'preprocessing' | 'transport_guard';
  omniConfigHash: string;
}

export interface MediaMemoryRecallEntry {
  entryId: MediaMemoryEntryId;
  kind: OmniMemoryRecallKind;
  role?: string;
  /** Bounded text payload (`recall.maxTextChars`): inline text for
   * policy outputs, a compact technical summary for synthesized
   * metadata/execution entries. */
  content?: string;
  /** Fidelity disclosure recorded at collection time — travels with the
   * content so degraded derivatives are never mistaken for originals. */
  disclosure?: string;
  /** Session handle for a derived media artifact, freshly bound through
   * the registry (M §5.2). Absent when the artifact is gone. */
  resourceId?: string;
  scope: MediaScope;
  channels: MediaChannel[];
  coverage: MediaCoverage;
  evidenceRefs: Array<{
    fileVersionId: MediaFileVersionId;
    executionId?: PolicyExecutionId;
  }>;
  provenance: MediaMemoryRecallProvenance;
}

export interface MediaMemoryRecallGap {
  scope: MediaScope;
  channels: MediaChannel[];
  reason: 'not_processed' | 'partial_coverage' | 'artifact_unavailable';
}

export interface MediaMemoryNextPolicyAction {
  toolName: string;
  resourceId: string;
  arguments: Record<string, unknown>;
  reason: string;
}

export interface MediaMemoryRecallResult {
  status: 'hit' | 'partial' | 'miss';
  files: MediaMemoryRecallFile[];
  entries: MediaMemoryRecallEntry[];
  gaps: MediaMemoryRecallGap[];
  nextPolicyActions?: MediaMemoryNextPolicyAction[];
}

/** Whole-request rejection (M §9.2): the request itself is invalid —
 * distinct from a valid request that finds nothing (`status: 'miss'`). */
export class MediaMemoryRecallRejection extends Error {
  constructor(
    readonly reason: 'empty_request' | 'unknown_resource',
    message: string,
  ) {
    super(message);
    this.name = 'MediaMemoryRecallRejection';
  }
}

/** Hook for suggesting `nextPolicyActions` from a gap. Recall itself
 * cannot name tools — which media-policy tools exist is session
 * configuration the caller owns — so suggestions only appear when the
 * wiring layer supplies an advisor built from the live tool registry. */
export type MediaMemoryRecallAdvisor = (input: {
  resourceId: string;
  mediaType: OmniModality;
  gap: MediaMemoryRecallGap;
}) => MediaMemoryNextPolicyAction[];

// ─── Internals ────────────────────────────────────────────────────────────

/** Truncate to a character budget without splitting a surrogate pair.
 * (`maxTextChars` is a UTF-16 length bound, unlike the byte-bounded
 * collection-side truncateUtf8.) */
function truncateChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let cut = text.slice(0, maxChars);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

/** Channels a fully-processed version of this modality would cover.
 * Conservative v1 baseline: onscreen_text (OCR) is not expected by
 * default — its absence is not reported as a gap. */
function expectedChannels(mediaType: OmniModality): MediaChannel[] {
  switch (mediaType) {
    case 'image':
      return ['visual'];
    case 'audio':
      return ['acoustic', 'speech_text'];
    case 'video':
      return ['visual', 'acoustic', 'speech_text'];
    default:
      return [];
  }
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1);
}

/** Temporal-overlap scope filter. Entries without a temporal scope speak
 * for the whole version and always pass. Non-temporal scope dimensions
 * are not filtered in v1. */
function scopeMatches(
  requested: MediaScope | undefined,
  entryScope: MediaScope,
): boolean {
  const want = requested?.temporal;
  const have = entryScope.temporal;
  if (!want || !have) return true;
  return have.startMs < want.endMs && have.endMs > want.startMs;
}

interface CandidateEntry {
  entry: MediaMemoryRecallEntry;
  createdAt: string;
  /** Resource the entry was recalled for (gap/advisor attribution). */
  forResourceId: string;
  /** Set when a derived artifact must exist on disk to be bindable. */
  derived?: {
    versionId: MediaFileVersionId;
    fileId: MediaFileId;
    fileRef: string;
    mediaType: OmniModality;
  };
}

interface SnapshotIndexes {
  childrenByParent: Map<MediaFileVersionId, MediaFileVersionRecord[]>;
  entriesByParent: Map<MediaFileVersionId, NormalizedPolicyOutput[]>;
  executionsBySource: Map<MediaFileVersionId, MediaPolicyExecutionRecord[]>;
  versionsByFile: Map<MediaFileId, MediaFileVersionRecord[]>;
}

function indexSnapshot(snapshot: MediaMemorySnapshot): SnapshotIndexes {
  const childrenByParent = new Map<
    MediaFileVersionId,
    MediaFileVersionRecord[]
  >();
  const versionsByFile = new Map<MediaFileId, MediaFileVersionRecord[]>();
  for (const version of Object.values(snapshot.versions)) {
    if (version.parentVersionId) {
      const list = childrenByParent.get(version.parentVersionId) ?? [];
      list.push(version);
      childrenByParent.set(version.parentVersionId, list);
    }
    const byFile = versionsByFile.get(version.fileId) ?? [];
    byFile.push(version);
    versionsByFile.set(version.fileId, byFile);
  }
  const entriesByParent = new Map<
    MediaFileVersionId,
    NormalizedPolicyOutput[]
  >();
  for (const entry of Object.values(snapshot.entries)) {
    const list = entriesByParent.get(entry.parentVersionId) ?? [];
    list.push(entry);
    entriesByParent.set(entry.parentVersionId, list);
  }
  const executionsBySource = new Map<
    MediaFileVersionId,
    MediaPolicyExecutionRecord[]
  >();
  for (const execution of Object.values(snapshot.executions)) {
    const list = executionsBySource.get(execution.sourceVersionId) ?? [];
    list.push(execution);
    executionsBySource.set(execution.sourceVersionId, list);
  }
  return {
    childrenByParent,
    entriesByParent,
    executionsBySource,
    versionsByFile,
  };
}

/** All versions reachable from `start` over DERIVED_FROM child edges,
 * bounded by the binding's root (M §8: every traversal stays inside one
 * root graph — a version filed under another root is never followed). */
function derivedSubgraph(
  snapshot: MediaMemorySnapshot,
  indexes: SnapshotIndexes,
  start: MediaFileVersionRecord,
  rootFileId: MediaFileId,
): MediaFileVersionRecord[] {
  const result: MediaFileVersionRecord[] = [];
  const visited = new Set<MediaFileVersionId>();
  const queue: MediaFileVersionRecord[] = [start];
  while (queue.length > 0) {
    const version = queue.shift() as MediaFileVersionRecord;
    if (visited.has(version.fileVersionId)) continue;
    visited.add(version.fileVersionId);
    const file = snapshot.files[version.fileId];
    if (!file || file.rootFileId !== rootFileId) continue;
    result.push(version);
    for (const child of indexes.childrenByParent.get(version.fileVersionId) ??
      []) {
      queue.push(child);
    }
  }
  return result;
}

function provenanceOf(
  execution: MediaPolicyExecutionRecord | undefined,
): MediaMemoryRecallProvenance {
  if (!execution) return { omniConfigHash: '' };
  const origin = execution.executionOrigin;
  return {
    toolName: execution.toolName,
    ...(execution.toolVersion !== undefined
      ? { toolVersion: execution.toolVersion }
      : {}),
    ...(origin.kind === 'fixed_policy'
      ? { policyId: origin.policyId, stage: origin.stage }
      : {}),
    omniConfigHash: execution.omniConfigHash,
  };
}

// ─── Recall service ───────────────────────────────────────────────────────

/**
 * The read side of multimodal media memory (M §9): given session resource
 * handles, return what memory already knows about the underlying media —
 * current-version-first (§9.5), bounded to each resource's root graph
 * (§8), with honest gaps for what was never processed or is no longer on
 * disk. Both recall surfaces (the active `omni_recall_media_memory` tool
 * and the passive sideQuery selector) sit on this one service.
 *
 * Read-only by constitution (M §14 / D11): the service holds a store but
 * only ever calls `read`. The only state it mutates is the session
 * registry, binding derived artifacts so the model can reference them.
 */
export class MediaMemoryRecallService {
  private readonly store: MediaMemoryStore;

  constructor(
    omniRootDir: string,
    private readonly config: NormalizedOmniMemoryRecall,
    private readonly registry: MediaResourceRegistry,
    private readonly options?: { advise?: MediaMemoryRecallAdvisor },
  ) {
    this.store = new MediaMemoryStore(omniRootDir);
  }

  /**
   * Execute one recall request. Throws {@link MediaMemoryRecallRejection}
   * when the request itself is invalid (empty, or referencing a handle
   * this session never issued); an unreadable store degrades to a plain
   * miss — recall is an enhancement and must never break the caller.
   */
  async recall(
    request: MediaMemoryRecallRequest,
  ): Promise<MediaMemoryRecallResult> {
    if (request.resourceIds.length === 0) {
      throw new MediaMemoryRecallRejection(
        'empty_request',
        'recall request must name at least one resourceId',
      );
    }
    const bindings = request.resourceIds.map((resourceId) => {
      const binding = this.registry.resolve(resourceId);
      if (!binding) {
        throw new MediaMemoryRecallRejection(
          'unknown_resource',
          `resourceId ${resourceId} was not issued in this session`,
        );
      }
      return binding;
    });

    const miss: MediaMemoryRecallResult = {
      status: 'miss',
      files: [],
      entries: [],
      gaps: [],
    };
    try {
      return await this.store.read(miss, (snapshot) =>
        this.recallFromSnapshot(snapshot, request, bindings),
      );
    } catch (err) {
      debugLogger.debug(
        `recall failed: ${err instanceof Error ? err.message : err}`,
      );
      return miss;
    }
  }

  private async recallFromSnapshot(
    snapshot: MediaMemorySnapshot,
    request: MediaMemoryRecallRequest,
    bindings: ReadonlyArray<ReturnType<MediaResourceRegistry['resolve']>>,
  ): Promise<MediaMemoryRecallResult> {
    const indexes = indexSnapshot(snapshot);
    const kinds = this.effectiveKinds(request);
    const includeHistorical =
      request.includeHistoricalVersions ??
      this.config.includeHistoricalVersions;

    const files = new Map<MediaFileVersionId, MediaMemoryRecallFile>();
    const candidates = new Map<MediaMemoryEntryId, CandidateEntry>();
    const gaps: Array<
      MediaMemoryRecallGap & { forResourceId: string; mediaType: OmniModality }
    > = [];

    for (const binding of bindings) {
      if (!binding) continue; // narrowed by the caller; keeps types honest
      const boundVersion = snapshot.versions[binding.fileVersionId];
      const file = boundVersion
        ? snapshot.files[boundVersion.fileId]
        : undefined;
      if (!boundVersion || !file) {
        // The persistent graph no longer holds this binding (store was
        // corrupt-rebuilt). The session resource still exists — report
        // the memory about it as unavailable rather than erroring.
        gaps.push({
          scope: {},
          channels: expectedChannels(binding.mediaType),
          reason: 'artifact_unavailable',
          forResourceId: binding.resourceId,
          mediaType: binding.mediaType,
        });
        continue;
      }

      // Current-version-first (§9.5): consult the CURRENT version's graph
      // by default; historical versions only on explicit request.
      const fileVersions = indexes.versionsByFile.get(file.fileId) ?? [];
      const currentVersion = snapshot.versions[file.currentVersionId];
      const consulted = includeHistorical
        ? [...fileVersions].sort((a, b) =>
            b.createdAt.localeCompare(a.createdAt),
          )
        : currentVersion
          ? [currentVersion]
          : [];

      for (const version of consulted) {
        files.set(version.fileVersionId, {
          fileId: file.fileId,
          fileVersionId: version.fileVersionId,
          current: version.fileVersionId === file.currentVersionId,
          mediaType: version.mediaType,
        });
      }
      // Explicit history hint (§9.5): the handle points at content that
      // is no longer current — list it as such even when not consulted.
      if (!files.has(binding.fileVersionId)) {
        files.set(binding.fileVersionId, {
          fileId: file.fileId,
          fileVersionId: binding.fileVersionId,
          current: false,
          mediaType: boundVersion.mediaType,
        });
      }

      for (const version of consulted) {
        await this.collectVersion(
          snapshot,
          indexes,
          binding.resourceId,
          binding.rootFileId,
          version,
          kinds,
          request,
          candidates,
        );
      }

      // Gaps speak for the CURRENT version's processing state, always —
      // history inclusion widens the entries, not the obligation.
      if (currentVersion) {
        gaps.push(
          ...(await this.gapsForVersion(
            snapshot,
            indexes,
            binding.resourceId,
            binding.rootFileId,
            file.fileRef,
            currentVersion,
          )),
        );
      }
    }

    const limit = Math.min(
      request.limit ?? this.config.maxEntries,
      this.config.maxEntries,
    );
    const entries = rankAndSlice(
      [...candidates.values()],
      request.query,
      limit,
    );

    // Artifact-availability pass for the derived media actually returned:
    // bind a session handle when the object is still on disk; otherwise
    // surface the loss as a gap instead of handing out a dead handle.
    for (const candidate of entries) {
      const derived = candidate.derived;
      if (!derived) continue;
      if (await pathExists(derived.fileRef)) {
        candidate.entry.resourceId = this.registry.bind({
          fileId: derived.fileId,
          fileVersionId: derived.versionId,
          rootFileId:
            snapshot.files[derived.fileId]?.rootFileId ?? derived.fileId,
          fileRef: derived.fileRef,
          mediaType: derived.mediaType,
        }).resourceId;
      } else {
        gaps.push({
          scope: candidate.entry.scope,
          channels: candidate.entry.channels,
          reason: 'artifact_unavailable',
          forResourceId: candidate.forResourceId,
          mediaType: derived.mediaType,
        });
      }
    }

    const resultEntries = entries.map((c) => c.entry);
    const resultGaps: MediaMemoryRecallGap[] = gaps.map(
      ({ scope, channels, reason }) => ({ scope, channels, reason }),
    );
    const nextPolicyActions = this.options?.advise
      ? gaps.flatMap((gap) =>
          this.options!.advise!({
            resourceId: gap.forResourceId,
            mediaType: gap.mediaType,
            gap: {
              scope: gap.scope,
              channels: gap.channels,
              reason: gap.reason,
            },
          }),
        )
      : [];

    const status: MediaMemoryRecallResult['status'] =
      resultEntries.length === 0
        ? 'miss'
        : resultGaps.length > 0
          ? 'partial'
          : 'hit';

    return {
      status,
      files: [...files.values()],
      entries: resultEntries,
      gaps: resultGaps,
      ...(nextPolicyActions.length > 0 ? { nextPolicyActions } : {}),
    };
  }

  /** Request kinds narrowed to what configuration allows; an absent
   * request filter means "everything configured". */
  private effectiveKinds(
    request: MediaMemoryRecallRequest,
  ): Set<OmniMemoryRecallKind> {
    const allowed = new Set(this.config.kinds);
    if (!request.kinds) return allowed;
    return new Set(request.kinds.filter((k) => allowed.has(k)));
  }

  /** Collect every matching entry reachable from one consulted version:
   * synthesized metadata for the version itself, then policy outputs and
   * executions across its whole derivation subgraph (the transcript of an
   * extracted audio track parents on the AUDIO version — only the
   * subgraph walk surfaces it for the movie's handle). */
  private async collectVersion(
    snapshot: MediaMemorySnapshot,
    indexes: SnapshotIndexes,
    forResourceId: string,
    rootFileId: MediaFileId,
    version: MediaFileVersionRecord,
    kinds: Set<OmniMemoryRecallKind>,
    request: MediaMemoryRecallRequest,
    out: Map<MediaMemoryEntryId, CandidateEntry>,
  ): Promise<void> {
    const rolesFilter = request.roles;
    if (kinds.has('metadata') && !rolesFilter) {
      const entryId = `metadata:${version.fileVersionId}`;
      out.set(entryId, {
        entry: {
          entryId,
          kind: 'metadata',
          content: truncateChars(
            JSON.stringify({
              mediaType: version.mediaType,
              mimeType: version.mimeType,
              sizeBytes: version.sizeBytes,
              source: version.source,
              ...version.metadata,
            }),
            this.config.maxTextChars,
          ),
          scope: {},
          channels: ['technical_metadata'],
          coverage: { mode: 'complete', scope: {} },
          evidenceRefs: [{ fileVersionId: version.fileVersionId }],
          provenance: {
            omniConfigHash: version.recognition.ingestionConfigHash,
          },
        },
        createdAt: version.createdAt,
        forResourceId,
      });
    }

    for (const node of derivedSubgraph(
      snapshot,
      indexes,
      version,
      rootFileId,
    )) {
      if (kinds.has('derived_media') || kinds.has('policy_result')) {
        for (const entry of indexes.entriesByParent.get(node.fileVersionId) ??
          []) {
          if (!kinds.has(entry.kind)) continue;
          if (rolesFilter && (!entry.role || !rolesFilter.includes(entry.role)))
            continue;
          if (!scopeMatches(request.scope, entry.scope)) continue;
          const execution = snapshot.executions[entry.producedByExecutionId];
          const derivedVersion = entry.derivedVersionId
            ? snapshot.versions[entry.derivedVersionId]
            : undefined;
          out.set(entry.outputId, {
            entry: {
              entryId: entry.outputId,
              kind: entry.kind,
              ...(entry.role !== undefined ? { role: entry.role } : {}),
              ...(entry.inlineText !== undefined
                ? {
                    content: truncateChars(
                      entry.inlineText,
                      this.config.maxTextChars,
                    ),
                  }
                : {}),
              ...(entry.disclosure !== undefined
                ? { disclosure: entry.disclosure }
                : {}),
              scope: entry.scope,
              channels: entry.channels,
              coverage: entry.coverage,
              evidenceRefs: [
                {
                  fileVersionId: entry.parentVersionId,
                  executionId: entry.producedByExecutionId,
                },
              ],
              provenance: provenanceOf(execution),
            },
            createdAt: entry.createdAt,
            forResourceId,
            ...(derivedVersion
              ? {
                  derived: {
                    versionId: derivedVersion.fileVersionId,
                    fileId: derivedVersion.fileId,
                    fileRef:
                      snapshot.files[derivedVersion.fileId]?.fileRef ?? '',
                    mediaType: derivedVersion.mediaType,
                  },
                }
              : {}),
          });
        }
      }

      if (kinds.has('execution') && !rolesFilter) {
        for (const execution of indexes.executionsBySource.get(
          node.fileVersionId,
        ) ?? []) {
          if (!scopeMatches(request.scope, execution.inputScope)) continue;
          const entryId = `execution:${execution.executionId}`;
          out.set(entryId, {
            entry: {
              entryId,
              kind: 'execution',
              content: truncateChars(
                JSON.stringify({
                  toolName: execution.toolName,
                  ...(execution.toolVersion !== undefined
                    ? { toolVersion: execution.toolVersion }
                    : {}),
                  finalArguments: execution.finalArguments,
                  completedAt: execution.completedAt,
                  outputCount: execution.outputRefs.length,
                }),
                this.config.maxTextChars,
              ),
              scope: execution.inputScope,
              channels: [],
              coverage: { mode: 'complete', scope: execution.inputScope },
              evidenceRefs: [
                {
                  fileVersionId: execution.sourceVersionId,
                  executionId: execution.executionId,
                },
              ],
              provenance: provenanceOf(execution),
            },
            createdAt: execution.completedAt,
            forResourceId,
          });
        }
      }
    }
  }

  /** Honest-gaps derivation (§9.4) for one CURRENT version: which of the
   * modality's expected channels have no evidence (not_processed), only
   * sampled/partial evidence (partial_coverage), and whether the source
   * bytes themselves are still on disk (artifact_unavailable, D5). Gap
   * truth is computed from the FULL subgraph, unfiltered — what the
   * request chose to see never changes what was processed. */
  private async gapsForVersion(
    snapshot: MediaMemorySnapshot,
    indexes: SnapshotIndexes,
    forResourceId: string,
    rootFileId: MediaFileId,
    fileRef: string,
    version: MediaFileVersionRecord,
  ): Promise<
    Array<
      MediaMemoryRecallGap & { forResourceId: string; mediaType: OmniModality }
    >
  > {
    const gaps: Array<
      MediaMemoryRecallGap & { forResourceId: string; mediaType: OmniModality }
    > = [];
    if (!(await pathExists(fileRef))) {
      gaps.push({
        scope: {},
        channels: expectedChannels(version.mediaType),
        reason: 'artifact_unavailable',
        forResourceId,
        mediaType: version.mediaType,
      });
    }

    const complete = new Set<MediaChannel>();
    const partial = new Set<MediaChannel>();
    for (const node of derivedSubgraph(
      snapshot,
      indexes,
      version,
      rootFileId,
    )) {
      for (const entry of indexes.entriesByParent.get(node.fileVersionId) ??
        []) {
        const full =
          entry.coverage.mode === 'complete' ||
          entry.coverage.mode === 'continuous';
        for (const channel of entry.channels) {
          (full ? complete : partial).add(channel);
        }
      }
    }

    const notProcessed: MediaChannel[] = [];
    const partialOnly: MediaChannel[] = [];
    for (const channel of expectedChannels(version.mediaType)) {
      if (complete.has(channel)) continue;
      (partial.has(channel) ? partialOnly : notProcessed).push(channel);
    }
    if (notProcessed.length > 0) {
      gaps.push({
        scope: {},
        channels: notProcessed,
        reason: 'not_processed',
        forResourceId,
        mediaType: version.mediaType,
      });
    }
    if (partialOnly.length > 0) {
      gaps.push({
        scope: {},
        channels: partialOnly,
        reason: 'partial_coverage',
        forResourceId,
        mediaType: version.mediaType,
      });
    }
    return gaps;
  }
}

async function pathExists(fileRef: string): Promise<boolean> {
  if (!fileRef) return false;
  try {
    await fs.access(fileRef);
    return true;
  } catch {
    return false;
  }
}

/** Order candidates by naive query-term overlap, then recency, then id
 * (full determinism), and apply the entry budget. Ranking never filters:
 * a zero-score entry still returns when the budget allows. */
function rankAndSlice(
  candidates: CandidateEntry[],
  query: string,
  limit: number,
): CandidateEntry[] {
  const tokens = tokenize(query);
  const scored = candidates.map((candidate) => {
    const haystack = [
      candidate.entry.role ?? '',
      candidate.entry.content ?? '',
      candidate.entry.provenance.toolName ?? '',
    ]
      .join(' ')
      .toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (haystack.includes(token)) score += 1;
    }
    return { candidate, score };
  });
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.candidate.createdAt.localeCompare(a.candidate.createdAt) ||
      a.candidate.entry.entryId.localeCompare(b.candidate.entry.entryId),
  );
  return scored.slice(0, Math.max(0, limit)).map((s) => s.candidate);
}
