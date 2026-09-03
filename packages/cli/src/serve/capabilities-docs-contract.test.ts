/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONDITIONAL_SERVE_FEATURES,
  SERVE_CAPABILITY_REGISTRY,
  SERVE_PROTOCOL_VERSION,
} from './capabilities.js';

const START = '<!-- conditional-serve-features:start -->';
const END = '<!-- conditional-serve-features:end -->';

describe('conditional serve capability documentation', () => {
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

  it('keeps the daemon index capability counts in sync', async () => {
    const index = await readFile(
      resolve(process.cwd(), '../../docs/developers/daemon/00-index.md'),
      'utf8',
    );
    const match = index.match(
      new RegExp(
        `SERVE_PROTOCOL_VERSION = '${SERVE_PROTOCOL_VERSION}'\`; (\\d+) registered tags; (\\d+) conditional tags`,
      ),
    );

    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBe(
      Object.keys(SERVE_CAPABILITY_REGISTRY).length,
    );
    expect(Number(match?.[2])).toBe(CONDITIONAL_SERVE_FEATURES.size);
  });
});
