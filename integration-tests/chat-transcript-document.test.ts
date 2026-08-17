import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance as nodePerformance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { DaemonEvent } from '@qwen-code/sdk/daemon';
import { TranscriptUpdateIdentityProjector } from '../packages/cli/src/acp-integration/session/transcript-update-identity.js';
import {
  EXPORT_TRANSCRIPT_LIMITS_V1,
  assertExportTranscriptDocumentV1,
  createExportTranscriptDocumentV1,
  type ExportTranscriptBlockV1,
  type ExportTranscriptDocumentV1,
} from '../packages/cli/src/ui/utils/export/export-transcript-document.js';
import {
  probeAcpTranscriptUpdates,
  probeDirectDaemonTranscript,
  type TranscriptAdapterProbeResult,
} from '../packages/vscode-ide-companion/src/services/chatTranscriptContractProbe.js';
import { probeTranscriptRenderIdentity } from '../packages/web-shell/client/adapters/transcriptRenderProbe.js';

const RENDERER_VERSION = '0.21.11-contract-probe.1';
const EXPORTED_AT = '2026-08-16T01:00:00.000Z';
const CANARY = 'CHAT_TRANSCRIPT_TEST_SECRET_DO_NOT_EXPORT';
const MAX_DOCUMENT_DURATION_MS = 60_000;
const MAX_HEAP_DELTA_BYTES = 512 * 1024 * 1024;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = resolve(
  repoRoot,
  'integration-tests/fixtures/chat-transcript-contract/v1',
);

interface ExpectedNetwork {
  readonly unexpectedRequests: number;
  readonly cspViolations: number;
  readonly allowedImageSources: readonly string[];
}

interface VscodeIdentityGate {
  readonly directDaemon: 'pass' | 'fail';
  readonly acp: 'pass' | 'fail';
  readonly selectedPath: 'acp' | 'direct-daemon' | null;
  readonly blockers: readonly string[];
}

const expectedNetwork = JSON.parse(
  readFileSync(
    resolve(fixtureRoot, 'cases/representative/expected-network.json'),
    'utf8',
  ),
) as ExpectedNetwork;

function record(
  uuid: string,
  parentUuid: string | null,
  type: 'user' | 'assistant',
  text: string,
): Record<string, unknown> {
  return {
    uuid,
    parentUuid,
    sessionId: 'synthetic-session',
    timestamp: '2026-08-16T00:00:00.000Z',
    cwd: '/workspace/project',
    version: 'test',
    type,
    message: {
      role: type === 'user' ? 'user' : 'model',
      parts: [{ text }],
    },
  };
}

