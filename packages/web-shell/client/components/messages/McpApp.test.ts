import { describe, expect, it } from 'vitest';
import {
  applySandboxCspQuery,
  getMcpAppDisplay,
  resolveMcpAppSandboxUrl,
} from './McpApp';

describe('MCP App host helpers', () => {
  it('recognizes a complete app display', () => {
    expect(
      getMcpAppDisplay({
        type: 'mcp_app',
        serverName: 'demo',
        resourceUri: 'ui://demo/app',
        html: '<main>Demo</main>',
        toolResult: { content: [] },
        toolArguments: {},
        fallbackText: 'Demo result',
      }),
    ).toMatchObject({ resourceUri: 'ui://demo/app' });
  });

  it('recognizes compacted displays so the host can render fallbackText', () => {
    expect(
      getMcpAppDisplay({
        type: 'mcp_app',
        serverName: 'demo',
        resourceUri: 'ui://demo/app',
        html: '',
        toolResult: {},
        toolArguments: {},
        fallbackText: 'Demo result',
      }),
    ).toMatchObject({ fallbackText: 'Demo result', html: '' });
  });

  it('uses the daemon origin and swaps the hostname when needed', () => {
    expect(
      resolveMcpAppSandboxUrl(
        'http://127.0.0.1:4170',
        'http://127.0.0.1:4170/session/demo',
      ),
    ).toBe(
      'http://localhost:4170/mcp-app-sandbox?hostOrigin=http%3A%2F%2F127.0.0.1%3A4170',
    );
  });

  it('swaps [::1] onto localhost so IPv6-only binds stay reachable', () => {
    expect(
      resolveMcpAppSandboxUrl(
        'http://[::1]:4170',
        'http://[::1]:4170/session/demo',
      ),
    ).toBe(
      'http://localhost:4170/mcp-app-sandbox?hostOrigin=http%3A%2F%2F%5B%3A%3A1%5D%3A4170',
    );
  });

  it('aliases a cross-origin [::1] daemon onto localhost for CSP', () => {
    expect(
      resolveMcpAppSandboxUrl(
        'http://[::1]:4170',
        'http://localhost:4170/session/demo',
      ),
    ).toBe(
      'http://localhost:4170/mcp-app-sandbox?hostOrigin=http%3A%2F%2Flocalhost%3A4170',
    );
  });

  it('keeps a localhost sandbox on localhost instead of guessing 127.0.0.1', () => {
    expect(
      resolveMcpAppSandboxUrl(
        'http://localhost:4170',
        'http://localhost:4170/session/demo',
      ),
    ).toBe(
      'http://localhost:4170/mcp-app-sandbox?hostOrigin=http%3A%2F%2Flocalhost%3A4170',
    );
  });

  it('keeps MCP App sandboxes available on the complete IPv4 loopback range', () => {
    expect(
      resolveMcpAppSandboxUrl(
        'http://127.0.0.2:4170',
        'http://127.0.0.2:4170/session/demo',
      ),
    ).toBe(
      'http://127.0.0.2:4170/mcp-app-sandbox?hostOrigin=http%3A%2F%2F127.0.0.2%3A4170',
    );
  });

  it('omits CSP from the sandbox URL when it would overflow the request line', () => {
    const sandboxUrl =
      'http://localhost:4170/mcp-app-sandbox?hostOrigin=http%3A%2F%2F127.0.0.1%3A4170';
    expect(applySandboxCspQuery(sandboxUrl, '{"connectDomains":[]}')).toContain(
      'csp=',
    );
    expect(applySandboxCspQuery(sandboxUrl, 'x'.repeat(8193))).toBe(sandboxUrl);
    const encodedOverflow = JSON.stringify({
      connectDomains: Array(680).fill('https://a'),
    });
    expect(encodedOverflow.length).toBeLessThan(8192);
    const encodedUrl = new URL(sandboxUrl);
    encodedUrl.searchParams.set('csp', encodedOverflow);
    expect(
      encodedUrl.pathname.length + encodedUrl.search.length,
    ).toBeGreaterThan(16 * 1024);
    expect(applySandboxCspQuery(sandboxUrl, encodedOverflow)).toBe(sandboxUrl);
  });

  it('rejects non-loopback hosts', () => {
    expect(
      resolveMcpAppSandboxUrl(
        'https://daemon.example.com',
        'https://host.example.com',
      ),
    ).toBeUndefined();
  });
});
