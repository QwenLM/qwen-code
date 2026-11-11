/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  validateFlags,
  isSingleCommandReadOnly,
  type CommandReadOnlySpec,
} from './shellCommandValidation.js';

// ============================================================================
// validateFlags unit tests
// ============================================================================

describe('validateFlags', () => {
  const basicConfig: CommandReadOnlySpec = {
    safeFlags: {
      '-v': 'none',
      '--verbose': 'none',
      '-n': 'number',
      '--count': 'number',
      '-f': 'string',
      '--format': 'string',
      '-d': 'char',
      '--delimiter': 'char',
      '-l': 'none',
      '-a': 'none',
      '-h': 'none',
      '-r': 'none',
      '--sort': 'string',
    },
  };

  describe('long flags with = value', () => {
    it('accepts --flag=value for string type', () => {
      expect(validateFlags(['cmd', '--format=json'], 1, basicConfig)).toBe(
        true,
      );
    });
    it('accepts --flag=value for number type', () => {
      expect(validateFlags(['cmd', '--count=5'], 1, basicConfig)).toBe(true);
    });
    it('accepts --flag= (empty inline value)', () => {
      expect(validateFlags(['cmd', '--format='], 1, basicConfig)).toBe(true);
    });
    it('rejects unknown --flag=value', () => {
      expect(validateFlags(['cmd', '--unknown=value'], 1, basicConfig)).toBe(
        false,
      );
    });
  });

  describe('long flags with separate value', () => {
    it('accepts --flag value for string type', () => {
      expect(validateFlags(['cmd', '--format', 'json'], 1, basicConfig)).toBe(
        true,
      );
    });
    it('accepts --flag value for number type', () => {
      expect(validateFlags(['cmd', '--count', '5'], 1, basicConfig)).toBe(true);
    });
    it('rejects missing argument at end of tokens', () => {
      expect(validateFlags(['cmd', '--count'], 1, basicConfig)).toBe(false);
    });
    it('rejects non-numeric value for number type', () => {
      expect(validateFlags(['cmd', '--count', 'abc'], 1, basicConfig)).toBe(
        false,
      );
    });
    it('allows negative numbers for number type', () => {
      expect(validateFlags(['cmd', '--count', '-1'], 1, basicConfig)).toBe(
        true,
      );
    });
    it('rejects string arg starting with - (potential confusion)', () => {
      expect(validateFlags(['cmd', '--format', '-json'], 1, basicConfig)).toBe(
        false,
      );
    });
    it('allows --sort with value starting with - (reverse sort keys)', () => {
      expect(validateFlags(['cmd', '--sort', '-refname'], 1, basicConfig)).toBe(
        true,
      );
    });
  });

  describe('unknown flags — fail closed', () => {
    it('rejects unknown long flag', () => {
      expect(validateFlags(['cmd', '--unknown'], 1, basicConfig)).toBe(false);
    });
    it('rejects unknown short flag', () => {
      expect(validateFlags(['cmd', '-z'], 1, basicConfig)).toBe(false);
    });
  });

  describe('attached short flag values', () => {
    it('accepts attached numeric value (-n5)', () => {
      expect(validateFlags(['cmd', '-n5'], 1, basicConfig)).toBe(true);
    });
    it('accepts attached numeric value (-n20)', () => {
      expect(validateFlags(['cmd', '-n20'], 1, basicConfig)).toBe(true);
    });
    it('accepts attached string value (-fjson)', () => {
      expect(validateFlags(['cmd', '-fjson'], 1, basicConfig)).toBe(true);
    });
    it('rejects attached value starting with - (-f-path)', () => {
      expect(validateFlags(['cmd', '-f-path'], 1, basicConfig)).toBe(false);
    });
  });

  describe('bundled short flags', () => {
    it('accepts valid bundle (-la)', () => {
      expect(validateFlags(['cmd', '-la'], 1, basicConfig)).toBe(true);
    });
    it('accepts valid bundle (-vlah)', () => {
      expect(validateFlags(['cmd', '-vlah'], 1, basicConfig)).toBe(true);
    });
    it('rejects bundle containing value-taking flag (-ln)', () => {
      // -n takes a number, so it can't be bundled
      expect(validateFlags(['cmd', '-ln'], 1, basicConfig)).toBe(false);
    });
    it('rejects bundle with unknown flag (-lz)', () => {
      expect(validateFlags(['cmd', '-lz'], 1, basicConfig)).toBe(false);
    });
  });

  describe('-- end-of-options', () => {
    it('stops flag parsing at --', () => {
      // --unknown after -- is treated as positional, not rejected
      expect(
        validateFlags(['cmd', '-v', '--', '--unknown'], 1, basicConfig),
      ).toBe(true);
    });
    it('does not stop at -- when respectsDoubleDash is false', () => {
      const noDoubleDash: CommandReadOnlySpec = {
        safeFlags: { '-v': 'none' },
        respectsDoubleDash: false,
      };
      // --unknown is now treated as a flag and rejected
      expect(
        validateFlags(['cmd', '-v', '--', '--unknown'], 1, noDoubleDash),
      ).toBe(false);
    });
  });

  describe('git numeric shorthand', () => {
    const gitConfig: CommandReadOnlySpec = {
      safeFlags: { '-n': 'number', '--oneline': 'none' },
    };

    it('accepts -5 as git numeric shorthand', () => {
      expect(
        validateFlags(['git', 'log', '-5'], 2, gitConfig, {
          commandName: 'git log',
        }),
      ).toBe(true);
    });
    it('accepts -10 as git numeric shorthand', () => {
      expect(
        validateFlags(['git', 'log', '-10'], 2, gitConfig, {
          commandName: 'git log',
        }),
      ).toBe(true);
    });
    it('rejects -5 when not a git command', () => {
      expect(
        validateFlags(['cmd', '-5'], 1, gitConfig, { commandName: 'cmd' }),
      ).toBe(false);
    });
  });

  describe('positional args allowed through', () => {
    it('allows positional args (no flag prefix)', () => {
      expect(validateFlags(['cmd', 'file.txt', 'dir/'], 1, basicConfig)).toBe(
        true,
      );
    });
    it('allows mix of flags and positionals', () => {
      expect(
        validateFlags(
          ['cmd', '-v', 'file.txt', '--count', '3'],
          1,
          basicConfig,
        ),
      ).toBe(true);
    });
  });

  describe('$VAR and brace expansion rejection', () => {
    // This is tested at the isSingleCommandReadOnly level since
    // validateFlags itself doesn't check for $VAR — that's done
    // by the caller (validateCommandViaFlagParsing)
    it('isSingleCommandReadOnly rejects $VAR in args', () => {
      expect(isSingleCommandReadOnly('cat $HOME/file')).toBe(false);
    });
    it('isSingleCommandReadOnly rejects ${VAR} in args', () => {
      expect(isSingleCommandReadOnly('cat ${HOME}/file')).toBe(false);
    });
    it('isSingleCommandReadOnly rejects brace expansion', () => {
      expect(isSingleCommandReadOnly('cat file{1,2}.txt')).toBe(false);
    });
  });
});

