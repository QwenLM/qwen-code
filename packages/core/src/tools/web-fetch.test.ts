/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BRAND_CLI_BIN, BRAND_WEBSITE_URL } from '../config/brand.js';
import type { ModelSelection } from '../provider/model/modelSelection.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from 'vitest';
import '../test-utils/mock-undici-fetch-with-global.js';
import {
  WebFetchTool,
  type WebFetchToolParams,
  clearWebFetchCache,
} from './web-fetch.js';
import type { Config } from '../config/config.js';
import { ToolErrorType } from './tool-error.js';
import { SessionIdInvariantError } from '../utils/sessionIdInvariantError.js';
import { testProviderModel } from '../test-utils/model-resolution.js';
import { mergeModelConfig } from '../provider/model/modelConfig.js';
import type { ModelSelectContext } from '../provider/model/modelSelectContext.js';
import type { ModelStreamRequest } from '../provider/modelStreamRequest.js';
import * as configService from '../config-service/index.js';
import { runLogger } from '../utils/runLogger.js';

/** Resolves to the secondary model's text; rejections surface from inference. */
const mockGenerateContent = vi.fn();
const secondaryModel = testProviderModel('lite');
/** Price lookup of the calling model, served by the session manager. */
const mockGetModel = vi.fn();

vi.mock('turndown', () => ({
  default: class {
    turndown(html: string) {
      return `Converted: ${html}`;
    }
  },
}));

// Mock global fetch for URL fetching
const mockFetchFn = vi.fn();
vi.stubGlobal('fetch', mockFetchFn);

function createMockResponse(opts: {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string;
}): Response {
  const status = opts.status ?? 200;
  const statusText = opts.statusText ?? 'OK';
  const headers = new Headers(opts.headers ?? {});
  const bodyText = opts.body ?? '';
  const bodyBytes = new TextEncoder().encode(bodyText);

  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers,
    body: {
      getReader: () => {
        let sent = false;
        return {
          read: async () => {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: bodyBytes };
          },
          releaseLock: () => {},
          cancel: async () => {},
        };
      },
      cancel: async () => {},
    } as unknown as ReadableStream,
    text: () => Promise.resolve(bodyText),
  } as unknown as Response;
}

