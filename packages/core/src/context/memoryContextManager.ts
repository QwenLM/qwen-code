/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  loadJitSubdirectoryMemory,
  concatenateInstructions,
  getGlobalMemoryPaths,
  getEnvironmentMemoryPaths,
  readMemoryMdFiles,
  categorizeAndConcatenate,
  filterExcludedMemoryPaths,
  isAgentsMdExcluded,
  resolveExcludePatterns,
  extractFrontmatterGlobs,
  getEnvironmentModelDecisionRuleEntries,
  getUserModelDecisionRuleEntries,
  type MemoryFileContent,
  type FailedMemoryFileInfo,
  deduplicatePathsByFileIdentity,
  getLargeMemoryFiles,
  getFailedMemoryFiles,
  loadRuleFileStates,
  loadStaticMemoryFileStates,
  renderModelDecisionRuleEntries,
  type RuleFileState,
  type StaticMemoryFileState,
} from '../utils/memoryDiscovery.js';
import type {
  BlockedExternalImport,
  FailedImport,
} from '../utils/memoryImportProcessor.js';
import type { Config } from '../config/config.js';
import { resolveWorktreeResourcePath } from '../services/worktree/pathIdentity.js';
import { coreEvents, CoreEvent } from '../utils/events.js';
import { runLogger } from '../utils/runLogger.js';
import { inferEntrySurface } from '../utils/entry-surface.js';
import { renderUserMemory } from '../prompts/snippets.js';
import { HookEventName, type InstructionsLoadReason } from '../hooks/types.js';
import { OutputFormat } from '../output/types.js';
import {
  getAgentsMdSizePolicy,
  onAgentsMdSizePolicyChanged,
} from '../config-service/features/agentsMdSizePolicy.js';
import {
  measureAgentsMdSize,
  evaluateAgentsMdSize,
  type AgentsMdSizeSnapshot,
} from '../utils/agentsMdSize.js';
import {
  getScopedAutoMemoryDirs,
} from '../memory/structured-memory-store.js';
import {
  loadScopedMemoryIndexFileStates,
  renderScopedMemoryIndexFileStates,
  type ScopedMemoryIndexFileState,
} from '../memory/memory-index.js';



import * as path from 'node:path';
import type { Message } from '../protocol/transcript/message.js';
import { getCurrentLocalDate } from '../utils/date.js';
import { raceWithAbortSignal } from '../utils/abort-race.js';


/**
 * Resolves the effective load reason and optional globs for a memory file.
 * Files with `paths:` frontmatter use 'path_glob_match'; others use the fallback.
 */
function resolveLoadReason(
  content: string | null | undefined,
  fallback: InstructionsLoadReason,
): { loadReason: InstructionsLoadReason; globs?: string[] } {
  const globs = content ? extractFrontmatterGlobs(content) : undefined;
  return globs
    ? { loadReason: 'path_glob_match', globs }
    : { loadReason: fallback };
}

/** Optional observation supplied by the caller; memory owns no startup/logging policy. */
type MemoryOperationObserver = <T>(
  name: string,
  action: () => Promise<T>,
) => Promise<T>;

const runMemoryOperation: MemoryOperationObserver = (_name, action) => action();

interface MemoryPathSet {
  global: string[];
  plugin: string[];
  project: string[];
  local: string[];
}

interface MemoryRefreshSnapshot {
  loadedPaths: string[];
  loadedFileIdentities: string[];
  hookFiredPaths: string[];
  globalMemory: string;
  pluginMemory: string;
  projectMemory: string;
  localMemory: string;
  jitMemory: string;
  autoMemoryIndexContent: string;
  autoMemoryIndexFileStates: ScopedMemoryIndexFileState[];
  ruleFileStates: RuleFileState[];
  staticMemoryFileStates: StaticMemoryFileState[];
  modelDecisionRuleIndexContent: string;
  failedFiles: FailedMemoryFileInfo[];
  pendingExternalImports: BlockedExternalImport[];
  filesWithExternalImports: string[];
  lastPaths: MemoryPathSet | null;
  cachedUserContext: Record<string, string> | null;
}

export class MemoryContextManager {
  private readonly loadedPaths: Set<string> = new Set();
  private readonly loadedFileIdentities: Set<string> = new Set();
  /** Tracks paths for which InstructionsLoaded hook has already fired.
   *  Persists across ordinary refresh() calls to deduplicate hook triggers.
   *  Compact refreshes reset it inside their queued transaction. */
  private readonly hookFiredPaths: Set<string> = new Set();
  private readonly config: Config;
  private readonly isExternalImportApproved: () => boolean;
  private sessionExternalImportApproved = false;
  private globalMemory: string = '';
  private pluginMemory: string = '';
  private projectMemory: string = '';
  private localMemory: string = '';
  private jitMemory: string = '';
  /** Rendered auto-memory MEMORY.md index block (all active scope roots,
   *  scope-labeled, each naming its absolute path), loaded once during
   *  refresh() and frozen until the next refresh — the startup baseline.
   *  In-session edits to MEMORY.md are surfaced through normal readFileState
   *  changed-file detection after the index files are seeded there. */
  private autoMemoryIndexContent: string = '';
  /** Raw startup file states for the same MEMORY.md files, used only to seed
   *  readFileState so mid-session index writes become edited_text_file. */
  private autoMemoryIndexFileStates: ScopedMemoryIndexFileState[] = [];
  /** Raw startup file states for project rule files (`.qwen/rules/*.md`).
   *  Like autoMemoryIndexFileStates, these are seeded into readFileState so
   *  mid-session rule edits surface as edited_text_file — rule content is
   *  otherwise frozen at startup via prependUserContext(). */
  private ruleFileStates: RuleFileState[] = [];
  /** Raw startup file states for static AGENTS-style memory files.
   *  Seeded into readFileState so external edits to startup-loaded AGENTS.md
   *  flow through the same edited_text_file path as JIT-loaded memory. */
  private staticMemoryFileStates: StaticMemoryFileState[] = [];
  private modelDecisionRuleIndexContent: string = '';
  private failedFiles: FailedMemoryFileInfo[] = [];
  private pendingExternalImports: BlockedExternalImport[] = [];
  private filesWithExternalImports: string[] = [];
  private lastPaths: MemoryPathSet | null = null;
  /** JIT-discovered nested memory paths tracked separately from lastPaths so
   *  that tier-only callers (e.g. nested/relevant memory generator seeding)
   *  remain unaffected while the Memory management UI can still surface them. */
  private jitDiscoveredPaths: { project: string[]; local: string[] } = {
    project: [],
    local: [],
  };
  /** Memoized user context for prependUserContext injection. Cleared on refresh(). */
  private cachedUserContext: Record<string, string> | null = null;
  /**
   * Date embedded in the stable startup context. It intentionally survives
   * memory refreshes; live date changes are delivered by date_change
   * attachments without invalidating the cached prompt prefix.
   */
  private startupDate: string | undefined;
  /** Serializes async state mutations so a failed rollback cannot clobber newer state. */
  private stateMutationTail: Promise<void> = Promise.resolve();
  private agentsMdSizeSnapshot: AgentsMdSizeSnapshot | undefined;
  private unsubscribeAgentsMdSizePolicy?: () => void;
  private disposed = false;

