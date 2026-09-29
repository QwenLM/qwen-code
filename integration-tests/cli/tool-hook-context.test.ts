/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * PreToolUse and PostToolUseFailure `additionalContext` from a real command
 * hook must reach the tool result in the next model request, on the core
 * (headless and interactive) and ACP paths.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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

const HOOK_SCRIPT = 'context-hook.mjs';
const HITS_LOG = 'hook-hits.jsonl';

// Emits `P02A_<event>_<tool_call_id>` so each marker names the call that
// produced it; the decision for PreToolUse comes from P02A_PRE_DECISION.
const hookSource = `
import { appendFileSync, readFileSync } from 'node:fs';
const input = JSON.parse(readFileSync(0, 'utf8'));
const event = input.hook_event_name;
appendFileSync(${JSON.stringify(HITS_LOG)}, JSON.stringify({ event, call: input.tool_call_id }) + '\\n');
const out = { hookEventName: event, additionalContext: 'P02A_' + event + '_' + input.tool_call_id };
const decision = process.env.P02A_PRE_DECISION;
if (event === 'PreToolUse' && decision) {
  out.permissionDecision = decision;
  out.permissionDecisionReason = 'p02a policy';
}
process.stdout.write(JSON.stringify({ hookSpecificOutput: out }));
`;

type ToolMessage = { role: string; tool_call_id?: string; content?: unknown };

