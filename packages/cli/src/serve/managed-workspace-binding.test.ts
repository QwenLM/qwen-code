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

const rootBinding = fixtures.bindings.find(
  (fixture) => fixture.id === 'root',
)?.binding;
if (!rootBinding) {
  throw new Error('The root fixture must define a valid binding.');
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
    const ids = [...fixtures.paths, ...fixtures.bindings].map(
      (fixture) => fixture.id,
    );

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

  it('rejects a revision passed as a number', () => {
    expect(() =>
      computeManagedContextDigest({
        ...rootBinding,
        contextRevision: 1,
      } as unknown as ManagedContextBinding),
    ).toThrow('Managed context binding is invalid.');
  });

  it('rejects a path that is not a string', () => {
    expect(() =>
      normalizeWorkspaceRelativePath(undefined as unknown as string),
    ).toThrow(InvalidWorkspaceRelativePathError);
  });
});
