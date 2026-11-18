/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(import.meta.dirname, 'AppContainer.tsx'),
  'utf8',
);

describe('AppContainer controls-height measurement wiring', () => {
  it('subscribes to the real controls box geometry', () => {
    expect(source).toMatch(
      /const\s*\{\s*height:\s*controlsHeight\s*\}\s*=\s*useBoxMetrics\(mainControlsRef\)/,
    );
  });

  it('subtracts the observed controls height from the transcript budget', () => {
    const start = source.indexOf('const availableTerminalHeight =');
    expect(start).toBeGreaterThan(-1);
    expect(source.slice(start, source.indexOf(');', start))).toMatch(
      /terminalHeight\s*-\s*controlsHeight\s*-\s*mainContentHeightReservation\s*-\s*tabBarHeight/,
    );
  });

  it('does not retain the replaced manual controls measurement effect', () => {
    expect(source).not.toContain('measureElement(mainControlsRef.current)');
    expect(source).not.toContain('setControlsHeight(');
  });
});
