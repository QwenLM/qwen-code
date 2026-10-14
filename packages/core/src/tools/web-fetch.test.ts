/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  WebFetchTool,
  clearWebFetchCache,
  rewriteGitHubBlobUrl,
  sideQueryTimeoutMs,
} from './web-fetch.js';
import type { WebFetchToolParams } from './web-fetch.js';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/config.js';
import { ToolConfirmationOutcome } from './tools.js';
import { ToolErrorType } from './tool-error.js';
import * as fetchUtils from '../utils/fetch.js';
import type { FetchPolicyResponse } from '../utils/fetch.js';

// Mocks the underlying call BaseLlmClient.generateText makes; web-fetch's
// `runSideQuery` text-mode path lands on this mock.
const mockGenerateContent = vi.fn();
const mockGetBaseLlmClient = vi.fn(() => ({
  generateText: mockGenerateContent,
}));

vi.mock('../utils/fetch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof fetchUtils>();
  return {
    ...actual,
    fetchWithPolicy: vi.fn(),
  };
});

const mockExtractPDFText = vi.hoisted(() => vi.fn());
vi.mock('../utils/pdf.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/pdf.js')>();
  return {
    ...actual,
    extractPDFText: mockExtractPDFText,
  };
});

function okResponse(
  overrides: Partial<FetchPolicyResponse> = {},
): FetchPolicyResponse {
  return {
    kind: 'response',
    status: 200,
    statusText: 'OK',
    contentType: 'text/html',
    contentDisposition: '',
    body: Buffer.from('<html><body>Test content</body></html>'),
    finalUrl: 'https://example.com',
    ...overrides,
  };
}

const pdfBytes = Buffer.concat([
  Buffer.from('%PDF-1.4\n'),
  Buffer.from([0xe2, 0xe3, 0xcf, 0xd3, 0x00, 0x01, 0x02]),
]);
const PDF = { contentType: 'application/pdf', body: pdfBytes };

type Overrides = Partial<FetchPolicyResponse>;

/** Every fetch resolves `okResponse(overrides)`; returns the spy. */
const stubFetch = (overrides: Overrides = {}) =>
  vi
    .spyOn(fetchUtils, 'fetchWithPolicy')
    .mockResolvedValue(okResponse(overrides));

/** stubFetch plus a side query answering `{ text: 'Summary' }`. */
function stubSummary(overrides: Overrides = {}) {
  const fetchSpy = stubFetch(overrides);
  mockGenerateContent.mockResolvedValue({ text: 'Summary' });
  return fetchSpy;
}

/** The first fetch fails with a FetchError, the http fallback resolves. */
function stubHttpFallback(message: string, code: string, finalUrl: string) {
  const fetchSpy = vi
    .spyOn(fetchUtils, 'fetchWithPolicy')
    .mockRejectedValueOnce(new fetchUtils.FetchError(message, code))
    .mockResolvedValueOnce(okResponse({ finalUrl }));
  mockGenerateContent.mockResolvedValue({ text: 'Summary' });
  return fetchSpy;
}

const PROCESSED = { text: 'Processed' };
const PROCESSED_USAGE_UNSET = { text: 'Processed', usage: undefined };

