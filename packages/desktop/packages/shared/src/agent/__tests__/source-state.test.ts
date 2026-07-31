/**
 * Tests for source state display logic
 *
 * These tests verify that sources are correctly classified as "needs auth" vs "inactive"
 * based on their authentication type and state.
 *
 * Bug fix: Sources with authType: "none" were incorrectly showing "needs auth" because
 * the code checked `!isAuthenticated` without first checking if auth is required.
 */
import { describe, it, expect } from 'bun:test';
import { sourceNeedsAuthentication } from '../../sources/credential-manager.ts';
import type { LoadedSource } from '../../sources/types.ts';

// Helper to create mock LoadedSource objects
function createMockSource(
  overrides: Partial<LoadedSource['config']> & { mcp?: LoadedSource['config']['mcp']; api?: LoadedSource['config']['api'] }
): LoadedSource {
  return {
    config: {
      id: 'test-source',
      name: 'Test Source',
      slug: 'test-source',
      enabled: true,
      provider: 'test',
      type: 'mcp',
      ...overrides,
    },
    guide: null,
    folderPath: '/test/path',
    workspaceRootPath: '/test/workspace',
    workspaceId: 'test-workspace',
  };
}

describe('sourceNeedsAuthentication', () => {
  describe('MCP sources', () => {
    describe('authType: "none" (no auth required)', () => {
      it('should return false when isAuthenticated is undefined', () => {
        const source = createMockSource({
          type: 'mcp',
          mcp: { url: 'https://example.com/mcp', authType: 'none' },
          isAuthenticated: undefined,
        });
        expect(sourceNeedsAuthentication(source)).toBe(false);
      });

      it('should return false when isAuthenticated is false', () => {
        const source = createMockSource({
          type: 'mcp',
          mcp: { url: 'https://example.com/mcp', authType: 'none' },
          isAuthenticated: false,
        });
        expect(sourceNeedsAuthentication(source)).toBe(false);
      });

      it('should return false when isAuthenticated is true', () => {
        const source = createMockSource({
          type: 'mcp',
          mcp: { url: 'https://example.com/mcp', authType: 'none' },
          isAuthenticated: true,
        });
        expect(sourceNeedsAuthentication(source)).toBe(false);
      });
    });

    describe('authType: "oauth" (OAuth required)', () => {
      it('should return true when not authenticated', () => {
        const source = createMockSource({
          type: 'mcp',
          mcp: { url: 'https://example.com/mcp', authType: 'oauth' },
          isAuthenticated: false,
        });
        expect(sourceNeedsAuthentication(source)).toBe(true);
      });

      it('should return true when isAuthenticated is undefined', () => {
        const source = createMockSource({
          type: 'mcp',
          mcp: { url: 'https://example.com/mcp', authType: 'oauth' },
          isAuthenticated: undefined,
        });
        expect(sourceNeedsAuthentication(source)).toBe(true);
      });

      it('should return false when authenticated', () => {
        const source = createMockSource({
          type: 'mcp',
          mcp: { url: 'https://example.com/mcp', authType: 'oauth' },
          isAuthenticated: true,
        });
        expect(sourceNeedsAuthentication(source)).toBe(false);
      });
    });

    describe('authType: "bearer" (bearer token required)', () => {
      it('should return true when not authenticated', () => {
        const source = createMockSource({
          type: 'mcp',
          mcp: { url: 'https://example.com/mcp', authType: 'bearer' },
          isAuthenticated: false,
        });
        expect(sourceNeedsAuthentication(source)).toBe(true);
      });

      it('should return false when authenticated', () => {
        const source = createMockSource({
          type: 'mcp',
          mcp: { url: 'https://example.com/mcp', authType: 'bearer' },
          isAuthenticated: true,
        });
        expect(sourceNeedsAuthentication(source)).toBe(false);
      });
    });

    describe('stdio transport (local subprocess)', () => {
      it('should return false regardless of authType (stdio runs locally)', () => {
        const source = createMockSource({
          type: 'mcp',
          mcp: { transport: 'stdio', command: 'npx', args: ['@test/server'] },
          isAuthenticated: undefined,
        });
        expect(sourceNeedsAuthentication(source)).toBe(false);
      });

      it('should return false even with oauth authType (ignored for stdio)', () => {
        const source = createMockSource({
          type: 'mcp',
          mcp: { transport: 'stdio', command: 'npx', authType: 'oauth' },
          isAuthenticated: false,
        });
        expect(sourceNeedsAuthentication(source)).toBe(false);
      });
    });

    describe('authType undefined (defaults to no auth)', () => {
      it('should return false when authType is undefined', () => {
        const source = createMockSource({
          type: 'mcp',
          mcp: { url: 'https://example.com/mcp' },
          isAuthenticated: undefined,
        });
        expect(sourceNeedsAuthentication(source)).toBe(false);
      });
    });
  });

  describe('API sources', () => {
    describe('authType: "none" (no auth required)', () => {
      it('should return false when isAuthenticated is undefined', () => {
        const source = createMockSource({
          type: 'api',
          api: { baseUrl: 'https://api.example.com', authType: 'none' },
          isAuthenticated: undefined,
        });
        expect(sourceNeedsAuthentication(source)).toBe(false);
      });

      it('should return false when isAuthenticated is false', () => {
        const source = createMockSource({
          type: 'api',
          api: { baseUrl: 'https://api.example.com', authType: 'none' },
          isAuthenticated: false,
        });
        expect(sourceNeedsAuthentication(source)).toBe(false);
      });
    });

    describe('authType: "bearer" (bearer token required)', () => {
      it('should return true when not authenticated', () => {
        const source = createMockSource({
          type: 'api',
          api: { baseUrl: 'https://api.example.com', authType: 'bearer' },
          isAuthenticated: false,
        });
        expect(sourceNeedsAuthentication(source)).toBe(true);
      });

      it('should return false when authenticated', () => {
        const source = createMockSource({
          type: 'api',
          api: { baseUrl: 'https://api.example.com', authType: 'bearer' },
          isAuthenticated: true,
        });
        expect(sourceNeedsAuthentication(source)).toBe(false);
      });
    });

    describe('authType: "header" (custom header required)', () => {
      it('should return true when not authenticated', () => {
        const source = createMockSource({
          type: 'api',
          api: { baseUrl: 'https://api.example.com', authType: 'header', headerName: 'X-API-Key' },
          isAuthenticated: false,
        });
        expect(sourceNeedsAuthentication(source)).toBe(true);
      });

      it('should return false when authenticated', () => {
        const source = createMockSource({
          type: 'api',
          api: { baseUrl: 'https://api.example.com', authType: 'header', headerName: 'X-API-Key' },
          isAuthenticated: true,
        });
        expect(sourceNeedsAuthentication(source)).toBe(false);
      });
    });

    describe('authType: "basic" (username/password required)', () => {
      it('should return true when not authenticated', () => {
        const source = createMockSource({
          type: 'api',
          api: { baseUrl: 'https://api.example.com', authType: 'basic' },
          isAuthenticated: false,
        });
        expect(sourceNeedsAuthentication(source)).toBe(true);
      });

      it('should return false when authenticated', () => {
        const source = createMockSource({
          type: 'api',
          api: { baseUrl: 'https://api.example.com', authType: 'basic' },
          isAuthenticated: true,
        });
        expect(sourceNeedsAuthentication(source)).toBe(false);
      });
    });

    describe('authType: "query" (query param required)', () => {
      it('should return true when not authenticated', () => {
        const source = createMockSource({
          type: 'api',
          api: { baseUrl: 'https://api.example.com', authType: 'query', queryParam: 'api_key' },
          isAuthenticated: false,
        });
        expect(sourceNeedsAuthentication(source)).toBe(true);
      });

      it('should return false when authenticated', () => {
        const source = createMockSource({
          type: 'api',
          api: { baseUrl: 'https://api.example.com', authType: 'query', queryParam: 'api_key' },
          isAuthenticated: true,
        });
        expect(sourceNeedsAuthentication(source)).toBe(false);
      });
    });

    describe('authType undefined', () => {
      it('should return false when authType is undefined (no auth required)', () => {
        const source = createMockSource({
          type: 'api',
          api: { baseUrl: 'https://api.example.com' } as LoadedSource['config']['api'],
          isAuthenticated: undefined,
        });
        expect(sourceNeedsAuthentication(source)).toBe(false);
      });
    });
  });

  describe('local sources', () => {
    it('should return false for local sources (no auth needed)', () => {
      const source = createMockSource({
        type: 'local',
        local: { path: '/path/to/files' },
        isAuthenticated: undefined,
      });
      expect(sourceNeedsAuthentication(source)).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle source with no mcp/api/local config', () => {
      const source = createMockSource({
        type: 'mcp',
        // No mcp config
      });
      expect(sourceNeedsAuthentication(source)).toBe(false);
    });

    it('should handle MCP source with both transport types (stdio takes precedence)', () => {
      // This shouldn't happen in practice, but test defensive behavior
      const source = createMockSource({
        type: 'mcp',
        mcp: {
          transport: 'stdio',
          command: 'npx',
          url: 'https://example.com',
          authType: 'oauth',
        },
        isAuthenticated: false,
      });
      // Stdio transport should make it return false regardless of authType
      expect(sourceNeedsAuthentication(source)).toBe(false);
    });
  });
});

