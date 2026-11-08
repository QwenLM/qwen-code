/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isDestructiveCommand,
  userMentionsDiscard,
  extractLastUserPrompt,
  registerSessionCommit,
  clearSessionCommits,
} from './destructive-commands.js';
import { modelText, userText } from '../test-utils/model-fixtures.js';

beforeEach(() => {
  clearSessionCommits();
});

/** Asserts a block, and that the reason names `reasonPart` when given. */
function expectBlocked(cmd: string, prompt: string, reasonPart?: string) {
  const result = isDestructiveCommand(cmd, prompt);
  expect(result).not.toBeNull();
  expect(result!.blocked).toBe(true);
  if (reasonPart !== undefined) expect(result!.reason).toContain(reasonPart);
}

function expectAllowed(commands: string[], prompt: string) {
  for (const cmd of commands) {
    expect(isDestructiveCommand(cmd, prompt)).toBeNull();
  }
}

/**
 * Asserts the third outcome (#16075 maintainer stopgap, round-15 assessment):
 * the command goes to the approval prompt — neither a hard block nor a silent
 * allow. Used where the guard recognises amend text but cannot positively
 * identify a dangerous amend.
 */
function expectAsk(cmd: string, prompt: string, cwd?: string) {
  const result = isDestructiveCommand(cmd, prompt, cwd);
  expect(result).not.toBeNull();
  expect(result!.blocked).toBe(false);
  expect(result!.ask).toBe(true);
}

describe('userMentionsDiscard', () => {
  it('returns true for English discard keywords', () => {
    const prompts = [
      'discard all local changes',
      'throw away my changes',
      'wipe the working tree',
      'clean up the git state',
      'reset everything',
      'drop all changes',
      'force reset the repo',
      'start over',
      'start fresh',
      'clean slate',
    ];
    for (const prompt of prompts) {
      expect(userMentionsDiscard(prompt)).toBe(true);
    }
  });

  it('returns true for Chinese discard keywords', () => {
    for (const prompt of ['丢弃所有修改', '清除工作区', '重置到初始状态']) {
      expect(userMentionsDiscard(prompt)).toBe(true);
    }
  });

  it('returns false for normal prompts', () => {
    const prompts = [
      'add a new feature',
      'fix the bug in auth',
      'commit the changes',
      'create a new branch',
      'run the tests',
    ];
    for (const prompt of prompts) {
      expect(userMentionsDiscard(prompt)).toBe(false);
    }
  });
});

describe('extractLastUserPrompt', () => {
  it('returns undefined for empty messages', () => {
    expect(extractLastUserPrompt([])).toBeUndefined();
  });

  it('extracts text from the last user message', () => {
    const messages = [
      userText('first message'),
      modelText('model response'),
      userText('second message'),
    ];
    expect(extractLastUserPrompt(messages)).toBe('second message');
  });

  it('skips model and function messages', () => {
    const messages = [
      modelText('model only'),
      userText('user text'),
      modelText('another model'),
    ];
    expect(extractLastUserPrompt(messages)).toBe('user text');
  });

  it('returns undefined when no user messages exist', () => {
    expect(extractLastUserPrompt([modelText('model only')])).toBeUndefined();
  });
});

describe('isDestructiveCommand — git patterns', () => {
  it.each<[string, string, string?]>([
    ['git reset --hard', 'fix the bug', 'git reset --hard'],
    ['git checkout -- .', 'fix the bug'],
    ['git clean -fd', 'remove files'],
    ['git clean -f', 'remove files'],
    ['git clean -fdx', 'remove all'],
    ['git stash drop', 'remove stash'],
  ])('blocks %s', expectBlocked);

  it.each([
    [
      'allows git reset --hard when user mentions discard',
      'git reset --hard',
      'discard all local changes and reset',
    ],
    [
      'allows git clean -fd when user mentions wipe',
      'git clean -fd',
      'wipe the working tree clean',
    ],
    [
      'allows git stash drop when user mentions discard',
      'git stash drop',
      'discard all stashes',
    ],
  ])('%s', (_title, cmd, prompt) => expectAllowed([cmd], prompt));

  it('allows safe git commands', () => {
    const safeCommands = [
      'git status',
      'git log',
      'git diff',
      'git add .',
      'git commit -m "fix"',
      'git branch -a',
      'git checkout feature-branch',
      'git pull',
      'git push origin main',
      'git stash',
      'git stash pop',
      'git stash list',
    ];
    expectAllowed(safeCommands, 'do stuff');
  });
});

describe('isDestructiveCommand — shell indirection', () => {
  it.each([
    ['bash -c "git reset --hard"', 'fix something'],
    ["sh -c 'git clean -fd'", 'remove untracked files'],
    ['zsh -c "git stash drop"', 'do stuff'],
  ])('blocks %s', (cmd, prompt) => expectBlocked(cmd, prompt));

  it('allows bash -c with safe commands', () => {
    expectAllowed(['bash -c "git status && git log"'], 'check status');
  });
});

describe('isDestructiveCommand — IaC patterns', () => {
  it.each<[string, string, string?]>([
    ['terraform destroy', 'update infrastructure', 'terraform'],
    ['pulumi destroy', 'update infrastructure'],
    ['cdk destroy', 'update infra'],
  ])('blocks %s', expectBlocked);

  it('allows terraform destroy when user explicitly requests it', () => {
    expectAllowed(['terraform destroy'], 'terraform destroy the staging stack');
  });

  it('allows terraform apply and plan', () => {
    const safeCommands = [
      'terraform apply',
      'terraform plan',
      'terraform init',
      'pulumi up',
      'cdk deploy',
    ];
    expectAllowed(safeCommands, 'deploy');
  });
});

