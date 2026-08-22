/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import type { Config, MCPServerConfig } from '@qwen-code/qwen-code-core';
import { QWEN_CODE_SERVE_ENV } from './acp-channel-fallback.js';
import {
  SHARED_CHROME_BRIDGE_OPT_OUT_ENV,
  cdpWsEndpointFor,
  isAutoConnectChromeDevToolsServer,
  maybeRouteChromeDevToolsViaDaemonBridge,
  probeDaemonCdpStatus,
  rewriteToWsEndpoint,
  type CdpStatusResponse,
} from './shared-chrome-bridge.js';

const AUTO_CONNECT_SERVER: MCPServerConfig = {
  command: 'npx',
  args: ['-y', 'chrome-devtools-mcp@latest', '--autoConnect'],
};

describe('isAutoConnectChromeDevToolsServer', () => {
  it('matches the canonical chrome-devtools --autoConnect config', () => {
    expect(
      isAutoConnectChromeDevToolsServer('chrome-devtools', AUTO_CONNECT_SERVER),
    ).toBe(true);
  });

  it('matches by adapter command name under other server names', () => {
    expect(
      isAutoConnectChromeDevToolsServer('my-chrome', {
        command: '/usr/local/bin/chrome-devtools-mcp',
        args: ['--autoConnect'],
      }),
    ).toBe(true);
  });

  it('matches an npx-wrapped adapter under another server name', () => {
    expect(
      isAutoConnectChromeDevToolsServer('my-chrome', AUTO_CONNECT_SERVER),
    ).toBe(true);
  });

  it('ignores servers without --autoConnect', () => {
    expect(
      isAutoConnectChromeDevToolsServer('chrome-devtools', {
        command: 'npx',
        args: ['-y', 'chrome-devtools-mcp@latest'],
      }),
    ).toBe(false);
  });

  it('ignores servers already pinned to a --wsEndpoint', () => {
    expect(
      isAutoConnectChromeDevToolsServer('chrome-devtools', {
        command: 'npx',
        args: ['--autoConnect', '--wsEndpoint', 'ws://127.0.0.1:9222/dev'],
      }),
    ).toBe(false);
  });

  it('ignores servers pinned via the --wsEndpoint= equals form', () => {
    expect(
      isAutoConnectChromeDevToolsServer('chrome-devtools', {
        command: 'npx',
        args: ['--autoConnect', '--wsEndpoint=ws://127.0.0.1:9222/dev'],
      }),
    ).toBe(false);
  });

  it('ignores servers pinned to a --browserUrl', () => {
    expect(
      isAutoConnectChromeDevToolsServer('chrome-devtools', {
        command: 'npx',
        args: ['--autoConnect', '--browserUrl', 'http://127.0.0.1:9222'],
      }),
    ).toBe(false);
    expect(
      isAutoConnectChromeDevToolsServer('chrome-devtools', {
        command: 'npx',
        args: ['--autoConnect', '--browserUrl=http://127.0.0.1:9222'],
      }),
    ).toBe(false);
  });

  it.each([
    ['--ws-endpoint', 'ws://127.0.0.1:9222/dev'],
    ['--ws-endpoint=ws://127.0.0.1:9222/dev'],
    ['--browser-url', 'http://127.0.0.1:9222'],
    ['--browser-url=http://127.0.0.1:9222'],
    ['-w', 'ws://127.0.0.1:9222/dev'],
    ['-u', 'http://127.0.0.1:9222'],
  ])('ignores servers pinned with adapter alias %s', (...endpointArgs) => {
    expect(
      isAutoConnectChromeDevToolsServer('chrome-devtools', {
        command: 'npx',
        args: ['--autoConnect', ...endpointArgs],
      }),
    ).toBe(false);
  });

  it('ignores unrelated stdio servers', () => {
    expect(
      isAutoConnectChromeDevToolsServer('filesystem', {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem'],
      }),
    ).toBe(false);
  });

  it('ignores adapter-name substrings in unrelated commands and packages', () => {
    expect(
      isAutoConnectChromeDevToolsServer('recorder', {
        command: 'chrome-devtools-mcp-recorder',
        args: ['--autoConnect'],
      }),
    ).toBe(false);
    expect(
      isAutoConnectChromeDevToolsServer('fork', {
        command: 'npx',
        args: ['my-chrome-devtools-mcp-fork', '--autoConnect'],
      }),
    ).toBe(false);
  });

  it('ignores non-stdio servers', () => {
    expect(
      isAutoConnectChromeDevToolsServer('chrome-devtools', {
        url: 'http://127.0.0.1:9222',
      } as MCPServerConfig),
    ).toBe(false);
  });
});

