/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkForExtensionUpdate,
  cloneFromGit,
  downloadFromArchiveUrl,
  downloadFromGitHubRelease,
  downloadPublicGitHubArchiveFallback,
  extractArchiveFile,
  extractFile,
  findReleaseAsset,
  isArchiveShapedUrl,
  isSupportedArchivePath,
  isSupportedArchiveUrl,
  parseGitHubRepoForReleases,
  resetLocalGitVersionCacheForTesting,
  shouldUsePublicGitHubArchiveFallback,
} from './github.js';
import { simpleGit, type SimpleGit } from 'simple-git';
import * as os from 'node:os';
import type * as https from 'node:https';
import type { IncomingMessage } from 'node:http';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { promises as dns } from 'node:dns';
import { gzipSync } from 'node:zlib';
import * as tar from 'tar';
import * as archiver from 'archiver';
import {
  ExtensionUpdateState,
  copyExtension,
  type Extension,
  type ExtensionManager,
} from './extensionManager.js';
import { convertCompatibleExtension } from './extension-converter.js';
import { getErrorMessage } from '../utils/errors.js';
import type { ExtensionInstallMetadata } from '../config/config.js';
import { EXTENSIONS_CONFIG_FILENAME } from './variables.js';
import { QODER_PLUGIN_MANIFEST } from './qoder-converter.js';
import { ExtensionStorage } from './storage.js';
import { assertTarArchiveLinksAreSafe } from './archive-safety.js';
import { AGENT_PLUGIN_SCHEMA } from './agent-plugins-v1/index.js';
import { prepareStoredGitCredential } from './extension-git-credentials.js';

const mockPlatform = vi.hoisted(() => vi.fn());
const mockArch = vi.hoisted(() => vi.fn());
const mockHttpsGet = vi.hoisted(() => vi.fn());
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return {
    ...actual,
    platform: mockPlatform,
    arch: mockArch,
  };
});
vi.mock('node:https', async (importOriginal) => {
  const actual = await importOriginal<typeof https>();
  return {
    ...actual,
    get: mockHttpsGet,
  };
});
vi.mock('simple-git');

