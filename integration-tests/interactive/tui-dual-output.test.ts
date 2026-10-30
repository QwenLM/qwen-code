/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import type {
  CLIMessage,
  ControlMessage,
  ContentBlock,
  StreamEvent,
} from '../../packages/cli/src/nonInteractive/types.js';
import {
  fakeToolCall,
  startFakeOpenAIServer,
  type FakeOpenAIRequest,
} from '../fake-openai-server.js';
import { E2E_MEMORY_SETTINGS_DEFAULTS } from '../e2e-memory-defaults.js';
import { pickE2eRenderer, resolveE2eCliCommand } from '../renderer-matrix.js';
import { InteractiveSession } from './interactive-session.js';

type Frame = CLIMessage | ControlMessage;
type Case =
  | 'text-thought'
  | 'tool'
  | 'allow'
  | 'deny'
  | 'cancel-followup'
  | 'active-exit';
const cases: Case[] = [
  'text-thought',
  'tool',
  'allow',
  'deny',
  'cancel-followup',
  'active-exit',
];
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const renderer = pickE2eRenderer();
const runtime = resolveE2eCliCommand(renderer);
const sha = (bytes: Buffer | string) =>
  createHash('sha256').update(bytes).digest('hex');
const json = (file: string, value: unknown) =>
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
async function until(
  check: () => boolean | Promise<boolean>,
  description: string,
  timeout = 15_000,
) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(description);
    await sleep(50);
  }
}
function blocks(frames: Frame[], type: 'user' | 'assistant'): ContentBlock[] {
  return frames.flatMap((frame) => {
    if (frame.type !== type) return [];
    assert.notEqual(typeof frame.message.content, 'string');
    return frame.message.content as ContentBlock[];
  });
}
function contentSequence(frames: Frame[]) {
  return blocks(frames, 'assistant').map((block) => {
    if (block.type === 'text') return ['text', block.text];
    if (block.type === 'thinking') return ['thinking', block.thinking];
    if (block.type !== 'tool_use')
      throw new Error('unexpected assistant block');
    return ['tool_use', { id: block.id, name: block.name, input: block.input }];
  });
}
function streamSequence(frames: Frame[]) {
  const events: StreamEvent[] = frames.flatMap((frame) =>
    frame.type === 'stream_event' ? [frame.event] : [],
  );
  const sequence: unknown[] = [];
  let messageOpen = false;
  let messageBlocks = 0;
  let block:
    | {
        index: number;
        type: string;
        value: string;
        name?: string;
        input: string;
      }
    | undefined;
  for (const event of events) {
    switch (event.type) {
      case 'message_start':
        assert.equal(messageOpen, false);
        messageOpen = true;
        messageBlocks = 0;
        break;
      case 'content_block_start': {
        assert.equal(messageOpen, true);
        assert.equal(block, undefined);
        const value = event.content_block;
        if (value.type === 'tool_result')
          throw new Error('unexpected streamed result');
        if (value.type === 'tool_use') assert.deepEqual(value.input, {});
        else
          assert.equal(value.type === 'text' ? value.text : value.thinking, '');
        block = {
          index: event.index,
          type: value.type,
          value: value.type === 'tool_use' ? value.id : '',
          name: value.type === 'tool_use' ? value.name : undefined,
          input: '',
        };
        break;
      }
      case 'content_block_delta': {
        assert.ok(messageOpen && block);
        assert.equal(event.index, block.index);
        if (event.delta.type === 'input_json_delta') {
          if (block.type !== 'tool_use')
            throw new Error('unexpected assistant block');
          block.input += event.delta.partial_json;
        } else if (event.delta.type === 'text_delta') {
          assert.equal(block.type, 'text');
          block.value += event.delta.text;
        } else {
          assert.equal(block.type, 'thinking');
          block.value += event.delta.thinking;
        }
        break;
      }
      case 'content_block_stop':
        assert.ok(messageOpen && block);
        assert.equal(event.index, block.index);
        assert.ok(block.value.length);
        sequence.push([
          block.type,
          block.type === 'tool_use'
            ? {
                id: block.value,
                name: block.name,
                input: JSON.parse(block.input),
              }
            : block.value,
        ]);
        block = undefined;
        messageBlocks++;
        break;
      case 'message_stop':
        assert.equal(messageOpen, true);
        assert.equal(block, undefined);
        assert.ok(messageBlocks > 0);
        messageOpen = false;
        break;
      default:
        break;
    }
  }
  assert.equal(messageOpen, false);
  assert.equal(block, undefined);
  return sequence;
}
function requestText(request: FakeOpenAIRequest) {
  const messages = request.body['messages'] as Array<{
    role: string;
    content: unknown;
  }>;
  const content = messages
    .filter((message) => message.role === 'user')
    .at(-1)?.content;
  if (typeof content === 'string') return content;
  assert.ok(Array.isArray(content));
  return content
    .map((part: { type: string; text: string }) => {
      assert.equal(part.type, 'text');
      return part.text.startsWith('<system-reminder>') ? '' : part.text;
    })
    .join('');
}

