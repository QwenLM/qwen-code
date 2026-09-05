import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance as nodePerformance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import {
  EXPORT_TRANSCRIPT_RENDERER_LIMITS,
  EXPORT_TRANSCRIPT_RENDERER_VERSION,
} from '@qwen-code/web-templates';
import {
  EXPORT_TRANSCRIPT_LIMITS_V1,
  createExportTranscriptDocumentV1,
  type ExportTranscriptBlockV1,
  type ExportTranscriptDocumentV1,
} from '../packages/cli/src/ui/utils/export/export-transcript-document.js';
import {
  renderExportTranscriptDocumentToHtml,
  toHtml,
} from '../packages/cli/src/ui/utils/export/formatters/html.js';
import { escapeJsonForHtmlScriptData } from '../packages/cli/src/ui/utils/export/html-script-data.js';

const RENDERER_VERSION = EXPORT_TRANSCRIPT_RENDERER_VERSION;
const RENDERER_URL = `https://unpkg.com/@qwen-code/qwen-code@${RENDERER_VERSION.split('+')[0]}/export-transcript-document.js`;
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

const rendererAssetPath = resolve(
  repoRoot,
  'packages/web-templates/src/export-html/dist/export-transcript-document.js',
);
const rendererAsset = readFileSync(rendererAssetPath, 'utf8');

const expectedNetwork = JSON.parse(
  readFileSync(
    resolve(fixtureRoot, 'cases/representative/expected-network.json'),
    'utf8',
  ),
) as ExpectedNetwork;

function replaceDocumentEnvelope(html: string, value: unknown): string {
  const idIndex = html.indexOf('id="transcript-document"');
  const openTagEnd = html.indexOf('>', idIndex);
  const closeTagStart = html.indexOf('</script>', openTagEnd);
  if (idIndex === -1 || openTagEnd === -1 || closeTagStart === -1) {
    throw new Error('Transcript document envelope is missing from test HTML.');
  }
  return `${html.slice(0, openTagEnd + 1)}${escapeJsonForHtmlScriptData(
    JSON.stringify(value),
  )}${html.slice(closeTagStart)}`;
}

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

async function installNetworkAndCspProbe(page: Page): Promise<{
  allowedScriptRequests: string[];
  unexpectedRequests: string[];
  cspErrors: string[];
}> {
  const allowedScriptRequests: string[] = [];
  const unexpectedRequests: string[] = [];
  const cspErrors: string[] = [];
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url === RENDERER_URL) {
      allowedScriptRequests.push(url);
      await route.fulfill({
        body: rendererAsset,
        contentType: 'text/javascript',
        headers: { 'access-control-allow-origin': '*' },
      });
      return;
    }
    unexpectedRequests.push(url);
    await route.abort('blockedbyclient');
  });
  page.on('console', (message) => {
    const text = message.text();
    if (/content security policy|refused to/i.test(text)) cspErrors.push(text);
  });
  return { allowedScriptRequests, unexpectedRequests, cspErrors };
}