function createMaximumDocument(): ExportTranscriptDocumentV1 {
  const records: Record<string, unknown>[] = [];
  for (
    let index = 0;
    index < EXPORT_TRANSCRIPT_LIMITS_V1.maxBlocks;
    index += 1
  ) {
    const uuid = `record-${index}`;
    const marker =
      index === 0
        ? 'FIRST_SEARCH_NEEDLE'
        : index === EXPORT_TRANSCRIPT_LIMITS_V1.maxBlocks - 1
          ? 'LAST_SEARCH_NEEDLE'
          : `block-${index}`;
    records.push(
      record(
        uuid,
        index === 0 ? null : `record-${index - 1}`,
        index % 2 === 0 ? 'user' : 'assistant',
        `${marker} ${'x'.repeat(7_950)}`,
      ),
    );
  }
  const document = createExportTranscriptDocumentV1(
    records,
    {
      startTime: '2026-08-16T00:00:00.000Z',
      metadata: {
        sessionId: `hidden-${CANARY}`,
        startTime: '2026-08-16T00:00:00.000Z',
        exportTime: EXPORTED_AT,
        cwd: '/workspace/project',
        gitRepo: 'qwen-code',
        gitBranch: 'contract-probe',
        model: 'synthetic-model',
        channel: 'cli',
        promptCount: 500,
        totalTokens: 1_000,
        filesWritten: 0,
        linesAdded: 0,
        linesRemoved: 0,
        uniqueFiles: [`/workspace/${CANARY}.ts`],
      },
    },
    { rendererVersion: RENDERER_VERSION, exportedAt: EXPORTED_AT },
  );
  const blocks: ExportTranscriptBlockV1[] = [...document.blocks];
  blocks[10] = {
    id: blocks[10]!.id,
    kind: 'thought',
    clientReceivedAt: 0,
    createdAt: 0,
    updatedAt: 0,
    text: `DOCUMENT_THINKING_DETAIL ${'x'.repeat(7_950)}`,
    streaming: false,
  };
  blocks[11] = {
    id: blocks[11]!.id,
    kind: 'tool',
    clientReceivedAt: 0,
    createdAt: 0,
    updatedAt: 0,
    toolCallId: 'tool-call-document',
    title: 'Document shell result',
    status: 'completed',
    toolName: 'shell',
    toolKind: 'execute',
    preview: { kind: 'command', command: 'printf document' },
    resultPreview: {
      kind: 'text',
      text: `DOCUMENT_TOOL_DETAIL ${'x'.repeat(7_950)}`,
    },
  };
  blocks[12] = {
    id: blocks[12]!.id,
    kind: 'assistant',
    clientReceivedAt: 0,
    createdAt: 0,
    updatedAt: 0,
    text: [
      'DOCUMENT_RICH_CONTENT',
      '```mermaid',
      'graph TD; A[Export] --> B[Document]',
      '```',
      '```echarts',
      '{"title":{"text":"DOCUMENT_CHART_FALLBACK"},"series":[]}',
      '```',
      'Inline math: $E=mc^2$',
      'x'.repeat(7_800),
    ].join('\n'),
    streaming: false,
  };
  blocks[13] = {
    id: blocks[13]!.id,
    kind: 'tool',
    clientReceivedAt: 0,
    createdAt: 0,
    updatedAt: 0,
    toolCallId: 'agent-document-1',
    title: 'Review export contract',
    status: 'cancelled',
    toolName: 'agent',
    toolKind: 'think',
    preview: {
      kind: 'subagent_delegation',
      agentName: 'reviewer',
      task: 'Review the document contract',
    },
  };
  blocks[14] = {
    id: blocks[14]!.id,
    kind: 'tool',
    clientReceivedAt: 0,
    createdAt: 0,
    updatedAt: 0,
    toolCallId: 'nested-document-tool',
    title: 'Read nested evidence',
    status: 'completed',
    toolName: 'read',
    toolKind: 'read',
    preview: { kind: 'file_read', path: 'contract.md' },
    resultPreview: { kind: 'text', text: 'DOCUMENT_NESTED_TOOL_DETAIL' },
    parentToolCallId: 'agent-document-1',
    parentBlockId: blocks[13]!.id,
  };
  blocks[15] = {
    id: blocks[15]!.id,
    kind: 'assistant',
    clientReceivedAt: 0,
    createdAt: 0,
    updatedAt: 0,
    text: 'DOCUMENT_SUBAGENT_STREAM',
    streaming: false,
    parentToolCallId: 'agent-document-1',
  };
  blocks[16] = {
    id: blocks[16]!.id,
    kind: 'tool',
    clientReceivedAt: 0,
    createdAt: 0,
    updatedAt: 0,
    toolCallId: 'agent-document-2',
    title: 'Audit export security',
    status: 'completed',
    toolName: 'agent',
    toolKind: 'think',
    preview: {
      kind: 'subagent_delegation',
      agentName: 'security-reviewer',
      task: 'Audit the document security boundary',
    },
    resultPreview: {
      kind: 'text',
      text: ['DOCUMENT_SUBAGENT_RESULT', 'DOCUMENT_PARALLEL_AGENT_RESULT'].join(
        '\n',
      ),
    },
  };
  blocks[17] = {
    id: blocks[17]!.id,
    kind: 'user_shell',
    clientReceivedAt: 0,
    createdAt: 0,
    updatedAt: 0,
    command: 'printf user-shell',
    cwd: 'project',
    text: `DOCUMENT_USER_SHELL_DETAIL ${'x'.repeat(7_900)}`,
  };
  blocks[19] = {
    id: blocks[19]!.id,
    kind: 'tool',
    clientReceivedAt: 0,
    createdAt: 0,
    updatedAt: 0,
    toolCallId: 'diff-document',
    title: 'Document diff',
    status: 'completed',
    toolName: 'edit',
    toolKind: 'edit',
    preview: {
      kind: 'file_diff',
      path: 'document.ts',
      oldText: Array.from({ length: 180 }, (_, index) => `-old ${index}`).join(
        '\n',
      ),
      newText: [
        'DOCUMENT_DIFF_DETAIL',
        ...Array.from({ length: 180 }, (_, index) => `+new ${index}`),
      ].join('\n'),
    },
    resultPreview: { kind: 'text', text: 'Document diff completed' },
  };
  return { ...document, blocks };
}

