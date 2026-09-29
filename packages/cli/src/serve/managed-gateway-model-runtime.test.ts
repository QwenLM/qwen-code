/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  FunctionDeclaration,
  GenerateContentResponse,
  Part,
} from '@google/genai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import type {
  ManagedGatewayAgentSink,
  ManagedGatewayToolRuntime,
} from './managed-gateway-model-runtime.js';
import type { ManagedGatewayPromptRequest } from './managed-prompt-types.js';

const mocks = vi.hoisted(() => {
  const generateContentStream = vi.fn();
  const shutdown = vi.fn().mockResolvedValue(undefined);
  const initialize = vi.fn().mockResolvedValue(undefined);
  const gatewayTools = [{ name: 'read_file', description: 'Read a file' }];
  const config = {
    getContentGenerator: () => ({ generateContentStream }),
    getModel: () => 'moonshot/kimi-k3',
    getModelsConfig: () => ({ getCurrentAuthType: () => 'openai' }),
    refreshAuth: vi.fn().mockResolvedValue(undefined),
    initialize,
    setReasoningEffort: vi.fn(),
    getToolRegistry: () => ({
      getFunctionDeclarations: () => gatewayTools,
      getTool: (name: string) =>
        name === 'read_file' ? { kind: 'read' } : undefined,
    }),
    shutdown,
  } as unknown as Config;
  return { config, generateContentStream, initialize, shutdown };
});

vi.mock('../config/settings.js', () => ({
  loadSettings: vi.fn().mockImplementation(() => ({ merged: {} })),
}));

vi.mock('../config/environment.js', () => ({
  buildHostBootstrapEnvironment: (env: Readonly<NodeJS.ProcessEnv>) => env,
  buildRuntimeEnvironment: vi
    .fn()
    .mockImplementation((_settings, _cwd, baseEnvironment) => ({
      effectiveEnv: Object.freeze({ ...baseEnvironment }),
      envFileReadFailed: false,
    })),
}));

vi.mock('../config/config.js', () => ({
  loadCliConfig: vi.fn().mockImplementation(async () => mocks.config),
}));

import { ResidentManagedGatewayModelRunner } from './managed-gateway-model-runtime.js';
import { loadCliConfig } from '../config/config.js';
import { loadSettings } from '../config/settings.js';
import { buildRuntimeEnvironment } from '../config/environment.js';

function toolManifest(tools: FunctionDeclaration[]) {
  return {
    capabilityDigest: createHash('sha256')
      .update(JSON.stringify(tools))
      .digest('hex'),
    tools,
  };
}

function response(parts: Part[]): GenerateContentResponse {
  return {
    candidates: [{ content: { role: 'model', parts }, index: 0 }],
  } as GenerateContentResponse;
}

function stream(...chunks: GenerateContentResponse[]) {
  return (async function* () {
    for (const chunk of chunks) yield chunk;
  })();
}

function request(
  messageId: string,
  turnKind: 'bootstrap' | 'continuation',
  text: string,
): ManagedGatewayPromptRequest {
  return {
    mode: 'gateway',
    turnKind,
    tenantId: 'tenant-1',
    workspaceId: 'workspace-1',
    workspaceCwd: '/workspace',
    sessionId: '11111111-1111-1111-1111-111111111111',
    messageId,
    managedClientId: 'client-1',
    prompt: [{ type: 'text', text }],
  };
}

