/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readyPromptBudgetMs } from '../ready-prompt-budget.js';

// A wait ceiling is invisible on a green run: the editor-parity repaints land
// in well under a second, so only the non-deterministic pool stall of #17544
// surfaces a revert to the old literal. Pin the decision next to the suite it
// sizes, the way scripts/tests pins the ready-prompt budget.
const source = readFileSync(
  join(import.meta.dirname, 'tui-editor-parity.test.ts'),
  'utf8',
);

describe('tui-editor-parity wait ceiling (#17544)', () => {
  it('gives a mid-turn repaint the shared-pool boot stall tier in CI', () => {
    const literal = source.match(
      /const until = createUntil\(\s*([\d_]+),?\s*\)/,
    )?.[1];
    expect(literal).toBeDefined();
    const localMs = Number(literal?.replaceAll('_', ''));
    // createUntil triples its budget when CI=true (wait.ts).
    expect(localMs * 3).toBeGreaterThanOrEqual(
      readyPromptBudgetMs({ RUNNER_ENVIRONMENT: 'self-hosted' }),
    );
    // The suite inherits vitest.config.ts's 300s per-test ceiling; a local
    // budget at or past it would fail on the timeout, not the wait's label.
    expect(localMs).toBeLessThan(300_000);
  });
});
