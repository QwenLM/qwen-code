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
  extractArchiveFile,
  extractFile,
  findReleaseAsset,
  isSupportedArchivePath,
  isSupportedArchiveUrl,
  parseGitHubRepoForReleases,
} from './github.js';
import { simpleGit, type SimpleGit } from 'simple-git';
import * as os from 'node:os';
import type * as https from 'node:https';
import type { IncomingMessage } from 'node:http';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import * as tar from 'tar';
import * as archiver from 'archiver';
import {
  ExtensionUpdateState,
  type Extension,
  type ExtensionManager,
} from './extensionManager.js';
import { getErrorMessage } from '../utils/errors.js';
import { EXTENSIONS_CONFIG_FILENAME } from './variables.js';

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
  afterEach(() => {
    vi.restoreAllMocks();
    mockHttpsGet.mockReset();
  });

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
    Object.assign(response, {
      statusCode,
      headers,
    });
    return response;
  }

  function callResponseCallback(
    _options:
      | https.RequestOptions
      | ((res: IncomingMessage) => void)
      | undefined,
    callback: ((res: IncomingMessage) => void) | undefined,
    response: IncomingMessage,
  ): void {
    if (typeof _options === 'function') {
      _options(response);
    } else {
      callback?.(response);
    }
  }

  function createRequestMock(): ReturnType<typeof https.get> {
    return {
      on: vi.fn().mockReturnThis(),
      setTimeout: vi.fn().mockReturnThis(),
      destroy: vi.fn().mockReturnThis(),
    } as unknown as ReturnType<typeof https.get>;
  }

  function mockHttpsResponses(...responses: Array<string | Buffer>): void {
    mockHttpsGet.mockImplementation(((
      _url: string | URL | https.RequestOptions,
      _options:
        | https.RequestOptions
        | ((res: IncomingMessage) => void)
        | undefined,
      callback?: (res: IncomingMessage) => void,
    ) => {
      const response = createResponse(responses.shift());
      callResponseCallback(_options, callback, response);
      return createRequestMock();
    }) as typeof https.get);
  }

  async function createZipBuffer(
    tempDir: string,
    entries: Array<{ name: string; content: string }>,
  ): Promise<Buffer> {
    const archivePath = path.join(tempDir, `archive-${Date.now()}.zip`);
    const output = fsSync.createWriteStream(archivePath);
    const archive = archiver.create('zip');
    const streamFinished = new Promise((resolve, reject) => {
      output.on('close', () => resolve(null));
      archive.on('error', reject);
    });

    archive.pipe(output);
    for (const entry of entries) {
      archive.append(entry.content, { name: entry.name });
    }
    await archive.finalize();
    await streamFinished;
    return fs.readFile(archivePath);
  }

  describe('cloneFromGit', () => {
    const mockGit = {
      clone: vi.fn(),
      getRemotes: vi.fn(),
      fetch: vi.fn(),
      checkout: vi.fn(),
    };

    beforeEach(() => {
      vi.mocked(simpleGit).mockReturnValue(mockGit as unknown as SimpleGit);
    });

    it('should clone, fetch and checkout a repo', async () => {
      mockPlatform.mockReturnValue('linux');
      const installMetadata = {
        source: 'http://my-repo.com',
        ref: 'my-ref',
        type: 'git' as const,
      };
      const destination = '/dest';
      mockGit.getRemotes.mockResolvedValue([
        { name: 'origin', refs: { fetch: 'http://my-repo.com' } },
      ]);

      await cloneFromGit(installMetadata, destination);

      expect(mockGit.clone).toHaveBeenCalledWith('http://my-repo.com', './', [
        '-c',
        'core.symlinks=true',
        '--depth',
        '1',
      ]);
      expect(mockGit.getRemotes).toHaveBeenCalledWith(true);
      expect(mockGit.fetch).toHaveBeenCalledWith('origin', 'my-ref');
      expect(mockGit.checkout).toHaveBeenCalledWith('FETCH_HEAD');
    });

    it('should use core.symlinks=false on Windows to avoid permission errors', async () => {
      mockPlatform.mockReturnValue('win32');
      const installMetadata = {
        source: 'http://my-repo.com',
        ref: 'my-ref',
        type: 'git' as const,
      };
      const destination = '/dest';
      mockGit.getRemotes.mockResolvedValue([
        { name: 'origin', refs: { fetch: 'http://my-repo.com' } },
      ]);

      await cloneFromGit(installMetadata, destination);

      expect(mockGit.clone).toHaveBeenCalledWith('http://my-repo.com', './', [
        '-c',
        'core.symlinks=false',
        '--depth',
        '1',
      ]);
    });

    it('should use core.symlinks=true on non-Windows platforms', async () => {
      mockPlatform.mockReturnValue('darwin');
      const installMetadata = {
        source: 'http://my-repo.com',
        ref: 'my-ref',
        type: 'git' as const,
      };
      const destination = '/dest';
      mockGit.getRemotes.mockResolvedValue([
        { name: 'origin', refs: { fetch: 'http://my-repo.com' } },
      ]);

      await cloneFromGit(installMetadata, destination);

      expect(mockGit.clone).toHaveBeenCalledWith('http://my-repo.com', './', [
        '-c',
        'core.symlinks=true',
        '--depth',
        '1',
      ]);
    });

    it('should use HEAD if ref is not provided', async () => {
      const installMetadata = {
        source: 'http://my-repo.com',
        type: 'git' as const,
      };
      const destination = '/dest';
      mockGit.getRemotes.mockResolvedValue([
        { name: 'origin', refs: { fetch: 'http://my-repo.com' } },
      ]);

      await cloneFromGit(installMetadata, destination);

      expect(mockGit.fetch).toHaveBeenCalledWith('origin', 'HEAD');
    });

    it('should throw if no remotes are found', async () => {
      const installMetadata = {
        source: 'http://my-repo.com',
        type: 'git' as const,
      };
      const destination = '/dest';
      mockGit.getRemotes.mockResolvedValue([]);

      await expect(cloneFromGit(installMetadata, destination)).rejects.toThrow(
        'Failed to clone Git repository from http://my-repo.com',
      );
    });

    it('should redact URL credentials in clone failures', async () => {
      const installMetadata = {
        source: 'https://user:token@my-repo.com/org/repo.git',
        type: 'git' as const,
      };
      const destination = '/dest';
      mockGit.getRemotes.mockResolvedValue([]);

      let message = '';
      try {
        await cloneFromGit(installMetadata, destination);
      } catch (error: unknown) {
        message = String(error);
      }

      expect(message).toContain(
        'https://***REDACTED***@my-repo.com/org/repo.git',
      );
      expect(message).not.toContain('user');
      expect(message).not.toContain('token');
    });

    it('should redact URL credentials in clone failure causes', async () => {
      const installMetadata = {
        source: 'https://user:token@my-repo.com/org/repo.git',
        type: 'git' as const,
      };
      const destination = '/dest';
      mockGit.clone.mockRejectedValue(
        new Error(
          "fatal: Authentication failed for 'https://user:token@my-repo.com/org/repo.git'",
        ),
      );

      let message = '';
      try {
        await cloneFromGit(installMetadata, destination);
      } catch (error: unknown) {
        message = getErrorMessage(error);
      }

      expect(message).toContain(
        'https://***REDACTED***@my-repo.com/org/repo.git',
      );
      expect(message).not.toContain('user');
      expect(message).not.toContain('token');
    });

    it('should preserve clone failure cause diagnostics while redacting its message', async () => {
      const installMetadata = {
        source: 'https://user:token@my-repo.com/org/repo.git',
        type: 'git' as const,
      };
      const destination = '/dest';
      const gitError = Object.assign(
        new Error(
          "fatal: Authentication failed for 'https://user:token@my-repo.com/org/repo.git'",
        ),
        {
          code: 'ENOTFOUND',
          task: { commands: ['clone'] },
        },
      );
      mockGit.clone.mockRejectedValue(gitError);

      let cause: unknown;
      try {
        await cloneFromGit(installMetadata, destination);
      } catch (error: unknown) {
        cause = error instanceof Error ? error.cause : undefined;
      }

      expect(cause).toBeInstanceOf(Error);
      expect(cause).not.toBe(gitError);
      expect((cause as Error).message).toContain(
        'https://***REDACTED***@my-repo.com/org/repo.git',
      );
      expect((cause as Error).message).not.toContain('user');
      expect((cause as { code?: string }).code).toBe('ENOTFOUND');
      expect((cause as { task?: { commands: string[] } }).task).toEqual({
        commands: ['clone'],
      });
    });

    it('should throw on clone error', async () => {
      const installMetadata = {
        source: 'http://my-repo.com',
        type: 'git' as const,
      };
      const destination = '/dest';
      mockGit.clone.mockRejectedValue(new Error('clone failed'));

      await expect(cloneFromGit(installMetadata, destination)).rejects.toThrow(
        'Failed to clone Git repository from http://my-repo.com',
      );
    });
  });

  describe('checkForExtensionUpdate', () => {
    const mockGit = {
      getRemotes: vi.fn(),
      listRemote: vi.fn(),
      revparse: vi.fn(),
    };

    const mockExtensionManager = {
      loadExtensionConfig: vi.fn(),
    } as unknown as ExtensionManager;

    beforeEach(() => {
      vi.mocked(simpleGit).mockReturnValue(mockGit as unknown as SimpleGit);
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

    it('should return NOT_UPDATABLE for non-git extensions', async () => {
      const extension = createExtension({
        installMetadata: {
          type: 'link',
          source: '',
        },
      });
      const result = await checkForExtensionUpdate(
        extension,
        mockExtensionManager,
      );
      expect(result).toBe(ExtensionUpdateState.NOT_UPDATABLE);
    });

    it('should return ERROR if no remotes found', async () => {
      const extension = createExtension({
        installMetadata: {
          type: 'git',
          source: '',
        },
      });
      mockGit.getRemotes.mockResolvedValue([]);
      const result = await checkForExtensionUpdate(
        extension,
        mockExtensionManager,
      );
      expect(result).toBe(ExtensionUpdateState.ERROR);
    });

    it('should return UPDATE_AVAILABLE when remote hash is different', async () => {
      const extension = createExtension({
        installMetadata: {
          type: 'git',
          source: 'my/ext',
        },
      });
      mockGit.getRemotes.mockResolvedValue([
        { name: 'origin', refs: { fetch: 'http://my-repo.com' } },
      ]);
      mockGit.listRemote.mockResolvedValue('remote-hash\tHEAD');
      mockGit.revparse.mockResolvedValue('local-hash');

      const result = await checkForExtensionUpdate(
        extension,
        mockExtensionManager,
      );
      expect(result).toBe(ExtensionUpdateState.UPDATE_AVAILABLE);
    });

    it('should return UP_TO_DATE when remote and local hashes are the same', async () => {
      const extension = createExtension({
        installMetadata: {
          type: 'git',
          source: 'my/ext',
        },
      });
      mockGit.getRemotes.mockResolvedValue([
        { name: 'origin', refs: { fetch: 'http://my-repo.com' } },
      ]);
      mockGit.listRemote.mockResolvedValue('same-hash\tHEAD');
      mockGit.revparse.mockResolvedValue('same-hash');

      const result = await checkForExtensionUpdate(
        extension,
        mockExtensionManager,
      );
      expect(result).toBe(ExtensionUpdateState.UP_TO_DATE);
    });

    it('should return ERROR on git error', async () => {
      const extension = createExtension({
        installMetadata: {
          type: 'git',
          source: 'my/ext',
        },
      });
      mockGit.getRemotes.mockRejectedValue(new Error('git error'));

      const result = await checkForExtensionUpdate(
        extension,
        mockExtensionManager,
      );
      expect(result).toBe(ExtensionUpdateState.ERROR);
    });

    it('should return UPDATE_AVAILABLE for local extension with different version', async () => {
      const extension = createExtension({
        version: '1.0.0',
        installMetadata: {
          type: 'local',
          source: '/path/to/source',
        },
      });

      const mockManager = {
        loadExtensionConfig: vi.fn().mockReturnValue({
          name: 'test',
          version: '2.0.0',
        }),
      } as unknown as ExtensionManager;

      const result = await checkForExtensionUpdate(extension, mockManager);
      expect(result).toBe(ExtensionUpdateState.UPDATE_AVAILABLE);
    });

    it('should return UP_TO_DATE for local extension with same version', async () => {
      const extension = createExtension({
        version: '1.0.0',
        installMetadata: {
          type: 'local',
          source: '/path/to/source',
        },
      });

      const mockManager = {
        loadExtensionConfig: vi.fn().mockReturnValue({
          name: 'test',
          version: '1.0.0',
        }),
      } as unknown as ExtensionManager;

      const result = await checkForExtensionUpdate(extension, mockManager);
      expect(result).toBe(ExtensionUpdateState.UP_TO_DATE);
    });

    it('should return NOT_UPDATABLE for local extension when source cannot be loaded', async () => {
      const extension = createExtension({
        version: '1.0.0',
        installMetadata: {
          type: 'local',
          source: '/path/to/source',
        },
      });

      const mockManager = {
        loadExtensionConfig: vi.fn().mockImplementation(() => {
          throw new Error('Cannot load config');
        }),
      } as unknown as ExtensionManager;

      const result = await checkForExtensionUpdate(extension, mockManager);
      expect(result).toBe(ExtensionUpdateState.NOT_UPDATABLE);
    });

    it('should convert a local Gemini archive before checking for updates', async () => {
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'local-archive-update-test-'),
      );
      try {
        const archivePath = path.join(tempDir, 'gemini-extension.zip');
        const archive = await createZipBuffer(tempDir, [
          {
            name: 'gemini-extension.json',
            content: JSON.stringify({
              name: 'gemini-archive-extension',
              version: '2.0.0',
            }),
          },
        ]);
        await fs.writeFile(archivePath, archive);
        const extension = createExtension({
          version: '1.0.0',
          installMetadata: {
            type: 'local',
            source: archivePath,
          },
        });
        const mockManager = {
          loadExtensionConfig: vi.fn(
            ({ extensionDir }: { extensionDir: string }) => {
              expect(
                fsSync.existsSync(
                  path.join(extensionDir, EXTENSIONS_CONFIG_FILENAME),
                ),
              ).toBe(true);
              return JSON.parse(
                fsSync.readFileSync(
                  path.join(extensionDir, EXTENSIONS_CONFIG_FILENAME),
                  'utf-8',
                ),
              );
            },
          ),
        } as unknown as ExtensionManager;

        const result = await checkForExtensionUpdate(extension, mockManager);

        expect(result).toBe(ExtensionUpdateState.UPDATE_AVAILABLE);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it('should return UPDATE_AVAILABLE for local archive extension with different version', async () => {
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'local-archive-update-test-'),
      );
      try {
        const archivePath = path.join(tempDir, 'qwen-extension.zip');
        const archive = await createZipBuffer(tempDir, [
          {
            name: EXTENSIONS_CONFIG_FILENAME,
            content: JSON.stringify({
              name: 'local-archive-extension',
              version: '2.0.0',
            }),
          },
        ]);
        await fs.writeFile(archivePath, archive);
        const extension = createExtension({
          version: '1.0.0',
          installMetadata: {
            type: 'local',
            source: archivePath,
          },
        });
        const mockManager = {
          loadExtensionConfig: vi.fn().mockReturnValue({
            name: 'local-archive-extension',
            version: '2.0.0',
          }),
        } as unknown as ExtensionManager;

        const result = await checkForExtensionUpdate(extension, mockManager);

        expect(result).toBe(ExtensionUpdateState.UPDATE_AVAILABLE);
        expect(mockManager.loadExtensionConfig).toHaveBeenCalledWith({
          extensionDir: expect.stringContaining('extension-archive-update-'),
        });
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it('should return UPDATE_AVAILABLE for archive URL extension with different version', async () => {
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'archive-url-update-test-'),
      );
      try {
        const archive = await createZipBuffer(tempDir, [
          {
            name: EXTENSIONS_CONFIG_FILENAME,
            content: JSON.stringify({
              name: 'archive-url-extension',
              version: '2.0.0',
            }),
          },
        ]);
        mockHttpsResponses(archive);
        const extension = createExtension({
          version: '1.0.0',
          installMetadata: {
            type: 'archive-url',
            source: 'https://example.com/extension.zip',
          },
        });
        const mockManager = {
          loadExtensionConfig: vi.fn().mockReturnValue({
            name: 'archive-url-extension',
            version: '2.0.0',
          }),
        } as unknown as ExtensionManager;

        const result = await checkForExtensionUpdate(extension, mockManager);

        expect(result).toBe(ExtensionUpdateState.UPDATE_AVAILABLE);
        expect(mockManager.loadExtensionConfig).toHaveBeenCalledWith({
          extensionDir: expect.stringContaining('extension-archive-update-'),
        });
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it('should convert an archive URL Gemini archive before checking for updates', async () => {
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'archive-url-update-test-'),
      );
      try {
        const archive = await createZipBuffer(tempDir, [
          {
            name: 'gemini-extension.json',
            content: JSON.stringify({
              name: 'gemini-archive-url-extension',
              version: '2.0.0',
            }),
          },
        ]);
        mockHttpsResponses(archive);
        const extension = createExtension({
          version: '1.0.0',
          installMetadata: {
            type: 'archive-url',
            source: 'https://example.com/gemini-extension.zip',
          },
        });
        const mockManager = {
          loadExtensionConfig: vi.fn(
            ({ extensionDir }: { extensionDir: string }) => {
              expect(
                fsSync.existsSync(
                  path.join(extensionDir, EXTENSIONS_CONFIG_FILENAME),
                ),
              ).toBe(true);
              return JSON.parse(
                fsSync.readFileSync(
                  path.join(extensionDir, EXTENSIONS_CONFIG_FILENAME),
                  'utf-8',
                ),
              );
            },
          ),
        } as unknown as ExtensionManager;

        const result = await checkForExtensionUpdate(extension, mockManager);

        expect(result).toBe(ExtensionUpdateState.UPDATE_AVAILABLE);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it('should return UP_TO_DATE for archive URL extension with same version', async () => {
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'archive-url-update-test-'),
      );
      try {
        const archive = await createZipBuffer(tempDir, [
          {
            name: EXTENSIONS_CONFIG_FILENAME,
            content: JSON.stringify({
              name: 'archive-url-extension',
              version: '1.0.0',
            }),
          },
        ]);
        mockHttpsResponses(archive);
        const extension = createExtension({
          version: '1.0.0',
          installMetadata: {
            type: 'archive-url',
            source: 'https://example.com/extension.zip',
          },
        });
        const mockManager = {
          loadExtensionConfig: vi.fn().mockReturnValue({
            name: 'archive-url-extension',
            version: '1.0.0',
          }),
        } as unknown as ExtensionManager;

        const result = await checkForExtensionUpdate(extension, mockManager);

        expect(result).toBe(ExtensionUpdateState.UP_TO_DATE);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
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

    it('should explain when a release archive is missing an extension manifest', async () => {
      const invalidArchive = await createZipBuffer(tempDir, [
        { name: 'README.md', content: 'not an extension' },
      ]);
      mockHttpsResponses(
        JSON.stringify({
          assets: [
            {
              name: 'extension.zip',
              browser_download_url: 'https://example.com/extension.zip',
            },
          ],
          tag_name: 'v1.0.0',
        }),
        invalidArchive,
      );

      await expect(
        downloadFromGitHubRelease(
          {
            source: 'owner/repo',
            type: 'git',
          },
          tempDir,
        ),
      ).rejects.toThrow(
        'Extension archive is missing a supported extension manifest.',
      );
    });

    it('should download and extract an archive URL', async () => {
      const archive = await createZipBuffer(tempDir, [
        {
          name: `${EXTENSIONS_CONFIG_FILENAME}`,
          content: JSON.stringify({
            name: 'archive-extension',
            version: '1.0.0',
          }),
        },
      ]);
      mockHttpsResponses(archive);

      await downloadFromArchiveUrl(
        {
          source: 'https://example.com/extension.zip',
          type: 'archive-url',
        },
        tempDir,
      );

      await expect(
        fs.readFile(path.join(tempDir, EXTENSIONS_CONFIG_FILENAME), 'utf-8'),
      ).resolves.toContain('archive-extension');
    });

    it.each([307, 308])(
      'should follow %i redirects with relative locations',
      async (statusCode) => {
        const archive = await createZipBuffer(tempDir, [
          {
            name: EXTENSIONS_CONFIG_FILENAME,
            content: JSON.stringify({
              name: 'redirected-archive-extension',
              version: '1.0.0',
            }),
          },
        ]);
        mockHttpsGet
          .mockImplementationOnce(((
            _url: string | URL | https.RequestOptions,
            _options:
              | https.RequestOptions
              | ((res: IncomingMessage) => void)
              | undefined,
            callback?: (res: IncomingMessage) => void,
          ) => {
            const response = createResponse(undefined, statusCode, {
              location: '../download/extension.zip',
            });
            callResponseCallback(_options, callback, response);
            return createRequestMock();
          }) as typeof https.get)
          .mockImplementationOnce(((
            _url: string | URL | https.RequestOptions,
            _options:
              | https.RequestOptions
              | ((res: IncomingMessage) => void)
              | undefined,
            callback?: (res: IncomingMessage) => void,
          ) => {
            const response = createResponse(archive);
            callResponseCallback(_options, callback, response);
            return createRequestMock();
          }) as typeof https.get);

        await downloadFromArchiveUrl(
          {
            source: 'https://example.com/releases/extension.zip',
            type: 'archive-url',
          },
          tempDir,
        );

        expect(mockHttpsGet).toHaveBeenCalledTimes(2);
        expect(mockHttpsGet.mock.calls[1][0].toString()).toBe(
          'https://example.com/download/extension.zip',
        );
      },
    );

    it('should reject malformed redirect locations without throwing', async () => {
      const response = createResponse(undefined, 302, {
        location: 'https://[::1',
      });
      const resumeSpy = vi.spyOn(response, 'resume');
      mockHttpsGet.mockImplementationOnce(((
        _url: string | URL | https.RequestOptions,
        _options:
          | https.RequestOptions
          | ((res: IncomingMessage) => void)
          | undefined,
        callback?: (res: IncomingMessage) => void,
      ) => {
        callResponseCallback(_options, callback, response);
        return createRequestMock();
      }) as typeof https.get);

      await expect(
        downloadFromArchiveUrl(
          {
            source: 'https://example.com/releases/extension.zip',
            type: 'archive-url',
          },
          tempDir,
        ),
      ).rejects.toThrow('Invalid redirect URL:');
      expect(resumeSpy).toHaveBeenCalled();
    });

    it('should drain non-200 archive URL responses before rejecting', async () => {
      const response = createResponse('missing', 404);
      const resumeSpy = vi.spyOn(response, 'resume');
      mockHttpsGet.mockImplementationOnce(((
        _url: string | URL | https.RequestOptions,
        _options:
          | https.RequestOptions
          | ((res: IncomingMessage) => void)
          | undefined,
        callback?: (res: IncomingMessage) => void,
      ) => {
        callResponseCallback(_options, callback, response);
        return createRequestMock();
      }) as typeof https.get);

      await expect(
        downloadFromArchiveUrl(
          {
            source: 'https://example.com/releases/extension.zip',
            type: 'archive-url',
          },
          tempDir,
        ),
      ).rejects.toThrow('Request failed with status code 404');
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

      const download = downloadFromArchiveUrl(
        {
          source: 'https://example.com/releases/extension.zip',
          type: 'archive-url',
        },
        tempDir,
      );
      timeoutCallback?.();

      await expect(download).rejects.toThrow(
        'Timed out downloading extension archive',
      );
      expect(request.destroy).toHaveBeenCalled();
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
      mockHttpsGet.mockImplementationOnce(((
        _url: string | URL | https.RequestOptions,
        _options:
          | https.RequestOptions
          | ((res: IncomingMessage) => void)
          | undefined,
        callback?: (res: IncomingMessage) => void,
      ) => {
        callResponseCallback(_options, callback, response);
        return createRequestMock();
      }) as typeof https.get);

      const download = downloadFromArchiveUrl(
        {
          source: 'https://example.com/releases/extension.zip',
          type: 'archive-url',
        },
        tempDir,
      );
      dataHandler?.({ length: 101 * 1024 * 1024 } as Buffer);

      await expect(download).rejects.toThrow(
        'Extension archive download exceeded maximum size',
      );
      expect(response.destroy).toHaveBeenCalled();
    });

    it('should not include the GitHub token for archive URL downloads', async () => {
      const originalToken = process.env['GITHUB_TOKEN'];
      process.env['GITHUB_TOKEN'] = 'secret-token';
      const archive = await createZipBuffer(tempDir, [
        {
          name: EXTENSIONS_CONFIG_FILENAME,
          content: JSON.stringify({
            name: 'public-archive-extension',
            version: '1.0.0',
          }),
        },
      ]);
      mockHttpsResponses(archive);

      try {
        await downloadFromArchiveUrl(
          {
            source: 'https://example.com/extension.zip',
            type: 'archive-url',
          },
          tempDir,
        );
      } finally {
        if (originalToken === undefined) {
          delete process.env['GITHUB_TOKEN'];
        } else {
          process.env['GITHUB_TOKEN'] = originalToken;
        }
      }

      const requestOptions = mockHttpsGet.mock.calls[0][1] as
        | https.RequestOptions
        | undefined;
      expect(requestOptions?.headers).toEqual({
        'User-agent': 'gemini-cli',
      });
    });

    it('should not forward the GitHub token to cross-host redirects', async () => {
      const originalToken = process.env['GITHUB_TOKEN'];
      process.env['GITHUB_TOKEN'] = 'secret-token';
      const archive = await createZipBuffer(tempDir, [
        {
          name: EXTENSIONS_CONFIG_FILENAME,
          content: JSON.stringify({
            name: 'redirected-release-extension',
            version: '1.0.0',
          }),
        },
      ]);
      mockHttpsGet
        .mockImplementationOnce(((
          _url: string | URL | https.RequestOptions,
          _options:
            | https.RequestOptions
            | ((res: IncomingMessage) => void)
            | undefined,
          callback?: (res: IncomingMessage) => void,
        ) => {
          const response = createResponse(
            JSON.stringify({
              assets: [
                {
                  name: 'extension.zip',
                  browser_download_url:
                    'https://github.com/owner/repo/releases/download/v1.0.0/extension.zip',
                },
              ],
              tag_name: 'v1.0.0',
            }),
          );
          callResponseCallback(_options, callback, response);
          return createRequestMock();
        }) as typeof https.get)
        .mockImplementationOnce(((
          _url: string | URL | https.RequestOptions,
          _options:
            | https.RequestOptions
            | ((res: IncomingMessage) => void)
            | undefined,
          callback?: (res: IncomingMessage) => void,
        ) => {
          const response = createResponse(undefined, 302, {
            location: 'https://objects.githubusercontent.com/extension.zip',
          });
          callResponseCallback(_options, callback, response);
          return createRequestMock();
        }) as typeof https.get)
        .mockImplementationOnce(((
          _url: string | URL | https.RequestOptions,
          _options:
            | https.RequestOptions
            | ((res: IncomingMessage) => void)
            | undefined,
          callback?: (res: IncomingMessage) => void,
        ) => {
          const response = createResponse(archive);
          callResponseCallback(_options, callback, response);
          return createRequestMock();
        }) as typeof https.get);

      try {
        await downloadFromGitHubRelease(
          {
            source: 'owner/repo',
            type: 'git',
          },
          tempDir,
        );
      } finally {
        if (originalToken === undefined) {
          delete process.env['GITHUB_TOKEN'];
        } else {
          process.env['GITHUB_TOKEN'] = originalToken;
        }
      }

      const originalDownloadOptions = mockHttpsGet.mock.calls[1][1] as
        | https.RequestOptions
        | undefined;
      const redirectedDownloadOptions = mockHttpsGet.mock.calls[2][1] as
        | https.RequestOptions
        | undefined;
      expect(originalDownloadOptions?.headers).toMatchObject({
        Authorization: 'token secret-token',
      });
      expect(redirectedDownloadOptions?.headers).toEqual({
        'User-agent': 'gemini-cli',
      });
    });

    it('should stop following redirect loops', async () => {
      mockHttpsGet.mockImplementation(((
        _url: string | URL | https.RequestOptions,
        _options:
          | https.RequestOptions
          | ((res: IncomingMessage) => void)
          | undefined,
        callback?: (res: IncomingMessage) => void,
      ) => {
        const response = createResponse(undefined, 302, {
          location: 'https://example.com/extension.zip',
        });
        callResponseCallback(_options, callback, response);
        return createRequestMock();
      }) as typeof https.get);

      await expect(
        downloadFromArchiveUrl(
          {
            source: 'https://example.com/extension.zip',
            type: 'archive-url',
          },
          tempDir,
        ),
      ).rejects.toThrow(
        'Too many redirects while downloading extension archive',
      );
    });

    it('should reject redirects without a location and clear the timeout', async () => {
      vi.useFakeTimers();
      const response = createResponse(undefined, 302);
      const resumeSpy = vi.spyOn(response, 'resume');
      mockHttpsGet.mockImplementationOnce(((
        _url: string | URL | https.RequestOptions,
        _options:
          | https.RequestOptions
          | ((res: IncomingMessage) => void)
          | undefined,
        callback?: (res: IncomingMessage) => void,
      ) => {
        callResponseCallback(_options, callback, response);
        return createRequestMock();
      }) as typeof https.get);

      try {
        await expect(
          downloadFromArchiveUrl(
            {
              source: 'https://example.com/extension.zip',
              type: 'archive-url',
            },
            tempDir,
          ),
        ).rejects.toThrow('Redirect response missing location header');
        expect(resumeSpy).toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should reject when an archive URL response stream errors', async () => {
      mockHttpsGet.mockImplementationOnce(((
        _url: string | URL | https.RequestOptions,
        _options:
          | https.RequestOptions
          | ((res: IncomingMessage) => void)
          | undefined,
        callback?: (res: IncomingMessage) => void,
      ) => {
        const response = new Readable({
          read() {
            this.destroy(new Error('connection lost'));
          },
        }) as IncomingMessage;
        Object.assign(response, {
          statusCode: 200,
          headers: {},
        });
        callResponseCallback(_options, callback, response);
        return createRequestMock();
      }) as typeof https.get);

      await expect(
        downloadFromArchiveUrl(
          {
            source: 'https://example.com/extension.zip',
            type: 'archive-url',
          },
          tempDir,
        ),
      ).rejects.toThrow(
        'Failed to download archive from https://example.com/extension.zip: connection lost',
      );
    });

    it('should explain when an archive URL cannot be extracted', async () => {
      mockHttpsResponses(Buffer.from('not a zip'));

      await expect(
        downloadFromArchiveUrl(
          {
            source: 'https://example.com/extension.zip',
            type: 'archive-url',
          },
          tempDir,
        ),
      ).rejects.toThrow(
        'Extension archive could not be extracted. Make sure it is a valid .zip or .tar.gz file.',
      );
    });

    it('should explain when a local archive is missing an extension manifest', async () => {
      const invalidArchivePath = path.join(tempDir, 'invalid.zip');
      const invalidArchive = await createZipBuffer(tempDir, [
        { name: 'README.md', content: 'not an extension' },
      ]);
      await fs.writeFile(invalidArchivePath, invalidArchive);

      await expect(
        extractArchiveFile(invalidArchivePath, tempDir),
      ).rejects.toThrow(
        'Extension archive is missing a supported extension manifest.',
      );
    });

    it('should extract and flatten a tar.gz archive with a wrapped extension directory', async () => {
      const archivePath = path.join(tempDir, 'wrapped-extension.tar.gz');
      const sourceRoot = path.join(tempDir, 'tar-source');
      const wrappedDir = path.join(sourceRoot, 'wrapped-extension');
      await fs.mkdir(wrappedDir, { recursive: true });
      await fs.writeFile(
        path.join(wrappedDir, EXTENSIONS_CONFIG_FILENAME),
        JSON.stringify({
          name: 'tar-wrapped-extension',
          version: '1.0.0',
        }),
      );
      await tar.c(
        {
          cwd: sourceRoot,
          file: archivePath,
          gzip: true,
        },
        ['wrapped-extension'],
      );
      await fs.rm(sourceRoot, { recursive: true, force: true });

      await extractArchiveFile(archivePath, tempDir);

      await expect(
        fs.readFile(path.join(tempDir, EXTENSIONS_CONFIG_FILENAME), 'utf-8'),
      ).resolves.toContain('tar-wrapped-extension');
    });

    it('should flatten wrapped archives when the archive file is in the destination', async () => {
      const archivePath = path.join(tempDir, 'downloaded-extension.zip');
      const archiveBuildDir = path.join(tempDir, 'archive-build');
      await fs.mkdir(archiveBuildDir);
      const archive = await createZipBuffer(archiveBuildDir, [
        {
          name: `wrapped/${EXTENSIONS_CONFIG_FILENAME}`,
          content: JSON.stringify({
            name: 'wrapped-with-readme-extension',
            version: '1.0.0',
          }),
        },
        { name: 'README.md', content: 'readme' },
      ]);
      await fs.rm(archiveBuildDir, { recursive: true, force: true });
      await fs.writeFile(archivePath, archive);

      await extractArchiveFile(archivePath, tempDir);

      await expect(
        fs.readFile(path.join(tempDir, EXTENSIONS_CONFIG_FILENAME), 'utf-8'),
      ).resolves.toContain('wrapped-with-readme-extension');
      await expect(
        fs.readFile(path.join(tempDir, 'README.md'), 'utf-8'),
      ).resolves.toBe('readme');
      await expect(fs.stat(archivePath)).resolves.toBeDefined();
    });

    it('should not flatten when the archive root already has a manifest', async () => {
      const archivePath = path.join(tempDir, 'root-and-wrapper.zip');
      const archive = await createZipBuffer(tempDir, [
        {
          name: EXTENSIONS_CONFIG_FILENAME,
          content: JSON.stringify({
            name: 'root-extension',
            version: '1.0.0',
          }),
        },
        {
          name: `wrapped/${EXTENSIONS_CONFIG_FILENAME}`,
          content: JSON.stringify({
            name: 'wrapped-extension',
            version: '1.0.0',
          }),
        },
      ]);
      await fs.writeFile(archivePath, archive);

      await extractArchiveFile(archivePath, tempDir);

      await expect(
        fs.readFile(path.join(tempDir, EXTENSIONS_CONFIG_FILENAME), 'utf-8'),
      ).resolves.toContain('root-extension');
      await expect(
        fs.readFile(
          path.join(tempDir, 'wrapped', EXTENSIONS_CONFIG_FILENAME),
          'utf-8',
        ),
      ).resolves.toContain('wrapped-extension');
    });

    it('should reject flattening when wrapper contents collide with root files', async () => {
      const archivePath = path.join(tempDir, 'colliding-wrapper.zip');
      const archiveBuildDir = path.join(tempDir, 'collision-build');
      await fs.mkdir(archiveBuildDir);
      const archive = await createZipBuffer(archiveBuildDir, [
        {
          name: `wrapped/${EXTENSIONS_CONFIG_FILENAME}`,
          content: JSON.stringify({
            name: 'wrapped-extension',
            version: '1.0.0',
          }),
        },
        { name: 'wrapped/README.md', content: 'wrapped readme' },
        { name: 'README.md', content: 'root readme' },
      ]);
      await fs.rm(archiveBuildDir, { recursive: true, force: true });
      await fs.writeFile(archivePath, archive);

      await expect(extractArchiveFile(archivePath, tempDir)).rejects.toThrow(
        'Extension archive cannot be flattened because "README.md" exists at both the archive root and inside "wrapped".',
      );
      await expect(
        fs.readFile(path.join(tempDir, 'README.md'), 'utf-8'),
      ).resolves.toBe('root readme');
      await expect(
        fs.readFile(
          path.join(tempDir, 'wrapped', EXTENSIONS_CONFIG_FILENAME),
          'utf-8',
        ),
      ).resolves.toContain('wrapped-extension');
    });

    it('should not flatten archives with multiple top-level entries', async () => {
      const archivePath = path.join(tempDir, 'multiple-entries.zip');
      const archive = await createZipBuffer(tempDir, [
        {
          name: `wrapped/${EXTENSIONS_CONFIG_FILENAME}`,
          content: JSON.stringify({
            name: 'wrapped-extension',
            version: '1.0.0',
          }),
        },
        { name: 'README.md', content: 'readme' },
        { name: 'LICENSE', content: 'license' },
      ]);
      await fs.writeFile(archivePath, archive);

      await expect(extractArchiveFile(archivePath, tempDir)).rejects.toThrow(
        'Extension archive is missing a supported extension manifest.',
      );
      await expect(
        fs.readFile(
          path.join(tempDir, 'wrapped', EXTENSIONS_CONFIG_FILENAME),
          'utf-8',
        ),
      ).resolves.toContain('wrapped-extension');
    });

    it('should not flatten archives without a top-level directory', async () => {
      const archivePath = path.join(tempDir, 'files-only.zip');
      const archive = await createZipBuffer(tempDir, [
        {
          name: EXTENSIONS_CONFIG_FILENAME,
          content: JSON.stringify({
            name: 'files-only-extension',
            version: '1.0.0',
          }),
        },
        { name: 'README.md', content: 'readme' },
      ]);
      await fs.writeFile(archivePath, archive);

      await extractArchiveFile(archivePath, tempDir);

      await expect(
        fs.readFile(path.join(tempDir, EXTENSIONS_CONFIG_FILENAME), 'utf-8'),
      ).resolves.toContain('files-only-extension');
    });

    it('should not flatten a top-level directory without a supported manifest', async () => {
      const archivePath = path.join(tempDir, 'unsupported-wrapper.zip');
      const archive = await createZipBuffer(tempDir, [
        { name: 'wrapped/README.md', content: 'not an extension' },
      ]);
      await fs.writeFile(archivePath, archive);

      await expect(extractArchiveFile(archivePath, tempDir)).rejects.toThrow(
        'Extension archive is missing a supported extension manifest.',
      );
      await expect(
        fs.readFile(path.join(tempDir, 'wrapped', 'README.md'), 'utf-8'),
      ).resolves.toBe('not an extension');
    });

    it('should identify supported archive paths and URLs', () => {
      expect(isSupportedArchivePath('/tmp/extension.zip')).toBe(true);
      expect(isSupportedArchivePath('/tmp/extension.tar.gz')).toBe(true);
      expect(isSupportedArchivePath('/tmp/extension.tgz')).toBe(false);
      expect(isSupportedArchiveUrl('https://example.com/extension.zip')).toBe(
        true,
      );
      expect(isSupportedArchiveUrl('http://example.com/extension.zip')).toBe(
        false,
      );
      expect(
        isSupportedArchiveUrl('https://example.com/extension.tar.gz'),
      ).toBe(true);
      expect(isSupportedArchiveUrl('git@github.com:owner/repo.git')).toBe(
        false,
      );
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

    it('should find asset matching platform and architecture', () => {
      mockPlatform.mockReturnValue('darwin');
      mockArch.mockReturnValue('arm64');
      const result = findReleaseAsset(assets);
      expect(result).toEqual(assets[0]);
    });

    it('should find asset matching platform if arch does not match', () => {
      mockPlatform.mockReturnValue('linux');
      mockArch.mockReturnValue('arm64');
      const result = findReleaseAsset(assets);
      expect(result).toEqual(assets[2]);
    });

    it('should return undefined if no matching asset is found', () => {
      mockPlatform.mockReturnValue('sunos');
      mockArch.mockReturnValue('x64');
      const result = findReleaseAsset(assets);
      expect(result).toBeUndefined();
    });

    it('should find generic asset if it is the only one', () => {
      const singleAsset = [
        { name: 'extension.tar.gz', browser_download_url: 'url' },
      ];
      mockPlatform.mockReturnValue('darwin');
      mockArch.mockReturnValue('arm64');
      const result = findReleaseAsset(singleAsset);
      expect(result).toEqual(singleAsset[0]);
    });

    it('should return undefined if multiple generic assets exist', () => {
      const multipleGenericAssets = [
        { name: 'extension-1.tar.gz', browser_download_url: 'url1' },
        { name: 'extension-2.tar.gz', browser_download_url: 'url2' },
      ];
      mockPlatform.mockReturnValue('darwin');
      mockArch.mockReturnValue('arm64');
      const result = findReleaseAsset(multipleGenericAssets);
      expect(result).toBeUndefined();
    });
  });

  describe('parseGitHubRepoForReleases', () => {
    it('should parse owner and repo from a full GitHub URL', () => {
      const source = 'https://github.com/owner/repo.git';
      const { owner, repo } = parseGitHubRepoForReleases(source);
      expect(owner).toBe('owner');
      expect(repo).toBe('repo');
    });

    it('should parse owner and repo from a full GitHub UR without .git', () => {
      const source = 'https://github.com/owner/repo';
      const { owner, repo } = parseGitHubRepoForReleases(source);
      expect(owner).toBe('owner');
      expect(repo).toBe('repo');
    });

    it('should fail on a GitHub SSH URL', () => {
      const source = 'git@github.com:owner/repo.git';
      expect(() => parseGitHubRepoForReleases(source)).toThrow(
        'GitHub release-based extensions are not supported for SSH. You must use an HTTPS URI with a personal access token to download releases from private repositories. You can set your personal access token in the GITHUB_TOKEN environment variable and install the extension via SSH.',
      );
    });

    it('should fail on a non-GitHub URL', () => {
      const source = 'https://example.com/owner/repo.git';
      expect(() => parseGitHubRepoForReleases(source)).toThrow(
        'Invalid GitHub repository source: https://example.com/owner/repo.git. Expected "owner/repo" or a github repo uri.',
      );
    });

    it('should redact URL credentials in invalid source errors', () => {
      const source = 'https://user:token@example.com/owner/repo.git';

      let message = '';
      try {
        parseGitHubRepoForReleases(source);
      } catch (error: unknown) {
        message = String(error);
      }

      expect(message).toContain(
        'https://***REDACTED***@example.com/owner/repo.git',
      );
      expect(message).not.toContain('user');
      expect(message).not.toContain('token');
    });

    it('should parse owner and repo from a shorthand string', () => {
      const source = 'owner/repo';
      const { owner, repo } = parseGitHubRepoForReleases(source);
      expect(owner).toBe('owner');
      expect(repo).toBe('repo');
    });

    it('should handle .git suffix in repo name', () => {
      const source = 'owner/repo.git';
      const { owner, repo } = parseGitHubRepoForReleases(source);
      expect(owner).toBe('owner');
      expect(repo).toBe('repo');
    });

    it('should throw error for invalid source format', () => {
      const source = 'invalid-format';
      expect(() => parseGitHubRepoForReleases(source)).toThrow(
        'Invalid GitHub repository source: invalid-format. Expected "owner/repo" or a github repo uri.',
      );
    });

    it('should throw error for source with too many parts', () => {
      const source = 'https://github.com/owner/repo/extra';
      expect(() => parseGitHubRepoForReleases(source)).toThrow(
        'Invalid GitHub repository source: https://github.com/owner/repo/extra. Expected "owner/repo" or a github repo uri.',
      );
    });
  });

  describe('extractFile', () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-test-'));
    });

    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('should extract a .tar.gz file', async () => {
      const archivePath = path.join(tempDir, 'test.tar.gz');
      const extractionDest = path.join(tempDir, 'extracted');
      await fs.mkdir(extractionDest);

      // Create a dummy file to be archived
      const dummyFilePath = path.join(tempDir, 'test.txt');
      await fs.writeFile(dummyFilePath, 'hello tar');

      // Create the tar.gz file
      await tar.c(
        {
          gzip: true,
          file: archivePath,
          cwd: tempDir,
        },
        ['test.txt'],
      );

      await extractFile(archivePath, extractionDest);

      const extractedFilePath = path.join(extractionDest, 'test.txt');
      const content = await fs.readFile(extractedFilePath, 'utf-8');
      expect(content).toBe('hello tar');
    });

    it.skipIf(process.platform === 'win32')(
      'should reject symlink entries in tar archives',
      async () => {
        const archivePath = path.join(tempDir, 'symlink.tar.gz');
        const extractionDest = path.join(tempDir, 'extracted');
        const sourceDir = path.join(tempDir, 'source');
        const outsideDir = path.join(tempDir, 'outside');
        await fs.mkdir(extractionDest);
        await fs.mkdir(sourceDir);
        await fs.mkdir(outsideDir);
        await fs.symlink(outsideDir, path.join(sourceDir, 'escape-link'));

        await tar.c(
          {
            gzip: true,
            file: archivePath,
            cwd: sourceDir,
          },
          ['escape-link'],
        );

        await expect(extractFile(archivePath, extractionDest)).rejects.toThrow(
          'Tar archive contains unsupported link entry: escape-link',
        );

        await expect(
          fs.lstat(path.join(extractionDest, 'escape-link')),
        ).rejects.toThrow();
      },
    );

    it('should extract a .zip file', async () => {
      const archivePath = path.join(tempDir, 'test.zip');
      const extractionDest = path.join(tempDir, 'extracted');
      await fs.mkdir(extractionDest);

      // Create a dummy file to be archived
      const dummyFilePath = path.join(tempDir, 'test.txt');
      await fs.writeFile(dummyFilePath, 'hello zip');

      // Create the zip file
      const output = fsSync.createWriteStream(archivePath);
      const archive = archiver.create('zip');

      const streamFinished = new Promise((resolve, reject) => {
        output.on('close', () => resolve(null));
        archive.on('error', reject);
      });

      archive.pipe(output);
      archive.file(dummyFilePath, { name: 'test.txt' });
      await archive.finalize();
      await streamFinished;

      await extractFile(archivePath, extractionDest);

      const extractedFilePath = path.join(extractionDest, 'test.txt');
      const content = await fs.readFile(extractedFilePath, 'utf-8');
      expect(content).toBe('hello zip');
    });

    it('should reject symlink entries in zip archives', async () => {
      const archivePath = path.join(tempDir, 'symlink.zip');
      const extractionDest = path.join(tempDir, 'extracted');
      await fs.mkdir(extractionDest);

      const output = fsSync.createWriteStream(archivePath);
      const archive = archiver.create('zip');

      const streamFinished = new Promise((resolve, reject) => {
        output.on('close', () => resolve(null));
        archive.on('error', reject);
      });

      archive.pipe(output);
      archive.symlink('escape-link', '/tmp/outside-target');
      await archive.finalize();
      await streamFinished;

      await expect(extractFile(archivePath, extractionDest)).rejects.toThrow(
        'Zip archive contains unsupported symbolic link entry: escape-link',
      );
      await expect(
        fs.lstat(path.join(extractionDest, 'escape-link')),
      ).rejects.toThrow();
    });

    it('should throw an error for unsupported file types', async () => {
      const unsupportedFilePath = path.join(tempDir, 'test.txt');
      await fs.writeFile(unsupportedFilePath, 'some content');
      const extractionDest = path.join(tempDir, 'extracted');
      await fs.mkdir(extractionDest);

      await expect(
        extractFile(unsupportedFilePath, extractionDest),
      ).rejects.toThrow('Unsupported file extension for extraction:');
    });
  });
});
