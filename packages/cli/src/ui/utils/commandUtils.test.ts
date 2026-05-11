/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Mock } from 'vitest';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { spawn, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  isAtCommand,
  isSlashCommand,
  copyToClipboard,
  getUrlOpenCommand,
  CodePage,
  findMidInputSlashCommand,
  findSlashCommandTokens,
  getBestSlashCommandMatch,
} from './commandUtils.js';
import type { RecentSlashCommands } from '../hooks/useSlashCompletion.js';

// Mock child_process
vi.mock('child_process');

// Mock process.platform for platform-specific tests
const mockProcess = vi.hoisted(() => ({
  platform: 'darwin',
}));

vi.stubGlobal('process', {
  ...process,
  get platform() {
    return mockProcess.platform;
  },
});

interface MockChildProcess extends EventEmitter {
  stdin: EventEmitter & {
    write: Mock;
    end: Mock;
  };
  stderr: EventEmitter;
}

describe('commandUtils', () => {
  let mockSpawn: Mock;
  let mockChild: MockChildProcess;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Dynamically import and set up spawn mock
    const { spawn } = await import('node:child_process');
    mockSpawn = spawn as Mock;

    // Create mock child process with stdout/stderr emitters
    mockChild = Object.assign(new EventEmitter(), {
      stdin: Object.assign(new EventEmitter(), {
        write: vi.fn(),
        end: vi.fn(),
      }),
      stderr: new EventEmitter(),
    }) as MockChildProcess;

    mockSpawn.mockReturnValue(mockChild as unknown as ReturnType<typeof spawn>);
  });

  describe('isAtCommand', () => {
    it('should return true when query starts with @', () => {
      expect(isAtCommand('@file')).toBe(true);
      expect(isAtCommand('@path/to/file')).toBe(true);
      expect(isAtCommand('@')).toBe(true);
    });

    it('should return true when query contains @ preceded by whitespace', () => {
      expect(isAtCommand('hello @file')).toBe(true);
      expect(isAtCommand('some text @path/to/file')).toBe(true);
      expect(isAtCommand('   @file')).toBe(true);
    });

    it('should return false when query does not start with @ and has no spaced @', () => {
      expect(isAtCommand('file')).toBe(false);
      expect(isAtCommand('hello')).toBe(false);
      expect(isAtCommand('')).toBe(false);
      expect(isAtCommand('email@domain.com')).toBe(false);
      expect(isAtCommand('user@host')).toBe(false);
    });

    it('should return false when @ is not preceded by whitespace', () => {
      expect(isAtCommand('hello@file')).toBe(false);
      expect(isAtCommand('text@path')).toBe(false);
    });
  });

  describe('isSlashCommand', () => {
    it('should return true when query starts with /', () => {
      expect(isSlashCommand('/help')).toBe(true);
      expect(isSlashCommand('/config set')).toBe(true);
      expect(isSlashCommand('/clear')).toBe(true);
      expect(isSlashCommand('/')).toBe(true);
    });

    it('should return false when query does not start with /', () => {
      expect(isSlashCommand('help')).toBe(false);
      expect(isSlashCommand('config set')).toBe(false);
      expect(isSlashCommand('')).toBe(false);
      expect(isSlashCommand('path/to/file')).toBe(false);
      expect(isSlashCommand(' /help')).toBe(false);
    });

    it('should return false for line comments starting with //', () => {
      expect(isSlashCommand('// This is a comment')).toBe(false);
      expect(isSlashCommand('// check if variants base info all filled.')).toBe(
        false,
      );
      expect(isSlashCommand('//comment without space')).toBe(false);
    });

    it('should return false for block comments starting with /*', () => {
      expect(isSlashCommand('/* This is a block comment */')).toBe(false);
      expect(isSlashCommand('/*\n * Multi-line comment\n */')).toBe(false);
      expect(isSlashCommand('/*comment without space*/')).toBe(false);
    });

    it('should return false for slash-prefixed file paths', () => {
      expect(isSlashCommand('/api/apiFunction/接口的实现')).toBe(false);
      expect(isSlashCommand('/Users/me/project/src/index.ts')).toBe(false);
      expect(isSlashCommand('/var/log/syslog check this')).toBe(false);
      expect(isSlashCommand('/home/user/.qwen/settings.json')).toBe(false);
      expect(isSlashCommand('/tmp/test.txt')).toBe(false);
      expect(isSlashCommand('/tmp\\test.txt')).toBe(false);
    });
  });

  describe('copyToClipboard', () => {
    describe('on macOS (darwin)', () => {
      beforeEach(() => {
        mockProcess.platform = 'darwin';
      });

      it('should successfully copy text to clipboard using pbcopy', async () => {
        const testText = 'Hello, world!';

        // Simulate successful execution
        setTimeout(() => {
          mockChild.emit('close', 0);
        }, 0);

        await copyToClipboard(testText);

        expect(mockSpawn).toHaveBeenCalledWith('pbcopy', []);
        expect(mockChild.stdin.write).toHaveBeenCalledWith(testText);
        expect(mockChild.stdin.end).toHaveBeenCalled();
      });

      it('should handle pbcopy command failure', async () => {
        const testText = 'Hello, world!';

        // Simulate command failure
        setTimeout(() => {
          mockChild.stderr.emit('data', 'Command not found');
          mockChild.emit('close', 1);
        }, 0);

        await expect(copyToClipboard(testText)).rejects.toThrow(
          "'pbcopy' exited with code 1: Command not found",
        );
      });

      it('should handle spawn error', async () => {
        const testText = 'Hello, world!';

        setTimeout(() => {
          mockChild.emit('error', new Error('spawn error'));
        }, 0);

        await expect(copyToClipboard(testText)).rejects.toThrow('spawn error');
      });

      it('should handle stdin write error', async () => {
        const testText = 'Hello, world!';

        setTimeout(() => {
          mockChild.stdin.emit('error', new Error('stdin error'));
        }, 0);

        await expect(copyToClipboard(testText)).rejects.toThrow('stdin error');
      });
    });

    describe('on Windows (win32)', () => {
      beforeEach(() => {
        mockProcess.platform = 'win32';
      });

      it('should successfully copy text to clipboard using clip', async () => {
        const testText = 'Hello, world!';

        setTimeout(() => {
          mockChild.emit('close', 0);
        }, 0);

        await copyToClipboard(testText);

        expect(mockSpawn).toHaveBeenCalledWith('cmd', [
          '/c',
          `chcp ${CodePage.UTF8} >nul && clip`,
        ]);
        expect(mockChild.stdin.write).toHaveBeenCalledWith(testText);
        expect(mockChild.stdin.end).toHaveBeenCalled();
      });
    });

    describe('on Linux', () => {
      beforeEach(() => {
        mockProcess.platform = 'linux';
      });

      it('should successfully copy text to clipboard using xclip', async () => {
        const testText = 'Hello, world!';
        const linuxOptions: SpawnOptions = {
          stdio: ['pipe', 'inherit', 'pipe'],
        };

        setTimeout(() => {
          mockChild.emit('close', 0);
        }, 0);

        await copyToClipboard(testText);

        expect(mockSpawn).toHaveBeenCalledWith(
          'xclip',
          ['-selection', 'clipboard'],
          linuxOptions,
        );
        expect(mockChild.stdin.write).toHaveBeenCalledWith(testText);
        expect(mockChild.stdin.end).toHaveBeenCalled();
      });

      it('should fall back to xsel when xclip fails', async () => {
        const testText = 'Hello, world!';
        let callCount = 0;
        const linuxOptions: SpawnOptions = {
          stdio: ['pipe', 'inherit', 'pipe'],
        };

        mockSpawn.mockImplementation(() => {
          const child = Object.assign(new EventEmitter(), {
            stdin: Object.assign(new EventEmitter(), {
              write: vi.fn(),
              end: vi.fn(),
            }),
            stderr: new EventEmitter(),
          }) as MockChildProcess;

          setTimeout(() => {
            if (callCount === 0) {
              // First call (xclip) fails
              const error = new Error('spawn xclip ENOENT');
              (error as NodeJS.ErrnoException).code = 'ENOENT';
              child.emit('error', error);
              child.emit('close', 1);
              callCount++;
            } else {
              // Second call (xsel) succeeds
              child.emit('close', 0);
            }
          }, 0);

          return child as unknown as ReturnType<typeof spawn>;
        });

        await copyToClipboard(testText);

        expect(mockSpawn).toHaveBeenCalledTimes(2);
        expect(mockSpawn).toHaveBeenNthCalledWith(
          1,
          'xclip',
          ['-selection', 'clipboard'],
          linuxOptions,
        );
        expect(mockSpawn).toHaveBeenNthCalledWith(
          2,
          'xsel',
          ['--clipboard', '--input'],
          linuxOptions,
        );
      });

      it('should throw error when both xclip and xsel are not found', async () => {
        const testText = 'Hello, world!';
        let callCount = 0;
        const linuxOptions: SpawnOptions = {
          stdio: ['pipe', 'inherit', 'pipe'],
        };

        mockSpawn.mockImplementation(() => {
          const child = Object.assign(new EventEmitter(), {
            stdin: Object.assign(new EventEmitter(), {
              write: vi.fn(),
              end: vi.fn(),
            }),
            stderr: new EventEmitter(),
          }) as MockChildProcess;

          setTimeout(() => {
            if (callCount === 0) {
              // First call (xclip) fails with ENOENT
              const error = new Error('spawn xclip ENOENT');
              (error as NodeJS.ErrnoException).code = 'ENOENT';
              child.emit('error', error);
              child.emit('close', 1);
              callCount++;
            } else {
              // Second call (xsel) fails with ENOENT
              const error = new Error('spawn xsel ENOENT');
              (error as NodeJS.ErrnoException).code = 'ENOENT';
              child.emit('error', error);
              child.emit('close', 1);
            }
          }, 0);

          return child as unknown as ReturnType<typeof spawn>;
        });
        await expect(copyToClipboard(testText)).rejects.toThrow(
          'Please ensure xclip or xsel is installed and configured.',
        );

        expect(mockSpawn).toHaveBeenCalledTimes(2);
        expect(mockSpawn).toHaveBeenNthCalledWith(
          1,
          'xclip',
          ['-selection', 'clipboard'],
          linuxOptions,
        );
        expect(mockSpawn).toHaveBeenNthCalledWith(
          2,
          'xsel',
          ['--clipboard', '--input'],
          linuxOptions,
        );
      });

      it('should emit error when xclip or xsel fail with stderr output (command installed)', async () => {
        const testText = 'Hello, world!';
        let callCount = 0;
        const linuxOptions: SpawnOptions = {
          stdio: ['pipe', 'inherit', 'pipe'],
        };
        const errorMsg = "Error: Can't open display:";
        const exitCode = 1;

        mockSpawn.mockImplementation(() => {
          const child = Object.assign(new EventEmitter(), {
            stdin: Object.assign(new EventEmitter(), {
              write: vi.fn(),
              end: vi.fn(),
            }),
            stderr: new EventEmitter(),
          }) as MockChildProcess;

          setTimeout(() => {
            // e.g., cannot connect to X server
            if (callCount === 0) {
              child.stderr.emit('data', errorMsg);
              child.emit('close', exitCode);
              callCount++;
            } else {
              child.stderr.emit('data', errorMsg);
              child.emit('close', exitCode);
            }
          }, 0);

          return child as unknown as ReturnType<typeof spawn>;
        });

        const xclipErrorMsg = `'xclip' exited with code ${exitCode}${errorMsg ? `: ${errorMsg}` : ''}`;
        const xselErrorMsg = `'xsel' exited with code ${exitCode}${errorMsg ? `: ${errorMsg}` : ''}`;

        await expect(copyToClipboard(testText)).rejects.toThrow(
          `All copy commands failed. "${xclipErrorMsg}", "${xselErrorMsg}". `,
        );

        expect(mockSpawn).toHaveBeenCalledTimes(2);
        expect(mockSpawn).toHaveBeenNthCalledWith(
          1,
          'xclip',
          ['-selection', 'clipboard'],
          linuxOptions,
        );
        expect(mockSpawn).toHaveBeenNthCalledWith(
          2,
          'xsel',
          ['--clipboard', '--input'],
          linuxOptions,
        );
      });
    });

    describe('on unsupported platform', () => {
      beforeEach(() => {
        mockProcess.platform = 'unsupported';
      });

      it('should throw error for unsupported platform', async () => {
        await expect(copyToClipboard('test')).rejects.toThrow(
          'Unsupported platform: unsupported',
        );
      });
    });

    describe('error handling', () => {
      beforeEach(() => {
        mockProcess.platform = 'darwin';
      });

      it('should handle command exit without stderr', async () => {
        const testText = 'Hello, world!';

        setTimeout(() => {
          mockChild.emit('close', 1);
        }, 0);

        await expect(copyToClipboard(testText)).rejects.toThrow(
          "'pbcopy' exited with code 1",
        );
      });

      it('should handle empty text', async () => {
        setTimeout(() => {
          mockChild.emit('close', 0);
        }, 0);

        await copyToClipboard('');

        expect(mockChild.stdin.write).toHaveBeenCalledWith('');
      });

      it('should handle multiline text', async () => {
        const multilineText = 'Line 1\nLine 2\nLine 3';

        setTimeout(() => {
          mockChild.emit('close', 0);
        }, 0);

        await copyToClipboard(multilineText);

        expect(mockChild.stdin.write).toHaveBeenCalledWith(multilineText);
      });

      it('should handle special characters', async () => {
        const specialText = 'Special chars: !@#$%^&*()_+-=[]{}|;:,.<>?';

        setTimeout(() => {
          mockChild.emit('close', 0);
        }, 0);

        await copyToClipboard(specialText);

        expect(mockChild.stdin.write).toHaveBeenCalledWith(specialText);
      });
    });
  });

  describe('getUrlOpenCommand', () => {
    describe('on macOS (darwin)', () => {
      beforeEach(() => {
        mockProcess.platform = 'darwin';
      });
      it('should return open', () => {
        expect(getUrlOpenCommand()).toBe('open');
      });
    });

    describe('on Windows (win32)', () => {
      beforeEach(() => {
        mockProcess.platform = 'win32';
      });
      it('should return start', () => {
        expect(getUrlOpenCommand()).toBe('start');
      });
    });

    describe('on Linux (linux)', () => {
      beforeEach(() => {
        mockProcess.platform = 'linux';
      });
      it('should return xdg-open', () => {
        expect(getUrlOpenCommand()).toBe('xdg-open');
      });
    });

    describe('on unmatched OS', () => {
      beforeEach(() => {
        mockProcess.platform = 'unmatched';
      });
      it('should return xdg-open', () => {
        expect(getUrlOpenCommand()).toBe('xdg-open');
      });
    });
  });
});

