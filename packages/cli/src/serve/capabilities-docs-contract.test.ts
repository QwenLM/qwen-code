/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONDITIONAL_SERVE_FEATURES,
  getAdvertisedServeFeatures,
  SERVE_CAPABILITY_REGISTRY,
} from './capabilities.js';

const START = '<!-- conditional-serve-features:start -->';
const END = '<!-- conditional-serve-features:end -->';

describe('conditional serve capability documentation', () => {
  it('advertises typed Goal lifecycle control as an unconditional v1 capability', () => {
    expect(SERVE_CAPABILITY_REGISTRY.session_goal_control).toEqual({
      since: 'v1',
    });
    expect(CONDITIONAL_SERVE_FEATURES.has('session_goal_control')).toBe(false);
    expect(getAdvertisedServeFeatures()).toContain('session_goal_control');
  });

  it('documents exactly the conditional feature registry keys', async () => {
    const protocol = await readFile(
      resolve(process.cwd(), '../../docs/developers/qwen-serve-protocol.md'),
      'utf8',
    );
    const starts = protocol.split(START).length - 1;
    const ends = protocol.split(END).length - 1;
    expect({ starts, ends }).toEqual({ starts: 1, ends: 1 });

    const table = protocol.slice(
      protocol.indexOf(START) + START.length,
      protocol.indexOf(END),
    );
    const documented = [...table.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map(
      ([, tag]) => tag,
    );
    expect(documented).toHaveLength(new Set(documented).size);
    expect([...documented].sort()).toEqual(
      [...CONDITIONAL_SERVE_FEATURES.keys()].sort(),
    );
  });
});
