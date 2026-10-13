/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A real PreToolUse command hook's `updatedInput` replaces the tool input:
 * the tool runs once with the replacement, permission checks and approval
 * prompts see the replacement, and the model's own function call is kept.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyContainerSandboxNoProxy,
  fakeServerHostOptions,
  TestRig,
} from '../test-helper.js';
import {
  fakeToolCall,
  startFakeOpenAIServer,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';
import {
  exitInteractive,
  fakeModelLaunchArgs,
  makeWaitFor,
} from '../helpers/gated-skill-fixture.js';
import { ACP_HOME_PREFIX, removeScratchDir } from '../scratch-dir.js';

const HOOK_SCRIPT = 'rewrite-hook.mjs';
const HITS_LOG = 'hook-hits.jsonl';
// Per-tool PreToolUse output, read from the (volume-mounted) test directory
// rather than the environment, which a container sandbox does not forward.
const OUTPUT_FILE = 'pre-output.json';

const hookSource = `
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const input = JSON.parse(readFileSync(0, 'utf8'));
const event = input.hook_event_name;
appendFileSync(${JSON.stringify(HITS_LOG)}, JSON.stringify({ event, call: input.tool_call_id, tool: input.tool_name, input: input.tool_input }) + '\\n');
const outputs = existsSync(${JSON.stringify(OUTPUT_FILE)})
  ? JSON.parse(readFileSync(${JSON.stringify(OUTPUT_FILE)}, 'utf8'))
  : {};
const out = { hookEventName: event, ...(event === 'PreToolUse' ? outputs[input.tool_name] : undefined) };
process.stdout.write(JSON.stringify({ hookSpecificOutput: out }));
`;

type Message = {
  role: string;
  tool_call_id?: string;
  content?: unknown;
  tool_calls?: Array<{ id: string; function: { arguments: string } }>;
};
type HookHit = {
  event: string;
  call: string;
  tool: string;
  input: Record<string, unknown>;
};

describe('PreToolUse updatedInput', () => {
  let rig: TestRig;
  let fakeServer: FakeOpenAIServer | undefined;
  let restoreNoProxy: (() => void) | undefined;

  afterEach(async () => {
    vi.unstubAllEnvs();
    restoreNoProxy?.();
    restoreNoProxy = undefined;
    await fakeServer?.close();
    fakeServer = undefined;
    await rig?.cleanup();
  });

  async function setup(
    testName: string,
    toolName: string,
    callId: string,
    buildArgs: (dir: string) => Record<string, unknown>,
    outputs: (dir: string) => Record<string, unknown>,
    extraSettings: Record<string, unknown> = {},
  ): Promise<FakeOpenAIServer> {
    rig = new TestRig();
    await rig.setup(testName, {
      settings: {
        hooks: {
          PreToolUse: [
            {
              matcher: '*',
              hooks: [{ type: 'command', command: `node ${HOOK_SCRIPT}` }],
            },
          ],
        },
        ...extraSettings,
      },
    });
    writeFileSync(join(rig.testDir!, HOOK_SCRIPT), hookSource);
    writeFileSync(
      join(rig.testDir!, OUTPUT_FILE),
      JSON.stringify(outputs(rig.testDir!)),
    );
    rig.createFile('A.txt', 'ORIGINAL_A\n');
    rig.createFile('B.txt', 'REWRITTEN_B\n');

    let streaming = 0;
    const server = await startFakeOpenAIServer(({ body }) => {
      if (body['stream'] !== true) return { content: '{}' };
      return streaming++ === 0
        ? {
            toolCalls: [
              fakeToolCall(toolName, buildArgs(rig.testDir!), callId),
            ],
          }
        : { content: 'done' };
    }, fakeServerHostOptions());
    fakeServer = server;

    vi.stubEnv('OPENAI_API_KEY', 'fake-key');
    vi.stubEnv('OPENAI_BASE_URL', server.baseUrl);
    vi.stubEnv('OPENAI_MODEL', 'fake-model');
    vi.stubEnv('QWEN_HOME', join(rig.testDir!, '.qwen-home'));
    vi.stubEnv('QWEN_RUNTIME_DIR', join(rig.testDir!, '.qwen-home'));
    restoreNoProxy = applyContainerSandboxNoProxy();
    return server;
  }

  function followUpMessages(server: FakeOpenAIServer): Message[] {
    const followUp = server.requests.find(
      (request) =>
        request.body['stream'] === true &&
        (request.body['messages'] as Message[]).some(
          (message) => message.role === 'tool',
        ),
    );
    return (followUp?.body['messages'] ?? []) as Message[];
  }

  /** The tool message for `callId` in the model request that follows it. */
  function toolResultFor(server: FakeOpenAIServer, callId: string): string {
    const toolMessage = followUpMessages(server).find(
      (message) => message.role === 'tool' && message.tool_call_id === callId,
    );
    expect(toolMessage, 'no paired tool result was sent').toBeDefined();
    return JSON.stringify(toolMessage!.content);
  }

  /** The model's own arguments for `callId`, as replayed to the model. */
  function modelArgsFor(
    server: FakeOpenAIServer,
    callId: string,
  ): Record<string, unknown> {
    const call = followUpMessages(server)
      .flatMap((message) => message.tool_calls ?? [])
      .find((toolCall) => toolCall.id === callId);
    expect(call, 'the model tool call was not replayed').toBeDefined();
    return JSON.parse(call!.function.arguments);
  }

  function hookHits(): HookHit[] {
    const log = join(rig.testDir!, HITS_LOG);
    if (!existsSync(log)) return [];
    return readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  function file(name: string): string | undefined {
    const path = join(rig.testDir!, name);
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  }

  it('headless: reads the replacement file and keeps the model call', async () => {
    const server = await setup(
      'updated input headless read',
      'read_file',
      'call_read',
      (dir) => ({ file_path: join(dir, 'A.txt') }),
      (dir) => ({
        read_file: { updatedInput: { file_path: join(dir, 'B.txt') } },
      }),
    );
    await rig.run('read the file', ...fakeModelLaunchArgs(server));

    const hits = hookHits();
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      event: 'PreToolUse',
      call: 'call_read',
      tool: 'read_file',
      input: { file_path: join(rig.testDir!, 'A.txt') },
    });
    const result = toolResultFor(server, 'call_read');
    expect(result).toContain('REWRITTEN_B');
    expect(result).not.toContain('ORIGINAL_A');
    expect(modelArgsFor(server, 'call_read')).toEqual({
      file_path: join(rig.testDir!, 'A.txt'),
    });
  });

  it('headless: checks deny rules against the replacement command', async () => {
    const server = await setup(
      'updated input headless deny',
      'run_shell_command',
      'call_shell',
      () => ({ command: 'echo safe-original' }),
      () => ({
        run_shell_command: {
          updatedInput: { command: 'touch denied-sentinel.txt' },
        },
      }),
      { permissions: { deny: ['Bash(touch *)'] } },
    );
    await rig.run('run the command', ...fakeModelLaunchArgs(server));

    expect(hookHits()).toHaveLength(1);
    expect(file('denied-sentinel.txt')).toBeUndefined();
    const result = toolResultFor(server, 'call_shell');
    expect(result).not.toContain('safe-original');
    expect(result).toMatch(/denied|declined/i);
  });

  it('headless: rejects a non-object updatedInput without running the tool', async () => {
    const server = await setup(
      'updated input headless invalid',
      'write_file',
      'call_invalid',
      (dir) => ({ file_path: join(dir, 'C.txt'), content: 'ORIGINAL_C' }),
      () => ({ write_file: { updatedInput: ['not', 'an', 'object'] } }),
    );
    await rig.run('write the file', ...fakeModelLaunchArgs(server));

    expect(hookHits()).toHaveLength(1);
    expect(file('C.txt')).toBeUndefined();
    expect(toolResultFor(server, 'call_invalid')).toContain('updatedInput');
  });

  it('headless: rewrites a nested exec call', async () => {
    const server = await setup(
      'updated input headless nested exec',
      'exec',
      'call_exec',
      (dir) => ({
        source: `const r = await tools.read_file({ file_path: ${JSON.stringify(join(dir, 'A.txt'))} }); text(JSON.stringify(r))`,
      }),
      (dir) => ({
        read_file: { updatedInput: { file_path: join(dir, 'B.txt') } },
      }),
      { tools: { codeModeOnly: true } },
    );
    await rig.run('run the script', ...fakeModelLaunchArgs(server));

    expect(hookHits().filter((hit) => hit.tool === 'read_file')).toEqual([
      expect.objectContaining({ call: 'call_exec:code:1' }),
    ]);
    const result = toolResultFor(server, 'call_exec');
    expect(result).toContain('REWRITTEN_B');
    expect(result).not.toContain('ORIGINAL_A');
  });

  it('interactive: a PreToolUse ask confirms and writes the replacement', async () => {
    const server = await setup(
      'updated input interactive ask',
      'write_file',
      'call_ask',
      (dir) => ({ file_path: join(dir, 'ask-a.txt'), content: 'ORIGINAL' }),
      (dir) => ({
        write_file: {
          permissionDecision: 'ask',
          permissionDecisionReason: 'p02b1 review',
          updatedInput: {
            file_path: join(dir, 'ask-b.txt'),
            content: 'REWRITTEN',
          },
        },
      }),
    );
    const { ptyProcess } = rig.runInteractive(...fakeModelLaunchArgs(server));
    let output = '';
    ptyProcess.onData((data) => {
      output += data;
    });
    const waitFor = makeWaitFor(rig, () => output);
    await waitFor('the CLI to start', () =>
      output.includes('Type your message'),
    );

    const prompt = 'write the file';
    ptyProcess.write(prompt);
    await waitFor('the prompt to echo', () => output.includes(prompt));
    ptyProcess.write('\r');
    // 'ask-b.txt' already paints with the executing tool row, before the
    // ask dialog exists; the hook's reason renders only inside the dialog,
    // so waiting for it is what makes the approval below land.
    await waitFor(
      'the confirmation for the replacement',
      () => output.includes('ask-b.txt') && output.includes('p02b1 review'),
    );
    expect(output).not.toContain('ask-a.txt');
    // The first option approves once.
    ptyProcess.write('\r');
    await waitFor('the follow-up model request', () =>
      server.requests.some(
        (request) =>
          request.body['stream'] === true &&
          JSON.stringify(request.body['messages']).includes('"role":"tool"'),
      ),
    );
    await exitInteractive(ptyProcess, waitFor, () => output);

    expect(hookHits()).toHaveLength(1);
    expect(file('ask-a.txt')).toBeUndefined();
    expect(file('ask-b.txt')).toBe('REWRITTEN');
  });

  it('ACP: asks for and writes the replacement once', async () => {
    const server = await setup(
      'updated input acp write',
      'write_file',
      'call_acp',
      (dir) => ({ file_path: join(dir, 'acp-a.txt'), content: 'ORIGINAL' }),
      (dir) => ({
        write_file: {
          updatedInput: {
            file_path: join(dir, 'acp-b.txt'),
            content: 'REWRITTEN',
          },
        },
      }),
    );
    const permissionRequests: Array<{
      toolCall?: { rawInput?: Record<string, unknown> };
    }> = [];
    // The agent keeps writing under QWEN_HOME briefly after it exits, so keep
    // it out of rig.testDir, whose teardown would otherwise race those writes.
    const qwenHome = mkdtempSync(join(tmpdir(), ACP_HOME_PREFIX));
    const child = spawn(
      'node',
      [
        rig.bundlePath,
        '--acp',
        '--no-chat-recording',
        ...fakeModelLaunchArgs(server),
      ],
      {
        cwd: rig.testDir!,
        env: {
          ...process.env,
          QWEN_HOME: qwenHome,
          QWEN_RUNTIME_DIR: qwenHome,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const closed = new Promise<void>((resolve) =>
      child.once('close', () => resolve()),
    );
    const pending = new Map<
      number,
      { resolve: (value: unknown) => void; reject: (error: Error) => void }
    >();
    let nextId = 0;
    let disposed = false;
    const stderr: string[] = [];
    child.stderr!.on('data', (chunk) => stderr.push(chunk.toString()));
    child.once('close', (code, signal) => {
      if (disposed) return;
      const tail = stderr.join('').trimEnd().slice(-500);
      for (const [id, { reject }] of pending) {
        reject(
          new Error(
            `ACP request ${id} failed: agent exited (code=${code} signal=${signal})` +
              (tail ? `\nlast agent stderr:\n${tail}` : ''),
          ),
        );
      }
      pending.clear();
    });
    createInterface({ input: child.stdout! }).on('line', (line) => {
      let message: {
        id?: number;
        method?: string;
        params?: unknown;
        result?: unknown;
      };
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id === undefined) return;
      if (message.method === undefined) {
        pending.get(message.id)?.resolve(message.result);
        pending.delete(message.id);
        return;
      }
      if (message.method === 'session/request_permission') {
        permissionRequests.push(
          message.params as (typeof permissionRequests)[number],
        );
      }
      child.stdin!.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result:
            message.method === 'session/request_permission'
              ? { outcome: { outcome: 'selected', optionId: 'proceed_once' } }
              : null,
        }) + '\n',
      );
    });
    const request = <T>(method: string, params: unknown) =>
      new Promise<T>((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, {
          resolve: (value) => resolve(value as T),
          reject,
        });
        child.stdin!.write(
          JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n',
        );
      });

    try {
      await request('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
        },
      });
      const session = await request<{ sessionId: string }>('session/new', {
        cwd: rig.testDir!,
        mcpServers: [],
      });
      // ACP sessions start in AUTO mode, which approves workspace writes.
      await request('session/set_mode', {
        sessionId: session.sessionId,
        modeId: 'default',
      });
      await request('session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'write the file' }],
      });
    } finally {
      disposed = true;
      child.kill();
      await closed;
      await removeScratchDir(qwenHome);
    }

    expect(hookHits()).toHaveLength(1);
    expect(permissionRequests).toHaveLength(1);
    expect(permissionRequests[0]?.toolCall?.rawInput).toEqual({
      file_path: join(rig.testDir!, 'acp-b.txt'),
      content: 'REWRITTEN',
    });
    expect(file('acp-a.txt')).toBeUndefined();
    expect(file('acp-b.txt')).toBe('REWRITTEN');
    expect(modelArgsFor(server, 'call_acp')).toEqual({
      file_path: join(rig.testDir!, 'acp-a.txt'),
      content: 'ORIGINAL',
    });
  });
});
