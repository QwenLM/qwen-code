/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SDKArtifactInfo } from '@qwen-code/core';

import { stat } from 'node:fs/promises';
import {
  isCompactFileToolResult,
  isFileEditResult,
  isFileWriteResult,
  isImageGenResult,
  selectToolResultSideChannel,
  type StructuredPatchHunk,
} from '@qwen-code/core';
import { cloneArtifactEntry } from './artifactProtocol.js';
import { ArtifactReferenceResolver } from './artifactReferenceResolver.js';
import {
  classificationFromArtifactEntry,
  parseArtifactRegistryState,
  serializeArtifactRegistryState,
  type ArtifactClassification,
  type ArtifactRegistryPersistence,
  type ParsedArtifactRegistryState,
} from './artifactRegistryState.js';
export type {
  ArtifactRegistryPersistence,
  PersistedArtifactRegistryState,
} from './artifactRegistryState.js';

export interface RegisteredArtifact {
  readonly entry: Readonly<SDKArtifactInfo>;
}

export interface ArtifactRegistryObservation {
  readonly snapshot: SDKArtifactInfo[] | null;
  readonly presented: SDKArtifactInfo[];
  /** Artifacts changed by this exact structured file-tool result. */
  readonly changedArtifacts: SDKArtifactInfo[];
}

export interface ArtifactPresentationOptions {
  /**
   * Current-turn working artifacts superseded by this explicit delivery.
   * Entries are removed only when their complete metadata is still unchanged.
   */
  readonly supersededArtifacts?: readonly SDKArtifactInfo[];
}

export class ArtifactPresentationError extends Error {
  constructor(readonly rejectedPaths: readonly string[]) {
    super(
      `Unable to present ${rejectedPaths.length} file path${
        rejectedPaths.length === 1 ? '' : 's'
      }: ${rejectedPaths.join(', ')}`,
    );
    this.name = 'ArtifactPresentationError';
  }
}

export interface ArtifactRegistryOptions {
  workingDirectory: string;
  initialWorkspaceRoots: readonly string[];
  /** 会话目录可切换时，在每次产物操作开始时读取当前路径上下文。 */
  getWorkspace?: () => Pick<
    ArtifactRegistryOptions,
    'workingDirectory' | 'initialWorkspaceRoots'
  >;
  persistence?: ArtifactRegistryPersistence;
}

interface ArtifactCandidate {
  path: string;
  classification: ArtifactClassification;
}

interface ArtifactEventMutation {
  changed: boolean;
  presented: SDKArtifactInfo[];
  changedArtifacts: SDKArtifactInfo[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function countPatchChanges(hunks: readonly StructuredPatchHunk[]): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) additions++;
      else if (line.startsWith('-')) deletions++;
    }
  }
  return { additions, deletions };
}

function countContentLines(content: string): number {
  if (content.length === 0) return 0;
  const lineCount = content.split('\n').length;
  return content.endsWith('\n') ? lineCount - 1 : lineCount;
}

