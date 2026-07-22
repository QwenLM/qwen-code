/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Goal runtime cutover', () => {
  it('removes the legacy history-to-Stop-hook restore entrypoint', () => {
    expect(
      existsSync(resolve(process.cwd(), 'src/ui/utils/restoreGoal.ts')),
    ).toBe(false);
  });

  it('does not import legacy Goal runtime modules from production CLI code', () => {
    const streamPath = resolve(
      process.cwd(),
      'src/ui/hooks/useGeminiStream.ts',
    );
    const source = readFileSync(streamPath, 'utf8');

    expect(source).not.toContain('getActiveGoal');
    expect(source).not.toContain('setActiveGoal');
    expect(source).not.toContain('clearActiveGoal');
  });
});
