/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  getSubagentSessionDir,
  getAgentJsonlPath,
  getAgentMetaPath,
  getAgentMetaTerminalSummary,
  attachJsonlTranscriptWriter,
  buildAgentTranscriptAttach,
  normalizeResumedAgentDepth,
  readAgentMeta,
  readAgentTrace,
  readLastTranscriptRecordUuidSync,
  writeAgentMeta,
  type AgentMeta,
  type AttachJsonlOptions,
} from './agent-transcript.js';
import {
  AgentEventEmitter,
  AgentEventType,
  type AgentRoundTextEvent,
  type AgentToolCallEvent,
  type AgentToolResponsesFinalizedEvent as Finalized,
} from './runtime/agent-events.js';
import type { ChatRecord } from '../services/chatRecordingService.js';
import type { Config } from '../config/config.js';
import {
  fnResponse,
  modelText,
  userText,
} from '../test-utils/model-fixtures.js';

// Pin the git-branch annotation without spawning git: buildAgentTranscriptAttach
// is the only consumer of getCachedGitBranch in this file's import graph.
// vi.hoisted so the attach tests can also pin WHICH directory the builder
// hands to the lookup (project root, not the storage dir).
const { getCachedGitBranchMock } = vi.hoisted(() => ({
  getCachedGitBranchMock: vi.fn(() => 'test-branch'),
}));

vi.mock('../utils/gitUtils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/gitUtils.js')>();
  return {
    ...actual,
    getCachedGitBranch: getCachedGitBranchMock,
  };
});

