/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  getSubagentSessionDir,
  getAgentJsonlPath,
  getAgentMetaPath,
  attachJsonlTranscriptWriter,
  readAgentMeta,
  readLastTranscriptRecordUuidSync,
  writeAgentMeta,
  type AgentMeta,
} from './agent-transcript.js';
import { AgentEventEmitter, AgentEventType } from './runtime/agent-events.js';
import type { ChatRecord } from '../services/chatRecordingService.js';
import type { Content, FunctionDeclaration } from '@google/genai';

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

  describe('writeAgentMeta', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-test-'));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('writes a JSON sidecar with the expected fields', () => {
      const metaPath = path.join(
        tempDir,
        'subagents',
        's1',
        'agent-a.meta.json',
      );
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
      const metaPath = path.join(
        tempDir,
        'a',
        'deeply',
        'nested',
        'agent.meta.json',
      );
      writeAgentMeta(metaPath, {
        agentId: 'a',
        agentType: 'x',
        description: 'd',
        parentSessionId: 's',
        parentAgentId: null,
        createdAt: 'now',
      });
      expect(fs.existsSync(metaPath)).toBe(true);
    });

    it('reads back a previously-written meta sidecar', () => {
      const metaPath = path.join(
        tempDir,
        'subagents',
        's1',
        'agent-a.meta.json',
      );
      writeAgentMeta(metaPath, {
        agentId: 'a',
        agentType: 'x',
        description: 'd',
        parentSessionId: 's',
        parentAgentId: null,
        createdAt: 'now',
        status: 'running',
        subagentName: 'explore',
        resolvedApprovalMode: 'auto-edit',
      });

      expect(readAgentMeta(metaPath)).toMatchObject({
        agentId: 'a',
        status: 'running',
        subagentName: 'explore',
      });
    });
  });

  describe('attachJsonlTranscriptWriter (canonical)', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-test-'));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    function readJsonl(p: string): ChatRecord[] {
      return fs
        .readFileSync(p, 'utf-8')
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as ChatRecord);
    }

    function makeWriter(
      jsonlPath: string,
      extra: {
        initialUserPrompt?: string;
        bootstrapHistory?: Content[];
        bootstrapSystemInstruction?: string | Content;
        bootstrapTools?: Array<string | FunctionDeclaration>;
        launchTaskPrompt?: string;
      } = {},
    ) {
      const emitter = new AgentEventEmitter();
      const { cleanup } = attachJsonlTranscriptWriter(emitter, jsonlPath, {
        agentId: 'agent-x',
        agentName: 'explore',
        agentColor: 'blue',
        sessionId: 'session-1',
        cwd: '/proj',
        version: '1.2.3',
        gitBranch: 'main',
        ...extra,
      });
      return { emitter, cleanup };
    }

    it('stamps base fields on every subagent record', () => {
      const jsonlPath = path.join(tempDir, 's', 'agent-x.jsonl');
      const { emitter, cleanup } = makeWriter(jsonlPath);

      emitter.emit(AgentEventType.ROUND_TEXT, {
        subagentId: 'agent-x',
        round: 1,
        text: 'Hello',
        thoughtText: '',
        timestamp: Date.now(),
      });
      cleanup();

      const records = readJsonl(jsonlPath);
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
      const jsonlPath = path.join(tempDir, 's', 'agent-x.jsonl');
      const { emitter, cleanup } = makeWriter(jsonlPath, {
        bootstrapHistory: [
          { role: 'user', parts: [{ text: 'bootstrap env' }] },
          { role: 'model', parts: [{ text: 'bootstrap ack' }] },
        ],
        initialUserPrompt: 'visible launch prompt',
        launchTaskPrompt: 'Begin.',
      });

      emitter.emit(AgentEventType.ROUND_TEXT, {
        subagentId: 'agent-x',
        round: 1,
        text: 'started',
        thoughtText: '',
        timestamp: Date.now(),
      });
      cleanup();

      const records = readJsonl(jsonlPath);
      expect(records.map((record) => [record.type, record.subtype])).toEqual([
        ['system', 'agent_bootstrap'],
        ['user', undefined],
        ['system', 'agent_launch_prompt'],
        ['assistant', undefined],
      ]);
      expect(records[0]?.systemPayload).toMatchObject({
        kind: 'fork',
        history: [
          { role: 'user', parts: [{ text: 'bootstrap env' }] },
          { role: 'model', parts: [{ text: 'bootstrap ack' }] },
        ],
      });
      expect(records[2]?.systemPayload).toMatchObject({
        displayText: 'Begin.',
      });
    });

    it('writes bootstrap records even when inherited history is empty', () => {
      const jsonlPath = path.join(tempDir, 's', 'agent-x.jsonl');
      const { cleanup } = makeWriter(jsonlPath, {
        bootstrapHistory: [],
        bootstrapSystemInstruction: {
          role: 'system',
          parts: [{ text: 'fork system' }],
        },
        bootstrapTools: [{ name: 'Bash' }],
        launchTaskPrompt: 'Begin.',
      });

      cleanup();

      const records = readJsonl(jsonlPath);
      expect(records.map((record) => [record.type, record.subtype])).toEqual([
        ['system', 'agent_bootstrap'],
        ['system', 'agent_launch_prompt'],
      ]);
      expect(records[0]?.systemPayload).toMatchObject({
        kind: 'fork',
        history: [],
        systemInstruction: {
          role: 'system',
          parts: [{ text: 'fork system' }],
        },
        tools: [{ name: 'Bash' }],
      });
    });

    it('writes a ROUND_TEXT event as an assistant record with text part', () => {
      const jsonlPath = path.join(tempDir, 's', 'agent-x.jsonl');
      const { emitter, cleanup } = makeWriter(jsonlPath);

      emitter.emit(AgentEventType.ROUND_TEXT, {
        subagentId: 'agent-x',
        round: 1,
        text: 'Hello',
        thoughtText: '',
        timestamp: Date.now(),
      });
      cleanup();

      const records = readJsonl(jsonlPath);
      expect(records).toHaveLength(1);
      expect(records[0].type).toBe('assistant');
      expect(records[0].message?.parts?.[0]).toMatchObject({ text: 'Hello' });
    });

    it('drops empty ROUND_TEXT to keep the canonical view free of noise', () => {
      const jsonlPath = path.join(tempDir, 's', 'agent-x.jsonl');
      const { emitter, cleanup } = makeWriter(jsonlPath);

      emitter.emit(AgentEventType.ROUND_TEXT, {
        subagentId: 'agent-x',
        round: 1,
        text: '',
        thoughtText: '',
        timestamp: Date.now(),
      });
      cleanup();

      expect(fs.existsSync(jsonlPath)).toBe(false);
    });

    it('writes TOOL_CALL events as assistant records with functionCall parts', () => {
      const jsonlPath = path.join(tempDir, 's', 'agent-x.jsonl');
      const { emitter, cleanup } = makeWriter(jsonlPath);

      emitter.emit(AgentEventType.TOOL_CALL, {
        subagentId: 'agent-x',
        round: 1,
        callId: 'c1',
        name: 'read_file',
        args: { file_path: '/x.txt' },
        description: 'read x',
        timestamp: Date.now(),
      });
      cleanup();

      const records = readJsonl(jsonlPath);
      expect(records).toHaveLength(1);
      const part = records[0].message?.parts?.[0] as {
        functionCall?: { id: string; name: string; args: unknown };
      };
      expect(part.functionCall).toMatchObject({
        id: 'c1',
        name: 'read_file',
        args: { file_path: '/x.txt' },
      });
    });

    it('writes TOOL_RESULT events as tool_result records with toolCallResult metadata', () => {
      const jsonlPath = path.join(tempDir, 's', 'agent-x.jsonl');
      const { emitter, cleanup } = makeWriter(jsonlPath);

      emitter.emit(AgentEventType.TOOL_RESULT, {
        subagentId: 'agent-x',
        round: 1,
        callId: 'c1',
        name: 'read_file',
        success: true,
        durationMs: 7,
        timestamp: Date.now(),
      });
      cleanup();

      const records = readJsonl(jsonlPath);
      expect(records).toHaveLength(1);
      expect(records[0].type).toBe('tool_result');
      expect(records[0].toolCallResult).toMatchObject({
        callId: 'c1',
        durationMs: 7,
      });
    });

    it('preserves real responseParts from TOOL_RESULT when present', () => {
      const jsonlPath = path.join(tempDir, 's', 'agent-x.jsonl');
      const { emitter, cleanup } = makeWriter(jsonlPath);

      const responseParts = [
        {
          functionResponse: {
            id: 'c1',
            name: 'read_file',
            response: { output: 'line1\nline2\n' },
          },
        },
      ];
      emitter.emit(AgentEventType.TOOL_RESULT, {
        subagentId: 'agent-x',
        round: 1,
        callId: 'c1',
        name: 'read_file',
        success: true,
        responseParts,
        timestamp: Date.now(),
      });
      cleanup();

      const records = readJsonl(jsonlPath);
      expect(records[0].message?.parts).toEqual(responseParts);
    });

    it('chains parentUuid across multiple records', () => {
      const jsonlPath = path.join(tempDir, 's', 'agent-x.jsonl');
      const { emitter, cleanup } = makeWriter(jsonlPath);

      emitter.emit(AgentEventType.ROUND_TEXT, {
        subagentId: 'agent-x',
        round: 1,
        text: 'hi',
        thoughtText: '',
        timestamp: 1,
      });
      emitter.emit(AgentEventType.TOOL_CALL, {
        subagentId: 'agent-x',
        round: 1,
        callId: 'c1',
        name: 'read_file',
        args: {},
        description: '',
        timestamp: 2,
      });
      emitter.emit(AgentEventType.TOOL_RESULT, {
        subagentId: 'agent-x',
        round: 1,
        callId: 'c1',
        name: 'read_file',
        success: true,
        timestamp: 3,
      });
      cleanup();

      const records = readJsonl(jsonlPath);
      expect(records).toHaveLength(3);
      expect(records[0].parentUuid).toBeNull();
      expect(records[1].parentUuid).toBe(records[0].uuid);
      expect(records[2].parentUuid).toBe(records[1].uuid);
    });

    it('seeds the JSONL with the launching prompt as a user-role record', () => {
      const jsonlPath = path.join(tempDir, 's', 'agent-x.jsonl');
      const { cleanup } = makeWriter(jsonlPath, {
        initialUserPrompt: 'Find all TODO comments',
      });

      cleanup();

      const records = readJsonl(jsonlPath);
      expect(records).toHaveLength(1);
      expect(records[0].type).toBe('user');
      expect(records[0].message).toEqual({
        role: 'user',
        parts: [{ text: 'Find all TODO comments' }],
      });
      expect(records[0].isSidechain).toBe(true);
      expect(records[0].parentUuid).toBeNull();
    });

    it('skips an empty initialUserPrompt so the chain stays clean', () => {
      const jsonlPath = path.join(tempDir, 's', 'agent-x.jsonl');
      const { cleanup } = makeWriter(jsonlPath, { initialUserPrompt: '' });

      cleanup();

      expect(fs.existsSync(jsonlPath)).toBe(false);
    });

    it('writes EXTERNAL_MESSAGE events as user records chained after the seed', () => {
      const jsonlPath = path.join(tempDir, 's', 'agent-x.jsonl');
      const { emitter, cleanup } = makeWriter(jsonlPath, {
        initialUserPrompt: 'initial prompt',
      });

      emitter.emit(AgentEventType.EXTERNAL_MESSAGE, {
        subagentId: 'agent-x',
        kind: 'message',
        text: 'follow-up from parent',
        timestamp: 100,
      });
      cleanup();

      const records = readJsonl(jsonlPath);
      expect(records).toHaveLength(2);
      expect(records[1].type).toBe('user');
      expect(records[1].message).toEqual({
        role: 'user',
        parts: [{ text: 'follow-up from parent' }],
      });
      expect(records[1].externalInputKind).toBe('message');
      expect(records[1].parentUuid).toBe(records[0].uuid);
    });

    it('preserves notification kind for EXTERNAL_MESSAGE records', () => {
      const jsonlPath = path.join(tempDir, 's', 'agent-x.jsonl');
      const { emitter, cleanup } = makeWriter(jsonlPath);

      emitter.emit(AgentEventType.EXTERNAL_MESSAGE, {
        subagentId: 'agent-x',
        kind: 'notification',
        text: '<task-notification />',
        timestamp: 100,
      });
      cleanup();

      const records = readJsonl(jsonlPath);
      expect(records).toHaveLength(1);
      expect(records[0].type).toBe('user');
      expect(records[0].message).toEqual({
        role: 'user',
        parts: [{ text: '<task-notification />' }],
      });
      expect(records[0].externalInputKind).toBe('notification');
    });

    it('defaults legacy EXTERNAL_MESSAGE events without kind to message records', () => {
      const jsonlPath = path.join(tempDir, 's', 'agent-x.jsonl');
      const { emitter, cleanup } = makeWriter(jsonlPath);

      emitter.emit(AgentEventType.EXTERNAL_MESSAGE, {
        subagentId: 'agent-x',
        text: 'legacy follow-up from parent',
        timestamp: 100,
      });
      cleanup();

      const records = readJsonl(jsonlPath);
      expect(records).toHaveLength(1);
      expect(records[0].type).toBe('user');
      expect(records[0].message).toEqual({
        role: 'user',
        parts: [{ text: 'legacy follow-up from parent' }],
      });
      expect(records[0].externalInputKind).toBe('message');
    });

    it('stops writing after cleanup', () => {
      const jsonlPath = path.join(tempDir, 's', 'agent-x.jsonl');
      const { emitter, cleanup } = makeWriter(jsonlPath);

      cleanup();
      emitter.emit(AgentEventType.ROUND_TEXT, {
        subagentId: 'agent-x',
        round: 1,
        text: 'late',
        thoughtText: '',
        timestamp: 1,
      });
      emitter.emit(AgentEventType.EXTERNAL_MESSAGE, {
        subagentId: 'agent-x',
        kind: 'notification',
        text: 'late injection',
        timestamp: 2,
      });

      expect(fs.existsSync(jsonlPath)).toBe(false);
    });

    it('appends onto an existing transcript when appendToExisting is enabled', () => {
      const jsonlPath = path.join(tempDir, 's', 'agent-x.jsonl');
      const first = makeWriter(jsonlPath, {
        initialUserPrompt: 'initial prompt',
      });
      first.cleanup();

      const emitter = new AgentEventEmitter();
      const { cleanup } = attachJsonlTranscriptWriter(emitter, jsonlPath, {
        agentId: 'agent-x',
        agentName: 'explore',
        agentColor: 'blue',
        sessionId: 'session-1',
        cwd: '/proj',
        version: '1.2.3',
        appendToExisting: true,
        initialUserPrompt: 'resume prompt',
      });

      cleanup();

      const records = readJsonl(jsonlPath);
      expect(records).toHaveLength(2);
      expect(records[1].parentUuid).toBe(records[0].uuid);
      expect(readLastTranscriptRecordUuidSync(jsonlPath)).toBe(records[1].uuid);
    });
  });
});