  constructor(config: Config, isExternalImportApproved?: () => boolean) {
    this.config = config;
    this.isExternalImportApproved = isExternalImportApproved ?? (() => false);
    if (this.isAgentsMdSizeEnabled()) {
      this.unsubscribeAgentsMdSizePolicy = onAgentsMdSizePolicyChanged(
        (policy) => {
          void this.enqueueStateMutation(async () => {
            if (!this.disposed && this.agentsMdSizeSnapshot) {
              this.publishAgentsMdSize(
                evaluateAgentsMdSize(
                  this.agentsMdSizeSnapshot,
                  policy,
                  'qcs_update',
                ),
                this.agentsMdSizeSnapshot.thresholdBytes !==
                  policy.projectDocMaxBytes,
              );
            }
          }).catch((error) =>
            runLogger.warn('[AGENTS.md size] Policy evaluation failed', error),
          );
        },
      );
    }
  }

  private isAgentsMdSizeEnabled(): boolean {
    const surface = inferEntrySurface(this.config);
    return (
      surface !== 'acp' &&
      surface !== 'remote_worker' &&
      (this.config.isInteractive?.() === true ||
        this.config.getOutputFormat?.() === OutputFormat.STREAM_JSON)
    );
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribeAgentsMdSizePolicy?.();
    this.unsubscribeAgentsMdSizePolicy = undefined;
  }

  getAgentsMdSizeSnapshot(): AgentsMdSizeSnapshot | undefined {
    return this.agentsMdSizeSnapshot;
  }

  private publishAgentsMdSize(
    snapshot: AgentsMdSizeSnapshot,
    notifyWarning = true,
  ): void {
    if (this.disposed) return;
    this.agentsMdSizeSnapshot = snapshot;
    coreEvents.emit(CoreEvent.AgentsMdSizeEvaluated, {
      sessionId: this.config.getSessionId(),
      snapshot,
      notifyWarning,
    });

  }

  private async refreshAgentsMdSize(notifyWarning: boolean): Promise<void> {
    if (!this.isAgentsMdSizeEnabled()) return;
    const sources = this.config.getAllowedAgentSources();
    const excludes = resolveExcludePatterns([
      ...this.config.getAgentsMdExcludes(),
    ]);
    const measurement = await measureAgentsMdSize({
      cwd: this.resolveMemoryPath(this.config.getTargetDir()),
      boundaryMarkers: this.config.getMemoryBoundaryMarkers(),
      fallbackFilenames: this.config.getAllContextFileNames(),
      allowed:
        this.config.isTrustedFolder() &&
        (!sources || sources.includes('project')),
      isExcluded: (file) => isAgentsMdExcluded(file, excludes),
    });
    this.publishAgentsMdSize(
      evaluateAgentsMdSize(
        measurement,
        getAgentsMdSizePolicy(),
        this.agentsMdSizeSnapshot ? 'refresh' : 'startup',
      ),
      // An internal refresh may win the startup race: the first measurement
      // must still notify, regardless of which refresh entry reached it first.
      !this.agentsMdSizeSnapshot || notifyWarning,
    );
  }

  /**
   * Refreshes the memory by reloading global, extension, and project memory.
   * Internal context updates may suppress only the new size notification;
   * measurement, diagnostics and existing memory warnings are unchanged.
   */
  refresh(
    loadReason: InstructionsLoadReason = 'session_start',
    options: {
      notifyAgentsMdSizeWarning?: boolean;
      observeOperation?: MemoryOperationObserver;
    } = {},
  ): Promise<void> {
    return this.enqueueStateMutation(() =>
      this.refreshTransaction(
        loadReason,
        options.notifyAgentsMdSizeWarning !== false,
        options.observeOperation,
      ),
    );
  }

  private enqueueStateMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.stateMutationTail.then(operation);
    this.stateMutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async refreshTransaction(
    loadReason: InstructionsLoadReason,
    notifyAgentsMdSizeWarning = true,
    observe: MemoryOperationObserver = runMemoryOperation,
  ): Promise<void> {
    const snapshot = this.captureRefreshSnapshot();
    if (loadReason === 'compact') {
      this.hookFiredPaths.clear();
    }
    try {
      await this.refreshUnchecked(loadReason, observe);
    } catch (error) {
      this.restoreRefreshSnapshot(snapshot);
      throw error;
    }
    // Diagnostic-only: never roll back successfully loaded instructions because size reporting failed.
    try {
      await observe('memory.measure_agents_md', () =>
        this.refreshAgentsMdSize(notifyAgentsMdSizeWarning),
      );
    } catch (error) {
      runLogger.warn('[AGENTS.md size] Measurement failed', error);
    }
  }