describe('agent-transcript', () => {
  describe('path helpers', () => {
    it('places the session dir under projectDir/subagents/<sessionId>', () => {
      expect(getSubagentSessionDir('/proj', 'sess-1')).toBe(
        path.join('/proj', 'subagents', 'sess-1'),
      );
    });

    it('returns .jsonl path for the canonical transcript', () => {
      expect(getAgentJsonlPath('/proj', 'sess-1', 'agent-1')).toBe(
        path.join('/proj', 'subagents', 'sess-1', 'agent-agent-1.jsonl'),
      );
    });

    it('returns .meta.json path for the sidecar', () => {
      expect(getAgentMetaPath('/proj', 'sess-1', 'agent-1')).toBe(
        path.join('/proj', 'subagents', 'sess-1', 'agent-agent-1.meta.json'),
      );
    });

    it('sanitizes agentId to prevent path traversal', () => {
      const result = getAgentJsonlPath(
        '/proj',
        'sess-1',
        '../../../etc/passwd',
      );
      expect(result).not.toContain('..');
      expect(result).toContain(
        path.join('/proj', 'subagents', 'sess-1') + path.sep,
      );
      expect(result.endsWith('.jsonl')).toBe(true);
    });

    it('sanitizes sessionId to prevent path traversal', () => {
      const result = getAgentJsonlPath('/proj', '../escape', 'agent-1');
      expect(result).not.toContain('..');
      expect(
        result.startsWith(path.join('/proj', 'subagents') + path.sep),
      ).toBe(true);
    });

    it('preserves alphanumerics, underscores, and hyphens in agentId', () => {
      expect(getAgentJsonlPath('/proj', 'sess', 'agent_1-abc')).toBe(
        path.join('/proj', 'subagents', 'sess', 'agent-agent_1-abc.jsonl'),
      );
    });
  });

  describe('buildAgentTranscriptAttach', () => {
    beforeEach(() => {
      getCachedGitBranchMock.mockClear();
    });

    function makeConfig(cliVersion: string): Config {
      return {
        getSessionId: () => 'sess-9',
        getProjectRoot: () => '/proj/root',
        getCliVersion: () => cliVersion,
        storage: { getProjectDir: () => '/proj/dir' },
      } as unknown as Config;
    }

    it('assembles the path and launch metadata every attach site shares', () => {
      const { jsonlPath, options } = buildAgentTranscriptAttach(
        makeConfig('1.2.3'),
        'agent-1',
      );

      expect(jsonlPath).toBe(
        getAgentJsonlPath('/proj/dir', 'sess-9', 'agent-1'),
      );
      expect(options).toEqual({
        agentId: 'agent-1',
        sessionId: 'sess-9',
        cwd: '/proj/root',
        version: '1.2.3',
        gitBranch: 'test-branch',
      });
      // The branch lookup is anchored at the project root — the storage dir
      // is never inside a git repo, so a swap would silently drop gitBranch
      // from every transcript.
      expect(getCachedGitBranchMock).toHaveBeenCalledWith('/proj/root');
    });

    it('falls back to an unknown version when the CLI reports none', () => {
      const { options } = buildAgentTranscriptAttach(makeConfig(''), 'agent-1');
      expect(options.version).toBe('unknown');
    });

    it('routes the path through an overridden sessionId for resume', () => {
      const { jsonlPath, options } = buildAgentTranscriptAttach(
        makeConfig('1.2.3'),
        'agent-1',
        { sessionId: 'launch-session' },
      );

      expect(options.sessionId).toBe('launch-session');
      expect(jsonlPath).toBe(
        getAgentJsonlPath('/proj/dir', 'launch-session', 'agent-1'),
      );
    });
  });

  describe('writeAgentMeta', () => {
    let tempDir: string;
    let metaPath: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-test-'));
      metaPath = path.join(tempDir, 'subagents', 's1', 'agent-a.meta.json');
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    const minimalMeta = (): AgentMeta => ({
      agentId: 'a',
      agentType: 'x',
      description: 'd',
      parentSessionId: 's',
      parentAgentId: null,
      createdAt: 'now',
    });

    it('writes a JSON sidecar with the expected fields', () => {
      const meta: AgentMeta = {
        agentId: 'a',
        agentType: 'explore',
        description: 'Explore: list ts files',
        parentSessionId: 's1',
        parentAgentId: null,
        createdAt: '2026-04-20T00:00:00.000Z',
      };
      writeAgentMeta(metaPath, meta);
      const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      expect(parsed).toEqual(meta);
    });

    it('creates parent directories that do not yet exist', () => {
      const nested = path.join(
        tempDir,
        'a',
        'deeply',
        'nested',
        'agent.meta.json',
      );
      writeAgentMeta(nested, minimalMeta());
      expect(fs.existsSync(nested)).toBe(true);
    });

    it('reads back a previously-written meta sidecar', () => {
      writeAgentMeta(metaPath, {
        ...minimalMeta(),
        status: 'running',
        subagentName: 'explore',
        resolvedApprovalMode: 'auto-edit',
        executionAllowedTools: [],
      });

      expect(readAgentMeta(metaPath)).toMatchObject({
        agentId: 'a',
        status: 'running',
        subagentName: 'explore',
        executionAllowedTools: [],
      });
    });

    it('caps the persisted terminal activity summary', () => {
      const activities = Array.from({ length: 12 }, (_, index) => ({
        name: `tool-${index}`,
        description: `activity-${index}`,
        at: index,
      }));
      const summary = getAgentMetaTerminalSummary(
        { totalTokens: 12, outputTokens: 8, toolUses: 12, durationMs: 100 },
        activities,
      );

      expect(summary.stats).toEqual({
        totalTokens: 12,
        outputTokens: 8,
        toolUses: 12,
        durationMs: 100,
      });
      expect(summary.recentActivities).toHaveLength(10);
      expect(summary.recentActivities?.[0]?.name).toBe('tool-2');
      expect(summary.recentActivities?.at(-1)?.name).toBe('tool-11');
    });
  });

  describe('attachJsonlTranscriptWriter (canonical)', () => {
    let tempDir: string;
    let jsonlPath: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-test-'));
      jsonlPath = path.join(tempDir, 's', 'agent-x.jsonl');
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    const exists = (suffix = '') => fs.existsSync(jsonlPath + suffix);
    const lines = (suffix: string) =>
      fs
        .readFileSync(jsonlPath + suffix, 'utf8')
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));
    const readJsonl = (): ChatRecord[] => lines('');
    const kinds = (records: ChatRecord[]) =>
      records.map((record) => [record.type, record.subtype]);

    type Emit = (emitter: AgentEventEmitter) => void;
    const ev = { subagentId: 'agent-x', round: 1 };
    const roundText =
      (text: string, more: Partial<AgentRoundTextEvent> = {}): Emit =>
      (e) =>
        e.emit(AgentEventType.ROUND_TEXT, {
          ...ev,
          text,
          thoughtText: '',
          timestamp: Date.now(),
          ...more,
        });
    const streamText =
      (text: string, thought: boolean, timestamp: number): Emit =>
      (e) =>
        e.emit(AgentEventType.STREAM_TEXT, { ...ev, text, thought, timestamp });
    const toolCall =
      (
        callId: string,
        name: string,
        args: Record<string, unknown>,
        description: string,
        more: Partial<AgentToolCallEvent> = {},
      ): Emit =>
      (e) =>
        e.emit(AgentEventType.TOOL_CALL, {
          ...ev,
          callId,
          name,
          args,
          description,
          timestamp: Date.now(),
          ...more,
        });
    // One finalized response whose single functionResponse part answers callId.
    const finalized =
      (
        callId: string,
        name: string,
        response: Record<string, unknown>,
        extra: Pick<Finalized['responses'][number], 'durationMs'> = {},
        timestamp = Date.now(),
      ): Emit =>
      (e) =>
        e.emit(AgentEventType.TOOL_RESPONSES_FINALIZED, {
          ...ev,
          responses: [
            {
              callId,
              ...extra,
              responseParts: [fnResponse(name, response, callId)],
            },
          ],
          timestamp,
        });
    // `kind` omitted means the key is absent (legacy events).
    const external =
      (
        text: string,
        kind?: 'message' | 'notification',
        timestamp = 100,
      ): Emit =>
      (e) =>
        e.emit(AgentEventType.EXTERNAL_MESSAGE, {
          subagentId: 'agent-x',
          ...(kind ? { kind } : {}),
          text,
          timestamp,
        });
    const usage = () => ({
      promptTokenCount: 100,
      candidatesTokenCount: 20,
      cachedContentTokenCount: 40,
      totalTokenCount: 120,
    });

    // Required attach options only; `named` adds the display fields.
    const bare = {
      agentId: 'agent-x',
      sessionId: 'session-1',
      cwd: '/proj',
      version: '1.2.3',
    };
    const named = { ...bare, agentName: 'explore', agentColor: 'blue' };

    /** Attaches a writer (`opts` + `extra`) and runs `events` through it. */
    function start(
      events: Emit[] = [],
      extra: Partial<AttachJsonlOptions> = {},
      opts: AttachJsonlOptions = { ...named, gitBranch: 'main' },
    ) {
      const emitter = new AgentEventEmitter();
      const { cleanup } = attachJsonlTranscriptWriter(emitter, jsonlPath, {
        ...opts,
        ...extra,
      });
      events.forEach((emit) => emit(emitter));
      return { emitter, cleanup };
    }

    /** start() + cleanup(); returns the records on disk ([] when no file). */
    function write(...args: Parameters<typeof start>): ChatRecord[] {
      start(...args).cleanup();
      return exists() ? readJsonl() : [];
    }

    it('stamps base fields on every subagent record', () => {
      const records = write([roundText('Hello')]);
      expect(records).toHaveLength(1);
      const r = records[0];
      expect(r.agentId).toBe('agent-x');
      expect(r.agentName).toBe('explore');
      expect(r.agentColor).toBe('blue');
      expect(r.isSidechain).toBe(true);
      expect(r.sessionId).toBe('session-1');
      expect(r.cwd).toBe('/proj');
      expect(r.version).toBe('1.2.3');
      expect(r.gitBranch).toBe('main');
      expect(r.parentUuid).toBeNull();
    });

    it('records fork bootstrap and launch prompt as system records before runtime events', () => {
      const records = write([roundText('started')], {
        bootstrapHistory: [
          userText('bootstrap env'),
          modelText('bootstrap ack'),
        ],
        initialUserPrompt: 'visible launch prompt',
        launchTaskPrompt: 'Begin.',
      });
      expect(kinds(records)).toEqual([
        ['system', 'agent_bootstrap'],
        ['user', undefined],
        ['system', 'agent_launch_prompt'],
        ['assistant', undefined],
      ]);
      expect(records[0]?.systemPayload).toMatchObject({
        kind: 'fork',
        history: [userText('bootstrap env'), modelText('bootstrap ack')],
      });
      expect(records[2]?.systemPayload).toMatchObject({
        displayText: 'Begin.',
      });
    });

    it('writes bootstrap records even when inherited history is empty', () => {
      const records = write([], {
        bootstrapHistory: [],
        launchTaskPrompt: 'Begin.',
      });
      expect(kinds(records)).toEqual([
        ['system', 'agent_bootstrap'],
        ['system', 'agent_launch_prompt'],
      ]);
      expect(records[0]?.systemPayload).toMatchObject({
        kind: 'fork',
        history: [],
      });
      expect(records[0]?.systemPayload).not.toHaveProperty(
        'executionAllowedTools',
      );
    });

    it('seeds an agent_retry system marker at the retry seam', () => {
      write([roundText('attempt one')], { initialUserPrompt: 'task' });
      const records = write(
        [roundText('attempt two')],
        { appendToExisting: true, retryAttempt: 2 },
        bare,
      );
      expect(kinds(records)).toEqual([
        ['user', undefined],
        ['assistant', undefined],
        ['system', 'agent_retry'],
        ['assistant', undefined],
      ]);
      expect(records[2]?.systemPayload).toEqual({ attempt: 2 });
      expect(records[2]?.parentUuid).toBe(records[1]?.uuid);
      expect(records[3]?.parentUuid).toBe(records[2]?.uuid);
    });

    it('writes a ROUND_TEXT event as an assistant record with text part', () => {
      const records = write([roundText('Hello', { usageMetadata: usage() })]);
      expect(records).toHaveLength(1);
      expect(records[0].type).toBe('assistant');
      expect(records[0].message?.parts?.[0]).toMatchObject({ text: 'Hello' });
      expect(records[0].usageMetadata).toMatchObject({
        promptTokenCount: 100,
        candidatesTokenCount: 20,
        cachedContentTokenCount: 40,
      });
    });

    it('persists thought content and live stream chunks separately', () => {
      const { cleanup } = start([
        streamText('thinking now', true, 1),
        streamText('x'.repeat(64 * 1024), false, 1),
        roundText('answer', { thoughtText: 'thinking now', timestamp: 2 }),
      ]);
      expect(readJsonl()[0].message?.parts).toEqual([
        { text: 'thinking now', thought: true },
        { text: 'answer' },
      ]);
      expect(lines('.stream')[0]).toMatchObject({
        runId: readJsonl()[0].agentRunId,
        round: 1,
        text: 'thinking now',
        thought: true,
        timestamp: 1,
      });
      expect(readJsonl()[0].agentRound).toBe(1);
      cleanup();
      expect(exists('.stream')).toBe(false);
    });

    it('flushes live stream chunks when the pending buffer reaches 64 KiB', () => {
      const { emitter, cleanup } = start([
        streamText('x'.repeat(32 * 1024), false, 1),
      ]);
      expect(exists('.stream')).toBe(false);
      streamText('y'.repeat(32 * 1024), false, 2)(emitter);

      expect(exists('.stream')).toBe(true);
      const records = lines('.stream');
      expect(records).toHaveLength(2);
      expect(records[1]).toMatchObject({
        round: 1,
        thought: false,
        timestamp: 2,
      });
      cleanup();
      expect(exists('.stream')).toBe(false);
    });

    it('replaces a stale stream sidecar when a writer starts', () => {
      fs.mkdirSync(path.dirname(jsonlPath), { recursive: true });
      fs.writeFileSync(`${jsonlPath}.stream`, 'stale\n');

      const { cleanup } = start();

      expect(exists('.stream')).toBe(false);
      cleanup();
    });

    it('writes usage-only ROUND_TEXT with a model message for exporters', () => {
      const records = write([
        roundText('', { runId: 'run-1', usageMetadata: usage() }),
      ]);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        type: 'assistant',
        message: { role: 'model', parts: [] },
        usageMetadata: usage(),
        agentRunId: 'run-1',
        agentRound: 1,
      });
    });

    it('drops ROUND_TEXT with no text, thought, or usage', () => {
      write([roundText('')]);
      expect(exists()).toBe(false);
    });

    it('writes TOOL_CALL events as assistant records with functionCall parts', () => {
      const records = write([
        toolCall('c1', 'read_file', { file_path: '/x.txt' }, 'read x'),
      ]);
      expect(records).toHaveLength(1);
      expect(records[0].message?.parts?.[0]?.functionCall).toMatchObject({
        id: 'c1',
        name: 'read_file',
        args: { file_path: '/x.txt' },
      });
    });

    it('persists the model-facing identity for bridged tool calls', () => {
      const bridged = {
        name: 'mcp__docs__read',
        arguments: { path: 'README.md' },
      };
      const [record] = write([
        toolCall('c1', 'mcp__docs__read', { path: 'README.md' }, 'read docs', {
          modelFacingName: 'tool_call',
          modelFacingArgs: bridged,
        }),
      ]);
      expect(record?.message?.parts?.[0]?.functionCall).toEqual({
        id: 'c1',
        name: 'tool_call',
        args: { name: 'mcp__docs__read', arguments: { path: 'README.md' } },
      });
    });

    it('persists only nested session readiness transitions and removes the listener', () => {
      const { emitter, cleanup } = start([
        toolCall('nested', 'agent', {}, 'nested'),
      ]);
      const update = (ready: boolean) =>
        emitter.emit(AgentEventType.TOOL_OUTPUT_UPDATE, {
          ...ev,
          callId: 'nested',
          outputChunk: {
            type: 'task_execution',
            subagentName: 'general-purpose',
            taskDescription: 'nested',
            taskPrompt: 'nested',
            status: 'running',
            subagentSessionReady: ready,
          },
          timestamp: Date.now(),
        });
      update(false);
      update(true);
      update(true);
      cleanup();
      update(false);
      const records = readJsonl();
      expect(records.map((record) => record.type)).toEqual([
        'assistant',
        'system',
        'system',
      ]);
      expect(
        records.slice(1).map((record) => ({
          subtype: record.subtype,
          payload: record.systemPayload,
        })),
      ).toEqual(
        [false, true].map((subagentSessionReady) => ({
          subtype: 'agent_session_ready',
          payload: { callId: 'nested', subagentSessionReady },
        })),
      );
      expect(records[1].parentUuid).toBe(records[0].uuid);
      expect(records[2].parentUuid).toBe(records[1].uuid);
    });

    it('preserves a nested launch failure in its finalized result', () => {
      const records = write([
        toolCall('nested', 'agent', {}, 'nested'),
        finalized('nested', 'agent', { error: 'Registration failed' }),
      ]);
      expect(records[1].systemPayload).toEqual({
        callId: 'nested',
        subagentSessionReady: false,
      });
      expect(records[2].toolCallResult).toEqual({
        callId: 'nested',
        status: 'error',
      });
    });

    it('does not persist provisional TOOL_RESULT response parts', () => {
      write([
        (e) =>
          e.emit(AgentEventType.TOOL_RESULT, {
            ...ev,
            callId: 'c1',
            name: 'read_file',
            success: true,
            responseParts: [
              fnResponse('read_file', { output: 'unfinalized' }, 'c1'),
            ],
            timestamp: Date.now(),
          }),
      ]);
      expect(exists()).toBe(false);
    });

    it('writes finalized tool responses with toolCallResult metadata', () => {
      const records = write([
        finalized('c1', 'read_file', { output: 'done' }, { durationMs: 7 }),
      ]);
      expect(records).toHaveLength(1);
      expect(records[0].type).toBe('tool_result');
      expect(records[0].toolCallResult).toMatchObject({
        callId: 'c1',
        durationMs: 7,
      });
    });

    it('preserves finalized responseParts', () => {
      const records = write([
        finalized('c1', 'read_file', { output: 'line1\nline2\n' }),
      ]);
      expect(records[0].message?.parts).toEqual([
        fnResponse('read_file', { output: 'line1\nline2\n' }, 'c1'),
      ]);
    });

    it('chains parentUuid across multiple records', () => {
      const records = write([
        roundText('hi', { timestamp: 1 }),
        toolCall('c1', 'read_file', {}, '', { timestamp: 2 }),
        finalized('c1', 'read_file', { output: 'done' }, {}, 3),
      ]);
      expect(records).toHaveLength(3);
      expect(records[0].parentUuid).toBeNull();
      expect(records[1].parentUuid).toBe(records[0].uuid);
      expect(records[2].parentUuid).toBe(records[1].uuid);
    });

    it('seeds the JSONL with the launching prompt as a user-role record', () => {
      const records = write([], {
        initialUserPrompt: 'Find all TODO comments',
      });
      expect(records).toHaveLength(1);
      expect(records[0].type).toBe('user');
      expect(records[0].message).toEqual(userText('Find all TODO comments'));
      expect(records[0].isSidechain).toBe(true);
      expect(records[0].parentUuid).toBeNull();
    });

    it('skips an empty initialUserPrompt so the chain stays clean', () => {
      write([], { initialUserPrompt: '' });
      expect(exists()).toBe(false);
    });

    it('writes EXTERNAL_MESSAGE events as user records chained after the seed', () => {
      const records = write([external('follow-up from parent', 'message')], {
        initialUserPrompt: 'initial prompt',
      });
      expect(records).toHaveLength(2);
      expect(records[1].type).toBe('user');
      expect(records[1].message).toEqual(userText('follow-up from parent'));
      expect(records[1].externalInputKind).toBe('message');
      expect(records[1].parentUuid).toBe(records[0].uuid);
    });

    it('preserves notification kind for EXTERNAL_MESSAGE records', () => {
      const records = write([
        external('<task-notification />', 'notification'),
      ]);
      expect(records).toHaveLength(1);
      expect(records[0].type).toBe('user');
      expect(records[0].message).toEqual(userText('<task-notification />'));
      expect(records[0].externalInputKind).toBe('notification');
    });

    it('defaults legacy EXTERNAL_MESSAGE events without kind to message records', () => {
      const records = write([external('legacy follow-up from parent')]);
      expect(records).toHaveLength(1);
      expect(records[0].type).toBe('user');
      expect(records[0].message).toEqual(
        userText('legacy follow-up from parent'),
      );
      expect(records[0].externalInputKind).toBe('message');
    });

    it('stops writing after cleanup', () => {
      const { emitter, cleanup } = start();
      cleanup();
      roundText('late', { timestamp: 1 })(emitter);
      external('late injection', 'notification', 2)(emitter);
      expect(exists()).toBe(false);
    });

    it('appends onto an existing transcript when appendToExisting is enabled', () => {
      write([], { initialUserPrompt: 'initial prompt' });
      const records = write(
        [],
        { appendToExisting: true, initialUserPrompt: 'resume prompt' },
        named,
      );
      expect(records).toHaveLength(2);
      expect(records[1].parentUuid).toBe(records[0].uuid);
      expect(readLastTranscriptRecordUuidSync(jsonlPath)).toBe(records[1].uuid);
    });
  });

  describe('normalizeResumedAgentDepth', () => {
    it('passes through valid persisted depths and absent values', () => {
      expect(normalizeResumedAgentDepth(undefined)).toBeUndefined();
      expect(normalizeResumedAgentDepth(0)).toBe(0);
      expect(normalizeResumedAgentDepth(3)).toBe(3);
      expect(normalizeResumedAgentDepth(100)).toBe(100);
    });

    it('fails closed (no spawn capacity) on tampered or corrupt values', () => {
      // A negative depth would make canSpawnNestedAgent() pass for every
      // cap; clamping down to 0 would likewise fail open by granting full
      // spawn capacity. Anything invalid pins to the ceiling instead.
      expect(normalizeResumedAgentDepth(-50)).toBe(100);
      // JSON `-1e309` parses to -Infinity.
      expect(normalizeResumedAgentDepth(-Infinity)).toBe(100);
      expect(normalizeResumedAgentDepth(Infinity)).toBe(100);
      expect(normalizeResumedAgentDepth(NaN)).toBe(100);
      expect(normalizeResumedAgentDepth(2.5)).toBe(100);
      expect(normalizeResumedAgentDepth(101)).toBe(100);
      expect(normalizeResumedAgentDepth(null as unknown as number)).toBe(
        undefined,
      );
    });
  });

  describe('readAgentTrace', () => {
    let projectDir: string;

    beforeEach(() => {
      projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-trace-'));
    });

    afterEach(() => {
      fs.rmSync(projectDir, { recursive: true, force: true });
    });

    it('returns complete, filtered lineage and marks missing parents', async () => {
      const sessionId = 'session-1';
      // [agentId, agentType, description, parentAgentId, status?]; createdAt
      // ticks one second per row, and rows without a status omit the key.
      const rows: Array<
        [string, string, string, string | null, AgentMeta['status']?]
      > = [
        ['root', 'reviewer', 'root task', null, 'completed'],
        ['child', 'tester', 'child task', 'root', 'running'],
        ['orphan', 'tester', 'orphan task', 'missing'],
        ['cycle-a', 'tester', 'cycle a', 'cycle-b'],
        ['cycle-b', 'tester', 'cycle b', 'cycle-a'],
        ['0-cycle-child', 'tester', 'cycle child', 'cycle-a'],
      ];
      rows.forEach(
        ([agentId, agentType, description, parentAgentId, status], i) =>
          writeAgentMeta(getAgentMetaPath(projectDir, sessionId, agentId), {
            agentId,
            agentType,
            description,
            parentSessionId: sessionId,
            parentAgentId,
            createdAt: `2026-01-01T00:00:0${i}.000Z`,
            ...(status ? { status } : {}),
          }),
      );

      const trace = await readAgentTrace(projectDir, sessionId, 'root');

      expect(trace.rootAgentIds).toEqual(['root']);
      expect(trace.nodes.map((node) => node.agentId)).toEqual([
        'root',
        'child',
      ]);
      expect(
        trace.nodes.find((node) => node.agentId === 'child'),
      ).toMatchObject({ rootAgentId: 'root', lineageState: 'complete' });
      const fullTrace = await readAgentTrace(projectDir, sessionId);
      expect(
        fullTrace.nodes.find((node) => node.agentId === 'orphan'),
      ).toMatchObject({ lineageState: 'orphaned' });
      expect(
        fullTrace.nodes
          .filter((node) => node.lineageState === 'cycle')
          .map((node) => node.rootAgentId),
      ).toEqual(['cycle-a', 'cycle-a', 'cycle-a']);
    });
  });
});