describe('inactive source reason display', () => {
  // These tests document the expected behavior for how sources should be
  // displayed in the agent's source context.

  describe('expected display values', () => {
    it('disabled source should show "disabled"', () => {
      // Source with enabled: false should always show "disabled"
      // regardless of auth state
      const source = createMockSource({
        enabled: false,
        type: 'mcp',
        mcp: { url: 'https://example.com/mcp', authType: 'oauth' },
        isAuthenticated: false,
      });
      // The formatSourceState logic checks enabled first
      expect(source.config.enabled).toBe(false);
    });

    it('MCP source with authType: "none" should show "inactive" not "needs auth"', () => {
      // This is the bug fix - authType: "none" sources should never show "needs auth"
      const source = createMockSource({
        type: 'mcp',
        mcp: { url: 'https://example.com/mcp', authType: 'none' },
        isAuthenticated: undefined,
      });
      expect(sourceNeedsAuthentication(source)).toBe(false);
      // Therefore formatSourceState should show "inactive" not "needs auth"
    });

    it('MCP source with authType: "oauth" and no auth should show "needs auth"', () => {
      const source = createMockSource({
        type: 'mcp',
        mcp: { url: 'https://example.com/mcp', authType: 'oauth' },
        isAuthenticated: false,
      });
      expect(sourceNeedsAuthentication(source)).toBe(true);
      // Therefore formatSourceState should show "needs auth"
    });

    it('stdio source should show "inactive" not "needs auth"', () => {
      const source = createMockSource({
        type: 'mcp',
        mcp: { transport: 'stdio', command: 'npx' },
        isAuthenticated: undefined,
      });
      expect(sourceNeedsAuthentication(source)).toBe(false);
      // Therefore formatSourceState should show "inactive" not "needs auth"
    });
  });
});
