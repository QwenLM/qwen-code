/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Background dream consolidation service.
 *
 * This follows the same lifecycle shape as the CLI's Stop-hook background
 * bookkeeping: initialize once for a Config, then fire-and-forget after a main
 * session turn completes. The actual fork runs through runForkedAgent with the
 * parent's context and exact tool schemas for prompt-cache alignment, while
 * execution is restricted to read/search tools, read-only shell commands, and
 * scoped memory writes.
 */

import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Config } from '../../config/config.js';
import {
  createConversationMessageAccessors,
  type AgentLoopContext,
} from '../../config/agent-loop-context.js';
import { buildPermissionContext } from '../../agents/agent-context-factory.js';
import { wrapWithParentToolSchemas } from '../../agents/fork-subagent.js';
import {
  runForkedAgent,
} from '../../core/forkedAgent.js';
import { buildForkCheckerMap } from '../../tools/tool-checkers/fork-restrictions.js';
import { ToolRegistry } from '../../tools/tool-registry.js';

import {
  getScopedAutoMemoryDirs,
  ensureAutoMemoryDir,
  MEMORY_INDEX_FILENAME,
  type ScopedAutoMemoryDir,
} from '../../memory/structured-memory-store.js';
import {
  EDIT_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  SHELL_TOOL_NAME,
  POWERSHELL_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from '../../tools/tool-names.js';
import { buildForkContextMessages } from '../../utils/forkContextUtils.js';
import { buildModelProjectionOptions } from '../../utils/modelProjectionOptions.js';
import { runWithAgentContext } from '../../utils/agentContext.js';
import { coreEvents } from '../../utils/events.js';
import { isRemoteWorkerMode } from '../../utils/headless.js';
import type { SystemPrompt } from '../../prompts/types.js';
import { runLogger } from '../../utils/runLogger.js';

import type {
  AssistantMessage,
  Message as TranscriptMessage,
  UserMessage,
} from '../../protocol/transcript/message.js';
import type { BusinessInfo } from '../../qoder/business-info.js';
import { getTranscriptProjectDir } from '../transcript-paths.js';
import { resolveDreamConfig } from './config.js';
import { buildConsolidationPrompt } from './consolidationPrompt.js';
import {
  listSessionsTouchedSince,
  markConsolidationComplete,
  readLastConsolidatedAt,
  rollbackConsolidationLock,
  tryAcquireConsolidationLock,
} from './consolidationLock.js';

const DREAM_FORK_ALLOWED_TOOLS: string[] = [
  READ_FILE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  EDIT_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  SHELL_TOOL_NAME,
  POWERSHELL_TOOL_NAME,
];

// runForkedAgent defaults to one turn, while dream is a background
// consolidation pass that usually needs to read several files before writing.
const AUTO_DREAM_MAX_TURNS = 50;

interface AutoDreamRootCandidate extends ScopedAutoMemoryDir {
  lastConsolidatedAt: number;
  hoursSince: number;
  sessionIds: string[];
}

interface AutoDreamLockedRoot extends AutoDreamRootCandidate {
  priorMtime: number;
}

export interface AutoDreamTurnContext {
  prompt: string;
  response: string;
  messages: TranscriptMessage[];
  systemPrompt?: SystemPrompt;
  parentRequestSetId?: string;
  parentBusinessInfo?: Readonly<BusinessInfo>;
  customContext?: Readonly<Record<string, string>>;
}

export interface AutoDreamCallbacks {
  onDreamStarted?: () => void;
  onDreamFinished?: () => void;
  onMemoriesImproved?: (memoryPaths: string[]) => void;
  onMemoryRefresh?: () => void;
}

class AutoDreamService {
  private currentPromise: Promise<void> | null = null;
  private lastSessionScanAt = 0;

  constructor(
    private readonly config: Config,
    private readonly callbacks: AutoDreamCallbacks = {},
  ) {}

  async onTurnComplete(ctx: AutoDreamTurnContext): Promise<void> {
    if (this.currentPromise) {
      runLogger.debug('[AutoDream] skip; consolidation already in progress');
      return;
    }

    // Tool hooks still run, but their events belong to this background agent
    // so the main session's hook status row can ignore them.
    this.currentPromise = runWithAgentContext(
      { agentId: `auto-dream-${randomUUID()}`, agentType: 'auto_dream' },
      () => this.runDream(ctx),
    );
    try {
      await this.currentPromise;
    } finally {
      this.currentPromise = null;
    }
  }

  async drain(timeoutMs?: number): Promise<void> {
    if (!this.currentPromise) return;
    if (timeoutMs === undefined) {
      await this.currentPromise;
      return;
    }
    await Promise.race([
      this.currentPromise,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref()),
    ]);
  }

  private async runDream(ctx: AutoDreamTurnContext): Promise<void> {
    try {
      await this.tryRunDream(ctx);
    } catch (error) {
      runLogger.debug(
        '[AutoDream] error:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async tryRunDream(ctx: AutoDreamTurnContext): Promise<void> {
    if (isRemoteWorkerMode()) {
      return;
    }
    if (!this.config.isAutoMemoryEnabled()) {
      return;
    }

    const dreamConfig = resolveDreamConfig(this.config);
    if (!dreamConfig.enabled) {
      return;
    }

    const scopedDirs = getScopedAutoMemoryDirs(this.config);
    if (scopedDirs.length === 0) {
      return;
    }

    const rootStates = await Promise.all(
      scopedDirs.map(async (root) => {
        const lastConsolidatedAt = await readLastConsolidatedAt(root.dir);
        return {
          ...root,
          lastConsolidatedAt,
          hoursSince: (Date.now() - lastConsolidatedAt) / 3_600_000,
        };
      }),
    );
    const rootsPastTimeGate = rootStates.filter(
      (root) => root.hoursSince >= dreamConfig.minHours,
    );
    if (rootsPastTimeGate.length === 0) {
      return;
    }

    const scanThrottleMs = dreamConfig.scanThrottleMinutes * 60 * 1000;
    const elapsedSinceScan = Date.now() - this.lastSessionScanAt;
    if (this.lastSessionScanAt > 0 && elapsedSinceScan < scanThrottleMs) {
      runLogger.debug(
        `[AutoDream] scan throttle; last scan was ${Math.round(
          elapsedSinceScan / 1000,
        )}s ago`,
      );
      return;
    }
    this.lastSessionScanAt = Date.now();

    const transcriptDir = getTranscriptProjectDir(
      this.config.getSessionArtifactProjectRoot(),
    );
    const currentSessionId = this.config.getSessionId();
    const candidates: AutoDreamRootCandidate[] = [];
    for (const root of rootsPastTimeGate) {
      const sessionIds = (
        await listSessionsTouchedSince(transcriptDir, root.lastConsolidatedAt)
      ).filter((sessionId) => sessionId !== currentSessionId);

      if (sessionIds.length < dreamConfig.minSessions) {
        runLogger.debug(
          `[AutoDream] skip ${root.scope} root; ${sessionIds.length} sessions since last consolidation, need ${dreamConfig.minSessions}`,
        );
        continue;
      }

      candidates.push({ ...root, sessionIds });
    }

    if (candidates.length === 0) {
      return;
    }

    const lockedRoots: AutoDreamLockedRoot[] = [];
    for (const candidate of candidates) {
      const priorMtime = await tryAcquireConsolidationLock(candidate.dir);
      if (priorMtime === null) {
        continue;
      }
      await ensureAutoMemoryDir(candidate.dir);
      lockedRoots.push({ ...candidate, priorMtime });
    }

    if (lockedRoots.length === 0) {
      return;
    }

    const maxSessionCount = Math.max(
      ...lockedRoots.map((root) => root.sessionIds.length),
    );
    runLogger.debug(
      `[AutoDream] firing; ${lockedRoots
        .map(
          (root) =>
            `${root.scope}=${root.hoursSince.toFixed(1)}h/${root.sessionIds.length}s`,
        )
        .join(', ')}`,
    );

    const dreamStartedAt = Date.now();
    let completedRootCount = 0;
    coreEvents.emitAutoDreamStatus({
      stage: 'started',
      sessionCount: maxSessionCount,
      memoryDir: lockedRoots.length === 1 ? lockedRoots[0]?.dir : undefined,
      rootCount: lockedRoots.length,
    });
    this.callbacks.onDreamStarted?.();
    try {
      const memoryPaths: string[] = [];
      for (const root of lockedRoots) {
        const rootMemoryPaths = await this.runDreamForRoot(
          ctx,
          transcriptDir,
          root,
        );
        await markConsolidationComplete(root.dir);
        memoryPaths.push(...rootMemoryPaths);
        completedRootCount += 1;
      }

      if (memoryPaths.length > 0) {
        runLogger.log(
          `[AutoDream] Improved ${memoryPaths.length} memor${
            memoryPaths.length === 1 ? 'y' : 'ies'
          }: ${memoryPaths.map((filePath) => path.basename(filePath)).join(', ')}`,
        );
        this.callbacks.onMemoriesImproved?.(memoryPaths);
        this.callbacks.onMemoryRefresh?.();
      } else {
        runLogger.debug('[AutoDream] completed; no memory files changed');
      }
      coreEvents.emitAutoDreamStatus({
        stage: 'completed',
        sessionCount: maxSessionCount,
        memoryDir: lockedRoots.length === 1 ? lockedRoots[0]?.dir : undefined,
        memoryPaths,
        durationMs: Date.now() - dreamStartedAt,
        rootCount: lockedRoots.length,
      });
    } catch (error) {
      coreEvents.emitAutoDreamStatus({
        stage: 'failed',
        sessionCount: maxSessionCount,
        memoryDir: lockedRoots.length === 1 ? lockedRoots[0]?.dir : undefined,
        durationMs: Date.now() - dreamStartedAt,
        rootCount: lockedRoots.length,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      for (const root of lockedRoots.slice(completedRootCount)) {
        await rollbackConsolidationLock(root.dir, root.priorMtime);
      }
      this.callbacks.onDreamFinished?.();
    }
  }

  private async runDreamForRoot(
    ctx: AutoDreamTurnContext,
    transcriptDir: string,
    root: AutoDreamLockedRoot,
  ): Promise<string[]> {
    const attemptId = randomUUID();
    const extra = `Tool constraints for this run: ${READ_FILE_TOOL_NAME}, ${GREP_TOOL_NAME}, and ${GLOB_TOOL_NAME} are unrestricted read-only tools. ${SHELL_TOOL_NAME}/${POWERSHELL_TOOL_NAME}, when available, are restricted to read-only commands. Anything that writes, redirects to a file, or modifies state will be denied. ${WRITE_FILE_TOOL_NAME}/${EDIT_TOOL_NAME} may only write inside ${root.dir}. Plan your exploration with this in mind; do not probe with rm or other mutation commands.

Sessions since last consolidation for this ${root.scope} memory root (${root.sessionIds.length}):
${root.sessionIds.map((id) => `- ${id}`).join('\n')}`;

    const rootSessionId = this.config.getSessionId();
    const scene = `fork:auto-dream:${attemptId}`;
    let forkResult;
    let dreamSchemaRegistry: ToolRegistry | undefined;
    try {
      const { toolRegistry, agentContext: dreamAgentContext } =
        buildDreamToolBridge(this.config, root.dir, scene);
      dreamSchemaRegistry = toolRegistry;
      forkResult = await runForkedAgent({
        config: this.config,
        prompt: buildConsolidationPrompt(
          root.dir,
          root.scope,
          transcriptDir,
          extra,
        ),
        sessionId: rootSessionId,
        model: this.config.getModel(),
        promptId: `dream-${root.scope}`,
        systemPrompt: ctx.systemPrompt,
        forkContextMessages: buildForkContextMessages(
          ctx.messages,
          this.config.getMemoryContextManager?.()?.getUserContext(),
          buildModelProjectionOptions(this.config, this.config.getModel()),
        ),
        forkLabel: 'auto_dream',
        querySource: 'auto_dream',
        maxTurns: AUTO_DREAM_MAX_TURNS,
        toolRegistry,
        toolExecutor: this.config.getToolExecutor(),
        agentContext: dreamAgentContext,
        parentRequestSetId: ctx.parentRequestSetId,
        parentBusinessInfo: ctx.parentBusinessInfo,
        customContext: ctx.customContext,
        skipCacheWrite: true,
        workdirs: this.config.getWorkspaceContext().getDirectories(),
        sessionScopeId: rootSessionId,
      });
    } finally {
      dreamSchemaRegistry?.dispose();
      this.config.getProcessPermissionManager()?.unregisterSceneCheckers(scene);
    }

    const memoryPaths = collectAutoMemoryWritePaths(
      forkResult.messages,
      root.dir,
      this.config.getWorkingDir(),
    ).filter((filePath) => path.basename(filePath) !== MEMORY_INDEX_FILENAME);
    return memoryPaths;
  }
}

const runners = new WeakMap<Config, AutoDreamService>();

export function initAutoDream(
  config: Config,
  callbacks: AutoDreamCallbacks = {},
): void {
  runners.set(config, new AutoDreamService(config, callbacks));
}

export async function executeAutoDream(
  config: Config,
  ctx: AutoDreamTurnContext,
): Promise<void> {
  await runners.get(config)?.onTurnComplete(ctx);
}

export async function drainAutoDream(
  config: Config,
  timeoutMs?: number,
): Promise<void> {
  await runners.get(config)?.drain(timeoutMs);
}

function buildDreamToolBridge(
  config: Config,
  memoryDir: string,
  scene: string,
): { toolRegistry: ToolRegistry; agentContext: AgentLoopContext } {
  const promptId = `auto-dream-${randomUUID().slice(0, 8)}`;
  const toolRegistry = new ToolRegistry(config);

  const parentRegistry = config.getToolRegistry();
  for (const tool of parentRegistry.getAllTools()) {
    toolRegistry.registerTool(tool.clone());
  }
  toolRegistry.sortTools();

  config.getProcessPermissionManager()?.registerSceneCheckers(
    scene,
    buildForkCheckerMap({
      unrestrictedRead: true,
      readOnlyShell: true,
      writeDirectory: memoryDir,
      label: scene,
    }),
  );

  const context: AgentLoopContext = {
    config,
    promptId,
    toolRegistry,
    toolCallSnapshots: config.toolCallSnapshots,
    permission: config.permission,
    // Dream owns an isolated permission policy: it may look anywhere, run only
    // read-only commands, and write only into its own memory directory. Parent
    // session rules are intentionally replaced rather than inherited; the
    // allowlist and checker table below are the complete worker boundary.
    permissionContext: () => ({
      ...buildPermissionContext(DREAM_FORK_ALLOWED_TOOLS),
      scene,
    }),
    ...createConversationMessageAccessors(config),
  };

  const forkRegistry =
    wrapWithParentToolSchemas(
      config.getParentToolSchemas?.(),
      config,
      toolRegistry,
    ) ?? toolRegistry;
  return { toolRegistry: forkRegistry, agentContext: context };
}

function getAbsoluteToolPath(
  filePath: unknown,
  cwd: string,
): string | undefined {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return undefined;
  }

  return path.resolve(cwd, filePath);
}

function isAssistantMessage(
  message: TranscriptMessage,
): message is AssistantMessage {
  return message.type === 'assistant';
}

function isUserMessage(message: TranscriptMessage): message is UserMessage {
  return message.type === 'user';
}

function collectSuccessfulToolResultIds(
  messages: readonly TranscriptMessage[],
): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (!isUserMessage(message) || !Array.isArray(message.message.content)) {
      continue;
    }

    for (const block of message.message.content) {
      if (block.type === 'tool_result' && !block.is_error) {
        ids.add(block.tool_use_id);
      }
    }
  }
  return ids;
}

export function collectAutoMemoryWritePaths(
  messages: readonly TranscriptMessage[],
  memoryDir: string,
  cwd: string,
): string[] {
  const paths = new Set<string>();
  const successfulToolResultIds = collectSuccessfulToolResultIds(messages);

  for (const message of messages) {
    if (!isAssistantMessage(message)) continue;

    for (const block of message.message.content) {
      if (
        block.type !== 'tool_use' ||
        (block.name !== WRITE_FILE_TOOL_NAME && block.name !== EDIT_TOOL_NAME)
      ) {
        continue;
      }
      if (!successfulToolResultIds.has(block.id)) {
        continue;
      }

      const filePath = getAbsoluteToolPath(
        (block.input as { file_path?: unknown })?.file_path,
        message.cwd ?? cwd,
      );
      if (!filePath) continue;

      const relative = path.relative(memoryDir, filePath);
      if (
        relative.length > 0 &&
        !relative.startsWith('..') &&
        !path.isAbsolute(relative)
      ) {
        paths.add(filePath);
      }
    }
  }

  return [...paths];
}
