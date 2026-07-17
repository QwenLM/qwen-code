/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWorkflowScript, WorkflowEngine } from './scriptRunner.js';
import { WorkflowScriptError } from './sandbox.js';
import type {
  AgentSpawner,
  AgentSpawnRequest,
  AgentSpawnResult,
} from './spawner.js';

class RecordingSpawner implements AgentSpawner {
  readonly prompts: string[] = [];
  constructor(private readonly reply: (p: string) => AgentSpawnResult) {}
  async spawn(req: AgentSpawnRequest): Promise<AgentSpawnResult> {
    this.prompts.push(req.prompt);
    return this.reply(req.prompt);
  }
}

async function runsDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'wf-runs-'));
}

const META_HEADER = `export const meta = { name: 'demo', description: 'd', phases: [{ title: 'A' }] };\n`;

describe('parseWorkflowScript', () => {
  it('accepts a pure-literal meta and strips the export', () => {
    const parsed = parseWorkflowScript(`${META_HEADER}return 1;`);
    expect(parsed.meta).toEqual({
      name: 'demo',
      description: 'd',
      phases: [{ title: 'A' }],
    });
    expect(parsed.body).not.toContain('export');
    expect(parsed.scriptHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a computed meta value with line info', () => {
    expect(() =>
      parseWorkflowScript(
        `export const meta = { name: 'x'.toUpperCase(), description: 'd' };\n`,
      ),
    ).toThrow(WorkflowScriptError);
  });

  it('rejects a source over the 512 KB cap', () => {
    const big =
      META_HEADER + `const s = '${'x'.repeat(520 * 1024)}';\nreturn 1;`;
    expect(() => parseWorkflowScript(big)).toThrow(/512 KB/);
  });
});

describe('WorkflowEngine.run', () => {
  it('runs a pipeline and returns the script value', async () => {
    const spawner = new RecordingSpawner((p) => ({
      text: `did:${p}`,
      tokens: 3,
    }));
    const engine = new WorkflowEngine(spawner, { runsDir: await runsDir() });
    const script = `${META_HEADER}
      phase('A');
      const out = await pipeline(['x', 'y'],
        (item) => agent('find ' + item),
        (prev) => agent('verify ' + prev),
      );
      return out;`;
    const res = await engine.run(script, {});
    expect(res.status).toBe('completed');
    expect(res.tokensSpent).toBe(12); // 2 items * 2 stages * 3 tokens
    expect(res.result).toEqual([
      'did:verify did:find x',
      'did:verify did:find y',
    ]);
  });

  it('resumes an unchanged script 100% from cache (no re-spawn)', async () => {
    const dir = await runsDir();
    const first = new RecordingSpawner((p) => ({ text: `r:${p}`, tokens: 1 }));
    const engine1 = new WorkflowEngine(first, { runsDir: dir });
    const script = `${META_HEADER}
      const a = await agent('one');
      const b = await agent('two');
      return [a, b];`;
    const r1 = await engine1.run(script, {});
    expect(first.prompts).toHaveLength(2);

    const second = new RecordingSpawner(() => ({
      text: 'SHOULD-NOT-RUN',
      tokens: 99,
    }));
    const engine2 = new WorkflowEngine(second, { runsDir: dir });
    const r2 = await engine2.run(script, { resumeFromRunId: r1.runId });
    expect(second.prompts).toHaveLength(0); // fully cached
    expect(r2.result).toEqual(r1.result);
    expect(r2.tokensSpent).toBe(0);
  });

  it('budget exhaustion throws into the script → run failed', async () => {
    const spawner = new RecordingSpawner((p) => ({ text: p, tokens: 100 }));
    const engine = new WorkflowEngine(spawner, { runsDir: await runsDir() });
    const script = `${META_HEADER}
      await agent('first');   // spends 100
      await agent('second');  // budget already exhausted → throws
      return 'unreached';`;
    await expect(
      engine.run(script, { budgetTotal: 100 }),
    ).rejects.toBeInstanceOf(WorkflowScriptError);
  });
});
