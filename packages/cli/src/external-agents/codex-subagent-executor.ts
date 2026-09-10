/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { ProcessRegistry } from '@qwen-code/acp-bridge/processRegistry';
import { sanitizeChildEnv } from '@qwen-code/qwen-code-core';
import { createDebugLogger } from '@qwen-code/qwen-code-core/utils/debugLogger.js';
import {
  AgentEventEmitter,
  AgentEventType,
  AgentTerminateMode,
  renderSubagentSystemPrompt,
  type AgentExternalInput,
  type AgentStatsSummary,
  type ContextState,
  type ExternalAgentExecutor,
  type ExternalAgentExecutorParams,
  type SubagentExecutor,
  type SubagentExecutorCore,
} from '@qwen-code/qwen-code-core/subagentRuntime';
import {
  isExpectedExternalAgentCleanupExit,
  isUnprovenExternalAgentTreeExit,
} from './acp-subagent-executor.js';

const debugLogger = createDebugLogger('EXTERNAL_AGENT');
type JsonObject = Record<string, unknown>;
class CodexInterruption extends Error {
  constructor(
    readonly mode: AgentTerminateMode.CANCELLED | AgentTerminateMode.TIMEOUT,
  ) {
    super(
      mode === AgentTerminateMode.TIMEOUT
        ? 'Codex task exceeded its time limit.'
        : 'Codex task cancelled.',
    );
  }
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Codex returned an invalid protocol object.');
  }
  return value as JsonObject;
}

function id(value: unknown): string {
  if (typeof value !== 'string' || !value) {
    throw new Error('Codex returned an invalid thread or turn ID.');
  }
  return value;
}

