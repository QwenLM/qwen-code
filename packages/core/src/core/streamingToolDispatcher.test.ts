/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import {
  isEarlyDispatchSafe,
  StreamingToolDispatcher,
} from './streamingToolDispatcher.js';
import {
  StreamingToolExecutor,
  StreamingToolExecutorDiscardedError,
} from './streamingToolExecutor.js';
import type {
  Config,
  ToolCallRequestInfo,
  ToolRegistry,
  ToolResult,
} from '../index.js';
import {
  DEFAULT_TRUNCATE_TOOL_OUTPUT_LINES,
  DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD,
  ApprovalMode,
  Kind,
} from '../index.js';
import { MockTool } from '../test-utils/mock-tool.js';
import { ToolNames } from '../tools/tool-names.js';

interface ToolSetup {
  name: string;
  kind: Kind;
  execute?: Mock;
}

function buildConfig(tools: ToolSetup[]): {
  config: Config;
  registry: ToolRegistry;
  mocks: Map<string, MockTool>;
} {
  const mocks = new Map<string, MockTool>();
  for (const t of tools) {
    mocks.set(
      t.name,
      new MockTool({
        name: t.name,
        kind: t.kind,
        execute:
          t.execute ??
          vi.fn(async () => ({
            llmContent: `ran-${t.name}`,
            returnDisplay: `display-${t.name}`,
          })),
      }),
    );
  }
  const registry = {
    getTool: vi.fn((name: string) => mocks.get(name)),
    ensureTool: vi.fn(async (name: string) => mocks.get(name)),
    getAllToolNames: vi.fn(() => [...mocks.keys()]),
  } as unknown as ToolRegistry;
  const config = {
    getToolRegistry: () => registry,
    getApprovalMode: () => ApprovalMode.DEFAULT,
    getAllowedTools: () => [],
    getSessionId: () => 'test-session-id',
    getUsageStatisticsEnabled: () => true,
    getDebugMode: () => false,
    getContentGeneratorConfig: () => ({
      model: 'test-model',
      authType: 'gemini',
    }),
    getShellExecutionConfig: () => ({
      terminalWidth: 90,
      terminalHeight: 30,
    }),
    storage: {
      getProjectTempDir: () => '/tmp',
    },
    getTruncateToolOutputThreshold: () =>
      DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD,
    getTruncateToolOutputLines: () => DEFAULT_TRUNCATE_TOOL_OUTPUT_LINES,
    getUseModelRouter: () => false,
    getGeminiClient: () => null,
    getChatRecordingService: () => undefined,
    getMessageBus: vi.fn().mockReturnValue(undefined),
    getDisableAllHooks: vi.fn().mockReturnValue(true),
    getHookSystem: vi.fn().mockReturnValue(undefined),
    getDebugLogger: vi.fn().mockReturnValue({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
    isInteractive: vi.fn().mockReturnValue(false),
  } as unknown as Config;
  return { config, registry, mocks };
}

function req(
  callId: string,
  name: string,
  args: Record<string, unknown> = {},
): ToolCallRequestInfo {
  return {
    callId,
    name,
    args,
    isClientInitiated: false,
    prompt_id: 'p1',
  };
}

describe('isEarlyDispatchSafe', () => {
  it('returns true for Kind.Read tools', () => {
    const { config } = buildConfig([{ name: 'read_file', kind: Kind.Read }]);
    expect(isEarlyDispatchSafe(config, req('a', 'read_file'))).toBe(true);
  });

  it('returns true for Kind.Search tools', () => {
    const { config } = buildConfig([
      { name: 'grep_search', kind: Kind.Search },
    ]);
    expect(isEarlyDispatchSafe(config, req('a', 'grep_search'))).toBe(true);
  });

  it('returns true for Kind.Fetch tools', () => {
    const { config } = buildConfig([{ name: 'web_search', kind: Kind.Fetch }]);
    expect(isEarlyDispatchSafe(config, req('a', 'web_search'))).toBe(true);
  });

  it('returns false for Kind.Edit / Write / Delete / Move', () => {
    const { config } = buildConfig([
      { name: 'edit', kind: Kind.Edit },
      { name: 'write_file', kind: Kind.Edit },
      { name: 'rm', kind: Kind.Delete },
      { name: 'mv', kind: Kind.Move },
    ]);
    expect(isEarlyDispatchSafe(config, req('a', 'edit'))).toBe(false);
    expect(isEarlyDispatchSafe(config, req('b', 'write_file'))).toBe(false);
    expect(isEarlyDispatchSafe(config, req('c', 'rm'))).toBe(false);
    expect(isEarlyDispatchSafe(config, req('d', 'mv'))).toBe(false);
  });

  it('returns false for Kind.Think (e.g. save_memory)', () => {
    const { config } = buildConfig([{ name: 'save_memory', kind: Kind.Think }]);
    expect(isEarlyDispatchSafe(config, req('a', 'save_memory'))).toBe(false);
  });

  it('returns false for unknown tool names (registry miss)', () => {
    const { config } = buildConfig([]);
    expect(isEarlyDispatchSafe(config, req('a', 'mystery_mcp_tool'))).toBe(
      false,
    );
  });

  it('returns false for the agent tool even though it is concurrency-safe in the scheduler', () => {
    const { config } = buildConfig([
      { name: ToolNames.AGENT, kind: Kind.Other },
    ]);
    expect(isEarlyDispatchSafe(config, req('a', ToolNames.AGENT))).toBe(false);
  });

  it('returns false for structured_output regardless of kind', () => {
    const { config } = buildConfig([
      { name: ToolNames.STRUCTURED_OUTPUT, kind: Kind.Read },
    ]);
    expect(
      isEarlyDispatchSafe(config, req('a', ToolNames.STRUCTURED_OUTPUT)),
    ).toBe(false);
  });

  describe('shell read-only handling', () => {
    it('returns true for a read-only shell command', () => {
      const { config } = buildConfig([
        { name: ToolNames.SHELL, kind: Kind.Execute },
      ]);
      expect(
        isEarlyDispatchSafe(
          config,
          req('a', ToolNames.SHELL, { command: 'git log --oneline -n 5' }),
        ),
      ).toBe(true);
    });

    it('returns false for a side-effecting shell command', () => {
      const { config } = buildConfig([
        { name: ToolNames.SHELL, kind: Kind.Execute },
      ]);
      expect(
        isEarlyDispatchSafe(
          config,
          req('a', ToolNames.SHELL, { command: 'rm -rf node_modules' }),
        ),
      ).toBe(false);
    });

    it('returns false for a shell call missing the command arg', () => {
      const { config } = buildConfig([
        { name: ToolNames.SHELL, kind: Kind.Execute },
      ]);
      expect(isEarlyDispatchSafe(config, req('a', ToolNames.SHELL))).toBe(
        false,
      );
    });

    it('returns false for non-string command arg (defensive)', () => {
      const { config } = buildConfig([
        { name: ToolNames.SHELL, kind: Kind.Execute },
      ]);
      expect(
        isEarlyDispatchSafe(
          config,
          req('a', ToolNames.SHELL, { command: 12345 as unknown as string }),
        ),
      ).toBe(false);
    });
  });

  it('canonicalises legacy tool names before classification', () => {
    // `search_file_content` is the legacy alias for grep_search (Kind.Search).
    const { config } = buildConfig([
      { name: 'grep_search', kind: Kind.Search },
    ]);
    expect(isEarlyDispatchSafe(config, req('a', 'search_file_content'))).toBe(
      true,
    );
  });
});

describe('StreamingToolDispatcher', () => {
  let parentAbort: AbortController;

  beforeEach(() => {
    parentAbort = new AbortController();
  });

  it('exposes an executor that Turn.accept() can populate', () => {
    const { config } = buildConfig([{ name: 'read_file', kind: Kind.Read }]);
    const d = new StreamingToolDispatcher(config, parentAbort.signal);
    expect(d.getExecutor()).toBeInstanceOf(StreamingToolExecutor);
    d.dispose();
  });

  it('dispatches a safe tool early and records its result into the executor', async () => {
    const { config } = buildConfig([{ name: 'read_file', kind: Kind.Read }]);
    const d = new StreamingToolDispatcher(config, parentAbort.signal);
    d.accept(req('a', 'read_file'));
    expect(d.hasEarlyDispatch('a')).toBe(true);

    const result = await d.getEarlyResult('a');
    expect(result?.callId).toBe('a');
    expect(
      d
        .getExecutor()
        .getCompletedResults()
        .map((r) => r.callId),
    ).toEqual(['a']);
    d.dispose();
  });

  it('does not dispatch an unsafe tool but still accepts it into the executor', () => {
    const { config } = buildConfig([{ name: 'edit', kind: Kind.Edit }]);
    const d = new StreamingToolDispatcher(config, parentAbort.signal);
    d.accept(req('a', 'edit'));
    expect(d.hasEarlyDispatch('a')).toBe(false);
    expect(d.getExecutor().size()).toBe(1);
    d.dispose();
  });

  it('is idempotent on duplicate callIds — second accept does not re-dispatch', async () => {
    const exec = vi.fn(async () => ({
      llmContent: 'first',
      returnDisplay: 'first',
    }));
    const { config } = buildConfig([
      { name: 'read_file', kind: Kind.Read, execute: exec },
    ]);
    const d = new StreamingToolDispatcher(config, parentAbort.signal);
    d.accept(req('a', 'read_file'));
    d.accept(req('a', 'read_file'));
    await d.drainInFlight();
    expect(exec).toHaveBeenCalledTimes(1);
    d.dispose();
  });

  it('parallelises multiple safe dispatches (waits for whichever resolves last)', async () => {
    let releaseA: (() => void) | undefined;
    let releaseB: (() => void) | undefined;
    const aGate = new Promise<void>((r) => {
      releaseA = r;
    });
    const bGate = new Promise<void>((r) => {
      releaseB = r;
    });
    const { config } = buildConfig([
      {
        name: 'read_file',
        kind: Kind.Read,
        execute: vi.fn(async (params: { [key: string]: unknown }) => {
          if (params['n'] === 1) await aGate;
          else await bGate;
          return { llmContent: 'ok', returnDisplay: 'ok' };
        }),
      },
    ]);
    const d = new StreamingToolDispatcher(config, parentAbort.signal);
    d.accept(req('a', 'read_file', { n: 1 }));
    d.accept(req('b', 'read_file', { n: 2 }));

    // Release in reverse order — drain should still wait for both.
    releaseB!();
    releaseA!();
    const completed = await d.drainInFlight();
    expect(completed.map((r) => r.callId).sort()).toEqual(['a', 'b']);
    d.dispose();
  });

  describe('orphan prevention', () => {
    // The MockTool used by these tests drops the AbortSignal in the
    // non-updateOutput path, so probing the signal directly isn't
    // reliable here. We assert the OBSERVABLE orphan-prevention
    // guarantee instead — late completions resolve to `undefined` and
    // do not leak into the executor's results buffer.

    /**
     * Build a tool whose execute() resolves only when `release()` is
     * invoked. The returned object exposes both the tool's config entry
     * and the release function so tests can deterministically trigger
     * the completion mid-test.
     */
    function gatedTool(name = 'read_file'): {
      tool: ToolSetup;
      release: (r?: ToolResult) => void;
    } {
      let releaseFn!: (r?: ToolResult) => void;
      const gate = new Promise<ToolResult>((resolve) => {
        releaseFn = (r) =>
          resolve(r ?? { llmContent: 'late', returnDisplay: 'late' });
      });
      return {
        tool: {
          name,
          kind: Kind.Read,
          execute: vi.fn(async () => gate),
        },
        release: releaseFn,
      };
    }

    it('a late completion after executor.reset() is dropped (retry path)', async () => {
      const { tool, release } = gatedTool();
      const { config } = buildConfig([tool]);
      const d = new StreamingToolDispatcher(config, parentAbort.signal);
      d.accept(req('a', 'read_file'));

      const pending = d.getEarlyResult('a')!;
      // Simulate Turn firing executor.reset('retry') (mid-stream retry).
      d.getExecutor().reset('retry');

      // Releasing the gated execute() now must NOT land its result in
      // the (now-fresh) executor buffer — the dispatcher detached the
      // slot the moment reset() fired.
      release();
      await expect(pending).resolves.toBeUndefined();
      expect(d.getExecutor().getCompletedResults()).toEqual([]);
      // The executor is Open again — next accept() works on a fresh slot.
      d.accept(req('a', 'read_file'));
      expect(d.getExecutor().size()).toBe(1);
      d.dispose();
    });

    it('a late completion after executor.discard() is dropped (abort path)', async () => {
      const { tool, release } = gatedTool();
      const { config } = buildConfig([tool]);
      const d = new StreamingToolDispatcher(config, parentAbort.signal);
      d.accept(req('a', 'read_file'));
      const pending = d.getEarlyResult('a')!;

      d.discard('aborted');
      expect(d.getExecutor().isDiscarded()).toBe(true);

      release();
      await expect(pending).resolves.toBeUndefined();
      expect(d.getExecutor().getCompletedResults()).toEqual([]);

      // Post-discard accept is a no-op — no orphan dispatch resurrection.
      d.accept(req('b', 'read_file'));
      expect(d.hasEarlyDispatch('b')).toBe(false);
      d.dispose();
    });

    it('a late completion after stream-error discard is dropped', async () => {
      const { tool, release } = gatedTool();
      const { config } = buildConfig([tool]);
      const d = new StreamingToolDispatcher(config, parentAbort.signal);
      d.accept(req('a', 'read_file'));
      const pending = d.getEarlyResult('a')!;
      d.discard('stream-error');

      release();
      await expect(pending).resolves.toBeUndefined();
      expect(d.getExecutor().getCompletedResults()).toEqual([]);
      d.dispose();
    });

    it('post-reset re-accept routes through a fresh slot (no cross-batch leak)', async () => {
      let attempt = 0;
      const { config } = buildConfig([
        {
          name: 'read_file',
          kind: Kind.Read,
          execute: vi.fn(async () => {
            attempt += 1;
            return {
              llmContent: `attempt-${attempt}`,
              returnDisplay: `attempt-${attempt}`,
            };
          }),
        },
      ]);
      const d = new StreamingToolDispatcher(config, parentAbort.signal);
      d.accept(req('a', 'read_file'));
      await d.drainInFlight();
      // First batch landed.
      expect(
        d
          .getExecutor()
          .getCompletedResults()
          .map((r) => r.callId),
      ).toEqual(['a']);

      d.reset('retry');
      // Buffer wiped; a fresh accept for the same callId works.
      d.accept(req('a', 'read_file'));
      await d.drainInFlight();
      const completed = d.getExecutor().getCompletedResults();
      expect(completed.map((r) => r.callId)).toEqual(['a']);
      d.dispose();
    });
  });

  describe('close() semantics', () => {
    it('after close(), drainInFlight() still waits for in-flight to settle', async () => {
      let release!: (r: ToolResult) => void;
      const gate = new Promise<ToolResult>((r) => {
        release = r;
      });
      const { config } = buildConfig([
        {
          name: 'read_file',
          kind: Kind.Read,
          execute: vi.fn(() => gate),
        },
      ]);
      const d = new StreamingToolDispatcher(config, parentAbort.signal);
      d.accept(req('a', 'read_file'));
      d.close();
      // accept() after close is a no-op.
      d.accept(req('b', 'read_file'));
      expect(d.hasEarlyDispatch('b')).toBe(false);

      release({ llmContent: 'ok', returnDisplay: 'ok' });
      const completed = await d.drainInFlight();
      expect(completed.map((r) => r.callId)).toEqual(['a']);
      d.dispose();
    });
  });

  describe('error path', () => {
    it('synthesises a tool-error response when executeToolCall throws', async () => {
      const { config } = buildConfig([
        {
          name: 'read_file',
          kind: Kind.Read,
          execute: vi.fn(async () => {
            throw new Error('boom');
          }),
        },
      ]);
      const d = new StreamingToolDispatcher(config, parentAbort.signal);
      d.accept(req('a', 'read_file'));
      const r = await d.getEarlyResult('a');
      // executeToolCall wraps tool errors into a normal response with
      // `error` set — no exception escapes to the dispatcher. So this
      // assertion verifies the dispatcher delivers it as-is.
      expect(r?.callId).toBe('a');
      const completed = d.getExecutor().getCompletedResults();
      expect(completed.map((c) => c.callId)).toEqual(['a']);
      d.dispose();
    });
  });

  describe('dispose()', () => {
    it('unsubscribes from the executor — later reset() does not affect the dispatcher', () => {
      const { config } = buildConfig([{ name: 'read_file', kind: Kind.Read }]);
      const d = new StreamingToolDispatcher(config, parentAbort.signal);
      d.dispose();
      // Should not throw even though the underlying executor is still alive.
      expect(() => d.getExecutor().reset('retry')).not.toThrow();
    });

    it('is idempotent', () => {
      const { config } = buildConfig([{ name: 'read_file', kind: Kind.Read }]);
      const d = new StreamingToolDispatcher(config, parentAbort.signal);
      d.dispose();
      expect(() => d.dispose()).not.toThrow();
    });
  });

  describe('integration with executor lifecycle', () => {
    it('discard reason flows through the executor', async () => {
      const { config } = buildConfig([{ name: 'read_file', kind: Kind.Read }]);
      const d = new StreamingToolDispatcher(config, parentAbort.signal);
      d.accept(req('a', 'read_file'));
      const pending = d.getExecutor().getRemainingResults();
      d.discard('unauthorized');
      await expect(pending).rejects.toBeInstanceOf(
        StreamingToolExecutorDiscardedError,
      );
      await expect(pending).rejects.toMatchObject({ reason: 'unauthorized' });
      d.dispose();
    });
  });
});
