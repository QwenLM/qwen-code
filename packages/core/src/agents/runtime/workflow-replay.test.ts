/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deriveAgentKey,
  deriveArgsSeed,
  WorkflowJournal,
} from './workflow-journal.js';
import { WorkflowOrchestrator } from './workflow-orchestrator.js';
import { WorkflowBudgetImpl } from './workflow-budget.js';
import { WorkflowDispatchScheduler } from './workflow-dispatch-scheduler.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

describe('workflow replay across executions', () => {
  let directory: string;
  let journalPath: string;
  const script = `return await parallel([() => agent('a'), () => agent('b')]);`;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-replay-'));
    journalPath = path.join(directory, 'journal.jsonl');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(directory, { recursive: true, force: true });
  });

  async function firstAttempt() {
    const journal = new WorkflowJournal(journalPath);
    await journal.ensureExists();
    const outcome = await new WorkflowOrchestrator(async (prompt) => {
      if (prompt === 'a') throw new Error('a failed');
      return 'b@1';
    }).run({ script, args: undefined, journal });
    await journal.drain();
    expect(outcome.result).toEqual([null, 'b@1']);
  }

  async function resumeJournal() {
    const journal = new WorkflowJournal(journalPath);
    const loaded = await journal.load();
    if (loaded.kind !== 'loaded') throw new Error(loaded.kind);
    return { journal, resumeReplay: loaded.replay };
  }

  it.each(['failed', 'budget', 'cap'] as const)(
    'does not revive a suffix after its next execution was %s',
    async (reason) => {
      await firstAttempt();
      if (reason === 'cap') vi.stubEnv('QWEN_CODE_MAX_WORKFLOW_AGENTS', '1');
      const second = await resumeJournal();
      const budget = new WorkflowBudgetImpl(1);
      const secondCalls: string[] = [];
      const run = new WorkflowOrchestrator(async (prompt) => {
        secondCalls.push(prompt);
        if (prompt === 'b') throw new Error('b failed');
        budget.recordSpent(1);
        return 'a@2';
      }).run({
        script,
        args: undefined,
        ...second,
        ...(reason === 'budget' ? { budget } : {}),
        scheduler: new WorkflowDispatchScheduler(1),
      });
      if (reason !== 'failed') {
        await expect(run).rejects.toThrow(
          reason === 'budget'
            ? 'token budget exceeded'
            : 'maximum of 1 agent() calls',
        );
        expect(secondCalls).toEqual(['a']);
      } else {
        await expect(run).resolves.toMatchObject({ result: ['a@2', null] });
        expect(secondCalls).toEqual(['a', 'b']);
      }
      await second.journal.drain();

      const third = await resumeJournal();
      const dispatch = vi.fn(async (prompt: string) => `${prompt}@3`);
      const outcome = await new WorkflowOrchestrator(dispatch).run({
        script,
        args: undefined,
        ...third,
      });
      await third.journal.drain();
      expect(dispatch.mock.calls.map((call) => call[0])).toEqual(['b']);
      expect(outcome.result).toEqual(['a@2', 'b@3']);
    },
  );

  it.each([script, `return await workflow('child');`])(
    'holds every parallel dispatch behind one persisted invalidation: %s',
    async (body) => {
      await firstAttempt();
      const resumed = await resumeJournal();
      const gate = deferred<void>();
      const retain = resumed.journal.retainReplayPrefix.bind(resumed.journal);
      const barrier = vi
        .spyOn(resumed.journal, 'retainReplayPrefix')
        .mockImplementation(async (keys) => {
          await gate.promise;
          await retain(keys);
        });
      const append = vi.spyOn(resumed.journal, 'append');
      const dispatch = vi.fn(async (prompt: string) => {
        const loaded = await new WorkflowJournal(journalPath).load();
        expect(loaded.kind).toBe('loaded');
        if (loaded.kind === 'loaded') {
          expect(
            [...loaded.replay.results.values()].map((e) => e.result),
          ).not.toContain('b@1');
        }
        return `${prompt}@2`;
      });
      const run = new WorkflowOrchestrator(dispatch).run({
        script: body,
        resolveSavedWorkflow: async () => ({ script }),
        args: undefined,
        ...resumed,
      });
      await vi.waitFor(() => expect(barrier).toHaveBeenCalledOnce());
      expect(dispatch).not.toHaveBeenCalled();
      expect(append).not.toHaveBeenCalled();
      gate.resolve();
      await expect(run).resolves.toMatchObject({ result: ['a@2', 'b@2'] });
      await resumed.journal.drain();
      expect(barrier).toHaveBeenCalledOnce();
    },
  );

  it('persists the miss even when the entry budget refuses all live calls', async () => {
    await firstAttempt();
    const resumed = await resumeJournal();
    const budget = new WorkflowBudgetImpl(1);
    budget.recordSpent(1);
    const dispatch = vi.fn(async () => 'unexpected');
    await expect(
      new WorkflowOrchestrator(dispatch).run({
        script,
        args: undefined,
        ...resumed,
        budget,
      }),
    ).rejects.toThrow('token budget exceeded');
    await resumed.journal.drain();
    expect(dispatch).not.toHaveBeenCalled();
    expect((await resumeJournal()).resumeReplay.results.size).toBe(0);
  });

  it('does not start calls cancelled while invalidation is pending', async () => {
    await firstAttempt();
    const resumed = await resumeJournal();
    const gate = deferred<void>();
    const retain = resumed.journal.retainReplayPrefix.bind(resumed.journal);
    const barrier = vi
      .spyOn(resumed.journal, 'retainReplayPrefix')
      .mockImplementation(async (keys) => {
        await gate.promise;
        await retain(keys);
      });
    const controller = new AbortController();
    const dispatch = vi.fn(async () => 'unexpected');
    const run = new WorkflowOrchestrator(dispatch).run({
      script,
      args: undefined,
      ...resumed,
      abortOnTimeout: controller,
    });
    const outcome = run.catch((error: unknown) => error);
    await vi.waitFor(() => expect(barrier).toHaveBeenCalledOnce());
    controller.abort();
    gate.resolve();
    expect(await outcome).toMatchObject({
      message: expect.stringMatching(/cancelled|ended/),
    });
    await resumed.journal.drain();
    expect(dispatch).not.toHaveBeenCalled();
    expect((await resumeJournal()).resumeReplay.results.size).toBe(0);
  });

  it.each([
    `return await agent('a');`,
    `try { await agent('a'); } catch {} return 'caught';`,
    `agent('a'); return 'unawaited';`,
    `return await parallel([() => agent('a'), () => agent('b')]);`,
    `return await pipeline(['a', 'b'], (_, p) => agent(p));`,
    `try { await agent('a'); } catch {} return await agent('b');`,
  ])(
    'fails the whole execution when its replay barrier fails: %s',
    async (body) => {
      await firstAttempt();
      const resumed = await resumeJournal();
      const original = await fs.readFile(journalPath, 'utf8');
      const failure = Object.assign(
        new Error('cannot persist replay boundary'),
        { __wfRunFailure: true },
      );
      vi.spyOn(resumed.journal, 'retainReplayPrefix').mockRejectedValue(
        failure,
      );
      const dispatch = vi.fn(async () => 'unexpected');
      await expect(
        new WorkflowOrchestrator(dispatch).run({
          script: body,
          args: undefined,
          ...resumed,
        }),
      ).rejects.toThrow('cannot persist replay boundary');
      await resumed.journal.drain();
      expect(dispatch).not.toHaveBeenCalled();
      expect(await fs.readFile(journalPath, 'utf8')).toBe(original);
    },
  );

  it('does not dispatch an already admitted call after its script ends', async () => {
    const journal = new WorkflowJournal(journalPath);
    await journal.ensureExists();
    const scheduler = new WorkflowDispatchScheduler(1);
    scheduler.pause();
    const dispatch = vi.fn(async () => 'unexpected');
    const complete = vi.fn();
    await new WorkflowOrchestrator(dispatch).run({
      script: `agent('a'); return 'done';`,
      args: undefined,
      journal,
      scheduler,
      emitter: { agentCompleted: complete },
    });
    scheduler.resume();
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
    await journal.drain();
    expect(dispatch).not.toHaveBeenCalled();
    expect(await fs.readFile(journalPath, 'utf8')).toBe('');
  });

  it('does not append an old execution result after a new resume', async () => {
    const journal = new WorkflowJournal(journalPath);
    await journal.ensureExists();
    const late = deferred<string>();
    const completed = vi.fn();
    await new WorkflowOrchestrator(async (prompt) =>
      prompt === 'a' ? late.promise : 'b@1',
    ).run({
      script: `agent('a'); return await agent('b');`,
      args: undefined,
      journal,
      scheduler: new WorkflowDispatchScheduler(2),
      emitter: { agentCompleted: completed },
    });
    await journal.drain();
    const resumed = await resumeJournal();
    await new WorkflowOrchestrator(async (prompt) => `${prompt}@2`).run({
      script,
      args: undefined,
      ...resumed,
    });
    await resumed.journal.drain();
    const expected = await fs.readFile(journalPath, 'utf8');
    late.resolve('a@1-late');
    await vi.waitFor(() => expect(completed).toHaveBeenCalledTimes(2));
    await journal.drain();
    expect(await fs.readFile(journalPath, 'utf8')).toBe(expected);
  });

  it('preserves cached prefix values while removing an abandoned old branch', async () => {
    const journal = new WorkflowJournal(journalPath);
    await journal.ensureExists();
    const originalScript = `return [await agent('p'), await agent('b')];`;
    await new WorkflowOrchestrator(async (prompt) => `${prompt}@1`).run({
      script: originalScript,
      args: undefined,
      journal,
    });
    await journal.drain();
    const changed = await resumeJournal();
    await new WorkflowOrchestrator(async () => {
      throw new Error('changed branch failed');
    }).run({
      script: `return [await agent('p'), await agent('changed')];`,
      args: undefined,
      ...changed,
    });
    await changed.journal.drain();
    const reverted = await resumeJournal();
    const dispatch = vi.fn(async (prompt: string) => `${prompt}@3`);
    await expect(
      new WorkflowOrchestrator(dispatch).run({
        script: originalScript,
        args: undefined,
        ...reverted,
      }),
    ).resolves.toMatchObject({ result: ['p@1', 'b@3'] });
    await reverted.journal.drain();
    expect(dispatch.mock.calls.map((call) => call[0])).toEqual(['b']);
  });
});