function extractRootArtifactChanges(event: unknown): ArtifactCandidate[] {
  const envelope = isRecord(event) ? event : undefined;
  if (!envelope || envelope['type'] !== 'user') return [];
  if (
    envelope['parent_tool_use_id'] !== undefined &&
    envelope['parent_tool_use_id'] !== null &&
    envelope['parent_tool_use_id'] !== ''
  ) {
    return [];
  }

  const message = isRecord(envelope['message'])
    ? envelope['message']
    : undefined;
  const content = message?.['content'];
  if (!Array.isArray(content)) return [];
  const resultBlocks = content.filter(
    (block) => isRecord(block) && block['type'] === 'tool_result',
  );
  if (resultBlocks.length === 0) return [];

  const candidates: ArtifactCandidate[] = [];
  for (const [index, block] of resultBlocks.entries()) {
    if (block['is_error'] === true) continue;
    const result = selectToolResultSideChannel(
      envelope['toolUseResult'],
      index,
      resultBlocks.length,
    );
    if (isFileWriteResult(result)) {
      const patchChanges = countPatchChanges(result.structuredPatch);
      const isNew =
        result.originalFile === null || result.originalFile.length === 0;
      candidates.push({
        path: result.filePath,
        classification: {
          kind: 'changed',
          additions: isNew
            ? countContentLines(result.content)
            : patchChanges.additions,
          deletions: isNew ? 0 : patchChanges.deletions,
          is_new: isNew,
        },
      });
    } else if (isFileEditResult(result)) {
      const patchChanges = countPatchChanges(result.structuredPatch);
      candidates.push({
        path: result.filePath,
        classification: {
          kind: 'changed',
          additions: patchChanges.additions,
          deletions: patchChanges.deletions,
          is_new: result.originalFile.length === 0,
        },
      });
    } else if (isImageGenResult(result)) {
      candidates.push({
        path: result.filePath,
        classification: {
          kind: 'changed',
          additions: 0,
          deletions: 0,
          is_new: true,
        },
      });
    } else if (
      isRecord(result) &&
      result['type'] === 'present_files' &&
      result['isHardFailure'] === false &&
      Array.isArray(result['files'])
    ) {
      for (const file of result['files']) {
        const filePath = isRecord(file)
          ? asString(file['file_path'])
          : undefined;
        if (filePath === undefined) continue;
        candidates.push({
          path: filePath,
          classification: { kind: 'presented' },
        });
      }
    } else if (
      isCompactFileToolResult(result) &&
      !isRecord(
        selectToolResultSideChannel(
          envelope['mcpMeta'],
          index,
          resultBlocks.length,
        ),
      )
    ) {
      candidates.push({
        path: result.file_path,
        classification: {
          kind: 'changed',
          additions: result.additions,
          deletions: result.deletions,
          is_new: false,
        },
      });
    }
  }
  return candidates;
}

export class ArtifactRegistry {
  private readonly persistence?: ArtifactRegistryPersistence;
  private referenceResolver: ArtifactReferenceResolver;
  private workspaceKey: string;
  private readonly entries = new Map<string, SDKArtifactInfo>();
  private mutationTail: Promise<void> = Promise.resolve();
  private coveredToolResultUuids = new Set<string>();

  constructor(private readonly options: ArtifactRegistryOptions) {
    this.persistence = options.persistence;
    this.referenceResolver = new ArtifactReferenceResolver(options);
    this.workspaceKey = JSON.stringify([
      options.workingDirectory,
      options.initialWorkspaceRoots,
    ]);
  }

  snapshot(): SDKArtifactInfo[] {
    return [...this.entries.values()].map(cloneArtifactEntry);
  }

  async initialize(
    historicalEvents: readonly unknown[] = [],
  ): Promise<SDKArtifactInfo[] | null> {
    return this.withMutationLock(async () => {
      let parsed: ParsedArtifactRegistryState = {
        state: 'known',
        records: [],
      };
      if (this.persistence) {
        let stored: unknown;
        try {
          stored = await this.persistence.load();
        } catch {
          return null;
        }
        parsed = parseArtifactRegistryState(stored);
      }
      if (parsed.state === 'unknown') return null;

      const previousEntries = this.cloneEntries();
      const previousCoverage = this.coveredToolResultUuids;
      try {
        this.coveredToolResultUuids = new Set(parsed.coveredToolResultUuids);
        let persistenceNeedsRewrite = false;
        const persistedPresentedPaths = new Set<string>();
        for (const record of parsed.records) {
          const entry = await this.referenceResolver.resolveCandidate(
            record.path,
            record.classification,
          );
          if (!entry) {
            persistenceNeedsRewrite = true;
            continue;
          }
          if (this.entries.has(entry.path)) {
            persistenceNeedsRewrite = true;
            continue;
          }
          this.entries.set(entry.path, entry);
          if (entry.kind === 'presented') {
            persistedPresentedPaths.add(entry.path);
          }
          if (entry.path !== record.path) {
            persistenceNeedsRewrite = true;
          }
        }

        let historyChanged = false;
        for (const event of historicalEvents) {
          // The restored snapshot supersedes only these historical tool results.
          // observeEvent still processes every new live result normally.
          const uuid = isRecord(event) ? event['uuid'] : undefined;
          if (typeof uuid === 'string' && this.coveredToolResultUuids.has(uuid))
            continue;
          historyChanged =
            (await this.addEvent(event, persistedPresentedPaths)).changed ||
            historyChanged;
        }

        if (this.persistence && (persistenceNeedsRewrite || historyChanged)) {
          await this.persist();
        }

        return this.snapshot();
      } catch (error) {
        this.restoreEntries(previousEntries);
        this.coveredToolResultUuids = previousCoverage;
        throw error;
      }
    });
  }

