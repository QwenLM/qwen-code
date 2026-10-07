/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type {
  AgentAdapterEvent,
  AgentAdapterTurnInput,
  SessionAgentPermissionPrompt,
} from '@qwen-code/qwen-code-core/agents/session-agents/contract.js';
import type { AgentProcess, AgentSpawnOptions } from './agent-process.js';
import {
  buildCodexArgs,
  codexApprovalResponse,
  CodexTurnGate,
  createCodexAppServerAdapter,
} from './codex-app-server.js';

type Message = Record<string, unknown>;

/** An in-memory `codex app-server`: `onMessage` scripts its JSON-RPC side. */
class FakeCodex extends EventEmitter {
  readonly pid = undefined;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly received: Message[] = [];

  constructor(
    private readonly onMessage: (message: Message, fake: FakeCodex) => void,
  ) {
    super();
    let buffer = '';
    this.stdin.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let index: number;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const message = JSON.parse(buffer.slice(0, index)) as Message;
        buffer = buffer.slice(index + 1);
        this.received.push(message);
        this.onMessage(message, this);
      }
    });
  }

  send(message: Message): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  reply(request: Message, result: unknown): void {
    this.send({ id: request['id'], result });
  }

  notify(method: string, params: Message): void {
    this.send({ method, params });
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    if (this.exitCode !== null || this.signalCode !== null) return true;
    this.signalCode = (signal as NodeJS.Signals) ?? 'SIGTERM';
    this.stdout.end();
    this.stderr.end();
    this.emit('exit', null, this.signalCode);
    return true;
  }
}

type Script = (message: Message, fake: FakeCodex) => void;

function harness(scripts: Script[]) {
  const spawns: Array<{
    args: string[];
    options: AgentSpawnOptions;
    fake: FakeCodex;
  }> = [];
  const spawn = (
    _command: string,
    args: readonly string[],
    options: AgentSpawnOptions,
  ) => {
    const fake = new FakeCodex(
      scripts[spawns.length] ?? scripts[scripts.length - 1]!,
    );
    spawns.push({ args: [...args], options, fake });
    return fake as unknown as AgentProcess;
  };
  return { spawns, spawn };
}

function turnInput(overrides: Partial<AgentAdapterTurnInput> = {}) {
  const events: AgentAdapterEvent[] = [];
  const input: AgentAdapterTurnInput = {
    prompt: 'do it',
    cwd: '/work',
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
    awaitPermission: async () => 'allow_once',
    ...overrides,
  };
  return { input, events };
}

/** The text the adapter sent with `turn/start`. */
function turnText(fake: FakeCodex): unknown {
  const request = fake.received.find(
    (message) => message['method'] === 'turn/start',
  );
  const params = request?.['params'] as
    | { input?: ReadonlyArray<{ text?: string }> }
    | undefined;
  return params?.input?.[0]?.text;
}

/** Handshake + thread setup; `onTurn` runs when turn/start arrives. */
function codexScript(options: {
  thread?: string;
  resume?: (request: Message, fake: FakeCodex) => void;
  onTurn: (request: Message, fake: FakeCodex) => void;
  onOther?: (message: Message, fake: FakeCodex) => void;
}): Script {
  return (message, fake) => {
    switch (message['method']) {
      case 'initialize':
        fake.reply(message, { userAgent: 'codex' });
        return;
      case 'initialized':
        return;
      case 'thread/resume':
        if (options.resume) options.resume(message, fake);
        else
          fake.reply(message, {
            thread: { id: (message['params'] as Message)['threadId'] },
          });
        return;
      case 'thread/start':
        fake.reply(message, { thread: { id: options.thread ?? 'th_new' } });
        return;
      case 'turn/start':
        options.onTurn(message, fake);
        return;
      default:
        options.onOther?.(message, fake);
    }
  };
}

function finishTurn(fake: FakeCodex, threadId: string, text = 'final'): void {
  fake.notify('turn/started', { threadId, turn: { id: 'turn_1' } });
  fake.notify('item/started', {
    threadId,
    turnId: 'turn_1',
    item: { type: 'commandExecution', id: 'cmd_1', command: 'ls' },
  });
  fake.notify('item/completed', {
    threadId,
    turnId: 'turn_1',
    item: {
      type: 'commandExecution',
      id: 'cmd_1',
      command: 'ls',
      status: 'completed',
    },
  });
  fake.notify('item/completed', {
    threadId,
    turnId: 'turn_1',
    item: { type: 'agentMessage', id: 'm1', text: 'narration' },
  });
  fake.notify('item/completed', {
    threadId,
    turnId: 'turn_1',
    item: { type: 'agentMessage', id: 'm2', text, phase: 'final_answer' },
  });
  fake.notify('turn/completed', {
    threadId,
    turn: {
      id: 'turn_1',
      status: 'completed',
      usage: { input_tokens: 7, output_tokens: 3 },
    },
  });
}

