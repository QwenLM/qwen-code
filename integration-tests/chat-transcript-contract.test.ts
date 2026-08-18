import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
  readonly sources: readonly string[];
  readonly consumers: readonly string[];
  readonly complete: boolean;
  readonly expectedDiagnostics: readonly string[];
  readonly hashes: Readonly<Record<string, string>>;
}

interface ExpectedModel {
  readonly kinds: readonly string[];
  readonly sourceRecordIds: readonly (readonly string[])[];
}

interface ExpectedRenderItems {
  readonly roles: readonly string[];
  readonly runtimeFields: readonly string[];
  readonly expectedToolArgs: Readonly<Record<string, unknown>>;
  readonly expectedToolResult: unknown;
}

interface ExpectedExportContract {
  readonly schemaVersion: number;
  readonly forbiddenFields: readonly string[];
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
  if (
    block.kind === 'user' ||
    block.kind === 'assistant' ||
    block.kind === 'thought'
  ) {
    return `${block.kind}:${block.text}`;
  }
  if (block.kind === 'tool') return `tool:${block.toolCallId}`;
  if (block.kind === 'permission') return `permission:${block.requestId}`;
  return `${block.kind}:${block.id}`;
}

function probeIdentity(
  complete: readonly DaemonTranscriptBlock[],
  partial: readonly DaemonTranscriptBlock[],
): IdentityCandidateResult {
  const completeBySemanticKey = new Map(
    complete.map((block) => [blockSemanticKey(block), block]),
  );
  const unstableBlockKinds = partial.flatMap((block) => {
    const completeBlock = completeBySemanticKey.get(blockSemanticKey(block));
    return completeBlock && completeBlock.id !== block.id ? [block.kind] : [];
  });
  const missingNativeTextIdentity = complete.flatMap((block) => {
    if (
      block.kind !== 'user' &&
      block.kind !== 'assistant' &&
      block.kind !== 'thought'
    ) {
      return [];
    }
    return block.sourceRecordIds?.length || block.promptId ? [] : [block.kind];
  });

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

    expect(manifest.fixtureVersion).toBe(1);
    expect(manifest.complete).toBe(true);
    expect(new Set(manifest.sources)).toEqual(
      new Set(['daemon', 'acp', 'chat-records']),
    );
    expect(new Set(manifest.consumers)).toEqual(
      new Set(['web', 'tauri', 'vscode', 'html']),
    );
    expect(manifest.expectedDiagnostics).toEqual([
      'direct_daemon_unstable_identity',
      'acp_unstable_identity',
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
      expect(definition.properties.errorKind.enum).toEqual(DAEMON_ERROR_KINDS);
    }
    const declaredExportProperties =
      collectDeclaredSchemaProperties(exportSchema);
    for (const field of expectedExport.forbiddenFields) {
      expect(declaredExportProperties.has(field), field).toBe(false);
    }
    const permissionOption = exportDefinitions['permissionOption'] as {
      properties: { raw: { const: unknown } };
    };
    expect(permissionOption.properties.raw.const).toBeNull();
    expect(expectedExport).toMatchObject({
      schemaVersion: 1,
      timestamps: 0,
      implementation: 'deferred-to-mr2',
    });

    for (const [relativePath, expectedHash] of Object.entries(
      manifest.hashes,
    )) {
      expect(sha256(resolve(fixtureRoot, relativePath))).toBe(expectedHash);
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
      projection.blocks.map((block) => block.sourceRecordIds ?? []),
    ).toEqual(expected.sourceRecordIds);
    expect(messages.map((message) => message.role)).toEqual(
      expectedRender.roles,
    );
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

  it('keeps Tauri wired to the packaged Web Shell artifact', () => {
    const prepareRuntime = readFileSync(
      resolve(repoRoot, 'packages/desktop-shell/scripts/prepare-runtime.js'),
      'utf8',
    );

    expect(prepareRuntime).toContain("'web-shell/index.html'");
    expect(prepareRuntime).toContain("'web-shell/assets'");
    expect(prepareRuntime).toContain(
      "[npm, 'run', 'build', '--workspace=packages/web-shell']",
    );
    expect(prepareRuntime).toContain('copyDirectory(distDir, libDir)');
  });
});
