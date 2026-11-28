/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { StreamingToolExecutor } from '../tool-executor/index.js';
import { testModelResolution } from '../test-utils/model-resolution.js';

import { systemPromptFromText } from '../prompts/system-prompt.js';
import { describe, expect, it, vi } from 'vitest';
import type {
  ForkedAgentCompletion,
  ForkedAgentResult,
} from '../core/forkedAgent.js';
import type { CacheSafeQuerySnapshot } from '../core/cache-safe-query-snapshot.js';

const forkMocks = vi.hoisted(() => ({
  runForkedAgent: vi.fn(),
}));

vi.mock('../core/forkedAgent.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/forkedAgent.js')>()),
  runForkedAgent: forkMocks.runForkedAgent,
}));

import {
  SkillEvolutionReviewService,
  type SkillEvolutionReviewResult,
} from './skillEvolutionReviewService.js';

type SkillEvolutionTurnContext = Parameters<
  SkillEvolutionReviewService['reviewTurn']
>[0];
type SkillEvolutionForkRunner = NonNullable<
  Parameters<SkillEvolutionReviewService['reviewTurn']>[1]
>;

function createConfig() {
  const toolExecutor = new StreamingToolExecutor();
  return {
    getToolExecutor: () => toolExecutor,
    getToolRegistry: () => ({ getAllTools: () => [] }),
    toolCallSnapshots: { publishToolCallSnapshot: vi.fn() },
    getConversationMessages: () => [],
    getModel: () => 'test-model',
    getSessionId: () => 'test-session',
    getMemoryContextManager: () => undefined,
    getWorkspaceContext: () => ({ getDirectories: () => [] }),
    stripThoughtsFromConversationHistory: vi.fn(),
  };
}

function createContext(turn: number): SkillEvolutionTurnContext {
  return {
    prompt: 'short',
    roots: [],
    activeSkills: [],
    existingSkillNames: [],
    messages: [
      {
        type: 'user',
        uuid: `turn-${turn}`,
        message: { role: 'user', content: 'short' },
      },
    ] as never,
    parentRequestId: `request-${turn}`,
  };
}

type ReviewForkJob = Parameters<SkillEvolutionForkRunner['run']>[0];

function createRunner(
  options: {
    completion?: ForkedAgentCompletion;
    messages?: ForkedAgentResult['messages'];
    textContent?: string;
    beforeRun?: (job: ReviewForkJob) => void | Promise<void>;
    error?: Error;
    emitCompletion?: boolean;
  } = {},
) {
  const completion = options.completion ?? createCompletion();
  return {
    run: vi.fn(async (job: ReviewForkJob) => {
      await options.beforeRun?.(job);
      if (options.emitCompletion !== false) job.onCompleted?.(completion);
      if (options.error) throw options.error;
      return {
        messages: options.messages ?? [],
        textContent: options.textContent ?? '{"suggestions":[]}',
        totalUsage: completion.totalUsage,
      };
    }),
  } satisfies SkillEvolutionForkRunner;
}

function createCompletion(): ForkedAgentCompletion {
  return {
    model: 'test-model',
    modelRequestIds: ['model-request-1'],
    modelRequests: [],
    modelRequestResults: [],
    totalUsage: {
      input_tokens: 5,
      output_tokens: 2,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    } as unknown as ForkedAgentCompletion['totalUsage'],
    durationMs: 1,
    success: true,
  };
}

function createMeteredCompletion(): ForkedAgentCompletion {
  const completion = createCompletion();
  return {
    ...completion,
    modelRequestIds: ['model-request-1', 'model-request-2'],
    modelRequests: [
      {
        requestId: 'model-request-1',
        model: 'test-model',
        ttftMs: 10,
        durationMs: 20,
        usage: {
          ...completion.totalUsage,
          credits: 1.25,
          original_credits: 1.5,
          billable: true,
        },
        thinkingTokens: 0,
        finishReason: 'tool_use',
      },
      {
        requestId: 'model-request-2',
        model: 'test-model',
        ttftMs: 8,
        durationMs: 16,
        usage: {
          ...completion.totalUsage,
          credits: 0.75,
          original_credits: 1,
          billable: true,
        },
        thinkingTokens: 0,
        finishReason: 'end_turn',
      },
    ],
  };
}

