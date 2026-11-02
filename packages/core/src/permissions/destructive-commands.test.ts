/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
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
    `echo "don't \$(git commit --amend --no-edit)"`,
    `x="it's \$(git commit --amend)"`,
  ])('blocks amend through an execution wrapper: %s', (command) => {
    expectBlocked(command, 'amend the commit', 'amend');
  });

  it('fails closed when eval nesting exceeds the unwrap depth cap', () => {
    // The cap is 8; a benign chain deeper than that is still refused rather
    // than allowed, so pathological nesting cannot hide an amend.
    const deep = Array.from({ length: 9 }).reduce<string>(
      (inner) => `eval '${inner}'`,
      'git commit --amend --no-edit',
    );
    expectBlocked(deep, 'amend the commit', 'amend');
  });

  it.each([
    `node -e 'console.log("a report about git commit --amend behaviour")'`,
    'echo "git commit --amend"',
    `printf '%s\\n' 'git commit --amend'`,
    'grep -n "git commit --amend" CHANGELOG.md',
    'git commit -m --amend',
    'git log --grep="git commit --amend"',
    `cat > notes.txt <<'EOF'\ngit commit --amend\nEOF`,
    // After `--` the token is a pathspec, not a flag, so this is not an amend.
    'git commit -- foo --amend',
  ])('allows inert text that mentions amend: %s', (command) => {
    expectAllowed([command], 'write a report');
  });

  it('allows git commit (without --amend)', () => {
    expectAllowed(['git commit -m "fix"'], 'commit changes');
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
