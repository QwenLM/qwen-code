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
} from './web-fetch.js';
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
    fs.rmSync(toolResultsDir, { recursive: true, force: true });
  });

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

    it.each([
      [
        'ftp://example.com',
        "The 'url' must be a valid URL starting with http:// or https://.",
      ],
      [
        'http:example.com',
        "The 'url' must be a valid URL starting with http:// or https://.",
      ],
      [
        'http:/example.com',
        "The 'url' must be a valid URL starting with http:// or https://.",
      ],
      ['https://', "The 'url' is malformed and could not be parsed."],
      ['http://[::1', "The 'url' is malformed and could not be parsed."],
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
      const tool = new WebFetchTool(mockConfig);
      const params = { url: 'https://private.ip', prompt: 'summarize this' };
      const invocation = tool.build(params);
      const result = await invocation.execute(new AbortController().signal);
      expect(result.error?.type).toBe(ToolErrorType.WEB_FETCH_FALLBACK_FAILED);
    });

    it('should return WEB_FETCH_FALLBACK_FAILED on API processing failure', async () => {
      vi.spyOn(fetchUtils, 'fetchWithPolicy').mockResolvedValue(okResponse());
      mockGenerateContent.mockRejectedValue(new Error('API error'));
      const tool = new WebFetchTool(mockConfig);
      const params = { url: 'https://public.ip', prompt: 'summarize this' };
      const invocation = tool.build(params);
      const result = await invocation.execute(new AbortController().signal);
      expect(result.error?.type).toBe(ToolErrorType.WEB_FETCH_FALLBACK_FAILED);
    });

    it('should return an error result for non-2xx statuses', async () => {
      vi.spyOn(fetchUtils, 'fetchWithPolicy').mockResolvedValue(
        okResponse({ status: 404, statusText: 'Not Found' }),
      );
      const tool = new WebFetchTool(mockConfig);
      const invocation = tool.build({
        url: 'https://example.com/missing',
        prompt: 'summarize',
      });
      const result = await invocation.execute(new AbortController().signal);
      expect(result.error?.type).toBe(ToolErrorType.WEB_FETCH_FALLBACK_FAILED);
      expect(result.llmContent).toContain('404 Not Found');
    });
  });

  describe('request headers', () => {
    it('should send a QwenCode User-Agent alongside Accept', async () => {
      const fetchSpy = vi
        .spyOn(fetchUtils, 'fetchWithPolicy')
        .mockResolvedValue(okResponse());
      mockGenerateContent.mockResolvedValue({ text: 'Summary' });

      const tool = new WebFetchTool(mockConfig);
      const invocation = tool.build({
        url: 'https://example.com',
        prompt: 'summarize',
      });
      await invocation.execute(new AbortController().signal);

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
        const fetchSpy = vi
          .spyOn(fetchUtils, 'fetchWithPolicy')
          .mockResolvedValue(okResponse());
        mockGenerateContent.mockResolvedValue({ text: 'Summary' });

        const tool = new WebFetchTool(mockConfig);
        const invocation = tool.build({
          url: 'https://example.com',
          prompt: 'summarize',
          format,
        });
        await invocation.execute(new AbortController().signal);

        expect(fetchSpy).toHaveBeenCalledWith(
          'https://example.com',
          expect.objectContaining({
            headers: expect.objectContaining({ Accept: accept }),
          }),
        );
      },
    );

    it('should upgrade http to https for public hosts', async () => {
      const fetchSpy = vi
        .spyOn(fetchUtils, 'fetchWithPolicy')
        .mockResolvedValue(okResponse());
      mockGenerateContent.mockResolvedValue({ text: 'Summary' });

      const tool = new WebFetchTool(mockConfig);
      const invocation = tool.build({
        url: 'http://example.com/page',
        prompt: 'summarize',
      });
      await invocation.execute(new AbortController().signal);

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://example.com/page',
        expect.anything(),
      );
    });

    it.each([
      'http://dev.internal/status',
      'http://intranet/wiki',
      'http://host.docker.internal:8080/api',
      'http://nas.local/files',
    ])('should NOT upgrade internal hostname %s', async (url) => {
      const fetchSpy = vi
        .spyOn(fetchUtils, 'fetchWithPolicy')
        .mockResolvedValue(okResponse());
      mockGenerateContent.mockResolvedValue({ text: 'Summary' });

      const tool = new WebFetchTool(mockConfig);
      await tool
        .build({ url, prompt: 'summarize' })
        .execute(new AbortController().signal);

      expect(fetchSpy).toHaveBeenCalledWith(url, expect.anything());
    });

    it('should upgrade public IPv6 literal hosts (bracketed, dot-free)', async () => {
      const fetchSpy = vi
        .spyOn(fetchUtils, 'fetchWithPolicy')
        .mockResolvedValue(okResponse());
      mockGenerateContent.mockResolvedValue({ text: 'Summary' });

      const tool = new WebFetchTool(mockConfig);
      await tool
        .build({ url: 'http://[2606:4700:4700::1111]/x', prompt: 'summarize' })
        .execute(new AbortController().signal);

      // A public IPv6 literal must not be caught by the single-label
      // internal-host heuristic just because its hostname has no dots.
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://[2606:4700:4700::1111]/x',
        expect.anything(),
      );
    });

    it('should drop an explicit :80 when upgrading to https', async () => {
      const fetchSpy = vi
        .spyOn(fetchUtils, 'fetchWithPolicy')
        .mockResolvedValue(okResponse());
      mockGenerateContent.mockResolvedValue({ text: 'Summary' });

      const tool = new WebFetchTool(mockConfig);
      await tool
        .build({ url: 'http://example.com:80/page', prompt: 'summarize' })
        .execute(new AbortController().signal);

      // NOT https://example.com:80/page — that would attempt TLS on port 80.
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://example.com/page',
        expect.anything(),
      );
    });

    it('should NOT upgrade explicit non-default http ports', async () => {
      const fetchSpy = vi
        .spyOn(fetchUtils, 'fetchWithPolicy')
        .mockResolvedValue(okResponse());
      mockGenerateContent.mockResolvedValue({ text: 'Summary' });

      const tool = new WebFetchTool(mockConfig);
      await tool
        .build({ url: 'http://example.com:8080/api', prompt: 'summarize' })
        .execute(new AbortController().signal);

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://example.com:8080/api',
        expect.anything(),
      );
    });

    it('should NOT upgrade http for localhost or private hosts', async () => {
      const fetchSpy = vi
        .spyOn(fetchUtils, 'fetchWithPolicy')
        .mockResolvedValue(okResponse());
      mockGenerateContent.mockResolvedValue({ text: 'Summary' });

      const tool = new WebFetchTool(mockConfig);
      const invocation = tool.build({
        url: 'http://localhost:3000/api',
        prompt: 'summarize',
      });
      await invocation.execute(new AbortController().signal);

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://localhost:3000/api',
        expect.anything(),
      );
    });
  });

  describe('content handling', () => {
    it('should convert HTML to markdown preserving link hrefs', async () => {
      let receivedContent = '';
      vi.spyOn(fetchUtils, 'fetchWithPolicy').mockResolvedValue(
        okResponse({
          body: Buffer.from(
            '<html><body><p>See <a href="/docs/alpha-guide">the alpha guide</a>.</p></body></html>',
          ),
        }),
      );
      mockGenerateContent.mockImplementation((options) => {
        receivedContent = options.contents[0].parts[0].text;
        return Promise.resolve({ text: 'Processed', usage: undefined });
      });

      const tool = new WebFetchTool(mockConfig);
      const invocation = tool.build({
        url: 'https://example.com',
        prompt: 'list links',
      });
      await invocation.execute(new AbortController().signal);

      expect(receivedContent).toContain('[the alpha guide](/docs/alpha-guide)');
    });

    it('should convert the full HTML body before truncating, with an explicit marker', async () => {
      // Needle sits beyond 100k chars of markup-light content; the marker
      // must appear and the needle must be gone from the truncated text,
      // proving truncation happened AFTER conversion (raw HTML truncation
      // at 100k would also drop the early content ratio entirely).
      const para = '<p>' + 'word '.repeat(40) + '</p>';
      const html =
        '<html><body>' +
        para.repeat(Math.ceil(110_000 / (para.length - 7))) +
        '<p>NEEDLE-AT-END</p></body></html>';
      let receivedContent = '';
      vi.spyOn(fetchUtils, 'fetchWithPolicy').mockResolvedValue(
        okResponse({ body: Buffer.from(html) }),
      );
      mockGenerateContent.mockImplementation((options) => {
        receivedContent = options.contents[0].parts[0].text;
        return Promise.resolve({ text: 'Processed', usage: undefined });
      });

      const tool = new WebFetchTool(mockConfig);
      const invocation = tool.build({
        url: 'https://example.com/large',
        prompt: 'summarize',
      });
      await invocation.execute(new AbortController().signal);

      expect(receivedContent).toContain(
        '[Content truncated: showing first 100,000 of',
      );
    });

    it('should keep content past 100k of raw HTML when the text itself fits', async () => {
      // Heavy markup, light text: 150k+ of raw HTML converts to well under
      // 100k of markdown, so a needle at the very end must survive. This is
      // the Gist-class regression test.
      const item =
        '<li class="item-row"><span class="meta-label">entry</span> <a href="/files/f.txt">f</a></li>';
      const html =
        '<html><body><ul>' +
        item.repeat(Math.ceil(150_000 / item.length)) +
        '<li><a href="/gists/NEEDLE-TARGET-a4b16">NEEDLE-GIST-LINK</a></li></ul></body></html>';
      expect(html.length).toBeGreaterThan(150_000);
      let receivedContent = '';
      vi.spyOn(fetchUtils, 'fetchWithPolicy').mockResolvedValue(
        okResponse({ body: Buffer.from(html) }),
      );
      mockGenerateContent.mockImplementation((options) => {
        receivedContent = options.contents[0].parts[0].text;
        return Promise.resolve({ text: 'Processed', usage: undefined });
      });

      const tool = new WebFetchTool(mockConfig);
      const invocation = tool.build({
        url: 'https://example.com/gists',
        prompt: 'find the needle',
      });
      await invocation.execute(new AbortController().signal);

      expect(receivedContent).toContain('NEEDLE-GIST-LINK');
      expect(receivedContent).toContain('/gists/NEEDLE-TARGET-a4b16');
    });

    it('should drop images (incl. data URIs) but keep anchor hrefs', async () => {
      let receivedContent = '';
      vi.spyOn(fetchUtils, 'fetchWithPolicy').mockResolvedValue(
        okResponse({
          body: Buffer.from(
            '<html><body><img src="data:image/png;base64,AAAABBBBCCCC" alt="hero">' +
              '<p>ARTICLE-TEXT with <a href="/docs/guide">a link</a></p></body></html>',
          ),
        }),
      );
      mockGenerateContent.mockImplementation((options) => {
        receivedContent = options.contents[0].parts[0].text;
        return Promise.resolve({ text: 'Processed' });
      });

      await new WebFetchTool(mockConfig)
        .build({ url: 'https://example.com/article', prompt: 'summarize' })
        .execute(new AbortController().signal);

      expect(receivedContent).toContain('ARTICLE-TEXT');
      expect(receivedContent).toContain('(/docs/guide)');
      expect(receivedContent).not.toContain('data:image');
      expect(receivedContent).not.toContain('![');
    });

    it('should strip script/style/noscript content before conversion', async () => {
      let receivedContent = '';
      vi.spyOn(fetchUtils, 'fetchWithPolicy').mockResolvedValue(
        okResponse({
          body: Buffer.from(
            '<html><head><style>.hydration{color:red}</style><script>window.__BLOB__="HYDRATION-GARBAGE";</script></head>' +
              '<body><noscript>NOSCRIPT-TEXT</noscript><p>REAL-ARTICLE-TEXT</p></body></html>',
          ),
        }),
      );
      mockGenerateContent.mockImplementation((options) => {
        receivedContent = options.contents[0].parts[0].text;
        return Promise.resolve({ text: 'Processed' });
      });

      await new WebFetchTool(mockConfig)
        .build({ url: 'https://example.com/app', prompt: 'summarize' })
        .execute(new AbortController().signal);

      expect(receivedContent).toContain('REAL-ARTICLE-TEXT');
      expect(receivedContent).not.toContain('HYDRATION-GARBAGE');
      expect(receivedContent).not.toContain('.hydration');
      expect(receivedContent).not.toContain('NOSCRIPT-TEXT');
    });

    it('should process JSON content returned by fallback content negotiation', async () => {
      let receivedContent = '';
      vi.spyOn(fetchUtils, 'fetchWithPolicy').mockResolvedValue(
        okResponse({
          contentType: 'application/json',
          body: Buffer.from(
            JSON.stringify({
              published_at: '2026-01-27T11:50:52Z',
              body: '<p>Release <b>notes</b></p>',
              desc: 'Use &amp; for ampersand',
            }),
          ),
        }),
      );
      mockGenerateContent.mockImplementation((options) => {
        receivedContent = options.contents[0].parts[0].text;
        return Promise.resolve({ text: 'Processed', usage: undefined });
      });

      const tool = new WebFetchTool(mockConfig);
      const invocation = tool.build({
        url: 'https://api.github.com/repos/openai/codex/releases/tags/rust-v0.92.0',
        prompt: 'report the published date',
      });
      await invocation.execute(new AbortController().signal);

      expect(receivedContent).toContain('published_at');
      expect(receivedContent).toContain('2026-01-27T11:50:52Z');
      expect(receivedContent).toContain('<p>Release <b>notes</b></p>');
      expect(receivedContent).toContain('Use &amp; for ampersand');
    });

    it('should include markdown content in prompt when server returns markdown', async () => {
      let receivedContent = '';
      vi.spyOn(fetchUtils, 'fetchWithPolicy').mockResolvedValue(
        okResponse({
          contentType: 'text/markdown; charset=utf-8',
          body: Buffer.from('# Hello World\n\nThis is markdown content.'),
        }),
      );
      mockGenerateContent.mockImplementation((options) => {
        receivedContent = options.contents[0].parts[0].text;
        return Promise.resolve({ text: 'Processed', usage: undefined });
      });

      const tool = new WebFetchTool(mockConfig);
      const invocation = tool.build({
        url: 'https://example.com',
        prompt: 'summarize',
      });
      await invocation.execute(new AbortController().signal);

      expect(receivedContent).toContain('# Hello World');
    });
  });

  describe('result shape', () => {
    it('should prefix llmContent with a metadata header and set a summary returnDisplay', async () => {
      vi.spyOn(fetchUtils, 'fetchWithPolicy').mockResolvedValue(
        okResponse({
          body: Buffer.from('<html><body>hi</body></html>'),
          finalUrl: 'https://example.com',
        }),
      );
      mockGenerateContent.mockResolvedValue({ text: 'A summary.' });

      const tool = new WebFetchTool(mockConfig);
      const invocation = tool.build({
        url: 'https://example.com',
        prompt: 'summarize',
      });
      const result = await invocation.execute(new AbortController().signal);

      expect(result.llmContent).toContain('URL: https://example.com');
      expect(result.llmContent).toContain('Status: 200 OK');
      expect(result.llmContent).toContain('Content-Type: text/html');
      expect(result.llmContent).toContain('A summary.');
      expect(result.returnDisplay).toMatch(
        /^Received 28 bytes \(200 OK\) from example\.com$/,
      );
    });

    it('should note the final URL when redirects were followed', async () => {
      vi.spyOn(fetchUtils, 'fetchWithPolicy').mockResolvedValue(
        okResponse({ finalUrl: 'https://example.com/moved-here' }),
      );
      mockGenerateContent.mockResolvedValue({ text: 'Summary' });

      const tool = new WebFetchTool(mockConfig);
      const invocation = tool.build({
        url: 'https://example.com/old',
        prompt: 'summarize',
      });
      const result = await invocation.execute(new AbortController().signal);

      expect(result.llmContent).toContain(
        'URL: https://example.com/old (final: https://example.com/moved-here)',
      );
    });

    it('should replace an empty side-query response with an explicit note', async () => {
      vi.spyOn(fetchUtils, 'fetchWithPolicy').mockResolvedValue(okResponse());
      mockGenerateContent.mockResolvedValue({ text: '' });

      const tool = new WebFetchTool(mockConfig);
      const invocation = tool.build({
        url: 'https://example.com',
        prompt: 'summarize',
      });
      const result = await invocation.execute(new AbortController().signal);

      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain(
        'The processing model returned no content',
      );
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

      const tool = new WebFetchTool(mockConfig);
      const invocation = tool.build({
        url: 'https://example.com/r',
        prompt: 'what is here?',
      });
      const result = await invocation.execute(new AbortController().signal);

      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain('REDIRECT DETECTED');
      expect(result.llmContent).toContain('https://other.example.org/target');
      expect(result.llmContent).toContain('what is here?');
      expect(mockGenerateContent).not.toHaveBeenCalled();
    });
  });

  describe('binary content', () => {
    const pdfBytes = Buffer.concat([
      Buffer.from('%PDF-1.4\n'),
      Buffer.from([0xe2, 0xe3, 0xcf, 0xd3, 0x00, 0x01, 0x02]),
    ]);

    it('should treat textual application types (yaml/ndjson) as text', async () => {
      let receivedContent = '';
      vi.spyOn(fetchUtils, 'fetchWithPolicy').mockResolvedValue(
        okResponse({
          contentType: 'application/yaml',
          body: Buffer.from('service:\n  name: fixture-yaml-value\n'),
        }),
      );
      mockGenerateContent.mockImplementation((options) => {
        receivedContent = options.contents[0].parts[0].text;
        return Promise.resolve({ text: 'Processed' });
      });

      const result = await new WebFetchTool(mockConfig)
        .build({ url: 'https://example.com/config.yaml', prompt: 'summarize' })
        .execute(new AbortController().signal);

      // Regression guard: yaml endpoints must not be persisted as .bin with
      // an empty side-query.
      expect(receivedContent).toContain('fixture-yaml-value');
      expect(result.llmContent).not.toContain('[Binary content');
      expect(fs.readdirSync(toolResultsDir)).toEqual([]);
    });

    it('should treat a headerless recognized .bin filename as binary', async () => {
      const firmware = Buffer.alloc(64, 0x7f);
      vi.spyOn(fetchUtils, 'fetchWithPolicy').mockResolvedValue(
        okResponse({
          contentType: '',
          body: firmware,
          finalUrl: 'https://example.com/firmware.bin',
        }),
      );

      const result = await new WebFetchTool(mockConfig)
        .build({ url: 'https://example.com/firmware.bin', prompt: 'what?' })
        .execute(new AbortController().signal);

      expect(result.llmContent).toMatch(/saved to \S+\.bin\.\]/);
      expect(mockGenerateContent).not.toHaveBeenCalled();
    });

    it('should treat a headerless .svg as text, not binary', async () => {
      let receivedContent = '';
      vi.spyOn(fetchUtils, 'fetchWithPolicy').mockResolvedValue(
        okResponse({
          contentType: '',
          body: Buffer.from(
            '<svg xmlns="http://www.w3.org/2000/svg"><title>SVG-TITLE-TEXT</title></svg>',
          ),
          finalUrl: 'https://example.com/logo.svg',
        }),
      );
      mockGenerateContent.mockImplementation((options) => {
        receivedContent = options.contents[0].parts[0].text;
        return Promise.resolve({ text: 'Processed' });
      });

      const result = await new WebFetchTool(mockConfig)
        .build({ url: 'https://example.com/logo.svg', prompt: 'describe' })
        .execute(new AbortController().signal);

      expect(receivedContent).toContain('SVG-TITLE-TEXT');
      expect(result.llmContent).not.toContain('[Binary content');
    });

    it('should persist extension-recognized binaries when Content-Type is absent', async () => {
      const pngBytes = Buffer.concat([
        Buffer.from([0x89]),
        Buffer.from('PNG\r\n'),
        Buffer.from([0x1a, 0x0a, 0x00, 0x01]),
      ]);
      vi.spyOn(fetchUtils, 'fetchWithPolicy').mockResolvedValue(
        okResponse({
          contentType: '',
          body: pngBytes,
          finalUrl: 'https://example.com/photo.png',
        }),
      );

      const result = await new WebFetchTool(mockConfig)
        .build({ url: 'https://example.com/photo.png', prompt: 'describe' })
        .execute(new AbortController().signal);

      expect(result.llmContent).toMatch(/saved to \S+\.png\./);
      expect(result.llmContent).not.toContain('�');
      expect(mockGenerateContent).not.toHaveBeenCalled();
    });

    it('should refuse to persist when the session disk budget is exhausted', async () => {
      vi.spyOn(fetchUtils, 'fetchWithPolicy').mockResolvedValue(
        okResponse({ contentType: 'application/pdf', body: pdfBytes }),
      );
      const cappedConfig = {
        ...mockConfig,
        getToolResultBytesWritten: () => 500 * 1024 * 1024,
      } as unknown as Config;

      const result = await new WebFetchTool(cappedConfig)
        .build({ url: 'https://example.com/doc.pdf', prompt: 'read it' })
        .execute(new AbortController().signal);

      expect(result.error?.type).toBe(ToolErrorType.WEB_FETCH_FALLBACK_FAILED);
      expect(result.llmContent).toContain('disk budget is exhausted');
      expect(fs.readdirSync(toolResultsDir)).toEqual([]);
    });

    it('should pass the abort signal to PDF extraction', async () => {
      vi.spyOn(fetchUtils, 'fetchWithPolicy').mockResolvedValue(
        okResponse({ contentType: 'application/pdf', body: pdfBytes }),
      );
      mockExtractPDFText.mockResolvedValue({ success: true, text: 'text' });
      mockGenerateContent.mockResolvedValue({ text: 'Summary' });

      const controller = new AbortController();
      await new WebFetchTool(mockConfig)
        .build({ url: 'https://example.com/doc.pdf', prompt: 'read it' })
        .execute(controller.signal);

      expect(mockExtractPDFText).toHaveBeenCalledWith(
        expect.stringMatching(/\.pdf$/),
        { signal: controller.signal },
      );
    });

    it('should persist PDFs, extract their text, and summarize it', async () => {
      vi.spyOn(fetchUtils, 'fetchWithPolicy').mockResolvedValue(
        okResponse({ contentType: 'application/pdf', body: pdfBytes }),
      );
      mockExtractPDFText.mockResolvedValue({
        success: true,
        text: 'CY 2025 tribal FQHC PPS rate: $718.00',
      });
      let receivedContent = '';
      mockGenerateContent.mockImplementation((options) => {
        receivedContent = options.contents[0].parts[0].text;
        return Promise.resolve({ text: 'The rate is $718.00.' });
      });

      const tool = new WebFetchTool(mockConfig);
      const invocation = tool.build({
        url: 'https://example.com/doc.pdf',
        prompt: 'what is the rate?',
      });
      const result = await invocation.execute(new AbortController().signal);

      // Extracted PDF text — not mojibake — reaches the side-query.
      expect(receivedContent).toContain('$718.00');
      expect(receivedContent).not.toContain('�');
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
    });

    it('should skip the side-query when PDF extraction fails, with no mojibake', async () => {
      vi.spyOn(fetchUtils, 'fetchWithPolicy').mockResolvedValue(
        okResponse({ contentType: 'application/pdf', body: pdfBytes }),
      );
      // beforeEach default: extraction unavailable

      const tool = new WebFetchTool(mockConfig);
      const invocation = tool.build({
        url: 'https://example.com/doc.pdf',
        prompt: 'what does it say?',
      });
      const result = await invocation.execute(new AbortController().signal);

      expect(mockGenerateContent).not.toHaveBeenCalled();
      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain(
        'No text could be extracted from this binary content',
      );
      expect(result.llmContent).not.toContain('�');
      expect(result.llmContent).toContain('saved to');
    });

    it('should sniff mislabeled PDFs (application/octet-stream) via magic bytes', async () => {
      vi.spyOn(fetchUtils, 'fetchWithPolicy').mockResolvedValue(
        okResponse({
          contentType: 'application/octet-stream',
          body: pdfBytes,
          finalUrl: 'https://example.com/download',
        }),
      );
      mockExtractPDFText.mockResolvedValue({
        success: true,
        text: 'Hidden PDF text',
      });
      mockGenerateContent.mockResolvedValue({ text: 'Summary of PDF' });

      const tool = new WebFetchTool(mockConfig);
      const invocation = tool.build({
        url: 'https://example.com/download',
        prompt: 'summarize',
      });
      const result = await invocation.execute(new AbortController().signal);

      // Saved as .pdf and reported as application/pdf despite the header.
      expect(result.llmContent).toMatch(/saved to \S+\.pdf\./);
      expect(result.llmContent).toContain('(application/pdf');
      expect(mockExtractPDFText).toHaveBeenCalled();
    });

    it('should not suggest read_file for binaries it cannot display', async () => {
      const junk = Buffer.alloc(64, 0x81);
      vi.spyOn(fetchUtils, 'fetchWithPolicy').mockResolvedValue(
        okResponse({ contentType: 'application/octet-stream', body: junk }),
      );

      const tool = new WebFetchTool(mockConfig);
      const invocation = tool.build({
        url: 'https://example.com/blob',
        prompt: 'what is this?',
      });
      const result = await invocation.execute(new AbortController().signal);

      expect(result.llmContent).toMatch(/saved to \S+\.bin\.\]/);
      expect(result.llmContent).not.toContain('read_file');
      expect(mockGenerateContent).not.toHaveBeenCalled();
    });

    it('should return an error when binary persistence fails', async () => {
      vi.spyOn(fetchUtils, 'fetchWithPolicy').mockResolvedValue(
        okResponse({ contentType: 'application/pdf', body: pdfBytes }),
      );
      // Point the tool-results dir at an existing FILE so mkdir/write fails.
      const blockedPath = path.join(toolResultsDir, 'occupied');
      fs.writeFileSync(blockedPath, 'plain file');
      const brokenConfig = {
        ...mockConfig,
        storage: { getToolResultsDir: () => blockedPath },
      } as unknown as Config;

      const result = await new WebFetchTool(brokenConfig)
        .build({ url: 'https://example.com/doc.pdf', prompt: 'what is it?' })
        .execute(new AbortController().signal);

      expect(result.error?.type).toBe(ToolErrorType.WEB_FETCH_FALLBACK_FAILED);
      expect(result.llmContent).toContain('failed to save');
      expect(mockGenerateContent).not.toHaveBeenCalled();
    });

    it('should not persist textual content', async () => {
      vi.spyOn(fetchUtils, 'fetchWithPolicy').mockResolvedValue(okResponse());
      mockGenerateContent.mockResolvedValue({ text: 'Summary' });

      const tool = new WebFetchTool(mockConfig);
      const invocation = tool.build({
        url: 'https://example.com',
        prompt: 'summarize',
      });
      const result = await invocation.execute(new AbortController().signal);

      expect(result.llmContent).not.toContain('[Binary content');
      expect(fs.readdirSync(toolResultsDir)).toEqual([]);
    });
  });

  describe('permission model', () => {
    it('always asks — WebFetch is egress, never auto-allowed by host', async () => {
      const tool = new WebFetchTool(mockConfig);
      // A curated docs host no longer auto-allows: a GET's path/query is an
      // exfiltration channel regardless of how trusted the host is.
      expect(
        await tool
          .build({
            url: 'https://docs.python.org/3/library/json.html',
            prompt: 'summarize',
          })
          .getDefaultPermission(),
      ).toBe('ask');
      // A directly requested curated raw URL no longer auto-allows either.
      expect(
        await tool
          .build({
            url: 'https://raw.githubusercontent.com/QwenLM/qwen-code/main/README.md',
            prompt: 'summarize',
          })
          .getDefaultPermission(),
      ).toBe('ask');
      // An arbitrary host asks, as it always did.
      expect(
        await tool
          .build({ url: 'https://example.com', prompt: 'summarize' })
          .getDefaultPermission(),
      ).toBe('ask');
    });
  });

  describe('preapproved list — markdown passthrough only', () => {
    it('should gate the raw passthrough on the final URL, not the requested one', async () => {
      vi.spyOn(fetchUtils, 'fetchWithPolicy').mockResolvedValue(
        okResponse({
          contentType: 'text/markdown',
          body: Buffer.from('# Raw QwenLM readme'),
          finalUrl:
            'https://raw.githubusercontent.com/QwenLM/qwen-code/main/README.md',
        }),
      );

      const tool = new WebFetchTool(mockConfig);
      const invocation = tool.build({
        url: 'https://github.com/QwenLM/qwen-code/blob/main/README.md',
        prompt: 'summarize',
      });
      const result = await invocation.execute(new AbortController().signal);

      expect(mockGenerateContent).not.toHaveBeenCalled();
      expect(result.llmContent).toContain('# Raw QwenLM readme');
    });

    it('should return preapproved markdown verbatim without a side query', async () => {
      vi.spyOn(fetchUtils, 'fetchWithPolicy').mockResolvedValue(
        okResponse({
          contentType: 'text/markdown',
          body: Buffer.from('# JSON module\n\nDetailed raw docs.'),
          finalUrl: 'https://docs.python.org/3/library/json.md',
        }),
      );

      const tool = new WebFetchTool(mockConfig);
      const invocation = tool.build({
        url: 'https://docs.python.org/3/library/json.md',
        prompt: 'summarize',
      });
      const result = await invocation.execute(new AbortController().signal);

      expect(mockGenerateContent).not.toHaveBeenCalled();
      expect(result.llmContent).toContain('# JSON module');
      expect(result.llmContent).toContain('Detailed raw docs.');
      expect(result.llmContent).toContain('Status: 200 OK');
    });

    it('should still run the side query for non-preapproved markdown', async () => {
      vi.spyOn(fetchUtils, 'fetchWithPolicy').mockResolvedValue(
        okResponse({
          contentType: 'text/markdown',
          body: Buffer.from('# Raw docs'),
        }),
      );
      mockGenerateContent.mockResolvedValue({ text: 'Summary' });

      const tool = new WebFetchTool(mockConfig);
      const invocation = tool.build({
        url: 'https://example.com/readme.md',
        prompt: 'summarize',
      });
      const result = await invocation.execute(new AbortController().signal);

      expect(mockGenerateContent).toHaveBeenCalled();
      expect(result.llmContent).toContain('Summary');
    });
  });

  describe('cache', () => {
    it('should serve a repeat fetch of the same URL from cache', async () => {
      const fetchSpy = vi
        .spyOn(fetchUtils, 'fetchWithPolicy')
        .mockResolvedValue(okResponse());
      mockGenerateContent.mockResolvedValue({ text: 'Summary' });

      const tool = new WebFetchTool(mockConfig);
      const first = tool.build({
        url: 'https://example.com',
        prompt: 'summarize',
      });
      await first.execute(new AbortController().signal);
      const second = tool.build({
        url: 'https://example.com',
        prompt: 'a different prompt',
      });
      const result = await second.execute(new AbortController().signal);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(result.error).toBeUndefined();
      // The side query still runs per-prompt; only the fetch is cached.
      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    });

    it('should key the cache on format as well as URL', async () => {
      const fetchSpy = vi
        .spyOn(fetchUtils, 'fetchWithPolicy')
        .mockResolvedValue(okResponse());
      mockGenerateContent.mockResolvedValue({ text: 'Summary' });

      const tool = new WebFetchTool(mockConfig);
      await tool
        .build({
          url: 'https://example.com',
          prompt: 'summarize',
          format: 'html',
        })
        .execute(new AbortController().signal);
      await tool
        .build({
          url: 'https://example.com',
          prompt: 'summarize',
          format: 'markdown',
        })
        .execute(new AbortController().signal);

      // Different Accept headers can produce different responses — a
      // URL-only cache key would wrongly serve the html-format entry here.
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('should fall back to the original http URL on connection-level https failures', async () => {
      const fetchSpy = vi
        .spyOn(fetchUtils, 'fetchWithPolicy')
        .mockRejectedValueOnce(
          new fetchUtils.FetchError('connect ECONNREFUSED', 'ECONNREFUSED'),
        )
        .mockResolvedValueOnce(
          okResponse({ finalUrl: 'http://wiki.corp.example.com/page' }),
        );
      mockGenerateContent.mockResolvedValue({ text: 'Summary' });

      const result = await new WebFetchTool(mockConfig)
        .build({ url: 'http://wiki.corp.example.com/page', prompt: 'read' })
        .execute(new AbortController().signal);

      expect(result.error).toBeUndefined();
      expect(fetchSpy).toHaveBeenNthCalledWith(
        1,
        'https://wiki.corp.example.com/page',
        expect.anything(),
      );
      expect(fetchSpy).toHaveBeenNthCalledWith(
        2,
        'http://wiki.corp.example.com/page',
        expect.anything(),
      );
    });

    it('should fall back to http when the TLS handshake is reset', async () => {
      const fetchSpy = vi
        .spyOn(fetchUtils, 'fetchWithPolicy')
        .mockRejectedValueOnce(
          new fetchUtils.FetchError('socket hang up', 'ECONNRESET'),
        )
        .mockResolvedValueOnce(
          okResponse({ finalUrl: 'http://legacy.example.com/page' }),
        );
      mockGenerateContent.mockResolvedValue({ text: 'Summary' });

      const result = await new WebFetchTool(mockConfig)
        .build({ url: 'http://legacy.example.com/page', prompt: 'read' })
        .execute(new AbortController().signal);

      expect(result.error).toBeUndefined();
      expect(fetchSpy).toHaveBeenNthCalledWith(
        2,
        'http://legacy.example.com/page',
        expect.anything(),
      );
    });

    it('should fall back to http for curated-list hosts like any other', async () => {
      // The old auto-allow suppressed the fallback for preapproved hosts
      // (their grant was https-only). With no auto-allow, a curated docs
      // host is user-confirmed like any host and gets the same fallback.
      const fetchSpy = vi
        .spyOn(fetchUtils, 'fetchWithPolicy')
        .mockRejectedValueOnce(
          new fetchUtils.FetchError('socket hang up', 'ECONNRESET'),
        )
        .mockResolvedValueOnce(
          okResponse({ finalUrl: 'http://react.dev/learn' }),
        );
      mockGenerateContent.mockResolvedValue({ text: 'Summary' });

      const result = await new WebFetchTool(mockConfig)
        .build({ url: 'http://react.dev/learn', prompt: 'read' })
        .execute(new AbortController().signal);

      expect(result.error).toBeUndefined();
      expect(fetchSpy).toHaveBeenNthCalledWith(
        1,
        'https://react.dev/learn',
        expect.anything(),
      );
      expect(fetchSpy).toHaveBeenNthCalledWith(
        2,
        'http://react.dev/learn',
        expect.anything(),
      );
    });

    it('should not fall back to http when the caller asked for https', async () => {
      vi.spyOn(fetchUtils, 'fetchWithPolicy').mockRejectedValue(
        new fetchUtils.FetchError('connect ECONNREFUSED', 'ECONNREFUSED'),
      );

      const result = await new WebFetchTool(mockConfig)
        .build({ url: 'https://example.com/page', prompt: 'read' })
        .execute(new AbortController().signal);

      // No silent downgrade for explicit https URLs.
      expect(result.error?.type).toBe(ToolErrorType.WEB_FETCH_FALLBACK_FAILED);
      expect(fetchUtils.fetchWithPolicy).toHaveBeenCalledTimes(1);
    });

    it('should NOT cache an http-fallback response under the https key', async () => {
      // http://foo upgrades to https://foo, TLS fails, plaintext fallback
      // succeeds. That plaintext content must not be cached under the https
      // key: a later explicit https://foo fetch would receive it without
      // contacting the TLS endpoint — a silent downgrade.
      const fetchSpy = vi
        .spyOn(fetchUtils, 'fetchWithPolicy')
        // First call: http://legacy.example.com upgraded to https → TLS reset.
        .mockRejectedValueOnce(
          new fetchUtils.FetchError('socket hang up', 'ECONNRESET'),
        )
        // Its http fallback succeeds.
        .mockResolvedValueOnce(
          okResponse({ finalUrl: 'http://legacy.example.com/page' }),
        )
        // A later explicit https fetch must hit the network, not the cache.
        .mockResolvedValueOnce(
          okResponse({ finalUrl: 'https://legacy.example.com/page' }),
        );
      mockGenerateContent.mockResolvedValue({ text: 'Summary' });

      const tool = new WebFetchTool(mockConfig);
      await tool
        .build({ url: 'http://legacy.example.com/page', prompt: 'read' })
        .execute(new AbortController().signal);
      await tool
        .build({ url: 'https://legacy.example.com/page', prompt: 'read' })
        .execute(new AbortController().signal);

      // 2 for the first (upgrade + fallback) + 1 for the uncached https call.
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(fetchSpy).toHaveBeenNthCalledWith(
        3,
        'https://legacy.example.com/page',
        expect.anything(),
      );
    });

    it('should not serve cache entries across session swaps (/clear, /new)', async () => {
      const fetchSpy = vi
        .spyOn(fetchUtils, 'fetchWithPolicy')
        .mockResolvedValue(okResponse());
      mockGenerateContent.mockResolvedValue({ text: 'Summary' });

      let sessionId = 'session-a';
      const swapConfig = {
        ...mockConfig,
        getSessionId: () => sessionId,
      } as unknown as Config;

      const tool = new WebFetchTool(swapConfig);
      await tool
        .build({ url: 'https://example.com', prompt: 'summarize' })
        .execute(new AbortController().signal);
      // startNewSession keeps the same Config/Storage but changes the ID.
      sessionId = 'session-b';
      await tool
        .build({ url: 'https://example.com', prompt: 'summarize' })
        .execute(new AbortController().signal);

      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('should invalidate the cache when the session storage is replaced', async () => {
      const fetchSpy = vi
        .spyOn(fetchUtils, 'fetchWithPolicy')
        .mockResolvedValue(okResponse());
      mockGenerateContent.mockResolvedValue({ text: 'Summary' });

      const tool = new WebFetchTool(mockConfig);
      await tool
        .build({ url: 'https://example.com', prompt: 'summarize' })
        .execute(new AbortController().signal);

      // Simulate /cd: relocateWorkingDirectory replaces config.storage with
      // a new Storage object on the SAME Config.
      (mockConfig as unknown as { storage: unknown }).storage = {
        getToolResultsDir: () => toolResultsDir,
      };
      await tool
        .build({ url: 'https://example.com', prompt: 'summarize' })
        .execute(new AbortController().signal);

      // A stale entry (with old-workspace persisted paths) must not survive.
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('should not share the cache across Config instances', async () => {
      const fetchSpy = vi
        .spyOn(fetchUtils, 'fetchWithPolicy')
        .mockResolvedValue(okResponse());
      mockGenerateContent.mockResolvedValue({ text: 'Summary' });

      // A distinct session has its own Storage instance (the cache key).
      const otherConfig = {
        ...mockConfig,
        storage: { getToolResultsDir: () => toolResultsDir },
      } as unknown as Config;
      await new WebFetchTool(mockConfig)
        .build({ url: 'https://example.com', prompt: 'summarize' })
        .execute(new AbortController().signal);
      await new WebFetchTool(otherConfig)
        .build({ url: 'https://example.com', prompt: 'summarize' })
        .execute(new AbortController().signal);

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

      const tool = new WebFetchTool(mockConfig);
      const first = tool.build({
        url: 'https://example.com',
        prompt: 'summarize',
      });
      const firstResult = await first.execute(new AbortController().signal);
      expect(firstResult.error?.type).toBe(
        ToolErrorType.WEB_FETCH_FALLBACK_FAILED,
      );

      const second = tool.build({
        url: 'https://example.com',
        prompt: 'summarize',
      });
      const secondResult = await second.execute(new AbortController().signal);
      expect(secondResult.error).toBeUndefined();
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('getConfirmationDetails', () => {
    it('should return confirmation details with the correct prompt and urls', async () => {
      const tool = new WebFetchTool(mockConfig);
      const params = {
        url: 'https://example.com',
        prompt: 'summarize this page',
      };
      const invocation = tool.build(params);
      expect(await invocation.getDefaultPermission()).toBe('ask');

      const confirmationDetails = await invocation.getConfirmationDetails(
        new AbortController().signal,
      );

      expect(confirmationDetails).toEqual({
        type: 'info',
        title: 'Confirm Web Fetch',
        prompt:
          'Fetch content from https://example.com and process with: summarize this page',
        urls: ['https://example.com'],
        permissionRules: ['WebFetch(example.com)'],
        onConfirm: expect.any(Function),
      });
    });

    it('should normalize github blob urls to the raw destination in params and confirmation', async () => {
      const tool = new WebFetchTool(mockConfig);
      const params = {
        url: 'https://github.com/google/gemini-react/blob/main/README.md',
        prompt: 'summarize the README',
      };
      const invocation = tool.build(params);
      expect(await invocation.getDefaultPermission()).toBe('ask');

      // The scheduler feeds invocation.params into permission-rule
      // evaluation — the normalized URL here is what makes an ask/deny
      // rule for raw.githubusercontent.com actually match.
      expect((invocation.params as { url: string }).url).toBe(
        'https://raw.githubusercontent.com/google/gemini-react/main/README.md',
      );

      const confirmationDetails = await invocation.getConfirmationDetails(
        new AbortController().signal,
      );

      expect(confirmationDetails).toEqual({
        type: 'info',
        title: 'Confirm Web Fetch',
        prompt:
          'Fetch content from https://raw.githubusercontent.com/google/gemini-react/main/README.md and process with: summarize the README',
        urls: [
          'https://raw.githubusercontent.com/google/gemini-react/main/README.md',
        ],
        permissionRules: ['WebFetch(raw.githubusercontent.com)'],
        onConfirm: expect.any(Function),
      });
    });

    it('should return ask even if approval mode is AUTO_EDIT (approval mode handled by scheduler)', async () => {
      const tool = new WebFetchTool({
        ...mockConfig,
        getApprovalMode: () => ApprovalMode.AUTO_EDIT,
      } as unknown as Config);
      const params = {
        url: 'https://example.com',
        prompt: 'summarize this page',
      };
      const invocation = tool.build(params);
      expect(await invocation.getDefaultPermission()).toBe('ask');

      const confirmationDetails = await invocation.getConfirmationDetails(
        new AbortController().signal,
      );

      expect(confirmationDetails).toEqual({
        type: 'info',
        title: 'Confirm Web Fetch',
        prompt:
          'Fetch content from https://example.com and process with: summarize this page',
        urls: ['https://example.com'],
        permissionRules: ['WebFetch(example.com)'],
        onConfirm: expect.any(Function),
      });
    });

    it('should have onConfirm as a no-op (approval mode handled by scheduler)', async () => {
      const setApprovalMode = vi.fn();
      const testConfig = {
        ...mockConfig,
        setApprovalMode,
      } as unknown as Config;
      const tool = new WebFetchTool(testConfig);
      const params = {
        url: 'https://example.com',
        prompt: 'summarize this page',
      };
      const invocation = tool.build(params);
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
