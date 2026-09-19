/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

describe('bundled Landlock helpers', () => {
  it.each([
    ['x64', 62],
    ['arm64', 183],
  ])('ships an executable Linux ELF for %s', (arch, machine) => {
    const binary = path.join(
      root,
      'packages/core/vendor/landlock-run',
      `${arch}-linux`,
      'qwen-landlock-run',
    );
    const header = readFileSync(binary).subarray(0, 20);
    expect([...header.subarray(0, 4)]).toEqual([0x7f, 0x45, 0x4c, 0x46]);
    expect(header[4]).toBe(2);
    expect(header[5]).toBe(1);
    expect(header.readUInt16LE(18)).toBe(machine);
    expect(statSync(binary).mode & 0o111).not.toBe(0);
  });
});