describe('isDestructiveCommand — git commit --amend', () => {
  it('blocks git commit --amend when no session commits registered', () => {
    expectBlocked('git commit --amend --no-edit', 'amend the commit', 'amend');
  });

  it.each([
    'git -c core.editor=true commit --amend',
    '/usr/bin/git commit --amend --no-edit',
    "bash -c 'git commit --amend --no-edit'",
    'sudo env GIT_COMMITTER_DATE=now git commit --amend --no-edit',
    'timeout 10 git commit --amend --no-edit',
    'if true; then git commit --amend --no-edit; fi',
    // `time` is both shell noise and a wrapper that takes a value-taking flag;
    // its value must not be mistaken for the program (#13570 review).
    "time -f '%e' git commit --amend --no-edit",
    'time --format=%e git commit --amend --no-edit',
    'time -o /tmp/time.out git commit --amend --no-edit',
    // The removed substring guard denied all of these; each executes a real
    // amend, so the token-based recogniser must keep denying them (#13570).
    'echo $(git commit --amend --no-edit)',
    'x=$(git commit --amend --no-edit)',
    'echo `git commit --amend --no-edit`',
    "bash <<'EOF'\ngit commit --amend --no-edit\nEOF",
    'sh -s <<EOF\ngit commit --amend --no-edit\nEOF',
    'xargs -I{} git commit --amend --no-edit',
    'find . -exec git commit --amend --no-edit \\;',
    '> amend.log git commit --amend --no-edit',
    // The shell removes `\`+newline before it lexes, so the ANSI-C opener it
    // interrupts still yields `--amend` (#16075 review, R7-1).
    "git commit $\\\n'--amend' --no-edit",
    // Shell that reads the heredoc through a pipe or a prefix — the guard
    // must see the amend behind data-producing openers (#13570 review).
    "cat <<'EOF' | bash\ngit commit --amend --no-edit\nEOF",
    "sudo bash <<'EOF'\ngit commit --amend --no-edit\nEOF",
    // Bash runs substitutions inside double quotes; only single quotes
    // suppress them, so each of these executes a real amend (#13570 review).
    'echo "$(git commit --amend --no-edit)"',
    'x="$(git commit --amend --no-edit)"',
    'git commit -m "$(git commit --amend)"',
    'echo "`git commit --amend --no-edit`"',
    // Mutation-gap pins: each of these behaviours was correct but unheld by
    // any test, so a mutation could remove it silently (#13570 review).
    "eval 'git commit --amend --no-edit'",
    'command git commit --amend --no-edit',
    // An apostrophe inside a double-quoted span is literal text, not a new
    // single-quoted region; it must not hide the substitution after it
    // (#13570 review).
    `echo "don't $(git commit --amend --no-edit)"`,
    `x="it's $(git commit --amend)"`,
    // `>` is a word boundary, so bash leaves the token `--amend>amend.log`;
    // matching the flag by exact equality missed a bare amend (#13570 review).
    'git commit --amend>amend.log',
    'git commit --amend</dev/null',
    'git commit --amend>>amend.log',
    'git commit --amend{,} --no-edit',
    'git commit --amend$(true)',
    // Constructs the token scan cannot classify fail closed: a wrapper the
    // module does not unwrap in place, a `-c`/`--split-string` payload, a
    // shell fed by a here-string or an executor, and `${IFS}` word splitting.
    "sudo bash -c 'git commit --amend --no-edit'",
    "env FOO=1 bash -c 'git commit --amend --no-edit'",
    "timeout 10 bash -c 'git commit --amend --no-edit'",
    "dash -c 'git commit --amend --no-edit'",
    "fish -c 'git commit --amend --no-edit'",
    "env -S 'git commit --amend --no-edit'",
    "bash <<< 'git commit --amend --no-edit'",
    `echo "git commit --amend --no-edit" | bash`,
    "xargs -I{} sh -c 'git commit --amend --no-edit'",
    `find . -exec sh -c 'git commit --amend --no-edit' \\;`,
    'cat <(git commit --amend --no-edit)',
    'git${IFS}commit${IFS}--amend --no-edit',
    // Seams the token scan did not model (#13570 review): a `\`-newline
    // continuation splits the invocation, `-c'…'` glues the payload to the
    // flag, a shell can carry a program this scan cannot read, and the heredoc
    // consumer is not always the first word of the line.
    'git commit \\\n--amend --no-edit',
    "bash -c'git commit --amend --no-edit'",
    'bash -c',
    "echo hi; bash <<'EOF'\ngit commit --amend --no-edit\nEOF",
    // `$'…'` is ANSI-C quoting: still one word, so the payload is the same
    // invocation and must not read as an unmodelled expansion.
    "bash -c $'git commit --amend --no-edit'",
    "bash <<< $'git commit --amend --no-edit'",
    // ANSI-C decoding turns `\n` into a real command boundary, so the amend is
    // a second command rather than text inside one word (#16075 review, R3-2).
    "bash -c $'git commit --amend\\ntrue'",
    // Escapes outside the `\n \t \r \\` shim decode to the bytes bash runs, so
    // `\x3b` / `\073` / `\u003b` are command boundaries, not letters
    // (#16075 review, R3-1).
    "bash -c $'git commit --amend\\x3btrue'",
    "sh -c $'git commit --amend\\x3btrue'",
    "bash -c $'git commit --amend\\073true'",
    "bash -c $'git commit --amend\\u003btrue'",
    // More unmodelled executors/consumers (#16075 review, R1-1): `script -c`
    // runs a program, `exec` prefixes the real shell, `fish` reads stdin, and
    // `su` carries a positional user before its `-c` payload.
    "script -c 'git commit --amend --no-edit' /dev/null",
    "exec bash <<'EOF'\ngit commit --amend --no-edit\nEOF",
    "fish <<'EOF'\ngit commit --amend --no-edit\nEOF",
    "su root -c 'git commit --amend --no-edit'",
    // git expands an `alias.*` it is handed itself, so the subcommand word is
    // not the program that runs (#16075 review, R4-1).
    "git -c alias.x='commit --amend' x",
    'git --config-env=alias.x=CMD x --no-edit',
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.x GIT_CONFIG_VALUE_0='commit --amend' git x",
  ])('blocks amend through an execution wrapper: %s', (command) => {
    expectBlocked(command, 'amend the commit', 'amend');
  });

  it('fails closed when eval nesting exceeds the unwrap depth cap', () => {
    // The cap is 8; a benign chain deeper than that is still refused rather
    // than allowed, so pathological nesting cannot hide an amend. The payload
    // must be benign — a real amend reaches depth 9 and returns true on its
    // own, which left the cap unheld (#16075 review, R5-5).
    const deep = Array.from({ length: 9 }).reduce<string>(
      (inner) => `eval '${inner}'`,
      'echo hi',
    );
    expectBlocked(deep, 'amend the commit', 'amend');
  });

  // `sh -c -- '…'` puts an option terminator before the program; reading `--`
  // as the program answered "not an amend" (#16075 review, R5-3). Quote
  // removal makes every spelling of that word the terminator (#16075 review,
  // R6-1).
  it.each([
    "sh -c -- 'git commit --amend --no-edit'",
    "bash -c -- 'git commit --amend --no-edit'",
    "dash -c -- 'git commit --amend --no-edit'",
    "sh -c \\-- 'git commit --amend --no-edit'",
    "sh -c '--' 'git commit --amend --no-edit'",
    "sh -c $'--' 'git commit --amend --no-edit'",
  ])('blocks amend behind an option terminator: %s', (command) => {
    expectBlocked(command, 'amend the commit', 'amend');
  });

  it('allows an option terminator with a safe program', () => {
    expectAllowed(
      ["sh -c -- 'echo A'", "bash -c -- 'git status'"],
      'check status',
    );
  });

  // Comment stripping stopped at the end of the segment rather than the line,
  // and its quote model did not know `$'…'`, so a note deleted a real amend
  // (#16075 review, R5-2).
  it.each([
    "git status # it's fine\ngit commit --amend --no-edit",
    "git commit -m $'it\\'s #1' --amend",
  ])('blocks amend after a comment or an ANSI-C hash: %s', (command) => {
    expectBlocked(command, 'amend the commit', 'amend');
  });

  // `tokenize` decoded only `\n \t \r \\`, so `\x65` kept its spelling and
  // `git commit $'--am\x65nd'` read as a different flag (#16075 review, R3-1).
  it('blocks amend spelled with decoded ANSI-C escapes', () => {
    expectBlocked(
      "git commit $'--am\\x65nd' --no-edit",
      'amend the commit',
      'amend',
    );
  });

  // `\UFFFFFFFF` is above the Unicode range; `String.fromCodePoint` threw out
  // of the guard instead of answering it (#16075 review, R5-1).
  it('answers instead of throwing on an out-of-range ANSI-C escape', () => {
    for (const command of [
      "bash -c $'\\UFFFFFFFF'",
      "bash -c $'\\U0011FFFF'",
      "eval $'\\UFFFFFFFF'",
    ]) {
      expect(() =>
        isDestructiveCommand(command, 'amend the commit'),
      ).not.toThrow();
    }
  });

  it.each([
    `printf '%s\\n' 'git commit --amend'`,
    'git commit -m --amend',
    // ANSI-C quoting keeps `--amend` inside `-m`'s value; `\'` is an escape,
    // not the end of the word, so this stays inert (#16075 review, R3-2).
    "git commit -m $'fix: remember --amend'",
    "git commit -m $'fix: don\\'t forget --amend'",
    // After `--` the token is a pathspec, not a flag, so this is not an amend.
    'git commit -- foo --amend',
    // A pipe, a process substitution or a here-string in inert text is not a
    // program: the pipe operator is quote-aware, `||` is not a pipe, `<(` in
    // quotes is literal text, and a here-string carries its own word
    // (#13570 review, R2-1).
    'curl -fsSL https://example.com/install.sh | bash',
    'echo hello | bash',
    'diff <(git log --oneline) <(git log --oneline main)',
    'git commit -m "document why a | bash pipeline is needed"',
    'grep -rn "a | sh" docs/',
    'echo "see pattern <(x) in the docs"',
    'bash <<< "echo hi"',
    'npm test || sh',
    // Fail-closed arms narrowed to position and quote state (#16075 review,
    // R3-1): `${IFS}` only matters in the program word, `xargs`/`find` pass
    // data rather than a program, an unquoted `#` comment is not an argument,
    // and a heredoc body belongs to the segment that owns the redirection.
    "echo 'set $IFS'",
    'git commit -m "docs: explain ${IFS} word splitting"',
    "grep -rn '${IFS}' packages/core/src",
    'find . -name bash',
    'ls | xargs sh',
    // Position, not presence: a program word in argument position runs
    // nothing (#16075 review, R5-4). The here-string variants of these two
    // moved to the backstop-flipped table below: `<<<` is a metacharacter
    // the inert prover does not classify (#16075 R9, B1).
    "echo bash -c 'git commit --amend'",
    "git commit -m 'fix: tidy' # --amend is blocked in AUTO mode",
  ])('allows inert text that mentions amend: %s', (command) => {
    expectAllowed([command], 'write a report');
  });

  // `xargs -L N` takes its value as a detached word (GNU declares `L:`), so
  // the program after the value is `rm`, not `5`. Reading `-L` as an
  // optional-value letter left the program position unclassifiable and denied
  // every plain `xargs -L N` file pipeline — the false positive reported on
  // #16075. The value-flag rows below stay denied so the narrowing cannot be
  // mistaken for skipping the program word.
  it.each([
    'find . -name "*.log" | xargs -L 5 rm',
    'ls | xargs -L 2 echo',
    'echo x | xargs -L 5 rm',
    'find . -name "*.log" | xargs -L5 rm',
    'find . -name "*.log" | xargs -n 1 rm',
    'ls | xargs --max-lines 5 rm',
  ])('allows an xargs value flag that keeps its program: %s', (command) => {
    expectAllowed([command], 'clean up old logs');
  });

  it.each([
    'ls | xargs -L 5 git commit --amend',
    "ls | xargs -L 5 sh -c 'git commit --amend'",
    'ls | xargs --max-lines 5 git commit -m x --amend',
  ])('still blocks an amend behind an xargs value flag: %s', (command) => {
    expectBlocked(command, 'amend the commit', 'amend');
  });

  it('allows git commit (without --amend)', () => {
    expectAllowed(['git commit -m "fix"'], 'commit changes');
  });

  // R12-1: an expanded program word that can never be git is an ordinary
  // invocation. The old scan failed closed on EVERY expansion in program
  // position, blocking routine editor/interpreter launches in AUTO mode.
  it('allows ordinary invocations behind an expanded program word', () => {
    expectAllowed(['$EDITOR notes.txt'], 'edit notes');
    expectAllowed(['"$PY" scripts/migrate.py'], 'run the migration');
    expectAllowed(
      ['${BIN}/tool --check', '$MAKE all', '"$VENV/bin/pip" install x'],
      'build the project',
    );
  });

  // The narrowing must not reopen the fail-open holes: a program word that
  // CAN be git, an assigned name, or an unresolvable expansion stays denied.
  it.each([
    '$GIT commit --amend',
    'X=git; $X commit --amend',
    "X=$'git\\x20commit\\x20--amend'; $X",
    '${IFS} git commit --amend',
    '$(which git) commit --amend',
  ])('keeps a potentially-git program word blocked: %s', (command) => {
    expectBlocked(command, 'amend the commit', 'amend');
  });

  // ── #16075 R9 structural repair ─────────────────────────────────────────

  // B1 (doudouOUC): every spelling below was ALLOWED at head 733b9096 with
  // an empty session registry while the base substring guard denied it, and
  // each one really amends HEAD when executed. The recognizer positively
  // identifies these invocations (static values, quote removal, pipe chains,
  // env -S, xargs, here-strings), so they stay hard-blocked.
  it.each([
    "X='git commit --amend --no-edit'; $X",
    "sh -c ''--'' 'git commit --amend --no-edit'",
    "echo 'git commit --amend --no-edit' | cat | bash",
    "env -u FOO -S 'git commit --amend --no-edit'",
    "xargs -n 1 bash -c 'git commit --amend --no-edit'",
    "bash <<< 'echo FIRST' <<< 'git commit --amend --no-edit'",
    'bash -c "echo hi # it\'s\ngit commit --amend --no-edit"',
  ])('B1 recognizer blocks a positively identified amend: %s', (command) => {
    expectBlocked(command, 'amend the commit', 'amend');
  });

  // Maintainer stopgap (#16075 round-15 assessment): these carriers really
  // amend HEAD in bash, but the hand-rolled recognizer does not positively
  // identify the invocation — only the literal-phrase backstop sees them.
  // Hard denial is reserved for positively identified dangerous amends, so
  // they route to the approval prompt instead (a human still sees the trap /
  // rebase --exec / shell payload before anything runs). Carrier attribution
  // is deferred to the parser-redesign follow-up, not chased spelling by
  // spelling here.
  it.each([
    "trap 'git commit --amend --no-edit' EXIT",
    "git rebase --exec 'git commit --amend --no-edit' HEAD~1",
    "bash -c -e 'git commit --amend --no-edit'",
    "find . -maxdepth 0 -exec timeout 5 sh -c 'git commit --amend --no-edit' \\;",
  ])('B1 unattributed carrier routes to approval: %s', (command) => {
    expectAsk(command, 'amend the commit');
  });

  // The narrow inert prover keeps genuinely inert data allowed: single-quoted
  // words of print/search/copy programs, comments, and a single-quoted-
  // delimiter heredoc fed to a non-shell program (bash performs no expansion
  // on such a body, and cat only copies it).
  it.each([
    "echo 'git commit --amend'",
    "grep 'git commit --amend' file.txt",
    "printf '%s' 'git commit --amend'",
    'git status # git commit --amend is blocked in AUTO mode',
    '# git commit --amend',
    "cat <<'EOF'\ngit commit --amend\nEOF",
  ])('B1 inert prover allows provably inert data: %s', (command) => {
    expectAllowed([command], 'write a report');
  });

  // A shell owner executes the heredoc body: the recognizer positively
  // identifies that invocation, so it stays hard-blocked.
  it.each(["bash <<'EOF'\ngit commit --amend\nEOF"])(
    'B1 shell-owned heredoc stays blocked: %s',
    (command) => {
      expectBlocked(command, 'write a report', 'amend');
    },
  );

  // Maintainer stopgap (#16075 round-15 assessment, fixing R15-4 / issue
  // #13570): these were hard-denied by the R9 backstop even though no amend
  // invocation is recognised and real bash proves the anchor inert. The
  // backstop now routes every inert-unprovable mention to the approval
  // prompt — the issue accepts "allowed, or at worst an approval prompt".
  // Provably inert data (the table above) stays allowed; positively
  // identified amends stay blocked.
  it.each([
    // The issue #13570 verbatim acceptance anchor. Was pinned expectBlocked
    // ("false positives the design accepts this round"); the maintainer
    // decision reverses that: inert-unprovable text must not hard-deny.
    `node -e 'console.log("a report about git commit --amend behaviour")'`,
    // Double-quoted occurrences are not proven inert this round.
    'echo "git commit --amend"',
    'grep -n "git commit --amend" CHANGELOG.md',
    'git log --grep="git commit --amend"',
    // A redirect is a metacharacter outside the quoted words (R1 scenario).
    `cat > notes.txt <<'EOF'\ngit commit --amend\nEOF`,
    // `<<<` is a metacharacter the inert prover does not classify.
    "echo bash <<< 'git commit --amend --no-edit'",
    "grep -rn sh <<< 'git commit --amend'",
    // A compound command is not a simple allowlisted command.
    "bash --version; cat > notes.md <<'EOF'\ngit commit --amend --no-edit\nEOF",
    // Heredoc shapes outside the inert proof: a pipe on the delimiter line,
    // an unquoted delimiter, and a trailing second command. The recognizer
    // does not attribute these carriers; approval, not hard denial.
    "cat <<'EOF'\ngit commit --amend\nEOF | bash",
    'cat <<EOF\ngit commit --amend\nEOF',
    "cat <<'EOF'\ngit commit --amend\nEOF\nls",
    // R1: unquoted inert text with a redirect (changelog echo).
    'echo git commit --amend >> CHANGELOG.md',
    // Double-quoted interpreter payloads are outside the inert proof.
    `node -e "console.log('git commit --amend')"`,
    // A commit MESSAGE that mentions the amend is data, not an invocation;
    // the recognizer ignores message arguments, the backstop sees the phrase.
    "git commit -m 'fix: explain why git commit --amend is blocked'",
    // The execSync twin: the model cannot parse JavaScript, so it cannot
    // positively identify the amend inside the payload either. Approval
    // keeps the security property (never silently auto-allow) while a human
    // reviewer sees the execSync call; distinguishing inert JS from executing
    // JS is the parser-redesign follow-up's job, not another spelling rule.
    `node -e 'require("child_process").execSync("git commit --amend")'`,
  ])('B1 inert-unprovable mention routes to approval: %s', (command) => {
    expectAsk(command, 'write a report');
  });
});

