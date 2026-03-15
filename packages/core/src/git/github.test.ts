import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { GitHubProvider } from './github.js';
import { simpleGit, type SimpleGit } from 'simple-git';
import * as https from 'node:https';

vi.mock('simple-git');
vi.mock('node:https');
vi.mock('node:fs', () => ({
  promises: {
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    readFile: vi.fn(),
    unlink: vi.fn(),
    rm: vi.fn(),
  },
  createWriteStream: vi.fn(),
  existsSync: vi.fn(),
}));
vi.mock('node:path');
vi.mock('tar');
vi.mock('extract-zip');
vi.mock('node:os');

describe('GitHubProvider', () => {
  let provider: GitHubProvider;
  const mockGit = {
    clone: vi.fn().mockReturnThis(),
    getRemotes: vi.fn().mockResolvedValue([{ name: 'origin' }]),
    fetch: vi.fn().mockReturnThis(),
    checkout: vi.fn().mockReturnThis(),
  };

  beforeEach(() => {
    provider = new GitHubProvider();
    vi.mocked(simpleGit).mockReturnValue(mockGit as unknown as SimpleGit);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('getRepoInfo', () => {
    it('should parse owner and repo from a shorthand string', () => {
      const { owner, repo } = provider.getRepoInfo('owner/repo');
      expect(owner).toBe('owner');
      expect(repo).toBe('repo');
    });

    it('should parse owner and repo from a GitHub URL', () => {
      const { owner, repo } = provider.getRepoInfo(
        'https://github.com/owner/repo',
      );
      expect(owner).toBe('owner');
      expect(repo).toBe('repo');
    });

    it('should throw for invalid GitHub source', () => {
      expect(() => provider.getRepoInfo('invalid')).toThrow();
    });
  });

  describe('clone', () => {
    it('should call simpleGit clone with correct arguments', async () => {
      await provider.clone('https://github.com/owner/repo', '/dest', 'ref');
      expect(simpleGit).toHaveBeenCalledWith('/dest');
      expect(mockGit.clone).toHaveBeenCalledWith(
        'https://github.com/owner/repo',
        './',
        expect.arrayContaining(['--depth', '1']),
      );
      expect(mockGit.getRemotes).toHaveBeenCalledWith(true);
      expect(mockGit.fetch).toHaveBeenCalledWith('origin', 'ref');
      expect(mockGit.checkout).toHaveBeenCalledWith('FETCH_HEAD');
    });

    it('should call simpleGit clone without branch if no ref provided', async () => {
      await provider.clone('https://github.com/owner/repo', '/dest');
      expect(mockGit.fetch).toHaveBeenCalledWith('origin', 'HEAD');
    });
  });

  describe('getLatestRelease', () => {
    it('should fetch and return latest release tag', async () => {
      const mockResponse = {
        on: vi.fn().mockImplementation((event, cb) => {
          if (event === 'data') {
            cb(Buffer.from(JSON.stringify({ tag_name: 'v1.0.0' })));
          }
          if (event === 'end') {
            cb();
          }
        }),
        statusCode: 200,
      };

      vi.mocked(https.get).mockImplementation((url, options, cb) => {
        const callback: (res: typeof mockResponse) => void =
          typeof options === 'function'
            ? options
            : (cb as (res: typeof mockResponse) => void);
        callback(mockResponse);
        const request = {
          on: vi.fn().mockReturnThis(),
        };
        return request as unknown as import('node:https').ClientRequest;
      });

      const tag = await provider.getLatestRelease('owner', 'repo');
      expect(tag).toBe('v1.0.0');
    });
  });
});