  async processEvent(event: unknown): Promise<SDKArtifactInfo[] | null> {
    const observation = await this.observeEvent(event);
    return observation?.snapshot ?? null;
  }

  async observeEvent(
    event: unknown,
  ): Promise<ArtifactRegistryObservation | null> {
    return this.withMutationLock(async () => {
      const previousEntries = this.cloneEntries();
      try {
        const mutation = await this.addEvent(event);
        if (!mutation.changed && mutation.presented.length === 0) return null;
        if (mutation.changed) {
          await this.persist();
        }
        return {
          snapshot: mutation.changed ? this.snapshot() : null,
          presented: mutation.presented,
          changedArtifacts: mutation.changedArtifacts,
        };
      } catch (error) {
        this.restoreEntries(previousEntries);
        throw error;
      }
    });
  }

  /**
   * Explicitly presents an exact set of files selected by the root agent.
   *
   * Validation is all-or-nothing: a missing or non-file path rejects the call
   * without adding any of the requested files. Unlike automatic discovery, an
   * explicit delivery may register any regular file. A complete snapshot is
   * returned even when every entry was already registered so the remote index
   * can be flushed before the corresponding tool result.
   */
  async present(
    paths: readonly string[],
    options: ArtifactPresentationOptions = {},
  ): Promise<ArtifactRegistryObservation> {
    return this.withMutationLock(async () => {
      const previousEntries = this.cloneEntries();
      try {
        const presented = new Map<string, SDKArtifactInfo>();
        const rejectedPaths: string[] = [];
        for (const pathname of new Set(paths)) {
          const candidate =
            this.referenceResolver.localPresentationCandidateFromHref(pathname);
          const entry =
            candidate === undefined
              ? undefined
              : await this.referenceResolver.resolveCandidate(candidate);
          if (!entry) {
            rejectedPaths.push(pathname);
            continue;
          }
          presented.set(entry.path, entry);
        }
        if (rejectedPaths.length > 0) {
          throw new ArtifactPresentationError(rejectedPaths);
        }

        let changed = await this.revalidateEntries();
        for (const superseded of options.supersededArtifacts ?? []) {
          if (presented.has(superseded.path)) continue;
          const existing = this.entries.get(superseded.path);
          if (existing?.kind === 'changed' && sameEntry(existing, superseded)) {
            this.entries.delete(superseded.path);
            changed = true;
          }
        }
        for (const entry of presented.values()) {
          const existing = this.entries.get(entry.path);
          if (!existing || !sameEntry(existing, entry)) {
            this.entries.set(entry.path, entry);
            changed = true;
          }
        }
        if (changed) {
          await this.persist();
        }
        return {
          snapshot: this.snapshot(),
          presented: [...presented.values()].map(cloneArtifactEntry),
          changedArtifacts: [],
        };
      } catch (error) {
        this.restoreEntries(previousEntries);
        throw error;
      }
    });
  }