describe('findMidInputSlashCommand', () => {
  it('returns null when input starts with / (handled by start-of-line completion)', () => {
    expect(findMidInputSlashCommand('/review', 7)).toBeNull();
  });

  it('returns null when cursor is before the slash token', () => {
    // "hello /review", cursor at position 3 (inside "hello")
    expect(findMidInputSlashCommand('hello /review', 3)).toBeNull();
  });

  it('returns match when cursor is exactly at the end of the token', () => {
    // "hello /re", cursor at end (offset=9)
    const result = findMidInputSlashCommand('hello /re', 9);
    expect(result).toEqual({
      token: '/re',
      startPos: 6,
      partialCommand: 're',
    });
  });

  it('returns null when cursor is inside the token (not at the end)', () => {
    // "hello /review", cursor at offset 9 (inside 'review')
    // slashPos=6, fullCommand="review"(len=6), end=13 → 9 !== 13 → null
    expect(findMidInputSlashCommand('hello /review', 9)).toBeNull();
  });

  it('returns null when cursor has moved past the token into a space', () => {
    // "hello /review ", cursor at offset 14 (after the trailing space)
    expect(findMidInputSlashCommand('hello /review ', 14)).toBeNull();
  });

  it('returns match for empty partial (cursor immediately after /)', () => {
    // partialCommand="" → getBestSlashCommandMatch will return null, but
    // findMidInputSlashCommand itself should return the match object
    const result = findMidInputSlashCommand('hello /', 7);
    expect(result).toEqual({
      token: '/',
      startPos: 6,
      partialCommand: '',
    });
  });

  it('returns null when / is not preceded by whitespace', () => {
    // "hello/review", no space before slash
    expect(findMidInputSlashCommand('hello/review', 12)).toBeNull();
  });
});

