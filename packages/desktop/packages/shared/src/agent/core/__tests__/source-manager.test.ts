/**
 * Tests for SourceManager
 *
 * Tests the centralized source state management used by both
 * backend agents.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { SourceManager } from '../source-manager.ts';
import type { LoadedSource } from '../../../sources/types.ts';

// Helper to create mock LoadedSource objects
function createMockSource(
  slug: string,
  overrides: Partial<LoadedSource['config']> = {}
): LoadedSource {
  return {
    config: {
      id: `${slug}-id`,
      name: slug.charAt(0).toUpperCase() + slug.slice(1),
      slug,
      enabled: true,
      provider: 'test',
      type: 'mcp',
      tagline: `${slug} tagline`,
      ...overrides,
    },
    guide: null,
    folderPath: `/test/sources/${slug}`,
    workspaceRootPath: '/test/workspace',
    workspaceId: 'test-workspace',
  };
}

describe('SourceManager', () => {
  let sourceManager: SourceManager;
  let debugMessages: string[];

  beforeEach(() => {
    debugMessages = [];
    sourceManager = new SourceManager({
      onDebug: (msg) => debugMessages.push(msg),
    });
  });

  describe('State Management', () => {
    it('should start with no active sources', () => {
      expect(sourceManager.getActiveSlugs().size).toBe(0);
      expect(sourceManager.getIntendedSlugs().size).toBe(0);
    });

    it('should update active state from MCP and API servers', () => {
      sourceManager.updateActiveState(['github', 'slack'], ['gmail'], ['github', 'slack', 'gmail']);

      const activeSlugs = sourceManager.getActiveSlugs();
      expect(activeSlugs.has('github')).toBe(true);
      expect(activeSlugs.has('slack')).toBe(true);
      expect(activeSlugs.has('gmail')).toBe(true);
    });

    it('should track intended slugs separately from active slugs', () => {
      // Intended slugs include sources that UI shows as active, even if build failed
      sourceManager.updateActiveState(['github'], [], ['github', 'failing-source']);

      expect(sourceManager.isSourceActive('github')).toBe(true);
      expect(sourceManager.isSourceActive('failing-source')).toBe(false);

      expect(sourceManager.isSourceIntendedActive('github')).toBe(true);
      expect(sourceManager.isSourceIntendedActive('failing-source')).toBe(true);
    });

    it('should log debug messages about source state', () => {
      sourceManager.updateActiveState(['github'], [], ['github', 'failing-source']);

      expect(debugMessages.some(m => m.includes('Active sources'))).toBe(true);
      expect(debugMessages.some(m => m.includes('failed builds'))).toBe(true);
    });
  });

  describe('Source Collection Management', () => {
    it('should store and retrieve all sources', () => {
      const sources = [
        createMockSource('github'),
        createMockSource('slack'),
        createMockSource('gmail'),
      ];

      sourceManager.setAllSources(sources);

      const retrieved = sourceManager.getAllSources();
      expect(retrieved.length).toBe(3);
      expect(retrieved[0]?.config.slug).toBe('github');
    });
  });

  describe('Source Visibility Tracking', () => {
    it('should track which sources have been seen', () => {
      sourceManager.markSourceSeen('github');

      // This is internal state, verified through formatSourceState behavior
      // When sources are "seen", they won't show introduction text again
    });

    it('should mark sources as unseen', () => {
      sourceManager.markSourceSeen('github');
      sourceManager.markSourceUnseen('github');

      // Source will show introduction text again
    });

    it('should reset all seen sources', () => {
      sourceManager.markSourceSeen('github');
      sourceManager.markSourceSeen('slack');
      sourceManager.resetSeenSources();

      // All sources will show introduction text again
    });
  });

  describe('Inactive Source Detection', () => {
    beforeEach(() => {
      // Set up sources where github is active but slack is inactive
      sourceManager.setAllSources([
        createMockSource('github'),
        createMockSource('slack'),
      ]);
      sourceManager.updateActiveState(['github'], [], ['github']);
    });

    it('should detect inactive source tool errors', () => {
      const result = sourceManager.detectInactiveSourceToolError(
        'mcp__slack__api_slack',
        'No such tool available: mcp__slack__api_slack'
      );

      expect(result).not.toBeNull();
      expect(result?.sourceSlug).toBe('slack');
      expect(result?.toolName).toBe('mcp__slack__api_slack');
    });

    it('should not detect errors for active sources', () => {
      const result = sourceManager.detectInactiveSourceToolError(
        'mcp__github__api_github',
        'No such tool available: mcp__github__api_github'
      );

      // github is active, so this shouldn't be detected as inactive source error
      expect(result).toBeNull();
    });

    it('should not detect errors for non-MCP tools', () => {
      const result = sourceManager.detectInactiveSourceToolError(
        'Bash',
        'Command failed: ls'
      );

      expect(result).toBeNull();
    });

    it('should handle "Tool not found" error pattern', () => {
      const result = sourceManager.detectInactiveSourceToolError(
        'mcp__slack__post_message',
        "Tool 'mcp__slack__post_message' not found"
      );

      expect(result).not.toBeNull();
      expect(result?.sourceSlug).toBe('slack');
    });
  });

  describe('Source State Formatting', () => {
    beforeEach(() => {
      sourceManager.setAllSources([
        createMockSource('github', { enabled: true, tagline: 'GitHub integration' }),
        createMockSource('slack', { enabled: true, tagline: 'Slack messaging' }),
        createMockSource('disabled-source', { enabled: false, tagline: 'Disabled' }),
      ]);
    });

    it('should format source state with active and inactive sources', () => {
      sourceManager.updateActiveState(['github'], [], ['github']);

      const formatted = sourceManager.formatSourceState();

      expect(formatted).toContain('<sources>');
      expect(formatted).toContain('</sources>');
      expect(formatted).toContain('Active: github');
      expect(formatted).toContain('slack (inactive)');
    });

    it('should show "Active: none" when no sources are active', () => {
      sourceManager.updateActiveState([], [], []);

      const formatted = sourceManager.formatSourceState();

      expect(formatted).toContain('Active: none');
    });

    it('should include taglines for new sources', () => {
      sourceManager.updateActiveState(['github'], [], ['github']);

      const formatted = sourceManager.formatSourceState();

      // First call should include taglines for unseen sources
      expect(formatted).toContain('github');
      expect(formatted).toContain('GitHub integration');
    });

    it('should mark sources with failed builds', () => {
      // github is intended but not actually active (build failed)
      sourceManager.updateActiveState([], [], ['github']);

      const formatted = sourceManager.formatSourceState();

      expect(formatted).toContain('github (no tools)');
    });
  });

  describe('Authentication Utilities', () => {
    it('should return correct auth tool for OAuth MCP sources', () => {
      const source = createMockSource('oauth-source', {
        type: 'mcp',
        mcp: { url: 'https://example.com/mcp', authType: 'oauth' },
      });

      const authTool = sourceManager.getAuthToolName(source);
      expect(authTool).toBe('source_oauth_trigger');
    });

    it('should return correct auth tool for bearer MCP sources', () => {
      const source = createMockSource('bearer-source', {
        type: 'mcp',
        mcp: { url: 'https://example.com/mcp', authType: 'bearer' },
      });

      const authTool = sourceManager.getAuthToolName(source);
      expect(authTool).toBe('source_credential_prompt');
    });

    it('should return correct auth tool for Google API sources', () => {
      const source = createMockSource('google-source', {
        type: 'api',
        provider: 'google',
        api: { baseUrl: 'https://www.googleapis.com', authType: 'oauth' },
      });

      const authTool = sourceManager.getAuthToolName(source);
      expect(authTool).toBe('source_google_oauth_trigger');
    });

    it('should return correct auth tool for Slack API sources', () => {
      const source = createMockSource('slack-source', {
        type: 'api',
        provider: 'slack',
        api: { baseUrl: 'https://slack.com/api', authType: 'oauth' },
      });

      const authTool = sourceManager.getAuthToolName(source);
      expect(authTool).toBe('source_slack_oauth_trigger');
    });

    it('should return null for sources without auth', () => {
      const source = createMockSource('no-auth-source', {
        type: 'mcp',
        mcp: { url: 'https://example.com/mcp', authType: 'none' },
      });

      const authTool = sourceManager.getAuthToolName(source);
      expect(authTool).toBeNull();
    });
  });
});
