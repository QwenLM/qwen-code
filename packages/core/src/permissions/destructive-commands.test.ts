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

  it('allows git commit (without --amend)', () => {
    expectAllowed(['git commit -m "fix"'], 'commit changes');
  });

  // ── #16075 R9 structural repair ─────────────────────────────────────────

  // B1 (doudouOUC): every spelling below was ALLOWED at head 733b9096 with
  // an empty session registry while the base substring guard denied it, and
  // each one really amends HEAD when executed. The fail-closed backstop must
  // deny all of them again — the recognizer may only add denials.
  it.each([
    "X='git commit --amend --no-edit'; $X",
    "sh -c ''--'' 'git commit --amend --no-edit'",
    "trap 'git commit --amend --no-edit' EXIT",
    "git rebase --exec 'git commit --amend --no-edit' HEAD~1",
    "echo 'git commit --amend --no-edit' | cat | bash",
    "env -u FOO -S 'git commit --amend --no-edit'",
    "bash -c -e 'git commit --amend --no-edit'",
    "xargs -n 1 bash -c 'git commit --amend --no-edit'",
    "find . -maxdepth 0 -exec timeout 5 sh -c 'git commit --amend --no-edit' \\;",
    "bash <<< 'echo FIRST' <<< 'git commit --amend --no-edit'",
    'bash -c "echo hi # it\'s\ngit commit --amend --no-edit"',
  ])('B1 backstop blocks a recognizer-missed amend: %s', (command) => {
    expectBlocked(command, 'amend the commit', 'amend');
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

  // The heredoc arm is inert ONLY for a quoted delimiter owned by a
  // non-shell allowlisted program: a shell owner executes the body, a pipe
  // hands it to a shell, and an unquoted delimiter lets bash expand the body.
  it.each([
    "bash <<'EOF'\ngit commit --amend\nEOF",
    "cat <<'EOF'\ngit commit --amend\nEOF | bash",
    'cat <<EOF\ngit commit --amend\nEOF',
    "cat <<'EOF'\ngit commit --amend\nEOF\nls",
  ])('B1 heredoc arm stays fail-closed outside its proof: %s', (command) => {
    expectBlocked(command, 'write a report', 'amend');
  });

  // These were ALLOWED before R9. The settled backstop design only proves
  // single-quoted words of a tiny inert-program allowlist, comments, and
  // quoted-delimiter heredocs without redirects; each case below sits outside
  // that proof (double quotes, a non-allowlisted program, a redirect, a
  // here-string, or a compound command), so the fail-closed backstop denies
  // it. They are false positives the design accepts this round — recorded
  // here, not silently dropped (#16075 R9, B1; qqqys backstop option (a)).
  it.each([
    // node is not an inert program: a `-e` payload can execute anything.
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
  ])('B1 backstop flips a formerly-allowed unprovable case: %s', (command) => {
    expectBlocked(command, 'write a report', 'amend');
  });

  // Known limitations that stay blocked this round — pinned so a future
  // narrowing of the backstop cannot silently re-open them, and not chased
  // further in R9 (#16075 R9 task scope; doudouOUC R1).
  it.each([
    // R1: unquoted inert text with a redirect — the every-offset sweep still
    // sees program-position amend words; fixing it needs the comment/newline
    // refactor the review describes.
    'echo git commit --amend >> CHANGELOG.md',
    // Double-quoted interpreter payloads are outside the inert proof.
    `node -e "console.log('git commit --amend')"`,
  ])('known limitation stays blocked: %s', (command) => {
    expectBlocked(command, 'write a report', 'amend');
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

  it.each([
    // Non-static targets refuse the exemption entirely (fail closed), even
    // when cwd's own HEAD is registered.
    'git -C "$OTHER" commit --amend --no-edit',
    'git -C relative/path commit --amend --no-edit',
    'git -C ~/repo commit --amend --no-edit',
    // Stacked relocations cannot be resolved statically.
    'git -C /tmp -C /var commit --amend --no-edit',
  ])('refuses the exemption for an unresolvable relocation: %s', (command) => {
    const result = isDestructiveCommand(command, 'amend the commit', repoA.dir);
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
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
    // runs under a cwd this walk cannot attribute: fail closed.
    `( cd ${'%REPO_B%'} && git commit --amend --no-edit )`,
    // A dynamic cd target cannot be resolved statically.
    'cd "$TARGET" && git commit --amend --no-edit',
    // popd returns to an unknown directory.
    'popd && git commit --amend --no-edit',
  ])('fails closed when the amend cwd is untrackable: %s', (template) => {
    const command = template.replace('%REPO_B%', repoB.dir);
    const result = isDestructiveCommand(command, 'amend the commit', repoA.dir);
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
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

  it('refuses the exemption for an unclassifiable direct git invocation', () => {
    // `-c $X` may define an alias that amends any repository; this is not a
    // nested payload, so the cwd-only answer must not exempt it.
    const result = isDestructiveCommand(
      'git -c $X y --no-edit',
      'amend the commit',
      repoA.dir,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
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
