/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  describeWorkflowDeterminismViolations,
  scanWorkflowScriptShape,
} from './workflow-script-shape.js';

function script(...lines: string[]): string {
  return lines.join('\n');
}

describe('scanWorkflowScriptShape — rows', () => {
  it('merges consecutive top-level calls into one step row', () => {
    const shape = scanWorkflowScriptShape(
      script(
        "const a = await agent('scan package.json')",
        'const b = await agent("scan the lockfile")',
        'await agent(`report ${a} and ${b}`)',
        'return b',
      ),
    );
    expect(shape.agentCalls).toBe(3);
    expect(shape.rows).toEqual([
      {
        kind: 'step',
        count: 3,
        prompts: ['scan package.json', 'scan the lockfile'],
        line: 1,
      },
    ]);
  });

  it('classifies calls inside parallel() and pipeline() as fan-outs', () => {
    const shape = scanWorkflowScriptShape(
      script(
        "phase('Review')",
        'const found = await parallel([',
        "  () => agent('review src/core'),",
        "  () => agent('review src/cli'),",
        '])',
        'const checked = await pipeline(found, (f) => agent(`verify ${f}`))',
      ),
    );
    expect(shape.rows.map((r) => [r.kind, r.count, r.prompts, r.line])).toEqual(
      [
        ['parallel', 2, ['review src/core', 'review src/cli'], 3],
        ['parallel', 1, ['verify …'], 6],
      ],
    );
  });

  it('keeps the loop head on a loop row', () => {
    const shape = scanWorkflowScriptShape(
      script(
        "await agent('plan')",
        'while (budget.remaining() > 50_000) {',
        "  await agent('find more')",
        '}',
        "await agent('summarize')",
      ),
    );
    expect(shape.rows.map((r) => [r.kind, r.condition])).toEqual([
      ['step', undefined],
      ['loop', 'while (budget.remaining() > 50_000)'],
      ['step', undefined],
    ]);
  });

  it('shortens a long loop head', () => {
    const shape = scanWorkflowScriptShape(
      script(
        'for (let round = 0; round < args.maxRounds && budget.remaining() > 100_000; round++) {',
        "  await agent('find')",
        '}',
      ),
    );
    expect(shape.rows[0].condition).toMatch(/^for \(.{39}…\)$/);
  });

  it('ends a braceless loop body with its statement, semicolon or not', () => {
    const shape = scanWorkflowScriptShape(
      script(
        'for (const file of args.files) await agent(`read ${file}`)',
        "await agent('merge')",
        'for (const f of args.files) await agent(f);',
        "await agent('again')",
      ),
    );
    expect(shape.rows.map((r) => [r.kind, r.condition])).toEqual([
      ['loop', 'for (const file of args.files)'],
      ['step', undefined],
      ['loop', 'for (const f of args.files)'],
      ['step', undefined],
    ]);
  });

  it('reads a for-await head and a do…while without its tail becoming a loop', () => {
    const shape = scanWorkflowScriptShape(
      script(
        'for await (const x of args.stream) {',
        '  await agent(x)',
        '}',
        'do {',
        "  await agent('again')",
        '} while (budget.remaining() > 0)',
        "await agent('done')",
      ),
    );
    expect(shape.rows.map((r) => [r.kind, r.condition])).toEqual([
      ['loop', 'for (const x of args.stream)'],
      ['loop', 'do … while'],
      ['step', undefined],
    ]);
  });

  it('splits step rows around a fan-out', () => {
    const shape = scanWorkflowScriptShape(
      script(
        "await agent('a')",
        "await parallel([() => agent('b')])",
        "await agent('c')",
      ),
    );
    expect(shape.rows.map((r) => r.kind)).toEqual(['step', 'parallel', 'step']);
  });

  // No dataflow: the calls stay where they are written, but the fan-out that
  // runs them is still listed, so it is not presented as a sequential step.
  it('gives a fan-out over functions built elsewhere a row of its own', () => {
    const shape = scanWorkflowScriptShape(
      script(
        'const thunks = args.files.map((f) => () => agent(`read ${f}`))',
        'const read = await parallel(thunks)',
        'const tasks = []',
        'for (const r of read) tasks.push(() => agent(`check ${r}`))',
        'await pipeline(tasks)',
        "await agent('summarize')",
      ),
    );
    expect(shape.agentCalls).toBe(3);
    expect(shape.rows.map((r) => [r.kind, r.count, r.line])).toEqual([
      ['step', 1, 1],
      ['parallel', 0, 2],
      ['loop', 1, 4],
      ['parallel', 0, 5],
      ['step', 1, 6],
    ]);
  });

  it('lists nested fan-outs over functions built elsewhere once', () => {
    const shape = scanWorkflowScriptShape(
      script(
        'const stages = args.stages.map((s) => (x) => agent(`${s} ${x}`))',
        'await parallel(args.groups.map((g) => () => pipeline(g, stages)))',
        "await parallel([() => parallel([() => agent('inner')])])",
      ),
    );
    expect(shape.rows.map((r) => [r.kind, r.count, r.line])).toEqual([
      ['step', 1, 1],
      ['parallel', 0, 2],
      ['parallel', 1, 3],
    ]);
  });

  it('classifies a call by its innermost context', () => {
    const shape = scanWorkflowScriptShape(
      script(
        'for (const group of args.groups) {',
        '  await parallel(group.map((g) => () => agent(g)))',
        "  await agent('merge group')",
        '}',
      ),
    );
    expect(shape.rows.map((r) => [r.kind, r.count])).toEqual([
      ['parallel', 1],
      ['loop', 1],
    ]);
  });

  it('counts a call in a template expression but not one in template text', () => {
    const shape = scanWorkflowScriptShape(
      'const r = `agent(no) ${await agent("inner")}`\nreturn r',
    );
    expect(shape.agentCalls).toBe(1);
    expect(shape.rows[0].prompts).toEqual(['inner']);
  });

  it('leaves the prompt out when the argument is not a literal', () => {
    const shape = scanWorkflowScriptShape('await agent(args.prompt)');
    expect(shape.rows).toEqual([
      { kind: 'step', count: 1, prompts: [], line: 1 },
    ]);
  });
});