describe('WebFetchTool', () => {
  let mockConfig: Config;
  let toolResultsDir: string;

  beforeEach(() => {
    vi.resetAllMocks();
    clearWebFetchCache();
    mockExtractPDFText.mockResolvedValue({
      success: false,
      error: 'pdftotext unavailable in tests',
    });
    toolResultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-fetch-test-'));
    mockConfig = {
      getApprovalMode: vi.fn(),
      setApprovalMode: vi.fn(),
      getProxy: vi.fn(),
      getBaseLlmClient: mockGetBaseLlmClient,
      getFastModel: vi.fn(() => undefined),
      getSessionId: vi.fn(() => 'test-session-id'),
      getModel: vi.fn(() => 'qwen-coder'),
      getCliVersion: vi.fn(() => '1.2.3'),
      getToolResultBytesWritten: vi.fn(() => 0),
      trackToolResultBytes: vi.fn(),
      storage: {
        getToolResultsDir: () => toolResultsDir,
      },
    } as unknown as Config;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(toolResultsDir, { recursive: true, force: true });
  });

  /** Builds and runs one call through a fresh tool. */
  const run = (
    url: string,
    prompt = 'summarize',
    opts: {
      signal?: AbortSignal;
      config?: Config;
      format?: WebFetchToolParams['format'];
    } = {},
  ) =>
    new WebFetchTool(opts.config ?? mockConfig)
      .build({ url, prompt, ...(opts.format && { format: opts.format }) })
      .execute(opts.signal ?? new AbortController().signal);

  /** Runs one fetch; `sent` is the text the side query (answering `reply`) received. */
  async function runCapturing(
    overrides: Overrides,
    reply: object,
    url: string,
    prompt?: string,
  ) {
    stubFetch(overrides);
    let sent = '';
    mockGenerateContent.mockImplementation((options) => {
      sent = options.contents[0].parts[0].text;
      return Promise.resolve(reply);
    });
    const result = await run(url, prompt);
    return { result, sent };
  }

  describe('execute', () => {
    it('should throw validation error when url parameter is missing', async () => {
      const tool = new WebFetchTool(mockConfig);
      const params = { prompt: 'no url here' };
      /* @ts-expect-error - we are testing validation */
      expect(() => tool.build(params)).toThrow(
        "params must have required property 'url'",
      );
    });

    it.each(['HTTPS://example.com', 'Http://example.com'])(
      'should accept uppercase http url schemes: %s',
      (url) => {
        const tool = new WebFetchTool(mockConfig);
        expect(() =>
          tool.build({ url, prompt: 'summarize this' }),
        ).not.toThrow();
      },
    );

    const notHttp =
      "The 'url' must be a valid URL starting with http:// or https://.";
    const malformed = "The 'url' is malformed and could not be parsed.";
    it.each([
      ['ftp://example.com', notHttp],
      ['http:example.com', notHttp],
      ['http:/example.com', notHttp],
      ['https://', malformed],
      ['http://[::1', malformed],
    ])(
      'should reject invalid or unsupported urls: %s',
      (url, expectedError) => {
        const tool = new WebFetchTool(mockConfig);
        expect(() => tool.build({ url, prompt: 'summarize this' })).toThrow(
          expectedError,
        );
      },
    );

    it.each([
      'https://user:secret@example.com/page',
      'http://user@example.com/page',
      'https://:secret@example.com/page',
      'https://%75ser@example.com/page',
    ])('should reject URLs containing credentials: %s', (url) => {
      const tool = new WebFetchTool(mockConfig);
      expect(() => tool.build({ url, prompt: 'summarize this' })).toThrow(
        "The 'url' must not include credentials.",
      );
    });

    it('should return WEB_FETCH_FALLBACK_FAILED on fetch failure', async () => {
      vi.spyOn(fetchUtils, 'fetchWithPolicy').mockRejectedValue(
        new Error('fetch failed'),
      );
      const result = await run('https://private.ip', 'summarize this');
      expect(result.error?.type).toBe(ToolErrorType.WEB_FETCH_FALLBACK_FAILED);
    });

    it('should fall back to raw content when side-query processing fails', async () => {
      stubFetch();
      mockGenerateContent.mockRejectedValue(new Error('API error'));
      const result = await run('https://public.ip', 'summarize this');
      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain('Content processing failed');
      expect(result.llmContent).toContain('Test content');
      expect(result.returnDisplay).toContain(
        'processing failed, raw content returned',
      );
    });

    it('should return an error result for non-2xx statuses', async () => {
      stubFetch({ status: 404, statusText: 'Not Found' });
      const result = await run('https://example.com/missing');
      expect(result.error?.type).toBe(ToolErrorType.WEB_FETCH_FALLBACK_FAILED);
      expect(result.llmContent).toContain('404 Not Found');
    });
  });

  describe('request headers', () => {
    it('should send a QwenCode User-Agent alongside Accept', async () => {
      const fetchSpy = stubSummary();

      await run('https://example.com');

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({
          headers: {
            Accept:
              'text/markdown, text/html;q=0.9, text/plain;q=0.8, */*;q=0.1',
            'User-Agent': `QwenCode/1.2.3 (${process.platform}; ${process.arch})`,
          },
        }),
      );
    });

    it.each([
      ['markdown', 'text/markdown, */*;q=0.1'],
      ['html', 'text/html, */*;q=0.1'],
      ['text', 'text/plain, */*;q=0.1'],
    ] as const)(
      'should map format=%s to the Accept header',
      async (format, accept) => {
        const fetchSpy = stubSummary();

        await run('https://example.com', 'summarize', { format });

        expect(fetchSpy).toHaveBeenCalledWith(
          'https://example.com',
          expect.objectContaining({
            headers: expect.objectContaining({ Accept: accept }),
          }),
        );
      },
    );

    /** Runs `url` and expects the fetch to have gone to `expected`. */
    async function expectFetchedAs(url: string, expected: string) {
      const fetchSpy = stubSummary();
      await run(url);
      expect(fetchSpy).toHaveBeenCalledWith(expected, expect.anything());
    }

    it.each([
      [
        'should upgrade http to https for public hosts',
        'http://example.com/page',
        'https://example.com/page',
      ],
      // A public IPv6 literal must not be caught by the single-label
      // internal-host heuristic just because its hostname has no dots.
      [
        'should upgrade public IPv6 literal hosts (bracketed, dot-free)',
        'http://[2606:4700:4700::1111]/x',
        'https://[2606:4700:4700::1111]/x',
      ],
      // NOT https://example.com:80/page — that would attempt TLS on port 80.
      [
        'should drop an explicit :80 when upgrading to https',
        'http://example.com:80/page',
        'https://example.com/page',
      ],
      [
        'should NOT upgrade explicit non-default http ports',
        'http://example.com:8080/api',
        'http://example.com:8080/api',
      ],
      [
        'should NOT upgrade http for localhost or private hosts',
        'http://localhost:3000/api',
        'http://localhost:3000/api',
      ],
    ])('%s', (_title, url, expected) => expectFetchedAs(url, expected));

    it.each([
      'http://dev.internal/status',
      'http://intranet/wiki',
      'http://host.docker.internal:8080/api',
      'http://nas.local/files',
    ])('should NOT upgrade internal hostname %s', (url) =>
      expectFetchedAs(url, url),
    );
  });

  describe('content handling', () => {
    it('should convert HTML to markdown preserving link hrefs', async () => {
      const { sent } = await runCapturing(
        {
          body: Buffer.from(
            '<html><body><p>See <a href="/docs/alpha-guide">the alpha guide</a>.</p></body></html>',
          ),
        },
        PROCESSED_USAGE_UNSET,
        'https://example.com',
        'list links',
      );

      expect(sent).toContain('[the alpha guide](/docs/alpha-guide)');
    });

    it('should convert the full HTML body before truncating, with an explicit marker', async () => {
      // Needle sits beyond 100k chars of markup-light content: the marker must
      // appear and the needle be gone, proving truncation happened AFTER
      // conversion (raw HTML truncation at 100k would also drop the early
      // content ratio entirely).
      const para = '<p>' + 'word '.repeat(40) + '</p>';
      const html =
        '<html><body>' +
        para.repeat(Math.ceil(110_000 / (para.length - 7))) +
        '<p>NEEDLE-AT-END</p></body></html>';

      const { sent } = await runCapturing(
        { body: Buffer.from(html) },
        PROCESSED_USAGE_UNSET,
        'https://example.com/large',
      );

      expect(sent).toContain('[Content truncated: showing first 100,000 of');
      expect(sent).not.toContain('NEEDLE-AT-END');
    });

    it('should keep content past 100k of raw HTML when the text itself fits', async () => {
      // Heavy markup, light text: 150k+ of raw HTML converts to well under 100k
      // of markdown, so a needle at the very end must survive (the Gist-class
      // regression).
      const item =
        '<li class="item-row"><span class="meta-label">entry</span> <a href="/files/f.txt">f</a></li>';
      const html =
        '<html><body><ul>' +
        item.repeat(Math.ceil(150_000 / item.length)) +
        '<li><a href="/gists/NEEDLE-TARGET-a4b16">NEEDLE-GIST-LINK</a></li></ul></body></html>';
      expect(html.length).toBeGreaterThan(150_000);

      const { sent } = await runCapturing(
        { body: Buffer.from(html) },
        PROCESSED_USAGE_UNSET,
        'https://example.com/gists',
        'find the needle',
      );

      expect(sent).toContain('NEEDLE-GIST-LINK');
      expect(sent).toContain('/gists/NEEDLE-TARGET-a4b16');
    });

    it('should drop images (incl. data URIs) but keep anchor hrefs', async () => {
      const { sent } = await runCapturing(
        {
          body: Buffer.from(
            '<html><body><img src="data:image/png;base64,AAAABBBBCCCC" alt="hero">' +
              '<p>ARTICLE-TEXT with <a href="/docs/guide">a link</a></p></body></html>',
          ),
        },
        PROCESSED,
        'https://example.com/article',
      );

      expect(sent).toContain('ARTICLE-TEXT');
      expect(sent).toContain('(/docs/guide)');
      expect(sent).not.toContain('data:image');
      expect(sent).not.toContain('![');
    });

    it('should strip script/style/noscript content before conversion', async () => {
      const { sent } = await runCapturing(
        {
          body: Buffer.from(
            '<html><head><style>.hydration{color:red}</style><script>window.__BLOB__="HYDRATION-GARBAGE";</script></head>' +
              '<body><noscript>NOSCRIPT-TEXT</noscript><p>REAL-ARTICLE-TEXT</p></body></html>',
          ),
        },
        PROCESSED,
        'https://example.com/app',
      );

      expect(sent).toContain('REAL-ARTICLE-TEXT');
      expect(sent).not.toContain('HYDRATION-GARBAGE');
      expect(sent).not.toContain('.hydration');
      expect(sent).not.toContain('NOSCRIPT-TEXT');
    });

    it('should process JSON content returned by fallback content negotiation', async () => {
      const { sent } = await runCapturing(
        {
          contentType: 'application/json',
          body: Buffer.from(
            JSON.stringify({
              published_at: '2026-01-27T11:50:52Z',
              body: '<p>Release <b>notes</b></p>',
              desc: 'Use &amp; for ampersand',
            }),
          ),
        },
        PROCESSED_USAGE_UNSET,
        'https://api.github.com/repos/openai/codex/releases/tags/rust-v0.92.0',
        'report the published date',
      );

      expect(sent).toContain('published_at');
      expect(sent).toContain('2026-01-27T11:50:52Z');
      expect(sent).toContain('<p>Release <b>notes</b></p>');
      expect(sent).toContain('Use &amp; for ampersand');
    });

    it('should include markdown content in prompt when server returns markdown', async () => {
      const { sent } = await runCapturing(
        {
          contentType: 'text/markdown; charset=utf-8',
          body: Buffer.from('# Hello World\n\nThis is markdown content.'),
        },
        PROCESSED_USAGE_UNSET,
        'https://example.com',
      );

      expect(sent).toContain('# Hello World');
    });
  });

  describe('result shape', () => {
    it('should prefix llmContent with a metadata header and set a summary returnDisplay', async () => {
      stubFetch({
        body: Buffer.from('<html><body>hi</body></html>'),
        finalUrl: 'https://example.com',
      });
      mockGenerateContent.mockResolvedValue({ text: 'A summary.' });

      const result = await run('https://example.com');

      expect(result.llmContent).toContain('URL: https://example.com');
      expect(result.llmContent).toContain('Status: 200 OK');
      expect(result.llmContent).toContain('Content-Type: text/html');
      expect(result.llmContent).toContain('A summary.');
      expect(result.returnDisplay).toMatch(
        /^Received 28 bytes \(200 OK\) from example\.com in \d+\.\ds$/,
      );
    });

    it('should note the final URL when redirects were followed', async () => {
      stubSummary({ finalUrl: 'https://example.com/moved-here' });

      const result = await run('https://example.com/old');

      expect(result.llmContent).toContain(
        'URL: https://example.com/old (final: https://example.com/moved-here)',
      );
    });

    it('should replace an empty side-query response with an explicit note', async () => {
      stubFetch();
      mockGenerateContent.mockResolvedValue({ text: '' });

      const result = await run('https://example.com');

      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain(
        'The processing model returned no content',
      );
    });
  });

  describe('side-query processing', () => {
    /** Fetches example.com under a fresh controller; `answer` plays the side query. */
    async function runAnswering(
      answer: (
        options: { abortSignal: AbortSignal; model?: string },
        controller: AbortController,
      ) => Promise<unknown>,
    ) {
      stubFetch();
      const controller = new AbortController();
      mockGenerateContent.mockImplementation((options) =>
        answer(options, controller),
      );
      const result = await run('https://example.com', 'summarize', {
        signal: controller.signal,
      });
      return { result, controller };
    }

    it('should stream on the fast model with maxAttempts 1 and a combined abort signal', async () => {
      vi.mocked(mockConfig.getFastModel).mockReturnValue('qwen-flash');
      let received: {
        stream?: boolean;
        model?: string;
        maxAttempts?: number;
        abortSignal?: AbortSignal;
      } = {};
      const { controller } = await runAnswering((options) => {
        received = options;
        return Promise.resolve({ text: 'Summary' });
      });

      expect(received.stream).toBe(true);
      expect(received.model).toBe('qwen-flash');
      expect(received.maxAttempts).toBe(1);
      // Combined signal: not the tool signal itself, but aborts with it.
      expect(received.abortSignal).not.toBe(controller.signal);
      expect(received.abortSignal?.aborted).toBe(false);
      controller.abort();
      expect(received.abortSignal?.aborted).toBe(true);
    });

    it('should use the main model when no fast model is configured', async () => {
      let receivedModel: string | undefined;
      await runAnswering((options) => {
        receivedModel = options.model;
        return Promise.resolve({ text: 'Summary' });
      });

      expect(receivedModel).toBe('qwen-coder');
    });

    it('should keep the persisted PDF and its extracted text when processing fails', async () => {
      stubFetch(PDF);
      mockExtractPDFText.mockResolvedValue({
        success: true,
        text: 'Bid item 24Z010: $1,234.56',
      });
      mockGenerateContent.mockRejectedValue(new Error('Request timed out.'));

      const result = await run(
        'https://example.com/doc.pdf',
        'list ALL bid items',
      );

      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain('Content processing failed');
      expect(result.llmContent).toContain('Bid item 24Z010: $1,234.56');
      expect(result.resultFilePaths).toHaveLength(1);
      expect(result.llmContent).toContain('saved to');
    });

    it('should fall back with raw content when the processing backstop fires, without aborting the tool signal', async () => {
      vi.stubEnv('QWEN_WEB_FETCH_PROCESSING_TIMEOUT_MS', '50');
      // Hangs until the composed signal (carrying the backstop timeout) aborts
      // it — simulating a stalled provider stream.
      const { result, controller } = await runAnswering(
        ({ abortSignal }) =>
          new Promise((_resolve, reject) => {
            abortSignal.addEventListener('abort', () =>
              reject(new Error('Request was aborted.')),
            );
          }),
      );

      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain('Content processing failed');
      expect(result.llmContent).toContain('Test content');
      expect(controller.signal.aborted).toBe(false);
    });

    it('should not return a late side-query success after the user aborts', async () => {
      // The final stream chunk can already be queued when the user aborts:
      // the side query then resolves successfully despite the abort.
      const { result } = await runAnswering((_options, controller) => {
        controller.abort();
        return Promise.resolve({ text: 'Late success' });
      });

      expect(result.error?.type).toBe(ToolErrorType.WEB_FETCH_FALLBACK_FAILED);
      expect(result.llmContent).not.toContain('Late success');
      expect(result.llmContent).not.toContain('Test content');
    });

    it.each([
      ['unset', undefined, 300_000],
      ['empty', '', 300_000],
      ['fraction', '0.5', 300_000],
      ['scientific notation', '1e3', 300_000],
      ['hexadecimal', '0x32', 300_000],
      ['zero', '0', 300_000],
      ['negative', '-5', 300_000],
      ['non-numeric', 'abc', 300_000],
      ['timer overflow', '2147483648', 300_000],
      ['max timer delay', '2147483647', 2_147_483_647],
      ['valid decimal', '50', 50],
    ])(
      'should resolve the backstop timeout for %s env values',
      (_label, envValue, expected) => {
        if (envValue === undefined) {
          vi.stubEnv('QWEN_WEB_FETCH_PROCESSING_TIMEOUT_MS', '');
          delete process.env['QWEN_WEB_FETCH_PROCESSING_TIMEOUT_MS'];
        } else {
          vi.stubEnv('QWEN_WEB_FETCH_PROCESSING_TIMEOUT_MS', envValue);
        }
        expect(sideQueryTimeoutMs()).toBe(expected);
      },
    );

    it('should return a proper error result when aborted with a non-Error reason', async () => {
      // Session.ts aborts with a plain string reason; throwIfAborted rethrows
      // it as-is, so the error path must not assume an Error instance.
      const { result } = await runAnswering((_options, controller) => {
        controller.abort('qwen:user-cancel');
        return Promise.resolve({ text: 'Late success' });
      });

      expect(result.error?.type).toBe(ToolErrorType.WEB_FETCH_FALLBACK_FAILED);
      expect(result.llmContent).toContain('qwen:user-cancel');
      expect(result.llmContent).not.toContain('undefined');
      expect(result.llmContent).not.toContain('Late success');
    });

    it('should propagate a user abort instead of fabricating a raw-content result', async () => {
      const { result } = await runAnswering((_options, controller) => {
        controller.abort();
        return Promise.reject(new Error('Request was aborted.'));
      });

      expect(result.error?.type).toBe(ToolErrorType.WEB_FETCH_FALLBACK_FAILED);
      expect(result.llmContent).not.toContain('Test content');
    });
  });

  describe('cross-host redirects', () => {
    it('should surface the redirect instead of content, without a side query', async () => {
      vi.spyOn(fetchUtils, 'fetchWithPolicy').mockResolvedValue({
        kind: 'cross-host-redirect',
        originalUrl: 'https://example.com/r',
        redirectUrl: 'https://other.example.org/target',
        status: 302,
      });

      const result = await run('https://example.com/r', 'what is here?');

      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain('REDIRECT DETECTED');
      expect(result.llmContent).toContain('https://other.example.org/target');
      expect(result.llmContent).toContain('what is here?');
      expect(mockGenerateContent).not.toHaveBeenCalled();
    });
  });

  describe('binary content', () => {
    it('should treat textual application types (yaml/ndjson) as text', async () => {
      const { result, sent } = await runCapturing(
        {
          contentType: 'application/yaml',
          body: Buffer.from('service:\n  name: fixture-yaml-value\n'),
        },
        PROCESSED,
        'https://example.com/config.yaml',
      );

      // Regression guard: yaml endpoints must not be persisted as .bin with an
      // empty side-query.
      expect(sent).toContain('fixture-yaml-value');
      expect(result.llmContent).not.toContain('[Binary content');
      expect(fs.readdirSync(toolResultsDir)).toEqual([]);
    });

    it('should treat a headerless recognized .bin filename as binary', async () => {
      stubFetch({
        contentType: '',
        body: Buffer.alloc(64, 0x7f),
        finalUrl: 'https://example.com/firmware.bin',
      });

      const result = await run('https://example.com/firmware.bin', 'what?');

      expect(result.llmContent).toMatch(/saved to \S+\.bin\.\]/);
      expect(mockGenerateContent).not.toHaveBeenCalled();
    });

    it('should treat a headerless .svg as text, not binary', async () => {
      const { result, sent } = await runCapturing(
        {
          contentType: '',
          body: Buffer.from(
            '<svg xmlns="http://www.w3.org/2000/svg"><title>SVG-TITLE-TEXT</title></svg>',
          ),
          finalUrl: 'https://example.com/logo.svg',
        },
        PROCESSED,
        'https://example.com/logo.svg',
        'describe',
      );

      expect(sent).toContain('SVG-TITLE-TEXT');
      expect(result.llmContent).not.toContain('[Binary content');
    });

    it('should persist extension-recognized binaries when Content-Type is absent', async () => {
      const pngBytes = Buffer.concat([
        Buffer.from([0x89]),
        Buffer.from('PNG\r\n'),
        Buffer.from([0x1a, 0x0a, 0x00, 0x01]),
      ]);
      stubFetch({
        contentType: '',
        body: pngBytes,
        finalUrl: 'https://example.com/photo.png',
      });

      const result = await run('https://example.com/photo.png', 'describe');

      expect(result.llmContent).toMatch(/saved to \S+\.png\./);
      expect(result.llmContent).not.toContain('�');
      expect(mockGenerateContent).not.toHaveBeenCalled();
    });

    it('should refuse to persist when the session disk budget is exhausted', async () => {
      stubFetch(PDF);
      const cappedConfig = {
        ...mockConfig,
        getToolResultBytesWritten: () => 500 * 1024 * 1024,
      } as unknown as Config;

      const result = await run('https://example.com/doc.pdf', 'read it', {
        config: cappedConfig,
      });

      expect(result.error?.type).toBe(ToolErrorType.WEB_FETCH_FALLBACK_FAILED);
      expect(result.llmContent).toContain('disk budget is exhausted');
      expect(fs.readdirSync(toolResultsDir)).toEqual([]);
    });

    it('should pass the abort signal to PDF extraction', async () => {
      stubSummary(PDF);
      mockExtractPDFText.mockResolvedValue({ success: true, text: 'text' });

      const controller = new AbortController();
      await run('https://example.com/doc.pdf', 'read it', {
        signal: controller.signal,
      });

      expect(mockExtractPDFText).toHaveBeenCalledWith(
        expect.stringMatching(/\.pdf$/),
        { signal: controller.signal },
      );
    });

    it('should persist PDFs, extract their text, and summarize it', async () => {
      mockExtractPDFText.mockResolvedValue({
        success: true,
        text: 'CY 2025 tribal FQHC PPS rate: $718.00',
      });
      const { result, sent } = await runCapturing(
        PDF,
        { text: 'The rate is $718.00.' },
        'https://example.com/doc.pdf',
        'what is the rate?',
      );

      // Extracted PDF text — not mojibake — reaches the side-query.
      expect(sent).toContain('$718.00');
      expect(sent).not.toContain('�');
      expect(result.llmContent).toContain('The rate is $718.00.');
      expect(result.llmContent).toMatch(
        /\[Binary content \(application\/pdf, .+\) saved to .+webfetch-.+\.pdf\. Use read_file to examine it \(reads PDFs natively; pass pages for large files\)\.\]/,
      );
      const savedPath = (result.llmContent as string).match(
        /saved to (\S+\.pdf)\./,
      )?.[1];
      expect(savedPath).toBeDefined();
      expect(fs.readFileSync(savedPath!)).toEqual(pdfBytes);
      expect(result.resultFilePaths).toEqual([savedPath]);

      // A same-session repeat is a cache hit: no second fetch, extraction, or
      // budget charge — and the persisted-file wiring survives the hit.
      const repeat = await run('https://example.com/doc.pdf', 'again?');
      expect(fetchUtils.fetchWithPolicy).toHaveBeenCalledTimes(1);
      expect(mockExtractPDFText).toHaveBeenCalledTimes(1);
      expect(vi.mocked(mockConfig.trackToolResultBytes).mock.calls).toEqual([
        [pdfBytes.length],
      ]);
      expect(repeat.resultFilePaths).toEqual([savedPath]);
      expect(repeat.llmContent).toContain(`saved to ${savedPath}`);
    });

    it('should skip the side-query when PDF extraction fails, with no mojibake', async () => {
      stubFetch(PDF);
      // beforeEach default: extraction unavailable

      const result = await run(
        'https://example.com/doc.pdf',
        'what does it say?',
      );

      expect(mockGenerateContent).not.toHaveBeenCalled();
      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain(
        'No text could be extracted from this binary content',
      );
      expect(result.llmContent).not.toContain('�');
      expect(result.llmContent).toContain('saved to');
    });

    it('should sniff mislabeled PDFs (application/octet-stream) via magic bytes', async () => {
      stubFetch({
        contentType: 'application/octet-stream',
        body: pdfBytes,
        finalUrl: 'https://example.com/download',
      });
      mockExtractPDFText.mockResolvedValue({
        success: true,
        text: 'Hidden PDF text',
      });
      mockGenerateContent.mockResolvedValue({ text: 'Summary of PDF' });

      const result = await run('https://example.com/download');

      // Saved as .pdf and reported as application/pdf despite the header.
      expect(result.llmContent).toMatch(/saved to \S+\.pdf\./);
      expect(result.llmContent).toContain('(application/pdf');
      expect(mockExtractPDFText).toHaveBeenCalled();
    });

    it('should not suggest read_file for binaries it cannot display', async () => {
      stubFetch({
        contentType: 'application/octet-stream',
        body: Buffer.alloc(64, 0x81),
      });

      const result = await run('https://example.com/blob', 'what is this?');

      expect(result.llmContent).toMatch(/saved to \S+\.bin\.\]/);
      expect(result.llmContent).not.toContain('read_file');
      expect(mockGenerateContent).not.toHaveBeenCalled();
    });

    it('should treat printable octet-stream bodies as text, not .bin', async () => {
      // The reverse mislabel: .log/.patch text behind a misconfigured server.
      const { result, sent } = await runCapturing(
        {
          contentType: 'application/octet-stream',
          body: Buffer.from('commit 3f1a\nAuthor: dev\n\n    fix: patch\n'),
        },
        { text: 'A git log' },
        'https://example.com/raw',
        'what is this?',
      );

      expect(sent).toContain('fix: patch');
      expect(result.llmContent).not.toContain('[Binary content');
      expect(result.resultFilePaths).toBeUndefined();
    });

    it('should return an error when binary persistence fails', async () => {
      stubFetch(PDF);
      // Point the tool-results dir at an existing FILE so mkdir/write fails.
      const blockedPath = path.join(toolResultsDir, 'occupied');
      fs.writeFileSync(blockedPath, 'plain file');
      const brokenConfig = {
        ...mockConfig,
        storage: { getToolResultsDir: () => blockedPath },
      } as unknown as Config;

      const result = await run('https://example.com/doc.pdf', 'what is it?', {
        config: brokenConfig,
      });

      expect(result.error?.type).toBe(ToolErrorType.WEB_FETCH_FALLBACK_FAILED);
      expect(result.llmContent).toContain('failed to save');
      expect(mockGenerateContent).not.toHaveBeenCalled();
      // Reserve, then roll back: the disk budget must net to zero on failure.
      expect(vi.mocked(brokenConfig.trackToolResultBytes).mock.calls).toEqual([
        [pdfBytes.length],
        [-pdfBytes.length],
      ]);
    });

    it('should wire Content-Disposition through to the persisted extension', async () => {
      // Unit-covered in binary-content.test.ts; this locks the wiring from the
      // response header to sniffFileKind.
      stubFetch({
        contentType: 'application/octet-stream',
        contentDisposition: 'attachment; filename="report.xlsx"',
        body: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]),
      });
      const result = await run('https://example.com/download', 'what is it?');
      expect(result.resultFilePaths?.[0]).toMatch(/\.xlsx$/);
    });

    it('should not persist textual content', async () => {
      stubSummary();

      const result = await run('https://example.com');

      expect(result.llmContent).not.toContain('[Binary content');
      expect(fs.readdirSync(toolResultsDir)).toEqual([]);
    });
  });

  describe('permission model', () => {
    it('always asks — WebFetch is egress, never auto-allowed by host', async () => {
      const permissionFor = (url: string) =>
        new WebFetchTool(mockConfig)
          .build({ url, prompt: 'summarize' })
          .getDefaultPermission();
      // A curated docs host no longer auto-allows: a GET's path/query is an
      // exfiltration channel regardless of how trusted the host is.
      expect(
        await permissionFor('https://docs.python.org/3/library/json.html'),
      ).toBe('ask');
      // A directly requested curated raw URL no longer auto-allows either.
      expect(
        await permissionFor(
          'https://raw.githubusercontent.com/QwenLM/qwen-code/main/README.md',
        ),
      ).toBe('ask');
      // An arbitrary host asks, as it always did.
      expect(await permissionFor('https://example.com')).toBe('ask');
    });
  });

  describe('preapproved list — markdown passthrough only', () => {
    it('should gate the raw passthrough on the final URL, not the requested one', async () => {
      stubFetch({
        contentType: 'text/markdown',
        body: Buffer.from('# Raw QwenLM readme'),
        finalUrl:
          'https://raw.githubusercontent.com/QwenLM/qwen-code/main/README.md',
      });

      const result = await run(
        'https://github.com/QwenLM/qwen-code/blob/main/README.md',
      );

      expect(mockGenerateContent).not.toHaveBeenCalled();
      expect(result.llmContent).toContain('# Raw QwenLM readme');
    });

    it('should return preapproved markdown verbatim without a side query', async () => {
      stubFetch({
        contentType: 'text/markdown',
        body: Buffer.from('# JSON module\n\nDetailed raw docs.'),
        finalUrl: 'https://docs.python.org/3/library/json.md',
      });

      const result = await run('https://docs.python.org/3/library/json.md');

      expect(mockGenerateContent).not.toHaveBeenCalled();
      expect(result.llmContent).toContain('# JSON module');
      expect(result.llmContent).toContain('Detailed raw docs.');
      expect(result.llmContent).toContain('Status: 200 OK');
    });

    it('should still run the side query for non-preapproved markdown', async () => {
      stubSummary({
        contentType: 'text/markdown',
        body: Buffer.from('# Raw docs'),
      });

      const result = await run('https://example.com/readme.md');

      expect(mockGenerateContent).toHaveBeenCalled();
      expect(result.llmContent).toContain('Summary');
    });
  });

  describe('cache', () => {
    it('should serve a repeat fetch from cache until the TTL expires', async () => {
      vi.useFakeTimers();
      try {
        const fetchSpy = stubSummary();

        await run('https://example.com');
        const result = await run('https://example.com', 'a different prompt');

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(result.error).toBeUndefined();
        // The side query still runs per-prompt; only the fetch is cached.
        expect(mockGenerateContent).toHaveBeenCalledTimes(2);

        // Past the 15-minute TTL the entry is stale and must be refetched.
        vi.advanceTimersByTime(15 * 60 * 1000 + 1);
        await run('https://example.com');
        expect(fetchSpy).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should key the cache on format as well as URL', async () => {
      const fetchSpy = stubSummary();

      await run('https://example.com', 'summarize', { format: 'html' });
      await run('https://example.com', 'summarize', { format: 'markdown' });

      // Different Accept headers can produce different responses — a URL-only
      // cache key would wrongly serve the html-format entry here.
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('should fall back to the original http URL on connection-level https failures', async () => {
      const url = 'http://wiki.corp.example.com/page';
      const fetchSpy = stubHttpFallback(
        'connect ECONNREFUSED',
        'ECONNREFUSED',
        url,
      );

      const result = await run(url, 'read');

      expect(result.error).toBeUndefined();
      expect(fetchSpy).toHaveBeenNthCalledWith(
        1,
        'https://wiki.corp.example.com/page',
        expect.anything(),
      );
      expect(fetchSpy).toHaveBeenNthCalledWith(2, url, expect.anything());
    });

    it('should fall back to http when the TLS handshake is reset', async () => {
      const url = 'http://legacy.example.com/page';
      const fetchSpy = stubHttpFallback('socket hang up', 'ECONNRESET', url);

      const result = await run(url, 'read');

      expect(result.error).toBeUndefined();
      expect(fetchSpy).toHaveBeenNthCalledWith(2, url, expect.anything());
    });

    it('should fall back to http when the upgraded host is unreachable (EHOSTUNREACH/ENETUNREACH)', async () => {
      // An ICMP host/network unreachable (a firewall REJECT, or a missing
      // route) fails the opportunistic https upgrade before any handshake,
      // with no RST for ECONNREFUSED to see — the http fallback must still
      // fire. (A silently DROPped port instead pends the connect and
      // surfaces as UND_ERR_CONNECT_TIMEOUT.)
      for (const code of ['EHOSTUNREACH', 'ENETUNREACH'] as const) {
        const fetchSpy = vi
          .spyOn(fetchUtils, 'fetchWithPolicy')
          .mockRejectedValueOnce(
            new fetchUtils.FetchError(`connect ${code} 203.0.113.1:443`, code),
          )
          .mockResolvedValueOnce(
            okResponse({ finalUrl: 'http://unreachable.example.com/page' }),
          );
        mockGenerateContent.mockResolvedValue({ text: 'Summary' });

        const result = await new WebFetchTool(mockConfig)
          .build({ url: 'http://unreachable.example.com/page', prompt: 'read' })
          .execute(new AbortController().signal);

        expect(result.error).toBeUndefined();
        expect(fetchSpy).toHaveBeenNthCalledWith(
          1,
          'https://unreachable.example.com/page',
          expect.anything(),
        );
        expect(fetchSpy).toHaveBeenNthCalledWith(
          2,
          'http://unreachable.example.com/page',
          expect.anything(),
        );
        fetchSpy.mockRestore();
      }
    });

    it('should fall back to http for curated-list hosts like any other', async () => {
      // The old auto-allow suppressed the fallback for preapproved hosts (their
      // grant was https-only). With no auto-allow, a curated docs host is
      // user-confirmed like any host and gets the same fallback.
      const url = 'http://react.dev/learn';
      const fetchSpy = stubHttpFallback('socket hang up', 'ECONNRESET', url);

      const result = await run(url, 'read');

      expect(result.error).toBeUndefined();
      expect(fetchSpy).toHaveBeenNthCalledWith(
        1,
        'https://react.dev/learn',
        expect.anything(),
      );
      expect(fetchSpy).toHaveBeenNthCalledWith(2, url, expect.anything());
    });

    it('should not fall back to http when the caller asked for https', async () => {
      vi.spyOn(fetchUtils, 'fetchWithPolicy').mockRejectedValue(
        new fetchUtils.FetchError('connect ECONNREFUSED', 'ECONNREFUSED'),
      );

      const result = await run('https://example.com/page', 'read');

      // No silent downgrade for explicit https URLs.
      expect(result.error?.type).toBe(ToolErrorType.WEB_FETCH_FALLBACK_FAILED);
      expect(fetchUtils.fetchWithPolicy).toHaveBeenCalledTimes(1);
    });

    it('should NOT cache an http-fallback response under the https key', async () => {
      // http://foo upgrades to https://foo, TLS fails, the plaintext fallback
      // succeeds. That content must not be cached under the https key, or a
      // later explicit https://foo fetch would get it without contacting the
      // TLS endpoint — a silent downgrade.
      const fetchSpy = stubHttpFallback(
        'socket hang up',
        'ECONNRESET',
        'http://legacy.example.com/page',
      )
        // A later explicit https fetch must hit the network, not the cache.
        .mockResolvedValueOnce(
          okResponse({ finalUrl: 'https://legacy.example.com/page' }),
        );

      await run('http://legacy.example.com/page', 'read');
      await run('https://legacy.example.com/page', 'read');

      // 2 for the first (upgrade + fallback) + 1 for the uncached https call.
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(fetchSpy).toHaveBeenNthCalledWith(
        3,
        'https://legacy.example.com/page',
        expect.anything(),
      );
    });

    it('should not serve cache entries across session swaps (/clear, /new)', async () => {
      const fetchSpy = stubSummary();
      let sessionId = 'session-a';
      const config = {
        ...mockConfig,
        getSessionId: () => sessionId,
      } as unknown as Config;

      await run('https://example.com', 'summarize', { config });
      // startNewSession keeps the same Config/Storage but changes the ID.
      sessionId = 'session-b';
      await run('https://example.com', 'summarize', { config });

      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('should invalidate the cache when the session storage is replaced', async () => {
      const fetchSpy = stubSummary();

      await run('https://example.com');
      // Simulate /cd: relocateWorkingDirectory replaces config.storage with a
      // new Storage object on the SAME Config.
      (mockConfig as unknown as { storage: unknown }).storage = {
        getToolResultsDir: () => toolResultsDir,
      };
      await run('https://example.com');

      // A stale entry (with old-workspace persisted paths) must not survive.
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('should not share the cache across Config instances', async () => {
      const fetchSpy = stubSummary();

      // A distinct session has its own Storage instance (the cache key).
      const otherConfig = {
        ...mockConfig,
        storage: { getToolResultsDir: () => toolResultsDir },
      } as unknown as Config;
      await run('https://example.com');
      await run('https://example.com', 'summarize', { config: otherConfig });

      // Two sessions (Configs) must not see each other's cached entries.
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('should not cache error responses', async () => {
      const fetchSpy = vi
        .spyOn(fetchUtils, 'fetchWithPolicy')
        .mockResolvedValueOnce(
          okResponse({ status: 500, statusText: 'Internal Server Error' }),
        )
        .mockResolvedValueOnce(okResponse());
      mockGenerateContent.mockResolvedValue({ text: 'Summary' });

      const firstResult = await run('https://example.com');
      expect(firstResult.error?.type).toBe(
        ToolErrorType.WEB_FETCH_FALLBACK_FAILED,
      );

      const secondResult = await run('https://example.com');
      expect(secondResult.error).toBeUndefined();
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('getConfirmationDetails', () => {
    /** Builds the call, expects 'ask', then the info confirmation for `target`. */
    async function expectAskThenConfirm(
      config: Config,
      params: WebFetchToolParams,
      target: string,
      host: string,
      beforeConfirm: (invocation: { params: unknown }) => void = () => {},
    ) {
      const invocation = new WebFetchTool(config).build(params);
      expect(await invocation.getDefaultPermission()).toBe('ask');
      beforeConfirm(invocation);

      expect(
        await invocation.getConfirmationDetails(new AbortController().signal),
      ).toEqual({
        type: 'info',
        title: 'Confirm Web Fetch',
        prompt: `Fetch content from ${target} and process with: ${params.prompt}`,
        urls: [target],
        permissionRules: [`WebFetch(${host})`],
        onConfirm: expect.any(Function),
      });
    }

    it('should return confirmation details with the correct prompt and urls', async () => {
      await expectAskThenConfirm(
        mockConfig,
        { url: 'https://example.com', prompt: 'summarize this page' },
        'https://example.com',
        'example.com',
      );
    });

    it('should normalize github blob urls to the raw destination in params and confirmation', async () => {
      const raw =
        'https://raw.githubusercontent.com/google/gemini-react/main/README.md';
      await expectAskThenConfirm(
        mockConfig,
        {
          url: 'https://github.com/google/gemini-react/blob/main/README.md',
          prompt: 'summarize the README',
        },
        raw,
        'raw.githubusercontent.com',
        (invocation) => {
          // The scheduler feeds invocation.params into permission-rule
          // evaluation — the normalized URL here is what makes an ask/deny
          // rule for raw.githubusercontent.com actually match.
          expect((invocation.params as { url: string }).url).toBe(raw);
        },
      );
    });

    it('should return ask even if approval mode is AUTO_EDIT (approval mode handled by scheduler)', async () => {
      await expectAskThenConfirm(
        {
          ...mockConfig,
          getApprovalMode: () => ApprovalMode.AUTO_EDIT,
        } as unknown as Config,
        { url: 'https://example.com', prompt: 'summarize this page' },
        'https://example.com',
        'example.com',
      );
    });

    it('should have onConfirm as a no-op (approval mode handled by scheduler)', async () => {
      const setApprovalMode = vi.fn();
      const testConfig = {
        ...mockConfig,
        setApprovalMode,
      } as unknown as Config;
      const invocation = new WebFetchTool(testConfig).build({
        url: 'https://example.com',
        prompt: 'summarize this page',
      });
      const confirmationDetails = await invocation.getConfirmationDetails(
        new AbortController().signal,
      );

      if (
        confirmationDetails &&
        typeof confirmationDetails === 'object' &&
        'onConfirm' in confirmationDetails
      ) {
        await confirmationDetails.onConfirm(
          ToolConfirmationOutcome.ProceedAlways,
        );
      }

      // setApprovalMode should NOT be called — onConfirm is a no-op
      expect(setApprovalMode).not.toHaveBeenCalled();
    });
  });
});

describe('rewriteGitHubBlobUrl', () => {
  it('rewrites github.com blob URLs to the raw host', () => {
    expect(
      rewriteGitHubBlobUrl('https://github.com/owner/repo/blob/main/README.md'),
    ).toBe('https://raw.githubusercontent.com/owner/repo/main/README.md');
  });

  it('rewrites www.github.com blob URLs too', () => {
    expect(
      rewriteGitHubBlobUrl('https://www.github.com/owner/repo/blob/main/f.ts'),
    ).toBe('https://raw.githubusercontent.com/owner/repo/main/f.ts');
  });

  it('only removes the /blob/ path segment, not later occurrences', () => {
    expect(
      rewriteGitHubBlobUrl(
        'https://github.com/owner/repo/blob/main/docs/blob/x.md',
      ),
    ).toBe('https://raw.githubusercontent.com/owner/repo/main/docs/blob/x.md');
  });

  it('never rewrites lookalike hosts containing github.com as a substring', () => {
    const url = 'https://evil-github.com/owner/repo/blob/main/secret.txt';
    expect(rewriteGitHubBlobUrl(url)).toBe(url);
  });

  it('never rewrites subdomains of github.com', () => {
    const url = 'https://gist.github.com/owner/repo/blob/main/f.txt';
    expect(rewriteGitHubBlobUrl(url)).toBe(url);
  });

  it('never rewrites URLs with github.com or /blob/ only in the path', () => {
    const url = 'https://example.com/github.com/blob/README.md';
    expect(rewriteGitHubBlobUrl(url)).toBe(url);
  });

  it('leaves non-blob github URLs and unparseable input untouched', () => {
    const plain = 'https://github.com/owner/repo/pull/1';
    expect(rewriteGitHubBlobUrl(plain)).toBe(plain);
    // /blob/ must sit after /owner/repo/, not at the path root.
    const shallow = 'https://github.com/blob/main/f.txt';
    expect(rewriteGitHubBlobUrl(shallow)).toBe(shallow);
    expect(rewriteGitHubBlobUrl('not a url')).toBe('not a url');
  });
});
