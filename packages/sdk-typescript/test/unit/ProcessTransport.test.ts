/**
 * Unit tests for ProcessTransport
 * Tests subprocess lifecycle management and IPC
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ProcessTransport } from '../../src/transport/ProcessTransport.js';
import { AbortError } from '../../src/types/errors.js';
import type { TransportOptions } from '../../src/types/types.js';
import { Readable, Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as childProcess from 'node:child_process';
import * as cliPath from '../../src/utils/cliPath.js';
import * as jsonLines from '../../src/utils/jsonLines.js';

// Mock modules
vi.mock('node:child_process');
vi.mock('../../src/utils/cliPath.js');
vi.mock('../../src/utils/jsonLines.js');

const mockSpawn = vi.mocked(childProcess.spawn);
const mockPrepareSpawnInfo = vi.mocked(cliPath.prepareSpawnInfo);
const mockParseJsonLinesStream = vi.mocked(jsonLines.parseJsonLinesStream);

// Helper function to create a mock child process with optional overrides
function createMockChildProcess(
  overrides: Partial<ChildProcess> = {},
): ChildProcess & EventEmitter {
  const mockStdin = new Writable({
    write: vi.fn((chunk, encoding, callback) => {
      if (typeof callback === 'function') callback();
      return true;
    }),
  });
  const mockWriteFn = vi.fn((chunk, encoding, callback) => {
    if (typeof callback === 'function') callback();
    return true;
  });
  mockStdin.write = mockWriteFn as unknown as typeof mockStdin.write;

  const mockStdout = new Readable({ read: vi.fn() });
  const mockStderr = new Readable({ read: vi.fn() });

  const baseProcess = Object.assign(new EventEmitter(), {
    stdin: mockStdin,
    stdout: mockStdout,
    stderr: mockStderr,
    pid: 12345,
    killed: false,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
    send: vi.fn(),
    disconnect: vi.fn(),
    unref: vi.fn(),
    ref: vi.fn(),
    connected: false,
    stdio: [mockStdin, mockStdout, mockStderr, null, null],
    spawnargs: [],
    spawnfile: 'qwen',
    channel: null,
    ...overrides,
  }) as unknown as ChildProcess & EventEmitter;

  return baseProcess;
}

describe('ProcessTransport', () => {
  let mockChildProcess: ChildProcess & EventEmitter;
  let mockStdin: Writable;
  let mockStdout: Readable;
  let mockStderr: Readable;

  beforeEach(() => {
    vi.clearAllMocks();

    const mockWriteFn = vi.fn((chunk, encoding, callback) => {
      if (typeof callback === 'function') callback();
      return true;
    });

    mockStdin = new Writable({
      write: mockWriteFn,
    });
    // Override write with a spy so we can track calls
    mockStdin.write = mockWriteFn as unknown as typeof mockStdin.write;

    mockStdout = new Readable({ read: vi.fn() });
    mockStderr = new Readable({ read: vi.fn() });

    mockChildProcess = Object.assign(new EventEmitter(), {
      stdin: mockStdin,
      stdout: mockStdout,
      stderr: mockStderr,
      pid: 12345,
      killed: false,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
      send: vi.fn(),
      disconnect: vi.fn(),
      unref: vi.fn(),
      ref: vi.fn(),
      connected: false,
      stdio: [mockStdin, mockStdout, mockStderr, null, null],
      spawnargs: [],
      spawnfile: 'qwen',
      channel: null,
    }) as unknown as ChildProcess & EventEmitter;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Construction and Initialization', () => {
    it('should create transport with required options', () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });
      mockSpawn.mockReturnValue(mockChildProcess);

      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
      };

      const transport = new ProcessTransport(options);

      expect(transport).toBeDefined();
      expect(transport.isReady).toBe(true);
      expect(mockSpawn).toHaveBeenCalledWith(
        'qwen',
        expect.arrayContaining([
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
        ]),
        expect.objectContaining({
          stdio: ['pipe', 'pipe', 'ignore'],
        }),
      );
    });

    it('should build CLI arguments correctly with all options', () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });
      mockSpawn.mockReturnValue(mockChildProcess);

      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
        model: 'qwen-max',
        permissionMode: 'auto-edit',
        maxSessionTurns: 10,
        coreTools: ['read_file', 'write_file'],
        excludeTools: ['web_search'],
        authType: 'api-key',
      };

      new ProcessTransport(options);

      expect(mockSpawn).toHaveBeenCalledWith(
        'qwen',
        expect.arrayContaining([
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          '--model',
          'qwen-max',
          '--approval-mode',
          'auto-edit',
          '--max-session-turns',
          '10',
          '--core-tools',
          'read_file,write_file',
          '--exclude-tools',
          'web_search',
          '--auth-type',
          'api-key',
        ]),
        expect.any(Object),
      );
    });

    it('should throw if aborted before initialization', () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });

      const abortController = new AbortController();
      abortController.abort();

      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
        abortController,
      };

      expect(() => new ProcessTransport(options)).toThrow(AbortError);
      expect(() => new ProcessTransport(options)).toThrow(
        'Transport start aborted',
      );
    });

    it('should use provided AbortController', () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });
      mockSpawn.mockReturnValue(mockChildProcess);

      const abortController = new AbortController();
      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
        abortController,
      };

      new ProcessTransport(options);

      expect(mockSpawn).toHaveBeenCalledWith(
        'qwen',
        expect.any(Array),
        expect.objectContaining({
          signal: abortController.signal,
        }),
      );
    });

    it('should create default AbortController if not provided', () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });
      mockSpawn.mockReturnValue(mockChildProcess);

      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
      };

      new ProcessTransport(options);

      expect(mockSpawn).toHaveBeenCalledWith(
        'qwen',
        expect.any(Array),
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        }),
      );
    });
  });

  describe('Lifecycle Management', () => {
    it('should spawn subprocess during construction', () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });
      mockSpawn.mockReturnValue(mockChildProcess);

      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
      };

      new ProcessTransport(options);

      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    it('should set isReady to true after successful initialization', () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });
      mockSpawn.mockReturnValue(mockChildProcess);

      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
      };

      const transport = new ProcessTransport(options);

      expect(transport.isReady).toBe(true);
    });

    it('should set isReady to false on process error', () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });
      mockSpawn.mockReturnValue(mockChildProcess);

      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
      };

      const transport = new ProcessTransport(options);

      mockChildProcess.emit('error', new Error('Spawn failed'));

      expect(transport.isReady).toBe(false);
      expect(transport.exitError).toBeDefined();
    });

    it('should close subprocess gracefully with SIGTERM', async () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });
      mockSpawn.mockReturnValue(mockChildProcess);

      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
      };

      const transport = new ProcessTransport(options);

      await transport.close();

      expect(mockChildProcess.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('should force kill with SIGKILL after timeout', async () => {
      vi.useFakeTimers();

      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });
      mockSpawn.mockReturnValue(mockChildProcess);

      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
      };

      const transport = new ProcessTransport(options);

      await transport.close();

      vi.advanceTimersByTime(5000);

      expect(mockChildProcess.kill).toHaveBeenCalledWith('SIGKILL');

      vi.useRealTimers();
    });

    it('should be idempotent when calling close() multiple times', async () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });
      mockSpawn.mockReturnValue(mockChildProcess);

      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
      };

      const transport = new ProcessTransport(options);

      await transport.close();
      await transport.close();
      await transport.close();

      expect(mockChildProcess.kill).toHaveBeenCalledTimes(3);
    });

    it('should wait for process exit in waitForExit()', async () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });
      mockSpawn.mockReturnValue(mockChildProcess);

      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
      };

      const transport = new ProcessTransport(options);

      const waitPromise = transport.waitForExit();

      mockChildProcess.emit('close', 0, null);

      await expect(waitPromise).resolves.toBeUndefined();
    });

    it('should reject waitForExit() on non-zero exit code', async () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });
      mockSpawn.mockReturnValue(mockChildProcess);

      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
      };

      const transport = new ProcessTransport(options);

      const waitPromise = transport.waitForExit();

      mockChildProcess.emit('close', 1, null);

      await expect(waitPromise).rejects.toThrow(
        'CLI process exited with code 1',
      );
    });

    it('should reject waitForExit() on signal termination', async () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });
      mockSpawn.mockReturnValue(mockChildProcess);

      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
      };

      const transport = new ProcessTransport(options);

      const waitPromise = transport.waitForExit();

      mockChildProcess.emit('close', null, 'SIGTERM');

      await expect(waitPromise).rejects.toThrow(
        'CLI process terminated by signal SIGTERM',
      );
    });

    it('should reject waitForExit() with AbortError when aborted', async () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });
      mockSpawn.mockReturnValue(mockChildProcess);

      const abortController = new AbortController();
      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
        abortController,
      };

      const transport = new ProcessTransport(options);

      const waitPromise = transport.waitForExit();

      abortController.abort();
      mockChildProcess.emit('close', 0, null);

      await expect(waitPromise).rejects.toThrow(AbortError);
    });
  });

  describe('Message Reading', () => {
    it('should read JSON Lines from stdout', async () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });
      mockSpawn.mockReturnValue(mockChildProcess);

      const mockMessages = [
        { type: 'message', content: 'test1' },
        { type: 'message', content: 'test2' },
      ];

      mockParseJsonLinesStream.mockImplementation(async function* () {
        for (const msg of mockMessages) {
          yield msg;
        }
      });

      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
      };

      const transport = new ProcessTransport(options);

      const messages: unknown[] = [];
      const readPromise = (async () => {
        for await (const message of transport.readMessages()) {
          messages.push(message);
        }
      })();

      // Give time for the async generator to start and yield messages
      await new Promise((resolve) => setTimeout(resolve, 10));

      mockChildProcess.emit('close', 0, null);

      await readPromise;

      expect(messages).toEqual(mockMessages);
    }, 5000); // Set a reasonable timeout

    it('should throw if reading from transport without stdout', async () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });

      const processWithoutStdout = createMockChildProcess({ stdout: null });
      mockSpawn.mockReturnValue(processWithoutStdout);

      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
      };

      const transport = new ProcessTransport(options);

      const generator = transport.readMessages();

      await expect(generator.next()).rejects.toThrow(
        'Cannot read messages: process not started',
      );
    });
  });

  describe('Message Writing', () => {
    it('should write message to stdin', () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });
      mockSpawn.mockReturnValue(mockChildProcess);

      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
      };

      const transport = new ProcessTransport(options);

      const message = '{"type":"test","data":"hello"}\n';
      transport.write(message);

      expect(mockStdin.write).toHaveBeenCalledWith(message);
    });

    it('should throw if writing before transport is ready', () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });
      mockSpawn.mockReturnValue(mockChildProcess);

      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
      };

      const transport = new ProcessTransport(options);

      mockChildProcess.emit('error', new Error('Process error'));

      expect(() => transport.write('test')).toThrow(
        'Transport not ready for writing',
      );
    });

    it('should throw if writing to closed transport', async () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });
      mockSpawn.mockReturnValue(mockChildProcess);

      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
      };

      const transport = new ProcessTransport(options);

      await transport.close();

      // After close(), isReady is false, so we get "Transport not ready" error first
      expect(() => transport.write('test')).toThrow(
        'Transport not ready for writing',
      );
    });

    it('should throw if writing when aborted', () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });
      mockSpawn.mockReturnValue(mockChildProcess);

      const abortController = new AbortController();
      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
        abortController,
      };

      const transport = new ProcessTransport(options);

      abortController.abort();

      expect(() => transport.write('test')).toThrow(AbortError);
      expect(() => transport.write('test')).toThrow(
        'Cannot write: operation aborted',
      );
    });

    it('should throw if writing to ended stream', () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });
      mockSpawn.mockReturnValue(mockChildProcess);

      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
      };

      const transport = new ProcessTransport(options);

      mockStdin.end();

      expect(() => transport.write('test')).toThrow(
        'Cannot write to ended stream',
      );
    });

    it('should throw if writing to terminated process', () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });

      const terminatedProcess = createMockChildProcess({ exitCode: 1 });
      mockSpawn.mockReturnValue(terminatedProcess);

      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
      };

      const transport = new ProcessTransport(options);

      expect(() => transport.write('test')).toThrow(
        'Cannot write to terminated process',
      );
    });

    it('should throw if process has exit error', () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });
      mockSpawn.mockReturnValue(mockChildProcess);

      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
      };

      const transport = new ProcessTransport(options);

      mockChildProcess.emit('close', 1, null);

      // After process closes with error, isReady is false, so we get "Transport not ready" error first
      expect(() => transport.write('test')).toThrow(
        'Transport not ready for writing',
      );
    });
  });

  describe('Error Handling', () => {
    it('should set exitError on process error', () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });
      mockSpawn.mockReturnValue(mockChildProcess);

      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
      };

      const transport = new ProcessTransport(options);

      const error = new Error('Process error');
      mockChildProcess.emit('error', error);

      expect(transport.exitError).toBeDefined();
      expect(transport.exitError?.message).toContain('CLI process error');
    });

    it('should set exitError on process close with non-zero code', () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });
      mockSpawn.mockReturnValue(mockChildProcess);

      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
      };

      const transport = new ProcessTransport(options);

      mockChildProcess.emit('close', 1, null);

      expect(transport.exitError).toBeDefined();
      expect(transport.exitError?.message).toBe(
        'CLI process exited with code 1',
      );
    });

    it('should set exitError on process close with signal', () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });
      mockSpawn.mockReturnValue(mockChildProcess);

      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
      };

      const transport = new ProcessTransport(options);

      mockChildProcess.emit('close', null, 'SIGKILL');

      expect(transport.exitError).toBeDefined();
      expect(transport.exitError?.message).toBe(
        'CLI process terminated by signal SIGKILL',
      );
    });

    it('should set AbortError when process aborted', () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });
      mockSpawn.mockReturnValue(mockChildProcess);

      const abortController = new AbortController();
      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
        abortController,
      };

      const transport = new ProcessTransport(options);

      abortController.abort();
      mockChildProcess.emit('error', new Error('Aborted'));

      expect(transport.exitError).toBeInstanceOf(AbortError);
      expect(transport.exitError?.message).toBe('CLI process aborted by user');
    });

    it('should not set exitError on clean exit', () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });
      mockSpawn.mockReturnValue(mockChildProcess);

      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
      };

      const transport = new ProcessTransport(options);

      mockChildProcess.emit('close', 0, null);

      expect(transport.exitError).toBeNull();
    });
  });

  describe('Resource Cleanup', () => {
    it('should register cleanup on parent process exit', () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });
      mockSpawn.mockReturnValue(mockChildProcess);

      const processOnSpy = vi.spyOn(process, 'on');

      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
      };

      new ProcessTransport(options);

      expect(processOnSpy).toHaveBeenCalledWith('exit', expect.any(Function));

      processOnSpy.mockRestore();
    });

    it('should remove event listeners on close', async () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });
      mockSpawn.mockReturnValue(mockChildProcess);

      const processOffSpy = vi.spyOn(process, 'off');

      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
      };

      const transport = new ProcessTransport(options);

      await transport.close();

      expect(processOffSpy).toHaveBeenCalledWith('exit', expect.any(Function));

      processOffSpy.mockRestore();
    });

    it('should register abort listener', () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });
      mockSpawn.mockReturnValue(mockChildProcess);

      const abortController = new AbortController();
      const addEventListenerSpy = vi.spyOn(
        abortController.signal,
        'addEventListener',
      );

      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
        abortController,
      };

      new ProcessTransport(options);

      expect(addEventListenerSpy).toHaveBeenCalledWith(
        'abort',
        expect.any(Function),
      );

      addEventListenerSpy.mockRestore();
    });

    it('should remove abort listener on close', async () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });
      mockSpawn.mockReturnValue(mockChildProcess);

      const abortController = new AbortController();
      const removeEventListenerSpy = vi.spyOn(
        abortController.signal,
        'removeEventListener',
      );

      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
        abortController,
      };

      const transport = new ProcessTransport(options);

      await transport.close();

      expect(removeEventListenerSpy).toHaveBeenCalledWith(
        'abort',
        expect.any(Function),
      );

      removeEventListenerSpy.mockRestore();
    });

    it('should end stdin on close', async () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });
      mockSpawn.mockReturnValue(mockChildProcess);

      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
      };

      const transport = new ProcessTransport(options);

      const endSpy = vi.spyOn(mockStdin, 'end');

      await transport.close();

      expect(endSpy).toHaveBeenCalled();
    });
  });

  describe('Working Directory', () => {
    it('should spawn process in specified cwd', () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });
      mockSpawn.mockReturnValue(mockChildProcess);

      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
        cwd: '/custom/path',
      };

      new ProcessTransport(options);

      expect(mockSpawn).toHaveBeenCalledWith(
        'qwen',
        expect.any(Array),
        expect.objectContaining({
          cwd: '/custom/path',
        }),
      );
    });

    it('should default to process.cwd() if not specified', () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });
      mockSpawn.mockReturnValue(mockChildProcess);

      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
      };

      new ProcessTransport(options);

      expect(mockSpawn).toHaveBeenCalledWith(
        'qwen',
        expect.any(Array),
        expect.objectContaining({
          cwd: process.cwd(),
        }),
      );
    });
  });

  describe('Environment Variables', () => {
    it('should pass environment variables to subprocess', () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });
      mockSpawn.mockReturnValue(mockChildProcess);

      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
        env: {
          CUSTOM_VAR: 'custom_value',
        },
      };

      new ProcessTransport(options);

      expect(mockSpawn).toHaveBeenCalledWith(
        'qwen',
        expect.any(Array),
        expect.objectContaining({
          env: expect.objectContaining({
            CUSTOM_VAR: 'custom_value',
          }),
        }),
      );
    });

    it('should inherit parent env by default', () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });
      mockSpawn.mockReturnValue(mockChildProcess);

      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
      };

      new ProcessTransport(options);

      expect(mockSpawn).toHaveBeenCalledWith(
        'qwen',
        expect.any(Array),
        expect.objectContaining({
          env: expect.objectContaining(process.env),
        }),
      );
    });

    it('should merge custom env with parent env', () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });
      mockSpawn.mockReturnValue(mockChildProcess);

      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
        env: {
          CUSTOM_VAR: 'custom_value',
        },
      };

      new ProcessTransport(options);

      expect(mockSpawn).toHaveBeenCalledWith(
        'qwen',
        expect.any(Array),
        expect.objectContaining({
          env: expect.objectContaining({
            ...process.env,
            CUSTOM_VAR: 'custom_value',
          }),
        }),
      );
    });
  });

  describe('Debug and Stderr Handling', () => {
    it('should pipe stderr when debug is true', () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });
      mockSpawn.mockReturnValue(mockChildProcess);

      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
        debug: true,
      };

      new ProcessTransport(options);

      expect(mockSpawn).toHaveBeenCalledWith(
        'qwen',
        expect.any(Array),
        expect.objectContaining({
          stdio: ['pipe', 'pipe', 'pipe'],
        }),
      );
    });

    it('should pipe stderr when stderr callback is provided', () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });
      mockSpawn.mockReturnValue(mockChildProcess);

      const stderrCallback = vi.fn();
      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
        stderr: stderrCallback,
      };

      new ProcessTransport(options);

      expect(mockSpawn).toHaveBeenCalledWith(
        'qwen',
        expect.any(Array),
        expect.objectContaining({
          stdio: ['pipe', 'pipe', 'pipe'],
        }),
      );
    });

    it('should ignore stderr when debug is false and no callback', () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });
      mockSpawn.mockReturnValue(mockChildProcess);

      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
        debug: false,
      };

      new ProcessTransport(options);

      expect(mockSpawn).toHaveBeenCalledWith(
        'qwen',
        expect.any(Array),
        expect.objectContaining({
          stdio: ['pipe', 'pipe', 'ignore'],
        }),
      );
    });

    it('should call stderr callback when data is received', () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });
      mockSpawn.mockReturnValue(mockChildProcess);

      const stderrCallback = vi.fn();
      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
        stderr: stderrCallback,
        debug: true, // Enable debug to ensure stderr data is logged
      };

      new ProcessTransport(options);

      // Clear previous calls from logger.info during initialization
      stderrCallback.mockClear();

      mockStderr.emit('data', Buffer.from('error message'));

      // The stderr data is passed through logger.debug, which formats it
      // So we check that the callback was called with a message containing 'error message'
      expect(stderrCallback).toHaveBeenCalled();
      expect(stderrCallback.mock.calls[0][0]).toContain('error message');
    });
  });

  describe('Stream Access', () => {
    it('should provide access to stdin via getInputStream()', () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });
      mockSpawn.mockReturnValue(mockChildProcess);

      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
      };

      const transport = new ProcessTransport(options);

      expect(transport.getInputStream()).toBe(mockStdin);
    });

    it('should provide access to stdout via getOutputStream()', () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });
      mockSpawn.mockReturnValue(mockChildProcess);

      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
      };

      const transport = new ProcessTransport(options);

      expect(transport.getOutputStream()).toBe(mockStdout);
    });

    it('should allow ending input via endInput()', () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });
      mockSpawn.mockReturnValue(mockChildProcess);

      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
      };

      const transport = new ProcessTransport(options);

      const endSpy = vi.spyOn(mockStdin, 'end');

      transport.endInput();

      expect(endSpy).toHaveBeenCalled();
    });
  });

  describe('Edge Cases', () => {
    it('should handle process that exits immediately', () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });

      const immediateExitProcess = createMockChildProcess({ exitCode: 0 });
      mockSpawn.mockReturnValue(immediateExitProcess);

      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
      };

      const transport = new ProcessTransport(options);

      expect(transport.isReady).toBe(true);
    });

    it('should handle waitForExit() when process already exited', async () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });

      const exitedProcess = createMockChildProcess({ exitCode: 0 });
      mockSpawn.mockReturnValue(exitedProcess);

      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
      };

      const transport = new ProcessTransport(options);

      await expect(transport.waitForExit()).resolves.toBeUndefined();
    });

    it('should handle close() when process is already killed', async () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });

      const killedProcess = createMockChildProcess({ killed: true });
      mockSpawn.mockReturnValue(killedProcess);

      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
      };

      const transport = new ProcessTransport(options);

      await expect(transport.close()).resolves.toBeUndefined();
    });

    it('should handle endInput() when stdin is null', () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });

      const processWithoutStdin = createMockChildProcess({ stdin: null });
      mockSpawn.mockReturnValue(processWithoutStdin);

      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
      };

      const transport = new ProcessTransport(options);

      expect(() => transport.endInput()).not.toThrow();
    });

    it('should return undefined for getInputStream() when stdin is null', () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });

      const processWithoutStdin = createMockChildProcess({ stdin: null });
      mockSpawn.mockReturnValue(processWithoutStdin);

      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
      };

      const transport = new ProcessTransport(options);

      expect(transport.getInputStream()).toBeUndefined();
    });

    it('should return undefined for getOutputStream() when stdout is null', () => {
      mockPrepareSpawnInfo.mockReturnValue({
        command: 'qwen',
        args: [],
        type: 'native',
        originalInput: 'qwen',
      });

      const processWithoutStdout = createMockChildProcess({ stdout: null });
      mockSpawn.mockReturnValue(processWithoutStdout);

      const options: TransportOptions = {
        pathToQwenExecutable: 'qwen',
      };

      const transport = new ProcessTransport(options);

      expect(transport.getOutputStream()).toBeUndefined();
    });
  });
});
