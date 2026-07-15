/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The subject is 23 review agents launched with no way to read the diff.
//
// Every test that matters here asserts a property that was MISSING from all 23
// real launch prompts, measured off the harness's own transcripts: the diff path
// is in the prompt, the read call is in the prompt, and the agent is not handed a
// sentence to recite when it finds nothing.

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../utils/stdioHelpers.js', () => ({ writeStdoutLine: vi.fn() }));
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import {
  buildChunkAgentPrompt,
  buildChunkLaunchPrompt,
  buildWholeDiffBlock,
  buildRoleBrief,
  buildRoleLaunchPrompt,
  agentPromptCommand,
} from './agent-prompt.js';
import { readRecordedPrompts, briefPath } from './lib/prompt-record.js';

const PLAN = {
  diffPathAbsolute: '/abs/.qwen/tmp/qwen-review-pr-6771-diff.txt',
  chunks: [
    {
      id: 13,
      startLine: 3808,
      endLine: 4024,
      lines: 217,
      chars: 9000,
      maxLineChars: 120,
      oversized: false,
      files: [
        {
          path: 'packages/cli/src/commands/review/x.test.ts',
          newStart: 1,
          newEnd: 211,
        },
      ],
    },
    {
      id: 14,
      startLine: 4025,
      endLine: 4200,
      lines: 176,
      chars: 40_000,
      maxLineChars: 90,
      oversized: true,
      files: [{ path: 'a.ts', newStart: 1, newEnd: 20 }],
    },
    {
      id: 15,
      startLine: 4201,
      endLine: 4202,
      lines: 2,
      chars: 60_000,
      maxLineChars: 59_000, // a minified bundle: one line no paging can reach
      oversized: true,
      files: [{ path: 'bundle.min.js', newStart: 1, newEnd: 1 }],
    },
  ],
};

