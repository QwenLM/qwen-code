/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentEventEmitter,
  AgentEventType,
  AgentTerminateMode,
  ContextState,
  ToolConfirmationOutcome,
  type ExternalAgentExecutorParams,
  type SubagentExecutor,
} from '@qwen-code/qwen-code-core/subagentRuntime';
import { Config, InputFormat } from '@qwen-code/qwen-code-core';
import {
  acpExternalAgentExecutor,
  externalModelLabel,
  isExpectedExternalAgentCleanupExit,
  isUnprovenExternalAgentTreeExit,
  optionKindForOutcome,
  resolvePermissionMode,
  selectPeerModeId,
  selectPermissionOption,
  selectRejectOption,
} from './acp-subagent-executor.js';

const fixture = String.raw`
import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import { spawn } from 'node:child_process';
const scenario = process.argv[1];
if (scenario === 'term-resistant' || scenario === 'late-after-timeout')
  process.on('SIGTERM', () => {});
let mode;
let prompts = 0;
let permissionCount = 0;
let connection;
const send = (update) => connection.sessionUpdate({sessionId:'fixture', update});
connection = new AgentSideConnection(() => ({
  initialize: async () => {
    if (scenario === 'init-exit') process.exit(3);
    if (scenario === 'init-hang') return new Promise(() => {});
    return {protocolVersion:1, agentCapabilities:{}};
  },
  newSession: async () => {
    if (scenario === 'session-exit') process.exit(4);
    if (scenario === 'session-hang') return new Promise(() => {});
    return {sessionId:'fixture', modes:{currentModeId:'auto', availableModes:scenario === 'no-mode' ? [] : scenario === 'claude-modes' ? [{id:'default',name:'Ask'},{id:'acceptEdits',name:'AcceptEdits'},{id:'bypassPermissions',name:'Bypass'}] : scenario === 'qwen-modes' ? [{id:'plan'},{id:'default'},{id:'auto-edit'},{id:'auto'},{id:'yolo'}] : [{id:'default',name:'Ask'},{id:'plan',name:'Plan'}]}};
  },
  setSessionMode: async (params) => {
    if (scenario === 'mode-error') throw new Error('cannot set mode');
    if (scenario === 'mode-hang') return new Promise(() => {});
    mode = params.modeId;
    return {};
  },
  authenticate: async () => ({}),
  cancel: async () => { await send({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'CANCEL_RECEIVED'}}); },
  prompt: async (params) => {
    prompts++;
    const safeModes = scenario === 'claude-modes' ? ['default','acceptEdits','bypassPermissions'] : scenario === 'qwen-modes' ? ['plan','default','auto-edit','auto','yolo'] : ['default','plan'];
    if (!safeModes.includes(mode)) throw new Error('PROMPT BEFORE SAFE MODE');
    if (scenario === 'claude-modes' || scenario === 'qwen-modes') { await send({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'MODE:'+mode}}); return {stopReason:'end_turn'}; }
    if (scenario === 'prompt-exit') process.exit(5);
    if (scenario === 'prompt-close') { process.stdout.end(); return new Promise(() => {}); }
    if (scenario === 'prompt-hang') return new Promise(() => {});
    if (scenario === 'unsupported-extension') {
      try {
        await connection.extMethod('_fixture/unsupported', {sessionId:'fixture'});
        throw new Error('Unsupported method unexpectedly succeeded');
      } catch (error) {
        await send({sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify({code:error.code,message:error.message})}});
      }
      return {stopReason:'end_turn'};
    }
    if (scenario === 'tree') {
      const descendant = spawn(process.execPath, ['-e','process.on("SIGTERM",()=>{});process.send("ready");setInterval(()=>{},1000)'], {stdio:['ignore','ignore','ignore','ipc']});
      await new Promise(resolve => descendant.once('message', resolve));
      await send({sessionUpdate:'agent_message_chunk',content:{type:'text',text:String(descendant.pid)}});
      return {stopReason:'end_turn'};
    }
    if (scenario === 'tool-open-hang') {
      await send({sessionUpdate:'tool_call',toolCallId:'open-1',title:'Shell',kind:'execute',status:'in_progress',rawInput:{command:'sleep'}});
      return new Promise(() => {});
    }
    if (scenario === 'late-after-timeout') {
      // Outlive the wall-time budget, then emit after the turn was declared
      // over (during dispose's SIGTERM grace). The widened onSessionUpdate
      // guard must drop these (R8-1).
      await new Promise((resolve) => setTimeout(resolve, 400));
      await send({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'LATE_AFTER_TIMEOUT'}});
      await send({sessionUpdate:'tool_call',toolCallId:'late-1',title:'Shell',kind:'execute',status:'in_progress',rawInput:{}});
      await send({sessionUpdate:'tool_call_update',toolCallId:'late-1',status:'completed'});
      return {stopReason:'end_turn'};
    }
    if (scenario.startsWith('permission')) {
      const toolName = scenario === 'permission-question' ? 'AskUserQuestion' : scenario === 'permission-question-snake' ? 'ask_user_question' : 'Write';
      const request = () => connection.requestPermission({sessionId:'fixture',toolCall:{toolCallId:'same',title:'Write',kind:'edit',rawInput:{command:'rm -rf ./build'},_meta:{claudeCode:{toolName}}},options:[{optionId:'once',name:'Once',kind:'allow_once'},{optionId:'always',name:'Always',kind:'allow_always'},{optionId:'no',name:'No',kind:'reject_once'}]});
      const result = scenario === 'permission-duplicate' ? await Promise.all([request(), request()]) : [await request()];
      await send({sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(result)}});
      permissionCount++;
      return {stopReason: result[0] && result[0].outcome.outcome === 'cancelled' ? 'cancelled' : 'end_turn'};
    }
    if (scenario === 'env') {
      await send({sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(['QWEN_SERVER_TOKEN','QWEN_DAEMON_TOKEN','QWEN_CODE_EXTERNAL_TOOL_GUARD_TOKEN','QWEN_CODE_PRIVATE_ACP_CAPABILITY'].map(k => process.env[k] ?? null))}});
      return {stopReason:'end_turn'};
    }
    await send({sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'thinking'}});
    await send({sessionUpdate:'agent_message_chunk',content:{type:'text',text:params.prompt.map(p=>p.text).join('|')}});
    await send({sessionUpdate:'tool_call',toolCallId:'tool-'+prompts,title:'Shell',kind:'execute',status:'in_progress',rawInput:{}});
    await send({sessionUpdate:'tool_call_update',toolCallId:'tool-'+prompts,rawInput:{command:'printf hello'},_meta:{claudeCode:{toolName:'Bash'}},content:[{type:'content',content:{type:'text',text:'hello'}}]});
    await send({sessionUpdate:'tool_call_update',toolCallId:'tool-'+prompts,status:'completed'});
    await send({sessionUpdate:'tool_call_update',toolCallId:'tool-'+prompts,status:'completed'});
    return {stopReason:scenario === 'continuation-refusal' && prompts > 1 ? 'refusal' : scenario === 'max-tokens' ? 'max_tokens' : scenario === 'unknown-stop' ? 'future_reason' : 'end_turn'};
  },
}), ndJsonStream(Writable.toWeb(process.stdout),Readable.toWeb(process.stdin)));
setInterval(()=>{},1000);
`;