// ── R10: recognizer seams measured against real bash/git at ab5f81bd ──────

describe('isDestructiveCommand — R10 recognizer seams', () => {
  it.each([
    // `$"…"` is locale-translation quoting: the shell removes the introducer
    // and quotes, so these run a real amend (#16075 review, R8-11).
    'git $"commit" --amend',
    'git commit $"--amend"',
    'bash -c $"git commit --amend --no-edit"',
    `sh -c $"--" 'git commit --amend --no-edit'`,
    // git accepts every unambiguous prefix of --amend (#16075 review, R8-8).
    'git commit --am --no-edit',
    'git commit --ame --no-edit',
    'git commit --amen --no-edit',
    // Short clusters are read letter by letter: an attached value does not
    // consume the next word (#16075 review, R1-6).
    'git commit -mtopic --amend',
    'git commit -mC --amend',
    'git commit -amC --amend --no-edit',
    "git commit -m'doc' --amend",
    // GIT_CONFIG_PARAMETERS defines aliases too (#16075 review, R8-12).
    `GIT_CONFIG_PARAMETERS="'alias.x=commit --amend'" git x --no-edit`,
    // Expansions in the subcommand/flag positions word-split into an amend
    // the tokenizer keeps glued (#16075 review, R8-10).
    'git commit${IFS}--amend --no-edit',
    'git commit $IFS--amend',
    'git commit ${x:---amend}',
    'git $(echo commit) --amend',
    'git {commit,--amend}',
    // Positional/special parameters expand to nothing when unset, gluing
    // `commit$1` into the plain subcommand (measured bash argv:
    // [git] [commit] [--amend]).
    'git commit$1 --amend',
    'git commit$@ --amend',
    'git commit$* --amend',
    // A global flag's VALUE decides what the flag does: `-c $X` can expand
    // to an alias definition that turns `y` into `commit --amend`.
    'git -c $X y --no-edit',
    // A trailing `\c` stays literal; it must not swallow the closing quote
    // and the rest of the line (#16075 review, R8-2 / R10-1). `\cZ` still
    // decodes as a control escape.
    "git commit -m $'fix \\c' --amend",
    "git commit -m $'fix \\cZ' --amend",
    // Global-flag seams: attr-source takes a value, redirections interleave
    // with the flags, and config sections are case-insensitive (#16075
    // review, R1-1 residual).
    'git --attr-source HEAD commit --amend',
    'git >/dev/null commit --amend',
    'git 2>&1 commit --amend',
    "git -c ALIAS.x='commit --amend' x",
  ])('blocks a real amend through a measured seam: %s', (command) => {
    expectBlocked(command, 'amend the commit', 'amend');
  });

  it.each([
    // The expansion arm reads invocation positions, not argument data:
    // another subcommand's variables and brace lists cannot amend.
    'git push origin $BRANCH',
    'git checkout feature/{a,b}',
    'git stash apply stash@{0}',
    // `-m --amend` is still a message; optional-value short flags never
    // consume the next word.
    'git commit -m --amend',
    'git commit -u --amendx',
    // A special parameter inside a consumed message value is data, not an
    // invocation position.
    "git commit -m 'price $5' --no-edit",
  ])('keeps non-amend invocations allowed: %s', (command) => {
    expectAllowed([command], 'do git work');
  });
});