async function runCodex(
  params: ExternalAgentExecutorParams,
  prompt: string,
  sandbox: string,
  signal: AbortSignal,
): Promise<string> {
  if (signal.aborted) throw new CodexInterruption(AgentTerminateMode.CANCELLED);
  const env = sanitizeChildEnv(process.env);
  delete env['CODEX_THREAD_ID'];
  delete env['CLAUDECODE'];
  delete env['NODE_OPTIONS'];
  const child = spawn(
    params.spec.command,
    params.spec.args ?? ['app-server', '--stdio'],
    {
      cwd: params.runtimeContext.getTargetDir(),
      env,
      stdio: 'pipe',
      detached: process.platform !== 'win32',
      windowsHide: true,
    },
  );
  const tracked = new ProcessRegistry().reserve().attach(child, {
    ownsProcessTree: true,
  });
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map<
    number,
    { resolve: (result: JsonObject) => void; reject: (error: Error) => void }
  >();
  let sequence = 0;
  let threadId: string | undefined;
  let turnId: string | undefined;
  let finalAnswer: string | undefined;
  let unphasedAnswer: string | undefined;
  let terminal = false;
  let exitDrainTimer: ReturnType<typeof setTimeout> | undefined;
  let fail!: (error: Error) => void;
  const failure = new Promise<never>((_resolve, reject) => {
    fail = reject;
  });
  let complete!: (turn: JsonObject) => void;
  const completed = new Promise<JsonObject>((resolve) => {
    complete = resolve;
  });
  const write = (frame: JsonObject) => {
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  };
  const request = (
    method: string,
    parameters: JsonObject,
  ): Promise<JsonObject> => {
    const requestId = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      write({ id: requestId, method, params: parameters });
    });
  };
  const abort = () => {
    if (threadId && turnId) {
      void request('turn/interrupt', { threadId, turnId }).catch(() => {});
    }
    fail(new CodexInterruption(AgentTerminateMode.CANCELLED));
  };
  signal.addEventListener('abort', abort, { once: true });
  child.once('error', (error: NodeJS.ErrnoException) => {
    fail(
      new Error(
        error.code === 'ENOENT'
          ? `Cannot start ${params.spec.command}. Install Codex and make it available on PATH.`
          : `Cannot start Codex: ${error.code ?? 'process error'}`,
      ),
    );
  });
  const onExit = (code: number | null, exitSignal: NodeJS.Signals | null) => {
    // Drain buffered output, but do not wait forever on a descendant's pipe.
    exitDrainTimer = setTimeout(
      () =>
        fail(
          new Error(`Codex exited before completion (${exitSignal ?? code}).`),
        ),
      10_000,
    );
  };
  child.once('exit', onExit);
  child.stdin.on('error', () => fail(new Error('Codex input stream closed.')));
  child.stdout.on('error', () =>
    fail(new Error('Codex output stream failed.')),
  );
  const associateTurn = (value: unknown) => {
    const observed = id(value);
    if (turnId && observed !== turnId)
      throw new Error('Codex returned another turn.');
    turnId = observed;
  };
  lines.on('line', (line) => {
    try {
      const frame = object(JSON.parse(line));
      if (typeof frame['method'] !== 'string') {
        const reply = pending.get(frame['id'] as number);
        if (!reply) return;
        pending.delete(frame['id'] as number);
        if (frame['error'])
          reply.reject(new Error('Codex rejected an app-server request.'));
        else reply.resolve(object(frame['result']));
        return;
      }
      const method = frame['method'];
      const parameters = object(frame['params'] ?? {});
      if (frame['id'] !== undefined) {
        let result: JsonObject;
        switch (method) {
          case 'item/commandExecution/requestApproval':
          case 'item/fileChange/requestApproval': {
            const available = parameters['availableDecisions'];
            const decision = Array.isArray(available)
              ? available.includes('decline')
                ? 'decline'
                : available.includes('cancel')
                  ? 'cancel'
                  : undefined
              : 'decline';
            if (!decision)
              throw new Error('Codex offered no unattended rejection.');
            result = { decision };
            break;
          }
          case 'item/permissions/requestApproval':
            result = { permissions: {}, scope: 'turn' };
            break;
          case 'item/tool/requestUserInput':
            result = { answers: {} };
            break;
          case 'mcpServer/elicitation/request':
            result = { action: 'decline', content: null, _meta: null };
            break;
          default:
            write({
              id: frame['id'],
              error: {
                code: -32601,
                message: 'Unsupported unattended request.',
              },
            });
            throw new Error(
              `Codex requested unsupported interaction: ${method}`,
            );
        }
        write({ id: frame['id'], result });
        return;
      }
      if (!threadId || parameters['threadId'] !== threadId) return;
      if (method === 'turn/started' || method === 'turn/completed') {
        const turn = object(parameters['turn']);
        associateTurn(turn['id']);
        if (method === 'turn/completed') {
          terminal = true;
          complete(turn);
        }
      } else if (method === 'item/completed') {
        associateTurn(parameters['turnId']);
        const item = object(parameters['item']);
        if (item['type'] !== 'agentMessage') return;
        if (typeof item['text'] !== 'string')
          throw new Error('Codex returned an invalid message.');
        if (item['phase'] === 'final_answer') finalAnswer = item['text'];
        else if (item['phase'] == null) unphasedAnswer = item['text'];
      }
    } catch (error) {
      fail(
        error instanceof Error
          ? error
          : new Error('Invalid Codex protocol frame.'),
      );
    }
  });
  lines.on('close', () => {
    if (!terminal || pending.size > 0)
      fail(new Error('Codex protocol closed before completion.'));
  });
  const initTimer = setTimeout(
    () => fail(new Error('Codex initialization timed out.')),
    10_000,
  );
  const minutes = params.runConfig.max_time_minutes;
  const executionTimer =
    minutes === undefined
      ? undefined
      : setTimeout(
          () => fail(new CodexInterruption(AgentTerminateMode.TIMEOUT)),
          minutes * 60_000,
        );
  const run = async () => {
    await request('initialize', {
      clientInfo: { name: 'qwen-code', version: '1.0.0' },
      capabilities: { experimentalApi: false },
    });
    write({ method: 'initialized' });
    const started = await request('thread/start', {
      cwd: params.runtimeContext.getTargetDir(),
      ephemeral: true,
      approvalPolicy: 'never',
      sandbox,
    });
    const thread = object(started['thread']);
    threadId = id(thread['id']);
    if (thread['ephemeral'] !== true)
      throw new Error('Codex did not create an ephemeral thread.');
    clearTimeout(initTimer);
    const startedTurn = await request('turn/start', {
      threadId,
      input: [{ type: 'text', text: prompt, text_elements: [] }],
    });
    associateTurn(object(startedTurn['turn'])['id']);
    const turn = await completed;
    if (turn['status'] !== 'completed')
      throw new Error(
        `Codex turn ended with status ${String(turn['status'])}.`,
      );
    const answer = finalAnswer ?? unphasedAnswer;
    if (!answer?.trim())
      throw new Error('Codex completed without a final answer.');
    return answer;
  };
  try {
    return await Promise.race([run(), failure]);
  } finally {
    clearTimeout(initTimer);
    clearTimeout(executionTimer);
    clearTimeout(exitDrainTimer);
    child.removeListener('exit', onExit);
    signal.removeEventListener('abort', abort);
    lines.close();
    for (const reply of pending.values())
      reply.reject(new Error('Codex connection closed.'));
    pending.clear();
    await tracked
      .terminate()
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        if (isUnprovenExternalAgentTreeExit(error)) {
          const diagnostic = `Codex process tree not proven gone after cleanup: ${detail}`;
          debugLogger.warn(diagnostic);
          if (params.eventEmitter?.rawListeners(AgentEventType.ERROR).length) {
            params.eventEmitter.emit(AgentEventType.ERROR, {
              subagentId: params.subagentId ?? params.name,
              error: diagnostic,
              timestamp: Date.now(),
            });
          }
        } else if (!isExpectedExternalAgentCleanupExit(error)) {
          throw new Error(`Codex cleanup failed: ${detail}`);
        }
      })
      .finally(() => {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      });
  }
}

