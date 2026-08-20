import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import {
  DAEMON_ERROR_KINDS,
  type DaemonEvent,
  type DaemonTranscriptBlock,
} from '@qwen-code/sdk/daemon';
import { projectChatRecordsToDaemonTranscript } from '@qwen-code/sdk/daemon/transcript';
import { createExportTranscriptDocumentV1 } from '../packages/cli/src/ui/utils/export/export-transcript-document.js';
import { TranscriptUpdateIdentityProjector } from '../packages/cli/src/acp-integration/session/transcript-update-identity.js';
import {
  probeAcpTranscriptUpdates,
  probeDirectDaemonTranscript,
} from '../packages/vscode-ide-companion/src/services/chatTranscriptContractProbe.js';
import { probeTranscriptRenderIdentity } from '../packages/web-shell/client/adapters/transcriptRenderProbe.js';
import { transcriptBlocksToDaemonMessages } from '../packages/web-shell/client/adapters/transcriptToMessages.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = resolve(
  repoRoot,
  'integration-tests/fixtures/chat-transcript-contract/v1',
);
const caseRoot = resolve(fixtureRoot, 'cases/representative');
const context = { scopeKey: 'workspace-a:session-a', generation: 3 } as const;

interface FixtureManifest {
  readonly fixtureVersion: number;
  readonly name: string;
  readonly generatorVersion: string;
  readonly capabilities: readonly string[];
  readonly consumers: readonly string[];
  readonly expectedDiagnostics: readonly string[];
  readonly normalizedFields: readonly string[];
  readonly hashes: Readonly<Record<string, string>>;
}

interface ExpectedModel {
  readonly kinds: readonly string[];
  readonly sourceRecordIds: readonly (readonly string[])[];
  readonly rawFreeToolResult: string;
}

interface ExpectedRenderItems {
  readonly roles: readonly string[];
  readonly requiredCapabilities: readonly string[];
  readonly identityFields: readonly string[];
}

interface ExpectedExport {
  readonly schemaVersion: number;
  readonly forbiddenFields: readonly string[];
  readonly frozenErrorKinds: readonly string[];
  readonly expectedToolResult: string;
  readonly timestamps: number;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function readJsonLines(path: string): unknown[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as unknown);
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function removeRawPresentationFields(
  blocks: readonly DaemonTranscriptBlock[],
): DaemonTranscriptBlock[] {
  const forbidden = new Set([
    'rawInput',
    'rawOutput',
    'content',
    'toolCall',
    'details',
    'locations',
    'meta',
  ]);
  return JSON.parse(
    JSON.stringify(blocks, (key, value) =>
      forbidden.has(key) ? undefined : value,
    ),
  ) as DaemonTranscriptBlock[];
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
      resolve(fixtureRoot, 'schema/export-transcript-document-v1.schema.json'),
    );
    const expectedExport = readJson<ExpectedExport>(
      resolve(caseRoot, 'expected-export.json'),
    );
    const matrix = readFileSync(
      resolve(fixtureRoot, 'capability-matrix.md'),
      'utf8',
    );

    expect(manifest.fixtureVersion).toBe(1);
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
    for (const [relativePath, expectedHash] of Object.entries(
      manifest.hashes,
    )) {
      expect(sha256(resolve(caseRoot, relativePath))).toBe(expectedHash);
    }
    expect(matrix).toContain('pass; stable under append/prepend/replay');
    expect(matrix).toContain('pass; selected for the later migration phase');
    expect(matrix).not.toMatch(/\b(?:TBD|unknown)\b/i);

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
    const rawFreeBlocks = removeRawPresentationFields(projection.blocks);
    const messages = transcriptBlocksToDaemonMessages(rawFreeBlocks, {
      safeToolProjection: true,
    });
    const renderEvidence = probeTranscriptRenderIdentity(rawFreeBlocks, {
      safeToolProjection: true,
    });
    const exportDocument = createExportTranscriptDocumentV1(
      records,
      { startTime: '2026-08-16T00:00:00.000Z' },
      {
        rendererVersion: '0.21.11-contract-probe.1',
        exportedAt: '2026-08-16T01:00:00.000Z',
      },
    );
    const exportedKeys = collectObjectKeys(exportDocument);

