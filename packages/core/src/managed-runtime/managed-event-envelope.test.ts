/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Ajv exposes draft 2020-12 through this documented entry point.
// eslint-disable-next-line import/no-internal-modules
import { Ajv2020 } from 'ajv/dist/2020.js';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  MANAGED_EVENT_ENVELOPE_FORBIDDEN_FIELDS,
  MANAGED_EVENT_ENVELOPE_FORMAT_VERSION,
  MANAGED_EVENT_ENVELOPE_STREAMS,
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
  readonly streams: unknown;
  readonly forbiddenFields: unknown;
  readonly limits: unknown;
  readonly envelope: unknown;
  readonly envelopeCases: ReadonlyArray<
    Checked & { readonly valid: boolean; readonly envelope: unknown }
  >;
  readonly dedupeCases: ReadonlyArray<
    Checked & {
      readonly same: boolean;
      readonly parseable: readonly [boolean, boolean];
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

const repoRoot = path.resolve(thisDirectory, '..', '..', '..', '..');
const moduleFile = path.join(thisDirectory, 'managed-event-envelope.ts');

const SCANNABLE_FILE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|jsx)$/;
const TEST_ONLY_FILE = /\.test\.(?:ts|tsx|mts|cts|js|mjs|cjs|jsx)$/;
const SOURCE_SUFFIX = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|jsx)$/;

// Static module specifiers of one source file, collected with the
// TypeScript AST — the detection shape of
// scripts/check-tui-dep-direction.mjs — so comments, string literals and
// interpolated templates can neither mask nor fake an import. Import and
// export declarations, dynamic import(), require()-family calls,
// import.meta.resolve(), import-type queries, import-equals and ambient
// module declarations are covered; computed or interpolated specifiers
// have no static name and stay out of reach, as Decision 5 records.
function collectModuleSpecifiers(source: string, fileName: string): string[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const specifiers: string[] = [];
  const MODULE_CALLS = new Set([
    'require',
    'require.resolve',
    'module.require',
    'require.main.require',
    'import.meta.resolve',
  ]);
  const literal = (node: ts.Node): string | undefined =>
    ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      ? node.text
      : undefined;
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined
    ) {
      const specifier = literal(node.moduleSpecifier);
      if (specifier !== undefined) {
        specifiers.push(specifier);
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const specifier = literal(node.moduleReference.expression);
      if (specifier !== undefined) {
        specifiers.push(specifier);
      }
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (
        ts.isLiteralTypeNode(argument) &&
        ts.isStringLiteral(argument.literal)
      ) {
        specifiers.push(argument.literal.text);
      }
    } else if (ts.isModuleDeclaration(node)) {
      const specifier = literal(node.name);
      if (specifier !== undefined) {
        specifiers.push(specifier);
      }
    } else if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const callee =
        expression.kind === ts.SyntaxKind.ImportKeyword
          ? 'import'
          : ts.isIdentifier(expression)
            ? expression.text
            : ts.isPropertyAccessExpression(expression)
              ? `${expression.expression.getText(sourceFile)}.${expression.name.text}`
              : undefined;
      if (
        callee === 'import' ||
        (callee !== undefined && MODULE_CALLS.has(callee))
      ) {
        const first = node.arguments[0];
        if (first !== undefined) {
          const specifier = literal(first);
          if (specifier !== undefined) {
            specifiers.push(specifier);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

// Whether one static specifier resolves to this module: the package deep
// path through the workspace wildcard exports (dist or src form), or a
// relative specifier from the importing file. A bare import of the package
// root names no module — it can only reach a re-export, one of the blind
// spots Decision 5 names.
function namesEnvelopeModule(specifier: string, fromFile: string): boolean {
  const corePackage = '@qwen-code/qwen-code-core/';
  if (specifier.startsWith(corePackage)) {
    const subpath = specifier
      .slice(corePackage.length)
      .replace(/^(?:dist|src)\//, '')
      .replace(SOURCE_SUFFIX, '');
    return subpath === 'managed-runtime/managed-event-envelope';
  }
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const resolved = path
      .resolve(path.dirname(fromFile), specifier)
      .replace(SOURCE_SUFFIX, '');
    return resolved === moduleFile.replace(SOURCE_SUFFIX, '');
  }
  return false;
}

// Production files importing the envelope module anywhere under the given
// roots. node_modules/ and dist/ stay skipped by rule — a built tree's
// dist/ holds this module's own compiled copy, which names it for real —
// symlinks are never followed, and test files are not production
// consumers. Any specifier naming this module must carry its name, so only
// files containing the raw substring pay for the AST parse; the substring
// never accuses, the AST does.
function findEnvelopeConsumers(roots: readonly string[]): string[] {
  const consumers: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'dist') {
          walk(full);
        }
        continue;
      }
      if (!SCANNABLE_FILE.test(entry.name) || TEST_ONLY_FILE.test(entry.name)) {
        continue;
      }
      const content = fs.readFileSync(full, 'utf8');
      if (!content.includes('managed-event-envelope')) {
        continue;
      }
      const specifiers = collectModuleSpecifiers(content, full);
      if (
        specifiers.some((specifier) => namesEnvelopeModule(specifier, full))
      ) {
        consumers.push(path.relative(repoRoot, full));
      }
    }
  };
  for (const root of roots) {
    walk(root);
  }

  return consumers.sort();
}