describe('workflow replay of structured results', () => {
  let directory: string;
  let journalPath: string;
  const good = { type: 'object', required: ['ok'] };
  const script = (schema: unknown) =>
    `return [await agent('a', { schema: ${JSON.stringify(schema)} }), await agent('b')];`;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-replay-'));
    journalPath = path.join(directory, 'journal.jsonl');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  /**
   * Writes the journal an older runtime could have left: `a` finished with
   * `aResult` under `schema`, then `b` finished with 'b@1'.
   */
  async function journalFromOlderRuntime(schema: unknown, aResult: unknown) {
    const journal = new WorkflowJournal(journalPath);
    await journal.ensureExists();
    const keyA = deriveAgentKey(deriveArgsSeed(undefined), 'a', {
      schema: schema as object,
    });
    const keyB = deriveAgentKey(keyA, 'b', {});
    await journal.append({ type: 'started', key: keyA, agentId: '1' });
    await journal.append({
      type: 'result',
      key: keyA,
      agentId: '1',
      result: aResult,
    });
    await journal.append({ type: 'started', key: keyB, agentId: '2' });
    await journal.append({
      type: 'result',
      key: keyB,
      agentId: '2',
      result: 'b@1',
    });
    await journal.drain();
    return { keyA, keyB };
  }

  async function resumeJournal() {
    const journal = new WorkflowJournal(journalPath);
    const loaded = await journal.load();
    if (loaded.kind !== 'loaded') throw new Error(loaded.kind);
    return { journal, resumeReplay: loaded.replay };
  }

  it('does not serve a success journaled under a schema that is now refused', async () => {
    const { keyA } = await journalFromOlderRuntime({ type: 42 }, { ok: 1 });
    const resumed = await resumeJournal();
    const dispatch = vi.fn(async (prompt: string) => `${prompt}@2`);
    const outcome = await new WorkflowOrchestrator(dispatch).run({
      script: script({ type: 42 }),
      args: undefined,
      ...resumed,
    });
    await resumed.journal.drain();
    expect(outcome.result).toEqual([null, 'b@2']);
    expect(dispatch.mock.calls.map((call) => call[0])).toEqual(['b']);
    const after = (await resumeJournal()).resumeReplay;
    expect(after.results.has(keyA)).toBe(false);
    expect(after.failed.has(keyA)).toBe(true);
  });

  it('re-runs a journaled result that fails its schema, and the old suffix stays gone', async () => {
    await journalFromOlderRuntime(good, {});
    const second = await resumeJournal();
    const secondCalls: string[] = [];
    const secondRun = await new WorkflowOrchestrator(async (prompt) => {
      secondCalls.push(prompt);
      if (prompt === 'a') {
        // The old suffix must already be gone when the live run starts.
        const loaded = await new WorkflowJournal(journalPath).load();
        if (loaded.kind !== 'loaded') throw new Error(loaded.kind);
        expect(
          [...loaded.replay.results.values()].map((entry) => entry.result),
        ).toEqual([]);
        return { ok: 'a@2' };
      }
      throw new Error('b failed');
    }).run({ script: script(good), args: undefined, ...second });
    await second.journal.drain();
    expect(secondRun.result).toEqual([{ ok: 'a@2' }, null]);
    expect(secondCalls).toEqual(['a', 'b']);

    const third = await resumeJournal();
    const dispatch = vi.fn(async (prompt: string) => `${prompt}@3`);
    const thirdRun = await new WorkflowOrchestrator(dispatch).run({
      script: script(good),
      args: undefined,
      ...third,
    });
    await third.journal.drain();
    expect(thirdRun.result).toEqual([{ ok: 'a@2' }, 'b@3']);
    expect(dispatch.mock.calls.map((call) => call[0])).toEqual(['b']);
  });

  it('serves a validated copy of a result that needs coercion, and a null without a schema', async () => {
    const coercible = {
      type: 'object',
      properties: { n: { type: 'number' } },
      required: ['n'],
    };
    const journal = new WorkflowJournal(journalPath);
    await journal.ensureExists();
    const keyA = deriveAgentKey(deriveArgsSeed(undefined), 'a', {
      schema: coercible,
    });
    const keyB = deriveAgentKey(keyA, 'b', {});
    await journal.append({
      type: 'result',
      key: keyA,
      agentId: '1',
      result: { n: '5' },
    });
    await journal.append({
      type: 'result',
      key: keyB,
      agentId: '2',
      result: null,
    });
    await journal.drain();
    const before = await fs.readFile(journalPath, 'utf8');

    const resumed = await resumeJournal();
    const dispatch = vi.fn(async () => 'unexpected');
    const outcome = await new WorkflowOrchestrator(dispatch).run({
      script: script(coercible),
      args: undefined,
      ...resumed,
    });
    await resumed.journal.drain();
    expect(outcome.result).toEqual([{ n: 5 }, null]);
    expect(dispatch).not.toHaveBeenCalled();
    expect(resumed.resumeReplay.results.get(keyA)?.result).toEqual({ n: '5' });
    expect(await fs.readFile(journalPath, 'utf8')).toBe(before);
  });

  it('serves a valid cached result for a schema whose properties also match patternProperties', async () => {
    const overlapping = {
      type: 'object',
      properties: { foo: { type: 'string' } },
      patternProperties: { '^f': { minLength: 1 } },
      required: ['foo'],
    };
    await journalFromOlderRuntime(overlapping, { foo: 'ok' });
    const before = await fs.readFile(journalPath, 'utf8');
    const resumed = await resumeJournal();
    const dispatch = vi.fn(async () => 'unexpected');
    const outcome = await new WorkflowOrchestrator(dispatch).run({
      script: script(overlapping),
      args: undefined,
      ...resumed,
    });
    await resumed.journal.drain();
    expect(outcome.result).toEqual([{ foo: 'ok' }, 'b@1']);
    expect(dispatch).not.toHaveBeenCalled();
    expect(await fs.readFile(journalPath, 'utf8')).toBe(before);
  });

  it('persists the miss of a refused schema even when the budget then refuses the call', async () => {
    await journalFromOlderRuntime({ type: 42 }, { ok: 1 });
    const resumed = await resumeJournal();
    const budget = new WorkflowBudgetImpl(1);
    budget.recordSpent(1);
    const dispatch = vi.fn(async () => 'unexpected');
    await expect(
      new WorkflowOrchestrator(dispatch).run({
        script: script({ type: 42 }),
        args: undefined,
        ...resumed,
        budget,
      }),
    ).rejects.toThrow('token budget exceeded');
    await resumed.journal.drain();
    expect(dispatch).not.toHaveBeenCalled();
    expect((await resumeJournal()).resumeReplay.results.size).toBe(0);
  });

  it('fails the execution when the barrier behind a refused schema fails', async () => {
    await journalFromOlderRuntime({ type: 42 }, { ok: 1 });
    const resumed = await resumeJournal();
    const original = await fs.readFile(journalPath, 'utf8');
    vi.spyOn(resumed.journal, 'retainReplayPrefix').mockRejectedValue(
      Object.assign(new Error('cannot persist replay boundary'), {
        __wfRunFailure: true,
      }),
    );
    const dispatch = vi.fn(async () => 'unexpected');
    await expect(
      new WorkflowOrchestrator(dispatch).run({
        script: script({ type: 42 }),
        args: undefined,
        ...resumed,
      }),
    ).rejects.toThrow('cannot persist replay boundary');
    await resumed.journal.drain();
    expect(dispatch).not.toHaveBeenCalled();
    expect(await fs.readFile(journalPath, 'utf8')).toBe(original);
  });
});