const executors: SubagentExecutor[] = [];
afterEach(async () => {
  await Promise.all(
    executors.splice(0).map((executor) => executor.dispose?.()),
  );
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function params(scenario = 'normal'): ExternalAgentExecutorParams {
  const runtimeContext = new Config({
    sessionId: 'fixture-test',
    targetDir: process.cwd(),
    cwd: process.cwd(),
    model: 'unused',
    debugMode: false,
  });
  vi.spyOn(runtimeContext, 'isInteractive').mockReturnValue(true);
  return {
    spec: {
      kind: 'acp',
      command: process.execPath,
      args: ['--input-type=module', '-e', fixture, scenario],
    },
    name: 'fixture',
    promptConfig: { systemPrompt: '' },
    modelConfig: { model: 'unused' },
    runConfig: {},
    runtimeContext,
    eventEmitter: new AgentEventEmitter(),
  };
}

async function create(
  options: ExternalAgentExecutorParams,
): Promise<SubagentExecutor> {
  const executor = await acpExternalAgentExecutor.create(options);
  executors.push(executor);
  return executor;
}

function context(text = 'task'): ContextState {
  const state = new ContextState();
  state.set('task_prompt', text);
  return state;
}

describe('permission mapping', () => {
  it('honors loader approval precedence and fails unknown modes towards asking', () => {
    expect(resolvePermissionMode('bypassPermissions', 'plan')).toBe('plan');
    expect(resolvePermissionMode('auto', 'default')).toBe('default');
    expect(resolvePermissionMode('auto', 'auto-edit')).toBe('acceptEdits');
    expect(resolvePermissionMode(undefined, undefined)).toBe('default');
    expect(resolvePermissionMode('unknown', undefined)).toBe('default');
  });
  it('maps host approval vocabulary to policy tokens, never peer mode ids (R11-3)', () => {
    expect(resolvePermissionMode('yolo', undefined)).toBe('bypass');
    expect(resolvePermissionMode('bypassPermissions', undefined)).toBe(
      'bypass',
    );
    expect(resolvePermissionMode('auto', undefined)).toBe('acceptEdits');
    expect(resolvePermissionMode('auto-edit', undefined)).toBe('acceptEdits');
  });
  it('selects the peer-advertised alias for a policy, never a host token (R11-3)', () => {
    // Claude vocabulary: host auto-edit maps to the peer's acceptEdits, never
    // the qwen-only 'auto' (which a Claude peer does not even advertise).
    expect(
      selectPeerModeId('acceptEdits', [
        'default',
        'acceptEdits',
        'bypassPermissions',
      ]),
    ).toBe('acceptEdits');
    // qwen vocabulary: host auto-edit maps to the peer's auto-edit.
    expect(
      selectPeerModeId('acceptEdits', ['auto-edit', 'auto', 'default']),
    ).toBe('auto-edit');
    expect(selectPeerModeId('bypass', ['bypassPermissions'])).toBe(
      'bypassPermissions',
    );
    expect(selectPeerModeId('bypass', ['yolo'])).toBe('yolo');
    // No advertised alias → undefined so the caller refuses, not guesses.
    expect(selectPeerModeId('bypass', ['default', 'plan'])).toBeUndefined();
  });
  it('never grants for non-approval outcomes or widens a single approval', () => {
    expect(optionKindForOutcome(ToolConfirmationOutcome.RestorePrevious)).toBe(
      'reject_once',
    );
    expect(optionKindForOutcome(ToolConfirmationOutcome.ModifyWithEditor)).toBe(
      'reject_once',
    );
    const options = [
      { optionId: 'always', kind: 'allow_always' },
      { optionId: 'no', kind: 'reject_once' },
    ];
    expect(
      selectPermissionOption(options, ToolConfirmationOutcome.ProceedOnce),
    ).toBe('no');
    expect(
      selectPermissionOption(options, ToolConfirmationOutcome.Cancel),
    ).toBeUndefined();
    expect(
      selectPermissionOption(
        [{ optionId: 'once', kind: 'allow_once' }],
        ToolConfirmationOutcome.ProceedAlways,
      ),
    ).toBe('once');
    expect(
      selectPermissionOption(
        [
          { optionId: 'same', kind: 'allow_once' },
          { optionId: 'same', kind: 'reject_once' },
        ],
        ToolConfirmationOutcome.ProceedOnce,
      ),
    ).toBeUndefined();
  });
  it('uses an external model label', () => {
    expect(externalModelLabel('/usr/bin/claude')).toBe('external-acp:claude');
    expect(externalModelLabel('C:\\tools\\claude')).toBe('external-acp:claude');
  });
  it('selects the narrowest reject option and refuses to guess', () => {
    const full = [
      { optionId: 'once', kind: 'allow_once' },
      { optionId: 'always', kind: 'allow_always' },
      { optionId: 'no', kind: 'reject_once' },
    ];
    // Prefers reject_once over reject_always (deny this call, not the session).
    expect(selectRejectOption(full)).toBe('no');
    expect(
      selectRejectOption([
        { optionId: 'never', kind: 'reject_always' },
        { optionId: 'once', kind: 'allow_once' },
      ]),
    ).toBe('never');
    // No reject option at all → undefined, so the caller falls back to cancel
    // rather than selecting an allow.
    expect(
      selectRejectOption([
        { optionId: 'once', kind: 'allow_once' },
        { optionId: 'always', kind: 'allow_always' },
      ]),
    ).toBeUndefined();
    expect(selectRejectOption([])).toBeUndefined();
    // Ambiguous duplicate IDs → refuse to guess.
    expect(
      selectRejectOption([
        { optionId: 'same', kind: 'reject_once' },
        { optionId: 'same', kind: 'allow_once' },
      ]),
    ).toBeUndefined();
  });
});

describe('cleanup-exit classification', () => {
  it("tolerates the peer's own unclean exit but not the unproven-tree race", () => {
    // The peer's own exit status, for ANY code/signal: acp-bridge raises this
    // only after the tree is proven gone, so dispose() tolerates it silently
    // (R7-2). Letting dispose() reject on it would override the turn's
    // classified terminal state.
    for (const status of [
      'code=none, signal=SIGTERM',
      'code=none, signal=SIGKILL',
      'code=5, signal=none',
      'code=1, signal=none',
      'code=none, signal=SIGHUP',
      'code=143, signal=none',
    ]) {
      const error = new Error(
        `ACP child pid=4242 exited uncleanly during shutdown (${status})`,
      );
      expect(isExpectedExternalAgentCleanupExit(error)).toBe(true);
      expect(isUnprovenExternalAgentTreeExit(error)).toBe(false);
    }
    // The snapshot-race shape means the tree was NEVER enumerated (a detached
    // descendant may survive), so it is reported, not silently swallowed
    // (R10-3). isExpectedExternalAgentCleanupExit must be false so dispose()
    // does not treat it as a clean exit; isUnprovenExternalAgentTreeExit routes
    // it to the report-and-resolve path.
    const snapshot = new Error(
      'ACP child pid=2628870 exited before its initial process-tree snapshot completed',
    );
    expect(isExpectedExternalAgentCleanupExit(snapshot)).toBe(false);
    expect(isUnprovenExternalAgentTreeExit(snapshot)).toBe(true);
  });
  it('propagates every genuine cleanup-proof failure', () => {
    const mustThrow = [
      // These are raised when the tree could NOT be proven gone — a descendant
      // we owned may have survived, so they must never be swallowed.
      'ACP child pid=4242 process-tree snapshot exceeded 512 processes or depth 8',
      'ACP child pid=4242 was absent from the initial process-tree snapshot',
      'ACP child pid=4242 was not an isolated process-group leader',
      'ACP child pid=4242 process-tree snapshot failed: ps exited 1',
      'ACP child pid=4242 could not send SIGKILL to pgid=4242: EPERM',
      'ACP child pid=4242 could not inspect pgid=999: EACCES',
      'ACP child pid=4242 did not exit within 5000ms',
    ];
    for (const message of mustThrow) {
      // Neither silently tolerated nor report-and-resolved: these must rethrow.
      expect(isExpectedExternalAgentCleanupExit(new Error(message))).toBe(
        false,
      );
      expect(isUnprovenExternalAgentTreeExit(new Error(message))).toBe(false);
    }
  });
  it('rejects non-Error and near-miss values', () => {
    for (const predicate of [
      isExpectedExternalAgentCleanupExit,
      isUnprovenExternalAgentTreeExit,
    ]) {
      expect(predicate(undefined)).toBe(false);
      expect(predicate(null)).toBe(false);
    }
    // The snapshot shape's anchoring and pid validation now live in
    // isUnprovenExternalAgentTreeExit (R10-3).
    const tail = 'exited before its initial process-tree snapshot completed';
    expect(isUnprovenExternalAgentTreeExit(`ACP child pid=1 ${tail}`)).toBe(
      false,
    );
    expect(
      isUnprovenExternalAgentTreeExit(
        new Error(`prefix ACP child pid=1 ${tail}`),
      ),
    ).toBe(false);
    expect(
      isUnprovenExternalAgentTreeExit(
        new Error(`ACP child pid=notanumber ${tail}`),
      ),
    ).toBe(false);
  });
});

// Real subprocess + real ProcessRegistry tree-kill. On Windows the registry
// kills via taskkill/SIGKILL and Node reports a numeric exit code with
// signalCode null, which dispose() surfaces as an unclean-exit error — the same
// exposure the repo's other real-process suites gate (process-registry.process,
// hook-runner.process). The pure-function suites above run on every platform.
describe.skipIf(process.platform === 'win32')('real ACP subprocess', () => {
  it('returns method-not-found -32601 across the real extension request wire', async () => {
    const executor = await create(params('unsupported-extension'));
    await executor.execute(context());
    expect(JSON.parse(executor.getFinalText())).toMatchObject({ code: -32601 });
    expect(executor.getTerminateMode()).toBe(AgentTerminateMode.GOAL);
  });
  it('sets an advertised asking mode before prompt and preserves text/thought/tool transcript events', async () => {
    const options = params();
    const text = vi.fn();
    const stream = vi.fn();
    const results = vi.fn();
    options.eventEmitter!.on(AgentEventType.ROUND_TEXT, text);
    options.eventEmitter!.on(AgentEventType.STREAM_TEXT, stream);
    options.eventEmitter!.on(AgentEventType.TOOL_RESPONSES_FINALIZED, results);
    const executor = await create(options);
    await executor.execute(context());
    expect(executor.getTerminateMode()).toBe(AgentTerminateMode.GOAL);
    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'task', thoughtText: 'thinking' }),
    );
    expect(stream).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'thinking', thought: true }),
    );
    expect(results).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(results.mock.calls)).toContain('hello');
    expect(
      results.mock.calls[0]![0].responses[0].responseParts[0].functionResponse,
    ).toMatchObject({
      name: 'execute',
      response: { input: { command: 'printf hello' }, toolName: 'Bash' },
    });
    expect(executor.getExecutionSummary()).toMatchObject({
      totalToolCalls: 1,
      successfulToolCalls: 1,
      rounds: 1,
    });
    const duration = executor.getExecutionSummary().totalDurationMs;
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(executor.getExecutionSummary().totalDurationMs).toBe(duration);
  });
  it.each(['no-mode', 'mode-error', 'init-exit', 'session-exit'])(
    'fails creation for %s',
    async (scenario) => {
      await expect(create(params(scenario))).rejects.toThrow();
    },
  );
  it('drives the peer-advertised acceptEdits mode for a host auto-edit approval (R11-3)', async () => {
    const options = params('claude-modes');
    options.approvalMode = 'auto-edit';
    const executor = await create(options);
    await executor.execute(context());
    // The peer is told 'acceptEdits' (its own vocabulary), never the qwen-only
    // 'auto'/'auto-edit' token — the fixture echoes the mode it received.
    expect(executor.getFinalText()).toContain('MODE:acceptEdits');
    expect(executor.getTerminateMode()).toBe(AgentTerminateMode.GOAL);
  });
  it('drives the peer-advertised bypassPermissions mode for a host yolo approval (R11-3)', async () => {
    const options = params('claude-modes');
    options.approvalMode = 'yolo';
    const executor = await create(options);
    await executor.execute(context());
    expect(executor.getFinalText()).toContain('MODE:bypassPermissions');
    expect(executor.getTerminateMode()).toBe(AgentTerminateMode.GOAL);
  });
  it('refuses creation when the peer advertises no mode for the host bypass policy (R11-3)', async () => {
    // The default fixture advertises only default+plan; a host yolo approval
    // maps to the bypass policy, which has no advertised alias → connect must
    // fail loudly (naming the policy), never silently weaken the mode.
    const options = params();
    options.approvalMode = 'yolo';
    await expect(create(options)).rejects.toThrow(/bypass/);
  });
  it('selects the qwen peer auto-edit mode for a host auto-edit approval (R11-3)', async () => {
    // A qwen-vocabulary peer advertises auto-edit (NOT the Claude-only
    // acceptEdits), so the old hard-coded 'acceptEdits' id made connect() throw
    // and killed the delegation. The policy token + alias selection must find
    // the peer's own auto-edit id and connect must succeed.
    const options = params('qwen-modes');
    options.approvalMode = 'auto-edit';
    const executor = await create(options);
    await executor.execute(context());
    expect(executor.getFinalText()).toContain('MODE:auto-edit');
    expect(executor.getTerminateMode()).toBe(AgentTerminateMode.GOAL);
  });
  it('selects the qwen peer yolo mode for a host yolo approval, never a weaker auto (R11-3)', async () => {
    // The old mapping sent host yolo → 'auto', which a qwen peer accepted —
    // silently running a YOLO delegation in the strictly weaker AUTO mode (and
    // against a Claude peer, 'auto' is not advertised, so it threw). The bypass
    // policy must select the peer's yolo id.
    const options = params('qwen-modes');
    options.approvalMode = 'yolo';
    const executor = await create(options);
    await executor.execute(context());
    expect(executor.getFinalText()).toContain('MODE:yolo');
    expect(executor.getTerminateMode()).toBe(AgentTerminateMode.GOAL);
  });
  it.each(['init-hang', 'session-hang', 'mode-hang'])(
    'bounds and reaps a %s handshake',
    async (scenario) => {
      await expect(create(params(scenario))).rejects.toThrow('timed out');
    },
    15000,
  );
  it.each(['prompt-exit', 'prompt-close'])(
    'rejects %s without an error listener',
    async (scenario) => {
      const executor = await create(params(scenario));
      await expect(executor.execute(context())).rejects.toThrow();
      expect(executor.getTerminateMode()).toBe(AgentTerminateMode.ERROR);
    },
  );
  it.each(['max-tokens', 'unknown-stop'])(
    'never certifies %s as success',
    async (scenario) => {
      const executor = await create(params(scenario));
      await executor.execute(context());
      expect(executor.getTerminateMode()).toBe(AgentTerminateMode.ERROR);
    },
  );
  it('preserves both external-input variants and updates continuation lifecycle and stats', async () => {
    const options = params('continuation-refusal');
    const finish = vi.fn();
    const external = vi.fn();
    options.eventEmitter!.on(AgentEventType.FINISH, finish);
    options.eventEmitter!.on(AgentEventType.EXTERNAL_MESSAGE, external);
    const executor = await create(options);
    await executor.execute(context('first'));
    await executor.executeExternalInputs(
      ['second', { kind: 'notification', text: 'notice' }],
      undefined,
      { resetStats: false },
    );
    expect(executor.getFinalText()).toBe('second|notice');
    // The continuation peer returned ACP `refusal` — the agent declined, which
    // is a failure the parent must see, not a user cancel (R6-2).
    expect(executor.getTerminateMode()).toBe(AgentTerminateMode.ERROR);
    expect(executor.getExecutionSummary()).toMatchObject({
      rounds: 2,
      totalToolCalls: 2,
    });
    expect(finish).toHaveBeenCalledTimes(2);
    expect(external).toHaveBeenCalledTimes(2);
    await executor.execute(context('fresh'));
    expect(executor.getExecutionSummary()).toMatchObject({
      rounds: 1,
      totalToolCalls: 1,
    });
  });
  it('records the user-side transcript entry on a continuation execute() turn', async () => {
    const options = params();
    const external = vi.fn();
    options.eventEmitter!.on(AgentEventType.EXTERNAL_MESSAGE, external);
    const executor = await create(options);
    await executor.execute(context('first'));
    // The first turn's task is seeded into the transcript as the initial user
    // prompt by the dispatcher, so execute() must not double-record it.
    expect(external).not.toHaveBeenCalled();
    await executor.execute(context('second'));
    // A resident external agent re-invoked per incoming user message must
    // record each continuation task, or the JSONL transcript loses every
    // message after the first and round 2 shows an answer to an unasked
    // question (R6-1). The in-process sibling emits the same event.
    expect(external).toHaveBeenCalledTimes(1);
    expect(external).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'message', text: 'second' }),
    );
  });
  it('flushes a tool call left open when the turn is cancelled', async () => {
    const options = params('tool-open-hang');
    const results = vi.fn();
    const finalized = vi.fn();
    options.eventEmitter!.on(AgentEventType.TOOL_RESULT, results);
    options.eventEmitter!.on(
      AgentEventType.TOOL_RESPONSES_FINALIZED,
      finalized,
    );
    const abort = new AbortController();
    // Cancel once the peer's in-progress tool_call has been recorded, so the
    // turn ends with that tool still open (R7-3).
    options.eventEmitter!.on(AgentEventType.TOOL_CALL, () => abort.abort());
    const executor = await create(options);
    await executor.execute(context(), abort.signal);
    expect(executor.getTerminateMode()).toBe(AgentTerminateMode.CANCELLED);
    // The open tool gets a terminal failed TOOL_RESULT + a finalized response,
    // so the inline frame / Web Shell row stop showing it as executing, the
    // JSONL functionCall is paired, and the FINISH totals sum.
    expect(results).toHaveBeenCalledWith(
      expect.objectContaining({ callId: 'open-1', success: false }),
    );
    expect(finalized).toHaveBeenCalledWith(
      expect.objectContaining({
        responses: [
          expect.objectContaining({
            callId: 'open-1',
            responseParts: [
              expect.objectContaining({
                functionResponse: expect.objectContaining({ id: 'open-1' }),
              }),
            ],
          }),
        ],
      }),
    );
    const summary = executor.getExecutionSummary();
    expect(summary.totalToolCalls).toBe(1);
    expect(summary.failedToolCalls).toBe(1);
    expect(summary.successfulToolCalls).toBe(0);
  });
  it('drains registered external messages before reporting completion', async () => {
    const executor = await create(params());
    const provider = vi
      .fn()
      .mockReturnValueOnce(['queued'])
      .mockReturnValue([]);
    executor.setExternalMessageProvider(provider);
    await executor.execute(context('first'));
    expect(executor.getFinalText()).toContain('queued');
    expect(executor.getExecutionSummary().rounds).toBe(2);
  });
  it('does not dispatch a continuation prompt once the wall-time budget is spent (R9-1)', async () => {
    const options = params();
    // An explicit cap: an absent max_time_minutes now means "no cap" (R10-5), so
    // the budget logic this test exercises needs a real value.
    options.runConfig.max_time_minutes = 10;
    const executor = await create(options);
    // Stub the connection so prompt() is countable and resolves end_turn
    // immediately; the first prompt also advances the mocked clock past the
    // 10-minute budget, simulating a peer that consumed the whole wall time on
    // round 1. A message is queued, so without a budget check the loop would
    // dispatch round 2 with `remaining` clamped to 0 — billing a prompt it then
    // abandons (wait's 0ms timer rejects with ExternalAgentTimeoutError) and
    // killing the peer in dispose(), after emitInputs already recorded the
    // queued message as delivered. The guard must stop before that dispatch.
    const realNow = Date.now();
    let mockNow = realNow;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => mockNow);
    const prompt = vi.fn().mockImplementation(() => {
      mockNow = realNow + 11 * 60_000;
      return Promise.resolve({ stopReason: 'end_turn' });
    });
    (
      executor as unknown as {
        connection: { prompt: typeof prompt; cancel: () => Promise<void> };
      }
    ).connection = { prompt, cancel: async () => {} };
    executor.setExternalMessageProvider(
      vi.fn().mockReturnValueOnce(['queued']).mockReturnValue([]),
    );
    await executor.execute(context('first'));
    // Removing the budget guard turns both red: round 2 dispatches (prompt is
    // called twice) and resolves end_turn against the empty queue, so the turn
    // ends GOAL instead of TIMEOUT.
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(executor.getTerminateMode()).toBe(AgentTerminateMode.TIMEOUT);
    nowSpy.mockRestore();
  });
  it('does not drain or record a queued message it has no budget to dispatch (R10-4)', async () => {
    const options = params();
    options.runConfig.max_time_minutes = 10;
    const delivered: unknown[] = [];
    options.eventEmitter!.on(AgentEventType.EXTERNAL_MESSAGE, (event) =>
      delivered.push(event),
    );
    const executor = await create(options);
    // Spend the budget during round 1 (the R9-1 construction) and back the
    // provider with a mutable queue that drains destructively, like
    // registry.drainMessages. Round 1 returns end_turn with a message waiting.
    const realNow = Date.now();
    let mockNow = realNow;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => mockNow);
    const prompt = vi.fn().mockImplementation(() => {
      mockNow = realNow + 11 * 60_000;
      return Promise.resolve({ stopReason: 'end_turn' });
    });
    (
      executor as unknown as {
        connection: { prompt: typeof prompt; cancel: () => Promise<void> };
      }
    ).connection = { prompt, cancel: async () => {} };
    const queue = ['USER MESSAGE FROM PARENT'];
    const provider = vi.fn().mockImplementation(() => queue.splice(0));
    executor.setExternalMessageProvider(provider);
    await executor.execute(context('first'));
    // The budget is spent before round 2, so the loop must break BEFORE the
    // destructive drain: the queue still holds the message, the provider was
    // never called, and no EXTERNAL_MESSAGE certified a delivery that never
    // reached the peer. Removing the pre-drain budget/abort check turns these
    // red — the queue empties, the provider runs, and the message is recorded as
    // delivered while `next` is dropped at the round-top guard.
    expect(queue).toEqual(['USER MESSAGE FROM PARENT']);
    expect(provider).not.toHaveBeenCalled();
    expect(delivered).toEqual([]);
    expect(executor.getTerminateMode()).toBe(AgentTerminateMode.TIMEOUT);
    nowSpy.mockRestore();
  });
  it('enforces the wall-time budget cumulatively across resetStats:false continuations (R11-2)', async () => {
    const options = params();
    options.runConfig.max_time_minutes = 10;
    const executor = await create(options);
    const realNow = Date.now();
    let mockNow = realNow;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => mockNow);
    // Each prompt burns 7 of the 10 budget minutes (mocked clock), resolving
    // end_turn immediately so wait() never times out the in-flight round.
    const prompt = vi.fn().mockImplementation(() => {
      mockNow += 7 * 60_000;
      return Promise.resolve({ stopReason: 'end_turn' });
    });
    (
      executor as unknown as {
        connection: { prompt: typeof prompt; cancel: () => Promise<void> };
      }
    ).connection = { prompt, cancel: async () => {} };
    // Turn 1 (fresh, resetStats default): burns 7min < 10min cap, ends GOAL.
    await executor.execute(context('first'));
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(executor.getTerminateMode()).toBe(AgentTerminateMode.GOAL);
    // Turn 2 (continuation, stats preserved): the cumulative clock starts at
    // 7min, leaving only 3min. Its prompt burns 7min more, pushing the
    // cumulative elapsed (14min) past the 10min cap, so the turn is cut off
    // TIMEOUT. Without subtracting this.durationMs, turn 2 would get a fresh
    // per-turn 10min budget, its 7min prompt would fit, and it would end GOAL —
    // a continued agent overrunning the whole-delegation cap.
    await executor.execute(context('second'), undefined, { resetStats: false });
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(executor.getTerminateMode()).toBe(AgentTerminateMode.TIMEOUT);
    nowSpy.mockRestore();
  });
  it('does not send a prompt for an already-aborted turn', async () => {
    const executor = await create(params('prompt-exit'));
    await executor.execute(context(), AbortSignal.abort());
    expect(executor.getTerminateMode()).toBe(AgentTerminateMode.CANCELLED);
    expect(executor.getFinalText()).toBe('');
  });
  it('cancels and reaps an uncooperative continuation', async () => {
    const executor = await create(params('prompt-hang'));
    const abort = new AbortController();
    const running = executor.executeExternalInputs(['continue'], abort.signal);
    setTimeout(() => abort.abort(), 50);
    await running;
    expect(executor.getTerminateMode()).toBe(AgentTerminateMode.CANCELLED);
  });
  it('enforces the configured wall time', async () => {
    const options = params('prompt-hang');
    options.runConfig.max_time_minutes = 0.001;
    const executor = await create(options);
    await executor.execute(context());
    expect(executor.getTerminateMode()).toBe(AgentTerminateMode.TIMEOUT);
  });
  it('drops session updates that arrive after a timeout declared the turn over', async () => {
    const options = params('late-after-timeout');
    options.runConfig.max_time_minutes = 0.002; // 120ms budget
    const executor = await create(options);
    await executor.execute(context());
    // The turn times out at ~120ms; the SIGTERM-resistant peer then emits a
    // chunk and a completing tool_call at ~400ms, during dispose's grace window
    // while `executing` is still true and `cancelled` is false (the timeout path
    // never sets it). The widened guard must drop them, so the late text never
    // reaches finalText (the TIMEOUT path hands it to the parent verbatim) and
    // the late tool never inflates the FINISH totals (R8-1).
    expect(executor.getTerminateMode()).toBe(AgentTerminateMode.TIMEOUT);
    expect(executor.getFinalText()).not.toContain('LATE_AFTER_TIMEOUT');
    expect(executor.getExecutionSummary().totalToolCalls).toBe(0);
    expect(executor.getExecutionSummary().successfulToolCalls).toBe(0);
  }, 15000);
  it('installs no wall-time deadline when max_time_minutes is absent (R10-5)', async () => {
    // An absent max_time_minutes means "no cap" everywhere else in the codebase
    // (agent-core installs no timer when maxTimeMinutes is falsy), so the
    // external executor must not borrow a 10-minute default: that would make the
    // same definition behave differently based only on whether it declares an
    // executor, and would make a TIMEOUT turn — handed to the parent as the
    // answer with no truncation marker — reachable by default. wait() already
    // treats an undefined budget as "no timer". Reinstating `?? 10` turns this
    // red (a ~600000ms timer is installed).
    const executor = await create(params());
    const timers = vi.spyOn(globalThis, 'setTimeout');
    await executor.execute(context());
    const tenMinute = timers.mock.calls.find(
      ([, delay]) =>
        typeof delay === 'number' && delay > 599_000 && delay <= 600_000,
    );
    expect(tenMinute).toBeUndefined();
  });
  it('reports an unproven process tree on disposal instead of swallowing it (R10-3)', async () => {
    const options = params();
    const errors: string[] = [];
    options.eventEmitter!.on(AgentEventType.ERROR, (event) =>
      errors.push(String((event as { error?: unknown }).error)),
    );
    const executor = await create(options);
    // Stub the tracked child so terminate() reaps the real peer first (no leaked
    // subprocess) and then rejects with the snapshot-race proof error — the shape
    // acp-bridge raises when the root exited before the tree was enumerated, so a
    // detached descendant may survive. dispose() must report it (not swallow it
    // silently) and must NOT rethrow: it is awaited between the turn's
    // terminal-state classification and the return, so rethrowing would replace a
    // classified TIMEOUT/CANCELLED with a thrown ERROR.
    const real = (
      executor as unknown as { child: { terminate: () => Promise<void> } }
    ).child;
    (
      executor as unknown as { child: { terminate: () => Promise<void> } }
    ).child = {
      terminate: async () => {
        await real.terminate().catch(() => {});
        throw new Error(
          'ACP child pid=4242 exited before its initial process-tree snapshot completed',
        );
      },
    };
    await expect(executor.dispose!()).resolves.toBeUndefined();
    expect(errors.some((message) => message.includes('not proven gone'))).toBe(
      true,
    );
  });
  it('refuses an unenforceable internal turn limit', async () => {
    const options = params();
    options.runConfig.max_turns = 1;
    await expect(create(options)).rejects.toThrow('max_turns');
  });
  it.each([NaN, Infinity, -1, 0, 100_000])(
    'rejects invalid timeout %s before spawning',
    async (minutes) => {
      const options = params();
      options.spec.command = '/nonexistent/external-agent';
      options.runConfig.max_time_minutes = minutes;
      await expect(create(options)).rejects.toThrow('max_time_minutes');
    },
  );
  it('cleans up when a START subscriber throws', async () => {
    const options = params();
    options.eventEmitter!.on(AgentEventType.START, () => {
      throw new Error('start listener failed');
    });
    const executor = await create(options);
    await expect(executor.execute(context())).rejects.toThrow(
      'start listener failed',
    );
    await expect(executor.execute(context())).rejects.toThrow('closed');
    expect(executor.getTerminateMode()).toBe(AgentTerminateMode.ERROR);
  });
  it.each(['permission-question', 'permission-question-snake'])(
    'denies routed interactive question %s',
    async (scenario) => {
      const options = params(scenario);
      const approval = vi.fn();
      options.eventEmitter!.on(AgentEventType.TOOL_WAITING_APPROVAL, approval);
      const executor = await create(options);
      await executor.execute(context());
      // Denies the TOOL (selects reject_once), not the TURN (`cancelled`).
      expect(JSON.parse(executor.getFinalText())).toEqual([
        { outcome: { outcome: 'selected', optionId: 'no' } },
      ]);
      expect(approval).not.toHaveBeenCalled();
    },
  );
  it('denies when no approval listener exists', async () => {
    const executor = await create(params('permission'));
    await executor.execute(context());
    expect(JSON.parse(executor.getFinalText())).toEqual([
      { outcome: { outcome: 'selected', optionId: 'no' } },
    ]);
  });
  it('denies the TOOL, not the TURN, when the user explicitly cancels (R8-3)', async () => {
    const options = params('permission');
    options.eventEmitter!.on(
      AgentEventType.TOOL_WAITING_APPROVAL,
      async (event) => event.respond(ToolConfirmationOutcome.Cancel),
    );
    const executor = await create(options);
    await executor.execute(context());
    // An explicit user rejection of this one tool selects the peer's
    // reject_once option, so the peer continues and ends the turn normally.
    // Routing Cancel to ACP `cancelled` instead would abort the whole delegated
    // turn (the peer answers stopReason `cancelled` → CANCELLED), abandoning the
    // remaining work and billing a fresh prompt to re-delegate.
    expect(JSON.parse(executor.getFinalText())).toEqual([
      { outcome: { outcome: 'selected', optionId: 'no' } },
    ]);
    expect(executor.getTerminateMode()).toBe(AgentTerminateMode.GOAL);
  });
  it('denies when the runtime disallows permission prompts even with a listener', async () => {
    const options = params('permission');
    vi.spyOn(
      options.runtimeContext,
      'getShouldAvoidPermissionPrompts',
    ).mockReturnValue(true);
    const approval = vi.fn();
    options.eventEmitter!.on(AgentEventType.TOOL_WAITING_APPROVAL, approval);
    const executor = await create(options);
    await executor.execute(context());
    expect(JSON.parse(executor.getFinalText())).toEqual([
      { outcome: { outcome: 'selected', optionId: 'no' } },
    ]);
    expect(approval).not.toHaveBeenCalled();
  });
  it('denies plain headless requests despite a display-only approval listener', async () => {
    const options = params('permission');
    vi.spyOn(options.runtimeContext, 'isInteractive').mockReturnValue(false);
    vi.spyOn(
      options.runtimeContext,
      'getExperimentalZedIntegration',
    ).mockReturnValue(false);
    vi.spyOn(options.runtimeContext, 'getInputFormat').mockReturnValue(
      InputFormat.TEXT,
    );
    vi.spyOn(
      options.runtimeContext,
      'getShouldAvoidPermissionPrompts',
    ).mockReturnValue(false);
    const displayOnly = vi.fn();
    options.eventEmitter!.on(AgentEventType.TOOL_WAITING_APPROVAL, displayOnly);
    const executor = await create(options);
    await executor.execute(context());
    expect(JSON.parse(executor.getFinalText())).toEqual([
      { outcome: { outcome: 'selected', optionId: 'no' } },
    ]);
    expect(displayOnly).not.toHaveBeenCalled();
  });
  it('allows stream-json approval responders', async () => {
    const options = params('permission');
    vi.spyOn(options.runtimeContext, 'isInteractive').mockReturnValue(false);
    vi.spyOn(options.runtimeContext, 'getInputFormat').mockReturnValue(
      InputFormat.STREAM_JSON,
    );
    options.eventEmitter!.on(
      AgentEventType.TOOL_WAITING_APPROVAL,
      async (event) => event.respond(ToolConfirmationOutcome.ProceedOnce),
    );
    const executor = await create(options);
    await executor.execute(context());
    expect(executor.getFinalText()).toContain('"optionId":"once"');
  });
  it('carries the action arguments into the approval confirmation (R11-5)', async () => {
    const options = params('permission');
    let seenPrompt: unknown;
    options.eventEmitter!.on(
      AgentEventType.TOOL_WAITING_APPROVAL,
      async (event) => {
        seenPrompt = (event as { confirmationDetails?: { prompt?: unknown } })
          .confirmationDetails?.prompt;
        await event.respond(ToolConfirmationOutcome.ProceedOnce);
      },
    );
    const executor = await create(options);
    await executor.execute(context());
    // The approval dialog must show WHAT the user is authorizing — the action's
    // arguments — not just the tool title and the option labels the dialog
    // already renders as buttons. The fixture peer asks permission for a Write
    // whose rawInput carries {command: 'rm -rf ./build'}. Reverting the prompt
    // back to the option-names join turns this red (no command string).
    expect(String(seenPrompt)).toContain('rm -rf ./build');
  });
  it('isolates duplicate outstanding tool IDs and ignores stale approval callbacks', async () => {
    const options = params('permission-duplicate');
    const callbacks: Array<() => Promise<void>> = [];
    options.eventEmitter!.on(AgentEventType.TOOL_WAITING_APPROVAL, (event) => {
      callbacks.push(() => event.respond(ToolConfirmationOutcome.ProceedOnce));
      setTimeout(
        () => void event.respond(ToolConfirmationOutcome.ProceedOnce),
        30,
      );
    });
    const executor = await create(options);
    await executor.execute(context());
    expect(JSON.parse(executor.getFinalText())).toEqual([
      { outcome: { outcome: 'selected', optionId: 'once' } },
      { outcome: { outcome: 'cancelled' } },
    ]);
    await callbacks[0]!();
  });
  it('releases pending permission requests on cancellation', async () => {
    const options = params('permission');
    const abort = new AbortController();
    options.eventEmitter!.on(AgentEventType.TOOL_WAITING_APPROVAL, () =>
      abort.abort(),
    );
    const executor = await create(options);
    await executor.execute(context(), abort.signal);
    expect(executor.getTerminateMode()).toBe(AgentTerminateMode.CANCELLED);
  });
  it('scrubs all internal credentials in the real child environment', async () => {
    for (const name of [
      'QWEN_SERVER_TOKEN',
      'QWEN_DAEMON_TOKEN',
      'QWEN_CODE_EXTERNAL_TOOL_GUARD_TOKEN',
      'QWEN_CODE_PRIVATE_ACP_CAPABILITY',
    ])
      vi.stubEnv(name, 'secret');
    const executor = await create(params('env'));
    await executor.execute(context());
    expect(JSON.parse(executor.getFinalText())).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });
  it('awaits verified disposal of a SIGTERM-resistant descendant', async () => {
    const executor = await create(params('tree'));
    await executor.execute(context());
    const pid = Number(executor.getFinalText());
    expect(pid).toBeGreaterThan(0);
    process.kill(pid, 0);
    await executor.dispose?.();
    expect(() => process.kill(pid, 0)).toThrow();
  }, 15000);
});