// Every workspace package's scannable root: its src/ when it has one, the
// package tree itself when it does not (that is what covers
// packages/web-shell/client), plus the repo-root code directories that are
// not workspaces at all but resolve the same deep imports. A workspace
// that disappears lands in missing so the gate fails loudly rather than
// shrinking its scan.
function workspaceSourceRoots(): { roots: string[]; missing: string[] } {
  const { workspaces = [] } = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
  ) as { readonly workspaces?: readonly string[] };
  const excluded = new Set(
    workspaces
      .filter((workspace) => workspace.startsWith('!'))
      .map((workspace) => workspace.slice(1)),
  );
  const missing: string[] = [];
  const packageDirs: string[] = [];
  for (const workspace of workspaces) {
    if (workspace.startsWith('!')) {
      continue;
    }
    if (workspace.endsWith('/*')) {
      const parent = workspace.slice(0, -2);
      if (!fs.existsSync(path.join(repoRoot, parent))) {
        missing.push(parent);
        continue;
      }
      for (const child of fs.readdirSync(path.join(repoRoot, parent), {
        withFileTypes: true,
      })) {
        const relative = `${parent}/${child.name}`;
        if (!child.isDirectory() || excluded.has(relative)) {
          continue;
        }
        // Only real packages count; containers such as packages/channels
        // contribute their member workspaces through their own entries.
        if (fs.existsSync(path.join(repoRoot, relative, 'package.json'))) {
          packageDirs.push(relative);
        }
      }
      continue;
    }
    if (!fs.existsSync(path.join(repoRoot, workspace))) {
      missing.push(workspace);
      continue;
    }
    packageDirs.push(workspace);
  }
  const roots = packageDirs.map((relative) => {
    const absolute = path.join(repoRoot, relative);
    const sourceRoot = path.join(absolute, 'src');
    return fs.existsSync(sourceRoot) ? sourceRoot : absolute;
  });
  for (const extra of ['scripts', 'integration-tests']) {
    const absolute = path.join(repoRoot, extra);
    if (fs.existsSync(absolute)) {
      roots.push(absolute);
    } else {
      missing.push(extra);
    }
  }
  return { roots, missing };
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
    expect(
      (schema.$defs['envelope'].properties?.['kind'] as { enum: unknown }).enum,
    ).toStrictEqual([...MANAGED_SESSION_EVENT_KINDS]);
    expect(fixtures.streams).toStrictEqual([...MANAGED_EVENT_ENVELOPE_STREAMS]);
    expect(
      (schema.$defs['envelope'].properties?.['stream'] as { enum: unknown })
        .enum,
    ).toStrictEqual([...MANAGED_EVENT_ENVELOPE_STREAMS]);
    expect((schema.$defs['stableId'] as { maxLength: number }).maxLength).toBe(
      MANAGED_SESSION_LIMITS.maxIdBytes,
    );
    expect(
      (
        schema.$defs['envelope'].properties?.['occurredAt'] as {
          maximum: number;
        }
      ).maximum,
    ).toBe(MANAGED_SESSION_LIMITS.maxTimeMs);
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

  // The *-missing family is the corpus's per-field statement of
  // requiredness: every member varies the canonical envelope by exactly one
  // omitted key, so a sweep that skips a row cannot go unnoticed.
  it('omits exactly one key in each *-missing envelope case', () => {
    const canonicalKeyCount = Object.keys(fixtures.envelope as object).length;
    const offenders = fixtures.envelopeCases
      .filter((fixture) => fixture.id.endsWith('-missing'))
      .filter(
        (fixture) =>
          typeof fixture.envelope !== 'object' ||
          fixture.envelope === null ||
          canonicalKeyCount - Object.keys(fixture.envelope as object).length !==
            1,
      )
      .map((fixture) => fixture.id);

    expect(offenders).toEqual([]);
  });

  it.each(fixtures.dedupeCases)(
    'compares the $id redelivery by exact key',
    ({ first, second, same, parseable }) => {
      // A `same: false` verdict must come from the declared reason: an
      // operand that silently degrades from parseable against its row's
      // declaration would keep the comparison green while the row stops
      // comparing two envelopes at all.
      expect([
        !throwsContractError(() => parseManagedEventEnvelope(first)),
        !throwsContractError(() => parseManagedEventEnvelope(second)),
      ]).toEqual([...parseable]);
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
      stream: 'authoritative_journal',
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
    // covers every workspace package (its src/, or the package tree when it
    // has none — that is what covers packages/web-shell/client) plus the
    // root-level scripts/ and integration-tests/ trees, because the
    // wildcard exports of @qwen-code/qwen-code-core make this module
    // deep-importable from any of them. Its named blind spots are
    // re-exports, computed or interpolated specifiers, symlinks and
    // languages outside the scanned extension set — Decision 5 of the
    // design doc lists them rather than implying them.
    const { roots, missing } = workspaceSourceRoots();

    expect(missing).toEqual([]);
    expect(roots.length).toBeGreaterThan(0);
    expect(findEnvelopeConsumers(roots)).toEqual([]);
  });

  it('names a planted consumer and exonerates prose mentions', () => {
    const deepSpecifier =
      '@qwen-code/qwen-code-core/managed-runtime/managed-event-envelope.js';
    const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'envelope-gate-'));
    try {
      fs.writeFileSync(
        path.join(tree, 'consumer.ts'),
        `import { parseManagedEventEnvelope } from '${deepSpecifier}';\nvoid parseManagedEventEnvelope;\n`,
      );
      fs.writeFileSync(
        path.join(tree, 'dynamic.mjs'),
        `const envelope = await import('${deepSpecifier}');\nvoid envelope;\n`,
      );
      fs.writeFileSync(
        path.join(tree, 'require-probe.cjs'),
        `const envelope = require('${deepSpecifier}');\nvoid envelope;\n`,
      );
      // A comment, a plain string literal and an interpolated template all
      // name the module without importing it; none may be accused.
      fs.writeFileSync(
        path.join(tree, 'prose.ts'),
        [
          '// references managed-event-envelope in a comment',
          "const name = 'managed-event-envelope';",
          'const specifier = `@qwen-code/qwen-code-core/${name}`;',
          'void specifier;',
          '',
        ].join('\n'),
      );
      // Test-only files are not production consumers.
      fs.writeFileSync(
        path.join(tree, 'consumer.test.ts'),
        `import { parseManagedEventEnvelope } from '${deepSpecifier}';\nvoid parseManagedEventEnvelope;\n`,
      );

      expect(
        findEnvelopeConsumers([tree]).map((entry) => path.basename(entry)),
      ).toEqual(['consumer.ts', 'dynamic.mjs', 'require-probe.cjs']);
    } finally {
      fs.rmSync(tree, { recursive: true, force: true });
    }
  });
});
