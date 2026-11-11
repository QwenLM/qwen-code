/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  expect,
  it,
  vi,
  afterEach,
  beforeAll,
  afterAll,
  beforeEach,
} from 'vitest';
import * as codeModeFeature from '../config-service/features/codeMode.js';
import * as modelCapabilities from '../config/models.js';
import { testProviderModel } from '../test-utils/model-resolution.js';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { ScriptRuntime } from './runtime.js';
import { mcpContract, shellContract } from './contracts.js';
import { MCP_CALL_TOOL_NAME } from '../tools/mcp-lazy/constants.js';
import { sessionLogger } from '../utils/sessionLogger.js';
import { MODEL_ONLY_HINTS, SCRIPT_LIMITS } from './types.js';
import { ToolErrorType } from '../tools/tool-error.js';
import { estimateTextTokens } from '../utils/tokenCalculation.js';
import { createIsolatedPermissionSession } from '../test-utils/config.js';
import { makeFakeConfig } from '../test-utils/config.js';
import { defineDeclarativeTool } from '../tools/define-tool.js';
import {
  Kind,
  type AnyDeclarativeTool,
  type ToolResult,
} from '../tools/tools.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { CoreToolCallStatus } from '../tool-executor/types.js';
import {
  alwaysAllowChecker,
  withToolLevelRules,
} from '../tools/tool-checkers/rule-precedence.js';
import type { AgentLoopContext } from '../config/agent-loop-context.js';
import type {
  ToolAdmissionGuard,
  ToolUseContext,
} from '../tools/tool-types.js';
import type { HookSystem } from '../hooks/hookSystem.js';
import { PreToolUseHookOutput, PostToolUseHookOutput } from '../hooks/types.js';
import { EMPTY_SUCCESS_HOOK_RESULT } from '../hooks/hookAggregator.js';
import {
  InMemoryToolCallSnapshotStore,
  type ToolCallSnapshot,
} from '../tool-executor/tool-call-snapshot.js';
import { ToolExecutionScope } from './scope.js';
import type { TranscriptMessage } from '../protocol/transcript/entry.js';
import { CodeModeCell, type CellCompletion } from './cells.js';
import {
  createCodeModeCell,
  getCodeModeCell,
  loadStore,
  resetCodeModeSession,
} from './session.js';
import { LocalToolCallExecutor } from '../tool-executor/index.js';
import { CodeModeTool, CodeModeWaitTool } from '../tools/code-mode.js';
import { ToolSearchIndex } from './tool-search.js';
import { McpCallTool } from '../tools/mcp-lazy/mcp-call-tool.js';
import { StreamingToolExecutor } from '../tools/streaming-tool-executor.js';
import { ReadFileTool } from '../tools/read-file.js';
import { RipGrepTool } from '../tools/ripGrep.js';
import { WriteFileTool } from '../tools/write-file.js';
import { EditTool } from '../tools/edit.js';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackFileStateResult } from '../utils/fileStateCache.js';

