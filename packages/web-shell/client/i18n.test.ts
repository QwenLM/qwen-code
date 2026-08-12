/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { EN, ZH } from './i18n';

describe('i18n EN/ZH parity', () => {
  it('keeps ZH a superset of EN with matching value shapes', () => {
    // t() falls back to EN and then to the raw key, so a key missing from
    // ZH silently renders English in zh-CN and a missing EN key renders the
    // key itself — with no runtime error either way. The `...EN` spread
    // guarantees the superset today; this pins it for refactors, and pins
    // the string-vs-function shape of every override (a function override
    // replaced by a plain string renders without interpolation).
    const missing = Object.keys(EN).filter((key) => !(key in ZH));
    expect(missing).toEqual([]);
    const shapeMismatched = Object.keys(EN).filter(
      (key) => typeof ZH[key] !== typeof EN[key],
    );
    expect(shapeMismatched).toEqual([]);
  });
});
