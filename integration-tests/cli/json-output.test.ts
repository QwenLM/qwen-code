/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, describe, it, beforeEach, afterEach, vi } from 'vitest';
import {
  CONTAINER_SANDBOX_NO_PROXY,
  fakeServerHostOptions,
  IS_CONTAINER_SANDBOX,
  TestRig,
} from '../test-helper.js';
import {
  startFakeOpenAIServer,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';

describe('JSON output', () => {
  let rig: TestRig;
  let fakeServer: FakeOpenAIServer;

  beforeEach(async () => {
    rig = new TestRig();
    // The spawned CLI routes through any inherited HTTP(S)_PROXY; without a
    // loopback NO_PROXY entry the fake-server POST is tunnelled and these
    // tests hang. Mirrors test-helper.ts:993-995.
    const noProxy = IS_CONTAINER_SANDBOX
      ? CONTAINER_SANDBOX_NO_PROXY
      : '127.0.0.1,localhost';
    vi.stubEnv('NO_PROXY', noProxy);
    vi.stubEnv('no_proxy', noProxy);
    fakeServer = await startFakeOpenAIServer(
      ({ body }) =>
        body['stream'] === true
          ? { contentChunks: ['Par', 'is'] }
          : { content: '{"selected_memories":[]}' },
      fakeServerHostOptions(),
    );
    await rig.setup('json-output-test');
  });

  afterEach(async () => {
    await fakeServer?.close();
    vi.unstubAllEnvs();
    await rig.cleanup();
  });

  const fakeModelArgs = () => [
    '--auth-type',
    'openai',
    '--model',
    'fake-model',
    '--openai-base-url',
    fakeServer.baseUrl,
    '--openai-api-key',
    'fake-key',
  ];

  it('should return a valid JSON array with result message containing response and stats', async () => {
    const result = await rig.run(
      'What is the capital of France?',
      '--output-format',
      'json',
      ...fakeModelArgs(),
    );
    const parsed = JSON.parse(result);

    // The output should be an array of messages
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);

    // Find the result message (should be the last message)
    const resultMessage = parsed.find(
      (msg: unknown) =>
        typeof msg === 'object' &&
        msg !== null &&
        'type' in msg &&
        msg.type === 'result',
    );

    expect(resultMessage).toBeDefined();
    expect(resultMessage).toHaveProperty('is_error');
    expect(resultMessage.is_error).toBe(false);
    expect(resultMessage).toHaveProperty('result');
    expect(typeof resultMessage.result).toBe('string');
    expect(resultMessage.result.toLowerCase()).toContain('paris');

    // Stats may be present if available
    if ('stats' in resultMessage) {
      expect(typeof resultMessage.stats).toBe('object');
    }
  });

  it('should return line-delimited JSON messages for stream-json output format', async () => {
    const result = await rig.run(
      'What is the capital of France?',
      '--output-format',
      'stream-json',
      ...fakeModelArgs(),
    );

    // Stream-json output is line-delimited JSON (one JSON object per line)
    const lines = result
      .trim()
      .split('\n')
      .filter((line) => line.trim());
    expect(lines.length).toBeGreaterThan(0);

    // Parse each line as a JSON object
    const messages: unknown[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        messages.push(parsed);
      } catch (parseError) {
        throw new Error(
          `Failed to parse JSON line: ${line}. Error: ${parseError}`,
        );
      }
    }

    // Should have at least system, assistant, and result messages
    expect(messages.length).toBeGreaterThanOrEqual(3);

    // Find system message
    const systemMessage = messages.find(
      (msg: unknown) =>
        typeof msg === 'object' &&
        msg !== null &&
        'type' in msg &&
        msg.type === 'system',
    );
    expect(systemMessage).toBeDefined();
    expect(systemMessage).toHaveProperty('subtype');
    expect(systemMessage).toHaveProperty('session_id');

    // Find assistant message
    const assistantMessage = messages.find(
      (msg: unknown) =>
        typeof msg === 'object' &&
        msg !== null &&
        'type' in msg &&
        msg.type === 'assistant',
    );
    expect(assistantMessage).toBeDefined();
    expect(assistantMessage).toHaveProperty('message');
    expect(assistantMessage).toHaveProperty('session_id');

    // Find result message (should be the last message)
    const resultMessage = messages[messages.length - 1] as {
      type: string;
      is_error: boolean;
      result: string;
    };
    expect(resultMessage).toBeDefined();
    expect(
      typeof resultMessage === 'object' &&
        resultMessage !== null &&
        'type' in resultMessage &&
        resultMessage.type === 'result',
    ).toBe(true);
    expect(resultMessage).toHaveProperty('is_error');
    expect(resultMessage.is_error).toBe(false);
    expect(resultMessage).toHaveProperty('result');
    expect(typeof resultMessage.result).toBe('string');
    expect(resultMessage.result.toLowerCase()).toContain('paris');
  });

  it('should include stream events when using stream-json with include-partial-messages', async () => {
    const result = await rig.run(
      'What is the capital of France?',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      ...fakeModelArgs(),
    );

    // Stream-json output is line-delimited JSON (one JSON object per line)
    const lines = result
      .trim()
      .split('\n')
      .filter((line) => line.trim());
    expect(lines.length).toBeGreaterThan(0);

    // Parse each line as a JSON object
    const messages: unknown[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        messages.push(parsed);
      } catch (parseError) {
        throw new Error(
          `Failed to parse JSON line: ${line}. Error: ${parseError}`,
        );
      }
    }

    // Should have more messages than without include-partial-messages
    // because we're including stream events
    expect(messages.length).toBeGreaterThan(3);

    // Find stream_event messages
    const streamEvents = messages.filter(
      (msg: unknown) =>
        typeof msg === 'object' &&
        msg !== null &&
        'type' in msg &&
        msg.type === 'stream_event',
    );
    expect(streamEvents.length).toBeGreaterThan(0);

    // Verify stream event structure
    const firstStreamEvent = streamEvents[0];
    expect(firstStreamEvent).toHaveProperty('event');
    expect(firstStreamEvent).toHaveProperty('session_id');
    expect(firstStreamEvent).toHaveProperty('uuid');

    // Check for expected stream event types
    const eventTypes = streamEvents.map((event: unknown) =>
      typeof event === 'object' &&
      event !== null &&
      'event' in event &&
      typeof event.event === 'object' &&
      event.event !== null &&
      'type' in event.event
        ? event.event.type
        : null,
    );

    // Should have message_start event
    expect(eventTypes).toContain('message_start');

    // Should have content_block_start event
    expect(eventTypes).toContain('content_block_start');

    // Should have content_block_delta events
    expect(eventTypes).toContain('content_block_delta');

    // Should have content_block_stop event
    expect(eventTypes).toContain('content_block_stop');

    // Should have message_stop event
    expect(eventTypes).toContain('message_stop');

    // Verify that we still have the complete assistant message
    const assistantMessage = messages.find(
      (msg: unknown) =>
        typeof msg === 'object' &&
        msg !== null &&
        'type' in msg &&
        msg.type === 'assistant',
    );
    expect(assistantMessage).toBeDefined();
    expect(assistantMessage).toHaveProperty('message');

    // Verify that we still have the result message
    const resultMessage = messages[messages.length - 1] as {
      type: string;
      is_error: boolean;
      result: string;
    };
    expect(resultMessage).toBeDefined();
    expect(
      typeof resultMessage === 'object' &&
        resultMessage !== null &&
        'type' in resultMessage &&
        resultMessage.type === 'result',
    ).toBe(true);
    expect(resultMessage).toHaveProperty('is_error');
    expect(resultMessage.is_error).toBe(false);
    expect(resultMessage).toHaveProperty('result');
    expect(resultMessage.result.toLowerCase()).toContain('paris');
  });

  it('should return a JSON error for enforced auth mismatch before running', async () => {
    await rig.setup('json-output-auth-mismatch', {
      settings: {
        security: { auth: { enforcedType: 'qwen-oauth' } },
      },
    });

    let thrown: Error | undefined;
    try {
      await rig.run('Hello', '--output-format', 'json', ...fakeModelArgs());
      expect.fail('Expected process to exit with error');
    } catch (e) {
      thrown = e as Error;
    }

    expect(thrown).toBeDefined();
    const message = (thrown as Error).message;

    // The error JSON is written to stdout as a CLIResultMessageError
    // Extract stdout from the error message
    const stdoutMatch = message.match(/Stdout:\n([\s\S]*?)(?:\n\nStderr:|$)/);
    expect(
      stdoutMatch,
      'Expected to find stdout in the error message',
    ).toBeTruthy();

    const stdout = stdoutMatch![1];
    let parsed: unknown[];
    try {
      // Parse the JSON array from stdout
      parsed = JSON.parse(stdout);
    } catch (parseError) {
      console.error('Failed to parse the following JSON:', stdout);
      throw new Error(
        `Test failed: Could not parse JSON from stdout. Details: ${parseError}`,
      );
    }

    // The output should be an array of messages
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);

    // Find the result message with error
    const resultMessage = parsed.find(
      (msg: unknown) =>
        typeof msg === 'object' &&
        msg !== null &&
        'type' in msg &&
        msg.type === 'result' &&
        'is_error' in msg &&
        msg.is_error === true,
    ) as {
      type: string;
      is_error: boolean;
      subtype: string;
      error?: { message: string; type?: string };
    };

    expect(resultMessage).toBeDefined();
    expect(resultMessage.is_error).toBe(true);
    expect(resultMessage).toHaveProperty('subtype');
    expect(resultMessage.subtype).toBe('error_during_execution');
    expect(resultMessage).toHaveProperty('error');
    expect(resultMessage.error).toBeDefined();
    expect(resultMessage.error?.message).toContain(
      'configured auth type is qwen-oauth',
    );
    expect(resultMessage.error?.message).toContain(
      'current auth type is openai',
    );
  });
});