  private captureRefreshSnapshot(): MemoryRefreshSnapshot {
    return {
      loadedPaths: [...this.loadedPaths],
      loadedFileIdentities: [...this.loadedFileIdentities],
      hookFiredPaths: [...this.hookFiredPaths],
      globalMemory: this.globalMemory,
      pluginMemory: this.pluginMemory,
      projectMemory: this.projectMemory,
      localMemory: this.localMemory,
      jitMemory: this.jitMemory,
      autoMemoryIndexContent: this.autoMemoryIndexContent,
      autoMemoryIndexFileStates: [...this.autoMemoryIndexFileStates],
      ruleFileStates: [...this.ruleFileStates],
      staticMemoryFileStates: [...this.staticMemoryFileStates],
      modelDecisionRuleIndexContent: this.modelDecisionRuleIndexContent,
      failedFiles: [...this.failedFiles],
      pendingExternalImports: [...this.pendingExternalImports],
      filesWithExternalImports: [...this.filesWithExternalImports],
      lastPaths: this.lastPaths,
      cachedUserContext: this.cachedUserContext,
    };
  }

  private restoreRefreshSnapshot(snapshot: MemoryRefreshSnapshot): void {
    this.loadedPaths.clear();
    snapshot.loadedPaths.forEach((filePath) => this.loadedPaths.add(filePath));
    this.loadedFileIdentities.clear();
    snapshot.loadedFileIdentities.forEach((identity) =>
      this.loadedFileIdentities.add(identity),
    );
    this.hookFiredPaths.clear();
    snapshot.hookFiredPaths.forEach((filePath) =>
      this.hookFiredPaths.add(filePath),
    );
    this.globalMemory = snapshot.globalMemory;
    this.pluginMemory = snapshot.pluginMemory;
    this.projectMemory = snapshot.projectMemory;
    this.localMemory = snapshot.localMemory;
    this.jitMemory = snapshot.jitMemory;
    this.autoMemoryIndexContent = snapshot.autoMemoryIndexContent;
    this.autoMemoryIndexFileStates = snapshot.autoMemoryIndexFileStates;
    this.ruleFileStates = snapshot.ruleFileStates;
    this.staticMemoryFileStates = snapshot.staticMemoryFileStates;
    this.modelDecisionRuleIndexContent = snapshot.modelDecisionRuleIndexContent;
    this.failedFiles = snapshot.failedFiles;
    this.pendingExternalImports = snapshot.pendingExternalImports;
    this.filesWithExternalImports = snapshot.filesWithExternalImports;
    this.lastPaths = snapshot.lastPaths;
    this.cachedUserContext = snapshot.cachedUserContext;
  }

  private async refreshUnchecked(
    loadReason: InstructionsLoadReason,
    observe: MemoryOperationObserver,
  ): Promise<void> {
    // Invalidate the memoized user context so the next getUserContext() call
    // rebuilds it from the freshly loaded memory tiers.
    this.clearUserContextCache();

    // Preserve JIT-discovered nested memory state across refresh() so that
    // trust-change / MCP-context refreshes don't drop nested AGENTS.md files
    // from the Memory UI.
    // Those files have already been disclosed in the transcript via
    // relevant_memories attachments; the model still "knows" about them.
    // We re-mark them as loaded after tier discovery so the delta tracker in
    // getRelevantMemoriesAttachments continues to treat them as seen.
    const preservedJitPaths = [
      ...this.jitDiscoveredPaths.project,
      ...this.jitDiscoveredPaths.local,
    ];

    this.loadedPaths.clear();
    this.loadedFileIdentities.clear();
    this.pendingExternalImports = [];
    this.filesWithExternalImports = [];
    this.jitMemory = '';
    this.staticMemoryFileStates = [];

    const rawPaths = await observe('memory.discover_paths', () =>
      this.discoverMemoryPaths(),
    );
    const paths = filterExcludedMemoryPaths(rawPaths, [
      ...this.config.getAgentsMdExcludes(),
    ]);
    this.lastPaths = paths;
    const { contentsMap, allContents, importParentMap } = await observe(
      'memory.read_contents',
      () => this.loadMemoryContents(paths),
    );

    this.categorizeMemoryContents(paths, contentsMap);

    // Capture raw on-disk state for rule files (project `.qwen/rules/*.md` and
    // eager user-scope `~/.qwen/rules/*.md`) so mid-session edits flow through
    // the same edited_text_file path as MEMORY.md (seeded into readFileState by
    // seedStaticMemoryPaths). Their injected content is otherwise frozen for the
    // session. Non-rule paths are filtered out inside loadRuleFileStates.
    this.ruleFileStates = await observe('memory.load_rules', () =>
      loadRuleFileStates([...paths.global, ...paths.project], contentsMap),
    );
    this.staticMemoryFileStates = await observe(
      'memory.load_static_state',
      () => loadStaticMemoryFileStates([...this.loadedPaths], contentsMap),
    );

    this.modelDecisionRuleIndexContent = await observe(
      'memory.load_rule_index',
      () => this.loadModelDecisionRuleIndex(),
    );

    await observe('memory.load_auto_memory_index', () =>
      this.loadAutoMemoryIndex(),
    );

    // Re-add preserved JIT paths to loadedPaths. jitDiscoveredPaths itself
    // was kept untouched above — Memory UI will continue to surface them.
    for (const p of preservedJitPaths) {
      this.loadedPaths.add(p);
    }

    const largeFiles = getLargeMemoryFiles(allContents);
    this.failedFiles = getFailedMemoryFiles(allContents);
    this.emitMemoryChanged(largeFiles, this.failedFiles);

    // Emit warnings for blocked external imports.
    // Note: failed @import warnings (e.g. ENOENT) are intentionally NOT surfaced
    // to the TUI on load/refresh — npm scoped-package mentions like
    // `@scope/pkg/file.js` get misread as file imports and produce noisy false
    // positives. They are still recorded in debug logs.
    this.emitBlockedExternalImportWarning(this.pendingExternalImports);

    // Fire InstructionsLoaded hook for each loaded file (fire-and-forget, observability only)
    this.fireInstructionsLoadedHooks(
      paths,
      contentsMap,
      loadReason,
      importParentMap,
    );

  }