// ── B2: the session exemption follows the repository the command targets ──

describe('session-commit exemption scoping (#16075 R9 B2)', () => {
  let repoA: { dir: string; head: string };
  let repoB: { dir: string; head: string };

  function makeRepo(label: string): { dir: string; head: string } {
    const dir = mkdtempSync(join(tmpdir(), 'amend-scope-'));
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    };
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf-8', env });
    git('init', '-q');
    // Distinct content per repo: identical trees committed in the same second
    // with the same identity would produce identical HEAD SHAs and make the
    // two-repo contrast vacuous.
    writeFileSync(join(dir, 'f.txt'), `${label}\n`);
    git('add', 'f.txt');
    git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
    return { dir, head: git('rev-parse', 'HEAD').trim() };
  }

  beforeEach(() => {
    repoA = makeRepo('repo-a');
    repoB = makeRepo('repo-b');
    registerSessionCommit(repoA.head);
  });

  afterEach(() => {
    rmSync(repoA.dir, { recursive: true, force: true });
    rmSync(repoB.dir, { recursive: true, force: true });
  });

  it('blocks an amend relocated to a repo whose HEAD is not registered', () => {
    // cwd=A (registered), but -C targets B: the exemption must not apply.
    const result = isDestructiveCommand(
      `git -C ${repoB.dir} commit --amend --no-edit`,
      'amend the commit',
      repoA.dir,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  // R7-2 (second round): the walk must refuse the exemption whenever it
  // cannot prove which repository the amend rewrites. Each row keeps repo A's
  // HEAD registered while the amend really runs in repo B (or after a segment
  // that moved HEAD), so the guard has to stay live. Maintainer stopgap
  // (#16075 round-15 assessment): an unattributable target routes to the
  // approval prompt instead of a hard denial — never a silent allow.
  it('routes a cd that `||` makes conditional to approval (true || cd A && amend, cwd=B)', () => {
    expectAsk(
      `true || cd ${repoA.dir} && git commit --amend --no-edit`,
      'amend the commit',
      repoB.dir,
    );
  });

  it('blocks an amend after an assignment-prefixed cd into repo B (cwd=A)', () => {
    // The walk tracks the cd through the assignment prefix: the target is
    // positively B, whose HEAD is not registered — hard denial stands.
    expect(
      isDestructiveCommand(
        `FOO=1 cd ${repoB.dir}; git commit --amend --no-edit`,
        'amend the commit',
        repoA.dir,
      )!.blocked,
    ).toBe(true);
  });

  it('routes an export hidden behind `builtin` to approval (builtin export GIT_DIR=B)', () => {
    expectAsk(
      `builtin export GIT_DIR=${repoB.dir}/.git; git commit --amend --no-edit`,
      'amend the commit',
      repoA.dir,
    );
  });

  it('routes an exported GIT_DIR across a backgrounded unset to approval', () => {
    expectAsk(
      `export GIT_DIR=${repoB.dir}/.git; unset GIT_DIR & git commit --amend --no-edit`,
      'amend the commit',
      repoA.dir,
    );
  });

  it('blocks the amend after a segment that positively moved HEAD (#16075 R14-1)', () => {
    // `git reset --soft HEAD~1` moves HEAD before the amend runs, so the
    // registered commit is not the one the amend rewrites. This is a
    // positively identified dangerous amend: hard denial, not approval
    // (patrol M3 fix, preserved by the maintainer stopgap).
    const result = isDestructiveCommand(
      'git reset --soft HEAD~1 && git commit --amend --no-edit',
      'amend the commit',
      repoA.dir,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  // ── R15-2: HEAD-movement allowlist (maintainer stopgap) ─────────────────
  // The eight-entry mover denylist missed update-ref/am/bisect/stash/…:
  // `git update-ref HEAD HEAD~1 && git commit --amend` rewrites the session
  // commit's PARENT (witnessed with real git: the old HEAD is no longer an
  // ancestor afterwards) while the guard exempted it. The allowlist inverts
  // the failure mode — only proven HEAD-neutral subcommands keep the
  // exemption alive; anything else counts as a movement and hard-denies.
  it.each([
    'git update-ref HEAD HEAD~1 && git commit --amend --no-edit',
    'git reset --soft HEAD~1 && git commit --amend --no-edit',
    'git checkout HEAD~1 && git commit --amend --no-edit',
    'git symbolic-ref HEAD refs/heads/other && git commit --amend --no-edit',
    'git stash && git commit --amend --no-edit',
    'git bisect start && git commit --amend --no-edit',
    'git am --abort && git commit --amend --no-edit',
    'git replace HEAD HEAD~1 && git commit --amend --no-edit',
    // Global flags must not hide the subcommand from the allowlist.
    'git --no-pager update-ref HEAD HEAD~1 && git commit --amend --no-edit',
    'git -c core.pager=cat update-ref HEAD HEAD~1 && git commit --amend --no-edit',
  ])('blocks an amend after a non-neutral HEAD movement: %s', (command) => {
    const result = isDestructiveCommand(command, 'amend the commit', repoA.dir);
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  it.each([
    'git status && git commit --amend --no-edit',
    'git log -1 && git commit --amend --no-edit',
    'git diff && git commit --amend --no-edit',
    'git add f.txt && git commit --amend --no-edit',
    'git rev-parse HEAD && git commit --amend --no-edit',
    'git --no-pager show --stat && git commit --amend --no-edit',
    'git -c core.pager=cat log && git commit --amend --no-edit',
    'git branch && git commit --amend --no-edit',
    'git tag && git commit --amend --no-edit',
    'git config --list && git commit --amend --no-edit',
    'git remote -v && git commit --amend --no-edit',
    'git fetch --dry-run && git commit --amend --no-edit',
  ])(
    'keeps the exemption after a proven HEAD-neutral git segment: %s',
    (command) => {
      expect(
        isDestructiveCommand(command, 'amend the commit', repoA.dir),
      ).toBeNull();
    },
  );

  it('keeps the neutral-segment exemption scoped to the registered repo', () => {
    // status is neutral, but the amend still targets B's unregistered HEAD.
    const result = isDestructiveCommand(
      'git status && git commit --amend --no-edit',
      'amend the commit',
      repoB.dir,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  it('does not read a mover name inside the amend message as a HEAD move', () => {
    // The allowlist applies to PRECEDING segments only; argument words of
    // the amend itself are data, not subcommands.
    expect(
      isDestructiveCommand(
        'git commit --amend -m reset checkout',
        'amend the commit',
        repoA.dir,
      ),
    ).toBeNull();
  });

  it('routes an unresolvable preceding subcommand to approval', () => {
    // `git $SUB` cannot be classified: unattributable (ask), consistent with
    // the stopgap's treatment of unclassifiable git invocations.
    expectAsk(
      'git $SUB && git commit --amend --no-edit',
      'amend the commit',
      repoA.dir,
    );
  });

  it('allows an amend relocated to the repo whose HEAD is registered', () => {
    // cwd=B (unregistered), but -C targets A: the exemption follows the
    // target, not the cwd.
    expect(
      isDestructiveCommand(
        `git -C ${repoA.dir} commit --amend --no-edit`,
        'amend the commit',
        repoB.dir,
      ),
    ).toBeNull();
  });

  it('keeps the no-flag exemption exactly as before', () => {
    expect(
      isDestructiveCommand(
        'git commit --amend --no-edit',
        'amend the commit',
        repoA.dir,
      ),
    ).toBeNull();
    expect(
      isDestructiveCommand(
        'git commit --amend --no-edit',
        'amend the commit',
        repoB.dir,
      ),
    ).not.toBeNull();
  });

  it('scopes GIT_DIR= to the named git directory', () => {
    expect(
      isDestructiveCommand(
        `GIT_DIR=${repoB.dir}/.git git commit --amend --no-edit`,
        'amend the commit',
        repoA.dir,
      ),
    ).not.toBeNull();
    expect(
      isDestructiveCommand(
        `GIT_DIR=${repoA.dir}/.git git commit --amend --no-edit`,
        'amend the commit',
        repoB.dir,
      ),
    ).toBeNull();
  });

  it('resolves --work-tree against the segment cwd, not the caller cwd', () => {
    // cwd=A (registered) but a leading `cd B` moves the shell, and
    // --work-tree moves only the checkout: the amend rewrites B's
    // unregistered HEAD, so the exemption must not apply (#16075 R11-1).
    const result = isDestructiveCommand(
      `cd ${repoB.dir} && git --work-tree ${repoB.dir} commit --amend --no-edit`,
      'amend the commit',
      repoA.dir,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  it('keeps the --work-tree exemption for the repo a leading cd enters', () => {
    // Mirror shape: cwd=B (unregistered), `cd A` then --work-tree A; the
    // amended HEAD is A's registered commit, so the exemption survives.
    expect(
      isDestructiveCommand(
        `cd ${repoA.dir} && git --work-tree ${repoA.dir} commit --amend --no-edit`,
        'amend the commit',
        repoB.dir,
      ),
    ).toBeNull();
  });

  it.each([
    // Non-static targets refuse the exemption entirely, even when cwd's own
    // HEAD is registered. The target is unattributable, not positively
    // foreign: approval, not hard denial (#16075 maintainer stopgap).
    'git -C "$OTHER" commit --amend --no-edit',
    'git -C relative/path commit --amend --no-edit',
    'git -C ~/repo commit --amend --no-edit',
    // Stacked relocations cannot be resolved statically.
    'git -C /tmp -C /var commit --amend --no-edit',
  ])('routes an unresolvable relocation to approval: %s', (command) => {
    expectAsk(command, 'amend the commit', repoA.dir);
  });

  // ── R7-2 fix-induced: relocations are segment-scoped and quote-aware ────

  it('does not read a -C inside the commit message as a relocation', () => {
    // cwd=B (unregistered); the message only SPELLS `-C <A>`. The old
    // whitespace split exempted this amend of B's unregistered HEAD.
    const result = isDestructiveCommand(
      `git commit --amend -m 'note -C ${repoA.dir} done'`,
      'amend the commit',
      repoB.dir,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  it('does not borrow a relocation from an adjacent segment', () => {
    // The `-C <A>` belongs to `git status`; the amend runs in cwd=B.
    const result = isDestructiveCommand(
      `git -C ${repoA.dir} status && git commit --amend --no-edit`,
      'amend the commit',
      repoB.dir,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  it('treats a post-subcommand -C as reuse-message, not a relocation', () => {
    // `git commit -C HEAD` reuses HEAD's message; the amend targets cwd=A,
    // whose HEAD is registered, so the exemption must survive.
    expect(
      isDestructiveCommand(
        'git commit --amend -C HEAD --no-edit',
        'amend the commit',
        repoA.dir,
      ),
    ).toBeNull();
  });

  it('does not read a relocation spelled in a heredoc body', () => {
    // The body is the commit message (-F -), not command words.
    expect(
      isDestructiveCommand(
        `git commit --amend -F - <<'EOF'\n-C ${repoB.dir}\nEOF`,
        'amend the commit',
        repoA.dir,
      ),
    ).toBeNull();
  });

  it.each(['cd', 'pushd'])(
    'follows %s into the repository the amend runs under',
    (cdCommand) => {
      // cwd=A (registered), but the amend runs in B after the cd.
      const result = isDestructiveCommand(
        `${cdCommand} ${repoB.dir} && git commit --amend --no-edit`,
        'amend the commit',
        repoA.dir,
      );
      expect(result).not.toBeNull();
      expect(result!.blocked).toBe(true);
    },
  );

  it('tracks a cd back to the registered repository', () => {
    expect(
      isDestructiveCommand(
        `cd ${repoB.dir} && cd ${repoA.dir} && git commit --amend --no-edit`,
        'amend the commit',
        repoA.dir,
      ),
    ).toBeNull();
  });

  it.each([
    // A subshell cd does not move this shell's cwd, and the amend inside it
    // runs under a cwd this walk cannot attribute.
    `( cd ${'%REPO_B%'} && git commit --amend --no-edit )`,
    // A dynamic cd target cannot be resolved statically.
    'cd "$TARGET" && git commit --amend --no-edit',
    // popd returns to an unknown directory.
    'popd && git commit --amend --no-edit',
  ])('routes an untrackable amend cwd to approval: %s', (template) => {
    // Unattributable, not positively foreign: approval, never a silent
    // allow (#16075 maintainer stopgap).
    const command = template.replace('%REPO_B%', repoB.dir);
    expectAsk(command, 'amend the commit', repoA.dir);
  });

  it.each(['sudo', 'env', 'env -i', 'sudo -u root'])(
    'reads a GIT_DIR handed through %s as a relocation',
    (prefix) => {
      // cwd=A (registered); the prefix command hands GIT_DIR=B through to
      // git, so the amend targets B, whose HEAD is not registered. The
      // prefix walker must not eat the assignment without recording it.
      const result = isDestructiveCommand(
        `${prefix} GIT_DIR=${repoB.dir}/.git git commit --amend --no-edit`,
        'amend the commit',
        repoA.dir,
      );
      expect(result).not.toBeNull();
      expect(result!.blocked).toBe(true);
    },
  );

  it('exempts a GIT_DIR handed through a prefix to the registered repo', () => {
    // cwd=B (unregistered); env hands GIT_DIR=A through and A's HEAD is
    // registered: the exemption follows the resolved target, not the cwd.
    expect(
      isDestructiveCommand(
        `env GIT_DIR=${repoA.dir}/.git git commit --amend --no-edit`,
        'amend the commit',
        repoB.dir,
      ),
    ).toBeNull();
  });

  it('refuses the exemption for a relocation encoded in a wrapper payload', () => {
    // The amend lives in bash's -c payload; \x20 hides the `-C <B>` from a
    // raw-text scan, but the inner git still amends B, not cwd A.
    const result = isDestructiveCommand(
      `bash -c $'git\\x20-C\\x20${repoB.dir}\\x20commit\\x20--amend\\x20--no-edit'`,
      'amend the commit',
      repoA.dir,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  it('keeps the cwd-only exemption for a payload without relocations', () => {
    expect(
      isDestructiveCommand(
        "bash -c 'git commit --amend --no-edit'",
        'amend the commit',
        repoA.dir,
      ),
    ).toBeNull();
  });

  it.each(['if', 'while'])(
    'tracks a cd wrapped in %s control flow',
    (keyword) => {
      // The condition's cd runs in this shell, so the amend runs in B even
      // though the cwd started in registered A.
      const command =
        keyword === 'if'
          ? `if cd ${repoB.dir}; then git commit --amend --no-edit; fi`
          : `while cd ${repoB.dir}; do git commit --amend --no-edit; break; done`;
      const result = isDestructiveCommand(
        command,
        'amend the commit',
        repoA.dir,
      );
      expect(result).not.toBeNull();
      expect(result!.blocked).toBe(true);
    },
  );

  it('exempts an amend after a control-flow cd to the registered repo', () => {
    expect(
      isDestructiveCommand(
        `if cd ${repoA.dir}; then git commit --amend --no-edit; fi`,
        'amend the commit',
        repoB.dir,
      ),
    ).toBeNull();
  });

  it('routes an unclassifiable direct git invocation to approval', () => {
    // `-c $X` may define an alias that amends any repository; this is not a
    // nested payload, so the cwd-only answer must not exempt it. The target
    // is unattributable, not positively foreign: approval (#16075 maintainer
    // stopgap).
    expectAsk('git -c $X y --no-edit', 'amend the commit', repoA.dir);
  });

  it('keeps the exemption for a literal -c config on a direct amend', () => {
    expect(
      isDestructiveCommand(
        'git -c user.name=x commit --amend --no-edit',
        'amend the commit',
        repoA.dir,
      ),
    ).toBeNull();
  });

  // R7-2: the exemption must follow the repository the amend actually
  // touches, not the session cwd — prefix chdirs, exported GIT_DIR, builtin
  // cd, wrapper payloads, piped/heredoc programs and pipeline cds all move
  // or hide the target (each witnessed with real bash and git).
  const amendAt = (command: string, cwd: string) =>
    isDestructiveCommand(command, 'amend the commit', cwd);

  it('blocks an amend relocated by a prefix chdir to an unregistered repo', () => {
    expect(
      amendAt(`env -C ${repoB.dir} git commit --amend --no-edit`, repoA.dir)!
        .blocked,
    ).toBe(true);
    expect(
      amendAt(`sudo -D ${repoB.dir} git commit --amend --no-edit`, repoA.dir)!
        .blocked,
    ).toBe(true);
  });

  it('exempts an amend relocated by env -C to the registered repo', () => {
    expect(
      amendAt(`env -C ${repoA.dir} git commit --amend --no-edit`, repoB.dir),
    ).toBeNull();
  });

  it('routes an amend under an exported GIT_DIR to approval', () => {
    // The exported relocation poisons the walk: unattributable, not
    // positively foreign (#16075 maintainer stopgap).
    expectAsk(
      `export GIT_DIR=${repoB.dir}/.git; git commit --amend --no-edit`,
      'amend the commit',
      repoA.dir,
    );
  });

  it('blocks an amend after builtin/command cd into an unregistered repo', () => {
    expect(
      amendAt(
        `builtin cd ${repoB.dir} && git commit --amend --no-edit`,
        repoA.dir,
      )!.blocked,
    ).toBe(true);
    expect(
      amendAt(
        `command cd ${repoB.dir} && git commit --amend --no-edit`,
        repoA.dir,
      )!.blocked,
    ).toBe(true);
  });

  it('attributes a wrapper payload amend to the cwd it inherits', () => {
    // The payload cds to B: the amend targets B, not the outer cwd A.
    expect(
      amendAt(
        `bash -c 'cd ${repoB.dir} && git commit --amend --no-edit'`,
        repoA.dir,
      )!.blocked,
    ).toBe(true);
    // The payload amends before the outer cd runs: the target is still B.
    expect(
      amendAt(
        `bash -c 'git commit --amend --no-edit' && cd ${repoA.dir}`,
        repoB.dir,
      )!.blocked,
    ).toBe(true);
    // The payload amends the inherited cwd: the exemption still applies.
    expect(
      amendAt("bash -c 'git commit --amend --no-edit'", repoA.dir),
    ).toBeNull();
  });

  it('does not move the cwd through a pipelined cd', () => {
    // Both sides of a pipe run in subshells: the amend stays at B.
    expect(
      amendAt(`cd ${repoA.dir} | cat; git commit --amend --no-edit`, repoB.dir)!
        .blocked,
    ).toBe(true);
    // Mirror: the pipelined cd to B does not move A, so the amend is exempt.
    expect(
      amendAt(`cd ${repoB.dir} | cat; git commit --amend --no-edit`, repoA.dir),
    ).toBeNull();
  });

  it('routes an amend after eval cd to approval', () => {
    // eval runs text the walk does not read: unattributable (#16075
    // maintainer stopgap).
    expectAsk(
      `eval 'cd ${repoB.dir}'; git commit --amend --no-edit`,
      'amend the commit',
      repoA.dir,
    );
  });

  it('blocks an amend inside piped/heredoc programs that cd to B', () => {
    // The walk reads these carriers and resolves the target to B: positively
    // foreign, so hard denial stands.
    expect(
      amendAt(
        `echo 'cd ${repoB.dir} && git commit --amend --no-edit' | bash`,
        repoA.dir,
      )!.blocked,
    ).toBe(true);
    expect(
      amendAt(
        `bash <<'EOF'\ncd ${repoB.dir}\ngit commit --amend --no-edit\nEOF`,
        repoA.dir,
      )!.blocked,
    ).toBe(true);
  });

  it('routes a second amend inside a command substitution to approval', () => {
    // The substitution amends a second repository the walk does not model:
    // unattributable, never exempt (#16075 maintainer stopgap).
    expectAsk(
      `git commit --amend --no-edit -m "$(git -C ${repoB.dir} commit --amend --no-edit)"`,
      'amend the commit',
      repoA.dir,
    );
  });

  it('blocks a payload amend relocated by an escaped -C', () => {
    expect(
      amendAt(
        `bash -c 'git \\-C ${repoB.dir} commit --amend --no-edit'`,
        repoA.dir,
      )!.blocked,
    ).toBe(true);
  });

  // R7-2: the walk's cwd/relocation model must not exempt an amend of a repo
  // the command does not target. Each row amends B (or an ambiguous cwd) while
  // repo A's HEAD is registered; every one was auto-approved before the fix.
  // Maintainer stopgap: unattributable targets route to approval; targets the
  // walk resolves to the unregistered repo stay hard-blocked.
  it.each([
    // unset of one exported name must not forget the other.
    `export GIT_DIR=${'%B%'}/.git; unset GIT_WORK_TREE; git commit --amend --no-edit`,
    // A poisoned cwd must reach into the wrapper payload, not reset there.
    `cd "$TARGET" && bash -c 'git commit --amend --no-edit'`,
    // eval may amend a second, unrecorded repository: terminal poison.
    `git commit --amend --no-edit && eval 'git -C ${'%B%'} commit --amend --no-edit'`,
  ])('routes an unattributable target to approval: %s', (template) => {
    const command = template.replaceAll('%B%', repoB.dir);
    expectAsk(command, 'amend the commit', repoA.dir);
  });

  it.each([
    // The carrier's GIT_DIR= prefix relocates the inner amend to B.
    `GIT_DIR=${'%B%'}/.git bash -c 'git commit --amend --no-edit'`,
    // `command -- cd` still runs the cd builtin, into B.
    `command -- cd ${'%B%'} && git commit --amend --no-edit`,
  ])(
    'blocks a target the walk resolves to the unregistered repo: %s',
    (template) => {
      const command = template.replaceAll('%B%', repoB.dir);
      expect(amendAt(command, repoA.dir)!.blocked).toBe(true);
    },
  );

  it('routes a cd bash never reaches to approval', () => {
    // cwd=B; `false && cd A` never moves the cwd. The conditional cd leaves
    // the target ambiguous — unattributable, not positively foreign (#16075
    // maintainer stopgap).
    expectAsk(
      `false && cd ${repoA.dir}; git commit --amend --no-edit`,
      'amend the commit',
      repoB.dir,
    );
  });

  // R15-1 (#16075 maintainer stopgap): an unquoted `$( … )` in the amend's
  // own arguments is a substitution, not a subshell group, but the walk's
  // paren poison cannot tell them apart and refuses the exemption. The
  // regression was a HARD DENIAL of a legitimate amend of the registered
  // commit; the stopgap routes it to approval instead. The quoted twin was
  // already exempt and stays exempt. Full exemption for substitution forms
  // belongs to the parser-redesign follow-up.
  it('routes an amend with an unquoted substitution argument to approval', () => {
    expectAsk(
      'git commit --amend -m $(date +%s)',
      'amend the commit',
      repoA.dir,
    );
    expectAsk(
      'echo $(date) && git commit --amend --no-edit',
      'amend the commit',
      repoA.dir,
    );
  });

  it('keeps the quoted-substitution twin exempt', () => {
    expect(
      amendAt('git commit --amend -m "$(date +%s)"', repoA.dir),
    ).toBeNull();
  });

  it('carries a carrier prefix GIT_DIR to the registered repo', () => {
    // cwd=B (unregistered); the prefix hands GIT_DIR=A to the inner amend and
    // A's HEAD is registered: the exemption follows the resolved target.
    expect(
      amendAt(
        `GIT_DIR=${repoA.dir}/.git bash -c 'git commit --amend --no-edit'`,
        repoB.dir,
      ),
    ).toBeNull();
  });

  it('tracks a command -- cd to the registered repo', () => {
    expect(
      amendAt(
        `command -- cd ${repoA.dir} && git commit --amend --no-edit`,
        repoB.dir,
      ),
    ).toBeNull();
  });

  it('clears only the unset exported name, keeping the other relocation', () => {
    // Unsetting GIT_DIR itself removes the relocation: the amend targets the
    // registered cwd A again (contrast the unset-GIT_WORK_TREE block row).
    expect(
      amendAt(
        `export GIT_DIR=${repoB.dir}/.git; unset GIT_DIR; git commit --amend --no-edit`,
        repoA.dir,
      ),
    ).toBeNull();
  });
});

describe('session commit tracking', () => {
  it('registerSessionCommit and clearSessionCommits work', () => {
    registerSessionCommit('abc123');
    // isAmendOfSessionCommit needs a real git repo; this only checks that
    // clearSessionCommits doesn't throw.
    clearSessionCommits();
  });

  it('isAmendOfSessionCommit returns false with no session commits', () => {
    // isAmendOfSessionCommit is not exported; tested via isDestructiveCommand.
    expectBlocked('git commit --amend', 'amend commit');
  });
});

describe('isDestructiveCommand — non-destructive commands', () => {
  it('returns null for non-git, non-IaC commands', () => {
    const commands = [
      'npm install',
      'python script.py',
      'ls -la',
      'cat file.txt',
      'echo "hello"',
      'mkdir -p src',
    ];
    expectAllowed(commands, 'do stuff');
  });
});

// ── #16075 R15-3: IFS values are command data, not regex source ───────────
// Real bash witnesses (git shim on PATH): each row below really runs
// `git commit --amend`. At the reviewed head the backslash row threw an
// uncaught SyntaxError out of the guard (/[\]+/ built from the IFS value)
// and the `]` row silently evaluated amend-free. Splitting on the IFS
// characters literally fixes both; the guard must also never crash on any
// other command string (see the crash-boundary test).
describe('isDestructiveCommand — IFS word-splitting regression (#16075 R15-3)', () => {
  beforeEach(() => {
    clearSessionCommits();
  });

  it.each([
    // Witness 1: crashed the whole permission evaluation with SyntaxError.
    "IFS='\\'; X='git\\commit\\--amend'; $X",
    // Witness 2: silently false — the `]` closed the regex character class.
    "IFS=']'; X='git]commit]--amend'; $X",
    // `^` negated the character class, splitting every character away.
    "IFS='^'; X='git^commit^--amend'; $X",
    // Several regex-active characters at once.
    "IFS='\\\\]^'; X='git\\\\commit]--amend'; $X",
  ])('blocks the amend bash really runs: %s', (command) => {
    expectBlocked(command, 'amend the commit', 'amend');
  });

  it.each([
    "IFS=:; X='ls:-la'; $X",
    "IFS='\\'; X='ls\\-la'; $X",
    "IFS=']'; X='echo]hi'; $X",
  ])('keeps a non-amend IFS split amend-free: %s', (command) => {
    expect(isDestructiveCommand(command, 'list files')).toBeNull();
  });
});
