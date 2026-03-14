import { describe, expect, it, vi, beforeEach } from 'vitest';
import { GitLabProvider } from './gitlab.js';
import { simpleGit, type SimpleGit } from 'simple-git';

vi.mock('simple-git');
vi.mock('node:https');
vi.mock('node:fs', () => ({
  promises: {
    unlink: vi.fn(),
  },
  createWriteStream: vi.fn(),
}));

describe('GitLabProvider', () => {
  let provider: GitLabProvider;

  beforeEach(() => {
    provider = new GitLabProvider();
  });

  describe('canHandle', () => {
    it('should return true for gitlab.com URLs', () => {
      expect(GitLabProvider.canHandle('https://gitlab.com/owner/repo')).toBe(
        true,
      );
      expect(GitLabProvider.canHandle('git@gitlab.com:owner/repo.git')).toBe(
        true,
      );
    });

    it('should return false for github.com URLs', () => {
      expect(GitLabProvider.canHandle('https://github.com/owner/repo')).toBe(
        false,
      );
    });
  });

  describe('getRepoInfo', () => {
    it('should parse owner and repo from GitLab URL', () => {
      const { owner, repo } = provider.getRepoInfo(
        'https://gitlab.com/group/subgroup/repo',
      );
      expect(owner).toBe('group/subgroup');
      expect(repo).toBe('repo');
    });

    it('should parse owner and repo from GitLab SSH source', () => {
      const { owner, repo } = provider.getRepoInfo(
        'git@gitlab.com:owner/repo.git',
      );
      expect(owner).toBe('owner');
      expect(repo).toBe('repo');
    });
  });

  describe('clone', () => {
    const mockGit = {
      clone: vi.fn().mockReturnThis(),
      getRemotes: vi.fn().mockResolvedValue([{ name: 'origin' }]),
      fetch: vi.fn().mockReturnThis(),
      checkout: vi.fn().mockReturnThis(),
    };

    beforeEach(() => {
      vi.mocked(simpleGit).mockReturnValue(mockGit as unknown as SimpleGit);
    });

    it('should call simpleGit clone with correct arguments', async () => {
      await provider.clone('https://gitlab.com/owner/repo', '/dest', 'ref');
      expect(simpleGit).toHaveBeenCalledWith('/dest');
      expect(mockGit.clone).toHaveBeenCalledWith(
        'https://gitlab.com/owner/repo',
        './',
        ['--depth', '1'],
      );
      expect(mockGit.fetch).toHaveBeenCalledWith('origin', 'ref');
      expect(mockGit.checkout).toHaveBeenCalledWith('FETCH_HEAD');
    });
  });
});