describe('codex-app-server adapter', () => {
  it('starts a thread on-request and returns the final answer', async () => {
    const { spawn, spawns } = harness([
      codexScript({
        onTurn: (request, fake) => {
          fake.reply(request, {});
          finishTurn(fake, 'th_new', 'The answer.');
        },
      }),
    ]);
    const { input, events } = turnInput({
      instructions: 'persona',
      model: 'gpt-5',
    });
    const result = await createCodexAppServerAdapter({
      spawn,
      env: {},
    }).runTurn(input);

    expect(result).toMatchObject({
      status: 'completed',
      outputText: 'The answer.',
      nativeSessionId: 'th_new',
      totalTokens: 10,
    });
    expect(result.resumeRejected).toBeUndefined();
    const received = spawns[0]!.fake.received;
    expect(received.map((message) => message['method'])).toEqual([
      'initialize',
      'initialized',
      'thread/start',
      'turn/start',
    ]);
    expect(received[0]!['params']).toMatchObject({
      capabilities: { experimentalApi: true },
    });
    expect(received[2]!['params']).toMatchObject({
      cwd: '/work',
      model: 'gpt-5',
      approvalPolicy: 'on-request',
      developerInstructions: 'persona',
      persistExtendedHistory: true,
    });
    expect(received[3]!['params']).toEqual({
      threadId: 'th_new',
      input: [{ type: 'text', text: 'do it' }],
    });
    expect(events).toContainEqual({
      type: 'native_session',
      nativeSessionId: 'th_new',
    });
    expect(events).toContainEqual({
      type: 'step',
      step: { id: 'cmd_1', title: 'exec_command: ls', status: 'running' },
    });
    expect(events).toContainEqual({
      type: 'step',
      step: { id: 'cmd_1', title: 'exec_command: ls', status: 'completed' },
    });
    expect(events).toContainEqual({ type: 'text_delta', text: 'narration' });
    expect(events).toContainEqual({ type: 'text_delta', text: 'The answer.' });
  });

  it('resumes, drops replay before turn/start and foreign threads', async () => {
    const { spawn, spawns } = harness([
      codexScript({
        resume: (request, fake) => {
          // History replayed during resume: before the gate is armed.
          fake.notify('item/completed', {
            threadId: 'th_old',
            item: {
              type: 'agentMessage',
              id: 'r',
              text: 'replayed',
              phase: 'final_answer',
            },
          });
          fake.reply(request, { thread: { id: 'th_old' } });
        },
        onTurn: (request, fake) => {
          fake.reply(request, {});
          fake.notify('item/completed', {
            threadId: 'th_sub',
            item: {
              type: 'agentMessage',
              id: 's',
              text: 'subagent',
              phase: 'final_answer',
            },
          });
          finishTurn(fake, 'th_old');
        },
      }),
    ]);
    const { input, events } = turnInput({
      nativeSessionId: 'th_old',
      prompt: 'delta',
      freshPrompt: 'whole conversation',
    });
    const result = await createCodexAppServerAdapter({
      spawn,
      env: {},
    }).runTurn(input);
    expect(result).toMatchObject({
      status: 'completed',
      outputText: 'final',
      nativeSessionId: 'th_old',
    });
    expect(result.resumeRejected).toBeUndefined();
    // The resumed thread holds the history: it gets only the delta.
    expect(turnText(spawns[0]!.fake)).toBe('delta');
    const texts = events.flatMap((event) =>
      event.type === 'text_delta' ? [event.text] : [],
    );
    expect(texts).not.toContain('replayed');
    expect(texts).not.toContain('subagent');
    // The approval contract is re-pinned on resume, not trusted to persist.
    const resume = spawns[0]!.fake.received.find(
      (message) => message['method'] === 'thread/resume',
    );
    expect(resume!['params']).toMatchObject({
      threadId: 'th_old',
      approvalPolicy: 'on-request',
      sandbox: 'read-only',
    });
  });

  it('falls back to thread/start when thread/resume is refused', async () => {
    const { spawn, spawns } = harness([
      codexScript({
        thread: 'th_fresh',
        resume: (request, fake) =>
          fake.send({
            id: request['id'],
            error: { code: -32600, message: 'no such thread' },
          }),
        onTurn: (request, fake) => {
          fake.reply(request, {});
          finishTurn(fake, 'th_fresh');
        },
      }),
    ]);
    const result = await createCodexAppServerAdapter({
      spawn,
      env: {},
    }).runTurn(
      turnInput({
        nativeSessionId: 'th_gone',
        prompt: 'delta',
        freshPrompt: 'whole conversation',
      }).input,
    );
    expect(spawns).toHaveLength(1);
    // The fresh thread holds none of the history: it gets all of it now.
    expect(turnText(spawns[0]!.fake)).toBe('whole conversation');
    expect(result).toMatchObject({
      status: 'completed',
      nativeSessionId: 'th_fresh',
      resumeRejected: true,
    });
  });

  it('holds an approval request until the person answers', async () => {
    let answer!: (optionId: string) => void;
    const prompts: SessionAgentPermissionPrompt[] = [];
    let fakeRef!: FakeCodex;
    const { spawn } = harness([
      codexScript({
        onTurn: (request, fake) => {
          fakeRef = fake;
          fake.reply(request, {});
          fake.notify('turn/started', {
            threadId: 'th_new',
            turn: { id: 'turn_1' },
          });
          fake.send({
            id: 99,
            method: 'item/commandExecution/requestApproval',
            params: {
              threadId: 'th_new',
              turnId: 'turn_1',
              itemId: 'cmd',
              command: 'rm -rf build',
            },
          });
        },
        onOther: (message, fake) => {
          if (message['id'] === 99) {
            finishTurn(fake, 'th_new');
          }
        },
      }),
    ]);
    const { input, events } = turnInput({
      awaitPermission: (prompt) => {
        prompts.push(prompt);
        return new Promise((resolve) => {
          answer = resolve;
        });
      },
    });
    const running = createCodexAppServerAdapter({ spawn, env: {} }).runTurn(
      input,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(prompts[0]).toMatchObject({
      requestId: '99',
      title: 'exec_command: rm -rf build',
      toolName: 'exec_command',
    });
    expect(events).toContainEqual({
      type: 'permission_request',
      prompt: prompts[0],
    });
    expect(fakeRef.received.some((message) => message['id'] === 99)).toBe(
      false,
    );

    answer('allow_once');
    const result = await running;
    expect(fakeRef.received.find((message) => message['id'] === 99)).toEqual({
      jsonrpc: '2.0',
      id: 99,
      result: { decision: 'accept' },
    });
    expect(events).toContainEqual({
      type: 'permission_resolved',
      requestId: '99',
    });
    expect(result.status).toBe('completed');
  });

  it('puts one approval to the person at a time', async () => {
    const pending: Array<(optionId: string) => void> = [];
    let fakeRef!: FakeCodex;
    const { spawn } = harness([
      codexScript({
        onTurn: (request, fake) => {
          fakeRef = fake;
          fake.reply(request, {});
          fake.notify('turn/started', {
            threadId: 'th_new',
            turn: { id: 'turn_1' },
          });
          for (const id of [98, 99]) {
            fake.send({
              id,
              method: 'item/fileChange/requestApproval',
              params: {
                threadId: 'th_new',
                turnId: 'turn_1',
                itemId: `f${id}`,
              },
            });
          }
        },
        onOther: (message, fake) => {
          if (message['id'] === 99) finishTurn(fake, 'th_new');
        },
      }),
    ]);
    const { input, events } = turnInput({
      awaitPermission: () =>
        new Promise((resolve) => {
          pending.push(resolve);
        }),
    });
    const running = createCodexAppServerAdapter({ spawn, env: {} }).runTurn(
      input,
    );
    const requested = () =>
      events.flatMap((event) =>
        event.type === 'permission_request' ? [event.prompt.requestId] : [],
      );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requested()).toEqual(['98']);
    pending[0]!('allow_once');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requested()).toEqual(['98', '99']);
    expect(
      fakeRef.received.find((message) => message['id'] === 98),
    ).toMatchObject({
      result: { decision: 'accept' },
    });
    pending[1]!('reject_once');
    expect((await running).status).toBe('completed');
    expect(
      fakeRef.received.find((message) => message['id'] === 99),
    ).toMatchObject({
      result: { decision: 'decline' },
    });
  });

  it('maps decisions per request kind', () => {
    expect(
      codexApprovalResponse(
        'item/fileChange/requestApproval',
        {},
        'reject_once',
      ),
    ).toEqual({
      decision: 'decline',
    });
    expect(
      codexApprovalResponse(
        'item/commandExecution/requestApproval',
        {},
        'allow_always',
      ),
    ).toEqual({ decision: 'acceptForSession' });
    expect(
      codexApprovalResponse('execCommandApproval', {}, 'allow_once'),
    ).toEqual({
      decision: 'approved',
    });
    expect(
      codexApprovalResponse(
        'item/permissions/requestApproval',
        { permissions: { network: { enabled: true }, other: 1 } },
        'allow_once',
      ),
    ).toEqual({ permissions: { network: { enabled: true } }, scope: 'turn' });
    expect(
      codexApprovalResponse('mcpServer/elicitation/request', {}, undefined),
    ).toEqual({
      action: 'decline',
      content: null,
    });
  });

  it('answers an unknown server request with -32601', async () => {
    let fakeRef!: FakeCodex;
    const { spawn } = harness([
      codexScript({
        onTurn: (request, fake) => {
          fakeRef = fake;
          fake.reply(request, {});
          fake.send({ id: 7, method: 'something/new', params: {} });
        },
        onOther: (message, fake) => {
          if (message['id'] === 7) finishTurn(fake, 'th_new');
        },
      }),
    ]);
    const result = await createCodexAppServerAdapter({
      spawn,
      env: {},
    }).runTurn(turnInput().input);
    expect(
      fakeRef.received.find((message) => message['id'] === 7),
    ).toMatchObject({
      error: { code: -32601 },
    });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('something/new');
  });

  it('retires a thread whose resume response overflows the line cap', async () => {
    const { spawn, spawns } = harness([
      codexScript({
        resume: (request, fake) =>
          fake.reply(request, {
            thread: { id: 'th_big', turns: 'x'.repeat(5_000) },
          }),
        onTurn: () => {},
      }),
      codexScript({
        thread: 'th_fresh',
        onTurn: (request, fake) => {
          fake.reply(request, {});
          finishTurn(fake, 'th_fresh');
        },
      }),
    ]);
    const result = await createCodexAppServerAdapter({
      spawn,
      env: {},
      maxLineBytes: 1_000,
      timeouts: { terminateGraceMs: 10 },
    }).runTurn(
      turnInput({
        nativeSessionId: 'th_big',
        prompt: 'delta',
        freshPrompt: 'whole conversation',
      }).input,
    );
    expect(spawns).toHaveLength(2);
    expect(turnText(spawns[1]!.fake)).toBe('whole conversation');
    expect(
      spawns[1]!.fake.received.map((message) => message['method']),
    ).toContain('thread/start');
    expect(result).toMatchObject({
      status: 'completed',
      nativeSessionId: 'th_fresh',
      resumeRejected: true,
    });
  });

  it('fails a turn that makes no progress', async () => {
    const { spawn } = harness([
      codexScript({ onTurn: (request, fake) => fake.reply(request, {}) }),
    ]);
    const result = await createCodexAppServerAdapter({
      spawn,
      env: {},
      timeouts: { firstTurnNoProgressMs: 20, terminateGraceMs: 10 },
    }).runTurn(turnInput().input);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('no progress');
  });

  it('cancels with turn/interrupt and stops the process', async () => {
    const controller = new AbortController();
    const { spawn, spawns } = harness([
      codexScript({
        onTurn: (request, fake) => {
          fake.reply(request, {});
          fake.notify('turn/started', {
            threadId: 'th_new',
            turn: { id: 'turn_1' },
          });
          setImmediate(() => controller.abort());
        },
        onOther: (message, fake) => {
          if (message['method'] === 'turn/interrupt') {
            fake.reply(message, {});
            fake.notify('turn/completed', {
              threadId: 'th_new',
              turn: { id: 'turn_1', status: 'interrupted' },
            });
          }
        },
      }),
    ]);
    const result = await createCodexAppServerAdapter({
      spawn,
      env: {},
      timeouts: { terminateGraceMs: 10 },
    }).runTurn(turnInput({ signal: controller.signal }).input);
    expect(result.status).toBe('cancelled');
    expect(
      spawns[0]!.fake.received.find((m) => m['method'] === 'turn/interrupt')?.[
        'params'
      ],
    ).toEqual({
      threadId: 'th_new',
      turnId: 'turn_1',
    });
    expect(spawns[0]!.fake.signalCode).toBe('SIGTERM');
  });

  it('a cancel during thread setup never sends turn/start', async () => {
    const controller = new AbortController();
    const { spawn, spawns } = harness([
      (message, fake) => {
        if (message['method'] === 'initialize') {
          fake.reply(message, { userAgent: 'codex' });
        }
        // thread/start is never answered: the cancel must unwind it.
        if (message['method'] === 'thread/start') controller.abort();
      },
    ]);
    const { input, events } = turnInput({ signal: controller.signal });
    const result = await createCodexAppServerAdapter({
      spawn,
      env: {},
      timeouts: { terminateGraceMs: 10 },
    }).runTurn(input);
    expect(result.status).toBe('cancelled');
    expect(result.error).toBeUndefined();
    const methods = spawns[0]!.fake.received.map((m) => m['method']);
    expect(methods).toEqual(['initialize', 'initialized', 'thread/start']);
    expect(events.map((event) => event.type)).not.toContain('native_session');
    expect(spawns[0]!.fake.signalCode).toBe('SIGTERM');
  });

  it('interrupts a turn cancelled before its id was known', async () => {
    const controller = new AbortController();
    const { spawn, spawns } = harness([
      codexScript({
        onTurn: (request, fake) => {
          // Cancelled while turn/start is in flight: no turn id yet.
          controller.abort();
          fake.reply(request, { turn: { id: 'turn_1' } });
          fake.notify('turn/started', {
            threadId: 'th_new',
            turn: { id: 'turn_1' },
          });
        },
        onOther: (message, fake) => {
          if (message['method'] === 'turn/interrupt') {
            fake.reply(message, {});
            fake.notify('turn/completed', {
              threadId: 'th_new',
              turn: { id: 'turn_1', status: 'interrupted' },
            });
          }
        },
      }),
    ]);
    const result = await createCodexAppServerAdapter({
      spawn,
      env: {},
      timeouts: { terminateGraceMs: 10 },
    }).runTurn(turnInput({ signal: controller.signal }).input);
    expect(result.status).toBe('cancelled');
    const interrupts = spawns[0]!.fake.received.filter(
      (m) => m['method'] === 'turn/interrupt',
    );
    expect(interrupts.map((m) => m['params'])).toEqual([
      { threadId: 'th_new', turnId: 'turn_1' },
    ]);
    expect(spawns[0]!.fake.signalCode).toBe('SIGTERM');
  });

  it('unwinds a cancelled turn/start that is never answered', async () => {
    const controller = new AbortController();
    const { spawn, spawns } = harness([
      codexScript({
        // turn/start hangs: no response, no turn/started.
        onTurn: () => controller.abort(),
      }),
    ]);
    const result = await createCodexAppServerAdapter({
      spawn,
      env: {},
      // The handshake timeout stays long: the cancel must not wait it out.
      timeouts: { interruptMs: 20, handshakeMs: 60_000, terminateGraceMs: 10 },
    }).runTurn(turnInput({ signal: controller.signal }).input);
    expect(result.status).toBe('cancelled');
    expect(
      spawns[0]!.fake.received.some((m) => m['method'] === 'turn/interrupt'),
    ).toBe(false);
    expect(spawns[0]!.fake.signalCode).toBe('SIGTERM');
  });

  it('adds the session_send MCP server with -c overrides', () => {
    expect(
      buildCodexArgs({
        command: 'C:\\node.exe',
        args: ['cli.js', '--url', 'http://127.0.0.1:1/x'],
        env: { QWEN_SESSION_SEND_TOKEN: 'tok', 'bad key': 'x' },
      }),
    ).toEqual([
      'app-server',
      '--listen',
      'stdio://',
      '-c',
      'mcp_servers.qwen-session.command="C:\\\\node.exe"',
      '-c',
      'mcp_servers.qwen-session.args=["cli.js","--url","http://127.0.0.1:1/x"]',
      '-c',
      'mcp_servers.qwen-session.env.QWEN_SESSION_SEND_TOKEN="tok"',
    ]);
  });

  it('gates notifications to the current turn', () => {
    const gate = new CodexTurnGate();
    expect(gate.accept('item/completed', {})).toBe(false);
    gate.arm();
    expect(gate.accept('turn/started', { turn: { id: 't2' } })).toBe(true);
    expect(gate.accept('item/completed', { turnId: 't1' })).toBe(false);
    expect(gate.accept('item/completed', { turnId: 't2' })).toBe(true);
    expect(gate.accept('turn/completed', { turn: { id: 't1' } })).toBe(false);
    expect(gate.accept('error', {})).toBe(true);
  });
});
