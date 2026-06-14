/**
 * Tests for BaseEventAdapter
 *
 * Uses a concrete TestEventAdapter to verify shared state management:
 * - Block reason tracking
 * - Read command classification
 * - Command output accumulation
 * - Turn lifecycle
 * - Event construction helpers
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { BaseEventAdapter } from '../backend/base-event-adapter.ts';
import type { AgentEvent } from '@craft-agent/core/types';

/**
 * Concrete test implementation of BaseEventAdapter.
 * Exposes protected methods for testing.
 */
class TestEventAdapter extends BaseEventAdapter {
  public turnStartCount = 0;

  constructor() {
    super('test-adapter');
  }

  protected onTurnStart(): void {
    this.turnStartCount++;
  }

  // Expose protected methods for testing
  public testConsumeBlockReason(...keys: string[]): string | undefined {
    return this.consumeBlockReason(...keys);
  }

  public testClassifyReadCommand(id: string, command: string) {
    return this.classifyReadCommand(id, command);
  }

  public testConsumeReadCommand(id: string) {
    return this.consumeReadCommand(id);
  }

  public testConsumeOutput(id: string) {
    return this.consumeOutput(id);
  }

  public testCreateToolStart(
    id: string,
    toolName: string,
    input: Record<string, unknown>,
    intent?: string,
    displayName?: string,
    parentToolUseId?: string,
  ): AgentEvent {
    return this.createToolStart(id, toolName, input, intent, displayName, parentToolUseId);
  }

  public testCreateToolResult(
    id: string,
    toolName: string,
    result: string,
    isError: boolean,
    parentToolUseId?: string,
  ): AgentEvent {
    return this.createToolResult(id, toolName, result, isError, parentToolUseId);
  }

  public testCreateReadToolStart(
    id: string,
    readInfo: { filePath: string; originalCommand: string; startLine?: number; endLine?: number },
    intent?: string,
    displayName?: string,
    parentToolUseId?: string,
  ): AgentEvent {
    return this.createReadToolStart(id, readInfo, intent, displayName, parentToolUseId);
  }
}

