/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkForExtensionUpdate,
  cloneFromGit,
  getRepoInfoFromSource,
} from './github.js';
import { simpleGit, type SimpleGit } from 'simple-git';
import {
  ExtensionUpdateState,
  type Extension,
  type ExtensionManager,
} from './extensionManager.js';
import { GitProviderFactory } from '../git/index.js';
import type { GitProvider } from '../git/types.js';

vi.mock('simple-git');
vi.mock('../git/index.js', () => ({
  GitProviderFactory: {
    getProvider: vi.fn(),
  },
}));

describe('git extension helpers', () => {
  const mockProvider: Partial<GitProvider> = {
    clone: vi.fn(),
    getRepoInfo: vi.fn(),
    getLatestRelease: vi.fn(),
    downloadRelease: vi.fn(),
  };

  beforeEach(() => {
    vi.mocked(GitProviderFactory.getProvider).mockReturnValue(
      mockProvider as GitProvider,
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('cloneFromGit', () => {
    it('should call provider clone', async () => {
      const installMetadata = {
        source: 'http://my-repo.com',
        ref: 'my-ref',
        type: 'git' as const,
      };
      const destination = '/dest';

      await cloneFromGit(installMetadata, destination);

      expect(GitProviderFactory.getProvider).toHaveBeenCalledWith(
        'http://my-repo.com',
      );
      expect(mockProvider.clone).toHaveBeenCalledWith(
        'http://my-repo.com',
        destination,
        'my-ref',
      );
    });
  });

  describe('checkForExtensionUpdate', () => {
    const mockExtensionManager = {
      loadExtensionConfig: vi.fn(),
    } as unknown as ExtensionManager;

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

    it('should return UPDATE_AVAILABLE when remote hash is different', async () => {
      const extension = createExtension({
        installMetadata: {
          type: 'git',
          source: 'my/ext',
        },
      });
      const mockGit = {
        getRemotes: vi
          .fn()
          .mockResolvedValue([
            { name: 'origin', refs: { fetch: 'http://my-repo.com' } },
          ]),
        listRemote: vi.fn().mockResolvedValue('remote-hash\tHEAD'),
        revparse: vi.fn().mockResolvedValue('local-hash'),
      };
      vi.mocked(simpleGit).mockReturnValue(mockGit as unknown as SimpleGit);

      const result = await checkForExtensionUpdate(
        extension,
        mockExtensionManager,
      );
      expect(result).toBe(ExtensionUpdateState.UPDATE_AVAILABLE);
    });

    it('should return UP_TO_DATE when release tag is the same', async () => {
      const extension = createExtension({
        installMetadata: {
          type: 'github-release',
          source: 'owner/repo',
          releaseTag: 'v1.0.0',
        },
      });
      vi.mocked(mockProvider.getRepoInfo!).mockReturnValue({
        owner: 'owner',
        repo: 'repo',
      });
      vi.mocked(mockProvider.getLatestRelease!).mockResolvedValue('v1.0.0');

      const result = await checkForExtensionUpdate(
        extension,
        mockExtensionManager,
      );
      expect(result).toBe(ExtensionUpdateState.UP_TO_DATE);
    });

    it('should return UPDATE_AVAILABLE when release tag is different', async () => {
      const extension = createExtension({
        installMetadata: {
          type: 'github-release',
          source: 'owner/repo',
          releaseTag: 'v1.0.0',
        },
      });
      vi.mocked(mockProvider.getRepoInfo!).mockReturnValue({
        owner: 'owner',
        repo: 'repo',
      });
      vi.mocked(mockProvider.getLatestRelease!).mockResolvedValue('v1.1.0');

      const result = await checkForExtensionUpdate(
        extension,
        mockExtensionManager,
      );
      expect(result).toBe(ExtensionUpdateState.UPDATE_AVAILABLE);
    });
  });

  describe('getRepoInfoFromSource', () => {
    it('should call provider getRepoInfo', () => {
      const source = 'owner/repo';
      vi.mocked(mockProvider.getRepoInfo!).mockReturnValue({
        owner: 'owner',
        repo: 'repo',
      });

      const result = getRepoInfoFromSource(source);

      expect(GitProviderFactory.getProvider).toHaveBeenCalledWith(source);
      expect(mockProvider.getRepoInfo).toHaveBeenCalledWith(source);
      expect(result).toEqual({ owner: 'owner', repo: 'repo' });
    });
  });
});
