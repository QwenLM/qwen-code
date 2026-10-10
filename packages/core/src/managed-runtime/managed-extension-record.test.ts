/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Ajv exposes draft 2020-12 through this documented entry point.
// eslint-disable-next-line import/no-internal-modules
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  MANAGED_EXTENSION_DELIVERY_TARGETS,
  MANAGED_EXTENSION_MONITOR_STOP_REASONS,
  MANAGED_EXTENSION_REASONS,
  MANAGED_EXTENSION_RECORD_KINDS,
  MANAGED_EXTENSION_RECORD_LIMITS,
  MANAGED_EXTENSION_STATE_LINES,
  isDefinitionPinConsistent,
  isExtensionRunSuccessor,
  isExtensionTransitionAllowed,
  isMonitorRunSuccessor,
  isOperationGrantSuccessor,
  parseDefinitionPin,
  parseExtensionRun,
  parseMonitorRun,
  parseOperationGrant,
  type ExtensionStateLine,
} from './managed-extension-record.js';
import {
  MANAGED_SESSION_DOMAINS,
  ManagedSessionRecordError,
  assertManagedSessionDomainEnabled,
} from './managed-session-records.js';

interface Checked {
  readonly id: string;
  readonly valid: boolean;
}

type Pair = Checked & { readonly previous: unknown; readonly next: unknown };

interface FixtureSuite {
  readonly contractVersion: 1;
  readonly domains: unknown;
  readonly limits: unknown;
  readonly kinds: unknown;
  readonly stateLines: Record<
    ExtensionStateLine,
    {
      readonly states: readonly string[];
      readonly transitions: Record<string, readonly string[]>;
    }
  >;
  readonly deliveryTargets: unknown;
  readonly reasons: unknown;
  readonly monitorStopReasons: unknown;
  readonly grant: Record<string, unknown>;
  readonly definitionPin: unknown;
  readonly run: unknown;
  readonly monitorRun: Record<string, unknown>;
  readonly grantCases: ReadonlyArray<Checked & { readonly grant: unknown }>;
  readonly grantSuccessorCases: readonly Pair[];
  readonly pinCases: ReadonlyArray<Checked & { readonly pin: unknown }>;
  readonly pinConsistencyCases: ReadonlyArray<
    Checked & { readonly first: unknown; readonly second: unknown }
  >;
  readonly runCases: ReadonlyArray<Checked & { readonly run: unknown }>;
  readonly runSuccessorCases: readonly Pair[];
  readonly monitorRunCases: ReadonlyArray<
    Checked & { readonly monitorRun: unknown }
  >;
  readonly monitorRunSuccessorCases: readonly Pair[];
}

interface SchemaDefinition {
  readonly required?: readonly string[];
  readonly properties?: Record<string, unknown>;
  readonly additionalProperties?: unknown;
}

/**
 * Fixture cases that the schema accepts although the contract refuses them.
 * JSON Schema cannot state UTF-8 byte limits, NFC, well-formed UTF-16, the
 * 2^63-1 bound readably, a kind derived from another field, or a bound that
 * depends on another field.
 */
const BEYOND_SCHEMA = {
  grant: [
    'generation-past-int64',
    'operation-id-high-surrogate-followed-by-a',
    'operation-id-lone-low-surrogate',
    'operation-id-lone-surrogate',
    'operation-id-not-nfc',
    'operation-id-over-512-bytes',
    'operation-id-two-byte-over-512-bytes',
    'owner-id-lone-surrogate',
    'owner-id-not-nfc',
    'owner-id-over-512-bytes',
    'owner-id-two-byte-over-512-bytes',
    'scope-record-of-another-domain',
    'tenant-id-lone-surrogate',
    'tenant-id-not-nfc',
    'tenant-id-over-512-bytes',
    'tenant-id-two-byte-over-512-bytes',
  ],
  pin: [
    'definition-id-lone-surrogate',
    'definition-id-not-nfc',
    'definition-id-over-512-bytes',
    'definition-id-two-byte-over-512-bytes',
  ],
  run: [
    'delivery-id-lone-surrogate',
    'delivery-id-not-nfc',
    'delivery-id-over-512-bytes',
    'delivery-id-two-byte-over-512-bytes',
    'dispatch-id-lone-surrogate',
    'dispatch-id-not-nfc',
    'dispatch-id-over-512-bytes',
    'dispatch-id-two-byte-over-512-bytes',
    'effect-id-lone-surrogate',
    'effect-id-not-nfc',
    'effect-id-over-512-bytes',
    'effect-id-two-byte-over-512-bytes',
    'execution-call-id-lone-surrogate',
    'execution-call-id-not-nfc',
    'execution-call-id-over-512-bytes',
    'execution-call-id-two-byte-over-512-bytes',
    'runtime-binding-id-lone-surrogate',
    'runtime-binding-id-not-nfc',
    'runtime-binding-id-over-512-bytes',
    'runtime-binding-id-two-byte-over-512-bytes',
  ],
  monitorRun: [
    'max-events-short',
    'monitor-id-lone-surrogate',
    'monitor-id-not-nfc',
    'monitor-id-over-512-bytes',
    'monitor-id-two-byte-over-512-bytes',
    'notified-past-observations',
    'observations-past-max-events',
    'owner-scope-id-lone-surrogate',
    'owner-scope-id-not-nfc',
    'owner-scope-id-over-512-bytes',
    'owner-scope-id-two-byte-over-512-bytes',
  ],
};

const contractDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'contracts',
);
const fixtures = JSON.parse(
  fs.readFileSync(
    path.join(contractDirectory, 'managed-extension-record-v1.fixtures.json'),
    'utf8',
  ),
) as FixtureSuite;
const schema = JSON.parse(
  fs.readFileSync(
    path.join(contractDirectory, 'managed-extension-record-v1.schema.json'),
    'utf8',
  ),
) as { readonly $id: string; readonly $defs: Record<string, SchemaDefinition> };
const ajv = new Ajv2020({ strict: true });
const validateSuite = ajv.compile(schema);

function schemaAccepts(definition: string, value: unknown): boolean {
  const validate = ajv.getSchema(`${schema.$id}#/$defs/${definition}`);
  if (!validate) {
    throw new Error(`The schema has no ${definition} definition.`);
  }
  return validate(value) as boolean;
}

function throwsContractError(parse: () => unknown): boolean {
  try {
    parse();
    return false;
  } catch (error) {
    if (error instanceof ManagedSessionRecordError) return true;
    throw error;
  }
}

function isDeepFrozen(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return true;
  return (
    Object.isFrozen(value) &&
    Object.values(value).every((child) => isDeepFrozen(child))
  );
}

function expectParsed(
  parse: (value: unknown) => unknown,
  fixture: Checked,
  value: unknown,
): void {
  if (fixture.valid) {
    const parsed = parse(value);

    expect(parsed).toStrictEqual(value);
    expect(isDeepFrozen(parsed)).toBe(true);
  } else {
    expect(throwsContractError(() => parse(value))).toBe(true);
  }
}

