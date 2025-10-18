/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalMode, type Config } from '@qwen-code/qwen-code-core';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { runStreamJsonSession } from './session.js';
import type { StreamJsonWriter } from './writer.js';

const runNonInteractiveMock = vi.fn();
const logUserPromptMock = vi.fn();
const connectToMcpServerMock = vi.fn();

vi.mock('../nonInteractiveCli.js', () => ({
  runNonInteractive: (...args: unknown[]) => runNonInteractiveMock(...args),
}));

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const original = await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...original,
    logUserPrompt: (...args: unknown[]) => logUserPromptMock(...args),
    connectToMcpServer: (...args: unknown[]) => connectToMcpServerMock(...args),
  };
});

function createConfig(): Config {
  const getToolMock = vi.fn().mockReturnValue({});
  const toolRegistryMock = {
    getTool: getToolMock,
    getAllToolNames: vi.fn().mockReturnValue([]),
  };

  const getToolRegistryMock = vi.fn().mockReturnValue(toolRegistryMock);
  const getApprovalModeMock = vi.fn().mockReturnValue(ApprovalMode.AUTO_EDIT);
  const getMcpServersMock = vi.fn().mockReturnValue({ default: {} });
  const workspaceContext = {
    getDirectories: vi.fn().mockReturnValue([process.cwd()]),
    onDirectoriesChanged: vi.fn().mockReturnValue(() => {}),
  };
  const ideClientMock = {
    getDetectedIdeDisplayName: vi.fn().mockReturnValue(''),
    getCurrentIde: vi.fn().mockReturnValue(null),
  };
  const storageMock = {
    getProjectTempCheckpointsDir: vi.fn().mockReturnValue(null),
  };

  return {
    getIncludePartialMessages: () => false,
    getContentGeneratorConfig: () => ({ authType: 'test' }),
    getOutputFormat: () => 'stream-json',
    setApprovalMode: vi.fn(),
    setModel: vi.fn().mockResolvedValue(undefined),
    getApprovalMode: getApprovalModeMock,
    getToolRegistry: getToolRegistryMock,
    getMcpServers: getMcpServersMock,
    getDebugMode: () => false,
    getWorkspaceContext: () => workspaceContext,
    getIdeClient: () => ideClientMock,
    getIdeMode: () => false,
    getCheckpointingEnabled: () => false,
    storage: storageMock,
  } as unknown as Config;
}

function createWriter() {
  const writeEnvelope = vi.fn();
  return {
    emitResult: vi.fn(),
    writeEnvelope,
    emitSystemMessage: vi
      .fn<(subtype: string, data?: unknown) => void>()
      .mockImplementation((subtype, data) => {
        writeEnvelope({
          type: 'system',
          subtype,
          session_id: 'test-session',
          data,
        });
      }),
  } as unknown as StreamJsonWriter;
}

