import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SchemaValidator } from '@qwen-code/qwen-code-core';
import { DAEMON_ERROR_KINDS, type DaemonEvent } from '@qwen-code/sdk/daemon';
import { projectChatRecordsToDaemonTranscript } from '@qwen-code/sdk/daemon/transcript';
import { createExportTranscriptDocumentV1 } from '../packages/cli/src/ui/utils/export/export-transcript-document.js';
import { transcriptBlocksToDaemonMessages } from '../packages/web-shell/client/adapters/transcriptToMessages.js';
import {
  adaptAcpTranscriptUpdates,
  adaptDirectDaemonEvents,
  projectStableTranscriptBlockIds,
  readJsonLines,
  stableTailIdentity,
} from './helpers/chat-transcript-contract.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = resolve(
  repoRoot,
  'integration-tests/fixtures/chat-transcript-contract/v1',
);
const sharedFixtureHashes = {
  'capability-matrix.md':
    'f726f64d41152f0a31636d14d40f34d9d9acab0636143719d60f31df477928cc',
  'schema/manifest.schema.json':
    'c6c72f87a9fafff94ba62cd031259a6fdf7235277a8638be21aa26cc3366f3fa',
} as const;
const casesRoot = resolve(fixtureRoot, 'cases');
const caseRoot = resolve(fixtureRoot, 'cases/representative');
const scopeKey = 'workspace-a:session-a';

interface FixtureManifest {
  readonly fixtureVersion: number;
  readonly name: string;
  readonly generatorVersion: string;
  readonly sources: readonly string[];
  readonly capabilities: readonly string[];
  readonly consumers: readonly string[];
  readonly expectedDiagnostics: readonly string[];
  readonly normalizedFields: readonly string[];
  readonly complete: boolean;
  readonly hashes: Readonly<Record<string, string>>;
}

interface ExpectedModel {
  readonly kinds: readonly string[];
  readonly texts: readonly string[];
  readonly sourceRecordIds: readonly (readonly string[])[];
  readonly rawFreeToolResult: string;
}

interface ExpectedRenderItems {
  readonly roles: readonly string[];
  readonly expectedTextContent: readonly string[];
  readonly runtimeFields: readonly string[];
  readonly expectedToolArgs: Readonly<Record<string, unknown>>;
  readonly expectedToolResult: unknown;
}

interface ExpectedExport {
  readonly schemaVersion: number;
  readonly forbiddenFields: readonly string[];
  readonly frozenErrorKinds: readonly string[];
  readonly expectedToolResult: string;
  readonly timestamps: number;
}

interface ExpectedGate {
  readonly overall: 'pass' | 'fail';
  readonly selectedVscodePath: 'acp' | 'direct-daemon' | null;
  readonly candidates: Readonly<
    Record<'directDaemon' | 'acp', { readonly status: 'pass' | 'fail' }>
  >;
  readonly blockers: readonly string[];
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function listFixtureFiles(directory: string, root = directory): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) return listFixtureFiles(entryPath, root);
    if (!entry.isFile()) return [];
    return [relative(root, entryPath).split(sep).join('/')];
  });
}

function expectManifestToMatchSchema(
  manifest: FixtureManifest,
  schema: Record<string, unknown>,
): void {
  expect(SchemaValidator.validateStrict(schema, manifest)).toBeNull();
  const properties = schema['properties'] as Record<string, unknown>;
  const required = schema['required'] as string[];
  expect(schema['additionalProperties']).toBe(false);
  expect(Object.keys(manifest).every((key) => key in properties)).toBe(true);
  for (const key of required) expect(manifest).toHaveProperty(key);
  const hashSchema = (
    properties['hashes'] as { additionalProperties: { pattern: string } }
  ).additionalProperties;
  for (const key of ['sources', 'consumers', 'capabilities']) {
    expect((properties[key] as { uniqueItems?: boolean }).uniqueItems).toBe(
      true,
    );
  }
  expect((properties['capabilities'] as { minItems?: number }).minItems).toBe(
    1,
  );
  expect(hashSchema.pattern).toBe('^[a-f0-9]{64}$');
  const pattern = new RegExp(hashSchema.pattern, 'u');
  for (const hash of Object.values(manifest.hashes))
    expect(hash).toMatch(pattern);
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

function collectObjectKeys(
  value: unknown,
  keys = new Set<string>(),
): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectObjectKeys(item, keys);
    return keys;
  }
  if (!value || typeof value !== 'object') return keys;
  for (const [key, item] of Object.entries(value)) {
    keys.add(key);
    collectObjectKeys(item, keys);
  }
  return keys;
}

