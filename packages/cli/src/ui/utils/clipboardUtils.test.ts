/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

// Use vi.hoisted to define mock functions before vi.mock is hoisted
const { mockSpawn, mockExecSync, clipboardMockState, mockDebugLogger } =
  vi.hoisted(() => ({
    mockSpawn: vi.fn(),
    mockExecSync: vi.fn(),
    clipboardMockState: {
      failLoad: false,
      loadDelayMs: 0,
      // The module resolves, but using it still throws - the shape of a native
      // addon built against a different Node ABI.
      throwOnConstruct: false,
      throwOnHasFormat: false,
    },
    // clipboardUtils records every failure it diagnoses through
    // createDebugLogger, which is a no-op without an active debug session, so
    // the diagnostics are only assertable through a spy.
    mockDebugLogger: {
      isEnabled: vi.fn(() => true),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  }));

// Mock @teddyzhu/clipboard
vi.mock('@teddyzhu/clipboard', async () => {
  if (clipboardMockState.loadDelayMs > 0) {
    await new Promise((resolve) =>
      setTimeout(resolve, clipboardMockState.loadDelayMs),
    );
  }
  if (clipboardMockState.failLoad) {
    throw new Error('native clipboard module missing');
  }
  // Both exports share one implementation so the throw flags apply no matter
  // which shape the caller destructures. The flags are read per call, not per
  // factory evaluation.
  const ClipboardManager = vi.fn().mockImplementation(() => {
    if (clipboardMockState.throwOnConstruct) {
      throw new Error('native clipboard addon ABI mismatch');
    }
    return {
      hasFormat: vi.fn().mockImplementation(() => {
        if (clipboardMockState.throwOnHasFormat) {
          throw new Error('native clipboard addon ABI mismatch');
        }
        return false;
      }),
      getImageData: vi.fn().mockReturnValue({ data: null }),
    };
  });
  return {
    default: { ClipboardManager },
    ClipboardManager,
  };
});

// Mock node:child_process
vi.mock('node:child_process', () => ({
  default: {
    spawn: mockSpawn,
    execSync: mockExecSync,
    exec: vi.fn(),
    execFile: vi.fn(),
  },
  spawn: mockSpawn,
  execSync: mockExecSync,
  exec: vi.fn(),
  execFile: vi.fn(),
}));

// Swap only the logger factory; every other core export is passed through, so
// the module graph under test keeps resolving exactly as it does in CI.
vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    createDebugLogger: () => mockDebugLogger,
  };
});

// We intentionally do NOT mock node:fs root to avoid breaking indirect
// dependencies (e.g. debugLogger, symlink) that import from 'node:fs'.
// vitest's mock system for built-in modules cannot simultaneously:
// 1. Override createWriteStream for save success path tests
// 2. Preserve { promises as fs } from 'node:fs' for indirect deps
// The success path test is documented below; error paths are fully covered.

// Mock node:fs/promises using importOriginal to preserve module structure
// for indirect dependencies (e.g. debugLogger, chatCompressionService).
// stat/mkdir/unlink are mocked to return default values for I/O-free testing.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    stat: vi.fn().mockResolvedValue({ size: 100 }),
    mkdir: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
    writeFile: vi.fn().mockResolvedValue(undefined),
    appendFile: vi.fn().mockResolvedValue(undefined),
    access: vi.fn().mockResolvedValue(undefined),
    copyFile: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
    rmdir: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(Buffer.from('')),
  };
});

// We intentionally do NOT mock node:fs root beyond createWriteStream, to avoid
// cross-test pollution with other files like startupProfiler.test.ts
// that use vi.mock('node:fs') (auto-mock).
/**
 * Create a mock child process that emits stdout data and close event.
 */
function createMockChild(
  stdoutData: string,
  exitCode: number = 0,
  stderrData: string = '',
) {
  const stdout = new EventEmitter() as EventEmitter & {
    pipe: (dest: EventEmitter) => EventEmitter;
  };
  stdout.pipe = (dest: EventEmitter) => {
    stdout.on('data', (data: Buffer) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (dest as any).write?.(data);
    });
    return dest;
  };
  // The production code pipes fd 2 as well, so every mock child has to expose
  // a stderr stream. Without it the handler attachment throws inside the
  // promise executor and the assertions would pass for the wrong reason.
  const stderr = new EventEmitter();
  const child = new EventEmitter() as EventEmitter & {
    stdout: typeof stdout;
    stderr: typeof stderr;
    kill: ReturnType<typeof vi.fn>;
    killed: boolean;
  };
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = vi.fn();
  child.killed = false;

  process.nextTick(() => {
    stdout.emit('data', Buffer.from(stdoutData));
    if (stderrData) {
      stderr.emit('data', Buffer.from(stderrData));
    }
    child.emit('close', exitCode);
  });

  return child;
}

/**
 * Create a mock child process that emits stdout data as separate byte chunks.
 * A pipe delivers data at arbitrary byte offsets, so a payload split inside a
 * multi-byte UTF-8 sequence is the case this exists for.
 */
function createChunkedMockChild(chunks: Buffer[], exitCode: number = 0) {
  const stdout = new EventEmitter() as EventEmitter & {
    pipe: (dest: EventEmitter) => EventEmitter;
  };
  stdout.pipe = (dest: EventEmitter) => dest;
  const stderr = new EventEmitter();
  const child = new EventEmitter() as EventEmitter & {
    stdout: typeof stdout;
    stderr: typeof stderr;
    kill: ReturnType<typeof vi.fn>;
    killed: boolean;
  };
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = vi.fn();
  child.killed = false;

  process.nextTick(() => {
    for (const chunk of chunks) {
      stdout.emit('data', chunk);
    }
    child.emit('close', exitCode);
  });

  return child;
}

/**
 * Create a mock child process that fails to spawn.
 *
 * Emits `close` after `error`, because that is what Node does: a child that
 * fails to spawn still reports `close` with the negated errno (measured on
 * Node v22/v24: `error:ENOENT` then `close:code=-2,sig=null`). A fixture that
 * stopped at `error` would hide every defect that lives in the second event,
 * which is where the double-settle was. The nested `process.nextTick` keeps
 * `close` the later event it is in production while still draining before the
 * awaiting test resumes (Node empties the nextTick queue before microtasks).
 */
function createSpawnErrorChild() {
  const stdout = new EventEmitter() as EventEmitter & {
    pipe: (dest: EventEmitter) => EventEmitter;
  };
  stdout.pipe = (dest: EventEmitter) => dest;
  const stderr = new EventEmitter();
  const child = new EventEmitter() as EventEmitter & {
    stdout: typeof stdout;
    stderr: typeof stderr;
    kill: ReturnType<typeof vi.fn>;
    killed: boolean;
  };
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = vi.fn();
  child.killed = false;

  process.nextTick(() => {
    child.emit('error', new Error('spawn ENOENT'));
    process.nextTick(() => {
      child.emit('close', -2, null);
    });
  });

  return child;
}

/**
 * Create a mock child process that never completes, driving the timeout path.
 *
 * `kill` answers with `close(null, 'SIGTERM')`, which is what a real
 * `child.kill()` produces and what the production timeout path therefore
 * always sees after it has already notified. An inert `vi.fn()` left that
 * second `close` unemitted, so the timeout path's double-settle was invisible.
 */
function createHangingChild() {
  const stdout = new EventEmitter() as EventEmitter & {
    pipe: (dest: EventEmitter) => EventEmitter;
  };
  stdout.pipe = (dest: EventEmitter) => dest;
  const stderr = new EventEmitter();
  const child = new EventEmitter() as EventEmitter & {
    stdout: typeof stdout;
    stderr: typeof stderr;
    kill: ReturnType<typeof vi.fn>;
    killed: boolean;
  };
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = vi.fn(() => {
    process.nextTick(() => {
      child.emit('close', null, 'SIGTERM');
    });
  });
  child.killed = false;

  return child;
}

