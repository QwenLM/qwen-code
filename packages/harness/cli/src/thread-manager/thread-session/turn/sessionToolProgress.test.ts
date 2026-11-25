/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreToolCallStatus, InMemoryToolCallSnapshotStore, type ToolCall } from '@qwen-code/core';
import { attachSessionToolProgress } from './sessionToolProgress.js';
import type { ThreadNotice } from '../contract/hostContext.js';

// 保护执行起点、替换快照和生命周期隔离；不调用真实命令。
describe('foreground shell progress', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10_000); });
  afterEach(() => vi.useRealTimers());
  function setup() {
    const snapshots = new InMemoryToolCallSnapshotStore();
    const notices: ThreadNotice[] = [];
    const dispose = attachSessionToolProgress({ snapshots, emitNotice: n => notices.push(n) });
    const publish = (calls: ToolCall[], toolCallScopeId = 'root') => snapshots.publishToolCallSnapshot({ toolCallScopeId, toolCalls: calls });
    return { notices, publish, dispose };
  }
  function call(id = 'a', extra = {}): ToolCall {
    return { status: CoreToolCallStatus.Executing, request: { callId: id, name: 'Bash', args: {}, prompt_id: 'p' }, executionStartedAt: 10_000, startTime: 1, ...extra } as ToolCall;
  }
  it('starts at actual execution, delays content and replaces repeated previews', () => {
    const { notices, publish, dispose } = setup();
    publish([call('a', { status: CoreToolCallStatus.AwaitingApproval })]);
    expect(notices).toHaveLength(0);
    publish([call('a', { liveOutput: 'early' })]);
    expect(notices).toMatchObject([{ kind: 'toolProgress', startedAtMs: 10_000, output: '' }]);
    vi.advanceTimersByTime(2000);
    expect(notices.at(-1)).toMatchObject({ output: 'early' });
    publish([call('a', { liveOutput: { isShellLiveOutput: true, output: 'same', totalBytes: 100, totalLines: 10 } })]);
    publish([call('a', { liveOutput: { isShellLiveOutput: true, output: 'same', totalBytes: 200, totalLines: 20 } })]);
    vi.advanceTimersByTime(1000);
    expect(notices.at(-1)).toMatchObject({ output: 'same', totalBytes: 200, previewTruncated: true });
    expect(notices).toHaveLength(3);
    publish([call('a', { liveOutput: 'plain' })]);
    vi.advanceTimersByTime(1000);
    expect(notices.at(-1)).toMatchObject({ output: 'plain' });
    expect((notices.at(-1) as { totalBytes?: number }).totalBytes).toBeUndefined();
    expect((notices.at(-1) as { previewTruncated?: boolean }).previewTruncated).toBeUndefined();
    dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([20, undefined])('ends with the newest pending preview and optional total: %s', (totalLines) => {
    const { notices, publish, dispose } = setup();
    publish([call('a', { liveOutput: { isShellLiveOutput: true, output: 'old', totalLines: 10, totalBytes: 100 } })]);
    vi.advanceTimersByTime(2000);
    publish([call('a', { liveOutput: { isShellLiveOutput: true, output: 'latest', totalLines, totalBytes: 200 } })]);
    publish([]);
    expect(notices.at(-1)).toMatchObject({ phase: 'ended', output: 'latest', totalLines });
    expect(vi.getTimerCount()).toBe(0);
    dispose();
  });

  it('keeps parallel calls isolated and never observes background or child schedulers', () => {
    const { notices, publish, dispose } = setup();
    publish([call()], 'child');
    publish([call('bg', { request: { callId: 'bg', name: 'Bash', args: { run_in_background: true } } })]);
    expect(notices).toHaveLength(0);
    publish([call('a'), call('b')]);
    publish([], 'child');
    expect(notices).toHaveLength(2);
    publish([call('a', { status: CoreToolCallStatus.Cancelled }), call('b')]);
    expect(notices.at(-1)).toMatchObject({ toolUseId: 'a', phase: 'ended' });
    publish([call('a'), call('b')]);
    expect(notices).toHaveLength(3);
    dispose();
    publish([call('c')]);
    expect(notices).toHaveLength(3);
  });
  it('bounds UTF-8 output and stops timers on completion', () => {
    const { notices, publish, dispose } = setup();
    publish([call('a', { liveOutput: '中'.repeat(100_000) })]);
    vi.advanceTimersByTime(2000);
    const last = notices.at(-1) as Extract<ThreadNotice, { kind: 'toolProgress' }>;
    expect(Buffer.byteLength(last.output)).toBeLessThanOrEqual(4096);
    expect(last.output).not.toContain('\uFFFD');
    expect(last.previewTruncated).toBe(true);
    publish([]);
    expect(vi.getTimerCount()).toBe(0);
    dispose();
  });

  it('CodeMode 的 Bash 与 Wait 所在调度器交错时不提前结束进度', () => {
    const snapshots = new InMemoryToolCallSnapshotStore();
    const notices: ThreadNotice[] = [];
    const dispose = attachSessionToolProgress({ snapshots, emitNotice: n => notices.push(n) });
    const codeMode = { rootToolUseId: 'exec', parentToolUseId: 'agent' };
    try {
      snapshots.publishToolCallSnapshot({ toolCallScopeId: 'cell', codeMode, toolCalls: [call('child', { request: { callId: 'child', name: 'Bash', args: {}, parentCallId: 'exec' }, liveOutput: 'working' })] });
      snapshots.publishToolCallSnapshot({ toolCallScopeId: 'root', toolCalls: [call('wait', { request: { callId: 'wait', name: 'Wait', args: {} } })] });
      vi.advanceTimersByTime(2000);
      expect(notices).toMatchObject([
        { phase: 'running', toolUseId: 'child', parentToolUseId: 'agent' },
        { phase: 'running', output: 'working' },
      ]);
      snapshots.publishToolCallSnapshot({ toolCallScopeId: 'cell', codeMode, toolCalls: [] });
      expect(notices.at(-1)).toMatchObject({ toolUseId: 'child', phase: 'ended' });
      expect(vi.getTimerCount()).toBe(0);
    } finally { dispose(); }
  });
});
