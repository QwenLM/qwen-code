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
  getAgentTranscriptDir,
  getAgentTranscriptPath,
  attachTranscriptWriter,
} from './agent-transcript.js';
import { AgentEventEmitter, AgentEventType } from './runtime/agent-events.js';

describe('agent-transcript', () => {
  describe('getAgentTranscriptDir', () => {
    it('returns agents subdirectory under projectTempDir', () => {
      expect(getAgentTranscriptDir('/tmp/project')).toBe('/tmp/project/agents');
    });
  });

  describe('getAgentTranscriptPath', () => {
    it('returns .txt file under agents directory', () => {
      expect(getAgentTranscriptPath('/tmp/project', 'my-agent')).toBe(
        '/tmp/project/agents/my-agent.txt',
      );
    });

    it('sanitizes agent ID to prevent path traversal', () => {
      const result = getAgentTranscriptPath(
        '/tmp/project',
        '../../../etc/passwd',
      );
      expect(result).not.toContain('..');
      expect(result).toContain('/tmp/project/agents/');
      expect(result.endsWith('.txt')).toBe(true);
    });

    it('preserves alphanumeric, underscores, and hyphens', () => {
      expect(getAgentTranscriptPath('/tmp/project', 'agent_1-abc')).toBe(
        '/tmp/project/agents/agent_1-abc.txt',
      );
    });
  });

  describe('attachTranscriptWriter', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-test-'));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('writes START event to transcript file', () => {
      const emitter = new AgentEventEmitter();
      const transcriptPath = path.join(tempDir, 'agents', 'test.txt');
      const cleanup = attachTranscriptWriter(emitter, transcriptPath);

      emitter.emit(AgentEventType.START, {
        subagentId: 'test-1',
        name: 'Test Agent',
        model: 'gemini-2.0',
        tools: ['read_file', 'edit_file'],
        timestamp: Date.now(),
      });

      cleanup();

      const content = fs.readFileSync(transcriptPath, 'utf-8');
      expect(content).toContain('Agent started: Test Agent');
      expect(content).toContain('Tools: read_file, edit_file');
    });

    it('writes TOOL_CALL event to transcript file', () => {
      const emitter = new AgentEventEmitter();
      const transcriptPath = path.join(tempDir, 'agents', 'test.txt');
      const cleanup = attachTranscriptWriter(emitter, transcriptPath);

      emitter.emit(AgentEventType.TOOL_CALL, {
        subagentId: 'test-1',
        round: 1,
        callId: 'call-1',
        name: 'read_file',
        args: { file_path: '/src/main.ts' },
        description: 'Read main.ts',
        timestamp: Date.now(),
      });

      cleanup();

      const content = fs.readFileSync(transcriptPath, 'utf-8');
      expect(content).toContain('Tool call: read_file(');
      expect(content).toContain('file_path="/src/main.ts"');
    });

    it('collapses multi-line string args into a single transcript line', () => {
      // Tool args like write_file/edit/shell heredoc carry multi-line
      // payloads. The transcript is read via read_file as a progress
      // window, so a raw newline would split one tool call across many
      // lines and dump file contents into the progress file.
      const emitter = new AgentEventEmitter();
      const transcriptPath = path.join(tempDir, 'agents', 'test.txt');
      const cleanup = attachTranscriptWriter(emitter, transcriptPath);

      emitter.emit(AgentEventType.TOOL_CALL, {
        subagentId: 'test-1',
        round: 1,
        callId: 'call-1',
        name: 'write_file',
        args: {
          file_path: '/src/main.ts',
          content: 'line one\nline two\nline three',
        },
        description: 'Write main.ts',
        timestamp: Date.now(),
      });

      cleanup();

      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const toolCallLines = content
        .split('\n')
        .filter((l) => l.includes('Tool call:'));
      expect(toolCallLines).toHaveLength(1);
      expect(toolCallLines[0]).toContain(
        'content="line one line two line three"',
      );
      expect(toolCallLines[0]).not.toContain('\n');
    });

    it('writes TOOL_RESULT event to transcript file', () => {
      const emitter = new AgentEventEmitter();
      const transcriptPath = path.join(tempDir, 'agents', 'test.txt');
      const cleanup = attachTranscriptWriter(emitter, transcriptPath);

      emitter.emit(AgentEventType.TOOL_RESULT, {
        subagentId: 'test-1',
        round: 1,
        callId: 'call-1',
        name: 'read_file',
        success: true,
        durationMs: 42,
        timestamp: Date.now(),
      });

      cleanup();

      const content = fs.readFileSync(transcriptPath, 'utf-8');
      expect(content).toContain('Tool result: read_file');
      expect(content).toContain('OK');
      expect(content).toContain('42ms');
    });

    it('writes error info in TOOL_RESULT event', () => {
      const emitter = new AgentEventEmitter();
      const transcriptPath = path.join(tempDir, 'agents', 'test.txt');
      const cleanup = attachTranscriptWriter(emitter, transcriptPath);

      emitter.emit(AgentEventType.TOOL_RESULT, {
        subagentId: 'test-1',
        round: 1,
        callId: 'call-1',
        name: 'read_file',
        success: false,
        error: 'File not found',
        durationMs: 10,
        timestamp: Date.now(),
      });

      cleanup();

      const content = fs.readFileSync(transcriptPath, 'utf-8');
      expect(content).toContain('ERROR');
      expect(content).toContain('File not found');
    });

    it('writes ROUND_TEXT event to transcript file', () => {
      const emitter = new AgentEventEmitter();
      const transcriptPath = path.join(tempDir, 'agents', 'test.txt');
      const cleanup = attachTranscriptWriter(emitter, transcriptPath);

      emitter.emit(AgentEventType.ROUND_TEXT, {
        subagentId: 'test-1',
        round: 1,
        text: 'I will now search the codebase.',
        thoughtText: '',
        timestamp: Date.now(),
      });

      cleanup();

      const content = fs.readFileSync(transcriptPath, 'utf-8');
      expect(content).toContain(
        'Agent response: I will now search the codebase.',
      );
    });

    it('writes FINISH event to transcript file', () => {
      const emitter = new AgentEventEmitter();
      const transcriptPath = path.join(tempDir, 'agents', 'test.txt');
      const cleanup = attachTranscriptWriter(emitter, transcriptPath);

      emitter.emit(AgentEventType.FINISH, {
        subagentId: 'test-1',
        terminateReason: 'end_turn',
        rounds: 3,
        totalTokens: 1500,
        totalToolCalls: 5,
        timestamp: Date.now(),
      });

      cleanup();

      const content = fs.readFileSync(transcriptPath, 'utf-8');
      expect(content).toContain('Agent finished: end_turn');
      expect(content).toContain('3 rounds');
      expect(content).toContain('1500 tokens');
      expect(content).toContain('5 tool calls');
    });

    it('writes a throttled TOOL_OUTPUT_UPDATE progress line', () => {
      const emitter = new AgentEventEmitter();
      const transcriptPath = path.join(tempDir, 'agents', 'test.txt');
      const cleanup = attachTranscriptWriter(emitter, transcriptPath);

      // First update for this callId → should be written.
      emitter.emit(AgentEventType.TOOL_OUTPUT_UPDATE, {
        subagentId: 'test-1',
        round: 1,
        callId: 'call-1',
        outputChunk: 'line one\nline two\nline three',
        pid: 42,
        timestamp: 1_000,
      });

      // Same callId within throttle window → must be suppressed.
      emitter.emit(AgentEventType.TOOL_OUTPUT_UPDATE, {
        subagentId: 'test-1',
        round: 1,
        callId: 'call-1',
        outputChunk: 'line one\nline two\nline three\nline four',
        timestamp: 1_500,
      });

      // After throttle window → allowed again.
      emitter.emit(AgentEventType.TOOL_OUTPUT_UPDATE, {
        subagentId: 'test-1',
        round: 1,
        callId: 'call-1',
        outputChunk: 'tailing output burst',
        timestamp: 10_000,
      });

      cleanup();

      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const progressLines = content
        .split('\n')
        .filter((l) => l.includes('Tool progress:'));
      expect(progressLines).toHaveLength(2);
      expect(progressLines[0]).toContain('callId=call-1');
      expect(progressLines[0]).toContain('pid=42');
      expect(progressLines[0]).toContain('line three');
      expect(progressLines[1]).toContain('tailing output burst');
    });

    it('resets throttle tracking when a tool finishes', () => {
      const emitter = new AgentEventEmitter();
      const transcriptPath = path.join(tempDir, 'agents', 'test.txt');
      const cleanup = attachTranscriptWriter(emitter, transcriptPath);

      emitter.emit(AgentEventType.TOOL_OUTPUT_UPDATE, {
        subagentId: 'test-1',
        round: 1,
        callId: 'call-1',
        outputChunk: 'first',
        timestamp: 1_000,
      });
      emitter.emit(AgentEventType.TOOL_RESULT, {
        subagentId: 'test-1',
        round: 1,
        callId: 'call-1',
        name: 'run_shell_command',
        success: true,
        durationMs: 5,
        timestamp: 1_100,
      });
      // New run of the same callId (extremely unlikely in practice, but
      // guards against state leakage between tools) should emit immediately.
      emitter.emit(AgentEventType.TOOL_OUTPUT_UPDATE, {
        subagentId: 'test-1',
        round: 2,
        callId: 'call-1',
        outputChunk: 'second',
        timestamp: 1_200,
      });

      cleanup();

      const content = fs.readFileSync(transcriptPath, 'utf-8');
      expect(content.match(/Tool progress:/g)!.length).toBe(2);
    });

    it('removes listeners on cleanup', () => {
      const emitter = new AgentEventEmitter();
      const transcriptPath = path.join(tempDir, 'agents', 'test.txt');
      const cleanup = attachTranscriptWriter(emitter, transcriptPath);

      cleanup();

      // Emitting after cleanup should not write anything new
      emitter.emit(AgentEventType.START, {
        subagentId: 'test-1',
        name: 'Late Agent',
        model: 'gemini-2.0',
        tools: [],
        timestamp: Date.now(),
      });

      const content = fs.readFileSync(transcriptPath, 'utf-8');
      expect(content).not.toContain('Late Agent');
    });

    it('creates transcript directory if it does not exist', () => {
      const emitter = new AgentEventEmitter();
      const deepPath = path.join(tempDir, 'nested', 'agents', 'test.txt');
      const cleanup = attachTranscriptWriter(emitter, deepPath);

      emitter.emit(AgentEventType.START, {
        subagentId: 'test-1',
        name: 'Nested Agent',
        tools: [],
        timestamp: Date.now(),
      });

      cleanup();

      expect(fs.existsSync(deepPath)).toBe(true);
      const content = fs.readFileSync(deepPath, 'utf-8');
      expect(content).toContain('Agent started: Nested Agent');
    });
  });
});
