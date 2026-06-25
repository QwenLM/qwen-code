/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebFetchTool } from './web-fetch.js';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/config.js';
import { ToolConfirmationOutcome } from './tools.js';
import { ToolErrorType } from './tool-error.js';
import * as fetchUtils from '../utils/fetch.js';

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
    fetchWithTimeout: vi.fn(),
    isPrivateIp: vi.fn(),
  };
});

describe('WebFetchTool', () => {
  let mockConfig: Config;

  beforeEach(() => {
    vi.resetAllMocks();
    mockConfig = {
      getApprovalMode: vi.fn(),
      setApprovalMode: vi.fn(),
      getProxy: vi.fn(),
      getBaseLlmClient: mockGetBaseLlmClient,
      getFastModel: vi.fn(() => undefined),
      getSessionId: vi.fn(() => 'test-session-id'),
      getModel: vi.fn(() => 'qwen-coder'),
    } as unknown as Config;
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

    it.each(['ftp://example.com', 'http:example.com', 'http:/example.com'])(
      'should reject invalid or unsupported url schemes: %s',
      (url) => {
        const tool = new WebFetchTool(mockConfig);
        expect(() => tool.build({ url, prompt: 'summarize this' })).toThrow(
          "The 'url' must be a valid URL starting with http:// or https://.",
        );
      },
    );

    it('should return WEB_FETCH_FALLBACK_FAILED on fetch failure', async () => {
      vi.spyOn(fetchUtils, 'isPrivateIp').mockReturnValue(true);
      vi.spyOn(fetchUtils, 'fetchWithTimeout').mockRejectedValue(
        new Error('fetch failed'),
      );
      const tool = new WebFetchTool(mockConfig);
      const params = { url: 'https://private.ip', prompt: 'summarize this' };
      const invocation = tool.build(params);
      const result = await invocation.execute(new AbortController().signal);
      expect(result.error?.type).toBe(ToolErrorType.WEB_FETCH_FALLBACK_FAILED);
    });

    it('should return WEB_FETCH_FALLBACK_FAILED on API processing failure', async () => {
      vi.spyOn(fetchUtils, 'isPrivateIp').mockReturnValue(false);
      vi.spyOn(fetchUtils, 'fetchWithTimeout').mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: () => Promise.resolve('<html><body>Test content</body></html>'),
      } as Response);
      mockGenerateContent.mockRejectedValue(new Error('API error'));
      const tool = new WebFetchTool(mockConfig);
      const params = { url: 'https://public.ip', prompt: 'summarize this' };
      const invocation = tool.build(params);
      const result = await invocation.execute(new AbortController().signal);
      expect(result.error?.type).toBe(ToolErrorType.WEB_FETCH_FALLBACK_FAILED);
    });
  });

  describe('format parameter', () => {
    it('should default to auto format when not specified', async () => {
      const fetchSpy = vi
        .spyOn(fetchUtils, 'fetchWithTimeout')
        .mockResolvedValue({
          ok: true,
          headers: new Headers({ 'content-type': 'text/html' }),
          text: () => Promise.resolve('<html><body>Test content</body></html>'),
        } as Response);

      mockGenerateContent.mockResolvedValue({
        response: { text: () => 'Summary' },
      });

      const tool = new WebFetchTool(mockConfig);
      const params = { url: 'https://example.com', prompt: 'summarize' };
      const invocation = tool.build(params);
      await invocation.execute(new AbortController().signal);

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://example.com',
        expect.any(Number),
        {
          Accept: 'text/markdown, text/html;q=0.9, text/plain;q=0.8, */*;q=0.1',
        },
      );
    });

    it('should prefer markdown when format is markdown', async () => {
      const fetchSpy = vi
        .spyOn(fetchUtils, 'fetchWithTimeout')
        .mockResolvedValue({
          ok: true,
          headers: new Headers({ 'content-type': 'text/markdown' }),
          text: () => Promise.resolve('# Test Content'),
        } as Response);

      mockGenerateContent.mockResolvedValue({
        response: { text: () => 'Summary' },
      });

      const tool = new WebFetchTool(mockConfig);
      const params = {
        url: 'https://example.com',
        prompt: 'summarize',
        format: 'markdown' as const,
      };
      const invocation = tool.build(params);
      await invocation.execute(new AbortController().signal);

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://example.com',
        expect.any(Number),
        { Accept: 'text/markdown, */*;q=0.1' },
      );
    });

    it('should prefer HTML when format is html', async () => {
      const fetchSpy = vi
        .spyOn(fetchUtils, 'fetchWithTimeout')
        .mockResolvedValue({
          ok: true,
          headers: new Headers({ 'content-type': 'text/html' }),
          text: () => Promise.resolve('<html><body>Test content</body></html>'),
        } as Response);

      mockGenerateContent.mockResolvedValue({
        response: { text: () => 'Summary' },
      });

      const tool = new WebFetchTool(mockConfig);
      const params = {
        url: 'https://example.com',
        prompt: 'summarize',
        format: 'html' as const,
      };
      const invocation = tool.build(params);
      await invocation.execute(new AbortController().signal);

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://example.com',
        expect.any(Number),
        { Accept: 'text/html, */*;q=0.1' },
      );
    });

    it('should prefer plain text when format is text', async () => {
      const fetchSpy = vi
        .spyOn(fetchUtils, 'fetchWithTimeout')
        .mockResolvedValue({
          ok: true,
          headers: new Headers({ 'content-type': 'text/plain' }),
          text: () => Promise.resolve('Plain text content'),
        } as Response);

      mockGenerateContent.mockResolvedValue({
        response: { text: () => 'Summary' },
      });

      const tool = new WebFetchTool(mockConfig);
      const params = {
        url: 'https://example.com',
        prompt: 'summarize',
        format: 'text' as const,
      };
      const invocation = tool.build(params);
      await invocation.execute(new AbortController().signal);

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://example.com',
        expect.any(Number),
        { Accept: 'text/plain, */*;q=0.1' },
      );
    });

    it('should process JSON content returned by fallback content negotiation', async () => {
      let receivedContent = '';
      vi.spyOn(fetchUtils, 'fetchWithTimeout').mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: () =>
          Promise.resolve(
            JSON.stringify({
              published_at: '2026-01-27T11:50:52Z',
              body: '<p>Release <b>notes</b></p>',
              desc: 'Use &amp; for ampersand',
            }),
          ),
      } as Response);

      mockGenerateContent.mockImplementation((options) => {
        receivedContent = options.contents[0].parts[0].text;
        return Promise.resolve({ text: 'Processed', usage: undefined });
      });

      const tool = new WebFetchTool(mockConfig);
      const params = {
        url: 'https://api.github.com/repos/openai/codex/releases/tags/rust-v0.92.0',
        prompt: 'report the published date',
      };
      const invocation = tool.build(params);
      await invocation.execute(new AbortController().signal);

      expect(receivedContent).toContain('published_at');
      expect(receivedContent).toContain('2026-01-27T11:50:52Z');
      expect(receivedContent).toContain('<p>Release <b>notes</b></p>');
      expect(receivedContent).toContain('Use &amp; for ampersand');
    });

    it('should include markdown content in prompt when server returns markdown', async () => {
      let receivedContent = '';
      vi.spyOn(fetchUtils, 'fetchWithTimeout').mockResolvedValue({
        ok: true,
        headers: new Headers({
          'content-type': 'text/markdown; charset=utf-8',
        }),
        text: () =>
          Promise.resolve('# Hello World\n\nThis is markdown content.'),
      } as Response);

      mockGenerateContent.mockImplementation((options) => {
        receivedContent = options.contents[0].parts[0].text;
        return Promise.resolve({ text: 'Processed', usage: undefined });
      });

      const tool = new WebFetchTool(mockConfig);
      const params = { url: 'https://example.com', prompt: 'summarize' };
      const invocation = tool.build(params);
      await invocation.execute(new AbortController().signal);

      expect(receivedContent).toContain('# Hello World');
    });

    it('should include plain text content in prompt when server returns plain text', async () => {
      let receivedContent = '';
      vi.spyOn(fetchUtils, 'fetchWithTimeout').mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'text/plain' }),
        text: () => Promise.resolve('Plain text content here'),
      } as Response);

      mockGenerateContent.mockImplementation((options) => {
        receivedContent = options.contents[0].parts[0].text;
        return Promise.resolve({ text: 'Processed', usage: undefined });
      });

      const tool = new WebFetchTool(mockConfig);
      const params = {
        url: 'https://example.com',
        prompt: 'summarize',
        format: 'text' as const,
      };
      const invocation = tool.build(params);
      await invocation.execute(new AbortController().signal);

      expect(receivedContent).toContain('Plain text content here');
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

    it('should return github urls as-is in confirmation details', async () => {
      const tool = new WebFetchTool(mockConfig);
      const params = {
        url: 'https://github.com/google/gemini-react/blob/main/README.md',
        prompt: 'summarize the README',
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
          'Fetch content from https://github.com/google/gemini-react/blob/main/README.md and process with: summarize the README',
        urls: ['https://github.com/google/gemini-react/blob/main/README.md'],
        permissionRules: ['WebFetch(github.com)'],
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
