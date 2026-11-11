/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

import { SdkControlClientTransport } from './sdk-control.js';

describe('SdkControlClientTransport', () => {
  it('forwards send() through sendMcpMessage and routes the response to onmessage', async () => {
    const reply: JSONRPCMessage = {
      jsonrpc: '2.0',
      id: 1,
      result: { ok: true },
    } as JSONRPCMessage;
    const sendMcpMessage = vi.fn().mockResolvedValue(reply);

    const transport = new SdkControlClientTransport('demo', sendMcpMessage);
    await transport.start();

    const onmessage = vi.fn();
    transport.onmessage = onmessage;

    const outbound: JSONRPCMessage = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    } as JSONRPCMessage;
    await transport.send(outbound);

    expect(sendMcpMessage).toHaveBeenCalledWith('demo', outbound);
    expect(onmessage).toHaveBeenCalledWith(reply);
  });

  it('rejects send() and notifies onerror when sendMcpMessage fails', async () => {
    const failure = new Error('SDK unavailable');
    const sendMcpMessage = vi.fn().mockRejectedValue(failure);

    const transport = new SdkControlClientTransport('demo', sendMcpMessage);
    const onerror = vi.fn();
    transport.onerror = onerror;

    await expect(
      transport.send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
      } as JSONRPCMessage),
    ).rejects.toBe(failure);
    expect(onerror).toHaveBeenCalledWith(failure);
  });

  it('close() invokes onclose exactly once and blocks subsequent sends', async () => {
    const sendMcpMessage = vi.fn();
    const transport = new SdkControlClientTransport('demo', sendMcpMessage);
    const onclose = vi.fn();
    transport.onclose = onclose;

    await transport.close();
    await transport.close();
    expect(onclose).toHaveBeenCalledTimes(1);

    await expect(
      transport.send({
        jsonrpc: '2.0',
        id: 1,
        method: 'ping',
      } as JSONRPCMessage),
    ).rejects.toThrow('SdkControlClientTransport is closed');
    expect(sendMcpMessage).not.toHaveBeenCalled();
  });
});