  private resolveMemoryPath(filePath: string): string {
    return resolveWorktreeResourcePath(
      filePath,
      this.config.getWorktreeSettings(),
    );
  }

  private async discoverMemoryPaths() {
    const allowedSources = this.config.getAllowedAgentSources();
    const isAllowed = (source: 'user' | 'project' | 'plugin'): boolean =>
      !allowedSources || allowedSources.includes(source);

    const [global, envResult] = await Promise.all([
      isAllowed('user')
        ? getGlobalMemoryPaths(this.config.getAllContextFileNames())
        : Promise.resolve([]),
      isAllowed('project') && this.config.isTrustedFolder()
        ? getEnvironmentMemoryPaths(
            this.config
              .getWorkspaceContext()
              .getDirectories()
              .map((directory) => this.resolveMemoryPath(directory)),
            this.config.getAllContextFileNames(),
            this.config.getMemoryBoundaryMarkers(),
            this.resolveMemoryPath(this.config.getTargetDir()),
          )
        : Promise.resolve({ project: [] as string[], local: [] as string[] }),
    ]);

    if (allowedSources) {
      runLogger.debug(
        '[DEBUG] [MemoryDiscovery] Filtering sources by allowedAgentSources:',
        allowedSources.join(', '),
        `(global: ${global.length}, project: ${envResult.project.length})`,
      );
    }

    return {
      global,
      plugin: [],
      project: envResult.project,
      local: envResult.local,
    };
  }

  private async loadMemoryContents(paths: MemoryPathSet) {
    // Split paths into two groups:
    // 1. Global/plugin: always allow external imports
    // 2. Project/local: gate external imports behind approval
    const alwaysExternalPaths = Array.from(
      new Set([...paths.global, ...paths.plugin]),
    );
    const gatedPaths = Array.from(new Set([...paths.project, ...paths.local]));

    // Remove any overlap (global/plugin paths that also appear in project/local)
    const alwaysExternalSet = new Set(alwaysExternalPaths);
    const dedupedGatedPaths = gatedPaths.filter(
      (p) => !alwaysExternalSet.has(p),
    );

    const allPathsStringDeduped = [
      ...alwaysExternalPaths,
      ...dedupedGatedPaths,
    ];

    // deduplicate by file identity to handle case-insensitive filesystems
    const { paths: allPaths, identityMap: pathIdentityMap } =
      await deduplicatePathsByFileIdentity(allPathsStringDeduped);

    // Partition the identity-deduped paths back into the two groups
    const alwaysExternalDeduped = allPaths.filter((p) =>
      alwaysExternalSet.has(p),
    );
    const gatedDeduped = allPaths.filter((p) => !alwaysExternalSet.has(p));

    const importFormat = this.config.getImportFormat();
    const boundaryMarkers = this.config.getMemoryBoundaryMarkers();
    const contextFileNames = this.config.getAllContextFileNames();
    const externalApproved =
      this.isExternalImportApproved() || this.sessionExternalImportApproved;

    // Read both batches in parallel
    const [alwaysExternalContents, gatedContents] = await Promise.all([
      alwaysExternalDeduped.length > 0
        ? readMemoryMdFiles(
            alwaysExternalDeduped,
            importFormat,
            boundaryMarkers,
            true, // always allow external imports for global/extension/userProject
            contextFileNames,
          )
        : Promise.resolve([]),
      gatedDeduped.length > 0
        ? readMemoryMdFiles(
            gatedDeduped,
            importFormat,
            boundaryMarkers,
            externalApproved, // gate by approval status
            contextFileNames,
          )
        : Promise.resolve([]),
    ]);

    const allContents = [...alwaysExternalContents, ...gatedContents];

    // Collect blocked external imports from gated paths
    for (const content of gatedContents) {
      if (
        content.blockedExternalImports &&
        content.blockedExternalImports.length > 0
      ) {
        this.pendingExternalImports.push(...content.blockedExternalImports);
        this.filesWithExternalImports.push(content.filePath);
      }
    }

    const loadedFilePaths = allContents
      .filter((c) => c.content !== null)
      .map((c) => c.filePath);
    this.markAsLoaded(loadedFilePaths);

    // Cache file identities for performance optimization
    for (const filePath of loadedFilePaths) {
      const identity = pathIdentityMap.get(filePath);
      if (identity) {
        this.loadedFileIdentities.add(identity);
      }
    }

    // Track resolved @import paths so JIT discovery skips files already inlined
    // Also aggregate importParentMap for InstructionsLoaded 'include' hooks
    const resolvedImportPaths: string[] = [];
    const aggregatedImportParentMap = new Map<string, string>();
    for (const content of allContents) {
      if (
        content.resolvedImportPaths &&
        content.resolvedImportPaths.length > 0
      ) {
        resolvedImportPaths.push(...content.resolvedImportPaths);
      }
      if (content.importParentMap) {
        for (const [child, parent] of content.importParentMap) {
          aggregatedImportParentMap.set(child, parent);
        }
      }
    }
    if (resolvedImportPaths.length > 0) {
      this.markAsLoaded(resolvedImportPaths);
      const { identityMap: importIdentityMap } =
        await deduplicatePathsByFileIdentity(resolvedImportPaths);
      for (const identity of importIdentityMap.values()) {
        this.loadedFileIdentities.add(identity);
      }
    }

    return {
      contentsMap: new Map(allContents.map((c) => [c.filePath, c])),
      allContents,
      importParentMap: aggregatedImportParentMap,
    };
  }

