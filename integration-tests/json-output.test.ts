/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, describe, it, beforeEach, afterEach } from 'vitest';
import { TestRig } from './test-helper.js';

describe('JSON output', () => {
  let rig: TestRig;

  beforeEach(async () => {
    rig = new TestRig();
    await rig.setup('json-output-test');
  });

  afterEach(async () => {
    await rig.cleanup();
  });

  it('should return a valid JSON array with result message containing response and stats', async () => {
    const result = await rig.run(
      'What is the capital of France?',
      '--output-format',
      'json',
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

  it('should return a JSON error for enforced auth mismatch before running', async () => {
    process.env['OPENAI_API_KEY'] = 'test-key';
    await rig.setup('json-output-auth-mismatch', {
      settings: {
        security: { auth: { enforcedType: 'qwen-oauth' } },
      },
    });

    let thrown: Error | undefined;
    try {
      await rig.run('Hello', '--output-format', 'json');
      expect.fail('Expected process to exit with error');
    } catch (e) {
      thrown = e as Error;
    } finally {
      delete process.env['OPENAI_API_KEY'];
    }

    expect(thrown).toBeDefined();
    const message = (thrown as Error).message;

    // The error JSON is written to stderr, so it should be in the error message
    // Use a regex to find the first complete JSON object in the string
    const jsonMatch = message.match(/{[\s\S]*}/);

    // Fail if no JSON-like text was found
    expect(
      jsonMatch,
      'Expected to find a JSON object in the error output',
    ).toBeTruthy();

    let payload;
    try {
      // Parse the matched JSON string
      payload = JSON.parse(jsonMatch![0]);
    } catch (parseError) {
      console.error('Failed to parse the following JSON:', jsonMatch![0]);
      throw new Error(
        `Test failed: Could not parse JSON from error message. Details: ${parseError}`,
      );
    }

    // The JsonFormatter.formatError() outputs: { error: { type, message, code } }
    expect(payload).toHaveProperty('error');
    expect(payload.error).toBeDefined();
    expect(payload.error.type).toBe('Error');
    expect(payload.error.code).toBe(1);
    expect(payload.error.message).toContain(
      'configured auth type is qwen-oauth',
    );
    expect(payload.error.message).toContain('current auth type is openai');
  });
});
