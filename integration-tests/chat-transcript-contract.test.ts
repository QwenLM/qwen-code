import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createDaemonTranscriptState,
  DAEMON_ERROR_KINDS,
  normalizeDaemonEvent,
  reduceDaemonTranscriptEvents,
  type DaemonEvent,
  type DaemonTranscriptBlock,
} from '@qwen-code/sdk/daemon';
import { projectChatRecordsToDaemonTranscript } from '@qwen-code/sdk/daemon/transcript';
import { transcriptBlocksToDaemonMessages } from '../packages/web-shell/client/adapters/transcriptToMessages.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = resolve(
  repoRoot,
  'integration-tests/fixtures/chat-transcript-contract/v1',
);
const caseRoot = resolve(fixtureRoot, 'cases/representative');

interface FixtureManifest {
  readonly fixtureVersion: number;
  readonly name: string;
  readonly generatorVersion?: string;
  readonly sources: readonly string[];
  readonly consumers: readonly string[];
  readonly capabilities: readonly string[];
  readonly complete: boolean;
  readonly expectedDiagnostics: readonly string[];
  readonly normalizedFields?: readonly string[];
  readonly hashes: Readonly<Record<string, string>>;
}

interface ExpectedModel {
  readonly kinds: readonly string[];
  readonly texts: readonly string[];
  readonly sourceRecordIds: readonly (readonly string[])[];
}

interface ExpectedRenderItems {
  readonly roles: readonly string[];
  readonly expectedTextContent: readonly string[];
  readonly runtimeFields: readonly string[];
  readonly expectedToolArgs: Readonly<Record<string, unknown>>;
  readonly expectedToolResult: unknown;
}

interface ExpectedExportContract {
  readonly schemaVersion: number;
  readonly forbiddenFields: readonly string[];
  readonly frozenErrorKinds: readonly string[];
  readonly timestamps: number;
  readonly implementation: string;
}

interface IdentityCandidateResult {
  readonly status: 'fail';
  readonly stableUnderPartialPrepend: false;
  readonly unstableBlockKinds: readonly string[];
  readonly missingNativeTextIdentity: readonly string[];
}

interface ExpectedGate {
  readonly overall: 'fail';
  readonly selectedVscodePath: null;
  readonly candidates: {
    readonly directDaemon: IdentityCandidateResult;
    readonly acp: IdentityCandidateResult;
  };
  readonly blockers: readonly string[];
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function readJsonLines<T>(path: string): T[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as T);
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function listFixtureEvidenceFiles(
  directory: string,
  relativeDirectory = '',
): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = relativeDirectory
      ? `${relativeDirectory}/${entry.name}`
      : entry.name;
    if (entry.isDirectory()) {
      return listFixtureEvidenceFiles(
        resolve(directory, entry.name),
        relativePath,
      );
    }
    return relativePath === 'cases/representative/manifest.json'
      ? []
      : [relativePath];
  });
}

function expectManifestToMatchSchema(
  manifest: FixtureManifest,
  schema: Record<string, unknown>,
): void {
  const properties = schema['properties'] as Record<
    string,
    Record<string, unknown>
  >;
  const required = schema['required'];
  expect(properties).toBeTypeOf('object');
  expect(required).toBeInstanceOf(Array);
  expect(schema['additionalProperties']).toBe(false);

  const allowedKeys = new Set(Object.keys(properties));
  for (const key of Object.keys(manifest)) {
    expect(allowedKeys.has(key), `manifest property ${key}`).toBe(true);
  }
  for (const key of required as string[]) {
    expect(manifest, `required manifest property ${key}`).toHaveProperty(key);
  }

  const nameSchema = properties['name'];
  expect(manifest.name.length).toBeGreaterThanOrEqual(
    nameSchema?.['minLength'] as number,
  );
  expect(manifest.name.length).toBeLessThanOrEqual(
    nameSchema?.['maxLength'] as number,
  );
  const capabilitySchema = properties['capabilities'];
  const capabilityItemSchema = capabilitySchema?.['items'] as Record<
    string,
    unknown
  >;
  expect(manifest.capabilities.length).toBeGreaterThanOrEqual(
    capabilitySchema?.['minItems'] as number,
  );
  expect(new Set(manifest.capabilities)).toHaveLength(
    manifest.capabilities.length,
  );
  for (const capability of manifest.capabilities) {
    expect(capability).toBeTypeOf('string');
    expect(capability.length).toBeLessThanOrEqual(
      capabilityItemSchema['maxLength'] as number,
    );
  }
  const hashSchema = properties['hashes']?.['additionalProperties'] as Record<
    string,
    unknown
  >;
  const hashPattern = new RegExp(hashSchema['pattern'] as string, 'u');
  for (const [relativePath, hash] of Object.entries(manifest.hashes)) {
    expect(relativePath).not.toBe('cases/representative/manifest.json');
    expect(hash, relativePath).toMatch(hashPattern);
  }
}

