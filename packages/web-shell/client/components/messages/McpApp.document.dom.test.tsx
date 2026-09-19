// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ThemeProvider, WebShellThemeId } from '../../themeContext';

const bridgeConstructed = vi.hoisted(() => vi.fn());
vi.mock('@modelcontextprotocol/ext-apps/app-bridge', () => ({
  AppBridge: class AppBridge {
    constructor() {
      bridgeConstructed();
      throw new Error('A read-only document must not construct an MCP bridge');
    }
  },
  PostMessageTransport: class PostMessageTransport {
    constructor() {
      throw new Error(
        'A read-only document must not construct an MCP transport',
      );
    }
  },
}));

import { McpApp, type McpAppDisplay } from './McpApp';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  bridgeConstructed.mockClear();
});

describe('MCP App document fallback', () => {
  it('renders recorded text without constructing a bridge when no daemon URL is provided', async () => {
    const display: McpAppDisplay = {
      type: 'mcp_app',
      serverName: 'document-fixture',
      resourceUri: 'ui://document/fixture',
      html: '<main>Interactive content</main>',
      toolResult: { content: [] },
      toolArguments: {},
      fallbackText: 'Recorded MCP result',
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <ThemeProvider value={WebShellThemeId.Dark}>
          <McpApp display={display} />
        </ThemeProvider>,
      );
    });
    expect(container.textContent).toContain('Recorded MCP result');
    expect(container.querySelector('iframe')).toBeNull();
    expect(bridgeConstructed).not.toHaveBeenCalled();
  });
});