  /**
   * Validates an App-owned full snapshot without replacing the CLI registry.
   * Workspace presentation fields and classifications are retained, while
   * external display fields, canonical paths, and file metadata come from
   * Worker filesystem validation.
   */
  async validateExternalSnapshot(
    artifacts: readonly SDKArtifactInfo[],
    options: { readonly skipMissingFiles?: boolean } = {},
  ): Promise<SDKArtifactInfo[]> {
    return this.withMutationLock(async () => {
      const resolved: SDKArtifactInfo[] = [];
      const rejectedPaths: string[] = [];
      const canonicalPaths = new Set<string>();
      for (const artifact of artifacts) {
        // App snapshots carry absolute filesystem paths, not Markdown hrefs.
        // Resolve the value literally so legal filename characters such as
        // "%" and "#" are not decoded or rejected as URL syntax.
        const entry = await this.referenceResolver.resolveCandidate(
          artifact.path,
          classificationFromArtifactEntry(artifact),
          { allowUnknownMime: true },
        );
        if (!entry && options.skipMissingFiles) {
          // Recovery must not block a Session because an old file was deleted.
          // Only ENOENT is omitted; invalid paths, non-files and access errors
          // still follow the existing snapshot rejection path below.
          try {
            await stat(artifact.path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          }
        }
        if (!entry || canonicalPaths.has(entry.path)) {
          rejectedPaths.push(artifact.path);
          continue;
        }
        canonicalPaths.add(entry.path);
        const isWorkspaceArtifact = entry.relative_path !== undefined;
        const relativePath = isWorkspaceArtifact
          ? (artifact.relative_path ?? entry.relative_path)
          : undefined;
        // The Worker owns file access and upload consistency. Keep App-owned
        // presentation metadata for workspace files, but refresh filesystem
        // metadata from stat so stale callback values cannot affect uploads.
        const size = entry.size;
        const mime = artifact.mime ?? entry.mime;
        const mtime = entry.mtime;
        resolved.push({
          ...entry,
          display_path: isWorkspaceArtifact
            ? artifact.display_path
            : entry.display_path,
          name: isWorkspaceArtifact ? artifact.name : entry.name,
          ...(artifact.group ? { group: { ...artifact.group } } : {}),
          ...(relativePath !== undefined
            ? { relative_path: relativePath }
            : {}),
          ...(size !== undefined ? { size } : {}),
          ...(mime !== undefined ? { mime } : {}),
          ...(mtime !== undefined ? { mtime } : {}),
          ...classificationFromArtifactEntry(artifact),
        });
      }
      if (rejectedPaths.length > 0) {
        throw new ArtifactPresentationError(rejectedPaths);
      }
      return resolved;
    });
  }

  async revalidate(pathname: string): Promise<
    | { status: 'not_registered' | 'unchanged' }
    | {
        status: 'changed' | 'unavailable';
        snapshot: SDKArtifactInfo[];
      }
  > {
    return this.withMutationLock(async () => {
      const existing = this.entries.get(pathname);
      if (!existing) {
        return { status: 'not_registered' };
      }

      const previousEntries = this.cloneEntries();
      try {
        const refreshed = await this.referenceResolver.resolveCandidate(
          pathname,
          classificationFromArtifactEntry(existing),
        );
        if (!refreshed || refreshed.path !== pathname) {
          this.entries.delete(pathname);
          await this.persist();
          return { status: 'unavailable', snapshot: this.snapshot() };
        }
        if (sameEntry(existing, refreshed)) {
          return { status: 'unchanged' };
        }
        this.entries.set(pathname, refreshed);
        await this.persist();
        return { status: 'changed', snapshot: this.snapshot() };
      } catch (error) {
        this.restoreEntries(previousEntries);
        throw error;
      }
    });
  }

  get(pathname: string): RegisteredArtifact | undefined {
    const entry = this.entries.get(pathname);
    return entry ? { entry: cloneArtifactEntry(entry) } : undefined;
  }

  private async addEvent(
    event: unknown,
    persistedPresentedPaths?: ReadonlySet<string>,
  ): Promise<ArtifactEventMutation> {
    const changedCandidates = extractRootArtifactChanges(event).flatMap(
      (candidate) => {
        const localPath =
          candidate.classification.kind === 'presented'
            ? this.referenceResolver.localPresentationCandidateFromHref(
                candidate.path,
              )
            : this.referenceResolver.localCandidateFromHref(candidate.path);
        return localPath === undefined
          ? []
          : [{ ...candidate, path: localPath }];
      },
    );
    if (changedCandidates.length === 0) {
      return { changed: false, presented: [], changedArtifacts: [] };
    }

    let changed = await this.revalidateEntries();
    const presented = new Map<string, SDKArtifactInfo>();
    const changedArtifacts = new Map<string, SDKArtifactInfo>();
    for (const candidate of changedCandidates) {
      const entry = await this.referenceResolver.resolveCandidate(
        candidate.path,
        candidate.classification,
      );
      if (!entry) continue;
      const existing = this.entries.get(entry.path);
      if (
        candidate.classification.kind === 'changed' &&
        existing?.kind === 'presented' &&
        persistedPresentedPaths?.has(entry.path)
      ) {
        continue;
      }
      if (!existing) {
        this.entries.set(entry.path, entry);
        if (entry.kind === 'presented') {
          presented.set(entry.path, entry);
        } else {
          changedArtifacts.set(entry.path, entry);
        }
        changed = true;
        continue;
      }
      if (!sameEntry(existing, entry)) {
        this.entries.set(entry.path, entry);
        if (entry.kind === 'presented') {
          presented.set(entry.path, entry);
        } else {
          changedArtifacts.set(entry.path, entry);
        }
        changed = true;
      }
    }
    return {
      changed,
      presented: [...presented.values()].map(cloneArtifactEntry),
      changedArtifacts: [...changedArtifacts.values()].map(cloneArtifactEntry),
    };
  }

  private async revalidateEntries(): Promise<boolean> {
    let changed = false;
    for (const [canonicalPath, existing] of this.entries) {
      const refreshed = await this.referenceResolver.resolveCandidate(
        canonicalPath,
        classificationFromArtifactEntry(existing),
      );
      if (!refreshed || refreshed.path !== canonicalPath) {
        this.entries.delete(canonicalPath);
        changed = true;
        continue;
      }
      if (!sameEntry(existing, refreshed)) {
        this.entries.set(canonicalPath, refreshed);
        changed = true;
      }
    }
    return changed;
  }

  private async persist(): Promise<void> {
    if (!this.persistence) return;
    await this.persistence.save(
      serializeArtifactRegistryState(this.snapshot(), [
        ...this.coveredToolResultUuids,
      ]),
    );
  }

  private async withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const workspace = this.options.getWorkspace?.();
      if (workspace) {
        const workspaceKey = JSON.stringify([
          workspace.workingDirectory,
          workspace.initialWorkspaceRoots,
        ]);
        if (workspaceKey !== this.workspaceKey) {
          // 同一次异步操作复用同一份解析上下文；目录未变化时不重复 realpath。
          this.referenceResolver = new ArtifactReferenceResolver(workspace);
          this.workspaceKey = workspaceKey;
        }
      }
      return await operation();
    } finally {
      release();
    }
  }

  private cloneEntries(): Map<string, SDKArtifactInfo> {
    const cloned = new Map<string, SDKArtifactInfo>();
    for (const [canonicalPath, entry] of this.entries) {
      cloned.set(canonicalPath, cloneArtifactEntry(entry));
    }
    return cloned;
  }

  private restoreEntries(entries: Map<string, SDKArtifactInfo>): void {
    this.entries.clear();
    for (const [canonicalPath, entry] of entries) {
      this.entries.set(canonicalPath, entry);
    }
  }
}

function sameEntry(left: SDKArtifactInfo, right: SDKArtifactInfo): boolean {
  const sameMetadata =
    left.path === right.path &&
    left.display_path === right.display_path &&
    left.name === right.name &&
    left.kind === right.kind &&
    left.group?.key === right.group?.key &&
    left.group?.name === right.group?.name &&
    left.relative_path === right.relative_path &&
    left.size === right.size &&
    left.mime === right.mime &&
    left.mtime === right.mtime;
  if (!sameMetadata || left.kind !== right.kind) return false;
  if (left.kind === 'changed' && right.kind === 'changed') {
    return (
      left.additions === right.additions &&
      left.deletions === right.deletions &&
      left.is_new === right.is_new
    );
  }
  return true;
}
