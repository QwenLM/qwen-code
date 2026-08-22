/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The marker format has a SECOND reader outside this package:
 * `.github/scripts/review-auto-stop.mjs`, the caller-side gate that decides
 * whether this repository keeps auto-triggering reviews (issue #9278). It
 * hand-copies the `OPEN`/`CLOSE` tokens, the `v === 1` pin and three field
 * names from this module, which are module-private here — so nothing but this
 * file couples the two.
 *
 * Without it, a producer-side `v: 1` → `v: 2` bump makes that gate read every
 * genuine review as unmarked: it reports "only 0 round(s) carry a readable
 * marker" on every PR and keeps reviewing forever — permanently inert,
 * fail-open, silent, and green in the gate's own suite, because every fixture
 * there is built from the gate's own constants.
 *
 * So these assertions feed REAL `serializeLedger` output through the real
 * gate. It runs in a child `node`, not as an import: the gate is plain ESM
 * outside every package's tsconfig, and spawning it exercises the module the
 * workflow actually loads.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  LEDGER_MAX_BYTES,
  LEDGER_MAX_FINDINGS,
  serializeLedger,
  type Ledger,
  type LedgerFinding,
} from './ledger.js';

/**
 * Found by walking up rather than by a relative hop: this file's own URL is
 * not a file URL under Vitest's transform, and a wrong path here would be a
 * spawn failure, never a silent pass.
 */
const gate = (() => {
  const rel = join('.github', 'scripts', 'review-auto-stop.mjs');
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    if (existsSync(join(dir, rel))) return join(dir, rel);
    if (dirname(dir) === dir)
      throw new Error(`could not locate ${rel} above ${process.cwd()}`);
  }
})();

interface GateAnswer {
  markers: Array<{
    round: number;
    fresh: number | null;
    floor: string | null;
  } | null>;
  decision: { stop: boolean; reason: string; evidence: { window: number } };
}

/** Run the shipped gate over these bodies, newest first. */
function askGate(bodies: string[]): GateAnswer {
  const dir = mkdtempSync(join(tmpdir(), 'auto-stop-contract-'));
  try {
    const input = join(dir, 'input.json');
    writeFileSync(input, JSON.stringify({ bodies }));
    const out = execFileSync(
      process.execPath,
      [
        '-e',
        `import(${JSON.stringify(pathToFileURL(gate).href)}).then(async (m) => {
           const { readFileSync } = await import('node:fs');
           const { bodies } = JSON.parse(readFileSync(process.argv[1], 'utf8'));
           process.stdout.write(JSON.stringify({
             markers: bodies.map((b) => m.readMarker(b)),
             decision: m.decideAutoStop(bodies),
           }));
         });`,
        input,
      ],
      { encoding: 'utf8' },
    );
    return JSON.parse(out) as GateAnswer;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const finding = (round: number, n: number): LedgerFinding => ({
  id: `R${round}-${n}`,
  sev: 'S',
  file: 'packages/cli/src/commands/review/compose-review.ts',
  line: 10 * n,
  title: `finding ${n} of round ${round}`,
});

const round = (r: number, fresh: number, findings = 2): Ledger => ({
  v: 1,
  round: r,
  findings: Array.from({ length: findings }, (_, i) => finding(r, i + 1)),
  posted: findings,
  prevPosted: findings,
  fresh,
  floor: 'o',
  sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  model: 'qwen3.8-max',
});

describe('the caller-side auto-stop gate reads what this module writes', () => {
  it('round-trips a real marker into the three fields the gate reads', () => {
    const body = `## Code review\n\nprose\n\n${serializeLedger(round(6, 3))}`;
    expect(askGate([body]).markers[0]).toEqual({
      round: 6,
      fresh: 3,
      floor: 'o',
    });
  });

  it('stops on a real non-shrinking series, with the measurement it states', () => {
    // Newest first, exactly as the workflow hands them over.
    const bodies = [round(6, 3), round(5, 3), round(4, 2), round(3, 2)].map(
      (l) => `prose\n\n${serializeLedger(l)}`,
    );
    const { decision } = askGate(bodies);
    expect(decision.stop).toBe(true);
    expect(decision.reason).toMatch(/r3=2 → r4=2 → r5=3 → r6=3/);
  });

  it('keeps reviewing when the byte cap sheds the count the trend is about', () => {
    // `fresh` and `floor` are the FIRST things the size cascade sheds, so a
    // heavy round genuinely publishes a marker without them. The gate must
    // read that as unevaluable — never as a flat trend.
    const heavy: Ledger = {
      ...round(6, 3, LEDGER_MAX_FINDINGS),
      findings: Array.from({ length: LEDGER_MAX_FINDINGS }, (_, i) => ({
        ...finding(6, i + 1),
        file: `packages/cli/src/commands/review/lib/${'d'.repeat(150)}/f${i}.ts`,
        title: `${'t'.repeat(70)}${i}`,
      })),
    };
    const shed = serializeLedger(heavy);
    expect(shed.length).toBeLessThanOrEqual(LEDGER_MAX_BYTES);
    expect(shed).not.toContain('"fresh"');

    const answer = askGate([
      `prose\n\n${shed}`,
      ...[round(5, 3), round(4, 2), round(3, 2)].map(
        (l) => `prose\n\n${serializeLedger(l)}`,
      ),
    ]);
    expect(answer.markers[0]).toEqual({ round: 6, fresh: null, floor: null });
    expect(answer.decision.stop).toBe(false);
    expect(answer.decision.reason).toMatch(/no first-time count/);
  });
});
