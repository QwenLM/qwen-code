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
function expectNeedsApproval(cmd: string, cwd?: string) {
  expect(isDestructiveCommand(cmd, 'amend the commit')?.blocked ?? false).toBe(
    false,
  );
  expect(amendNeedsApproval(cmd, cwd)).toBe(true);
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

  // `--amend` here is the value of `-m`, not an operator: it never mentioned an
  // amend invocation, so it stays allowed on both the old and the new guard.
  it('keeps git commit -m --amend allowed', () => {
    expectAllowed(['git commit -m --amend'], 'commit changes');
  });

  it('allows git commit (without --amend)', () => {
    expectAllowed(['git commit -m "fix"'], 'commit changes');
  });

  it.each([
    'git commit -m "fix" # was: --amend',
    'git commit -a -m "x" # not --amend',
    'git commit -m x <<< --amend',
    'git commit -m a#b',
  ])(
    'does not read comments or here-strings as amend arguments: %s',
    (command) => {
      expectAllowed([command], 'commit changes');
    },
  );

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

  it('allows an amend of a commit this session created', () => {
    // The registry is keyed by HEAD, so this needs a real repository.
    const dir = mkdtempSync(join(tmpdir(), 'amend-session-'));
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
      expect(isDestructiveCommand('git commit --amend', 'amend')).toBeNull();
      expect(amendNeedsApproval('git commit --amend', dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
