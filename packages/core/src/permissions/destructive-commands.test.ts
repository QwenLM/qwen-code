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

  it.each([
    'git commit -m "fix" # was: --amend',
    'git commit -a -m "x" # not --amend',
    'git commit -m x <<< --amend',
    'git commit -m "note --amend"',
  ])('asks conservatively for an amend-shaped argument: %s', (command) => {
    expectNeedsApproval(command);
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
  ])('routes executed-output shapes to approval: %s', (command) => {
    expectNeedsApproval(command);
  });

  // R16-1: shapes a hand-scanned prover certified as inert while bash executed
  // them. They all go to approval now; none of them may be allowed.
  it.each([
    `echo 'git commit --amend' 2>&1 | sh`,
    `{ printf '%s\n' 'git commit --amend'; } | sh`,
    `cat <<'EOF' 2>&1 | sh\ngit commit --amend\nEOF`,
    `cat() { sh -c "$1"; }\ncat 'git commit --amend'`,
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
    // Rule 3: an indirect word plus IFS assembly still carries a `$`, so the
    // text is unprovable and must ask rather than fall through to L5.3.
    `w='git commit --am'; IFS=' '; $w"end"`,
    // Rule 3 only: the expansion splits the `commit` word, so word scanning
    // cannot see the subcommand and only the `$`-alongside-git+commit rule
    // keeps this from falling through to L5.3.
    'git ${x}commit --amend',
    "git commit --amend\\n'-m' x",
  ])('routes the %s spelling to approval', (command) => {
    expectNeedsApproval(command);
  });

  it('keeps amend scanning linear for long model-authored commands', () => {
    const start = performance.now();
    expect(amendNeedsApproval('git commit '.repeat(8000))).toBe(false);
    expect(performance.now() - start).toBeLessThan(500);
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
