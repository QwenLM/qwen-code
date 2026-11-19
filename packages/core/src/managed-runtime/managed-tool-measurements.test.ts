import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { managedToolDigest } from '../tools/managed-tool-protocol.js';
import {
  parseManagedToolMeasurementEvidence,
  parseManagedToolMeasurements,
} from './managed-tool-measurements.js';

const fixture = JSON.parse(
  await readFile(
    new URL(
      './contracts/managed-tool-measurements-v1.fixtures.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  cases: Array<{ id: string; valid: boolean; measurements: unknown }>;
  evidence: Record<string, unknown>;
  wire: unknown;
  resultDigest: string;
};

describe('Managed executor measurements shared contract', () => {
  it.each(fixture.cases)('$id (valid=$valid)', ({ valid, measurements }) => {
    if (valid)
      expect(parseManagedToolMeasurements(measurements)).toEqual(measurements);
    else expect(() => parseManagedToolMeasurements(measurements)).toThrow();
  });

  it('uses the same canonical UTF-8 result digest as Java', () => {
    expect(managedToolDigest(fixture.wire)).toBe(fixture.resultDigest);
    expect(
      parseManagedToolMeasurementEvidence(
        Buffer.from(JSON.stringify(fixture.evidence)),
      ),
    ).toEqual(fixture.evidence);
  });

  it('bounds evidence bytes and rejects opaque contents and missing bindings', () => {
    for (const patch of [
      { invocationId: 'wrong' },
      { executionCallId: 'x'.repeat(513) },
      { parameters: 'private' },
      { schemaVersion: 2 },
      { modelProposal: 'guessed' },
    ]) {
      expect(() =>
        parseManagedToolMeasurementEvidence(
          Buffer.from(JSON.stringify({ ...fixture.evidence, ...patch })),
        ),
      ).toThrow();
    }
    expect(() =>
      parseManagedToolMeasurementEvidence(Buffer.alloc(4097, ' ')),
    ).toThrow();
  });
});
