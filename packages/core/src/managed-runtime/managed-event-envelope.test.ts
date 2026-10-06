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
  MANAGED_EVENT_ENVELOPE_FORBIDDEN_FIELDS,
  MANAGED_EVENT_ENVELOPE_FORMAT_VERSION,
  isManagedEventEnvelopeRedelivered,
  managedEventEnvelopeFrom,
  managedEventEnvelopeKey,
  parseManagedEventEnvelope,
  type ManagedEventEnvelope,
} from './managed-event-envelope.js';
import {
  MANAGED_SESSION_EVENT_KINDS,
  MANAGED_SESSION_LIMITS,
  ManagedSessionRecordError,
  managedSessionEventsDigest,
  parseManagedSessionEvent,
} from './managed-session-records.js';

interface Checked {
  readonly id: string;
}

interface FixtureSuite {
  readonly contract: string;
  readonly contractVersion: 1;
  readonly formatVersion: 1;
  readonly kinds: unknown;
  readonly forbiddenFields: unknown;
  readonly limits: unknown;
  readonly envelope: unknown;
  readonly envelopeCases: ReadonlyArray<
    Checked & { readonly valid: boolean; readonly envelope: unknown }
  >;
  readonly dedupeCases: ReadonlyArray<
    Checked & {
      readonly same: boolean;
      readonly first: unknown;
      readonly second: unknown;
    }
  >;
  readonly fromEventCases: ReadonlyArray<
    Checked & { readonly event: unknown; readonly envelope: unknown }
  >;
}

interface SchemaDefinition {
  readonly required?: readonly string[];
  readonly properties?: Record<string, unknown>;
  readonly additionalProperties?: unknown;
}

/**
 * Values the schema accepts although the contract refuses them: JSON Schema
 * cannot state UTF-8 byte limits, NFC normalization or well-formed UTF-16.
 */
const BEYOND_SCHEMA = [
  'event-id-lone-surrogate',
  'event-id-not-nfc',
  'event-id-over-512-bytes',
  'session-id-lone-surrogate',
  'session-id-not-nfc',
  'session-id-over-512-bytes',
  'tenant-id-lone-surrogate',
  'tenant-id-not-nfc',
  'tenant-id-over-512-bytes',
  'workspace-id-lone-surrogate',
  'workspace-id-not-nfc',
  'workspace-id-over-512-bytes',
];

const thisDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
  fs.readFileSync(
    path.join(
      thisDirectory,
      'contracts',
      'managed-event-envelope-v1.fixtures.json',
    ),
    'utf8',
  ),
) as FixtureSuite;
const schema = JSON.parse(
  fs.readFileSync(
    path.join(
      thisDirectory,
      'contracts',
      'managed-event-envelope-v1.schema.json',
    ),
    'utf8',
  ),
) as { readonly $id: string; readonly $defs: Record<string, SchemaDefinition> };
const ajv = new Ajv2020({ strict: true });
const validateSuite = ajv.compile(schema);