function collectDeclaredSchemaProperties(
  value: unknown,
  names = new Set<string>(),
): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectDeclaredSchemaProperties(item, names);
    return names;
  }
  if (!value || typeof value !== 'object') return names;

  for (const [key, item] of Object.entries(value)) {
    if (key === 'properties' && item && typeof item === 'object') {
      for (const propertyName of Object.keys(item)) names.add(propertyName);
    }
    collectDeclaredSchemaProperties(item, names);
  }
  return names;
}

function reduceDaemonEvents(
  events: readonly DaemonEvent[],
): readonly DaemonTranscriptBlock[] {
  let state = createDaemonTranscriptState({ now: 0 });
  for (const event of events) {
    state = reduceDaemonTranscriptEvents(state, normalizeDaemonEvent(event), {
      now: 0,
    });
  }
  return state.blocks;
}

function reduceAcpUpdates(
  updates: readonly unknown[],
): readonly DaemonTranscriptBlock[] {
  return reduceDaemonEvents(
    updates.map(
      (update): DaemonEvent => ({
        v: 1,
        type: 'session_update',
        data: { update },
      }),
    ),
  );
}

function blockSemanticKey(block: DaemonTranscriptBlock): string {
  switch (block.kind) {
    case 'user':
    case 'assistant':
    case 'thought':
      return `${block.kind}:${block.text}`;
    case 'tool':
      return `tool:${block.toolCallId}`;
    case 'permission':
      return `permission:${block.requestId}`;
    default:
      throw new Error(`Unsupported identity probe block kind: ${block.kind}`);
  }
}

function indexBlocksBySemanticKey(
  blocks: readonly DaemonTranscriptBlock[],
  label: 'complete' | 'partial',
): ReadonlyMap<string, DaemonTranscriptBlock> {
  const indexed = new Map<string, DaemonTranscriptBlock>();
  for (const block of blocks) {
    const key = blockSemanticKey(block);
    if (indexed.has(key)) {
      throw new Error(`Ambiguous ${label} identity probe semantic key: ${key}`);
    }
    indexed.set(key, block);
  }
  return indexed;
}

function probeIdentity(
  complete: readonly DaemonTranscriptBlock[],
  partial: readonly DaemonTranscriptBlock[],
): IdentityCandidateResult {
  const completeBySemanticKey = indexBlocksBySemanticKey(complete, 'complete');
  const partialBySemanticKey = indexBlocksBySemanticKey(partial, 'partial');
  const unstableBlockKinds = [
    ...new Set(
      [...partialBySemanticKey].flatMap(([key, block]) => {
        const completeBlock = completeBySemanticKey.get(key);
        if (!completeBlock) {
          throw new Error(`Missing complete identity probe block: ${key}`);
        }
        return completeBlock.id !== block.id ? [block.kind] : [];
      }),
    ),
  ];
  const missingNativeTextIdentity = [
    ...new Set(
      complete.flatMap((block) => {
        if (
          block.kind !== 'user' &&
          block.kind !== 'assistant' &&
          block.kind !== 'thought'
        ) {
          return [];
        }
        return block.sourceRecordIds?.length || block.promptId
          ? []
          : [block.kind];
      }),
    ),
  ];

  expect(unstableBlockKinds.length).toBeGreaterThan(0);
  return {
    status: 'fail',
    stableUnderPartialPrepend: false,
    unstableBlockKinds,
    missingNativeTextIdentity,
  };
}