describe('findSlashCommandTokens', () => {
  const mockCommands = [
    {
      name: 'review',
      description: 'Review code',
      kind: 'built-in' as const,
      modelInvocable: true,
      userInvocable: true,
      hidden: false,
    },
    {
      name: 'clear',
      description: 'Clear conversation',
      kind: 'built-in' as const,
      modelInvocable: false,
      userInvocable: true,
      hidden: false,
    },
    {
      name: 'hidden-cmd',
      description: 'Hidden',
      kind: 'built-in' as const,
      modelInvocable: true,
      userInvocable: true,
      hidden: true,
    },
  ] as Parameters<typeof findSlashCommandTokens>[1];

  it('returns empty array for empty text', () => {
    expect(findSlashCommandTokens('', mockCommands)).toEqual([]);
  });

  it('marks line-start known command as valid', () => {
    const tokens = findSlashCommandTokens('/clear some args', mockCommands);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ commandName: 'clear', valid: true });
  });

  it('marks line-start hidden command as invalid', () => {
    const tokens = findSlashCommandTokens('/hidden-cmd', mockCommands);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({
      commandName: 'hidden-cmd',
      valid: false,
    });
  });

  it('marks mid-input modelInvocable command as valid', () => {
    const tokens = findSlashCommandTokens(
      'please /review this code',
      mockCommands,
    );
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ commandName: 'review', valid: true });
  });

  it('marks mid-input non-modelInvocable command as invalid', () => {
    const tokens = findSlashCommandTokens(
      'please /clear everything',
      mockCommands,
    );
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ commandName: 'clear', valid: false });
  });

  it('marks unknown token as invalid', () => {
    const tokens = findSlashCommandTokens('/usr/bin/something', mockCommands);
    // /usr matches nothing, so invalid
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ commandName: 'usr', valid: false });
  });

  it('returns correct start and end positions', () => {
    const text = 'run /review now';
    const tokens = findSlashCommandTokens(text, mockCommands);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].start).toBe(4);
    expect(tokens[0].end).toBe(11); // '/review' is 7 chars, starts at 4
  });

  it('marks altName token as valid (line-start)', () => {
    const commandsWithAlt = [
      ...mockCommands,
      {
        name: 'stats',
        description: 'Show stats',
        kind: 'built-in' as const,
        modelInvocable: false,
        userInvocable: true,
        hidden: false,
        altNames: ['usage'],
      },
    ] as Parameters<typeof findSlashCommandTokens>[1];

    const tokens = findSlashCommandTokens('/usage', commandsWithAlt);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ commandName: 'usage', valid: true });
  });
});