describe('buildChunkAgentPrompt — what the real launches left out', () => {
  it('scopes the agent to its own territory, by line', () => {
    // The diff path and the read moved to the launch prompt — a chunk agent's brief
    // runs to five kilobytes, and a Step 3B review of a real PR has seventeen of
    // them. Eighty-seven kilobytes is not something an orchestrator pastes. What is
    // asserted here is what the BRIEF must still carry; the read is asserted on
    // `buildChunkLaunchPrompt` below, where it now lives and where coverage reads it.
    const p = buildChunkAgentPrompt(PLAN, 13);
    expect(p).toContain('lines 3808-4024');
    expect(p).toContain('belong to other agents');
  });

  it('does NOT hand the agent a sentence to recite when it finds nothing', () => {
    // Every real prompt ended with: `If you find no issues, say "No issues found
    // — reviewed chunk 13 (x.test.ts)"`. An agent that cannot open the diff will
    // still say it — and did, 23 times. A receipt the prompt wrote is not
    // evidence of work.
    const p = buildChunkAgentPrompt(PLAN, 13);
    expect(p).not.toMatch(/say ["“]No issues found/i);
    expect(p).not.toMatch(/If you find no issues, say/i);
    // It asks for evidence instead.
    expect(p).toContain('say what you examined');
  });

  it('tells the agent to page a truncated read', () => {
    const p = buildChunkAgentPrompt(PLAN, 13);
    expect(p).toContain('isTruncated');
    expect(p).toMatch(/larger `?offset`?/);
  });

  it('flags an oversized chunk as one that will need paging', () => {
    expect(buildChunkAgentPrompt(PLAN, 14)).toContain('oversized');
  });

  it('asks a normal chunk for the receipt check-coverage parses', () => {
    // The structured line the downstream check reads. Nothing else asserted it,
    // so dropping it would have been a silent regression.
    const p = buildChunkAgentPrompt(PLAN, 13);
    expect(p).toContain('Covered: chunk 13 lines 3808-4024');
  });

  it('does not ask an unreachable chunk for BOTH Uncoverable and Covered', () => {
    // It was told to return `Uncoverable`, and then also told to end with
    // `Covered:` — two instructions that contradict each other. A chunk that
    // reports itself both uncoverable and covered is neither.
    const p = buildChunkAgentPrompt(PLAN, 15);
    expect(p).toContain('Uncoverable: chunk 15');
    expect(p).not.toContain('Covered: chunk 15');
  });

  it('drops a malformed files[] entry instead of rendering "undefined"', () => {
    // The plan is cast off disk unchecked. A bad entry would otherwise print
    // `- undefined (new-side lines undefined-undefined)` and send the agent
    // looking for a file that does not exist.
    const plan = {
      diffPathAbsolute: '/d.txt',
      chunks: [
        {
          id: 1,
          startLine: 1,
          endLine: 10,
          lines: 10,
          chars: 100,
          maxLineChars: 50,
          oversized: false,
          files: [
            null,
            { newStart: 1, newEnd: 2 },
            { path: 'real.ts', newStart: 1, newEnd: 9 },
          ],
        },
      ],
    } as never;
    const p = buildChunkAgentPrompt(plan, 1);
    expect(p).not.toContain('undefined');
    expect(p).toContain('real.ts');
  });

  it('handles a chunk with no recorded files', () => {
    const plan = {
      diffPathAbsolute: '/d.txt',
      chunks: [
        {
          id: 1,
          startLine: 1,
          endLine: 10,
          lines: 10,
          chars: 100,
          maxLineChars: 50,
          oversized: false,
          files: [],
        },
      ],
    };
    expect(buildChunkAgentPrompt(plan, 1)).toContain('(none recorded)');
  });

  it('tells an unreachable chunk to return Uncoverable, not a receipt', () => {
    // A single line longer than one read: every page starts at a line boundary,
    // so its tail is unreachable by any offset. It must not be receipted.
    const p = buildChunkAgentPrompt(PLAN, 15);
    expect(p).toContain('Uncoverable: chunk 15');
    expect(p).toContain('exceeds the read limit');
  });

  it('scopes the agent to its own territory', () => {
    const p = buildChunkAgentPrompt(PLAN, 13);
    expect(p).toContain('lines 3808-4024');
    expect(p).toContain('belong to other agents');
    // And names the source files it covers.
    expect(p).toContain('packages/cli/src/commands/review/x.test.ts');
  });

  it('carries the severity definitions, so test-coverage is not filed as Critical', () => {
    const p = buildChunkAgentPrompt(PLAN, 13);
    expect(p).toContain('**Critical**');
    expect(p).toContain('**Suggestion**');
  });

  it('appends project rules when there are any', () => {
    const p = buildChunkAgentPrompt(PLAN, 13, 'No `any` in new code.');
    expect(p).toContain('Project rules');
    expect(p).toContain('No `any` in new code.');
    expect(buildChunkAgentPrompt(PLAN, 13)).not.toContain('Project rules');
  });
});

describe('buildChunkAgentPrompt — refuses a plan it cannot build from', () => {
  it('refuses a plan with no diff path — that is the bug, not a default', () => {
    // A prompt built without the diff path is exactly what shipped 23 times. It
    // must be an error, never a prompt that merely describes the chunk.
    expect(() => buildChunkAgentPrompt({ chunks: PLAN.chunks }, 13)).toThrow(
      /diffPathAbsolute/,
    );
  });

  it('refuses a plan with no chunks', () => {
    expect(() =>
      buildChunkAgentPrompt({ diffPathAbsolute: '/x/diff.txt' }, 1),
    ).toThrow(/chunks/);
  });

  it('refuses a chunk id the plan does not have', () => {
    expect(() => buildChunkAgentPrompt(PLAN, 99)).toThrow(/no chunk 99/);
  });

  it('refuses a chunk whose line range is unusable', () => {
    const bad = {
      diffPathAbsolute: '/x/diff.txt',
      chunks: [{ id: 1, startLine: 0, endLine: -5, files: [] }],
    };
    expect(() => buildChunkAgentPrompt(bad, 1)).toThrow(/line range/);
  });
});

describe('agent-prompt (command boundary)', () => {
  // Without this, `calls[0]` is the first call *ever* made to the mock across the
  // file — correct today only because nothing earlier invokes the handler, and
  // silently wrong the moment something does.
  beforeEach(() => {
    (writeStdoutLine as unknown as Mock).mockClear();
  });

  it('prints the prompt for the chunk it was asked for', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ap-cmd-'));
    try {
      const plan = join(dir, 'plan.json');
      writeFileSync(plan, JSON.stringify(PLAN));
      (agentPromptCommand.handler as (a: unknown) => void)({
        plan,
        chunk: 13,
      });
      const calls = (writeStdoutLine as unknown as Mock).mock.calls;
      expect(calls).toHaveLength(1);
      const printed = calls[0][0];
      expect(printed).toContain('offset=3807');
      expect(printed).toContain(PLAN.diffPathAbsolute);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names the plan it could not read, instead of a raw stack', () => {
    expect(() =>
      (agentPromptCommand.handler as (a: unknown) => void)({
        plan: '/no/such/plan.json',
        chunk: 1,
      }),
    ).toThrow(/cannot read the plan/);
  });
  it('injects the project rules the review loaded', () => {
    // They were loaded, written to a file, and dropped: `buildChunkAgentPrompt`
    // took a `rules` argument that the CLI had no flag to supply. The review
    // enforced no project rule at all and said nothing about it.
    const dir = mkdtempSync(join(tmpdir(), 'ap-rules-'));
    try {
      const plan = join(dir, 'plan.json');
      writeFileSync(plan, JSON.stringify(PLAN));
      const rules = join(dir, 'rules.md');
      writeFileSync(rules, 'No `any` in new code.\n');

      (agentPromptCommand.handler as (a: unknown) => void)({
        plan,
        chunk: 13,
        rules,
      });

      // The rules are in the BRIEF, which the launch prompt points at — not in the
      // launch prompt itself, which is the thing the orchestrator has to carry.
      const printed = (writeStdoutLine as unknown as Mock).mock.calls[0][0];
      expect(printed).toContain('.brief.md');
      const brief = readRecordedPrompts(plan); // launch prompts, keyed
      expect(brief.get('chunk-13')).toBe(printed);
      const briefText = readFileSync(briefPath(plan, 'chunk-13'), 'utf8');
      expect(briefText).toContain('Project rules');
      expect(briefText).toContain('No `any` in new code.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a rules path that does not resolve, rather than reviewing without them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ap-rules2-'));
    try {
      const plan = join(dir, 'plan.json');
      writeFileSync(plan, JSON.stringify(PLAN));
      expect(() =>
        (agentPromptCommand.handler as (a: unknown) => void)({
          plan,
          chunk: 13,
          rules: join(dir, 'no-such-rules.md'),
        }),
      ).toThrow(/cannot read the rules/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records what it handed out, so a rewrite of it can be seen', () => {
    // The command was called correctly for all five chunks of a real review — and
    // the orchestrator then paraphrased what it printed on the way to the agent.
    // Nothing could see that, because a paraphrase keeps the diff path. So the
    // builder writes down what it emitted, at a path derived from the plan that
    // the caller is never given and never asked to write to.
    const dir = mkdtempSync(join(tmpdir(), 'ap-rec-'));
    try {
      const plan = join(dir, 'plan.json');
      writeFileSync(plan, JSON.stringify(PLAN));

      (agentPromptCommand.handler as (a: unknown) => void)({ plan, chunk: 13 });
      (agentPromptCommand.handler as (a: unknown) => void)({
        plan,
        'whole-diff': true,
      });

      const recorded = readRecordedPrompts(plan);
      expect([...recorded.keys()].sort()).toEqual(['chunk-13', 'whole-diff']);
      // What is recorded is the LAUNCH prompt — the thing the orchestrator must
      // deliver unedited. The brief it points at is recorded beside it.
      expect(recorded.get('chunk-13')).toBe(
        buildChunkLaunchPrompt(PLAN, 13, briefPath(plan, 'chunk-13')),
      );
      expect(readFileSync(briefPath(plan, 'chunk-13'), 'utf8')).toBe(
        buildChunkAgentPrompt(PLAN, 13),
      );
      expect(recorded.get('whole-diff')).toBe(buildWholeDiffBlock(PLAN));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The half of the fan-out this command did not cover. Measured against one real
// Step 3B run: all three whole-diff agents — cross-file tracer, test-coverage
// matrix, build & test — were launched with a prompt that named no diff file at
// all. The test-coverage matrix was told in prose to "Read the diff chunks", and
// given no path to read them from.
describe('buildWholeDiffBlock — the agents that walk the whole diff', () => {
  it("names the diff and every chunk's read", () => {
    const block = buildWholeDiffBlock(PLAN);
    expect(block).toContain(PLAN.diffPathAbsolute);
    for (const c of PLAN.chunks) {
      const offset = c.startLine - 1;
      const limit = c.endLine - c.startLine + 1;
      expect(block).toContain(
        `read_file(file_path="${PLAN.diffPathAbsolute}", offset=${offset}, limit=${limit})`,
      );
    }
  });

  it('says the source tree is not a substitute for the diff', () => {
    // The blind whole-diff agents did not sit idle: they went and read the
    // post-change source. On a deletion that shows them nothing — the line is
    // simply not there, and nothing marks where it was.
    expect(buildWholeDiffBlock(PLAN)).toContain(
      'deletion leaves no trace in the post-change file',
    );
  });

  it('hands the agent no sentence to recite when it finds nothing', () => {
    const block = buildWholeDiffBlock(PLAN);
    expect(block).toContain('say what you examined');
    expect(block).not.toMatch(/say ["`']No issues found/i);
  });

  it('carries the project rules when it is given them', () => {
    expect(buildWholeDiffBlock(PLAN, 'No `any` in new code.')).toContain(
      'No `any` in new code.',
    );
  });

  it('refuses a plan with no diff path — the whole point of the command', () => {
    expect(() => buildWholeDiffBlock({ chunks: PLAN.chunks })).toThrow(
      /diffPathAbsolute/,
    );
  });

  it.each([
    ['none of the three', {}],
    ['chunk + whole-diff', { chunk: 13, 'whole-diff': true }],
    ['chunk + role', { chunk: 13, role: '2' }],
    ['whole-diff + role', { 'whole-diff': true, role: '2' }],
    ['all three', { chunk: 13, 'whole-diff': true, role: '2' }],
  ])('rejects a call that names %s', (_, extra) => {
    // Three mutually exclusive modes: a territory chunk, a named role, or the
    // bare whole-diff block. A run that named none used to fall through to the
    // chunk builder with `undefined` and blame the plan for "no chunk undefined";
    // a run that named two would silently pick one. The guard runs before the plan
    // is read, so the message is about the call, and it covers every bad shape —
    // not just the two the first version tested.
    expect(() =>
      (agentPromptCommand.handler as (a: unknown) => void)({
        plan: '/nonexistent/plan.json',
        ...extra,
      }),
    ).toThrow(/exactly one of/);
  });
});

// The rest of the fan-out. Every agent's prompt is now built here — because the
// half that was not got launched with no diff path at all, and the one that was
// never launched at all could not be seen by anything that inspects the agents
// that ran.
describe('buildRoleBrief — every agent, not just the territory ones', () => {
  const PR_PLAN = {
    ...PLAN,
    prNumber: '6766',
    ownerRepo: 'QwenLM/qwen-code',
    worktreePath: '.qwen/tmp/review-pr-6766',
    mergeBaseSha: 'abc123',
  };

  it.each([
    '1a',
    '1b',
    '1c',
    '2',
    '3',
    '4',
    '5',
    '6a',
    '6b',
    '6c',
    'test-matrix',
  ] as const)('welds the diff and every chunk read into role %s', (role) => {
    const p = buildRoleBrief(PLAN, role);
    expect(p).toContain(PLAN.diffPathAbsolute);
    for (const c of PLAN.chunks) {
      expect(p).toContain(
        `offset=${c.startLine - 1}, limit=${c.endLine - c.startLine + 1}`,
      );
    }
    // And the things a paraphrase drops.
    expect(p).toContain('say what you examined');
    expect(p).toContain('**Critical**');
    expect(p).not.toMatch(/If you find no issues, say/i);
  });

  it('gives Agent 7 no diff — its evidence is the commands it ran', () => {
    // It runs the build. Requiring it to open the diff would be requiring a thing
    // its job does not involve, and reporting it "blind" for not doing so would
    // send the reader to fix a prompt that is correct.
    const p = buildRoleBrief(PR_PLAN, '7');
    expect(p).not.toContain(PLAN.diffPathAbsolute);
    expect(p).toContain('npm run build');
    expect(p).toContain('Source: [build]');
  });

  it('pins Agent 7 to the PR worktree and hands it the test-efficacy probe', () => {
    const p = buildRoleBrief(PR_PLAN, '7', { planPath: '/tmp/plan.json' });
    expect(p).toContain('.qwen/tmp/review-pr-6766');
    expect(p).toContain('qwen review test-efficacy /tmp/plan.json');
    expect(p).toContain('--base abc123');
  });

  it('gives Agent 7 ABSOLUTE paths — its cwd is the worktree, not the repo', () => {
    // `worktreePath` and the plan path are repo-relative in the report, and this
    // agent's working directory IS the worktree — so `--worktree
    // .qwen/tmp/review-pr-6766` resolves to `<worktree>/.qwen/tmp/review-pr-6766`,
    // which does not exist. Watched live: Agent 7 of a real 29-agent run spent its
    // time running `find … -name "*6457*fetch*"`, hunting for a plan it had been
    // handed a path to that could not resolve from where it was standing.
    const p = buildRoleBrief(PR_PLAN, '7', { planPath: '/abs/tmp/plan.json' });
    expect(p).toContain('qwen review test-efficacy /abs/tmp/plan.json');
    expect(p).toMatch(/--worktree \/[^\s]*review-pr-6766/);
    expect(p).not.toMatch(/--worktree \.qwen/);
    expect(p).toContain('--out /abs/tmp/qwen-review-pr-6766-efficacy.json');
  });

  it('hands Agent 7 the build-test command with absolute --plan/--worktree/--out', () => {
    const p = buildRoleBrief(PR_PLAN, '7', { planPath: '/abs/tmp/plan.json' });
    expect(p).toContain('qwen review build-test');
    expect(p).toContain('--plan /abs/tmp/plan.json');
    expect(p).toMatch(/--worktree \/[^\s]*review-pr-6766/);
    expect(p).not.toMatch(/--plan \.qwen/);
    expect(p).toContain('--out /abs/tmp/qwen-review-pr-6766-build-test.json');
  });

  it('never emits a literal "undefined" in the build-test --out filename', () => {
    // `prNumber` is typed `unknown` and can be absent. Without the guard, the
    // filename resolves to `qwen-review-pr-undefined-build-test.json` — a report
    // the agent writes and downstream never finds.
    const noPr = { ...PR_PLAN };
    delete (noPr as { prNumber?: unknown }).prNumber;
    const p = buildRoleBrief(noPr, '7', { planPath: '/abs/tmp/plan.json' });
    expect(p).not.toContain('pr-undefined-build-test');
    // The brief PROSE still names the command; what must be absent is the concrete
    // command BLOCK — the `--plan` invocation (unique to the build-test block here).
    expect(p).not.toContain('--plan /abs/tmp/plan.json');
    expect(p).not.toMatch(/--out \S*build-test\.json/);
  });

  it('welds the PR into Agent 0 — a bare `gh pr view` judges the wrong issue', () => {
    const p = buildRoleBrief(PR_PLAN, '0', {
      planPath: '/x/qwen-review-pr-6766-fetch.json',
    });
    expect(p).toContain('#6766');
    expect(p).toContain('QwenLM/qwen-code');
    expect(p).toContain('/x/qwen-review-pr-6766-context.md');
    // The empty scope is a complete answer, and it needs evidence to be one.
    expect(p).toContain('scope empty');
  });

  it('refuses Agent 0 on a plan with no pull request in it', () => {
    expect(() => buildRoleBrief(PLAN, '0')).toThrow(/prNumber/);
  });

  it('gives an invariant agent the file, its added ranges, and its diff slice', () => {
    // The third is not optional. A deletion leaves no trace in the post-change
    // file — the removed line is simply not there, and nothing marks where it was.
    const plan = {
      ...PLAN,
      files: [
        {
          path: 'src/big.ts',
          heavy: true,
          addedRanges: [{ start: 10, end: 40 }],
          diffRange: { startLine: 100, endLine: 300 },
        },
      ],
    };
    const p = buildRoleBrief(plan, 'invariant-a', { file: 'src/big.ts' });
    expect(p).toContain('read_file(file_path="src/big.ts")');
    expect(p).toContain('10-40');
    expect(p).toContain(
      `read_file(file_path="${PLAN.diffPathAbsolute}", offset=99, limit=201)`,
    );
    expect(p).toContain('setTimeout');
  });

  it('refuses an invariant agent on a file the diff did not rewrite', () => {
    const plan = {
      ...PLAN,
      files: [{ path: 'src/small.ts', heavy: false }],
    };
    expect(() =>
      buildRoleBrief(plan, 'invariant-a', { file: 'src/small.ts' }),
    ).toThrow(/not a heavy file/);
  });

  it('splits the invariant checklist three ways, and says so', () => {
    const plan = {
      ...PLAN,
      files: [
        {
          path: 'f.ts',
          heavy: true,
          addedRanges: [],
          diffRange: { startLine: 1, endLine: 2 },
        },
      ],
    };
    const a = buildRoleBrief(plan, 'invariant-a', { file: 'f.ts' });
    const b = buildRoleBrief(plan, 'invariant-b', { file: 'f.ts' });
    const c = buildRoleBrief(plan, 'invariant-c', { file: 'f.ts' });
    expect(a).toContain('Timers');
    expect(b).toContain('Retry counters');
    expect(c).toContain('Early returns');
    for (const p of [a, b, c]) expect(p).toContain('do not attempt the others');
  });

  it('carries the project rules into every role', () => {
    expect(buildRoleBrief(PLAN, '2', { rules: 'No `any`.' })).toContain(
      'No `any`.',
    );
    expect(
      buildRoleBrief(
        { ...PLAN, prNumber: '1', ownerRepo: 'a/b', worktreePath: 'w' },
        '7',
        { rules: 'No `any`.' },
      ),
    ).toContain('No `any`.');
  });

  it('records each role under the key the roster looks it up by', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ap-role-'));
    try {
      const plan = join(dir, 'plan.json');
      writeFileSync(plan, JSON.stringify(PR_PLAN));
      (agentPromptCommand.handler as (a: unknown) => void)({
        plan,
        role: '1c',
      });
      (agentPromptCommand.handler as (a: unknown) => void)({ plan, role: '2' });
      const recorded = readRecordedPrompts(plan);
      expect([...recorded.keys()].sort()).toEqual(['1c', '2']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The size problem, stated as a test. A 4 652-character prompt is not a thing an
// orchestrator will paste twelve times: measured on a real run, it delivered 2 893
// characters of one — head kept, preamble of its own added, 1 900 characters cut
// out of the middle — then read the check's exit-3, decided "the agents clearly did
// their job", skipped compose-review, and filed an Approve it had written itself.
describe('buildRoleLaunchPrompt — small enough to actually be carried', () => {
  it('points at the brief instead of containing it', () => {
    const p = buildRoleLaunchPrompt(PLAN, '2', '/tmp/prompts/2.brief.md');
    expect(p).toContain('read_file(file_path="/tmp/prompts/2.brief.md")');
    expect(p).toContain('Your brief is a file');
    // The brief's own text is NOT in it.
    expect(p).not.toContain('Injection (SQL, command');
  });

  it('still names the diff and every range — coverage is computed from this', () => {
    const p = buildRoleLaunchPrompt(PLAN, '2', '/tmp/2.brief.md');
    expect(p).toContain(PLAN.diffPathAbsolute);
    for (const c of PLAN.chunks) {
      expect(p).toContain(
        `offset=${c.startLine - 1}, limit=${c.endLine - c.startLine + 1}`,
      );
    }
  });

  it('gives Agent 7 no diff — it runs the build', () => {
    const p = buildRoleLaunchPrompt(PLAN, '7', '/tmp/7.brief.md');
    expect(p).not.toContain(PLAN.diffPathAbsolute);
    expect(p).toContain('/tmp/7.brief.md');
  });

  it('stays under a kilobyte, where the full brief does not', () => {
    // The number is the point. Twelve of these is a few kilobytes the orchestrator
    // copies without editing; twelve of the briefs is fifty-five, which it does not.
    for (const role of [
      '0',
      '1a',
      '1c',
      '2',
      '6a',
      '7',
      'test-matrix',
    ] as const) {
      const launch = buildRoleLaunchPrompt(PLAN, role, '/tmp/x.brief.md');
      expect(launch.length).toBeLessThan(1024);
    }
    const brief = buildRoleBrief(PLAN, '1c');
    expect(brief.length).toBeGreaterThan(3000);
  });
});

describe('buildChunkLaunchPrompt — the 87-kilobyte problem', () => {
  it('carries the chunk id and the read, and nothing else of size', () => {
    // Coverage is computed from these two, off the prompt the harness recorded:
    // `chunk N of M` attributes the territory, `offset`/`limit` are the lines the
    // agent was pointed at. They cannot move to the brief. Everything else did.
    const p = buildChunkLaunchPrompt(PLAN, 13, '/tmp/p/chunk-13.brief.md');
    expect(p).toMatch(/chunk 13 of 3/);
    expect(p).toContain('read_file(file_path="/tmp/p/chunk-13.brief.md")');
    expect(p).toContain(
      `read_file(file_path="${PLAN.diffPathAbsolute}", offset=3807, limit=217)`,
    );
    expect(p.length).toBeLessThan(1024);
  });

  it('is a fraction of the brief it points at', () => {
    // Seventeen chunk briefs with the project rules in them is eighty-seven
    // kilobytes in one response. Seventeen of these is eleven.
    const launch = buildChunkLaunchPrompt(PLAN, 13, '/tmp/x.brief.md');
    const brief = buildChunkAgentPrompt(PLAN, 13, 'No `any` in new code.');
    expect(brief.length).toBeGreaterThan(launch.length * 2);
  });

  it('hands the agent no sentence to recite when it finds nothing', () => {
    const p = buildChunkLaunchPrompt(PLAN, 13, '/tmp/x.brief.md');
    expect(p).toContain('say what you examined');
    expect(p).not.toMatch(/say ["`\u2018\u201c]No issues found/i);
  });
});

// `/review` runs on other people's repositories. A checklist that arrives when it
// is not wanted is worse than one that never existed.
describe('path rules — they arrive where they belong, and nowhere else', () => {
  const WF_PLAN = {
    diffPathAbsolute: '/abs/d.txt',
    prNumber: '1',
    ownerRepo: 'a/b',
    worktreePath: 'w',
    files: [{ path: '.github/workflows/patrol.yml' }, { path: 'src/pay.ts' }],
    chunks: [
      {
        id: 1,
        startLine: 1,
        endLine: 100,
        lines: 100,
        chars: 500,
        maxLineChars: 80,
        oversized: false,
        files: [
          { path: '.github/workflows/patrol.yml', newStart: 1, newEnd: 90 },
        ],
      },
      {
        id: 2,
        startLine: 101,
        endLine: 200,
        lines: 100,
        chars: 500,
        maxLineChars: 80,
        oversized: false,
        files: [{ path: 'src/pay.ts', newStart: 1, newEnd: 90 }],
      },
    ],
  };

  it('reaches the chunk agent whose territory holds the workflow', () => {
    expect(buildChunkAgentPrompt(WF_PLAN, 1)).toContain('pull_request_target');
  });

  it('does not reach the chunk agent next door, whose territory does not', () => {
    // The scoping that keeps this from being noise. Chunk 2 is TypeScript.
    expect(buildChunkAgentPrompt(WF_PLAN, 2)).not.toContain(
      'pull_request_target',
    );
  });

  it.each(['1a', '1b', '2', '3', '4', '5', '6a', '6b', '6c'] as const)(
    'reaches the code-reviewing dimension %s',
    (role) => {
      expect(buildRoleBrief(WF_PLAN, role)).toContain('pull_request_target');
    },
  );

  it.each(['0', '7', 'test-matrix'] as const)(
    'does not reach %s — it is not sitting that exam',
    (role) => {
      // Build & Test runs commands. Issue Fidelity reads an issue. The test matrix
      // maps behaviours to tests. None of them reviews the workflow's code, and a
      // security syllabus in their brief is a syllabus that gets skimmed.
      expect(buildRoleBrief(WF_PLAN, role)).not.toContain(
        'pull_request_target',
      );
    },
  );

  it('scopes an invariant agent to its own file', () => {
    const plan = {
      ...WF_PLAN,
      files: [
        {
          path: 'src/pay.ts',
          heavy: true,
          addedRanges: [{ start: 1, end: 9 }],
          diffRange: { startLine: 1, endLine: 9 },
        },
        { path: '.github/workflows/patrol.yml' },
      ],
    };
    // It owns pay.ts. The workflow elsewhere in the diff is not its problem.
    expect(
      buildRoleBrief(plan, 'invariant-a', { file: 'src/pay.ts' }),
    ).not.toContain('pull_request_target');
  });

  it('is silent on a diff that touches no workflow at all', () => {
    // The common case. It must cost nothing.
    const plain = { ...WF_PLAN, files: [{ path: 'src/pay.ts' }] };
    expect(buildRoleBrief(plain, '2')).not.toContain('GitHub Actions');
    expect(buildRoleBrief(plain, '2')).not.toContain('Rules for the files');
  });
});

// The degradation the orchestrator used to add by hand — and now cannot, because it
// does not write these prompts any more.
describe('lightweight mode — the diff, and nothing else', () => {
  const LIGHT = { ...PLAN }; // no worktreePath, no untrackedFiles → diff-only
  const LOCAL = { ...PLAN, worktreePath: '.qwen/tmp/review-pr-1' };

  it('tells a code-reviewing agent there is no tree to read', () => {
    expect(buildRoleBrief(LIGHT, '1a')).toContain(
      'You have the diff, and nothing else',
    );
    expect(buildRoleBrief(LOCAL, '1a')).not.toContain(
      'You have the diff, and nothing else',
    );
  });

  it('stops 1b and 1c asserting what they cannot check', () => {
    // A precision rule, not a convenience. An agent that cannot grep for a
    // re-establishment and asserts one is missing files a false Critical, and a
    // false Critical blocks a merge.
    for (const role of ['1b', '1c'] as const) {
      const b = buildRoleBrief(LIGHT, role);
      expect(b).toContain('`Confidence: low`');
      expect(b).toContain('must not assert it is missing');
      expect(buildRoleBrief(LOCAL, role)).not.toContain(
        'must not assert it is missing',
      );
    }
  });
});

describe('an invariant agent reads its file, not the whole review', () => {
  const HEAVY = {
    diffPathAbsolute: '/abs/d.txt',
    files: [
      {
        path: 'src/big.ts',
        heavy: true,
        addedRanges: [{ start: 10, end: 40 }],
        diffRange: { startLine: 100, endLine: 300 },
      },
    ],
    chunks: [
      {
        id: 1,
        startLine: 1,
        endLine: 400,
        lines: 400,
        chars: 1,
        maxLineChars: 1,
        oversized: false,
        files: [],
      },
      {
        id: 2,
        startLine: 401,
        endLine: 800,
        lines: 400,
        chars: 1,
        maxLineChars: 1,
        oversized: false,
        files: [],
      },
      {
        id: 3,
        startLine: 801,
        endLine: 1200,
        lines: 400,
        chars: 1,
        maxLineChars: 1,
        oversized: false,
        files: [],
      },
    ],
  };

  it("is pointed at its own file's diff slice, and at nothing else", () => {
    // It used to be handed the whole chunk plan. That sends it to read every line of
    // a six-thousand-line diff it was not asked about — and coverage is computed
    // from the ranges in this prompt, so it would be credited with reading every
    // chunk in the review. One agent could mask twenty missing ones.
    const p = buildRoleLaunchPrompt(HEAVY, 'invariant-a', '/t/b.md', {
      file: 'src/big.ts',
    });
    expect(p).toContain('offset=99, limit=201'); // diffRange 100-300
    expect(p).not.toContain('offset=0, limit=400'); // chunk 1
    expect(p).not.toContain('offset=400, limit=400'); // chunk 2
    expect(p).not.toContain('offset=800, limit=400'); // chunk 3
  });

  it('still hands a whole-diff agent every chunk', () => {
    const p = buildRoleLaunchPrompt(HEAVY, '2', '/t/b.md');
    expect(p).toContain('offset=0, limit=400');
    expect(p).toContain('offset=400, limit=400');
    expect(p).toContain('offset=800, limit=400');
  });
});