describe('scanWorkflowScriptShape — determinism', () => {
  it('reports each clock and random call with its line', () => {
    const shape = scanWorkflowScriptShape(
      script(
        "await agent('x')",
        'const id = Math.random()',
        'const at = Date.now()',
        'const d = new Date()',
        'const p = Date.parse("2026-01-01")',
        'const u = Date . UTC(2026, 0, 1)',
        'const s = Date().toString()',
        'const n = new  Date ()',
        'const b = Date ()',
      ),
    );
    expect(shape.determinismViolations).toEqual([
      { call: 'Math.random()', line: 2 },
      { call: 'Date.now()', line: 3 },
      { call: 'new Date()', line: 4 },
      { call: 'Date.parse()', line: 5 },
      { call: 'Date.UTC()', line: 6 },
      { call: 'Date()', line: 7 },
      { call: 'new Date()', line: 8 },
      { call: 'Date()', line: 9 },
    ]);
  });

  it('ignores calls inside strings, templates and comments', () => {
    const shape = scanWorkflowScriptShape(
      script(
        "// agent('not a call') and Date.now()",
        '/* Math.random() */',
        "const note = 'call agent(x) at Date.now()'",
        'const t = `template agent(y) Math.random()`',
        'return note + t',
      ),
    );
    expect(shape.agentCalls).toBe(0);
    expect(shape.determinismViolations).toEqual([]);
  });

  it('does not mistake members or longer names for the globals', () => {
    const shape = scanWorkflowScriptShape(
      script(
        'const myDate = { now: () => 1 }',
        'myDate.now()',
        'args.Date.now()',
        'const MathX = { random: () => 1 }',
        'MathX.random()',
        'const renew = () => 1',
        'myDate()',
        'args.Date()',
        'renew(Date)',
        "tools.agent('not the global')",
      ),
    );
    expect(shape.determinismViolations).toEqual([]);
    expect(shape.agentCalls).toBe(0);
  });
});

describe('describeWorkflowDeterminismViolations', () => {
  it('names the calls and says how to get the value in', () => {
    const message = describeWorkflowDeterminismViolations([
      { call: 'Date.now()', line: 3 },
      { call: 'Math.random()', line: 7 },
    ]);
    expect(message).toContain(
      'this script calls Date.now() on line 3, Math.random() on line 7.',
    );
    expect(message).toContain('through `args`');
  });

  it('lists five and counts the rest', () => {
    const message = describeWorkflowDeterminismViolations(
      Array.from({ length: 7 }, (_, i) => ({
        call: 'Date.now()' as const,
        line: i + 1,
      })),
    );
    expect(message).toContain('Date.now() on line 5 and 2 more.');
    expect(message).not.toContain('line 6');
  });
});