  private categorizeMemoryContents(
    paths: MemoryPathSet,
    contentsMap: Map<string, MemoryFileContent>,
  ) {
    const hierarchicalMemory = categorizeAndConcatenate(paths, contentsMap);

    this.globalMemory = hierarchicalMemory.global || '';
    this.pluginMemory = hierarchicalMemory.plugin || '';
    this.localMemory = hierarchicalMemory.local || '';

    // MCP instructions are now injected via delta attachments
    // (mcp_instructions_delta) instead of being baked into project memory.
    // See packages/core/src/attachments/generators/mcp-generators.ts
    this.projectMemory = this.config.isTrustedFolder()
      ? hierarchicalMemory.project || ''
      : '';
  }

  /**
   * Read the auto-memory MEMORY.md of every active scope root once and freeze
   * the rendered block for prependUserContext() injection. No-op when
   * auto-memory is disabled or all indexes are missing/empty.
   */
  private async loadAutoMemoryIndex(): Promise<void> {
    this.autoMemoryIndexContent = '';
    this.autoMemoryIndexFileStates = [];
    if (!this.config.isAutoMemoryConsumptionEnabled?.()) return;
    if (!this.config.storage) return;

    this.autoMemoryIndexFileStates = await loadScopedMemoryIndexFileStates(
      getScopedAutoMemoryDirs(this.config),
    );
    this.autoMemoryIndexContent = renderScopedMemoryIndexFileStates(
      this.autoMemoryIndexFileStates,
    );
  }

  private async loadModelDecisionRuleIndex(): Promise<string> {
    const allowedSources = this.config.getAllowedAgentSources();
    const isAllowed = (source: 'user' | 'project'): boolean =>
      !allowedSources || allowedSources.includes(source);

    const [userRules, rawProjectRules] = await Promise.all([
      isAllowed('user')
        ? getUserModelDecisionRuleEntries()
        : Promise.resolve([]),
      isAllowed('project') && this.config.isTrustedFolder()
        ? getEnvironmentModelDecisionRuleEntries(
            [this.resolveMemoryPath(this.config.getTargetDir())],
            this.config.getMemoryBoundaryMarkers(),
          )
        : Promise.resolve([]),
    ]);

    const excludePatterns = [...this.config.getAgentsMdExcludes()];
    const expandedExcludes =
      excludePatterns.length > 0 ? resolveExcludePatterns(excludePatterns) : [];
    const projectRules =
      expandedExcludes.length > 0
        ? rawProjectRules.filter(
            (entry) => !isAgentsMdExcluded(entry.filePath, expandedExcludes),
          )
        : rawProjectRules;

    return renderModelDecisionRuleEntries([...userRules, ...projectRules]);
  }

  /**
   * Fire InstructionsLoaded hook for each loaded memory file (fire-and-forget, observability only).
   * Deduplicates by filePath until an explicit reset or a compact refresh.
   */
  private fireInstructionsLoadedHooks(
    paths: MemoryPathSet,
    contentsMap: Map<string, MemoryFileContent>,
    loadReason: InstructionsLoadReason = 'session_start',
    importParentMap?: Map<string, string>,
  ): void {
    const hookSystem = this.config.getHookSystem();
    if (!hookSystem) {
      return;
    }

    // Fast-path: skip entirely when no InstructionsLoaded hooks are configured
    const registry = hookSystem.getRegistry();
    if (
      registry.getHooksForEvent(HookEventName.InstructionsLoaded).length === 0
    ) {
      return;
    }

    const memoryTypeMap = new Map<string, string>();
    for (const p of paths.global) memoryTypeMap.set(p, 'User');
    for (const p of paths.plugin) memoryTypeMap.set(p, 'Managed');
    for (const p of paths.project) memoryTypeMap.set(p, 'Project');
    for (const p of paths.local) memoryTypeMap.set(p, 'Local');

    for (const [filePath, content] of contentsMap) {
      if (content.content === null) continue;
      // Dedup: skip paths that have already fired since the last reset.
      if (this.hookFiredPaths.has(filePath)) continue;
      this.hookFiredPaths.add(filePath);

      const memoryType = memoryTypeMap.get(filePath) ?? 'Project';

      const { loadReason: effectiveLoadReason, globs } = resolveLoadReason(
        content.content,
        loadReason,
      );

      const hookCall = globs
        ? hookSystem.fireInstructionsLoadedEvent(
            filePath,
            memoryType,
            effectiveLoadReason,
            { globs },
          )
        : hookSystem.fireInstructionsLoadedEvent(
            filePath,
            memoryType,
            effectiveLoadReason,
          );
      void hookCall.catch((err) =>
        runLogger.debug(
          `InstructionsLoaded hook error for ${filePath}: ${err}`,
        ),
      );
    }

    // Fire hooks for @imported child files with loadReason 'include'
    if (importParentMap && importParentMap.size > 0) {
      for (const [childPath, parentPath] of importParentMap) {
        if (this.hookFiredPaths.has(childPath)) continue;
        this.hookFiredPaths.add(childPath);

        // Imported files inherit the memoryType of their parent
        const memoryType = memoryTypeMap.get(parentPath) ?? 'Project';
        void hookSystem
          .fireInstructionsLoadedEvent(childPath, memoryType, 'include', {
            parentFilePath: parentPath,
          })
          .catch((err) =>
            runLogger.debug(
              `InstructionsLoaded hook error for imported ${childPath}: ${err}`,
            ),
          );
      }
    }
  }

  /**
   * Discovers and loads context for a specific accessed path (Tier 3 - JIT).
   * Traverses upwards from the accessed path to the project root.
   */
  discoverContext(
    accessedPath: string,
    trustedRoots: string[],
    signal?: AbortSignal,
  ): Promise<string> {
    return this.enqueueStateMutation(() =>
      raceWithAbortSignal(
        this.discoverContextUnchecked(accessedPath, trustedRoots, signal),
        signal,
      ),
    );
  }