/**
 * Create a mock stdout with a pipe method.
 */
function createMockStdout() {
  const stdout = new EventEmitter() as EventEmitter & {
    pipe: (dest: EventEmitter) => EventEmitter;
  };
  stdout.pipe = (dest: EventEmitter) => {
    stdout.on('data', (data: Buffer) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (dest as any).write?.(data);
    });
    return dest;
  };
  return stdout;
}

/**
 * Set up environment for xclip/X11 testing.
 */
function setupX11Env() {
  vi.stubEnv('WAYLAND_DISPLAY', undefined as unknown as string);
  vi.stubEnv('XDG_SESSION_TYPE', 'x11');
  vi.stubEnv('DISPLAY', ':0');
  Object.defineProperty(process, 'platform', {
    value: 'linux',
    configurable: true,
    writable: true,
  });
}

const originalPlatform = process.platform;

// The beforeEach below resets the module registry and re-imports the module
// graph for every test; under heavy parallel CI load that can exceed the
// default hook timeout without any real hang.
const timeoutMs = process.env['RUNNER_NAME']?.startsWith('ecs-qwen-')
  ? 60_000
  : 30_000;
vi.setConfig({ testTimeout: timeoutMs, hookTimeout: timeoutMs });

describe('clipboardUtils', () => {
  let clipboardHasImage: (onUnavailable?: () => void) => Promise<boolean>;
  let saveClipboardImage: (dir?: string) => Promise<string | null>;
  let cleanupOldClipboardImages: (dir?: string) => Promise<void>;
  let writeOsc52: (text: string) => boolean;
  let isWaylandSession: () => boolean;
  let readClipboardText: () => Promise<string | null>;

  beforeEach(async () => {
    // Clean up /tmp/test directory from previous runs to ensure
    // fs.open with O_EXCL fails consistently in saveFromCommand tests.
    // Must use the real fs module because node:fs/promises is mocked.
    const realFs =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    await realFs.rm('/tmp/test', { recursive: true, force: true });

    clipboardMockState.failLoad = false;
    clipboardMockState.loadDelayMs = 0;
    clipboardMockState.throwOnConstruct = false;
    clipboardMockState.throwOnHasFormat = false;
    vi.resetModules();
    vi.clearAllMocks();

    // Dynamic import after resetModules gives a fresh module instance.
    // Top-level import would be stale after resetModules.
    const mod = await import('./clipboardUtils.js');
    clipboardHasImage = mod.clipboardHasImage;
    saveClipboardImage = mod.saveClipboardImage;
    cleanupOldClipboardImages = mod.cleanupOldClipboardImages;
    writeOsc52 = mod.writeOsc52;
    isWaylandSession = mod.isWaylandSession;
    readClipboardText = mod.readClipboardText;
    mod.resetLinuxClipboardTool();
    // Set up Wayland env as default
    vi.stubEnv('WAYLAND_DISPLAY', 'wayland-0');
    vi.stubEnv('XDG_SESSION_TYPE', undefined as unknown as string);
    vi.stubEnv('DISPLAY', undefined as unknown as string);
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
      writable: true,
    });
  });

  describe('isWaylandSession', () => {
    it('matches the session type case-insensitively', () => {
      vi.stubEnv('XDG_SESSION_TYPE', 'Wayland');
      vi.stubEnv('WAYLAND_DISPLAY', '');

      expect(isWaylandSession()).toBe(true);
    });

    it('uses WAYLAND_DISPLAY when the session type is unset', () => {
      delete process.env['XDG_SESSION_TYPE'];
      vi.stubEnv('WAYLAND_DISPLAY', 'wayland-0');

      expect(isWaylandSession()).toBe(true);
    });
  });

  describe('clipboardHasImage', () => {
    it('uses wl-paste for a case-insensitive Wayland session type', async () => {
      vi.stubEnv('XDG_SESSION_TYPE', 'Wayland');
      vi.stubEnv('WAYLAND_DISPLAY', '');
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/wl-paste'));
      mockSpawn.mockReturnValue(createMockChild('image/png\n', 0));

      await clipboardHasImage();

      expect(mockExecSync).toHaveBeenCalledWith('command -v wl-paste', {
        stdio: 'ignore',
      });
    });

    it('should return true when clipboard contains image', async () => {
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/wl-paste'));
      const mockChild = createMockChild('image/png\nimage/bmp\n', 0);
      mockSpawn.mockReturnValue(mockChild);

      const result = await clipboardHasImage();
      expect(result).toBe(true);
    });

    it('should return false when clipboard does not contain image', async () => {
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/wl-paste'));
      const mockChild = createMockChild('text/plain\n', 0);
      mockSpawn.mockReturnValue(mockChild);

      const result = await clipboardHasImage();
      expect(result).toBe(false);
    });

    it('should return false when wl-paste is not found', async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('command not found');
      });

      const result = await clipboardHasImage();
      expect(result).toBe(false);
    });
  });

  describe('readClipboardText', () => {
    // The file's `beforeEach` only clears call history, not implementations, so
    // the clipboard simulator below has to be withdrawn by hand. Left in place
    // it would answer every later test's spawn too, and those tests would pass
    // or fail on the order they ran in rather than on their own setup.
    afterEach(() => {
      mockSpawn.mockReset();
    });

    /**
     * Answer the way a real clipboard does: the enumeration query reports the
     * types on offer, and an individual read only succeeds for a type that was
     * actually listed. Payloads are keyed by the exact reported name, so asking
     * for a normalised name that was never offered — or reading the `TARGETS`
     * atom as if it were content — comes back empty.
     */
    function mockClipboard(types: string[], payloads: Record<string, string>) {
      mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
        if (args.includes('--list-types')) {
          return createMockChild(
            types.join('\n'),
            types.length ? 0 : 1,
            types.length ? '' : 'Nothing is copied',
          );
        }
        const requested =
          args[args.indexOf(args.includes('-t') ? '-t' : '--type') + 1];
        if (requested === 'TARGETS') {
          return createMockChild(types.join('\n'), 0);
        }
        const payload = payloads[requested] ?? '';
        return createMockChild(payload, payload ? 0 : 1);
      });
    }

    /** Type names the reader actually asked for, in order. */
    function requestedTypes(): string[] {
      return mockSpawn.mock.calls
        .map(([, args]) => args as string[])
        .filter(
          (args) => !args.includes('--list-types') && !args.includes('TARGETS'),
        )
        .map(
          (args) =>
            args[args.indexOf(args.includes('-t') ? '-t' : '--type') + 1],
        );
    }

    // fileURLToPath follows host semantics; on Windows these URIs have no
    // drive letter and the production catch keeps the raw URI instead, so the
    // expectation is derived rather than hardcoded POSIX.
    const fileUriToPath = (uri: string): string => {
      try {
        return fileURLToPath(uri);
      } catch {
        return uri;
      }
    };

    const cases: Array<{
      name: string;
      tool: 'wl-paste' | 'xclip';
      types: string[];
      payloads: Record<string, string>;
      expected: string | null;
      reads: string[];
    }> = [
      {
        name: 'reads the text offer back under the exact name it was given',
        tool: 'wl-paste',
        types: ['image/png', 'text/plain;charset=utf-8'],
        payloads: { 'text/plain;charset=utf-8': 'prose' },
        expected: 'prose',
        reads: ['text/plain;charset=utf-8'],
      },
      {
        name: 'prefers text over the uri-list offered alongside it',
        tool: 'wl-paste',
        types: ['text/uri-list', 'text/plain'],
        payloads: {
          'text/uri-list': 'https://not-this',
          'text/plain': 'the prose',
        },
        expected: 'the prose',
        reads: ['text/plain'],
      },
      {
        name: 'reads a uri-list, in its CRLF form, when there is no plain text',
        tool: 'wl-paste',
        types: ['text/uri-list'],
        payloads: {
          'text/uri-list': 'https://a.example\r\nhttps://b.example\r\n',
        },
        expected: 'https://a.example\nhttps://b.example',
        reads: ['text/uri-list'],
      },
      {
        name: 'converts file:// URIs in a uri-list to local paths',
        tool: 'wl-paste',
        types: ['text/uri-list'],
        payloads: {
          'text/uri-list': 'file:///a/shot.png\r\nfile:///a/My%20Shot.png\r\n',
        },
        expected: [
          fileUriToPath('file:///a/shot.png'),
          fileUriToPath('file:///a/My%20Shot.png'),
        ].join('\n'),
        reads: ['text/uri-list'],
      },
      {
        name: 'converts every file: URI spelling and leaves remote hosts raw',
        tool: 'wl-paste',
        types: ['text/uri-list'],
        payloads: {
          'text/uri-list':
            'File:///a/shot.png\r\nfile:/a/two.png\r\nfile://attacker.example.com/share/shot.png\r\n',
        },
        // The remote line is hardcoded: on Windows fileURLToPath would turn
        // it into a UNC path, which the conversion must never produce.
        expected: [
          fileUriToPath('File:///a/shot.png'),
          fileUriToPath('file:/a/two.png'),
          'file://attacker.example.com/share/shot.png',
        ].join('\n'),
        reads: ['text/uri-list'],
      },
      {
        name: 'drops uri-list comment lines',
        tool: 'wl-paste',
        types: ['text/uri-list'],
        payloads: {
          'text/uri-list': '# a comment\r\nfile:///a/shot.png\r\n',
        },
        expected: fileUriToPath('file:///a/shot.png'),
        reads: ['text/uri-list'],
      },
      {
        name: 'maps X11 atoms onto text without reading TARGETS as content',
        tool: 'xclip',
        types: ['TARGETS', 'TIMESTAMP', 'UTF8_STRING', 'STRING'],
        payloads: {
          TARGETS: 'UTF8_STRING\nSTRING',
          UTF8_STRING: 'x11 prose',
          STRING: 'fallback',
        },
        expected: 'x11 prose',
        reads: ['UTF8_STRING'],
      },
      {
        name: 'falls through to the next text atom when the first is empty',
        tool: 'xclip',
        types: ['UTF8_STRING', 'STRING'],
        payloads: { UTF8_STRING: '', STRING: 'from STRING' },
        expected: 'from STRING',
        reads: ['UTF8_STRING', 'STRING'],
      },
      {
        // ICCCM leaves the advertisement order to the selection owner; the
        // legacy STRING atom is Latin-1, so a co-offered UTF-8 representation
        // of the same selection is always the better read.
        name: 'prefers a UTF-8 offer over the legacy STRING atom listed before it',
        tool: 'xclip',
        types: ['TARGETS', 'STRING', 'UTF8_STRING'],
        payloads: { STRING: 'latin', UTF8_STRING: 'utf8' },
        expected: 'utf8',
        reads: ['UTF8_STRING'],
      },
      {
        name: 'asks for nothing when the clipboard holds only an image',
        tool: 'wl-paste',
        types: ['image/png'],
        payloads: { 'image/png': 'binary' },
        expected: null,
        reads: [],
      },
      {
        name: 'asks for nothing when no listed type is text',
        tool: 'wl-paste',
        types: ['application/x-ole-meta', 'image/bmp'],
        payloads: { 'application/x-ole-meta': 'blob' },
        expected: null,
        reads: [],
      },
      {
        name: 'falls back to any other text type when no plain text is offered',
        tool: 'wl-paste',
        types: ['text/html', 'text/uri-list'],
        payloads: {
          'text/html': '<b>markup</b>',
          'text/uri-list': 'https://ignored',
        },
        expected: '<b>markup</b>',
        reads: ['text/html'],
      },
      {
        name: 'treats a whitespace-only selection as nothing to paste',
        tool: 'wl-paste',
        types: ['text/plain'],
        payloads: { 'text/plain': '  \n' },
        expected: null,
        reads: ['text/plain'],
      },
      {
        name: 'returns nothing for a whitespace-only plain read instead of falling through to markup',
        tool: 'wl-paste',
        types: ['text/plain', 'text/html'],
        payloads: { 'text/plain': '  \n', 'text/html': '<b>markup</b>' },
        expected: null,
        reads: ['text/plain'],
      },
      {
        // A blank-line copy reads as only the line terminator: that is
        // nothing to paste, not a reason to keep looking at the same
        // selection's markup.
        name: 'returns nothing for a terminator-only plain read instead of falling through to markup',
        tool: 'wl-paste',
        types: ['text/plain', 'text/html'],
        payloads: { 'text/plain': '\n', 'text/html': '<b>markup</b>' },
        expected: null,
        reads: ['text/plain'],
      },
      {
        name: 'keeps looking when a uri-list offer holds only comment lines',
        tool: 'wl-paste',
        types: ['text/uri-list', 'text/html'],
        payloads: {
          'text/uri-list': '# nothing but a comment\r\n',
          'text/html': '<b>markup</b>',
        },
        expected: '<b>markup</b>',
        reads: ['text/uri-list', 'text/html'],
      },
    ];

    it.each(cases)('$name', async (testCase) => {
      if (testCase.tool === 'xclip') {
        setupX11Env();
      }
      mockExecSync.mockReturnValue(Buffer.from(`/usr/bin/${testCase.tool}`));
      mockClipboard(testCase.types, testCase.payloads);

      await expect(readClipboardText()).resolves.toBe(testCase.expected);
      expect(requestedTypes()).toEqual(testCase.reads);
    });

    it('decodes a legacy STRING offer as Latin-1 when UTF-8 decoding fails', async () => {
      setupX11Env();
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/xclip'));
      mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
        const requested = args[args.indexOf('-t') + 1];
        if (requested === 'TARGETS') {
          return createMockChild('STRING\n', 0);
        }
        // ICCCM defines STRING as Latin-1: 'café' on the wire is 63 61 66 E9,
        // which a UTF-8 decode would corrupt into U+FFFD.
        return createChunkedMockChild([Buffer.from('caf\u00e9', 'latin1')]);
      });

      await expect(readClipboardText()).resolves.toBe('caf\u00e9');
      expect(requestedTypes()).toEqual(['STRING']);
    });

    it('keeps valid UTF-8 that contains U+FFFD instead of retrying as Latin-1', async () => {
      setupX11Env();
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/xclip'));
      mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
        const requested = args[args.indexOf('-t') + 1];
        if (requested === 'TARGETS') {
          return createMockChild('STRING\n', 0);
        }
        // A genuinely well-formed UTF-8 payload may carry a replacement
        // character — common when copying terminal output or a log line.
        // Only invalid bytes justify the Latin-1 retry.
        return createChunkedMockChild([
          Buffer.from('caf\u00e9 \uFFFD', 'utf8'),
        ]);
      });

      await expect(readClipboardText()).resolves.toBe('caf\u00e9 \uFFFD');
      expect(requestedTypes()).toEqual(['STRING']);
    });

    it('decodes stdout as one byte stream when a chunk splits a character', async () => {
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/wl-paste'));
      // The split lands inside the three-byte 中: decoding each chunk on
      // arrival would splice U+FFFD into the payload at the boundary.
      const payload = `${'a'.repeat(100)}中文😀${'b'.repeat(100)}`;
      const bytes = Buffer.from(payload, 'utf8');
      const splitAt = 101;
      mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
        if (args.includes('--list-types')) {
          return createMockChild('text/plain\n', 0);
        }
        return createChunkedMockChild([
          bytes.subarray(0, splitAt),
          bytes.subarray(splitAt),
        ]);
      });

      const result = await readClipboardText();

      expect(result).toBe(payload);
      expect(result).not.toContain(String.fromCharCode(0xfffd));
    });

    it('discards a read that grows past the size cap', async () => {
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/wl-paste'));
      // One byte past the 16 MiB cap readStdout enforces: the read resolves
      // to nothing and the child is killed rather than accumulated whole.
      // The child is created at spawn time — an eagerly created mock emits
      // before readStdout's handlers are attached and the test would pass
      // through the timeout path without ever witnessing the cap.
      let bigChild: ReturnType<typeof createChunkedMockChild> | undefined;
      mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
        if (args.includes('--list-types')) {
          return createMockChild('text/plain\n', 0);
        }
        bigChild = createChunkedMockChild([
          Buffer.from('x'.repeat(16 * 1024 * 1024 + 1)),
        ]);
        return bigChild;
      });

      await expect(readClipboardText()).resolves.toBeNull();
      expect(bigChild?.kill).toHaveBeenCalled();
    });

    it('stops reading offered types after the first over-cap read', async () => {
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/wl-paste'));
      // Both offers are conversions of the same oversized selection: after
      // the first read breaches the cap, reading the second would stream
      // another 16 MiB into the same discard.
      mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
        if (args.includes('--list-types')) {
          return createMockChild('text/plain\nUTF8_STRING\n', 0);
        }
        return createChunkedMockChild([
          Buffer.from('x'.repeat(16 * 1024 * 1024 + 1)),
        ]);
      });

      await expect(readClipboardText()).resolves.toBeNull();
      expect(requestedTypes()).toEqual(['text/plain']);
    });

    it('ignores chunks that arrive after a read was abandoned on timeout', async () => {
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/wl-paste'));
      // The child ignores SIGTERM, which a wedged clipboard owner may do: the
      // timeout settles the read, and a chunk arriving afterwards must
      // neither accumulate nor re-enter the over-cap kill branch.
      const hanging = createHangingChild();
      hanging.kill = vi.fn(); // no close follows — the child outlives the read
      mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
        if (args.includes('--list-types')) {
          return createMockChild('text/plain\n', 0);
        }
        return hanging;
      });

      await expect(readClipboardText()).resolves.toBeNull();
      expect(hanging.kill).toHaveBeenCalledTimes(1);

      hanging.stdout.emit(
        'data',
        Buffer.from('x'.repeat(16 * 1024 * 1024 + 1)),
      );
      expect(hanging.kill).toHaveBeenCalledTimes(1);
    }, 10000);

    it('stays quiet when no clipboard tool is reachable', async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('command not found');
      });

      await expect(readClipboardText()).resolves.toBeNull();
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('does not touch the tools off Linux', async () => {
      Object.defineProperty(process, 'platform', {
        value: 'darwin',
        configurable: true,
        writable: true,
      });

      await expect(readClipboardText()).resolves.toBeNull();
      expect(mockSpawn).not.toHaveBeenCalled();
    });
  });

  // ─── Linux clipboard unavailability must not be silent (#12488) ──

  describe('clipboardHasImage onUnavailable on Linux', () => {
    it('notifies when there is no display server to reach a tool through', async () => {
      // getLinuxClipboardTool() exit (a): not a Wayland session, no
      // XDG_SESSION_TYPE and no DISPLAY, so it returns null without ever
      // probing for wl-paste/xclip.
      vi.stubEnv('WAYLAND_DISPLAY', undefined as unknown as string);
      vi.stubEnv('XDG_SESSION_TYPE', undefined as unknown as string);
      vi.stubEnv('DISPLAY', undefined as unknown as string);

      const onUnavailable = vi.fn();
      await expect(clipboardHasImage(onUnavailable)).resolves.toBe(false);
      expect(onUnavailable).toHaveBeenCalledOnce();
      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it('notifies when the tool probe fails on X11', async () => {
      // getLinuxClipboardTool() exit (b): display env is present so xclip is
      // selected, but `command -v xclip` throws because it is not installed.
      setupX11Env();
      mockExecSync.mockImplementation(() => {
        throw new Error('command not found');
      });

      const onUnavailable = vi.fn();
      await expect(clipboardHasImage(onUnavailable)).resolves.toBe(false);
      expect(onUnavailable).toHaveBeenCalledOnce();
    });

    it('notifies when the tool probe fails on Wayland', async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('command not found');
      });

      const onUnavailable = vi.fn();
      await expect(clipboardHasImage(onUnavailable)).resolves.toBe(false);
      expect(onUnavailable).toHaveBeenCalledOnce();
    });

    it('stays quiet when the clipboard holds an image', async () => {
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/wl-paste'));
      mockSpawn.mockReturnValue(createMockChild('image/png\n', 0));

      const onUnavailable = vi.fn();
      await expect(clipboardHasImage(onUnavailable)).resolves.toBe(true);
      expect(onUnavailable).not.toHaveBeenCalled();
    });

    it('stays quiet when the clipboard holds only text', async () => {
      // "no image on the clipboard" is benign and must not nag the user.
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/wl-paste'));
      mockSpawn.mockReturnValue(createMockChild('text/plain\n', 0));

      const onUnavailable = vi.fn();
      await expect(clipboardHasImage(onUnavailable)).resolves.toBe(false);
      expect(onUnavailable).not.toHaveBeenCalled();
    });

    it('still notifies on the non-Linux native module path', async () => {
      clipboardMockState.failLoad = true;
      vi.resetModules();
      const mod = await import('./clipboardUtils.js');
      Object.defineProperty(process, 'platform', {
        value: 'darwin',
        configurable: true,
        writable: true,
      });

      const onUnavailable = vi.fn();
      await expect(mod.clipboardHasImage(onUnavailable)).resolves.toBe(false);
      expect(onUnavailable).toHaveBeenCalledOnce();
    });
  });

  // ─── Linux tool found but its query fails (#12505 finding 1) ──
  // getLinuxClipboardTool() only probes `command -v`; it never touches the
  // display server, so the probe can pass while the actual clipboard query
  // fails (dead/stale X server, compositor socket gone). Those failures must
  // notify. Staying quiet is reserved for two benign answers: a successful
  // query that finds no image, and an empty clipboard (which also exits
  // non-zero, but is the tool answering correctly).

  describe('clipboardHasImage Linux query failures', () => {
    it('notifies when wl-paste --list-types exits non-zero', async () => {
      // No stderr to classify the exit, so it stays a query failure: the
      // default for an unexplained non-zero exit is to notify.
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/wl-paste'));
      mockSpawn.mockReturnValue(createMockChild('', 1));

      const onUnavailable = vi.fn();
      await expect(clipboardHasImage(onUnavailable)).resolves.toBe(false);
      expect(onUnavailable).toHaveBeenCalledOnce();
    });

    it('notifies when wl-paste fails to spawn', async () => {
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/wl-paste'));
      mockSpawn.mockReturnValue(createSpawnErrorChild());

      const onUnavailable = vi.fn();
      await expect(clipboardHasImage(onUnavailable)).resolves.toBe(false);
      // The fixture emits `error` then `close(-2)`, as Node does. Without the
      // settle latch the close handler re-enters its non-zero branch: a second
      // notify, and an exit code recorded for a process that never started.
      expect(onUnavailable).toHaveBeenCalledOnce();
      expect(mockDebugLogger.debug).not.toHaveBeenCalledWith(
        expect.stringContaining('exited with code'),
      );
      // That latch is also what makes this errno the spawn failure's only
      // trace, so it is pinned here: reverting the handler to the pre-PR
      // `child.on('error', () => {` drops the binding and the log together and
      // would otherwise ship green. `.debug` and not `.error`, because the
      // synchronous-throw arm logs the byte-identical message at the other
      // level and is pinned separately.
      expect(mockDebugLogger.debug).toHaveBeenCalledWith(
        'Failed to spawn wl-paste --list-types:',
        expect.any(Error),
      );
    });

    it('notifies when the wl-paste query times out', async () => {
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/wl-paste'));
      mockSpawn.mockReturnValue(createHangingChild());

      const onUnavailable = vi.fn();
      await expect(clipboardHasImage(onUnavailable)).resolves.toBe(false);
      expect(onUnavailable).toHaveBeenCalledOnce();
      // The kill() the timeout path issues produces `close(null, 'SIGTERM')`,
      // which the fixture now emits. The timeout line must be the *only*
      // diagnosis recorded: `exited with code null` states an exit code the
      // query never had, and the notify must not fire a second time.
      expect(mockDebugLogger.debug).toHaveBeenCalledWith(
        expect.stringMatching(/^wl-paste --list-types timed out after \d+ms$/),
      );
      expect(mockDebugLogger.debug).not.toHaveBeenCalledWith(
        expect.stringContaining('exited with code'),
      );
    }, 10000);

    it('notifies when spawning wl-paste itself throws', async () => {
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/wl-paste'));
      mockSpawn.mockImplementation(() => {
        throw new Error('spawn error');
      });

      const onUnavailable = vi.fn();
      await expect(clipboardHasImage(onUnavailable)).resolves.toBe(false);
      expect(onUnavailable).toHaveBeenCalledOnce();
    });

    it('notifies when xclip exits non-zero on X11', async () => {
      // The issue's regression case: X11 session with DISPLAY set and xclip
      // installed, but the query exits non-zero without saying the clipboard
      // is empty, so it cannot be classified as benign. The dead-X-server
      // wording itself is pinned further down in this block.
      setupX11Env();
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/xclip'));
      mockSpawn.mockReturnValue(createMockChild('', 1));

      const onUnavailable = vi.fn();
      await expect(clipboardHasImage(onUnavailable)).resolves.toBe(false);
      expect(onUnavailable).toHaveBeenCalledOnce();
    });

    it('notifies when xclip fails to spawn on X11', async () => {
      setupX11Env();
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/xclip'));
      mockSpawn.mockReturnValue(createSpawnErrorChild());

      const onUnavailable = vi.fn();
      await expect(clipboardHasImage(onUnavailable)).resolves.toBe(false);
      expect(onUnavailable).toHaveBeenCalledOnce();
      expect(mockDebugLogger.debug).not.toHaveBeenCalledWith(
        expect.stringContaining('exited with code'),
      );
      // Same reason as the wl-paste twin above: the latch suppresses the close
      // handler's fabricated exit code, so this errno is the only trace the
      // spawn failure leaves and dropping it must not ship green.
      expect(mockDebugLogger.debug).toHaveBeenCalledWith(
        'Failed to spawn xclip:',
        expect.any(Error),
      );
    });

    it('notifies when the xclip query times out on X11', async () => {
      setupX11Env();
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/xclip'));
      mockSpawn.mockReturnValue(createHangingChild());

      const onUnavailable = vi.fn();
      await expect(clipboardHasImage(onUnavailable)).resolves.toBe(false);
      expect(onUnavailable).toHaveBeenCalledOnce();
      expect(mockDebugLogger.debug).toHaveBeenCalledWith(
        expect.stringMatching(/^xclip timed out after \d+ms$/),
      );
      expect(mockDebugLogger.debug).not.toHaveBeenCalledWith(
        expect.stringContaining('exited with code'),
      );
    }, 10000);

    it('notifies when spawning xclip itself throws on X11', async () => {
      setupX11Env();
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/xclip'));
      mockSpawn.mockImplementation(() => {
        throw new Error('spawn error');
      });

      const onUnavailable = vi.fn();
      await expect(clipboardHasImage(onUnavailable)).resolves.toBe(false);
      expect(onUnavailable).toHaveBeenCalledOnce();
    });

    it('stays quiet when xclip succeeds and the clipboard holds only text', async () => {
      // Anti-nag: a successful query that finds no image is benign and must
      // not warn. The pre-existing xclip tests called clipboardHasImage()
      // with no argument, so a misplaced notification could not fail there —
      // this closes that coverage gap.
      setupX11Env();
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/xclip'));
      mockSpawn.mockReturnValue(
        createMockChild('text/plain\nUTF8_STRING\n', 0),
      );

      const onUnavailable = vi.fn();
      await expect(clipboardHasImage(onUnavailable)).resolves.toBe(false);
      expect(onUnavailable).not.toHaveBeenCalled();
    });

    // ─── An empty clipboard exits non-zero too, and must stay quiet ───
    // Linux clipboard tools use one and the same exit code for "the display
    // server is dead" and for "nothing is on the clipboard", so the exit code
    // alone cannot separate them — only stderr can. Which wording each shipped
    // tool version produces, and its upstream provenance, is documented once on
    // EMPTY_CLIPBOARD_STDERR_MARKERS rather than restated here; each case below
    // pins one of those wordings. Pressing the image-paste binding with an
    // empty clipboard is routine, so it must not claim the native module is
    // broken.

    it('stays quiet when wl-paste exits non-zero because nothing is copied', async () => {
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/wl-paste'));
      mockSpawn.mockReturnValue(createMockChild('', 1, 'Nothing is copied\n'));

      const onUnavailable = vi.fn();
      await expect(clipboardHasImage(onUnavailable)).resolves.toBe(false);
      expect(onUnavailable).not.toHaveBeenCalled();
      // fd 2 has to be piped for that distinction to be possible at all.
      expect(mockSpawn).toHaveBeenCalledWith('wl-paste', ['--list-types'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    });

    it('stays quiet when wl-paste 1.x exits non-zero with "No selection"', async () => {
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/wl-paste'));
      mockSpawn.mockReturnValue(createMockChild('', 1, 'No selection\n'));

      const onUnavailable = vi.fn();
      await expect(clipboardHasImage(onUnavailable)).resolves.toBe(false);
      expect(onUnavailable).not.toHaveBeenCalled();
    });

    it('stays quiet when released xclip 0.13 reports the target is unavailable', async () => {
      // The wording a shipped xclip actually produces for an unowned
      // selection. 0.13 is what Debian/Ubuntu/Fedora package, and it has no
      // `errconvsel()`, so the master-only wording below matches nothing here:
      // without this marker the routine empty-clipboard case falls through to
      // onUnavailable and spends the session's one-shot notify latch on a
      // false alarm, silencing the genuine failure this PR exists to report.
      setupX11Env();
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/xclip'));
      mockSpawn.mockReturnValue(
        createMockChild('', 1, 'Error: target TARGETS not available\n'),
      );

      const onUnavailable = vi.fn();
      await expect(clipboardHasImage(onUnavailable)).resolves.toBe(false);
      expect(onUnavailable).not.toHaveBeenCalled();
    });

    it('stays quiet when xclip exits non-zero because nothing owns the selection', async () => {
      // Unreleased xclip git master wording, kept so the marker set covers
      // both the shipped and the in-development spelling.
      setupX11Env();
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/xclip'));
      mockSpawn.mockReturnValue(
        createMockChild(
          '',
          1,
          'xclip: Error: There is no owner for the CLIPBOARD selection\n',
        ),
      );

      const onUnavailable = vi.fn();
      await expect(clipboardHasImage(onUnavailable)).resolves.toBe(false);
      expect(onUnavailable).not.toHaveBeenCalled();
    });

    it('still notifies when wl-paste cannot reach the Wayland server', async () => {
      // Real failure, same exit code 1: the compositor socket is gone.
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/wl-paste'));
      mockSpawn.mockReturnValue(
        createMockChild(
          '',
          1,
          'Failed to connect to a Wayland server: No such file or directory\n',
        ),
      );

      const onUnavailable = vi.fn();
      await expect(clipboardHasImage(onUnavailable)).resolves.toBe(false);
      expect(onUnavailable).toHaveBeenCalledOnce();
      // This echo is the only record of the wording isEmptyClipboardError()
      // classified as a real failure rather than an empty clipboard, so
      // without it the classification decision is not auditable. No trailing
      // newline: the site trims.
      expect(mockDebugLogger.debug).toHaveBeenCalledWith(
        'wl-paste stderr: Failed to connect to a Wayland server: No such file or directory',
      );
    });

    it('still notifies when xclip cannot open the display', async () => {
      // Real failure, same exit code as an empty clipboard: xcprint.c
      // `errxdisplay()` prints this and exits EXIT_FAILURE.
      setupX11Env();
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/xclip'));
      mockSpawn.mockReturnValue(
        createMockChild('', 1, "xclip: Error: Can't open display: :0\n"),
      );

      const onUnavailable = vi.fn();
      await expect(clipboardHasImage(onUnavailable)).resolves.toBe(false);
      expect(onUnavailable).toHaveBeenCalledOnce();
      // Same as the wl-paste twin above: the only record of the wording that
      // was classified as a real failure. Trimmed, so no trailing newline.
      expect(mockDebugLogger.debug).toHaveBeenCalledWith(
        "xclip stderr: xclip: Error: Can't open display: :0",
      );
    });

    it('records the exit code and args when a failed query writes no stderr', async () => {
      // The shape xclip produces when it exits EXIT_FAILURE without writing
      // anything to stderr: the user is notified, so the debug log is the only
      // place the reason can come from.
      setupX11Env();
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/xclip'));
      mockSpawn.mockReturnValue(createMockChild('', 1));

      await expect(clipboardHasImage(vi.fn())).resolves.toBe(false);
      expect(mockDebugLogger.debug).toHaveBeenCalledWith(
        'xclip exited with code 1. Args: -selection clipboard -t TARGETS -o',
      );
    });

    it('records the exit code when wl-paste --list-types fails silently', async () => {
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/wl-paste'));
      mockSpawn.mockReturnValue(createMockChild('', 1));

      await expect(clipboardHasImage(vi.fn())).resolves.toBe(false);
      expect(mockDebugLogger.debug).toHaveBeenCalledWith(
        'wl-paste --list-types exited with code 1',
      );
    });
  });

  // ─── xclip / X11 path tests ───────────────────────────────────

  describe('xclip / X11 path', () => {
    beforeEach(() => {
      setupX11Env();
    });

    describe('clipboardHasImage', () => {
      it('should detect xclip as the clipboard tool on X11', async () => {
        mockExecSync.mockReturnValue(Buffer.from('/usr/bin/xclip'));
        const mockChild = createMockChild('image/png\nTARGETS\n', 0);
        mockSpawn.mockReturnValue(mockChild);

        const result = await clipboardHasImage();
        expect(result).toBe(true);
        // Verify xclip was called with correct TARGETS args. fd 2 is piped so
        // a non-zero exit can be diagnosed and an empty clipboard told apart
        // from a real failure.
        expect(mockSpawn).toHaveBeenCalledWith(
          'xclip',
          ['-selection', 'clipboard', '-t', 'TARGETS', '-o'],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
      });

      it('should detect the BMP flavour the shared image-type set defines', async () => {
        mockExecSync.mockReturnValue(Buffer.from('/usr/bin/xclip'));
        // TARGETS reporting image/bmp (what WSL2 exposes) must count as an
        // image on X11 exactly as it does on Wayland — one set decides both.
        mockSpawn.mockReturnValue(createMockChild('TARGETS\nimage/bmp\n', 0));

        await expect(clipboardHasImage()).resolves.toBe(true);
      });

      it('should return false when xclip reports no image types', async () => {
        mockExecSync.mockReturnValue(Buffer.from('/usr/bin/xclip'));
        const mockChild = createMockChild('text/plain\nUTF8_STRING\n', 0);
        mockSpawn.mockReturnValue(mockChild);

        const result = await clipboardHasImage();
        expect(result).toBe(false);
      });

      it('should return false when xclip is not found', async () => {
        mockExecSync.mockImplementation(() => {
          throw new Error('command not found');
        });

        const result = await clipboardHasImage();
        expect(result).toBe(false);
      });
    });

    describe('saveClipboardImage', () => {
      it('should return null when xclip is not found', async () => {
        mockExecSync.mockImplementation(() => {
          throw new Error('command not found');
        });

        const result = await saveClipboardImage('/tmp/test');
        expect(result).toBe(null);
      });

      // xclip save success path: blocked by vitest's built-in module mock
      // limitation.  node:fs.createWriteStream cannot be mocked without
      // breaking indirect deps (debugLogger, symlink) that import
      // { promises as fs } from 'node:fs'.  Error paths below verify
      // correct spawn construction; clipboardHasImage tests verify detection.
    });
  });

  // ─── BMP-to-PNG conversion tests ──────────────────────────────

  describe('BMP-to-PNG conversion (wl-paste)', () => {
    // Note: BMP-to-PNG conversion success path requires saveFromCommand to resolve,
    // which is blocked by the createWriteStream mocking issue.
    // The "prefer PNG over BMP" test below verifies the correct branching logic,
    // and the "python3 PIL conversion fails" test verifies error handling.

    it('should return null when python3 PIL conversion fails', async () => {
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/wl-paste'));

      let callCount = 0;
      mockSpawn.mockImplementation(() => {
        callCount++;
        const stdout = createMockStdout();
        // Production pipes fd 2 and attaches a handler to it, so the fixture
        // must expose the stream or that attachment throws inside the promise
        // executor and this test passes without running anything past it.
        const stderr = new EventEmitter();
        const child = new EventEmitter() as EventEmitter & {
          stdout: ReturnType<typeof createMockStdout>;
          stderr: typeof stderr;
          kill: ReturnType<typeof vi.fn>;
          killed: boolean;
        };
        child.stdout = stdout;
        child.stderr = stderr;
        child.kill = vi.fn();
        child.killed = false;

        if (callCount === 1) {
          // only bmp
          process.nextTick(() => {
            stdout.emit('data', Buffer.from('image/bmp\n'));
            child.emit('close', 0);
          });
        } else if (callCount === 2) {
          // wl-paste --type image/bmp: save succeeds
          process.nextTick(() => {
            child.emit('close', 0);
          });
        } else {
          // python3 PIL conversion: fails
          process.nextTick(() => {
            child.emit('close', 1);
          });
        }

        return child;
      });

      const result = await saveClipboardImage('/tmp/test');
      expect(result).toBe(null);

      // Witness that the run reached the BMP branch and derived the .bmp path —
      // `toBe(null)` alone also passed when this fixture lacked a stderr
      // stream, because the resulting TypeError was swallowed by
      // saveClipboardImage's catch-all. Despite this test's name it does not
      // reach the conversion catch: fs.open is unmocked while mkdir is a no-op,
      // so saveFromCommand fails at its O_EXCL open before spawning, python3
      // never runs, and the unlink counted here is the save-failure tail.
      const { unlink } = await import('node:fs/promises');
      const unlinked = vi.mocked(unlink).mock.calls.map((c) => String(c[0]));
      expect(unlinked.filter((p) => p.endsWith('.bmp'))).toHaveLength(1);
    });

    it('should prefer PNG over BMP when both are available', async () => {
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/wl-paste'));

      let callCount = 0;
      const spawnCalls: Array<{ command: string; args: string[] }> = [];
      mockSpawn.mockImplementation((command: string, args: string[]) => {
        callCount++;
        const stdout = createMockStdout();
        // Production pipes fd 2 and attaches a handler to it, so the fixture
        // must expose the stream or that attachment throws inside the promise
        // executor and this test passes without running anything past it.
        const stderr = new EventEmitter();
        const child = new EventEmitter() as EventEmitter & {
          stdout: ReturnType<typeof createMockStdout>;
          stderr: typeof stderr;
          kill: ReturnType<typeof vi.fn>;
          killed: boolean;
        };
        child.stdout = stdout;
        child.stderr = stderr;
        child.kill = vi.fn();
        child.killed = false;

        if (callCount === 1) {
          // both png and bmp available
          spawnCalls.push({ command, args });
          process.nextTick(() => {
            stdout.emit('data', Buffer.from('image/png\nimage/bmp\n'));
            child.emit('close', 0);
          });
        } else if (callCount === 2) {
          // wl-paste --type image/png: attempted but O_EXCL fails (dir doesn't exist)
          spawnCalls.push({ command, args });
          process.nextTick(() => {
            child.emit('close', 0);
          });
        }

        return child;
      });

      await saveClipboardImage('/tmp/test');

      // O_EXCL in saveFromCommand prevents the second spawn because
      // mkdir is mocked (directory never actually created), so fs.open
      // fails. Only the list-types spawn fires.
      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0].args).toContain('--list-types');

      // Neither save can spawn: saveFromCommand opens with O_EXCL first and
      // mkdir is mocked, so each branch fails at the open and unlinks the path
      // it derived. .png before .bmp is the preference this test is named for,
      // and it is only observable now that the type query resolves instead of
      // throwing on a missing stderr stream.
      const { unlink } = await import('node:fs/promises');
      const unlinked = vi.mocked(unlink).mock.calls.map((c) => {
        const target = String(c[0]);
        return target.slice(target.lastIndexOf('.'));
      });
      expect(unlinked).toEqual(['.png', '.bmp']);
    });
  });

  // ─── saveFromCommand error path tests ─────────────────────────

  describe('saveFromCommand error paths', () => {
    beforeEach(() => {
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/wl-paste'));
    });

    it('should return null on spawn timeout (5s)', async () => {
      let callCount = 0;
      mockSpawn.mockImplementation(() => {
        callCount++;
        const stdout = createMockStdout();
        const child = new EventEmitter() as EventEmitter & {
          stdout: ReturnType<typeof createMockStdout>;
          stderr: EventEmitter;
          kill: ReturnType<typeof vi.fn>;
          killed: boolean;
        };
        child.stdout = stdout;
        child.stderr = new EventEmitter();
        child.kill = vi.fn();
        child.killed = false;

        if (callCount === 1) {
          // --list-types: succeeds
          process.nextTick(() => {
            stdout.emit('data', Buffer.from('image/png\n'));
            child.emit('close', 0);
          });
        } else {
          // wl-paste save: never emits close — will timeout
          // do nothing
        }

        return child;
      });

      const result = await saveClipboardImage('/tmp/test');
      expect(result).toBe(null);
    }, 10000);

    it('should return null on spawn error', async () => {
      let callCount = 0;
      mockSpawn.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // --list-types: succeeds
          return createMockChild('image/png\n', 0);
        }
        // wl-paste save: emit error
        const stdout = createMockStdout();
        const child = new EventEmitter() as EventEmitter & {
          stdout: ReturnType<typeof createMockStdout>;
          stderr: EventEmitter;
          kill: ReturnType<typeof vi.fn>;
          killed: boolean;
        };
        child.stdout = stdout;
        child.stderr = new EventEmitter();
        child.kill = vi.fn();
        child.killed = false;

        process.nextTick(() => {
          child.emit('error', new Error('spawn ENOENT'));
        });
        return child;
      });

      const result = await saveClipboardImage('/tmp/test');
      expect(result).toBe(null);
    });

    it('should return null on stdout error', async () => {
      let callCount = 0;
      mockSpawn.mockImplementation(() => {
        callCount++;
        const stdout = createMockStdout();
        const child = new EventEmitter() as EventEmitter & {
          stdout: ReturnType<typeof createMockStdout>;
          stderr: EventEmitter;
          kill: ReturnType<typeof vi.fn>;
          killed: boolean;
        };
        child.stdout = stdout;
        child.stderr = new EventEmitter();
        child.kill = vi.fn();
        child.killed = false;

        if (callCount === 1) {
          // --list-types: succeeds
          process.nextTick(() => {
            stdout.emit('data', Buffer.from('image/png\n'));
            child.emit('close', 0);
          });
        } else {
          // wl-paste save: stdout error
          process.nextTick(() => {
            stdout.emit('error', new Error('read error'));
          });
        }

        return child;
      });

      const result = await saveClipboardImage('/tmp/test');
      expect(result).toBe(null);
    });

    // Note: fileStream error path requires saveFromCommand to reach the fileStream error handler.
    // Due to createWriteStream mocking limitations, this path cannot be properly tested.
    // The stdout error and spawn error tests above cover similar error handling logic.
  });

  // ─── saveClipboardImage existing tests (improved) ─────────────

  describe('saveClipboardImage', () => {
    it('should return null when no clipboard tool is available', async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('command not found');
      });

      const result = await saveClipboardImage('/tmp/test');
      expect(result).toBe(null);
    });

    it('should return null on spawn error during list-types', async () => {
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/wl-paste'));

      // Mock spawn to throw an error
      mockSpawn.mockImplementation(() => {
        throw new Error('spawn error');
      });

      const result = await saveClipboardImage('/tmp/test');
      expect(result).toBe(null);
    });

    it('records why the save path gave up when spawning wl-paste throws', async () => {
      // saveFileWithWlPaste calls getWlPasteImageTypes without an
      // onUnavailable callback, so this log line is the only trace a
      // synchronous spawn throw (EMFILE under fd pressure) leaves behind.
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/wl-paste'));
      const spawnError = new Error('spawn EMFILE');
      mockSpawn.mockImplementation(() => {
        throw spawnError;
      });

      await expect(saveClipboardImage('/tmp/test')).resolves.toBe(null);
      expect(mockDebugLogger.error).toHaveBeenCalledWith(
        'Failed to spawn wl-paste --list-types:',
        spawnError,
      );
    });

    // Note: PNG save success path requires saveFromCommand to resolve with true,
    // which is blocked by the createWriteStream mocking limitation.
    // The spawn error and timeout tests above verify error handling.
    // The correct wl-paste command invocation is verified indirectly through
    // the clipboardHasImage tests and the fact that saveClipboardImage
    // calls the right spawn commands before timing out.
  });

  describe('cleanupOldClipboardImages', () => {
    it('should not throw errors when directory does not exist', async () => {
      await expect(
        cleanupOldClipboardImages('/path/that/does/not/exist'),
      ).resolves.not.toThrow();
    });

    it('should complete without errors on valid directory', async () => {
      await expect(cleanupOldClipboardImages('.')).resolves.not.toThrow();
    });
  });

  describe('macOS/Windows fallback', () => {
    it('notifies after a cached native module load failure', async () => {
      clipboardMockState.failLoad = true;
      vi.resetModules();
      const mod = await import('./clipboardUtils.js');
      Object.defineProperty(process, 'platform', {
        value: 'darwin',
        configurable: true,
        writable: true,
      });

      await expect(mod.clipboardHasImage()).resolves.toBe(false);
      const onUnavailable = vi.fn();
      await expect(mod.clipboardHasImage(onUnavailable)).resolves.toBe(false);
      expect(onUnavailable).toHaveBeenCalledOnce();
    });

    it('notifies when the native module loads but constructing it throws', async () => {
      clipboardMockState.throwOnConstruct = true;
      vi.resetModules();
      const mod = await import('./clipboardUtils.js');
      Object.defineProperty(process, 'platform', {
        value: 'darwin',
        configurable: true,
        writable: true,
      });
      const onUnavailable = vi.fn();

      await expect(mod.clipboardHasImage(onUnavailable)).resolves.toBe(false);
      expect(onUnavailable).toHaveBeenCalledOnce();
    });

    it('notifies when the native module loads but hasFormat throws', async () => {
      clipboardMockState.throwOnHasFormat = true;
      vi.resetModules();
      const mod = await import('./clipboardUtils.js');
      Object.defineProperty(process, 'platform', {
        value: 'darwin',
        configurable: true,
        writable: true,
      });
      const onUnavailable = vi.fn();

      await expect(mod.clipboardHasImage(onUnavailable)).resolves.toBe(false);
      expect(onUnavailable).toHaveBeenCalledOnce();
    });

    it('does not notify when the clipboard read succeeds but holds no image', async () => {
      vi.resetModules();
      const mod = await import('./clipboardUtils.js');
      Object.defineProperty(process, 'platform', {
        value: 'darwin',
        configurable: true,
        writable: true,
      });
      const onUnavailable = vi.fn();

      await expect(mod.clipboardHasImage(onUnavailable)).resolves.toBe(false);
      expect(onUnavailable).not.toHaveBeenCalled();
    });

    it('shares an in-flight native module load without false errors', async () => {
      clipboardMockState.loadDelayMs = 20;
      vi.resetModules();
      const mod = await import('./clipboardUtils.js');
      Object.defineProperty(process, 'platform', {
        value: 'darwin',
        configurable: true,
        writable: true,
      });
      const onUnavailable = vi.fn();

      await expect(
        Promise.all([
          mod.clipboardHasImage(onUnavailable),
          mod.clipboardHasImage(onUnavailable),
        ]),
      ).resolves.toEqual([false, false]);
      expect(onUnavailable).not.toHaveBeenCalled();
    });

    it('should return false on non-linux platform when @teddyzhu/clipboard fails', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', {
        value: 'darwin',
        configurable: true,
        writable: true,
      });

      // @teddyzhu/clipboard mock returns false by default
      const result = await clipboardHasImage();
      expect(result).toBe(false);

      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
        writable: true,
      });
    });

    it('should return null on non-linux platform when saving fails', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        configurable: true,
        writable: true,
      });

      // @teddyzhu/clipboard mock returns false by default
      const result = await saveClipboardImage('/tmp/test');
      expect(result).toBe(null);

      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
        writable: true,
      });
    });
  });

  describe('cache behavior', () => {
    it('should reset wl-paste cache between clipboardHasImage calls', async () => {
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/wl-paste'));

      // First call: returns image
      const mockChild1 = createMockChild('image/png\n', 0);
      mockSpawn.mockReturnValue(mockChild1);
      const result1 = await clipboardHasImage();
      expect(result1).toBe(true);

      // Second call: should also return true (cache reset, new spawn)
      const mockChild2 = createMockChild('text/plain\n', 0);
      mockSpawn.mockReturnValue(mockChild2);
      const result2 = await clipboardHasImage();
      expect(result2).toBe(false);
    });
  });

  describe('writeOsc52', () => {
    const originalStdoutIsTTY = process.stdout.isTTY;
    const originalStderrIsTTY = process.stderr.isTTY;
    let stdoutWriteMock: ReturnType<typeof vi.fn>;
    let stderrWriteMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      stdoutWriteMock = vi.fn();
      stderrWriteMock = vi.fn();
      // Control multiplexer env vars for deterministic tests
      vi.stubEnv('TMUX', undefined as unknown as string);
      vi.stubEnv('STY', undefined as unknown as string);
      // Mock isTTY and write
      Object.defineProperty(process.stdout, 'isTTY', {
        value: true,
        configurable: true,
      });
      Object.defineProperty(process.stderr, 'isTTY', {
        value: false,
        configurable: true,
      });
      process.stdout.write = stdoutWriteMock;
      process.stderr.write = stderrWriteMock;
    });

    afterEach(() => {
      Object.defineProperty(process.stdout, 'isTTY', {
        value: originalStdoutIsTTY,
        configurable: true,
      });
      Object.defineProperty(process.stderr, 'isTTY', {
        value: originalStderrIsTTY,
        configurable: true,
      });
      vi.restoreAllMocks();
    });

    it('should write OSC 52 sequence to stdout when stdout is TTY', () => {
      const text = 'hello world';
      const expectedBase64 = Buffer.from(text, 'utf-8').toString('base64');
      const expectedSequence = `\x1b]52;c;${expectedBase64}\x07`;

      const result = writeOsc52(text);

      expect(result).toBe(true);
      expect(stdoutWriteMock).toHaveBeenCalledWith(
        expectedSequence,
        expect.any(Function),
      );
      expect(stderrWriteMock).not.toHaveBeenCalled();
    });

    it('should write OSC 52 sequence to stderr when stdout is not TTY but stderr is', () => {
      Object.defineProperty(process.stdout, 'isTTY', {
        value: false,
        configurable: true,
      });
      Object.defineProperty(process.stderr, 'isTTY', {
        value: true,
        configurable: true,
      });

      const text = 'hello world';
      const expectedBase64 = Buffer.from(text, 'utf-8').toString('base64');
      const expectedSequence = `\x1b]52;c;${expectedBase64}\x07`;

      const result = writeOsc52(text);

      expect(result).toBe(true);
      expect(stderrWriteMock).toHaveBeenCalledWith(
        expectedSequence,
        expect.any(Function),
      );
      expect(stdoutWriteMock).not.toHaveBeenCalled();
    });

    it('should return false and not write when neither stdout nor stderr is TTY', () => {
      Object.defineProperty(process.stdout, 'isTTY', {
        value: false,
        configurable: true,
      });
      Object.defineProperty(process.stderr, 'isTTY', {
        value: false,
        configurable: true,
      });

      const result = writeOsc52('hello world');

      expect(result).toBe(false);
      expect(stdoutWriteMock).not.toHaveBeenCalled();
      expect(stderrWriteMock).not.toHaveBeenCalled();
    });

    it('should handle special characters in text', () => {
      const text = 'special: \n\t\r"\'\\';
      const expectedBase64 = Buffer.from(text, 'utf-8').toString('base64');
      const expectedSequence = `\x1b]52;c;${expectedBase64}\x07`;

      const result = writeOsc52(text);

      expect(result).toBe(true);
      expect(stdoutWriteMock).toHaveBeenCalledWith(
        expectedSequence,
        expect.any(Function),
      );
    });

    it('should handle empty string', () => {
      const text = '';
      const expectedBase64 = Buffer.from(text, 'utf-8').toString('base64');
      const expectedSequence = `\x1b]52;c;${expectedBase64}\x07`;

      const result = writeOsc52(text);

      expect(result).toBe(true);
      expect(stdoutWriteMock).toHaveBeenCalledWith(
        expectedSequence,
        expect.any(Function),
      );
    });

    it('should return false on write error', () => {
      stdoutWriteMock.mockImplementation(() => {
        throw new Error('write failed');
      });

      const result = writeOsc52('hello');

      expect(result).toBe(false);
    });

    it('should wrap in tmux DCS envelope when TMUX is set', () => {
      vi.stubEnv('TMUX', '/tmp/tmux-1000/default,12345,0');
      const text = 'hello world';
      const expectedBase64 = Buffer.from(text, 'utf-8').toString('base64');
      const rawSequence = `\x1b]52;c;${expectedBase64}\x07`;
      const expectedSequence = `\x1bPtmux;\x1b${rawSequence}\x1b\\`;

      const result = writeOsc52(text);

      expect(result).toBe(true);
      expect(stdoutWriteMock).toHaveBeenCalledWith(
        expectedSequence,
        expect.any(Function),
      );
    });

    it('should wrap in screen DCS envelope when STY is set', () => {
      vi.stubEnv('STY', '12345.pts-0.host');
      const text = 'hello world';
      const expectedBase64 = Buffer.from(text, 'utf-8').toString('base64');
      const rawSequence = `\x1b]52;c;${expectedBase64}\x07`;
      const expectedSequence = `\x1bP${rawSequence}\x1b\\`;

      const result = writeOsc52(text);

      expect(result).toBe(true);
      expect(stdoutWriteMock).toHaveBeenCalledWith(
        expectedSequence,
        expect.any(Function),
      );
    });
  });
});
