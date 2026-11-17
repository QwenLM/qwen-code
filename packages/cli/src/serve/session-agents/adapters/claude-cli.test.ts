/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type {
  AgentAdapterEvent,
  AgentAdapterTurnInput,
  SessionAgentPermissionPrompt,
} from '@qwen-code/qwen-code-core/agents/session-agents/contract.js';
import type { AgentProcess, AgentSpawnOptions } from './agent-process.js';
import {
  buildClaudeArgs,
  claudeResumeWasRejected,
  createClaudeCliAdapter,
} from './claude-cli.js';

/** A child process whose stdio is in-memory; `onLine` scripts the CLI. */
class FakeClaude extends EventEmitter {
  readonly pid = undefined;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly written: Array<Record<string, unknown>> = [];
  readonly signals: string[] = [];

  constructor(
    onLine: (line: Record<string, unknown>, fake: FakeClaude) => void,
    exitOnStdinClose = true,
  ) {
    super();
    let buffer = '';
    this.stdin.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let index: number;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = JSON.parse(buffer.slice(0, index)) as Record<
          string,
          unknown
        >;
        buffer = buffer.slice(index + 1);
        this.written.push(line);
        onLine(line, this);
      }
    });
    // The CLI exits once stdin closes (after `result`).
    if (exitOnStdinClose) {
      this.stdin.on('finish', () => setImmediate(() => this.exit(0)));
    }
  }

  send(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(String(signal));
    this.exit(null, (signal as NodeJS.Signals) ?? 'SIGTERM');
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    this.emit('exit', code, signal);
  }
}

type Script = (line: Record<string, unknown>, fake: FakeClaude) => void;

function harness(scripts: Script[], exitOnStdinClose = true) {
  const spawns: Array<{
    command: string;
    args: string[];
    options: AgentSpawnOptions;
    fake: FakeClaude;
  }> = [];
  const spawn = (
    command: string,
    args: readonly string[],
    options: AgentSpawnOptions,
  ) => {
    const script = scripts[spawns.length] ?? scripts[scripts.length - 1]!;
    const fake = new FakeClaude(script, exitOnStdinClose);
    spawns.push({ command, args: [...args], options, fake });
    return fake as unknown as AgentProcess;
  };
  return { spawns, spawn };
}

function turnInput(overrides: Partial<AgentAdapterTurnInput> = {}) {
  const events: AgentAdapterEvent[] = [];
  const prompts: SessionAgentPermissionPrompt[] = [];
  const input: AgentAdapterTurnInput = {
    prompt: 'hello',
    cwd: '/work',
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
    awaitPermission: async (prompt) => {
      prompts.push(prompt);
      return 'allow_once';
    },
    ...overrides,
  };
  return { input, events, prompts };
}

const isUserTurn = (line: Record<string, unknown>) => line['type'] === 'user';

/** The text of the user turn written to a fake's stdin. */
function userText(fake: FakeClaude): unknown {
  const turn = fake.written.find(isUserTurn) as
    | { message?: { content?: ReadonlyArray<{ text?: string }> } }
    | undefined;
  return turn?.message?.content?.[0]?.text;
}

function completeTurn(sessionId: string, text = 'done'): Script {
  return (line, fake) => {
    if (!isUserTurn(line)) return;
    fake.send({ type: 'system', subtype: 'init', session_id: sessionId });
    fake.send({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'pondering' },
          { type: 'text', text: 'Looking. ' },
          {
            type: 'tool_use',
            id: 'tu_1',
            name: 'Bash',
            input: { command: 'ls -la' },
          },
        ],
      },
    });
    fake.send({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }],
      },
    });
    fake.send({
      type: 'assistant',
      message: { content: [{ type: 'text', text }] },
    });
    fake.send({
      type: 'result',
      subtype: 'success',
      result: text,
      is_error: false,
      session_id: sessionId,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
    });
  };
}