class CodexSubagentExecutor implements SubagentExecutor {
  readonly continuationBlockedReason =
    'Codex agents are one-shot: start a new Agent task instead of sending messages or resuming.';
  private readonly controller = new AbortController();
  private readonly emitter: AgentEventEmitter;
  private readonly core: SubagentExecutorCore;
  private readonly sandbox: string;
  private execution?: Promise<void>;
  private finalText = '';
  private terminateMode = AgentTerminateMode.ERROR;
  private durationMs = 0;

  constructor(private readonly params: ExternalAgentExecutorParams) {
    if (params.spec.kind !== 'codex')
      throw new Error('Expected a Codex executor.');
    if (!params.runtimeContext.isTrustedFolder())
      throw new Error('Codex agents require a trusted workspace.');
    const minutes = params.runConfig.max_time_minutes;
    if (
      params.runConfig.max_turns !== undefined ||
      (minutes !== undefined &&
        (!Number.isFinite(minutes) ||
          minutes <= 0 ||
          minutes * 60_000 > 2_147_483_647))
    ) {
      throw new Error(
        'Codex requires a valid time limit and does not support max_turns.',
      );
    }
    switch (params.approvalMode ?? 'default') {
      case 'default':
      case 'plan':
        this.sandbox = 'read-only';
        break;
      case 'auto':
      case 'auto-edit':
        this.sandbox = 'workspace-write';
        break;
      case 'yolo':
        this.sandbox = 'danger-full-access';
        break;
      default:
        throw new Error(
          `Codex does not support approval mode ${params.approvalMode}.`,
        );
    }
    this.emitter = params.eventEmitter ?? new AgentEventEmitter();
    this.core = {
      getEventEmitter: () => this.emitter,
      modelConfig: { model: 'external-codex:codex' },
    };
  }

  execute(context: ContextState, signal?: AbortSignal): Promise<void> {
    if (this.execution)
      return Promise.reject(new Error(this.continuationBlockedReason));
    this.execution = this.run(context, signal);
    return this.execution;
  }

  private async run(
    context: ContextState,
    signal?: AbortSignal,
  ): Promise<void> {
    const start = Date.now();
    const subagentId = this.params.subagentId ?? this.params.name;
    const abort = () => this.controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      if (this.controller.signal.aborted)
        throw new CodexInterruption(AgentTerminateMode.CANCELLED);
      if (context.get('initial_messages_override') !== undefined)
        throw new Error('Codex agents cannot import conversation history.');
      this.emitter.emit(AgentEventType.START, {
        subagentId,
        name: this.params.name,
        model: this.core.modelConfig.model,
        tools: [],
        timestamp: Date.now(),
      });
      const system = renderSubagentSystemPrompt(
        this.params.promptConfig,
        context,
        this.params.runtimeContext,
      );
      const task = String(context.get('task_prompt') ?? 'Get Started!');
      this.finalText = await runCodex(
        { ...this.params, eventEmitter: this.emitter },
        [system, task].filter(Boolean).join('\n\n'),
        this.sandbox,
        this.controller.signal,
      );
      this.terminateMode = this.controller.signal.aborted
        ? AgentTerminateMode.CANCELLED
        : AgentTerminateMode.GOAL;
    } catch (error) {
      this.terminateMode =
        error instanceof CodexInterruption
          ? error.mode
          : AgentTerminateMode.ERROR;
      this.finalText = error instanceof Error ? error.message : String(error);
      if (!(error instanceof CodexInterruption)) throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      this.durationMs = Date.now() - start;
      this.emitter.emit(AgentEventType.ROUND_TEXT, {
        subagentId,
        round: 1,
        text: this.finalText,
        thoughtText: '',
        timestamp: Date.now(),
      });
      this.emitter.emit(AgentEventType.FINISH, {
        subagentId,
        terminateReason: this.terminateMode,
        rounds: 1,
        totalDurationMs: this.durationMs,
        totalToolCalls: 0,
        successfulToolCalls: 0,
        failedToolCalls: 0,
        timestamp: Date.now(),
      });
    }
  }

  async executeExternalInputs(inputs: AgentExternalInput[]): Promise<void> {
    if (inputs.length) throw new Error(this.continuationBlockedReason);
  }
  setExternalMessageProvider(): void {
    throw new Error(this.continuationBlockedReason);
  }
  getFinalText(): string {
    return this.finalText;
  }
  getTerminateMode(): AgentTerminateMode {
    return this.terminateMode;
  }
  getCore(): SubagentExecutorCore {
    return this.core;
  }
  getExecutionSummary(): AgentStatsSummary {
    return {
      rounds: this.execution ? 1 : 0,
      totalDurationMs: this.durationMs,
      totalToolCalls: 0,
      successfulToolCalls: 0,
      failedToolCalls: 0,
      successRate: 0,
      inputTokens: 0,
      outputTokens: 0,
      thoughtTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      toolUsage: [],
    };
  }
  async dispose(): Promise<void> {
    this.controller.abort();
    await this.execution?.catch(() => {});
  }
}

export const codexExternalAgentExecutor: ExternalAgentExecutor = {
  create: async (params) => new CodexSubagentExecutor(params),
};