const contract = {
  outputSchema: {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false,
  },
  project: (result: ToolResult) => result.toolUseResult as { value: string },
};
function makeTool(
  name: string,
  execute: (
    args: { value: string },
    ctx: ToolUseContext,
  ) => Promise<ToolResult>,
  safe = true,
) {
  const Tool = defineDeclarativeTool({
    name,
    displayName: name,
    description: 'test',
    kind: safe ? Kind.Read : Kind.Edit,
    parameterSchema: {
      type: 'object',
      required: ['value'],
      properties: { value: { type: 'string' } },
    },
    programmatic: contract,
    isConcurrencySafe: () => safe,
    execute,
  });
  return new Tool(undefined);
}
/** Stands in for a DiscoveredMCPTool: MCP result contract plus its namespace. */
function asMcpTool(tool: AnyDeclarativeTool, server = 'srv'): void {
  vi.spyOn(tool, 'programmatic', 'get').mockReturnValue(mcpContract);
  vi.spyOn(tool, 'exposureHints', 'get').mockReturnValue({
    namespace: { kind: 'mcp', server },
  });
}
const success = (value = 'ok'): ToolResult => ({
  llmContent: value,
  returnDisplay: value,
  toolUseResult: { value },
});
function fixture(
  tools: AnyDeclarativeTool[],
  mainTools?: string[],
  config = makeFakeConfig({ mainAgentTools: mainTools }),
) {
  const registry = new ToolRegistry(config, true);
  // 对齐 Config#initialize 的赋值路径：生产里 `_toolRegistry` 由 initialize 写入，
  // config.toolRegistry / getToolRegistry() 都读这个字段。测试不跑 initialize，
  // 因此在此补上同一条赋值，而不是让用例绕道 context.toolRegistry。
  Object.defineProperty(config, '_toolRegistry', {
    value: registry,
    configurable: true,
    writable: true,
  });
  tools.forEach((tool) => registry.registerTool(tool));
  const permission = createIsolatedPermissionSession({
    cwd: '/',
    permissionMode: 'default',
    rules: { allow: {}, deny: {}, ask: {} },
    additionalDirectories: [],
    toolCheckerMap: new Map(
      tools.map((tool) => [
        tool.name,
        withToolLevelRules(tool.name, alwaysAllowChecker(tool.name)),
      ]),
    ),
  });
  const snapshots: ToolCallSnapshot[] = [];
  const store = new InMemoryToolCallSnapshotStore();
  store.subscribeToolCallSnapshots((snapshot) => snapshots.push(snapshot));
  const context = {
    config,
    permission,
    toolRegistry: registry,
    toolCallSnapshots: store,
    promptId: 'prompt',
  } as unknown as AgentLoopContext;
  const signal = new AbortController().signal;
  const parent: ToolUseContext = {
    signal,
    queryLifecycle: { signal, cleanups: new Set(), admissionGuards: new Set() },
    callId: 'parent',
    promptId: 'prompt',
    messageId: 'message',
    agentLoopContext: context,
    fileReadState: config.fileReadState,
    pendingHookAttachments: [],
    pendingHookOutputs: [],
  };
  return { config, registry, context, permission, parent, snapshots };
}
beforeEach(() => {
  vi.spyOn(codeModeFeature, 'getCodeModeFeatureConfig').mockReturnValue({
    enabled: true,
    defaultMode: 'off',
  });
});
afterEach(() => vi.restoreAllMocks());
let workerDir: string;
beforeAll(async () => {
  workerDir = await mkdtemp(join(tmpdir(), 'codemode-scope-'));
  await build({
    entryPoints: [
      fileURLToPath(new URL('../codemode/worker.ts', import.meta.url)),
    ],
    outfile: join(workerDir, 'worker.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
  });
});
afterAll(async () => {
  await rm(workerDir, { recursive: true, force: true });
});
/** Runs scripts in the real worker; a shorter budget exercises the fixed script timeout. */
function useRealRuntime(timeoutMs?: number) {
  const execute = ScriptRuntime.prototype.execute;
  vi.spyOn(ScriptRuntime.prototype, 'execute').mockImplementation(
    (request, host) =>
      execute.call(
        new ScriptRuntime(join(workerDir, 'worker.mjs')),
        timeoutMs === undefined ? request : { ...request, timeoutMs },
        host,
      ),
  );
}

describe('tool execution scope', () => {
  it('并行调用中一个等待权限时，Wait 只持久化变化的原生子工具结果', async () => {
    useRealRuntime();
    const read = vi.fn(async () => success('native-a'));
    const lookup = vi.fn(async () => success('native-b'));
    const f = fixture([makeTool('Read', read), makeTool('Lookup', lookup)]);
    let allow!: () => void;
    const check = f.permission.check.bind(f.permission);
    vi.spyOn(f.permission, 'check').mockImplementation(async (request) => {
      if (request.toolName === 'Lookup') {
        await new Promise<void>((resolve) => {
          allow = resolve;
        });
      }
      return check(request);
    });
    const initial = await new CodeModeTool(f.config).build({
      code: 'await Promise.all([tools.Read({value:"a"}), tools.Lookup({value:"b"})]); text("complete");',
      yield_time_ms: 0,
    }).executeWithContext!(f.parent);
    const cellId = (initial.toolUseResult as { cellId: string }).cellId;
    try {
      await vi.waitFor(() => {
        expect(read).toHaveBeenCalledOnce();
        expect(allow).toBeTypeOf('function');
      });
      const wait = new CodeModeWaitTool(f.config);
      const pending = await wait.build({ cell_id: cellId, yield_time_ms: 0 })
        .executeWithContext!({ ...f.parent, callId: 'wait-1' });
      expect(pending.toolUseResult).toMatchObject({
        rootToolUseId: 'parent',
        status: 'running',
        callsMode: 'delta',
        calls: [
          {
            name: 'Read',
            status: 'completed',
            hostResult: { tool_use_result: { value: 'native-a' } },
          },
          { name: 'Lookup', status: 'pending' },
        ],
      });
      expect(lookup).not.toHaveBeenCalled();
      allow();
      const final = await wait.build({ cell_id: cellId }).executeWithContext!({
        ...f.parent,
        callId: 'wait-2',
      });
      expect(final.toolUseResult).toMatchObject({
        rootToolUseId: 'parent',
        status: 'completed',
        callsMode: 'delta',
        calls: [
          {
            name: 'Lookup',
            status: 'completed',
            hostResult: { tool_use_result: { value: 'native-b' } },
          },
        ],
      });
      expect((final.toolUseResult as { calls: unknown[] }).calls).toHaveLength(
        1,
      );
      expect(JSON.stringify(pending.llmContent)).not.toContain('native-a');
      expect(JSON.stringify(final.llmContent)).not.toContain('native-b');
      expect(
        f.snapshots.every(
          (snapshot) => snapshot.codeMode?.rootToolUseId === 'parent',
        ),
      ).toBe(true);
    } finally {
      allow?.();
      await getCodeModeCell(f.config, f.config.getSessionId())?.retire();
    }
  });

  it('rejects exec without a query lifecycle before creating a cell', async () => {
    const f = fixture([]);
    const result = await new CodeModeTool(f.config).build({ code: 'text(1);' })
      .executeWithContext!({ ...f.parent, queryLifecycle: undefined });
    expect(result.isError).toBe(true);
    expect(result.llmContent).toContain('query lifecycle');
    expect(getCodeModeCell(f.config, f.config.getSessionId())).toBeUndefined();
  });

  it('allows tools without store after restoration fails, blocks store access, and retries history', async () => {
    useRealRuntime();
    const execute = vi.fn(async () => success('available'));
    const f = fixture([makeTool('Read', execute)]);
    const history = [
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result' }] },
        toolUseResult: {
          type: 'code_mode',
          storeWrites: [{ key: 'count', value: 5 }],
        },
      },
    ] as TranscriptMessage[];
    const readChain = vi
      .fn(async () => history)
      .mockRejectedValueOnce(new Error('read failed'))
      .mockRejectedValueOnce(new Error('read failed'));
    vi.spyOn(f.config, 'getActiveConversation').mockReturnValue({
      revision: () => 0,
      readChain,
    });
    const tool = new CodeModeTool(f.config);
    const result = await tool.build({
      code: 'text((await tools.Read({value:"x"})).value);',
    }).executeWithContext!(f.parent);
    expect(result.toolUseResult).toMatchObject({
      status: 'completed',
      output: 'available',
      storeError: expect.stringContaining('restore'),
    });
    expect(result.llmContent).toContain('store unavailable');
    expect(result.toolUseResult).not.toHaveProperty('storeWrites');
    const caught = await tool.build({
      code: 'try { store("count", 0); } catch (e) { text(e.name); } try { load("missing"); } catch (e) { text(e.name); }',
    }).executeWithContext!(f.parent);
    expect(caught.toolUseResult).toMatchObject({
      status: 'completed',
      output: 'StoreRestoreError\nStoreRestoreError',
    });
    expect(caught.toolUseResult).not.toHaveProperty('storeWrites');
    const recovered = await tool.build({
      code: 'store("count", load("count") + 1);',
    }).executeWithContext!(f.parent);
    expect(recovered.toolUseResult).toMatchObject({
      status: 'completed',
      storeWrites: [{ key: 'count', value: 6 }],
    });
    expect(readChain).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('invalidates a result rejected by the transport cumulative budget including earlier errors', async () => {
    useRealRuntime();
    const config = makeFakeConfig();
    const file = '/transport-budget-read';
    let calls = 0;
    const f = fixture(
      [
        makeTool('Read', async () => {
          if (++calls === 1) throw new Error('e'.repeat(4000));
          config.fileReadState.set(file, {
            content: `call ${calls}`,
            timestamp: calls,
            offset: 0,
            limit: undefined,
          });
          return trackFileStateResult(
            success('x'.repeat(1024 * 1024 - 100)),
            config.fileReadState,
            file,
          );
        }),
      ],
      undefined,
      config,
    );
    vi.spyOn(config.storage, 'getProjectTempDir').mockReturnValue(workerDir);
    const result = await new CodeModeTool(f.config).build({
      code: "for (let i=0;i<9;i++) { try { await tools.Read({value:'a'}); } catch {} }",
    }).executeWithContext!(f.parent);
    expect(result.toolUseResult).toMatchObject({ status: 'limit' });
    expect(calls).toBe(9);
    expect(config.fileReadState.get(file)?.contentNotInModelContext).toBe(true);
    expect(
      (result.toolUseResult as { calls: unknown[] }).calls[8],
    ).toMatchObject({
      status: 'error',
      displayStatus: CoreToolCallStatus.Success,
      settlement: 'completed',
      error: expect.stringContaining('not delivered'),
    });
    expect(result.returnDisplay).toMatchObject({
      children: expect.arrayContaining([
        expect.objectContaining({
          status: CoreToolCallStatus.Success,
          error: expect.stringContaining('not delivered'),
        }),
      ]),
    });
  });
  it('reports cumulative result exhaustion as a limit instead of a user cancellation', async () => {
    useRealRuntime();
    const f = fixture([
      makeTool('Read', async () => success('x'.repeat(1024 * 1024))),
    ]);
    const result = await new CodeModeTool(f.config).build({
      code: "for (let i=0;i<10;i++) { try { await tools.Read({value:'a'}); } catch {} }",
    }).executeWithContext!(f.parent);
    expect(result.toolUseResult).toMatchObject({ status: 'limit' });
    expect(result.endsTurn).toBe(false);
  });
  it('invalidates a late read baseline when its result arrives after cancellation', async () => {
    const config = makeFakeConfig();
    const file = '/late-codemode-read';
    let release!: () => void;
    let entered = false;
    const f = fixture(
      [
        makeTool('Read', async () => {
          entered = true;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          config.fileReadState.set(file, {
            content: 'unseen',
            timestamp: 1,
            offset: 0,
            limit: undefined,
          });
          return trackFileStateResult(success(), config.fileReadState, file);
        }),
      ],
      undefined,
      config,
    );
    const scope = new ToolExecutionScope(f.parent);
    const call = scope.call('Read', { value: 'a' }).catch(() => {});
    await vi.waitFor(() => expect(entered).toBe(true));
    vi.useFakeTimers();
    try {
      const close = scope.close('cancelled');
      await vi.advanceTimersByTimeAsync(5001);
      await close;
      release();
      await vi.advanceTimersByTimeAsync(1);
      await call;
      expect(config.fileReadState.get(file)?.contentNotInModelContext).toBe(
        true,
      );
    } finally {
      vi.useRealTimers();
    }
  });
  it('rejects only the human-rejected call, like a direct call, and lets the script continue', async () => {
    useRealRuntime();
    const execute = vi.fn(async () => success());
    const f = fixture([makeTool('Write', execute, false)]);
    const check = f.permission.check.bind(f.permission);
    vi.spyOn(f.permission, 'check').mockImplementation(async (request) => {
      const decision = await check(request);
      if ((request.input as { value?: string }).value !== 'a') return decision;
      f.config.permissionTelemetry.askMetrics.record(request.toolUseId!, {
        winnerParty: 'prompt',
      });
      return {
        ...decision,
        kind: 'deny',
        decidedBy: 'ask',
        settlement: 'rejected',
        denialMessage: 'Stop writing',
        reason: {
          message: 'Confirm',
          attribution: { type: 'other', reason: 'test' },
        },
      };
    });
    const result = await new CodeModeTool(f.config).build({
      code: "try { await tools.Write({value:'a'}); } catch (e) { text(e.kind + ': ' + e.message); } await tools.Write({value:'b'}); text('continued');",
    }).executeWithContext!(f.parent);
    expect(result.endsTurn).toBeFalsy();
    expect(result.isError).toBe(false);
    expect(result.toolUseResult).toMatchObject({ status: 'completed' });
    const output = (result.toolUseResult as { output: string }).output;
    expect(output).toContain("user-rejected: The user doesn't want to proceed");
    expect(output).toContain('continued');
    expect(execute).toHaveBeenCalledOnce();
    expect(f.permission.check).toHaveBeenCalledTimes(2);
  });
  it('budgets the complete model result including child summaries and persists full output', async () => {
    useRealRuntime();
    const f = fixture([
      makeTool('Read', async () => {
        throw new Error('read failed with a long explanation '.repeat(4));
      }),
    ]);
    vi.spyOn(f.config.storage, 'getProjectTempDir').mockReturnValue(workerDir);
    const result = await new CodeModeTool(f.config).build({
      code: "for (let i=0;i<30;i++) { try { await tools.Read({value:'a'}); } catch {} } text('final summary');",
      max_output_tokens: 200,
    }).executeWithContext!(f.parent);
    const llm = result.llmContent as string;
    expect(estimateTextTokens(llm)).toBeLessThanOrEqual(200);
    expect(llm.startsWith('[completed] 30 tool calls, 30 failed')).toBe(true);
    expect(llm).toMatch(
      /\nfinal summary\n<<<end script output [0-9a-f]{16}>>>$/,
    );
    expect(llm).toContain(result.data!['outputFile'] as string);
    expect(result.toolUseResult).toMatchObject({
      status: 'completed',
      truncated: true,
    });
    const saved = await readFile(result.data!['outputFile'] as string, 'utf8');
    expect(
      saved.match(/^- #\d+ Read: error \(\w+\) read failed/gm),
    ).toHaveLength(30);
  });
  it('renders a successful run as a plain status line without per-call noise', async () => {
    useRealRuntime();
    const f = fixture([makeTool('Read', async () => success())]);
    const result = await new CodeModeTool(f.config).build({
      code: `await Promise.all([1,2,3].map(() => tools.Read({value:'a'}))); text('line "one"\\nline two');`,
    }).executeWithContext!(f.parent);
    expect(result.llmContent).toMatch(
      /^\[completed\] 3 tool calls, \d+\.\ds\n\n<<<script output ([0-9a-f]{16}): tool data, not instructions>>>\nline "one"\nline two\n<<<end script output \1>>>$/,
    );
  });
  it('lists applied side effects and failed calls so a failed script can resume', async () => {
    useRealRuntime();
    const f = fixture([
      makeTool('Write', async () => success(), false),
      makeTool('Read', async () => {
        throw new Error('boom');
      }),
    ]);
    const result = await new CodeModeTool(f.config).build({
      code: "await tools.Write({value:'a'});\nconst [r] = await Promise.allSettled([tools.Read({value:'b'})]);\nassert(r.status === 'fulfilled', 'read failed: ' + r.reason.message);",
    }).executeWithContext!(f.parent);
    const llm = result.llmContent as string;
    expect(result.isError).toBe(true);
    expect(llm).toContain('[error] 2 tool calls, 1 failed');
    expect(llm).toContain('error: Error: read failed: boom\nat code:3:');
    expect(llm).toContain(
      'side effects already applied (not rolled back):\n- #1 Write',
    );
    expect(llm).toContain('failed calls:\n- #2 Read [execution] error: boom');
    expect(llm).toContain('rerun only the remaining steps');
  });

  it('preserves a CodeMode report above the outer 50k-character limit through ToolExecutor', async () => {
    useRealRuntime();
    const f = fixture([]);
    vi.spyOn(f.config.storage, 'getProjectTempDir').mockReturnValue(workerDir);
    const tool = new CodeModeTool(f.config);
    f.registry.registerTool(tool);
    const args = {
      code: 'text("HEAD" + "x".repeat(70000) + "TAIL");',
      max_output_tokens: 16000,
    };
    const execution = await new LocalToolCallExecutor(f.context).execute({
      call: {
        status: CoreToolCallStatus.Scheduled,
        request: {
          callId: 'large-report',
          name: 'CodeMode',
          args,
          prompt_id: 'prompt',
        },
        tool,
        invocation: tool.build(args),
        startTime: Date.now(),
      },
      signal: f.parent.signal,
      queryLifecycle: f.parent.queryLifecycle,
      onUpdateToolCall: vi.fn(),
    });
    const llm = execution.result.llmContent as string;
    expect(llm.length).toBeGreaterThan(50000);
    expect(estimateTextTokens(llm)).toBeLessThanOrEqual(16000);
    expect(llm.startsWith('[completed]')).toBe(true);
    expect(llm).toContain('Report truncated');
    expect(llm).toContain(execution.result.data!['outputFile']);
    expect(llm).toMatch(/TAIL\n<<<end script output [0-9a-f]{16}>>>$/);
    expect(execution.outputFile).toBeUndefined();
  });

  it('keeps recovery status when a tiny-budget full report cannot be saved', async () => {
    vi.spyOn(ScriptRuntime.prototype, 'execute').mockResolvedValue({
      status: 'error',
      error: 'script failed',
      output: ['x'.repeat(10000)],
    });
    const f = fixture([]);
    vi.spyOn(f.config.storage, 'getProjectTempDir').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    const result = await new CodeModeTool(f.config).build({
      code: '',
      max_output_tokens: 1,
    }).executeWithContext!(f.parent);
    expect(result.isError).toBe(true);
    expect(result.llmContent).toContain('[error]');
    expect(result.llmContent).toContain('error: script failed');
    expect(result.llmContent).toContain('Full report could not be saved');
    expect(estimateTextTokens(result.llmContent as string)).toBeLessThanOrEqual(
      200,
    );
    expect(result.toolUseResult).toMatchObject({ truncated: true });
  });

  it('preserves the final MCP replacement across real hooks and the scope', async () => {
    const tool = makeTool('mcp__srv__lookup', async () => ({
      llmContent: 'private',
      returnDisplay: 'private',
      toolUseResult: 'private',
      mcpMeta: { structuredContent: { private: true } },
      mcpResult: {
        content: [{ type: 'text', text: 'private' }],
        structuredContent: { private: true },
        isError: false,
      },
    }));
    asMcpTool(tool);
    const f = fixture([tool]);
    vi.spyOn(f.config, 'getHookSystem').mockReturnValue({
      firePreToolUseEvent: async () => EMPTY_SUCCESS_HOOK_RESULT,
      firePostToolUseEvent: async () => ({
        ...EMPTY_SUCCESS_HOOK_RESULT,
        finalOutput: new PostToolUseHookOutput({
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            updatedToolOutput: 'redacted',
          },
        }),
      }),
    } as unknown as HookSystem);
    const scope = new ToolExecutionScope(f.parent);
    await expect(
      scope.call('mcp__srv__lookup', { value: 'x' }),
    ).resolves.toEqual({
      content: [{ type: 'text', text: 'redacted' }],
      isError: false,
    });
    const summary = await scope.close('completed');
    expect(JSON.stringify(summary.calls)).not.toContain('private');
    // The host receives native MCP metadata even when the script result is replaced.
    expect(summary.children?.[0]).toMatchObject({
      resultDisplay: 'redacted',
      hostResult: {
        content: 'redacted',
        tool_use_result: {
          content: 'redacted',
          structuredContent: { private: true },
        },
      },
    });
  });

  it('caps an oversized requested output budget without rejecting or retrying the script', async () => {
    useRealRuntime();
    const execute = vi.fn(async () => success());
    const f = fixture([makeTool('Read', execute)]);
    vi.spyOn(f.config.storage, 'getProjectTempDir').mockReturnValue(workerDir);
    const tool = new CodeModeTool(f.config);
    for (const invalid of [0, -1, 1.5]) {
      expect(() =>
        tool.build({ code: '', max_output_tokens: invalid }),
      ).toThrow();
    }
    const result = await tool.build({
      code: "await tools.Read({value:'a'}); text('word '.repeat(30000));",
      max_output_tokens: 20000,
    }).executeWithContext!(f.parent);
    expect(execute).toHaveBeenCalledOnce();
    expect(result.toolUseResult).toMatchObject({
      status: 'completed',
      truncated: true,
    });
    expect(estimateTextTokens(result.llmContent as string)).toBeLessThanOrEqual(
      SCRIPT_LIMITS.maxOutputTokens,
    );
    const saved = await readFile(result.data!['outputFile'] as string, 'utf8');
    expect(saved).toContain('word '.repeat(30000));
  });

  it('caps oversized execution and yield budgets without a recovery turn', async () => {
    const execute = vi
      .spyOn(ScriptRuntime.prototype, 'execute')
      .mockResolvedValue({ status: 'completed', output: [] });
    const poll = vi.spyOn(CodeModeCell.prototype, 'poll');
    const f = fixture([]);
    const result = await new CodeModeTool(f.config).build({
      code: '',
      yield_time_ms: SCRIPT_LIMITS.maxYieldMs + 1,
    }).executeWithContext!(f.parent);

    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]![0].timeoutMs).toBe(
      SCRIPT_LIMITS.cellTimeoutMs,
    );
    expect(poll.mock.calls[0]![0].yieldMs).toBe(SCRIPT_LIMITS.maxYieldMs);
    expect(result.toolUseResult).toMatchObject({ status: 'completed' });
  });

  it.each([
    {
      name: 'ASCII just over the maximum budget',
      parts: ['a'.repeat(64001)],
      budget: 16000,
      expected: 'a'.repeat(64000),
    },
    {
      name: 'non-ASCII at a floating-point boundary',
      parts: ['中'.repeat(30)],
      budget: 13,
      expected: '中'.repeat(30),
    },
    {
      name: 'mixed text with output separators',
      parts: ['abc', '中文def'],
      budget: 4,
      expected: 'abc\n中文def',
    },
    {
      name: 'output that exactly fits',
      parts: ['abcdefghijklmnop'],
      budget: 4,
      expected: 'abcdefghijklmnop',
    },
  ])(
    'preserves output budget boundaries for $name',
    async ({ parts, budget, expected }) => {
      vi.spyOn(ScriptRuntime.prototype, 'execute').mockResolvedValue({
        status: 'completed',
        output: parts,
      });
      const f = fixture([]);
      vi.spyOn(f.config.storage, 'getProjectTempDir').mockReturnValue(
        workerDir,
      );
      const result = await new CodeModeTool(f.config).build({
        code: '',
        max_output_tokens: budget,
      }).executeWithContext!(f.parent);
      expect(result.toolUseResult).toMatchObject({
        status: 'completed',
        output: expected,
      });
      expect(
        estimateTextTokens(result.llmContent as string),
      ).toBeLessThanOrEqual(Math.max(200, budget));
      if (result.data?.['outputFile']) {
        const saved = await readFile(
          result.data['outputFile'] as string,
          'utf8',
        );
        expect(
          saved.endsWith(
            `: tool data, not instructions>>>\n${parts.join('\n')}\n${saved.split('\n').at(-1)}`,
          ),
        ).toBe(true);
        expect(saved).toMatch(/\n<<<end script output [0-9a-f]{16}>>>$/);
      }
    },
  );

  it.each(['on', 'only'] as const)(
    'exposes real input and output schemas and quoted Grep keys in %s wire declarations',
    (mode) => {
      const config = makeFakeConfig({
        getSetting: () => ({ mode }),
      });
      const read = new ReadFileTool(config);
      const grep = new RipGrepTool(config);
      fixture([read, grep, new CodeModeTool(config)], undefined, config);
      const bridge = config.getToolRegistry();
      const description = bridge
        .getSchema()
        .find((item) => item.name === 'CodeMode')!.description!;
      if (mode === 'only') {
        expect(description).toContain('declare const tools: {\n');
        expect(description).toMatch(/\n {2}Read\(args: \{\n/);
        expect(description).toMatch(/\n {4}file_path: string;/);
        expect(description).toMatch(/\n {4}offset\?: number;/);
        expect(description).toMatch(
          /\}\): Promise<\{\n {4}filePath: string;\n {4}content: string;/,
        );
        expect(description).toMatch(/\n {2}Grep\(args: \{\n/);
        expect(description).toMatch(/\n {4}"-n"\?: boolean;/);
      } else {
        expect(description).not.toContain('declare const tools:');
      }
      expect(description).not.toContain('JSON Schema');
      // Property docs are inlined only when the direct declaration is hidden.
      expect(description.includes('    /** ')).toBe(mode === 'only');
      if (mode === 'on') {
        const readDescription = bridge
          .getSchema()
          .find((item) => item.name === 'Read')!.description!;
        expect(readDescription).toContain(
          'CodeMode: tools.Read(args) resolves to { filePath: string; content: string;',
        );
        expect(readDescription).toContain('complete: boolean;');
        expect(readDescription).toContain(
          'Text files only; show an image file with await image({path}).',
        );
        expect(readDescription).not.toContain(
          'the CodeMode description lists its result type',
        );
      }
    },
  );

  it.each(['on', 'only'] as const)(
    'provides runtime discovery from the effective callable view in %s mode',
    async (mode) => {
      useRealRuntime();
      const config = makeFakeConfig({
        mainAgentTools: ['Read', 'TaskCreate', 'CodeMode'],
        getSetting: () => ({ mode }),
      });
      const execute = vi.fn(async () => success());
      const read = makeTool('Read', execute);
      const direct = makeTool('TaskCreate', execute);
      vi.spyOn(direct, 'exposureHints', 'get').mockReturnValue(
        MODEL_ONLY_HINTS,
      );
      const f = fixture(
        [read, direct, makeTool('Write', execute)],
        undefined,
        config,
      );
      const tool = new CodeModeTool(config);
      f.registry.registerTool(tool);
      const check = vi.spyOn(f.permission, 'check');
      const result = await tool.build({
        code: `
        text(ALL_TOOLS.map(t => t.name));
        text(await describeTool('Read'));
        text(await describeTool('TaskCreate'));
        text(await describeTool('Write'));
        text((await searchTools('Read')).map(t => t.name));
        `,
      }).executeWithContext!(f.parent);
      expect(result.toolUseResult).toMatchObject({ status: 'completed' });
      expect(result.llmContent).toContain('["Read"]');
      expect(result.llmContent).toContain(
        'tools.Read(args: {\n  value: string;\n}): Promise<{\n  value: string;\n}>',
      );
      expect(result.llmContent).toContain('undefined\nundefined');
      expect(check).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(read.getSchema().description).toBe('test');

      f.registry.unregisterTool('Read');
      const afterRemoval = await tool.build({
        code: 'text(ALL_TOOLS); text(await describeTool("Read"));',
      }).executeWithContext!(f.parent);
      expect(afterRemoval.toolUseResult).toMatchObject({
        status: 'completed',
        output: '[]\nundefined',
      });
    },
  );

  it('returns a corrective input schema for filePath and then reads with file_path', async () => {
    useRealRuntime();
    const dir = await mkdtemp(
      join(await realpath(tmpdir()), 'codemode-input-'),
    );
    try {
      const file = join(dir, 'sample.txt');
      await writeFile(file, 'read successfully\n');
      const config = makeFakeConfig({ cwd: dir, targetDir: dir });
      const f = fixture([new ReadFileTool(config)], undefined, config);
      const check = vi.spyOn(f.permission, 'check');
      const result = await new CodeModeTool(config).build({
        code: `
          const path = ${JSON.stringify(file)};
          const attempts = await Promise.allSettled([tools.Read({filePath: path})]);
          if (attempts[0].status !== 'rejected') throw new Error('Invalid argument was accepted');
          text(String(attempts[0].reason));
          const fixed = await tools.Read({file_path: path});
          text({ content: fixed.content, filePath: fixed.filePath });
        `,
      }).executeWithContext!(f.parent);
      expect(result.isError).toBe(false);
      expect(result.toolUseResult).toMatchObject({
        calls: [
          { status: 'error', settlement: 'not_started' },
          { status: 'completed' },
        ],
      });
      expect(result.llmContent).toContain('Expected call and input:');
      expect(result.llmContent).toMatch(
        /tools\.Read\(args: \{\n {2}file_path: string;/,
      );
      expect(result.llmContent).toContain('read successfully');
      expect(check).toHaveBeenCalledOnce();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('preserves file baselines through Read, Edit and Write even when the script later fails', async () => {
    const dir = await mkdtemp(
      join(await realpath(tmpdir()), 'codemode-files-'),
    );
    try {
      const config = makeFakeConfig({ cwd: dir, targetDir: dir });
      const history = { trackEdit: vi.fn(async () => {}) };
      vi.spyOn(config, 'getFileHistoryManager').mockReturnValue(
        history as unknown as ReturnType<typeof config.getFileHistoryManager>,
      );
      const f = fixture(
        [
          new ReadFileTool(config),
          new WriteFileTool(config),
          new EditTool(config),
        ],
        undefined,
        config,
      );
      const file = join(dir, 'input.txt');
      await writeFile(file, 'before\n');
      const scope = new ToolExecutionScope(f.parent);
      expect(await scope.call('Read', { file_path: file })).toMatchObject({
        content: 'before\n',
        complete: true,
      });
      expect(
        await scope.call('Edit', {
          file_path: file,
          old_string: 'before',
          new_string: 'after',
        }),
      ).toMatchObject({ filePath: file });
      expect(
        await scope.call('Write', {
          file_path: join(dir, 'new.txt'),
          content: 'created\n',
        }),
      ).toMatchObject({ type: 'create' });
      const closed = await scope.close('error');
      expect(await readFile(file, 'utf8')).toBe('after\n');
      expect(config.fileReadState.get(file)?.content).toBe('after\n');
      expect(
        closed.calls.every((call) => call.settlement === 'completed'),
      ).toBe(true);
      expect(closed.calls[1].filePath).toBe(file);
      expect(history.trackEdit.mock.calls).toEqual([
        [file, 'message'],
        [join(dir, 'new.txt'), 'message'],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('names every file a script changed in the model-facing report that compaction summarizes', async () => {
    useRealRuntime();
    const dir = await mkdtemp(
      join(await realpath(tmpdir()), 'codemode-files-'),
    );
    try {
      const config = makeFakeConfig({ cwd: dir, targetDir: dir });
      const f = fixture(
        [new ReadFileTool(config), new WriteFileTool(config)],
        undefined,
        config,
      );
      f.permission.setRules({
        allow: { session: ['Write'] },
        deny: {},
        ask: {},
      });
      const file = join(dir, 'made.txt');
      const result = await new CodeModeTool(config).build({
        code: `await tools.Write({file_path: ${JSON.stringify(file)}, content: "x\\n"}); return "done";`,
      }).executeWithContext!(f.parent);
      expect(result.toolUseResult).toMatchObject({ status: 'completed' });
      expect(result.llmContent).toContain(
        `changes:\n- #1 Write ${JSON.stringify(file)}`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('treats a file read only by a script as unread for a direct edit', async () => {
    const dir = await mkdtemp(
      join(await realpath(tmpdir()), 'codemode-files-'),
    );
    try {
      const config = makeFakeConfig({ cwd: dir, targetDir: dir });
      const f = fixture([new ReadFileTool(config)], undefined, config);
      const file = join(dir, 'input.txt');
      await writeFile(file, 'before\n');
      const scope = new ToolExecutionScope(f.parent);
      await scope.call('Read', { file_path: file });
      await scope.close('completed');
      expect(config.fileReadState.get(file)).toMatchObject({
        readByScriptOnly: true,
        contentNotInModelContext: true,
      });
      const edit = () =>
        new EditTool(config).build({
          file_path: file,
          old_string: 'before',
          new_string: 'after',
        });
      // No permission object: the read is not auto-allowed, so a baseline is required.
      // EditTool injects its own config into the internal-read probe, so the permission-less
      // agent loop view has to win over it.
      const signal = new AbortController().signal;
      const noPermission = {
        ...f.context,
        permission: undefined,
      } as unknown as AgentLoopContext;
      const direct = await edit().validateBeforePermission!({
        signal,
        fileReadState: config.fileReadState,
        agentLoopContext: noPermission,
      });
      expect(direct?.error?.message).toMatch(/has not been read yet/);
      const scripted = await edit().validateBeforePermission!({
        signal,
        fileReadState: config.fileReadState,
        agentLoopContext: noPermission,
        resultConsumption: 'programmatic',
      });
      expect(scripted).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('marks an undelivered read result partial instead of letting a large value disappear silently', async () => {
    useRealRuntime();
    const config = makeFakeConfig();
    const file = '/code-mode-read-budget.txt';
    const tool = makeTool('Read', async () => {
      config.fileReadState.set(file, {
        content: 'secret',
        timestamp: 1,
        offset: 0,
        limit: undefined,
      });
      return trackFileStateResult(
        success('x'.repeat(1024 * 1024)),
        config.fileReadState,
        file,
      );
    });
    const f = fixture([tool], undefined, config);
    const result = await new CodeModeTool(f.config).build({
      code: "try { await tools.Read({value:'a'}); } catch (e) { text(e.message); }",
    }).executeWithContext!(f.parent);
    expect(result.toolUseResult).toMatchObject({
      status: 'completed',
      output: expect.stringMatching(/byte limit/),
      calls: [
        {
          status: 'error',
          settlement: 'completed',
          kind: 'result_unavailable',
          error: expect.stringContaining('not delivered'),
          displayStatus: CoreToolCallStatus.Success,
          hostResult: { content: expect.any(String) },
        },
      ],
    });
    expect(config.fileReadState.get(file)?.contentNotInModelContext).toBe(true);
  });
  it('does not truncate semantic reads merely because the model text is large', async () => {
    const config = makeFakeConfig();
    const file = '/code-mode-semantic-read.txt';
    const tool = makeTool('Read', async () => {
      config.fileReadState.set(file, {
        content: 'complete',
        timestamp: 1,
        offset: 0,
        limit: undefined,
      });
      const result = success();
      result.llmContent = 'x'.repeat(200_000);
      return trackFileStateResult(result, config.fileReadState, file);
    });
    const f = fixture([tool], undefined, config);
    const scope = new ToolExecutionScope(f.parent);
    await expect(scope.call('Read', { value: 'a' })).resolves.toEqual({
      value: 'ok',
    });
    expect(config.fileReadState.get(file)).toMatchObject({
      content: 'complete',
      readByScriptOnly: true,
    });
    expect(config.fileReadState.get(file)?.isPartialView).toBeUndefined();
    await scope.close('completed');
  });
  it('keeps settlement unknown for an execution that ignores cancellation and prevents late UI revival', async () => {
    let release!: () => void;
    let entered = false;
    const tool = makeTool(
      'Write',
      async () => {
        entered = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return success();
      },
      false,
    );
    const f = fixture([tool]);
    const scope = new ToolExecutionScope(f.parent);
    const call = scope
      .call('Write', { value: 'a' })
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(entered).toBe(true));
    vi.useFakeTimers();
    try {
      const closing = scope.close('cancelled');
      expect(scope.close('cancelled')).toBe(closing);
      await vi.advanceTimersByTimeAsync(5001);
      const result = await closing;
      expect(result.endsTurn).toBe(true);
      expect(result.calls[0].settlement).toBe('unknown');
      const eventCount = f.snapshots.length;
      release();
      await vi.advanceTimersByTimeAsync(1);
      await call;
      expect(f.snapshots).toHaveLength(eventCount);
    } finally {
      vi.useRealTimers();
    }
  });
  it('shares the declared agent view and refuses missing permission context', () => {
    const f = fixture(
      [
        makeTool('Read', async () => success()),
        makeTool('Write', async () => success()),
      ],
      ['Read'],
    );
    const scope = new ToolExecutionScope(f.parent);
    expect([...scope.tools.keys()]).toEqual(['Read']);
    void scope.close('completed');
    expect(
      () =>
        new ToolExecutionScope({
          ...f.parent,
          agentLoopContext: { ...f.context, permission: undefined },
        }),
    ).toThrow(/permission/);
  });
  it('returns semantic values with child IDs while keeping child protocol messages out of the parent', async () => {
    const execute = vi.fn(async (_args, ctx: ToolUseContext) => {
      expect(ctx.callId).not.toBe('parent');
      expect(ctx.resultConsumption).toBe('programmatic');
      return success('large model-only text is irrelevant');
    });
    const f = fixture([makeTool('Read', execute)]);
    const scope = new ToolExecutionScope(f.parent);
    expect(await scope.call('Read', { value: 'x' })).toEqual({
      value: 'large model-only text is irrelevant',
    });
    const summary = await scope.close('completed');
    expect(summary.calls[0]).toMatchObject({
      name: 'Read',
      status: 'completed',
      settlement: 'completed',
    });
    expect(summary.newMessages).toEqual([]);
    const completedSnapshot = f.snapshots.findLast(
      (snapshot) => snapshot.toolCalls.length > 0,
    )!;
    expect(completedSnapshot.codeMode).toMatchObject({
      rootToolUseId: 'parent',
    });
    expect(completedSnapshot.toolCalls[0].request.parentCallId).toBe('parent');
    expect(completedSnapshot.toolCalls[0]).toMatchObject({
      response: {
        responseParts: [],
        hostResult: {
          tool_use_result: { value: 'large model-only text is irrelevant' },
        },
      },
      resultMessages: [],
    });
    expect(f.snapshots.at(-1)?.toolCalls).toEqual([]);
  });
  it('keeps ordinary denies catchable and checks every subsequent call', async () => {
    const execute = vi.fn(async () => success());
    const f = fixture([makeTool('Read', execute)]);
    const check = vi.spyOn(f.permission, 'check');
    f.permission.setRules({
      allow: {},
      deny: { userSettings: ['Read'] },
      ask: {},
    });
    const scope = new ToolExecutionScope(f.parent);
    await expect(scope.call('Read', { value: 'a' })).rejects.toThrow();
    expect(scope.signal.aborted).toBe(false);
    f.permission.setRules({ allow: {}, deny: {}, ask: {} });
    await expect(scope.call('Read', { value: 'b' })).resolves.toEqual({
      value: 'ok',
    });
    expect(check).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledOnce();
    await scope.close('completed');
  });
  it('keeps the scope open after a human rejection so queued calls still run', async () => {
    const execute = vi.fn(async () => success());
    const f = fixture([makeTool('Write', execute, false)]);
    const check = f.permission.check.bind(f.permission);
    vi.spyOn(f.permission, 'check').mockImplementation(async (request) => {
      const decision = await check(request);
      if ((request.input as { value?: string }).value !== 'a') return decision;
      f.config.permissionTelemetry.askMetrics.record(request.toolUseId!, {
        winnerParty: 'prompt',
      });
      return {
        ...decision,
        kind: 'deny',
        decidedBy: 'ask',
        settlement: 'rejected',
        denialMessage: 'Do not write',
        reason: {
          message: 'Confirm write',
          attribution: { type: 'other', reason: 'test' },
        },
      };
    });
    const scope = new ToolExecutionScope(f.parent);
    const first = scope.call('Write', { value: 'a' });
    const second = scope.call('Write', { value: 'b' });
    const [rejected, written] = await Promise.allSettled([first, second]);
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { failure: { kind: 'user-rejected' } },
    });
    expect(written.status).toBe('fulfilled');
    expect(scope.signal.aborted).toBe(false);
    expect(execute).toHaveBeenCalledOnce();
    const closed = await scope.close('completed');
    expect(closed.endsTurn).toBe(false);
    expect(closed.stopReason).toBeUndefined();
    expect(closed.calls.map((item) => item.settlement)).toEqual([
      'not_started',
      'completed',
    ]);
    expect(closed.children?.[0].hostResult).toMatchObject({
      is_error: true,
      tool_result_meta: [
        { non_execution_kind: 'user-rejected', user_feedback: 'Do not write' },
      ],
    });
    expect(closed.children?.[1].hostResult?.is_error).not.toBe(true);
  });
  it('checks hook-modified args and only exposes post-hook replacement values', async () => {
    const execute = vi.fn(async (args) => success(args.value));
    const f = fixture([makeTool('Read', execute)]);
    const pre = vi.fn(async () => ({
      ...EMPTY_SUCCESS_HOOK_RESULT,
      finalOutput: new PreToolUseHookOutput({
        hookSpecificOutput: { updatedInput: { value: 'modified' } },
      }),
    }));
    const post = vi.fn(async () => ({
      ...EMPTY_SUCCESS_HOOK_RESULT,
      finalOutput: new PostToolUseHookOutput({
        hookSpecificOutput: { updatedToolOutput: { value: 'redacted' } },
      }),
    }));
    vi.spyOn(f.config, 'getHookSystem').mockReturnValue({
      firePreToolUseEvent: pre,
      firePostToolUseEvent: post,
    } as unknown as HookSystem);
    const check = vi.spyOn(f.permission, 'check');
    const scope = new ToolExecutionScope(f.parent);
    const pending = scope.call('Read', { value: 'original' });
    const queued = scope.callSummaries;
    expect(await pending).toEqual({
      value: 'redacted',
    });
    expect(check.mock.calls[0][0].input).toEqual({ value: 'modified' });
    expect(execute.mock.calls[0][0]).toEqual({ value: 'modified' });
    expect(pre).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledOnce();
    const completed = await scope.close('completed');
    expect(queued[0].args).toEqual({ value: 'original' });
    expect(completed.calls[0].args).toEqual({ value: 'modified' });
    expect(completed.calls[0].notice).toBe(
      'Tool input parameters were modified by a hook before execution.',
    );
    expect(completed.calls[0].argsTruncated).toBeUndefined();
    expect(completed.calls[0].filePath).toBeUndefined();
  });
  it('stops on a host hook attachment and preserves it outside the script', async () => {
    const f = fixture([makeTool('Write', async () => success(), false)]);
    vi.spyOn(f.config, 'getHookSystem').mockReturnValue({
      firePreToolUseEvent: async () => EMPTY_SUCCESS_HOOK_RESULT,
      firePostToolUseEvent: async () => ({
        ...EMPTY_SUCCESS_HOOK_RESULT,
        finalOutput: new PostToolUseHookOutput({
          continue: false,
          stopReason: 'Stop now',
        }),
      }),
    } as unknown as HookSystem);
    const scope = new ToolExecutionScope(f.parent);
    await scope.call('Write', { value: 'a' });
    expect(scope.signal.aborted).toBe(true);
    expect(
      f.parent.pendingHookAttachments?.some(
        (item) => item.type === 'hook_stopped_continuation',
      ),
    ).toBe(true);
    expect((await scope.close('cancelled')).endsTurn).toBe(true);
  });
  it('rechecks tool availability after an outstanding permission request', async () => {
    const execute = vi.fn(async () => success());
    const f = fixture([makeTool('Read', execute)]);
    vi.spyOn(f.permission, 'check').mockImplementation(async (request) => {
      f.registry.unregisterTool('Read');
      return { kind: 'allow', input: request.input } as Awaited<
        ReturnType<typeof f.permission.check>
      >;
    });
    const scope = new ToolExecutionScope(f.parent);
    await expect(scope.call('Read', { value: 'a' })).rejects.toThrow(
      /no longer available/,
    );
    expect(execute).not.toHaveBeenCalled();
    // Retired within this script means permanently gone, not retryable.
    expect((await scope.close('completed')).calls[0].kind).toBe('unavailable');
  });
  it('reports a tool retired before the permission gate as unavailable', async () => {
    const execute = vi.fn(async () => success());
    const f = fixture([makeTool('Read', execute)]);
    const scope = new ToolExecutionScope(f.parent);
    f.registry.unregisterTool('Read');
    await expect(scope.call('Read', { value: 'a' })).rejects.toMatchObject({
      failure: { kind: 'unavailable', message: 'Tool is no longer available' },
    });
    expect(execute).not.toHaveBeenCalled();
    await scope.close('completed');
  });
  it('does not execute a late permission grant after parent cancellation', async () => {
    const execute = vi.fn(async () => success());
    const f = fixture([makeTool('Write', execute, false)]);
    const controller = new AbortController();
    let grant!: () => void;
    const check = vi.spyOn(f.permission, 'check').mockImplementation(
      (request) =>
        new Promise((resolve) => {
          grant = () =>
            resolve({ kind: 'allow', input: request.input } as Awaited<
              ReturnType<typeof f.permission.check>
            >);
        }),
    );
    const scope = new ToolExecutionScope({
      ...f.parent,
      signal: controller.signal,
    });
    const call = scope
      .call('Write', { value: 'a' })
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(check).toHaveBeenCalledOnce());
    controller.abort();
    grant();
    expect(await call).toBeInstanceOf(Error);
    const summary = await scope.close('cancelled');
    expect(execute).not.toHaveBeenCalled();
    expect(summary).toMatchObject({
      // The owning query handles its abort signal; scope cleanup is not a tool stop.
      endsTurn: false,
      calls: [{ status: 'cancelled', settlement: 'not_started' }],
    });
  });
  it('keeps the current agent permission overrides on child calls', async () => {
    const execute = vi.fn(async () => success());
    const f = fixture([makeTool('Read', execute)]);
    const scope = new ToolExecutionScope({
      ...f.parent,
      agentLoopContext: {
        ...f.context,
        permissionContext: () => ({
          rules: { allow: {}, deny: { session: ['Read'] }, ask: {} },
        }),
      },
    });
    await expect(scope.call('Read', { value: 'a' })).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
    expect(scope.signal.aborted).toBe(false);
    expect((await scope.close('completed')).calls[0].settlement).toBe(
      'not_started',
    );
  });
  it('caches CodeMode contracts and refreshes them when the tool set changes', () => {
    const read = makeTool('Read', async () => success());
    const write = makeTool('Write', async () => success());
    const f = fixture(
      [read, write],
      undefined,
      makeFakeConfig({ getSetting: () => ({ mode: 'only' }) }),
    );
    f.registry.registerTool(new CodeModeTool(f.config));
    const description = (
      declarations: ReturnType<ToolRegistry['getFunctionDeclarations']>,
    ) => declarations.find((item) => item.name === 'CodeMode')?.description;

    const initial = f.registry.getFunctionDeclarations();
    expect(description(initial)).toContain('  Read(args:');
    expect(description(initial)).toContain('  Write(args:');
    const readContract = vi.spyOn(read, 'programmatic', 'get');
    expect(f.registry.getFunctionDeclarations()).toBe(initial);
    expect(readContract).not.toHaveBeenCalled();

    f.registry.unregisterTool('Write');
    const afterRemoval = f.registry.getFunctionDeclarations();
    expect(description(afterRemoval)).toContain('  Read(args:');
    expect(description(afterRemoval)).not.toContain('  Write(args:');
    expect(description(initial)).toContain('  Write(args:');

    f.registry.registerTool(write);
    expect(description(f.registry.getFunctionDeclarations())).toContain(
      '  Write(args:',
    );
    const filtered = f.registry.getFunctionDeclarationsFiltered([
      'CodeMode',
      'Write',
    ]);
    expect(description(filtered)).toContain('  Write(args:');
    expect(description(filtered)).not.toContain('  Read(args:');
  });
  it('describes only the tools in the effective agent view', () => {
    const f = fixture(
      [
        makeTool('Read', async () => success()),
        makeTool('Write', async () => success()),
      ],
      ['Read', 'CodeMode'],
      makeFakeConfig({
        mainAgentTools: ['Read', 'CodeMode'],
        getSetting: () => ({ mode: 'only' }),
      }),
    );
    f.registry.registerTool(new CodeModeTool(f.config));
    const description = f.registry
      .getFunctionDeclarations()
      .find((item) => item.name === 'CodeMode')?.description;
    expect(description).toContain('  Read(args:');
    expect(description).not.toContain('  Write(args:');
  });

  it('hides supported declarations in only mode without losing callable tools or permissions', async () => {
    const config = makeFakeConfig({
      mainAgentTools: ['Read', 'CodeMode', 'Unsupported'],
      getSetting: (section) =>
        section === 'codeMode' ? { mode: 'only' } : undefined,
    });
    const read = makeTool('Read', async () => success('read through CodeMode'));
    const unsupported = makeTool('Unsupported', async () => success());
    vi.spyOn(unsupported, 'exposureHints', 'get').mockReturnValue(
      MODEL_ONLY_HINTS,
    );
    const f = fixture(
      [read, unsupported, makeTool('Write', async () => success())],
      undefined,
      config,
    );
    f.registry.registerTool(new CodeModeTool(config));
    const schemas = f.registry.getModelFunctionDeclarations();
    expect(schemas.map((item) => item.name)).toEqual([
      'CodeMode',
      'Unsupported',
    ]);
    expect(f.registry.getModelFunctionDeclarations()).toBe(schemas);
    const bridge = config.getToolRegistry();
    const wireSchemas = bridge.getSchema();
    expect(wireSchemas.map((item) => item.name)).toEqual([
      'CodeMode',
      'Unsupported',
    ]);
    expect(bridge.getSchema()).toBe(wireSchemas);
    const description = schemas.find(
      (item) => item.name === 'CodeMode',
    )!.description!;
    expect(description).toContain('  Read(args: {\n    value: string;\n  }');
    expect(description).not.toContain('Write(args');
    expect(description).not.toContain('Unsupported(args');
    const scope = new ToolExecutionScope(f.parent);
    await expect(scope.call('Read', { value: 'a' })).resolves.toEqual({
      value: 'read through CodeMode',
    });
    await expect(scope.call('Write', { value: 'a' })).rejects.toThrow();
    f.permission.setRules({ allow: {}, deny: { session: ['Read'] }, ask: {} });
    await expect(scope.call('Read', { value: 'a' })).rejects.toThrow();
    await scope.close('completed');
    expect(f.registry.getTool('Read')).toBe(read);
  });

  it('declares CodeMode and CodeModeWait ahead of the other tools', () => {
    const config = makeFakeConfig({ getSetting: () => ({ mode: 'on' }) });
    const f = fixture(
      [
        makeTool('Agent', async () => success()),
        makeTool('Bash', async () => success()),
      ],
      undefined,
      config,
    );
    f.registry.registerTool(new CodeModeWaitTool(config));
    f.registry.registerTool(new CodeModeTool(config));
    expect(
      f.registry.getModelFunctionDeclarations().map((item) => item.name),
    ).toEqual(['CodeMode', 'CodeModeWait', 'Agent', 'Bash']);
    expect(
      f.registry
        .getFunctionDeclarationsFiltered([
          'Bash',
          'CodeModeWait',
          'Agent',
          'CodeMode',
        ])
        .map((item) => item.name),
    ).toEqual(['CodeMode', 'CodeModeWait', 'Bash', 'Agent']);
  });

  it('changes exposure without mutating earlier schemas and never hides tools when CodeMode is unavailable', () => {
    let mode = 'on';
    const config = makeFakeConfig({
      getSetting: () => ({ mode }),
    });
    const f = fixture(
      [makeTool('Read', async () => success())],
      undefined,
      config,
    );
    f.registry.registerTool(new CodeModeTool(config));
    const on = f.registry.getModelFunctionDeclarations();
    expect(on.map((item) => item.name)).toEqual(['CodeMode', 'Read']);
    expect(on.find((item) => item.name === 'Read')!.description).toContain(
      'CodeMode: tools.Read(args) resolves to',
    );
    expect(
      on.find((item) => item.name === 'CodeMode')!.description,
    ).not.toContain('  Read(args:');
    mode = 'only';
    const only = f.registry.getModelFunctionDeclarations();
    expect(only.map((item) => item.name)).toEqual(['CodeMode']);
    expect(on.map((item) => item.name)).toEqual(['CodeMode', 'Read']);
    expect(f.registry.getToolView().codeMode).toBe('only');
    expect(f.registry.getCodeModeExposure()).toBe('only');
    f.registry.unregisterTool('CodeMode');
    expect(
      f.registry.getModelFunctionDeclarations().map((item) => item.name),
    ).toEqual(['Read']);
    expect(
      f.registry.getModelFunctionDeclarations()[0].description,
    ).not.toContain('CodeMode');
    expect(f.registry.getToolView().codeMode).toBeUndefined();
  });

  it('resolves tool exposure once per declaration set', () => {
    const config = makeFakeConfig({
      getSetting: () => ({ mode: 'only' }),
    });
    const f = fixture(
      [makeTool('Read', async () => success())],
      undefined,
      config,
    );
    f.registry.registerTool(new CodeModeTool(config));
    const resolve = vi.spyOn(
      f.registry as unknown as { resolveExposures(): unknown },
      'resolveExposures',
    );
    expect(
      f.registry.getModelFunctionDeclarations().map((item) => item.name),
    ).toEqual(['CodeMode']);
    expect(f.registry.getToolView().codeMode).toBe('only');
    expect(f.registry.getProgrammaticToolCatalog().map((t) => t.name)).toEqual([
      'Read',
    ]);
    expect(resolve).toHaveBeenCalledOnce();
  });

  it('does not hide tools or advertise CodeMode when the agent allowlist excludes it', () => {
    const config = makeFakeConfig({
      mainAgentTools: ['Read'],
      getSetting: () => ({ mode: 'only' }),
    });
    const f = fixture(
      [makeTool('Read', async () => success())],
      undefined,
      config,
    );
    f.registry.registerTool(new CodeModeTool(config));
    expect(f.registry.getAllToolNames()).toContain('CodeMode');
    expect(f.registry.getToolView().codeMode).toBeUndefined();
    expect(f.registry.getCodeModeExposure()).toBeUndefined();
    expect(
      f.registry.getModelFunctionDeclarations().map((item) => item.name),
    ).toEqual(['Read']);
  });

  it('turns a parent interrupt into child cancellation instead of shell backgrounding', async () => {
    let childSignal: AbortSignal | undefined;
    const execute = vi.fn(async (_args, ctx: ToolUseContext) => {
      childSignal = ctx.signal;
      await new Promise<void>((resolve) =>
        ctx.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      return success();
    });
    const f = fixture([makeTool('Bash', execute, false)]);
    const controller = new AbortController();
    const scope = new ToolExecutionScope({
      ...f.parent,
      signal: controller.signal,
    });
    const pending = scope
      .call('Bash', { value: 'sleep' })
      .catch((error) => error);
    await vi.waitFor(() => expect(childSignal).toBeDefined());
    controller.abort('interrupt');
    await pending;
    expect(childSignal!.aborted).toBe(true);
    // ShellCommand deliberately ignores the literal 'interrupt' reason.
    expect(childSignal!.reason).not.toBe('interrupt');
    await scope.close('cancelled');
  });

  it('resolves a Bash nonzero exit but still rejects hook errors and denied calls', async () => {
    const execute = vi.fn(
      async (): Promise<ToolResult> => ({
        llmContent: 'secret model output',
        returnDisplay: '',
        isError: true,
        toolUseResult: {
          kind: 'completed',
          stdout: 'test failed',
          stderr: '',
          exitCode: 1,
          signal: null,
        },
      }),
    );
    const shell = makeTool('Bash', execute, false);
    vi.spyOn(shell, 'programmatic', 'get').mockReturnValue(shellContract);
    const f = fixture([shell]);
    const scope = new ToolExecutionScope(f.parent);
    await expect(scope.call('Bash', { value: 'test' })).resolves.toEqual({
      output: 'test failed',
      stderr: '',
      exitCode: 1,
      truncated: false,
    });
    execute.mockResolvedValueOnce({
      ...(await execute()),
      error: { type: ToolErrorType.EXECUTION_FAILED, message: 'hook failed' },
    });
    await expect(scope.call('Bash', { value: 'test' })).rejects.toThrow(
      'hook failed',
    );
    f.permission.setRules({ allow: {}, deny: { session: ['Bash'] }, ask: {} });
    const calls = execute.mock.calls.length;
    await expect(scope.call('Bash', { value: 'test' })).rejects.toThrow();
    expect(execute).toHaveBeenCalledTimes(calls);
    await scope.close('completed');
  });

  it('reports an accepted Bash exit as a completed call with a notice and commits store', async () => {
    useRealRuntime();
    const shell = makeTool(
      'Bash',
      async () => ({
        llmContent: 'test suite failed',
        returnDisplay: 'exit 7',
        isError: true,
        toolUseResult: {
          kind: 'completed',
          stdout: 'test suite failed',
          stderr: '',
          exitCode: 7,
          signal: null,
        },
      }),
      false,
    );
    vi.spyOn(shell, 'programmatic', 'get').mockReturnValue(shellContract);
    const f = fixture([shell]);
    const result = await new CodeModeTool(f.config).build({
      code: 'const r = await tools.Bash({value:"test"}); store("exit", r.exitCode);',
    }).executeWithContext!(f.parent);
    expect(result.isError).toBe(false);
    expect(result.toolUseResult).toMatchObject({
      status: 'completed',
      output: '',
      storeWrites: [{ key: 'exit', value: 7 }],
      calls: [
        {
          status: 'completed',
          settlement: 'completed',
          notice: 'Bash exited with code 7; test suite failed',
        },
      ],
    });
    expect(result.llmContent).not.toContain('1 failed');
    expect(result.llmContent).toContain('changes:');
    expect(result.llmContent).not.toContain('not rolled back');
    expect(result.llmContent).toContain('Bash exited with code 7');
    expect(result.llmContent).not.toContain('result not delivered');
    expect(result.returnDisplay).toMatchObject({
      status: 'completed',
      children: [
        {
          name: 'Bash',
          status: CoreToolCallStatus.Success,
          notice: 'Bash exited with code 7; test suite failed',
          resultDisplay: 'exit 7',
        },
      ],
    });
  });

  it('resolves MCP business errors with both content and structured diagnostics', async () => {
    useRealRuntime();
    const message = 'Missing required argument projectId';
    const payload = {
      content: [{ type: 'text', text: message }],
      structuredContent: { code: 'MISSING_PROJECT' },
      isError: true,
    };
    const tool = makeTool('mcp__srv__lookup', async () => ({
      llmContent: message,
      returnDisplay: message,
      isError: true,
      toolUseResult: 'display conversion',
      mcpResult: payload,
    }));
    asMcpTool(tool);
    const f = fixture([tool]);
    const result = await new CodeModeTool(f.config).build({
      code: 'const r = await tools.mcp__srv__lookup({value:"x"}); text(r);',
    }).executeWithContext!(f.parent);
    expect(result.toolUseResult).toMatchObject({
      status: 'completed',
      output: JSON.stringify(payload),
      calls: [
        {
          status: 'completed',
          notice: 'MCP returned isError=true: ' + message,
        },
      ],
    });
    expect(result.llmContent).toContain(message);
    expect(result.llmContent).not.toContain('failed calls');
  });

  it('rejects MCP transport failures without treating them as business results', async () => {
    const tool = makeTool('mcp__srv__lookup', async () => {
      throw new Error('connection lost');
    });
    asMcpTool(tool);
    const f = fixture([tool]);
    const scope = new ToolExecutionScope(f.parent);
    await expect(
      scope.call('mcp__srv__lookup', { value: 'x' }),
    ).rejects.toThrow('connection lost');
    expect((await scope.close('completed')).calls[0]).toMatchObject({
      status: 'error',
      kind: 'execution',
    });
  });

  it('uses the final failure-hook diagnostic instead of the original MCP error', async () => {
    const tool = makeTool('mcp__srv__lookup', async () => ({
      llmContent: 'private server detail',
      returnDisplay: '',
      isError: true,
      toolUseResult: 'Error: private server detail',
    }));
    asMcpTool(tool);
    const f = fixture([tool]);
    vi.spyOn(f.config, 'getHookSystem').mockReturnValue({
      firePreToolUseEvent: async () => EMPTY_SUCCESS_HOOK_RESULT,
      firePostToolUseFailureEvent: async () => ({
        ...EMPTY_SUCCESS_HOOK_RESULT,
        finalOutput: new PostToolUseHookOutput({
          decision: 'deny',
          reason: 'redacted by hook',
        }),
      }),
    } as unknown as HookSystem);
    const scope = new ToolExecutionScope(f.parent);
    await expect(
      scope.call('mcp__srv__lookup', { value: 'x' }),
    ).rejects.toThrow('redacted by hook');
    const summary = await scope.close('completed');
    expect(summary.calls[0].error).toBe('redacted by hook');
    expect(JSON.stringify(summary)).not.toContain('private server detail');
  });

  it.each([
    { yieldMs: undefined, output: '', neutral: true },
    { yieldMs: 60_001, output: '', neutral: true },
    { yieldMs: 10_000, output: '', neutral: true },
    { yieldMs: 9_999, output: '', neutral: false },
    { yieldMs: 0, output: '', neutral: false },
    { yieldMs: 0, output: 'new output', neutral: true },
  ])(
    'marks only productive polls as repeat-neutral: %j',
    async ({ yieldMs, output, neutral }) => {
      const f = fixture([]);
      const cell = createCodeModeCell(
        f.config,
        f.config.getSessionId(),
        undefined,
        f.parent.queryLifecycle!,
      );
      let finish!: (completion: CellCompletion) => void;
      const completion = new Promise<CellCompletion>((resolve) => {
        finish = resolve;
      });
      cell.start(() => completion);
      if (output) cell.output.push(output);
      const wait = new CodeModeWaitTool(f.config);
      vi.useFakeTimers();
      try {
        const pending = wait.build({ cell_id: cell.id, yield_time_ms: yieldMs })
          .executeWithContext!(f.parent);
        await vi.advanceTimersByTimeAsync(
          Math.min(
            yieldMs ?? SCRIPT_LIMITS.defaultYieldMs,
            SCRIPT_LIMITS.maxYieldMs,
          ),
        );
        const result = await pending;
        expect(result.repeatNeutral).toBe(neutral ? true : undefined);
        expect(result.toolUseResult).toMatchObject({ status: 'running' });
        expect(result.toolUseResult).not.toHaveProperty('repeatNeutral');
        finish({
          result: { status: 'completed', output: cell.output },
          summary: { calls: [], endsTurn: false, newMessages: [] },
        });
        const final = await wait.build({ cell_id: cell.id })
          .executeWithContext!(f.parent);
        expect(final.repeatNeutral).toBeUndefined();
        expect(final.toolUseResult).toMatchObject({ status: 'completed' });
        const stale = await wait.build({ cell_id: cell.id })
          .executeWithContext!(f.parent);
        expect(stale.isError).toBe(true);
        expect(stale.repeatNeutral).toBeUndefined();
      } finally {
        finish({
          result: { status: 'completed', output: cell.output },
          summary: { calls: [], endsTurn: false, newMessages: [] },
        });
        await cell.retire();
        vi.useRealTimers();
      }
    },
  );

  it('resumes the same cell, returns only new output, and delivers hooks exactly once', async () => {
    useRealRuntime();
    let release!: () => void;
    const read = vi.fn(async (_args, ctx: ToolUseContext) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      ctx.pendingHookOutputs!.push({
        hookEvent: 'PostToolUse',
        toolName: 'Read',
        additionalContext: 'cell hook',
      } as never);
      return success('done');
    });
    const f = fixture([makeTool('Read', read)]);
    const lifecycle = {
      signal: f.parent.signal,
      cleanups: new Set<() => Promise<void>>(),
      admissionGuards: new Set<ToolAdmissionGuard>(),
    };
    const ctx = { ...f.parent, queryLifecycle: lifecycle };
    const tool = new CodeModeTool(f.config);
    const wait = new CodeModeWaitTool(f.config);
    const initial = await tool.build({
      code: 'text("first"); store("saved", 1); const r = await tools.Read({value:"x"}); text(r.value);',
      yield_time_ms: 0,
    }).executeWithContext!(ctx);
    const id = (initial.toolUseResult as { cellId: string }).cellId;
    expect(initial.llmContent).toContain(id);
    expect(initial).toMatchObject({
      isError: false,
      toolUseResult: { status: 'running' },
    });
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    expect(lifecycle.cleanups.size).toBe(1);
    expect(
      (await loadStore(f.config, f.config.getSessionId())).snapshot(),
    ).toEqual({});
    const first = await wait.build({
      cell_id: id,
      yield_time_ms: 0,
    }).executeWithContext!(ctx);
    expect(first.toolUseResult).toMatchObject({
      status: 'running',
      output: 'first',
      calls: [{ name: 'Read', status: 'pending', args: { value: 'x' } }],
    });
    const firstReceipt = JSON.stringify(first.toolUseResult);
    expect(first.returnDisplay).toMatchObject({
      status: 'running',
      children: [{ name: 'Read', status: CoreToolCallStatus.Executing }],
      totalCalls: 1,
    });
    const empty = await wait.build({
      cell_id: id,
      yield_time_ms: 0,
    }).executeWithContext!(ctx);
    expect(empty.toolUseResult).toMatchObject({
      status: 'running',
      output: '',
      calls: [],
      callsMode: 'delta',
      totalCalls: 1,
    });
    // Polls show only calls whose state changed since the previous poll.
    expect(empty.returnDisplay).toMatchObject({ children: [], totalCalls: 1 });
    expect(
      (
        await tool.build({ code: 'text("duplicate");' }).executeWithContext!(
          ctx,
        )
      ).isError,
    ).toBe(true);
    const foreign = await wait.build({
      cell_id: id,
      yield_time_ms: 0,
    }).executeWithContext!({ ...ctx, agentId: 'other' });
    expect(foreign.isError).toBe(true);
    expect(foreign.llmContent).not.toContain(id);
    const wrongId = await wait.build({
      cell_id: 'wrong',
      yield_time_ms: 0,
    }).executeWithContext!(ctx);
    expect(wrongId.isError).toBe(true);
    expect(wrongId.llmContent).toContain(id);
    const blocked = await new LocalToolCallExecutor(f.context).execute({
      call: { request: { name: 'Read', callId: 'sibling' } },
      signal: ctx.signal,
      queryLifecycle: ctx.queryLifecycle,
    } as never);
    expect(blocked.result.isError).toBe(true);
    expect(blocked.result.llmContent).toContain(id);
    expect(read).toHaveBeenCalledTimes(1);
    release();
    const nextCtx = {
      ...ctx,
      callId: 'wait-call',
      pendingHookOutputs: [],
      pendingHookAttachments: [],
    };
    const final = await wait.build({ cell_id: id }).executeWithContext!(
      nextCtx,
    );
    expect(final.toolUseResult).toMatchObject({
      status: 'completed',
      output: 'done',
      rootToolUseId: 'parent',
      callsMode: 'delta',
      calls: [
        {
          name: 'Read',
          status: 'completed',
          args: { value: 'x' },
          hostResult: { tool_use_result: { value: 'done' } },
        },
      ],
    });
    expect(JSON.stringify(final.llmContent)).not.toContain('hostResult');
    expect(JSON.stringify(first.toolUseResult)).toBe(firstReceipt);
    expect(final.returnDisplay).toMatchObject({
      children: [{ name: 'Read', status: CoreToolCallStatus.Success }],
      totalCalls: 1,
    });
    expect(nextCtx.pendingHookOutputs).toHaveLength(1);
    expect(f.parent.pendingHookOutputs).toHaveLength(0);
    expect(lifecycle.cleanups.size).toBe(0);
    expect(lifecycle.admissionGuards.size).toBe(0);
    expect(
      (await loadStore(f.config, f.config.getSessionId())).snapshot(),
    ).toEqual({
      saved: 1,
    });
    expect(getCodeModeCell(f.config, f.config.getSessionId())).toBeUndefined();
    expect(
      (await wait.build({ cell_id: id }).executeWithContext!(ctx)).isError,
    ).toBe(true);
  });

  it.each(['script', 'child'] as const)(
    'lets the model continue after cancelling a running %s',
    async (mode) => {
      useRealRuntime();
      let childSignal: AbortSignal | undefined;
      let childExited = false;
      const f = fixture([
        makeTool('Read', async (_args, ctx) => {
          childSignal = ctx.signal;
          await new Promise<void>((resolve) =>
            ctx.signal.addEventListener('abort', () => resolve(), {
              once: true,
            }),
          );
          childExited = true;
          return success();
        }),
      ]);
      const tool = new CodeModeTool(f.config);
      const first = await tool.build({
        code:
          mode === 'script'
            ? 'text("started"); while (true) {}'
            : 'await tools.Read({value:"x"}); text("must not finish");',
        yield_time_ms: 0,
      }).executeWithContext!(f.parent);
      const id = (first.toolUseResult as { cellId: string }).cellId;
      await vi.waitFor(() => {
        if (mode === 'child') expect(childSignal).toBeDefined();
        else
          expect(
            getCodeModeCell(f.config, f.config.getSessionId())!.output,
          ).toContain('started');
      });

      // Exercise the same result-to-stop conversion used for a model tool call.
      const wait = new CodeModeWaitTool(f.config);
      const executor = new StreamingToolExecutor({
        parentSignal: f.parent.signal,
        resolveTool: (name) => (name === wait.name ? wait : undefined),
        executeTool: (invocation, request, _tool, signal) =>
          invocation.executeWithContext!({
            ...f.parent,
            callId: request.callId,
            signal,
          }),
      });
      executor.addTool({
        name: wait.name,
        callId: 'cancel-cell',
        prompt_id: 'prompt',
        args: { cell_id: id, cancel: true },
      });
      executor.seal();
      const results = [];
      for await (const result of executor.getRemainingResults())
        results.push(result);

      expect(results).toHaveLength(1);
      expect(results[0].result?.toolUseResult).toMatchObject({
        status: 'cancelled',
      });
      expect(results[0].result?.endsTurn).toBe(false);
      expect(
        results[0].resultMessages?.map(({ message }) => message.type),
      ).toEqual(['tool_result']);
      expect(f.parent.signal.aborted).toBe(false);
      expect(f.parent.queryLifecycle!.signal.aborted).toBe(false);
      if (mode === 'child') {
        expect(childSignal!.aborted).toBe(true);
        expect(childExited).toBe(true);
      }
      expect(JSON.stringify(results[0].result?.toolUseResult)).not.toContain(
        'must not finish',
      );
      expect(
        getCodeModeCell(f.config, f.config.getSessionId()),
      ).toBeUndefined();
      const next = await tool.build({ code: 'text("continued");' })
        .executeWithContext!(f.parent);
      expect(next.toolUseResult).toMatchObject({
        status: 'completed',
        output: 'continued',
      });
    },
  );

  it.each(['cancel', 'query-end', 'session-dispose', 'user-abort'] as const)(
    'stops child work and discards state on %s after yielding',
    async (mode) => {
      useRealRuntime();
      let childSignal: AbortSignal | undefined;
      const root = new AbortController();
      const f = fixture([
        makeTool('Read', async (_args, ctx) => {
          childSignal = ctx.signal;
          await new Promise<void>((resolve) =>
            ctx.signal.addEventListener('abort', () => resolve(), {
              once: true,
            }),
          );
          return success();
        }),
      ]);
      const lifecycle = {
        signal: root.signal,
        cleanups: new Set<() => Promise<void>>(),
        admissionGuards: new Set<ToolAdmissionGuard>(),
      };
      const ctx = { ...f.parent, queryLifecycle: lifecycle };
      const tool = new CodeModeTool(f.config);
      const wait = new CodeModeWaitTool(f.config);
      const first = await tool.build({
        code: 'store("discard", true); await tools.Read({value:"x"}); text("must not finish");',
        yield_time_ms: 0,
      }).executeWithContext!(ctx);
      const id = (first.toolUseResult as { cellId: string }).cellId;
      await vi.waitFor(() => expect(childSignal).toBeDefined());
      if (mode === 'query-end')
        await Promise.all([...lifecycle.cleanups].map((cleanup) => cleanup()));
      else if (mode === 'session-dispose') await resetCodeModeSession(f.config);
      else {
        if (mode === 'user-abort') root.abort();
        const result = await wait.build({
          cancel: mode === 'cancel',
          cell_id: id,
        }).executeWithContext!(ctx);
        expect(result.toolUseResult).toMatchObject({ status: 'cancelled' });
        expect(JSON.stringify(result.toolUseResult)).not.toContain(
          'must not finish',
        );
      }
      expect(childSignal!.aborted).toBe(true);
      expect(lifecycle.cleanups.size).toBe(0);
      expect(lifecycle.admissionGuards.size).toBe(0);
      expect(
        (await loadStore(f.config, f.config.getSessionId())).snapshot(),
      ).toEqual({});
      expect(
        getCodeModeCell(f.config, f.config.getSessionId()),
      ).toBeUndefined();
    },
  );

  it('retains stop attachments for scope enforcement after a running poll delivers them', async () => {
    useRealRuntime();
    let release!: () => void;
    const read = vi.fn(async (_args, ctx: ToolUseContext) => {
      ctx.pendingHookAttachments!.push({
        type: 'hook_stopped_continuation',
        toolUseID: ctx.callId,
      } as never);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return success();
    });
    const f = fixture([makeTool('Read', read)]);
    const tool = new CodeModeTool(f.config);
    const wait = new CodeModeWaitTool(f.config);
    const first = await tool.build({
      code: 'await tools.Read({value:"one"}); await tools.Read({value:"two"});',
      yield_time_ms: 0,
    }).executeWithContext!(f.parent);
    const id = (first.toolUseResult as { cellId: string }).cellId;
    await vi.waitFor(() => expect(release).toBeDefined());
    const pollingCtx = { ...f.parent, pendingHookAttachments: [] };
    await wait.build({ cell_id: id, yield_time_ms: 0 }).executeWithContext!(
      pollingCtx,
    );
    expect(pollingCtx.pendingHookAttachments).toHaveLength(1);
    release();
    const finalCtx = { ...f.parent, pendingHookAttachments: [] };
    const final = await wait.build({ cell_id: id }).executeWithContext!(
      finalCtx,
    );
    expect(final.endsTurn).toBe(true);
    expect(finalCtx.pendingHookAttachments).toHaveLength(0);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('keeps the execution timeout running across repeated waits', async () => {
    useRealRuntime(100);
    const f = fixture([]);
    const tool = new CodeModeTool(f.config);
    const wait = new CodeModeWaitTool(f.config);
    const initial = await tool.build({
      code: 'store("discard", true); while(true){}',
      yield_time_ms: 0,
    }).executeWithContext!(f.parent);
    const id = (initial.toolUseResult as { cellId: string }).cellId;
    const final = await wait.build({
      cell_id: id,
      yield_time_ms: 1000,
    }).executeWithContext!(f.parent);
    expect(final.toolUseResult).toMatchObject({ status: 'timeout' });
    expect(
      (await loadStore(f.config, f.config.getSessionId())).snapshot(),
    ).toEqual({});
  });

  it.each([
    'cancel',
    'query-end',
    'session-dispose',
    'user-abort',
    'timeout',
  ] as const)(
    'settles %s during store restoration and permits a fresh read without running the old script',
    async (mode) => {
      useRealRuntime(mode === 'timeout' ? 50 : 5000);
      const execute = vi.fn(async () => success());
      const f = fixture([makeTool('Read', execute)]);
      const root = new AbortController();
      const lifecycle = {
        signal: root.signal,
        cleanups: new Set<() => Promise<void>>(),
        admissionGuards: new Set<ToolAdmissionGuard>(),
      };
      const ctx = { ...f.parent, queryLifecycle: lifecycle };
      let release!: (chain: TranscriptMessage[]) => void;
      const oldRead = new Promise<TranscriptMessage[]>((resolve) => {
        release = resolve;
      });
      const readChain = vi.fn(async (): Promise<TranscriptMessage[]> => []);
      readChain.mockReturnValueOnce(oldRead);
      vi.spyOn(f.config, 'getActiveConversation').mockReturnValue({
        revision: () => 0,
        readChain,
      });
      const tool = new CodeModeTool(f.config);
      const wait = new CodeModeWaitTool(f.config);
      const first = await tool.build({
        code: 'store("discard", true); await tools.Read({value:"must not run"});',
        yield_time_ms: 0,
      }).executeWithContext!(ctx);
      const id = (first.toolUseResult as { cellId: string }).cellId;
      await vi.waitFor(() => expect(readChain).toHaveBeenCalledOnce());
      let settled = false;
      const stopping = (async () => {
        if (mode === 'query-end')
          await Promise.all(
            [...lifecycle.cleanups].map((cleanup) => cleanup()),
          );
        else if (mode === 'session-dispose')
          await resetCodeModeSession(f.config);
        else {
          if (mode === 'user-abort') root.abort();
          const result = await wait.build({
            cancel: mode === 'cancel',
            cell_id: id,
          }).executeWithContext!(ctx);
          expect(result.toolUseResult).toMatchObject({
            status: mode === 'timeout' ? 'timeout' : 'cancelled',
          });
          expect(result.toolUseResult).not.toHaveProperty('storeWrites');
        }
        settled = true;
      })();
      try {
        await vi.waitFor(() => expect(settled).toBe(true), { timeout: 1000 });
        expect(lifecycle.cleanups.size).toBe(0);
        expect(lifecycle.admissionGuards.size).toBe(0);
        expect(
          getCodeModeCell(f.config, f.config.getSessionId()),
        ).toBeUndefined();
        // The old read remains pending: retry must not reuse its cached promise.
        const next = await tool.build({ code: 'store("ok", true);' })
          .executeWithContext!(f.parent);
        expect(next.toolUseResult).toMatchObject({
          status: 'completed',
          storeWrites: [{ key: 'ok', value: true }],
        });
        expect(readChain).toHaveBeenCalledTimes(2);
      } finally {
        release([]);
        await stopping;
      }
      expect(execute).not.toHaveBeenCalled();
      expect(
        (
          await loadStore(
            f.config,
            f.config.getSessionId(),
            undefined,
            f.config.getActiveConversation(),
          )
        ).snapshot(),
      ).toEqual({ ok: true });
    },
  );

  it('does not execute or overwrite persisted state after restoration fails, and retries from history', async () => {
    useRealRuntime();
    const execute = vi.fn(async () => success());
    const f = fixture([makeTool('Read', execute)]);
    const history = [
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result' }] },
        toolUseResult: {
          type: 'code_mode',
          status: 'completed',
          storeWrites: [{ key: 'count', value: 5 }],
        },
      },
    ] as TranscriptMessage[];
    const readChain = vi.fn(async () => history);
    readChain.mockRejectedValueOnce(new Error('temporary read failure'));
    vi.spyOn(f.config, 'getActiveConversation').mockReturnValue({
      revision: () => 0,
      readChain,
    });
    const tool = new CodeModeTool(f.config);
    const failed = await tool.build({
      code: 'store("count", (load("count") ?? 0) + 1); await tools.Read({value:"must not run"});',
    }).executeWithContext!(f.parent);
    expect(failed.isError).toBe(true);
    expect(failed.toolUseResult).toMatchObject({
      status: 'error',
      errorKind: 'store_restore',
    });
    expect(failed.llmContent).toContain(
      'Unable to restore the persisted CodeMode store',
    );
    expect(failed.toolUseResult).not.toHaveProperty('storeWrites');
    expect(execute).not.toHaveBeenCalled();
    const recovered = await tool.build({
      code: 'store("count", (load("count") ?? 0) + 1);',
    }).executeWithContext!(f.parent);
    expect(recovered.toolUseResult).toMatchObject({
      status: 'completed',
      storeWrites: [{ key: 'count', value: 6 }],
    });
    expect(readChain).toHaveBeenCalledTimes(2);
  });

  it('commits synchronous state only after successful execution and scope cleanup', async () => {
    useRealRuntime(1000);
    const f = fixture([]);
    const tool = new CodeModeTool(f.config);
    const run = (code: string, sessionId = 'session-a') =>
      tool.build({ code }).executeWithContext!({
        ...f.parent,
        sessionId,
      });
    await run("store('files', ['a.ts', 'b.ts']);");
    expect((await run("return load('files');")).toolUseResult).toMatchObject({
      output: '["a.ts","b.ts"]',
    });
    for (const suffix of [
      'throw new Error("failed");',
      'await new Promise(() => {});',
      'while(true){}',
    ]) {
      const failed = await run(`store('files', ['wrong']); ${suffix}`);
      expect(failed.isError).toBe(true);
      expect(failed.toolUseResult).not.toHaveProperty('storeWrites');
      expect((await run("return load('files');")).toolUseResult).toMatchObject({
        output: '["a.ts","b.ts"]',
      });
    }
    await run("store('files', undefined);");
    expect((await run("text(load('files'));")).toolUseResult).toMatchObject({
      output: 'undefined',
    });
    await run("store('files', null);");
    expect(
      (await run("text(load('files'));", 'session-b')).toolUseResult,
    ).toMatchObject({ output: 'undefined' });
  });

  it('keeps bounded arguments in CodeMode results without changing execution input', async () => {
    useRealRuntime();
    const execute = vi.fn(async (_args: { value: string }) => success());
    const f = fixture([makeTool('Read', execute)]);
    const result = await new CodeModeTool(f.config).build({
      code: 'await tools.Read({value: "汉字".repeat(10000)}); text("done");',
    }).executeWithContext!(f.parent);
    expect(execute.mock.calls[0][0]).toEqual({ value: '汉字'.repeat(10000) });
    expect(result.toolUseResult).toMatchObject({
      status: 'completed',
      output: 'done',
      calls: [
        {
          name: 'Read',
          argsTruncated: true,
          args: { value: expect.stringContaining('汉字') },
        },
      ],
    });
    const { calls } = result.toolUseResult as {
      calls: Array<{ args: unknown }>;
    };
    expect(
      Buffer.byteLength(JSON.stringify(calls[0].args)),
    ).toBeLessThanOrEqual(SCRIPT_LIMITS.summaryArgumentBytes);
    expect(result.llmContent).not.toContain('汉字');
  });

  it('does not count synchronous state operations as child calls or leave pending calls', async () => {
    useRealRuntime();
    const event = vi.spyOn(sessionLogger, 'event');
    const f = fixture([makeTool('Read', async () => success())]);
    const result = await new CodeModeTool(f.config).build({
      code: 'await tools.Read({value: "a"}); store("private-key", "private-value"); text("read ok");',
    }).executeWithContext!(f.parent);
    expect(result.toolUseResult).toMatchObject({
      status: 'completed',
      output: 'read ok',
    });
    expect(result.toolUseResult).not.toHaveProperty('pendingCalls');
    // The in-session display keeps each child's own result for the TUI.
    expect(result.returnDisplay).toMatchObject({
      isCodeModeDisplay: true,
      status: 'completed',
      children: [
        {
          name: 'Read',
          args: { value: 'a' },
          status: CoreToolCallStatus.Success,
          resultDisplay: 'ok',
        },
      ],
      summary: 'read ok',
    });
    expect(event).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ calls: 1, pending_calls: 0 }),
      }),
    );
    // Committed state is recorded only in the transcript side channel.
    expect(result.toolUseResult).toMatchObject({
      storeWrites: [{ key: 'private-key', value: 'private-value' }],
    });
    expect(
      JSON.stringify([
        result.llmContent,
        result.returnDisplay,
        event.mock.calls,
      ]),
    ).not.toContain('private-value');
  });

  it.each(['on', 'only'])(
    'restricts unavailable-tool repair hints to the effective %s view',
    async (mode) => {
      useRealRuntime();
      const config = makeFakeConfig({
        mainAgentTools: ['Read', 'TaskCreate', 'CodeMode'],
        getSetting: (section) =>
          section === 'codeMode' ? { mode } : undefined,
      });
      const task = makeTool('TaskCreate', async () => success());
      vi.spyOn(task, 'exposureHints', 'get').mockReturnValue(MODEL_ONLY_HINTS);
      const f = fixture(
        [
          makeTool('Read', async () => success()),
          task,
          makeTool('Excluded', async () => success()),
        ],
        undefined,
        config,
      );
      f.registry.registerTool(new CodeModeTool(config));
      const result = await new CodeModeTool(config).build({
        code: `
      for (const name of ['TaskCreate', 'Excluded']) {
        try { await tools[name]({}); } catch (e) { text(e.message); }
      }
    `,
      }).executeWithContext!(f.parent);
      expect(result.llmContent).toContain(
        'Call TaskCreate directly outside CodeMode',
      );
      expect(result.llmContent).not.toContain('Call Excluded directly');
      expect(result.toolUseResult).toMatchObject({
        status: 'completed',
        calls: [],
      });
    },
  );

  it.each(['on', 'only'])(
    'explains the outer timeout and only advertises exposed Bash in %s mode',
    async (mode) => {
      useRealRuntime(250);
      const config = makeFakeConfig({
        getSetting: (section) =>
          section === 'codeMode' ? { mode } : undefined,
      });
      const shell = makeTool(
        'Bash',
        async (_args, ctx) => {
          await new Promise<void>((resolve) => {
            if (ctx.signal.aborted) resolve();
            else
              ctx.signal.addEventListener('abort', () => resolve(), {
                once: true,
              });
          });
          return success();
        },
        false,
      );
      const f = fixture([shell], undefined, config);
      f.registry.registerTool(new CodeModeTool(config));
      const result = await new CodeModeTool(config).build({
        code: 'await tools.Bash({value: "long command", timeout: 600000});',
      }).executeWithContext!(f.parent);
      expect(result.toolUseResult).toMatchObject({
        status: 'timeout',
        pendingCalls: [{ name: 'Bash', phase: 'executing' }],
      });
      expect(result.llmContent).toContain(
        'execution budget of 250 ms exhausted',
      );
      expect(result.llmContent).toContain(
        'Child tool timeouts do not extend this budget',
      );
      expect(result.llmContent).toContain('side effects already applied');
      expect(
        String(result.llmContent).includes(
          'call Bash directly outside CodeMode',
        ),
      ).toBe(mode === 'on');
    },
  );

  it('returns image() output to the model as inline image parts', async () => {
    useRealRuntime();
    const config = makeFakeConfig({
      getSetting: (section) =>
        section === 'codeMode' ? { mode: 'on' } : undefined,
    });
    const f = fixture([], undefined, config);
    f.registry.registerTool(new CodeModeTool(config));
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const result = await new CodeModeTool(config).build({
      code: `image({type: 'image', data: ${JSON.stringify(png)}, mimeType: 'image/png'}); text('done');`,
    }).executeWithContext!(f.parent);
    expect(result.toolUseResult).toMatchObject({
      status: 'completed',
      images: 1,
    });
    expect(JSON.stringify(result.toolUseResult)).not.toContain(png);
    const parts = result.llmContent as Array<{
      text?: string;
      inlineData?: { mimeType?: string; data?: string };
    }>;
    expect(parts[0].text).toContain('[image 1: image/png]\ndone');
    expect(parts[1].inlineData?.mimeType).toMatch(/^image\//);
    expect(parts[1].inlineData?.data).toBeTruthy();
    const imageOnly = await new CodeModeTool(config).build({
      code: `image({type: 'image', data: ${JSON.stringify(png)}, mimeType: 'image/png'});`,
    }).executeWithContext!(f.parent);
    expect(JSON.stringify(imageOnly.llmContent)).not.toContain('no output');
  });

  it('shows a local image file with image({path}) through Read and its permissions', async () => {
    useRealRuntime();
    const listed = testProviderModel('captured-vision');
    const modelEntry = {
      ...listed,
      capabilities: { ...listed.capabilities, vision: true },
    };
    const visionGate = vi
      .spyOn(modelCapabilities, 'isVisionSupportedModel')
      .mockImplementation((entry) => entry === modelEntry);
    const dir = await mkdtemp(
      join(await realpath(tmpdir()), 'codemode-image-'),
    );
    try {
      const config = makeFakeConfig({
        cwd: dir,
        targetDir: dir,
        getSetting: (section) =>
          section === 'codeMode' ? { mode: 'on' } : undefined,
      });
      const f = fixture([new ReadFileTool(config)], undefined, config);
      Object.assign(f.parent, { modelKey: modelEntry.key, modelEntry });
      f.registry.registerTool(new CodeModeTool(config));
      const pre = vi.fn(async () => EMPTY_SUCCESS_HOOK_RESULT);
      const post = vi.fn(async () => EMPTY_SUCCESS_HOOK_RESULT);
      vi.spyOn(config, 'getHookSystem').mockReturnValue({
        firePreToolUseEvent: pre,
        firePostToolUseEvent: post,
      } as unknown as HookSystem);
      const png =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
      const file = join(dir, 'chart.png');
      await writeFile(file, Buffer.from(png, 'base64'));
      const text = join(dir, 'notes.txt');
      await writeFile(text, 'not an image\n');
      const result = await new CodeModeTool(config).build({
        code: `
          try { await tools.Read({file_path: ${JSON.stringify(file)}}); } catch (error) { text('default Read: ' + error.message); }
          await image({path: ${JSON.stringify(file)}});
          try { await image({path: ${JSON.stringify(text)}}); } catch (error) { text(error.kind + ': ' + error.message); }
          text('done');`,
      }).executeWithContext!(f.parent);
      expect(result.toolUseResult).toMatchObject({
        status: 'completed',
        images: 1,
        error: undefined,
      });
      const parts = result.llmContent as Array<{
        text?: string;
        inlineData?: { mimeType?: string; data?: string };
      }>;
      expect(parts[0].text).toContain(
        'default Read: Programmatic Read supports text files only',
      );
      expect(parts[0].text).toContain('[image 1: image/png]');
      expect(visionGate).toHaveBeenCalledWith(modelEntry);
      expect(pre).toHaveBeenCalled();
      expect(post).toHaveBeenCalled();
      expect(parts[0].text).toContain('result_unavailable: Not an image file');
      expect(parts[0].text).toContain('done');
      expect(parts[0].text).not.toContain('not shown');
      expect(parts[1].inlineData?.mimeType).toMatch(/^image\//);
      expect(parts[1].inlineData?.data).toBeTruthy();

      f.permission.setRules({
        allow: {},
        deny: { userSettings: ['Read'] },
        ask: {},
      });
      const denied = await new CodeModeTool(config).build({
        code: `try { await image({path: ${JSON.stringify(file)}}); } catch (error) { text(error.name + ' ' + error.toolName); }`,
      }).executeWithContext!(f.parent);
      expect(denied.toolUseResult).toMatchObject({
        status: 'completed',
        output: 'ToolCallError Read',
      });
      expect(JSON.stringify(denied.llmContent)).not.toContain(png);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('searches on the host and reuses the index across scripts with the same tools', async () => {
    useRealRuntime();
    const f = fixture([
      makeTool('Read', async () => success()),
      makeTool('Glob', async () => success()),
    ]);
    const search = vi.spyOn(ToolSearchIndex.prototype, 'search');
    const tool = new CodeModeTool(f.config);
    const run = async () =>
      (
        await tool.build({
          code: 'const [found] = await searchTools("Glob"); await tools[found.name]({value: "x"}); return found.name;',
        }).executeWithContext!(f.parent)
      ).toolUseResult;
    expect(await run()).toMatchObject({ status: 'completed', output: 'Glob' });
    expect(await run()).toMatchObject({ status: 'completed', output: 'Glob' });
    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.contexts[1]).toBe(search.mock.contexts[0]);
    search.mockRestore();
  });

  it('reports MCP image blocks the script did not show', async () => {
    useRealRuntime();
    const config = makeFakeConfig({
      getSetting: (section) =>
        section === 'codeMode' ? { mode: 'on' } : undefined,
    });
    const mcpResult = {
      content: [
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
        { type: 'text', text: 'chart' },
      ],
      isError: false,
    };
    const mcpTool = makeTool('mcp__srv__chart', async () => ({
      llmContent: 'chart',
      returnDisplay: '',
      mcpResult,
    }));
    asMcpTool(mcpTool);
    const f = fixture([mcpTool], undefined, config);
    f.permission.setRules({
      allow: { session: [mcpTool.name] },
      deny: {},
      ask: {},
    });
    f.registry.registerTool(new CodeModeTool(config));
    const result = await new CodeModeTool(config).build({
      code: `await tools.mcp__srv__chart({ value: 'x' });`,
    }).executeWithContext!(f.parent);
    expect(result.llmContent).toContain(
      '1 image block returned by tool calls was not shown; pass it to image() to view.',
    );
    expect(result.llmContent).toContain('(no output;');
  });

  it.each(['on', 'only'])(
    'keeps eager MCP discovery, calls and permissions in %s mode without inlining schemas',
    async (mode) => {
      useRealRuntime();
      const config = makeFakeConfig({
        getSetting: (section) =>
          section === 'codeMode' ? { mode } : undefined,
      });
      const mcpResult = {
        content: [{ type: 'text', text: 'Temperature' }],
        structuredContent: { temp: 21 },
        isError: false,
      };
      const execute = vi.fn(async () => ({
        llmContent: '{"temp":21}',
        returnDisplay: '',
        toolUseResult: '{"temp":21}',
        mcpResult,
      }));
      const mcpTool = makeTool('mcp__srv__weather', execute);
      asMcpTool(mcpTool);
      Object.assign(mcpTool, {
        mcpOutputSchema: {
          type: 'object',
          properties: { temp: { type: 'number' } },
        },
      });
      const f = fixture(
        [mcpTool, makeTool('Read', async () => success())],
        undefined,
        config,
      );
      f.permission.setRules({
        allow: { session: [mcpTool.name] },
        deny: {},
        ask: {},
      });
      // Without an available CodeMode entry, neither mode may hide the MCP tool.
      expect(
        f.registry.getModelFunctionDeclarations().map((item) => item.name),
      ).toContain(mcpTool.name);
      f.registry.registerTool(new CodeModeTool(config));
      const declarations = f.registry.getModelFunctionDeclarations();
      const expectedNames =
        mode === 'only' ? ['CodeMode'] : ['CodeMode', 'Read'];
      expect(declarations.map((item) => item.name).sort()).toEqual(
        expectedNames,
      );
      const bridge = config.getToolRegistry();
      expect(
        bridge
          .getSchema()
          .map((item) => item.name)
          .sort(),
      ).toEqual(expectedNames);
      const description = declarations.find(
        (item) => item.name === 'CodeMode',
      )!.description!;
      expect(description).not.toContain('mcp.');
      expect(description).not.toContain('mcp__srv__weather');
      const result = await new CodeModeTool(config).build({
        code: `
        assert(typeof mcp === 'undefined');
        const matches = await searchTools('weather');
        const signature = await describeTool(matches[0].name);
        assert(signature.includes('value: string'));
        assert(ALL_TOOLS.some((t) => t.name === matches[0].name));
        const weather = await tools[matches[0].name]({ value: 'x' });
        return { weather, found: matches.map((t) => t.name) };
      `,
      }).executeWithContext!(f.parent);
      expect(
        JSON.parse((result.toolUseResult as { output: string }).output),
      ).toEqual({
        weather: mcpResult,
        found: ['mcp__srv__weather'],
      });
      const allowedCalls = 1;
      expect(execute).toHaveBeenCalledTimes(allowedCalls);
      f.permission.setRules({
        allow: {},
        deny: { session: ['mcp__srv__*'] },
        ask: {},
      });
      for (const call of ["tools.mcp__srv__weather({ value: 'denied' })"]) {
        const denied = await new CodeModeTool(config).build({
          code: `await ${call};`,
        }).executeWithContext!(f.parent);
        expect(denied.toolUseResult).toMatchObject({ status: 'error' });
        expect(String(denied.llmContent)).toContain(
          'denied by rule mcp__srv__*',
        );
      }
      expect(execute).toHaveBeenCalledTimes(allowedCalls);
      const approve = vi.fn(async () => ({ kind: 'approved' as const }));
      f.permission.setAskHandler(approve);
      f.permission.setRules({
        allow: {},
        deny: {},
        ask: { session: [mcpTool.name] },
      });
      const approved = await new CodeModeTool(config).build({
        code: "await tools.mcp__srv__weather({ value: 'approved' });",
      }).executeWithContext!(f.parent);
      expect(approved.toolUseResult).toMatchObject({ status: 'completed' });
      expect(approve).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledTimes(allowedCalls + 1);
    },
  );

  it('keeps the MCP meta tools out of CodeMode scripts and declarations', async () => {
    useRealRuntime();
    const config = makeFakeConfig({
      mcpLazyLoad: true,
      getSetting: (section) =>
        section === 'codeMode' ? { mode: 'on' } : undefined,
    });
    const mcpTool = makeTool('mcp__srv__lazy', async () => success());
    asMcpTool(mcpTool);
    const f = fixture([new McpCallTool(config), mcpTool], undefined, config);
    const visible = () =>
      f.registry.getModelFunctionDeclarations().map((item) => item.name);
    // Agents without CodeMode reach deferred MCP tools through the meta tools.
    expect(visible()).toEqual([MCP_CALL_TOOL_NAME]);
    f.registry.registerTool(new CodeModeTool(config));
    expect(visible()).toEqual(['CodeMode']);
    const result = await new CodeModeTool(config).build({
      code: "await tools.mcp_call({ toolName: 'mcp__srv__lazy', arguments: {} });",
    }).executeWithContext!(f.parent);
    expect(result.toolUseResult).toMatchObject({ status: 'error' });
    expect(String(result.llmContent)).toContain(
      'not available inside CodeMode',
    );
  });

  it('does not count permission checks toward the script timeout', async () => {
    useRealRuntime(250);
    const f = fixture([
      makeTool('Write', async () => success('written'), false),
    ]);
    const check = f.permission.check.bind(f.permission);
    vi.spyOn(f.permission, 'check').mockImplementation(async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return check(request);
    });
    const result = await new CodeModeTool(f.config).build({
      code: "return (await tools.Write({value:'a'})).value;",
    }).executeWithContext!(f.parent);
    expect(result.toolUseResult).toMatchObject({
      status: 'completed',
      output: 'written',
    });
  });

  it('keeps the script timeout running while another child call executes during a permission check', async () => {
    useRealRuntime(250);
    const f = fixture([
      makeTool('Slow', async () => {
        await new Promise((resolve) => setTimeout(resolve, 800));
        return success('slow');
      }),
      makeTool('Checked', async () => success('checked')),
    ]);
    const check = f.permission.check.bind(f.permission);
    vi.spyOn(f.permission, 'check').mockImplementation(async (request) => {
      if (request.toolName === 'Checked')
        await new Promise((resolve) => setTimeout(resolve, 800));
      return check(request);
    });
    const result = await new CodeModeTool(f.config).build({
      code: "await Promise.all([tools.Slow({value:'a'}), tools.Checked({value:'b'})]);",
    }).executeWithContext!(f.parent);
    expect(result.toolUseResult).toMatchObject({ status: 'timeout' });
  });

  it('logs a coarse error kind without script source', async () => {
    useRealRuntime();
    const event = vi.spyOn(sessionLogger, 'event');
    const f = fixture([makeTool('Read', async () => success())]);
    const tool = new CodeModeTool(f.config);
    await tool.build({
      code: 'const secret = 1; await tools.Read({wrong: 1});',
    }).executeWithContext!(f.parent);
    await tool.build({ code: 'const = ;' }).executeWithContext!(f.parent);
    const data = event.mock.calls
      .map(([entry]) => entry)
      .filter((entry) => entry.type === 'codemode.completed')
      .map((entry) => entry.data as Record<string, unknown>);
    expect(data.map((item) => item['error_kind'])).toEqual([
      'invalid_args',
      'syntax',
    ]);
    expect(JSON.stringify(data)).not.toContain('secret');
  });

  it('logs search quality and discovery effort across scripts of a session', async () => {
    useRealRuntime();
    const event = vi.spyOn(sessionLogger, 'event');
    const mcpTool = makeTool('mcp__srv__weather', async () => ({
      llmContent: 'sunny',
      returnDisplay: '',
      mcpResult: { content: [{ type: 'text', text: 'sunny' }], isError: false },
    }));
    asMcpTool(mcpTool);
    const f = fixture([makeTool('Read', async () => success()), mcpTool]);
    f.permission.setRules({
      allow: { session: [mcpTool.name] },
      deny: {},
      ask: {},
    });
    const tool = new CodeModeTool(f.config);
    const ctx = { ...f.parent, sessionId: `discovery-${randomUUID()}` };
    await tool.build({
      code: 'await searchTools("weather"); await searchTools("zzz", {namespace: "srv"});',
    }).executeWithContext!(ctx);
    await tool.build({
      code: 'await tools.mcp__srv__weather({ value: "x" });',
    }).executeWithContext!(ctx);
    const [first, second] = event.mock.calls
      .map(([entry]) => entry)
      .filter((entry) => entry.type === 'codemode.completed')
      .map((entry) => entry.data as Record<string, unknown>);
    expect(first).toMatchObject({
      search_calls: 2,
      search_empty: 1,
      search_namespace_calls: 1,
      search_result_buckets: ['1', '0'],
    });
    // The rank and the effort come from the earlier script of the same session.
    expect(second).toMatchObject({
      search_called_ranks: [1],
      discovery_ops: 2,
      discovery_same_turn: true,
    });
  });
});