describe('rewriteToWsEndpoint', () => {
  it('drops --autoConnect and appends the tunnel endpoint', () => {
    expect(
      rewriteToWsEndpoint(
        ['-y', 'chrome-devtools-mcp@latest', '--autoConnect'],
        'ws://127.0.0.1:4170/cdp',
      ),
    ).toEqual([
      '-y',
      'chrome-devtools-mcp@latest',
      '--wsEndpoint',
      'ws://127.0.0.1:4170/cdp',
    ]);
  });

  it('replaces an existing two-token --wsEndpoint', () => {
    expect(
      rewriteToWsEndpoint(
        ['--autoConnect', '--wsEndpoint', 'ws://old:1/x', '--headless'],
        'ws://127.0.0.1:4170/cdp',
      ),
    ).toEqual(['--headless', '--wsEndpoint', 'ws://127.0.0.1:4170/cdp']);
  });

  it('replaces an existing --wsEndpoint= form', () => {
    expect(
      rewriteToWsEndpoint(
        ['--autoConnect', '--wsEndpoint=ws://old:1/x'],
        'ws://127.0.0.1:4170/cdp',
      ),
    ).toEqual(['--wsEndpoint', 'ws://127.0.0.1:4170/cdp']);
  });
});

describe('cdpWsEndpointFor', () => {
  it('derives the ws endpoint from the default daemon URL', () => {
    expect(cdpWsEndpointFor({})).toBe('ws://127.0.0.1:4170/cdp');
  });

  it('honors QWEN_DAEMON_URL and trims trailing slashes', () => {
    expect(
      cdpWsEndpointFor({ QWEN_DAEMON_URL: 'http://127.0.0.1:5999/' }),
    ).toBe('ws://127.0.0.1:5999/cdp');
  });

  it('normalizes an uppercase HTTPS daemon URL', () => {
    expect(cdpWsEndpointFor({ QWEN_DAEMON_URL: 'HTTPS://daemon:4170' })).toBe(
      'wss://daemon:4170/cdp',
    );
  });
});

function statusResponse(status: number, body: CdpStatusResponse): typeof fetch {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe('probeDaemonCdpStatus', () => {
  it('returns the parsed status from the daemon', async () => {
    const body: CdpStatusResponse = {
      enabled: true,
      bridgeConnected: true,
      multiClient: true,
      linkCount: 0,
      usable: true,
    };
    const status = await probeDaemonCdpStatus({}, statusResponse(200, body));
    expect(status).toEqual(body);
  });

  it('returns undefined on non-200', async () => {
    const status = await probeDaemonCdpStatus(
      {},
      statusResponse(401, { enabled: true }),
    );
    expect(status).toBeUndefined();
  });

  it('returns undefined when the daemon is unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    expect(await probeDaemonCdpStatus({}, fetchImpl)).toBeUndefined();
  });

  it('probes QWEN_DAEMON_URL when set', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ usable: true }),
    })) as unknown as typeof fetch;
    await probeDaemonCdpStatus(
      { QWEN_DAEMON_URL: 'http://127.0.0.1:5999' },
      fetchImpl,
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:5999/cdp/status',
      expect.anything(),
    );
  });
});