describe('chat transcript contract prevalidation', () => {
  it('locks the evidence fixtures, schemas, and fail-first capability decision', () => {
    const manifest = readJson<FixtureManifest>(
      resolve(caseRoot, 'manifest.json'),
    );
    const manifestSchema = readJson<Record<string, unknown>>(
      resolve(fixtureRoot, 'schema/manifest.schema.json'),
    );
    const exportSchema = readJson<Record<string, unknown>>(
      resolve(fixtureRoot, 'schema/export-transcript-document-v1.schema.json'),
    );
    const expectedExport = readJson<ExpectedExportContract>(
      resolve(caseRoot, 'expected-export.json'),
    );
    const matrix = readFileSync(
      resolve(fixtureRoot, 'capability-matrix.md'),
      'utf8',
    );

    expectManifestToMatchSchema(manifest, manifestSchema);
    const manifestWithUnknownProperty = {
      ...manifest,
      unknownProperty: true,
    };
    expect(() =>
      expectManifestToMatchSchema(manifestWithUnknownProperty, manifestSchema),
    ).toThrow(/manifest property unknownProperty/u);
    expect(manifest.fixtureVersion).toBe(1);
    expect(manifest.complete).toBe(true);
    expect(new Set(manifest.sources)).toEqual(
      new Set(['daemon', 'acp', 'chat-records']),
    );
    expect(new Set(manifest.consumers)).toEqual(
      new Set(['web', 'tauri', 'vscode', 'html']),
    );
    expect(manifest.name).toBe('representative');
    expect(manifest.generatorVersion).toBe(
      'chat-transcript-prevalidation-evidence-v1',
    );
    expect(new Set(manifest.capabilities)).toEqual(
      new Set([
        'semantic-projection',
        'runtime-raw-compatibility',
        'stable-identity-prepend-probe',
        'export-document-schema',
        'two-mr-migration-gate',
      ]),
    );
    expect(manifest.expectedDiagnostics).toEqual([
      'direct_daemon_unstable_identity',
      'acp_unstable_identity',
    ]);
    expect(manifest.normalizedFields).toEqual([
      'clientReceivedAt',
      'createdAt',
      'updatedAt',
    ]);
    expect(manifestSchema['additionalProperties']).toBe(false);
    expect(exportSchema['additionalProperties']).toBe(false);

    const exportDefinitions = exportSchema['$defs'] as Record<string, unknown>;
    const blockSchema = exportDefinitions['block'] as {
      oneOf: Array<{ $ref: string }>;
    };
    expect(blockSchema.oneOf).toHaveLength(10);
    for (const definitionName of ['statusBlock', 'errorBlock']) {
      const definition = exportDefinitions[definitionName] as {
        properties: { errorKind: { enum: string[] } };
      };
      expect(definition.properties.errorKind.enum).toEqual(
        expectedExport.frozenErrorKinds,
      );
    }
    for (const errorKind of expectedExport.frozenErrorKinds) {
      expect(
        DAEMON_ERROR_KINDS,
        `Export V1 error kind ${errorKind} must remain supported by the SDK`,
      ).toContain(errorKind);
    }
    const declaredExportProperties =
      collectDeclaredSchemaProperties(exportSchema);
    for (const field of expectedExport.forbiddenFields) {
      expect(declaredExportProperties.has(field), field).toBe(false);
    }
    const permissionOption = exportDefinitions['permissionOption'] as {
      properties: { raw: { const: unknown } };
    };
    const toolBlock = exportDefinitions['toolBlock'] as {
      properties: Record<string, unknown>;
    };
    const statusBlock = exportDefinitions['statusBlock'] as {
      properties: Record<string, unknown>;
    };
    const errorBlock = exportDefinitions['errorBlock'] as {
      properties: Record<string, unknown>;
    };
    expect(toolBlock.properties).not.toHaveProperty('content');
    expect(statusBlock.properties).not.toHaveProperty('data');
    expect(errorBlock.properties).not.toHaveProperty('data');
    expect(permissionOption.properties.raw.const).toBeNull();
    expect(expectedExport).toMatchObject({
      schemaVersion: 1,
      timestamps: 0,
      implementation: 'deferred-to-mr2',
    });

    expect(Object.keys(manifest.hashes).sort()).toEqual(
      listFixtureEvidenceFiles(fixtureRoot).sort(),
    );
    for (const [relativePath, expectedHash] of Object.entries(
      manifest.hashes,
    )) {
      expect(sha256(resolve(fixtureRoot, relativePath))).toBe(expectedHash);
    }

    const exportProperties = exportSchema['properties'] as Record<
      string,
      Record<string, unknown>
    >;
    const rendererVersionPattern = new RegExp(
      exportProperties['rendererVersion']?.['pattern'] as string,
      'u',
    );
    for (const validVersion of [
      '1.2.3',
      '1.2.3-beta.1+build.7',
      'a'.repeat(64),
    ]) {
      expect(validVersion, validVersion).toMatch(rendererVersionPattern);
    }
    for (const invalidVersion of [
      'LATEST',
      'latest',
      '1.0.0 - 2.0.0',
      '1.x',
      '1.0.0 || 2.0.0',
      '^1.2.3',
      '~1.2.3',
      '*',
      '>=1.0.0',
    ]) {
      expect(invalidVersion, invalidVersion).not.toMatch(
        rendererVersionPattern,
      );
    }
    expect(matrix).toContain('FAIL — migration blocked');
    expect(matrix).toContain('No VS Code transport is selected in MR1');
    expect(matrix).not.toMatch(/pass; selected/i);
  });

  it('preserves current ChatRecord and Web Shell runtime semantics', () => {
    const records = readJsonLines<unknown>(
      resolve(caseRoot, 'chat-records.jsonl'),
    );
    const expected = readJson<ExpectedModel>(
      resolve(caseRoot, 'expected-model.json'),
    );
    const expectedRender = readJson<ExpectedRenderItems>(
      resolve(caseRoot, 'expected-render-items.json'),
    );
    const projection = projectChatRecordsToDaemonTranscript(records);
    const messages = transcriptBlocksToDaemonMessages(projection.blocks);
    const toolBlock = projection.blocks.find((block) => block.kind === 'tool');
    const toolMessage = messages.find(
      (message) => message.role === 'tool_group',
    );

    expect(projection.complete).toBe(true);
    expect(projection.diagnostics).toEqual([]);
    expect(projection.blocks.map((block) => block.kind)).toEqual(
      expected.kinds,
    );
    expect(
      projection.blocks.flatMap((block) => {
        switch (block.kind) {
          case 'user':
          case 'assistant':
          case 'thought':
            return [block.text];
          default:
            return [];
        }
      }),
    ).toEqual(expected.texts);
    expect(
      projection.blocks.map((block) => block.sourceRecordIds ?? []),
    ).toEqual(expected.sourceRecordIds);
    expect(messages.map((message) => message.role)).toEqual(
      expectedRender.roles,
    );
    expect(
      messages.flatMap((message) => {
        switch (message.role) {
          case 'user':
          case 'thinking':
          case 'assistant':
            return [message.content];
          default:
            return [];
        }
      }),
    ).toEqual(expectedRender.expectedTextContent);
    expect(toolBlock).toMatchObject({
      rawInput: expectedRender.expectedToolArgs,
      rawOutput: expectedRender.expectedToolResult,
    });
    expect(toolMessage).toMatchObject({
      tools: [
        {
          args: expectedRender.expectedToolArgs,
          rawOutput: expectedRender.expectedToolResult,
        },
      ],
    });
    expect(expectedRender.runtimeFields).toEqual(['rawInput', 'rawOutput']);
  });

  it('records both VS Code identity candidates as reproducible blockers', () => {
    const daemonEvents = readJsonLines<DaemonEvent>(
      resolve(caseRoot, 'daemon-events.jsonl'),
    );
    const acpUpdates = readJsonLines<unknown>(
      resolve(caseRoot, 'acp-session-updates.jsonl'),
    );
    const expectedGate = readJson<ExpectedGate>(
      resolve(caseRoot, 'expected-gate.json'),
    );
    const observedGate: ExpectedGate = {
      overall: 'fail',
      selectedVscodePath: null,
      candidates: {
        directDaemon: probeIdentity(
          reduceDaemonEvents(daemonEvents),
          reduceDaemonEvents(daemonEvents.slice(1)),
        ),
        acp: probeIdentity(
          reduceAcpUpdates(acpUpdates),
          reduceAcpUpdates(acpUpdates.slice(1)),
        ),
      },
      blockers: [
        'direct-daemon uses reducer ordinal block IDs that change when history is prepended',
        'ACP text updates do not carry a stable source identity and inherit the same ordinal block IDs',
      ],
    };

    expect(observedGate).toEqual(expectedGate);
  });

  it('fails closed on ambiguous identity keys and records kind sets', () => {
    const assistantBlock = (
      id: string,
      text: string,
    ): DaemonTranscriptBlock => ({
      id,
      kind: 'assistant',
      clientReceivedAt: 0,
      createdAt: 0,
      updatedAt: 0,
      text,
    });

    expect(() =>
      probeIdentity(
        [assistantBlock('complete-1', 'duplicate')],
        [
          assistantBlock('partial-1', 'duplicate'),
          assistantBlock('partial-2', 'duplicate'),
        ],
      ),
    ).toThrow(/Ambiguous partial identity probe semantic key/u);

    expect(
      probeIdentity(
        [
          assistantBlock('complete-1', 'first'),
          assistantBlock('complete-2', 'second'),
        ],
        [
          assistantBlock('partial-1', 'first'),
          assistantBlock('partial-2', 'second'),
        ],
      ),
    ).toEqual({
      status: 'fail',
      stableUnderPartialPrepend: false,
      unstableBlockKinds: ['assistant'],
      missingNativeTextIdentity: ['assistant'],
    });

    expect(() =>
      probeIdentity(
        [
          {
            id: 'status-1',
            kind: 'status',
            clientReceivedAt: 0,
            createdAt: 0,
            updatedAt: 0,
            text: 'status',
          },
        ],
        [],
      ),
    ).toThrow(/Unsupported identity probe block kind: status/u);
  });
});