  private async discoverContextUnchecked(
    accessedPath: string,
    trustedRoots: string[],
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted();
    if (!this.config.isTrustedFolder()) {
      return '';
    }
    const result = await loadJitSubdirectoryMemory(
      this.resolveMemoryPath(accessedPath),
      trustedRoots.map((directory) => this.resolveMemoryPath(directory)),
      new Set(this.loadedPaths),
      this.config.getAllContextFileNames(),
      new Set(this.loadedFileIdentities),
      this.config.getMemoryBoundaryMarkers(),
      this.isExternalImportApproved() || this.sessionExternalImportApproved,
    );

    signal?.throwIfAborted();
    if (result.files.length === 0) {
      this.emitBlockedExternalImportWarning(result.blockedExternalImports);
      return '';
    }

    const excludePatterns = [...this.config.getAgentsMdExcludes()];
    if (excludePatterns.length > 0) {
      const expanded = resolveExcludePatterns(excludePatterns);
      result.files = result.files.filter(
        (f) => !isAgentsMdExcluded(f.path, expanded),
      );
      if (result.files.length === 0) {
        return '';
      }
    }

    // 所有异步准备完成并确认调用仍有效后，才提交 JIT 状态和触发 Hook。
    const importIdentities = result.resolvedImportPaths?.length
      ? await deduplicatePathsByFileIdentity(result.resolvedImportPaths)
      : undefined;
    signal?.throwIfAborted();
    const newFilePaths = result.files.map((f) => f.path);
    this.markAsLoaded(newFilePaths);
    this.trackJitDiscoveredPaths(newFilePaths);

    // Fire InstructionsLoaded hook for JIT-discovered files (fire-and-forget)
    const jitHookSystem = this.config.getHookSystem();
    if (jitHookSystem) {
      const fileContentMap = new Map<string, string>();
      for (const f of result.files) {
        fileContentMap.set(f.path, f.content);
      }

      for (const filePath of newFilePaths) {
        if (this.hookFiredPaths.has(filePath)) continue;
        this.hookFiredPaths.add(filePath);

        const content = fileContentMap.get(filePath);
        const { loadReason: effectiveLoadReason, globs } = resolveLoadReason(
          content,
          'nested_traversal',
        );

        const hookCall = globs
          ? jitHookSystem.fireInstructionsLoadedEvent(
              filePath,
              'Project',
              effectiveLoadReason,
              {
                triggerFilePath: accessedPath,
                globs,
              },
            )
          : jitHookSystem.fireInstructionsLoadedEvent(
              filePath,
              'Project',
              effectiveLoadReason,
              {
                triggerFilePath: accessedPath,
              },
            );
        void hookCall.catch((err) =>
          runLogger.debug(
            `InstructionsLoaded hook error for ${filePath}: ${err}`,
          ),
        );
      }
    }

    // Fire hooks for @imported files discovered via JIT with loadReason 'include'
    if (result.importParentMap && result.importParentMap.size > 0) {
      for (const [childPath, parentPath] of result.importParentMap) {
        if (this.hookFiredPaths.has(childPath)) continue;
        this.hookFiredPaths.add(childPath);

        void this.config
          .getHookSystem()
          ?.fireInstructionsLoadedEvent(childPath, 'Project', 'include', {
            parentFilePath: parentPath,
            triggerFilePath: accessedPath,
          })
          .catch((err) =>
            runLogger.debug(
              `InstructionsLoaded hook error for imported ${childPath}: ${err}`,
            ),
          );
      }
    }

    // Cache identities for newly loaded files
    if (result.fileIdentities) {
      for (const identity of result.fileIdentities) {
        this.loadedFileIdentities.add(identity);
      }
    }

    // Track resolved @import paths from JIT-loaded files
    if (result.resolvedImportPaths && result.resolvedImportPaths.length > 0) {
      this.markAsLoaded(result.resolvedImportPaths);
      for (const identity of importIdentities?.identityMap.values() ?? []) {
        this.loadedFileIdentities.add(identity);
      }
    }

    this.emitBlockedExternalImportWarning(result.blockedExternalImports);
    this.emitFailedImportWarningFromJit(result.failedImports);
    const jitContent = concatenateInstructions(
      result.files.map((f) => ({ filePath: f.path, content: f.content })),
    );

    // Accumulate JIT content for /memory show visibility
    if (jitContent) {
      this.jitMemory = this.jitMemory
        ? `${this.jitMemory}\n${jitContent}`
        : jitContent;
    }

    // Notify UI of updated file count
    this.emitMemoryChanged();

    return jitContent;
  }

  private emitMemoryChanged(
    largeFiles?: Array<{ path: string; characterCount: number }>,
    failedFiles?: FailedMemoryFileInfo[],
  ): void {
    coreEvents.emit(CoreEvent.MemoryChanged, {
      sessionId: this.config.getSessionId(),
      fileCount: this.loadedPaths.size,
      largeFiles: largeFiles && largeFiles.length > 0 ? largeFiles : undefined,
      failedFiles:
        failedFiles && failedFiles.length > 0 ? failedFiles : undefined,
    });
  }

  private emitBlockedExternalImportWarning(
    blocked?: BlockedExternalImport[],
  ): void {
    if (!blocked || blocked.length === 0) return;
    const paths = blocked.map((b) => b.resolvedPath).join(', ');
    coreEvents.emitFeedback(
      'warning',
      `${blocked.length} external @import(s) blocked in AGENTS.md: ${paths}. ` +
        'Run with approved external imports or update settings to allow them.',
    );
  }

  private emitFailedImportWarningFromJit(failed?: FailedImport[]): void {
    if (!failed || failed.length === 0) return;
    const details = failed
      .map((f) => `${f.importPath} (from ${f.sourceFile}): ${f.error}`)
      .join('; ');
    coreEvents.emitFeedback(
      'warning',
      `${failed.length} @import(s) failed in AGENTS.md: ${details}`,
    );
  }

  getGlobalMemory(): string {
    return this.globalMemory;
  }

  getPluginMemory(): string {
    return this.pluginMemory;
  }

