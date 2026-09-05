/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, mkdtempSync } from 'node:fs';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  getShellConfiguration,
  GitWorktreeService,
  splitCommands,
  ToolNames,
} from '@qwen-code/qwen-code-core';
import type { ExternalToolGuardPrepareRequest } from '@qwen-code/acp-bridge/bridgeOptions';
import { SHELL_EXECUTING_TOOL_NAMES } from '@qwen-code/acp-bridge/externalToolGuard';
import {
  containsCmdRewriteSyntax,
  containsUnmodelledWindowsSyntax,
  createDaemonToolGuard,
  preserveWindowsPathSeparators,
} from './daemon-git-worktree-guard.js';

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'daemon-guard-'));
const effectiveCwd = path.join(temporaryRoot, 'workspace', 'worktree');
const insideNested = path.join(effectiveCwd, 'nested');
const outsideRepo = path.join(temporaryRoot, 'outside', 'repo');
// A second outside checkout whose path contains no Git word, so a test using
// it cannot pass because `\bgit\b` happened to match inside the path.
const plainOutsidePath = path.join(temporaryRoot, 'elsewhere', 'checkout');
// Spelling for paths interpolated into COMMAND STRINGS on the lanes that
// execute through bash: an unquoted backslash is a POSIX escape, so a native
// Windows path pasted into a command reaches the tokenizer as `C:temprepo`
// and the test stops exercising what it names — resolvable targets become
// unresolvable ones, and cwd shifts silently fail in place. Forward slashes
// survive bash and resolve identically on Windows. Filesystem setup and
// denial-reason assertions keep the native spelling: the guard canonicalizes
// targets through realpath before printing them.
const cmdPath = (value: string): string =>
  process.platform === 'win32' ? value.replaceAll('\\', '/') : value;
mkdirSync(path.join(outsideRepo, '.git'), { recursive: true });
mkdirSync(insideNested, { recursive: true });

function request(
  command: string,
  extraArguments: Record<string, unknown> = {},
): ExternalToolGuardPrepareRequest {
  return {
    sessionId: 'session-1',
    promptId: 'prompt-1',
    toolCallId: 'call-1',
    toolName: 'run_shell_command',
    arguments: { command, ...extraArguments },
    effectiveCwd,
  } as ExternalToolGuardPrepareRequest;
}

// Bash-semantics expectations only mean what they say on lanes that execute
// through bash: on the win32 cmd/PowerShell lanes the divergent-syntax gate
// denies those shapes before any analysis reads them.
const bashSemanticsLane =
  process.platform !== 'win32' || getShellConfiguration().shell === 'bash';

