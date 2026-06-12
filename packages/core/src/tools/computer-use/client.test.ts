import { describe, it, expect, vi } from 'vitest';
import { ComputerUseClient, isTransportClosedError } from './client.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

describe('ComputerUseClient', () => {
  it('is constructible', () => {
    const client = new ComputerUseClient({
      binary: '/fake/cua-driver',
      onProgress: vi.fn(),
    });
    expect(client).toBeDefined();
  });

  it('reports not-started before start() is called', () => {
    const client = new ComputerUseClient({
      binary: '/fake/cua-driver',
      onProgress: vi.fn(),
    });
    expect(client.isStarted()).toBe(false);
  });

  it('returns the same instance for repeated callers via singleton', () => {
    const a = ComputerUseClient.shared();
    const b = ComputerUseClient.shared();
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// isTransportClosedError unit tests
// ---------------------------------------------------------------------------
describe('isTransportClosedError', () => {
  it('matches "Connection closed" (StdioClientTransport stream closed)', () => {
    expect(isTransportClosedError(new Error('Connection closed'))).toBe(true);
  });

  it('matches SDK JSON-RPC wrapping: "MCP error -32000: Connection closed"', () => {
    expect(
      isTransportClosedError(new Error('MCP error -32000: Connection closed')),
    ).toBe(true);
  });

  it('matches "Not connected" (Client guard before transport is open)', () => {
    expect(isTransportClosedError(new Error('Not connected'))).toBe(true);
  });

  it('matches the daemon-restart error (Screen Recording grant → daemon restart)', () => {
    // The first-use failure mode: after granting Screen Recording, macOS
    // restarts the CuaDriver daemon; the proxy → daemon Unix socket dies.
    expect(
      isTransportClosedError(
        new Error(
          'MCP error -32603: daemon transport error forwarding `list_windows`: connect to /Users/x/Library/Caches/cua-driver/cua-driver.sock: Connection refused (os error 61)',
        ),
      ),
    ).toBe(true);
  });

  it('matches a bare "Connection refused" / "os error 61"', () => {
    expect(isTransportClosedError(new Error('Connection refused'))).toBe(true);
    expect(
      isTransportClosedError(new Error('connect failed: os error 61')),
    ).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isTransportClosedError(new Error('connection closed'))).toBe(true);
    expect(isTransportClosedError(new Error('NOT CONNECTED'))).toBe(true);
  });

  it('does NOT match unrelated upstream tool errors', () => {
    expect(isTransportClosedError(new Error('Tool execution failed'))).toBe(
      false,
    );
  });

  it('does NOT match element_index errors', () => {
    expect(
      isTransportClosedError(new Error('element_index out of range')),
    ).toBe(false);
  });

  it('handles non-Error values (string, undefined, plain object)', () => {
    expect(isTransportClosedError('Connection closed')).toBe(true);
    expect(isTransportClosedError('something else')).toBe(false);
    expect(isTransportClosedError(undefined)).toBe(false);
    expect(isTransportClosedError({ code: -32000 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// callTool reconnect path
//
// Strategy: subclass ComputerUseClient and override start(), stop(), and
// callTool() so we can inject fake behaviors without spawning real processes.
// The overridden callTool re-implements the same logic as production, driven
// by a `behaviors` queue so each call can throw or succeed independently.
// ---------------------------------------------------------------------------

type BehaviorFn = () => Promise<CallToolResult>;

/**
 * Test subclass that overrides start/stop/callTool to avoid real process
 * spawning. `behaviors` is a queue: the i-th entry is used on the i-th
 * underlying tool invocation.
 */
class ReconnectTestClient extends ComputerUseClient {
  callCount = 0;
  behaviors: BehaviorFn[] = [];
  stopCalled = 0;
  startCalled = 0;

  override async start(_onProgress?: (message: string) => void): Promise<void> {
    this.startCalled++;
    (this as unknown as { client: object }).client = { __fake: true };
  }

  override async stop(): Promise<void> {
    this.stopCalled++;
    (this as unknown as { client: undefined }).client = undefined;
  }

  override async callTool(
    _name: string,
    _args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    if (!(this as unknown as { client: unknown }).client)
      throw new Error('ComputerUseClient not started');
    try {
      return await this.runNextBehavior();
    } catch (err) {
      if (!isTransportClosedError(err)) throw err;
      await this.stop();
      await this.start();
      if (!(this as unknown as { client: unknown }).client)
        throw new Error('ComputerUseClient reconnect failed');
      return await this.runNextBehavior();
    }
  }

  private async runNextBehavior(): Promise<CallToolResult> {
    const idx = this.callCount++;
    const b = this.behaviors[idx];
    if (!b) throw new Error(`No behavior defined for call index ${idx}`);
    return b();
  }
}

function makeClient(): ReconnectTestClient {
  const c = new ReconnectTestClient({
    binary: '/fake/cua-driver',
  });
  // Pre-seed the started state so callTool guard passes.
  (c as unknown as { client: object }).client = { __fake: true };
  return c;
}

const successResult: CallToolResult = {
  content: [{ type: 'text', text: 'ok' }],
  isError: false,
};

describe('callTool reconnect path', () => {
  it('returns result directly when first call succeeds (no reconnect)', async () => {
    const c = makeClient();
    c.behaviors = [async () => successResult];

    const result = await c.callTool('get_app_state', {});

    expect(result).toBe(successResult);
    expect(c.stopCalled).toBe(0);
    expect(c.startCalled).toBe(0);
    expect(c.callCount).toBe(1);
  });

  it('reconnects and retries on "Connection closed", returns retry result', async () => {
    const c = makeClient();
    c.behaviors = [
      async () => {
        throw new Error('Connection closed');
      },
      async () => successResult,
    ];

    const result = await c.callTool('get_app_state', {});

    expect(result).toBe(successResult);
    expect(c.stopCalled).toBe(1);
    expect(c.startCalled).toBe(1);
    expect(c.callCount).toBe(2);
  });

  it('reconnects on "MCP error -32000: Connection closed" SDK variant', async () => {
    const c = makeClient();
    c.behaviors = [
      async () => {
        throw new Error('MCP error -32000: Connection closed');
      },
      async () => successResult,
    ];

    const result = await c.callTool('take_screenshot', {});

    expect(result).toBe(successResult);
    expect(c.stopCalled).toBe(1);
    expect(c.startCalled).toBe(1);
  });

  it('reconnects on "Not connected" variant', async () => {
    const c = makeClient();
    c.behaviors = [
      async () => {
        throw new Error('Not connected');
      },
      async () => successResult,
    ];

    const result = await c.callTool('click_element', { element_index: 0 });

    expect(result).toBe(successResult);
    expect(c.stopCalled).toBe(1);
    expect(c.startCalled).toBe(1);
  });

  it('reconnects on the daemon-restart "Connection refused" error', async () => {
    const c = makeClient();
    c.behaviors = [
      async () => {
        throw new Error(
          'MCP error -32603: daemon transport error forwarding `list_windows`: connect to /Users/x/Library/Caches/cua-driver/cua-driver.sock: Connection refused (os error 61)',
        );
      },
      async () => successResult,
    ];

    const result = await c.callTool('list_windows', { pid: 717 });

    expect(result).toBe(successResult);
    expect(c.stopCalled).toBe(1);
    expect(c.startCalled).toBe(1);
  });

  it('does NOT reconnect on non-transport errors (e.g. upstream tool validation)', async () => {
    const c = makeClient();
    c.behaviors = [
      async () => {
        throw new Error('Tool execution failed');
      },
    ];

    await expect(c.callTool('get_app_state', {})).rejects.toThrow(
      'Tool execution failed',
    );
    expect(c.stopCalled).toBe(0);
    expect(c.startCalled).toBe(0);
    expect(c.callCount).toBe(1);
  });

  it('does NOT reconnect on element_index errors from upstream', async () => {
    const c = makeClient();
    c.behaviors = [
      async () => {
        throw new Error('element_index out of range');
      },
    ];

    await expect(
      c.callTool('click_element', { element_index: 99 }),
    ).rejects.toThrow('element_index out of range');
    expect(c.stopCalled).toBe(0);
    expect(c.startCalled).toBe(0);
  });

  it('re-throws when retry also fails (no infinite reconnect loop)', async () => {
    const c = makeClient();
    c.behaviors = [
      async () => {
        throw new Error('Connection closed');
      },
      async () => {
        throw new Error('Still failing after reconnect');
      },
    ];

    await expect(c.callTool('get_app_state', {})).rejects.toThrow(
      'Still failing after reconnect',
    );
    // reconnect happened exactly once
    expect(c.stopCalled).toBe(1);
    expect(c.startCalled).toBe(1);
    expect(c.callCount).toBe(2);
  });
});
