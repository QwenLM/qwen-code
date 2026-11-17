/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  parseManagedToolStage,
  isManagedToolStageSuccessor,
} from './managed-tool-stage-record.js';

const fixtures = JSON.parse(
  readFileSync(
    new URL('./contracts/managed-tool-stage-v1.fixtures.json', import.meta.url),
    'utf8',
  ),
) as {
  valid: Array<{ name: string; record: unknown }>;
  invalid: Array<{ name: string; record: unknown }>;
  successors: Array<{
    name: string;
    previous: unknown;
    next: unknown;
    valid: boolean;
  }>;
};
describe('shared Managed tool stage fixtures', () => {
  it.each(fixtures.valid)('accepts $name', (fixture) => {
    expect(() => parseManagedToolStage(fixture.record)).not.toThrow();
  });
  it.each(fixtures.invalid)('rejects $name', (fixture) => {
    expect(() => parseManagedToolStage(fixture.record)).toThrow();
  });
  it.each(fixtures.successors)('checks successor $name', (fixture) => {
    expect(isManagedToolStageSuccessor(fixture.previous, fixture.next)).toBe(
      fixture.valid,
    );
  });
});