describe('BaseEventAdapter', () => {
  let adapter: TestEventAdapter;

  beforeEach(() => {
    adapter = new TestEventAdapter();
  });

  describe('Turn Lifecycle', () => {
    it('should call onTurnStart on startTurn', () => {
      adapter.startTurn();
      expect(adapter.turnStartCount).toBe(1);
    });

    it('should increment turnIndex on each startTurn', () => {
      adapter.startTurn();
      adapter.startTurn();
      adapter.startTurn();
      expect(adapter.turnStartCount).toBe(3);
    });

    it('should clear state on startTurn', () => {
      // Set up some state
      adapter.setBlockReason('tool-1', 'blocked');
      adapter.accumulateOutput('tool-1', 'output');

      // Start new turn — should clear everything
      adapter.startTurn();

      expect(adapter.testConsumeBlockReason('tool-1')).toBeUndefined();
      expect(adapter.testConsumeOutput('tool-1')).toBeUndefined();
    });

    it('should track turnId when provided', () => {
      adapter.startTurn('turn-123');
      const event = adapter.testCreateToolStart('t1', 'Read', {});
      expect(event).toHaveProperty('turnId', 'turn-123');
    });

    it('should have no turnId when not provided', () => {
      adapter.startTurn();
      const event = adapter.testCreateToolStart('t1', 'Read', {});
      expect(event).toHaveProperty('turnId', undefined);
    });
  });

  describe('Block Reason Tracking', () => {
    it('should store and consume block reasons', () => {
      adapter.setBlockReason('tool-1', 'Permission denied');
      expect(adapter.testConsumeBlockReason('tool-1')).toBe('Permission denied');
    });

    it('should delete block reason after consume', () => {
      adapter.setBlockReason('tool-1', 'blocked');
      adapter.testConsumeBlockReason('tool-1');
      expect(adapter.testConsumeBlockReason('tool-1')).toBeUndefined();
    });

    it('should return undefined for unknown keys', () => {
      expect(adapter.testConsumeBlockReason('nonexistent')).toBeUndefined();
    });

    it('should try multiple keys and return first match', () => {
      adapter.setBlockReason('alt-key', 'found via alt');
      expect(adapter.testConsumeBlockReason('missing', 'alt-key')).toBe('found via alt');
    });
  });

  describe('Read Command Classification', () => {
    it('should classify cat commands as reads', () => {
      const info = adapter.testClassifyReadCommand('t1', 'cat /path/to/file.ts');
      expect(info).not.toBeNull();
      expect(info!.filePath).toBe('/path/to/file.ts');
    });

    it('should not classify non-read commands', () => {
      const info = adapter.testClassifyReadCommand('t1', 'ls -la');
      expect(info).toBeNull();
    });

    it('should consume read command after classification', () => {
      adapter.testClassifyReadCommand('t1', 'cat /path/to/file.ts');
      const consumed = adapter.testConsumeReadCommand('t1');
      expect(consumed).not.toBeUndefined();
      expect(consumed!.filePath).toBe('/path/to/file.ts');

      // Second consume should return undefined
      expect(adapter.testConsumeReadCommand('t1')).toBeUndefined();
    });
  });

  describe('Command Output Accumulation', () => {
    it('should accumulate streaming output', () => {
      adapter.accumulateOutput('t1', 'Hello');
      adapter.accumulateOutput('t1', ' World');
      expect(adapter.testConsumeOutput('t1')).toBe('Hello World');
    });

    it('should delete output after consume', () => {
      adapter.accumulateOutput('t1', 'data');
      adapter.testConsumeOutput('t1');
      expect(adapter.testConsumeOutput('t1')).toBeUndefined();
    });

    it('should track output per tool ID independently', () => {
      adapter.accumulateOutput('t1', 'output-1');
      adapter.accumulateOutput('t2', 'output-2');
      expect(adapter.testConsumeOutput('t1')).toBe('output-1');
      expect(adapter.testConsumeOutput('t2')).toBe('output-2');
    });
  });

  describe('Event Construction', () => {
    it('should create tool_start events', () => {
      adapter.startTurn('turn-1');
      const event = adapter.testCreateToolStart(
        'tool-123',
        'Bash',
        { command: 'ls' },
        'List files',
        'List Directory',
        'parent-456',
      );

      expect(event).toEqual({
        type: 'tool_start',
        toolName: 'Bash',
        toolUseId: 'tool-123',
        input: { command: 'ls' },
        intent: 'List files',
        displayName: 'List Directory',
        turnId: 'turn-1',
        parentToolUseId: 'parent-456',
      });
    });

    it('should create tool_result events', () => {
      adapter.startTurn('turn-1');
      const event = adapter.testCreateToolResult(
        'tool-123',
        'Bash',
        'file1.ts\nfile2.ts',
        false,
        'parent-456',
      );

      expect(event).toEqual({
        type: 'tool_result',
        toolUseId: 'tool-123',
        toolName: 'Bash',
        result: 'file1.ts\nfile2.ts',
        isError: false,
        turnId: 'turn-1',
        parentToolUseId: 'parent-456',
      });
    });

    it('should create Read-classified tool_start events', () => {
      adapter.startTurn();
      const event = adapter.testCreateReadToolStart(
        'tool-123',
        {
          filePath: '/src/index.ts',
          originalCommand: 'cat /src/index.ts',
          startLine: 10,
          endLine: 20,
        },
      );

      expect(event).toMatchObject({
        type: 'tool_start',
        toolName: 'Read',
        toolUseId: 'tool-123',
        input: {
          file_path: '/src/index.ts',
          offset: 10,
          limit: 11, // endLine - startLine + 1
          _command: 'cat /src/index.ts',
        },
        displayName: 'Read File',
      });
    });

    it('should use custom displayName for Read tool start', () => {
      adapter.startTurn();
      const event = adapter.testCreateReadToolStart(
        'tool-123',
        { filePath: '/src/index.ts', originalCommand: 'head -20 /src/index.ts' },
        undefined,
        'Read Source',
      );

      expect(event).toHaveProperty('displayName', 'Read Source');
    });
  });
});
