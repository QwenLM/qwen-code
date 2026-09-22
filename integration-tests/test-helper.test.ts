/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONTAINER_SANDBOX_NO_PROXY,
  fakeServerHostOptions,
  capturedToolCallPathMatches,
  parseStreamJsonToolCalls,
  TestRig,
} from './test-helper.js';
import { startFakeOpenAIServer } from './fake-openai-server.js';

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('TestRig', () => {
  const originalKeepOutput = process.env['KEEP_OUTPUT'];

  afterEach(() => {
    if (originalKeepOutput === undefined) {
      delete process.env['KEEP_OUTPUT'];
    } else {
      process.env['KEEP_OUTPUT'] = originalKeepOutput;
    }
    vi.restoreAllMocks();
  });

  it('resets a reused test directory during setup', async () => {
    const rig = new TestRig();
    await rig.setup('reused test directory');
    const staleFile = rig.createFile('stale.txt', 'stale');

    await rig.setup('reused test directory');

    expect(existsSync(staleFile)).toBe(false);
    expect(rig.testDir).not.toBeNull();
    expect(existsSync(rig.testDir!)).toBe(true);
  });

  it('removes the test directory during cleanup', async () => {
    delete process.env['KEEP_OUTPUT'];
    const rig = new TestRig();
    await rig.setup('cleanup test directory');
    const testDir = rig.testDir!;

    await rig.cleanup();

    expect(existsSync(testDir)).toBe(false);
  });

  it('keeps the test directory during cleanup when KEEP_OUTPUT is set', async () => {
    process.env['KEEP_OUTPUT'] = 'true';
    const rig = new TestRig();
    await rig.setup('keep output test directory');
    const testDir = rig.testDir!;

    await rig.cleanup();

    expect(existsSync(testDir)).toBe(true);
  });

  it('kills an interactive session a test never closed during cleanup', async () => {
    // KEEP_OUTPUT is what CI sets, and it makes cleanup() keep the test
    // directory — the spawned child must not survive that path either.
    process.env['KEEP_OUTPUT'] = 'true';
    const rig = new TestRig();
    await rig.setup('cleanup kills interactive session');
    // Stands in for the CLI bundle: what is under test is that cleanup ends
    // whatever runInteractive spawned, not what the CLI itself does.
    rig.bundlePath = rig.createFile(
      'idle-cli.js',
      'setInterval(() => {}, 1000);\n',
    );

    const { ptyProcess } = rig.runInteractive();
    expect(isProcessAlive(ptyProcess.pid)).toBe(true);

    await rig.cleanup();

    await expect
      .poll(() => isProcessAlive(ptyProcess.pid), {
        message: 'the interactive CLI child outlived cleanup()',
        timeout: 10_000,
      })
      .toBe(false);
  });

  it.each([
    [
      'telemetry events',
      (rig: TestRig) => rig.waitForTelemetryEvent('tool_call'),
    ],
    ['tool calls', (rig: TestRig) => rig.waitForToolCall('read_file')],
    [
      'any tool call',
      (rig: TestRig) => rig.waitForAnyToolCall(['read_file', 'write_file']),
    ],
  ])(
    'keeps polling for %s when telemetry is not ready yet',
    async (_label, waitFor) => {
      const rig = new TestRig();
      vi.spyOn(rig, 'waitForTelemetryReady').mockResolvedValue(undefined);
      const poll = vi.spyOn(rig, 'poll').mockResolvedValue(false);

      await expect(waitFor(rig)).resolves.toBe(false);
      expect(poll).toHaveBeenCalled();
    },
  );

  describe('readTelemetryEvent', () => {
    it('returns the latest matching event with its attributes', async () => {
      const rig = new TestRig();
      await rig.setup('read telemetry event latest');
      rig.createFile(
        'telemetry.log',
        [
          JSON.stringify({
            attributes: {
              'event.name': 'qwen-code.chat_compression',
              tokens_before: 1000,
              tokens_after: 900,
            },
          }),
          JSON.stringify({
            attributes: { 'event.name': 'qwen-code.api_request' },
          }),
          JSON.stringify({
            attributes: {
              'event.name': 'qwen-code.chat_compression',
              tokens_before: 28891,
              tokens_after: 27128,
            },
          }),
          JSON.stringify({
            attributes: { 'event.name': 'qwen-code.api_request' },
          }),
        ].join('\n'),
      );

      const event = rig.readTelemetryEvent('chat_compression');

      expect(event?.attributes?.['tokens_before']).toBe(28891);
      expect(event?.attributes?.['tokens_after']).toBe(27128);

      await rig.cleanup();
    });

    it('returns null when the event never landed', async () => {
      const rig = new TestRig();
      await rig.setup('read telemetry event absent');

      expect(rig.readTelemetryEvent('chat_compression')).toBeNull();

      await rig.cleanup();
    });
  });

  describe('parseStreamJsonToolCalls', () => {
    it('preserves structured args and associates out-of-order results by id', () => {
      const stdout = [
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'call-1',
                name: 'run_shell_command',
                input: {
                  command: "printf 'hello\\n世界'",
                  nested: { values: ['a', 2] },
                },
              },
              {
                type: 'tool_use',
                id: 'call-2',
                name: 'read_file',
                input: { file_path: 'missing.txt' },
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call-2',
                is_error: true,
                content: 'File not found',
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call-1',
                is_error: false,
                content: 'hello',
              },
            ],
          },
        }),
        JSON.stringify({ type: 'result', result: 'finished' }),
      ].join('\n');

      expect(parseStreamJsonToolCalls(stdout)).toEqual({
        result: 'finished',
        toolCalls: [
          {
            callId: 'call-1',
            name: 'run_shell_command',
            args: {
              command: "printf 'hello\\n世界'",
              nested: { values: ['a', 2] },
            },
            success: true,
          },
          {
            callId: 'call-2',
            name: 'read_file',
            args: { file_path: 'missing.txt' },
            success: false,
            error: 'File not found',
          },
        ],
      });
    });

    it('does not invent a result for an unfinished tool call', () => {
      const stdout = JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'call-1',
              name: 'write_file',
              input: { file_path: 'a.txt', content: 'a' },
            },
          ],
        },
      });

      expect(parseStreamJsonToolCalls(stdout).toolCalls).toEqual([
        {
          callId: 'call-1',
          name: 'write_file',
          args: { file_path: 'a.txt', content: 'a' },
        },
      ]);
    });

    it('fails closed on a malformed frame', () => {
      expect(() =>
        parseStreamJsonToolCalls(
          `${JSON.stringify({ type: 'system' })}\nnot-json`,
        ),
      ).toThrow('Invalid stream-json frame on line 2');
    });

    it('matches both relative and absolute tool paths without substring collisions', () => {
      const call = {
        callId: 'call-1',
        name: 'read_file',
        args: { file_path: '/workspace/project/missing.txt' },
      };

      expect(
        capturedToolCallPathMatches(call, 'file_path', 'missing.txt'),
      ).toBe(true);
      expect(
        capturedToolCallPathMatches(
          { ...call, args: { file_path: 'missing.txt' } },
          'file_path',
          'missing.txt',
        ),
      ).toBe(true);
      expect(capturedToolCallPathMatches(call, 'file_path', 'sing.txt')).toBe(
        false,
      );
    });
  });

  it('captures real tool args and result without reading telemetry args', async () => {
    const rig = new TestRig();
    await rig.setup('stream json tool capture');
    const targetPath = join(rig.testDir!, 'captured.txt');
    let streamingRequestIndex = 0;
    const fakeServer = await startFakeOpenAIServer(({ body }) => {
      if (body['stream'] !== true) {
        return { content: '{"selected_memories":[]}' };
      }
      if (streamingRequestIndex++ === 0) {
        return {
          toolCalls: [
            {
              id: 'capture-call',
              type: 'function',
              function: {
                name: 'write_file',
                arguments: JSON.stringify({
                  file_path: targetPath,
                  content: 'captured',
                }),
              },
            },
          ],
        };
      }
      return { content: 'done' };
    }, fakeServerHostOptions());

    vi.stubEnv('OPENAI_API_KEY', 'fake-key');
    vi.stubEnv('OPENAI_BASE_URL', fakeServer.baseUrl);
    vi.stubEnv('OPENAI_MODEL', 'fake-model');
    vi.stubEnv('QWEN_MODEL', 'fake-model');
    vi.stubEnv('QWEN_HOME', join(rig.testDir!, '.qwen-home'));
    vi.stubEnv('QWEN_RUNTIME_DIR', join(rig.testDir!, '.qwen-home'));
    vi.stubEnv('NO_PROXY', CONTAINER_SANDBOX_NO_PROXY);
    vi.stubEnv('no_proxy', CONTAINER_SANDBOX_NO_PROXY);

    try {
      const capture = await rig.runWithToolCapture(
        'write the file',
        '--auth-type',
        'openai',
        '--model',
        'fake-model',
        '--openai-base-url',
        fakeServer.baseUrl,
        '--openai-api-key',
        'fake-key',
      );

      expect(capture.result).toBe('done');
      expect(capture.toolCalls).toEqual([
        {
          callId: 'capture-call',
          name: 'write_file',
          args: { file_path: targetPath, content: 'captured' },
          success: true,
        },
      ]);
      expect(rig.readFile('captured.txt')).toBe('captured');
      expect(
        rig.readToolLogs().find((log) => log.toolRequest.name === 'write_file')
          ?.toolRequest.args,
      ).not.toContain(targetPath);
    } finally {
      await fakeServer.close();
      await rig.cleanup();
    }
  });
});
