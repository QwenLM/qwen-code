import { describe, expect, it } from 'vitest';
import { GitProviderFactory } from './factory.js';
import { GitHubProvider } from './github.js';
import { GitAuthManager } from './auth.js';

describe('GitProviderFactory', () => {
  it('should return GitHubProvider for github.com URLs', () => {
    const provider = GitProviderFactory.getProvider(
      'https://github.com/owner/repo',
    );
    expect(provider).toBeInstanceOf(GitHubProvider);
  });

  it('should return GitHubProvider for owner/repo shorthand', () => {
    const provider = GitProviderFactory.getProvider('owner/repo');
    expect(provider).toBeInstanceOf(GitHubProvider);
  });

  it('should throw for unknown provider URLs', () => {
    expect(() =>
      GitProviderFactory.getProvider('https://bitbucket.org/owner/repo'),
    ).toThrow('No Git provider found');
  });

  it('should register a custom provider', () => {
    class MockProvider extends GitHubProvider {
      static override readonly providerName = 'mock';
      static override canHandle(source: string): boolean {
        return source.includes('mock-provider');
      }
    }

    GitProviderFactory.register(MockProvider);
    const provider = GitProviderFactory.getProvider(
      'https://mock-provider.com/owner/repo',
    );
    expect(provider).toBeInstanceOf(MockProvider);
  });

  it('should inject auth token from GitAuthManager', () => {
    GitAuthManager.setToken('github', 'test-token');
    const provider = GitProviderFactory.getProvider('owner/repo');
    // @ts-expect-error - accessing private/internal property for testing
    expect(provider.getGitHubToken()).toBe('test-token');
  });
});
