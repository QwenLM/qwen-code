/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  EXCLUDED_DIRECTORY_NAMES,
  EXCLUDED_FILE_PATTERNS,
  OVERSIZED_FILE_LINE_THRESHOLD,
  SOURCE_ROOTS,
  countCorePublicExports,
  countSourceLines,
  findArchitectureDebtGrowth,
  isEligibleProductionPath,
  measureArchitectureDebt,
  validateBaseline,
} from '../check-architecture-debt.js';

const baseline = {
  version: 1,
  policy: {
    lineThreshold: OVERSIZED_FILE_LINE_THRESHOLD,
    sourceRoots: SOURCE_ROOTS,
    excludedDirectoryNames: EXCLUDED_DIRECTORY_NAMES,
    excludedFilePatterns: EXCLUDED_FILE_PATTERNS,
  },
  metrics: {
    oversizedFiles: { 'packages/core/src/large.ts': 1000 },
    genaiImportFiles: ['packages/core/src/known.ts'],
    corePublicExports: 2,
  },
};

function lines(count, suffix = '') {
  return `${Array.from({ length: count }, (_, index) => `line ${index}`).join('\n')}${suffix}`;
}

function measure(
  files,
  coreIndexSource = 'export const one = 1;\nexport const two = 2;',
) {
  return measureArchitectureDebt({ files, coreIndexSource });
}

describe('architecture debt ratchet', () => {
  it('keeps the production and exclusion policy explicit', () => {
    expect(isEligibleProductionPath('packages/core/src/large.ts')).toBe(true);
    expect(isEligibleProductionPath('packages/core/src/large.test.ts')).toBe(
      false,
    );
    expect(
      isEligibleProductionPath('packages/core/src/generated/large.ts'),
    ).toBe(false);
    expect(isEligibleProductionPath('packages/core/src/schemas/large.ts')).toBe(
      false,
    );
    expect(isEligibleProductionPath('packages/core/src/tool-adapter.ts')).toBe(
      false,
    );
  });

  it('fails when an existing oversized file grows or a new one appears', () => {
    const measurement = measure([
      { path: 'packages/core/src/large.ts', content: lines(1001) },
      { path: 'packages/core/src/new-large.ts', content: lines(1000) },
    ]);
    const findings = findArchitectureDebtGrowth({ measurement, baseline });
    expect(findings).toEqual([
      expect.stringContaining('packages/core/src/large.ts'),
      expect.stringContaining('packages/core/src/new-large.ts'),
    ]);
    expect(findings.join('\n')).toMatch(/baseline 1000/);
    expect(findings.join('\n')).toMatch(/threshold 1000/);
  });

  it('fails when a new production @google/genai import appears', () => {
    const measurement = measure([
      {
        path: 'packages/core/src/known.ts',
        content: "import type { Part } from '@google/genai';\n",
      },
      {
        path: 'packages/core/src/new-genai.ts',
        content: "import { GoogleGenAI } from '@google/genai';\n",
      },
    ]);
    const findings = findArchitectureDebtGrowth({ measurement, baseline });
    expect(findings).toEqual([
      expect.stringContaining(
        'new production @google/genai import: packages/core/src/new-genai.ts',
      ),
    ]);
  });

  it('fails when core public export declarations grow', () => {
    const measurement = measure(
      [],
      'export const one = 1;\nexport const two = 2;\nexport const three = 3;',
    );
    const findings = findArchitectureDebtGrowth({ measurement, baseline });
    expect(measurement.corePublicExports).toBe(3);
    expect(findings).toEqual([
      expect.stringContaining('core public export surface grew'),
    ]);
  });

  it('counts source lines without relying on repository source text', () => {
    expect(countSourceLines('one\ntwo\n')).toBe(2);
    expect(countSourceLines('one\ntwo')).toBe(2);
    expect(
      countCorePublicExports('export const one = 1;\n// export const no = 0;'),
    ).toBe(1);
  });

  it('rejects a baseline whose policy no longer describes the checker', () => {
    expect(() =>
      validateBaseline({
        ...baseline,
        policy: { ...baseline.policy, lineThreshold: 999 },
      }),
    ).toThrow(/Invalid architecture debt baseline/);
  });
});
