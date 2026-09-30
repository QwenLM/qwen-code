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
  CONTEXT_BINDING_DOMAIN_TAG,
  InvalidWorkspaceRelativePathError,
  computeManagedContextDigest,
  encodeManagedContextBinding,
  normalizeWorkspaceRelativePath,
  type ManagedContextBinding,
} from './managed-workspace-binding.js';

interface PathCase {
  readonly id: string;
  readonly input: string;
  readonly expected:
    | { readonly cwdRelative: string }
    | { readonly error: 'invalid_cwd' };
}

interface BindingCase {
  readonly id: string;
  readonly binding: ManagedContextBinding;
  readonly expected:
    | { readonly encodedHex: string; readonly contextDigest: string }
    | { readonly error: 'invalid_binding' };
}

/** Inclusive code point ranges, ascending and disjoint. */
type CodePointRanges = ReadonlyArray<readonly [number, number]>;

type ProbeCase = {
  readonly id: string;
  /** `{c}` marks where each probed code point goes. */
  readonly template: string;
  readonly accepted: CodePointRanges;
} & (
  | { readonly kind: 'path' }
  | { readonly kind: 'binding'; readonly field: keyof ManagedContextBinding }
);

interface FixtureSuite {
  readonly contractVersion: 1;
  readonly digest: {
    readonly algorithm: string;
    readonly prefix: string;
    readonly domainTag: string;
    readonly fieldOrder: readonly string[];
  };
  readonly paths: readonly PathCase[];
  readonly bindings: readonly BindingCase[];
  readonly probes: {
    readonly codePoints: CodePointRanges;
    readonly binding: ManagedContextBinding;
    readonly cases: readonly ProbeCase[];
  };
}

const contractDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'contracts',
);
const fixtures = JSON.parse(
  fs.readFileSync(
    path.join(contractDirectory, 'managed-workspace-binding-v1.fixtures.json'),
    'utf8',
  ),
) as FixtureSuite;
const schema = JSON.parse(
  fs.readFileSync(
    path.join(contractDirectory, 'managed-workspace-binding-v1.schema.json'),
    'utf8',
  ),
) as Record<string, unknown>;

const rootCase = fixtures.bindings.find((fixture) => fixture.id === 'root');
if (!rootCase || !('contextDigest' in rootCase.expected)) {
  throw new Error('The root fixture must define a valid binding.');
}
const rootBinding = rootCase.binding;
const rootDigest = rootCase.expected.contextDigest;
const probedCodePoints = expandRanges(fixtures.probes.codePoints);

function expandRanges(ranges: CodePointRanges): number[] {
  const codePoints: number[] = [];
  for (const [low, high] of ranges) {
    if (low > high || low <= (codePoints.at(-1) ?? -1)) {
      throw new Error('Probe ranges must be ascending and disjoint.');
    }
    for (let codePoint = low; codePoint <= high; codePoint++) {
      codePoints.push(codePoint);
    }
  }
  return codePoints;
}

function probeOutcome(
  probe: ProbeCase,
  value: string,
): 'accepted' | 'rejected' | 'changed' {
  try {
    if (probe.kind === 'path') {
      // Probe templates keep every accepted value in normal form.
      return normalizeWorkspaceRelativePath(value) === value
        ? 'accepted'
        : 'changed';
    }
    computeManagedContextDigest({
      ...fixtures.probes.binding,
      [probe.field]: value,
    });
    return 'accepted';
  } catch (error) {
    const rejection =
      probe.kind === 'path'
        ? error instanceof InvalidWorkspaceRelativePathError
        : error instanceof Error &&
          error.message === 'Managed context binding is invalid.';
    if (rejection) {
      return 'rejected';
    }
    throw error;
  }
}

