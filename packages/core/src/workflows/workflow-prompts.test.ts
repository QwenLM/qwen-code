/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import baseline from './__fixtures__/cc-2.1.260-prompts.json' with { type: 'json' };
import { ENV_SUBAGENT_MODEL } from '../config/brand.js';
import {
  getWorkflowAuthoringReference,
  getWorkflowBaseDescription,
  getWorkflowToolDescription,
  WORKFLOW_TOOL_DESCRIPTION,
} from './workflow-prompts.js';
import { parseWorkflowScript } from './workflow-parser.js';
import { runWorkflowScript } from './workflow-runtime.js';

// Only the missing schemas/helpers are supplied by the harness. The examples
// themselves are sliced from the shipping prompt, without rewriting their code.
function snippet(start: string, end: string): string {
  return getWorkflowAuthoringReference().split(start)[1].split(end)[0]
    .split('\n').map((line) => line.replace(/^ {2}/, '')).join('\n').trim();
}
const objectSchema = { type: 'object', properties: {} };
const fixtures = `
const FINDINGS_SCHEMA = ${JSON.stringify(objectSchema)};
const VERDICT_SCHEMA = ${JSON.stringify(objectSchema)};
const BUGS_SCHEMA = FINDINGS_SCHEMA, BUGS = FINDINGS_SCHEMA, VERDICT = VERDICT_SCHEMA;
const FINDERS = [{prompt: 'Find bugs'}];
const key = b => b.desc;
const verifyPrompt = f => 'Verify ' + f.title;
const dedupeByFileAndLine = findings => [...new Map(findings.map(f => [f.file + ':' + f.line, f])).values()];
`;

