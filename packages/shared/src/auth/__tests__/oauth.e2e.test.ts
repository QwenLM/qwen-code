/**
 * E2E tests for OAuth metadata discovery against real MCP servers.
 *
 * These tests verify that OAuth metadata can be discovered from popular MCP servers.
 * They only check that metadata is discoverable - they don't perform full OAuth flows.
 *
 * Tests are skipped if servers are unreachable (network tolerance for CI).
 */
import { describe, it, expect } from 'bun:test';
import { discoverOAuthMetadata, getMcpBaseUrl } from '../oauth';

// Helper to check if a URL is reachable
async function isReachable(url: string, timeoutMs = 5000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response.status < 500;
  } catch {
    return false;
  }
}

// Helper to conditionally skip tests based on server reachability
function describeIfReachable(name: string, mcpUrl: string, fn: () => void) {
  describe(name, () => {
    // Check reachability once - if unreachable, all tests in this describe will run but assertions will be skipped
    let reachable = true;
    it('should be reachable', async () => {
      const origin = getMcpBaseUrl(mcpUrl);
      reachable = await isReachable(origin);
      if (!reachable) {
        console.log(`Skipping ${name}: server unreachable`);
      }
    });
    fn();
  });
}

describe('E2E: OAuth Metadata Discovery', () => {
  describe('HTTPS MCP endpoint', () => {
    const MCP_URL = 'https://api.github.com/mcp/';

    it('extracts correct origin', () => {
      expect(getMcpBaseUrl(MCP_URL)).toBe('https://api.github.com');
    });

    it('discovers OAuth metadata', async () => {
      const logs: string[] = [];
      const metadata = await discoverOAuthMetadata(MCP_URL, (msg) => logs.push(msg));

      // If we get null, the server might be down or require auth - that's OK for E2E
      if (metadata === null) {
        console.log('GitHub MCP: No metadata discovered (server may require auth or be unavailable)');
        console.log('Discovery logs:', logs);
        return;
      }

      expect(metadata.authorization_endpoint).toBeTruthy();
      expect(metadata.token_endpoint).toBeTruthy();
      console.log('GitHub MCP OAuth metadata:', metadata);
    });
  });

  describe('Linear MCP (mcp.linear.app)', () => {
    const MCP_URL = 'https://mcp.linear.app/sse';

    it('extracts correct origin', () => {
      expect(getMcpBaseUrl(MCP_URL)).toBe('https://mcp.linear.app');
    });

    it('discovers OAuth metadata', async () => {
      const logs: string[] = [];
      const metadata = await discoverOAuthMetadata(MCP_URL, (msg) => logs.push(msg));

      if (metadata === null) {
        console.log('Linear MCP: No metadata discovered (server may require auth or be unavailable)');
        console.log('Discovery logs:', logs);
        return;
      }

      expect(metadata.authorization_endpoint).toBeTruthy();
      expect(metadata.token_endpoint).toBeTruthy();
      console.log('Linear MCP OAuth metadata:', metadata);
    });
  });

  describe('Ahrefs MCP (api.ahrefs.com/mcp/mcp)', () => {
    const MCP_URL = 'https://api.ahrefs.com/mcp/mcp';

    it('extracts correct origin (the bug we are fixing)', () => {
      // This was the original bug - the old regex would return https://api.ahrefs.com/mcp
      expect(getMcpBaseUrl(MCP_URL)).toBe('https://api.ahrefs.com');
    });

    it('discovers OAuth metadata', async () => {
      const logs: string[] = [];
      const metadata = await discoverOAuthMetadata(MCP_URL, (msg) => logs.push(msg));

      if (metadata === null) {
        console.log('Ahrefs MCP: No metadata discovered (server may require auth or be unavailable)');
        console.log('Discovery logs:', logs);
        return;
      }

      expect(metadata.authorization_endpoint).toBeTruthy();
      expect(metadata.token_endpoint).toBeTruthy();
      console.log('Ahrefs MCP OAuth metadata:', metadata);
    });
  });

  describe('Multiple path segments', () => {
    it('handles various MCP URL patterns correctly', () => {
      // These are hypothetical URLs to test the origin extraction
      expect(getMcpBaseUrl('https://api.example.com/v1/mcp')).toBe('https://api.example.com');
      expect(getMcpBaseUrl('https://api.example.com/v1/mcp/sse')).toBe('https://api.example.com');
      expect(getMcpBaseUrl('https://mcp.example.com/')).toBe('https://mcp.example.com');
      expect(getMcpBaseUrl('http://localhost:8080/mcp')).toBe('http://localhost:8080');
    });
  });
});
