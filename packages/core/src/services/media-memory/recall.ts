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
  /**
   * True when `content` is a PREFIX of what memory holds, cut by
   * `recall.maxTextChars`. Coverage speaks for what was PROCESSED, so a
   * transcript entry legitimately reports `complete` — without this flag
   * the model reads a truncated transcript, sees complete coverage and no
   * gap, and answers about late audio it never saw. Defaults collide here
   * by design: maxTextChars (24000 chars) is smaller than the collection
   * bound (65536 bytes), so any long transcript is cut at READ time.
   */
  contentTruncated?: boolean;
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
  /**
   * Total entries that matched, present ONLY when the entry budget cut the
   * list short. Without it a truncated page is indistinguishable from an
   * exhaustive one: a real audit read 6 clips under `limit: 12` and
   * concluded "no keyframes were ever extracted" while the store held 72
   * of them. The reader was being honest about what it saw — it simply had
   * no way to know it was looking at a page.
   */
  matchedEntries?: number;
}

/** One candidate-manifest row for the sideQuery selector (M §9.3):
 * enough structure to judge relevance — never the raw media, the full
 * text, a local path, or a secret. */
export interface MediaMemoryCandidateSummary {
  entryId: MediaMemoryEntryId;
  kind: OmniMemoryRecallKind;
  role?: string;
  scope: MediaScope;
  channels: MediaChannel[];
  coverage: MediaCoverage;
  /** Bounded content preview. */
  description?: string;
  /** Producing tool, when known. */
  producer?: string;
}

/** Character budget for one manifest row's content preview. */
const CANDIDATE_DESCRIPTION_MAX_CHARS = 200;

/** Whole-request rejection (M §9.2): the request itself is invalid —
 * distinct from a valid request that finds nothing (`status: 'miss'`).
 * `invalid_selection` is the sideQuery variant (M §9.3): the selector
 * returned an entryId outside the candidate manifest (unknown, cross-root
 * — the manifest is root-bounded by construction) or over budget. */