describe('claude-cli adapter', () => {
  it('builds argv without bypassing permissions', () => {
    const args = buildClaudeArgs({ model: 'sonnet', instructions: 'be terse' });
    expect(args).toEqual(
      expect.arrayContaining([
        '-p',
        '--output-format',
        'stream-json',
        '--input-format',
        'stream-json',
        '--verbose',
        '--permission-prompt-tool',
        'stdio',
      ]),
    );
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('default');
    expect(args).not.toContain('bypassPermissions');
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe('AskUserQuestion');
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('be terse');

    const resumed = buildClaudeArgs({
      resumeSessionId: 's1',
      instructions: 'be terse',
    });
    expect(resumed[resumed.indexOf('--resume') + 1]).toBe('s1');
    expect(resumed).not.toContain('--append-system-prompt');
  });

  it('runs a turn and maps the stream to events', async () => {
    const { spawn, spawns } = harness([completeTurn('sess-1', 'All done.')]);
    const adapter = createClaudeCliAdapter({
      executable: '/bin/claude',
      env: {
        PATH: '/bin',
        CLAUDECODE: '1',
        CLAUDECODE_X: '1',
        CLAUDE_CODE_USE_BEDROCK: '1',
      },
      spawn,
    });
    const { input, events } = turnInput({
      instructions: 'persona',
      model: 'opus',
    });
    const result = await adapter.runTurn(input);

    expect(result).toMatchObject({
      status: 'completed',
      outputText: 'All done.',
      nativeSessionId: 'sess-1',
      totalTokens: 17,
    });
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.command).toBe('/bin/claude');
    expect(spawns[0]!.options.cwd).toBe('/work');
    expect(spawns[0]!.options.env['CLAUDECODE']).toBeUndefined();
    expect(spawns[0]!.options.env['CLAUDECODE_X']).toBeUndefined();
    expect(spawns[0]!.options.env['CLAUDE_CODE_USE_BEDROCK']).toBe('1');
    expect(spawns[0]!.fake.written[0]).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    });
    expect(events).toContainEqual({
      type: 'native_session',
      nativeSessionId: 'sess-1',
    });
    expect(events).toContainEqual({ type: 'thought_delta', text: 'pondering' });
    expect(events).toContainEqual({ type: 'text_delta', text: 'Looking. ' });
    expect(events).toContainEqual({
      type: 'step',
      step: { id: 'tu_1', title: 'Bash: ls -la', status: 'running' },
    });
    expect(events).toContainEqual({
      type: 'step',
      step: { id: 'tu_1', title: 'Bash: ls -la', status: 'completed' },
    });
    expect(events).toContainEqual({ type: 'usage', totalTokens: 17 });
  });

  it('relays can_use_tool to awaitPermission and answers allow / deny', async () => {
    const script: Script = (line, fake) => {
      if (isUserTurn(line)) {
        fake.send({ type: 'system', session_id: 's' });
        fake.send({
          type: 'control_request',
          request_id: 'req-1',
          request: {
            subtype: 'can_use_tool',
            tool_name: 'Bash',
            input: { command: 'npm test', run_in_background: true },
          },
        });
        return;
      }
      if (line['type'] === 'control_response') {
        const response = line['response'] as { request_id: string };
        if (response.request_id === 'req-1') {
          fake.send({
            type: 'control_request',
            request_id: 'req-2',
            request: {
              subtype: 'can_use_tool',
              tool_name: 'Write',
              input: { file_path: '/a' },
            },
          });
        } else {
          fake.send({
            type: 'result',
            result: 'ok',
            is_error: false,
            session_id: 's',
          });
        }
      }
    };
    const { spawn, spawns } = harness([script]);
    const adapter = createClaudeCliAdapter({ spawn, env: {} });
    const answers = ['allow_once', 'reject_once'];
    const { input, events, prompts } = turnInput({
      awaitPermission: async (prompt) => {
        prompts.push(prompt);
        return answers.shift()!;
      },
    });
    const result = await adapter.runTurn(input);
    expect(result.status).toBe('completed');

    expect(prompts[0]).toMatchObject({
      requestId: 'req-1',
      title: 'Bash: npm test',
      toolName: 'Bash',
    });
    expect(prompts[0]!.options.map((option) => option.kind)).toEqual([
      'allow_once',
      'reject_once',
    ]);
    // The person approves the input that runs: background forced off.
    expect(JSON.parse(prompts[0]!.inputPreview!)).toEqual({
      command: 'npm test',
      run_in_background: false,
    });
    const responses = spawns[0]!.fake.written.filter(
      (line) => line['type'] === 'control_response',
    );
    expect(responses[0]).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req-1',
        response: {
          behavior: 'allow',
          updatedInput: { command: 'npm test', run_in_background: false },
        },
      },
    });
    expect(responses[1]).toMatchObject({
      response: { request_id: 'req-2', response: { behavior: 'deny' } },
    });
    expect(
      events.filter((event) => event.type === 'permission_resolved'),
    ).toHaveLength(2);
  });

  it('puts one permission to the person at a time', async () => {
    const script: Script = (line, fake) => {
      if (isUserTurn(line)) {
        for (const id of ['p1', 'p2']) {
          fake.send({
            type: 'control_request',
            request_id: id,
            request: {
              subtype: 'can_use_tool',
              tool_name: 'Edit',
              input: { file_path: id },
            },
          });
        }
        return;
      }
      const response = line['response'] as { request_id?: string } | undefined;
      if (response?.request_id === 'p2') {
        fake.send({ type: 'result', result: 'ok', session_id: 's' });
      }
    };
    const { spawn } = harness([script]);
    const pending: Array<(optionId: string) => void> = [];
    const { input, events } = turnInput({
      awaitPermission: () =>
        new Promise((resolve) => {
          pending.push(resolve);
        }),
    });
    const running = createClaudeCliAdapter({ spawn, env: {} }).runTurn(input);
    const requested = () =>
      events.flatMap((event) =>
        event.type === 'permission_request' ? [event.prompt.requestId] : [],
      );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requested()).toEqual(['p1']);
    pending[0]!('allow_once');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requested()).toEqual(['p1', 'p2']);
    pending[1]!('reject_once');
    expect((await running).status).toBe('completed');
  });

  it('never answers an unknown control_request with allow', async () => {
    const script: Script = (line, fake) => {
      if (isUserTurn(line)) {
        fake.send({
          type: 'control_request',
          request_id: 'x',
          request: { subtype: 'mystery' },
        });
        fake.send({ type: 'result', result: 'ok', session_id: 's' });
      }
    };
    const { spawn, spawns } = harness([script]);
    await createClaudeCliAdapter({ spawn, env: {} }).runTurn(turnInput().input);
    const response = spawns[0]!.fake.written.find(
      (line) => line['type'] === 'control_response',
    );
    expect(response).toMatchObject({
      response: { subtype: 'error', request_id: 'x' },
    });
    expect(JSON.stringify(response)).not.toContain('allow');
  });

  it('retries in a fresh session when the resume is rejected before any tool ran', async () => {
    const rejected: Script = (line, fake) => {
      if (!isUserTurn(line)) return;
      fake.send({ type: 'system', session_id: 'other' });
      fake.send({
        type: 'result',
        is_error: true,
        result: 'boom',
        session_id: 'other',
      });
    };
    const { spawn, spawns } = harness([rejected, completeTurn('fresh')]);
    const adapter = createClaudeCliAdapter({ spawn, env: {} });
    const result = await adapter.runTurn(
      turnInput({
        nativeSessionId: 'old',
        instructions: 'persona',
        prompt: 'delta',
        freshPrompt: 'whole conversation',
      }).input,
    );
    expect(spawns).toHaveLength(2);
    expect(spawns[0]!.args).toContain('--resume');
    expect(spawns[1]!.args).not.toContain('--resume');
    expect(spawns[1]!.args).toContain('--append-system-prompt');
    // The resumed session holds the history, so it gets the delta; the fresh
    // one holds none, so it gets the conversation from the start.
    expect(userText(spawns[0]!.fake)).toBe('delta');
    expect(userText(spawns[1]!.fake)).toBe('whole conversation');
    expect(result).toMatchObject({
      status: 'completed',
      nativeSessionId: 'fresh',
      resumeRejected: true,
    });
  });

  it('sends the prompt when there is no fresh prompt for the retry', async () => {
    const rejected: Script = (line, fake) => {
      if (!isUserTurn(line)) return;
      fake.send({
        type: 'result',
        is_error: true,
        result: 'No conversation found with session ID: old',
      });
    };
    const { spawn, spawns } = harness([rejected, completeTurn('fresh')]);
    const result = await createClaudeCliAdapter({ spawn, env: {} }).runTurn(
      turnInput({ nativeSessionId: 'old', prompt: 'delta' }).input,
    );
    expect(spawns).toHaveLength(2);
    expect(userText(spawns[1]!.fake)).toBe('delta');
    expect(result).toMatchObject({ status: 'completed', resumeRejected: true });
  });

  it('detects "no conversation found" on stderr as a rejected resume', () => {
    expect(
      claudeResumeWasRejected('old', undefined, true, [
        '',
        'No conversation found with session ID: old',
      ]),
    ).toBe(true);
    expect(claudeResumeWasRejected('old', 'old', true, ['rate limited'])).toBe(
      false,
    );
    expect(claudeResumeWasRejected(undefined, 'x', true, [])).toBe(false);
    expect(claudeResumeWasRejected('old', 'x', false, [])).toBe(false);
  });

  it('retires a saturated session even when prompt_too_long arrives as a clean success', async () => {
    const saturated: Script = (line, fake) => {
      if (!isUserTurn(line)) return;
      fake.send({ type: 'system', session_id: 'old' });
      fake.send({
        type: 'result',
        is_error: false,
        terminal_reason: 'prompt_too_long',
        result: '',
        session_id: 'old',
      });
    };
    const { spawn, spawns } = harness([saturated, completeTurn('fresh')]);
    const result = await createClaudeCliAdapter({ spawn, env: {} }).runTurn(
      turnInput({
        nativeSessionId: 'old',
        prompt: 'delta',
        freshPrompt: 'whole conversation',
      }).input,
    );
    expect(spawns).toHaveLength(2);
    expect(userText(spawns[1]!.fake)).toBe('whole conversation');
    expect(result).toMatchObject({ status: 'completed', resumeRejected: true });
  });

  it('fails without retrying when a fresh session overflows', async () => {
    const saturated: Script = (line, fake) => {
      if (!isUserTurn(line)) return;
      fake.send({
        type: 'result',
        is_error: true,
        terminal_reason: 'prompt_too_long',
        session_id: 's',
      });
    };
    const { spawn, spawns } = harness([saturated]);
    const result = await createClaudeCliAdapter({ spawn, env: {} }).runTurn(
      turnInput().input,
    );
    expect(spawns).toHaveLength(1);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('prompt_too_long');
  });

  it('does not retry fresh when a tool already ran', async () => {
    const rejectedAfterTool: Script = (line, fake) => {
      if (!isUserTurn(line)) return;
      fake.send({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }],
        },
      });
      fake.send({
        type: 'result',
        is_error: true,
        result: 'No conversation found',
        session_id: 'x',
      });
    };
    const { spawn, spawns } = harness([rejectedAfterTool]);
    const result = await createClaudeCliAdapter({ spawn, env: {} }).runTurn(
      turnInput({ nativeSessionId: 'old' }).input,
    );
    expect(spawns).toHaveLength(1);
    expect(result).toMatchObject({ status: 'failed', resumeRejected: true });
    expect(result.nativeSessionId).toBeUndefined();
  });

  it('writes the session_send MCP config to a private temp file and removes it', async () => {
    let seen = undefined as
      | { path: string; content: unknown; mode: number }
      | undefined;
    const { spawn, spawns } = harness([completeTurn('s')]);
    const spy = (
      command: string,
      args: readonly string[],
      options: AgentSpawnOptions,
    ) => {
      const path = args[args.indexOf('--mcp-config') + 1]!;
      seen = {
        path,
        content: JSON.parse(readFileSync(path, 'utf8')),
        mode: statSync(path).mode & 0o777,
      };
      return spawn(command, args, options);
    };
    await createClaudeCliAdapter({ spawn: spy, env: {} }).runTurn(
      turnInput({
        sessionSendServer: {
          command: '/usr/bin/node',
          args: [
            '/cli.js',
            'agents',
            'session-send-mcp',
            '--url',
            'http://127.0.0.1:1/x',
          ],
          env: { QWEN_SESSION_SEND_TOKEN: 'tok' },
        },
      }).input,
    );
    expect(spawns).toHaveLength(1);
    expect(seen!.content).toEqual({
      mcpServers: {
        'qwen-session': {
          command: '/usr/bin/node',
          args: [
            '/cli.js',
            'agents',
            'session-send-mcp',
            '--url',
            'http://127.0.0.1:1/x',
          ],
          env: { QWEN_SESSION_SEND_TOKEN: 'tok' },
        },
      },
    });
    if (process.platform !== 'win32') expect(seen!.mode).toBe(0o600);
    expect(existsSync(seen!.path)).toBe(false);
  });

  it('cancels by closing stdin and terminating the process', async () => {
    const controller = new AbortController();
    const hang: Script = (line, fake) => {
      if (!isUserTurn(line)) return;
      fake.send({ type: 'system', session_id: 's' });
      fake.send({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'partial' }] },
      });
      setImmediate(() => controller.abort());
    };
    // Exits only on a signal, not on stdin close.
    const { spawn, spawns } = harness([hang], false);
    const result = await createClaudeCliAdapter({
      spawn,
      env: {},
      terminateGraceMs: 10,
    }).runTurn(turnInput({ signal: controller.signal }).input);
    expect(result).toMatchObject({
      status: 'cancelled',
      outputText: 'partial',
    });
    expect(spawns[0]!.fake.signals).toContain('SIGTERM');
  });

  it('reports a missing executable as a failed turn', async () => {
    const result = await createClaudeCliAdapter({
      spawn: () => {
        const fake = new FakeClaude(() => {});
        setImmediate(() => {
          fake.emit('error', new Error('spawn claude ENOENT'));
          fake.stdout.destroy();
        });
        return fake as unknown as AgentProcess;
      },
      env: {},
    }).runTurn(turnInput().input);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('ENOENT');
  });
});
