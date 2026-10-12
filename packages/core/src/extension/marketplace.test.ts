/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseInstallSource,
  loadMarketplaceConfigFromSource,
} from './marketplace.js';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import { promises as dns } from 'node:dns';

// Mock dependencies
vi.mock('node:fs/promises', () => ({
  stat: vi.fn(),
}));

vi.mock('node:fs', () => ({
  promises: {
    readFile: vi.fn(),
  },
}));

vi.mock('node:http', () => ({
  get: vi.fn(),
}));

vi.mock('node:https', () => ({
  get: vi.fn(),
}));

vi.mock('./github.js', async (importOriginal) => {
  // Real pure URL predicates (isSupportedArchiveUrl / isArchiveShapedUrl):
  // they do no I/O, so there is nothing to isolate and the suite that owns
  // the new policy asserts against the actual classifier, not a copy.
  const actual = await importOriginal<typeof import('./github.js')>();
  return {
    ...actual,
    parseGitHubRepoForReleases: vi.fn((url: string) => {
      const match = url.match(/github\.com\/([^/]+)\/([^/]+)/);
      if (match) {
        return { owner: match[1], repo: match[2] };
      }
      throw new Error('Not a GitHub URL');
    }),
  };
});

type Get = typeof http.get | typeof https.get;

/**
 * Makes `get` hand a fresh `makeRes()` to the response callback synchronously
 * and return a stub request whose `destroy` is `destroy`.
 */
function mockGet(get: Get, makeRes: () => object, destroy = vi.fn()) {
  vi.mocked(get as typeof http.get).mockImplementation(
    (_url, _options, callback) => {
      if (typeof callback === 'function') {
        callback(makeRes() as never);
      }
      return { on: vi.fn(), setTimeout: vi.fn(), destroy } as never;
    },
  );
}

/** A 200 response that emits `body` as JSON; `resume: false` omits it. */
const jsonRes =
  (body: unknown, { resume = true } = {}) =>
  () => ({
    statusCode: 200,
    ...(resume ? { resume: vi.fn() } : {}),
    on: vi.fn((event: string, handler: (chunk?: Buffer) => void) => {
      if (event === 'data') {
        handler(Buffer.from(JSON.stringify(body)));
      }
      if (event === 'end') {
        handler();
      }
    }),
  });

const marketplace = (name: string, owner = 'Owner', plugin = 'p1') => ({
  name,
  owner: { name: owner },
  plugins: [{ name: plugin }],
});

/** `fs.stat` fails once, so the source is not a local path. */
const statMissing = () =>
  vi.mocked(fs.stat).mockRejectedValueOnce(new Error('ENOENT'));

/**
 * Parses `input` with `fs.stat` reporting an existing local path (`local`) or
 * none, and checks each listed field; a key set to undefined asserts absence.
 */
async function expectParsed(
  input: string,
  expected: { source?: string; type?: string; pluginName?: string },
  local = false,
) {
  if (local) {
    vi.mocked(fs.stat).mockResolvedValueOnce({} as never);
  } else {
    statMissing();
  }
  const result = await parseInstallSource(input);
  for (const key of ['source', 'type', 'pluginName'] as const) {
    if (key in expected) {
      expect(result[key]).toBe(expected[key]);
    }
  }
  return result;
}