describe('SkillEvolutionReviewService', () => {
  it('applies the established skill review criteria', async () => {
    const service = new SkillEvolutionReviewService(createConfig() as never);
    service.configure({});
    let reviewPrompt = '';
    const runner = createRunner({
      beforeRun: (job) => {
        reviewPrompt = job.prompt;
      },
    });

    await service.reviewTurn(
      { ...createContext(1), hostReviewApproved: true },
      runner,
    );

    for (const expected of [
      'User corrected your method, scope, or output more than once',
      'User said "\u4ee5\u540e\u90fd\u8fd9\u6837\u505a"/"\u4e0b\u6b21\u6ce8\u610f"/"from now on"/"going forward"',
      'A rule in memory references a concrete tool call, fixed ID, time-range calculation, or output format',
      'You changed approach mid-way due to tool failure, wrong assumption, or user feedback',
      'A reusable 2+ step procedure emerged that another agent could execute verbatim',
      'An existing skill was invoked and extended at runtime',
      "An existing skill's name or description is misleading or narrower than its actual use",
      'Did the agent add steps SKILL.md did not cover?',
      'Did any SKILL.md command or tool call fail and require substitution?',
      "Was the user's request within the skill's stated scope, or silently stretched?",
      'Did the user issue 2+ refinement turns reaching a stable output spec?',
      'Is the final flow a reproducible pipeline another agent could rerun verbatim?',
    ]) {
      expect(reviewPrompt).toContain(expected);
    }
    expect(reviewPrompt).not.toContain('skill_suggest');
  });

  it('forwards the parent selection and turn customContext into the forked review request', async () => {
    forkMocks.runForkedAgent.mockResolvedValue({
      messages: [],
      totalUsage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      textContent: '{"suggestions":[]}',
    });
    const service = new SkillEvolutionReviewService(createConfig() as never);
    service.configure({});

    const parentSelection = testModelResolution('parent-model');
    await service.reviewTurn({
      ...createContext(1),
      hostReviewApproved: true,
      cacheSafeQuerySnapshot: {
        model: 'parent-model',
        modelResolution: parentSelection,
        systemPrompt: [],
        forkContextMessages: [],
        toolSchemas: [],
      },
      customContext: { tenant: 'skill-evolution' },
    });

    expect(forkMocks.runForkedAgent.mock.calls[0]?.[0]).toMatchObject({
      customContext: { tenant: 'skill-evolution' },
      parentSelection,
    });
    expect(forkMocks.runForkedAgent.mock.calls[0]?.[0]).not.toHaveProperty(
      'modelResolution',
    );
  });

  it('includes customContext in a custom runner job', async () => {
    const service = new SkillEvolutionReviewService(createConfig() as never);
    service.configure({});
    let observed: unknown;
    const runner = createRunner({
      beforeRun: (job) => {
        observed = job.customContext;
      },
    });

    await service.reviewTurn(
      {
        ...createContext(1),
        hostReviewApproved: true,
        customContext: { tenant: 'custom-runner' },
      },
      runner,
    );

    expect(observed).toEqual({ tenant: 'custom-runner' });
  });

  it('treats active skill roots as an optional fallback after conversation evidence', async () => {
    const service = new SkillEvolutionReviewService(createConfig() as never);
    service.configure({});
    let reviewPrompt = '';
    const runner = createRunner({
      beforeRun: (job) => {
        reviewPrompt = job.prompt;
      },
    });

    await service.reviewTurn(
      {
        ...createContext(1),
        roots: [
          {
            id: 'review',
            dir: '/test/project/.qwen/skills/review',
          },
          {
            id: 'docx',
            dir: '/app/skills/docx',
          },
        ],
        activeSkills: [
          {
            id: 'review',
            source: 'user',
          },
          {
            id: 'docx',
            source: 'built-in',
          },
        ] as const,
        hostReviewApproved: true,
      },
      runner,
    );

    const conversationFirst =
      "Use the parent conversation's already-injected skill instructions and execution trace as the primary evidence.";
    const conditionalRead =
      'Inspect the listed active skill roots only when that evidence is missing or you need referenced resources or current file state.';
    const root = '- review: /test/project/.qwen/skills/review';
    const writableSkill = '- review [source=user, writable]';
    const builtinSkill = '- docx [source=built-in, read-only]';

    expect(reviewPrompt).toContain(conversationFirst);
    expect(reviewPrompt).toContain(conditionalRead);
    expect(reviewPrompt).toContain(root);
    expect(reviewPrompt).toContain(writableSkill);
    expect(reviewPrompt).toContain(builtinSkill);
    expect(reviewPrompt.indexOf(conversationFirst)).toBeLessThan(
      reviewPrompt.indexOf(root),
    );
    expect(reviewPrompt).toContain(
      'Do not read any other skill root. Do not modify files.',
    );
    expect(reviewPrompt).not.toContain('Read the listed skill roots only.');
  });

  it('keeps the baseline review criteria when the SDK host provides a custom prompt', async () => {
    const service = new SkillEvolutionReviewService(createConfig() as never);
    service.configure({
      prompt: 'Review only release automation skills.',
    });
    let reviewPrompt = '';
    const runner = createRunner({
      beforeRun: (job) => {
        reviewPrompt = job.prompt;
      },
    });

    await service.reviewTurn(
      { ...createContext(1), hostReviewApproved: true },
      runner,
    );

    expect(reviewPrompt).toContain('Review only release automation skills.');
    expect(reviewPrompt).toContain('Strong signals');
    expect(reviewPrompt).toContain(
      'Did the agent add steps SKILL.md did not cover?',
    );
    expect(reviewPrompt).toContain(
      'Is the final flow a reproducible pipeline another agent could rerun verbatim?',
    );
  });

  it('advertises the completed parent request tool schemas to the review model', async () => {
    const results: SkillEvolutionReviewResult[] = [];
    const parentToolSchemas: CacheSafeQuerySnapshot['toolSchemas'] = [
      {
        name: 'parent_read',
        description: 'Parent tool schema',
        parameters: { type: 'object', properties: {} },
      },
    ];
    const service = new SkillEvolutionReviewService(createConfig() as never, {
      onResult: (result) => {
        results.push(result);
      },
    });
    service.configure({});
    let advertisedToolSchemas: unknown;
    const runner = createRunner({
      beforeRun: (job) => {
        advertisedToolSchemas = job.toolRegistry?.getSchema();
      },
    });

    await service.reviewTurn(
      {
        ...createContext(1),
        hostReviewApproved: true,
        cacheSafeQuerySnapshot: {
          modelResolution: testModelResolution('test-model'),
          systemPrompt: systemPromptFromText('system'),
          forkContextMessages: [],
          model: 'test-model',
          toolSchemas: parentToolSchemas,
        },
      },
      runner,
    );

    expect(advertisedToolSchemas).toEqual(parentToolSchemas);
    expect(results.at(-1)?.status).toBe('no_change');
  });

  it('returns validated suggestions from the review model final JSON response', async () => {
    const results: SkillEvolutionReviewResult[] = [];
    const service = new SkillEvolutionReviewService(createConfig() as never, {
      onResult: (result) => {
        results.push(result);
      },
    });
    service.configure({ maxSuggestions: 2 });
    const runner = createRunner({
      textContent: JSON.stringify({
        suggestions: [
          {
            skillName: 'release-check',
            action: 'create',
            summary: 'Capture the repeatable release verification flow.',
            confidence: 0.9,
            rationale: 'The same multi-step checks were corrected twice.',
          },
        ],
      }),
    });

    await service.reviewTurn(
      { ...createContext(1), hostReviewApproved: true },
      runner,
    );

    expect(results.at(-1)).toMatchObject({
      status: 'suggested',
      modelRequestIds: ['model-request-1'],
      suggestions: [
        {
          skillName: 'release-check',
          action: 'create',
          confidence: 0.9,
        },
      ],
    });
  });

  it('keeps update suggestions only for effective writable user skills', async () => {
    const results: SkillEvolutionReviewResult[] = [];
    const service = new SkillEvolutionReviewService(createConfig() as never, {
      onResult: (result) => {
        results.push(result);
      },
    });
    service.configure({ maxSuggestions: 5 });
    const runner = createRunner({
      textContent: JSON.stringify({
        suggestions: [
          {
            skillName: 'DoCx',
            action: 'update',
            summary: 'Preserve the corrected document workflow.',
            confidence: 0.9,
          },
          {
            skillName: 'verify',
            action: 'update',
            summary: 'Change a bundled verification workflow.',
            confidence: 0.9,
          },
          {
            skillName: 'plugin-review',
            action: 'update',
            summary: 'Change a plugin workflow.',
            confidence: 0.9,
          },
          {
            skillName: 'project-review',
            action: 'update',
            summary: 'Change a project workflow.',
            confidence: 0.9,
          },
          {
            skillName: 'unknown-review',
            action: 'update',
            summary: 'Change a workflow with unknown ownership.',
            confidence: 0.9,
          },
        ],
      }),
    });

    await service.reviewTurn(
      {
        ...createContext(1),
        roots: [],
        activeSkills: [
          {
            id: 'docx',
            source: 'user',
          },
          {
            id: 'verify',
            source: 'built-in',
          },
          {
            id: 'plugin-review',
            source: 'plugin',
          },
          {
            id: 'project-review',
            source: 'project',
          },
          {
            id: 'unknown-review',
            source: undefined,
          },
        ] as const,
        hostReviewApproved: true,
      },
      runner,
    );

    expect(results.at(-1)).toMatchObject({
      status: 'suggested',
      suggestions: [{ skillName: 'DoCx', action: 'update' }],
    });
  });

  it('rejects create suggestions that reuse any active skill name', async () => {
    const results: SkillEvolutionReviewResult[] = [];
    const service = new SkillEvolutionReviewService(createConfig() as never, {
      onResult: (result) => {
        results.push(result);
      },
    });
    service.configure({ maxSuggestions: 4 });
    const runner = createRunner({
      textContent: JSON.stringify({
        suggestions: [
          {
            skillName: 'DOCX',
            action: 'create',
            summary: 'Create over an existing builtin.',
            confidence: 0.9,
          },
          {
            skillName: 'existing-user',
            action: 'create',
            summary: 'Create over an existing user skill.',
            confidence: 0.9,
          },
          {
            skillName: 'inactive-pdf',
            action: 'create',
            summary: 'Create over an inactive builtin.',
            confidence: 0.9,
          },
          {
            skillName: 'durable-document-workflow',
            action: 'create',
            summary: 'Capture the durable workflow under a new name.',
            confidence: 0.9,
          },
        ],
      }),
    });

    await service.reviewTurn(
      {
        ...createContext(1),
        roots: [],
        activeSkills: [
          {
            id: 'docx',
            source: 'built-in',
          },
          {
            id: 'existing-user',
            source: 'user',
          },
        ] as const,
        existingSkillNames: ['docx', 'existing-user', 'inactive-pdf'],
        hostReviewApproved: true,
      },
      runner,
    );

    expect(results.at(-1)).toMatchObject({
      status: 'suggested',
      suggestions: [
        { skillName: 'durable-document-workflow', action: 'create' },
      ],
    });
  });

  it('aggregates multi-request fork credits into result usage', async () => {
    const config = createConfig();
    const results: SkillEvolutionReviewResult[] = [];
    const service = new SkillEvolutionReviewService(config as never, {
      onResult: (result) => {
        results.push(result);
      },
    });
    service.configure({});
    const completion = createMeteredCompletion();
    const runner = createRunner({ completion });

    await service.reviewTurn(
      {
        ...createContext(1),
        roots: [{ id: 'review', dir: '/skills/review' }],
        hostReviewApproved: true,
      },
      runner,
    );

    expect(results.at(-1)).toMatchObject({
      status: 'no_change',
      modelRequestIds: ['model-request-1', 'model-request-2'],
      usage: {
        input_tokens: 5,
        output_tokens: 2,
        credits: 2,
      },
    });
    expect(results.at(-1)).not.toHaveProperty('credits');
  });

  it('parses only the final assistant response after skill inspection turns', async () => {
    const results: SkillEvolutionReviewResult[] = [];
    const service = new SkillEvolutionReviewService(createConfig() as never, {
      onResult: (result) => {
        results.push(result);
      },
    });
    service.configure({});
    const completion = createCompletion();
    const finalJson = JSON.stringify({
      suggestions: [
        {
          skillName: 'release-check',
          action: 'update',
          summary: 'Preserve the corrected verification sequence.',
          confidence: 0.8,
        },
      ],
    });
    const runner = createRunner({
      completion,
      messages: [
        {
          type: 'assistant',
          uuid: 'inspection-message',
          timestamp: '2026-01-01T00:00:00.000Z',
          message: {
            type: 'message',
            role: 'assistant',
            stop_sequence: null,
            container: null,
            context_management: null,
            id: 'inspection-response',
            model: 'test-model',
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'I will inspect the skill.' }],
          },
        },
        {
          type: 'assistant',
          uuid: 'final-message',
          timestamp: '2026-01-01T00:00:01.000Z',
          message: {
            type: 'message',
            role: 'assistant',
            stop_sequence: null,
            container: null,
            context_management: null,
            id: 'final-response',
            model: 'test-model',
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: finalJson }],
          },
        },
      ],
      textContent: `I will inspect the skill.${finalJson}`,
    });

    await service.reviewTurn(
      {
        ...createContext(1),
        roots: [
          {
            id: 'release-check',
            dir: '/home/test/.qwen/skills/release-check',
          },
        ],
        activeSkills: [
          {
            id: 'release-check',
            source: 'user',
          },
        ] as const,
        hostReviewApproved: true,
      },
      runner,
    );

    expect(results.at(-1)).toMatchObject({
      status: 'suggested',
      suggestions: [{ skillName: 'release-check', action: 'update' }],
    });
  });

  it('reports malformed model output with its request ids and usage without retrying', async () => {
    const results: SkillEvolutionReviewResult[] = [];
    const service = new SkillEvolutionReviewService(createConfig() as never, {
      onResult: (result) => {
        results.push(result);
      },
    });
    service.configure({});
    const completion = createMeteredCompletion();
    const runner = createRunner({ completion, textContent: 'not json' });

    await service.reviewTurn(
      { ...createContext(1), hostReviewApproved: true },
      runner,
    );

    expect(runner.run).toHaveBeenCalledOnce();
    expect(results.at(-1)).toMatchObject({
      status: 'failed',
      modelRequestIds: ['model-request-1', 'model-request-2'],
      usage: { input_tokens: 5, output_tokens: 2, credits: 2 },
    });
    expect(results.at(-1)).not.toHaveProperty('credits');
  });

  it('rejects suggestions with empty required text fields', async () => {
    const results: SkillEvolutionReviewResult[] = [];
    const service = new SkillEvolutionReviewService(createConfig() as never, {
      onResult: (result) => {
        results.push(result);
      },
    });
    service.configure({});
    const runner = createRunner({
      textContent: JSON.stringify({
        suggestions: [
          {
            skillName: '   ',
            action: 'create',
            summary: '',
            confidence: 0.9,
          },
        ],
      }),
    });

    await service.reviewTurn(
      { ...createContext(1), hostReviewApproved: true },
      runner,
    );

    expect(results.at(-1)).toMatchObject({
      status: 'failed',
      suggestions: [],
    });
  });

  it('applies cooldown after malformed output instead of forking again next turn', async () => {
    const results: SkillEvolutionReviewResult[] = [];
    const service = new SkillEvolutionReviewService(createConfig() as never, {
      onResult: (result) => {
        results.push(result);
      },
    });
    service.configure({ reviewThreshold: 1 });
    const runner = createRunner({ textContent: 'not json' });

    await service.reviewTurn(createContext(1), runner);
    await service.reviewTurn(createContext(2), runner);

    expect(runner.run).toHaveBeenCalledOnce();
    expect(results.map((result) => result.status)).toEqual([
      'failed',
      'skipped',
    ]);
    expect(results.at(-1)).toMatchObject({ reason: 'cooldown' });
  });

  it('applies cooldown and preserves usage after a failed model request', async () => {
    const config = createConfig();
    const results: SkillEvolutionReviewResult[] = [];
    const service = new SkillEvolutionReviewService(config as never, {
      onResult: (result) => {
        results.push(result);
      },
    });
    service.configure({ reviewThreshold: 1 });
    const completion = createCompletion();
    const runner = createRunner({
      completion: { ...completion, success: false },
      error: new Error('provider failed'),
    });

    await service.reviewTurn(createContext(1), runner);
    await service.reviewTurn(createContext(2), runner);

    expect(runner.run).toHaveBeenCalledOnce();
    expect(results[0]).toMatchObject({
      status: 'failed',
      reason: 'provider failed',
      modelRequestIds: ['model-request-1'],
      usage: { input_tokens: 5, output_tokens: 2 },
    });
    expect(results[1]).toMatchObject({
      status: 'skipped',
      reason: 'cooldown',
    });
  });

  it('accumulates the built-in review score across turns before starting a fork', async () => {
    const results: SkillEvolutionReviewResult[] = [];
    const service = new SkillEvolutionReviewService(createConfig() as never, {
      onResult: (result) => {
        results.push(result);
      },
    });
    service.configure({ prompt: 'review skills' });
    const runner = createRunner();

    for (let turn = 1; turn <= 8; turn += 1) {
      await service.reviewTurn(createContext(turn), runner);
    }

    expect(runner.run).toHaveBeenCalledOnce();
    expect(results.map((result) => result.status)).toEqual([
      'skipped',
      'skipped',
      'skipped',
      'skipped',
      'skipped',
      'skipped',
      'skipped',
      'no_change',
    ]);
    expect(results.at(-1)).toMatchObject({
      reviewScore: 8,
      modelRequestIds: ['model-request-1'],
      usage: { input_tokens: 5, output_tokens: 2 },
    });
  });

  it('uses an approved host gate instead of the built-in score and cooldown', async () => {
    const results: SkillEvolutionReviewResult[] = [];
    const service = new SkillEvolutionReviewService(createConfig() as never, {
      onResult: (result) => {
        results.push(result);
      },
    });
    service.configure({ prompt: 'review skills' });
    const runner = createRunner();

    await service.reviewTurn(
      { ...createContext(1), hostReviewApproved: true },
      runner,
    );
    await service.reviewTurn(
      { ...createContext(2), hostReviewApproved: true },
      runner,
    );

    expect(runner.run).toHaveBeenCalledTimes(2);
    expect(results.map((result) => result.status)).toEqual([
      'no_change',
      'no_change',
    ]);
    expect(results.map((result) => result.reviewScore)).toEqual([
      undefined,
      undefined,
    ]);
    expect(results.every((result) => !('reviewScore' in result))).toBe(true);
  });

  it('continues accepting host-approved reviews after repeated fork failures', async () => {
    const results: SkillEvolutionReviewResult[] = [];
    const service = new SkillEvolutionReviewService(createConfig() as never, {
      onResult: (result) => {
        results.push(result);
      },
    });
    service.configure({});
    const runner = createRunner({
      error: new Error('provider failed'),
      emitCompletion: false,
    });

    for (let turn = 1; turn <= 4; turn += 1) {
      await service.reviewTurn(
        { ...createContext(turn), hostReviewApproved: true },
        runner,
      );
    }

    expect(runner.run).toHaveBeenCalledTimes(4);
    expect(results).toHaveLength(4);
    expect(results.every((result) => result.status === 'failed')).toBe(true);
  });

  it('keeps its own single-flight queue and reviews only the latest pending turn', async () => {
    const results: SkillEvolutionReviewResult[] = [];
    const service = new SkillEvolutionReviewService(createConfig() as never, {
      onResult: (result) => {
        results.push(result);
      },
    });
    service.configure({});
    const completion = createCompletion();
    let releaseFirstReview: (() => void) | undefined;
    const firstReviewBlocked = new Promise<void>((resolve) => {
      releaseFirstReview = resolve;
    });
    const firstRunner = createRunner({
      completion,
      beforeRun: async () => {
        await firstReviewBlocked;
      },
    });
    const replacedRunner = createRunner({ completion });
    const latestRunner = createRunner({ completion });

    const first = service.reviewTurn(
      { ...createContext(1), hostReviewApproved: true },
      firstRunner,
    );
    await vi.waitFor(() => expect(firstRunner.run).toHaveBeenCalledOnce());
    await service.reviewTurn(
      { ...createContext(2), hostReviewApproved: true },
      replacedRunner,
    );
    await service.reviewTurn(
      { ...createContext(3), hostReviewApproved: true },
      latestRunner,
    );

    expect(replacedRunner.run).not.toHaveBeenCalled();
    expect(latestRunner.run).not.toHaveBeenCalled();
    releaseFirstReview?.();
    await first;

    expect(replacedRunner.run).not.toHaveBeenCalled();
    expect(latestRunner.run).toHaveBeenCalledOnce();
    expect(results).toHaveLength(2);
    expect(results.map((result) => result.sourceRequestIds)).toEqual([
      ['request-1'],
      ['request-3'],
    ]);
  });

  it('waits ten minutes after a review before allowing another fork', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      const service = new SkillEvolutionReviewService(createConfig() as never);
      service.configure({ reviewThreshold: 1 });
      const runner = createRunner();
      await service.reviewTurn(createContext(1), runner);
      now.mockReturnValue(1_000_000 + 600_000 - 1);
      await service.reviewTurn(createContext(2), runner);
      expect(runner.run).toHaveBeenCalledOnce();
      now.mockReturnValue(1_000_000 + 600_000);
      await service.reviewTurn(createContext(3), runner);
      expect(runner.run).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  it('uses the configured review threshold', async () => {
    const results: SkillEvolutionReviewResult[] = [];
    const service = new SkillEvolutionReviewService(createConfig() as never, {
      onResult: (result) => {
        results.push(result);
      },
    });
    service.configure({ reviewThreshold: 2 });
    const runner = createRunner();

    await service.reviewTurn(createContext(1), runner);
    await service.reviewTurn(createContext(2), runner);

    expect(runner.run).toHaveBeenCalledOnce();
    expect(results.map((result) => result.status)).toEqual([
      'skipped',
      'no_change',
    ]);
    expect(results[0]?.sourceRequestIds).toEqual(['request-1']);
    expect(results.at(-1)?.reviewScore).toBe(2);
  });

  it('caps the reported review score while cooldown defers another fork', async () => {
    const results: SkillEvolutionReviewResult[] = [];
    const service = new SkillEvolutionReviewService(createConfig() as never, {
      onResult: (result) => {
        results.push(result);
      },
    });
    service.configure({ reviewThreshold: 1 });
    const runner = createRunner();

    for (let turn = 1; turn <= 12; turn += 1) {
      await service.reviewTurn(createContext(turn), runner);
    }

    expect(runner.run).toHaveBeenCalledOnce();
    expect(results[0]).toMatchObject({ status: 'no_change', reviewScore: 1 });
    expect(results.at(-1)).toMatchObject({
      status: 'skipped',
      reason: 'cooldown',
      reviewScore: 10,
    });
  });
});
