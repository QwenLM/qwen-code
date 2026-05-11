/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for `--json-schema` headless structured output.
 *
 * Validates that:
 *   - A valid schema makes the synthetic `structured_output` tool the only
 *     way for the model to terminate, and the submitted args land in the
 *     result message's `structured_result` field.
 *   - Schema validation happens at CLI parse time; bad schemas fail fast
 *     with a non-zero exit code instead of silently no-oping at runtime.
 *   - File-based schemas (`@/path/to/schema.json`) are loaded and parsed.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TestRig, validateModelOutput } from '../test-helper.js';

interface ResultMessage {
  type: string;
  is_error: boolean;
  result?: string;
  structured_result?: unknown;
  error?: { message: string };
}

function findResultMessage(parsed: unknown): ResultMessage | undefined {
  if (!Array.isArray(parsed)) return undefined;
  return parsed.find(
    (msg): msg is ResultMessage =>
      typeof msg === 'object' &&
      msg !== null &&
      (msg as { type?: unknown }).type === 'result',
  );
}

describe('--json-schema headless structured output', () => {
  let rig: TestRig;

  afterEach(async () => {
    if (rig) await rig.cleanup();
  });

  it('emits structured_result when the model fills the schema', async () => {
    rig = new TestRig();
    await rig.setup('json-schema-inline');

    const schema = JSON.stringify({
      type: 'object',
      required: ['answer'],
      properties: {
        answer: { type: 'number' },
      },
      additionalProperties: false,
    });

    const stdout = await rig.run(
      'What is 2 + 2? Submit it via the structured_output tool.',
      '--output-format',
      'json',
      '--json-schema',
      schema,
    );

    const parsed = JSON.parse(stdout);
    const result = findResultMessage(parsed);
    expect(result, 'expected a result message').toBeDefined();
    expect(result!.is_error).toBe(false);
    expect(result, 'expected structured_result on success').toHaveProperty(
      'structured_result',
    );

    const structured = result!.structured_result as { answer?: unknown };
    expect(structured).toBeTypeOf('object');
    expect(structured.answer).toBe(4);

    // The `result` string must be the JSON-stringified payload (contract).
    expect(typeof result!.result).toBe('string');
    expect(JSON.parse(result!.result!)).toEqual(structured);

    // The structured_output tool must have been invoked.
    const toolLogs = rig.readToolLogs();
    const found = toolLogs.find(
      (l) => l.toolRequest.name === 'structured_output',
    );
    expect(
      found,
      `expected structured_output tool call, saw: ${toolLogs.map((l) => l.toolRequest.name).join(', ')}`,
    ).toBeTruthy();

    validateModelOutput(stdout, null, 'json-schema inline');
  });

  it('loads a schema from disk via the @path syntax', async () => {
    rig = new TestRig();
    await rig.setup('json-schema-file');

    const schemaPath = join(rig.testDir!, 'schema.json');
    writeFileSync(
      schemaPath,
      JSON.stringify({
        type: 'object',
        required: ['city', 'country'],
        properties: {
          city: { type: 'string' },
          country: { type: 'string' },
        },
        additionalProperties: false,
      }),
    );

    const stdout = await rig.run(
      'What is the capital of France and what country is it in? Submit via structured_output.',
      '--output-format',
      'json',
      '--json-schema',
      `@${schemaPath}`,
    );

    const result = findResultMessage(JSON.parse(stdout));
    expect(result?.is_error).toBe(false);
    const structured = result!.structured_result as {
      city?: unknown;
      country?: unknown;
    };
    expect(structured).toBeTypeOf('object');
    expect(typeof structured.city).toBe('string');
    expect(typeof structured.country).toBe('string');
    expect(String(structured.city).toLowerCase()).toContain('paris');
  });

  it('fails fast at CLI parse time on invalid JSON', async () => {
    rig = new TestRig();
    await rig.setup('json-schema-bad-json');

    let thrown: Error | undefined;
    try {
      await rig.run('hi', '--json-schema', '{not valid json');
      expect.fail('expected non-zero exit on invalid JSON');
    } catch (e) {
      thrown = e as Error;
    }

    expect(thrown).toBeDefined();
    expect(thrown!.message).toMatch(/--json-schema is not valid JSON/i);
  });

  it('fails fast at CLI parse time on invalid JSON Schema', async () => {
    rig = new TestRig();
    await rig.setup('json-schema-bad-schema');

    // Ajv strict-compile will reject `type: "this-is-not-a-real-type"`.
    let thrown: Error | undefined;
    try {
      await rig.run(
        'hi',
        '--json-schema',
        JSON.stringify({ type: 'this-is-not-a-real-type' }),
      );
      expect.fail('expected non-zero exit on invalid schema');
    } catch (e) {
      thrown = e as Error;
    }

    expect(thrown).toBeDefined();
    expect(thrown!.message).toMatch(
      /--json-schema is not a valid JSON Schema/i,
    );
  });

  it('rejects a missing schema file', async () => {
    rig = new TestRig();
    await rig.setup('json-schema-missing-file');

    let thrown: Error | undefined;
    try {
      await rig.run('hi', '--json-schema', '@/tmp/__does_not_exist__.json');
      expect.fail('expected non-zero exit on missing file');
    } catch (e) {
      thrown = e as Error;
    }

    expect(thrown).toBeDefined();
    expect(thrown!.message).toMatch(/--json-schema could not read/i);
  });

  it('exits 1 with is_error=true when the model emits plain text instead of calling structured_output', async () => {
    rig = new TestRig();
    await rig.setup('json-schema-plain-text-error');

    const schema = JSON.stringify({
      type: 'object',
      required: ['answer'],
      properties: { answer: { type: 'string' } },
      additionalProperties: false,
    });

    // Force the model down the plain-text path deterministically by
    // excluding the synthetic tool from the registry. Without
    // structured_output available, the model has no choice but to emit
    // plain text, which is exactly the failure mode this branch handles
    // (`config.getJsonSchema()` set + no submission == exit 1 + isError).
    let thrown: Error | undefined;
    try {
      await rig.run(
        'Reply with the literal text "ok".',
        '--output-format',
        'json',
        '--json-schema',
        schema,
        '--exclude-tools',
        'structured_output',
      );
      expect.fail('expected non-zero exit when model emits plain text');
    } catch (e) {
      thrown = e as Error;
    }

    expect(thrown).toBeDefined();

    // Stdout (containing the JSON result array) is captured in the error
    // body in JSON-output mode.
    const stdoutMatch = thrown!.message.match(
      /Stdout:\n([\s\S]*?)(?:\n\nStderr:|$)/,
    );
    expect(
      stdoutMatch,
      `expected JSON stdout in error body, got: ${thrown!.message.slice(0, 400)}`,
    ).toBeTruthy();

    const parsed = JSON.parse(stdoutMatch![1]);
    const result = findResultMessage(parsed);
    expect(result).toBeDefined();
    expect(result!.is_error).toBe(true);
    expect(result!.error?.message).toMatch(/Model produced plain text/i);

    // structured_output must NOT have been called (otherwise the success
    // branch would have terminated and we'd never hit this code path).
    const calls = rig.readToolLogs().map((l) => l.toolRequest.name);
    expect(calls).not.toContain('structured_output');
  });
});