async function expectConnectSrcCspEnforced(page: Page): Promise<void> {
  const directive = await page.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const timeout = window.setTimeout(
          () => reject(new Error('CSP violation was not observed.')),
          2_000,
        );
        window.addEventListener(
          'securitypolicyviolation',
          (event) => {
            window.clearTimeout(timeout);
            resolve(event.violatedDirective);
          },
          { once: true },
        );
        void fetch('https://qwen-csp-probe.invalid/connect').catch(() => {});
      }),
  );
  expect(directive).toBe('connect-src');
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
          'packages/cli/src/ui/utils/export/export-transcript-document-v1.schema.json',
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
    expect(EXPORT_TRANSCRIPT_RENDERER_LIMITS).toEqual({
      maxBlocks: EXPORT_TRANSCRIPT_LIMITS_V1.maxBlocks,
      maxEnvelopeBytes: EXPORT_TRANSCRIPT_LIMITS_V1.maxEnvelopeBytes,
    });
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
      if (entry['type'] === 'string') {
        expect(Number(entry['maxLength'])).toBeGreaterThan(0);
        expect(Number(entry['maxLength'])).toBeLessThanOrEqual(
          EXPORT_TRANSCRIPT_LIMITS_V1.maxEnvelopeBytes,
        );
      }
      for (const child of Object.values(entry)) visit(child);
    };
    visit(schema);
  });

  it('opens, searches, copies, and prints the maximum document with its pinned npm runtime', async () => {
    const exportDocument = createMaximumDocument();
    const serialized = JSON.stringify(exportDocument);
    const html = renderExportTranscriptDocumentToHtml(exportDocument);
    expect(exportDocument.blocks).toHaveLength(
      EXPORT_TRANSCRIPT_LIMITS_V1.maxBlocks,
    );
    expect(exportDocument.metadata).toMatchObject({
      complete: true,
      truncated: false,
    });
    const envelopeBytes = new TextEncoder().encode(
      escapeJsonForHtmlScriptData(serialized),
    ).byteLength;
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

    await page.setContent(html, { waitUntil: 'load' });
    await expect
      .poll(() => page.locator('body').getAttribute('data-render-complete'))
      .toBe('true');
    expect(await page.locator('[data-document-metadata]').isVisible()).toBe(
      true,
    );
    const expandAll = page.locator('[data-document-expand-all]');
    const collapseAll = page.locator('[data-document-collapse-all]');
    const themeToggle = page.locator('[data-document-theme-toggle]');
    expect(await expandAll.isDisabled()).toBe(true);
    expect(await collapseAll.isEnabled()).toBe(true);
    expect(await themeToggle.isVisible()).toBe(true);
    await collapseAll.click();
    expect(await expandAll.isEnabled()).toBe(true);
    expect(await collapseAll.isDisabled()).toBe(true);
    await expandAll.click();
    expect(await expandAll.isDisabled()).toBe(true);
    await themeToggle.click();
    expect(await page.locator('html').getAttribute('class')).toContain('light');
    await expect
      .poll(() => page.locator('div[class*="mermaidInline"] svg').count())
      .toBeGreaterThan(0);
    expect(await page.locator('.katex').count()).toBeGreaterThan(0);
    expect(
      await page.locator('[data-agent-status]').count(),
    ).toBeGreaterThanOrEqual(2);
    const renderedItemCount = await page
      .locator('[data-message-row-key]')
      .count();
    expect(renderedItemCount).toBeGreaterThan(0);
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
    expect(probe.unexpectedRequests).toHaveLength(
      expectedNetwork.unexpectedRequests,
    );
    expect(probe.allowedScriptRequests).toEqual(
      expect.arrayContaining([RENDERER_URL]),
    );
    expect(probe.cspErrors, probe.cspErrors.join('\n')).toHaveLength(
      expectedNetwork.cspViolations,
    );
    expect(await page.locator('body').innerText()).not.toMatch(
      /(?:1969-12-31|1970-01-01)/,
    );
    await expectConnectSrcCspEnforced(page);
    expect(durationMs).toBeLessThan(MAX_DOCUMENT_DURATION_MS);
    const heapDeltaBytes = Math.max(0, heapAfter - heapBefore);
    expect(heapDeltaBytes).toBeLessThan(MAX_HEAP_DELTA_BYTES);
    await page.close();
    await browser.close();
    browser = undefined;
  }, 90_000);

  it('renders a stable error page for incompatible document envelopes', async () => {
    const document = createExportTranscriptDocumentV1(
      [record('error-probe', null, 'user', 'Error probe')],
      {
        startTime: '2026-08-16T00:00:00.000Z',
        metadata: {
          sessionId: 'error-probe',
          startTime: '2026-08-16T00:00:00.000Z',
          exportTime: EXPORTED_AT,
          cwd: '/workspace/project',
          promptCount: 1,
          uniqueFiles: [],
        },
      },
      { rendererVersion: RENDERER_VERSION, exportedAt: EXPORTED_AT },
    );
    const html = renderExportTranscriptDocumentToHtml(document);
    const invalidDocuments = [
      { ...document, rendererVersion: 'incompatible-renderer' },
      {
        ...document,
        metadata: { ...document.metadata, title: { invalid: true } },
      },
    ];

    browser = await chromium.launch({ headless: true });
    for (const invalidDocument of invalidDocuments) {
      const page = await browser.newPage();
      const probe = await installNetworkAndCspProbe(page);
      await page.setContent(replaceDocumentEnvelope(html, invalidDocument), {
        waitUntil: 'load',
      });
      await expect
        .poll(() => page.locator('body').getAttribute('data-render-complete'))
        .toBe('error');
      expect(await page.getByRole('alert').textContent()).toContain(
        'Unable to open this chat export',
      );
      expect(probe.allowedScriptRequests).toEqual([RENDERER_URL]);
      expect(probe.unexpectedRequests).toHaveLength(
        expectedNetwork.unexpectedRequests,
      );
      expect(probe.cspErrors, probe.cspErrors.join('\n')).toHaveLength(
        expectedNetwork.cspViolations,
      );
      await page.close();
    }
  });

  it('fails closed when the CDN renderer is unavailable or fails integrity', async () => {
    const document = createExportTranscriptDocumentV1(
      [record('cdn-error', null, 'user', 'CDN error probe')],
      {
        startTime: '2026-08-16T00:00:00.000Z',
        metadata: {
          sessionId: 'cdn-error',
          startTime: '2026-08-16T00:00:00.000Z',
          exportTime: EXPORTED_AT,
          cwd: '/workspace/project',
          promptCount: 1,
          uniqueFiles: [],
        },
      },
      { rendererVersion: RENDERER_VERSION, exportedAt: EXPORTED_AT },
    );

    browser = await chromium.launch({ headless: true });
    for (const rendererBody of [null, 'throw new Error("broken renderer");']) {
      const page = await browser.newPage();
      await page.route('**/*', async (route) => {
        if (rendererBody && route.request().url() === RENDERER_URL) {
          await route.fulfill({
            body: rendererBody,
            contentType: 'text/javascript',
            headers: { 'access-control-allow-origin': '*' },
          });
        } else {
          await route.abort('blockedbyclient');
        }
      });
      await page.setContent(renderExportTranscriptDocumentToHtml(document), {
        waitUntil: 'load',
      });
      await expect
        .poll(() => page.locator('body').getAttribute('data-render-complete'))
        .toBe('error');
      expect(await page.getByRole('alert').textContent()).toContain(
        'Unable to load this chat export',
      );
      await page.close();
    }
  });

  it('runs the real HTML export entry point with its pinned npm runtime', async () => {
    const records = [
      {
        ...record(
          'remote-image',
          null,
          'assistant',
          [
            '![tracking](https://example.invalid/track.png)',
            '[![nested-tracking](https://example.invalid/nested-track.png?u=victim)](https://example.com)',
            '![inline-safe](data:image/png;base64,iVBORw0KGgo=)',
            'Literal closing tag: </script>',
          ].join('\n'),
        ),
        rawInput: CANARY,
      },
    ];
    const sessionData = {
      sessionId: CANARY,
      startTime: '2026-08-16T00:00:00.000Z',
      messages: [],
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
    };
    const html = toHtml(sessionData, records);

    expect(html).not.toContain('https://example.invalid');
    expect(html).not.toContain(CANARY);
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("object-src 'none'");
    expect(html).toContain("frame-src 'none'");
    expect(html).toContain("media-src 'none'");

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const probe = await installNetworkAndCspProbe(page);
    await page.setContent(html, { waitUntil: 'load' });
    await expect
      .poll(() => page.locator('body').getAttribute('data-render-complete'))
      .toBe('true');
    expect(await page.locator('body').innerText()).toContain(
      '[image omitted: tracking]',
    );
    expect(await page.locator('body').innerText()).toContain(
      '[image omitted: nested-tracking]',
    );
    expect(await page.locator('body').innerText()).toContain(
      'Literal closing tag: </script>',
    );
    expect(
      await page.locator('img[alt="inline-safe"]').getAttribute('src'),
    ).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(probe.unexpectedRequests).toHaveLength(
      expectedNetwork.unexpectedRequests,
    );
    expect(probe.allowedScriptRequests).toEqual([RENDERER_URL]);
    expect(probe.cspErrors, probe.cspErrors.join('\n')).toHaveLength(
      expectedNetwork.cspViolations,
    );
    expect(await page.locator('body').innerText()).not.toMatch(
      /(?:1969-12-31|1970-01-01)/,
    );
    await expectConnectSrcCspEnforced(page);
    await page.close();
    await browser.close();
    browser = undefined;
  });
});
