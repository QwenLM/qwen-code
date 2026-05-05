/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebSearchTool, __resetWebSearchCallCount } from './web-search.js';
import type { Config } from '../config/config.js';
import { ToolErrorType } from './tool-error.js';
import { DashScopeOpenAICompatibleProvider } from '../core/openaiContentGenerator/provider/dashscope.js';

const mockCreate = vi.fn();

function buildMockConfig(overrides: Partial<Record<string, unknown>> = {}) {
  const cgConfig = {
    apiKey: 'test-key',
    // matches DashScopeOpenAICompatibleProvider.isDashScopeProvider regex
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-coder',
    ...overrides,
  };
  return {
    getContentGeneratorConfig: vi.fn(() => cgConfig),
    getModel: vi.fn(() => cgConfig.model),
    getApprovalMode: vi.fn(),
    setApprovalMode: vi.fn(),
    getSessionId: vi.fn(() => 'test-session'),
    getCliVersion: vi.fn(() => '0.0.0'),
    getProxy: vi.fn(),
  } as unknown as Config;
}

function buildSearchResponse(
  results: Array<{
    title: string;
    url: string;
    snippet?: string;
    site_name?: string;
  }>,
) {
  return {
    search_info: {
      search_results: results.map((r, i) => ({ index: i, ...r })),
    },
    choices: [{ message: { content: '' } }],
  };
}