function schemaAccepts(value: unknown): boolean {
  const validate = ajv.getSchema(`${schema.$id}#/$defs/envelope`);
  if (!validate) {
    throw new Error('The schema has no envelope definition.');
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

describe('Managed event envelope contract', () => {
  it('validates the shared fixtures against the shared schema', () => {
    expect(validateSuite(fixtures)).toBe(true);
    expect(validateSuite.errors).toBeNull();
    expect(parseManagedEventEnvelope(fixtures.envelope)).toStrictEqual(
      fixtures.envelope,
    );
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

  it('pins the contract pin values to the committed record vocabulary', () => {
    expect(fixtures.contract).toBe('managed-event-envelope/1');
    expect(fixtures.contractVersion).toBe(1);
    expect(fixtures.formatVersion).toBe(MANAGED_EVENT_ENVELOPE_FORMAT_VERSION);
    expect(fixtures.kinds).toStrictEqual([...MANAGED_SESSION_EVENT_KINDS]);
    expect(fixtures.forbiddenFields).toStrictEqual([
      ...MANAGED_EVENT_ENVELOPE_FORBIDDEN_FIELDS,
    ]);
    expect(fixtures.limits).toStrictEqual({
      maxIdBytes: MANAGED_SESSION_LIMITS.maxIdBytes,
      maxTimeMs: MANAGED_SESSION_LIMITS.maxTimeMs,
    });
  });

  it('uses each case id once in each list', () => {
    for (const list of [
      fixtures.envelopeCases,
      fixtures.dedupeCases,
      fixtures.fromEventCases,
    ]) {
      const ids = list.map((fixture) => fixture.id);

      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('commits one valid envelope for every event kind of the record', () => {
    const validKinds = new Set(
      fixtures.envelopeCases
        .filter((fixture) => fixture.valid)
        .map(
          (fixture) =>
            (fixture.envelope as ManagedEventEnvelope).kind as string,
        ),
    );

    expect(validKinds).toEqual(new Set(MANAGED_SESSION_EVENT_KINDS));
  });

  it.each(fixtures.envelopeCases)('parses the $id envelope', (fixture) => {
    if (fixture.valid) {
      const parsed = parseManagedEventEnvelope(fixture.envelope);

      expect(parsed).toStrictEqual(fixture.envelope);
      expect(isDeepFrozen(parsed)).toBe(true);
    } else {
      expect(
        throwsContractError(() => parseManagedEventEnvelope(fixture.envelope)),
      ).toBe(true);
    }
  });

  it('names each forbidden field when refusing it', () => {
    for (const field of MANAGED_EVENT_ENVELOPE_FORBIDDEN_FIELDS) {
      const leak = { ...(fixtures.envelope as object), [field]: 'leaked' };

      expect(() => parseManagedEventEnvelope(leak)).toThrow(
        new RegExp(`forbidden field "${field}"`),
      );
      expect(throwsContractError(() => parseManagedEventEnvelope(leak))).toBe(
        true,
      );
    }
  });

  it('pins a fixture case for every forbidden field', () => {
    const uncovered = MANAGED_EVENT_ENVELOPE_FORBIDDEN_FIELDS.filter(
      (field) =>
        !fixtures.envelopeCases.some(
          (fixture) =>
            typeof fixture.envelope === 'object' &&
            fixture.envelope !== null &&
            Object.hasOwn(fixture.envelope as Record<string, unknown>, field) &&
            !fixture.valid,
        ),
    );

    expect(uncovered).toEqual([]);
  });

  it.each(fixtures.dedupeCases)(
    'compares the $id redelivery by exact key',
    ({ first, second, same }) => {
      expect(isManagedEventEnvelopeRedelivered(first, second)).toBe(same);
      expect(isManagedEventEnvelopeRedelivered(second, first)).toBe(same);
    },
  );

  // Written from the fixture literals, never recomputed from the parsed
  // envelope — a recomputed expectation is self-referential exactly the way
  // an unpinned key would be.
  it('derives the idempotence key from the parsed envelope', () => {
    const parsed = parseManagedEventEnvelope(fixtures.envelope);

    expect(managedEventEnvelopeKey(parsed)).toStrictEqual({
      tenantId: 'tenant-1',
      sessionId: 'session-1',
      sequence: 42,
    });
  });

  it.each(fixtures.fromEventCases)(
    'derives the $id envelope from the committed row',
    (fixture) => {
      const event = parseManagedSessionEvent(fixture.event);
      const derived = managedEventEnvelopeFrom(event);

      expect(derived).toStrictEqual(fixture.envelope);
      expect(derived.payloadRef.digest).toBe(
        managedSessionEventsDigest([event]),
      );
      expect(isDeepFrozen(derived)).toBe(true);
    },
  );

  it('agrees with the schema except where the schema cannot state a rule', () => {
    // A case the module accepts and the schema refuses would put the
    // schema in the wrong.
    const acceptedButSchemaInvalid: string[] = [];
    const disagreements = fixtures.envelopeCases
      .filter((fixture) => {
        const schemaValid = schemaAccepts(fixture.envelope);
        if (fixture.valid && !schemaValid) {
          acceptedButSchemaInvalid.push(fixture.id);
        }
        return schemaValid !== fixture.valid;
      })
      .map((fixture) => fixture.id)
      .sort();

    expect(acceptedButSchemaInvalid).toEqual([]);
    expect(disagreements).toEqual(BEYOND_SCHEMA);
  });

  it('refuses objects that are not plain JSON objects', () => {
    const inherited = Object.assign(
      Object.create({ inherited: true }) as object,
      fixtures.envelope,
    );
    const callable = Object.assign(() => undefined, fixtures.envelope);

    expect(
      throwsContractError(() => parseManagedEventEnvelope(inherited)),
    ).toBe(true);
    expect(throwsContractError(() => parseManagedEventEnvelope(callable))).toBe(
      true,
    );
    expect(() => parseManagedEventEnvelope(inherited)).toThrow(
      /^envelope must be a plain JSON object\.$/,
    );
    expect(() => parseManagedEventEnvelope(callable)).toThrow(
      /^envelope must be a plain JSON object\.$/,
    );
  });

  it('declares the contract without enabling any consumer', () => {
    // The house enablement pattern gates on a registry (e.g. the enabled
    // domain list); this contract adds no registry entry, so its non-
    // enablement is structural: no production file may import it. The scan
    // walks every workspace package's src, not just this package's — the
    // wildcard exports of @qwen-code/qwen-code-core make this module
    // deep-importable from any workspace package, so a narrower walk could
    // never see the consumer it exists to bar. Re-exports and dynamic
    // specifiers stay out of reach by design.
    const repoRoot = path.resolve(thisDirectory, '..', '..', '..', '..');
    const { workspaces = [] } = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
    ) as { readonly workspaces?: readonly string[] };
    const sourceRoots = new Set<string>();
    for (const workspace of workspaces) {
      if (workspace.startsWith('!')) {
        continue;
      }
      if (workspace.endsWith('/*')) {
        const parent = path.join(repoRoot, workspace.slice(0, -2));
        if (!fs.existsSync(parent)) {
          continue;
        }
        for (const child of fs.readdirSync(parent, { withFileTypes: true })) {
          if (child.isDirectory()) {
            sourceRoots.add(path.join(parent, child.name, 'src'));
          }
        }
      } else {
        sourceRoots.add(path.join(repoRoot, workspace, 'src'));
      }
    }
    const consumers: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of fs.readdirSync(directory, {
        withFileTypes: true,
      })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules' && entry.name !== 'dist') {
            walk(full);
          }
          continue;
        }
        if (
          !entry.name.endsWith('.ts') ||
          entry.name.endsWith('.test.ts') ||
          entry.name === 'managed-event-envelope.ts'
        ) {
          continue;
        }
        if (fs.readFileSync(full, 'utf8').includes('managed-event-envelope')) {
          consumers.push(path.relative(repoRoot, full));
        }
      }
    };
    for (const sourceRoot of sourceRoots) {
      if (fs.existsSync(sourceRoot)) {
        walk(sourceRoot);
      }
    }

    expect(consumers).toEqual([]);
  });
});