describe('chat transcript cross-host contract', () => {
  it('locks fixture hashes, schemas, consumers, and capability decisions', () => {
    const manifest = readJson<FixtureManifest>(
      resolve(caseRoot, 'manifest.json'),
    );
    const manifestSchema = readJson<Record<string, unknown>>(
      resolve(fixtureRoot, 'schema/manifest.schema.json'),
    );
    const exportSchema = readJson<Record<string, unknown>>(
      resolve(
        repoRoot,
        'packages/cli/src/ui/utils/export/export-transcript-document-v1.schema.json',
      ),
    );
    const expectedExport = readJson<ExpectedExport>(
      resolve(caseRoot, 'expected-export.json'),
    );
    const expectedGate = readJson<ExpectedGate>(
      resolve(caseRoot, 'expected-gate.json'),
    );
    const matrix = readFileSync(
      resolve(fixtureRoot, 'capability-matrix.md'),
      'utf8',
    );

    expect(manifest.fixtureVersion).toBe(1);
    expectManifestToMatchSchema(manifest, manifestSchema);
    expect(manifest.complete).toBe(true);
    expect(new Set(manifest.sources)).toEqual(
      new Set(['daemon', 'acp', 'chat-records']),
    );
    expect(manifest.name).toBe('representative');
    expect(manifest.generatorVersion).toBe('chat-transcript-prevalidation-v1');
    expect(new Set(manifest.capabilities)).toEqual(
      new Set([
        'text-thinking-usage-images',
        'streaming-replay-prepend',
        'tools-plan-permission',
        'render-action-identity',
        'scope-generation',
        'export-security-network-budgets',
      ]),
    );
    expect(new Set(manifest.consumers)).toEqual(
      new Set(['web', 'tauri', 'vscode', 'html']),
    );
    expect(manifest.expectedDiagnostics).toEqual([]);
    expect(manifest.normalizedFields).toEqual([
      'clientReceivedAt',
      'createdAt',
      'updatedAt',
    ]);
    expect(manifestSchema['additionalProperties']).toBe(false);
    expect(exportSchema['additionalProperties']).toBe(false);
    const exportDefinitions = exportSchema['$defs'] as Record<string, unknown>;
    const metadataSchema = exportDefinitions['metadata'] as {
      properties: Record<string, unknown>;
    };
    expect(metadataSchema.properties).not.toHaveProperty('sessionLabel');
    const toolPreviewSchema = exportDefinitions['toolPreview'] as {
      oneOf: Array<Record<string, unknown>>;
    };
    expect(toolPreviewSchema.oneOf).toHaveLength(14);
    expect(
      toolPreviewSchema.oneOf
        .filter((entry) => !('$ref' in entry))
        .every((entry) => entry['additionalProperties'] === false),
    ).toBe(true);
    for (const definition of Object.values(exportDefinitions)) {
      const entry = definition as Record<string, unknown>;
      if (entry['type'] === 'object') {
        expect(entry['additionalProperties']).toBe(false);
      }
    }
    const permissionBlockSchema = exportDefinitions['permissionBlock'] as {
      properties: {
        resolved: { enum: string[] };
      };
    };
    expect(permissionBlockSchema.properties.resolved.enum).toEqual([
      'approved',
      'rejected',
      'cancelled',
      'expired',
      'resolved',
    ]);
    for (const definitionName of ['statusBlock', 'errorBlock']) {
      const definition = exportDefinitions[definitionName] as {
        properties: { errorKind: { enum: string[] } };
      };
      expect(definition.properties.errorKind.enum).toEqual(
        expectedExport.frozenErrorKinds,
      );
    }
    expect(expectedExport.frozenErrorKinds).toEqual(DAEMON_ERROR_KINDS);
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
    const permissionOption = exportDefinitions['permissionOption'] as {
      properties: { raw: { const: unknown } };
    };
    expect(permissionOption.properties.raw.const).toBeNull();
    const declaredExportProperties =
      collectDeclaredSchemaProperties(exportSchema);
    for (const field of expectedExport.forbiddenFields) {
      expect(declaredExportProperties.has(field), field).toBe(false);
    }
    const blockSchema = exportDefinitions['block'] as {
      oneOf: Array<{ $ref: string }>;
    };
    expect(blockSchema.oneOf).toHaveLength(10);
    for (const { $ref } of blockSchema.oneOf) {
      const definitionName = $ref.replace('#/$defs/', '');
      const definition = exportDefinitions[definitionName] as Record<
        string,
        unknown
      >;
      expect(definition['additionalProperties']).toBe(false);
      const kind = (definition['properties'] as Record<string, unknown>)[
        'kind'
      ] as Record<string, unknown>;
      expect(typeof kind['const']).toBe('string');
    }
    const declaredCaseFiles = readdirSync(casesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const fixtureCaseRoot = resolve(casesRoot, entry.name);
        const fixtureCaseManifest = readJson<FixtureManifest>(
          resolve(fixtureCaseRoot, 'manifest.json'),
        );
        expectManifestToMatchSchema(fixtureCaseManifest, manifestSchema);
        const evidenceFiles = Object.keys(fixtureCaseManifest.hashes);
        expect(listFixtureFiles(fixtureCaseRoot).sort()).toEqual(
          ['manifest.json', ...evidenceFiles].sort(),
        );
        for (const [relativePath, expectedHash] of Object.entries(
          fixtureCaseManifest.hashes,
        )) {
          expect(sha256(resolve(fixtureCaseRoot, relativePath))).toBe(
            expectedHash,
          );
        }
        return ['manifest.json', ...evidenceFiles].map(
          (path) => `cases/${entry.name}/${path}`,
        );
      });
    expect(listFixtureFiles(fixtureRoot).sort()).toEqual(
      [...Object.keys(sharedFixtureHashes), ...declaredCaseFiles].sort(),
    );
    for (const [relativePath, expectedHash] of Object.entries(
      sharedFixtureHashes,
    )) {
      expect(sha256(resolve(fixtureRoot, relativePath))).toBe(expectedHash);
    }
    expect(matrix).toContain('pass; stable under append/prepend/replay');
    expect(matrix).toContain('deferred; product selection moves to MR2B');
    expect(matrix).not.toMatch(/\b(?:TBD|unknown)\b/i);
    expect(expectedGate).toMatchObject({
      overall: 'fail',
      selectedVscodePath: null,
      candidates: {
        directDaemon: { status: 'pass' },
        acp: { status: 'pass' },
      },
    });
    expect(expectedGate.blockers).not.toHaveLength(0);

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
      expect(rendererVersionPattern.test(validVersion), validVersion).toBe(
        true,
      );
    }
    for (const invalidVersion of [
      'latest',
      '^1.2.3',
      '>=1.2.3',
      '1.2',
      '1.2.3 || 2.0.0',
      'not-a-version',
    ]) {
      expect(rendererVersionPattern.test(invalidVersion), invalidVersion).toBe(
        false,
      );
    }
  });

  it('keeps document semantics after all raw renderer fields are removed', () => {
    const records = readJsonLines(resolve(caseRoot, 'chat-records.jsonl'));
    const expected = readJson<ExpectedModel>(
      resolve(caseRoot, 'expected-model.json'),
    );
    const expectedRender = readJson<ExpectedRenderItems>(
      resolve(caseRoot, 'expected-render-items.json'),
    );
    const expectedExport = readJson<ExpectedExport>(
      resolve(caseRoot, 'expected-export.json'),
    );
    const projection = projectChatRecordsToDaemonTranscript(records);
    const runtimeMessages = transcriptBlocksToDaemonMessages(projection.blocks);
    const exportDocument = createExportTranscriptDocumentV1(
      records,
      { startTime: '2026-08-16T00:00:00.000Z' },
      {
        rendererVersion: '0.21.11-contract-probe.1',
        exportedAt: '2026-08-16T01:00:00.000Z',
      },
    );
    const messages = transcriptBlocksToDaemonMessages(exportDocument.blocks, {
      safeToolProjection: true,
    });
    const exportedKeys = collectObjectKeys(exportDocument);

    expect(projection.complete).toBe(true);
    expect(projection.diagnostics).toEqual([]);
    expect(projection.blocks.map((block) => block.kind)).toEqual(
      expected.kinds,
    );
    expect(
      projection.blocks.map((block) => block.sourceRecordIds ?? []),
    ).toEqual(expected.sourceRecordIds);
    expect(
      projection.blocks.flatMap((block) =>
        'text' in block && typeof block.text === 'string' ? [block.text] : [],
      ),
    ).toEqual(expected.texts);
    expect(messages.map((message) => message.role)).toEqual(
      expectedRender.roles,
    );
    expect(
      messages.flatMap((message) =>
        'content' in message && typeof message.content === 'string'
          ? [message.content]
          : [],
      ),
    ).toEqual(expectedRender.expectedTextContent);
    expect(
      messages.find((message) => message.role === 'tool_group')?.tools[0]
        ?.rawOutput,
    ).toBe(expected.rawFreeToolResult);
    expect(
      projection.blocks.find((block) => block.kind === 'tool'),
    ).toMatchObject({
      rawInput: expectedRender.expectedToolArgs,
      rawOutput: expectedRender.expectedToolResult,
    });
    expect(
      runtimeMessages.find((message) => message.role === 'tool_group'),
    ).toMatchObject({
      tools: [
        {
          args: expectedRender.expectedToolArgs,
          rawOutput: expectedRender.expectedToolResult,
        },
      ],
    });
    expect(expectedRender.runtimeFields).toEqual(['rawInput', 'rawOutput']);
    expect(messages.every((message) => message.id.length > 0)).toBe(true);
    expect(exportDocument.schemaVersion).toBe(expectedExport.schemaVersion);
    expect(
      exportDocument.blocks.find((block) => block.kind === 'tool')
        ?.resultPreview,
    ).toMatchObject({
      kind: 'text',
      text: expectedExport.expectedToolResult,
    });
    expect(
      exportDocument.blocks.every(
        (block) =>
          block.clientReceivedAt === expectedExport.timestamps &&
          block.createdAt === expectedExport.timestamps &&
          block.updatedAt === expectedExport.timestamps,
      ),
    ).toBe(true);
    for (const field of expectedExport.forbiddenFields) {
      expect(exportedKeys.has(field), field).toBe(false);
    }
  });

  it('keeps identity stable in both VS Code candidates', () => {
    const daemonEvents = readJsonLines(
      resolve(caseRoot, 'daemon-events.jsonl'),
    ) as DaemonEvent[];
    const acpUpdates = readJsonLines(
      resolve(caseRoot, 'acp-session-updates.jsonl'),
    );
    const direct = adaptDirectDaemonEvents(daemonEvents, scopeKey);
    const directTail = adaptDirectDaemonEvents(daemonEvents.slice(1), scopeKey);
    const acp = adaptAcpTranscriptUpdates(acpUpdates, scopeKey);
    const acpTail = adaptAcpTranscriptUpdates(acpUpdates.slice(1), scopeKey);

    const taggedAcpSegments = ['first ', 'second'].map((text, index) => ({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
      _meta: {
        qwenTranscript: {
          segmentId: `record-${index + 1}:0`,
          sourceRecordIds: [`record-${index + 1}`],
        },
      },
    }));
    const completeTaggedAcp = adaptAcpTranscriptUpdates(
      taggedAcpSegments,
      scopeKey,
    );
    const tailTaggedAcp = adaptAcpTranscriptUpdates(
      taggedAcpSegments.slice(1),
      scopeKey,
    );
    const deltaUpdates = ['first ', 'second'].map((text) => ({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
      _meta: {
        qwenTranscript: {
          segmentId: 'prompt-multi-delta:assistant:0',
        },
      },
    }));
    const completeDelta = adaptAcpTranscriptUpdates(deltaUpdates, scopeKey);
    const tailDelta = adaptAcpTranscriptUpdates(
      deltaUpdates.slice(1),
      scopeKey,
    );

    expect(stableTailIdentity(direct, directTail)).toBe(true);
    expect(stableTailIdentity(acp, acpTail)).toBe(true);
    expect(stableTailIdentity(completeTaggedAcp, tailTaggedAcp)).toBe(true);
    expect(stableTailIdentity(completeDelta, tailDelta, 0)).toBe(true);

    const taggedBlock = completeTaggedAcp.blocks.find(
      (block) => block.kind === 'assistant',
    );
    expect(taggedBlock).toBeDefined();
    const duplicateIdentity = projectStableTranscriptBlockIds(
      [taggedBlock!, { ...taggedBlock!, id: 'duplicate-runtime-id' }],
      scopeKey,
    );
    const missingIdentity = projectStableTranscriptBlockIds(
      [
        {
          ...taggedBlock!,
          id: 'missing-runtime-id',
          segmentId: undefined,
          sourceRecordIds: undefined,
        },
      ],
      scopeKey,
    );

    expect(duplicateIdentity.compatible).toBe(false);
    expect(stableTailIdentity(duplicateIdentity, duplicateIdentity, 0)).toBe(
      false,
    );
    expect(missingIdentity.compatible).toBe(false);
    expect(stableTailIdentity(missingIdentity, missingIdentity, 0)).toBe(false);
  });
});