it.each(cases)(
  'dual output %s through the actual CLI',
  async (name) => {
    const output =
      process.env['QWEN_TUI_ACCEPTANCE_OUT'] ??
      join(root, '.qwen/e2e-tests/tui-dual-output');
    mkdirSync(output, { recursive: true });
    const evidence = mkdtempSync(
      join(output, `dual-${runtime}-${renderer}-${name}-`),
    );
    let scratch: string | undefined;
    let sidecar: string | undefined;
    let server: Awaited<ReturnType<typeof startFakeOpenAIServer>> | undefined;
    let session: InteractiveSession | undefined;
    let failure: string | undefined;
    const cleanupErrors: string[] = [];
    const facts: Record<string, unknown> = {};
    let release = () => {};
    try {
      scratch = mkdtempSync(join(tmpdir(), 'qwen-dual-output-'));
      const workspace = join(scratch, 'workspace');
      const home = join(scratch, 'home');
      const runtimeDir = join(scratch, 'runtime');
      const temp = join(scratch, 'tmp');
      for (const dir of [workspace, home, runtimeDir, temp])
        mkdirSync(dir, { recursive: true });
      const systemSettings = join(scratch, 'system-settings.json');
      const systemDefaults = join(scratch, 'system-defaults.json');
      json(systemSettings, {});
      json(systemDefaults, {});
      sidecar = join(scratch, 'events.jsonl');
      const toolFile = join(workspace, 'owned-tool.txt');
      const prompt = `DUAL-PROMPT-${name}`;
      const followup = 'DUAL-SECOND-PROMPT';
      const answer = 'DUAL-FINAL-ANSWER';
      const thought = 'DUAL-REASONING';
      const partial = 'DUAL-PARTIAL-VISIBLE';
      const tail = 'DUAL-TAIL-MUST-NOT-DELIVER';
      const fileContent = 'DUAL-OWNED-TOOL-CONTENT';
      const callId = `call-dual-${name}`;
      const toolName = name === 'tool' ? 'read_file' : 'write_file';
      const toolInput = {
        file_path: toolFile,
        ...(name === 'tool' ? {} : { content: fileContent }),
      };
      if (name === 'tool') writeFileSync(toolFile, fileContent);
      json(join(home, 'settings.json'), {
        security: {
          auth: { selectedType: 'openai' },
          folderTrust: { enabled: false },
        },
        general: { enableAutoUpdate: false, showSessionRecap: false },
        ui: { enableFollowupSuggestions: false },
        memory: E2E_MEMORY_SETTINGS_DEFAULTS,
      });
      const held = new Promise<void>((done) => {
        release = done;
      });
      server = await startFakeOpenAIServer(({ requestIndex }) => {
        if (requestIndex === 0 && ['tool', 'allow', 'deny'].includes(name))
          return { toolCalls: [fakeToolCall(toolName, toolInput, callId)] };
        if (
          requestIndex === 0 &&
          ['cancel-followup', 'active-exit'].includes(name)
        )
          return {
            contentChunks: [partial, tail],
            holdAfterChunks: 1,
            holdUntil: held,
          };
        return {
          content: answer,
          ...(name === 'text-thought' ? { reasoning: thought } : {}),
        };
      });
      const modelServer = server;
      session = await InteractiveSession.start({
        cwd: workspace,
        cols: 120,
        rows: 40,
        inheritEnv: false,
        env: {
          PATH: process.env['PATH'],
          HOME: scratch,
          QWEN_HOME: home,
          QWEN_RUNTIME_DIR: runtimeDir,
          QWEN_CODE_SYSTEM_SETTINGS_PATH: systemSettings,
          QWEN_CODE_SYSTEM_DEFAULTS_PATH: systemDefaults,
          TMPDIR: temp,
          TMP: temp,
          TEMP: temp,
          USERPROFILE: scratch,
          XDG_CACHE_HOME: join(scratch, 'cache'),
          TERM: 'xterm-256color',
          LANG: 'en_US.UTF-8',
          QWEN_CODE_LANG: 'en',
          QWEN_SANDBOX: 'false',
          QWEN_CODE_DISABLE_CRON: '1',
          QWEN_CODE_SKIP_UPDATE_CHECK_ONCE: 'true',
          QWEN_CODE_MODELS_DEV_REFRESH: 'off',
          NO_PROXY: 'localhost,127.0.0.1',
        },
        args: [
          '--auth-type',
          'openai',
          '--openai-api-key',
          'owned-fake-key',
          '--openai-base-url',
          modelServer.baseUrl,
          '--model',
          'fake-model',
          '--approval-mode',
          'default',
          '--json-file',
          sidecar,
        ],
      });
      const active = session;
      const visible = (text: string) =>
        until(
          async () => (await active.viewport()).includes(text),
          `missing visible ${text}`,
        );
      await active.idle(200, 1500);
      await active.send(prompt);
      if (name === 'allow' || name === 'deny') {
        await visible('Yes, allow once');
        expect(await active.viewport()).toContain('owned-tool.txt');
        await active.idle(150, 1000);
        active.pressKey(name === 'allow' ? '\r' : '\x1b');
        if (name === 'allow')
          await until(
            () =>
              existsSync(toolFile) &&
              readFileSync(toolFile, 'utf8') === fileContent,
            'real tool write',
          );
        else {
          await until(
            async () => !(await active.viewport()).includes('Yes, allow once'),
            'denial dismisses confirmation',
          );
          await active.idle(300, 1500);
          expect(existsSync(toolFile)).toBe(false);
        }
      }
      if (name === 'cancel-followup' || name === 'active-exit') {
        await visible(partial);
        if (name === 'cancel-followup') {
          active.pressKey('\x1b');
          await until(
            () => modelServer.requests[0]?.transport.closedAt !== undefined,
            'original held HTTP closes before release',
            5000,
          );
          expect(modelServer.requests[0].transport.writableEndedAtClose).toBe(
            false,
          );
          expect(modelServer.requests).toHaveLength(1);
          facts['cancelTransport'] = { ...modelServer.requests[0].transport };
          active.pressKey('\x15');
          await active.idle(150, 1000);
          await active.send(followup);
          await until(
            () => modelServer.requests.length === 2,
            'successor admitted while tail held',
            5000,
          );
          expect(requestText(modelServer.requests[1])).toBe(followup);
          facts['tailReleasedAt'] = performance.now();
          release();
        }
      }
      if (name !== 'deny' && name !== 'active-exit') await visible(answer);
      facts['viewportBeforeExit'] = await active.viewport();
      if (name === 'active-exit') {
        const firstKeyAt = performance.now();
        active.pressKey('\x03');
        await sleep(300);
        const secondKeyAt = performance.now();
        facts['activeExit'] = {
          firstKeyAt,
          secondKeyAt,
          transport: { ...modelServer.requests[0].transport },
        };
        expect(secondKeyAt - firstKeyAt).toBeLessThan(1000);
        active.pressKey('\x03');
      } else {
        await active.idle(200, 1000);
        await active.send('/quit');
      }
      await until(
        () => active.exitResult() !== undefined,
        'orderly PTY exit event',
        10_000,
      );
      expect(active.exitResult()?.exitCode).toBe(0);
      expect(modelServer.requests).toHaveLength(
        ['tool', 'allow', 'cancel-followup'].includes(name) ? 2 : 1,
      );
      expect(requestText(modelServer.requests[0])).toBe(prompt);
      const raw = readFileSync(sidecar, 'utf8');
      expect(raw.endsWith('\n')).toBe(true);
      expect(raw).not.toContain('\x1b');
      const frames: Frame[] = raw
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line));
      facts['frames'] = frames;
      expect(frames[0]).toMatchObject({
        type: 'system',
        subtype: 'session_start',
        data: { protocol_version: 2 },
      });
      expect(frames.at(-1)).toMatchObject({
        type: 'system',
        subtype: 'session_end',
      });
      expect(
        frames.filter(
          (frame) =>
            frame.type === 'system' && frame.subtype === 'session_start',
        ),
      ).toHaveLength(1);
      expect(
        frames.filter(
          (frame) => frame.type === 'system' && frame.subtype === 'session_end',
        ),
      ).toHaveLength(1);
      expect(
        blocks(frames, 'user')
          .filter((block) => block.type === 'text')
          .map((block) => block.text),
      ).toEqual(name === 'cancel-followup' ? [prompt, followup] : [prompt]);
      const expected =
        name === 'text-thought'
          ? [
              ['thinking', thought],
              ['text', answer],
            ]
          : ['tool', 'allow', 'deny'].includes(name)
            ? [
                ['tool_use', { id: callId, name: toolName, input: toolInput }],
                ...(name === 'deny' ? [] : [['text', answer]]),
              ]
            : name === 'cancel-followup'
              ? [
                  ['text', partial],
                  ['text', answer],
                ]
              : [['text', partial]];
      expect(contentSequence(frames)).toEqual(expected);
      expect(streamSequence(frames)).toEqual(expected);
      if (['tool', 'allow', 'deny'].includes(name)) {
        const results = blocks(frames, 'user').filter(
          (block) => block.type === 'tool_result',
        );
        if (name === 'deny') expect(results).toEqual([]);
        else {
          expect(results).toHaveLength(1);
          expect(results[0]).toMatchObject({
            tool_use_id: callId,
            is_error: false,
          });
          if (name === 'tool') {
            expect(JSON.stringify(results[0].content)).toContain(fileContent);
            const messages = modelServer.requests[1].body['messages'] as Array<{
              role: string;
              content: unknown;
            }>;
            expect(
              messages.some(
                (message) =>
                  message.role === 'tool' &&
                  JSON.stringify(message.content).includes(fileContent),
              ),
            ).toBe(true);
          }
        }
      }
      if (name === 'allow' || name === 'deny') {
        const requests = frames.filter(
          (frame) => frame.type === 'control_request',
        );
        const responses = frames.filter(
          (frame) => frame.type === 'control_response',
        );
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
          request: {
            subtype: 'can_use_tool',
            tool_use_id: callId,
            tool_name: toolName,
            input: toolInput,
          },
        });
        if (name === 'deny' && renderer === 'ink') {
          expect(responses).toHaveLength(0);
          facts['permissionContract'] =
            'EXPECTED_INK_GAP: Node/Bun Ink native Esc all-denied request1/response0';
        } else {
          expect(responses).toHaveLength(1);
          expect(responses[0]).toMatchObject({
            response: {
              request_id: requests[0].request_id,
              response: { allowed: name === 'allow' },
            },
          });
        }
      }
      if (name === 'cancel-followup') {
        const partialIndex = frames.findIndex(
          (frame) =>
            frame.type === 'assistant' &&
            frame.message.content.some(
              (block) => block.type === 'text' && block.text === partial,
            ),
        );
        const followupIndex = frames.findIndex(
          (frame) =>
            frame.type === 'user' &&
            JSON.stringify(frame.message.content).includes(followup),
        );
        expect(partialIndex).toBeGreaterThan(0);
        expect(followupIndex).toBeGreaterThan(partialIndex);
        expect(raw).not.toContain(tail);
        expect(requestText(modelServer.requests[1])).toBe(followup);
      }
    } catch (error) {
      failure =
        error instanceof Error ? (error.stack ?? error.message) : String(error);
    } finally {
      release();
      try {
        if (session)
          writeFileSync(join(evidence, 'terminal.ansi'), session.output());
      } catch (error) {
        cleanupErrors.push(`terminal: ${String(error)}`);
      }
      try {
        if (sidecar && existsSync(sidecar))
          writeFileSync(
            join(evidence, 'events-precleanup.jsonl'),
            readFileSync(sidecar),
          );
      } catch (error) {
        cleanupErrors.push(`sidecar: ${String(error)}`);
      }
      try {
        await session?.close();
      } catch (error) {
        cleanupErrors.push(`PTY: ${String(error)}`);
      }
      try {
        await server?.close();
      } catch (error) {
        cleanupErrors.push(`server: ${String(error)}`);
      }
      try {
        if (sidecar && existsSync(sidecar))
          writeFileSync(join(evidence, 'events.jsonl'), readFileSync(sidecar));
      } catch (error) {
        cleanupErrors.push(`postclose sidecar: ${String(error)}`);
      }
      try {
        if (scratch) rmSync(scratch, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(`scratch: ${String(error)}`);
      }
      try {
        facts['source'] = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: root,
          encoding: 'utf8',
          timeout: 5000,
        }).trim();
        facts['bundleSha256'] = sha(readFileSync(join(root, 'dist/cli.js')));
        facts['fixtureSha256'] = sha(
          readFileSync(fileURLToPath(import.meta.url)),
        );
        facts['runtimeVersion'] = execFileSync(runtime, ['--version'], {
          encoding: 'utf8',
          timeout: 5000,
        }).trim();
      } catch (error) {
        cleanupErrors.push(`identity: ${String(error)}`);
      }
      json(join(evidence, 'result.json'), {
        status:
          failure || cleanupErrors.length
            ? 'FAIL'
            : facts['permissionContract']
              ? 'EXPECTED_INK_GAP'
              : 'PASS',
        failure,
        cleanupErrors,
        renderer,
        runtime,
        case: name,
        exit: session?.exitResult(),
        requests: server?.requests ?? [],
        ...facts,
      });
    }
    if (failure || cleanupErrors.length)
      throw new Error([failure, ...cleanupErrors].filter(Boolean).join('\n'));
  },
  90_000,
);