// ---------------------------------------------------------------------------
// getBestSlashCommandMatch
// ---------------------------------------------------------------------------
describe('getBestSlashCommandMatch', () => {
  const makeCommand = (
    name: string,
    opts: {
      modelInvocable?: boolean;
      completionPriority?: number;
      argumentHint?: string;
      altNames?: string[];
    } = {},
  ) =>
    ({
      name,
      description: `${name} desc`,
      kind: 'built-in',
      modelInvocable: opts.modelInvocable ?? true,
      completionPriority: opts.completionPriority ?? 0,
      argumentHint: opts.argumentHint,
      altNames: opts.altNames,
      userInvocable: true,
      hidden: false,
    }) as Parameters<typeof getBestSlashCommandMatch>[1][number];

  const cmds = [
    makeCommand('review', { completionPriority: 5 }),
    makeCommand('refactor', { completionPriority: 3 }),
    makeCommand('run', { completionPriority: 1 }),
  ];

  it('returns null for empty partialCommand', () => {
    expect(getBestSlashCommandMatch('', cmds)).toBeNull();
  });

  it('returns null when no commands match', () => {
    expect(getBestSlashCommandMatch('xyz', cmds)).toBeNull();
  });

  it('returns null for non-modelInvocable commands', () => {
    const nonInvocable = [makeCommand('reset', { modelInvocable: false })];
    expect(getBestSlashCommandMatch('re', nonInvocable)).toBeNull();
  });

  it('returns the best prefix match by completionPriority', () => {
    // 'r' matches review(5), refactor(3), run(1) — highest priority wins
    const result = getBestSlashCommandMatch('r', cmds);
    expect(result).not.toBeNull();
    expect(result!.fullCommand).toBe('review');
    expect(result!.suffix).toBe('eview');
  });

  it('returns argumentHint when command has one', () => {
    const withHint = [makeCommand('ask', { argumentHint: '<query>' })];
    const result = getBestSlashCommandMatch('as', withHint);
    expect(result!.argumentHint).toBe('<query>');
  });

  it('respects recentCommands ordering (recent overrides lower priority)', () => {
    // 'r' matches review(5), refactor(3), run(1)
    // Make 'run' recently used — but completionPriority takes precedence
    const recentCommands: RecentSlashCommands = new Map([
      ['run', { name: 'run', usedAt: Date.now(), count: 10 }],
    ]);
    const result = getBestSlashCommandMatch('r', cmds, recentCommands);
    // completionPriority is checked first, so review (priority=5) still wins
    expect(result!.fullCommand).toBe('review');
  });

  it('uses recentCommands to break a tie in completionPriority', () => {
    const tied = [
      makeCommand('alpha', { completionPriority: 5 }),
      makeCommand('albet', { completionPriority: 5 }),
    ];
    const recentCommands: RecentSlashCommands = new Map([
      ['albet', { name: 'albet', usedAt: Date.now(), count: 1 }],
    ]);
    const result = getBestSlashCommandMatch('al', tied, recentCommands);
    expect(result!.fullCommand).toBe('albet');
  });

  it('excludes exact-match commands without argumentHint', () => {
    // 'review' exactly matches 'review' with no argumentHint → excluded
    const result = getBestSlashCommandMatch('review', cmds);
    expect(result).toBeNull();
  });

  it('includes exact-match command when it has argumentHint', () => {
    const withHint = [makeCommand('review', { argumentHint: '<file>' })];
    const result = getBestSlashCommandMatch('review', withHint);
    expect(result).not.toBeNull();
    expect(result!.suffix).toBe('');
  });
});
