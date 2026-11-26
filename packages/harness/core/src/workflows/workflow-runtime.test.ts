/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  runWorkflowScript,
  WorkflowAgentUserRetryError,
} from './workflow-runtime.js';
import { WorkflowJournal } from './workflow-journal.js';

describe('runWorkflowScript', () => {
  const config = {} as Parameters<typeof runWorkflowScript>[0]['config'];

  it('returns native script values across direct, pipeline, parallel, child and resume paths', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-native-return-'));
    const journalPath = path.join(tmp, 'journal.jsonl');
    const scriptBody = `
const direct = await agent('direct');
const staged = await pipeline(['pipe'], text => agent(text), text => text.toUpperCase());
const batch = await parallel([() => agent('parallel'), () => agent({ prompt: 'skip', skip: true }), () => agent('api')]);
const nested = await workflow('child');
const structured = await agent('json', {schema: {type:'object', properties:{value:{type:'number'}}}});
return {direct, staged, batch, nested, structured};`;
    const invokeAgent = vi.fn(async ({ invocation }: Parameters<NonNullable<Parameters<typeof runWorkflowScript>[0]['invokeAgent']>>[0]) => invocation.prompt === 'api'
      ? { content: 'terminal error', state: 'error' as const, apiError: 'terminal' }
      : { content: invocation.prompt, state: 'done' as const, ...(invocation.schema ? { structured: { value: 7 } } : {}) });
    try {
      const journal = await WorkflowJournal.load(journalPath);
      const result = await runWorkflowScript({ config, scriptBody, journal, invokeAgent,
        resolveWorkflow: async () => ({ meta: {name:'child',description:'Child'}, scriptBody: `return await agent('child');` }),
      });
      expect(result.error).toBeUndefined();
      expect(result.result).toEqual({ direct: 'direct', staged: ['PIPE'], batch: ['parallel', null, null], nested: 'child', structured: { value: 7 } });
      const persisted = await fs.readFile(journalPath, 'utf8');
      expect(persisted).toContain('"content":"direct"');
      const resumedAgent = vi.fn(async () => ({ content: 'unexpected', state: 'done' as const }));
      const resumed = await runWorkflowScript({ config, scriptBody: `return await agent('direct');`, journal: await WorkflowJournal.load(journalPath), invokeAgent: resumedAgent });
      expect(resumed.result).toBe('direct');
      expect(resumedAgent).not.toHaveBeenCalled();
      const repeated = await runWorkflowScript({ config, scriptBody: `return await agent('direct');`, journal: await WorkflowJournal.load(journalPath), invokeAgent: resumedAgent });
      expect(repeated.result).toBe('direct');
      expect(resumedAgent).not.toHaveBeenCalled();
      const legacyString = await runWorkflowScript({
        config,
        scriptBody: `return {content: 'plain'.content, state: 'plain'.state};`,
        invokeAgent: resumedAgent,
      });
      expect(legacyString.result).toEqual({ content: 'plain', state: 'done' });
    } finally { await fs.rm(tmp, { recursive: true, force: true }); }
  });

  it('keeps previous result.content workflows working while returning real strings', async () => {
    const invokeAgent = vi.fn(
      async ({ invocation }: Parameters<
        NonNullable<Parameters<typeof runWorkflowScript>[0]['invokeAgent']>
      >[0]) => ({
        content: invocation.prompt,
        state: 'done' as const,
      }),
    );

    const result = await runWorkflowScript({
      config,
      invokeAgent,
      resolveWorkflow: async () => ({
        meta: { name: 'child', description: 'Child' },
        scriptBody: `const result = await agent('child'); return result.content;`,
      }),
      scriptBody: `
const direct = await agent('direct');
const piped = await pipeline(
  ['one'],
  (_, item) => agent(item),
  (review) => agent('verify:' + review.content),
);
const parallelResults = await parallel([
  () => agent('left'),
  () => agent('right'),
]);
const child = await workflow('child');
return {
  direct,
  directContent: direct.content,
  directState: direct.state,
  strictString: direct === 'direct',
  valueType: typeof direct,
  upper: direct.toUpperCase(),
  piped: piped.map((entry) => entry.content),
  parallel: parallelResults.map((entry) => entry.content),
  child,
  compatibilityFieldsAreEnumerable: Object.keys(direct).some(
    (key) => key === 'content' || key === 'state'
  ),
};`,
    });

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      direct: 'direct',
      directContent: 'direct',
      directState: 'done',
      strictString: true,
      valueType: 'string',
      upper: 'DIRECT',
      piped: ['verify:one'],
      parallel: ['left', 'right'],
      child: 'child',
      compatibilityFieldsAreEnumerable: false,
    });
    expect(
      Object.prototype.hasOwnProperty.call(String.prototype, 'content'),
    ).toBe(false);
    expect(
      Object.prototype.hasOwnProperty.call(String.prototype, 'state'),
    ).toBe(false);
  });

  it('keeps result.content compatibility for journal replay', async () => {
    const tmp = await fs.mkdtemp(
      path.join(os.tmpdir(), 'workflow-content-compat-'),
    );
    const journalPath = path.join(tmp, 'journal.jsonl');
    const scriptBody = `const result = await agent('cached'); return result.content;`;
    try {
      const liveAgent = vi.fn(async () => ({
        content: 'cached text',
        state: 'done' as const,
      }));
      const live = await runWorkflowScript({
        config,
        scriptBody,
        journal: await WorkflowJournal.load(journalPath),
        invokeAgent: liveAgent,
      });
      expect(live.result).toBe('cached text');
      expect(liveAgent).toHaveBeenCalledOnce();

      const replayAgent = vi.fn(async () => ({
        content: 'unexpected',
        state: 'done' as const,
      }));
      const replay = await runWorkflowScript({
        config,
        scriptBody,
        journal: await WorkflowJournal.load(journalPath),
        invokeAgent: replayAgent,
      });
      expect(replay.result).toBe('cached text');
      expect(replayAgent).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('normalizes per-call constraints before journaling and invalidates cached results when they change', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-constraint-cache-'));
    const journalPath = path.join(tmp, 'journal.jsonl');
    const invokeAgent = vi.fn(async () => ({ content: 'result', state: 'done' as const }));
    try {
      for (const disallowedTools of [['Write', 'Bash', 'Write'], ['Bash', 'Write'], ['Write']]) {
        const result = await runWorkflowScript({ config, journal: await WorkflowJournal.load(journalPath),
          scriptBody: `return await agent('same prompt', {disallowedTools: ${JSON.stringify(disallowedTools)}});`, invokeAgent });
        expect(result.result).toBe('result');
      }
      expect(invokeAgent).toHaveBeenCalledTimes(2);
      const invalid = await runWorkflowScript({ config, scriptBody: `return await agent('same', {disallowedTools: 'Bash'});`, invokeAgent });
      expect(invalid.error).toContain('opts.disallowedTools');
      expect(invokeAgent).toHaveBeenCalledTimes(2);
    } finally { await fs.rm(tmp, { recursive: true, force: true }); }
  });

  it('runs a basic script with args, phase, and log', async () => {
    const progress: string[] = [];
    const result = await runWorkflowScript({
      config,
      args: { value: 2 },
      scriptBody: `
phase('Start');
log('hello');
return args.value + 1;
`,
      onProgress: (item) => progress.push(item.type),
    });

    expect(result.error).toBeUndefined();
    expect(result.result).toBe(3);
    expect(result.logs).toEqual(['hello']);
    expect(result.phaseCount).toBe(1);
    expect(progress).toContain('workflow_phase');
    expect(progress).toContain('workflow_log');
  });

  it('removes abort listeners after script completion', async () => {
    const controller = new AbortController();
    const addSpy = vi.spyOn(controller.signal, 'addEventListener');
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

    const result = await runWorkflowScript({
      config,
      signal: controller.signal,
      scriptBody: `return 'done';`,
    });

    expect(result.error).toBeUndefined();
    expect(result.result).toBe('done');
    expect(removeSpy).toHaveBeenCalledTimes(addSpy.mock.calls.length);
  });

  it('does not let an aborted agent catch resume the detached script', async () => {
    const controller = new AbortController();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const invokeAgent = vi.fn(
      async ({ signal }: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          markStarted?.();
          const rejectForAbort = () => reject(new Error('agent aborted'));
          if (signal?.aborted) {
            rejectForAbort();
            return;
          }
          signal?.addEventListener('abort', rejectForAbort, { once: true });
        }),
    );

    const run = runWorkflowScript({
      config,
      signal: controller.signal,
      scriptBody: `
try {
  await agent({ prompt: 'first' });
} catch {}
log('continued after abort');
return await agent({ prompt: 'second' });
`,
      invokeAgent,
    });
    await started;

    controller.abort('workflow-pause');
    const result = await run;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.error).toBe('Workflow aborted');
    expect(result.failures).toEqual([]);
    expect(result.logs).not.toContain('continued after abort');
    expect(invokeAgent).toHaveBeenCalledTimes(1);
  });

  it('does not start queued agents after the workflow aborts', async () => {
    const controller = new AbortController();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const invokeAgent = vi.fn(
      async ({ signal }: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          markStarted?.();
          const rejectForAbort = () => reject(new Error('agent aborted'));
          if (signal?.aborted) {
            rejectForAbort();
            return;
          }
          signal?.addEventListener('abort', rejectForAbort, { once: true });
        }),
    );
    const journal = {
      nextCachedResult: vi.fn(async ({ prompt }: { prompt: string }) => ({
        key: `${prompt}-key`,
      })),
      appendStarted: vi.fn(async () => {}),
      appendResult: vi.fn(async () => {}),
      appendEvent: vi.fn(async () => {}),
    };

    const run = runWorkflowScript({
      config,
      signal: controller.signal,
      maxConcurrency: 1,
      journal,
      scriptBody: `
return await parallel([
  () => agent({ prompt: 'first' }),
  () => agent({ prompt: 'queued' }),
]);
`,
      invokeAgent,
    });
    await started;

    controller.abort('workflow-pause');
    const result = await run;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.error).toBe('Workflow aborted');
    expect(invokeAgent).toHaveBeenCalledTimes(1);
    expect(invokeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        invocation: expect.objectContaining({ prompt: 'first' }),
      }),
    );
    expect(journal.appendStarted).toHaveBeenCalledTimes(1);
    expect(journal.appendStarted).toHaveBeenCalledWith(
      'first-key',
      undefined,
    );
    expect(journal.appendEvent).toHaveBeenCalledWith(
      'first-key',
      expect.objectContaining({ kind: 'attempt_started', attempt: 1 }),
    );
    expect(journal.appendEvent).not.toHaveBeenCalledWith(
      'queued-key',
      expect.objectContaining({ kind: 'attempt_started' }),
    );
  });

  it.each([
    ['agent', `return await agent({ prompt: 'must not start' });`],
    [
      'parallel',
      `return await parallel([() => log('parallel continued')]);`,
    ],
    [
      'pipeline',
      `return await pipeline([1], () => log('pipeline continued'));`,
    ],
    ['child workflow', `return await workflow('must-not-resolve');`],
  ])('keeps pre-aborted %s work pending', async (_name, scriptBody) => {
    const controller = new AbortController();
    controller.abort('workflow-pause');
    const invokeAgent = vi.fn(async () => ({
      content: 'unexpected',
      state: 'done' as const,
    }));
    const resolveWorkflow = vi.fn(async () => ({
      meta: { name: 'unexpected', description: 'Unexpected' },
      scriptBody: `return 'unexpected';`,
    }));

    const result = await runWorkflowScript({
      config,
      signal: controller.signal,
      scriptBody,
      invokeAgent,
      resolveWorkflow,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.error).toBe('Workflow aborted');
    expect(result.logs).toEqual([]);
    expect(invokeAgent).not.toHaveBeenCalled();
    expect(resolveWorkflow).not.toHaveBeenCalled();
  });

  it('clears workflow timers after script completion', async () => {
    vi.useFakeTimers();
    try {
      const result = await runWorkflowScript({
        config,
        scriptBody: `
setTimeout(() => log('late timer'), 10);
return 'done';
`,
      });

      expect(result.error).toBeUndefined();
      expect(result.result).toBe('done');
      vi.advanceTimersByTime(10);
      expect(result.logs).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes JSON-encoded string args verbatim instead of parsing them', async () => {
    const result = await runWorkflowScript({
      config,
      args: '{"value":"ok"}',
      scriptBody: `
return { type: typeof args, value: args.value };
`,
    });

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ type: 'string', value: undefined });
  });

  it('turns parallel slot failures into nulls', async () => {
    const result = await runWorkflowScript({
      config,
      scriptBody: `
return await parallel([
  () => 1,
  () => { throw new Error('bad slot'); },
]);
`,
    });

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual([1, null]);
    expect(result.failures[0]).toContain('parallel[1] failed');
  });

  it('blocks nondeterministic globals at runtime', async () => {
    const result = await runWorkflowScript({
      config,
      scriptBody: `return Date.now();`,
    });

    expect(result.error).toContain('Date.now() is unavailable');
  });

  it('disables string code generation in the workflow vm', async () => {
    const result = await runWorkflowScript({
      config,
      scriptBody: `return eval('1 + 1');`,
    });

    expect(result.error).toContain('Code generation from strings disallowed');
  });

  it('enforces parallel and pipeline item limits', async () => {
    const parallelResult = await runWorkflowScript({
      config,
      maxItems: 1,
      scriptBody: `return await parallel([() => 1, () => 2]);`,
    });
    expect(parallelResult.error).toContain('parallel() item limit exceeded (1)');

    const pipelineResult = await runWorkflowScript({
      config,
      maxItems: 1,
      scriptBody: `return await pipeline([1, 2], (value) => value);`,
    });
    expect(pipelineResult.error).toContain('pipeline() item limit exceeded (1)');
  });

  it('does not expose Node require', async () => {
    const result = await runWorkflowScript({
      config,
      scriptBody: `return typeof require;`,
    });

    expect(result.result).toBe('undefined');
  });

  it('injects agent as a controlled runtime function', async () => {
    const invokeAgent = vi.fn(async ({ invocation }) => ({
      content: `done:${invocation.prompt}`,
      state: 'done' as const,
      agentId: 'agent-1',
      agentType: invocation.type,
    }));
    const progress: string[] = [];

    const result = await runWorkflowScript({
      config,
      scriptBody: `
phase('Inspect');
return await agent({ type: 'general-purpose', prompt: 'read files' });
`,
      invokeAgent,
      onProgress: (item) => progress.push(item.type),
    });

    expect(result.error).toBeUndefined();
    expect(result.agentCount).toBe(1);
    expect(result.result).toBe('done:read files');
    expect(invokeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        invocation: expect.objectContaining({
          prompt: 'read files',
          phaseTitle: 'Inspect',
          phaseIndex: 1,
        }),
      }),
    );
    expect(progress).toEqual([
      'workflow_phase',
      'workflow_agent',
      'workflow_agent',
    ]);
  });

  it('uses each agent phase override without mutating the global phase', async () => {
    const invocations: Array<{
      label: string;
      phaseIndex?: number;
      phaseTitle?: string;
    }> = [];
    const agentEvents: Array<
      Extract<
        Parameters<
          NonNullable<Parameters<typeof runWorkflowScript>[0]['onProgress']>
        >[0],
        { type: 'workflow_agent' }
      >
    > = [];

    const result = await runWorkflowScript({
      config,
      seedPhaseTitles: ['Scope', 'Search', 'Fetch'],
      scriptBody: `
phase('Scope');
const grouped = await parallel([
  () => agent('search', { label: 'search', phase: 'Search' }),
  () => agent('fetch', { label: 'fetch', phase: 'Fetch' }),
]);
const ungrouped = await agent('after', { label: 'after' });
return [...grouped, ungrouped];
`,
      invokeAgent: async ({ invocation, onProgress }) => {
        invocations.push({
          label: invocation.label,
          phaseIndex: invocation.phaseIndex,
          phaseTitle: invocation.phaseTitle,
        });
        onProgress?.({ lastToolName: 'TestTool' });
        return { content: invocation.prompt, state: 'done' as const };
      },
      onProgress: (item) => {
        if (item.type === 'workflow_agent') agentEvents.push(item);
      },
    });

    expect(result.error).toBeUndefined();
    expect(invocations).toEqual([
      { label: 'search', phaseIndex: 2, phaseTitle: 'Search' },
      { label: 'fetch', phaseIndex: 3, phaseTitle: 'Fetch' },
      { label: 'after', phaseIndex: 1, phaseTitle: 'Scope' },
    ]);
    for (const event of agentEvents) {
      const expectedPhase =
        event.label === 'search'
          ? { phaseIndex: 2, phaseTitle: 'Search' }
          : event.label === 'fetch'
            ? { phaseIndex: 3, phaseTitle: 'Fetch' }
            : { phaseIndex: 1, phaseTitle: 'Scope' };
      expect(event).toMatchObject(expectedPhase);
    }
  });

  it('emits workflow agent observability fields for transcript indexing', async () => {
    const agentEvents: Array<
      Extract<
        Parameters<NonNullable<Parameters<typeof runWorkflowScript>[0]['onProgress']>>[0],
        { type: 'workflow_agent' }
      >
    > = [];
    const journal = {
      nextCachedResult: vi.fn(async () => ({ key: 'journal-key-1' })),
      appendStarted: vi.fn(async () => {}),
      appendResult: vi.fn(async () => {}),
      appendEvent: vi.fn(async () => {}),
    };

    const result = await runWorkflowScript({
      config,
      journal,
      scriptBody: `
return await agent({
  name: 'reader',
  prompt: 'read the full repository',
  model: 'example-fast',
});
`,
      invokeAgent: async ({ invocation }) => ({
        content: `done:${invocation.prompt}`,
        state: 'done' as const,
        agentId: 'agent-1',
        agentType: invocation.type,
        outputPath: '/tmp/agent-output.json',
        transcriptPath: '/tmp/agent-transcript.jsonl',
        tokens: 12,
        toolCalls: 3,
      }),
      onProgress: (item) => {
        if (item.type === 'workflow_agent') agentEvents.push(item);
      },
    });

    expect(result.error).toBeUndefined();
    expect(agentEvents).toHaveLength(2);
    expect(agentEvents[0]).toMatchObject({
      state: 'start',
      label: 'reader',
      model: 'example-fast',
      prompt: 'read the full repository',
      journalKey: 'journal-key-1',
      promptPreview: 'read the full repository',
    });
    expect(agentEvents[1]).toMatchObject({
      state: 'done',
      agentId: 'agent-1',
      model: 'example-fast',
      prompt: 'read the full repository',
      journalKey: 'journal-key-1',
      outputPath: '/tmp/agent-output.json',
      transcriptPath: '/tmp/agent-transcript.jsonl',
      attemptTranscriptPaths: ['/tmp/agent-transcript.jsonl'],
      tokens: 12,
      toolCalls: 3,
    });
  });

  it('emits live workflow agent tool activity while the agent is running', async () => {
    const agentEvents: Array<
      Extract<
        Parameters<NonNullable<Parameters<typeof runWorkflowScript>[0]['onProgress']>>[0],
        { type: 'workflow_agent' }
      >
    > = [];

    const result = await runWorkflowScript({
      config,
      scriptBody: `
return await agent({
  name: 'reader',
  prompt: 'read files',
});
`,
      invokeAgent: async ({ onProgress }) => {
        onProgress?.({
          lastToolName: 'Read',
          lastToolSummary: '/repo/file.ts',
          recentToolActivities: ['Glob(**/*.ts)', 'Read(/repo/file.ts)'],
          toolCalls: 2,
          lastProgressAt: 1234,
        });
        return {
          content: 'done',
          state: 'done' as const,
          agentId: 'agent-1',
          toolCalls: 1,
        };
      },
      onProgress: (item) => {
        if (item.type === 'workflow_agent') agentEvents.push(item);
      },
    });

    expect(result.error).toBeUndefined();
    expect(agentEvents.map((event) => event.state)).toEqual([
      'start',
      'progress',
      'done',
    ]);
    expect(agentEvents[1]).toMatchObject({
      state: 'progress',
      label: 'reader',
      lastToolName: 'Read',
      lastToolSummary: '/repo/file.ts',
      recentToolActivities: ['Glob(**/*.ts)', 'Read(/repo/file.ts)'],
      toolCalls: 2,
      lastProgressAt: 1234,
    });
  });

  it('supports agent(prompt, opts) shorthand', async () => {
    const invokeAgent = vi.fn(async ({ invocation }) => ({
      content: `done:${invocation.prompt}`,
      state: 'done' as const,
      agentType: invocation.type,
    }));

    const result = await runWorkflowScript({
      config,
      scriptBody: `
return await agent('read files', { type: 'general-purpose', label: 'reader', description: 'Read files' });
`,
      invokeAgent,
    });

    expect(result.error).toBeUndefined();
    expect(result.result).toBe('done:read files');
    expect(invokeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        invocation: expect.objectContaining({
          prompt: 'read files',
          type: 'general-purpose',
          label: 'reader',
          description: 'Read files',
        }),
      }),
    );
  });

  it('normalizes agent effort into the invocation, progress, and journal input', async () => {
    const progress: Array<{ state: string; effort?: string }> = [];
    const journal = {
      nextCachedResult: vi.fn(async () => ({ key: 'effort-key' })),
      appendStarted: vi.fn(async () => {}),
      appendResult: vi.fn(async () => {}),
      appendEvent: vi.fn(async () => {}),
    };
    const invokeAgent = vi.fn(async () => ({
      content: 'done',
      state: 'done' as const,
    }));

    const result = await runWorkflowScript({
      config,
      journal,
      scriptBody: `
return await agent('review carefully', { effort: 'XHIGH' });
`,
      invokeAgent,
      onProgress: (item) => {
        if (item.type === 'workflow_agent') progress.push(item);
      },
    });

    expect(result.error).toBeUndefined();
    expect(journal.nextCachedResult).toHaveBeenCalledWith(
      expect.objectContaining({ effort: 'xhigh' }),
    );
    expect(invokeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        invocation: expect.objectContaining({ effort: 'xhigh' }),
      }),
    );
    expect(progress).toEqual([
      expect.objectContaining({ state: 'start', effort: 'xhigh' }),
      expect.objectContaining({ state: 'done', effort: 'xhigh' }),
    ]);
  });

  it('validates agent structured output with schema', async () => {
    const result = await runWorkflowScript({
      config,
      scriptBody: `
const worker = await agent({
  prompt: 'return json',
  schema: {
    type: 'object',
    properties: { value: { type: 'number' } },
    required: ['value'],
    additionalProperties: false,
  },
});
return worker.value;
`,
      invokeAgent: async () => ({
        content: '{"value":42}',
        state: 'done' as const,
        structured: { value: 42 },
      }),
    });

    expect(result.error).toBeUndefined();
    expect(result.result).toBe(42);
  });

  it('returns cached structured agent output directly to workflow scripts', async () => {
    const invokeAgent = vi.fn();
    const journal = {
      nextCachedResult: vi.fn(async () => ({
        key: 'cache-key',
        result: {
          content: '{"value":42}',
          state: 'done' as const,
          structured: { value: 42 },
        },
      })),
      appendStarted: vi.fn(async () => {}),
      appendResult: vi.fn(async () => {}),
      appendEvent: vi.fn(async () => {}),
    };

    const result = await runWorkflowScript({
      config,
      journal,
      scriptBody: `
const worker = await agent({
  prompt: 'return json',
  schema: {
    type: 'object',
    properties: { value: { type: 'number' } },
    required: ['value'],
    additionalProperties: false,
  },
});
return worker.value;
`,
      invokeAgent,
    });

    expect(result.error).toBeUndefined();
    expect(result.result).toBe(42);
    expect(invokeAgent).not.toHaveBeenCalled();
  });

  it('fails the workflow when agent structured output violates schema', async () => {
    const result = await runWorkflowScript({
      config,
      scriptBody: `
return await agent({
  name: 'structured-worker',
  prompt: 'return json',
  schema: {
    type: 'object',
    properties: { value: { type: 'number' } },
    required: ['value'],
    additionalProperties: false,
  },
});
`,
      invokeAgent: async () => ({
        content: '{"value":"bad"}',
        state: 'done' as const,
      }),
    });

    expect(result.error).toContain(
      'agent structured output does not match schema',
    );
    expect(result.failures[0]).toContain('agent[1] structured-worker failed');
    expect(result.agentCount).toBe(1);
  });

  it('retries failed agents before succeeding', async () => {
    let calls = 0;
    const invocationAttempts: number[] = [];
    const progress: string[] = [];
    const attempts: Array<{ attempt?: number; maxAttempts?: number }> = [];
    const result = await runWorkflowScript({
      config,
      scriptBody: `
return await agent({ name: 'unstable-worker', prompt: 'unstable', retries: 1 });
`,
      invokeAgent: async ({ invocation }) => {
        calls++;
        invocationAttempts.push(invocation.attempt);
        if (calls === 1) {
          throw new Error('temporary failure');
        }
        return {
          content: 'ok',
          state: 'done' as const,
        };
      },
      onProgress: (item) => {
        if (item.type === 'workflow_agent') {
          progress.push(item.state);
          attempts.push({
            attempt: item.attempt,
            maxAttempts: item.maxAttempts,
          });
        }
      },
    });

    expect(result.error).toBeUndefined();
    expect(calls).toBe(2);
    expect(invocationAttempts).toEqual([1, 2]);
    expect(result.result).toBe('ok');
    expect(progress).toContain('retry');
    expect(attempts).toContainEqual({ attempt: 1, maxAttempts: 2 });
    expect(attempts).toContainEqual({ attempt: 2, maxAttempts: 2 });
  });

  it('preserves transcript paths across retry attempts', async () => {
    let calls = 0;
    const agentEvents: Array<
      Extract<
        Parameters<NonNullable<Parameters<typeof runWorkflowScript>[0]['onProgress']>>[0],
        { type: 'workflow_agent' }
      >
    > = [];

    const result = await runWorkflowScript({
      config,
      scriptBody: `
return await agent({ name: 'unstable-worker', prompt: 'unstable', retries: 1 });
`,
      invokeAgent: async () => {
        calls++;
        if (calls === 1) {
          return {
            content: 'bad',
            state: 'error' as const,
            transcriptPath: '/tmp/attempt-1.jsonl',
          };
        }
        return {
          content: 'ok',
          state: 'done' as const,
          transcriptPath: '/tmp/attempt-2.jsonl',
        };
      },
      onProgress: (item) => {
        if (item.type === 'workflow_agent') agentEvents.push(item);
      },
    });

    expect(result.error).toBeUndefined();
    expect(agentEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: 'retry',
          attemptTranscriptPaths: ['/tmp/attempt-1.jsonl'],
        }),
        expect.objectContaining({
          state: 'done',
          transcriptPath: '/tmp/attempt-2.jsonl',
          attemptTranscriptPaths: [
            '/tmp/attempt-1.jsonl',
            '/tmp/attempt-2.jsonl',
          ],
        }),
      ]),
    );
  });

  it('skips agents without invoking subagents', async () => {
    const invokeAgent = vi.fn();
    const progress: string[] = [];
    const result = await runWorkflowScript({
      config,
      scriptBody: `
return await agent({
  name: 'skip-worker',
  prompt: 'skip me',
  skip: true,
  skipReason: 'already covered',
});
`,
      invokeAgent,
      onProgress: (item) => {
        if (item.type === 'workflow_agent') progress.push(item.state);
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.result).toBeNull();
    expect(invokeAgent).not.toHaveBeenCalled();
    expect(progress).toContain('skipped');
  });

  it('returns null when a live workflow agent is skipped by user control', async () => {
    const progress: string[] = [];
    const result = await runWorkflowScript({
      config,
      scriptBody: `
return await agent({ name: 'skip-live-worker', prompt: 'skip live' });
`,
      invokeAgent: async () => null,
      onProgress: (item) => {
        if (item.type === 'workflow_agent') progress.push(item.state);
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.result).toBeNull();
    expect(progress).toContain('skipped');
  });

  it('retries stalled agents up to the production retry cap', async () => {
    let calls = 0;
    const progress: string[] = [];
    const result = await runWorkflowScript({
      config,
      scriptBody: `
return await agent({
  name: 'slow-worker',
  prompt: 'slow',
  stallMs: 5,
  retries: 1,
});
`,
      invokeAgent: async ({ signal }) => {
        calls++;
        await new Promise<never>((_, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(new Error('agent aborted')),
            { once: true },
          );
        });
        return {
          content: 'late',
          state: 'done' as const,
        };
      },
      onProgress: (item) => {
        if (item.type === 'workflow_agent') progress.push(item.state);
      },
    });

    expect(result.error).toContain('workflow agent stalled after 5ms');
    expect(result.failures[0]).toContain('agent[1] slow-worker failed');
    expect(calls).toBe(6);
    expect(progress).toContain('retry');
    expect(progress).toContain('error');
  });

  it('retries stalled agents by default', async () => {
    let calls = 0;
    const result = await runWorkflowScript({
      config,
      scriptBody: `
return await agent({
  name: 'single-stall-worker',
  prompt: 'slow',
  stallMs: 1,
});
`,
      invokeAgent: async ({ signal }) => {
        calls++;
        await new Promise<never>((_, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(new Error('agent aborted')),
            { once: true },
          );
        });
        return {
          content: 'late',
          state: 'done' as const,
        };
      },
    });

    expect(result.error).toContain('workflow agent stalled after 1ms');
    expect(calls).toBe(6);
  });

  it('allows the default stall timeout to be disabled explicitly', async () => {
    let calls = 0;
    const attempts: Array<{ attempt?: number; maxAttempts?: number }> = [];
    const result = await runWorkflowScript({
      config,
      scriptBody: `
return await agent({
  name: 'permission-wait-worker',
  prompt: 'slow without progress',
  stallMs: 0,
});
`,
      invokeAgent: async () => {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          content: 'completed after waiting',
          state: 'done' as const,
        };
      },
      onProgress: (item) => {
        if (item.type === 'workflow_agent') {
          attempts.push({
            attempt: item.attempt,
            maxAttempts: item.maxAttempts,
          });
        }
      },
    });

    expect(result.error).toBeUndefined();
    expect(calls).toBe(1);
    expect(result.result).toBe('completed after waiting');
    expect(attempts).toContainEqual({ attempt: 1, maxAttempts: undefined });
  });

  it('applies the 180 second default stall timeout', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const run = runWorkflowScript({
        config,
        scriptBody: `
return await agent({
  name: 'default-stall-worker',
  prompt: 'never completes',
});
`,
        invokeAgent: async ({ signal }) => {
          calls++;
          await new Promise<never>((_, reject) => {
            signal?.addEventListener(
              'abort',
              () => reject(new Error('agent aborted')),
              { once: true },
            );
          });
          return {
            content: 'late',
            state: 'done' as const,
          };
        },
      });

      for (let attempt = 0; attempt < 6; attempt++) {
        await vi.advanceTimersByTimeAsync(180_000);
      }
      const result = await run;

      expect(result.error).toContain(
        'workflow agent stalled after 180000ms',
      );
      expect(calls).toBe(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not stall agents that keep producing query events', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const run = runWorkflowScript({
        config,
        scriptBody: `
return await agent({
  name: 'progress-worker',
  prompt: 'slow but active',
  stallMs: 20,
});
`,
        invokeAgent: async ({ onQueryEvent }) => {
          calls++;
          for (let index = 0; index < 3; index++) {
            await new Promise((resolve) => setTimeout(resolve, 15));
            onQueryEvent?.({
              type: 'stream_event',
              event: {
                type: 'content_block_delta',
                index,
                delta: { type: 'text_delta', text: 'active' },
              },
            });
          }
          return {
            content: 'active',
            state: 'done' as const,
          };
        },
      });

      await vi.advanceTimersByTimeAsync(45);
      const result = await run;

      expect(result.error).toBeUndefined();
      expect(calls).toBe(1);
      expect(result.result).toBe('active');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not treat UI progress as a stall heartbeat', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const run = runWorkflowScript({
        config,
        scriptBody: `
return await agent({
  name: 'ui-only-worker',
  prompt: 'reports UI progress without query events',
  stallMs: 20,
});
`,
        invokeAgent: async ({ signal, onProgress }) => {
          calls++;
          if (calls > 1) {
            return {
              content: 'recovered',
              state: 'done' as const,
            };
          }

          const interval = setInterval(() => onProgress?.(), 5);
          try {
            return await new Promise<never>((_, reject) => {
              const rejectForAbort = () => reject(new Error('agent aborted'));
              if (signal?.aborted) {
                rejectForAbort();
                return;
              }
              signal?.addEventListener('abort', rejectForAbort, { once: true });
            });
          } finally {
            clearInterval(interval);
          }
        },
      });

      await vi.advanceTimersByTimeAsync(25);
      const result = await run;

      expect(result.error).toBeUndefined();
      expect(calls).toBe(2);
      expect(result.result).toBe('recovered');
    } finally {
      vi.useRealTimers();
    }
  });

  it('pauses the stall timer for streaming tools and ignores nested tool IDs', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const run = runWorkflowScript({
        config,
        scriptBody: `
return await agent({
  name: 'streaming-tool-worker',
  prompt: 'run a long tool',
  stallMs: 20,
});
`,
        invokeAgent: async ({
          signal,
          onProgress,
          onQueryEvent,
        }) => {
          calls++;
          if (calls > 1) {
            return {
              content: 'recovered after tool became idle',
              state: 'done' as const,
            };
          }

          await new Promise((resolve) => setTimeout(resolve, 1));
          onQueryEvent?.({
            type: 'assistant_block',
            index: 0,
            message: {
              messageId: 'streaming-message',
              model: 'test-model',
              blocks: [
                {
                  type: 'tool_use',
                  id: 'outer-tool',
                  name: 'LongTool',
                  input: {},
                },
              ],
            },
          });
          onQueryEvent?.({
            type: 'assistant',
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: 'nested-tool',
                  name: 'NestedTool',
                  input: {},
                },
              ],
            },
          } as never);
          onQueryEvent?.({
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'active' },
            },
          });
          onProgress?.({ lastToolName: 'LongTool' });

          await new Promise((resolve) => setTimeout(resolve, 100));
          onQueryEvent?.({
            type: 'user',
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'outer-tool',
                  content: 'done',
                },
              ],
            },
          } as never);

          return new Promise<never>((_, reject) => {
            const rejectForAbort = () => reject(new Error('agent aborted'));
            if (signal?.aborted) {
              rejectForAbort();
              return;
            }
            signal?.addEventListener('abort', rejectForAbort, { once: true });
          });
        },
      });

      await vi.advanceTimersByTimeAsync(100);
      expect(calls).toBe(1);

      await vi.advanceTimersByTimeAsync(25);
      const result = await run;

      expect(result.error).toBeUndefined();
      expect(calls).toBe(2);
      expect(result.result).toBe('recovered after tool became idle');
    } finally {
      vi.useRealTimers();
    }
  });

  it('resumes the stall timer only after all parallel tools finish', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const run = runWorkflowScript({
        config,
        scriptBody: `
return await agent({
  name: 'parallel-tool-worker',
  prompt: 'run parallel tools',
  stallMs: 20,
});
`,
        invokeAgent: async ({ signal, onQueryEvent }) => {
          calls++;
          if (calls > 1) {
            return {
              content: 'recovered after parallel tools',
              state: 'done' as const,
            };
          }

          await new Promise((resolve) => setTimeout(resolve, 1));
          for (const id of ['tool-a', 'tool-b']) {
            onQueryEvent?.({
              type: 'assistant_block',
              index: 0,
              message: {
                messageId: `parallel-message-${id}`,
                model: 'test-model',
                blocks: [
                  {
                    type: 'tool_use',
                    id,
                    name: 'ParallelTool',
                    input: {},
                  },
                ],
              },
            });
          }

          await new Promise((resolve) => setTimeout(resolve, 30));
          onQueryEvent?.({
            type: 'user',
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'tool-a',
                  content: 'done',
                },
              ],
            },
          } as never);

          await new Promise((resolve) => setTimeout(resolve, 30));
          onQueryEvent?.({
            type: 'user',
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'tool-b',
                  content: 'done',
                },
              ],
            },
          } as never);

          return new Promise<never>((_, reject) => {
            const rejectForAbort = () => reject(new Error('agent aborted'));
            if (signal?.aborted) {
              rejectForAbort();
              return;
            }
            signal?.addEventListener('abort', rejectForAbort, { once: true });
          });
        },
      });

      await vi.advanceTimersByTimeAsync(50);
      expect(calls).toBe(1);

      await vi.advanceTimersByTimeAsync(35);
      const result = await run;

      expect(result.error).toBeUndefined();
      expect(calls).toBe(2);
      expect(result.result).toBe('recovered after parallel tools');
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries agents when user control requests retry', async () => {
    let calls = 0;
    const progress: string[] = [];
    const attempts: Array<{ attempt?: number; maxAttempts?: number }> = [];
    const result = await runWorkflowScript({
      config,
      scriptBody: `
return await agent({ name: 'user-retry-worker', prompt: 'retry me' });
`,
      invokeAgent: async () => {
        calls++;
        if (calls === 1) throw new WorkflowAgentUserRetryError();
        return {
          content: 'retried',
          state: 'done' as const,
        };
      },
      onProgress: (item) => {
        if (item.type === 'workflow_agent') {
          progress.push(item.state);
          attempts.push({
            attempt: item.attempt,
            maxAttempts: item.maxAttempts,
          });
        }
      },
    });

    expect(result.error).toBeUndefined();
    expect(calls).toBe(2);
    expect(result.result).toBe('retried');
    expect(progress).toContain('retry');
    expect(attempts).toContainEqual({ attempt: 1, maxAttempts: undefined });
    expect(attempts).toContainEqual({ attempt: 1, maxAttempts: 6 });
    expect(attempts).toContainEqual({ attempt: 2, maxAttempts: 6 });
  });

  it('returns null and records agent API failures without aborting the script', async () => {
    const progress: string[] = [];
    const result = await runWorkflowScript({
      config,
      scriptBody: `
const value = await agent({ name: 'api-worker', prompt: 'call provider' });
return { value, fallback: value === null };
`,
      invokeAgent: async () => ({
        content: 'provider unavailable',
        state: 'error' as const,
        apiError: 'provider unavailable',
      }),
      onProgress: (item) => {
        if (item.type === 'workflow_agent') progress.push(item.state);
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ value: null, fallback: true });
    expect(result.failures).toEqual([
      expect.stringContaining('agent[1] api-worker failed: provider unavailable'),
    ]);
    expect(progress).toContain('error');
    expect(progress).not.toContain('skipped');
  });

  it('honors explicit retries before degrading an API failure to null', async () => {
    let calls = 0;
    const result = await runWorkflowScript({
      config,
      scriptBody: `
return await agent({ name: 'api-worker', prompt: 'call provider', retries: 1 });
`,
      invokeAgent: async () => {
        calls++;
        return calls === 1
          ? {
              content: 'provider unavailable',
              state: 'error' as const,
              apiError: 'provider unavailable',
            }
          : { content: 'recovered', state: 'done' as const };
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.result).toBe('recovered');
    expect(result.failures).toEqual([]);
    expect(calls).toBe(2);
  });

  it('keeps parallel agent failures non-fatal when the script handles null results', async () => {
    const result = await runWorkflowScript({
      config,
      scriptBody: `
return await parallel([
  () => agent({ name: 'bad-worker', prompt: 'fail' }),
  () => 'still-runs',
]);
`,
      invokeAgent: async () => ({
        content: 'agent failed',
        state: 'error' as const,
      }),
    });

    expect(result.result).toEqual([null, 'still-runs']);
    expect(result.error).toBeUndefined();
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining('agent[1] bad-worker failed'),
        expect.stringContaining('parallel[0] failed'),
      ]),
    );
  });

  it('preserves multiple non-fatal agent failures from parallel workers', async () => {
    const result = await runWorkflowScript({
      config,
      scriptBody: `
return await parallel([
  () => agent({ name: 'first-bad-worker', prompt: 'fail 1' }),
  () => agent({ name: 'second-bad-worker', prompt: 'fail 2' }),
  () => 'still-runs',
]);
`,
      invokeAgent: async ({ invocation }) => ({
        content: `${invocation.name} failed`,
        state: 'error' as const,
      }),
    });

    expect(result.result).toEqual([null, null, 'still-runs']);
    expect(result.error).toBeUndefined();
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining('agent[1] first-bad-worker failed'),
        expect.stringContaining('agent[2] second-bad-worker failed'),
        expect.stringContaining('parallel[0] failed'),
        expect.stringContaining('parallel[1] failed'),
      ]),
    );
  });

  it('keeps pipeline agent failures non-fatal when the script handles null results', async () => {
    const result = await runWorkflowScript({
      config,
      scriptBody: `
return await pipeline(
  ['a', 'b'],
  (item) => agent({ name: 'pipeline-worker-' + item, prompt: 'fail ' + item })
);
`,
      invokeAgent: async ({ invocation }) => ({
        content: `${invocation.name} failed`,
        state: 'error' as const,
      }),
    });

    expect(result.result).toEqual([null, null]);
    expect(result.error).toBeUndefined();
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining('agent[1] pipeline-worker-a failed'),
        expect.stringContaining('agent[2] pipeline-worker-b failed'),
        expect.stringContaining('pipeline[0] failed'),
        expect.stringContaining('pipeline[1] failed'),
      ]),
    );
  });

  it('enforces the total agent cap', async () => {
    const result = await runWorkflowScript({
      config,
      maxAgents: 1,
      scriptBody: `
await agent({ prompt: 'first' });
return await agent({ prompt: 'second' });
`,
      invokeAgent: async ({ invocation }) => ({
        content: invocation.prompt,
        state: 'done' as const,
      }),
    });

    expect(result.error).toContain('Workflow agent limit exceeded (1)');
    expect(result.agentCount).toBe(1);
  });

  it('does not start new agents after budget is exhausted', async () => {
    const invokeAgent = vi.fn();
    const result = await runWorkflowScript({
      config,
      budget: { total: 10, spent: () => 10 },
      scriptBody: `
return await agent({ prompt: 'over budget' });
`,
      invokeAgent,
    });

    expect(result.error).toContain('Workflow budget exceeded');
    expect(result.agentCount).toBe(0);
    expect(invokeAgent).not.toHaveBeenCalled();
  });

  it('returns journal cached agent results without invoking live agents', async () => {
    const invokeAgent = vi.fn();
    const journal = {
      nextCachedResult: vi.fn(async () => ({
        key: 'cache-key',
        result: {
          content: 'cached result',
          state: 'done' as const,
          cached: true,
        },
      })),
      appendStarted: vi.fn(async () => {}),
      appendResult: vi.fn(async () => {}),
      appendEvent: vi.fn(async () => {}),
    };

    const result = await runWorkflowScript({
      config,
      journal,
      scriptBody: `return await agent({ prompt: 'cached' });`,
      invokeAgent,
    });

    expect(result.error).toBeUndefined();
    expect(result.result).toBe('cached result');
    expect(invokeAgent).not.toHaveBeenCalled();
    expect(journal.appendStarted).not.toHaveBeenCalled();
    expect(journal.appendResult).not.toHaveBeenCalled();
    expect(journal.appendEvent).not.toHaveBeenCalled();
  });

  it('does not reuse a cached structured result when the resume schema changes', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-runtime-'));
    const journalPath = path.join(tmpDir, 'journal.jsonl');
    try {
      const firstJournal = await WorkflowJournal.load(journalPath);
      const first = await runWorkflowScript({
        config,
        journal: firstJournal,
        scriptBody: `
const worker = await agent({
  prompt: 'same prompt',
  schema: {
    type: 'object',
    properties: { value: { type: 'number' } },
    required: ['value'],
    additionalProperties: false,
  },
});
return worker.value;
`,
        invokeAgent: async () => ({
          content: '{"value":42}',
          state: 'done' as const,
          structured: { value: 42 },
        }),
      });
      expect(first.error).toBeUndefined();
      expect(first.result).toBe(42);

      const invokeAgent = vi.fn(async () => ({
        content: '{"label":"fresh"}',
        state: 'done' as const,
        structured: { label: 'fresh' },
      }));
      const resumedJournal = await WorkflowJournal.load(journalPath);
      const resumed = await runWorkflowScript({
        config,
        journal: resumedJournal,
        scriptBody: `
const worker = await agent({
  prompt: 'same prompt',
  schema: {
    type: 'object',
    properties: { label: { type: 'string' } },
    required: ['label'],
    additionalProperties: false,
  },
});
return worker.label;
`,
        invokeAgent,
      });

      expect(resumed.error).toBeUndefined();
      expect(resumed.result).toBe('fresh');
      expect(invokeAgent).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not replay a skipped worker as a cached result when resuming', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-runtime-'));
    const journalPath = path.join(tmpDir, 'journal.jsonl');
    try {
      const firstJournal = await WorkflowJournal.load(journalPath);
      const skipped = await runWorkflowScript({
        config,
        journal: firstJournal,
        scriptBody: `
return await agent({
  name: 'maybe-worker',
  prompt: 'same prompt',
  skip: true,
  skipReason: 'not needed yet',
});
`,
        invokeAgent: vi.fn(),
      });
      expect(skipped.error).toBeUndefined();
      expect(skipped.result).toBeNull();

      const invokeAgent = vi.fn(async () => ({
        content: 'fresh result',
        state: 'done' as const,
      }));
      const resumedJournal = await WorkflowJournal.load(journalPath);
      const resumed = await runWorkflowScript({
        config,
        journal: resumedJournal,
        scriptBody: `
return await agent({ name: 'maybe-worker', prompt: 'same prompt' });
`,
        invokeAgent,
      });

      expect(resumed.error).toBeUndefined();
      expect(resumed.result).toBe('fresh result');
      expect(invokeAgent).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('records journal attempt, retry, skipped, and error audit events without caching skips', async () => {
    const events: unknown[] = [];
    const journal = {
      nextCachedResult: vi.fn(async () => ({ key: 'audit-key' })),
      appendStarted: vi.fn(async () => {}),
      appendResult: vi.fn(async () => {}),
      appendEvent: vi.fn(async (_key: string, event: unknown) => {
        events.push(event);
      }),
    };

    const retryResult = await runWorkflowScript({
      config,
      journal,
      scriptBody: `
await agent({ name: 'retry-worker', prompt: 'retry', retries: 1 });
return await agent({ name: 'skip-worker', prompt: 'skip', skip: true });
`,
      invokeAgent: async ({ invocation }) => {
        if (invocation.name === 'retry-worker' && events.length === 1) {
          throw new Error('temporary');
        }
        return { content: 'ok', state: 'done' as const };
      },
    });

    expect(retryResult.error).toBeUndefined();
    expect(retryResult.result).toBeNull();
    expect(journal.appendStarted).toHaveBeenCalledTimes(2);
    expect(journal.appendResult).toHaveBeenCalledTimes(1);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'attempt_started', attempt: 1 }),
        expect.objectContaining({
          kind: 'retry',
          attempt: 1,
          reason: 'error',
          error: 'temporary',
        }),
        expect.objectContaining({ kind: 'attempt_started', attempt: 2 }),
        expect.objectContaining({
          kind: 'skipped',
          attempt: 0,
          reason: 'user-skip',
        }),
      ]),
    );
  });

  it('returns aggregate workflow usage from latest agent progress stats', async () => {
    const result = await runWorkflowScript({
      config,
      scriptBody: `
await agent({ prompt: 'a' });
return await agent({ prompt: 'b' });
`,
      invokeAgent: async ({ invocation }) => ({
        content: invocation.prompt,
        state: 'done' as const,
        tokens: invocation.prompt === 'a' ? 10 : 20,
        toolCalls: invocation.prompt === 'a' ? 1 : 2,
      }),
    });

    expect(result.error).toBeUndefined();
    expect(result.totalTokens).toBe(30);
    expect(result.totalToolCalls).toBe(3);
  });

  it('limits concurrent live agent invocations', async () => {
    let active = 0;
    let maxActive = 0;
    const result = await runWorkflowScript({
      config,
      maxConcurrency: 2,
      scriptBody: `
return await parallel([
  () => agent({ prompt: 'a' }),
  () => agent({ prompt: 'b' }),
  () => agent({ prompt: 'c' }),
  () => agent({ prompt: 'd' }),
]);
`,
      invokeAgent: async ({ invocation }) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active--;
        return { content: invocation.prompt, state: 'done' as const };
      },
    });

    expect(result.error).toBeUndefined();
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it('runs one child workflow with inherited runtime APIs', async () => {
    const invokeAgent = vi.fn(async ({ invocation }) => ({
      content: `done:${invocation.prompt}`,
      state: 'done' as const,
      agentId: 'agent-1',
      agentType: invocation.type,
    }));
    const resolveWorkflow = vi.fn(async () => ({
      meta: {
        name: 'child-review',
        description: 'Review child workflow',
        phases: [{ title: 'Child phase' }],
      },
      scriptBody: `
log('child started');
return await agent({ prompt: args.prompt, type: 'general-purpose' });
`,
    }));
    const progress: Array<{ type: string; title?: string; phaseTitle?: string }> =
      [];

    const result = await runWorkflowScript({
      config,
      args: { prompt: 'inspect child' },
      scriptBody: `
phase('Parent');
return await workflow('child-review', args);
`,
      invokeAgent,
      resolveWorkflow,
      onProgress: (item) => progress.push(item),
    });

    expect(result.error).toBeUndefined();
    expect(result.agentCount).toBe(1);
    expect(result.result).toBe('done:inspect child');
    expect(resolveWorkflow).toHaveBeenCalledWith({
      name: 'child-review',
      args: { prompt: 'inspect child' },
    });
    expect(invokeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        invocation: expect.objectContaining({
          prompt: 'inspect child',
          phaseTitle: 'child-review',
        }),
      }),
    );
    expect(progress).toContainEqual(
      expect.objectContaining({
        type: 'workflow_phase',
        title: 'child-review',
      }),
    );
    expect(result.logs).toContain('child started');
  });

  it('propagates uncaught child workflow failures to the parent workflow', async () => {
    const result = await runWorkflowScript({
      config,
      scriptBody: `return await workflow('child-failure');`,
      resolveWorkflow: async () => ({
        meta: {
          name: 'child-failure',
          description: 'Failing child workflow',
        },
        scriptBody: `
return await agent({ name: 'child-worker', prompt: 'fail in child' });
`,
      }),
      invokeAgent: async () => ({
        content: 'child failed',
        state: 'error' as const,
      }),
    });

    expect(result.result).toBeNull();
    expect(result.error).toContain('child failed');
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining('agent[1] child-worker failed'),
      ]),
    );
  });

  it('rejects workflow nesting beyond one child level', async () => {
    const result = await runWorkflowScript({
      config,
      scriptBody: `return await workflow('child');`,
      resolveWorkflow: async ({ name }) => ({
        meta: {
          name: name ?? 'child',
          description: 'Child workflow',
        },
        scriptBody: `return await workflow('grandchild');`,
      }),
    });

    expect(result.error).toContain(
      'workflow() nesting is limited to one child level',
    );
  });
});
