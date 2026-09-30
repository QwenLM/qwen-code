/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (file) =>
  readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

// Repo-root script mentions, bare or ./-prefixed. A package-relative tail such
// as packages/foo/scripts/bar.js is not a root mention, so the lookbehind
// still rejects a `scripts/` preceded by a path character.
const namedScripts = (text) => [
  ...new Set(
    [...text.matchAll(/(?<![\w./-])(?:\.\/)?scripts\/[\w./-]*[\w-]/g)].map(
      (match) => match[0].replace(/^\.\//, ''),
    ),
  ),
];

describe('managed-agent-server e2e runner', () => {
  // #12941: the Stage A acceptance criterion names a 15-second Runtime delay,
  // but the ordering assertion was gated at 20 s, so a --runtime-delay-ms 15000
  // run silently skipped it. Pin the threshold to the criterion's delay and
  // the README's statement of the arming delay to the threshold.
  it('arms the model-before-Runtime assertion at the criterion delay', () => {
    const source = read('scripts/run-managed-agent-server-e2e.ts');
    expect(source).toContain('modelBeforeRuntimeAssertionDelayMs = 15_000');
    expect(source).toContain(
      'runtimeDelayMs >= modelBeforeRuntimeAssertionDelayMs',
    );
    const delaySeconds =
      Number(
        source
          .match(/modelBeforeRuntimeAssertionDelayMs = (\d[\d_]*)/)[1]
          .replace(/_/g, ''),
      ) / 1000;
    expect(read('packages/sdk-java/managed-agent-server/README.md')).toContain(
      `the ${delaySeconds} seconds the acceptance criterion`,
    );
  });

  // When the assertion fires the operator must tell an ordering defect from
  // provider latency, so the thrown message must carry the deciding sequence
  // operands alongside the in-scope timings (observedAt is a poll-batch stamp,
  // so the timings alone can be identical or argue against the verdict).
  it('reports the ordering timings when the assertion fires', () => {
    const source = read('scripts/run-managed-agent-server-e2e.ts');
    expect(source).toContain('firstModelSequence=${firstModel.event.sequence}');
    expect(source).toContain(
      'runtimeReadySequence=${runtimeReady.event.sequence}',
    );
    expect(source).toContain(
      'firstModelEventMs=${firstModel.observedAt - requestStartedAt}',
    );
    expect(source).toContain(
      'runtimeReadyMs=${runtimeReady.observedAt - requestStartedAt}',
    );
    expect(source).toContain('runtimeDelayMs=${runtimeDelayMs}');
  });

  // #12941: the README named scripts/run-managed-hosted-runtime-e2e.ts as the
  // deterministic CI proof, a file that has never existed. Any script the
  // README names must be real.
  it('names only scripts that exist', () => {
    const readme = read('packages/sdk-java/managed-agent-server/README.md');
    expect(readme).not.toContain('run-managed-hosted-runtime-e2e');
    for (const script of namedScripts(readme)) {
      expect(
        existsSync(new URL(`../../${script}`, import.meta.url)),
        `${script} named in the managed-agent README does not exist`,
      ).toBe(true);
    }
  });

  // The README currently names no script, so only a fixture can pin the
  // extractor itself: an extractor that stops matching must fail, not pass.
  it('extracts the script spellings the README could use', () => {
    expect(namedScripts('npx tsx ./scripts/nope.ts')).toEqual([
      'scripts/nope.ts',
    ]);
    expect(namedScripts('see `scripts/nope.ts`')).toEqual(['scripts/nope.ts']);
    expect(namedScripts('packages/foo/scripts/nope.ts')).toEqual([]);
  });
});