  /** @deprecated Alias for getPluginMemory(). */
  getExtensionMemory(): string {
    return this.pluginMemory;
  }

  getEnvironmentMemory(): string {
    return this.projectMemory;
  }

  getLocalMemory(): string {
    return this.localMemory;
  }

  getAutoMemoryIndexFileStates(): readonly ScopedMemoryIndexFileState[] {
    return this.autoMemoryIndexFileStates;
  }

  getRuleFileStates(): readonly RuleFileState[] {
    return this.ruleFileStates;
  }

  getStaticMemoryFileStates(): readonly StaticMemoryFileState[] {
    return this.staticMemoryFileStates;
  }

  /**
   * Returns a memoized user context record for prependUserContext() injection.
   * The result is cached and reused across turns within a session.
   * Cleared on refresh() (e.g. trust change, MCP context refresh).
   */
  getUserContext(): Record<string, string> {
    if (this.cachedUserContext) return this.cachedUserContext;

    const rendered = renderUserMemory({
      global: this.globalMemory,
      plugin: this.pluginMemory,
      project: this.projectMemory,
      local: this.localMemory,
    });

    const context: Record<string, string> = {};
    if (rendered.trim().length > 0) {
      context['agentsMd'] = rendered;
    }
    if (this.autoMemoryIndexContent.trim()) {
      // Already rendered with per-scope "Contents of <path> ..." headers.
      context['autoMemory'] = this.autoMemoryIndexContent.trim();
    }
    if (this.modelDecisionRuleIndexContent.trim()) {
      context['modelDecisionRules'] = this.modelDecisionRuleIndexContent.trim();
    }
    context['currentDate'] = `Today's date is ${this.getStartupDate()}.`;

    this.cachedUserContext = context;
    return context;
  }

  /** Return the immutable date used by the startup user-context prefix. */
  getStartupDate(): string {
    this.startupDate ??= getCurrentLocalDate();
    return this.startupDate;
  }

  clearUserContextCache(): void {
    this.cachedUserContext = null;
  }

  getJitMemory(): string {
    return this.jitMemory;
  }

  getJitDiscoveredPaths(): {
    project: readonly string[];
    local: readonly string[];
  } {
    return this.jitDiscoveredPaths;
  }

  getFailedFiles(): readonly FailedMemoryFileInfo[] {
    return this.failedFiles;
  }

  /**
   * Returns external imports that were blocked because they reference paths
   * outside the project root. These are only from project/local memory files.
   */
  getPendingExternalImports(): readonly BlockedExternalImport[] {
    return this.pendingExternalImports;
  }

  /**
   * Re-reads the memory files that had blocked external imports, this time
   * with includeExternal=true, and updates the memory contents accordingly.
   * Should be called after the user approves external imports.
   */
  resolveExternalImports(): Promise<void> {
    return this.enqueueStateMutation(() =>
      this.resolveExternalImportsUnchecked(),
    );
  }

  private async resolveExternalImportsUnchecked(): Promise<void> {
    if (this.filesWithExternalImports.length === 0 || !this.lastPaths) {
      return;
    }

    // Mark session-level approval so JIT discovery also allows external imports
    this.sessionExternalImportApproved = true;

    runLogger.debug(
      '[DEBUG] [MemoryContextManager] Resolving external imports for:',
      this.filesWithExternalImports.join(', '),
    );

    // Re-read only the affected files with includeExternal=true
    const affectedContents = await readMemoryMdFiles(
      this.filesWithExternalImports,
      this.config.getImportFormat(),
      this.config.getMemoryBoundaryMarkers(),
      true, // includeExternal
      this.config.getAllContextFileNames(),
    );

    // Build a new contentsMap by re-reading all paths (to ensure consistency)
    // but reuse cached contents for non-affected files
    const paths = this.lastPaths;
    this.loadedPaths.clear();
    this.loadedFileIdentities.clear();
    this.pendingExternalImports = [];
    this.filesWithExternalImports = [];

    const { contentsMap, allContents } =
      await this.loadMemoryContentsWithOverrides(paths, affectedContents);

    this.categorizeMemoryContents(paths, contentsMap);
    this.clearUserContextCache();

    const largeFiles = getLargeMemoryFiles(allContents);
    this.failedFiles = getFailedMemoryFiles(allContents);
    this.emitMemoryChanged(largeFiles, this.failedFiles);
  }

  /**
   * Loads memory contents, but overrides specific file contents with
   * pre-loaded results (used during external import resolution).
   */
  private async loadMemoryContentsWithOverrides(
    paths: MemoryPathSet,
    overrides: MemoryFileContent[],
  ) {
    const overrideMap = new Map(overrides.map((c) => [c.filePath, c]));

    const alwaysExternalPaths = Array.from(
      new Set([...paths.global, ...paths.plugin]),
    );
    const gatedPaths = Array.from(new Set([...paths.project, ...paths.local]));
    const alwaysExternalSet = new Set(alwaysExternalPaths);
    const dedupedGatedPaths = gatedPaths.filter(
      (p) => !alwaysExternalSet.has(p),
    );
    const allPathsStringDeduped = [
      ...alwaysExternalPaths,
      ...dedupedGatedPaths,
    ];

    const { paths: allPaths, identityMap: pathIdentityMap } =
      await deduplicatePathsByFileIdentity(allPathsStringDeduped);

    // Split into overridden vs non-overridden
    const pathsToRead = allPaths.filter((p) => !overrideMap.has(p));
    const overriddenPaths = allPaths.filter((p) => overrideMap.has(p));

    // Read non-overridden paths (all with includeExternal=true since user approved)
    const freshContents =
      pathsToRead.length > 0
        ? await readMemoryMdFiles(
            pathsToRead,
            this.config.getImportFormat(),
            this.config.getMemoryBoundaryMarkers(),
            true, // includeExternal since user approved
            this.config.getAllContextFileNames(),
          )
        : [];

    // Combine overrides with fresh reads
    const allContents = [
      ...overriddenPaths.map((p) => overrideMap.get(p)!),
      ...freshContents,
    ];

    const loadedFilePaths = allContents
      .filter((c) => c.content !== null)
      .map((c) => c.filePath);
    this.markAsLoaded(loadedFilePaths);

    for (const filePath of loadedFilePaths) {
      const identity = pathIdentityMap.get(filePath);
      if (identity) {
        this.loadedFileIdentities.add(identity);
      }
    }

    // Track resolved @import paths so JIT discovery skips files already inlined
    const resolvedImportPaths: string[] = [];
    for (const content of allContents) {
      if (
        content.resolvedImportPaths &&
        content.resolvedImportPaths.length > 0
      ) {
        resolvedImportPaths.push(...content.resolvedImportPaths);
      }
    }
    if (resolvedImportPaths.length > 0) {
      this.markAsLoaded(resolvedImportPaths);
      const { identityMap: importIdentityMap } =
        await deduplicatePathsByFileIdentity(resolvedImportPaths);
      for (const identity of importIdentityMap.values()) {
        this.loadedFileIdentities.add(identity);
      }
    }

    return {
      contentsMap: new Map(allContents.map((c) => [c.filePath, c])),
      allContents,
    };
  }

