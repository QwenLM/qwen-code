/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { PassThrough, Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../config/settings.js';
import { runStreamJsonSession } from './session.js';
import { StreamJsonController } from './controller.js';
import { StreamJsonWriter } from './writer.js';

const runNonInteractiveMock = vi.fn();
const logUserPromptMock = vi.fn();

vi.mock('../nonInteractiveCli.js', () => ({
  runNonInteractive: (...args: unknown[]) => runNonInteractiveMock(...args),
}));

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    logUserPrompt: (...args: unknown[]) => logUserPromptMock(...args),
  };
});

interface ConfigOverrides {
  getIncludePartialMessages?: () => boolean;
  getSessionId?: () => string;
  getModel?: () => string;
  getContentGeneratorConfig?: () => { authType?: string };
  [key: string]: unknown;
}

function createConfig(overrides: ConfigOverrides = {}): Config {
  const base = {
    getIncludePartialMessages: () => false,
    getSessionId: () => 'session-test',
    getModel: () => 'model-test',
    getContentGeneratorConfig: () => ({ authType: 'test-auth' }),
    getOutputFormat: () => 'stream-json',
  };
  return { ...base, ...overrides } as unknown as Config;
}

function createSettings(): LoadedSettings {
  return {
    merged: {
      security: { auth: {} },
    },
  } as unknown as LoadedSettings;
}

function createWriter() {
  return {
    emitResult: vi.fn(),
    writeEnvelope: vi.fn(),
    emitSystemMessage: vi.fn(),
  } as unknown as StreamJsonWriter;
}

describe('runStreamJsonSession', () => {
  let settings: LoadedSettings;

  beforeEach(() => {
    settings = createSettings();
    runNonInteractiveMock.mockReset();
    logUserPromptMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs initial prompt before reading stream and logs it', async () => {
    const config = createConfig();
    const writer = createWriter();
    const stream = Readable.from([]);
    runNonInteractiveMock.mockResolvedValueOnce(undefined);

    await runStreamJsonSession(config, settings, 'Hello world', {
      input: stream,
      writer,
    });

    expect(runNonInteractiveMock).toHaveBeenCalledTimes(1);
    const call = runNonInteractiveMock.mock.calls[0];
    expect(call[0]).toBe(config);
    expect(call[1]).toBe(settings);
    expect(call[2]).toBe('Hello world');
    expect(typeof call[3]).toBe('string');
    expect(call[4]).toEqual(
      expect.objectContaining({
        streamJson: expect.objectContaining({ writer }),
        abortController: expect.any(AbortController),
      }),
    );
    expect(logUserPromptMock).toHaveBeenCalledTimes(1);
    const loggedPrompt = logUserPromptMock.mock.calls[0][1] as
      | Record<string, unknown>
      | undefined;
    expect(loggedPrompt).toMatchObject({
      prompt: 'Hello world',
      prompt_length: 11,
    });
    expect(loggedPrompt?.['prompt_id']).toBe(call[3]);
  });

  it('handles user envelope when no initial prompt is provided', async () => {
    const config = createConfig();
    const writer = createWriter();
    const envelope = {
      type: 'user' as const,
      message: {
        content: '   Stream mode ready   ',
      },
    };
    const stream = Readable.from([`${JSON.stringify(envelope)}\n`]);
    runNonInteractiveMock.mockResolvedValueOnce(undefined);

    await runStreamJsonSession(config, settings, undefined, {
      input: stream,
      writer,
    });

    expect(runNonInteractiveMock).toHaveBeenCalledTimes(1);
    const call = runNonInteractiveMock.mock.calls[0];
    expect(call[2]).toBe('Stream mode ready');
    expect(call[4]).toEqual(
      expect.objectContaining({
        userEnvelope: envelope,
        streamJson: expect.objectContaining({ writer }),
        abortController: expect.any(AbortController),
      }),
    );
  });

  it('processes multiple user messages sequentially', async () => {
    const config = createConfig();
    const writer = createWriter();
    const lines = [
      JSON.stringify({
        type: 'user',
        message: { content: 'first request' },
      }),
      JSON.stringify({
        type: 'user',
        message: { content: 'second request' },
      }),
    ].map((line) => `${line}\n`);
    const stream = Readable.from(lines);
    runNonInteractiveMock.mockResolvedValue(undefined);

    await runStreamJsonSession(config, settings, undefined, {
      input: stream,
      writer,
    });

    expect(runNonInteractiveMock).toHaveBeenCalledTimes(2);
    expect(runNonInteractiveMock.mock.calls[0][2]).toBe('first request');
    expect(runNonInteractiveMock.mock.calls[1][2]).toBe('second request');
  });

  it('emits stream_event when partial messages are enabled', async () => {
    const config = createConfig({
      getIncludePartialMessages: () => true,
      getSessionId: () => 'partial-session',
      getModel: () => 'partial-model',
    });
    const stream = Readable.from([
      `${JSON.stringify({
        type: 'user',
        message: { content: 'show partial' },
      })}\n`,
    ]);
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    runNonInteractiveMock.mockImplementationOnce(
      async (
        _config,
        _settings,
        _prompt,
        _promptId,
        options?: {
          streamJson?: { writer?: StreamJsonWriter };
        },
      ) => {
        const builder = options?.streamJson?.writer?.createAssistantBuilder();
        builder?.appendText('partial');
        builder?.finalize();
      },
    );

    await runStreamJsonSession(config, settings, undefined, {
      input: stream,
    });

    const outputs = writeSpy.mock.calls
      .map(([chunk]) => chunk as string)
      .join('')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));

    expect(outputs.some((envelope) => envelope.type === 'stream_event')).toBe(
      true,
    );
    writeSpy.mockRestore();
  });

  it('emits error result when JSON parsing fails', async () => {
    const config = createConfig();
    const writer = createWriter();
    const stream = Readable.from(['{invalid json\n']);

    await runStreamJsonSession(config, settings, undefined, {
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

  it('delegates control requests to the controller', async () => {
    const config = createConfig();
    const writer = new StreamJsonWriter(config, false);
    const controllerPrototype = StreamJsonController.prototype as unknown as {
      handleIncomingControlRequest: (...args: unknown[]) => unknown;
    };
    const handleSpy = vi.spyOn(
      controllerPrototype,
      'handleIncomingControlRequest',
    );

    const inputStream = new PassThrough();
    const controlRequest = {
      type: 'control_request',
      request_id: 'req-1',
      request: { subtype: 'initialize' },
    };

    inputStream.end(`${JSON.stringify(controlRequest)}\n`);

    await runStreamJsonSession(config, settings, undefined, {
      input: inputStream,
      writer,
    });

    expect(handleSpy).toHaveBeenCalledTimes(1);
    const firstCall = handleSpy.mock.calls[0] as unknown[] | undefined;
    expect(firstCall?.[1]).toMatchObject(controlRequest);
  });
});