describe('tool hook additionalContext delivery', () => {
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
    fileName: string,
    callId: string,
    buildArgs: (filePath: string) => Record<string, unknown> = (filePath) => ({
      file_path: filePath,
    }),
    extraSettings: Record<string, unknown> = {},
  ): Promise<FakeOpenAIServer> {
    rig = new TestRig();
    const hookGroup = [
      {
        matcher: '*',
        hooks: [{ type: 'command', command: `node ${HOOK_SCRIPT}` }],
      },
    ];
    await rig.setup(testName, {
      settings: {
        hooks: { PreToolUse: hookGroup, PostToolUseFailure: hookGroup },
        ...extraSettings,
      },
    });
    writeFileSync(join(rig.testDir!, HOOK_SCRIPT), hookSource);
    rig.createFile('note.txt', 'hello from note\n');

    let streaming = 0;
    const server = await startFakeOpenAIServer(({ body }) => {
      if (body['stream'] !== true) return { content: '{}' };
      return streaming++ === 0
        ? {
            toolCalls: [
              fakeToolCall(
                toolName,
                buildArgs(join(rig.testDir!, fileName)),
                callId,
              ),
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
    vi.stubEnv('P02A_PRE_DECISION', '');
    restoreNoProxy = applyContainerSandboxNoProxy();
    return server;
  }

  /** The tool message for `callId` in the model request that follows it. */
  function toolResultFor(server: FakeOpenAIServer, callId: string): string {
    const followUp = server.requests.find(
      (request) =>
        request.body['stream'] === true &&
        (request.body['messages'] as ToolMessage[]).some(
          (message) => message.role === 'tool',
        ),
    );
    const messages = (followUp?.body['messages'] ?? []) as ToolMessage[];
    const toolMessage = messages.find(
      (message) => message.role === 'tool' && message.tool_call_id === callId,
    );
    expect(toolMessage, 'no paired tool result was sent').toBeDefined();
    expect(
      JSON.stringify(messages.filter((message) => message.role === 'user')),
    ).not.toContain('P02A_');
    return JSON.stringify(toolMessage!.content);
  }

  function hookHits(): Array<{ event: string; call: string }> {
    const log = join(rig.testDir!, HITS_LOG);
    if (!existsSync(log)) return [];
    return readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  function count(text: string, needle: string): number {
    return text.split(needle).length - 1;
  }

  it('headless: delivers PreToolUse context with a successful result', async () => {
    const server = await setup(
      'hook context headless allow',
      'read_file',
      'note.txt',
      'call_allow',
    );
    await rig.run('read the note', ...fakeModelLaunchArgs(server));

    expect(hookHits()).toEqual([{ event: 'PreToolUse', call: 'call_allow' }]);
    const result = toolResultFor(server, 'call_allow');
    expect(result).toContain('hello from note');
    expect(count(result, 'P02A_PreToolUse_call_allow')).toBe(1);
  });

  it('headless: delivers PreToolUse context with a denied result', async () => {
    const server = await setup(
      'hook context headless deny',
      'read_file',
      'note.txt',
      'call_deny',
    );
    vi.stubEnv('P02A_PRE_DECISION', 'deny');
    await rig.run('read the note', ...fakeModelLaunchArgs(server));

    const result = toolResultFor(server, 'call_deny');
    expect(result).toContain('p02a policy');
    expect(result).not.toContain('hello from note');
    expect(count(result, 'P02A_PreToolUse_call_deny')).toBe(1);
  });

  it('headless: delivers nested exec PreToolUse context with the exec result', async () => {
    const server = await setup(
      'hook context headless nested exec',
      'exec',
      'note.txt',
      'call_exec',
      (filePath) => ({
        // Consumes the nested result without printing it.
        source: `const r = await tools.read_file({ file_path: ${JSON.stringify(filePath)} }); text(String(r).includes('P02A_') ? 'changed' : 'raw')`,
      }),
      { tools: { codeModeOnly: true } },
    );
    await rig.run('run the script', ...fakeModelLaunchArgs(server));

    expect(hookHits()).toEqual(
      expect.arrayContaining([
        { event: 'PreToolUse', call: 'call_exec' },
        { event: 'PreToolUse', call: 'call_exec:code:1' },
      ]),
    );
    const result = toolResultFor(server, 'call_exec');
    expect(result).toContain('raw');
    expect(result).not.toContain('changed');
    expect(count(result, 'P02A_PreToolUse_call_exec:code:1')).toBe(1);
  });

  it('interactive: delivers the first PreToolUse ask context once after approval', async () => {
    const server = await setup(
      'hook context interactive ask',
      'read_file',
      'note.txt',
      'call_ask',
    );
    vi.stubEnv('P02A_PRE_DECISION', 'ask');
    const { ptyProcess } = rig.runInteractive(...fakeModelLaunchArgs(server));
    let output = '';
    ptyProcess.onData((data) => {
      output += data;
    });
    const waitFor = makeWaitFor(rig, () => output);
    await waitFor('the CLI to start', () =>
      output.includes('Type your message'),
    );

    const prompt = 'read the note';
    ptyProcess.write(prompt);
    await waitFor('the prompt to echo', () => output.includes(prompt));
    ptyProcess.write('\r');
    await waitFor('the ask confirmation', () => output.includes('p02a policy'));
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

    expect(hookHits()).toEqual([{ event: 'PreToolUse', call: 'call_ask' }]);
    const result = toolResultFor(server, 'call_ask');
    expect(result).toContain('hello from note');
    expect(count(result, 'P02A_PreToolUse_call_ask')).toBe(1);
  });

  it('ACP: delivers PreToolUse and PostToolUseFailure context on a returned error', async () => {
    const server = await setup(
      'hook context acp failure',
      'read_file',
      'missing.txt',
      'call_fail',
    );
    const child = spawn(
      'node',
      [
        rig.bundlePath,
        '--acp',
        '--no-chat-recording',
        ...fakeModelLaunchArgs(server),
      ],
      { cwd: rig.testDir!, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const pending = new Map<number, (value: unknown) => void>();
    let nextId = 0;
    createInterface({ input: child.stdout! }).on('line', (line) => {
      let message: { id?: number; method?: string; result?: unknown };
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id === undefined) return;
      if (message.method === undefined) {
        pending.get(message.id)?.(message.result);
      } else {
        // Answer any client request (e.g. permission) so the turn proceeds.
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
      }
    });
    const request = <T>(method: string, params: unknown) =>
      new Promise<T>((resolve) => {
        const id = ++nextId;
        pending.set(id, (value) => resolve(value as T));
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
      await request('session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'read the missing note' }],
      });
    } finally {
      child.kill();
    }

    expect(hookHits()).toEqual([
      { event: 'PreToolUse', call: 'call_fail' },
      { event: 'PostToolUseFailure', call: 'call_fail' },
    ]);
    const result = toolResultFor(server, 'call_fail');
    expect(count(result, 'P02A_PreToolUse_call_fail')).toBe(1);
    expect(count(result, 'P02A_PostToolUseFailure_call_fail')).toBe(1);
  });
});