// #12651 R1-1: maskNonCode must end a `//` comment at any of the four
// ECMAScript LineTerminators. A CR-only script (no `\n` anywhere) used to
// be blanked end-to-end, silencing the pre-launch determinism gate (clock
// calls invisible → run starts and burns tokens before the sandbox guard
// rejects it) and emptying the agent-row inventory the approval dialog
// renders.
describe('scanWorkflowScriptShape — LineTerminator-terminated comments (#12651)', () => {
  it('still reports a clock call after a CR-only leading comment', () => {
    const shape = scanWorkflowScriptShape(
      "// header\rexport const meta = { name: 'x', description: 'd' }\rreturn Date.now();",
    );
    expect(shape.determinismViolations.map((v) => v.call)).toContain(
      'Date.now()',
    );
  });

  it('still produces a row for an agent() call after a CR-only leading comment', () => {
    const shape = scanWorkflowScriptShape(
      "// header\rexport const meta = { name: 'x', description: 'd' }\rawait agent('do the thing');\rreturn 1;",
    );
    expect(shape.agentCalls).toBe(1);
    expect(shape.rows.length).toBeGreaterThan(0);
  });

  it('is symmetric with LF on the same script', () => {
    const cr = scanWorkflowScriptShape(
      "// h\rexport const meta = { name: 'x', description: 'd' }\rawait agent('go');\rreturn 1;",
    );
    const lf = scanWorkflowScriptShape(
      "// h\nexport const meta = { name: 'x', description: 'd' }\nawait agent('go');\nreturn 1;",
    );
    expect(cr.agentCalls).toBe(lf.agentCalls);
    expect(cr.rows.length).toBe(lf.rows.length);
    expect(cr.determinismViolations.length).toBe(
      lf.determinismViolations.length,
    );
  });
});

// A nested workflow() resolves script bytes the parent's launch block
// never pinned (a saved workflow from any tier); the hosted profile
// refuses the script at admission on this signal (#13803 R1-1).
describe('scanWorkflowScriptShape — nested workflow calls', () => {
  it('reports each call on the injected global with its line', () => {
    const shape = scanWorkflowScriptShape(
      script(
        "await workflow('audit')",
        "await workflow({ scriptPath: '.qwen/workflows/x.js' })",
        'const noun = workflow',
      ),
    );
    expect(shape.nestedWorkflowCalls).toEqual([1, 2]);
  });

  it('ignores the name inside strings, templates and comments', () => {
    const shape = scanWorkflowScriptShape(
      script(
        "// workflow('not a call')",
        '/* workflow(x) */',
        "const note = 'workflow(x)'",
        'const t = `template workflow(y)`',
        'return note + t',
      ),
    );
    expect(shape.nestedWorkflowCalls).toEqual([]);
  });

  it('does not mistake members or longer names for the global', () => {
    const shape = scanWorkflowScriptShape(
      script(
        'host.workflow(x)',
        'const myworkflow = () => 1',
        'myworkflow(x)',
        'const workflows = () => 1',
        'workflows(x)',
      ),
    );
    expect(shape.nestedWorkflowCalls).toEqual([]);
  });
});

// The managed workflow child's agents carry no tools and use nothing on
// the Harness host; the hosted admission refuses a literal host-bound
// option early on this signal (#13858 R4-4), the runtime refuses the rest.
describe('scanWorkflowScriptShape — host-bound agent options', () => {
  it('reports each literal host-bound option key with its line', () => {
    const shape = scanWorkflowScriptShape(
      script(
        "await agent('a', { tools: ['read_file'] })",
        "await agent('b', {",
        "  model: 'm',",
        "  agentType: 'Explore',",
        '})',
        "await agent('c', { isolation: 'worktree', workingDir })",
      ),
    );
    expect(shape.hostBoundAgentOptions).toEqual([
      { option: 'tools', line: 1 },
      { option: 'agentType', line: 4 },
      { option: 'isolation', line: 6 },
      { option: 'workingDir', line: 6 },
    ]);
  });

  it('ignores nested keys, strings, comments and text-only options', () => {
    const shape = scanWorkflowScriptShape(
      script(
        "await agent('a', { schema: { properties: { tools: { type: 'string' } } } })",
        "await agent('b', { model: 'm', effort: 'high', label: 'tools' })",
        "// agent('c', { tools: [] })",
        "const note = \"agent('d', { agentType: 'x' })\"",
        "const tools = ['x']; return agent('e', { label: tools[0] })",
      ),
    );
    expect(shape.hostBoundAgentOptions).toEqual([]);
  });
});