describe('git extension helpers', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_TOKEN', '');
    resetLocalGitVersionCacheForTesting();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    mockHttpsGet.mockReset();
  });

  type GetOptions = https.RequestOptions | undefined;
  type Body = IncomingMessage | string | Buffer;

  function createResponse(
    responseBody: string | Buffer | undefined,
    statusCode = 200,
    headers: IncomingMessage['headers'] = {},
  ): IncomingMessage {
    const response = Readable.from([
      typeof responseBody === 'string'
        ? Buffer.from(responseBody)
        : (responseBody ?? Buffer.alloc(0)),
    ]) as IncomingMessage;
    Object.assign(response, { statusCode, headers });
    return response;
  }

  function streamingResponse(read: (this: Readable) => void): IncomingMessage {
    return Object.assign(new Readable({ read }), {
      statusCode: 200,
      headers: {},
    }) as IncomingMessage;
  }

  // A redirect response; omit `location` to model a missing header.
  function redirect(location?: string, statusCode = 302): IncomingMessage {
    return createResponse(
      undefined,
      statusCode,
      location === undefined ? {} : { location },
    );
  }

  function callResponseCallback(
    _options: GetOptions | ((res: IncomingMessage) => void),
    callback: ((res: IncomingMessage) => void) | undefined,
    response: IncomingMessage,
  ): void {
    (typeof _options === 'function' ? _options : callback)?.(response);
  }

  function createRequestMock(): ReturnType<typeof https.get> {
    return {
      on: vi.fn().mockReturnThis(),
      setTimeout: vi.fn().mockReturnThis(),
      destroy: vi.fn().mockReturnThis(),
    } as unknown as ReturnType<typeof https.get>;
  }

  // Header names are case-insensitive, so anonymity checks must not depend
  // on the exact casing the client used for a header key.
  function headerNames(
    options: GetOptions | ((res: IncomingMessage) => void),
  ): string[] {
    const headers =
      typeof options === 'function' ? undefined : options?.headers;
    return Object.keys(headers ?? {}).map((key) => key.toLowerCase());
  }

  const mockHttpsResponses = (...responses: Array<string | Buffer>) =>
    replyAlways(() => createResponse(responses.shift()));

  // Queues one https.get answer; `inspect` (asserts, aborts) runs first.
  function replyOnce(
    response: Body,
    inspect?: (url: string, options: GetOptions) => void,
    request = createRequestMock(),
  ): void {
    mockHttpsGet.mockImplementationOnce(((url, options, callback) => {
      inspect?.(String(url), options);
      callResponseCallback(
        options,
        callback,
        typeof response === 'string' || Buffer.isBuffer(response)
          ? createResponse(response)
          : response,
      );
      return request;
    }) as typeof https.get);
  }

  const replyEach = (...responses: Body[]) =>
    responses.forEach((response) => replyOnce(response));

  function replyAlways(makeResponse: () => IncomingMessage): void {
    mockHttpsGet.mockImplementation(((_url, options, callback) => {
      callResponseCallback(options, callback, makeResponse());
      return createRequestMock();
    }) as typeof https.get);
  }

  // Serves `response` once; the returned resume() spy shows it was drained.
  function replyDrained(response: IncomingMessage) {
    const resumeSpy = vi.spyOn(response, 'resume');
    replyOnce(response);
    return resumeSpy;
  }

  const getOptions = (call: number) =>
    mockHttpsGet.mock.calls[call][1] as GetOptions;

  // Resolves every host to a public address so network-policy checks pass.
  const mockPublicDns = () =>
    vi
      .spyOn(dns, 'lookup')
      .mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as never);

  async function withFakeTimers(fn: () => Promise<void>): Promise<void> {
    vi.useFakeTimers();
    try {
      await fn();
    } finally {
      vi.useRealTimers();
    }
  }

  async function withTempDir<T>(
    prefix: string,
    fn: (dir: string) => Promise<T>,
  ): Promise<T> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    try {
      return await fn(dir);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  async function caught(fn: () => unknown): Promise<unknown> {
    try {
      await fn();
    } catch (error: unknown) {
      return error;
    }
    return undefined;
  }

  function expectRedacted(message: string, redactedUrl: string): void {
    expect(message).toContain(redactedUrl);
    expect(message).not.toContain('user');
    expect(message).not.toContain('token');
  }

  const tgz = (file: string, cwd: string, entries: string[]) =>
    tar.c({ gzip: true, file, cwd }, entries);

  async function writeArchive(
    file: string,
    add: (archive: archiver.Archiver) => void,
    format: archiver.Format = 'zip',
    options?: archiver.ArchiverOptions,
  ): Promise<void> {
    const output = fsSync.createWriteStream(file);
    const archive = archiver.create(format, options);
    const streamFinished = new Promise((resolve, reject) => {
      output.on('close', () => resolve(null));
      archive.on('error', reject);
    });
    archive.pipe(output);
    add(archive);
    await archive.finalize();
    await streamFinished;
  }

  type ZipEntry = { name: string; content: string };

  async function createZipBuffer(
    tempDir: string,
    entries: ZipEntry[],
  ): Promise<Buffer> {
    const archivePath = path.join(tempDir, `archive-${Date.now()}.zip`);
    await writeArchive(archivePath, (archive) => {
      for (const entry of entries) {
        archive.append(entry.content, { name: entry.name });
      }
    });
    return fs.readFile(archivePath);
  }

  const zipManifest = (
    dir: string,
    config: object,
    name = EXTENSIONS_CONFIG_FILENAME,
  ) => createZipBuffer(dir, [{ name, content: JSON.stringify(config) }]);

  const exampleZip = 'https://example.com/extension.zip';
  const OLD_GIT = { major: 2, minor: 34, patch: 1 };
  const PINNED_GIT_OPTIONS = {
    config: [
      'http.curloptResolve=github.com:443:8.8.8.8',
      'http.followRedirects=false',
      'http.proxy=',
      'protocol.allow=never',
      'protocol.https.allow=always',
      'core.fsmonitor=',
      'log.showSignature=false',
    ],
    unsafe: {
      allowUnsafeConfigPaths: true,
      allowUnsafeProtocolOverride: true,
      allowUnsafeFsMonitor: true,
    },
  };
  const CREDENTIALED_UNSAFE = {
    allowUnsafeConfigPaths: true,
    allowUnsafeProtocolOverride: true,
    allowUnsafeConfigEnvCount: true,
    allowUnsafeFsMonitor: true,
  };
  const basicAuth = (userPass: string) =>
    `Authorization: Basic ${Buffer.from(userPass).toString('base64')}`;
  const cloneArgs = (symlinks: boolean) => [
    '-c',
    `core.symlinks=${symlinks}`,
    '--depth',
    '1',
  ];

  describe('cloneFromGit', () => {
    const mockGit = {
      clone: vi.fn(),
      getRemotes: vi.fn(),
      fetch: vi.fn(),
      checkout: vi.fn(),
      revparse: vi.fn(),
      version: vi.fn(),
      env: vi.fn(),
    };

    beforeEach(() => {
      vi.mocked(simpleGit).mockReturnValue(mockGit as unknown as SimpleGit);
      mockGit.env.mockReturnValue(mockGit);
      mockGit.version.mockResolvedValue({ major: 2, minor: 52 });
      mockGit.revparse.mockResolvedValue('local-hash');
    });

    const myRepo = 'http://my-repo.com';
    const githubRepo = 'https://github.com/owner/repo.git';
    const scpRepo = 'git@github.com:owner/repo.git';
    const credentialedRepo = 'https://user:token@my-repo.com/org/repo.git';
    const redactedRepo = 'https://***REDACTED***@my-repo.com/org/repo.git';

    // Clones into /dest with getRemotes reporting the source as origin.
    function cloneOrigin(
      metadata: Omit<ExtensionInstallMetadata, 'type'>,
      ...rest: [AbortSignal?, Parameters<typeof cloneFromGit>[3]?]
    ): Promise<string> {
      mockGit.getRemotes.mockResolvedValue([
        { name: 'origin', refs: { fetch: metadata.source } },
      ]);
      return cloneFromGit({ ...metadata, type: 'git' }, '/dest', ...rest);
    }

    it('should clone, fetch and checkout a repo', async () => {
      mockPlatform.mockReturnValue('linux');
      const controller = new AbortController();

      const commit = await cloneOrigin(
        { source: myRepo, ref: 'my-ref' },
        controller.signal,
      );

      expect(simpleGit).toHaveBeenCalledWith('/dest', {
        abort: controller.signal,
        config: ['core.fsmonitor=', 'log.showSignature=false'],
        unsafe: { allowUnsafeFsMonitor: true },
      });
      expect(mockGit.clone).toHaveBeenCalledWith(myRepo, './', cloneArgs(true));
      expect(mockGit.getRemotes).toHaveBeenCalledWith(true);
      expect(mockGit.fetch).toHaveBeenCalledWith(myRepo, 'my-ref');
      expect(mockGit.checkout).toHaveBeenCalledWith('FETCH_HEAD');
      expect(commit).toBe('local-hash');
    });

    it.each([
      [
        'should use core.symlinks=false on Windows to avoid permission errors',
        'win32',
        false,
      ],
      [
        'should use core.symlinks=true on non-Windows platforms',
        'darwin',
        true,
      ],
    ] as const)('%s', async (_title, platform, symlinks) => {
      mockPlatform.mockReturnValue(platform);
      await cloneOrigin({ source: myRepo, ref: 'my-ref' });
      expect(mockGit.clone).toHaveBeenCalledWith(
        myRepo,
        './',
        cloneArgs(symlinks),
      );
    });

    it('should use HEAD if ref is not provided', async () => {
      await cloneOrigin({ source: myRepo });
      expect(mockGit.fetch).toHaveBeenCalledWith(myRepo, 'HEAD');
    });

    it('pins public HTTPS Git traffic and disables redirects and proxies', async () => {
      vi.stubEnv('GIT_CONFIG_COUNT', '1');
      mockPublicDns();

      await cloneOrigin({ source: githubRepo, networkPolicy: 'public' });

      expect(simpleGit).toHaveBeenLastCalledWith('/dest', PINNED_GIT_OPTIONS);
      expect(mockGit.env).toHaveBeenCalledWith(
        expect.objectContaining({
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: expect.any(String),
        }),
      );
      expect(mockGit.env.mock.calls[0]?.[0]).not.toHaveProperty(
        'GIT_CONFIG_COUNT',
      );
      expect(mockGit.fetch).toHaveBeenCalledWith(githubRepo, 'HEAD');
    });

    it('explains how to install public extensions when Git is too old for DNS pinning', async () => {
      mockGit.version.mockResolvedValue(OLD_GIT);

      await expect(
        cloneFromGit(
          { source: githubRepo, type: 'git', networkPolicy: 'public' },
          '/dest',
        ),
      ).rejects.toThrow(
        'Public extension Git installs require Git 2.37 or newer unless the source is an anonymous public GitHub root repository; found Git 2.34.1. Upgrade Git for credentialed, non-GitHub, nested, submodule, or Git LFS installs.',
      );
      expect(mockGit.clone).not.toHaveBeenCalled();
    });

    it('accepts Git 2.37 while preserving public network pinning', async () => {
      mockGit.version.mockResolvedValue({ major: 2, minor: 37, patch: 0 });
      mockPublicDns();

      await cloneOrigin({ source: githubRepo, networkPolicy: 'public' });

      expect(simpleGit).toHaveBeenLastCalledWith('/dest', PINNED_GIT_OPTIONS);
      expect(mockGit.clone).toHaveBeenCalled();
    });

    it('passes explicit credentials through scoped Git config without changing the URL', async () => {
      mockPublicDns();
      const source = 'https://git.example.com/owner/repo.git';

      await cloneOrigin({ source, networkPolicy: 'public' }, undefined, {
        username: 'user',
        password: 'fine-grained-token',
      });

      expect(mockGit.clone).toHaveBeenCalledWith(source, './', cloneArgs(true));
      expect(simpleGit).toHaveBeenLastCalledWith(
        '/dest',
        expect.objectContaining({ unsafe: CREDENTIALED_UNSAFE }),
      );
      expect(mockGit.env).toHaveBeenCalledWith(
        expect.objectContaining({
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: `http.${source}.extraHeader`,
          GIT_CONFIG_VALUE_0: basicAuth('user:fine-grained-token'),
        }),
      );
      const gitEnvironment = mockGit.env.mock.calls.at(-1)?.[0];
      for (const key of [
        'GIT_CONFIG_PARAMETERS',
        'GIT_CONFIG_SYSTEM',
        'HOME',
        'HTTP_PROXY',
      ]) {
        expect(gitEnvironment).not.toHaveProperty(key);
      }
      expect(JSON.stringify(mockGit.clone.mock.calls)).not.toContain(
        'fine-grained-token',
      );
    });

    it('rejects an option-shaped ref before creating a credentialed Git client', async () => {
      await expect(
        cloneFromGit(
          {
            source: 'https://git.example.com/owner/remote.uploadpack.git',
            ref: '--upload-pack=attacker-command',
            type: 'git',
          },
          '/dest',
          undefined,
          { username: 'user', password: 'token' },
        ),
      ).rejects.toThrow('Git refs must not start with "-".');
      expect(simpleGit).not.toHaveBeenCalled();
      expect(mockGit.clone).not.toHaveBeenCalled();
    });

    it('injects GITHUB_TOKEN without adding it to the clone URL', async () => {
      vi.stubEnv('GITHUB_TOKEN', 'ambient-token');
      mockPublicDns();

      await cloneOrigin({ source: githubRepo, networkPolicy: 'public' });

      expect(mockGit.clone).toHaveBeenCalledWith(
        githubRepo,
        './',
        expect.any(Array),
      );
      expect(simpleGit).toHaveBeenLastCalledWith(
        '/dest',
        expect.objectContaining({ unsafe: CREDENTIALED_UNSAFE }),
      );
      expect(mockGit.env).toHaveBeenCalledWith(
        expect.objectContaining({
          GIT_CONFIG_VALUE_0: basicAuth('ambient-token:'),
        }),
      );
      expect(JSON.stringify(mockGit.clone.mock.calls)).not.toContain(
        'ambient-token',
      );
    });

    it('rejects SSH Git traffic under the public network policy', async () => {
      await expect(
        cloneFromGit(
          { source: scpRepo, type: 'git', networkPolicy: 'public' },
          '/dest',
        ),
      ).rejects.toThrow('must use HTTPS');
      expect(mockGit.clone).not.toHaveBeenCalled();
    });

    it('allows SCP-like SSH Git sources without the public network policy', async () => {
      await cloneOrigin({ source: scpRepo });

      expect(mockGit.clone).toHaveBeenCalledWith(
        scpRepo,
        './',
        cloneArgs(true),
      );
      expect(mockGit.fetch).toHaveBeenCalledWith(scpRepo, 'HEAD');
    });

    it('should throw if no remotes are found', async () => {
      mockGit.getRemotes.mockResolvedValue([]);

      await expect(
        cloneFromGit({ source: myRepo, type: 'git' }, '/dest'),
      ).rejects.toThrow(
        'Failed to clone Git repository from http://my-repo.com',
      );
    });

    it('should redact URL credentials in clone failures', async () => {
      mockGit.getRemotes.mockResolvedValue([]);

      const error = await caught(() =>
        cloneFromGit({ source: credentialedRepo, type: 'git' }, '/dest'),
      );

      expectRedacted(String(error), redactedRepo);
    });

    it('should redact URL credentials in clone failure causes', async () => {
      mockGit.clone.mockRejectedValue(
        new Error(`fatal: Authentication failed for '${credentialedRepo}'`),
      );

      const error = await caught(() =>
        cloneFromGit({ source: credentialedRepo, type: 'git' }, '/dest'),
      );

      expectRedacted(getErrorMessage(error), redactedRepo);
    });

    it('should preserve clone failure cause diagnostics while redacting its message', async () => {
      const gitError = Object.assign(
        new Error(`fatal: Authentication failed for '${credentialedRepo}'`),
        { code: 'ENOTFOUND', task: { commands: ['clone'] } },
      );
      mockGit.clone.mockRejectedValue(gitError);

      const error = await caught(() =>
        cloneFromGit({ source: credentialedRepo, type: 'git' }, '/dest'),
      );
      const cause = error instanceof Error ? error.cause : undefined;

      expect(cause).toBeInstanceOf(Error);
      expect(cause).not.toBe(gitError);
      expect((cause as Error).message).toContain(redactedRepo);
      expect((cause as Error).message).not.toContain('user');
      expect((cause as { code?: string }).code).toBe('ENOTFOUND');
      expect((cause as { task?: { commands: string[] } }).task).toEqual({
        commands: ['clone'],
      });
    });

    it('should throw on clone error', async () => {
      mockGit.clone.mockRejectedValue(new Error('clone failed'));

      await expect(
        cloneFromGit({ source: myRepo, type: 'git' }, '/dest'),
      ).rejects.toThrow(
        'Failed to clone Git repository from http://my-repo.com',
      );
    });

    it('preserves abort errors raised after a git operation', async () => {
      const controller = new AbortController();
      const reason = new Error('download cancelled');
      mockGit.clone.mockImplementationOnce(async () => {
        controller.abort(reason);
      });

      await expect(
        cloneFromGit(
          { source: myRepo, type: 'git' },
          '/dest',
          controller.signal,
        ),
      ).rejects.toBe(reason);
    });

    it('preserves a git failure when the signal aborts as a side effect', async () => {
      const controller = new AbortController();
      mockGit.clone.mockImplementationOnce(async () => {
        controller.abort();
        throw new Error('authentication failed');
      });

      await expect(
        cloneFromGit(
          { source: myRepo, type: 'git' },
          '/dest',
          controller.signal,
        ),
      ).rejects.toThrow(
        'Failed to clone Git repository from http://my-repo.com authentication failed',
      );
    });
  });

  describe('old-Git public GitHub archive fallback', () => {
    const fallbackSha = 'abcdef0123456789abcdef0123456789abcdef01';
    const treeUrl = `https://api.github.com/repos/owner/repo/git/trees/${fallbackSha}?recursive=1`;
    const codeloadUrl = `https://codeload.github.com/owner/repo/tar.gz/${fallbackSha}`;
    const emptyTree = JSON.stringify({ tree: [], truncated: false });
    const hasManifest = (dir: string) =>
      fsSync.existsSync(path.join(dir, EXTENSIONS_CONFIG_FILENAME));
    const gitLfsPointer = [
      'version https://git-lfs.github.com/spec/v1',
      'oid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393',
      'size 12345',
      '',
    ].join('\n');

    // Tars `source/repo-archive` (a manifest plus what `populate` adds) and
    // creates an empty `destination`, both under `tempDir`.
    async function tarRepoArchive(
      tempDir: string,
      populate?: (root: string, sourceDir: string) => Promise<void>,
      {
        manifestName = EXTENSIONS_CONFIG_FILENAME,
        entries = ['repo-archive'],
      } = {},
    ): Promise<{ archive: Buffer; destination: string }> {
      const sourceDir = path.join(tempDir, 'source');
      const root = path.join(sourceDir, 'repo-archive');
      const destination = path.join(tempDir, 'destination');
      await fs.mkdir(root, { recursive: true });
      await fs.mkdir(destination);
      await fs.writeFile(
        path.join(root, manifestName),
        JSON.stringify({ name: 'archive-extension', version: '1.0.0' }),
      );
      await populate?.(root, sourceDir);
      const archivePath = path.join(tempDir, 'source.tar.gz');
      await tgz(archivePath, sourceDir, entries);
      return { archive: await fs.readFile(archivePath), destination };
    }

    const runFallback = (
      destination: string,
      metadata: Partial<ExtensionInstallMetadata> = {},
      signal?: AbortSignal,
    ) =>
      downloadPublicGitHubArchiveFallback(
        {
          type: 'git',
          source: 'https://github.com/owner/repo',
          networkPolicy: 'public',
          ...metadata,
        },
        destination,
        signal,
      );

    const serveFallback = (
      archive: Buffer,
      tree: object = { tree: [], truncated: false },
    ) =>
      mockHttpsResponses(
        JSON.stringify({ sha: fallbackSha }),
        JSON.stringify(tree),
        archive,
      );

    function expectAnonymousPinned(options: GetOptions): void {
      expect(headerNames(options)).not.toContain('authorization');
      expect(typeof options?.lookup).toBe('function');
      expect(options?.agent).toBe(false);
    }

    it.each([
      ['HEAD', undefined],
      ['branch', 'feature/test'],
      ['tag', 'v1.2.3'],
      ['commit', '0123456789abcdef0123456789abcdef01234567'],
    ])(
      'resolves %s to a commit and downloads anonymously',
      async (_kind, ref) => {
        vi.stubEnv('GITHUB_TOKEN', 'must-not-be-sent');
        mockPublicDns();
        await withTempDir('old-git-fallback-test-', async (tempDir) => {
          const { archive, destination } = await tarRepoArchive(tempDir);
          replyOnce(JSON.stringify({ sha: fallbackSha }), (url, options) => {
            expect(url).toContain(
              `/commits/${encodeURIComponent(ref || 'HEAD')}`,
            );
            expectAnonymousPinned(options);
          });
          replyOnce(emptyTree, (url, options) => {
            expect(url).toBe(treeUrl);
            expectAnonymousPinned(options);
          });
          replyOnce(archive, (url, options) => {
            expect(url).toBe(codeloadUrl);
            expectAnonymousPinned(options);
          });

          await expect(
            runFallback(destination, {
              source: 'https://github.com/owner/repo.git',
              ...(ref ? { ref } : {}),
            }),
          ).resolves.toBe(fallbackSha);
          expect(hasManifest(destination)).toBe(true);
        });
      },
    );

    it('follows a limited GitHub API redirect when resolving the commit SHA', async () => {
      vi.stubEnv('GITHUB_TOKEN', 'must-not-be-sent');
      mockPublicDns();
      await withTempDir('old-git-fallback-redirect-test-', async (tempDir) => {
        const { archive, destination } = await tarRepoArchive(tempDir);
        const renamed =
          'https://api.github.com/repos/owner/renamed/commits/HEAD';
        replyOnce(redirect(renamed, 301));
        replyOnce(JSON.stringify({ sha: fallbackSha }), (url, options) => {
          expect(url).toBe(renamed);
          expect(headerNames(options)).not.toContain('authorization');
        });
        // The tree check targets the source owner/repo; rename redirects
        // are followed inside fetchJson, not by the caller.
        replyOnce(emptyTree, (url, options) => {
          expect(url).toBe(treeUrl);
          expect(headerNames(options)).not.toContain('authorization');
        });
        replyOnce(archive, (url) => expect(url).toBe(codeloadUrl));

        await expect(runFallback(destination)).resolves.toBe(fallbackSha);
        expect(hasManifest(destination)).toBe(true);
      });
    });

    it('rejects an invalid commit SHA before downloading the archive', async () => {
      vi.stubEnv('GITHUB_TOKEN', 'must-not-be-sent');
      mockPublicDns();
      replyOnce(JSON.stringify({ sha: 'not-a-valid-sha' }), (url, options) => {
        expect(url).toContain('/commits/HEAD');
        expect(headerNames(options)).not.toContain('authorization');
      });

      await expect(runFallback('/dest')).rejects.toThrow(
        'GitHub returned an invalid commit SHA.',
      );
      expect(mockHttpsGet).toHaveBeenCalledTimes(1);
    });

    it('aborts the commit SHA resolution when the signal aborts mid-request', async () => {
      vi.stubEnv('GITHUB_TOKEN', 'must-not-be-sent');
      mockPublicDns();
      const controller = new AbortController();
      const reason = new Error('download cancelled');
      // A response body that never completes: only the abort wiring can
      // settle this request, so a dropped signal hangs instead of aborting.
      const hangingResponse = streamingResponse(() => {});
      const request = createRequestMock();
      mockHttpsGet.mockImplementationOnce(((_url, options, callback) => {
        expect(String(_url)).toContain('/commits/HEAD');
        callResponseCallback(options, callback, hangingResponse);
        // Abort while the commit SHA request is still in flight.
        controller.abort(reason);
        return request;
      }) as typeof https.get);

      await expect(runFallback('/dest', {}, controller.signal)).rejects.toBe(
        reason,
      );
      expect(request.destroy).toHaveBeenCalled();
      // The archive download and every later request must be skipped.
      expect(mockHttpsGet).toHaveBeenCalledTimes(1);
    });

    it.each([
      'http://github.com/owner/repo',
      'https://gitlab.com/owner/repo',
      'https://user:pass@github.com/owner/repo',
      'https://github.com:8443/owner/repo',
      'https://github.com/owner/repo/path',
      'https://github.com/owner/repo?ref=main',
      'https://github.com/owner/repo#readme',
    ])(
      'rejects an ineligible source without network access: %s',
      async (source) => {
        await expect(runFallback('/dest', { source })).rejects.toThrow(
          'Older-Git fallback',
        );
        expect(mockHttpsGet).not.toHaveBeenCalled();
      },
    );

    // Runs the real fallback download against an archive whose repo root holds
    // `files`. The mocked commit-tree listing mirrors `files` unless
    // overridden, e.g. to model `export-ignore` hiding a path from the archive.
    async function runFallbackAgainstArchive(
      files: Record<string, string>,
      treeOverride?: {
        tree: Array<{ path: string; type: string }>;
        truncated?: boolean;
      },
    ): Promise<string> {
      mockPublicDns();
      return withTempDir('old-git-fallback-files-test-', async (tempDir) => {
        const { archive, destination } = await tarRepoArchive(
          tempDir,
          async (root) => {
            for (const [relativePath, contents] of Object.entries(files)) {
              const filePath = path.join(root, relativePath);
              await fs.mkdir(path.dirname(filePath), { recursive: true });
              await fs.writeFile(filePath, contents);
            }
          },
        );
        serveFallback(
          archive,
          treeOverride ?? {
            tree: Object.keys(files).map((filePath) => ({
              path: filePath.split(path.sep).join('/'),
              type: 'blob',
            })),
            truncated: false,
          },
        );
        return runFallback(destination);
      });
    }

    it.each([
      [
        'a root .gitmodules file',
        {
          '.gitmodules':
            '[submodule "nested"]\n\tpath = nested\n\turl = https://github.com/owner/nested.git',
        },
        'submodules',
      ],
      [
        // codeload archives honor `.gitattributes` `export-ignore`, so a
        // repository can hide its attributes file from the archive; the raw
        // pointer content must still be rejected (and no `.gitattributes`
        // means no grammar-only check could have seen the LFS config).
        'a Git LFS pointer file without any .gitattributes',
        { 'payload.bin': gitLfsPointer },
        'Git LFS',
      ],
      [
        'a nested Git LFS pointer file',
        { 'assets/payload.bin': gitLfsPointer },
        'Git LFS',
      ],
    ])(
      'rejects archives containing %s',
      async (_label, files, expectedError) => {
        await expect(runFallbackAgainstArchive(files)).rejects.toThrow(
          expectedError,
        );
      },
    );

    it('rejects a repo whose root .gitmodules is hidden from the archive via export-ignore', async () => {
      // codeload strips `export-ignore` paths from the archive, so the
      // extracted tree carries no `.gitmodules`; the commit tree still lists
      // it (with the submodule gitlink) and the tree check must fail closed.
      await expect(
        runFallbackAgainstArchive(
          {},
          {
            tree: [
              { path: '.gitmodules', type: 'blob' },
              { path: 'nested', type: 'commit' },
            ],
          },
        ),
      ).rejects.toThrow('submodules');
    });

    it('rejects a repo with a bare submodule gitlink and no .gitmodules', async () => {
      await expect(
        runFallbackAgainstArchive(
          {},
          { tree: [{ path: 'vendor/nested', type: 'commit' }] },
        ),
      ).rejects.toThrow('submodules');
    });

    it('rejects a repo when GitHub truncates the tree listing', async () => {
      await expect(
        runFallbackAgainstArchive({}, { tree: [], truncated: true }),
      ).rejects.toThrow('tree listing');
    });

    it('still rejects a root .gitmodules absent from the tree listing', async () => {
      // Defense in depth: even if the tree listing under-reports, the
      // extracted-tree scan must keep rejecting a root `.gitmodules`.
      await expect(
        runFallbackAgainstArchive(
          { '.gitmodules': '[submodule "nested"]\n\tpath = nested\n' },
          { tree: [] },
        ),
      ).rejects.toThrow('submodules');
    });

    // Issue #8993's repro repository (obra/superpowers) carries a root
    // symlink `AGENTS.md -> CLAUDE.md`, and GitHub codeload archives
    // preserve repository symlinks. Issue #9724 lifted the blanket link ban
    // for this fallback: a target that resolves inside the archive root now
    // installs, while anything escaping it still fails closed. The escape
    // case below must fail if that containment is ever silently removed.
    it.runIf(process.platform !== 'win32')(
      'installs an archive with a root symlink like the issue #8993 repro repo',
      async () => {
        mockPublicDns();
        await withTempDir('old-git-fallback-symlink-test-', async (tempDir) => {
          const { archive, destination } = await tarRepoArchive(
            tempDir,
            async (root) => {
              await fs.writeFile(path.join(root, 'CLAUDE.md'), '# agents\n');
              await fs.symlink('CLAUDE.md', path.join(root, 'AGENTS.md'));
            },
            { manifestName: 'gemini-extension.json' },
          );
          serveFallback(archive);

          let convertedDir: string | undefined;
          try {
            await expect(runFallback(destination)).resolves.toBe(fallbackSha);
            // The extracted tree preserves the repository symlink for the
            // format converter and installer to process.
            const installedLink = path.join(destination, 'AGENTS.md');
            expect((await fs.lstat(installedLink)).isSymbolicLink()).toBe(true);
            expect(await fs.readlink(installedLink)).toBe('CLAUDE.md');

            const converted = await convertCompatibleExtension(destination);
            convertedDir = converted.extensionDir;
            expect(converted.originSource).toBe('Gemini');
            const installed = path.join(tempDir, 'installed');
            await copyExtension(converted.extensionDir, installed);
            const installedAgents = path.join(installed, 'AGENTS.md');
            expect((await fs.lstat(installedAgents)).isFile()).toBe(true);
            expect(await fs.readFile(installedAgents, 'utf8')).toBe(
              '# agents\n',
            );
          } finally {
            if (convertedDir && convertedDir !== destination) {
              await fs.rm(convertedDir, { recursive: true, force: true });
            }
          }
        });
      },
    );

    it.runIf(process.platform !== 'win32')(
      'rejects an archive whose symlink escapes the archive root',
      async () => {
        mockPublicDns();
        await withTempDir('old-git-fallback-escape-test-', async (tempDir) => {
          // Contained before flattening because `pwn` is an archive entry,
          // but moving the link out of the wrapper makes `../pwn` escape the
          // destination. The post-flatten check must reject it.
          const { archive, destination } = await tarRepoArchive(
            tempDir,
            async (root, sourceDir) => {
              await fs.writeFile(
                path.join(sourceDir, 'pwn'),
                'planted content\n',
              );
              await fs.symlink('../pwn', path.join(root, 'escape'));
            },
            { entries: ['repo-archive', 'pwn'] },
          );
          serveFallback(archive);

          await expect(runFallback(destination)).rejects.toThrow(
            /Extension archive could not be extracted.*Extracted directory tree contains unsupported link entry: .*escape/,
          );
        });
      },
    );

    it('accepts an archive whose only .gitmodules file is nested', async () => {
      await expect(
        runFallbackAgainstArchive({
          'fixtures/.gitmodules': '[submodule "inert"]',
        }),
      ).resolves.toBe(fallbackSha);
    });

    it('accepts an archive with commented-out LFS attributes and no pointer content', async () => {
      await expect(
        runFallbackAgainstArchive({
          '.gitattributes': '# *.bin filter=lfs diff=lfs merge=lfs -text\n',
        }),
      ).resolves.toBe(fallbackSha);
    });

    // A ustar header for a zero-content file (as in archive-safety.test.ts):
    // `tar.t` parses headers without entry content, so a header declaring a
    // huge size exercises the expanded-size ceiling without gigabytes of data.
    function createTarFileHeader(name: string, size: number): Buffer {
      const header = Buffer.alloc(512);
      header.write(name, 0, 100, 'utf8');
      header.write('0000644\0', 100, 8); // mode
      header.write('0000000\0', 108, 8); // uid
      header.write('0000000\0', 116, 8); // gid
      header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12);
      header.write('14763423360\0', 136, 12); // mtime
      header.write('        ', 148, 8); // checksum placeholder (spaces)
      header.write('0', 156, 1); // typeflag: regular file
      header.write('ustar\0', 257, 6);
      header.write('00', 263, 2);
      let checksum = 0;
      for (const byte of header) {
        checksum += byte;
      }
      header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
      return header;
    }

    it('enforces the expanded-size limit on the downloaded fallback archive', async () => {
      mockPublicDns();
      await withTempDir('old-git-fallback-size-test-', async (tempDir) => {
        const destination = path.join(tempDir, 'destination');
        await fs.mkdir(destination);
        const maxExpandedBytes = 1024 * 1024 * 1024;
        serveFallback(
          gzipSync(
            Buffer.concat([
              createTarFileHeader('big.bin', maxExpandedBytes + 1),
              Buffer.alloc(1024), // tar trailer
            ]),
          ),
        );

        await expect(runFallback(destination)).rejects.toThrow(
          `Tar archive expands beyond ${maxExpandedBytes} bytes.`,
        );
      });
    });
  });

  describe('shouldUsePublicGitHubArchiveFallback', () => {
    const gateGit = { version: vi.fn() };

    beforeEach(() => {
      vi.mocked(simpleGit).mockReturnValue(gateGit as unknown as SimpleGit);
    });

    afterEach(() => {
      gateGit.version.mockReset();
    });

    function createMetadata(
      overrides: Partial<ExtensionInstallMetadata> = {},
    ): ExtensionInstallMetadata {
      return {
        type: 'git',
        source: 'https://github.com/owner/repo',
        networkPolicy: 'public',
        ...overrides,
      };
    }

    it('uses the fallback for old Git with an anonymous public GitHub root', async () => {
      gateGit.version.mockResolvedValue(OLD_GIT);
      await expect(
        shouldUsePublicGitHubArchiveFallback(createMetadata()),
      ).resolves.toBe(true);
    });

    it('stays on pinned Git when Git is modern enough', async () => {
      gateGit.version.mockResolvedValue({ major: 2, minor: 52, patch: 0 });
      await expect(
        shouldUsePublicGitHubArchiveFallback(createMetadata()),
      ).resolves.toBe(false);
    });

    const failClosedCases: Array<[string, Partial<ExtensionInstallMetadata>]> =
      [
        ['stored credentials', { credentialPersistence: 'stored' }],
        [
          'a Claude marketplace config',
          {
            marketplaceConfig: {
              name: 'marketplace',
              owner: { name: 'owner', email: 'owner@example.com' },
              plugins: [],
            },
          },
        ],
        ['a plugin name', { pluginName: 'sample-plugin' }],
        ['external content', { externalContent: true }],
        ['a missing public network policy', { networkPolicy: undefined }],
        ['a non-git install type', { type: 'github-release' }],
        ['a non-GitHub source', { source: 'https://gitlab.com/owner/repo' }],
        [
          'a nested GitHub path',
          { source: 'https://github.com/owner/repo/nested' },
        ],
      ];

    it.each(failClosedCases)(
      'stays fail-closed on old Git for %s',
      async (_label, overrides) => {
        gateGit.version.mockResolvedValue(OLD_GIT);
        await expect(
          shouldUsePublicGitHubArchiveFallback(createMetadata(overrides)),
        ).resolves.toBe(false);
      },
    );
  });

  describe('checkForExtensionUpdate', () => {
    const { UP_TO_DATE, UPDATE_AVAILABLE, NOT_UPDATABLE, ERROR } =
      ExtensionUpdateState;

    const managerReturning = (config: { name: string; version: string }) =>
      ({
        loadExtensionConfig: vi.fn().mockReturnValue(config),
      }) as unknown as ExtensionManager;

    // Reads the real extracted/converted manifest (asserting it exists first).
    function readingManager(checkExtracted = false): ExtensionManager {
      const loadExtensionConfig = vi.fn(
        ({ extensionDir }: { extensionDir: string }) => {
          const manifest = path.join(extensionDir, EXTENSIONS_CONFIG_FILENAME);
          if (checkExtracted) expect(fsSync.existsSync(manifest)).toBe(true);
          return JSON.parse(fsSync.readFileSync(manifest, 'utf-8'));
        },
      );
      return { loadExtensionConfig } as unknown as ExtensionManager;
    }

    it.skipIf(process.platform === 'win32')(
      'does not try to extract uploaded archive metadata sources',
      async () => {
        const source = `upload:v1:${randomBytes(8).toString('hex')}:extension.zip`;
        await withTempDir('uploaded-archive-update-test-', async (tempDir) => {
          const previousCwd = process.cwd();
          process.chdir(tempDir);
          try {
            const uploaded = { name: 'uploaded', version: '2.0.0' };
            await fs.writeFile(source, await zipManifest(tempDir, uploaded));
            const extension = {
              name: 'uploaded',
              version: '1.0.0',
              installMetadata: { type: 'local' as const, source },
            } as Extension;
            const mockManager = managerReturning({ ...uploaded });

            await expect(
              checkForExtensionUpdate(extension, mockManager),
            ).resolves.toBe(NOT_UPDATABLE);
            expect(mockManager.loadExtensionConfig).not.toHaveBeenCalled();
          } finally {
            await fs.rm(source, { force: true });
            process.chdir(previousCwd);
          }
        });
      },
    );

    const mockGit = {
      getRemotes: vi.fn(),
      listRemote: vi.fn(),
      revparse: vi.fn(),
      version: vi.fn(),
      env: vi.fn(),
    };

    const mockExtensionManager = {
      loadExtensionConfig: vi.fn(),
    } as unknown as ExtensionManager;

    beforeEach(() => {
      vi.mocked(simpleGit).mockReturnValue(mockGit as unknown as SimpleGit);
      mockGit.version.mockResolvedValue({ major: 2, minor: 52 });
      mockGit.env.mockReturnValue(mockGit);
    });

    function createExtension(overrides: Partial<Extension> = {}): Extension {
      return {
        id: 'test-id',
        name: 'test',
        path: '/ext',
        version: '1.0.0',
        isActive: true,
        config: { name: 'test', version: '1.0.0' },
        contextFiles: [],
        ...overrides,
      };
    }

    function check(
      installMetadata: ExtensionInstallMetadata,
      manager = mockExtensionManager,
      signal?: AbortSignal,
      overrides: Partial<Extension> = {},
    ): Promise<ExtensionUpdateState> {
      return checkForExtensionUpdate(
        createExtension({ ...overrides, installMetadata }),
        manager,
        signal,
      );
    }

    function mockRemoteCheck(fetch: string, remote: string, local: string) {
      mockGit.getRemotes.mockResolvedValue([
        { name: 'origin', refs: { fetch } },
      ]);
      mockGit.listRemote.mockResolvedValue(`${remote}\tHEAD`);
      mockGit.revparse.mockResolvedValue(local);
    }

    const pinnedCommit = '0123456789abcdef0123456789abcdef01234567';
    // Old Git: the remote HEAD SHA comes from the GitHub API, not ls-remote.
    function checkOldGitSha(remoteSha: string) {
      mockGit.version.mockResolvedValue(OLD_GIT);
      mockPublicDns();
      mockHttpsResponses(JSON.stringify({ sha: remoteSha }));
      return check({
        type: 'git',
        source: 'https://github.com/owner/repo',
        gitCommit: pinnedCommit,
        networkPolicy: 'public',
      });
    }

    it.each([
      ['same', pinnedCommit, UP_TO_DATE],
      [
        'different',
        '89abcdef0123456789abcdef0123456789abcdef',
        UPDATE_AVAILABLE,
      ],
    ])(
      'checks old-Git public GitHub SHA when remote is %s',
      async (_case, remoteSha, expected) => {
        expect(await checkOldGitSha(remoteSha)).toBe(expected);
        expect(mockGit.listRemote).not.toHaveBeenCalled();
      },
    );

    it('returns ERROR when the old-Git update check receives an invalid SHA', async () => {
      expect(await checkOldGitSha('not-a-valid-sha')).toBe(ERROR);
      expect(mockGit.listRemote).not.toHaveBeenCalled();
    });

    it('returns NOT_UPDATABLE when the old-Git install has no stored commit', async () => {
      mockGit.version.mockResolvedValue(OLD_GIT);
      const result = await check({
        type: 'git',
        source: 'https://github.com/owner/repo',
        networkPolicy: 'public',
      });

      expect(result).toBe(NOT_UPDATABLE);
      expect(mockHttpsGet).not.toHaveBeenCalled();
      expect(mockGit.listRemote).not.toHaveBeenCalled();
    });

    it('should return NOT_UPDATABLE for non-git extensions', async () => {
      expect(await check({ type: 'link', source: '' })).toBe(NOT_UPDATABLE);
    });

    it('should return ERROR if no remotes found', async () => {
      mockGit.getRemotes.mockResolvedValue([]);
      expect(await check({ type: 'git', source: '' })).toBe(ERROR);
    });

    it('should return UPDATE_AVAILABLE when remote hash is different', async () => {
      mockRemoteCheck('http://my-repo.com', 'remote-hash', 'local-hash');
      expect(await check({ type: 'git', source: 'my/ext' })).toBe(
        UPDATE_AVAILABLE,
      );
    });

    it('uses stored credentials for a clean exact-scope remote check', async () => {
      await withTempDir('stored-git-update-test-', async (tempDir) => {
        vi.stubEnv('QWEN_HOME', path.join(tempDir, 'qwen-home'));
        vi.stubEnv('QWEN_CODE_FORCE_FILE_STORAGE', 'true');
        mockPublicDns();
        const source = 'https://git.example.com/owner/repo.git';
        const extensionPath = path.join(tempDir, 'extension');
        await fs.mkdir(extensionPath);
        const stored = await prepareStoredGitCredential(extensionPath, {
          username: 'user',
          password: 'fine-grained-token',
        });
        stored.commit();
        mockGit.listRemote.mockResolvedValue('remote-hash\tHEAD');

        const result = await check(
          {
            type: 'git',
            source,
            gitCommit: 'local-hash',
            credentialPersistence: 'stored',
            networkPolicy: 'public',
          },
          undefined,
          undefined,
          { path: extensionPath },
        );

        expect(result).toBe(UPDATE_AVAILABLE);
        expect(mockGit.listRemote).toHaveBeenCalledWith([source, 'HEAD']);
        expect(simpleGit).toHaveBeenLastCalledWith(
          extensionPath,
          expect.objectContaining({ unsafe: CREDENTIALED_UNSAFE }),
        );
        expect(mockGit.env).toHaveBeenLastCalledWith(
          expect.objectContaining({
            GIT_CONFIG_KEY_0: `http.${source}.extraHeader`,
            GIT_CONFIG_VALUE_0: basicAuth('user:fine-grained-token'),
          }),
        );
        expect(JSON.stringify(mockGit.listRemote.mock.calls)).not.toContain(
          'fine-grained-token',
        );
      });
    });

    it('rejects an option-shaped ref before a credentialed remote check', async () => {
      vi.stubEnv('GITHUB_TOKEN', 'ambient-token');
      const result = await check({
        type: 'git',
        source: 'https://github.com/owner/remote.uploadpack.git',
        gitCommit: 'local-hash',
        ref: '--upload-pack=attacker-command',
      });

      expect(result).toBe(ERROR);
      expect(simpleGit).not.toHaveBeenCalled();
      expect(mockGit.listRemote).not.toHaveBeenCalled();
    });

    it('fails a stored update check before Git when its selector is missing', async () => {
      await withTempDir('missing-git-credential-test-', async (tempDir) => {
        await expect(
          check(
            {
              type: 'git',
              source: 'https://git.example.com/owner/repo.git',
              gitCommit: 'local-hash',
              credentialPersistence: 'stored',
              networkPolicy: 'public',
            },
            undefined,
            undefined,
            { path: tempDir },
          ),
        ).rejects.toMatchObject({ code: 'extension_credential_unavailable' });
        expect(mockGit.listRemote).not.toHaveBeenCalled();
      });
    });

    const qoderPlugin = 'https://github.com/example/sample-qoder-plugin';

    it.each(['Qoder', 'Claude'] as const)(
      'checks a converted %s Git extension using its recorded commit',
      async (originSource) => {
        mockGit.listRemote.mockResolvedValue('remote-hash\tHEAD');

        const result = await check({
          type: 'git',
          source: qoderPlugin,
          originSource,
          gitCommit: 'local-hash',
        });

        expect(result).toBe(UPDATE_AVAILABLE);
        expect(mockGit.getRemotes).not.toHaveBeenCalled();
        expect(mockGit.listRemote).toHaveBeenCalledWith([qoderPlugin, 'HEAD']);
      },
    );

    it('uses the peeled commit when checking a recorded annotated tag', async () => {
      mockGit.listRemote.mockResolvedValue(
        'tag-hash\trefs/tags/v1.0.0\nlocal-hash\trefs/tags/v1.0.0^{}',
      );

      const result = await check({
        type: 'git',
        source: qoderPlugin,
        originSource: 'Qoder',
        gitCommit: 'local-hash',
        ref: 'v1.0.0',
      });

      expect(result).toBe(UP_TO_DATE);
      expect(mockGit.listRemote).toHaveBeenCalledWith([
        qoderPlugin,
        'v1.0.0',
        'v1.0.0^{}',
      ]);
    });

    it.each(['Qoder', 'Claude'] as const)(
      'does not update-check legacy %s Git installs without a recorded commit',
      async (originSource) => {
        const result = await check({
          type: 'git',
          source: qoderPlugin,
          originSource,
        });

        expect(result).toBe(NOT_UPDATABLE);
        expect(mockGit.listRemote).not.toHaveBeenCalled();
      },
    );

    const marketplace = 'https://github.com/example/sample-marketplace';

    it.each(['git', 'github-release'] as const)(
      'does not update-check external marketplace content installed through %s',
      async (type) => {
        const result = await check({
          type,
          source: marketplace,
          originSource: 'Claude',
          releaseTag: 'v1.0.0',
          externalContent: true,
        });

        expect(result).toBe(NOT_UPDATABLE);
        expect(mockGit.getRemotes).not.toHaveBeenCalled();
        expect(mockGit.listRemote).not.toHaveBeenCalled();
        expect(mockHttpsGet).not.toHaveBeenCalled();
      },
    );

    const marketplaceRelease = {
      type: 'github-release',
      source: marketplace,
      originSource: 'Claude',
      pluginName: 'sample-plugin',
      releaseTag: 'v1.0.0',
    } as const;

    it('does not update-check legacy Claude marketplace releases without content provenance', async () => {
      expect(await check({ ...marketplaceRelease })).toBe(NOT_UPDATABLE);
      expect(mockHttpsGet).not.toHaveBeenCalled();
    });

    it('update-checks marketplace releases with confirmed repository content', async () => {
      mockHttpsResponses(JSON.stringify({ tag_name: 'v2.0.0' }));

      const result = await check({
        ...marketplaceRelease,
        externalContent: false,
      });

      expect(result).toBe(UPDATE_AVAILABLE);
      expect(mockHttpsGet).toHaveBeenCalledOnce();
    });

    it('pins public Git update checks and disables redirects and proxies', async () => {
      mockPublicDns();
      const source = 'https://github.com/owner/repo.git';
      mockRemoteCheck(source, 'same-hash', 'same-hash');

      const result = await check({
        type: 'git',
        source,
        networkPolicy: 'public',
      });

      expect(result).toBe(UP_TO_DATE);
      expect(simpleGit).toHaveBeenLastCalledWith('/ext', PINNED_GIT_OPTIONS);
      expect(mockGit.listRemote).toHaveBeenCalledWith([source, 'HEAD']);
    });

    it('checks SCP-like SSH Git remotes without the public network policy', async () => {
      const source = 'git@github.com:owner/repo.git';
      mockRemoteCheck(source, 'same-hash', 'same-hash');

      expect(await check({ type: 'git', source })).toBe(UP_TO_DATE);
      expect(mockGit.listRemote).toHaveBeenCalledWith([source, 'HEAD']);
    });

    it('should return UP_TO_DATE when remote and local hashes are the same', async () => {
      mockRemoteCheck('http://my-repo.com', 'same-hash', 'same-hash');
      expect(await check({ type: 'git', source: 'my/ext' })).toBe(UP_TO_DATE);
    });

    it('should return ERROR on git error', async () => {
      mockGit.getRemotes.mockRejectedValue(new Error('git error'));
      expect(await check({ type: 'git', source: 'my/ext' })).toBe(ERROR);
    });

    it.each([
      [
        'should return UPDATE_AVAILABLE for local extension with different version',
        '2.0.0',
        UPDATE_AVAILABLE,
      ],
      [
        'should return UP_TO_DATE for local extension with same version',
        '1.0.0',
        UP_TO_DATE,
      ],
    ])('%s', async (_title, sourceVersion, expected) => {
      const manager = managerReturning({
        name: 'test',
        version: sourceVersion,
      });
      expect(
        await check({ type: 'local', source: '/path/to/source' }, manager),
      ).toBe(expected);
    });

    it('should convert a local Qoder plugin before checking for updates', async () => {
      await withTempDir('local-qoder-update-test-', async (tempDir) => {
        await fs.mkdir(path.join(tempDir, '.qoder-plugin'));
        await fs.writeFile(
          path.join(tempDir, QODER_PLUGIN_MANIFEST),
          JSON.stringify({ name: 'sample-qoder-plugin', version: '2.0.0' }),
        );

        const result = await check(
          { type: 'local', source: tempDir, originSource: 'Qoder' },
          readingManager(),
        );

        expect(result).toBe(UPDATE_AVAILABLE);
        expect(await fs.readdir(tempDir)).toEqual(['.qoder-plugin']);
      });
    });

    it('does not convert a local marketplace checkout during update checks', async () => {
      await withTempDir('local-marketplace-update-test-', async (tempDir) => {
        const manager = managerReturning({
          name: 'sample-plugin',
          version: '1.0.0',
        });

        const result = await check(
          {
            type: 'local',
            source: tempDir,
            originSource: 'Claude',
            pluginName: 'sample-plugin',
          },
          manager,
        );

        expect(result).toBe(UP_TO_DATE);
        expect(manager.loadExtensionConfig).toHaveBeenCalledWith({
          extensionDir: tempDir,
        });
        expect(await fs.readdir(tempDir)).toEqual([]);
      });
    });

    it('should return NOT_UPDATABLE for local extension when source cannot be loaded', async () => {
      const manager = {
        loadExtensionConfig: vi.fn().mockImplementation(() => {
          throw new Error('Cannot load config');
        }),
      } as unknown as ExtensionManager;

      expect(
        await check({ type: 'local', source: '/path/to/source' }, manager),
      ).toBe(NOT_UPDATABLE);
    });

    async function writeManifestZip(
      dir: string,
      file: string,
      config: object,
      manifestName?: string,
    ): Promise<string> {
      const archivePath = path.join(dir, file);
      await fs.writeFile(
        archivePath,
        await zipManifest(dir, config, manifestName),
      );
      return archivePath;
    }

    const geminiArchive = (dir: string) =>
      writeManifestZip(
        dir,
        'gemini-extension.zip',
        { name: 'gemini-archive-extension', version: '2.0.0' },
        'gemini-extension.json',
      );
    const qwenArchive = (dir: string) =>
      writeManifestZip(dir, 'qwen-extension.zip', {
        name: 'local-archive-extension',
        version: '2.0.0',
      });

    function abortOnCheck(n: number, error: unknown): AbortSignal {
      let abortChecks = 0;
      return {
        throwIfAborted: () => {
          abortChecks += 1;
          if (abortChecks >= n) throw error;
        },
      } as unknown as AbortSignal;
    }

    it('should convert a local Gemini archive before checking for updates', async () => {
      await withTempDir('local-archive-update-test-', async (tempDir) => {
        const source = await geminiArchive(tempDir);
        expect(
          await check({ type: 'local', source }, readingManager(true)),
        ).toBe(UPDATE_AVAILABLE);
      });
    });

    it('should return UPDATE_AVAILABLE for local archive extension with different version', async () => {
      await withTempDir('local-archive-update-test-', async (tempDir) => {
        const source = await qwenArchive(tempDir);
        const manager = managerReturning({
          name: 'local-archive-extension',
          version: '2.0.0',
        });

        expect(await check({ type: 'local', source }, manager)).toBe(
          UPDATE_AVAILABLE,
        );
        expect(manager.loadExtensionConfig).toHaveBeenCalledWith({
          extensionDir: expect.stringContaining('extension-archive-update-'),
        });
      });
    });

    it('should propagate an abort observed after extracting a local archive', async () => {
      await withTempDir('local-archive-abort-test-', async (tempDir) => {
        const source = await qwenArchive(tempDir);
        const manager = {
          loadExtensionConfig: vi.fn(),
        } as unknown as ExtensionManager;
        const abortError = new DOMException('Aborted', 'AbortError');

        await expect(
          check(
            { type: 'local', source },
            manager,
            abortOnCheck(3, abortError),
          ),
        ).rejects.toBe(abortError);
        expect(manager.loadExtensionConfig).not.toHaveBeenCalled();
      });
    });

    it('should clean up a converted local archive when aborted after conversion', async () => {
      await withTempDir('converted-archive-abort-test-', async (tempDir) => {
        const convertedDir = path.join(tempDir, 'converted');
        const source = await geminiArchive(tempDir);
        vi.spyOn(ExtensionStorage, 'createTmpDir').mockImplementation(
          async () => {
            await fs.mkdir(convertedDir);
            return convertedDir;
          },
        );
        const abortError = new DOMException('Aborted', 'AbortError');

        await expect(
          check(
            { type: 'local', source },
            {} as ExtensionManager,
            abortOnCheck(4, abortError),
          ),
        ).rejects.toBe(abortError);
        await expect(fs.stat(convertedDir)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      });
    });

    const checkArchiveUrl = (
      source: string,
      config: { name: string; version: string },
      manager: ExtensionManager,
      manifestName?: string,
    ) =>
      withTempDir('archive-url-update-test-', async (tempDir) => {
        mockHttpsResponses(await zipManifest(tempDir, config, manifestName));
        return check({ type: 'archive-url', source }, manager);
      });

    it('should return UPDATE_AVAILABLE for archive URL extension with different version', async () => {
      const config = { name: 'archive-url-extension', version: '2.0.0' };
      const manager = managerReturning({ ...config });

      expect(await checkArchiveUrl(exampleZip, config, manager)).toBe(
        UPDATE_AVAILABLE,
      );
      expect(manager.loadExtensionConfig).toHaveBeenCalledWith({
        extensionDir: expect.stringContaining('extension-archive-update-'),
      });
    });

    it('should convert an archive URL Gemini archive before checking for updates', async () => {
      expect(
        await checkArchiveUrl(
          'https://example.com/gemini-extension.zip',
          { name: 'gemini-archive-url-extension', version: '2.0.0' },
          readingManager(true),
          'gemini-extension.json',
        ),
      ).toBe(UPDATE_AVAILABLE);
    });

    it('should return UP_TO_DATE for archive URL extension with same version', async () => {
      const config = { name: 'archive-url-extension', version: '1.0.0' };
      expect(
        await checkArchiveUrl(
          exampleZip,
          config,
          managerReturning({ ...config }),
        ),
      ).toBe(UP_TO_DATE);
    });
  });

  describe('downloadFromGitHubRelease', () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'github-release-archive-test-'),
      );
    });

    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    const releasesZip = 'https://example.com/releases/extension.zip';
    const tokenHeader = { Authorization: 'token secret-token' };
    const MISSING_MANIFEST =
      'Extension archive is missing a supported extension manifest.';

    const fromRelease = (
      overrides: Partial<ExtensionInstallMetadata> = {},
      signal?: AbortSignal,
    ) =>
      downloadFromGitHubRelease(
        { source: 'owner/repo', type: 'github-release', ...overrides },
        tempDir,
        signal,
      );
    const publicPolicy = { networkPolicy: 'public' } as const;

    const fromUrl = (
      source: string,
      signal?: AbortSignal,
      overrides: Partial<ExtensionInstallMetadata> = {},
    ) =>
      downloadFromArchiveUrl(
        { source, type: 'archive-url', ...overrides },
        tempDir,
        signal,
      );

    const readText = (...segments: string[]) =>
      fs.readFile(path.join(tempDir, ...segments), 'utf-8');

    const releaseJson = (
      url = 'https://github.com/owner/repo/releases/download/v1.0.0/extension.zip',
    ) =>
      JSON.stringify({
        assets: [{ name: 'extension.zip', browser_download_url: url }],
        tag_name: 'v1.0.0',
      });

    it('preserves the abort reason for release metadata response errors', async () => {
      const responseError = new Error('response interrupted');
      const controller = new AbortController();
      const abortReason = new Error('release check cancelled');
      replyOnce(
        streamingResponse(function () {
          controller.abort(abortReason);
          this.destroy(responseError);
        }),
      );

      await expect(fromRelease({}, controller.signal)).rejects.toBe(
        abortReason,
      );
    });

    it('preserves the abort reason for release metadata status errors', async () => {
      const controller = new AbortController();
      const abortReason = new Error('release check cancelled');
      replyOnce(createResponse('missing', 404), () =>
        controller.abort(abortReason),
      );

      await expect(fromRelease({}, controller.signal)).rejects.toBe(
        abortReason,
      );
    });

    it('times out release metadata requests', async () => {
      await withFakeTimers(async () => {
        const request = {
          on: vi.fn().mockReturnThis(),
          destroy: vi.fn().mockReturnThis(),
        } as unknown as ReturnType<typeof https.get>;
        mockHttpsGet.mockImplementationOnce(() => request);

        const outcome = fromRelease().catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(120_000);

        await expect(outcome).resolves.toMatchObject({
          message: 'Timed out fetching GitHub API response',
        });
        expect(request.destroy).toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      });
    });

    it('rejects invalid release metadata JSON', async () => {
      mockHttpsResponses('{ invalid json');
      await expect(fromRelease()).rejects.toBeInstanceOf(SyntaxError);
    });

    // The release-metadata fetch exercises fetchJson's redirect handling
    // (mirrors the downloadFile redirect matrix below).
    async function downloadViaApiRedirect(location: string) {
      vi.stubEnv('GITHUB_TOKEN', 'secret-token');
      const lookupSpy = mockPublicDns();
      replyEach(
        redirect(location),
        releaseJson(),
        await zipManifest(tempDir, {
          name: 'redirected-metadata-extension',
          version: '1.0.0',
        }),
      );
      await fromRelease(publicPolicy);
      return lookupSpy;
    }

    it('stops following GitHub API redirect loops', async () => {
      // With a network policy every hop must be re-resolved through DNS, so
      // the lookup spy counts the per-hop re-validations.
      const lookupSpy = mockPublicDns();
      replyAlways(() =>
        redirect('https://api.github.com/repos/owner/repo/releases/next'),
      );

      await expect(fromRelease(publicPolicy)).rejects.toThrow(
        'Too many redirects while fetching GitHub API data',
      );
      // The initial request plus MAX_API_REDIRECTS follow-ups.
      expect(mockHttpsGet).toHaveBeenCalledTimes(6);
      expect(lookupSpy).toHaveBeenCalledTimes(6);
    });

    it('rejects GitHub API redirects without a location and clears the timeout', async () => {
      await withFakeTimers(async () => {
        const lookupSpy = mockPublicDns();
        const resumeSpy = replyDrained(redirect());

        await expect(fromRelease(publicPolicy)).rejects.toThrow(
          'Redirect response missing location header',
        );
        expect(resumeSpy).toHaveBeenCalled();
        // The single hop is resolved once against the network policy.
        expect(lookupSpy).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
      });
    });

    it('rejects GitHub API redirect scheme downgrades before following them', async () => {
      vi.stubEnv('GITHUB_TOKEN', 'secret-token');
      const lookupSpy = mockPublicDns();
      replyOnce(
        redirect('http://api.github.com/repos/owner/repo/releases/latest'),
      );

      await expect(fromRelease(publicPolicy)).rejects.toThrow(
        'Unsupported redirect URL protocol: http:',
      );

      // The downgrade is rejected before any request to the http: URL, so
      // only the initial hop is resolved against the network policy.
      expect(mockHttpsGet).toHaveBeenCalledTimes(1);
      expect(lookupSpy).toHaveBeenCalledTimes(1);
      expect(getOptions(0)?.headers).toMatchObject(tokenHeader);
    });

    it('does not forward the GitHub token to cross-host GitHub API redirects', async () => {
      const lookupSpy = await downloadViaApiRedirect(
        'https://objects.githubusercontent.com/metadata',
      );

      expect(getOptions(0)?.headers).toMatchObject(tokenHeader);
      expect(getOptions(1)?.headers).toEqual({ 'User-Agent': 'gemini-cli' });
      // Every hop (initial API, redirected API, archive download) is
      // re-resolved against the network policy and carries the pinned lookup,
      // so a redirect can never escape to a freshly resolved blocked address.
      expect(lookupSpy).toHaveBeenCalledTimes(3);
      for (const call of mockHttpsGet.mock.calls) {
        const hopOptions = call[1] as GetOptions;
        expect(typeof hopOptions?.lookup).toBe('function');
        expect(hopOptions?.agent).toBe(false);
      }
    });

    it('keeps the GitHub token for same-host GitHub API redirects', async () => {
      const lookupSpy = await downloadViaApiRedirect(
        'https://api.github.com/repos/owner/renamed/releases/latest',
      );

      expect(getOptions(1)?.headers).toMatchObject(tokenHeader);
      // Initial API hop + redirected hop + archive download, each
      // re-resolved against the network policy.
      expect(lookupSpy).toHaveBeenCalledTimes(3);
    });

    it('should explain when a release archive is missing an extension manifest', async () => {
      const invalidArchive = await createZipBuffer(tempDir, [
        { name: 'README.md', content: 'not an extension' },
      ]);
      mockHttpsResponses(releaseJson(exampleZip), invalidArchive);

      await expect(fromRelease({ type: 'git' })).rejects.toThrow(
        MISSING_MANIFEST,
      );
    });

    it('should download and extract an archive URL', async () => {
      mockHttpsResponses(
        await zipManifest(tempDir, {
          name: 'archive-extension',
          version: '1.0.0',
        }),
      );

      await fromUrl(exampleZip);

      await expect(readText(EXTENSIONS_CONFIG_FILENAME)).resolves.toContain(
        'archive-extension',
      );
    });

    it.each([307, 308])(
      'should follow %i redirects with relative locations',
      async (statusCode) => {
        const archive = await zipManifest(tempDir, {
          name: 'redirected-archive-extension',
          version: '1.0.0',
        });
        replyEach(redirect('../download/extension.zip', statusCode), archive);

        await fromUrl(releasesZip);

        expect(mockHttpsGet).toHaveBeenCalledTimes(2);
        expect(mockHttpsGet.mock.calls[1][0].toString()).toBe(
          'https://example.com/download/extension.zip',
        );
      },
    );

    it('should reject malformed redirect locations without throwing', async () => {
      const resumeSpy = replyDrained(redirect('https://[::1'));

      await expect(fromUrl(releasesZip)).rejects.toThrow(
        'Invalid redirect URL:',
      );
      expect(resumeSpy).toHaveBeenCalled();
    });

    it('should drain non-200 archive URL responses before rejecting', async () => {
      const resumeSpy = replyDrained(createResponse('missing', 404));

      await expect(fromUrl(releasesZip)).rejects.toThrow(
        'Request failed with status code 404',
      );
      expect(resumeSpy).toHaveBeenCalled();
    });

    it('should time out archive URL downloads', async () => {
      let timeoutCallback: (() => void) | undefined;
      const request = {
        on: vi.fn().mockReturnThis(),
        setTimeout: vi.fn((_ms: number, callback?: () => void) => {
          timeoutCallback = callback;
          return request;
        }),
        destroy: vi.fn().mockReturnThis(),
      } as unknown as ReturnType<typeof https.get>;
      mockHttpsGet.mockImplementationOnce(() => request);

      const download = fromUrl(releasesZip);
      timeoutCallback?.();

      await expect(download).rejects.toThrow(
        'Timed out downloading extension archive',
      );
      expect(request.destroy).toHaveBeenCalled();
    });

    it('does not start an archive request when DNS outlives the deadline', async () => {
      await withFakeTimers(async () => {
        vi.spyOn(dns, 'lookup').mockImplementation(
          () => new Promise(() => undefined),
        );

        const outcome = fromUrl(
          'https://packages.example/extension.zip',
          undefined,
          publicPolicy,
        ).catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(120_000);

        await expect(outcome).resolves.toMatchObject({
          message:
            'Failed to download archive from https://packages.example/extension.zip: Timed out downloading extension archive',
        });
        expect(mockHttpsGet).not.toHaveBeenCalled();
      });
    });

    it('preserves the caller abort reason for archive URL downloads', async () => {
      let errorHandler: ((error: Error) => void) | undefined;
      const request = {
        on: vi.fn((event: string, handler: (error: Error) => void) => {
          if (event === 'error') errorHandler = handler;
          return request;
        }),
        setTimeout: vi.fn().mockReturnThis(),
        destroy: vi.fn().mockReturnThis(),
      } as unknown as ReturnType<typeof https.get>;
      mockHttpsGet.mockImplementationOnce(() => request);
      const controller = new AbortController();
      const reason = new Error('download cancelled');

      const download = fromUrl(releasesZip, controller.signal);
      controller.abort(reason);
      errorHandler?.(reason);

      await expect(download).rejects.toBe(reason);
    });

    it('should reject oversized archive URL downloads', async () => {
      let dataHandler: ((chunk: Buffer) => void) | undefined;
      const response = {
        statusCode: 200,
        headers: {},
        on: vi.fn((event: string, handler: (chunk: Buffer) => void) => {
          if (event === 'data') {
            dataHandler = handler;
          }
          return response;
        }),
        pipe: vi.fn(),
        resume: vi.fn(),
        destroy: vi.fn(),
      } as unknown as IncomingMessage;
      replyOnce(response);

      const download = fromUrl(releasesZip);
      dataHandler?.({ length: 101 * 1024 * 1024 } as Buffer);

      await expect(download).rejects.toThrow(
        'Extension archive download exceeded maximum size',
      );
      expect(response.destroy).toHaveBeenCalled();
    });

    it('should not include the GitHub token for archive URL downloads', async () => {
      vi.stubEnv('GITHUB_TOKEN', 'secret-token');
      mockHttpsResponses(
        await zipManifest(tempDir, {
          name: 'public-archive-extension',
          version: '1.0.0',
        }),
      );

      await fromUrl(exampleZip);

      expect(getOptions(0)?.headers).toEqual({ 'User-agent': 'gemini-cli' });
    });

    it('should not forward the GitHub token to cross-host redirects', async () => {
      vi.stubEnv('GITHUB_TOKEN', 'secret-token');
      const archive = await zipManifest(tempDir, {
        name: 'redirected-release-extension',
        version: '1.0.0',
      });
      replyEach(
        releaseJson(),
        redirect('https://objects.githubusercontent.com/extension.zip'),
        archive,
      );

      await fromRelease({ type: 'git' });

      expect(getOptions(1)?.headers).toMatchObject(tokenHeader);
      expect(getOptions(2)?.headers).toEqual({ 'User-agent': 'gemini-cli' });
    });

    it('should reject same-host scheme downgrade redirects before sending a token', async () => {
      vi.stubEnv('GITHUB_TOKEN', 'secret-token');
      replyEach(
        releaseJson(),
        redirect(
          'http://github.com/owner/repo/releases/download/v1.0.0/extension.zip',
        ),
      );

      await expect(fromRelease()).rejects.toThrow(
        'Unsupported download URL protocol: http:',
      );

      expect(mockHttpsGet).toHaveBeenCalledTimes(2);
      expect(getOptions(1)?.headers).toMatchObject(tokenHeader);
    });

    it('should stop following redirect loops', async () => {
      replyAlways(() => redirect(exampleZip));

      await expect(fromUrl(exampleZip)).rejects.toThrow(
        'Too many redirects while downloading extension archive',
      );
    });

    it('should reject redirects without a location and clear the timeout', async () => {
      await withFakeTimers(async () => {
        const resumeSpy = replyDrained(redirect());

        await expect(fromUrl(exampleZip)).rejects.toThrow(
          'Redirect response missing location header',
        );
        expect(resumeSpy).toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      });
    });

    it('should reject when an archive URL response stream errors', async () => {
      replyOnce(
        streamingResponse(function () {
          this.destroy(new Error('connection lost'));
        }),
      );

      await expect(fromUrl(exampleZip)).rejects.toThrow(
        'Failed to download archive from https://example.com/extension.zip: connection lost',
      );
    });

    it('should explain when an archive URL cannot be extracted', async () => {
      mockHttpsResponses(Buffer.from('not a zip'));

      await expect(fromUrl(exampleZip)).rejects.toThrow(
        'Extension archive could not be extracted. Make sure it is a valid .zip or .tar.gz file.',
      );
    });

    // A `buildDir` (removed afterwards) keeps createZipBuffer's scratch zip
    // out of the extraction root.
    async function stageZip(
      file: string,
      entries: ZipEntry[],
      buildDir?: string,
    ): Promise<string> {
      const archivePath = path.join(tempDir, file);
      const buildPath = buildDir ? path.join(tempDir, buildDir) : tempDir;
      if (buildDir) await fs.mkdir(buildPath);
      const archive = await createZipBuffer(buildPath, entries);
      if (buildDir) await fs.rm(buildPath, { recursive: true, force: true });
      await fs.writeFile(archivePath, archive);
      return archivePath;
    }

    const manifestEntry = (name: string, dir = ''): ZipEntry => ({
      name: `${dir}${EXTENSIONS_CONFIG_FILENAME}`,
      content: JSON.stringify({ name, version: '1.0.0' }),
    });

    it('should explain when a local archive is missing an extension manifest', async () => {
      const invalidArchivePath = await stageZip('invalid.zip', [
        { name: 'README.md', content: 'not an extension' },
      ]);

      await expect(
        extractArchiveFile(invalidArchivePath, tempDir),
      ).rejects.toThrow(MISSING_MANIFEST);
    });

    it('should extract and flatten a tar.gz archive with a wrapped extension directory', async () => {
      const archivePath = path.join(tempDir, 'wrapped-extension.tar.gz');
      const sourceRoot = path.join(tempDir, 'tar-source');
      const wrappedDir = path.join(sourceRoot, 'wrapped-extension');
      await fs.mkdir(wrappedDir, { recursive: true });
      await fs.writeFile(
        path.join(wrappedDir, EXTENSIONS_CONFIG_FILENAME),
        JSON.stringify({ name: 'tar-wrapped-extension', version: '1.0.0' }),
      );
      await tgz(archivePath, sourceRoot, ['wrapped-extension']);
      await fs.rm(sourceRoot, { recursive: true, force: true });

      await extractArchiveFile(archivePath, tempDir);

      await expect(readText(EXTENSIONS_CONFIG_FILENAME)).resolves.toContain(
        'tar-wrapped-extension',
      );
    });

    it('should extract and flatten a wrapped Qoder plugin archive', async () => {
      const archivePath = await stageZip('wrapped-qoder-plugin.zip', [
        {
          name: `wrapped/${QODER_PLUGIN_MANIFEST}`,
          content: JSON.stringify({ name: 'sample-qoder-plugin' }),
        },
        { name: 'wrapped/system-prompt.md', content: '# System context' },
      ]);

      await extractArchiveFile(archivePath, tempDir);

      await expect(readText(QODER_PLUGIN_MANIFEST)).resolves.toContain(
        'sample-qoder-plugin',
      );
      await expect(readText('system-prompt.md')).resolves.toBe(
        '# System context',
      );
    });

    it('should extract and flatten a wrapped Agent Plugin archive', async () => {
      const manifest = JSON.stringify({
        $schema: AGENT_PLUGIN_SCHEMA,
        name: 'portable-plugin',
      });
      const skill =
        '---\nname: direct\ndescription: Direct skill\n---\nPortable instructions.';
      const archivePath = await stageZip('wrapped-agent-plugin.zip', [
        { name: 'wrapped/plugin.json', content: manifest },
        { name: 'wrapped/skills/direct/SKILL.md', content: skill },
      ]);

      await extractArchiveFile(archivePath, tempDir);

      await expect(readText('plugin.json')).resolves.toBe(manifest);
      await expect(readText('skills', 'direct', 'SKILL.md')).resolves.toBe(
        skill,
      );
    });

    it('should flatten wrapped archives when the archive file is in the destination', async () => {
      const archivePath = await stageZip(
        'downloaded-extension.zip',
        [
          manifestEntry('wrapped-with-readme-extension', 'wrapped/'),
          { name: 'README.md', content: 'readme' },
        ],
        'archive-build',
      );

      await extractArchiveFile(archivePath, tempDir);

      await expect(readText(EXTENSIONS_CONFIG_FILENAME)).resolves.toContain(
        'wrapped-with-readme-extension',
      );
      await expect(readText('README.md')).resolves.toBe('readme');
      await expect(fs.stat(archivePath)).resolves.toBeDefined();
    });

    it('should not flatten when the archive root already has a manifest', async () => {
      const archivePath = await stageZip('root-and-wrapper.zip', [
        manifestEntry('root-extension'),
        manifestEntry('wrapped-extension', 'wrapped/'),
      ]);

      await extractArchiveFile(archivePath, tempDir);

      await expect(readText(EXTENSIONS_CONFIG_FILENAME)).resolves.toContain(
        'root-extension',
      );
      await expect(
        readText('wrapped', EXTENSIONS_CONFIG_FILENAME),
      ).resolves.toContain('wrapped-extension');
    });

    it('should reject flattening when wrapper contents collide with root files', async () => {
      const archivePath = await stageZip(
        'colliding-wrapper.zip',
        [
          manifestEntry('wrapped-extension', 'wrapped/'),
          { name: 'wrapped/README.md', content: 'wrapped readme' },
          { name: 'README.md', content: 'root readme' },
        ],
        'collision-build',
      );

      await expect(extractArchiveFile(archivePath, tempDir)).rejects.toThrow(
        /Extension archive could not be extracted.*Extension archive cannot be flattened because "README.md" exists at both the archive root and inside "wrapped"\./,
      );
      await expect(readText('README.md')).resolves.toBe('root readme');
      await expect(
        readText('wrapped', EXTENSIONS_CONFIG_FILENAME),
      ).resolves.toContain('wrapped-extension');
    });

    it('should not flatten archives with multiple top-level entries', async () => {
      const archivePath = await stageZip('multiple-entries.zip', [
        manifestEntry('wrapped-extension', 'wrapped/'),
        { name: 'README.md', content: 'readme' },
        { name: 'LICENSE', content: 'license' },
      ]);

      await expect(extractArchiveFile(archivePath, tempDir)).rejects.toThrow(
        MISSING_MANIFEST,
      );
      await expect(
        readText('wrapped', EXTENSIONS_CONFIG_FILENAME),
      ).resolves.toContain('wrapped-extension');
    });

    it('should not flatten archives without a top-level directory', async () => {
      const archivePath = await stageZip('files-only.zip', [
        manifestEntry('files-only-extension'),
        { name: 'README.md', content: 'readme' },
      ]);

      await extractArchiveFile(archivePath, tempDir);

      await expect(readText(EXTENSIONS_CONFIG_FILENAME)).resolves.toContain(
        'files-only-extension',
      );
    });

    it('should not flatten a top-level directory without a supported manifest', async () => {
      const archivePath = await stageZip('unsupported-wrapper.zip', [
        { name: 'wrapped/README.md', content: 'not an extension' },
      ]);

      await expect(extractArchiveFile(archivePath, tempDir)).rejects.toThrow(
        MISSING_MANIFEST,
      );
      await expect(readText('wrapped', 'README.md')).resolves.toBe(
        'not an extension',
      );
    });

    it('should identify supported archive paths and URLs', () => {
      expect(isSupportedArchivePath('/tmp/extension.zip')).toBe(true);
      expect(isSupportedArchivePath('/tmp/extension.tar.gz')).toBe(true);
      expect(isSupportedArchivePath('/tmp/extension.tgz')).toBe(false);
      expect(isSupportedArchiveUrl(exampleZip)).toBe(true);
      expect(isSupportedArchiveUrl('http://example.com/extension.zip')).toBe(
        false,
      );
      expect(
        isSupportedArchiveUrl('https://example.com/extension.tar.gz'),
      ).toBe(true);
      // A query string must not hide the archive extension.
      expect(
        isSupportedArchiveUrl('https://example.com/extension.zip?token=1'),
      ).toBe(true);
      expect(isSupportedArchiveUrl('git@github.com:owner/repo.git')).toBe(
        false,
      );
    });

    it('should classify archive-shaped URLs regardless of scheme', () => {
      expect(isArchiveShapedUrl('http://example.com/extension.zip')).toBe(true);
      expect(isArchiveShapedUrl('https://example.com/extension.tar.gz')).toBe(
        true,
      );
      expect(isArchiveShapedUrl('HTTP://example.com/ext.zip#frag')).toBe(true);
      // A query string must not hide the archive extension.
      expect(isArchiveShapedUrl('http://example.com/ext.zip?token=1')).toBe(
        true,
      );
      expect(isArchiveShapedUrl('http://example.com/extension.tgz')).toBe(
        false,
      );
      expect(isArchiveShapedUrl('http://example.com/repo')).toBe(false);
      // Unparseable URLs classify as false, never throw.
      expect(isArchiveShapedUrl('http://exa mple.com/plugin.zip')).toBe(false);
    });
  });

  describe('findReleaseAsset', () => {
    const assets = [
      { name: 'darwin.arm64.extension.tar.gz', browser_download_url: 'url1' },
      { name: 'darwin.x64.extension.tar.gz', browser_download_url: 'url2' },
      { name: 'linux.x64.extension.tar.gz', browser_download_url: 'url3' },
      { name: 'win32.x64.extension.tar.gz', browser_download_url: 'url4' },
      { name: 'extension-generic.tar.gz', browser_download_url: 'url5' },
    ];

    // Expects `list[index]` (or undefined) on the given platform and arch.
    function expectAsset(
      platform: string,
      arch: string,
      list: typeof assets,
      index?: number,
    ): void {
      mockPlatform.mockReturnValue(platform);
      mockArch.mockReturnValue(arch);
      expect(findReleaseAsset(list)).toEqual(
        index === undefined ? undefined : list[index],
      );
    }

    it('should find asset matching platform and architecture', () =>
      expectAsset('darwin', 'arm64', assets, 0));

    it('should find asset matching platform if arch does not match', () =>
      expectAsset('linux', 'arm64', assets, 2));

    it('should return undefined if no matching asset is found', () =>
      expectAsset('sunos', 'x64', assets));

    it('should find generic asset if it is the only one', () =>
      expectAsset(
        'darwin',
        'arm64',
        [{ name: 'extension.tar.gz', browser_download_url: 'url' }],
        0,
      ));

    it('should return undefined if multiple generic assets exist', () =>
      expectAsset('darwin', 'arm64', [
        { name: 'extension-1.tar.gz', browser_download_url: 'url1' },
        { name: 'extension-2.tar.gz', browser_download_url: 'url2' },
      ]));
  });

  describe('parseGitHubRepoForReleases', () => {
    function expectParsed(source: string, expectedRepo = 'repo'): void {
      const { owner, repo } = parseGitHubRepoForReleases(source);
      expect(owner).toBe('owner');
      expect(repo).toBe(expectedRepo);
    }

    const expectInvalid = (
      source: string,
      message = `Invalid GitHub repository source: ${source}. Expected "owner/repo" or a github repo uri.`,
    ) => expect(() => parseGitHubRepoForReleases(source)).toThrow(message);

    it('should parse owner and repo from a full GitHub URL', () =>
      expectParsed('https://github.com/owner/repo.git'));

    it('should parse owner and repo from a full GitHub UR without .git', () =>
      expectParsed('https://github.com/owner/repo'));

    it('should not strip .git from the middle of a repo name (GitHub Pages)', () =>
      expectParsed(
        'https://github.com/owner/owner.github.io',
        'owner.github.io',
      ));

    it('should only strip a trailing .git, not an embedded one', () => {
      const { repo } = parseGitHubRepoForReleases(
        'owner/my.gitignore-tools.git',
      );
      expect(repo).toBe('my.gitignore-tools');
    });

    it('should fail on a GitHub SSH URL', () =>
      expectInvalid(
        'git@github.com:owner/repo.git',
        'GitHub release-based extensions are not supported for SSH. You must use an HTTPS URI with a personal access token to download releases from private repositories. You can set your personal access token in the GITHUB_TOKEN environment variable and install the extension via SSH.',
      ));

    it('should fail on a non-GitHub URL', () =>
      expectInvalid('https://example.com/owner/repo.git'));

    it('should redact URL credentials in invalid source errors', async () => {
      const error = await caught(() =>
        parseGitHubRepoForReleases(
          'https://user:token@example.com/owner/repo.git',
        ),
      );

      expectRedacted(
        String(error),
        'https://***REDACTED***@example.com/owner/repo.git',
      );
    });

    it('should parse owner and repo from a shorthand string', () =>
      expectParsed('owner/repo'));

    it('should handle .git suffix in repo name', () =>
      expectParsed('owner/repo.git'));

    it('should throw error for invalid source format', () =>
      expectInvalid('invalid-format'));

    it('should throw error for source with too many parts', () =>
      expectInvalid('https://github.com/owner/repo/extra'));
  });

  describe('extractFile', () => {
    let tempDir: string;

    async function getFileSize(filePath: string): Promise<number> {
      try {
        return (await fs.stat(filePath)).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
        throw error;
      }
    }

    async function waitForFileData(filePath: string): Promise<void> {
      // Poll on a wall-clock budget (~10s, under the 15s test ceiling), not an
      // iteration count: 1_000 sub-millisecond setImmediate turns could elapse
      // while tar I/O lags on a contended runner, the source of the "Timed out
      // waiting for extracted data" flake.
      for (let attempt = 0; attempt < 2_000; attempt += 1) {
        if ((await getFileSize(filePath)) > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`Timed out waiting for extracted data at ${filePath}`);
    }

    async function waitForStableFileSize(filePath: string): Promise<number> {
      let previousSize = -1;
      let stableChecks = 0;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await new Promise((resolve) => setImmediate(resolve));
        const size = await getFileSize(filePath);
        if (size === previousSize) {
          stableChecks += 1;
          if (stableChecks === 3) return size;
        } else {
          previousSize = size;
          stableChecks = 0;
        }
      }
      throw new Error(`Extracted data did not stop changing at ${filePath}`);
    }

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-test-'));
    });

    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    const inTemp = (name: string) => path.join(tempDir, name);

    async function makeDest(name = 'extracted'): Promise<string> {
      await fs.mkdir(inTemp(name));
      return inTemp(name);
    }

    const extractAllowingLinks = (archivePath: string, dest: string) =>
      extractFile(archivePath, dest, undefined, {
        allowContainedSymlinks: true,
      });

    // Aborts once extraction has written data; the file must stay partial.
    async function expectCancelledMidway(
      archivePath: string,
      extractionDest: string,
      fullSize: number,
      reasonMessage: string,
    ): Promise<void> {
      const extractedFilePath = path.join(extractionDest, 'large.bin');
      const controller = new AbortController();
      const abortReason = new Error(reasonMessage);
      const extraction = extractFile(
        archivePath,
        extractionDest,
        controller.signal,
      );
      try {
        await waitForFileData(extractedFilePath);
      } catch (error) {
        controller.abort(error);
        await extraction.catch(() => undefined);
        throw error;
      }
      controller.abort(abortReason);
      await expect(extraction).rejects.toBe(abortReason);
      expect(await waitForStableFileSize(extractedFilePath)).toBeLessThan(
        fullSize,
      );
    }

    async function tarAgentsSymlink(
      stageName: string,
      archiveName: string,
    ): Promise<string> {
      const stage = inTemp(stageName);
      await fs.mkdir(stage);
      await fs.writeFile(path.join(stage, 'CLAUDE.md'), '# guide\n');
      await fs.symlink('CLAUDE.md', path.join(stage, 'AGENTS.md'));
      const archivePath = inTemp(archiveName);
      await tgz(archivePath, stage, ['CLAUDE.md', 'AGENTS.md']);
      return archivePath;
    }

    it('should extract a .tar.gz file', async () => {
      const archivePath = inTemp('test.tar.gz');
      const extractionDest = await makeDest();
      await fs.writeFile(inTemp('test.txt'), 'hello tar');
      await tgz(archivePath, tempDir, ['test.txt']);

      await extractFile(archivePath, extractionDest);

      expect(
        await fs.readFile(path.join(extractionDest, 'test.txt'), 'utf-8'),
      ).toBe('hello tar');
    });

    it('should cancel while scanning a tar archive', async () => {
      const archivePath = inTemp('scan-cancel.tar.gz');
      await fs.writeFile(inTemp('large.bin'), randomBytes(16 * 1024 * 1024));
      await tgz(archivePath, tempDir, ['large.bin']);

      const controller = new AbortController();
      const abortReason = new Error('cancel tar scan');
      const scan = assertTarArchiveLinksAreSafe(archivePath, controller.signal);
      setImmediate(() => controller.abort(abortReason));
      await expect(scan).rejects.toBe(abortReason);
    });

    it('should cancel while extracting a tar archive', async () => {
      const archivePath = inTemp('extract-cancel.tar.gz');
      const content = randomBytes(32 * 1024 * 1024);
      const extractionDest = await makeDest();
      await fs.writeFile(inTemp('large.bin'), content);
      await tgz(archivePath, tempDir, ['large.bin']);

      await expectCancelledMidway(
        archivePath,
        extractionDest,
        content.length,
        'cancel tar extraction',
      );
    });

    it.skipIf(process.platform === 'win32')(
      'should reject symlink entries in tar archives',
      async () => {
        const archivePath = inTemp('symlink.tar.gz');
        const extractionDest = await makeDest();
        const sourceDir = await makeDest('source');
        const outsideDir = await makeDest('outside');
        await fs.symlink(outsideDir, path.join(sourceDir, 'escape-link'));
        await tgz(archivePath, sourceDir, ['escape-link']);

        await expect(extractFile(archivePath, extractionDest)).rejects.toThrow(
          'Tar archive contains unsupported link entry: escape-link',
        );
        await expect(
          fs.lstat(path.join(extractionDest, 'escape-link')),
        ).rejects.toThrow();
      },
    );

    it('should extract a .zip file', async () => {
      const archivePath = inTemp('test.zip');
      const extractionDest = await makeDest();
      const dummyFilePath = inTemp('test.txt');
      await fs.writeFile(dummyFilePath, 'hello zip');
      await writeArchive(archivePath, (archive) =>
        archive.file(dummyFilePath, { name: 'test.txt' }),
      );

      await extractFile(archivePath, extractionDest);

      expect(
        await fs.readFile(path.join(extractionDest, 'test.txt'), 'utf-8'),
      ).toBe('hello zip');
    });

    it('should cancel while extracting a zip archive', async () => {
      const archivePath = inTemp('extract-cancel.zip');
      const content = Buffer.alloc(64 * 1024 * 1024, 0x61);
      const extractionDest = await makeDest();
      await writeArchive(archivePath, (archive) =>
        archive.append(content, { name: 'large.bin' }),
      );

      await expectCancelledMidway(
        archivePath,
        extractionDest,
        content.length,
        'cancel zip extraction',
      );
    });

    it('should reject symlink entries in zip archives', async () => {
      const archivePath = inTemp('symlink.zip');
      const extractionDest = await makeDest();
      await writeArchive(archivePath, (archive) =>
        archive.symlink('escape-link', '/tmp/outside-target'),
      );

      await expect(extractFile(archivePath, extractionDest)).rejects.toThrow(
        'Zip archive contains unsupported symbolic link entry: escape-link',
      );
      await expect(
        fs.lstat(path.join(extractionDest, 'escape-link')),
      ).rejects.toThrow();
    });

    it.skipIf(process.platform === 'win32')(
      'should reject zip extraction through an existing symlink',
      async () => {
        const archivePath = inTemp('existing-symlink.zip');
        const extractionDest = await makeDest();
        const outsideDir = await makeDest('outside');
        await fs.symlink(outsideDir, path.join(extractionDest, 'escape'));
        await writeArchive(archivePath, (archive) =>
          archive.append('outside write', { name: 'escape/file.txt' }),
        );

        await expect(extractFile(archivePath, extractionDest)).rejects.toThrow(
          'Refusing to extract through non-directory path',
        );
        await expect(
          fs.lstat(path.join(outsideDir, 'file.txt')),
        ).rejects.toThrow();
      },
    );

    // Issue #9724: the older-Git fallback installs public repositories that
    // carry in-repo symlinks. Containment is asserted here through the real
    // extraction path, not inferred from the tar library's own behaviour.
    it.skipIf(process.platform === 'win32')(
      'extracts a tar.gz carrying a contained symlink when allowed',
      async () => {
        const extractionDest = await makeDest('extracted-contained');
        const archivePath = await tarAgentsSymlink(
          'superpowers-stage',
          'contained.tar.gz',
        );

        await extractAllowingLinks(archivePath, extractionDest);

        const link = await fs.lstat(path.join(extractionDest, 'AGENTS.md'));
        expect(link.isSymbolicLink()).toBe(true);
        expect(await fs.readlink(path.join(extractionDest, 'AGENTS.md'))).toBe(
          'CLAUDE.md',
        );
      },
    );

    it.skipIf(process.platform === 'win32')(
      'fails when a contained symlink cannot be extracted',
      async () => {
        const extractionDest = inTemp('strict-symlink-dest');
        await fs.mkdir(path.join(extractionDest, 'AGENTS.md'), {
          recursive: true,
        });
        await fs.writeFile(
          path.join(extractionDest, 'AGENTS.md', 'blocking-file'),
          'block replacement\n',
        );
        const archivePath = await tarAgentsSymlink(
          'strict-symlink-stage',
          'strict-symlink.tar.gz',
        );

        await expect(
          extractAllowingLinks(archivePath, extractionDest),
        ).rejects.toThrow();
      },
    );

    it.skipIf(process.platform === 'win32')(
      'refuses a tar.gz whose symlink escapes the destination, writing nothing',
      async () => {
        const stage = await makeDest('escape-stage');
        const extractionDest = await makeDest('extracted-escape');
        const outsideDir = await makeDest('outside-escape');
        await fs.writeFile(path.join(outsideDir, 'canary.txt'), 'ORIGINAL\n');
        await fs.symlink('../outside-escape', path.join(stage, 'escape'));
        const archivePath = inTemp('escape.tar.gz');
        await tgz(archivePath, stage, ['escape']);

        await expect(
          extractAllowingLinks(archivePath, extractionDest),
        ).rejects.toThrow('unsupported link entry');
        // The escaping link is refused before extraction begins, so the
        // destination stays empty and the file outside it is untouched.
        expect(await fs.readdir(extractionDest)).toEqual([]);
        expect(
          await fs.readFile(path.join(outsideDir, 'canary.txt'), 'utf8'),
        ).toBe('ORIGINAL\n');
      },
    );

    it.skipIf(process.platform === 'win32')(
      'rejects a later entry beneath an earlier symlink before extraction',
      async () => {
        const archivePath = inTemp('symlink-descendant.tar.gz');
        const extractionDest = await makeDest('symlink-descendant-dest');
        await writeArchive(
          archivePath,
          (archive) => {
            archive.append('target', { name: 'target' });
            archive.symlink('alias', 'target');
            archive.append('must not be written', { name: 'alias/child' });
          },
          'tar',
          { gzip: true },
        );

        await expect(
          extractAllowingLinks(archivePath, extractionDest),
        ).rejects.toThrow('unsupported link entry');
        expect(await fs.readdir(extractionDest)).toEqual([]);
      },
    );

    it('should throw an error for unsupported file types', async () => {
      const unsupportedFilePath = inTemp('test.txt');
      await fs.writeFile(unsupportedFilePath, 'some content');
      const extractionDest = await makeDest();

      await expect(
        extractFile(unsupportedFilePath, extractionDest),
      ).rejects.toThrow('Unsupported file extension for extraction:');
    });
  });
});
