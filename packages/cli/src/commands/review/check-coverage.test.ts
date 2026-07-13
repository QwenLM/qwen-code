/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The subject here is a review that approved 4 925 lines nobody read. Every test
// that matters is a test that this command *refused* to call that covered.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkCoverage,
  checkCoverageCommand,
  splitReturns,
} from './check-coverage.js';

/** What a chunk agent that did its job comes back with. */
function real(id: number): string {
  return (
    `- **File:** src/pay.ts:12\n- **Issue:** the guard is inverted\n` +
    `- **Failure scenario:** a negative amount charges the card\n\n` +
    `Covered: chunk ${id} lines 1-400\n`
  );
}

/** What one that did not comes back with. Verbatim from the dogfood run. */
const WHIFF = 'No issues found.\n';

function returnsFile(blocks: Array<[string, string]>): string {
  return blocks
    .map(([label, body]) => `=== AGENT: ${label} ===\n${body}`)
    .join('');
}

describe('splitReturns', () => {
  it("keeps each agent's text verbatim, including a bare one", () => {
    const out = splitReturns(
      returnsFile([
        ['chunk 1', real(1)],
        ['chunk 2', WHIFF],
      ]),
    );
    expect(out.map((r) => r.label)).toEqual(['chunk 1', 'chunk 2']);
    expect(out[0].body).toContain('Covered: chunk 1');
    expect(out[1].body.trim()).toBe('No issues found.');
  });
});

describe('checkCoverage', () => {
  it('passes when every chunk carries a receipt', () => {
    const r = checkCoverage(
      [1, 2, 3],
      splitReturns(
        returnsFile([
          ['chunk 1', real(1)],
          ['chunk 2', real(2)],
          ['chunk 3', real(3)],
        ]),
      ),
    );
    expect(r.ok).toBe(true);
    expect(r.missingChunks).toEqual([]);
    expect(r.whiffedAgents).toEqual([]);
  });

  it('refuses the review that approved a diff nobody read', () => {
    // The dogfood run, reproduced: eighteen chunks, and every agent back in under
    // two seconds with the words "No issues found." and nothing else. The
    // orchestrator called that zero findings and filed an Approve.
    const planned = Array.from({ length: 18 }, (_, i) => i + 1);
    const r = checkCoverage(
      planned,
      splitReturns(
        returnsFile(
          planned.map((id) => [`chunk ${id}`, WHIFF] as [string, string]),
        ),
      ),
    );

    expect(r.ok).toBe(false);
    expect(r.missingChunks).toEqual(planned); // nobody receipted anything
    expect(r.whiffedAgents).toHaveLength(18);
    expect(r.coveredChunks).toEqual([]);
  });

  it('names the chunk nobody covered, not just the count', () => {
    const r = checkCoverage(
      [1, 2, 3],
      splitReturns(
        returnsFile([
          ['chunk 1', real(1)],
          ['chunk 3', real(3)],
        ]),
      ),
    );
    expect(r.ok).toBe(false);
    expect(r.missingChunks).toEqual([2]);
  });

  it('accepts an Uncoverable receipt as a disclosed gap, not a failure', () => {
    // A chunk holding one line longer than a read returns cannot be covered by
    // anyone. Saying so is the honest answer; it still forbids an Approve
    // downstream, but it is not a *missing* receipt.
    const r = checkCoverage(
      [1, 2],
      splitReturns(
        returnsFile([
          ['chunk 1', real(1)],
          ['chunk 2', 'Uncoverable: chunk 2 — line exceeds the read limit\n'],
        ]),
      ),
    );
    expect(r.ok).toBe(true);
    expect(r.uncoverableChunks).toEqual([2]);
    expect(r.missingChunks).toEqual([]);
  });

  it('lets a whole-diff agent earn its silence with evidence', () => {
    // The whole-diff agents owe no receipt, so the substantive-return check is
    // the only one they get. A bare "No issues found." is a whiff; the same
    // finding *with what it walked* is a complete answer.
    const bare = checkCoverage(
      [],
      splitReturns(returnsFile([['security', WHIFF]])),
    );
    expect(bare.whiffedAgents).toEqual(['security']);

    // The prompt's OWN model answer for a clean return is 108 characters. A
    // check that rejects it fails closed on good work — and my first threshold
    // (120) did exactly that, flagging a real Build & Test return that named its
    // commands and their outcomes. Caught by driving the command against the
    // actual dogfood transcript.
    const concise = checkCoverage(
      [],
      splitReturns(
        returnsFile([
          [
            'build-and-test',
            '`npm run build` ok. `npm test` 749 passed across 48 files. No ' +
              'build or test failures.\n',
          ],
        ]),
      ),
    );
    expect(concise.whiffedAgents).toEqual([]);

    // But a length floor alone is crude: this clears it and says nothing.
    const hollow = checkCoverage(
      [],
      splitReturns(returnsFile([['quality', 'No issues found\n']])),
    );
    expect(hollow.whiffedAgents).toEqual(['quality']);

    const earned = checkCoverage(
      [],
      splitReturns(
        returnsFile([
          [
            'security',
            'No issues found — walked every new subprocess call site, every ' +
              'path joined from user input, and the two new regexes for ' +
              'catastrophic backtracking. Nothing reaches a shell.\n',
          ],
        ]),
      ),
    );
    expect(earned.whiffedAgents).toEqual([]);
    expect(earned.ok).toBe(true);
  });
});

