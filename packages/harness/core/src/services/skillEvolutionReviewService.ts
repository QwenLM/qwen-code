/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SystemPrompt } from '../prompts/types.js';
import { randomUUID } from 'node:crypto';
import type { Config } from '../config/config.js';
import {
  createConversationMessageAccessors,
  type AgentLoopContext,
} from '../config/agent-loop-context.js';
import { buildPermissionContext } from '../agents/agent-context-factory.js';
import { wrapWithParentToolSchemas } from '../agents/fork-subagent.js';
import type { CacheSafeQuerySnapshot } from '../core/cache-safe-query-snapshot.js';
import type {
  ForkedAgentCompletion,
  ForkedAgentParams,
  ForkedAgentResult,
} from '../core/forkedAgent.js';
import { runForkedAgent } from '../core/forkedAgent.js';
import { ToolRegistry } from '../tools/tool-registry.js';

import {
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  READ_FILE_TOOL_NAME,
} from '../tools/tool-names.js';
import type { Message as TranscriptMessage } from '../protocol/transcript/message.js';
import { getAssistantTextBlocks } from '../protocol/transcript/message-utils.js';
import type { BusinessInfo } from '../qoder/business-info.js';
import { buildForkContextMessages } from '../utils/forkContextUtils.js';
import { buildModelProjectionOptions } from '../utils/modelProjectionOptions.js';
import {
  getForkCompletionBilling,
  type ForkCompletionBilling,
} from '../model-request/credit-usage.js';
import {
  collectCompletedToolUseNames,
  scoreTurnReview,
} from './turnReviewScoring.js';
import {
  SKILL_EVOLUTION_CREATE_AUDIT,
  SKILL_EVOLUTION_STRONG_SIGNALS,
  SKILL_EVOLUTION_UPDATE_AUDIT,
} from './skillEvolutionReviewCriteria.js';

import type { SkillSource } from '../skills/skillManager.js';

type SkillEvolutionRoot = {
  id: string;
  dir: string;
};
type SkillEvolutionActiveSkill = {
  id: string;
  source?: SkillSource;
};
type SkillEvolutionGenerationConfig = {
  prompt?: string;
  maxSuggestions?: number;
  reviewThreshold?: number;
};
type SkillEvolutionSuggestionInput = {
  skillName: string;
  action: 'create' | 'update';
  summary: string;
  confidence: number;
  rationale?: string;
};
type SkillEvolutionTurnContext = {
  prompt: string;
  messages: TranscriptMessage[];
  roots: readonly SkillEvolutionRoot[];
  activeSkills: readonly SkillEvolutionActiveSkill[];
  existingSkillNames: readonly string[];
  systemPrompt?: SystemPrompt;
  parentRequestId?: string;
  parentRequestSetId?: string;
  parentBusinessInfo?: Readonly<BusinessInfo>;
  customContext?: Readonly<Record<string, string>>;
  hostReviewApproved?: boolean;
  cacheSafeQuerySnapshot?: CacheSafeQuerySnapshot;
};
export type SkillEvolutionReviewResult = {
  status: 'suggested' | 'no_change' | 'skipped' | 'failed';
  attemptId: string;
  reason?: string;
  origin: 'turn_complete';
  reviewScore?: number;
  sourceRequestIds?: string[];
  modelRequestIds?: string[];
  suggestions: SkillEvolutionSuggestionInput[];
  durationMs: number;
  usage?: ForkedAgentCompletion['totalUsage'];
};
type SkillEvolutionReviewCallbacks = {
  onResult?: (result: SkillEvolutionReviewResult) => void | Promise<void>;
};

type PendingSkillEvolutionReview = {
  ctx: SkillEvolutionTurnContext;
  runner: SkillEvolutionForkRunner;
};

type SkillEvolutionForkJob = Pick<
  ForkedAgentParams,
  | 'prompt'
  | 'promptId'
  | 'forkLabel'
  | 'maxTurns'
  | 'customContext'
  | 'toolRegistry'
  | 'agentContext'
  | 'onCompleted'
>;

type SkillEvolutionForkRunner = {
  run(job: SkillEvolutionForkJob): Promise<ForkedAgentResult>;
};

export const DEFAULT_SKILL_EVOLUTION_REVIEW_THRESHOLD = 8;
const MAX_SKILL_EVOLUTION_REVIEW_SCORE = 10;
export const DEFAULT_SKILL_EVOLUTION_COOLDOWN_MS = 10 * 60_000;