describe('WebFetchTool', () => {
  let mockConfig: Config;
  let select: Mock;
  let inference: Mock;

  let sourceRoot: string;
  beforeEach(async () => {
    sourceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'webfetch-integration-'),
    );
    vi.resetAllMocks();
    vi.spyOn(configService, 'getConfigValue').mockImplementation((key) =>
      key === 'webfetch_model_policy' ? { summary: ['selected-model'] } : undefined,
    );
    clearWebFetchCache();
    select = vi.fn(
      async (
        input: ModelSelectContext & { overrideSelection?: ModelSelection },
      ) => ({
        model: input.overrideSelection?.model ?? secondaryModel,
        config: mergeModelConfig(
          { reasoning: { effort: 'low' }, sampling: { temperature: 0.2 } },
          input.overrideSelection?.config,
        ),
      }),
    );
    inference = vi.fn(async (request: ModelStreamRequest) => ({
      completed: Promise.resolve(mockGenerateContent(request)).then(
        (text: string) => ({
          blocks: [{ type: 'text', text }],
          stopReason: 'end_turn',
        }),
      ),
    }));
    mockConfig = {
      storage: { getProjectTempDir: () => sourceRoot },
      getPermissionMode: vi.fn(),
      setPermissionMode: vi.fn(),
      getProxy: vi.fn(),
      get config() {
        return this;
      },
      getModelProviderManager: () => ({
        select,
        inference,
        getModel: mockGetModel,
      }),
      getSessionId: vi.fn().mockReturnValue('session-from-user'),
      getModel: vi.fn().mockReturnValue('selected-model'),
      getRetryFetchErrors: vi.fn().mockReturnValue(false),
      getMaxAttempts: vi.fn().mockReturnValue(3),
      isInteractive: () => false,
      isContextManagementEnabled: vi.fn().mockReturnValue(false),
    } as unknown as Config;
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await fs.rm(sourceRoot, { recursive: true, force: true });
  });

  function sourcePath(value: unknown): string {
    const match = String(value).match(
      /Full readable source \(before summary\/truncation\): (.+)/,
    );
    expect(match, 'tool result provides readable local source').not.toBeNull();
    return match![1];
  }

  describe('model policy routing', () => {
    it('defaults to direct without a QCS policy even for a low-price model', async () => {
      vi.spyOn(configService, 'getConfigValue').mockReturnValue(undefined);
      mockGetModel.mockReturnValue({ priceFactor: 0.3 });
      mockFetchFn.mockResolvedValue(
        createMockResponse({
          body: 'body',
          headers: { 'content-type': 'text/plain' },
        }),
      );
      mockGenerateContent.mockResolvedValue('summary');
      const result = await new WebFetchTool(mockConfig)
        .build({ url: 'https://example.com', prompt: 'read' })
        .execute(new AbortController().signal);
      expect(result.llmContent).toContain('body');
      expect(mockGenerateContent).not.toHaveBeenCalled();
    });

    it('defaults to direct when reading QCS throws', async () => {
      vi.spyOn(configService, 'getConfigValue').mockImplementation((key) => {
        if (key === 'webfetch_model_policy') throw new Error('QCS unavailable');
        return undefined;
      });
      mockFetchFn.mockResolvedValue(
        createMockResponse({
          body: 'body',
          headers: { 'content-type': 'text/plain' },
        }),
      );
      mockGenerateContent.mockResolvedValue('summary');
      const result = await new WebFetchTool(mockConfig)
        .build({ url: 'https://example.com', prompt: 'read' })
        .execute(new AbortController().signal);
      expect(result.llmContent).toContain('body');
      expect(mockGenerateContent).not.toHaveBeenCalled();
    });
    it.each([
      [{ direct: ['selected-model'] }, true],
      ['{"direct":["selected-model"],"summary":[]}', true],
      [{ summary: ['selected-model'] }, false],
      [{ direct: ['other'] }, true],
      [{ summary: ['other'] }, true],
      [{ direct: ['selected-model'], summary: ['selected-model'] }, true],
      [{ direct: ['selected-model'], summary: 'invalid' }, true],
      [{ direct: ['selected-model', 1] }, true],
      [{ 'selected-model': 'direct' }, true],
      [{}, true],
      [null, true],
      [false, true],
      ['{bad', true],
      [[], true],
      [undefined, true],
    ])('routes policy %s to direct=%s', async (policy, direct) => {
      vi.spyOn(configService, 'getConfigValue').mockReturnValue(policy);
      mockFetchFn.mockResolvedValue(
        createMockResponse({
          body: '<h1>Page</h1>',
          headers: { 'content-type': 'text/html' },
        }),
      );
      mockGenerateContent.mockResolvedValue('summary');
      const result = await new WebFetchTool(mockConfig)
        .build({ url: 'https://example.com', prompt: 'find details' })
        .execute(new AbortController().signal);
      if (direct) {
        expect(result.llmContent).toContain('Converted: <h1>Page</h1>');
        expect(mockGenerateContent).not.toHaveBeenCalled();
        expect(
          await fs.readFile(sourcePath(result.llmContent), 'utf8'),
        ).toContain('Page');
      } else {
        expect(mockGenerateContent).toHaveBeenCalledOnce();
        expect(
          await fs.readFile(sourcePath(result.llmContent), 'utf8'),
        ).toContain('Page');
      }
      expect(result.toolUseResult).toMatchObject({ result: result.llmContent });
      expect(result.returnDisplay).toMatchObject({ result: result.llmContent });
    });

    it('logs a conflict without including the model name', async () => {
      vi.spyOn(configService, 'getConfigValue').mockReturnValue({
        direct: ['selected-model'],
        summary: ['selected-model'],
      });
      const warning = vi.spyOn(runLogger, 'warn');
      mockFetchFn.mockResolvedValue(
        createMockResponse({ body: 'body', headers: { 'content-type': 'text/plain' } }),
      );
      mockGenerateContent.mockResolvedValue('summary');
      await new WebFetchTool(mockConfig)
        .build({ url: 'https://example.com', prompt: 'read' })
        .execute(new AbortController().signal);
      expect(warning).toHaveBeenCalledWith(
        '[WebFetch] model policy conflict; using direct',
      );
    });

    it.each([
      ['cheap', true],
      ['expensive', false],
    ])(
      'uses the calling model %s instead of the session model',
      async (modelKey, direct) => {
        vi.mocked(mockConfig.getModel).mockReturnValue(
          direct ? 'expensive' : 'cheap',
        );
        vi.spyOn(configService, 'getConfigValue').mockReturnValue({
          direct: ['cheap'],
          summary: ['expensive'],
        });
        mockFetchFn.mockResolvedValue(
          createMockResponse({
            body: 'body',
            headers: { 'content-type': 'text/plain' },
          }),
        );
        mockGenerateContent.mockResolvedValue('summary');
        const invocation = new WebFetchTool(mockConfig).build({
          url: 'https://example.com',
          prompt: 'read',
        });
        const result = await invocation.executeWithContext!({
          signal: new AbortController().signal,
          modelKey,
        });
        expect(mockGenerateContent).toHaveBeenCalledTimes(direct ? 0 : 1);
        if (direct) expect(result.llmContent).toContain('body');
        else expect(result.llmContent).toContain('summary');
      },
    );

    it('keeps the in-flight mode and reads updated policy for cached content', async () => {
      const policy = vi.spyOn(configService, 'getConfigValue').mockReturnValue({
        direct: ['selected-model'],
      });
      mockFetchFn.mockImplementation(async () => {
        policy.mockReturnValue({ summary: ['selected-model'] });
        return createMockResponse({
          body: 'cached body',
          headers: { 'content-type': 'text/plain' },
        });
      });
      mockGenerateContent.mockResolvedValue('summary');
      const invocation = new WebFetchTool(mockConfig).build({
        url: 'https://example.com',
        prompt: 'read',
      });
      const signal = new AbortController().signal;
      expect((await invocation.execute(signal)).llmContent).toContain('cached body');
      expect(mockGenerateContent).not.toHaveBeenCalled();
      const summarized = await invocation.execute(signal);
      expect(await fs.readFile(sourcePath(summarized.llmContent), 'utf8')).toBe(
        'cached body',
      );
      policy.mockReturnValue({ direct: ['selected-model'] });
      expect((await invocation.execute(signal)).llmContent).toContain('cached body');
      expect(mockFetchFn).toHaveBeenCalledOnce();
      expect(mockGenerateContent).toHaveBeenCalledOnce();
    });

    it.each([100, 110000])(
      'bounds direct remote preview and saves complete readable materials (body %s)',
      async (bodyLength) => {
        vi.spyOn(configService, 'getConfigValue').mockReturnValue({ direct: ['selected-model'] });
        const adapter = vi.fn().mockResolvedValue({
          content: 'x'.repeat(bodyLength),
          contentType: 'text/plain',
          links: {
            external: [
              { href: 'https://example.com/ref' },
              {
                href: 'https://example.com/oversized',
                text: 'z'.repeat(101000),
              },
            ],
          },
          media: {
            images: [
              { src: 'https://example.com/image.png', data: 'BINARY_BYTES' },
            ],
          },
        });
        const result = await new WebFetchTool(mockConfig, adapter)
          .build({ url: 'https://example.com', prompt: 'read' })
          .execute(new AbortController().signal);
        const output = String(result.llmContent);
        expect(output).toContain('Read');
        expect(output).toContain('Grep');
        const saved = await fs.readFile(sourcePath(output), 'utf8');
        expect(output.split('\n\n[WebFetch content truncated')[0]).toBe(
          saved.slice(0, 50000),
        );
        expect(saved).toContain('x'.repeat(bodyLength));
        expect(saved).toContain('https://example.com/ref');
        expect(saved).toContain('https://example.com/image.png');
        expect(saved).toContain('z'.repeat(101000));
        expect(saved).not.toContain('BINARY_BYTES');
        expect(mockGenerateContent).not.toHaveBeenCalled();
      },
    );

    it.each([10000, 10001, 49999, 50000, 50001])(
      'saves direct materials at every size: %s',
      async (length) => {
        vi.spyOn(configService, 'getConfigValue').mockReturnValue({ direct: ['selected-model'] });
        const body = 'x'.repeat(length - 4) + 'TAIL';
        mockFetchFn.mockResolvedValue(
          createMockResponse({
            body,
            headers: { 'content-type': 'text/plain' },
          }),
        );
        const result = await new WebFetchTool(mockConfig)
          .build({ url: 'https://example.com', prompt: 'read' })
          .execute(new AbortController().signal);
        if (length <= 50000) {
          expect(result.llmContent).toContain(body);
        } else {
          expect(
            String(result.llmContent).split(
              '\n\n[WebFetch content truncated',
            )[0],
          ).toBe(body.slice(0, 50000));
        }
        expect(await fs.readFile(sourcePath(result.llmContent), 'utf8')).toBe(body);
        expect(mockGenerateContent).not.toHaveBeenCalled();
      },
    );

    it('returns the direct preview with an unavailable notice when saving fails', async () => {
      vi.spyOn(configService, 'getConfigValue').mockReturnValue({ direct: ['selected-model'] });
      await fs.writeFile(
        path.join(sourceRoot, 'tool-outputs'),
        'blocks directory',
      );
      mockFetchFn.mockResolvedValue(
        createMockResponse({
          body: 'x'.repeat(50001),
          headers: { 'content-type': 'text/plain' },
        }),
      );
      const result = await new WebFetchTool(mockConfig)
        .build({ url: 'https://example.com', prompt: 'read' })
        .execute(new AbortController().signal);
      expect(String(result.llmContent)).toContain(
        'Local page source unavailable',
      );
      expect(String(result.llmContent)).not.toContain('[Local page source]');
      expect(
        String(result.llmContent).split('\n\n[WebFetch content truncated')[0],
      ).toBe('x'.repeat(50000));
      expect(mockGenerateContent).not.toHaveBeenCalled();
    });
    it('keeps direct mode when the remote fetch falls back locally', async () => {
      vi.spyOn(configService, 'getConfigValue').mockReturnValue({ direct: ['selected-model'] });
      const adapter = vi
        .fn()
        .mockRejectedValue(new Error('remote unavailable'));
      mockFetchFn.mockResolvedValue(
        createMockResponse({
          body: 'local body',
          headers: { 'content-type': 'text/plain' },
        }),
      );
      const result = await new WebFetchTool(mockConfig, adapter)
        .build({ url: 'https://example.com', prompt: 'read' })
        .execute(new AbortController().signal);
      expect(adapter).toHaveBeenCalledOnce();
      expect(result.llmContent).toContain('local body');
      expect(mockGenerateContent).not.toHaveBeenCalled();
      expect(await fs.readFile(sourcePath(result.llmContent), 'utf8')).toBe('local body');
    });
  });

  describe('summary and source mode', () => {
    it.each([true, false])(
      'uses the injected preapproval verdict after rebuilding with context: %s',
      async (approved) => {
        mockFetchFn.mockResolvedValue(
          createMockResponse({
            body: '<h1>Documentation</h1>',
            headers: { 'content-type': 'text/html' },
          }),
        );
        mockGenerateContent.mockResolvedValue('summary');
        const signal = new AbortController().signal;
        const tool = new WebFetchTool(
          undefined,
          undefined,
          (hostname, pathname) =>
            approved && hostname === 'example.com' && pathname === '/docs',
        );
        await tool
          .build(
            { url: 'https://example.com/docs', prompt: 'summarize' },
            { config: mockConfig, promptId: 'test', signal },
          )
          .execute(signal);
        const prompt = mockGenerateContent.mock.calls[0][0].prompt.messages[0]
          .content;
        expect(prompt.includes('125-character maximum')).toBe(!approved);
        expect(prompt.includes('documentation excerpts')).toBe(approved);
      },
    );

    it.each([
      [
        'https://example.com',
        'text/html',
        '<h1>Local body</h1>',
        'Converted: <h1>Local body</h1>',
      ],
      [
        'https://docs.python.org/page.md',
        'text/markdown',
        '# Markdown body',
        '# Markdown body',
      ],
    ])(
      'saves %s before returning a consistent summary and source',
      async (url, type, body, saved) => {
        mockFetchFn.mockResolvedValue(
          createMockResponse({ body, headers: { 'content-type': type } }),
        );
        mockGenerateContent.mockResolvedValue('short summary');
        const result = await new WebFetchTool(mockConfig)
          .build({ url, prompt: 'summarize' })
          .execute(new AbortController().signal);
        expect(await fs.readFile(sourcePath(result.llmContent), 'utf8')).toBe(
          saved,
        );
        expect(result.llmContent).toContain('short summary');
        expect(result.toolUseResult).toMatchObject({
          result: result.llmContent,
        });
        expect(result.returnDisplay).toMatchObject({
          result: result.llmContent,
        });
      },
    );

    it('saves full remote body and metadata while keeping summary materials within one budget', async () => {
      const adapter = vi.fn().mockResolvedValue({
        content: 'x'.repeat(110000) + '\n# Tail\nretained tail',
        contentType: 'text/plain',
        links: {
          external: [
            { href: 'https://example.com/docs' },
            { href: 'https://example.com/large', text: 'z'.repeat(21000) },
          ],
        },
        media: {
          images: [
            { src: 'https://example.com/image.png', data: 'DO_NOT_SAVE_BYTES' },
          ],
        },
        fetchedAt: '2026-10-22T01:00:00.000Z',
      });
      mockGenerateContent.mockResolvedValue('remote summary');
      const result = await new WebFetchTool(mockConfig, adapter)
        .build({ url: 'https://example.com', prompt: 'summarize' })
        .execute(new AbortController().signal);
      const file = await fs.readFile(sourcePath(result.llmContent), 'utf8');
      expect(file).toContain('retained tail');
      expect(file).toContain('z'.repeat(21000));
      expect(file).not.toContain('DO_NOT_SAVE_BYTES');
      expect(result.llmContent).toContain('2026-10-22T01:00:00.000Z');
      const prompt = mockGenerateContent.mock.calls[0][0].prompt.messages[0]
        .content as string;
      expect(prompt).toContain('https://example.com/docs');
      expect(prompt).not.toContain('https://example.com/large');
      expect(prompt).not.toContain('retained tail');
      const contentStart = prompt.indexOf('x'.repeat(20));
      const lastReference = prompt.indexOf('https://example.com/image.png');
      expect(lastReference - contentStart).toBeLessThan(100000);
    });

    it.each([
      {
        bodyLength: 100000,
        withReferences: false,
        saveFails: false,
        truncated: false,
      },
      {
        bodyLength: 100001,
        withReferences: false,
        saveFails: false,
        truncated: true,
      },
      {
        bodyLength: 90000,
        withReferences: true,
        saveFails: false,
        truncated: true,
      },
      {
        bodyLength: 100001,
        withReferences: false,
        saveFails: true,
        truncated: true,
      },
    ])(
      'reports summary body truncation accurately: %j',
      async ({ bodyLength, withReferences, saveFails, truncated }) => {
        const body = 'x'.repeat(bodyLength);
        const adapter = withReferences
          ? async () => ({
              content: body,
              contentType: 'text/plain',
              links: {
                external: [
                  { href: 'https://example.com/ref', text: 'r'.repeat(19000) },
                ],
              },
            })
          : undefined;
        if (!adapter)
          mockFetchFn.mockResolvedValue(
            createMockResponse({
              body,
              headers: { 'content-type': 'text/plain' },
            }),
          );
        if (saveFails)
          await fs.writeFile(
            path.join(sourceRoot, 'tool-outputs'),
            'blocks directory creation',
          );
        mockGenerateContent.mockResolvedValue('summary');
        const result = await new WebFetchTool(mockConfig, adapter)
          .build({ url: 'https://example.com', prompt: 'summarize' })
          .execute(new AbortController().signal);
        const prompt = mockGenerateContent.mock.calls[0][0].prompt.messages[0]
          .content as string;
        const material = prompt.match(
          /Web page content:\n---\n([\s\S]*?)\n---/,
        )![1];
        expect(material.length).toBeLessThanOrEqual(100000);
        expect(
          prompt.includes('You are seeing only part of the page body'),
        ).toBe(truncated);
        expect(
          String(result.llmContent).includes('Summary input was truncated'),
        ).toBe(truncated);
        if (truncated)
          expect(prompt).toContain(
            'Do not conclude that information is absent from the full page',
          );
        if (saveFails) {
          expect(result.llmContent).toContain('Local page source unavailable');
          expect(result.llmContent).not.toContain('complete local file below');
          expect(result.llmContent).not.toContain('Full readable source');
        } else {
          expect(
            await fs.readFile(sourcePath(result.llmContent), 'utf8'),
          ).toContain(body);
          if (truncated)
            expect(result.llmContent).toContain(
              'Use Read or Grep on the complete local file below',
            );
        }
        expect(result.toolUseResult).toMatchObject({
          result: result.llmContent,
        });
        expect(result.returnDisplay).toMatchObject({
          result: result.llmContent,
        });
      },
    );

    it('saves the local fallback source when the remote request fails', async () => {
      mockFetchFn.mockResolvedValue(
        createMockResponse({
          body: 'fallback body',
          headers: { 'content-type': 'text/plain' },
        }),
      );
      mockGenerateContent.mockResolvedValue('fallback summary');
      const result = await new WebFetchTool(mockConfig, async () => {
        throw new Error('remote failure');
      })
        .build({ url: 'https://example.com', prompt: 'summarize' })
        .execute(new AbortController().signal);
      expect(await fs.readFile(sourcePath(result.llmContent), 'utf8')).toBe(
        'fallback body',
      );
    });

    it('reuses cached content and fetch time but writes into the executing session', async () => {
      mockFetchFn.mockResolvedValue(
        createMockResponse({
          body: 'cached',
          headers: { 'content-type': 'text/plain' },
        }),
      );
      mockGenerateContent.mockResolvedValue('summary');
      const tool = new WebFetchTool(mockConfig);
      const first = await tool
        .build({ url: 'https://example.com', prompt: 'first' })
        .execute(new AbortController().signal);
      vi.mocked(mockConfig.getSessionId).mockReturnValue('second-session');
      const second = await tool
        .build({ url: 'https://example.com', prompt: 'second' })
        .execute(new AbortController().signal);
      expect(sourcePath(second.llmContent)).toContain('session-second-session');
      expect(sourcePath(first.llmContent)).not.toBe(
        sourcePath(second.llmContent),
      );
      expect(String(first.llmContent).match(/Fetched at: .+/)?.[0]).toBe(
        String(second.llmContent).match(/Fetched at: .+/)?.[0],
      );
      expect(mockFetchFn).toHaveBeenCalledTimes(1);
      expect(await fs.readFile(sourcePath(second.llmContent), 'utf8')).toBe(
        'cached',
      );
    });

    it('returns the saved file when summarization fails without refetching', async () => {
      mockFetchFn.mockResolvedValue(
        createMockResponse({
          body: 'available source',
          headers: { 'content-type': 'text/plain' },
        }),
      );
      mockGenerateContent.mockRejectedValue(new Error('model unavailable'));
      const result = await new WebFetchTool(mockConfig)
        .build({ url: 'https://example.com', prompt: 'summarize' })
        .execute(new AbortController().signal);
      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain('Summary unavailable');
      expect(await fs.readFile(sourcePath(result.llmContent), 'utf8')).toBe(
        'available source',
      );
      expect(mockFetchFn).toHaveBeenCalledTimes(1);
    });

    it('returns the summary without a false file path when saving fails', async () => {
      mockFetchFn.mockResolvedValue(
        createMockResponse({
          body: 'content',
          headers: { 'content-type': 'text/plain' },
        }),
      );
      mockGenerateContent.mockResolvedValue('usable summary');
      await fs.writeFile(
        path.join(sourceRoot, 'tool-outputs'),
        'blocks directory',
      );
      const result = await new WebFetchTool(mockConfig)
        .build({ url: 'https://example.com', prompt: 'summarize' })
        .execute(new AbortController().signal);
      expect(result.llmContent).toContain('usable summary');
      expect(result.llmContent).toContain('Local page source unavailable');
      expect(result.llmContent).not.toContain('Full readable source');
      expect(result.error).toBeUndefined();
    });

    it('does not turn a cancelled summary into a file success', async () => {
      mockFetchFn.mockResolvedValue(
        createMockResponse({
          body: 'content',
          headers: { 'content-type': 'text/plain' },
        }),
      );
      const controller = new AbortController();
      mockGenerateContent.mockImplementation(async () => {
        controller.abort();
        throw new Error('provider stopped');
      });
      const result = await new WebFetchTool(mockConfig)
        .build({ url: 'https://example.com', prompt: 'summarize' })
        .execute(controller.signal);
      expect(result.llmContent).not.toContain('Full readable source');
      expect(result.llmContent).toContain('cancelled');
    });

    it.each([404, 302])('does not save an HTTP %s result', async (status) => {
      mockFetchFn.mockResolvedValue(
        createMockResponse({
          status,
          headers: { location: 'https://another.example/page' },
        }),
      );
      await new WebFetchTool(mockConfig)
        .build({ url: 'https://example.com', prompt: 'summarize' })
        .execute(new AbortController().signal);
      expect(await fs.readdir(sourceRoot)).toEqual([]);
    });
  });

  describe('remote content adapter', () => {
    it('falls back once when the remote adapter fails', async () => {
      const adapter = vi
        .fn()
        .mockRejectedValue(new Error('remote unavailable'));
      mockFetchFn.mockResolvedValue(
        createMockResponse({
          body: 'local text',
          headers: { 'content-type': 'text/plain' },
        }),
      );
      mockGenerateContent.mockResolvedValue('answer');
      const result = await new WebFetchTool(mockConfig, adapter)
        .build({ url: 'https://example.com', prompt: 'summarize' })
        .execute(new AbortController().signal);
      expect(adapter).toHaveBeenCalledTimes(1);
      expect(mockFetchFn).toHaveBeenCalledTimes(1);
      expect(result.error).toBeUndefined();
    });

    it('does not fetch locally after cancellation', async () => {
      const controller = new AbortController();
      const adapter = vi.fn(async () => {
        controller.abort();
        throw controller.signal.reason;
      });
      await new WebFetchTool(mockConfig, adapter)
        .build({ url: 'https://example.com', prompt: 'summarize' })
        .execute(controller.signal);
      expect(mockFetchFn).not.toHaveBeenCalled();
    });
  });

  it('includes remote links and media descriptions in model input without embedding media data', async () => {
    const adapter = vi.fn().mockResolvedValue({
      content: '<p>Body</p>',
      contentType: 'text/html',
      links: {
        internal: [{ href: 'https://example.com/docs', text: 'Docs' }],
      },
      media: {
        images: [
          {
            src: 'https://example.com/a.png',
            alt: 'A picture',
            data: 'BINARY_PAYLOAD',
          },
        ],
        videos: [{ src: 'https://example.com/a.mp4', desc: 'A video' }],
      },
    });
    mockGenerateContent.mockResolvedValue('answer');
    const result = await new WebFetchTool(mockConfig, adapter)
      .build({ url: 'http://example.com', prompt: 'Find links and media' })
      .execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    const input = JSON.stringify(mockGenerateContent.mock.calls[0]);
    expect(input).toContain('Converted: <p>Body</p>');
    expect(input).toContain('https://example.com/docs');
    expect(input).toContain('A picture');
    expect(input).toContain('https://example.com/a.mp4');
    expect(input).not.toContain('BINARY_PAYLOAD');
    expect(adapter.mock.calls[0][0]).toBe('https://example.com/');
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    expect(mockFetchFn).not.toHaveBeenCalled();
  });

  it('keeps bounded remote references visible when the body exceeds the model limit', async () => {
    const links = {
      internal: Array.from({ length: 1000 }, (_, i) => ({
        href: `https://example.com/docs/${i}`,
        text: 'Reference',
      })),
    };
    const adapter = vi.fn().mockResolvedValue({
      content: 'x'.repeat(110_000),
      contentType: 'text/plain',
      links,
    });
    mockGenerateContent.mockResolvedValue('answer');
    const result = await new WebFetchTool(mockConfig, adapter)
      .build({ url: 'https://example.com', prompt: 'Find links' })
      .execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    const input = JSON.stringify(mockGenerateContent.mock.calls[0]);
    expect(input).toContain('https://example.com/docs/0');
    expect(input).not.toContain('https://example.com/docs/999');
    const modelPrompt = mockGenerateContent.mock.calls[0][0].prompt.messages[0]
      .content as string;
    const materials = modelPrompt
      .split('Web page content:\n---\n')[1]
      .split('\n---\n')[0];
    expect(materials.length).toBeLessThanOrEqual(100000);
    expect(modelPrompt).toContain('You are seeing only part of the page body');
    expect(
      materials.slice(materials.indexOf('\n\nPage links and media')).length,
    ).toBeLessThanOrEqual(20000);
    expect(mockFetchFn).not.toHaveBeenCalled();
  });

  describe('remote adapter boundaries', () => {
    it('uses the execution context when the product tool has no initial context', async () => {
      const adapter = vi
        .fn()
        .mockResolvedValue({ content: 'remote', contentType: 'text/plain' });
      mockGenerateContent.mockResolvedValue('answer');
      const invocation = new WebFetchTool(undefined, adapter).build({
        url: 'https://example.com',
        prompt: 'summarize',
      });
      const result = await invocation.executeWithContext!({
        config: mockConfig,
        signal: new AbortController().signal,
        promptId: 'prompt',
      });
      expect(result.error).toBeUndefined();
      expect(adapter).toHaveBeenCalledTimes(1);
      expect(mockFetchFn).not.toHaveBeenCalled();
    });
    it('does not refetch after model processing fails', async () => {
      const adapter = vi
        .fn()
        .mockResolvedValue({ content: 'remote', contentType: 'text/plain' });
      mockGenerateContent.mockRejectedValue(new Error('model failure'));
      await new WebFetchTool(mockConfig, adapter)
        .build({ url: 'https://example.com', prompt: 'summarize' })
        .execute(new AbortController().signal);
      expect(adapter).toHaveBeenCalledTimes(1);
      expect(mockFetchFn).not.toHaveBeenCalled();
    });
    it('preserves cross-origin redirect reporting', async () => {
      const adapter = vi.fn().mockResolvedValue({
        content: 'remote',
        contentType: 'text/plain',
        redirectedUrl: 'https://different.example.com/page',
      });
      const result = await new WebFetchTool(mockConfig, adapter)
        .build({ url: 'https://example.com', prompt: 'summarize' })
        .execute(new AbortController().signal);
      expect(result.llmContent).toContain('REDIRECT DETECTED');
      expect(mockGenerateContent).not.toHaveBeenCalled();
    });
    it('validates URLs before sending them to the remote service', async () => {
      const adapter = vi.fn();
      await new WebFetchTool(mockConfig, adapter)
        .build({ url: 'https://user:secret@example.com', prompt: 'summarize' })
        .execute(new AbortController().signal);
      expect(adapter).not.toHaveBeenCalled();
      expect(mockFetchFn).not.toHaveBeenCalled();
    });
    it('does not fall back when the overall deadline aborts remote fetch', async () => {
      vi.useFakeTimers();
      const adapter = vi.fn(
        (_url: string, signal: AbortSignal) =>
          new Promise<never>((_, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            }),
          ),
      );
      const pending = new WebFetchTool(mockConfig, adapter)
        .build({ url: 'https://example.com', prompt: 'summarize' })
        .execute(new AbortController().signal);
      await vi.advanceTimersByTimeAsync(120_000);
      const result = await pending;
      expect(result.error).toBeDefined();
      expect(mockFetchFn).not.toHaveBeenCalled();
    });
  });

  describe('validateToolParamValues', () => {
    it('should throw if url is missing', () => {
      const tool = new WebFetchTool(mockConfig);
      expect(() =>
        tool.build({ url: '', prompt: 'test' } as WebFetchToolParams),
      ).toThrow("The 'url' parameter is required.");
    });

    it('should throw if prompt is missing', () => {
      const tool = new WebFetchTool(mockConfig);
      expect(() =>
        tool.build({
          url: 'https://example.com',
          prompt: '',
        } as WebFetchToolParams),
      ).toThrow("The 'prompt' parameter is required.");
    });

    it('should throw if url is invalid', () => {
      const tool = new WebFetchTool(mockConfig);
      expect(() => tool.build({ url: 'not-a-url', prompt: 'test' })).toThrow(
        'Invalid URL: "not-a-url"',
      );
    });

    it('should throw for unsupported protocol', () => {
      const tool = new WebFetchTool(mockConfig);
      expect(() =>
        tool.build({ url: 'ftp://example.com', prompt: 'test' }),
      ).toThrow('Unsupported protocol');
    });

    it('should pass for valid url and prompt', () => {
      const tool = new WebFetchTool(mockConfig);
      expect(() =>
        tool.build({
          url: 'https://example.com',
          prompt: 'Summarize this page',
        }),
      ).not.toThrow();
    });
  });

  describe('getDescription', () => {
    it('should include hostname in description', () => {
      const tool = new WebFetchTool(mockConfig);
      const invocation = tool.build({
        url: 'https://example.com/page',
        prompt: 'test',
      });
      expect(invocation.getDescription()).toBe(
        'Fetching content from example.com',
      );
    });
  });

  describe('execute', () => {
    it('returns an error when the redirected response body fails', async () => {
      const response = new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(new Error('body stream interrupted'));
          },
        }),
        { status: 200 },
      );
      mockFetchFn
        .mockResolvedValueOnce(
          createMockResponse({
            status: 302,
            headers: { location: '/next' },
          }),
        )
        .mockResolvedValueOnce(response);
      const result = await new WebFetchTool(mockConfig)
        .build({
          url: 'https://example.com/start',
          prompt: 'summarize',
        })
        .execute(new AbortController().signal);
      expect(result.error).toBeDefined();
    });

    it('should fetch URL and process with secondary model', async () => {
      mockFetchFn.mockResolvedValue(
        createMockResponse({
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: '<html><body>Hello World</body></html>',
        }),
      );

      mockGenerateContent.mockResolvedValue('Summarized: Hello World');

      const tool = new WebFetchTool(mockConfig);
      const invocation = tool.build({
        url: 'https://example.com',
        prompt: 'Summarize this page',
      });
      const result = await invocation.execute(new AbortController().signal);

      expect(result.llmContent).toContain('Summarized: Hello World');
      expect(result.error).toBeUndefined();
    });

    it('reports secondary model failure diagnostics', async () => {
      mockFetchFn.mockResolvedValue(
        createMockResponse({
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: '<html><body>Hello World</body></html>',
        }),
      );
      vi.spyOn(mockConfig.storage, 'getProjectTempDir').mockImplementation(
        () => {
          throw new Error('storage unavailable');
        },
      );
      mockGenerateContent.mockRejectedValue(
        Object.assign(new Error('Gateway Time-out'), {
          status: 504,
          code: 'UND_ERR_CONNECT_TIMEOUT',
        }),
      );

      const invocation = new WebFetchTool(mockConfig).build({
        url: 'https://example.com',
        prompt: 'Summarize this page',
      });

      const result = await invocation.execute(new AbortController().signal);

      expect(result.error?.type).toBe(ToolErrorType.WEB_FETCH_PROCESSING_ERROR);
      expect(result.data).toEqual(
        expect.objectContaining({
          tool_error_stage: 'secondary_model_request',
          tool_error_subtype: 'http_5xx',
          http_status: 504,
          network_error_code: 'UND_ERR_CONNECT_TIMEOUT',
        }),
      );
      expect(result.data).not.toHaveProperty('web_fetch_stage');
      expect(result.data).not.toHaveProperty('web_fetch_secondary_model');
      expect(result.data).not.toHaveProperty('url');
      expect(result.data).not.toHaveProperty('prompt');
      const details = JSON.parse(
        result.data?.['tool_error_details_json'] as string,
      );
      expect(details).toEqual(
        expect.objectContaining({
          schema_version: 1,
          tool: 'WebFetch',
          stage: 'secondary_model_request',
          subtype: 'http_5xx',
          secondary_model: expect.objectContaining({
            used: true,
            model: 'lite',
            provider: 'qoder',
            status: 504,
            error_code: 'UND_ERR_CONNECT_TIMEOUT',
          }),
        }),
      );
      expect(details.secondary_model['duration_ms']).toEqual(
        expect.any(Number),
      );
    });

    it('returns a stable unavailable result when the session invariant fails', async () => {
      mockFetchFn.mockResolvedValue(
        createMockResponse({
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: '<html><body>Hello World</body></html>',
        }),
      );
      mockGenerateContent.mockRejectedValue(
        new SessionIdInvariantError('utility session id changed'),
      );

      const invocation = new WebFetchTool(mockConfig).build({
        url: 'https://example.com',
        prompt: 'Summarize this page',
      });

      const result = await invocation.execute(new AbortController().signal);

      expect(result.error).toEqual({
        message:
          'WebFetch is unavailable because its model session context is invalid. Continue without WebFetch.',
        type: ToolErrorType.WEB_FETCH_PROCESSING_ERROR,
      });
      expect(result.llmContent).not.toContain('utility session id changed');
    });

    it('reports the total timeout instead of a competing socket error', async () => {
      const total = new AbortController();
      const timeoutReason = new DOMException(
        'Request timed out after 60000ms',
        'TimeoutError',
      );
      const socketError = Object.assign(new Error('socket closed'), {
        code: 'ECONNRESET',
      });
      const timeoutSpy = vi
        .spyOn(AbortSignal, 'timeout')
        .mockReturnValue(total.signal);
      mockFetchFn.mockImplementation(async () => {
        total.abort(timeoutReason);
        throw socketError;
      });

      try {
        const tool = new WebFetchTool(mockConfig);
        const invocation = tool.build({
          url: 'https://example.com',
          prompt: 'Summarize this page',
        });
        const result = await invocation.execute(new AbortController().signal);

        expect(result.error?.message).toContain(
          'Request timed out after 60000ms',
        );
        expect(result.error?.message).not.toContain('socket closed');
        expect(result.error?.message).not.toContain('ECONNRESET');
      } finally {
        timeoutSpy.mockRestore();
      }
    });

    it('returns a terminal error when the full WebFetch deadline expires', async () => {
      vi.useFakeTimers();
      mockFetchFn.mockResolvedValue(
        createMockResponse({
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: '<html><body>Hello World</body></html>',
        }),
      );
      mockGenerateContent.mockReturnValue(new Promise(() => {}));

      const invocation = new WebFetchTool(mockConfig).build({
        url: 'https://example.com',
        prompt: 'Summarize this page',
      });
      const updates: unknown[] = [];
      const execution = invocation.execute(
        new AbortController().signal,
        (output) => updates.push(output),
      );
      await vi.waitFor(() =>
        expect(mockGenerateContent).toHaveBeenCalledTimes(1),
      );
      await vi.advanceTimersByTimeAsync(120_000);
      const result = await execution;
      const updatesAtDeadline = updates.length;
      await vi.advanceTimersByTimeAsync(2_000);

      expect(result.error).toEqual({
        message: 'WebFetch timed out after 120000ms.',
        type: ToolErrorType.WEB_FETCH_PROCESSING_ERROR,
      });
      expect(result.data).toEqual(
        expect.objectContaining({
          tool_error_stage: 'overall_deadline',
          tool_error_subtype: 'timeout',
        }),
      );
      const details = JSON.parse(
        result.data?.['tool_error_details_json'] as string,
      );
      expect(details).toEqual(
        expect.objectContaining({
          timeout_ms: 120_000,
          duration_ms: expect.any(Number),
        }),
      );
      expect(updates.length).toBe(updatesAtDeadline);
    });

    it('should advertise live output support (canUpdateOutput)', () => {
      const tool = new WebFetchTool(mockConfig);
      expect(tool.canUpdateOutput).toBe(true);
    });

    it('should emit live progress while fetching and summarizing', async () => {
      mockFetchFn.mockResolvedValue(
        createMockResponse({
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: '<html><body>Hello World</body></html>',
        }),
      );

      mockGenerateContent.mockResolvedValue('Summarized: Hello World');

      const tool = new WebFetchTool(mockConfig);
      const invocation = tool.build({
        url: 'https://example.com/page',
        prompt: 'Summarize this page',
      });

      const updates: string[] = [];
      const result = await invocation.execute(
        new AbortController().signal,
        (output) => {
          if (typeof output === 'string') {
            updates.push(output);
          }
        },
      );

      expect(result.llmContent).toContain('Summarized: Hello World');
      // Initial fetch progress line so the UI shows movement immediately.
      expect(
        updates.some((u) => u.includes('Fetching content from example.com')),
      ).toBe(true);
      // Heartbeat while the secondary model summarizes, so it never looks stuck.
      expect(
        updates.some((u) =>
          u.includes('Analyzing fetched content with the model'),
        ),
      ).toBe(true);
    });

    it('should fall back to default secondary model when model policy returns undefined', async () => {
      mockFetchFn.mockResolvedValue(
        createMockResponse({
          status: 200,
          headers: { 'content-type': 'text/plain' },
          body: 'Weather content',
        }),
      );
      mockGenerateContent.mockResolvedValue('Processed weather content');
      const getModelPolicy = vi.fn().mockResolvedValue(undefined);

      const tool = new WebFetchTool(mockConfig);
      const invocation = tool.build({
        url: 'https://example.com/weather',
        prompt: 'Summarize this page',
      });
      const result = await invocation.executeWithContext!({
        signal: new AbortController().signal,
        sessionId: 'session-from-tool-context',
        config: {
          getModelPolicy,
        } as unknown as Config,
      });

      expect(result.llmContent).toContain('Processed weather content');
      expect(result.error).toBeUndefined();
      expect(getModelPolicy).toHaveBeenCalledWith(
        'web_fetch',
        'session-from-tool-context',
        0,
        undefined,
        expect.any(AbortSignal),
        undefined,
      );
      expect(select).toHaveBeenCalledWith({ purpose: 'web_fetch' });
      expect(inference).toHaveBeenCalledWith(
        expect.objectContaining({
          resolution: {
            model: secondaryModel,
            config: {
              reasoning: { effort: 'none', thinking: { type: 'disabled' } },
              context: { maxOutputTokens: 8192 },
              sampling: { temperature: 0.2 },
            },
          },
          prompt: { messages: [{ role: 'user', content: expect.any(String) }] },
          control: { signal: expect.any(AbortSignal) },
          qoder: expect.objectContaining({
            identity: expect.objectContaining({
              sessionId: 'session-from-tool-context',
            }),
            taskRouting: { taskId: 'agent_summary', policyTaskId: undefined },
            business: expect.objectContaining({ type: 'webfetch_summary' }),
          }),
        }),
      );
    });

    it('should preserve task routing and the output cap when model policy overrides the model', async () => {
      const policyModel = {
        ...testProviderModel('gateway/web-model'),
        source: 'gateway',
      };
      mockGetModel.mockImplementation((key: string) =>
        key === policyModel.key ? policyModel : undefined,
      );
      mockFetchFn.mockResolvedValue(
        createMockResponse({
          status: 200,
          headers: { 'content-type': 'text/plain' },
          body: 'Weather content',
        }),
      );
      mockGenerateContent.mockResolvedValue('Processed weather content');
      const getModelPolicy = vi.fn().mockResolvedValue({
        model: 'gateway/web-model',
        parameters: { reasoningEffort: 'max' },
        labels: {
          taskId: 'sdk_scene',
          subTask: 'web_fetch',
        },
      });

      const tool = new WebFetchTool(mockConfig);
      const invocation = tool.build({
        url: 'https://example.com/weather',
        prompt: 'Summarize this page',
      });
      const result = await invocation.executeWithContext!({
        signal: new AbortController().signal,
        sessionId: 'session-from-tool-context',
        config: {
          getModelPolicy,
        } as unknown as Config,
      });

      expect(result.llmContent).toContain('Processed weather content');
      expect(result.error).toBeUndefined();
      expect(select).toHaveBeenCalledWith({
        purpose: 'web_fetch',
        overrideSelection: {
          model: policyModel,
          config: {
            reasoning: { effort: 'none', thinking: { type: 'disabled' } },
            context: { maxOutputTokens: 8192 },
          },
        },
      });
      expect(inference).toHaveBeenCalledWith(
        expect.objectContaining({
          resolution: {
            model: policyModel,
            config: {
              reasoning: { effort: 'none', thinking: { type: 'disabled' } },
              context: { maxOutputTokens: 8192 },
              sampling: { temperature: 0.2 },
            },
          },
          qoder: expect.objectContaining({
            identity: expect.objectContaining({
              sessionId: 'session-from-tool-context',
            }),
            taskRouting: { taskId: 'agent_summary', policyTaskId: 'sdk_scene' },
            business: expect.objectContaining({
              type: 'webfetch_summary',
              sub_task: 'web_fetch',
            }),
          }),
        }),
      );
    });

    it('should fall back to default secondary model when model policy returns an empty object', async () => {
      mockFetchFn.mockResolvedValue(
        createMockResponse({
          status: 200,
          headers: { 'content-type': 'text/plain' },
          body: 'Weather content',
        }),
      );
      mockGenerateContent.mockResolvedValue('Processed weather content');
      const getModelPolicy = vi.fn().mockResolvedValue({});

      const tool = new WebFetchTool(mockConfig);
      const invocation = tool.build({
        url: 'https://example.com/weather',
        prompt: 'Summarize this page',
      });
      const result = await invocation.executeWithContext!({
        signal: new AbortController().signal,
        config: {
          getModelPolicy,
        } as unknown as Config,
      });

      expect(result.llmContent).toContain('Processed weather content');
      expect(result.error).toBeUndefined();
      expect(select).toHaveBeenCalledWith({ purpose: 'web_fetch' });
    });

    it('returns the saved source without secondary inference when model policy fails', async () => {
      mockFetchFn.mockResolvedValue(
        createMockResponse({
          status: 200,
          headers: { 'content-type': 'text/plain' },
          body: 'Weather content',
        }),
      );
      mockGenerateContent.mockResolvedValue('Processed weather content');
      const getModelPolicy = vi
        .fn()
        .mockRejectedValue(new Error('policy failed'));

      const tool = new WebFetchTool(mockConfig);
      const invocation = tool.build({
        url: 'https://example.com/weather',
        prompt: 'Summarize this page',
      });
      const result = await invocation.executeWithContext!({
        signal: new AbortController().signal,
        config: {
          getModelPolicy,
        } as unknown as Config,
      });

      expect(result.error).toBeUndefined();
      expect(await fs.readFile(sourcePath(result.llmContent), 'utf8')).toBe(
        'Weather content',
      );
      expect(mockGenerateContent).not.toHaveBeenCalled();
    });

    it('should not fall back when model policy is aborted', async () => {
      mockFetchFn.mockResolvedValue(
        createMockResponse({
          status: 200,
          headers: { 'content-type': 'text/plain' },
          body: 'Weather content',
        }),
      );
      const abortError = new Error('Operation cancelled by user');
      abortError.name = 'AbortError';
      const getModelPolicy = vi.fn().mockRejectedValue(abortError);

      const tool = new WebFetchTool(mockConfig);
      const invocation = tool.build({
        url: 'https://example.com/weather',
        prompt: 'Summarize this page',
      });
      const result = await invocation.executeWithContext!({
        signal: new AbortController().signal,
        config: {
          getModelPolicy,
        } as unknown as Config,
      });

      expect(result.llmContent).toBe('Web fetch was cancelled.');
      expect(result.error).toBeUndefined();
      expect(mockGenerateContent).not.toHaveBeenCalled();
    });

    it('should handle cross-origin redirect', async () => {
      mockFetchFn.mockResolvedValue(
        createMockResponse({
          status: 302,
          headers: { location: 'https://other-host.com/page' },
        }),
      );

      const tool = new WebFetchTool(mockConfig);
      const invocation = tool.build({
        url: 'https://example.com',
        prompt: 'test',
      });
      const result = await invocation.execute(new AbortController().signal);

      expect(result.llmContent).toContain('REDIRECT DETECTED');
      expect(result.llmContent).toContain('https://other-host.com/page');
    });

    it('should short-circuit 404 without calling the secondary model', async () => {
      mockFetchFn.mockResolvedValue(
        createMockResponse({
          status: 404,
          statusText: 'Not Found',
          headers: { 'content-type': 'application/xml' },
          body: '<Error><Code>NoSuchKey</Code></Error>',
        }),
      );

      const tool = new WebFetchTool(mockConfig);
      const invocation = tool.build({
        url: 'https://example.com/missing',
        prompt: 'test',
      });
      const result = await invocation.execute(new AbortController().signal);

      expect(result.llmContent).toContain('HTTP ERROR');
      expect(result.llmContent).toContain('404');
      expect(mockGenerateContent).not.toHaveBeenCalled();
      expect((result.toolUseResult as { code: number }).code).toBe(404);
    });

    it('should short-circuit 500 without calling the secondary model', async () => {
      mockFetchFn.mockResolvedValue(
        createMockResponse({
          status: 500,
          statusText: 'Internal Server Error',
          headers: { 'content-type': 'text/html' },
          body: '<html>boom</html>',
        }),
      );

      const tool = new WebFetchTool(mockConfig);
      const invocation = tool.build({
        url: 'https://example.com/broken',
        prompt: 'test',
      });
      const result = await invocation.execute(new AbortController().signal);

      expect(result.llmContent).toContain('HTTP ERROR');
      expect(result.llmContent).toContain('500');
      expect(mockGenerateContent).not.toHaveBeenCalled();
    });

    it('should not throw when body cancel rejects on a non-2xx response', async () => {
      const rejectingResponse = {
        ok: false,
        status: 404,
        statusText: 'Not Found',
        headers: new Headers(),
        body: {
          getReader: () => ({
            read: async () => ({ done: true, value: undefined }),
            releaseLock: () => {},
            cancel: async () => {},
          }),
          cancel: () => Promise.reject(new Error('cancel failed')),
        } as unknown as ReadableStream,
        text: () => Promise.resolve(''),
      } as unknown as Response;
      mockFetchFn.mockResolvedValue(rejectingResponse);

      const tool = new WebFetchTool(mockConfig);
      const invocation = tool.build({
        url: 'https://example.com/missing',
        prompt: 'test',
      });
      const result = await invocation.execute(new AbortController().signal);

      expect(result.llmContent).toContain('HTTP ERROR');
      expect(result.llmContent).toContain('404');
      expect(mockGenerateContent).not.toHaveBeenCalled();
    });

    it('should pass through a numeric retry-after header', async () => {
      mockFetchFn.mockResolvedValue(
        createMockResponse({
          status: 429,
          statusText: 'Too Many Requests',
          headers: { 'retry-after': '120' },
        }),
      );

      const tool = new WebFetchTool(mockConfig);
      const invocation = tool.build({
        url: 'https://example.com/rate-limited',
        prompt: 'test',
      });
      const result = await invocation.execute(new AbortController().signal);

      expect(result.llmContent).toContain('retry after 120 seconds');
      expect(mockGenerateContent).not.toHaveBeenCalled();
    });

    it('should support an HTTP-date retry-after header', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2099-10-21T07:27:00.000Z'));
      mockFetchFn.mockResolvedValue(
        createMockResponse({
          status: 503,
          statusText: 'Service Unavailable',
          headers: { 'retry-after': 'Wed, 21 Oct 2099 07:28:00 GMT' },
        }),
      );

      const tool = new WebFetchTool(mockConfig);
      const invocation = tool.build({
        url: 'https://example.com/unavailable',
        prompt: 'test',
      });
      const result = await invocation.execute(new AbortController().signal);

      expect(result.llmContent).toContain('retry after 60 seconds');
      vi.useRealTimers();
    });

    it('should send a non-browser User-Agent header', async () => {
      mockFetchFn.mockResolvedValue(
        createMockResponse({
          status: 200,
          headers: { 'content-type': 'text/plain' },
          body: 'Content',
        }),
      );
      mockGenerateContent.mockResolvedValue('Processed');

      const tool = new WebFetchTool(mockConfig);
      const invocation = tool.build({
        url: 'https://example.com',
        prompt: 'test',
      });
      await invocation.execute(new AbortController().signal);

      expect(mockFetchFn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'User-Agent': expect.stringContaining(`${BRAND_CLI_BIN}/`),
          }),
        }),
      );
      expect(mockFetchFn.mock.calls.at(-1)?.[1]?.headers?.['User-Agent']).toContain(
        `(+${BRAND_WEBSITE_URL})`,
      );
    });

    it('should follow same-origin redirects', async () => {
      // First call returns redirect to same origin
      mockFetchFn
        .mockResolvedValueOnce(
          createMockResponse({
            status: 301,
            headers: { location: 'https://example.com/new-page' },
          }),
        )
        .mockResolvedValueOnce(
          createMockResponse({
            status: 200,
            headers: { 'content-type': 'text/plain' },
            body: 'Final content',
          }),
        );

      mockGenerateContent.mockResolvedValue('Processed final content');

      const tool = new WebFetchTool(mockConfig);
      const invocation = tool.build({
        url: 'https://example.com/old-page',
        prompt: 'test',
      });
      const result = await invocation.execute(new AbortController().signal);

      expect(result.llmContent).toContain('Processed final content');
      expect(mockFetchFn).toHaveBeenCalledTimes(2);
    });

    it('should upgrade http to https', async () => {
      mockFetchFn.mockResolvedValue(
        createMockResponse({
          status: 200,
          headers: { 'content-type': 'text/plain' },
          body: 'Content',
        }),
      );

      mockGenerateContent.mockResolvedValue('Processed');

      const tool = new WebFetchTool(mockConfig);
      const invocation = tool.build({
        url: 'http://example.com',
        prompt: 'test',
      });
      await invocation.execute(new AbortController().signal);

      // fetch should be called with https
      expect(mockFetchFn).toHaveBeenCalledWith(
        'https://example.com/',
        expect.any(Object),
      );
    });

    it('should return error for invalid URL', async () => {
      const tool = new WebFetchTool(mockConfig);
      // Bypass validation to test execute error handling
      const invocation = tool['createInvocation']({
        url: 'x',
        prompt: 'test',
      } as WebFetchToolParams);
      const result = await invocation.execute(new AbortController().signal);

      expect(result.error?.type).toBe(ToolErrorType.WEB_FETCH_PROCESSING_ERROR);
      expect(result.llmContent).toContain('Error');
    });

    it('should return error when fetch fails', async () => {
      mockFetchFn.mockRejectedValue(new Error('Network error'));

      const tool = new WebFetchTool(mockConfig);
      const invocation = tool.build({
        url: 'https://example.com',
        prompt: 'test',
      });
      const result = await invocation.execute(new AbortController().signal);

      expect(result.error?.type).toBe(ToolErrorType.WEB_FETCH_PROCESSING_ERROR);
      expect(result.llmContent).toContain('Network error');
      expect(result.returnDisplay).toContain('Network error');
    });

    it('summarizes a text/plain llms.txt and saves its source', async () => {
      mockGenerateContent.mockResolvedValue('index summary');
      const index =
        '# CLI\n\n- [Overview](https://docs.example.com/cli/overview.md)';
      mockFetchFn.mockResolvedValue(
        createMockResponse({
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
          body: index,
        }),
      );

      const tool = new WebFetchTool(mockConfig);
      const invocation = tool.build({
        url: 'https://docs.example.com/cli/llms.txt',
        prompt: 'Find the overview page',
      });
      const result = await invocation.execute(new AbortController().signal);

      expect(await fs.readFile(sourcePath(result.llmContent), 'utf8')).toBe(
        index,
      );
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    });

    it('should use cache for repeated requests', async () => {
      mockFetchFn.mockResolvedValue(
        createMockResponse({
          status: 200,
          headers: { 'content-type': 'text/plain' },
          body: 'Cached content',
        }),
      );

      mockGenerateContent.mockResolvedValue('Processed');

      const tool = new WebFetchTool(mockConfig);

      // First request
      const inv1 = tool.build({ url: 'https://example.com', prompt: 'test' });
      await inv1.execute(new AbortController().signal);

      // Second request — should hit cache
      const inv2 = tool.build({
        url: 'https://example.com',
        prompt: 'test again',
      });
      await inv2.execute(new AbortController().signal);

      // fetch should only be called once (second is cached)
      expect(mockFetchFn).toHaveBeenCalledTimes(1);
      // But generateContent should be called twice (processing still happens)
      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    });

    it('should handle model returning empty response', async () => {
      mockFetchFn.mockResolvedValue(
        createMockResponse({
          status: 200,
          headers: { 'content-type': 'text/plain' },
          body: 'Some content',
        }),
      );

      mockGenerateContent.mockResolvedValue('');

      const tool = new WebFetchTool(mockConfig);
      const invocation = tool.build({
        url: 'https://example.com',
        prompt: 'test',
      });
      const result = await invocation.execute(new AbortController().signal);

      expect(result.llmContent).toContain('No response from model');
    });
  });
});