// ============================================================================
// isSingleCommandReadOnly integration tests
// ============================================================================

describe('isSingleCommandReadOnly', () => {
  describe('commands validated via flag parsing', () => {
    it('validates grep with standard flags', () => {
      expect(isSingleCommandReadOnly('grep -rn TODO src/')).toBe(true);
    });
    it('validates rg with standard flags', () => {
      expect(isSingleCommandReadOnly('rg -i --type ts pattern src/')).toBe(
        true,
      );
    });
    it('validates git log with numeric shorthand', () => {
      expect(isSingleCommandReadOnly('git log -5')).toBe(true);
    });
    it('validates git log with attached count', () => {
      expect(isSingleCommandReadOnly('git log --oneline -n 10')).toBe(true);
    });
    it('validates git branch --show-current', () => {
      expect(isSingleCommandReadOnly('git branch --show-current')).toBe(true);
    });
    it('validates read-only shell builtins', () => {
      expect(isSingleCommandReadOnly('echo "---"')).toBe(true);
      expect(isSingleCommandReadOnly("printf '%s\\n' hello")).toBe(true);
    });
    it('validates sort with char flag', () => {
      expect(isSingleCommandReadOnly('sort -t : -k 1,1 file.txt')).toBe(true);
    });
    it('validates find with safe predicates', () => {
      expect(isSingleCommandReadOnly('find . -name "*.ts" -type f')).toBe(true);
    });
    it('rejects find with -exec', () => {
      expect(isSingleCommandReadOnly('find . -exec rm {} ;')).toBe(false);
    });
    it('rejects sort with -o (writes file)', () => {
      expect(isSingleCommandReadOnly('sort -o out.txt input.txt')).toBe(false);
    });
    it('rejects wc --files0-from because it reads indirect file paths', () => {
      expect(isSingleCommandReadOnly('wc --files0-from=file-list.txt')).toBe(
        false,
      );
    });
  });

  describe('commands validated via regex fallback', () => {
    it('validates pwd', () => {
      expect(isSingleCommandReadOnly('pwd')).toBe(true);
    });
    it('rejects pwd flags outside the exact read-only form', () => {
      expect(isSingleCommandReadOnly('pwd -P')).toBe(false);
    });
    it('keeps existing type queries on the regex validator', () => {
      expect(isSingleCommandReadOnly('type -a node')).toBe(true);
    });
    it('validates whoami', () => {
      expect(isSingleCommandReadOnly('whoami')).toBe(true);
    });
    it('validates cat with file args', () => {
      expect(isSingleCommandReadOnly('cat package.json')).toBe(true);
    });
    it('validates ls -la', () => {
      expect(isSingleCommandReadOnly('ls -la')).toBe(true);
    });
    it('validates version check', () => {
      expect(isSingleCommandReadOnly('node -v')).toBe(true);
    });
  });

  describe('dangerous commands rejected', () => {
    it('rejects command substitution (backticks)', () => {
      expect(isSingleCommandReadOnly('cat `echo /etc/passwd`')).toBe(false);
    });
    it('rejects shell operators', () => {
      expect(isSingleCommandReadOnly('cat file.txt | grep foo')).toBe(false);
    });
    it('rejects unquoted $VAR', () => {
      expect(isSingleCommandReadOnly('cat $HOME/.ssh/id_rsa')).toBe(false);
    });
    it('rejects uniq with output file', () => {
      expect(isSingleCommandReadOnly('uniq input.txt output.txt')).toBe(false);
    });
    it('rejects tail -f (streaming)', () => {
      expect(isSingleCommandReadOnly('tail -f app.log')).toBe(false);
    });
    it('rejects tail -F (streaming)', () => {
      expect(isSingleCommandReadOnly('tail -F app.log')).toBe(false);
    });
    it('rejects tail --follow (streaming)', () => {
      expect(isSingleCommandReadOnly('tail --follow app.log')).toBe(false);
    });
    it('rejects unsafe builtin invocations', () => {
      expect(isSingleCommandReadOnly('echo "$HOME"')).toBe(false);
      expect(isSingleCommandReadOnly("printf -v result '%s' value")).toBe(
        false,
      );
      expect(isSingleCommandReadOnly("printf '%d' 'items[index]'")).toBe(false);
    });
  });

  describe('2>&1 handling', () => {
    it('strips trailing 2>&1 and validates', () => {
      expect(isSingleCommandReadOnly('cat file.txt 2>&1')).toBe(true);
    });
    it('rejects dangerous command even with 2>&1', () => {
      expect(isSingleCommandReadOnly('rm -rf / 2>&1')).toBe(false);
    });
  });

  describe('new Phase 4B commands', () => {
    it('validates sha256sum', () => {
      expect(isSingleCommandReadOnly('sha256sum package.json')).toBe(true);
    });
    it('validates tree -L 2', () => {
      expect(isSingleCommandReadOnly('tree -L 2 src')).toBe(true);
    });
    it('rejects tree -o (writes file)', () => {
      expect(isSingleCommandReadOnly('tree -o out.txt')).toBe(false);
    });
    it('validates git ls-remote origin', () => {
      expect(isSingleCommandReadOnly('git ls-remote origin')).toBe(true);
    });
    it('rejects git ls-remote with URL', () => {
      expect(
        isSingleCommandReadOnly('git ls-remote https://github.com/a/b'),
      ).toBe(false);
    });
  });
});
