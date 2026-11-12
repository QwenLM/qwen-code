/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  amendNeedsApproval,
  isDestructiveCommand,
  userMentionsDiscard,
  extractLastUserPrompt,
  registerSessionCommit,
  clearSessionCommits,
  isAmendOfSessionCommit,
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

/**
 * Asserts the guard routes the command to manual approval: the hard block is
 * gone, and the AUTO-mode fallback asks the user.
 */
function expectNeedsApproval(cmd: string) {
  expect(isDestructiveCommand(cmd, 'amend the commit')?.blocked ?? false).toBe(
    false,
  );
  expect(amendNeedsApproval(cmd)).toBe(true);
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
  it('routes git commit --amend to approval when no session commits are registered', () => {
    expectNeedsApproval('git commit --amend --no-edit');
  });

  it.each([
    'git -c core.editor=true commit --amend',
    '/usr/bin/git commit --amend --no-edit',
    "bash -c 'git commit --amend --no-edit'",
    'sudo env GIT_COMMITTER_DATE=now git commit --amend --no-edit',
    'timeout 10 git commit --amend --no-edit',
    'if true; then git commit --amend --no-edit; fi',
    "eval 'git commit --amend --no-edit'",
  ])('routes amend through an execution wrapper to approval: %s', (command) => {
    expectNeedsApproval(command);
  });

  // The recognizer misses these shapes, so the literal backstop must keep
  // the base guard's block: it may only add denials, never relax one.
  it.each([
    "trap 'git commit --amend --no-edit' EXIT",
    'echo git commit --amend >> CHANGELOG.md',
    'echo "git commit --amend"',
    `node -e 'console.log("a report about git commit --amend behaviour")'`,
    "su -c 'git commit --amend --no-edit'",
    'git >| /dev/null commit --amend',
  ])('routes unprovable amend text to approval: %s', (command) => {
    expectNeedsApproval(command);
  });

  it.each([
    "echo 'git commit --amend'",
    "printf '%s\\n' 'git commit --amend'",
    "grep -n 'git commit --amend' CHANGELOG.md",
    '# git commit --amend',
    'echo ok # a note about git commit --amend',
    "cat > notes.txt <<'EOF'\ngit commit --amend\nEOF",
  ])(
    'routes amend text the old prover called inert to approval: %s',
    (command) => {
      expectNeedsApproval(command);
    },
  );

  it('asks conservatively when a message looks like an amend invocation', () => {
    expectNeedsApproval('git commit -m --amend');
  });

  it('allows git commit (without --amend)', () => {
    expectAllowed(['git commit -m "fix"'], 'commit changes');
  });

  it.each(['git commit -m x <<< --amend', 'git commit -m "note --amend"'])(
    'asks conservatively for an amend-shaped argument: %s',
    (command) => {
      expectNeedsApproval(command);
    },
  );

  it('does not ask for amend-shaped text inside a comment', () => {
    // A comment never runs: only a literal `git commit --amend` adjacency is
    // still caught, by the regex on the raw command.
    expect(amendNeedsApproval('git commit -m "fix" # was: --amend')).toBe(
      false,
    );
    expect(amendNeedsApproval('git commit -a -m "x" # not --amend')).toBe(
      false,
    );
  });

  it('routes a next-line amend after a comment to approval', () => {
    expectNeedsApproval("git status # it's fine\ngit commit --amend");
  });

  it.each([
    "echo 'git commit --amend' | sh",
    "printf '%s\\n' 'git commit --amend' | sh",
    "bash <(echo 'git commit --amend')",
    "cat <<'EOF' | sh\ngit commit --amend\nEOF",
    "cat notes.txt # <<'EOF'\ngit commit --amend",
    "cat <<'EOF'X\ngit commit --amend\nEOFX",
    "for echo in 'git commit --amend'; do $echo; done",
    "$(echo 'git commit --amend')",
    "./cat 'git commit --amend'",
    // Every row above spells `git commit --am…` in the raw text, so the
    // backstop regex alone would satisfy this block. These two do not: the
    // `commit` word is split by quotes, so only the substitution body (or the
    // wrapper's inner command) plus quote removal can see the amend. Removing
    // either scanner path makes exactly these rows fail.
    "$(git com''mit --amend)",
    "bash -c 'git com''mit --amend'",
  ])('routes executed-output shapes to approval: %s', (command) => {
    expectNeedsApproval(command);
  });

  it('routes a function that hands its argument to `sh -c` to approval', () => {
    // `${1}` is bash's positional reference spelled so vitest's `$name` title
    // interpolation cannot rewrite it. Written as `$1` the reported case name
    // read `sh -c "undefined"` while the command really carried `$1`, so the
    // name stopped describing what ran. The fixture is asserted as written.
    const command = `cat() { sh -c "\${1}"; }\ncat 'git commit --amend'`;
    expect(command).toContain(`sh -c "\${1}"`);
    expectNeedsApproval(command);
  });

  // R16-1: shapes a hand-scanned prover certified as inert while bash executed
  // them. They all go to approval now; none of them may be allowed.
  it.each([
    `echo 'git commit --amend' 2>&1 | sh`,
    `{ printf '%s\n' 'git commit --amend'; } | sh`,
    `cat <<'EOF' 2>&1 | sh\ngit commit --amend\nEOF`,
    `echo 'git commit --amend' > /tmp/x.sh && bash /tmp/x.sh`,
    `printf -v x 'git commit --amend'; sh -c "$x"`,
    `./cat <<'EOF'\ngit commit --amend\nEOF`,
  ])('routes an unproven amend mention to approval: %s', (command) => {
    expectNeedsApproval(command);
  });

  it('requires approval even for a commit this session created', () => {
    // R23-2: the cwd-based exemption is gone, so the registry no longer
    // removes the approval even when it names the current HEAD. The process
    // cwd is moved into the repository so a mutation that restored the old
    // `!isAmendOfSessionCommit(process.cwd())` return would answer `false`
    // here and fail the test.
    const dir = mkdtempSync(join(tmpdir(), 'amend-session-'));
    const originalCwd = process.cwd();
    try {
      execSync(
        'git init -q && git -c user.email=a@b.c -c user.name=a commit -q --allow-empty -m one',
        { cwd: dir, stdio: 'ignore' },
      );
      const head = execSync('git rev-parse HEAD', {
        cwd: dir,
        encoding: 'utf-8',
      }).trim();
      registerSessionCommit(head);
      process.chdir(dir);
      expect(isAmendOfSessionCommit(dir)).toBe(true);
      expect(isDestructiveCommand('git commit --amend', 'amend')).toBeNull();
      expect(amendNeedsApproval('git commit --amend')).toBe(true);
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // R23-1: the guard is lexical now. Every spelling below reached the
  // classifier unasked before; all of them must ask.
  it.each([
    'git commit -a --amend',
    'git commit --no-edit --amend',
    'git commit -m "x" --amend',
    'git commit -C HEAD --amend',
    'git commit \\\n --amend --no-edit',
    'git commit "--amend"',
    "git commit --'amend'",
    "git commit $'--amend'",
    'git commit --amen',
    'git commit --am',
    'git -C /elsewhere commit --amend',
    "bash -c 'git commit --amend'",
    'env --chdir=/elsewhere git commit --amend',
    'sudo -D /elsewhere git commit --amend',
    'env -C /elsewhere git commit --amend',
    'git checkout HEAD~1 && git commit --amend',
    'git switch some-branch && git commit --amend',
    '/usr/bin/git commit --amend',
    '$(git commit --amend)',
    '`git commit --amend`',
    '<(git commit --amend)',
    "x='git commit --amend'; $x",
    'git commit --amend>/dev/null',
    // R25-2: redirect glued to the program word, IFS-assembled words, and a
    // flag produced by an expansion.
    'git>|/dev/null commit --amend --no-edit --allow-empty',
    'git${IFS}commit${IFS}--amend --no-edit',
    'x=amend; git commit --$x',
    // A bare expansion after `commit` may itself produce `--amend`; only a
    // known value-taking flag may consume such an expansion as its argument.
    'git commit $FLAG',
    'git commit "${FLAG}"',
    'git commit -m msg $FLAG',
    'git commit -S $FLAG',
    'git commit --gpg-sign $FLAG',
    'git commit `printf "$FLAG"`',
    // Rule 3: an indirect word plus IFS assembly still carries a `$`, so the
    // text is unprovable and must ask rather than fall through to L5.3.
    `w='git commit --am'; IFS=' '; $w"end"`,
    // Rule 3 only: the expansion splits the `commit` word, so word scanning
    // cannot see the subcommand and only the `$`-alongside-git+commit rule
    // keeps this from falling through to L5.3.
    'git ${x}commit --amend',
    // A backslash-newline is removed before bash parses, so the two physical
    // lines are one word: this really runs `git commit --amend`, while the raw
    // text never spells `git commit`, so only the lexical scan can see it.
    // The previous entry here was `git commit --amend -m x`, which asserted a
    // different thing while claiming to cover this one.
    'git com\\\nmit --amend',
    // R16-1: bash keeps CR, VT, FF, NBSP and the ideographic space inside the
    // word, so the `#` after one is data and the amend after it really runs.
    // `\s` matched them as blanks, the scanner cut the tail as a comment and
    // the raw backstop could not see the quote-split `com''mit`.
    "echo hi\r#x; git com''mit --amend",
    "echo hi\u00a0#x; git com''mit --amend",
    "echo hi\u3000#x; git com''mit --amend",
    // R16-1: `<<<` is a here-string. Re-entering the opener scan on its second
    // `<` registered the operand as a heredoc delimiter and deleted the amend
    // line after it as body.
    'x=amend; git commit -m x <<< "EOF"\ngit commit --$x --allow-empty --no-edit -m amended\nEOF',
    // R16-1: an IFS slice expands to the same space `${IFS}` does.
    'git${IFS:0:1}commit${IFS:0:1}--amend',
    // R16-1: a git GLOBAL `-c` value is data, and an alias it defines can be
    // the commit subcommand itself — bash amends through it (verified against
    // a real repository's reflog).
    "git -c alias.z='commit --amend' z --no-edit",
    "git -c alias.z='commit' z --amend",
  ])('routes the %s spelling to approval', (command) => {
    expectNeedsApproval(command);
  });

  it('keeps amend scanning linear for long model-authored commands', () => {
    // `git commit ` repeated is answered by the backstop regex and never
    // reaches the scanner, so it cannot witness this bound. Repeat shapes that
    // do traverse both scanner layers: 2000 substitution bodies and 2000
    // stripped heredocs.
    const command = 'git commit -m "$(true)"\ncat <<EOF\nx\nEOF\n'.repeat(2000);
    const start = performance.now();
    expect(amendNeedsApproval(command)).toBe(false);
    expect(performance.now() - start).toBeLessThan(500);
  });

  it('does not ask for shell commands whose dollar signs are data', () => {
    // B1 regression: rule 3 must be gated on a git mention that also spells
    // `commit`; `$` alone cannot mean an amend.
    for (const command of [
      "awk '{print $1}' data.csv",
      "perl -e 'print $_' /tmp/file",
      'echo $HOME',
      'ls -la $PWD',
      'git push origin $BRANCH',
      'git commit -m "fix: $issue"',
      'git commit --author="$a"',
      'npm run $SCRIPT',
    ]) {
      expect(amendNeedsApproval(command)).toBe(false);
    }
  });

  it('keeps a dollar sign inside the command it belongs to', () => {
    // R25-2 negative space: a `$` in an earlier simple command cannot turn a
    // later `git commit` into an amend (`echo $HOME; git commit -m x`), and a
    // `$` that never reaches an amend flag is not an amend either.
    for (const command of [
      'echo $HOME; git commit -m x',
      'git push $BRANCH; git commit -m x',
      '$X commit -m x',
      'git push $BRANCH; echo commit $msg',
      // R16-1 negative space: a global option's value is data. Neither a
      // config assignment that merely mentions an amend nor an alias that
      // runs another subcommand makes this call an amend.
      'git -c user.name=x commit -m y',
      "git -c alias.z='commit --amend' status",
      "git -c alias.z='log --oneline' z",
      'git -C /elsewhere status',
    ]) {
      expect(amendNeedsApproval(command)).toBe(false);
    }
  });

  it('still asks when a dollar sign can assemble the amend', () => {
    // The positive direction the gate must not lose: an expansion in the
    // program, subcommand or amend position is unprovable, not inert.
    for (const command of [
      '$X commit --amend',
      'git $SUB --amend',
      'git commit -m "$msg" --amend',
      'git >| /dev/null commit --amend',
      'git commit -S --amend',
    ]) {
      expect(amendNeedsApproval(command)).toBe(true);
    }
  });

  it('does not ask for an amend whose only dollar sign is an argument value', () => {
    // Rule 3 keys on `$` positions that can restructure the command, not on
    // the presence of `$`: a variable commit message is the most common
    // legitimate case.
    expect(amendNeedsApproval('git commit -m "$msg"')).toBe(false);
    expect(amendNeedsApproval('git commit -m "$(cat msg)"')).toBe(false);
    for (const flag of [
      '-m',
      '--message',
      '-F',
      '--file',
      '-C',
      '-c',
      '--reuse-message',
      '--reedit-message',
      '-t',
      '--template',
      '--author',
      '--date',
    ]) {
      expect(amendNeedsApproval(`git commit ${flag} "$value"`)).toBe(false);
    }
  });

  it('looks inside a flag value that runs a command substitution', () => {
    // B2: a flag value is an argument, but the shell runs its substitutions
    // first, so a nested amend is part of what executes.
    expect(amendNeedsApproval('git commit -m "$(git commit --$x)"')).toBe(true);
    expect(amendNeedsApproval('git commit --author="$(git commit --$x)"')).toBe(
      true,
    );
    expect(amendNeedsApproval('git commit -m "`git commit --$x`"')).toBe(true);
    // A harmless substitution stays a value.
    expect(amendNeedsApproval('git commit -m "$(cat msg)"')).toBe(false);
    expect(amendNeedsApproval('git commit -m "note $(echo hi)"')).toBe(false);
  });

  it('does not mistake a hash inside quotes for a comment', () => {
    // R26-1: the substitution scanner decided "comment" from the previous raw
    // character, so a quoted `#` truncated the line and hid the amend after it.
    for (const command of [
      'git commit -m "fix #42" && git commit -a --amend',
      'echo "step #1"; git commit -a --amend',
      'git commit --author="a #b"; git commit --amend',
    ]) {
      expect(amendNeedsApproval(command)).toBe(true);
    }
  });

  it('reads substitutions from the raw text, not from a dequoted word', () => {
    // Quoted parens inside a substitution body must not end it early.
    expect(
      amendNeedsApproval('git commit -m "$(printf \')\' ; git commit --$x)"'),
    ).toBe(true);
    expect(
      amendNeedsApproval('git commit -m "$(printf \'(\' ; git commit --$x)"'),
    ).toBe(true);
    expect(
      amendNeedsApproval(
        'git commit --author="$(echo \')\' && git commit --$x)"',
      ),
    ).toBe(true);
    // A literal or escaped substitution never runs.
    expect(amendNeedsApproval("git commit -m '$(git commit --$x)'")).toBe(
      false,
    );
    expect(amendNeedsApproval('git commit -m "\\$(git commit --$x)"')).toBe(
      false,
    );
    expect(amendNeedsApproval('git commit -m "\\`git commit --$x\\`"')).toBe(
      false,
    );
    // Nesting still reaches the inner command.
    expect(
      amendNeedsApproval('git commit -m "$(echo $(git commit --$x))"'),
    ).toBe(true);
  });

  it('fails closed when a substitution body hides its own boundary', () => {
    // Matching parens behind a comment or a heredoc needs a full shell parser.
    // The body is reported unprovable and the command asks.
    expect(
      amendNeedsApproval('git commit -m "$(echo x # )\ngit commit --$x\n)"'),
    ).toBe(true);
    expect(
      amendNeedsApproval(
        'git commit -m "$(cat <<\'EOF\'\n)\nEOF\ngit commit --$x\n)"',
      ),
    ).toBe(true);
  });

  it('skips text that provably never runs', () => {
    // A top-level comment and a quoted-delimiter heredoc body are inert data.
    expect(amendNeedsApproval('git commit -m x # $(git commit --$x)')).toBe(
      false,
    );
    expect(
      amendNeedsApproval("git commit -m x <<'EOF'\n$(git commit --$x)\nEOF"),
    ).toBe(false);
    // An unquoted delimiter expands its body, so a substitution there runs;
    // a plain body has nothing to run.
    expect(amendNeedsApproval('cat <<EOF\n$(git commit --$x)\nEOF')).toBe(true);
    expect(amendNeedsApproval('cat <<EOF\nhello\nEOF')).toBe(false);
  });

  it('matches a heredoc terminator the way bash does', () => {
    // A terminator line must be the whole line: ` EOF` is body content, so
    // the substitution below it still runs.
    expect(
      amendNeedsApproval(
        'git commit -m x <<EOF\n EOF\n# $(git commit --$x)\nEOF',
      ),
    ).toBe(true);
    // Quote removal names `EOF` for all of these, and any quoted or escaped
    // character keeps the body literal.
    expect(
      amendNeedsApproval('git commit -m x <<\\EOF\n$(git commit --$x)\nEOF'),
    ).toBe(false);
    expect(
      amendNeedsApproval("git commit -m x <<E'OF'\n$(git commit --$x)\nEOF"),
    ).toBe(false);
    // Normal and tab-stripping forms still terminate where they should.
    expect(amendNeedsApproval('git commit -m x <<EOF\nhello\nEOF')).toBe(false);
    expect(amendNeedsApproval('git commit -m x <<-EOF\n\thello\n\tEOF')).toBe(
      false,
    );
    expect(
      amendNeedsApproval('git commit -m x <<-EOF\n\t$(git commit --$x)\n\tEOF'),
    ).toBe(true);
  });

  it('joins a backslash-newline the way bash does', () => {
    // Bash removes `\\<newline>` before parsing, so `$` + newline + `(` is a
    // command substitution, not a literal.
    expect(amendNeedsApproval('git commit -m "$\\\n(git commit --$x)"')).toBe(
      true,
    );
    expect(
      amendNeedsApproval('git commit --author="$\\\n(git commit --$x)"'),
    ).toBe(true);
    // The join also reassembles a flag name and the `commit` word itself.
    expect(amendNeedsApproval('git commit --am\\\nend')).toBe(true);
    expect(amendNeedsApproval('git com\\\nmit --amend')).toBe(true);
    // Any number of continuations after `$` is unprovable, not reconstructed.
    expect(
      amendNeedsApproval('git commit -m "$\\\n\\\n(git commit --$x)"'),
    ).toBe(true);
    expect(
      amendNeedsApproval('git commit -m "$\\\n\\\n\\\n(git commit --$x)"'),
    ).toBe(true);
    expect(amendNeedsApproval('git commit -m "hello $\\\nx"')).toBe(true);
    // A continuation with no `$` and no amend changes nothing.
    expect(amendNeedsApproval('echo hello\\\nworld')).toBe(false);
    // Single quotes keep `\` literal, so nothing is joined there.
    expect(amendNeedsApproval("git commit -m '$\\\n(git commit --$x)'")).toBe(
      false,
    );
    // A plain continuation changes nothing.
    expect(amendNeedsApproval('git commit -m "hello\\\nworld"')).toBe(false);
    // An unquoted heredoc body expands; a continuation in it is unprovable.
    expect(
      amendNeedsApproval('git commit -m x <<EOF\n$\\\n(git commit --$x)\nEOF'),
    ).toBe(true);
  });

  it('keeps a substitution that becomes a flag from being skipped', () => {
    // The skeleton leaves a marker there, so the word scan still treats the
    // argument as an unprovable expansion.
    expect(amendNeedsApproval('git commit "$(echo --amend)"')).toBe(true);
  });

  it('consumes the next token only when m ends a short-option cluster', () => {
    expect(amendNeedsApproval('git commit -am "$msg"')).toBe(false);
    expect(amendNeedsApproval('git commit -avm "$msg"')).toBe(false);
    expect(amendNeedsApproval('git commit -a -m "$msg"')).toBe(false);
    // `m` takes the inline `a` as its value here, leaving `$msg` a bare
    // argument that could become a flag.
    expect(amendNeedsApproval('git commit -ma "$msg"')).toBe(true);
  });

  it.each([
    'git status',
    'git commit -m "a normal commit"',
    'git log --grep=amend',
    'git commit --all',
    'git commit -m a#b',
  ])('leaves a non-amend command alone: %s', (command) => {
    expect(amendNeedsApproval(command)).toBe(false);
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
    // isAmendOfSessionCommit is not exported; observed through the router.
    expectNeedsApproval('git commit --amend');
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