describe('WebSearchTool', () => {
  let mockConfig: Config;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockCreate.mockReset();
    // Bypass the real OpenAI client. We don't need to test provider.buildClient()
    // here — provider transport (headers, proxy, runtime fetch options) is
    // owned and tested by the provider module itself; what matters for
    // WebSearchTool is what `params` we pass to chat.completions.create.
    vi.spyOn(
      DashScopeOpenAICompatibleProvider.prototype,
      'buildClient',
    ).mockReturnValue({
      chat: { completions: { create: mockCreate } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    mockConfig = buildMockConfig();
    __resetWebSearchCallCount(mockConfig);
  });

  describe('parameter validation', () => {
    it('rejects query shorter than 2 characters', () => {
      const tool = new WebSearchTool(mockConfig);
      expect(() => tool.build({ query: 'a' })).toThrow();
    });

    it('rejects allowed_domains > 25', () => {
      const tool = new WebSearchTool(mockConfig);
      const tooMany = Array.from({ length: 26 }, (_, i) => `d${i}.com`);
      expect(() =>
        tool.build({ query: 'foo bar', allowed_domains: tooMany }),
      ).toThrow();
    });

    it('accepts a valid query', () => {
      const tool = new WebSearchTool(mockConfig);
      expect(() => tool.build({ query: 'foo bar' })).not.toThrow();
    });
  });

  describe('provider gating', () => {
    it('returns WEB_SEARCH_PROVIDER_UNSUPPORTED on non-DashScope baseUrl', async () => {
      const cfg = buildMockConfig({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-...',
      });
      const tool = new WebSearchTool(cfg);
      const inv = tool.build({ query: 'hello world' });
      const r = await inv.execute(new AbortController().signal);
      expect(r.error?.type).toBe(ToolErrorType.WEB_SEARCH_PROVIDER_UNSUPPORTED);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('returns WEB_SEARCH_PROVIDER_UNSUPPORTED when apiKey missing', async () => {
      // empty baseUrl is treated as DashScope (default), but no apiKey →
      // we still must reject (provider is unconfigured).
      const cfg = buildMockConfig({ apiKey: undefined });
      const tool = new WebSearchTool(cfg);
      const inv = tool.build({ query: 'hello world' });
      const r = await inv.execute(new AbortController().signal);
      expect(r.error?.type).toBe(ToolErrorType.WEB_SEARCH_PROVIDER_UNSUPPORTED);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('accepts dashscope-intl.aliyuncs.com', async () => {
      mockCreate.mockResolvedValueOnce(
        buildSearchResponse([{ title: 't', url: 'https://example.com/x' }]),
      );
      const cfg = buildMockConfig({
        baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      });
      const tool = new WebSearchTool(cfg);
      const inv = tool.build({ query: 'hello world' });
      const r = await inv.execute(new AbortController().signal);
      expect(r.error).toBeUndefined();
    });
  });

  describe('successful search', () => {
    it('parses search_info and formats results', async () => {
      mockCreate.mockResolvedValueOnce(
        buildSearchResponse([
          {
            title: 'Result one',
            url: 'https://example.com/a',
            snippet: 'snippet a',
            site_name: 'example.com',
          },
          {
            title: 'Result two',
            url: 'https://other.com/b',
            snippet: 'snippet b',
          },
        ]),
      );
      const tool = new WebSearchTool(mockConfig);
      const inv = tool.build({ query: 'hello world' });
      const r = await inv.execute(new AbortController().signal);
      expect(r.error).toBeUndefined();
      expect(r.llmContent).toContain('Result one');
      expect(r.llmContent).toContain('Result two');
      expect(r.llmContent).toContain('https://example.com/a');
      expect(r.llmContent).toContain('Safety:');
      expect(r.returnDisplay).toContain('2 result(s)');
    });

    it('passes assigned_site_list when allowed_domains is set', async () => {
      mockCreate.mockResolvedValueOnce(
        buildSearchResponse([{ title: 'r', url: 'https://github.com/a' }]),
      );
      const tool = new WebSearchTool(mockConfig);
      const inv = tool.build({
        query: 'hello world',
        allowed_domains: ['github.com', 'stackoverflow.com'],
      });
      await inv.execute(new AbortController().signal);
      expect(mockCreate).toHaveBeenCalledOnce();
      const params = mockCreate.mock.calls[0][0];
      expect(params.search_options.assigned_site_list).toEqual([
        'github.com',
        'stackoverflow.com',
      ]);
      expect(params.enable_search).toBe(true);
      expect(params.search_options.forced_search).toBe(true);
    });

    it('falls back to choices[0].message.search_info when top-level absent', async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: '',
              search_info: {
                search_results: [
                  {
                    index: 0,
                    title: 'nested',
                    url: 'https://example.com/nested',
                  },
                ],
              },
            },
          },
        ],
      });
      const tool = new WebSearchTool(mockConfig);
      const inv = tool.build({ query: 'hello world' });
      const r = await inv.execute(new AbortController().signal);
      expect(r.error).toBeUndefined();
      expect(r.llmContent).toContain('nested');
      expect(r.llmContent).toContain('https://example.com/nested');
    });
  });

  describe('blocked_domains normalization', () => {
    it('matches when blocklist entry has scheme/path/port', async () => {
      mockCreate.mockResolvedValueOnce(
        buildSearchResponse([
          { title: 'keep', url: 'https://github.com/a' },
          { title: 'drop1', url: 'https://evil.com/x' },
          { title: 'drop2', url: 'https://sub.evil.com/y' },
        ]),
      );
      const tool = new WebSearchTool(mockConfig);
      const inv = tool.build({
        query: 'hello world',
        blocked_domains: [
          'https://evil.com/some/path', // normalize → evil.com
          'evil.com:443', // normalize → evil.com (also matches sub.evil.com)
        ],
      });
      const r = await inv.execute(new AbortController().signal);
      expect(r.llmContent).toContain('keep');
      expect(r.llmContent).not.toContain('drop1');
      expect(r.llmContent).not.toContain('drop2');
    });

    it('does not over-match unrelated domains with similar suffix', async () => {
      mockCreate.mockResolvedValueOnce(
        buildSearchResponse([{ title: 'keep', url: 'https://notevil.com/x' }]),
      );
      const tool = new WebSearchTool(mockConfig);
      const inv = tool.build({
        query: 'hello world',
        blocked_domains: ['evil.com'],
      });
      const r = await inv.execute(new AbortController().signal);
      expect(r.llmContent).toContain('keep');
    });
  });

  describe('rate limiting', () => {
    it('blocks the 9th call in a session', async () => {
      mockCreate.mockResolvedValue(
        buildSearchResponse([{ title: 'r', url: 'https://example.com/a' }]),
      );
      const tool = new WebSearchTool(mockConfig);
      for (let i = 0; i < 8; i++) {
        const inv = tool.build({ query: `query ${i + 1}` });
        const r = await inv.execute(new AbortController().signal);
        expect(r.error).toBeUndefined();
      }
      const inv = tool.build({ query: 'query 9' });
      const r = await inv.execute(new AbortController().signal);
      expect(r.error?.type).toBe(ToolErrorType.WEB_SEARCH_RATE_LIMITED);
    });

    it('does not refund quota on HTTP backend failure (auth/quota)', async () => {
      // HTTP 401 is a backend response — the request crossed the network
      // boundary. Refunding would let an attacker burn unlimited quota by
      // making the backend return 401.
      const httpErr = Object.assign(new Error('Unauthorized'), { status: 401 });
      mockCreate.mockRejectedValueOnce(httpErr);
      const tool = new WebSearchTool(mockConfig);
      const inv1 = tool.build({ query: 'fails' });
      const r1 = await inv1.execute(new AbortController().signal);
      expect(r1.error?.type).toBe(ToolErrorType.WEB_SEARCH_BACKEND_FAILED);

      // The next 7 should still succeed (used 1 of 8); the 9th rate-limits.
      mockCreate.mockResolvedValue(
        buildSearchResponse([{ title: 'ok', url: 'https://example.com/x' }]),
      );
      for (let i = 0; i < 7; i++) {
        const inv = tool.build({ query: `q${i}` });
        const r = await inv.execute(new AbortController().signal);
        expect(r.error).toBeUndefined();
      }
      const inv9 = tool.build({ query: 'should be limited' });
      const r9 = await inv9.execute(new AbortController().signal);
      expect(r9.error?.type).toBe(ToolErrorType.WEB_SEARCH_RATE_LIMITED);
    });

    it('refunds quota on transport-only failure (no HTTP status)', async () => {
      // A pre-network failure (DNS/TLS/abort) — refundable.
      mockCreate.mockRejectedValueOnce(new Error('ENOTFOUND'));
      const tool = new WebSearchTool(mockConfig);
      const inv1 = tool.build({ query: 'fails' });
      const r1 = await inv1.execute(new AbortController().signal);
      expect(r1.error?.type).toBe(ToolErrorType.WEB_SEARCH_BACKEND_FAILED);

      // All 8 subsequent should succeed (counter was refunded to 0).
      mockCreate.mockResolvedValue(
        buildSearchResponse([{ title: 'ok', url: 'https://example.com/x' }]),
      );
      for (let i = 0; i < 8; i++) {
        const inv = tool.build({ query: `q${i}` });
        const r = await inv.execute(new AbortController().signal);
        expect(r.error).toBeUndefined();
      }
    });

    it('counts NO_RESULTS toward the quota (no bypass via empty results)', async () => {
      // Successful HTTP 200 with empty search_results consumes quota.
      mockCreate.mockResolvedValue(buildSearchResponse([]));
      const tool = new WebSearchTool(mockConfig);
      // First 8 calls all return NO_RESULTS but consume quota.
      for (let i = 0; i < 8; i++) {
        const inv = tool.build({ query: `q${i}` });
        const r = await inv.execute(new AbortController().signal);
        expect(r.error?.type).toBe(ToolErrorType.WEB_SEARCH_NO_RESULTS);
      }
      const inv9 = tool.build({ query: 'limit' });
      const r9 = await inv9.execute(new AbortController().signal);
      expect(r9.error?.type).toBe(ToolErrorType.WEB_SEARCH_RATE_LIMITED);
    });

    it('counts all-blocked-results toward the quota', async () => {
      // Backend returns hits but all match blocked_domains → still consumes.
      mockCreate.mockResolvedValue(
        buildSearchResponse([{ title: 't', url: 'https://blocked.com/a' }]),
      );
      const tool = new WebSearchTool(mockConfig);
      for (let i = 0; i < 8; i++) {
        const inv = tool.build({
          query: `q${i}`,
          blocked_domains: ['blocked.com'],
        });
        const r = await inv.execute(new AbortController().signal);
        expect(r.error?.type).toBe(ToolErrorType.WEB_SEARCH_NO_RESULTS);
      }
      const inv9 = tool.build({ query: 'limit' });
      const r9 = await inv9.execute(new AbortController().signal);
      expect(r9.error?.type).toBe(ToolErrorType.WEB_SEARCH_RATE_LIMITED);
    });

    it('reserves quota synchronously across concurrent calls', async () => {
      // Race scenario: 16 concurrent searches against quota=8. Only 8
      // should succeed; the rest must be rate-limited. If we read-then-
      // write across the await, all 16 would see used=0 initially.
      let resolveAll: (v: unknown) => void;
      const gate = new Promise((res) => {
        resolveAll = res;
      });
      mockCreate.mockImplementation(async () => {
        await gate;
        return buildSearchResponse([
          { title: 't', url: 'https://example.com/x' },
        ]);
      });
      const tool = new WebSearchTool(mockConfig);
      const promises: Array<Promise<unknown>> = [];
      for (let i = 0; i < 16; i++) {
        const inv = tool.build({ query: `q${i}` });
        promises.push(inv.execute(new AbortController().signal));
      }
      // Let the in-flight requests finish.
      resolveAll!(undefined);
      const results = (await Promise.all(promises)) as Array<{
        error?: { type: string };
      }>;
      const succeeded = results.filter((r) => !r.error).length;
      const limited = results.filter(
        (r) => r.error?.type === ToolErrorType.WEB_SEARCH_RATE_LIMITED,
      ).length;
      expect(succeeded).toBe(8);
      expect(limited).toBe(8);
    });
  });

  describe('confirmation details', () => {
    it('does not expose persistent permission rules', async () => {
      const tool = new WebSearchTool(mockConfig);
      const inv = tool.build({ query: 'hello world' });
      // BaseDeclarativeTool exposes shouldConfirmExecute via the invocation;
      // we directly test getConfirmationDetails() on the invocation impl.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const details = await (inv as any).getConfirmationDetails(
        new AbortController().signal,
      );
      // bare `WebSearch` rule would let "always allow" cover any future
      // query without scope; we deliberately leave permissionRules empty.
      expect(details.permissionRules).toEqual([]);
    });
  });

  describe('max_results clamping', () => {
    it('caps at HARD_MAX_RESULTS (50) when caller asks for more', async () => {
      const big = Array.from({ length: 100 }, (_, i) => ({
        title: `t${i}`,
        url: `https://example.com/p${i}`,
      }));
      mockCreate.mockResolvedValueOnce(buildSearchResponse(big));
      const tool = new WebSearchTool(mockConfig);
      const inv = tool.build({ query: 'foo', max_results: 999 });
      const r = await inv.execute(new AbortController().signal);
      expect(r.returnDisplay).toContain('50 result(s)');
    });

    it('floors at 1 when caller asks for 0 or negative', async () => {
      mockCreate.mockResolvedValueOnce(
        buildSearchResponse([
          { title: 'a', url: 'https://example.com/a' },
          { title: 'b', url: 'https://example.com/b' },
        ]),
      );
      const tool = new WebSearchTool(mockConfig);
      const inv = tool.build({ query: 'foo', max_results: 0 });
      const r = await inv.execute(new AbortController().signal);
      expect(r.returnDisplay).toContain('1 result(s)');
    });
  });

  describe('tool description', () => {
    it('warns about prompt injection', () => {
      const tool = new WebSearchTool(mockConfig);
      const desc = (tool as unknown as { description: string }).description;
      expect(desc).toMatch(/UNTRUSTED EXTERNAL CONTENT/);
      expect(desc).toMatch(/ignore previous instructions/);
    });

    it('documents blocked_domains hostname normalization', () => {
      const tool = new WebSearchTool(mockConfig);
      const desc = (tool as unknown as { description: string }).description;
      expect(desc).toMatch(/blocked_domains/);
      expect(desc).toMatch(/hostnames/);
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Wiring tests — make sure the registration side keeps WebSearch hooked up.
// These are intentionally minimal: they assert the registration is in place,
// not how each subsystem behaves (which is owned by their own test files).
// ──────────────────────────────────────────────────────────────────────────

describe('WebSearch registration wiring', () => {
  it('tool-names exposes WEB_SEARCH and WebSearch display name', async () => {
    const { ToolNames, ToolDisplayNames } = await import('./tool-names.js');
    expect(ToolNames.WEB_SEARCH).toBe('web_search');
    expect(ToolDisplayNames.WEB_SEARCH).toBe('WebSearch');
  });

  it('claude-converter maps Claude WebSearch → WebSearch (not None)', async () => {
    // claudeBuildInToolsTransform isn't exported; verify via the public
    // convertClaudeAgentConfig path which round-trips a Claude tools list
    // through the same mapping table.
    const { convertClaudeAgentConfig } = await import(
      '../extension/claude-converter.js'
    );
    const claudeAgent = {
      name: 'test-agent',
      tools: ['WebSearch', 'WebFetch'],
      model: 'claude-3-5',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const qwenAgent = convertClaudeAgentConfig(claudeAgent);
    expect(qwenAgent['tools']).toContain('WebSearch');
    expect(qwenAgent['tools']).toContain('WebFetch');
    expect(qwenAgent['tools']).not.toContain('None');
  });

  it('speculationToolGate halts at WebSearch (boundary tool)', async () => {
    const { evaluateToolCall } = await import(
      '../followup/speculationToolGate.js'
    );
    const { ApprovalMode } = await import('../config/config.js');
    const overlayFs = {
      resolveReadPath: (p: string) => p,
      redirectWrite: async (p: string) => p,
    };
    const result = await evaluateToolCall(
      'web_search',
      { query: 'q' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      overlayFs as any,
      ApprovalMode.DEFAULT,
    );
    expect(result.action).toBe('boundary');
    expect(result.reason).toContain('web_search');
  });

  it('rule-parser resolves WebSearch aliases to web_search', async () => {
    const { resolveToolName } = await import('../permissions/rule-parser.js');
    expect(resolveToolName('WebSearch')).toBe('web_search');
    expect(resolveToolName('WebSearchTool')).toBe('web_search');
    expect(resolveToolName('web_search')).toBe('web_search');
  });
});