describe('parseInstallSource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: HTTPS requests fail (no marketplace config)
    const notFound = () => ({ statusCode: 404, resume: vi.fn(), on: vi.fn() });
    mockGet(https.get, notFound);
    mockGet(http.get, notFound);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('owner/repo format parsing', () => {
    it('should parse owner/repo format without plugin name', () =>
      expectParsed('owner/repo', {
        source: 'https://github.com/owner/repo',
        type: 'git',
        pluginName: undefined,
      }));

    it('should parse owner/repo format with plugin name', () =>
      expectParsed('owner/repo:my-plugin', {
        source: 'https://github.com/owner/repo',
        type: 'git',
        pluginName: 'my-plugin',
      }));

    it('should handle owner/repo with dashes and underscores', () =>
      expectParsed('my-org/my_repo:plugin-name', {
        source: 'https://github.com/my-org/my_repo',
        pluginName: 'plugin-name',
      }));
  });

  describe('HTTPS URL parsing', () => {
    it('should parse HTTPS GitHub URL without plugin name', () =>
      expectParsed('https://github.com/owner/repo', {
        source: 'https://github.com/owner/repo',
        type: 'git',
        pluginName: undefined,
      }));

    it('should parse HTTPS GitHub URL with plugin name', () =>
      expectParsed('https://github.com/owner/repo:my-plugin', {
        source: 'https://github.com/owner/repo',
        type: 'git',
        pluginName: 'my-plugin',
      }));

    it('should not treat port number as plugin name', () =>
      expectParsed('https://example.com:8080/repo', {
        source: 'https://example.com:8080/repo',
        pluginName: undefined,
      }));

    // The uppercase scheme must be recognized as a URL, so the colon in the
    // scheme is not mistaken for a pluginName separator.
    it('should parse an uppercase HTTPS URL scheme as a git source', () =>
      expectParsed('HTTPS://github.com/owner/repo:my-plugin', {
        source: 'HTTPS://github.com/owner/repo',
        type: 'git',
        pluginName: 'my-plugin',
      }));

    it('should parse supported archive URLs as archive-url installs', () =>
      expectParsed('https://example.com/releases/extension.tar.gz', {
        source: 'https://example.com/releases/extension.tar.gz',
        type: 'archive-url',
        pluginName: undefined,
      }));

    it('should parse supported archive URLs with plugin name', () =>
      expectParsed('https://example.com/releases/extension.zip:my-plugin', {
        source: 'https://example.com/releases/extension.zip',
        type: 'archive-url',
        pluginName: 'my-plugin',
      }));

    it('should reject http archive URLs with an actionable error', async () => {
      vi.mocked(fs.stat).mockRejectedValueOnce(new Error('ENOENT'));

      await expect(
        parseInstallSource('http://example.com/releases/extension.zip'),
      ).rejects.toThrow('Archive URLs must use https://');
    });

    it('should reject http archive URLs even when a query string hides the extension', async () => {
      vi.mocked(fs.stat).mockRejectedValueOnce(new Error('ENOENT'));

      await expect(
        parseInstallSource('http://example.com/releases/extension.zip?token=1'),
      ).rejects.toThrow('Archive URLs must use https://');
    });

    it('should reject an uppercase HTTP scheme with an archive extension', async () => {
      vi.mocked(fs.stat).mockRejectedValueOnce(new Error('ENOENT'));

      await expect(
        parseInstallSource('HTTP://example.com/releases/extension.tar.gz'),
      ).rejects.toThrow('Archive URLs must use https://');
    });

    it('should reject http archive URLs when a fragment follows the extension', async () => {
      vi.mocked(fs.stat).mockRejectedValueOnce(new Error('ENOENT'));

      await expect(
        parseInstallSource('http://example.com/releases/extension.zip#v1'),
      ).rejects.toThrow('Archive URLs must use https://');
    });

    it('should redact credentials in the https-required error', async () => {
      vi.mocked(fs.stat).mockRejectedValueOnce(new Error('ENOENT'));

      await expect(
        parseInstallSource(
          'http://user:ghp_s3cr3t@example.com/releases/extension.zip',
        ),
      ).rejects.toThrow(
        'http://***REDACTED***@example.com/releases/extension.zip',
      );
    });
  });

  describe('HTTP URL parsing', () => {
    it('should still parse plain http git URLs as git installs', async () => {
      vi.mocked(fs.stat).mockRejectedValueOnce(new Error('ENOENT'));

      const result = await parseInstallSource('http://example.com:8080/repo');

      expect(result.source).toBe('http://example.com:8080/repo');
      expect(result.type).toBe('git');
      expect(result.pluginName).toBeUndefined();
    });

    it('should keep non-http git transports with archive-shaped paths installable', async () => {
      // isArchiveShapedUrl is scheme-agnostic, so an sso:// URL whose
      // pathname ends in an archive extension is archive-shaped — but the
      // insecure-scheme rejection narrows to http:// only, because isGitUrl
      // admits other non-https transports that may legitimately serve git
      // repositories with such names. This case discriminates on that
      // conjunct: deleting the startsWith('http://') guard turns it red.
      vi.mocked(fs.stat).mockRejectedValueOnce(new Error('ENOENT'));

      const result = await parseInstallSource('sso://git.corp/team/tools.zip');

      expect(result.source).toBe('sso://git.corp/team/tools.zip');
      expect(result.type).toBe('git');
      expect(result.pluginName).toBeUndefined();
    });

    it('should keep unparseable http URLs on the git path instead of throwing Invalid URL', async () => {
      vi.mocked(fs.stat).mockRejectedValueOnce(new Error('ENOENT'));

      const result = await parseInstallSource('http://exa mple.com/plugin.zip');

      expect(result.type).toBe('git');
      expect(result.source).toBe('http://exa mple.com/plugin.zip');
    });

    it('should mention the git-remote reading for http URLs that end in an archive extension', async () => {
      vi.mocked(fs.stat).mockRejectedValueOnce(new Error('ENOENT'));

      // Only the git@/SSH remote (or a local clone into a non-archive-named
      // directory) actually reaches the git path — an https:// URL with an
      // archive pathname is classified as an archive download first — so the
      // message must not recommend it. The assertion pins the message
      // end-to-end (^…$): appends (M10), mid-message insertions and any
      // rewording that re-adds an https:// recommendation all go red here.
      await expect(
        parseInstallSource('http://example.com:8080/team/tools.zip'),
      ).rejects.toThrow(
        /^Archive URLs must use https:\/\/ \(got [^)]*\)\. Re-download the archive from an HTTPS URL — or, if this is a Git repository whose name ends in an archive extension, use its git@\/SSH remote, or clone it into a directory whose name does not end in \.zip or \.tar\.gz and install from that local path\.$/,
      );
    });
  });

  describe('git@ URL parsing', () => {
    it('should parse git@ URL without plugin name', () =>
      expectParsed('git@github.com:owner/repo.git', {
        source: 'git@github.com:owner/repo.git',
        type: 'git',
        pluginName: undefined,
      }));

    it('should parse git@ URL with plugin name', () =>
      expectParsed('git@github.com:owner/repo.git:my-plugin', {
        source: 'git@github.com:owner/repo.git',
        type: 'git',
        pluginName: 'my-plugin',
      }));
  });

  describe('local path parsing', () => {
    const local = (source: string) =>
      expectParsed(
        source,
        { source, type: 'local', pluginName: undefined },
        true,
      );

    it('should parse relative path with ../ correctly', () =>
      local('../claude-code'));

    it('should parse relative path with ./../ correctly', () =>
      local('./../claude-code'));

    it('should parse relative path with ./ correctly', () =>
      local('./my-extension'));

    it('should parse local path without plugin name', () =>
      local('/path/to/extension'));

    it('should parse local path with plugin name', () =>
      expectParsed(
        '/path/to/extension:my-plugin',
        {
          source: '/path/to/extension',
          type: 'local',
          pluginName: 'my-plugin',
        },
        true,
      ));

    // stat fails (path doesn't exist), so this falls through to the owner/repo
    // check and converts to a GitHub URL.
    it('should throw error for non-existent path that looks like owner/repo', () =>
      expectParsed('some-org/some-repo', {
        source: 'https://github.com/some-org/some-repo',
        type: 'git',
      }));

    it('should throw error for non-existent path that is not valid format', async () => {
      statMissing();

      await expect(
        parseInstallSource('invalid-format-no-slash'),
      ).rejects.toThrow('Install source not found: invalid-format-no-slash');
    });

    // The colon after C should not be treated as plugin separator.
    it('should handle Windows drive letter correctly', () =>
      local('C:\\path\\to\\extension'));
  });

  describe('scoped npm package parsing', () => {
    it('should parse scoped npm package without version', () =>
      expectParsed('@ali/openclaw-tmcp-dingtalk', {
        source: '@ali/openclaw-tmcp-dingtalk',
        type: 'npm',
        pluginName: undefined,
      }));

    it('should parse scoped npm package with version', () =>
      expectParsed('@ali/openclaw-tmcp-dingtalk@1.2.0', {
        source: '@ali/openclaw-tmcp-dingtalk@1.2.0',
        type: 'npm',
      }));

    it('should parse scoped npm package with latest tag', () =>
      expectParsed('@scope/my-extension@latest', {
        source: '@scope/my-extension@latest',
        type: 'npm',
      }));

    it('should parse scoped npm package with plugin name', () =>
      expectParsed('@ali/openclaw-tmcp-dingtalk:my-plugin', {
        source: '@ali/openclaw-tmcp-dingtalk',
        type: 'npm',
        pluginName: 'my-plugin',
      }));
  });

  describe('marketplace config detection', () => {
    it('should detect marketplace type when config exists', async () => {
      statMissing();
      const mockMarketplaceConfig = marketplace(
        'test-marketplace',
        'Test Owner',
        'plugin1',
      );
      // Mock successful API response
      mockGet(https.get, jsonRes(mockMarketplaceConfig, { resume: false }));

      const result = await parseInstallSource('owner/repo');

      expect(result.originSource).toBe('Claude');
      expect(result.marketplaceConfig).toEqual(mockMarketplaceConfig);
    });

    it('should remain git type when marketplace config not found', async () => {
      // HTTPS returns 404 (default mock behavior)
      const result = await expectParsed('owner/repo', { type: 'git' });

      expect(result.marketplaceConfig).toBeUndefined();
    });
  });

  describe('loadMarketplaceConfigFromSource', () => {
    /** Serves marketplace `name` as JSON over `get`, then loads `source`. */
    async function expectServedLoad(get: Get, name: string, source: string) {
      statMissing();
      const cfg = marketplace(name);
      mockGet(get, jsonRes(cfg));

      const result = await loadMarketplaceConfigFromSource(source);

      expect(result).toEqual(cfg);
    }

    it('fetches direct HTTP marketplace JSON with the HTTP client', async () => {
      await expectServedLoad(
        http.get,
        'http-marketplace',
        'http://example.com/marketplace.json',
      );
      expect(http.get).toHaveBeenCalledWith(
        'http://example.com/marketplace.json',
        {
          headers: { 'User-Agent': 'qwen-code' },
          signal: expect.any(AbortSignal),
        },
        expect.any(Function),
      );
      expect(https.get).not.toHaveBeenCalled();
    });

    it('resolves a marketplace from a git@ SSH source', () =>
      expectServedLoad(
        https.get,
        'ssh-marketplace',
        'git@github.com:owner/repo.git',
      ));

    it('resolves a marketplace from an uppercase HTTPS GitHub source', () =>
      expectServedLoad(
        https.get,
        'uppercase-url-marketplace',
        'HTTPS://github.com/owner/repo',
      ));

    it('resolves a direct JSON marketplace from an uppercase HTTPS source', () =>
      expectServedLoad(
        https.get,
        'uppercase-direct-marketplace',
        'HTTPS://example.com/marketplace.json',
      ));

    it('resolves a direct JSON marketplace from an uppercase HTTP source', async () => {
      await expectServedLoad(
        http.get,
        'uppercase-http-marketplace',
        'HTTP://example.com/marketplace.json',
      );
      expect(https.get).not.toHaveBeenCalledWith(
        'HTTP://example.com/marketplace.json',
        expect.anything(),
        expect.anything(),
      );
    });

    // A non-GitHub https URL reaches fetchUrl via a single direct-JSON fetch,
    // so these exercise the fetchUrl security guards in isolation.
    it('aborts and returns null when the response body exceeds the size cap', async () => {
      vi.mocked(fs.stat).mockRejectedValue(new Error('ENOENT'));
      const destroy = vi.fn();
      vi.mocked(https.get).mockImplementation((_url, _options, callback) => {
        const handlers: Record<string, (chunk?: Buffer) => void> = {};
        const res = {
          statusCode: 200,
          resume: vi.fn(),
          on: vi.fn((event: string, handler: (chunk?: Buffer) => void) => {
            handlers[event] = handler;
          }),
        };
        if (typeof callback === 'function') callback(res as never);
        // Emit one chunk past the 10 MB cap AFTER `req` is assigned in fetchUrl
        // (the real `https.get` invokes the response callback asynchronously);
        // 'end' never fires, so the guard must abort mid-stream.
        process.nextTick(() =>
          handlers['data']?.(Buffer.alloc(11 * 1024 * 1024)),
        );
        return { on: vi.fn(), setTimeout: vi.fn(), destroy } as never;
      });

      const result = await loadMarketplaceConfigFromSource(
        'https://example.com/marketplace.json',
      );
      expect(result).toBeNull();
      expect(destroy).toHaveBeenCalled();
    });

    it('aborts and returns null when the wall-clock deadline elapses', async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(fs.stat).mockRejectedValue(new Error('ENOENT'));
        const destroy = vi.fn();
        // A stalled/trickling server: connects with 200 but never emits 'data'
        // or 'end'. The socket-idle req.setTimeout (mocked no-op) would never
        // fire, so only the absolute wall-clock deadline can resolve it.
        mockGet(
          https.get,
          () => ({ statusCode: 200, resume: vi.fn(), on: vi.fn() }),
          destroy,
        );

        const promise = loadMarketplaceConfigFromSource(
          'https://example.com/marketplace.json',
        );
        // MARKETPLACE_FETCH_TIMEOUT_MS is 10s; advance just past it.
        await vi.advanceTimersByTimeAsync(10_000 + 50);
        await expect(promise).resolves.toBeNull();
        expect(destroy).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not start a request when DNS outlives the deadline', async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(fs.stat).mockRejectedValue(new Error('ENOENT'));
        vi.spyOn(dns, 'lookup').mockImplementation(
          () => new Promise(() => undefined),
        );

        const promise = loadMarketplaceConfigFromSource(
          'https://packages.example/marketplace.json',
          'public',
        );
        await vi.advanceTimersByTimeAsync(10_000);

        await expect(promise).resolves.toBeNull();
        expect(https.get).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