describe('checkCoverage — topology and roster', () => {
  it('does not demand receipts under the dimension fan-out', () => {
    // Step 3A has no receipts, and must not. The first cut demanded them anyway,
    // which would have blocked EVERY small review at Step 4 with chunks it
    // believed nobody read. Under the dimension topology the only question is
    // whether each agent did a walk.
    const r = checkCoverage(
      [1, 2, 3],
      splitReturns(
        returnsFile([
          [
            'correctness',
            'No issues found — walked all three hunks; the guard on line 12 ' +
              'handles the empty case, and every changed export keeps its ' +
              'signature.\n',
          ],
        ]),
      ),
      { topology: 'dimension' },
    );
    expect(r.ok).toBe(true);
    expect(r.missingChunks).toEqual([]);
  });

  it('still flags a dimension agent that walked nothing', () => {
    const r = checkCoverage(
      [1, 2],
      splitReturns(returnsFile([['security', 'No issues found.\n']])),
      { topology: 'dimension' },
    );
    expect(r.ok).toBe(false);
    expect(r.whiffedAgents).toEqual(['security']);
  });

  it('sees an expected agent that never returned at all', () => {
    // Every chunk receipted, but the Security agent was never launched. A checker
    // that only sees the returns that turned up cannot miss what is not there.
    const r = checkCoverage(
      [1],
      splitReturns(returnsFile([['chunk 1', real(1)]])),
      { topology: 'territory', expected: ['chunk 1', 'security'] },
    );
    expect(r.ok).toBe(false);
    expect(r.missingAgents).toEqual(['security']);
  });

  it('does not credit a receipt for a chunk the agent was not assigned', () => {
    // A chunk-1 agent whose receipt says `Covered: chunk 2` — a copy-paste, or a
    // receipt quoted out of the untrusted diff this file sits in. The label
    // carries the assignment; the receipt has to agree with it.
    //
    // Chunk 2 is deliberately NOT among the returns, so the only way it could
    // appear as covered is by crediting the cross-claim. It must not: chunk 2 is
    // missing, and chunk 1 — which brought no receipt of its own — is missing
    // too. (An earlier version of this test kept chunk 2 present, so `[2]` came
    // from chunk 2's own receipt and the cross-claim went unmeasured — the
    // assertion matched the buggy behaviour exactly.)
    const bad = checkCoverage(
      [1, 2],
      splitReturns(
        returnsFile([
          ['chunk 1', 'Covered: chunk 2 lines 1-9\nthe guard is inverted\n'],
        ]),
      ),
    );
    expect(bad.coveredChunks).toEqual([]); // the cross-claim credits nothing
    expect(bad.missingChunks).toEqual([1, 2]);
  });

  it('flags a receipted chunk whose body still says nothing', () => {
    // The substantive-return check must run WITH a receipt present, not only
    // without one. A `Covered: chunk 3` followed by "No issues found." read the
    // lines it was handed and looked at none of them.
    const r = checkCoverage(
      [3],
      splitReturns(
        returnsFile([
          ['chunk 3', 'Covered: chunk 3 lines 1-9\nNo issues found.\n'],
        ]),
      ),
    );
    expect(r.coveredChunks).toEqual([3]);
    expect(r.whiffedAgents).toEqual(['chunk 3']);
    expect(r.ok).toBe(false);
  });

  it('sanitises a forged, control-laden agent label', () => {
    const forged = `chunk 1 \u001b[2K\u0007${'x'.repeat(200)}`;
    const r = checkCoverage(
      [1],
      splitReturns(`=== AGENT: ${forged} ===\n${real(1)}`),
    );
    // No control byte survives into the report — a diff-induced `=== AGENT:`
    // line could otherwise fabricate a return and drive the reader's terminal.
    // eslint-disable-next-line no-control-regex
    expect(/[\u0000-\u001f]/.test(JSON.stringify(r))).toBe(false);
  });
});