async function buildWebShellDocumentBundle(): Promise<string> {
  const distEntry = resolve(repoRoot, 'packages/web-shell/dist/index.js');
  const distMtime = statSync(distEntry).mtimeMs;
  const clientRoot = resolve(repoRoot, 'packages/web-shell/client');
  const productionSourceMtimes: number[] = [];
  const visitSources = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        visitSources(path);
      } else if (
        /\.(?:css|ts|tsx)$/.test(entry.name) &&
        !/\.(?:test|spec)\.(?:ts|tsx)$/.test(entry.name)
      ) {
        productionSourceMtimes.push(statSync(path).mtimeMs);
      }
    }
  };
  visitSources(clientRoot);
  if (productionSourceMtimes.some((mtime) => mtime > distMtime)) {
    throw new Error(
      'Web Shell dist is stale; run npm run build --workspace=packages/web-shell.',
    );
  }
  const bundled = await esbuild({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { assertExportTranscriptDocumentV1 } from './packages/cli/src/ui/utils/export/export-transcript-document.ts';
        import { WebShellTranscript } from './packages/web-shell/dist/index.js';
        const envelope = document.getElementById('transcript');
        const rootNode = document.getElementById('app');
        if (!(envelope instanceof HTMLScriptElement) || !rootNode) throw new Error('Transcript document root is missing.');
        const serialized = envelope.textContent ?? '';
        if (new TextEncoder().encode(serialized).byteLength > ${EXPORT_TRANSCRIPT_LIMITS_V1.maxEnvelopeBytes}) throw new Error('Transcript document exceeds the envelope budget.');
        const value = JSON.parse(serialized);
        assertExportTranscriptDocumentV1(value);
        if (value.rendererVersion !== '${RENDERER_VERSION}') throw new Error('Transcript renderer version is unsupported.');
        createRoot(rootNode).render(React.createElement(WebShellTranscript, {
          blocks: value.blocks,
          renderMode: 'document',
          compactThinking: true,
          theme: 'light',
        }));
        const markComplete = () => {
          const text = document.body.innerText;
          if (text.includes('FIRST_SEARCH_NEEDLE') && text.includes('LAST_SEARCH_NEEDLE')) {
            document.body.dataset.renderComplete = 'true';
            return;
          }
          requestAnimationFrame(markComplete);
        };
        requestAnimationFrame(markComplete);
      `,
      resolveDir: repoRoot,
      sourcefile: 'document-browser-entry.js',
    },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    minify: true,
    write: false,
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const code = bundled.outputFiles[0]?.text;
  if (!code) throw new Error('Web Shell browser bundle is empty.');
  return code.replace(/<\/script/gi, '<\\/script');
}

let webShellDocumentBundle: Promise<string> | undefined;

function getWebShellDocumentBundle(): Promise<string> {
  webShellDocumentBundle ??= buildWebShellDocumentBundle();
  return webShellDocumentBundle;
}

function buildDocumentProbeHtml(
  document: ExportTranscriptDocumentV1,
  browserBundle: string,
): string {
  assertExportTranscriptDocumentV1(document);
  const envelope = JSON.stringify(document).replaceAll('<', '\\u003c');
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-contract-probe'; style-src-elem 'nonce-contract-probe'; style-src-attr 'unsafe-inline'; img-src data:; connect-src 'none'; object-src 'none'; frame-src 'none'; media-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'">
  <style nonce="contract-probe">body{margin:0}</style>
</head>
<body>
  <div id="app"></div>
  <script nonce="contract-probe" id="transcript" type="application/json">${envelope}</script>
  <script nonce="contract-probe">
    const createElement = document.createElement.bind(document);
    document.createElement = (name, options) => {
      const element = createElement(name, options);
      if (name.toLowerCase() === 'style') element.setAttribute('nonce', 'contract-probe');
      return element;
    };
  </script>
  <script nonce="contract-probe">${browserBundle}</script>
</body>
</html>`;
}

function writeGateReport(evidence: {
  readonly durationMs: number;
  readonly heapDeltaBytes: number;
  readonly envelopeBytes: number;
  readonly pdfBytes: number;
  readonly copiedLength: number;
  readonly renderedItemCount: number;
  readonly sourceBlockCount: number;
  readonly requests: readonly string[];
  readonly cspErrors: readonly string[];
}): void {
  const outputRoot = process.env['INTEGRATION_TEST_FILE_DIR'];
  if (!outputRoot) return;
  const manifest = JSON.parse(
    readFileSync(
      resolve(fixtureRoot, 'cases/representative/manifest.json'),
      'utf8',
    ),
  ) as { hashes: Readonly<Record<string, string>> };
  const matrix = readFileSync(
    resolve(fixtureRoot, 'capability-matrix.md'),
    'utf8',
  );
  const vscodeIdentity = evaluateVscodeIdentityGate();
  const identityPassed =
    vscodeIdentity.directDaemon === 'pass' && vscodeIdentity.acp === 'pass';
  writeFileSync(
    resolve(outputRoot, 'chat-transcript-gate-report.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedBy: 'chat-transcript-contract prevalidation tests',
        overall: identityPassed ? 'pass' : 'fail',
        selectedVscodePath: vscodeIdentity.selectedPath,
        vscodeCandidates: {
          directDaemon: vscodeIdentity.directDaemon,
          acp: vscodeIdentity.acp,
        },
        vscodeBlockers: vscodeIdentity.blockers,
        gates: {
          semantic: {
            status: 'pass',
            evidence: 'chat-transcript-contract.test.ts',
          },
          identityAction: {
            status: identityPassed ? 'pass' : 'fail',
            evidence:
              'source-stamped live ACP plus direct-daemon/ACP append, partial-prepend, replay, render and action identity fixtures',
          },
          exportSecurity: {
            status: 'pass',
            evidence: 'ExportTranscriptDocument allowlist and canary tests',
          },
          resourceNetwork: {
            status: 'pass',
            evidence:
              'built WebShellTranscript document-mode Chromium open/search/copy/print probe',
          },
        },
        thresholds: {
          maxDurationMs: MAX_DOCUMENT_DURATION_MS,
          maxHeapDeltaBytes: MAX_HEAP_DELTA_BYTES,
          maxBlocks: EXPORT_TRANSCRIPT_LIMITS_V1.maxBlocks,
          maxEnvelopeBytes: EXPORT_TRANSCRIPT_LIMITS_V1.maxEnvelopeBytes,
          unexpectedRequests: expectedNetwork.unexpectedRequests,
          cspViolations: expectedNetwork.cspViolations,
        },
        observed: {
          ...evidence,
          durationMs: Math.round(evidence.durationMs),
        },
        fixtureHashes: manifest.hashes,
        capabilityMatrixSha256: createHash('sha256')
          .update(matrix)
          .digest('hex'),
      },
      null,
      2,
    )}\n`,
  );
}

function evaluateVscodeIdentityGate(): VscodeIdentityGate {
  const caseRoot = resolve(fixtureRoot, 'cases/representative');
  const daemonEvents = readJsonLines(
    resolve(caseRoot, 'daemon-events.jsonl'),
  ) as DaemonEvent[];
  const acpUpdates = readJsonLines(
    resolve(caseRoot, 'acp-session-updates.jsonl'),
  );
  const context = {
    scopeKey: 'workspace-a:session-a',
    generation: 3,
  } as const;
  const direct = probeDirectDaemonTranscript(daemonEvents, context, context);
  const directTail = probeDirectDaemonTranscript(
    daemonEvents.slice(1),
    context,
    context,
  );
  const acp = probeAcpTranscriptUpdates(acpUpdates, context, context);
  const acpTail = probeAcpTranscriptUpdates(
    acpUpdates.slice(1),
    context,
    context,
  );
  const liveProjector = new TranscriptUpdateIdentityProjector();
  const promptId = 'session-a########1';
  const liveUpdates = ['first ', 'second'].map((text) =>
    liveProjector.project(
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
      } as SessionUpdate,
      promptId,
    ),
  );
  const live = probeAcpTranscriptUpdates(liveUpdates, context, context);
  const liveTail = probeAcpTranscriptUpdates(
    liveUpdates.slice(1),
    context,
    context,
  );
  const directPassed = stableTailIdentity(direct, directTail);
  const acpPassed =
    stableTailIdentity(acp, acpTail) && stableTailIdentity(live, liveTail, 0);
  const blockers = [
    ...(directPassed ? [] : ['direct-daemon stable identity matrix failed']),
    ...(acpPassed ? [] : ['ACP stable identity matrix failed']),
  ];
  return {
    directDaemon: directPassed ? 'pass' : 'fail',
    acp: acpPassed ? 'pass' : 'fail',
    selectedPath: acpPassed ? 'acp' : directPassed ? 'direct-daemon' : null,
    blockers,
  };
}

function stableTailIdentity(
  complete: TranscriptAdapterProbeResult,
  tail: TranscriptAdapterProbeResult,
  completeOffset = 1,
): boolean {
  if (
    [...complete.diagnostics, ...tail.diagnostics].some(
      (diagnostic) => diagnostic.severity === 'error',
    )
  ) {
    return false;
  }
  if (
    JSON.stringify(
      complete.model.blocks.slice(completeOffset).map(({ id }) => id),
    ) !== JSON.stringify(tail.model.blocks.map(({ id }) => id))
  ) {
    return false;
  }
  const completeRender = probeTranscriptRenderIdentity(complete.model.blocks);
  const tailRender = probeTranscriptRenderIdentity(tail.model.blocks);
  return (
    JSON.stringify(completeRender.items.slice(completeOffset)) ===
      JSON.stringify(tailRender.items) &&
    JSON.stringify(actionIdentity(completeRender.actions.copyLastReply)) ===
      JSON.stringify(actionIdentity(tailRender.actions.copyLastReply)) &&
    JSON.stringify(completeRender.actions.openFiles) ===
      JSON.stringify(tailRender.actions.openFiles)
  );
}

function actionIdentity(
  action:
    | {
        readonly renderedItemId: string;
        readonly sourceBlockIds: readonly string[];
      }
    | undefined,
): unknown {
  return action
    ? {
        renderedItemId: action.renderedItemId,
        sourceBlockIds: action.sourceBlockIds,
      }
    : undefined;
}

function readJsonLines(path: string): unknown[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as unknown);
}

async function installNetworkAndCspProbe(
  page: Page,
): Promise<{ requests: string[]; cspErrors: string[] }> {
  const requests: string[] = [];
  const cspErrors: string[] = [];
  await page.route('**/*', async (route) => {
    requests.push(route.request().url());
    await route.abort('blockedbyclient');
  });
  page.on('console', (message) => {
    const text = message.text();
    if (/content security policy|refused to/i.test(text)) cspErrors.push(text);
  });
  return { requests, cspErrors };
}

describe('ExportTranscriptDocument browser gate', () => {
  let browser: Browser | undefined;

  afterEach(async () => {
    await browser?.close();
    browser = undefined;
  });

  it('keeps machine-readable schema limits aligned with runtime limits', () => {
    const schema = JSON.parse(
      readFileSync(
        resolve(
          repoRoot,
          'integration-tests/fixtures/chat-transcript-contract/v1/schema/export-transcript-document-v1.schema.json',
        ),
        'utf8',
      ),
    ) as Record<string, unknown>;
    const properties = schema['properties'] as Record<string, unknown>;
    const blocks = properties['blocks'] as Record<string, unknown>;
    const definitions = schema['$defs'] as Record<string, unknown>;
    const rasterImage = definitions['rasterImage'] as Record<string, unknown>;
    const rasterProperties = rasterImage['properties'] as Record<
      string,
      unknown
    >;
    const rasterData = rasterProperties['data'] as Record<string, unknown>;
    const rasterMimeType = rasterProperties['mimeType'] as {
      enum: readonly string[];
    };
    const toolPreview = definitions['toolPreview'] as {
      oneOf: Array<Record<string, unknown>>;
    };
    const imageGeneration = toolPreview.oneOf.find(
      (entry) =>
        (
          (entry['properties'] as Record<string, unknown> | undefined)?.[
            'kind'
          ] as Record<string, unknown> | undefined
        )?.['const'] === 'image_generation',
    );
    const thumbnailUrl = (
      imageGeneration?.['properties'] as Record<string, unknown>
    )['thumbnailUrl'] as Record<string, unknown>;

    expect(blocks['maxItems']).toBe(EXPORT_TRANSCRIPT_LIMITS_V1.maxBlocks);
    expect(rasterData['maxLength']).toBe(
      Math.ceil(EXPORT_TRANSCRIPT_LIMITS_V1.maxRasterBytes / 3) * 4,
    );
    expect(thumbnailUrl['maxLength']).toBe(
      Math.ceil(EXPORT_TRANSCRIPT_LIMITS_V1.maxRasterBytes / 3) * 4 + 23,
    );
    expect(rasterMimeType.enum.map((mimeType) => `data:${mimeType}`)).toEqual(
      expectedNetwork.allowedImageSources,
    );
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (!value || typeof value !== 'object') return;
      const entry = value as Record<string, unknown>;
      if (entry['type'] === 'array') {
        expect(Number(entry['maxItems'])).toBeLessThanOrEqual(
          EXPORT_TRANSCRIPT_LIMITS_V1.maxArrayLength,
        );
      }
      if (entry['type'] === 'integer') {
        expect(entry['maximum']).toBeDefined();
      }
      for (const child of Object.values(entry)) visit(child);
    };
    visit(schema);
  });

  it('opens, searches, copies, and prints the maximum document with zero network', async () => {
    const browserBundle = await getWebShellDocumentBundle();
    const exportDocument = createMaximumDocument();
    const serialized = JSON.stringify(exportDocument);
    const renderEvidence = probeTranscriptRenderIdentity(
      exportDocument.blocks,
      { safeToolProjection: true },
    );
    const renderedSourceBlockIds = new Set(
      renderEvidence.items.flatMap((item) => item.sourceBlockIds),
    );
    expect(exportDocument.blocks).toHaveLength(
      EXPORT_TRANSCRIPT_LIMITS_V1.maxBlocks,
    );
    expect(renderedSourceBlockIds).toEqual(
      new Set(exportDocument.blocks.map((block) => block.id)),
    );
    expect(exportDocument.metadata).toMatchObject({
      complete: true,
      truncated: false,
    });
    const envelopeBytes = new TextEncoder().encode(serialized).byteLength;
    expect(envelopeBytes).toBeLessThanOrEqual(
      EXPORT_TRANSCRIPT_LIMITS_V1.maxEnvelopeBytes,
    );
    expect(serialized).not.toContain(CANARY);

    browser = await chromium.launch({
      headless: true,
      args: ['--enable-precise-memory-info'],
    });
    const page = await browser.newPage();
    const probe = await installNetworkAndCspProbe(page);
    const startedAt = nodePerformance.now();
    const heapBefore = await page.evaluate(
      () =>
        (
          globalThis.performance as Performance & {
            memory?: { usedJSHeapSize: number };
          }
        ).memory?.usedJSHeapSize ?? 0,
    );

    await page.setContent(
      buildDocumentProbeHtml(exportDocument, browserBundle),
      {
        waitUntil: 'load',
      },
    );
    await expect
      .poll(() => page.locator('body').getAttribute('data-render-complete'))
      .toBe('true');
    await expect
      .poll(() => page.locator('div[class*="mermaidInline"] svg').count())
      .toBeGreaterThan(0);
    expect(await page.locator('.katex').count()).toBeGreaterThan(0);
    expect(
      await page.locator('[data-agent-status]').count(),
    ).toBeGreaterThanOrEqual(2);
    expect(await page.locator('[data-message-row-key]').count()).toBe(
      renderEvidence.items.length,
    );
    const interaction = await page.evaluate(() => {
      const bodyText = globalThis.document.body.innerText;
      const range = globalThis.document.createRange();
      range.selectNodeContents(globalThis.document.body);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      const copiedLength = selection?.toString().length ?? 0;
      selection?.removeAllRanges();
      const clippedByMaxHeight = Array.from(
        globalThis.document.querySelectorAll<HTMLElement>('*'),
      )
        .filter((element) => {
          const style = getComputedStyle(element);
          return (
            style.display !== 'none' &&
            style.maxHeight !== 'none' &&
            element.scrollHeight > element.clientHeight + 1
          );
        })
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          className: element.className,
          maxHeight: getComputedStyle(element).maxHeight,
        }));
      return {
        firstFound: bodyText.includes('FIRST_SEARCH_NEEDLE'),
        lastFound: bodyText.includes('LAST_SEARCH_NEEDLE'),
        thinkingFound: bodyText.includes('DOCUMENT_THINKING_DETAIL'),
        toolFound: bodyText.includes('DOCUMENT_TOOL_DETAIL'),
        richFound: bodyText.includes('DOCUMENT_RICH_CONTENT'),
        chartFallbackFound: bodyText.includes('DOCUMENT_CHART_FALLBACK'),
        subagentResultFound: bodyText.includes('DOCUMENT_SUBAGENT_RESULT'),
        subagentStreamFound: bodyText.includes('DOCUMENT_SUBAGENT_STREAM'),
        nestedToolFound: bodyText.includes('DOCUMENT_NESTED_TOOL_DETAIL'),
        parallelAgentFound: bodyText.includes('DOCUMENT_PARALLEL_AGENT_RESULT'),
        userShellFound: bodyText.includes('DOCUMENT_USER_SHELL_DETAIL'),
        diffFound: bodyText.includes('DOCUMENT_DIFF_DETAIL'),
        copiedLength,
        clippedByMaxHeight,
      };
    });
    const pdf = await page.pdf({ printBackground: false });
    const heapAfter = await page.evaluate(
      () =>
        (
          globalThis.performance as Performance & {
            memory?: { usedJSHeapSize: number };
          }
        ).memory?.usedJSHeapSize ?? 0,
    );
    const durationMs = nodePerformance.now() - startedAt;

    expect(interaction).toMatchObject({
      firstFound: true,
      lastFound: true,
      thinkingFound: true,
      toolFound: true,
      richFound: true,
      chartFallbackFound: true,
      subagentResultFound: true,
      subagentStreamFound: true,
      nestedToolFound: true,
      parallelAgentFound: true,
      userShellFound: true,
      diffFound: true,
      clippedByMaxHeight: [],
    });
    expect(interaction.copiedLength).toBeGreaterThan(7_000_000);
    expect(pdf.byteLength).toBeGreaterThan(1_000);
    expect(probe.requests).toHaveLength(expectedNetwork.unexpectedRequests);
    expect(probe.cspErrors, probe.cspErrors.join('\n')).toHaveLength(
      expectedNetwork.cspViolations,
    );
    expect(durationMs).toBeLessThan(MAX_DOCUMENT_DURATION_MS);
    const heapDeltaBytes = Math.max(0, heapAfter - heapBefore);
    expect(heapDeltaBytes).toBeLessThan(MAX_HEAP_DELTA_BYTES);
    writeGateReport({
      durationMs,
      heapDeltaBytes,
      envelopeBytes,
      pdfBytes: pdf.byteLength,
      copiedLength: interaction.copiedLength,
      renderedItemCount: renderEvidence.items.length,
      sourceBlockCount: renderedSourceBlockIds.size,
      requests: probe.requests,
      cspErrors: probe.cspErrors,
    });

    await page.close();
    await browser.close();
    browser = undefined;
  }, 90_000);

  it('removes active Markdown resources before the browser envelope exists', async () => {
    const exportDocument = createExportTranscriptDocumentV1(
      [
        {
          ...record(
            'remote-image',
            null,
            'user',
            '![tracking](https://example.invalid/track.png)',
          ),
          rawInput: CANARY,
        },
      ],
      {
        startTime: '2026-08-16T00:00:00.000Z',
        metadata: {
          sessionId: CANARY,
          startTime: '2026-08-16T00:00:00.000Z',
          exportTime: EXPORTED_AT,
          cwd: '/workspace/project',
          gitRepo: 'qwen-code',
          gitBranch: 'contract-probe',
          model: 'synthetic-model',
          channel: 'cli',
          promptCount: 1,
          totalTokens: 1,
          filesWritten: 0,
          linesAdded: 0,
          linesRemoved: 0,
          uniqueFiles: [CANARY],
        },
      },
      { rendererVersion: RENDERER_VERSION, exportedAt: EXPORTED_AT },
    );
    const html = buildDocumentProbeHtml(
      exportDocument,
      await getWebShellDocumentBundle(),
    );

    expect(html).not.toContain('https://example.invalid');
    expect(html).not.toContain(CANARY);
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("object-src 'none'");
    expect(html).toContain("frame-src 'none'");
    expect(html).toContain("media-src 'none'");
  });
});