describe('ResidentManagedGatewayModelRunner', () => {
  const roots: string[] = [];

  beforeEach(() => {
    vi.mocked(loadCliConfig).mockClear();
    vi.mocked(loadSettings).mockClear();
    vi.mocked(buildRuntimeEnvironment).mockClear();
    mocks.generateContentStream.mockReset();
    mocks.initialize.mockClear();
    mocks.shutdown.mockClear();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it('keeps the captured host environment when ambient and caller values change', async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), 'qwen-managed-environment-'),
    );
    roots.push(stateDir);
    const baseEnvironment = { MANAGED_HOST_KEY: 'host-value' };
    const runner = new ResidentManagedGatewayModelRunner(
      '/primary/project',
      stateDir,
      baseEnvironment,
    );
    baseEnvironment.MANAGED_HOST_KEY = 'later-value';
    vi.stubEnv('MANAGED_HOST_KEY', 'ambient-value');
    try {
      await runner.start();
      const runtimeEnvironment =
        vi.mocked(loadCliConfig).mock.calls[0]?.[9]?.runtimeEnvironment;
      expect(runtimeEnvironment).toEqual({ MANAGED_HOST_KEY: 'host-value' });
      expect(Object.isFrozen(runtimeEnvironment)).toBe(true);
      for (const call of vi.mocked(buildRuntimeEnvironment).mock.calls) {
        expect(call[1]).toBe(os.homedir());
      }
      expect(loadSettings).toHaveBeenLastCalledWith('/primary/project', {
        consumeCorruptionEnvVars: false,
        skipWorkspaceSettings: true,
        workspaceTrusted: false,
        runtimeEnvironment,
      });
      expect(process.env['MANAGED_HOST_KEY']).toBe('ambient-value');
    } finally {
      await runner.dispose();
    }
  });

  it('owns the model loop, feeds Runtime Tool results back, and restores history', async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), 'qwen-managed-model-'),
    );
    roots.push(stateDir);
    mocks.generateContentStream
      .mockResolvedValueOnce(
        stream(
          response([
            {
              text: 'Need local evidence.',
              thought: true,
              thoughtSignature: 'reasoning-signature-1',
            },
            {
              thoughtSignature: 'tool-signature-1',
              functionCall: {
                id: 'call-1',
                name: 'read_file',
                args: { file_path: 'proof.txt' },
              },
            },
          ]),
        ),
      )
      .mockResolvedValueOnce(stream(response([{ text: 'proof-value' }])))
      .mockResolvedValueOnce(
        stream(response([{ text: 'I remember proof-value' }])),
      );

    const execute = vi.fn().mockResolvedValue({
      responseParts: [
        {
          functionResponse: {
            id: 'call-1',
            name: 'read_file',
            response: { output: 'proof-value' },
          },
        },
      ],
      executionStatus: 'success',
    });
    const runtime: ManagedGatewayToolRuntime = {
      getManifest: vi
        .fn()
        .mockResolvedValue(
          toolManifest([{ name: 'read_file', description: 'Read a file' }]),
        ),
      execute,
    };
    const sink: ManagedGatewayAgentSink = {
      onModelStarted: vi.fn(),
      onThought: vi.fn(),
      onDelta: vi.fn(),
      onToolRequested: vi.fn(),
      onToolCompleted: vi.fn(),
    };
    const runner = new ResidentManagedGatewayModelRunner('/gateway', stateDir);

    await expect(
      runner.runTurn(
        request('message-1', 'bootstrap', 'read proof.txt'),
        runtime,
        sink,
        new AbortController().signal,
      ),
    ).resolves.toBe('proof-value');
    expect(mocks.initialize).toHaveBeenCalledWith({
      skipMcpDiscovery: true,
      skipHooks: true,
      skipSkillManager: true,
      skipFileCheckpointing: true,
      lenientToolWarmup: true,
    });
    expect(sink.onModelStarted).toHaveBeenNthCalledWith(1, {
      round: 0,
      agentDefinitionId: expect.stringMatching(
        /^qwen-managed-readonly-v1:[a-f0-9]{64}$/,
      ),
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: 'message-1',
        toolCallId: 'call-1',
        toolName: 'read_file',
        capabilityDigest: toolManifest([
          { name: 'read_file', description: 'Read a file' },
        ]).capabilityDigest,
      }),
      expect.any(AbortSignal),
    );
    expect(mocks.generateContentStream.mock.calls[1]?.[0].contents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'model',
          parts: expect.arrayContaining([
            expect.objectContaining({
              text: 'Need local evidence.',
              thought: true,
              thoughtSignature: 'reasoning-signature-1',
            }),
            expect.objectContaining({
              thoughtSignature: 'tool-signature-1',
              functionCall: expect.objectContaining({
                id: 'call-1',
                name: 'read_file',
              }),
            }),
          ]),
        }),
      ]),
    );

    const restarted = new ResidentManagedGatewayModelRunner(
      '/gateway',
      stateDir,
    );
    await expect(
      restarted.runTurn(
        request('message-2', 'continuation', 'what was the value?'),
        runtime,
        sink,
        new AbortController().signal,
      ),
    ).resolves.toBe('I remember proof-value');

    const continuationRequest = mocks.generateContentStream.mock.calls[2]?.[0];
    expect(continuationRequest.contents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          parts: [{ text: 'read proof.txt' }],
        }),
        expect.objectContaining({
          role: 'model',
          parts: expect.arrayContaining([
            expect.objectContaining({
              functionCall: expect.objectContaining({ name: 'read_file' }),
            }),
          ]),
        }),
        expect.objectContaining({
          role: 'user',
          parts: [{ text: 'what was the value?' }],
        }),
      ]),
    );
    await runner.dispose();
    await restarted.dispose();
  });

  it('finishes a no-Tool authoritative turn without waiting for Runtime', async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), 'qwen-managed-model-'),
    );
    roots.push(stateDir);
    mocks.generateContentStream.mockResolvedValueOnce(
      stream(response([{ text: 'authoritative answer' }])),
    );
    const getManifest = vi.fn();
    const order: string[] = [];
    const sink: ManagedGatewayAgentSink = {
      onModelStarted: vi.fn(() => {
        order.push('started');
      }),
      onThought: vi.fn(),
      onDelta: vi.fn(() => {
        order.push('delta');
      }),
      onToolRequested: vi.fn(),
      onToolCompleted: vi.fn(),
    };
    const runner = new ResidentManagedGatewayModelRunner('/gateway', stateDir);

    await expect(
      runner.runTurn(
        request('message-no-tool', 'bootstrap', 'say hello'),
        { getManifest, execute: vi.fn() },
        sink,
        new AbortController().signal,
      ),
    ).resolves.toBe('authoritative answer');
    expect(order).toEqual(['started', 'delta']);
    expect(getManifest).not.toHaveBeenCalled();
    await runner.dispose();
  });

  it('does not commit a final answer when the deadline fires as the stream closes', async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), 'qwen-managed-model-'),
    );
    roots.push(stateDir);
    const controller = new AbortController();
    mocks.generateContentStream.mockResolvedValueOnce(
      (async function* () {
        yield response([{ text: 'too late' }]);
        controller.abort(new Error('deadline'));
      })(),
    );
    const sink: ManagedGatewayAgentSink = {
      onModelStarted: vi.fn(),
      onThought: vi.fn(),
      onDelta: vi.fn(),
      onToolRequested: vi.fn(),
      onToolCompleted: vi.fn(),
    };
    const runner = new ResidentManagedGatewayModelRunner('/gateway', stateDir);

    await expect(
      runner.runTurn(
        request('message-deadline', 'bootstrap', 'answer'),
        { getManifest: vi.fn(), execute: vi.fn() },
        sink,
        controller.signal,
      ),
    ).rejects.toThrow('deadline');
    await expect(
      runner.runTurn(
        request('message-follow-up', 'continuation', 'continue'),
        { getManifest: vi.fn(), execute: vi.fn() },
        sink,
        new AbortController().signal,
      ),
    ).rejects.toThrow('no durable conversation history');
    await runner.dispose();
  });

  it('fails a continuation without durable Gateway history', async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), 'qwen-managed-model-'),
    );
    roots.push(stateDir);
    const runner = new ResidentManagedGatewayModelRunner('/gateway', stateDir);
    const runtime: ManagedGatewayToolRuntime = {
      getManifest: vi.fn().mockResolvedValue(toolManifest([])),
      execute: vi.fn(),
    };

    await expect(
      runner.runTurn(
        request('message-1', 'continuation', 'continue'),
        runtime,
        {
          onModelStarted: vi.fn(),
          onThought: vi.fn(),
          onDelta: vi.fn(),
          onToolRequested: vi.fn(),
          onToolCompleted: vi.fn(),
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('no durable conversation history');
    expect(mocks.generateContentStream).not.toHaveBeenCalled();
    await runner.dispose();
  });

  it('fails closed when the Runtime returns a different Tool Call identity', async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), 'qwen-managed-model-'),
    );
    roots.push(stateDir);
    mocks.generateContentStream.mockResolvedValueOnce(
      stream(
        response([
          {
            functionCall: {
              id: 'call-expected',
              name: 'read_file',
              args: { file_path: 'proof.txt' },
            },
          },
        ]),
      ),
    );
    const runner = new ResidentManagedGatewayModelRunner('/gateway', stateDir);

    await expect(
      runner.runTurn(
        request('message-1', 'bootstrap', 'read proof.txt'),
        {
          getManifest: vi.fn().mockResolvedValue({
            ...toolManifest([
              { name: 'read_file', description: 'Read a file' },
            ]),
          }),
          execute: vi.fn().mockResolvedValue({
            responseParts: [
              {
                functionResponse: {
                  id: 'call-wrong',
                  name: 'read_file',
                  response: { output: 'untrusted' },
                },
              },
            ],
            executionStatus: 'success',
          }),
        },
        {
          onModelStarted: vi.fn(),
          onThought: vi.fn(),
          onDelta: vi.fn(),
          onToolRequested: vi.fn(),
          onToolCompleted: vi.fn(),
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('mismatched Tool result');
    expect(mocks.generateContentStream).toHaveBeenCalledOnce();
    await runner.dispose();
  });

  it('rejects a manifest digest that does not bind its declarations', async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), 'qwen-managed-model-'),
    );
    roots.push(stateDir);
    mocks.generateContentStream.mockResolvedValueOnce(
      stream(
        response([
          {
            functionCall: {
              id: 'call-expected',
              name: 'read_file',
              args: { file_path: 'proof.txt' },
            },
          },
        ]),
      ),
    );
    const runner = new ResidentManagedGatewayModelRunner('/gateway', stateDir);

    await expect(
      runner.runTurn(
        request('message-1', 'bootstrap', 'read proof.txt'),
        {
          getManifest: vi.fn().mockResolvedValue({
            capabilityDigest: 'a'.repeat(64),
            tools: [{ name: 'read_file', description: 'Read a file' }],
          }),
          execute: vi.fn(),
        },
        {
          onModelStarted: vi.fn(),
          onThought: vi.fn(),
          onDelta: vi.fn(),
          onToolRequested: vi.fn(),
          onToolCompleted: vi.fn(),
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('invalid Tool manifest');
    expect(mocks.generateContentStream).toHaveBeenCalledOnce();
    await runner.dispose();
  });

  it('rejects a Runtime schema incompatible with the Agent Definition', async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), 'qwen-managed-model-'),
    );
    roots.push(stateDir);
    mocks.generateContentStream.mockResolvedValueOnce(
      stream(
        response([
          {
            functionCall: {
              id: 'call-expected',
              name: 'read_file',
              args: { file_path: 'proof.txt' },
            },
          },
        ]),
      ),
    );
    const execute = vi.fn();
    const runner = new ResidentManagedGatewayModelRunner('/gateway', stateDir);

    await expect(
      runner.runTurn(
        request('message-1', 'bootstrap', 'read proof.txt'),
        {
          getManifest: vi.fn().mockResolvedValue(
            toolManifest([
              {
                name: 'read_file',
                description: 'Read a file',
                parameters: { required: ['different'] },
              },
            ]),
          ),
          execute,
        },
        {
          onModelStarted: vi.fn(),
          onThought: vi.fn(),
          onDelta: vi.fn(),
          onToolRequested: vi.fn(),
          onToolCompleted: vi.fn(),
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('incompatible with Agent Definition');
    expect(execute).not.toHaveBeenCalled();
    await runner.dispose();
  });

  it('rejects more than one Runtime function response for one Tool Call', async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), 'qwen-managed-model-'),
    );
    roots.push(stateDir);
    mocks.generateContentStream.mockResolvedValueOnce(
      stream(
        response([
          {
            functionCall: {
              id: 'call-expected',
              name: 'read_file',
              args: { file_path: 'proof.txt' },
            },
          },
        ]),
      ),
    );
    const runner = new ResidentManagedGatewayModelRunner('/gateway', stateDir);

    await expect(
      runner.runTurn(
        request('message-1', 'bootstrap', 'read proof.txt'),
        {
          getManifest: vi
            .fn()
            .mockResolvedValue(toolManifest([{ name: 'read_file' }])),
          execute: vi.fn().mockResolvedValue({
            responseParts: [
              {
                functionResponse: {
                  id: 'call-expected',
                  name: 'read_file',
                  response: { output: 'trusted' },
                },
              },
              {
                functionResponse: {
                  id: 'call-other',
                  name: 'read_file',
                  response: { output: 'untrusted' },
                },
              },
            ],
            executionStatus: 'success',
          }),
        },
        {
          onModelStarted: vi.fn(),
          onThought: vi.fn(),
          onDelta: vi.fn(),
          onToolRequested: vi.fn(),
          onToolCompleted: vi.fn(),
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('invalid Tool result');
    await runner.dispose();
  });

  it('rejects a Tool Call id reused across model rounds', async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), 'qwen-managed-model-'),
    );
    roots.push(stateDir);
    const repeatedCall = response([
      {
        functionCall: {
          id: 'call-reused',
          name: 'read_file',
          args: { file_path: 'proof.txt' },
        },
      },
    ]);
    mocks.generateContentStream
      .mockResolvedValueOnce(stream(repeatedCall))
      .mockResolvedValueOnce(stream(repeatedCall));
    const execute = vi.fn().mockResolvedValue({
      responseParts: [
        {
          functionResponse: {
            id: 'call-reused',
            name: 'read_file',
            response: { output: 'trusted' },
          },
        },
      ],
      executionStatus: 'success',
    });
    const runner = new ResidentManagedGatewayModelRunner('/gateway', stateDir);

    await expect(
      runner.runTurn(
        request('message-1', 'bootstrap', 'read proof.txt'),
        {
          getManifest: vi
            .fn()
            .mockResolvedValue(toolManifest([{ name: 'read_file' }])),
          execute,
        },
        {
          onModelStarted: vi.fn(),
          onThought: vi.fn(),
          onDelta: vi.fn(),
          onToolRequested: vi.fn(),
          onToolCompleted: vi.fn(),
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("reused Tool Call id 'call-reused' across rounds");
    expect(execute).toHaveBeenCalledOnce();
    await runner.dispose();
  });
});