describe('check-coverage (command boundary)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'check-coverage-'));
    process.exitCode = undefined;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  function run(chunks: number[], blocks: Array<[string, string]>) {
    const plan = join(dir, 'plan.json');
    const returns = join(dir, 'returns.txt');
    const out = join(dir, 'coverage.json');
    writeFileSync(
      plan,
      JSON.stringify({ chunks: chunks.map((id) => ({ id })) }),
    );
    writeFileSync(returns, returnsFile(blocks));
    (checkCoverageCommand.handler as (a: unknown) => void)({
      plan,
      returns,
      out,
      topology: 'territory',
    });
    return JSON.parse(readFileSync(out, 'utf8'));
  }

  it('exits non-zero when the diff was not covered', () => {
    const report = run(
      [1, 2],
      [
        ['chunk 1', WHIFF],
        ['chunk 2', WHIFF],
      ],
    );
    expect(report.ok).toBe(false);
    expect(process.exitCode).toBe(3);
  });

  it('exits clean when it was', () => {
    const report = run(
      [1, 2],
      [
        ['chunk 1', real(1)],
        ['chunk 2', real(2)],
      ],
    );
    expect(report.ok).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it('refuses a plan that is not a plan', () => {
    // `{}` parses, and a zero-chunk plan is a review with nothing to cover. Point
    // the command at the wrong artifact and it would exit 0 over a diff it never
    // saw.
    const plan = join(dir, 'plan.json');
    const returns = join(dir, 'returns.txt');
    writeFileSync(plan, JSON.stringify({}));
    writeFileSync(returns, returnsFile([['chunk 1', real(1)]]));
    expect(() =>
      (checkCoverageCommand.handler as (a: unknown) => void)({
        plan,
        returns,
        out: join(dir, 'c.json'),
        topology: 'territory',
      }),
    ).toThrow(/no .chunks/);
  });

  it('refuses a returns file with no agent blocks at all', () => {
    const plan = join(dir, 'plan.json');
    const returns = join(dir, 'returns.txt');
    writeFileSync(plan, JSON.stringify({ chunks: [{ id: 1 }] }));
    // A summary of what the agents said, rather than what they said.
    writeFileSync(returns, 'All agents reported no issues.\n');

    expect(() =>
      (checkCoverageCommand.handler as (a: unknown) => void)({
        plan,
        returns,
        out: join(dir, 'coverage.json'),
      }),
    ).toThrow(/verbatim/);
  });
});