describe('Workflow authoring reference', () => {
  const config = {} as Parameters<typeof runWorkflowScript>[0]['config'];
  afterEach(() => vi.unstubAllEnvs());

  it.each([undefined, 'inherit', 'forced-model'])('matches the native baseline with only the MCP tool-name substitution (model=%s)', (model) => {
    vi.stubEnv(ENV_SUBAGENT_MODEL, model);
    expect(getWorkflowBaseDescription()).toBe(baseline.base);
    expect(getWorkflowAuthoringReference()).toBe((model && model !== 'inherit' ? baseline.forcedReference : baseline.reference).replace('via ToolSearch', 'via mcp_list/mcp_get/mcp_call in lazy mode (or directly when already exposed)'));
    expect(getWorkflowToolDescription({ authoringAvailable: true })).toBe(`${baseline.base}\n\n${baseline.hint}`);
    expect(getWorkflowToolDescription({ authoringAvailable: false })).toBe(`${baseline.base}\n\n${getWorkflowAuthoringReference()}`);
  });

  it('runs the original canonical per-finding pipeline without a cross-dimension barrier', async () => {
    const example = getWorkflowBaseDescription().slice(getWorkflowBaseDescription().indexOf('  export const meta'));
    const parsed = parseWorkflowScript(example);
    let releaseSlow!: () => void;
    let verifiedFast!: () => void;
    const slow = new Promise<void>(resolve => { releaseSlow = resolve; });
    const fast = new Promise<void>(resolve => { verifiedFast = resolve; });
    const completed: string[] = [];
    const run = runWorkflowScript({
      config, scriptBody: fixtures + parsed.scriptBody, maxConcurrency: 4,
      invokeAgent: async ({ invocation }) => {
        if (invocation.label === 'review:perf') await slow;
        completed.push(invocation.label);
        if (invocation.phaseTitle === 'Review') return {
          content: '', state: 'done', structured: { findings: [
            { title: invocation.label, file: invocation.label },
            { title: 'false positive', file: 'false.ts' },
          ] },
        };
        if (invocation.label === 'verify:review:bugs') verifiedFast();
        return { content: '', state: 'done', structured: { isReal: invocation.label !== 'verify:false.ts' } };
      },
    });
    await fast;
    expect(completed).not.toContain('review:perf');
    releaseSlow();
    const result = await run;
    expect(result.error).toBeUndefined();
    expect(result.agentCount).toBe(6);
    expect(result.result).toEqual({ confirmed: [
      { title: 'review:bugs', file: 'review:bugs', verdict: { isReal: true } },
      { title: 'review:perf', file: 'review:perf', verdict: { isReal: true } },
    ] });
  });

  it('runs the original barrier and deduplicates the complete finding set before verification', async () => {
    let reviews = 0;
    let verified = 0;
    const result = await runWorkflowScript({
      config,
      scriptBody: fixtures + `const DIMENSIONS = [{prompt:'one'}, {prompt:'two'}];\n` +
        snippet('When a barrier IS correct — dedup across all findings before expensive verification:\n', '\n\nLoop-until-count') + '\nreturn verified;',
      invokeAgent: async ({ invocation }) => {
        if (!invocation.prompt.startsWith('Verify')) {
          reviews++;
          return { content: '', state: 'done', structured: { findings: [{ title: 'same', file: 'a.ts', line: 1 }] } };
        }
        expect(reviews).toBe(2);
        verified++;
        return { content: '', state: 'done', structured: { isReal: true } };
      },
    });
    expect(result.error).toBeUndefined();
    expect(verified).toBe(1);
    expect(result.result).toEqual([{ isReal: true }]);
  });

  it('runs the original diverse-lens panel with a majority, all-seen deduplication and two consecutive dry rounds', async () => {
    const batches = [['real', 'rejected'], ['new'], ['rejected'], ['real']];
    const judgments: string[] = [];
    const result = await runWorkflowScript({
      config, maxConcurrency: 8,
      scriptBody: fixtures + snippet('Composing patterns — exhaustive review (find → dedup vs seen → diverse-lens panel → loop-until-dry):\n', '\n\nQuality patterns'),
      invokeAgent: async ({ invocation }) => {
        if (invocation.phaseTitle === 'Find') return {
          content: '', state: 'done', structured: { bugs: batches.shift()!.map(desc => ({ desc })) },
        };
        judgments.push(invocation.prompt);
        return { content: '', state: 'done', structured: {
          real: !invocation.prompt.includes('rejected') && !invocation.prompt.includes('repro lens'),
        } };
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.result).toEqual([{ desc: 'real' }, { desc: 'new' }]);
    expect(batches).toEqual([]);
    expect(judgments).toHaveLength(9);
    for (const lens of ['correctness', 'security', 'repro']) {
      expect(judgments.filter(prompt => prompt.includes(`${lens} lens`))).toHaveLength(3);
    }
  });

  it('runs the original refutation vote with a skipped voter', async () => {
    let vote = 0;
    const result = await runWorkflowScript({
      config,
      scriptBody: fixtures + `const claim = 'claim';\n` + snippet('    const votes =', '\n- Perspective-diverse').replace(/^/, 'const votes =') + '\nreturn survives;',
      invokeAgent: async () => ++vote === 3
        ? { content: '', state: 'done', skipped: true }
        : { content: '', state: 'done', structured: { refuted: false } },
    });
    expect(result.error).toBeUndefined();
    expect(result.result).toBe(true);
    expect(vote).toBe(3);
  });

  it.each([undefined, 250_000])('runs the original budget loop without inventing an implicit target (%s)', async (total) => {
    let spent = 0;
    const result = await runWorkflowScript({
      config, budget: total ? { total, spent: () => spent } : undefined,
      scriptBody: fixtures + snippet('  const bugs = []\n  while (budget.total', '\n\nComposing patterns').replace(/^/, 'const bugs = []\nwhile (budget.total') + '\nreturn bugs;',
      invokeAgent: async () => {
        spent += 100_000;
        return { content: '', state: 'done', structured: { bugs: [spent] } };
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.result).toEqual(total ? [100_000, 200_000] : []);
    expect(result.agentCount).toBe(total ? 2 : 0);
  });
});

describe('workflow prompts', () => {
  it('uses the native full reference as the no-Skill fallback', () => {
    expect(WORKFLOW_TOOL_DESCRIPTION).toBe(
      getWorkflowToolDescription({ authoringAvailable: false }),
    );
    expect(WORKFLOW_TOOL_DESCRIPTION).toContain('agent(prompt: string, opts?:');
    expect(WORKFLOW_TOOL_DESCRIPTION).toContain('**Ultracode.**');
    expect(WORKFLOW_TOOL_DESCRIPTION).toContain('DEFAULT TO pipeline()');
    expect(WORKFLOW_TOOL_DESCRIPTION).toContain(
      'To resume after a pause, kill, or script edit',
    );
  });

  it('does not expose agent retry or script-level skip knobs in the main prompt', () => {
    expect(WORKFLOW_TOOL_DESCRIPTION).not.toContain('agent({ retries');
    expect(WORKFLOW_TOOL_DESCRIPTION).not.toContain('agent({ stallMs');
    expect(WORKFLOW_TOOL_DESCRIPTION).not.toContain('agent({ skip: true');
  });
});
