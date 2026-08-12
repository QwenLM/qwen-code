import { describe, expect, it } from 'vitest';
import { getMcpAppDisplay, resolveMcpAppSandboxUrl } from './McpApp';

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

  it('rejects non-loopback hosts', () => {
    expect(
      resolveMcpAppSandboxUrl(
        'https://daemon.example.com',
        'https://host.example.com',
      ),
    ).toBeUndefined();
  });
});