describe('Managed extension record contract', () => {
  it('validates the shared fixtures against the shared schema', () => {
    expect(validateSuite(fixtures)).toBe(true);
    expect(validateSuite.errors).toBeNull();
  });

  it('closes every record definition of the schema', () => {
    const open = Object.entries(schema.$defs)
      .filter(
        ([, definition]) =>
          definition.properties !== undefined &&
          (definition.additionalProperties !== false ||
            Object.keys(definition.properties).some(
              (key) => !definition.required?.includes(key),
            )),
      )
      .map(([name]) => name);

    expect(open).toEqual([]);
  });

  it('pins the domains, limits, kinds, state lines and reasons', () => {
    expect(fixtures.contractVersion).toBe(1);
    expect(fixtures.domains).toStrictEqual([...MANAGED_SESSION_DOMAINS]);
    expect(fixtures.limits).toStrictEqual({
      ...MANAGED_EXTENSION_RECORD_LIMITS,
    });
    expect(fixtures.kinds).toStrictEqual({ ...MANAGED_EXTENSION_RECORD_KINDS });
    expect(fixtures.stateLines).toStrictEqual(
      JSON.parse(JSON.stringify(MANAGED_EXTENSION_STATE_LINES)),
    );
    expect(fixtures.deliveryTargets).toStrictEqual(
      JSON.parse(JSON.stringify(MANAGED_EXTENSION_DELIVERY_TARGETS)),
    );
    expect(fixtures.reasons).toStrictEqual(
      JSON.parse(JSON.stringify(MANAGED_EXTENSION_REASONS)),
    );
    expect(fixtures.monitorStopReasons).toStrictEqual(
      JSON.parse(JSON.stringify(MANAGED_EXTENSION_MONITOR_STOP_REASONS)),
    );
  });

  it('registers monitor_run without enabling it for submission', () => {
    expect(MANAGED_SESSION_DOMAINS).toContain('monitor_run');
    expect(
      throwsContractError(() =>
        assertManagedSessionDomainEnabled('monitor_run'),
      ),
    ).toBe(true);
  });

  it('allows exactly the listed step between every pair of states', () => {
    const wrong: string[] = [];
    for (const [stateLine, { states, transitions }] of Object.entries(
      fixtures.stateLines,
    )) {
      for (const from of states) {
        for (const to of states) {
          if (
            isExtensionTransitionAllowed(
              stateLine as ExtensionStateLine,
              from,
              to,
            ) !== transitions[from].includes(to)
          ) {
            wrong.push(`${stateLine}: ${from} -> ${to}`);
          }
        }
      }
    }

    expect(wrong).toEqual([]);
    expect(isExtensionTransitionAllowed('run', 'reserved', 'constructor')).toBe(
      false,
    );
    expect(isExtensionTransitionAllowed('run', 'toString', 'admitted')).toBe(
      false,
    );
    expect(
      isExtensionTransitionAllowed(
        'toString' as ExtensionStateLine,
        'reserved',
        'admitted',
      ),
    ).toBe(false);
  });

  it('uses each case id once in each list', () => {
    for (const list of [
      fixtures.grantCases,
      fixtures.grantSuccessorCases,
      fixtures.pinCases,
      fixtures.pinConsistencyCases,
      fixtures.runCases,
      fixtures.runSuccessorCases,
      fixtures.monitorRunCases,
      fixtures.monitorRunSuccessorCases,
    ]) {
      const ids = list.map((fixture) => fixture.id);

      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it.each(fixtures.grantCases)('parses the $id grant', (fixture) => {
    expectParsed(parseOperationGrant, fixture, fixture.grant);
  });

  it.each(fixtures.grantSuccessorCases)(
    'checks the $id grant successor',
    ({ previous, next, valid }) => {
      expect(isOperationGrantSuccessor(previous, next)).toBe(valid);
    },
  );

  it.each(fixtures.pinCases)('parses the $id definition pin', (fixture) => {
    expectParsed((value) => parseDefinitionPin(value), fixture, fixture.pin);
  });

  it.each(fixtures.pinConsistencyCases)(
    'checks the $id pin pair',
    ({ first, second, valid }) => {
      expect(isDefinitionPinConsistent(first, second)).toBe(valid);
      expect(isDefinitionPinConsistent(second, first)).toBe(valid);
    },
  );

  it.each(fixtures.runCases)('parses the $id run', (fixture) => {
    expectParsed((value) => parseExtensionRun(value), fixture, fixture.run);
  });

  it.each(fixtures.runSuccessorCases)(
    'checks the $id run successor',
    ({ previous, next, valid }) => {
      expect(isExtensionRunSuccessor(previous, next)).toBe(valid);
    },
  );

  it.each(fixtures.monitorRunCases)('parses the $id monitor', (fixture) => {
    expectParsed(parseMonitorRun, fixture, fixture.monitorRun);
  });

  it.each(fixtures.monitorRunSuccessorCases)(
    'checks the $id monitor successor',
    ({ previous, next, valid }) => {
      expect(isMonitorRunSuccessor(previous, next)).toBe(valid);
    },
  );

  it('agrees with the schema except where the schema cannot state a rule', () => {
    const lists = {
      grant: fixtures.grantCases.map((each) => ({
        ...each,
        value: each.grant,
        definition: 'operationGrant',
      })),
      pin: fixtures.pinCases.map((each) => ({
        ...each,
        value: each.pin,
        definition: 'definitionPin',
      })),
      run: fixtures.runCases.map((each) => ({
        ...each,
        value: each.run,
        definition: 'extensionRun',
      })),
      monitorRun: fixtures.monitorRunCases.map((each) => ({
        ...each,
        value: each.monitorRun,
        definition: 'monitorRun',
      })),
    };
    // A case the module accepts and the schema refuses would put the
    // schema in the wrong.
    const acceptedButSchemaInvalid: string[] = [];
    const disagreements = Object.fromEntries(
      Object.entries(lists).map(([name, cases]) => [
        name,
        cases
          .filter((fixture) => {
            const schemaValid = schemaAccepts(
              fixture.definition,
              fixture.value,
            );
            if (fixture.valid && !schemaValid) {
              acceptedButSchemaInvalid.push(fixture.id);
            }
            return schemaValid !== fixture.valid;
          })
          .map((fixture) => fixture.id)
          .sort(),
      ]),
    );

    expect(acceptedButSchemaInvalid).toEqual([]);
    expect(disagreements).toEqual(BEYOND_SCHEMA);
  });

  it('reads each monitor field once, so the checked value is kept', () => {
    for (const field of Object.keys(fixtures.monitorRun)) {
      let reads = 0;
      const copy = { ...fixtures.monitorRun };
      Object.defineProperty(copy, field, {
        enumerable: true,
        get: () => {
          reads++;
          return reads === 1 ? fixtures.monitorRun[field] : 'changed';
        },
      });

      expect(parseMonitorRun(copy)).toStrictEqual(fixtures.monitorRun);
      expect(reads).toBe(1);
    }
  });

  it('refuses a sparse phase list, which JSON cannot carry', () => {
    const withPhases = (phases: unknown[]) => ({
      ...fixtures.grant,
      resourceScope: {
        ...(fixtures.grant['resourceScope'] as object),
        phases,
      },
    });

    expect(
      throwsContractError(() => parseOperationGrant(withPhases(new Array(1)))),
    ).toBe(true);
    expect(
      throwsContractError(() =>
        // eslint-disable-next-line no-sparse-arrays
        parseOperationGrant(withPhases(['send_segment', , 'query_receipt'])),
      ),
    ).toBe(true);
  });

  it('refuses objects that are not plain JSON objects', () => {
    const inherited = Object.assign(
      Object.create({ inherited: true }) as object,
      fixtures.grant,
    );
    const callable = Object.assign(() => undefined, fixtures.grant);

    expect(throwsContractError(() => parseOperationGrant(inherited))).toBe(
      true,
    );
    expect(throwsContractError(() => parseOperationGrant(callable))).toBe(true);
  });
});