describe('runStreamJsonSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('processes initial prompt before reading stream', async () => {
    const config = createConfig();
    const writer = createWriter();
    const stream = Readable.from([]);
    runNonInteractiveMock.mockResolvedValueOnce(undefined);

    await runStreamJsonSession(config, 'Hello world', {
      input: stream,
      writer,
    });

    expect(runNonInteractiveMock).toHaveBeenCalledTimes(1);
    expect(runNonInteractiveMock).toHaveBeenCalledWith(
      config,
      'Hello world',
      expect.any(String),
      expect.objectContaining({
        streamJson: expect.objectContaining({ writer }),
        abortController: expect.any(AbortController),
      }),
    );
    expect(logUserPromptMock).toHaveBeenCalledTimes(1);
  });

  it('processes user envelope even when prompt is empty', async () => {
    const config = createConfig();
    const writer = createWriter();
    const stream = Readable.from([
      JSON.stringify({
        type: 'user',
        message: { content: '' },
        parent_tool_use_id: 'tool-parent-1',
      }) + '\n',
    ]);
    runNonInteractiveMock.mockResolvedValueOnce(undefined);

    await runStreamJsonSession(config, undefined, {
      input: stream,
      writer,
    });

    expect(runNonInteractiveMock).toHaveBeenCalledWith(
      config,
      '',
      expect.any(String),
      expect.objectContaining({
        userEnvelope: expect.objectContaining({
          parent_tool_use_id: 'tool-parent-1',
        }),
      }),
    );
    expect(logUserPromptMock).not.toHaveBeenCalled();
  });

  it('responds to initialize control request and handles user message', async () => {
    const config = createConfig();
    const writer = createWriter();
    const lines = [
      JSON.stringify({
        type: 'control_request',
        request_id: 'req-1',
        request: { subtype: 'initialize' },
      }) + '\n',
      JSON.stringify({
        type: 'user',
        message: { content: 'Second prompt' },
      }) + '\n',
    ];
    const stream = Readable.from(lines);
    runNonInteractiveMock.mockResolvedValueOnce(undefined);

    await runStreamJsonSession(config, undefined, {
      input: stream,
      writer,
    });

    expect(writer.writeEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'control_response',
        request_id: 'req-1',
        success: true,
        response: expect.objectContaining({
          capabilities: expect.objectContaining({
            can_handle_can_use_tool: true,
            can_handle_hook_callback: true,
            can_handle_mcp_message: true,
          }),
        }),
      }),
    );
    expect(writer.writeEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'system',
        subtype: 'init',
      }),
    );
    expect(runNonInteractiveMock).toHaveBeenCalledTimes(1);
    expect(runNonInteractiveMock).toHaveBeenCalledWith(
      config,
      'Second prompt',
      expect.any(String),
      expect.objectContaining({
        streamJson: expect.objectContaining({ writer }),
        abortController: expect.any(AbortController),
        userEnvelope: expect.objectContaining({
          type: 'user',
        }),
      }),
    );
  });

  it('supports multiple sequential user prompts in persistent session', async () => {
    const config = createConfig();
    const writer = createWriter();
    const lines = [
      JSON.stringify({
        type: 'user',
        message: { content: 'first request' },
      }) + '\n',
      JSON.stringify({
        type: 'user',
        message: { content: 'second request' },
      }) + '\n',
    ];
    const stream = Readable.from(lines);
    runNonInteractiveMock.mockResolvedValue(undefined);

    await runStreamJsonSession(config, undefined, {
      input: stream,
      writer,
    });

    expect(runNonInteractiveMock).toHaveBeenCalledTimes(2);
    expect(runNonInteractiveMock.mock.calls[0][1]).toBe('first request');
    expect(runNonInteractiveMock.mock.calls[1][1]).toBe('second request');
  });

  it('honours interrupt control request and stops session', async () => {
    const config = createConfig();
    const writer = createWriter();
    const lines = [
      JSON.stringify({
        type: 'control_request',
        request_id: 'req-interrupt',
        request: { subtype: 'interrupt' },
      }) + '\n',
      JSON.stringify({
        type: 'user',
        message: { content: 'should not run' },
      }) + '\n',
    ];
    const stream = Readable.from(lines);

    await runStreamJsonSession(config, undefined, {
      input: stream,
      writer,
    });

    expect(writer.writeEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'control_response',
        request_id: 'req-interrupt',
        success: true,
      }),
    );
    expect(runNonInteractiveMock).not.toHaveBeenCalled();
  });

  it('emits error result when JSON parsing fails', async () => {
    const config = createConfig();
    const writer = createWriter();
    const stream = Readable.from(['{invalid json']);

    await runStreamJsonSession(config, undefined, {
      input: stream,
      writer,
    });

    expect(writer.emitResult).toHaveBeenCalledWith(
      expect.objectContaining({
        isError: true,
      }),
    );
    expect(runNonInteractiveMock).not.toHaveBeenCalled();
  });

  it('updates approval mode when receiving set_permission_mode', async () => {
    const config = createConfig();
    const writer = createWriter();
    const stream = Readable.from([
      JSON.stringify({
        type: 'control_request',
        request_id: 'req-permission',
        request: { subtype: 'set_permission_mode', mode: 'auto-edit' },
      }) + '\n',
    ]);

    await runStreamJsonSession(config, undefined, {
      input: stream,
      writer,
    });

    expect(config.setApprovalMode).toHaveBeenCalledWith(
      ApprovalMode.AUTO_EDIT,
    );
    expect(writer.writeEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'control_response',
        request_id: 'req-permission',
        success: true,
      }),
    );
  });

  it('invokes config.setModel for set_model requests', async () => {
    const config = createConfig();
    const writer = createWriter();
    const stream = Readable.from([
      JSON.stringify({
        type: 'control_request',
        request_id: 'req-model',
        request: { subtype: 'set_model', model: 'new-model' },
      }) + '\n',
    ]);

    await runStreamJsonSession(config, undefined, {
      input: stream,
      writer,
    });

    expect(config.setModel).toHaveBeenCalledWith('new-model');
    expect(writer.writeEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'control_response',
        request_id: 'req-model',
        success: true,
      }),
    );
  });

  it('handles can_use_tool requests using approval mode', async () => {
    const config = createConfig();
    const writer = createWriter();
    const stream = Readable.from([
      JSON.stringify({
        type: 'control_request',
        request_id: 'req-tool',
        request: { subtype: 'can_use_tool', tool_name: 'edit' },
      }) + '\n',
    ]);

    await runStreamJsonSession(config, undefined, {
      input: stream,
      writer,
    });

    expect(writer.writeEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'control_response',
        request_id: 'req-tool',
        success: true,
        response: expect.objectContaining({
          behavior: 'allow',
        }),
      }),
    );
  });

  it('denies can_use_tool when approval mode is manual', async () => {
    const config = createConfig();
    (config.getApprovalMode as unknown as vi.Mock).mockReturnValue(
      ApprovalMode.DEFAULT,
    );
    const writer = createWriter();
    const stream = Readable.from([
      JSON.stringify({
        type: 'control_request',
        request_id: 'req-tool',
        request: { subtype: 'can_use_tool', tool_name: 'edit' },
      }) + '\n',
    ]);

    await runStreamJsonSession(config, undefined, {
      input: stream,
      writer,
    });

    expect(writer.writeEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'control_response',
        request_id: 'req-tool',
        success: true,
        response: expect.objectContaining({
          behavior: 'deny',
        }),
      }),
    );
  });

  it('handles hook_callback requests with default continue decision', async () => {
    const config = createConfig();
    const writer = createWriter();
    const initializeLine = JSON.stringify({
      type: 'control_request',
      request_id: 'req-init',
      request: {
        subtype: 'initialize',
        hooks: {
          pre_tool: [
            {
              matcher: null,
              hookCallbackIds: ['hook-1'],
            },
          ],
        },
      },
    });
    const hookCallLine = JSON.stringify({
      type: 'control_request',
      request_id: 'req-hook',
      request: { subtype: 'hook_callback', callback_id: 'hook-1' },
    });
    const stream = Readable.from([`${initializeLine}\n`, `${hookCallLine}\n`]);

    await runStreamJsonSession(config, undefined, {
      input: stream,
      writer,
    });

    expect(writer.writeEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'control_response',
        request_id: 'req-hook',
        success: true,
        response: expect.objectContaining({
          decision: 'continue',
        }),
      }),
    );
  });

  it('returns descriptive error for unknown MCP server requests', async () => {
    const config = createConfig();
    const writer = createWriter();
    (config.getMcpServers as unknown as vi.Mock).mockReturnValue({});
    const stream = Readable.from([
      JSON.stringify({
        type: 'control_request',
        request_id: 'req-mcp',
        request: { subtype: 'mcp_message', server_name: 'missing', message: {} },
      }) + '\n',
    ]);

    await runStreamJsonSession(config, undefined, {
      input: stream,
      writer,
    });

    expect(writer.writeEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'control_response',
        request_id: 'req-mcp',
        success: false,
        error: expect.objectContaining({
          message: expect.stringContaining('missing'),
        }),
      }),
    );
  });

  it('forwards mcp_message requests to configured MCP server', async () => {
    const config = createConfig();
    const writer = createWriter();
    (config.getMcpServers as unknown as vi.Mock).mockReturnValue({
      default: { command: 'echo' },
    });

    const clientRequest = vi.fn().mockResolvedValue({});
    const clientNotification = vi.fn().mockResolvedValue(undefined);
    const clientClose = vi.fn().mockResolvedValue(undefined);
    connectToMcpServerMock.mockResolvedValueOnce({
      request: clientRequest,
      notification: clientNotification,
      close: clientClose,
      onclose: undefined,
    } as unknown as Client);

    const stream = Readable.from([
      JSON.stringify({
        type: 'control_request',
        request_id: 'req-mcp',
        request: {
          subtype: 'mcp_message',
          server_name: 'default',
          message: {
            jsonrpc: '2.0',
            id: '42',
            method: 'tools/list',
            params: {},
          },
        },
      }) + '\n',
    ]);

    await runStreamJsonSession(config, undefined, {
      input: stream,
      writer,
    });

    expect(connectToMcpServerMock).toHaveBeenCalledWith(
      'default',
      expect.objectContaining({ command: 'echo' }),
      false,
      expect.any(Object),
    );
    expect(clientRequest).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'tools/list', id: '42' }),
      expect.anything(),
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(writer.writeEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'control_response',
        request_id: 'req-mcp',
        success: true,
        response: expect.objectContaining({
          subtype: 'mcp_message',
          mcp_response: expect.objectContaining({
            id: '42',
            result: {},
          }),
        }),
      }),
    );
    expect(clientClose).toHaveBeenCalled();
  });
});