    expect(projection.complete).toBe(true);
    expect(projection.blocks.map((block) => block.kind)).toEqual(
      expected.kinds,
    );
    expect(
      projection.blocks.map((block) => block.sourceRecordIds ?? []),
    ).toEqual(expected.sourceRecordIds);
    expect(messages.map((message) => message.role)).toEqual(
      expectedRender.roles,
    );
    expect(
      messages.find((message) => message.role === 'tool_group')?.tools[0]
        ?.rawOutput,
    ).toBe(expected.rawFreeToolResult);
    expect(
      new Set(renderEvidence.items.flatMap((item) => item.capabilities)),
    ).toEqual(new Set(expectedRender.requiredCapabilities));
    expect(renderEvidence.items.every((item) => item.renderedItemId)).toBe(
      true,
    );
    expect(
      renderEvidence.items.every((item) => item.sourceBlockIds.length > 0),
    ).toBe(true);
    for (const field of expectedRender.identityFields) {
      expect(
        renderEvidence.items.every((item) => Object.hasOwn(item, field)),
        field,
      ).toBe(true);
    }
    expect(JSON.stringify(renderEvidence)).not.toContain(
      expected.rawFreeToolResult,
    );
    expect(renderEvidence.actions.copyAll.renderedItemIds).toEqual(
      renderEvidence.items.map((item) => item.renderedItemId),
    );
    expect(renderEvidence.actions.copyLastReply).toBeDefined();
    expect(renderEvidence.actions.editLastUserMessage).toBeDefined();
    expect(renderEvidence.actions.openFiles.length).toBeGreaterThan(0);
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
    const direct = probeDirectDaemonTranscript(daemonEvents, context, context);
    const directTail = probeDirectDaemonTranscript(
      daemonEvents.slice(1),
      context,
      context,
    );
    const acp = probeAcpTranscriptUpdates(acpUpdates, context, context);
    const liveIdentity = new TranscriptUpdateIdentityProjector();
    const liveAcpUpdate = liveIdentity.project(
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'live answer' },
      } as SessionUpdate,
      'session-a########1',
    );
    const liveAcp = probeAcpTranscriptUpdates(
      [liveAcpUpdate],
      context,
      context,
    );
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
    const completeTaggedAcp = probeAcpTranscriptUpdates(
      taggedAcpSegments,
      context,
      context,
    );
    const tailTaggedAcp = probeAcpTranscriptUpdates(
      taggedAcpSegments.slice(1),
      context,
      context,
    );
    const stale = probeDirectDaemonTranscript(daemonEvents, context, {
      ...context,
      generation: context.generation + 1,
    });
    const directRender = probeTranscriptRenderIdentity(direct.model.blocks);
    const directTailRender = probeTranscriptRenderIdentity(
      directTail.model.blocks,
    );
    const acpTail = probeAcpTranscriptUpdates(
      acpUpdates.slice(1),
      context,
      context,
    );
    const acpRender = probeTranscriptRenderIdentity(acp.model.blocks);
    const acpTailRender = probeTranscriptRenderIdentity(acpTail.model.blocks);
    const firstDelta = {
      id: 60,
      v: 1,
      type: 'session_update',
      promptId: 'prompt-multi-delta',
      data: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'first ' },
          _meta: {
            qwenTranscript: { segmentId: 'prompt-multi-delta:assistant:0' },
          },
        },
      },
    } satisfies DaemonEvent;
    const secondDelta = {
      ...firstDelta,
      id: 61,
      data: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'second' },
          _meta: {
            qwenTranscript: { segmentId: 'prompt-multi-delta:assistant:0' },
          },
        },
      },
    } satisfies DaemonEvent;
    const completeDeltaBlock = probeDirectDaemonTranscript(
      [firstDelta, secondDelta],
      context,
      context,
    );
    const tailDeltaBlock = probeDirectDaemonTranscript(
      [secondDelta],
      context,
      context,
    );
    const completeRender = probeTranscriptRenderIdentity(
      completeDeltaBlock.model.blocks,
    );
    const tailRender = probeTranscriptRenderIdentity(
      tailDeltaBlock.model.blocks,
    );

    expect(direct.diagnostics).toEqual([]);
    expect(
      direct.identities.every((item) => item.sourceIdentity.length > 0),
    ).toBe(true);
    expect(directTail.model.blocks.map((block) => block.id)).toEqual(
      direct.model.blocks.slice(1).map((block) => block.id),
    );
    expect(directTailRender.items).toEqual(directRender.items.slice(1));
    expect(directTailRender.actions.copyLastReply).toEqual(
      directRender.actions.copyLastReply,
    );
    expect(directTailRender.actions.openFiles).toEqual(
      directRender.actions.openFiles,
    );
    expect(acp.diagnostics).toEqual([]);
    expect(acp.identities.every((item) => item.sourceIdentity.length > 0)).toBe(
      true,
    );
    expect(acpTail.diagnostics).toEqual([]);
    expect(acpTail.model.blocks.map((block) => block.id)).toEqual(
      acp.model.blocks.slice(1).map((block) => block.id),
    );
    expect(acpTailRender.items).toEqual(acpRender.items.slice(1));
    expect(acpTailRender.actions.copyLastReply).toEqual(
      acpRender.actions.copyLastReply,
    );
    expect(acpTailRender.actions.openFiles).toEqual(
      acpRender.actions.openFiles,
    );
    expect(completeDeltaBlock.model.blocks[0]?.id).toBe(
      tailDeltaBlock.model.blocks[0]?.id,
    );
    expect(completeDeltaBlock.diagnostics).toEqual([]);
    expect(tailDeltaBlock.diagnostics).toEqual([]);
    expect(completeRender.items[0]?.renderedItemId).toBe(
      tailRender.items[0]?.renderedItemId,
    );
    expect(completeRender.actions.copyLastReply?.renderedItemId).toBe(
      tailRender.actions.copyLastReply?.renderedItemId,
    );
    expect(completeRender.actions.copyLastReply?.semanticHash).not.toBe(
      tailRender.actions.copyLastReply?.semanticHash,
    );
    expect(completeTaggedAcp.model.blocks[1]?.id).toBe(
      tailTaggedAcp.model.blocks[0]?.id,
    );
    expect(completeTaggedAcp.identities[1]?.sourceIdentity).toEqual(
      tailTaggedAcp.identities[0]?.sourceIdentity,
    );
    expect(liveAcp.diagnostics).toEqual([]);
    expect(liveAcp.identities[0]?.sourceIdentity[0]).toBe('segmentId');
    expect(stale.model.blocks).toEqual([]);
    expect(stale.diagnostics).toContainEqual({
      code: 'stale_scope_generation_ignored',
      severity: 'info',
    });
  });
});
