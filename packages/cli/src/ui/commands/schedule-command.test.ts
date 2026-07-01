import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scheduleCommand } from './schedule-command.js';
import {
  deleteScheduleTask,
} from '@qwen-code/qwen-code-core';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import type { MessageActionReturn } from './types.js';

// Mock the core module
vi.mock('@qwen-code/qwen-code-core', async () => {
  const actual = await vi.importActual<typeof import('@qwen-code/qwen-code-core')>('@qwen-code/qwen-code-core');
  return {
    ...actual,
    deleteScheduleTask: vi.fn(),
  };
});

function createMockContext(args: string = '') {
  return createMockCommandContext({
    invocation: {
      raw: `/schedule ${args}`.trim(),
      name: 'schedule',
      args,
    },
  });
}

describe('scheduleCommand', () => {
  let tmpDir: string;
  let qwenDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sched-cmd-test-'));
    qwenDir = path.join(tmpDir, '.qwen');
    process.env['QWEN_HOME'] = qwenDir;
    await fs.mkdir(qwenDir, { recursive: true });
    vi.clearAllMocks();
  });

  describe('name and description', () => {
    it('has correct name', () => {
      expect(scheduleCommand.name).toBe('schedule');
    });

    it('has a description', () => {
      expect(scheduleCommand.description).toBeTruthy();
    });
  });

  describe('/schedule (no args)', () => {
    it('shows help text when no tasks exist', async () => {
      const context = createMockContext('');
      const result = await scheduleCommand.action!(context, '');
      expect(result).toBeDefined();
      expect((result as MessageActionReturn).type).toBe('message');
    });
  });

  describe('/schedule list', () => {
    it('returns empty message when no tasks', async () => {
      const context = createMockContext('list');
      const result = await scheduleCommand.action!(context, 'list');
      expect(result).toBeDefined();
      const msg = result as MessageActionReturn;
      expect(msg.type).toBe('message');
      expect(msg.content).toContain('No scheduled tasks');
    });
  });

  describe('/schedule daemon status', () => {
    it('returns daemon status message', async () => {
      const context = createMockContext('daemon status');
      const result = await scheduleCommand.action!(context, 'daemon status');
      expect(result).toBeDefined();
      expect((result as MessageActionReturn).type).toBe('message');
    });
  });

  describe('/schedule delete <id>', () => {
    it('returns error when task not found', async () => {
      vi.mocked(deleteScheduleTask).mockResolvedValue(false);
      const context = createMockContext('delete nonexistent');
      const result = await scheduleCommand.action!(context, 'delete nonexistent');
      expect(result).toBeDefined();
      const msg = result as MessageActionReturn;
      expect(msg.type).toBe('message');
      expect(msg.messageType).toBe('error');
      expect(msg.content).toContain('not found');
    });

    it('returns success when task deleted', async () => {
      vi.mocked(deleteScheduleTask).mockResolvedValue(true);
      const context = createMockContext('delete abc123');
      const result = await scheduleCommand.action!(context, 'delete abc123');
      expect(result).toBeDefined();
      const msg = result as MessageActionReturn;
      expect(msg.type).toBe('message');
      expect(msg.messageType).toBe('info');
      expect(msg.content).toContain('deleted');
    });

    it('returns help when no id provided', async () => {
      const context = createMockContext('delete');
      const result = await scheduleCommand.action!(context, 'delete');
      expect(result).toBeDefined();
      expect((result as MessageActionReturn).type).toBe('message');
      // Falls through to default help text since 'delete' doesn't match 'delete '
    });
  });

  describe('/schedule logs <id>', () => {
    it('returns error when task not found', async () => {
      const context = createMockContext('logs nonexistent');
      const result = await scheduleCommand.action!(context, 'logs nonexistent');
      expect(result).toBeDefined();
      const msg = result as MessageActionReturn;
      expect(msg.type).toBe('message');
      expect(msg.messageType).toBe('error');
    });

    it('returns help when no id provided', async () => {
      const context = createMockContext('logs');
      const result = await scheduleCommand.action!(context, 'logs');
      expect(result).toBeDefined();
      expect((result as MessageActionReturn).type).toBe('message');
      // Falls through to default help text since 'logs' doesn't match 'logs '
    });
  });

  describe('/schedule run <id>', () => {
    it('points to CLI for run', async () => {
      const context = createMockContext('run abc123');
      const result = await scheduleCommand.action!(context, 'run abc123');
      expect(result).toBeDefined();
      const msg = result as MessageActionReturn;
      expect(msg.type).toBe('message');
      expect(msg.content).toContain('shell');
    });
  });

  describe('/schedule daemon start', () => {
    it('points to CLI for daemon start', async () => {
      const context = createMockContext('daemon start');
      const result = await scheduleCommand.action!(context, 'daemon start');
      expect(result).toBeDefined();
      const msg = result as MessageActionReturn;
      expect(msg.type).toBe('message');
      expect(msg.content).toContain('shell');
    });
  });

  describe('/schedule daemon stop', () => {
    it('points to CLI for daemon stop', async () => {
      const context = createMockContext('daemon stop');
      const result = await scheduleCommand.action!(context, 'daemon stop');
      expect(result).toBeDefined();
      const msg = result as MessageActionReturn;
      expect(msg.type).toBe('message');
      expect(msg.content).toContain('shell');
    });
  });

  describe('unknown subcommand', () => {
    it('returns help text', async () => {
      const context = createMockContext('unknown');
      const result = await scheduleCommand.action!(context, 'unknown');
      expect(result).toBeDefined();
      expect((result as MessageActionReturn).type).toBe('message');
    });
  });
});