  private markAsLoaded(paths: string[]): void {
    paths.forEach((p) => this.loadedPaths.add(p));
  }

  /**
   * Track JIT-discovered nested memory paths separately from tier-loaded
   * paths. Exposed to the Memory management UI via getCategorizedPathsWithJit()
   * so nested AGENTS.md files that were JIT-injected still appear in the list.
   * Classifies by filename: *.local.md -> local, otherwise -> project.
   */
  private trackJitDiscoveredPaths(newPaths: string[]): void {
    if (newPaths.length === 0) return;
    const localFilenames = new Set(this.config.getAllLocalContextFileNames());
    const existingProject = new Set(this.jitDiscoveredPaths.project);
    const existingLocal = new Set(this.jitDiscoveredPaths.local);
    let changed = false;
    for (const p of newPaths) {
      if (localFilenames.has(path.basename(p))) {
        if (!existingLocal.has(p)) {
          this.jitDiscoveredPaths.local.push(p);
          existingLocal.add(p);
          changed = true;
        }
      } else {
        if (!existingProject.has(p)) {
          this.jitDiscoveredPaths.project.push(p);
          existingProject.add(p);
          changed = true;
        }
      }
    }
    // Silence lint: `changed` kept for future debugging / event emission.
    void changed;
  }

  /**
   * Manually resets hook dedup state. Compact refreshes reset it atomically
   * inside refreshTransaction(), so their callers do not need this method.
   */
  resetHookDedup(): void {
    this.hookFiredPaths.clear();
  }

  getLoadedPaths(): ReadonlySet<string> {
    return this.loadedPaths;
  }

  /**
   * Re-hydrate JIT-discovered nested memory paths from a resumed transcript's
   * relevant_memories (or legacy relevant_memories) attachments. Called after
   * session resume so that:
   *   - getRelevantMemoriesAttachments() does not re-emit previously-disclosed
   *     JIT files on the first post-resume turn (they'll land in the first-turn
   *     seed via getLoadedPaths()).
   *   - The Memory management UI surfaces nested AGENTS.md files that were
   *     JIT-injected in the prior session.
   */
  restoreJitPathsFromMessages(messages: readonly Message[]): void {
    const restored: string[] = [];
    for (const m of messages) {
      if (m.type !== 'attachment') continue;
      const attachment = m.attachment as
        | { type?: string; files?: Array<{ filePath?: unknown }> }
        | undefined;
      if (!attachment || attachment.type !== 'relevant_memories') continue;
      if (!Array.isArray(attachment.files)) continue;
      for (const f of attachment.files) {
        if (typeof f?.filePath === 'string' && f.filePath.length > 0) {
          restored.push(f.filePath);
        }
      }
    }
    if (restored.length === 0) return;
    this.markAsLoaded(restored);
    this.trackJitDiscoveredPaths(restored);
    this.emitMemoryChanged();
  }

  /**
   * Returns the categorized memory paths from the last refresh.
   * Used by the TUI to display memory files with proper type labels.
   */
  getCategorizedPaths(): {
    global: readonly string[];
    plugin: readonly string[];
    project: readonly string[];
    local: readonly string[];
  } | null {
    if (!this.lastPaths) return null;
    return {
      global: this.lastPaths.global,
      plugin: this.lastPaths.plugin,
      project: this.lastPaths.project,
      local: this.lastPaths.local,
    };
  }

  /**
   * Like getCategorizedPaths() but also includes JIT-discovered nested memory
   * paths merged into project/local. Used by the Memory management UI so that
   * nested AGENTS.md files injected via JIT are visible to the user.
   * Tier-oriented callers (memory attachment generators) must
   * keep using getCategorizedPaths() — mixing JIT paths in there would cause
   * getRelevantMemoriesAttachments to suppress legitimate JIT emissions.
   */
  getCategorizedPathsWithJit(): {
    global: readonly string[];
    plugin: readonly string[];
    project: readonly string[];
    local: readonly string[];
  } | null {
    if (!this.lastPaths) return null;
    const existingProject = new Set(this.lastPaths.project);
    const existingLocal = new Set(this.lastPaths.local);
    const projectExtra = this.jitDiscoveredPaths.project.filter(
      (p) => !existingProject.has(p),
    );
    const localExtra = this.jitDiscoveredPaths.local.filter(
      (p) => !existingLocal.has(p),
    );
    return {
      global: this.lastPaths.global,
      plugin: this.lastPaths.plugin,
      project:
        projectExtra.length > 0
          ? [...this.lastPaths.project, ...projectExtra]
          : this.lastPaths.project,
      local:
        localExtra.length > 0
          ? [...this.lastPaths.local, ...localExtra]
          : this.lastPaths.local,
    };
  }
}