function configStub(servers: Record<string, MCPServerConfig>): {
  config: Config;
  setMcpServers: ReturnType<typeof vi.fn>;
} {
  const setMcpServers = vi.fn();
  const config = {
    getMcpServers: () => servers,
    getSettingsMcpServers: () => servers,
    isSafeMode: () => false,
    getBareMode: () => false,
    setMcpServers,
  } as unknown as Config;
  return { config, setMcpServers };
}

const USABLE: CdpStatusResponse = {
  enabled: true,
  bridgeConnected: true,
  multiClient: true,
  linkCount: 0,
  usable: true,
};

describe('maybeRouteChromeDevToolsViaDaemonBridge', () => {
  it('does not reroute daemon-owned ACP children', async () => {
    const { config, setMcpServers } = configStub({
      'chrome-devtools': AUTO_CONNECT_SERVER,
    });
    const fetchImpl = vi.fn();

    await maybeRouteChromeDevToolsViaDaemonBridge(
      config,
      { [QWEN_CODE_SERVE_ENV]: '1' },
      () => {},
      fetchImpl,
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(setMcpServers).not.toHaveBeenCalled();
  });

  it('applies the rewrite when the probe reports a usable bridge', async () => {
    const numericArgServer = {
      command: 'node',
      args: ['server.js', '--port', 9222],
    } as unknown as MCPServerConfig;
    const { config, setMcpServers } = configStub({
      'chrome-devtools': AUTO_CONNECT_SERVER,
      filesystem: numericArgServer,
    });

    await maybeRouteChromeDevToolsViaDaemonBridge(
      config,
      {},
      () => {},
      statusResponse(200, USABLE),
    );

    expect(setMcpServers).toHaveBeenCalledTimes(1);
    const next = setMcpServers.mock.calls[0]?.[0] as Record<
      string,
      MCPServerConfig
    >;
    expect(next['chrome-devtools']).toEqual({
      command: 'npx',
      args: [
        '-y',
        'chrome-devtools-mcp@latest',
        '--wsEndpoint',
        'ws://127.0.0.1:4170/cdp',
      ],
    });
    // Unrelated servers pass through untouched.
    expect(next['filesystem']).toBe(numericArgServer);
  });

  it('leaves approval-gated server configs literal', async () => {
    const { config, setMcpServers } = configStub({
      'chrome-devtools': { ...AUTO_CONNECT_SERVER, scope: 'project' },
    });
    const fetchImpl = vi.fn();

    await maybeRouteChromeDevToolsViaDaemonBridge(
      config,
      {},
      () => {},
      fetchImpl,
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(setMcpServers).not.toHaveBeenCalled();
  });

  it('preserves settings servers hidden by the allow-list', async () => {
    const settingsServers = {
      'chrome-devtools': AUTO_CONNECT_SERVER,
      filesystem: { command: 'npx', args: ['-y', 'some-fs-server'] },
    };
    const setMcpServers = vi.fn();
    const config = {
      getMcpServers: () => ({
        'chrome-devtools': AUTO_CONNECT_SERVER,
      }),
      getSettingsMcpServers: () => settingsServers,
      isSafeMode: () => false,
      getBareMode: () => false,
      setMcpServers,
    } as unknown as Config;

    await maybeRouteChromeDevToolsViaDaemonBridge(
      config,
      {},
      () => {},
      statusResponse(200, USABLE),
    );

    expect(setMcpServers.mock.calls[0]?.[0]).toMatchObject({
      filesystem: settingsServers.filesystem,
    });
  });

  it('keeps the user config when the bridge is not usable', async () => {
    const { config, setMcpServers } = configStub({
      'chrome-devtools': AUTO_CONNECT_SERVER,
    });
    await maybeRouteChromeDevToolsViaDaemonBridge(
      config,
      {},
      () => {},
      statusResponse(200, { ...USABLE, usable: false }),
    );
    expect(setMcpServers).not.toHaveBeenCalled();
  });

  it('does not reroute MCP servers in safe mode', async () => {
    const { config, setMcpServers } = configStub({
      'chrome-devtools': AUTO_CONNECT_SERVER,
    });
    vi.spyOn(config, 'isSafeMode').mockReturnValue(true);
    const fetchImpl = vi.fn();

    await maybeRouteChromeDevToolsViaDaemonBridge(
      config,
      {},
      () => {},
      fetchImpl as unknown as typeof fetch,
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(setMcpServers).not.toHaveBeenCalled();
  });

  it('does not reroute MCP servers in bare mode', async () => {
    const { config, setMcpServers } = configStub({
      'chrome-devtools': AUTO_CONNECT_SERVER,
    });
    vi.spyOn(config, 'getBareMode').mockReturnValue(true);
    const fetchImpl = vi.fn();

    await maybeRouteChromeDevToolsViaDaemonBridge(
      config,
      {},
      () => {},
      fetchImpl as unknown as typeof fetch,
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(setMcpServers).not.toHaveBeenCalled();
  });

  it('hints at the shared bridge when a candidate exists but no usable bridge', async () => {
    const { config } = configStub({ 'chrome-devtools': AUTO_CONNECT_SERVER });
    const log = vi.fn();
    await maybeRouteChromeDevToolsViaDaemonBridge(
      config,
      {},
      log,
      statusResponse(200, { ...USABLE, usable: false }),
    );
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain('no usable shared Chrome bridge');
    expect(log.mock.calls[0]?.[0]).toContain('qwen serve');
    expect(log.mock.calls[0]?.[0]).toContain(SHARED_CHROME_BRIDGE_OPT_OUT_ENV);
  });

  it('fails open when reroute setup throws', async () => {
    const log = vi.fn();
    const config = {
      getSettingsMcpServers: () => {
        throw new Error('settings unavailable');
      },
      isSafeMode: () => false,
      getBareMode: () => false,
      setMcpServers: vi.fn(),
    } as unknown as Config;

    await maybeRouteChromeDevToolsViaDaemonBridge(
      config,
      {},
      log,
      vi.fn() as unknown as typeof fetch,
    );

    expect(config.setMcpServers).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      'qwen: shared Chrome bridge reroute skipped: settings unavailable',
    );
  });

  it('stays silent when the probe fails without any candidate', async () => {
    const { config } = configStub({
      filesystem: { command: 'npx', args: ['-y', 'some-fs-server'] },
    });
    const log = vi.fn();
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await maybeRouteChromeDevToolsViaDaemonBridge(config, {}, log, fetchImpl);
    expect(log).not.toHaveBeenCalled();
  });

  it('keeps the user config when the probe fails', async () => {
    const { config, setMcpServers } = configStub({
      'chrome-devtools': AUTO_CONNECT_SERVER,
    });
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await maybeRouteChromeDevToolsViaDaemonBridge(
      config,
      {},
      () => {},
      fetchImpl,
    );
    expect(setMcpServers).not.toHaveBeenCalled();
  });

  it('skips entirely on QWEN_NO_SHARED_CHROME_BRIDGE', async () => {
    const { config, setMcpServers } = configStub({
      'chrome-devtools': AUTO_CONNECT_SERVER,
    });
    const fetchImpl = vi.fn();
    await maybeRouteChromeDevToolsViaDaemonBridge(
      config,
      { [SHARED_CHROME_BRIDGE_OPT_OUT_ENV]: '1' },
      () => {},
      fetchImpl as unknown as typeof fetch,
    );
    expect(setMcpServers).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not probe when no chrome-devtools --autoConnect server exists', async () => {
    const { config, setMcpServers } = configStub({
      filesystem: { command: 'npx', args: ['-y', 'some-fs-server'] },
    });
    const fetchImpl = vi.fn();
    await maybeRouteChromeDevToolsViaDaemonBridge(
      config,
      {},
      () => {},
      fetchImpl as unknown as typeof fetch,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(setMcpServers).not.toHaveBeenCalled();
  });
});
