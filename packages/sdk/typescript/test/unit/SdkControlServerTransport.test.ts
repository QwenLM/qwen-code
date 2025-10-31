/**
 * Unit tests for SdkControlServerTransport
 *
 * Tests MCP message proxying between MCP Server and Query's control plane.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SdkControlServerTransport } from '../../src/mcp/SdkControlServerTransport.js';

describe('SdkControlServerTransport', () => {
  let sendToQuery: ReturnType<typeof vi.fn>;
  let transport: SdkControlServerTransport;

  beforeEach(() => {
    sendToQuery = vi.fn().mockResolvedValue({ result: 'success' });
    transport = new SdkControlServerTransport({
      serverName: 'test-server',
      sendToQuery,
    });
  });

  describe('Lifecycle', () => {
    it('should start successfully', async () => {
      await transport.start();
      expect(transport.isStarted()).toBe(true);
    });

    it('should close successfully', async () => {
      await transport.start();
      await transport.close();
      expect(transport.isStarted()).toBe(false);
    });

    it('should handle close callback', async () => {
      const onclose = vi.fn();
      transport.onclose = onclose;

      await transport.start();
      await transport.close();

      expect(onclose).toHaveBeenCalled();
    });
  });

  describe('Message Sending', () => {
    it('should send message to Query', async () => {
      await transport.start();

      const message = {
        jsonrpc: '2.0' as const,
        id: 1,
        method: 'tools/list',
        params: {},
      };

      await transport.send(message);

      expect(sendToQuery).toHaveBeenCalledWith(message);
    });

    it('should throw error when sending before start', async () => {
      const message = {
        jsonrpc: '2.0' as const,
        id: 1,
        method: 'tools/list',
      };

      await expect(transport.send(message)).rejects.toThrow('not started');
    });

    it('should handle send errors', async () => {
      const error = new Error('Network error');
      sendToQuery.mockRejectedValue(error);

      const onerror = vi.fn();
      transport.onerror = onerror;

      await transport.start();

      const message = {
        jsonrpc: '2.0' as const,
        id: 1,
        method: 'tools/list',
      };

      await expect(transport.send(message)).rejects.toThrow('Network error');
      expect(onerror).toHaveBeenCalledWith(error);
    });
  });

  describe('Message Receiving', () => {
    it('should deliver message to MCP Server via onmessage', async () => {
      const onmessage = vi.fn();
      transport.onmessage = onmessage;

      await transport.start();

      const message = {
        jsonrpc: '2.0' as const,
        id: 1,
        result: { tools: [] },
      };

      transport.handleMessage(message);

      expect(onmessage).toHaveBeenCalledWith(message);
    });

    it('should warn when receiving message without onmessage handler', async () => {
      const consoleWarnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => {});

      await transport.start();

      const message = {
        jsonrpc: '2.0' as const,
        id: 1,
        result: {},
      };

      transport.handleMessage(message);

      expect(consoleWarnSpy).toHaveBeenCalled();

      consoleWarnSpy.mockRestore();
    });

    it('should warn when receiving message for closed transport', async () => {
      const consoleWarnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => {});
      const onmessage = vi.fn();
      transport.onmessage = onmessage;

      await transport.start();
      await transport.close();

      const message = {
        jsonrpc: '2.0' as const,
        id: 1,
        result: {},
      };

      transport.handleMessage(message);

      expect(consoleWarnSpy).toHaveBeenCalled();
      expect(onmessage).not.toHaveBeenCalled();

      consoleWarnSpy.mockRestore();
    });
  });

  describe('Error Handling', () => {
    it('should deliver error to MCP Server via onerror', async () => {
      const onerror = vi.fn();
      transport.onerror = onerror;

      await transport.start();

      const error = new Error('Test error');
      transport.handleError(error);

      expect(onerror).toHaveBeenCalledWith(error);
    });

    it('should log error when no onerror handler set', async () => {
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      await transport.start();

      const error = new Error('Test error');
      transport.handleError(error);

      expect(consoleErrorSpy).toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });
  });

  describe('Server Name', () => {
    it('should return server name', () => {
      expect(transport.getServerName()).toBe('test-server');
    });
  });

  describe('Bidirectional Communication', () => {
    it('should support full message round-trip', async () => {
      const onmessage = vi.fn();
      transport.onmessage = onmessage;

      await transport.start();

      // Send request from MCP Server to CLI
      const request = {
        jsonrpc: '2.0' as const,
        id: 1,
        method: 'tools/list',
        params: {},
      };

      await transport.send(request);
      expect(sendToQuery).toHaveBeenCalledWith(request);

      // Receive response from CLI to MCP Server
      const response = {
        jsonrpc: '2.0' as const,
        id: 1,
        result: {
          tools: [
            {
              name: 'test_tool',
              description: 'A test tool',
              inputSchema: { type: 'object' },
            },
          ],
        },
      };

      transport.handleMessage(response);
      expect(onmessage).toHaveBeenCalledWith(response);
    });

    it('should handle multiple messages in sequence', async () => {
      const onmessage = vi.fn();
      transport.onmessage = onmessage;

      await transport.start();

      // Send multiple requests
      for (let i = 0; i < 5; i++) {
        const message = {
          jsonrpc: '2.0' as const,
          id: i,
          method: 'test',
        };

        await transport.send(message);
      }

      expect(sendToQuery).toHaveBeenCalledTimes(5);

      // Receive multiple responses
      for (let i = 0; i < 5; i++) {
        const message = {
          jsonrpc: '2.0' as const,
          id: i,
          result: {},
        };

        transport.handleMessage(message);
      }

      expect(onmessage).toHaveBeenCalledTimes(5);
    });
  });
});