export class MediaMemoryRecallRejection extends Error {
  constructor(
    readonly reason: 'empty_request' | 'unknown_resource' | 'invalid_selection',
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

/** Character classes that write without spaces between words. A run of
 * these cannot be split on separators, so it is indexed as overlapping
 * character bigrams instead. */
const UNSEGMENTED =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Split a separator-delimited run into maximal same-class segments, so a
 * mixed run like `480p字幕` yields `480p` and `字幕` rather than bigrams
 * that straddle the boundary. */
const SEGMENT_RUN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;

/**
 * Query terms for relevance ordering.
 *
 * Splitting on separators alone works for languages that write with them
 * and fails completely for those that do not: `机器人的梦想 剧情` became the
 * two whole phrases `机器人的梦想` and `剧情`, each scored by substring
 * containment — so unless an entry repeated the caller's exact phrasing,
 * every candidate scored zero and ordering silently collapsed to
 * newest-first. Runs in unsegmented scripts therefore become overlapping
 * character bigrams, which match partial phrasings the way word tokens do.
 */
function tokenize(query: string): string[] {
  const tokens = new Set<string>();
  for (const run of query.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    for (const segment of run.match(SEGMENT_RUN) ?? []) {
      if (!UNSEGMENTED.test(segment)) {
        if (segment.length > 1) tokens.add(segment);
        continue;
      }
      const chars = [...segment];
      if (chars.length === 1) {
        tokens.add(segment);
        continue;
      }
      for (let i = 0; i + 1 < chars.length; i++) {
        tokens.add(chars[i] + chars[i + 1]);
      }
    }
  }
  return [...tokens];
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

/** The shared output of one snapshot walk (collectFromSnapshot). */
interface CollectedRecall {
  files: Map<MediaFileVersionId, MediaMemoryRecallFile>;
  candidates: Map<MediaMemoryEntryId, CandidateEntry>;
  gaps: Array<
    MediaMemoryRecallGap & { forResourceId: string; mediaType: OmniModality }
  >;
}

/** Deterministic manifest order (M §9.3): newest first, entryId
 * tiebreak — the cap must cut the same rows on every run. */
function orderCandidates(candidates: CandidateEntry[]): CandidateEntry[] {
  return [...candidates].sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) ||
      a.entry.entryId.localeCompare(b.entry.entryId),
  );
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
    const bindings = this.resolveBindings(request.resourceIds);
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

  /**
   * Bounded candidate manifest for the sideQuery selector (M §9.3): every
   * entry reachable from the named resources — same root-bounded walk as
   * {@link recall}, configured kinds, current-version-first — summarized
   * without full text/paths and capped at `sideQuery.maxCandidateEntries`
   * (newest first; deterministic tiebreak). Rejections propagate like
   * {@link recall}; an unreadable store degrades to an empty manifest.
   */
  async candidateSummaries(
    resourceIds: string[],
  ): Promise<MediaMemoryCandidateSummary[]> {
    const bindings = this.resolveBindings(resourceIds);
    const request: MediaMemoryRecallRequest = { resourceIds, query: '' };
    // No catch-all here: an unreadable/absent store already resolves to the
    // empty manifest inside `read`, so anything reaching this frame is a
    // defect in the walk. The caller records it as `manifest_failed` and
    // sends the main request anyway — swallowing it here would only cost us
    // the stack trace.
    return await this.store.read(
      [] as MediaMemoryCandidateSummary[],
      async (snapshot) => {
        const { candidates } = await this.collectFromSnapshot(
          snapshot,
          request,
          bindings,
        );
        return orderCandidates([...candidates.values()])
          .slice(0, this.config.sideQuery.maxCandidateEntries)
          .map((candidate) => ({
            entryId: candidate.entry.entryId,
            kind: candidate.entry.kind,
            ...(candidate.entry.role !== undefined
              ? { role: candidate.entry.role }
              : {}),
            scope: candidate.entry.scope,
            channels: candidate.entry.channels,
            coverage: candidate.entry.coverage,
            ...(candidate.entry.content !== undefined
              ? {
                  description: truncateChars(
                    candidate.entry.content,
                    CANDIDATE_DESCRIPTION_MAX_CHARS,
                  ),
                }
              : {}),
            ...(candidate.entry.provenance.toolName !== undefined
              ? { producer: candidate.entry.provenance.toolName }
              : {}),
          }));
      },
    );
  }

  /**
   * Materialize a selector's picks by the unified protocol (M §9.3): the
   * selection must be a subset of the manifest {@link candidateSummaries}
   * would produce for the same resources and within
   * `sideQuery.maxSelectedEntries` — anything else (unknown id, cross-root
   * id, over budget) rejects the WHOLE selection with `invalid_selection`,
   * never a partial fulfilment.
   */
  async recallSelection(
    resourceIds: string[],
    entryIds: string[],
  ): Promise<MediaMemoryRecallResult> {
    const bindings = this.resolveBindings(resourceIds);
    // A repeated pick is one pick: a selector naming the same entry twice
    // asked for the same content, and materializing it twice would spend
    // the budget on a duplicate.
    const selectedIds = [...new Set(entryIds)];
    if (selectedIds.length > this.config.sideQuery.maxSelectedEntries) {
      throw new MediaMemoryRecallRejection(
        'invalid_selection',
        `selector returned ${selectedIds.length} entryIds; at most ` +
          `${this.config.sideQuery.maxSelectedEntries} may be selected`,
      );
    }
    const request: MediaMemoryRecallRequest = { resourceIds, query: '' };
    return await this.store.read(
      {
        status: 'miss',
        files: [],
        entries: [],
        gaps: [],
      } satisfies MediaMemoryRecallResult,
      async (snapshot) => {
        const collected = await this.collectFromSnapshot(
          snapshot,
          request,
          bindings,
        );
        // The manifest the selector saw is the ordered, capped view —
        // validate against exactly that, so an id beyond the cap (which
        // the selector was never shown) rejects like any unknown id.
        const manifest = new Map(
          orderCandidates([...collected.candidates.values()])
            .slice(0, this.config.sideQuery.maxCandidateEntries)
            .map((candidate) => [candidate.entry.entryId, candidate]),
        );
        const selected: CandidateEntry[] = [];
        for (const entryId of selectedIds) {
          const candidate = manifest.get(entryId);
          if (!candidate) {
            throw new MediaMemoryRecallRejection(
              'invalid_selection',
              `selector returned entryId ${entryId} that is not in the ` +
                `candidate manifest`,
            );
          }
          selected.push(candidate);
        }
        return this.finishResult(snapshot, selected, collected);
      },
    );
  }

  /** Shared request validation (M §9.2): every identifier must resolve to a
   * binding THIS session issued; an empty list or an unresolvable identifier
   * rejects the whole request.
   *
   * A model-visible local source is annotated with its ABSOLUTE PATH rather
   * than a handle, and the model passes that path here. Each identifier is
   * resolved as a handle first (the common case), then as a session-bound
   * fileRef (`resolveByFileRef`) — so the displayed path recalls exactly as
   * the handle would. An identifier that is neither still rejects the whole
   * request. */
  private resolveBindings(
    resourceIds: string[],
  ): Array<NonNullable<ReturnType<MediaResourceRegistry['resolve']>>> {
    if (resourceIds.length === 0) {
      throw new MediaMemoryRecallRejection(
        'empty_request',
        'recall request must name at least one resourceId',
      );
    }
    // Deduplicated per resolved binding — not per raw string: a handle and
    // the path form of the SAME resource both resolve to one binding, and
    // gaps/advice are pushed per binding, so an undeduplicated pair would
    // yield identical duplicate gaps and tell the model to run the same
    // follow-up call twice on one resource.
    const seen = new Set<string>();
    const bindings: Array<
      NonNullable<ReturnType<MediaResourceRegistry['resolve']>>
    > = [];
    for (const resourceId of resourceIds) {
      const binding =
        this.registry.resolve(resourceId) ??
        this.registry.resolveByFileRef(resourceId);
      if (!binding) {
        throw new MediaMemoryRecallRejection(
          'unknown_resource',
          `resourceId ${resourceId} was not issued in this session`,
        );
      }
      if (seen.has(binding.resourceId)) continue;
      seen.add(binding.resourceId);
      bindings.push(binding);
    }
    return bindings;
  }

  private async recallFromSnapshot(
    snapshot: MediaMemorySnapshot,
    request: MediaMemoryRecallRequest,
    bindings: ReadonlyArray<ReturnType<MediaResourceRegistry['resolve']>>,
  ): Promise<MediaMemoryRecallResult> {
    const collected = await this.collectFromSnapshot(
      snapshot,
      request,
      bindings,
    );
    const limit = Math.min(
      request.limit ?? this.config.maxEntries,
      this.config.maxEntries,
    );
    const entries = rankAndSlice(
      [...collected.candidates.values()],
      request.query,
      limit,
    );
    return this.finishResult(snapshot, entries, collected);
  }

  /** The shared walk both recall shapes sit on: resolve each binding to
   * its file, list consulted versions (current-first §9.5), collect
   * candidate entries across the root-bounded derivation subgraph, and
   * derive the CURRENT version's honest gaps. */
  private async collectFromSnapshot(
    snapshot: MediaMemorySnapshot,
    request: MediaMemoryRecallRequest,
    bindings: ReadonlyArray<ReturnType<MediaResourceRegistry['resolve']>>,
  ): Promise<CollectedRecall> {
    const indexes = indexSnapshot(snapshot);
    const kinds = this.effectiveKinds(request);
    const includeHistorical =
      request.includeHistoricalVersions ??
      this.config.includeHistoricalVersions;

    const files = new Map<MediaFileVersionId, MediaMemoryRecallFile>();
    const candidates = new Map<MediaMemoryEntryId, CandidateEntry>();
    const gaps: CollectedRecall['gaps'] = [];

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

    return { files, candidates, gaps };
  }

  /** Availability pass + assembly shared by both recall shapes: bind a
   * session handle for each returned derived artifact still on disk,
   * degrade the lost ones to gaps, derive advisor suggestions and the
   * hit/partial/miss verdict. */
  private async finishResult(
    snapshot: MediaMemorySnapshot,
    entries: CandidateEntry[],
    collected: CollectedRecall,
  ): Promise<MediaMemoryRecallResult> {
    const { files, gaps } = collected;
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

    // Only when the budget actually cut something: an exhaustive page stays
    // as small as it was before this field existed (§9.4 minimal return).
    const matched = collected.candidates.size;
    return {
      status,
      files: [...files.values()],
      entries: resultEntries,
      gaps: resultGaps,
      ...(nextPolicyActions.length > 0 ? { nextPolicyActions } : {}),
      ...(matched > resultEntries.length ? { matchedEntries: matched } : {}),
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
                    // Say so when the payload is a prefix: coverage speaks
                    // for what was processed, so it stays `complete` and
                    // no gap is raised — the flag is the only signal that
                    // the model is not holding the whole text.
                    ...(entry.inlineText.length > this.config.maxTextChars
                      ? { contentTruncated: true }
                      : {}),
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
      // The source bytes are gone (D5): report the loss and STOP. Continuing
      // the channel scan would emit sibling `not_processed` gaps, and the
      // advisor — which only filters `artifact_unavailable` — would then
      // suggest evidence-gathering calls carrying a handle whose file no
      // longer exists: the gate resolves it and `assertMediaPolicyIo` fails,
      // a guaranteed-to-fail turn. Nothing can be gathered from a deleted
      // file, so "unavailable" is the complete and only honest gap.
      return [
        {
          scope: {},
          channels: expectedChannels(version.mediaType),
          reason: 'artifact_unavailable',
          forResourceId,
          mediaType: version.mediaType,
        },
      ];
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