function buildSkillEvolutionReviewGuidance(maxSuggestions: number): string {
  return `Evaluate whether the conversation produced a durable skill improvement. Focus on non-trivial approaches involving trial-and-error, course correction, or a mismatch between the user's expected and actual method.

${SKILL_EVOLUTION_STRONG_SIGNALS}

${SKILL_EVOLUTION_UPDATE_AUDIT}

${SKILL_EVOLUTION_CREATE_AUDIT}

Memory and skills are not mutually exclusive. Memory is always-in-context concise rules; skills are on-demand playbooks for tool chains and output formats. Do not skip a skill suggestion just because the rule is already in memory.

Suggestion rules:
- skillName: lowercase words separated by hyphens
- action: "create" for a new skill, "update" for an existing loaded skill
- summary and rationale: match the user's language
- confidence: 0 to 1; only return suggestions with confidence >= 0.6
- Return at most ${maxSuggestions} suggestions.`;
}

class SkillEvolutionReviewAttemptError extends Error {
  constructor(
    message: string,
    readonly attemptId: string,
    readonly completion: ForkedAgentCompletion | undefined,
    readonly durationMs: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

function buildSkillEvolutionCompletionUsage(
  completion: ForkedAgentCompletion | undefined,
): {
  usage: ForkedAgentCompletion['totalUsage'] | undefined;
  billing: ForkCompletionBilling | undefined;
} {
  if (!completion) {
    return { usage: undefined, billing: undefined };
  }

  const { credits: _requestLevelCredits, ...usage } = completion.totalUsage;
  const billing = getForkCompletionBilling(completion);
  return {
    usage:
      billing.credits === undefined
        ? usage
        : { ...usage, credits: billing.credits },
    billing,
  };
}

function buildSkillEvolutionForkBridge(
  config: Config,
  roots: readonly SkillEvolutionRoot[],
  parentToolSchemas: CacheSafeQuerySnapshot['toolSchemas'] | undefined,
): { toolRegistry: ToolRegistry; agentContext: AgentLoopContext } {
  const promptId = `skill-evolution-fork-${randomUUID().slice(0, 8)}`;
  const registry = new ToolRegistry(config);
  const parent = config.getToolRegistry();
  const allowed = new Set([
    READ_FILE_TOOL_NAME,
    GLOB_TOOL_NAME,
    GREP_TOOL_NAME,
  ]);
  for (const tool of parent.getAllTools())
    if (allowed.has(tool.name)) registry.registerTool(tool.clone());
  registry.sortTools();
  const context: AgentLoopContext = {
    config,
    promptId,
    toolRegistry: registry,
    toolCallSnapshots: config.toolCallSnapshots,
    permission: config.permission,
    // Restricted fork: Read/Glob/Grep allowed by session rule; anything else
    // asks, and the fork's refuse-ask handler denies it.
    // TODO(cutover): the legacy context also whitelisted the skill roots for
    // reads (sdkMemoryRoots); reads outside the workspace roots are not yet
    // re-granted here.
    permissionContext: () => buildPermissionContext([...allowed]),
    ...createConversationMessageAccessors(config),
  };
  const toolRegistry =
    wrapWithParentToolSchemas(parentToolSchemas, config, registry) ?? registry;
  return { toolRegistry, agentContext: context };
}

function createSkillEvolutionForkRunner(
  config: Config,
  ctx: SkillEvolutionTurnContext,
): SkillEvolutionForkRunner {
  const parentSnapshot =
    ctx.cacheSafeQuerySnapshot ??
    config.getCacheSafeQuerySnapshot?.() ??
    undefined;
  const forkModel = parentSnapshot?.model ?? config.getModel();
  const base = {
    config,
    parentSelection: parentSnapshot?.modelResolution,
    sessionId: config.getSessionId(),
    systemPrompt: parentSnapshot?.systemPrompt ?? ctx.systemPrompt ?? [],
    forkContextMessages:
      parentSnapshot?.forkContextMessages ??
      buildForkContextMessages(
        ctx.messages,
        config.getMemoryContextManager?.()?.getUserContext(),
        buildModelProjectionOptions(config, forkModel),
      ),
    ...(parentSnapshot
      ? {
          maxOutputTokens: parentSnapshot.maxOutputTokens,
          thinkingBudget: parentSnapshot.thinkingBudget,
          reasoningEffort: parentSnapshot.reasoningEffort,
          generation: parentSnapshot.generation,
          contextWindow: parentSnapshot.contextWindow,
        }
      : {}),
    parentRequestSetId: ctx.parentRequestSetId,
    parentBusinessInfo: ctx.parentBusinessInfo,
    customContext: ctx.customContext,
    skipCacheWrite: true,
    workdirs: config.getWorkspaceContext().getDirectories(),
    toolExecutor: config.getToolExecutor(),
  };

  return {
    run: (job) => runForkedAgent({ ...job, ...base }),
  };
}

function parseSkillEvolutionSuggestions(
  result: ForkedAgentResult,
  maxSuggestions: number,
  activeSkills: readonly SkillEvolutionActiveSkill[],
  existingSkillNames: readonly string[],
): SkillEvolutionSuggestionInput[] {
  const finalResponseText = getFinalAssistantText(result);
  let value: unknown;
  try {
    value = JSON.parse(finalResponseText.trim());
  } catch (error) {
    throw new Error('skill evolution review returned invalid JSON', {
      cause: error,
    });
  }
  if (!isRecord(value) || !Array.isArray(value['suggestions'])) {
    throw new Error('skill evolution review must return a suggestions array');
  }
  if (value['suggestions'].length > maxSuggestions) {
    throw new Error(
      `skill evolution review returned more than ${maxSuggestions} suggestions`,
    );
  }
  const suggestions = value['suggestions'].map((suggestion) => {
    if (!isSkillEvolutionSuggestion(suggestion)) {
      throw new Error('skill evolution review returned an invalid suggestion');
    }
    return {
      skillName: suggestion.skillName,
      action: suggestion.action,
      summary: suggestion.summary,
      confidence: suggestion.confidence,
      ...(suggestion.rationale === undefined
        ? {}
        : { rationale: suggestion.rationale }),
    };
  });
  const existingNames = new Set(
    existingSkillNames.map((name) => name.toLowerCase()),
  );
  return suggestions.filter((suggestion) => {
    const skillName = suggestion.skillName.toLowerCase();
    if (suggestion.action === 'create') {
      return !existingNames.has(skillName);
    }
    return activeSkills.some(
      (skill) =>
        skill.id.toLowerCase() === skillName && skill.source === 'user',
    );
  });
}

function formatSkillEvolutionActiveSkill(
  skill: SkillEvolutionActiveSkill,
): string {
  const writable = skill.source === 'user';
  return `- ${skill.id} [source=${skill.source ?? 'unknown'}, ${writable ? 'writable' : 'read-only'}]`;
}

function isSkillEvolutionSuggestion(
  value: unknown,
): value is SkillEvolutionSuggestionInput {
  if (!isRecord(value)) return false;
  const { skillName, action, summary, confidence, rationale } = value;
  return (
    typeof skillName === 'string' &&
    skillName.trim().length > 0 &&
    (action === 'create' || action === 'update') &&
    typeof summary === 'string' &&
    summary.trim().length > 0 &&
    typeof confidence === 'number' &&
    Number.isFinite(confidence) &&
    confidence >= 0.6 &&
    confidence <= 1 &&
    (rationale === undefined || typeof rationale === 'string')
  );
}

function getFinalAssistantText(result: ForkedAgentResult): string {
  for (let index = result.messages.length - 1; index >= 0; index -= 1) {
    const message = result.messages[index];
    if (message.type !== 'assistant') continue;
    const text = getAssistantTextBlocks(message).join('');
    if (text) return text;
  }
  return result.textContent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getMessagesSinceCursor(
  messages: readonly TranscriptMessage[],
  lastProcessedUuid: string | null,
): TranscriptMessage[] {
  if (!lastProcessedUuid) return [...messages];
  const cursor = messages.findIndex(
    (message) => message.uuid === lastProcessedUuid,
  );
  return cursor === -1 ? [...messages] : messages.slice(cursor + 1);
}

export class SkillEvolutionReviewService {
  private generationConfig?: SkillEvolutionGenerationConfig;
  private lastProcessedMessageUuid: string | null = null;
  private lastReviewAt = 0;
  private totalUserTextLength = 0;
  private turnCount = 0;
  private toolCallCount = 0;
  private readonly uniqueToolNames = new Set<string>();
  private inProgress = false;
  private pendingReview: PendingSkillEvolutionReview | null = null;
  private currentPromise: Promise<void> | null = null;

  constructor(
    private readonly config: Config,
    private readonly callbacks: SkillEvolutionReviewCallbacks = {},
  ) {}

  configure(config: SkillEvolutionGenerationConfig | undefined): void {
    this.generationConfig = config;
  }

  async reviewTurn(
    ctx: SkillEvolutionTurnContext,
    runner?: SkillEvolutionForkRunner,
  ): Promise<void> {
    if (!this.generationConfig) return;
    const review = {
      ctx,
      runner: runner ?? createSkillEvolutionForkRunner(this.config, ctx),
    };
    if (this.inProgress) {
      this.pendingReview = review;
      return;
    }
    this.currentPromise = this.runReviewLoop(review);
    await this.currentPromise;
  }

  async drain(): Promise<void> {
    if (this.currentPromise) await this.currentPromise;
  }

  private async runReviewLoop(
    initial: PendingSkillEvolutionReview,
  ): Promise<void> {
    this.inProgress = true;
    try {
      let current: PendingSkillEvolutionReview | null = initial;
      while (current) {
        if (this.generationConfig) {
          await this.processReview(current.ctx, current.runner);
        }
        current = this.pendingReview;
        this.pendingReview = null;
      }
    } finally {
      this.inProgress = false;
      this.currentPromise = null;
    }
  }

  private async emit(
    result: SkillEvolutionReviewResult,
    ctx: SkillEvolutionTurnContext,
    _completion?: ForkedAgentCompletion,
    _billing?: ForkCompletionBilling,
  ): Promise<void> {
    const emittedResult =
      result.sourceRequestIds !== undefined || !ctx.parentRequestId
        ? result
        : { ...result, sourceRequestIds: [ctx.parentRequestId] };

    await this.callbacks.onResult?.(emittedResult);
  }

  private async processReview(
    ctx: SkillEvolutionTurnContext,
    runner: SkillEvolutionForkRunner,
  ): Promise<void> {
    try {
      await this.review(ctx, runner);
    } catch (error) {
      await this.emitFailure(ctx, error);
    }
  }

  private async emitFailure(
    ctx: SkillEvolutionTurnContext,
    error: unknown,
  ): Promise<void> {
    const outputError =
      error instanceof SkillEvolutionReviewAttemptError ? error : undefined;
    const { usage, billing } = buildSkillEvolutionCompletionUsage(
      outputError?.completion,
    );
    await this.emit(
      {
        status: 'failed',
        attemptId: outputError?.attemptId ?? randomUUID(),
        reason: error instanceof Error ? error.message : String(error),
        origin: 'turn_complete',
        modelRequestIds: outputError?.completion?.modelRequestIds,
        suggestions: [],
        durationMs: outputError?.durationMs ?? 0,
        usage,
      },
      ctx,
      outputError?.completion,
      billing,
    );
  }

  private async review(
    ctx: SkillEvolutionTurnContext,
    runner: SkillEvolutionForkRunner,
  ): Promise<void> {
    const startedAt = Date.now();
    const attemptId = randomUUID();
    const last = ctx.messages.at(-1);
    if (last?.uuid && last.uuid === this.lastProcessedMessageUuid) return;
    let score: number | undefined;
    let reviewThreshold: number | undefined;
    if (ctx.hostReviewApproved) {
      if (last?.uuid) this.lastProcessedMessageUuid = last.uuid;
    } else {
      const newMessages = getMessagesSinceCursor(
        ctx.messages,
        this.lastProcessedMessageUuid,
      );
      const completedTools = collectCompletedToolUseNames(newMessages);
      this.totalUserTextLength += ctx.prompt.trim().length;
      this.turnCount += 1;
      this.toolCallCount += completedTools.toolCallCount;
      for (const toolName of completedTools.toolNames) {
        this.uniqueToolNames.add(toolName);
      }
      if (last?.uuid) this.lastProcessedMessageUuid = last.uuid;
      score = Math.min(
        scoreTurnReview({
          totalUserTextLength: this.totalUserTextLength,
          turnCount: this.turnCount,
          toolCallCount: this.toolCallCount,
          uniqueToolCount: this.uniqueToolNames.size,
        }),
        MAX_SKILL_EVOLUTION_REVIEW_SCORE,
      );
      reviewThreshold =
        this.generationConfig?.reviewThreshold ??
        DEFAULT_SKILL_EVOLUTION_REVIEW_THRESHOLD;
      if (score < reviewThreshold) {
        await this.emit(
          {
            status: 'skipped',
            attemptId,
            reason: 'review_score_below_threshold',
            origin: 'turn_complete',
            reviewScore: score,
            suggestions: [],
            durationMs: Date.now() - startedAt,
          },
          ctx,
        );
        return;
      }
      if (
        Date.now() - this.lastReviewAt <
        DEFAULT_SKILL_EVOLUTION_COOLDOWN_MS
      ) {
        await this.emit(
          {
            status: 'skipped',
            attemptId,
            reason: 'cooldown',
            origin: 'turn_complete',
            reviewScore: score,
            suggestions: [],
            durationMs: Date.now() - startedAt,
          },
          ctx,
        );
        return;
      }
    }
    const maxSuggestions = this.generationConfig?.maxSuggestions ?? 3;
    let completion: ForkedAgentCompletion | undefined;
    const { toolRegistry, agentContext: forkAgentContext } =
      buildSkillEvolutionForkBridge(
        this.config,
        ctx.roots,
        ctx.cacheSafeQuerySnapshot?.toolSchemas ??
          this.config.getParentToolSchemas?.(),
      );
    const directive = [
      this.generationConfig?.prompt ??
        'Review this conversation and suggest durable skill improvements.',
      '',
      buildSkillEvolutionReviewGuidance(maxSuggestions),
      '',
      'Only active skills marked writable may be targets of "update" suggestions.',
      'Read-only skills may be used as evidence but must never be update targets.',
      'A "create" suggestion must not reuse any existing skill name.',
      ...ctx.activeSkills.map(formatSkillEvolutionActiveSkill),
      '',
      "Use the parent conversation's already-injected skill instructions and execution trace as the primary evidence.",
      'Inspect the listed active skill roots only when that evidence is missing or you need referenced resources or current file state.',
      'Do not read any other skill root. Do not modify files.',
      ...ctx.roots.map((root) => `- ${root.id}: ${root.dir}`),
      '',
      'Return exactly one JSON object and no other text: {"suggestions":[{"skillName":"lowercase-hyphen-name","action":"create","summary":"...","confidence":0.8,"rationale":"..."}]}. The action must be either "create" or "update". Return {"suggestions":[]} when no durable improvement qualifies.',
    ].join('\n');
    let forkResult: ForkedAgentResult;

    try {
      forkResult = await runner.run({
        prompt: directive,
        promptId: 'skill-evolution-fork',
        forkLabel: 'skill-evolution-fork',
        maxTurns: 5,
        customContext: ctx.customContext,
        toolRegistry,
        agentContext: forkAgentContext,
        onCompleted: (value) => {
          completion = value;
        },
      });
    } catch (error) {
      this.lastReviewAt = Date.now();
      this.resetScoreState();
      throw new SkillEvolutionReviewAttemptError(
        error instanceof Error ? error.message : String(error),
        attemptId,
        completion,
        Date.now() - startedAt,
        { cause: error },
      );
    } finally {
      toolRegistry.dispose();
    }
    this.lastReviewAt = Date.now();
    this.resetScoreState();
    let suggestions: SkillEvolutionSuggestionInput[];
    try {
      suggestions = parseSkillEvolutionSuggestions(
        forkResult,
        maxSuggestions,
        ctx.activeSkills,
        ctx.existingSkillNames,
      );
    } catch (error) {
      throw new SkillEvolutionReviewAttemptError(
        error instanceof Error ? error.message : String(error),
        attemptId,
        completion,
        Date.now() - startedAt,
        { cause: error },
      );
    }
    const { usage, billing } =
      buildSkillEvolutionCompletionUsage(completion);
    await this.emit(
      {
        status: suggestions.length > 0 ? 'suggested' : 'no_change',
        attemptId,
        origin: 'turn_complete',
        ...(score === undefined ? {} : { reviewScore: score }),
        modelRequestIds: completion?.modelRequestIds,
        suggestions,
        durationMs: Date.now() - startedAt,
        usage,
      },
      ctx,
      completion,
      billing,
    );
  }

  private resetScoreState(): void {
    this.totalUserTextLength = 0;
    this.turnCount = 0;
    this.toolCallCount = 0;
    this.uniqueToolNames.clear();
  }
}