afterAll(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe('createDaemonToolGuard', () => {
  it.each([
    () => `git -C ${cmdPath(outsideRepo)} reset --hard`,
    () => `git -C${cmdPath(outsideRepo)} checkout -- .`,
    () =>
      `git --work-tree=${cmdPath(outsideRepo)} --git-dir=${cmdPath(path.join(outsideRepo, '.git'))} clean -fd`,
    () =>
      `git --git-dir ${cmdPath(path.join(outsideRepo, '.git'))} commit -m x`,
    () => `git --namespace foo -C ${cmdPath(outsideRepo)} reset --hard`,
    () =>
      `git --super-prefix=foo --work-tree=${cmdPath(outsideRepo)} clean -fd`,
    // `grep` runs the target repo's diff.<driver>.textconv programs and
    // `status` refreshes the target index + runs its core.fsmonitor.
    () => `git -C ${cmdPath(outsideRepo)} grep --textconv pattern`,
    () => `git -C ${cmdPath(outsideRepo)} status --porcelain`,
  ])('denies relocated mutating Git command %#', async (buildCommand) => {
    const guard = createDaemonToolGuard();

    await expect(guard(request(buildCommand()))).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining(outsideRepo),
    });
  });

  it('allows relocated read-only Git commands', async () => {
    const guard = createDaemonToolGuard();

    await expect(
      guard(request(`git -C ${outsideRepo} rev-parse HEAD`)),
    ).resolves.toEqual({ allowed: true });
  });

  it.each([
    `git -C ${outsideRepo} diff`,
    `git -C ${outsideRepo} log -p`,
    `git -C ${outsideRepo} show --output=${path.join(outsideRepo, 'out.txt')} HEAD`,
  ])(
    'denies relocated Git subcommands that can execute target-repo config or write files',
    async (command) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(command))).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  it.each([
    `git -C ${outsideRepo} branch -D topic`,
    `git -C ${outsideRepo} remote add origin example.invalid/repo`,
  ])(
    'denies relocated Git subcommands that can mutate state',
    async (command) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(command))).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  it('denies dynamic repository relocation for mutating commands', async () => {
    const guard = createDaemonToolGuard();

    await expect(
      guard(request('git -C "$OTHER_WORKTREE" reset --hard')),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining('dynamic repository location'),
    });
  });

  it.each([
    'git -C `echo /outside/repo` reset --hard',
    'git -C ~/repos/other-checkout reset --hard',
    'git -C /outside/repo* reset --hard',
  ])('denies shell-expansion relocation forms %#', async (command) => {
    const guard = createDaemonToolGuard();

    await expect(guard(request(command))).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining('dynamic repository location'),
    });
  });

  // `$'…'` ANSI-C quoting and `$(…)` substitution are bash spellings; the
  // Windows lanes deny them at the divergent-syntax gate before analysis.
  it
    .runIf(bashSemanticsLane)
    .each([
      "git $'-C' /outside/repo reset --hard",
      "$'git' -C /outside/repo reset --hard",
      'git $(echo -C) /outside/repo reset --hard',
    ])(
    'denies shell-expansion relocation forms on the bash lanes %#',
    async (command) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(command))).resolves.toMatchObject({
        allowed: false,
        reason: expect.stringContaining('dynamic repository location'),
      });
    },
  );

  it.each([
    // Git treats an empty `-C` as a no-op and applies the next relocation.
    () => `git -C "" -C ${cmdPath(outsideRepo)} reset --hard`,
  ])('denies relocations masked by token edge cases %#', async (command) => {
    const guard = createDaemonToolGuard();

    await expect(guard(request(command()))).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining(outsideRepo),
    });
  });

  // A trailing `#` comment is a bash construct; on the cmd.exe lane the `#`
  // is ordinary argv text and the divergent-syntax gate owns the shape.
  it
    .runIf(bashSemanticsLane)
    .each([() => `git -C ${cmdPath(outsideRepo)} reset --hard # note`])(
    'denies relocations masked by token edge cases on the bash lanes %#',
    async (command) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(command()))).resolves.toMatchObject({
        allowed: false,
        reason: expect.stringContaining(outsideRepo),
      });
    },
  );

  it.each(['git -C', 'git --git-dir', 'git --work-tree='])(
    'fails closed on a dangling relocation option',
    async (command) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(command))).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  it('allows mutating Git commands inside the effective working directory', async () => {
    const guard = createDaemonToolGuard();

    await expect(guard(request('git -C nested reset --hard'))).resolves.toEqual(
      { allowed: true },
    );
  });

  it('resolves relative targets from the explicit shell directory', async () => {
    const guard = createDaemonToolGuard();

    await expect(
      guard(request('git -C .. reset --hard', { directory: insideNested })),
    ).resolves.toEqual({ allowed: true });
    await expect(
      guard(
        request(
          `git -C ${path.relative(insideNested, outsideRepo)} reset --hard`,
          {
            directory: insideNested,
          },
        ),
      ),
    ).resolves.toMatchObject({ allowed: false });
  });

  it.each([
    `pwd && git -C ${outsideRepo} reset --hard; true`,
    `X=1 git -C ${outsideRepo} reset --hard`,
    `env X=1 git -C ${outsideRepo} reset --hard`,
    `command git -C ${outsideRepo} reset --hard`,
    `pwd\ngit -C ${outsideRepo} reset --hard`,
  ])(
    'denies a relocated mutation inside shell command forms',
    async (command) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(command))).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  it.each([
    () => `sh -c 'git -C ${outsideRepo} reset --hard'`,
    () => `bash -c "git -C ${outsideRepo} reset --hard"`,
    () => `bash -lc 'git -C ${outsideRepo} reset --hard'`,
    () => `eval 'git -C ${outsideRepo} reset --hard'`,
    () => `sudo git -C ${outsideRepo} reset --hard`,
    () => `nohup git -C ${outsideRepo} reset --hard`,
    () => `timeout 5 git -C ${outsideRepo} reset --hard`,
    () => `exec git -C ${outsideRepo} reset --hard`,
    () => `/usr/bin/git -C ${outsideRepo} reset --hard`,
    () => `./bin/git -C ${outsideRepo} reset --hard`,
    () => `{ git -C ${outsideRepo} reset --hard; }`,
    () => `! git -C ${outsideRepo} reset --hard`,
    () => `env -S 'git -C ${outsideRepo} reset --hard'`,
  ])(
    'denies a relocated mutation through wrapper invocations %#',
    async (buildCommand) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(buildCommand()))).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  it.each([
    () => `cd ${outsideRepo} && git reset --hard`,
    () => `pushd ${outsideRepo} && git reset --hard`,
    () => `(cd ${outsideRepo} && git reset --hard)`,
    () => `eval 'cd ${outsideRepo}' && git reset --hard`,
    () => 'cd && git reset --hard',
    () => 'cd - && git reset --hard',
    () => 'popd && git reset --hard',
  ])(
    'denies mutations after a cwd-shifting builtin %#',
    async (buildCommand) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(buildCommand()))).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  it.each([
    () => `if true; then git -C ${outsideRepo} reset --hard; fi`,
    () => `if true; then cd ${outsideRepo} && git reset --hard; fi`,
    () => `for i in 1; do git -C ${outsideRepo} reset --hard; done`,
    () => `while true; do git -C ${outsideRepo} reset --hard; break; done`,
    () => `until false; do git -C ${outsideRepo} reset --hard; done`,
    () =>
      `if false; then pwd; elif true; then git -C ${outsideRepo} reset --hard; fi`,
    () => `time git -C ${outsideRepo} reset --hard`,
    () => `coproc git -C ${outsideRepo} reset --hard`,
  ])(
    'denies relocated mutations hidden behind shell keywords %#',
    async (buildCommand) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(buildCommand()))).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  it.each([() => 'bash -c "$CMD"', () => 'sh -c "$CMD" arg'])(
    'fails closed on undecidable shell payloads %#',
    async (buildCommand) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(buildCommand()))).resolves.toMatchObject({
        allowed: false,
        reason: expect.stringContaining('could not be resolved'),
      });
    },
  );

  // A substitution body runs before the command it is embedded in, so it is
  // analysed on its own instead of being folded into an opaque token.
  it.each([
    () => `echo $(git -C ${outsideRepo} reset --hard)`,
    () => `echo "$(cd ${outsideRepo} && git reset --hard)"`,
    () => `FOO=$(cd ${outsideRepo} && git reset --hard)`,
    () => `echo \`cd ${outsideRepo} && git reset --hard\``,
    () => `echo \${x:-$(git -C ${outsideRepo} reset --hard)}`,
    () => `echo $(( $(git -C ${outsideRepo} reset --hard) + 1 ))`,
    () => `sh -c "$(echo git -C ${outsideRepo} reset --hard)"`,
    () => `eval "$(echo git -C ${outsideRepo} reset --hard)"`,
  ])(
    'denies a relocated mutation inside a command substitution %#',
    async (buildCommand) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(buildCommand()))).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  it.runIf(bashSemanticsLane)(
    'allows command substitutions that stay inside the boundary',
    async () => {
      const guard = createDaemonToolGuard();

      await expect(guard(request('echo $(date)'))).resolves.toEqual({
        allowed: true,
      });
      await expect(
        guard(request('echo $(git rev-parse HEAD)')),
      ).resolves.toEqual({ allowed: true });
      await expect(
        guard(request('echo $(cd nested && git commit -m x)')),
      ).resolves.toEqual({ allowed: true });
    },
  );

  it('fails closed on an unterminated command substitution', async () => {
    const guard = createDaemonToolGuard();

    await expect(
      guard(request(`echo $(git -C ${outsideRepo} reset --hard`)),
    ).resolves.toMatchObject({ allowed: false });
  });

  it.each([
    () => `bash -c'git -C ${outsideRepo} reset --hard'`,
    () => `bash -lc'git -C ${outsideRepo} reset --hard'`,
  ])(
    'denies relocated mutations fused into the -c flag token %#',
    async (buildCommand) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(buildCommand()))).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  it.each([
    () => `cd ${outsideRepo} && sh -c 'git reset --hard'`,
    () => `cd ${outsideRepo} && bash -c 'git clean -fd'`,
    () => `cd ${outsideRepo} && eval 'git reset --hard'`,
    () => `cd ${outsideRepo}; sh -c 'git reset --hard'`,
    () => `cd ${outsideRepo} && sh -c 'cd nested && git reset --hard'`,
  ])(
    'keeps the entry cwd as the containment basis inside shell wrappers %#',
    async (buildCommand) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(buildCommand()))).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  it.runIf(bashSemanticsLane)(
    'still allows wrapper payloads that stay inside the entry cwd',
    async () => {
      const guard = createDaemonToolGuard();

      await expect(
        guard(
          request(`cd ${cmdPath(effectiveCwd)} && sh -c 'git reset --hard'`),
        ),
      ).resolves.toEqual({ allowed: true });
    },
  );

  it.each([
    () => `git -c core.fsmonitor=/tmp/evil.sh -C ${outsideRepo} status`,
  ])(
    'inspects command-executing -c config even for read-only subcommands %#',
    async (buildCommand) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(buildCommand()))).resolves.toMatchObject({
        allowed: false,
        reason: expect.stringContaining('dynamic repository location'),
      });
    },
  );

  // The quoted config value is a bash quoting shape; the Windows lanes deny
  // it at the divergent-syntax gate before the config scan.
  it
    .runIf(bashSemanticsLane)
    .each([() => `git -c alias.x='!evil' -C ${outsideRepo} status`])(
    'inspects command-executing -c config on the bash lanes %#',
    async (buildCommand) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(buildCommand()))).resolves.toMatchObject({
        allowed: false,
        reason: expect.stringContaining('dynamic repository location'),
      });
    },
  );

  it.each([
    () => `git --exec-path -C ${outsideRepo} reset --hard`,
    () => `git --list-cmds -C ${outsideRepo} reset --hard`,
  ])(
    'does not let --exec-path/--list-cmds swallow the relocation token %#',
    async (buildCommand) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(buildCommand()))).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  it('denies a model-supplied directory outside the effective working directory', async () => {
    const guard = createDaemonToolGuard();

    await expect(
      guard(request('git reset --hard', { directory: outsideRepo })),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining(outsideRepo),
    });
    await expect(
      guard(
        request('git reset --hard', {
          directory: path.relative(effectiveCwd, outsideRepo),
        }),
      ),
    ).resolves.toMatchObject({ allowed: false });
    await expect(
      guard(request('git reset --hard', { directory: insideNested })),
    ).resolves.toEqual({ allowed: true });
  });

  it.runIf(bashSemanticsLane)(
    'keeps subshell cwd shifts from leaking into later commands',
    async () => {
      const guard = createDaemonToolGuard();

      await expect(
        guard(request(`sh -c 'cd ${outsideRepo}'; git reset --hard`)),
      ).resolves.toEqual({ allowed: true });
      await expect(
        guard(request(`cd ${cmdPath(effectiveCwd)} && git reset --hard`)),
      ).resolves.toEqual({ allowed: true });
    },
  );

  it.runIf(bashSemanticsLane).each([
    () => `git -C \\
${cmdPath(outsideRepo)} reset --hard`,

    () => `g\\
it -C ${cmdPath(outsideRepo)} reset --hard`,
  ])(
    'joins backslash continuations before parsing %#',
    async (buildCommand) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(buildCommand()))).resolves.toMatchObject({
        allowed: false,
        reason: expect.stringContaining(outsideRepo),
      });
    },
  );

  it.each([
    () => `GIT_DIR=${path.join(outsideRepo, '.git')} git reset --hard`,
    () => `GIT_WORK_TREE=${outsideRepo} git reset --hard`,
    () => `GIT_COMMON_DIR=${path.join(outsideRepo, '.git')} git reset --hard`,
    () => `env GIT_DIR=${path.join(outsideRepo, '.git')} git reset --hard`,
    () => `env -C ${outsideRepo} git reset --hard`,
    () => `env --chdir=${outsideRepo} git reset --hard`,
    () => `env -u GIT_DIR git -C ${outsideRepo} reset --hard`,
    () => `sudo -D ${outsideRepo} git reset --hard`,
  ])(
    'denies repository relocation through environment forms %#',
    async (buildCommand) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(buildCommand()))).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  it.each([
    `git --git-dir=../evil/.git -C .. branch X`,
    `git -C .. --git-dir=../evil/.git branch X`,
    `git --work-tree=../evil -C .. reset --hard`,
  ])(
    'resolves relative git-dir and work-tree against the final -C cwd',
    async (command) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(command))).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  it.each([
    'git -c core.editor=evil-command commit',
    'git --config-env core.pager=evil-command log --follow',
    'git -c filter.evil.clean=evil-command add file',
  ])(
    'denies mutating subcommands with command-valued -c config',
    async (command) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(command))).resolves.toMatchObject({
        allowed: false,
        reason: expect.stringContaining('dynamic repository location'),
      });
    },
  );

  // The quoted config values are bash quoting shapes; the Windows lanes deny
  // them at the divergent-syntax gate before the config scan.
  it.runIf(bashSemanticsLane).each([
    `git -c alias.pwn='!git -C ${outsideRepo} branch pwned' pwn`,
    // Command-executing config families git runs directly.
    "git -c trailer.sign.command='evil-command' interpret-trailers",
    "git -c man.foo.cmd='evil-command' help -m git",
    "git -c sendemail.sendmailcmd='evil-command' send-email",
  ])(
    'denies command-valued -c config mutations on the bash lanes %#',
    async (command) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(command))).resolves.toMatchObject({
        allowed: false,
        reason: expect.stringContaining('dynamic repository location'),
      });
    },
  );

  it('allows harmless -c config on mutations inside the boundary', async () => {
    const guard = createDaemonToolGuard();

    await expect(
      guard(request('git -c user.name=Qwen commit --allow-empty')),
    ).resolves.toEqual({ allowed: true });
  });

  it('fails closed on commands that cannot be parsed', async () => {
    const guard = createDaemonToolGuard();

    await expect(
      guard(request('git -C ${UNBALANCED reset --hard')),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining('could not be parsed'),
    });
  });

  it('follows chained -C targets using Git semantics', async () => {
    const guard = createDaemonToolGuard();

    await expect(
      guard(request(`git -C nested -C ${cmdPath(outsideRepo)} reset --hard`)),
    ).resolves.toMatchObject({ allowed: false });
    await expect(
      guard(
        request(
          `git -C ${cmdPath(outsideRepo)} -C ${cmdPath(path.relative(outsideRepo, effectiveCwd))} reset --hard`,
        ),
      ),
    ).resolves.toEqual({ allowed: true });
  });

  // The string->string transform behind the win32 pipeline tests below,
  // pinned on every lane: the pipeline runs only in the merge_group Windows
  // lane, so a regression in this state machine would otherwise pass every
  // PR check green and first go red inside the merge queue.
  describe('preserveWindowsPathSeparators (pure mapping)', () => {
    const map = (segment: string, shell: 'cmd' | 'powershell' | 'bash') =>
      preserveWindowsPathSeparators(segment, 'win32', shell);

    it('escapes the separator before an ordinary path character', () => {
      expect(map('git -C C:\\repo\\sub', 'cmd')).toBe(
        'git -C C:\\\\repo\\\\sub',
      );
    });

    it.each([' ', '\t'])(
      'keeps whitespace after a separator as a word boundary %#',
      (whitespace) => {
        expect(map(`git -C C:\\repo\\${whitespace}-C out`, 'cmd')).toBe(
          `git -C C:\\\\repo"\\\\"${whitespace}-C out`,
        );
      },
    );

    it.each([';', '|', '&', '<', '>', '(', ')'])(
      'keeps a boundary operator after a separator delimiting %#',
      (operator) => {
        expect(map(`a\\${operator}b`, 'cmd')).toBe(`a"\\\\"${operator}b`);
      },
    );

    it('escapes a trailing separator at the end of the segment', () => {
      expect(map('git -C C:\\repo\\', 'cmd')).toBe('git -C C:\\\\repo\\\\');
    });

    it('applies the same mapping for PowerShell sessions', () => {
      expect(map('git -C C:\\repo\\ status', 'powershell')).toBe(
        'git -C C:\\\\repo"\\\\" status',
      );
    });

    it('leaves single-quoted bodies alone', () => {
      const quoted = "git -C 'C:\\repo\\ path' status";
      expect(map(quoted, 'cmd')).toBe(quoted);
    });

    it('doubles backslashes inside double-quoted bodies', () => {
      // Neither cmd.exe nor PowerShell escapes with a backslash inside
      // double quotes, and the POSIX tokenizer keeps `\\` literal there,
      // so doubling is a fixed point for both readers.
      expect(map('git -C "C:\\repo\\ path" status', 'cmd')).toBe(
        'git -C "C:\\\\repo\\\\ path" status',
      );
    });

    it('closes the double-quoted region at the quote after a backslash', () => {
      // cmd.exe and PowerShell close the region on the `"` unconditionally;
      // consuming `\"` as a POSIX escape pair leaves every splitter
      // believing the quote is still open and swallows the separators
      // after it.
      expect(map('cd "src\\" && cd ..', 'cmd')).toBe('cd "src\\\\" && cd ..');
      expect(map('git status "x\\" && git reset', 'powershell')).toBe(
        'git status "x\\\\" && git reset',
      );
    });

    it('stays off for bash-executed sessions on Windows', () => {
      const command = 'git -C C:\\repo\\ status';
      expect(map(command, 'bash')).toBe(command);
    });

    it('stays off on other platforms', () => {
      const command = 'git -C C:\\repo\\ status';
      expect(preserveWindowsPathSeparators(command, 'linux', 'cmd')).toBe(
        command,
      );
    });

    it('keeps splitCommands agreeing after a backslash-closed quote', () => {
      // Pre-fix the pre-pass consumed `\"` as a POSIX escape pair, the
      // quote never closed for splitCommands, and the whole line stayed
      // one segment while cmd.exe executes three.
      const normalized = preserveWindowsPathSeparators(
        'cd "src\\" && cd ..\\..\\outside && git reset --hard',
        'win32',
        'cmd',
      );
      expect(splitCommands(normalized)).toHaveLength(3);
    });
  });

  // The win32/cmd lane pin for the rewrite-syntax denial below, pinned on
  // every lane for the same reason the separator pre-pass is: the pipeline
  // shape only runs in the merge_group Windows lane.
  describe('containsCmdRewriteSyntax (pure predicate)', () => {
    const detects = (segment: string, shell: 'cmd' | 'powershell' | 'bash') =>
      containsCmdRewriteSyntax(segment, 'win32', shell);

    it('flags an unquoted caret', () => {
      expect(detects('git ^-C C:\\outside reset --hard', 'cmd')).toBe(true);
    });

    it('flags a caret-escaped quote', () => {
      expect(detects('git ^"status^"', 'cmd')).toBe(true);
    });

    it('flags an expansion pair', () => {
      expect(detects('git -C %USERPROFILE%\\repo reset --hard', 'cmd')).toBe(
        true,
      );
    });

    it('flags an expansion pair inside double quotes', () => {
      expect(detects('git -C "%OUTSIDE%" reset --hard', 'cmd')).toBe(true);
    });

    it('flags a delayed-expansion pair', () => {
      expect(detects('git -C C:\\a!b!c reset --hard', 'cmd')).toBe(true);
    });

    it('leaves a caret inside double quotes alone', () => {
      expect(detects('git commit -m "a ^ b"', 'cmd')).toBe(false);
    });

    it('leaves a lone percent or bang alone', () => {
      expect(detects('git -C C:\\100%\\repo status', 'cmd')).toBe(false);
      expect(detects('git commit -m "done!"', 'cmd')).toBe(false);
    });

    it.each(['powershell', 'bash'] as const)(
      'stays off for %s sessions',
      (shell) => {
        expect(detects('git ^-C C:\\outside reset --hard', shell)).toBe(false);
        expect(detects('git -C %OUTSIDE% reset --hard', shell)).toBe(false);
      },
    );

    it('stays off on other platforms', () => {
      expect(
        containsCmdRewriteSyntax('git ^-C C:\\outside reset', 'linux', 'cmd'),
      ).toBe(false);
    });
  });

  // cmd.exe has no backslash escape, so a path separator followed by
  // whitespace is a word boundary in the executed argv. These shapes only
  // mean what they say on win32 executing through cmd.exe or PowerShell,
  // where both the separator pre-pass and the path resolution are
  // Windows-aware; on other platforms — or under a win32 Git Bash session,
  // where the pre-pass stays off by design — they would exercise a chimera
  // of win32 tokenisation and POSIX path rules.
  describe.runIf(
    process.platform === 'win32' &&
      getShellConfiguration().shell !== 'bash' &&
      // The lane-spoof harness (daemon-git-worktree-guard.win32-lane.test.ts)
      // cannot supply real Windows path semantics; these shapes stay pinned
      // on the lane that really executes them.
      process.env['QWEN_DAEMON_GUARD_LANE_SPOOF'] === undefined,
  )('trailing-separator-before-flag shapes (cmd.exe argv)', () => {
    it.each([' ', '\t'])(
      'keeps whitespace after a trailing separator as a word boundary %#',
      async (whitespace) => {
        // `git -C <in>\ -C <out>` splits at the whitespace and applies BOTH
        // -C flags. Gluing the whitespace into the first value would hide
        // the second relocation inside it — the bypass this shape pins.
        const guard = createDaemonToolGuard();
        await expect(
          guard(
            request(
              `git -C ${effectiveCwd}\\${whitespace}-C ${outsideRepo} reset --hard`,
            ),
          ),
        ).resolves.toMatchObject({
          allowed: false,
          reason: expect.stringContaining(outsideRepo),
        });
      },
    );

    it('keeps a flag parked after a trailing separator visible to the analysis', async () => {
      const guard = createDaemonToolGuard();
      await expect(
        guard(
          request(
            `git -C ${effectiveCwd}\\ --git-dir=${path.join(outsideRepo, '.git')} reset --hard`,
          ),
        ),
      ).resolves.toMatchObject({ allowed: false });
    });

    it('still allows a trailing separator that stays inside the boundary', async () => {
      const guard = createDaemonToolGuard();
      await expect(
        guard(request(`git -C ${effectiveCwd}\\ reset --hard`)),
      ).resolves.toEqual({ allowed: true });
    });
  });

  // The rewrite gate reads process.platform and getShellConfiguration() at
  // call time, so spoofing both pins the cmd-lane denial on every lane — the
  // merge_group Windows lane is otherwise the only lane that executes the
  // gate, and a regression would first go red inside the merge queue.
  describe('cmd.exe rewrite-syntax denial (spoofed cmd lane)', () => {
    const savedEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      vi.spyOn(os, 'platform').mockReturnValue('win32');
      // Keep the Git Bash detectors (MSYSTEM/TERM) off so the shell
      // configuration resolves to cmd like the Windows merge lane.
      for (const key of ['MSYSTEM', 'TERM', 'ComSpec'] as const) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
      }
    });

    afterEach(() => {
      vi.restoreAllMocks();
      for (const key of ['MSYSTEM', 'TERM', 'ComSpec'] as const) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
    });

    it('denies rewrite syntax on its own reason, not the unparseable one', async () => {
      const guard = createDaemonToolGuard();
      await expect(
        guard(request('git -C %OUTSIDE_REPO% reset --hard')),
      ).resolves.toMatchObject({
        allowed: false,
        reason: expect.stringContaining('cmd.exe rewrite syntax'),
      });
    });

    it('denies a rewrite pair that only straddles a command separator', async () => {
      const guard = createDaemonToolGuard();
      await expect(
        guard(request('echo %A && git -C %B reset --hard')),
      ).resolves.toMatchObject({
        allowed: false,
        reason: expect.stringContaining('cmd.exe rewrite syntax'),
      });
    });

    it('denies caret-escaped rewrite shapes on their own reason', async () => {
      const guard = createDaemonToolGuard();
      await expect(
        guard(request(`git ^-C ${outsideRepo} reset --hard`)),
      ).resolves.toMatchObject({
        allowed: false,
        reason: expect.stringContaining('cmd.exe rewrite syntax'),
      });
      await expect(
        guard(request(`git ^"-C ${outsideRepo}^" reset --hard`)),
      ).resolves.toMatchObject({
        allowed: false,
        reason: expect.stringContaining('cmd.exe rewrite syntax'),
      });
    });

    it('keeps the unparseable reason for genuinely unparseable commands', async () => {
      const guard = createDaemonToolGuard();
      await expect(
        guard(request('git -C ${UNBALANCED reset --hard')),
      ).resolves.toMatchObject({
        allowed: false,
        reason: expect.stringContaining('could not be parsed'),
      });
    });
  });

  // The win32 lanes execute cmd.exe or PowerShell, whose grammar diverges
  // from the POSIX text model the analysis reads; the divergent-syntax gate
  // and the lane-scoped shadow/pipe models close the class structurally.
  // Spoofed so every lane pins it — the merge_group Windows lane is
  // otherwise the only lane that executes these paths.
  describe('Windows shell-surface denial (spoofed lanes)', () => {
    const savedEnv: Record<string, string | undefined> = {};

    const spoofLane = (lane: 'cmd' | 'powershell'): void => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      vi.spyOn(os, 'platform').mockReturnValue('win32');
      for (const key of ['MSYSTEM', 'TERM', 'ComSpec'] as const) {
        delete process.env[key];
      }
      if (lane === 'powershell') process.env['ComSpec'] = 'powershell.exe';
    };

    beforeEach(() => {
      for (const key of ['MSYSTEM', 'TERM', 'ComSpec'] as const) {
        savedEnv[key] = process.env[key];
      }
    });

    afterEach(() => {
      vi.restoreAllMocks();
      for (const key of ['MSYSTEM', 'TERM', 'ComSpec'] as const) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
    });

    it.each([
      // A separator glued to a path split stages before one normalization.
      () => ['cmd', `cd ${outsideRepo}\\&& git reset --hard`],
      // cmd.exe ordinary characters the POSIX model misreads.
      () => [
        'cmd',
        `git -C ${insideNested}\\#x -C ${outsideRepo} reset --hard`,
      ],
      () => [
        'cmd',
        `git -C ${insideNested}\\;x -C ${outsideRepo} reset --hard`,
      ],
      () => ['cmd', `cd ${outsideRepo} & git reset --hard`],
      () => ['cmd', `(cd ${outsideRepo}) && git reset --hard`],
      () => ['cmd', `git -C ${outsideRepo} reset --hard'suffix`],
      // bash shadow syntax defines nothing on the Windows lanes.
      () => ['cmd', `alias git='echo hi'; git -C ${outsideRepo} reset --hard`],
      () => ['cmd', `git() { :; }; git -C ${outsideRepo} reset --hard`],
      // Heredoc bodies are live commands on these lanes.
      () => ['cmd', `echo <<EOF\ncd ${outsideRepo}\nEOF\ngit reset --hard`],
      // PowerShell stop-parsing, call operator, subexpression, pipe state.
      () => ['powershell', 'git --% -C %TEMP% reset --hard'],
      () => [
        'powershell',
        `alias git='echo hi'; git -C ${outsideRepo} reset --hard`,
      ],
      () => ['powershell', `cd ${outsideRepo}; & git reset --hard`],
      () => ['powershell', `cd ${outsideRepo} | git reset --hard`],
      () => ['powershell', `$(cd ${outsideRepo}); git reset --hard`],
    ])('denies the divergent shape %#', async (build) => {
      const [lane, command] = build() as ['cmd' | 'powershell', string];
      spoofLane(lane);
      const guard = createDaemonToolGuard();
      await expect(guard(request(command))).resolves.toMatchObject({
        allowed: false,
      });
    });

    it.each([
      () => ['cmd', 'git add -A && git commit -m "x"'],
      () => ['cmd', 'cd nested && git reset --hard'],
      () => ['powershell', 'git status; git log -1'],
      // A PowerShell pipeline does not scope the session's directory away.
      () => ['powershell', 'cd nested | Out-Null; git reset --hard'],
      // `2>&1` and friends are file-descriptor plumbing in cmd.exe,
      // PowerShell and bash alike — never a command separator.
      () => ['cmd', 'git status 2>&1'],
      () => ['cmd', 'git rev-parse HEAD 1>out.txt 2>&1'],
      () => ['powershell', 'git status 2>&1'],
      () => ['powershell', 'npm test 2>&1 > out.txt'],
    ])('still allows the agreed shape %#', async (build) => {
      const [lane, command] = build() as ['cmd' | 'powershell', string];
      spoofLane(lane);
      const guard = createDaemonToolGuard();
      await expect(guard(request(command))).resolves.toEqual({
        allowed: true,
      });
    });
  });

  describe('containsUnmodelledWindowsSyntax (pure predicate)', () => {
    const detects = (segment: string, shell: 'cmd' | 'powershell' | 'bash') =>
      containsUnmodelledWindowsSyntax(segment, 'win32', shell);

    it('flags the divergent cmd.exe forms', () => {
      expect(detects('git -C in#x -C out reset', 'cmd')).toBe(true);
      expect(detects('alias git=x; git reset', 'cmd')).toBe(true);
      expect(detects('cd out & git reset', 'cmd')).toBe(true);
      expect(detects('(cd out) && git reset', 'cmd')).toBe(true);
      expect(detects("git -C 'out' reset", 'cmd')).toBe(true);
      expect(detects('"a" && "b"', 'cmd')).toBe(true);
    });

    it('flags the divergent PowerShell forms', () => {
      expect(detects('git --% -C %TEMP% reset', 'powershell')).toBe(true);
      expect(detects("git -C 'out''x' reset", 'powershell')).toBe(true);
      expect(detects('cd out; & git reset', 'powershell')).toBe(true);
      expect(detects('$(cd out); git reset', 'powershell')).toBe(true);
    });

    it('leaves agreed syntax alone', () => {
      for (const shell of ['cmd', 'powershell'] as const) {
        expect(detects('git add -A && git commit -m "x"', shell)).toBe(false);
        expect(detects('git status | more', shell)).toBe(false);
        expect(detects('a || b', shell)).toBe(false);
        // File-descriptor plumbing is identical in meaning across these
        // shells; the same exception readTopLevelSeparators makes.
        expect(detects('git status 2>&1', shell)).toBe(false);
        expect(detects('git status >NUL 2>&1', shell)).toBe(false);
        expect(detects('git status >&2', shell)).toBe(false);
        expect(detects('npm test &> out', shell)).toBe(false);
      }
      expect(detects("git -C 'out' reset", 'powershell')).toBe(false);
      expect(detects('git -C in#x reset', 'powershell')).toBe(false);
    });

    it('stays off for bash sessions and other platforms', () => {
      expect(detects('cd out & (git reset)', 'bash')).toBe(false);
      expect(containsUnmodelledWindowsSyntax('(cd out)', 'linux', 'cmd')).toBe(
        false,
      );
    });
  });

  // A Windows shell invocation hands everything after it to a grammar this
  // analysis does not model, so it fails closed on every Windows lane —
  // including Git Bash sessions, where cmd.exe and PowerShell remain
  // reachable programs; nested spellings re-enter the same rule through the
  // payload recursion. Spoofed so every lane pins it — the merge_group
  // Windows lane is otherwise the only lane that executes these paths.
  describe('Windows shell invocations fail closed (spoofed win32 lanes)', () => {
    const encoded = Buffer.from(`git -C ${outsideRepo} reset --hard`).toString(
      'base64',
    );
    const savedEnv: Record<string, string | undefined> = {};

    const spoofWindows = (shell: 'cmd' | 'powershell' | 'bash'): void => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      vi.spyOn(os, 'platform').mockReturnValue('win32');
      for (const key of ['MSYSTEM', 'TERM', 'ComSpec'] as const) {
        delete process.env[key];
      }
      if (shell === 'powershell') process.env['ComSpec'] = 'powershell.exe';
      if (shell === 'bash') process.env['MSYSTEM'] = 'MINGW64';
    };

    beforeEach(() => {
      for (const key of ['MSYSTEM', 'TERM', 'ComSpec'] as const) {
        savedEnv[key] = process.env[key];
      }
    });

    afterEach(() => {
      vi.restoreAllMocks();
      for (const key of ['MSYSTEM', 'TERM', 'ComSpec'] as const) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
    });

    it.each([
      () => ['cmd', `CMD.EXE /c "git -C ${outsideRepo} reset --hard"`],
      () => ['cmd', `powershell -EncodedCommand ${encoded}`],
      () => [
        'powershell',
        `pwsh -Command 'git -C ${outsideRepo} reset --hard'`,
      ],
      () => [
        'powershell',
        `bash -c 'cmd /c "git -C ${outsideRepo} reset --hard"'`,
      ],
    ])(
      'denies the nested shell payload on its own reason %#',
      async (build) => {
        const [lane, command] = build() as [
          'cmd' | 'powershell' | 'bash',
          string,
        ];
        spoofWindows(lane);
        const guard = createDaemonToolGuard();

        await expect(guard(request(command))).resolves.toMatchObject({
          allowed: false,
          reason: expect.stringContaining('could not be resolved'),
        });
      },
    );

    // On the win32 Git Bash lane the cmd-rewrite and divergent-syntax gates
    // stay off, so only the program-level rule can deny these payloads.
    it.each([
      () => `cmd /c "git ^-C ${outsideRepo} reset --hard"`,
      () => `bash -c 'cmd /c "git -C ${outsideRepo} reset --hard"'`,
    ])(
      'keeps the entrance closed on the win32 Git Bash lane %#',
      async (build) => {
        spoofWindows('bash');
        const guard = createDaemonToolGuard();

        await expect(guard(request(build()))).resolves.toMatchObject({
          allowed: false,
          reason: expect.stringContaining('could not be resolved'),
        });
      },
    );

    it('keeps an ordinary mention of a Windows shell allowed', async () => {
      spoofWindows('cmd');
      const guard = createDaemonToolGuard();

      await expect(guard(request('echo cmd powershell pwsh'))).resolves.toEqual(
        { allowed: true },
      );
    });
  });

  // PowerShell relocates the session and mutates the process environment
  // through spellings the POSIX text model reads as ordinary programs
  // (`Set-Location`, `$env:NAME = value`) or as nothing at all. The cd
  // family is tracked like its POSIX twins; the environment mutation the
  // model cannot read fails closed. Spoofed so every lane pins it — the
  // merge_group Windows lane is otherwise the only lane that executes it.
  describe('PowerShell state carriers (spoofed powershell lane)', () => {
    const savedEnv: Record<string, string | undefined> = {};

    const spoofPowershell = (): void => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      vi.spyOn(os, 'platform').mockReturnValue('win32');
      for (const key of ['MSYSTEM', 'TERM', 'ComSpec'] as const) {
        delete process.env[key];
      }
      process.env['ComSpec'] = 'powershell.exe';
    };

    beforeEach(() => {
      for (const key of ['MSYSTEM', 'TERM', 'ComSpec'] as const) {
        savedEnv[key] = process.env[key];
      }
    });

    afterEach(() => {
      vi.restoreAllMocks();
      for (const key of ['MSYSTEM', 'TERM', 'ComSpec'] as const) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
    });

    it.each([
      () => `Set-Location ${outsideRepo}; git reset --hard`,
      () => `sl ${outsideRepo}; git reset --hard`,
      () => `Push-Location ${outsideRepo}; git reset --hard`,
      () => `Set-Location -Path ${outsideRepo}; git reset --hard`,
    ])(
      'denies a relocation persisted through the PowerShell cd family %#',
      async (build) => {
        spoofPowershell();
        const guard = createDaemonToolGuard();
        await expect(guard(request(build()))).resolves.toMatchObject({
          allowed: false,
          reason: expect.stringContaining(outsideRepo),
        });
      },
    );

    it('fails closed on Pop-Location, whose destination is unresolvable', async () => {
      spoofPowershell();
      const guard = createDaemonToolGuard();
      await expect(
        guard(request('Pop-Location; git reset --hard')),
      ).resolves.toMatchObject({
        allowed: false,
        reason: expect.stringContaining('dynamic repository location'),
      });
    });

    it('keeps an in-boundary PowerShell move harmless', async () => {
      spoofPowershell();
      const guard = createDaemonToolGuard();
      await expect(
        guard(request(`Set-Location ${insideNested}; git reset --hard`)),
      ).resolves.toEqual({ allowed: true });
    });

    it.each([
      () => `$env:GIT_DIR='${outsideRepo}/.git'; git reset --hard`,
      () => `$env:GIT_WORK_TREE = '${outsideRepo}'; git reset --hard`,
      () => `\${env:GIT_DIR}='${outsideRepo}/.git'; git reset --hard`,
      () =>
        `[Environment]::SetEnvironmentVariable('GIT_DIR','x'); git reset --hard`,
    ])(
      'denies PowerShell environment mutation it cannot model %#',
      async (build) => {
        spoofPowershell();
        const guard = createDaemonToolGuard();
        await expect(guard(request(build()))).resolves.toMatchObject({
          allowed: false,
          reason: expect.stringContaining('Windows shell syntax'),
        });
      },
    );

    it('leaves a PowerShell environment read alone', async () => {
      spoofPowershell();
      const guard = createDaemonToolGuard();
      await expect(guard(request('echo $env:PATH'))).resolves.toEqual({
        allowed: true,
      });
    });

    it('fails closed on set, the Set-Variable alias that never touches the process environment', async () => {
      spoofPowershell();
      const guard = createDaemonToolGuard();
      await expect(
        guard(request(`set GIT_DIR=${effectiveCwd}/gd; git reset --hard`)),
      ).resolves.toMatchObject({
        allowed: false,
        reason: expect.stringContaining('dynamic repository location'),
      });
    });
  });

  // PowerShell Core is cross-platform, but cmd.exe and Windows PowerShell
  // are not: on POSIX hosts `pwsh` is just another interpreter the guard
  // does not model — the same stance as python or node — so the
  // Windows-lane fail-closed rule must not reach these lanes. Gated off the
  // lane-spoof harness, which executes this suite as win32/cmd.
  describe.runIf(
    process.platform !== 'win32' &&
      process.env['QWEN_DAEMON_GUARD_LANE_SPOOF'] === undefined,
  )('benign pwsh stays allowed on POSIX lanes', () => {
    it('allows an ordinary pwsh invocation', async () => {
      const guard = createDaemonToolGuard();

      await expect(
        guard(request('pwsh -NoProfile -Command Write-Output hello')),
      ).resolves.toEqual({ allowed: true });
    });
  });

  it('checks work-tree and git-dir targets independently', async () => {
    const guard = createDaemonToolGuard();

    await expect(
      guard(
        request(
          `git --work-tree=${effectiveCwd} --git-dir=${path.join(outsideRepo, '.git')} reset --hard`,
        ),
      ),
    ).resolves.toMatchObject({ allowed: false });
  });

  it('resolves a missing target through its nearest existing symlink ancestor', async () => {
    const localEffectiveCwd = path.join(temporaryRoot, 'sym-cwd');
    const localOutsideRepo = path.join(temporaryRoot, 'sym-outside');
    const linkedOutsideRepo = path.join(localEffectiveCwd, 'linked-outside');
    await Promise.all([
      mkdir(localEffectiveCwd, { recursive: true }),
      mkdir(localOutsideRepo, { recursive: true }),
    ]);
    await symlink(localOutsideRepo, linkedOutsideRepo);

    const guard = createDaemonToolGuard();
    await expect(
      guard({
        ...request('git -C linked-outside/missing reset --hard'),
        effectiveCwd: localEffectiveCwd,
      }),
    ).resolves.toMatchObject({ allowed: false });
  });

  it('denies relocated mutations whose target does not exist at decision time', async () => {
    const guard = createDaemonToolGuard();

    // A target that is missing now cannot be proven safe: it may exist as an
    // outward symlink by the time git runs.
    await expect(
      guard(request('git -C not-created-yet reset --hard')),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining('unresolvable repository location'),
    });
  });

  // A path the command itself re-points defeats any containment proved before
  // it runs — `bait` is still the original directory when the guard looks.
  it.each([
    () => `ln -s ${outsideRepo} link && git -C link reset --hard`,
    () =>
      `rm -rf nested && ln -s ${outsideRepo} nested && git -C nested reset --hard`,
    () => `mv ${outsideRepo} nested && git -C nested reset --hard`,
  ])(
    'denies a relocation after the command relinks a path %#',
    async (build) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(build()))).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  // Only an invocation that resolves a path is affected: renaming files and
  // then staging them is everyday work, not a relocation.
  it('leaves path-free Git alone after a rename', async () => {
    const guard = createDaemonToolGuard();

    for (const command of [
      'cp a b && git commit -m x',
      'mv old new && git add -A',
      'mv old new && git add -A && git commit -m x',
      'ln -s a b && git status',
    ]) {
      await expect(guard(request(command))).resolves.toEqual({ allowed: true });
    }
  });

  it('follows gitfile redirects before the containment check', async () => {
    // Per-test fixture: the redirect file persists for the rest of the run
    // and would change how later tests resolve targets under a shared basis.
    const localEffectiveCwd = path.join(temporaryRoot, 'gitfile-cwd');
    const localNested = path.join(localEffectiveCwd, 'nested');
    await mkdir(localNested, { recursive: true });
    await writeFile(
      path.join(localNested, '.git'),
      `gitdir: ${path.join(outsideRepo, '.git')}\n`,
    );
    const localRequest = (
      command: string,
    ): ExternalToolGuardPrepareRequest => ({
      ...request(command),
      effectiveCwd: localEffectiveCwd,
    });

    const guard = createDaemonToolGuard();
    await expect(
      guard(localRequest('git --git-dir=nested/.git branch -D topic')),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining(outsideRepo),
    });
  });

  // The `sh -c` wrapper payload is a bash spelling; the Windows lanes deny
  // it at the divergent-syntax gate before the gitfile redirect is read.
  it.runIf(bashSemanticsLane)(
    'follows gitfile redirects inside a wrapper payload',
    async () => {
      const localEffectiveCwd = path.join(temporaryRoot, 'gitfile-cwd-bash');
      const localNested = path.join(localEffectiveCwd, 'nested');
      await mkdir(localNested, { recursive: true });
      await writeFile(
        path.join(localNested, '.git'),
        `gitdir: ${path.join(outsideRepo, '.git')}\n`,
      );
      const localRequest = (
        command: string,
      ): ExternalToolGuardPrepareRequest => ({
        ...request(command),
        effectiveCwd: localEffectiveCwd,
      });

      const guard = createDaemonToolGuard();
      await expect(
        guard(localRequest(`GIT_DIR=nested/.git sh -c 'git reset --hard'`)),
      ).resolves.toMatchObject({
        allowed: false,
        reason: expect.stringContaining(outsideRepo),
      });
    },
  );

  it('canonicalizes a symlink named .git before stripping the basename', async () => {
    const localEffectiveCwd = path.join(temporaryRoot, 'symgit-cwd');
    const localNestedD = path.join(localEffectiveCwd, 'nested', 'd');
    await mkdir(localNestedD, { recursive: true });
    await symlink(
      path.join(outsideRepo, '.git'),
      path.join(localNestedD, '.git'),
    );
    const localRequest = (
      command: string,
    ): ExternalToolGuardPrepareRequest => ({
      ...request(command),
      effectiveCwd: localEffectiveCwd,
    });

    const guard = createDaemonToolGuard();
    await expect(
      guard(localRequest('git --git-dir=nested/d/.git branch -D topic')),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining(outsideRepo),
    });
  });

  it('resolves per-worktree admin directories to the linked worktree', async () => {
    const adminDir = path.join(effectiveCwd, '.git', 'worktrees', 'wt1');
    const outsideCheckout = path.join(temporaryRoot, 'outside-checkout');
    await Promise.all([
      mkdir(adminDir, { recursive: true }),
      mkdir(outsideCheckout, { recursive: true }),
    ]);
    await writeFile(
      path.join(outsideCheckout, '.git'),
      `gitdir: ${adminDir}\n`,
    );
    await writeFile(
      path.join(adminDir, 'gitdir'),
      `${path.join(outsideCheckout, '.git')}\n`,
    );

    const guard = createDaemonToolGuard();
    await expect(
      guard(request('git --git-dir=.git/worktrees/wt1 reset --hard')),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining(outsideCheckout),
    });
  });

  it('allows per-worktree admin directories whose checkout stays inside', async () => {
    const adminDir = path.join(effectiveCwd, '.git', 'worktrees', 'wt2');
    const insideCheckout = path.join(effectiveCwd, 'wt2-checkout');
    await Promise.all([
      mkdir(adminDir, { recursive: true }),
      mkdir(insideCheckout, { recursive: true }),
    ]);
    await writeFile(path.join(insideCheckout, '.git'), `gitdir: ${adminDir}\n`);
    await writeFile(
      path.join(adminDir, 'gitdir'),
      `${path.join(insideCheckout, '.git')}\n`,
    );

    const guard = createDaemonToolGuard();
    await expect(
      guard(request('git --git-dir=.git/worktrees/wt2 reset --hard')),
    ).resolves.toEqual({ allowed: true });
  });

  it('clamps long paths and strips control characters in denial reasons', async () => {
    const guard = createDaemonToolGuard();
    const longTarget = path.join(outsideRepo, 'x'.repeat(200), 'y'.repeat(200));

    const longDenial = await guard(
      request(`git -C ${longTarget} reset --hard`),
    );
    expect(longDenial).toMatchObject({ allowed: false });
    const longReason = (longDenial as { reason: string }).reason;
    expect(longReason.length).toBeLessThanOrEqual(500);
    expect(longReason).toContain('…');

    const tabTarget = path.join(temporaryRoot, 'tab\tdir');
    // Windows file names cannot contain control characters, so the fixture
    // directory cannot exist there; the guard denies the nonexistent target
    // all the same and must still strip the tab from its reason.
    if (process.platform !== 'win32') {
      await mkdir(path.join(tabTarget, '.git'), { recursive: true });
    }
    const controlDenial = await guard(
      request(`git -C '${tabTarget}' reset --hard`),
    );
    expect(controlDenial).toMatchObject({ allowed: false });
    const controlReason = (controlDenial as { reason: string }).reason;
    expect(controlReason.length).toBeLessThanOrEqual(500);
    // eslint-disable-next-line no-control-regex -- asserting control chars are stripped
    expect(controlReason).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });

  it('denies dynamic relocations even for read-only subcommands', async () => {
    const guard = createDaemonToolGuard();

    // `status` would run the target repository's core.fsmonitor, so the
    // unresolved/dangerous-config check precedes the read-only allowance.
    await expect(
      guard(request('git -C "$OTHER_WORKTREE" rev-parse')),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining('dynamic repository location'),
    });
  });

  it.each([
    () => `echo git -C ${outsideRepo} reset --hard`,
    () => `nice git -C ${outsideRepo} reset --hard`,
    () => `nice -n 5 git -C ${outsideRepo} reset --hard`,
    () => `stdbuf -o0 git -C ${outsideRepo} reset --hard`,
    () => `setsid git -C ${outsideRepo} reset --hard`,
    () => `flock /tmp/daemon-guard-lock git -C ${outsideRepo} reset --hard`,
    () => `xargs -I{} git -C ${outsideRepo} reset --hard`,
  ])(
    'fails closed when an unrecognized program may run a relocated Git command %#',
    async (buildCommand) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(buildCommand()))).resolves.toMatchObject({
        allowed: false,
        reason: expect.stringContaining('unrecognized program'),
      });
    },
  );

  // The quoted `su -c`/`find -exec sh -c` payloads are bash quoting shapes;
  // the Windows lanes deny them at the divergent-syntax gate first.
  it.runIf(bashSemanticsLane).each([
    () => `su -c 'git -C ${outsideRepo} reset --hard'`,
    () => `find . -exec git -C ${outsideRepo} reset --hard ;`,
    // `PATH=`/`GIT_EXEC_PATH=` inside an unrecognized wrapper choose which git
    // binary runs — the direct forms are denied, so the wrapper must be too.
    () => `find . -exec sh -c 'PATH=/tmp/evil git reset --hard' ';'`,
    () => `find . -exec sh -c 'GIT_EXEC_PATH=/tmp/evil git reset --hard' ';'`,
    // A relocation assignment glued to a shell delimiter inside a quoted
    // payload must still register as a marker, matching the `cd`/`pushd` arm.
    () => `su -c 'true;GIT_DIR=${outsideRepo}/.git git reset --hard'`,
    () => `su -c 'x && GIT_WORK_TREE=${outsideRepo} git reset --hard'`,
  ])(
    'fails closed on quoted-payload wrappers on the bash lanes %#',
    async (buildCommand) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(buildCommand()))).resolves.toMatchObject({
        allowed: false,
        reason: expect.stringContaining('unrecognized program'),
      });
    },
  );

  it.runIf(bashSemanticsLane)(
    'allows commands that mention Git without a relocation marker',
    async () => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(`echo 'git status'`))).resolves.toEqual({
        allowed: true,
      });
      await expect(guard(request(`grep -rn 'git reset' src`))).resolves.toEqual(
        {
          allowed: true,
        },
      );
    },
  );

  // An unrecognized program word hides what runs, so a git mention only
  // survives while the shell is provably still inside the boundary.
  it.each([
    () => `cd ${cmdPath(outsideRepo)} && nice git reset --hard`,
    () => `cd ${cmdPath(outsideRepo)} && ionice -c3 git reset --hard`,
    () => `cd ${cmdPath(outsideRepo)} && echo x | xargs -I{} git reset --hard`,
    () =>
      `cd ${cmdPath(outsideRepo)} && find . -maxdepth 0 -exec git reset --hard ;`,
    () => `cd ${cmdPath(outsideRepo)} && stdbuf -o0 git reset --hard`,
    () => 'cd - && nice git reset --hard',
  ])(
    'denies an unrecognized program running Git after a cwd shift %#',
    async (buildCommand) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(buildCommand()))).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  it('allows an unrecognized program running Git inside the boundary', async () => {
    const guard = createDaemonToolGuard();

    await expect(
      guard(request('cd nested && nice git status')),
    ).resolves.toEqual({ allowed: true });
    await expect(guard(request('nice git status'))).resolves.toEqual({
      allowed: true,
    });
  });

  // `export`/`declare -x`/`set -a` put a GIT_* relocation in the environment
  // of every later command, so it outlives the run that declared it.
  it.each([
    () => `export GIT_WORK_TREE=${outsideRepo} && git reset --hard`,
    () => `export GIT_WORK_TREE=${outsideRepo} ; git reset --hard`,
    () => `export GIT_DIR=${path.join(outsideRepo, '.git')} && git commit -m x`,
    () => `declare -x GIT_WORK_TREE=${outsideRepo} && git reset --hard`,
    () => `typeset -x GIT_WORK_TREE=${outsideRepo} && git reset --hard`,
    () => `readonly GIT_WORK_TREE=${outsideRepo} && git reset --hard`,
    () => `set -a && GIT_WORK_TREE=${outsideRepo} && git reset --hard`,
    () => `set -o allexport; GIT_WORK_TREE=${outsideRepo}; git reset --hard`,
    () => `export GIT_WORK_TREE=${outsideRepo} && sh -c 'git reset --hard'`,
    () => `export GIT_WORK_TREE=$OTHER && git reset --hard`,
  ])(
    'denies a mutation after an exported Git relocation %#',
    async (buildCommand) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(buildCommand()))).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  it('leaves unexported and unrelated assignments alone', async () => {
    const guard = createDaemonToolGuard();

    await expect(
      guard(request('export FOO=bar && git commit -m x')),
    ).resolves.toEqual({ allowed: true });
    await expect(
      guard(
        request(
          `export GIT_WORK_TREE=${cmdPath(insideNested)} && git commit -m x`,
        ),
      ),
    ).resolves.toEqual({ allowed: true });
  });

  // Without `export` (or `set -a`) the assignment stays shell-local and
  // never reaches the git process — a bash scoping rule the `;`-shaped
  // command only exercises on the bash lanes.
  it.runIf(bashSemanticsLane)(
    'keeps an unexported assignment shell-local on the bash lanes',
    async () => {
      const guard = createDaemonToolGuard();

      await expect(
        guard(request(`GIT_WORK_TREE=${outsideRepo}; echo done`)),
      ).resolves.toEqual({ allowed: true });
    },
  );

  it.each([
    () => `builtin cd ${outsideRepo} && git reset --hard`,
    () => `builtin cd -P ${outsideRepo} && git reset --hard`,
  ])('denies a mutation after `builtin cd` %#', async (buildCommand) => {
    const guard = createDaemonToolGuard();

    await expect(guard(request(buildCommand()))).resolves.toMatchObject({
      allowed: false,
    });
  });

  // `cd -P <dir>` must not resolve containment against `<cwd>/-P`: that
  // basis is inside the boundary whenever such a directory exists.
  it.each([
    () => `cd -P ${outsideRepo} && git reset --hard`,
    () => `cd -L ${outsideRepo} && git reset --hard`,
    () => `cd -eP ${outsideRepo} && git reset --hard`,
    () => `cd -- ${outsideRepo} && git reset --hard`,
  ])(
    'denies a mutation after an option-carrying cd %#',
    async (buildCommand) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(buildCommand()))).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  it('keeps an option-carrying cd inside the boundary allowed', async () => {
    const guard = createDaemonToolGuard();

    await expect(
      guard(request('cd -P nested && git commit -m x')),
    ).resolves.toEqual({ allowed: true });
    await expect(
      guard(request('cd -- nested && git commit -m x')),
    ).resolves.toEqual({ allowed: true });
  });

  // The relocated read-only allowance covers subcommands that neither write
  // files nor run target-repository programs — flags can revoke both.
  it.each([
    () =>
      `git -C ${cmdPath(outsideRepo)} cat-file --textconv --path=f.txt HEAD:f.txt`,
    () =>
      `git -C ${cmdPath(outsideRepo)} cat-file --filters --path=f.txt HEAD:f.txt`,
    () =>
      `git -C ${cmdPath(outsideRepo)} rev-parse --output=${cmdPath(outsideRepo)}/o.txt HEAD`,
    () =>
      `git -C ${cmdPath(outsideRepo)} cat-file --output ${cmdPath(outsideRepo)}/o.txt -p HEAD`,
  ])(
    'denies a relocated read-only subcommand carrying a disqualifying flag %#',
    async (buildCommand) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(buildCommand()))).resolves.toMatchObject({
        allowed: false,
        reason: expect.stringContaining(outsideRepo),
      });
    },
  );

  it('still allows the plain relocated read-only subcommands', async () => {
    const guard = createDaemonToolGuard();

    for (const command of [
      `git -C ${outsideRepo} cat-file -p HEAD:f.txt`,
      `git -C ${outsideRepo} rev-parse HEAD`,
    ]) {
      await expect(guard(request(command))).resolves.toEqual({ allowed: true });
    }
  });

  // `ls-files` executes the target repository's core.fsmonitor hook — the
  // same property that excluded `status` (measured on git 2.47.3).
  it.each([
    () => `git -C ${cmdPath(outsideRepo)} ls-files`,
    () => `git -C ${cmdPath(outsideRepo)} ls-files --others`,
  ])('denies a relocated ls-files %#', async (buildCommand) => {
    const guard = createDaemonToolGuard();

    await expect(guard(request(buildCommand()))).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining(outsideRepo),
    });
  });

  // `describe --dirty`/`--broken` rewrite the target repository's index
  // whenever its stat cache is stale (measured on git 2.47.3: a plain
  // `describe`/`--tags`/`--always` leaves .git/index untouched). The whole
  // subcommand stays out of the read-only set because the flag is one token
  // away from any describe a model writes.
  it.each([
    () => `git -C ${cmdPath(outsideRepo)} describe`,
    () => `git -C ${cmdPath(outsideRepo)} describe --tags`,
    () => `git -C ${cmdPath(outsideRepo)} describe --dirty`,
    () => `git -C ${cmdPath(outsideRepo)} describe --always --dirty`,
    () => `git -C ${cmdPath(outsideRepo)} describe --broken`,
  ])('denies a relocated describe %#', async (buildCommand) => {
    const guard = createDaemonToolGuard();

    await expect(guard(request(buildCommand()))).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining(outsideRepo),
    });
  });

  // `monitor` runs its `command` through the same shell as the shell tool.
  it('applies the built-in policy to the monitor tool', async () => {
    const guard = createDaemonToolGuard();
    const monitorCall = (command: string) =>
      ({
        ...request(command),
        toolName: ToolNames.MONITOR,
      }) as ExternalToolGuardPrepareRequest;

    await expect(
      guard(monitorCall(`git -C ${outsideRepo} reset --hard`)),
    ).resolves.toMatchObject({ allowed: false });
    await expect(guard(monitorCall('git status'))).resolves.toEqual({
      allowed: true,
    });
  });

  // A quoted payload can relocate through `cd` instead of a Git flag, and an
  // unrecognized program word hides which of them runs.
  it.each([
    () => `su -c 'cd ${outsideRepo} && git reset --hard'`,
    () => `xargs -I{} sh -c 'cd ${outsideRepo} && git reset --hard'`,
    // `executableBaseName` lowercases, so an uppercase program word resolves
    // to the same binary on a case-insensitive filesystem.
    () => `cd ${cmdPath(outsideRepo)} && nice GIT reset --hard`,
  ])(
    'denies a relocated mutation concealed in an unrecognized program %#',
    async (buildCommand) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(buildCommand()))).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  // A program word the daemon cannot read is as opaque as an unrecognized one.
  it.each([
    () => `cd ${cmdPath(outsideRepo)} && $CMD git reset --hard`,
    () => `cd ${cmdPath(outsideRepo)} && command $CMD git reset --hard`,
  ])(
    'denies a dynamic program running Git after a cwd shift %#',
    async (buildCommand) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(buildCommand()))).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  it.each([
    // `export NAME` with no `=` exports an earlier shell-local assignment.
    () =>
      `GIT_WORK_TREE=${outsideRepo}; export GIT_WORK_TREE; git reset --hard`,
    () =>
      `GIT_DIR=${path.join(outsideRepo, '.git')}\nexport GIT_DIR\ngit commit -m x`,
    // `eval` runs in the current shell, so its exports outlive the payload.
    () => `eval 'export GIT_WORK_TREE=${outsideRepo}' && git reset --hard`,
    () => `eval 'set -a' && GIT_WORK_TREE=${outsideRepo} && git reset --hard`,
    // `set -o $OPT` can request allexport without naming it.
    () => `set -o $OPT && GIT_WORK_TREE=${outsideRepo} && git reset --hard`,
    // `+=` appends to an unknown previous value.
    () =>
      `GIT_WORK_TREE+=${outsideRepo} && export GIT_WORK_TREE && git reset --hard`,
  ])(
    'denies a mutation after a deferred or unresolvable export %#',
    async (buildCommand) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(buildCommand()))).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  it.runIf(bashSemanticsLane)(
    'keeps shell-local assignments shell-local',
    async () => {
      const guard = createDaemonToolGuard();

      await expect(
        guard(request(`GIT_WORK_TREE=${outsideRepo}; echo done`)),
      ).resolves.toEqual({ allowed: true });
      await expect(
        guard(request('FOO=bar; export FOO; git commit -m x')),
      ).resolves.toEqual({ allowed: true });
    },
  );

  // Config keys are case-insensitive and several beyond the alias set run a
  // program of the target repository's choosing.
  it.each([
    () => `git -c core.sshCommand='touch /tmp/x' -C ${outsideRepo} rev-parse`,
    () => `git -c CORE.SSHCOMMAND='touch /tmp/x' -C ${outsideRepo} rev-parse`,
    () => `git -c diff.d.textconv='touch /tmp/x' -C ${outsideRepo} rev-parse`,
    () => `git -c merge.d.driver='touch /tmp/x' -C ${outsideRepo} rev-parse`,
    () => `git -c sequence.editor='touch /tmp/x' -C ${outsideRepo} rev-parse`,
  ])(
    'denies relocated commands carrying command-executing config %#',
    async (buildCommand) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(buildCommand()))).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  // An unmodelled value-taking global option makes its value look like the
  // subcommand, which ends option parsing and hides the relocation after it.
  it.each([
    () =>
      `git --shallow-file /tmp/shallow -C ${cmdPath(outsideRepo)} reset --hard`,
    () => `git --attr-source HEAD -C ${cmdPath(outsideRepo)} reset --hard`,
  ])(
    'parses relocations after value-taking global options %#',
    async (buildCommand) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(buildCommand()))).resolves.toMatchObject({
        allowed: false,
        reason: expect.stringContaining(outsideRepo),
      });
    },
  );

  it.each([
    () => 'env -S "$CMD"',
    () => `env -S'git -C ${outsideRepo} reset --hard'`,
    () => `env -iS'git -C ${outsideRepo} reset --hard'`,
  ])('handles env -S payload forms %#', async (buildCommand) => {
    const guard = createDaemonToolGuard();

    await expect(guard(request(buildCommand()))).resolves.toMatchObject({
      allowed: false,
    });
  });

  // Git discovers its repository by walking up from the working directory, so
  // an in-boundary directory can still hand it an outside repository.
  it('denies a relocation into a directory whose .git redirects outside', async () => {
    const decoy = path.join(effectiveCwd, 'gitfile-decoy');
    await mkdir(decoy, { recursive: true });
    await writeFile(
      path.join(decoy, '.git'),
      `gitdir: ${path.join(outsideRepo, '.git')}\n`,
    );

    const guard = createDaemonToolGuard();
    await expect(
      guard(request('git -C gitfile-decoy reset --hard')),
    ).resolves.toMatchObject({ allowed: false });
    await expect(
      guard(request('cd gitfile-decoy && git commit -m x')),
    ).resolves.toMatchObject({ allowed: false });
  });

  it('keeps a linked-worktree session working when its own .git points outside', async () => {
    const linkedRoot = mkdtempSync(path.join(os.tmpdir(), 'daemon-guard-wt-'));
    const session = path.join(linkedRoot, 'checkout');
    const adminDir = path.join(linkedRoot, 'main', '.git', 'worktrees', 'live');
    await Promise.all([
      mkdir(path.join(session, 'nested'), { recursive: true }),
      mkdir(adminDir, { recursive: true }),
    ]);
    await writeFile(path.join(session, '.git'), `gitdir: ${adminDir}\n`);
    await writeFile(
      path.join(adminDir, 'gitdir'),
      `${path.join(session, '.git')}\n`,
    );

    const guard = createDaemonToolGuard();
    const call = {
      ...request('cd nested && git commit -m x'),
      effectiveCwd: session,
    } as ExternalToolGuardPrepareRequest;
    await expect(guard(call)).resolves.toEqual({ allowed: true });
    await rm(linkedRoot, { recursive: true, force: true });
  });

  it('resolves cd -P through symlinks before applying ..', async () => {
    await symlink(outsideRepo, path.join(effectiveCwd, 'outward-link'), 'dir');

    const guard = createDaemonToolGuard();
    await expect(
      guard(request('cd -P outward-link/.. && git reset --hard')),
    ).resolves.toMatchObject({ allowed: false });
    // The default (logical) form really does stay inside: bash resolves
    // `link/..` against the logical path, so allowing it matches the shell.
    await expect(
      guard(request('cd outward-link/.. && git commit -m x')),
    ).resolves.toEqual({ allowed: true });
  });

  // `git -C` reaches the kernel as a chdir, which resolves each component's
  // symlinks — unlike bash's default (logical) `cd`.
  it('resolves git -C physically through symlinks', async () => {
    const outward = path.join(effectiveCwd, 'physical-link');
    await symlink(path.join(outsideRepo, 'sub'), outward, 'dir');
    await mkdir(path.join(outsideRepo, 'sub'), { recursive: true });

    const guard = createDaemonToolGuard();
    await expect(
      guard(request('git -C physical-link/.. reset --hard')),
    ).resolves.toMatchObject({ allowed: false });
    await expect(guard(request('git -C nested/.. status'))).resolves.toEqual({
      allowed: true,
    });
  });

  // A here-string carries its payload in the command line itself.
  it.each([
    () => `sh <<< 'git -C ${outsideRepo} reset --hard'`,
    () => `bash -s <<< 'cd ${outsideRepo} && git reset --hard'`,
  ])('denies a payload delivered by here-string %#', async (buildCommand) => {
    const guard = createDaemonToolGuard();

    await expect(guard(request(buildCommand()))).resolves.toMatchObject({
      allowed: false,
    });
  });

  it('keeps ordinary redirects allowed', async () => {
    const guard = createDaemonToolGuard();

    await expect(
      guard(request('git -C nested status > out.txt 2> err.txt')),
    ).resolves.toEqual({ allowed: true });
  });

  // Brace expansion happens after this parse, so the tokens git receives are
  // not the tokens the guard saw.
  it.each([
    () => `git {-C,${outsideRepo}} reset --hard`,
    () => `git -C{,${outsideRepo}} reset --hard`,
  ])('denies a relocation hidden in a brace expansion %#', async (build) => {
    const guard = createDaemonToolGuard();

    await expect(guard(request(build()))).resolves.toMatchObject({
      allowed: false,
    });
  });

  // A redirection operand is scanned for markers but is never argv, so an
  // `eval` payload must not absorb it.
  it.each([
    () => `eval > /dev/null 'cd ${outsideRepo} && git reset --hard'`,
    () => `eval 2> /dev/null 'cd ${outsideRepo} && git reset --hard'`,
  ])('keeps redirections out of an eval payload %#', async (build) => {
    const guard = createDaemonToolGuard();

    await expect(guard(request(build()))).resolves.toMatchObject({
      allowed: false,
    });
  });

  // `cd` glued to a control operator is still a relocation.
  it.each([
    () => `su -c 'true;cd ${outsideRepo} && git reset --hard'`,
    () => `su -c 'true&&cd ${outsideRepo} && git reset --hard'`,
  ])('treats an operator-glued cd as a marker %#', async (build) => {
    const guard = createDaemonToolGuard();

    await expect(guard(request(build()))).resolves.toMatchObject({
      allowed: false,
    });
  });

  // Letters after `c` in a bundle are more flags; the payload is a later argv
  // entry, and `-o`/`-O` among them consumes one first.
  it.each([
    () => `bash -cx 'cd ${outsideRepo} && git reset --hard'`,
    () => `sh -co ignoreeof 'cd ${outsideRepo} && git reset --hard'`,
    () => `bash -c'cd ${outsideRepo} && git reset --hard'`,
  ])('reads the -c payload from the right argv entry %#', async (build) => {
    const guard = createDaemonToolGuard();

    await expect(guard(request(build()))).resolves.toMatchObject({
      allowed: false,
    });
  });

  it.each([
    // `sudo -R <rootfs>` moves the filesystem root out from under every path.
    () => `sudo -R ${outsideRepo} git reset --hard`,
    () => `sudo --chroot=${outsideRepo} git reset --hard`,
    // A command that chooses its own `git` binary defeats the classification.
    () => `PATH=/tmp/evilbin git commit -m x`,
    () => `GIT_EXEC_PATH=/tmp/evil git commit -m x`,
  ])(
    'fails closed when the run redefines its own context %#',
    async (build) => {
      const guard = createDaemonToolGuard();

      await expect(guard(request(build()))).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  // Values assigned earlier in the same command are visible to the guard.
  it.each([
    () => `X='git reset --hard'; cd ${cmdPath(outsideRepo)}; $X`,
    () => `X=git; Y='-C ${outsideRepo} reset --hard'; $X $Y`,
    () =>
      `eval 'GIT_WORK_TREE=${cmdPath(outsideRepo)}'; export GIT_WORK_TREE; git reset --hard`,
    () =>
      `GIT_WORK_TREE=${cmdPath(outsideRepo)}; export $NAME; git reset --hard`,
  ])('resolves a relocation through shell variables %#', async (build) => {
    const guard = createDaemonToolGuard();

    await expect(guard(request(build()))).resolves.toMatchObject({
      allowed: false,
    });
  });

  it.runIf(bashSemanticsLane)(
    'scopes a parenthesized subshell the way the shell does',
    async () => {
      const guard = createDaemonToolGuard();

      // The subshell's cwd dies with its parentheses...
      await expect(
        guard(request(`(cd ${outsideRepo}); git commit -m x`)),
      ).resolves.toEqual({ allowed: true });
      // ...but a Git command inside them is still judged against it.
      await expect(
        guard(request(`(cd ${outsideRepo} && git reset --hard)`)),
      ).resolves.toMatchObject({ allowed: false });
    },
  );

  it('keeps env value flags in their attached forms decidable', async () => {
    const guard = createDaemonToolGuard();

    for (const command of [
      'env --unset=GIT_DIR git commit -m x',
      'env -uGIT_DIR git commit -m x',
    ]) {
      await expect(guard(request(command))).resolves.toEqual({ allowed: true });
    }
  });

  // A relinked `.git` redirects repository discovery for every later command,
  // relocated or not; a relinked directory only affects a run that resolves
  // that very path.
  it.each([
    () => `ln -s ${path.join(outsideRepo, '.git')} .git && git status`,
    () => `ln -s ${path.join(outsideRepo, '.git')} .git && git commit -m x`,
    () => `env ln -s ${outsideRepo} bait && git -C bait reset --hard`,
    () => `X=1 ln -s ${outsideRepo} bait && git -C bait reset --hard`,
    () => `nice ln -s ${outsideRepo} bait && git -C bait reset --hard`,
    () => `cp -s ${outsideRepo} bait && git -C bait reset --hard`,
  ])('denies Git after the command relinks its path %#', async (build) => {
    const guard = createDaemonToolGuard();

    await expect(guard(request(build()))).resolves.toMatchObject({
      allowed: false,
    });
  });

  // A dynamic program word may be `ln`, and an ordinary target it re-points
  // is just as invalidating as a `.git` one.
  it.each([
    () =>
      `rm -rf src && X=ln; $X -s ${outsideRepo} src && git -C src reset --hard`,
    () => `X=ln; $X -s ${outsideRepo} nested && git -C nested reset --hard`,
  ])('denies Git after a dynamic relinker re-points its path %#', async (b) => {
    const guard = createDaemonToolGuard();

    await expect(guard(request(b()))).resolves.toMatchObject({
      allowed: false,
    });
  });

  // Git discovers its repository by walking up even with no relocation.
  it('denies a planted gitfile at the session root', async () => {
    const decoyRoot = path.join(temporaryRoot, 'decoy-session');
    await mkdir(decoyRoot, { recursive: true });
    await writeFile(
      path.join(decoyRoot, '.git'),
      `gitdir: ${path.join(outsideRepo, '.git')}\n`,
    );

    const guard = createDaemonToolGuard();
    const call = {
      ...request('git commit -m x'),
      effectiveCwd: decoyRoot,
    } as ExternalToolGuardPrepareRequest;
    await expect(guard(call)).resolves.toMatchObject({ allowed: false });
  });

  it('leaves a session bound below its repository alone', async () => {
    // The repository's `.git` lives ABOVE the boundary, so the walk stops at
    // the boundary and finds nothing — the ordinary monorepo-subdir session.
    const repoRoot = path.join(temporaryRoot, 'mono');
    const session = path.join(repoRoot, 'packages', 'app');
    await mkdir(path.join(repoRoot, '.git'), { recursive: true });
    await mkdir(session, { recursive: true });

    const guard = createDaemonToolGuard();
    const call = {
      ...request('git commit -m x'),
      effectiveCwd: session,
    } as ExternalToolGuardPrepareRequest;
    await expect(guard(call)).resolves.toEqual({ allowed: true });
  });

  it.each([
    // Redirects and their `N>` prefixes are never the `-c` payload.
    () => `sh -c > /dev/null 'git -C ${outsideRepo} reset --hard'`,
    // These env keys move where git writes or which config it reads.
    () => `GIT_OBJECT_DIRECTORY=${outsideRepo}/.git/objects git commit -m x`,
    () => `GIT_CONFIG_GLOBAL=${outsideRepo}/evil.cfg git commit -m x`,
    () => `GIT_ALTERNATE_OBJECT_DIRECTORIES=${outsideRepo} git commit -m x`,
    // `$'…'` escapes with a backslash, so the scanner must not lose phase.
    () => `echo $'a\\'b' $(git -C ${outsideRepo} reset --hard)`,
    // `+=` builds the value the shell will expand.
    () => `X=git; X+=' -C ${outsideRepo}'; X+=' reset --hard'; $X`,
  ])('closes the round-4 shell and environment gaps %#', async (build) => {
    const guard = createDaemonToolGuard();

    await expect(guard(request(build()))).resolves.toMatchObject({
      allowed: false,
    });
  });

  it.runIf(bashSemanticsLane)(
    'keeps a subshell from leaking its environment outward',
    async () => {
      const guard = createDaemonToolGuard();

      await expect(
        guard(
          request(`(export GIT_WORK_TREE=${outsideRepo}); git commit -m x`),
        ),
      ).resolves.toEqual({ allowed: true });
      await expect(
        guard(
          request(`(export GIT_WORK_TREE=${outsideRepo}; git reset --hard)`),
        ),
      ).resolves.toMatchObject({ allowed: false });
    },
  );

  it("leaves a program's own -C flag alone", async () => {
    const guard = createDaemonToolGuard();

    for (const command of [
      'grep -C 5 git CHANGELOG.md',
      'tar -C nested -cf out.tar .',
    ]) {
      await expect(guard(request(command))).resolves.toEqual({ allowed: true });
    }
    // …while an unrecognized wrapper's -C is still git's.
    await expect(
      guard(request(`xargs -I{} git -C ${outsideRepo} reset --hard`)),
    ).resolves.toMatchObject({ allowed: false });
  });

  // A trailing `#` comment is a bash construct; the cmd.exe lane reads the
  // `#` as argv and the divergent-syntax gate owns the shape.
  it.runIf(bashSemanticsLane)(
    "leaves a program's own -C flag alone behind a comment",
    async () => {
      const guard = createDaemonToolGuard();

      await expect(
        guard(request('diff -C 3 a.txt b.txt # git')),
      ).resolves.toEqual({ allowed: true });
    },
  );

  // Relink state crosses scopes in both directions: the symlink a nested
  // evaluation creates is just as real, and a parent's relink still misleads
  // a nested run.
  it.each([
    () =>
      `sh -c 'rm -rf src && ln -s ${outsideRepo} src' && git -C src reset --hard`,
    () => `eval 'ln -s ${outsideRepo} src' && git -C src reset --hard`,
    () => `echo $(ln -s ${outsideRepo} src) && git -C src reset --hard`,
    () => `ln -s ${outsideRepo} src && sh -c 'git -C src reset --hard'`,
    () => `X=ln; $X -s ${path.join(outsideRepo, '.git')} .git && git add -A`,
    () => `ln -s ${path.join(outsideRepo, '.git')} .git && nice git add -A`,
  ])('carries relink state across scopes %#', async (build) => {
    const guard = createDaemonToolGuard();

    await expect(guard(request(build()))).resolves.toMatchObject({
      allowed: false,
    });
  });

  it.each([
    // `<(…)` opens a paren the tokenizer must count, or its `)` pops the
    // enclosing subshell early and the preceding `cd` is lost.
    () => `(cd ${outsideRepo}; <(true); git reset --hard)`,
    // `eval` runs in this shell, so it sees the shell-local assignment.
    () =>
      `GIT_DIR=${outsideRepo}/meta; eval 'export GIT_DIR'; git reset --hard`,
    // Any unreadable word in a shell's argv can be the `-c`.
    () => `A='-c'; bash $A "$P"`,
    () => `bash $A "$P"`,
  ])('fails closed on the round-5 scope gaps %#', async (build) => {
    const guard = createDaemonToolGuard();

    await expect(guard(request(build()))).resolves.toMatchObject({
      allowed: false,
    });
  });

  // A sub-agent pinned to a worktree executes there while reporting the
  // parent session id, so the session's own directory is not the boundary.
  describe('reported execution directory', () => {
    const call = (
      command: string,
      invocationCwd?: string,
    ): ExternalToolGuardPrepareRequest =>
      ({
        ...request(command),
        ...(invocationCwd === undefined ? {} : { invocationCwd }),
      }) as ExternalToolGuardPrepareRequest;

    it('accepts a directory inside the session', async () => {
      const guard = createDaemonToolGuard();

      await expect(
        guard(call('git commit -m x', insideNested)),
      ).resolves.toEqual({ allowed: true });
    });

    it('fails closed on a directory the daemon cannot place', async () => {
      const guard = createDaemonToolGuard();

      // The session id owns no worktree here, so this scope is unverifiable.
      await expect(
        guard(call('git commit -m x', outsideRepo)),
      ).resolves.toMatchObject({
        allowed: false,
        reason: expect.stringContaining('execution directory'),
      });
    });

    it('contains a sub-agent to an in-project agent worktree', async () => {
      // `AgentTool` with `isolation: 'worktree'` provisions under
      // `<projectRoot>/.qwen/worktrees/`, i.e. inside the session — being
      // inside is not enough to leave the boundary alone.
      const agentWorktree = path.join(
        effectiveCwd,
        '.qwen',
        'worktrees',
        'agent-abc1234',
      );
      const sibling = path.join(
        effectiveCwd,
        '.qwen',
        'worktrees',
        'agent-def5678',
      );
      await mkdir(path.join(agentWorktree, 'src'), { recursive: true });
      await mkdir(sibling, { recursive: true });
      await writeFile(
        path.join(agentWorktree, '.git'),
        `gitdir: ${path.join(outsideRepo, '.git', 'worktrees', 'agent-abc1234')}\n`,
      );
      await mkdir(
        path.join(outsideRepo, '.git', 'worktrees', 'agent-abc1234'),
        { recursive: true },
      );
      await writeFile(
        path.join(outsideRepo, '.git', 'worktrees', 'agent-abc1234', 'gitdir'),
        `${path.join(agentWorktree, '.git')}\n`,
      );

      const guard = createDaemonToolGuard();
      // Work inside its own worktree is allowed...
      await expect(
        guard(call('cd src && git commit -m x', agentWorktree)),
      ).resolves.toEqual({ allowed: true });
      // ...reaching into a sibling agent's worktree is not, even though both
      // sit inside the session's directory.
      await expect(
        guard(call(`git -C ${sibling} reset --hard`, agentWorktree)),
      ).resolves.toMatchObject({ allowed: false });
    });

    it('contains a sub-agent to the worktree it reports', async () => {
      // A session id unique to this test: `getWorktreesDir` resolves under the
      // user's global Qwen dir, so a shared id would have this test create and
      // delete real directories belonging to someone's session.
      const isolatedSessionId = `daemon-guard-${process.pid}-worktree`;
      const owned = GitWorktreeService.getWorktreesDir(isolatedSessionId);
      const agentWorktree = path.join(owned, 'agent-a');
      await mkdir(path.join(agentWorktree, 'src'), { recursive: true });

      const guard = createDaemonToolGuard();
      const inWorktree = (command: string): ExternalToolGuardPrepareRequest =>
        ({
          ...call(command, agentWorktree),
          sessionId: isolatedSessionId,
        }) as ExternalToolGuardPrepareRequest;
      try {
        // Its own worktree is the boundary: work inside it is allowed...
        await expect(
          guard(inWorktree('cd src && git commit -m x')),
        ).resolves.toEqual({ allowed: true });
        // ...while reaching back into the parent checkout is not.
        await expect(
          guard(inWorktree(`git -C ${effectiveCwd} reset --hard`)),
        ).resolves.toMatchObject({ allowed: false });
      } finally {
        await rm(GitWorktreeService.getSessionDir(isolatedSessionId), {
          recursive: true,
          force: true,
        });
      }
    });
  });

  it.each([
    // Env vars git executes as programs, and its config-injection channels.
    () => `GIT_SSH_COMMAND='touch /tmp/x' git fetch`,
    () => `GIT_EDITOR='touch /tmp/x' git commit`,
    () => `GIT_ASKPASS='touch /tmp/x' git fetch`,
    () => `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.pager git status`,
    // Config keys git runs through a shell.
    () => `git -c diff.external='touch /tmp/x' -C ${outsideRepo} rev-parse`,
    () => `git -c core.gitProxy='touch /tmp/x' -C ${outsideRepo} rev-parse`,
    // An unrecognized wrapper does not launder that config.
    () => `nice git -c alias.pwn='!cd ${outsideRepo} && git reset --hard' pwn`,
    // `-execdir` runs git with the cwd of each directory it visits.
    () => `find ${outsideRepo} -execdir git reset --hard ;`,
    // An archive decides where it writes, so the extraction directory is
    // what became untrustworthy.
    () => `tar -xf evil.tar && git -C nested reset --hard`,
    // A body defined earlier runs where the later bare word appears.
    () => `alias g='git reset --hard'; cd ${outsideRepo}; g`,
    () => `f() { git reset --hard; }; cd ${outsideRepo}; f`,
    // A decoy `> g` redirect whose target equals the function name must not
    // truncate the prefix-assignment scan of the `GIT_DIR=` on the call.
    () => `g() { git reset --hard; }; > g GIT_DIR=${outsideRepo}/.git g`,
  ])('closes the round-6 escapes %#', async (build) => {
    const guard = createDaemonToolGuard();

    await expect(guard(request(build()))).resolves.toMatchObject({
      allowed: false,
    });
  });

  // Each of these was denied by a rule that was too broad.
  it('keeps ordinary commands out of the round-6 rules', async () => {
    const guard = createDaemonToolGuard();

    for (const command of [
      // `SHELLOPTS` is bash's own options state, not a git redirection.
      'SHELLOPTS=errexit git status',
      'env --ignore-environment git status',
      'env --null git status',
      // `curl -C -` resumes a download; it is not `git -C`.
      'curl -C - -o pkg.tgz https://git.example.com/pkg.tgz',
      'tar -xf a.tar && git commit -m x',
    ]) {
      await expect(guard(request(command))).resolves.toEqual({ allowed: true });
    }
  });

  // The quoted/`;`-separated shapes are bash spellings the Windows lanes
  // deny at the divergent-syntax gate before the round-6 rules read them.
  it.runIf(bashSemanticsLane)(
    'keeps bash-shaped ordinary commands out of the round-6 rules',
    async () => {
      const guard = createDaemonToolGuard();

      for (const command of [
        "env -iS 'git status'",
        // A `cd` target the guard already knows the value of.
        `d=${cmdPath(insideNested)}; cd $d; git status`,
        // `set +a` turns allexport back off.
        `set -a; set +a; GIT_WORK_TREE=${outsideRepo}; echo done`,
        // Definitions used inside the boundary stay allowed.
        'f() { git status; }; cd nested; f',
        "alias g='git status'; cd nested; g",
      ]) {
        await expect(guard(request(command))).resolves.toEqual({
          allowed: true,
        });
      }
    },
  );

  // Round-7. These are the reviewers' exact payloads: the earlier "denies as
  // written" replies were checked with counter-probes that tripped a
  // different rule (a `.git` in the path matching the Git-word marker, or a
  // literal `-C`), leaving the reported mechanism untouched. `outsideRepo`
  // would do that again, so these use a path with no Git word in it.
  describe('round-7 exact payloads', () => {
    const plainOutside = path.join(temporaryRoot, 'elsewhere', 'checkout');
    const spacedOutside = path.join(temporaryRoot, 'boundary with space');

    it.each([
      // `$'…'` is not ANSI-C quoting inside double quotes, so the
      // substitution in it is live.
      () => `echo "$'$(GIT_DIR=${plainOutside}/.git git reset --hard HEAD~1)'"`,
      // The export attribute sticks to the name, so a LATER assignment to it
      // reaches the git subprocess.
      () =>
        `export GIT_DIR; GIT_DIR=${cmdPath(plainOutside)}; git reset --hard`,
      () =>
        `export GIT_WORK_TREE; GIT_WORK_TREE=${cmdPath(plainOutside)}; git reset --hard`,
      // Both sides of a pipe run in subshells: the parent stays outside.
      () => `cd ${plainOutside}; echo x | cd ${effectiveCwd}; git commit -m x`,
      // A bare digit before a spaced redirect is a real argv word.
      () => `eval git -C 2 > x reset --hard`,
      // `-o` before `c` in a bundle does not cancel the `c`.
      () => `bash -oc errexit "$P"`,
      () => `bash -Oc extglob "$P"`,
      () => `bash -oc errexit 'git -C ${plainOutside} reset --hard'`,
      // Re-joining argv must not lose the quoting that made a path one word.
      () => `env -S 'git -C' '${spacedOutside}' reset --hard`,
    ])('denies the reported payload verbatim %#', async (build) => {
      await mkdir(path.join(plainOutside, '.git'), { recursive: true });
      await mkdir(path.join(spacedOutside, '.git'), { recursive: true });
      const guard = createDaemonToolGuard();

      await expect(guard(request(build()))).resolves.toMatchObject({
        allowed: false,
      });
    });

    it.runIf(bashSemanticsLane)(
      'leaves the equivalent in-boundary shapes alone',
      async () => {
        const guard = createDaemonToolGuard();

        for (const command of [
          'echo x | cat; git commit -m x',
          `cd nested; echo x | cd ${effectiveCwd}; git commit -m x`,
          "env -S 'git status'",
          "bash -oc errexit 'git status'",
          'export GIT_DIR; echo done',
        ]) {
          await expect(guard(request(command))).resolves.toEqual({
            allowed: true,
          });
        }
      },
    );
  });

  // Defects the round-7 patch itself introduced. Each was reproduced before
  // the fix; the path deliberately carries no Git word.
  it.each([
    // The fd digit of `2>…` belongs to the redirection, never to argv.
    () => `sh -c 2> /dev/null 'git -C ${plainOutsidePath} reset --hard'`,
    // Each `o`/`O` after `c` consumes one entry, not "one if any".
    () => `bash -coo x y 'git -C ${plainOutsidePath} reset --hard'`,
    // The last payload rebuild that still joined without re-quoting.
    () => `env --split-string='git -C' '${plainOutsidePath}' reset --hard`,
    // A lone `&` backgrounds into a subshell, so its `cd` does not stick.
    () => `cd ${plainOutsidePath}; cd ${effectiveCwd} & git reset --hard`,
    // `>|` is the clobber redirect, not a pipe.
    () => `cd ${plainOutsidePath} >| /tmp/f && git -C . push`,
    // The export attribute is shell state and crosses `eval`.
    () =>
      `export GIT_DIR; eval 'GIT_DIR=${plainOutsidePath}'; git reset --hard`,
    // A deferred body is keyed on the program word, not on run[0].
    () => `alias g='git reset --hard'; cd ${plainOutsidePath}; X=1 g`,
  ])('closes a defect the round-7 patch introduced %#', async (build) => {
    await mkdir(path.join(plainOutsidePath, '.git'), { recursive: true });
    const guard = createDaemonToolGuard();

    await expect(guard(request(build()))).resolves.toMatchObject({
      allowed: false,
    });
  });

  it('leaves backgrounded and redirected in-boundary work alone', async () => {
    const guard = createDaemonToolGuard();

    for (const command of ['git status > out.txt 2> err.txt']) {
      await expect(guard(request(command))).resolves.toEqual({ allowed: true });
    }
  });

  // Backgrounding (`&`) and quoted wrapper payloads are bash spellings the
  // Windows lanes deny at the divergent-syntax gate first.
  it.runIf(bashSemanticsLane)(
    'leaves backgrounded and quoted in-boundary work alone on the bash lanes',
    async () => {
      const guard = createDaemonToolGuard();

      for (const command of [
        'sleep 1 & git commit -m x',
        "bash -coo x y 'git status'",
        "env --split-string='git status'",
      ]) {
        await expect(guard(request(command))).resolves.toEqual({
          allowed: true,
        });
      }
    },
  );

  // Common shell forms an agent may emit — not adversarial exotica. Fixed
  // even under the guard's "reliable against literal forms" promise.
  it.each([
    // `&>` / `&>>` is a redirect operator, not a background separator.
    () => `cd ${plainOutsidePath} &> /dev/null; git reset --hard`,
    () => `cd ${plainOutsidePath} &>> /dev/null; git reset --hard`,
    // The `function NAME { … }` keyword form, `()` optional.
    () => `function g { git reset --hard; }; cd ${plainOutsidePath}; g`,
    () => `function g() { git reset --hard; }; cd ${plainOutsidePath}; g`,
    // `include.path`/`includeIf.*.path` pull in a config file the guard
    // cannot read; it can carry a worktree redirect or executable config.
    () => `git -c include.path=/tmp/evil reset --hard`,
    () => `git -c includeIf.gitdir:/x.path=/tmp/evil commit -m x`,
  ])(
    'denies a common-form relocation the parser used to miss %#',
    async (b) => {
      await mkdir(path.join(plainOutsidePath, '.git'), { recursive: true });
      const guard = createDaemonToolGuard();

      await expect(guard(request(b()))).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  it.runIf(bashSemanticsLane)(
    'leaves the in-boundary equivalents of those forms alone',
    async () => {
      const guard = createDaemonToolGuard();

      for (const command of [
        'git status &> /dev/null',
        'git commit -m x &>> log.txt',
        'function g { git status; }; cd nested; g',
      ]) {
        await expect(guard(request(command))).resolves.toEqual({
          allowed: true,
        });
      }
    },
  );

  // Round-9 Criticals reproduced before fixing (Git-word-free path).
  it.each([
    // Config/env channels git executes as programs.
    () => `git -c imap.tunnel='touch /tmp/x' -C ${plainOutsidePath} fetch`,
    () =>
      `git -c instaweb.httpd='touch /tmp/x' -C ${plainOutsidePath} rev-parse`,
    () =>
      `GIT_DIFFTOOL_EXTCMD='touch /tmp/x' git -C ${plainOutsidePath} difftool`,
    // `GIT_DIR=… set -a` persists (special builtin) and exports.
    () => `GIT_DIR=${plainOutsidePath}/.git set -a; git reset --hard`,
    // Definition recognition behind a redirect / keyword prefix.
    () => `2>/dev/null alias g='git reset --hard'; cd ${plainOutsidePath}; g`,
    () =>
      `if true; then alias g='git reset --hard'; fi; cd ${plainOutsidePath}; g`,
    // Every pair of a multi-alias statement is a definition.
    () => `alias a=x g='git reset --hard'; cd ${plainOutsidePath}; g`,
    // A heredoc body must not launder a tracked cwd.
    () =>
      `cd ${plainOutsidePath}; cat <<EOF\ncd ${effectiveCwd}\nEOF\ngit reset --hard`,
    () =>
      `cd ${plainOutsidePath}; bash <<EOF\ncd ${effectiveCwd}\nEOF\ngit reset --hard`,
    () =>
      `cd ${plainOutsidePath}; bash <<EOF\ngit() { true; }\nEOF\ngit reset --hard`,
    // A `-C` inside a function body is seen when the body spans segments.
    () => `f() { true; git -C ${plainOutsidePath} reset --hard; }; f`,
  ])('denies the round-9 critical form %#', async (build) => {
    await mkdir(path.join(plainOutsidePath, '.git'), { recursive: true });
    const guard = createDaemonToolGuard();

    await expect(guard(request(build()))).resolves.toMatchObject({
      allowed: false,
    });
  });

  it('keeps the round-9 in-boundary equivalents alone', async () => {
    const guard = createDaemonToolGuard();

    for (const command of [
      // Extract-then-commit is ordinary work, not a relocation.
      'tar -xf a.tar && git commit -m x',
    ]) {
      await expect(guard(request(command))).resolves.toEqual({ allowed: true });
    }
  });

  it('keeps valid compound heredoc openers parseable', async () => {
    const guard = createDaemonToolGuard();

    for (const command of [
      'cat <<EOF && echo done\nhello\nEOF',
      'cat <<EOF || echo done\nhello\nEOF',
    ]) {
      await expect(guard(request(command))).resolves.toEqual({ allowed: true });
    }
  });

  // Heredocs are bash syntax; on the cmd.exe lane these shapes never execute
  // as heredocs and the divergent-syntax gate owns what is provable there.
  it.runIf(bashSemanticsLane)(
    'denies a heredoc piped into a shell outright',
    async () => {
      const guard = createDaemonToolGuard();

      // The body runs as shell code here; nothing about it is provable, so the
      // guard must fail closed instead of dropping it from view (#9417).
      await expect(
        guard(request('cat <<EOF | bash\necho done\nEOF')),
      ).resolves.toMatchObject({ allowed: false });
      await expect(
        guard(request('tee /tmp/s.sh <<EOF\nrm -rf /important\nEOF')),
      ).resolves.toMatchObject({ allowed: false });
    },
  );

  it.runIf(bashSemanticsLane).each([
    // A shell-fed body is executed code, never stdin data.
    `bash <<'EOF'\ngit reset --hard\nEOF`,
    `sh <<'EOF'\ngit reset --hard\nEOF`,
    `bash -s <<'EOF'\ngit reset --hard\nEOF`,
    `bash - <<'EOF'\ngit reset --hard\nEOF`,
    `bash /dev/stdin <<'EOF'\ngit reset --hard\nEOF`,
    // Interpreters run the body as a program.
    `python <<'EOF'\nimport os\nEOF`,
    `python - X=1 <<'EOF'\nprint(1)\nEOF`,
    `node <<'EOF'\nprocess.exit(1)\nEOF`,
    // Command substitution inside an unquoted body executes.
    `cat <<EOF\n$(git reset --hard)\nEOF`,
    // A delimiter prefix is not a word boundary in bash.
    `cat <<END-X\nbody\nEND-X`,
    // Arithmetic spanning lines is outside the grammar.
    `(( a\ncat <<EOF\n))`,
    // An unsafe opener keeps the body, and the body must not launder the cwd.
    `cat $F <<'EOF'\ncd /tmp\nEOF\ngit reset --hard`,
    // An odd trailing backslash splices lines the parser cannot see across.
    `bash -s \\\ncat <<EOF\nrm -rf /important\nEOF`,
    `cat <<EOF # c \\\nbody\nEOF`,
    // A bare dot is the POSIX source builtin.
    `. /tmp/evil\ncat <<EOF\nrm -rf /important\nEOF`,
    // trap redefines the receiver behind the guard's back.
    `trap 'cat() { bash; }' DEBUG\ncat <<EOF\ngit reset --hard\nEOF`,
  ])('fails closed on heredoc entrance %#', async (command) => {
    const guard = createDaemonToolGuard();

    await expect(guard(request(command))).resolves.toMatchObject({
      allowed: false,
    });
  });

  it.runIf(bashSemanticsLane)(
    'does not let an LF-only line terminate a CRLF heredoc early',
    async () => {
      const guard = createDaemonToolGuard();

      // bash keeps the CR in the delimiter word, so "EOF" without it is body,
      // not the terminator; the command is unterminated and must fail closed.
      await expect(
        guard(request('cat <<EOF\r\nbody\nEOF')),
      ).resolves.toMatchObject({ allowed: false });
      // A consistently CRLF command parses fine and stays inert.
      await expect(
        guard(request('cat <<EOF\r\nbody\r\nEOF\r')),
      ).resolves.toMatchObject({ allowed: true });
    },
  );

  it('treats an escaped quote as a literal, not a string opener', async () => {
    const guard = createDaemonToolGuard();

    // \" is a literal character, so the heredoc below is real and its body is
    // stripped as usual instead of being hidden inside a phantom string.
    await expect(
      guard(request("echo \\\"\ncat <<'EOF'\nrm -rf /important\nEOF")),
    ).resolves.toMatchObject({ allowed: true });
  });

  // Backgrounding, heredocs and function definitions are bash spellings the
  // Windows lanes deny at the divergent-syntax gate first.
  it.runIf(bashSemanticsLane)(
    'keeps the round-9 bash-shaped equivalents alone on the bash lanes',
    async () => {
      const guard = createDaemonToolGuard();

      for (const command of [
        // A backgrounded `cd` does not move the shell that runs git.
        'cd nested & git commit -m x',
        'cat <<EOF\nhello\nEOF',
        'f() { true; git status; }; f',
      ]) {
        await expect(guard(request(command))).resolves.toEqual({
          allowed: true,
        });
      }
    },
  );

  // An alias replaces its name with its body and keeps the trailing argv, so
  // the relocation an invocation appends is part of what runs.
  it.each([
    () => `alias gg='git'; gg -C ${plainOutsidePath} reset --hard`,
    () => `alias gg='git -C'; gg ${plainOutsidePath} reset --hard`,
  ])('denies a relocation passed to an alias %#', async (build) => {
    await mkdir(path.join(plainOutsidePath, '.git'), { recursive: true });
    const guard = createDaemonToolGuard();

    await expect(guard(request(build()))).resolves.toMatchObject({
      allowed: false,
    });
  });

  it.runIf(bashSemanticsLane)(
    'leaves an alias used inside the boundary alone',
    async () => {
      const guard = createDaemonToolGuard();

      for (const command of [
        "alias gg='git'; gg status",
        "alias gg='git commit'; gg -m x",
        "alias gg='git status'; cd nested; gg",
      ]) {
        await expect(guard(request(command))).resolves.toEqual({
          allowed: true,
        });
      }
    },
  );

  // A function/alias runs in the current shell, so a `cd` or export in its
  // body survives the call and a later path-free Git mutation is judged
  // against where the body left the shell.
  it.each([
    () => `f() { cd ${plainOutsidePath}; }; f; git reset --hard`,
    () =>
      `f() { export GIT_DIR=${plainOutsidePath}/.git; }; f; git reset --hard`,
    () => `alias gg='cd ${plainOutsidePath}'; gg; git reset --hard`,
  ])('carries a body cwd/export out to the caller %#', async (build) => {
    await mkdir(path.join(plainOutsidePath, '.git'), { recursive: true });
    const guard = createDaemonToolGuard();

    await expect(guard(request(build()))).resolves.toMatchObject({
      allowed: false,
    });
  });

  it.runIf(bashSemanticsLane)(
    'keeps an in-boundary body cwd shift allowed',
    async () => {
      const guard = createDaemonToolGuard();

      for (const command of [
        'f() { cd nested; }; f; git status',
        'f() { echo hi; }; f; git commit -m x',
      ]) {
        await expect(guard(request(command))).resolves.toEqual({
          allowed: true,
        });
      }
    },
  );

  // A body run in the current shell inherits the caller's `set -a`, so a
  // plain assignment there is exported to the following git.
  it.each([
    () =>
      `set -a; f() { GIT_WORK_TREE=${plainOutsidePath}; }; f; git reset --hard`,
    () => `set -a; GIT_WORK_TREE=${plainOutsidePath}; git reset --hard`,
    () => `set -a; eval 'GIT_WORK_TREE=${plainOutsidePath}'; git reset --hard`,
  ])(
    'carries the caller allexport into a same-shell body %#',
    async (build) => {
      await mkdir(path.join(plainOutsidePath, '.git'), { recursive: true });
      const guard = createDaemonToolGuard();

      await expect(guard(request(build()))).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  it.runIf(bashSemanticsLane)(
    'leaves an unexported body assignment alone',
    async () => {
      await mkdir(path.join(plainOutsidePath, '.git'), { recursive: true });
      const guard = createDaemonToolGuard();

      // No `export`, no `set -a`: bash does not put it in git's environment.
      for (const command of [
        `GIT_WORK_TREE=${plainOutsidePath}; git status`,
        `f() { GIT_WORK_TREE=${plainOutsidePath}; }; f; git status`,
      ]) {
        await expect(guard(request(command))).resolves.toEqual({
          allowed: true,
        });
      }
    },
  );

  it.each([
    // A command substitution inherits the caller's `set -a`.
    () => `set -a; echo $(GIT_WORK_TREE=${plainOutsidePath}; git reset --hard)`,
    // A nested function defined in the caller is visible to the body it runs.
    () =>
      `inner() { cd ${plainOutsidePath}; }; outer() { inner; }; outer; git reset --hard`,
  ])(
    'shares option and definition state with a same-shell body %#',
    async (b) => {
      await mkdir(path.join(plainOutsidePath, '.git'), { recursive: true });
      const guard = createDaemonToolGuard();

      await expect(guard(request(b()))).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  it.runIf(bashSemanticsLane)(
    'lets a same-shell body turn allexport back off',
    async () => {
      await mkdir(path.join(plainOutsidePath, '.git'), { recursive: true });
      const guard = createDaemonToolGuard();

      // `set +a` in the body persists, so the later assignment is unexported.
      for (const command of [
        `set -a; f() { set +a; }; f; GIT_WORK_TREE=${plainOutsidePath}; git status`,
        `set -a; eval 'set +a'; GIT_WORK_TREE=${plainOutsidePath}; git status`,
        // A substitution's own changes die with it.
        `echo $(GIT_WORK_TREE=${plainOutsidePath}; git status)`,
      ]) {
        await expect(guard(request(command))).resolves.toEqual({
          allowed: true,
        });
      }
    },
  );

  it.each([
    // A function/alias shadows the git program or a builtin; bash resolves it
    // before either, so the recorded body must run first.
    () => `git() { cd ${plainOutsidePath}; command git status; }; git`,
    () =>
      `cd() { command cd ${plainOutsidePath}; }; cd nested; git reset --hard`,
    // A pipeline redefinition runs in a subshell and does not persist.
    () =>
      `f() { cd ${plainOutsidePath}; }; f() { :; } | cat; f; git reset --hard`,
    // `export -f` makes a function visible inside a `bash -c` subprocess.
    () =>
      `f() { cd ${plainOutsidePath}; }; export -f f; bash -c "f; git reset --hard"`,
  ])('resolves a shadowing/exported function correctly %#', async (build) => {
    await mkdir(path.join(plainOutsidePath, '.git'), { recursive: true });
    const guard = createDaemonToolGuard();

    await expect(guard(request(build()))).resolves.toMatchObject({
      allowed: false,
    });
  });

  it('does not import an unexported function into a subprocess', async () => {
    const guard = createDaemonToolGuard();

    // `command git` explicitly bypasses a shadowing function.
    await expect(guard(request('command git status'))).resolves.toEqual({
      allowed: true,
    });
  });

  // Without `export -f`, `bash -c` does not see `f`, so this is an ordinary
  // (path-free) git run inside the boundary — pinned on the bash lanes,
  // where the definition/payload spellings execute as written.
  it.runIf(bashSemanticsLane)(
    'keeps an unexported function out of a subprocess on the bash lanes',
    async () => {
      const guard = createDaemonToolGuard();

      await expect(
        guard(request(`f() { cd ${plainOutsidePath}; }; bash -c 'git status'`)),
      ).resolves.toEqual({ allowed: true });
    },
  );

  // Gaps in the function-model work of the preceding commits.
  it.each([
    // `export -f` state must reach a nested same-shell body too.
    () =>
      `f() { cd ${plainOutsidePath}; }; export -f f; g() { bash -c "f; git reset --hard"; }; g`,
    // A prefix assignment on a function/alias invocation reaches its git.
    () => `gg() { git status; }; GIT_WORK_TREE=${plainOutsidePath} gg`,
    () => `alias gg='git status'; GIT_WORK_TREE=${plainOutsidePath} gg`,
  ])('propagates invocation state into a recorded body %#', async (build) => {
    await mkdir(path.join(plainOutsidePath, '.git'), { recursive: true });
    const guard = createDaemonToolGuard();

    await expect(guard(request(build()))).resolves.toMatchObject({
      allowed: false,
    });
  });

  it.runIf(bashSemanticsLane)('rolls back a pipe subshell fully', async () => {
    await mkdir(path.join(plainOutsidePath, '.git'), { recursive: true });
    const guard = createDaemonToolGuard();

    // The pipe-side export/assignment dies with the subshell.
    await expect(
      guard(
        request(
          `export GIT_WORK_TREE; GIT_WORK_TREE=${plainOutsidePath} | cat; git status`,
        ),
      ),
    ).resolves.toEqual({ allowed: true });
  });

  // Reachable escapes via a redirection on a `cd` or inside a git run.
  it.each([
    () => `cd ${plainOutsidePath} >&2; git reset --hard`,
    () => `git 2>/dev/null -C ${plainOutsidePath} reset --hard`,
    () => `git -C ${plainOutsidePath} 2>/dev/null reset --hard`,
  ])('denies a relocation around a redirection %#', async (build) => {
    await mkdir(path.join(plainOutsidePath, '.git'), { recursive: true });
    const guard = createDaemonToolGuard();

    await expect(guard(request(build()))).resolves.toMatchObject({
      allowed: false,
    });
  });

  it('leaves an ordinary redirection alone', async () => {
    const guard = createDaemonToolGuard();

    for (const command of ['git status 2>/dev/null']) {
      await expect(guard(request(command))).resolves.toEqual({ allowed: true });
    }
  });

  // `>&N`/`2>&1` carry a lone `&`, which the Windows lanes deny at the
  // divergent-syntax gate; `;` is bash command separation.
  it.runIf(bashSemanticsLane)(
    'leaves bash-shaped redirections alone on the bash lanes',
    async () => {
      const guard = createDaemonToolGuard();

      for (const command of [
        'cd nested >&2; git status',
        'git -C nested reset --hard 2>&1',
      ]) {
        await expect(guard(request(command))).resolves.toEqual({
          allowed: true,
        });
      }
    },
  );

  it.each([
    // A redirection before an alias/function invocation must not hide it.
    () => `alias gg='git -C ${plainOutsidePath} reset --hard'; 2>/dev/null gg`,
    () => `gg() { git -C ${plainOutsidePath} reset --hard; }; 2>/dev/null gg`,
    // Only the segment `&` follows is backgrounded; the next runs foreground.
    () => `true & cd ${plainOutsidePath}; git reset --hard`,
  ])('denies a relocation past a redirect or background %#', async (build) => {
    await mkdir(path.join(plainOutsidePath, '.git'), { recursive: true });
    const guard = createDaemonToolGuard();

    await expect(guard(request(build()))).resolves.toMatchObject({
      allowed: false,
    });
  });

  it.runIf(bashSemanticsLane)(
    'keeps foreground/background boundaries correct',
    async () => {
      const guard = createDaemonToolGuard();

      for (const command of [
        // The backgrounded `cd` is a subshell; the foreground git stays inside.
        `cd ${outsideRepo} & git status`,
        'true & cd nested; git status',
        "2>/dev/null alias gg='git status'; gg",
      ]) {
        await expect(guard(request(command))).resolves.toEqual({
          allowed: true,
        });
      }
    },
  );

  // A harmless recorded body must not mask a relocation the real interpreter
  // would run: only bash imports `export -f`, and removals retract a shadow.
  it.each([
    // dash does not import the exported function, so the real git relocates.
    () =>
      `git() { :; }; export -f git; dash -c "git -C ${plainOutsidePath} reset --hard"`,
    // `unset -f`/`unalias` remove the shadow, exposing the real git.
    () => `git() { :; }; unset -f git; git -C ${plainOutsidePath} reset --hard`,
    () =>
      `alias git='echo hi'; unalias git; git -C ${plainOutsidePath} reset --hard`,
    // `sh` resolves to dash on most daemons but to bash on macOS, so the
    // guard never replays an exported shadow for it: importing on a
    // dash-backed `sh` would recreate the escape. It fails closed — the
    // deliberate, safe trade-off is over-denying the bash-backed case.
    () =>
      `git() { :; }; export -f git; sh -c "git -C ${plainOutsidePath} reset --hard"`,
    // `env -i`/`-`/`--ignore-environment` wipe the exported function before
    // bash starts, so even bash resolves the real git.
    () =>
      `git() { :; }; export -f git; env -i bash -c "git -C ${plainOutsidePath} reset --hard"`,
    () =>
      `git() { :; }; export -f git; env - bash -c "git -C ${plainOutsidePath} reset --hard"`,
    () =>
      `git() { :; }; export -f git; env --ignore-environment bash -c "git -C ${plainOutsidePath} reset --hard"`,
  ])(
    'does not let a stale/incompatible shadow mask a relocation %#',
    async (b) => {
      await mkdir(path.join(plainOutsidePath, '.git'), { recursive: true });
      const guard = createDaemonToolGuard();

      await expect(guard(request(b()))).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  // Removal builtins must retract a shadow only the way the real shell does:
  // mis-modelling one drops a live relocating function and allows the command.
  it.each([
    // `unset` has no `-a` option: the command errors, the function survives.
    () => `pwn() { git -C ${plainOutsidePath} reset --hard; }; unset -a; pwn`,
    // `unalias -a` clears aliases, never functions.
    () => `pwn() { git -C ${plainOutsidePath} reset --hard; }; unalias -a; pwn`,
    // A function shadowing `unset` runs `:` instead of the builtin, so the
    // removal never happens and the shadow stays live.
    () =>
      `pwn() { git -C ${plainOutsidePath} reset --hard; }; unset() { :; }; unset -f pwn; pwn`,
    // A `-c` subprocess is a separate process: its `unset -f` cannot retract
    // the parent's exported function.
    () =>
      `pwn() { git -C ${plainOutsidePath} reset --hard; }; export -f pwn; bash -c "unset -f pwn"; bash -c pwn`,
    // A command substitution inherits the exported function too.
    () =>
      `evil() { git -C ${plainOutsidePath} reset --hard; }; export -f evil; echo $(bash -c 'evil')`,
    // A bare `unset NAME` removes a same-name variable first; Bash keeps the
    // function, so the model must not delete it (it tracks no variables).
    () =>
      `pwn() { git -C ${plainOutsidePath} reset --hard; }; pwn=1; unset pwn; pwn`,
    // A bare `unset git` with no same-name variable removes the function in
    // bash; the harmless body must not mask the relocating call arguments.
    () => `git() { :; }; unset git; git -C ${plainOutsidePath} reset --hard`,
    // Fused `export -nf` un-exports the function bash's option parser accepts.
    () =>
      `git() { :; }; export -f git; export -nf git; bash -c 'git -C ${plainOutsidePath} reset --hard'`,
    // A `command`/`builtin` prefix still runs the real removal builtin.
    () =>
      `git() { :; }; command unset -f git; git -C ${plainOutsidePath} reset --hard`,
    // A leading redirection is stripped from argv, so it must not hide the
    // `command unset` that removes the shadow.
    () =>
      `git() { :; }; 2>/dev/null command unset -f git; git -C ${plainOutsidePath} reset --hard`,
    // `enable -n unset` disables the builtin, so the removal is a no-op and
    // the relocating function survives.
    () =>
      `g() { git -C ${plainOutsidePath} reset --hard; }; enable -n unset; unset -f g; g`,
    // A removal inside a `( … )` subshell does not reach the parent shell.
    () =>
      `git() { command git -C ${plainOutsidePath} reset --hard "$@"; }; ( unset -f git ); git`,
    // A function shadowing `unset` runs its relocating body even when the
    // argument names only untracked state — the builtin never runs.
    () => `unset() { git -C ${plainOutsidePath} reset --hard; }; unset other`,
    // `unset A` drops the tracked variable, so `cd $A` is a bare `cd` to $HOME
    // in bash; the guard must not keep expanding the stale in-bounds value.
    () => `A=nested; unset A; cd $A; git reset --hard`,
    // A function shadowing the `command`/`builtin` prefix word runs its own
    // relocating body — the prefix is not a guaranteed bypass to the builtin.
    () =>
      `command() { git -C ${plainOutsidePath} reset --hard; }; command unset other`,
    () =>
      `builtin() { git -C ${plainOutsidePath} reset --hard; }; builtin unset other`,
  ])(
    'does not let a mis-modelled removal drop a live relocating shadow %#',
    async (build) => {
      await mkdir(path.join(plainOutsidePath, '.git'), { recursive: true });
      const guard = createDaemonToolGuard();

      await expect(guard(request(build()))).resolves.toMatchObject({
        allowed: false,
      });
    },
  );

  // Shadow modelling is bash semantics: on the win32 cmd/PowerShell lanes
  // the same text defines nothing — the guard's divergent-syntax gate denies
  // most of it outright and no shadow is recorded — so these pins only mean
  // what they say on lanes that execute through bash.
  describe.runIf(
    process.platform !== 'win32' || getShellConfiguration().shell === 'bash',
  )('bash exported-function shadow semantics', () => {
    it.each([
      // `env -u BASH_FUNC_git%%` (separated, attached, and `--unset=` forms)
      // strips the exported function from the child, which then runs the real
      // git — the guard must not replay the harmless imported body.
      () =>
        `git() { :; }; export -f git; env -u 'BASH_FUNC_git%%' bash -c "git -C ${plainOutsidePath} reset --hard"`,
      () =>
        `git() { :; }; export -f git; env -u'BASH_FUNC_git%%' bash -c "git -C ${plainOutsidePath} reset --hard"`,
      () =>
        `git() { :; }; export -f git; env --unset='BASH_FUNC_git%%' bash -c "git -C ${plainOutsidePath} reset --hard"`,
    ])(
      'does not let a mis-modelled removal drop a live relocating shadow %#',
      async (build) => {
        await mkdir(path.join(plainOutsidePath, '.git'), { recursive: true });
        const guard = createDaemonToolGuard();

        await expect(guard(request(build()))).resolves.toMatchObject({
          allowed: false,
        });
      },
    );

    it('keeps a live compatible shadow modelled', async () => {
      await mkdir(path.join(plainOutsidePath, '.git'), { recursive: true });
      const guard = createDaemonToolGuard();

      for (const command of [
        // bash imports the function, which really shadows git and drops args.
        `git() { :; }; export -f git; bash -c "git -C ${plainOutsidePath} reset --hard"`,
        // The alias is still in effect (no removal).
        `alias git='echo hi'; git -C ${plainOutsidePath} reset --hard`,
        // Removing a different name leaves the git shadow intact.
        `git() { :; }; unset -f other; git -C ${plainOutsidePath} reset --hard`,
        // `env -i` clears the function, but a read-only relocation is still fine.
        `git() { :; }; export -f git; env -i bash -c "git -C ${plainOutsidePath} rev-parse HEAD"`,
        // `env` without a clearing flag keeps the bash-imported shadow live.
        `git() { :; }; export -f git; env FOO=bar bash -c "git -C ${plainOutsidePath} reset --hard"`,
        // `env -u` of an unrelated key leaves the exported function in place.
        `git() { :; }; export -f git; env -u FOO bash -c "git -C ${plainOutsidePath} reset --hard"`,
        // `env -u BASH_FUNC_other%%` strips a different function, not git.
        `git() { :; }; export -f git; env -u 'BASH_FUNC_other%%' bash -c "git -C ${plainOutsidePath} reset --hard"`,
      ]) {
        await expect(guard(request(command))).resolves.toEqual({
          allowed: true,
        });
      }
    });
  });

  // The shell-executing set pins ToolNames literals in acp-bridge, which
  // cannot import core; a rename must fail here.
  it('matches the ToolNames constants for shell-executing tools', () => {
    expect(SHELL_EXECUTING_TOOL_NAMES).toEqual(
      new Set([ToolNames.SHELL, ToolNames.MONITOR]),
    );
  });

  it('short-circuits the external provider after a built-in denial', async () => {
    const externalGuard = vi.fn().mockResolvedValue({ allowed: true });
    const guard = createDaemonToolGuard(externalGuard);

    await expect(
      guard(request(`git -C ${outsideRepo} reset --hard`)),
    ).resolves.toMatchObject({ allowed: false });
    expect(externalGuard).not.toHaveBeenCalled();
  });

  it('forwards allowed calls to the external provider unchanged', async () => {
    const externalGuard = vi.fn().mockResolvedValue({ allowed: true });
    const guard = createDaemonToolGuard(externalGuard);
    const call = request('pwd');

    await expect(guard(call)).resolves.toEqual({ allowed: true });
    expect(externalGuard).toHaveBeenCalledWith(call);
  });

  it('returns an external provider denial for an otherwise allowed call', async () => {
    const providerDenial = {
      allowed: false,
      reason: 'Provider policy denied this invocation.',
    };
    const externalGuard = vi.fn().mockResolvedValue(providerDenial);
    const guard = createDaemonToolGuard(externalGuard);

    await expect(guard(request('pwd'))).resolves.toEqual(providerDenial);
    expect(externalGuard).toHaveBeenCalledOnce();
  });

  it.each([
    ToolNames.AGENT,
    ToolNames.WORKFLOW,
    ToolNames.CREATE_SUB_SESSION,
    ToolNames.SEND_MESSAGE,
  ])(
    'preserves external-provider nested executor restrictions only when configured (%s)',
    async (toolName) => {
      const call = {
        ...request('pwd'),
        toolName,
        arguments: {},
      };

      await expect(createDaemonToolGuard()(call)).resolves.toEqual({
        allowed: true,
      });
      await expect(
        createDaemonToolGuard(vi.fn().mockResolvedValue({ allowed: true }))(
          call,
        ),
      ).resolves.toMatchObject({
        allowed: false,
        reason: expect.stringContaining('nested or delegated'),
      });
    },
  );

  // The unsupported-tool set intentionally pins ToolNames string literals so
  // this module keeps its import footprint; a rename must fail here.
  it('matches the ToolNames constants for nested executor tools', () => {
    const unsupported = new Set([
      'agent',
      'workflow',
      'create_sub_session',
      'send_message',
    ]);
    expect(unsupported).toEqual(
      new Set([
        ToolNames.AGENT,
        ToolNames.WORKFLOW,
        ToolNames.CREATE_SUB_SESSION,
        ToolNames.SEND_MESSAGE,
      ]),
    );
  });

  it('fails closed without the trusted effective working directory', async () => {
    const guard = createDaemonToolGuard();
    const call = request('pwd') as unknown as Record<string, unknown>;
    delete call['effectiveCwd'];

    await expect(
      guard(call as unknown as ExternalToolGuardPrepareRequest),
    ).rejects.toThrow('trusted workspace context');
  });

  it('applies the built-in policy to prompt-less shell checks', async () => {
    const guard = createDaemonToolGuard();

    const allowed = request('pwd') as unknown as Record<string, unknown>;
    delete allowed['promptId'];
    await expect(
      guard(allowed as unknown as ExternalToolGuardPrepareRequest),
    ).resolves.toEqual({ allowed: true });

    const denied = request(
      `git -C ${outsideRepo} reset --hard`,
    ) as unknown as Record<string, unknown>;
    delete denied['promptId'];
    await expect(
      guard(denied as unknown as ExternalToolGuardPrepareRequest),
    ).resolves.toMatchObject({ allowed: false });
  });

  it('refuses to consult the external provider without a prompt binding', async () => {
    const externalGuard = vi.fn().mockResolvedValue({ allowed: true });
    const guard = createDaemonToolGuard(externalGuard);
    const call = request('pwd') as unknown as Record<string, unknown>;
    delete call['promptId'];

    await expect(
      guard(call as unknown as ExternalToolGuardPrepareRequest),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining('without an active prompt binding'),
    });
    expect(externalGuard).not.toHaveBeenCalled();
  });
});
