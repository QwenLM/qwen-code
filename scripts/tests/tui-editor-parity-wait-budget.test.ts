/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readyPromptBudgetMs } from '../../integration-tests/ready-prompt-budget.js';
import { CI_WAIT_MULTIPLIER } from '../../integration-tests/interactive/wait.js';

// A wait ceiling is invisible on a green run: the editor-parity repaints land
// in well under a second, so only the non-deterministic pool stall of #17544
// surfaces a revert to the old literal. Pinned here, where test:scripts
// collects it on every PR — the PR-gated integration lanes enumerate files
// and omit this one (scripts/tests/ready-prompt-budget.test.ts).
const repo = resolve(import.meta.dirname, '../..');
const source = readFileSync(
  join(repo, 'integration-tests/interactive/tui-editor-parity.test.ts'),
  'utf8',
);
const integrationConfig = readFileSync(
  join(repo, 'integration-tests/vitest.config.ts'),
  'utf8',
);

describe('tui-editor-parity wait ceiling (#17544)', () => {
  it('gives a mid-turn repaint the shared-pool boot stall tier in CI', () => {
    const literal = source.match(/const WAIT_LOCAL_MS = ([\d_]+);/)?.[1];
    expect(literal).toBeDefined();
    expect(source).toContain('createUntil(WAIT_LOCAL_MS)');
    // The factor wait.ts actually applies, not a second spelling of it: a
    // CI-time saving there must red this pin rather than silently drop the
    // ceiling back below the stall tier.
    const ciWaitMs = Number(literal?.replaceAll('_', '')) * CI_WAIT_MULTIPLIER;
    expect(ciWaitMs).toBeGreaterThanOrEqual(
      readyPromptBudgetMs({ RUNNER_ENVIRONMENT: 'self-hosted' }),
    );
    // Compared in the units the wait runs in: a local budget under the
    // per-test timeout can still scale past it, and a stalled repaint would
    // then die as vitest's bare "Test timed out" with no until label.
    expect(ciWaitMs).toBeLessThan(300_000);
    // 300s is the config's fallback, not a constant; pin both halves of the
    // derivation so lowering it moves this bound too.
    expect(integrationConfig).toMatch(
      /Number\(process\.env\['TB_TIMEOUT_MINUTES'\] \|\| '5'\)/,
    );
    expect(integrationConfig).toMatch(
      /const testTimeoutMs = timeoutMinutes \* 60 \* 1000;/,
    );
  });

  it('keeps every per-case ceiling above one stalled wait', () => {
    // The /permissions cases override the root timeout downward. A literal
    // there pre-empts the wait's own label, so each ceiling derives from the
    // boot window plus one scaled wait instead.
    expect(source).toContain(
      'readyPromptBudgetMs(process.env) + scaledWait(WAIT_LOCAL_MS) + 60_000',
    );
    const ceilings = [...source.matchAll(/^ {2}(\w+),\n\);$/gm)].map(
      (m) => m[1],
    );
    expect([...new Set(ceilings)]).toEqual(['PERMISSIONS_CASE_TIMEOUT']);
  });
});