describe('Managed Workspace binding contract', () => {
  it('validates the shared fixtures against the shared schema', () => {
    const validate = new Ajv2020({ strict: true }).compile(schema);

    expect(validate(fixtures)).toBe(true);
    expect(validate.errors).toBeNull();
  });

  it('pins the digest construction', () => {
    expect(fixtures.digest).toEqual({
      algorithm: 'sha256',
      prefix: 'sha256:',
      domainTag: CONTEXT_BINDING_DOMAIN_TAG,
      fieldOrder: [
        'tenantId',
        'workspaceId',
        'workspaceGeneration',
        'storageId',
        'cwdRelative',
        'contextConfigRef',
        'contextRevision',
      ],
    });
  });

  it('uses each case id once', () => {
    const ids = [
      ...fixtures.paths,
      ...fixtures.bindings,
      ...fixtures.probes.cases,
    ].map((fixture) => fixture.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(fixtures.paths)('normalizes the $id path case', (fixture) => {
    if ('cwdRelative' in fixture.expected) {
      expect(normalizeWorkspaceRelativePath(fixture.input)).toBe(
        fixture.expected.cwdRelative,
      );
    } else {
      expect(() => normalizeWorkspaceRelativePath(fixture.input)).toThrow(
        InvalidWorkspaceRelativePathError,
      );
    }
  });

  it.each(fixtures.bindings)('encodes the $id binding case', (fixture) => {
    if ('contextDigest' in fixture.expected) {
      expect(encodeManagedContextBinding(fixture.binding).toString('hex')).toBe(
        fixture.expected.encodedHex,
      );
      expect(computeManagedContextDigest(fixture.binding)).toBe(
        fixture.expected.contextDigest,
      );
    } else {
      expect(() => computeManagedContextDigest(fixture.binding)).toThrow(
        'Managed context binding is invalid.',
      );
    }
  });

  it.each(fixtures.probes.cases)(
    'accepts exactly the listed code points in the $id probe',
    (probe) => {
      const accepted = new Set(expandRanges(probe.accepted));
      const probed = new Set(probedCodePoints);
      const mismatches: string[] = [];
      for (const codePoint of probedCodePoints) {
        const value = probe.template
          .split('{c}')
          .join(String.fromCodePoint(codePoint));
        const outcome = probeOutcome(probe, value);
        if (outcome !== (accepted.has(codePoint) ? 'accepted' : 'rejected')) {
          mismatches.push(`U+${codePoint.toString(16)} ${outcome}`);
        }
      }

      expect(mismatches).toEqual([]);
      expect(
        [...accepted].filter((codePoint) => !probed.has(codePoint)),
      ).toEqual([]);
    },
  );

  it.each([
    'tenantId',
    'workspaceId',
    'workspaceGeneration',
    'storageId',
    'cwdRelative',
    'contextConfigRef',
    'contextRevision',
  ] as const)('reads %s once, so the checked value is encoded', (field) => {
    let reads = 0;
    const binding = { ...rootBinding };
    Object.defineProperty(binding, field, {
      enumerable: true,
      get: () => {
        reads++;
        return reads === 1 ? rootBinding[field] : '/etc/../x';
      },
    });

    expect(computeManagedContextDigest(binding)).toBe(rootDigest);
    expect(reads).toBe(1);
  });

  it('reports invalid_cwd without echoing the input', () => {
    let error: unknown;
    try {
      normalizeWorkspaceRelativePath('secret/../x');
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(InvalidWorkspaceRelativePathError);
    expect((error as InvalidWorkspaceRelativePathError).code).toBe(
      'invalid_cwd',
    );
    expect((error as Error).name).toBe('InvalidWorkspaceRelativePathError');
    expect((error as Error).message).not.toContain('secret');
  });

  it.each([
    'tenantId',
    'workspaceId',
    'workspaceGeneration',
    'storageId',
    'cwdRelative',
    'contextConfigRef',
    'contextRevision',
  ] as const)('rejects a missing %s', (field) => {
    const binding = {
      ...rootBinding,
      [field]: undefined,
    } as unknown as ManagedContextBinding;

    expect(() => computeManagedContextDigest(binding)).toThrow(
      'Managed context binding is invalid.',
    );
  });

  it.each([
    'tenantId',
    'workspaceId',
    'workspaceGeneration',
    'storageId',
    'cwdRelative',
    'contextConfigRef',
    'contextRevision',
  ] as const)('rejects a %s that is not a string primitive', (field) => {
    // An array, a String object and a number all coerce to valid text, so
    // only a type check keeps them out of the encoded bytes.
    for (const value of [
      [rootBinding[field]],
      Object(rootBinding[field]),
      Number(rootBinding[field]) || 7,
    ]) {
      expect(() =>
        computeManagedContextDigest({
          ...rootBinding,
          [field]: value,
        } as unknown as ManagedContextBinding),
      ).toThrow('Managed context binding is invalid.');
    }
  });

  it('rejects a binding that is not an object', () => {
    // A function that carries every field is not a binding object either.
    const callable = Object.assign(() => undefined, rootBinding);
    for (const value of [undefined, null, 'tenant-a', 7, callable]) {
      expect(() =>
        computeManagedContextDigest(value as unknown as ManagedContextBinding),
      ).toThrow('Managed context binding is invalid.');
    }
  });

  it('rejects a path that is not a string primitive', () => {
    for (const value of [undefined, null, ['a'], Object('a'), 7]) {
      expect(() =>
        normalizeWorkspaceRelativePath(value as unknown as string),
      ).toThrow(InvalidWorkspaceRelativePathError);
    }
  });
});
