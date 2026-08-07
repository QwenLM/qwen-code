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
import type { Content } from '@google/genai';

// ─── userMentionsDiscard ───────────────────────────────────────────────────

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
    const prompts = ['丢弃所有修改', '清除工作区', '重置到初始状态'];
    for (const prompt of prompts) {
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

// ─── extractLastUserPrompt ─────────────────────────────────────────────────

describe('extractLastUserPrompt', () => {
  it('returns undefined for empty messages', () => {
    expect(extractLastUserPrompt([])).toBeUndefined();
  });

  it('extracts text from the last user message', () => {
    const messages: Content[] = [
      { role: 'user', parts: [{ text: 'first message' }] },
      { role: 'model', parts: [{ text: 'model response' }] },
      { role: 'user', parts: [{ text: 'second message' }] },
    ];
    expect(extractLastUserPrompt(messages)).toBe('second message');
  });

  it('skips model and function messages', () => {
    const messages: Content[] = [
      { role: 'model', parts: [{ text: 'model only' }] },
      { role: 'user', parts: [{ text: 'user text' }] },
      { role: 'model', parts: [{ text: 'another model' }] },
    ];
    expect(extractLastUserPrompt(messages)).toBe('user text');
  });

  it('returns undefined when no user messages exist', () => {
    const messages: Content[] = [
      { role: 'model', parts: [{ text: 'model only' }] },
    ];
    expect(extractLastUserPrompt(messages)).toBeUndefined();
  });
});

// ─── isDestructiveCommand — git patterns ───────────────────────────────────

describe('isDestructiveCommand — git patterns', () => {
  beforeEach(() => {
    clearSessionCommits();
  });

  it('blocks git reset --hard', () => {
    const result = isDestructiveCommand('git reset --hard', 'fix the bug');
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
    expect(result!.reason).toContain('git reset --hard');
  });

  it('blocks git checkout -- .', () => {
    const result = isDestructiveCommand('git checkout -- .', 'fix the bug');
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  it('blocks git clean -fd', () => {
    const result = isDestructiveCommand('git clean -fd', 'remove files');
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  it('blocks git clean -f', () => {
    const result = isDestructiveCommand('git clean -f', 'remove files');
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  it('blocks git clean -fdx', () => {
    const result = isDestructiveCommand('git clean -fdx', 'remove all');
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  it('blocks the force flag wherever it appears in git clean', () => {
    for (const cmd of [
      // Long spelling of -f.
      'git clean --force',
      'git clean --force -d',
      // Force flag after another flag, rather than as the first token.
      'git clean -d --force',
      'git clean -d -f',
      'git clean -n -f',
      'git clean --quiet -fd',
    ]) {
      const result = isDestructiveCommand(cmd, 'remove files');
      expect(result).not.toBeNull();
      expect(result!.blocked).toBe(true);
    }
  });

  it('does not pull a -f from a later command segment into git clean', () => {
    // `git clean` alone is harmless; the -f belongs to the second command.
    for (const cmd of [
      'git clean; grep -f patterns.txt file',
      'git clean && tail -f log.txt',
      'git clean | xargs -f',
    ]) {
      const result = isDestructiveCommand(cmd, 'look at logs');
      expect(result).toBeNull();
    }
  });

  it('does not pull a -f from an earlier command segment into git clean', () => {
    // The mirror of the case above, and the one a self-concatenated haystack
    // gets wrong: with `git clean` in the final segment, a scan over
    // `cmd + ' ' + cmd` leaves the first copy and picks the `-f` out of the
    // second. Every command here deletes nothing.
    for (const cmd of [
      'rm -f stale.log && git clean',
      'tail -f log.txt; git clean -n',
      'npm ci --force && git clean -n',
      'grep -rf pat.txt src | head; git clean -n',
      './deploy.sh && git checkout',
    ]) {
      const result = isDestructiveCommand(cmd, 'look at logs');
      expect(result).toBeNull();
    }
  });

  it('blocks git clean when a backslash continues the line before the flag', () => {
    // A backslash before the newline is a line continuation, so bash joins the
    // two lines into one command and the force flag does apply to this clean.
    for (const cmd of [
      'git clean \\\n -fd',
      'git clean \\\n --force',
      'git clean -d \\\n -f',
    ]) {
      const result = isDestructiveCommand(cmd, 'remove files');
      expect(result).not.toBeNull();
      expect(result!.blocked).toBe(true);
    }
  });

  it('treats a bare newline as a command separator, like ; and &&', () => {
    // Bash ends a command at an unescaped newline, so the flag on the next
    // line belongs to a different command and the clean that runs is bare.
    // Verified against bash: `git clean\n -fd` runs `git clean`, then fails
    // with `-fd: command not found`.
    for (const cmd of [
      'git clean\n -fd',
      'git clean\n --force',
      'git clean\nrm -f stale.log',
      'git clean\ntail -f log.txt',
    ]) {
      const result = isDestructiveCommand(cmd, 'look at logs');
      expect(result).toBeNull();
    }
  });

  it('blocks git checkout . (same discard as the -- . form)', () => {
    for (const cmd of [
      'git checkout .',
      'git checkout . && npm test',
      // No space before the separator — the `.` is followed by `;`/`&`/`|`
      // rather than whitespace, which an over-tight lookahead would miss.
      'git checkout .;rm -rf /tmp/x',
      'git checkout .&&npm test',
      'git checkout .|tee out.txt',
      'git checkout ./',
      // The parent forms discard a whole tree from a subdirectory — strictly
      // more than `.` does — and the `--` spelling of both is already blocked
      // by the sibling pattern, so the bare spelling cannot be the lenient one.
      'git checkout ..',
      'git checkout ../',
      // Redirects bind to the command, not the pathspec: bash tokenizes `.>`
      // as the word `.` plus a redirect, so the checkout still runs.
      'git checkout .>/dev/null',
      'git checkout .>out.txt 2>&1',
      'git checkout .<in.txt',
      // Command substitution puts the closing delimiter right after the dot.
      'echo $(git checkout .)',
      'echo `git checkout .`',
    ]) {
      const result = isDestructiveCommand(cmd, 'fix the bug');
      expect(result).not.toBeNull();
      expect(result!.blocked).toBe(true);
    }
  });

  it('blocks the longer dot-only spellings of the whole tree', () => {
    // Measured against real git rather than assumed: from the repository root
    // every `./…` form here reverts exactly what `git checkout .` reverts, and
    // from a subdirectory `../..` reverts strictly more than the `..` that is
    // already blocked. Matching only the short spellings would leave
    // `git checkout .` blocked and `git checkout ./.` allowed for two commands
    // that are identical in effect.
    for (const cmd of [
      'git checkout .//',
      'git checkout ./.',
      'git checkout ././',
      'git checkout ./..',
      'git checkout ../..',
      'git checkout ../../',
      'git checkout ..//',
      'git checkout .///',
      'git checkout .././',
      'git checkout ./../..',
      // The separator forms of the same spellings.
      'git checkout ./.>out.txt',
      'git checkout ../..;echo done',
    ]) {
      const result = isDestructiveCommand(cmd, 'fix the bug');
      expect(result).not.toBeNull();
      expect(result!.blocked).toBe(true);
    }
  });

  it('blocks git stash drop', () => {
    const result = isDestructiveCommand('git stash drop', 'remove stash');
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  it('allows git reset --hard when user mentions discard', () => {
    const result = isDestructiveCommand(
      'git reset --hard',
      'discard all local changes and reset',
    );
    expect(result).toBeNull();
  });

  it('allows git clean -fd when user mentions wipe', () => {
    const result = isDestructiveCommand(
      'git clean -fd',
      'wipe the working tree clean',
    );
    expect(result).toBeNull();
  });

  it('allows git stash drop when user mentions discard', () => {
    const result = isDestructiveCommand(
      'git stash drop',
      'discard all stashes',
    );
    expect(result).toBeNull();
  });

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
      // A leading-dot pathspec is a single file, not the whole worktree, so
      // it must not be caught by the `git checkout .` pattern.
      'git checkout .gitignore',
      'git checkout .github/workflows/ci.yml',
      'git checkout .env.local',
      // The same single files written with an explicit `./` or `../` prefix.
      // Real git reverts exactly one file for these — byte-identical in effect
      // to the undotted spellings above — so blocking them would be blocking a
      // spelling rather than a blast radius.
      'git checkout ./package.json',
      'git checkout ./.gitignore',
      'git checkout ./src/foo.ts',
      'git checkout ../README.md',
      // Directory pathspecs, consistent with the already-allowed `src` and
      // `packages/core`: a `./` prefix does not change what is discarded.
      'git checkout ./src',
      'git checkout ./packages/core',
      'git checkout ../src',
      'git checkout ../../pkg/a.ts',
      // Three dots is not a pathspec at all — git resolves it as a revision
      // and switches to a detached HEAD, reverting nothing. It sits next to
      // the dot-only pathspecs above and must not be swept up with them.
      'git checkout ...',
      // `--force` only counts on `git clean`; these are unrelated commands.
      'git push --force-with-lease',
      'git fetch --force',
    ];
    for (const cmd of safeCommands) {
      const result = isDestructiveCommand(cmd, 'do stuff');
      expect(result).toBeNull();
    }
  });
});

// ─── isDestructiveCommand — shell indirection bypass ───────────────────────

describe('isDestructiveCommand — shell indirection', () => {
  beforeEach(() => {
    clearSessionCommits();
  });

  it('blocks bash -c "git reset --hard"', () => {
    const result = isDestructiveCommand(
      'bash -c "git reset --hard"',
      'fix something',
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  it("blocks sh -c 'git clean -fd'", () => {
    const result = isDestructiveCommand(
      "sh -c 'git clean -fd'",
      'remove untracked files',
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  it('blocks zsh -c "git stash drop"', () => {
    const result = isDestructiveCommand('zsh -c "git stash drop"', 'do stuff');
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  it('allows bash -c with safe commands', () => {
    const result = isDestructiveCommand(
      'bash -c "git status && git log"',
      'check status',
    );
    expect(result).toBeNull();
  });
});

// ─── isDestructiveCommand — IaC patterns ──────────────────────────────────

describe('isDestructiveCommand — IaC patterns', () => {
  it('blocks terraform destroy', () => {
    const result = isDestructiveCommand(
      'terraform destroy',
      'update infrastructure',
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
    expect(result!.reason).toContain('terraform');
  });

  it('blocks pulumi destroy', () => {
    const result = isDestructiveCommand(
      'pulumi destroy',
      'update infrastructure',
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  it('blocks cdk destroy', () => {
    const result = isDestructiveCommand('cdk destroy', 'update infra');
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  it('allows terraform destroy when user explicitly requests it', () => {
    const result = isDestructiveCommand(
      'terraform destroy',
      'terraform destroy the staging stack',
    );
    expect(result).toBeNull();
  });

  it('allows terraform apply and plan', () => {
    const safeCommands = [
      'terraform apply',
      'terraform plan',
      'terraform init',
      'pulumi up',
      'cdk deploy',
    ];
    for (const cmd of safeCommands) {
      const result = isDestructiveCommand(cmd, 'deploy');
      expect(result).toBeNull();
    }
  });

  // Scanning `command + ' ' + stripped` let a two-token pattern match the tail
  // of one copy against the head of the next. `destroy.sh --cdk` concatenates
  // to `destroy.sh --cdk destroy.sh --cdk`, where `cdk destroy` appears only at
  // the seam — an adjacency the user never typed.
  it.each([['destroy.sh --cdk'], ['./destroy-stack.sh --with terraform']])(
    'does not block %s, where the tool name and destroy are not adjacent',
    (command) => {
      expect(isDestructiveCommand(command, 'clean up')).toBeNull();
    },
  );

  // Over-correction guard: unwrapping `bash -c "…"` is the whole reason both
  // spellings are tested, and it must still be caught. Passes before and after.
  it('still blocks a wrapped IaC destroy', () => {
    const result = isDestructiveCommand(
      'bash -c "terraform destroy"',
      'update infra',
    );
    expect(result?.blocked).toBe(true);
    expect(result!.reason).toContain('terraform');
  });

  it('names the tool when only the unwrapped spelling matches', () => {
    // Contrived, but it is the one shape that reaches this branch: the quote
    // breaks the adjacency in the raw command, so the pattern matches only
    // after unwrapping. Reading the tool name off the raw command alone
    // reported "unknown" in the message.
    const result = isDestructiveCommand(
      'bash -c "terraform" destroy',
      'update infra',
    );
    expect(result?.blocked).toBe(true);
    expect(result!.reason).toContain('terraform');
    expect(result!.reason).not.toContain('unknown');
  });
});

// ─── isDestructiveCommand — git commit --amend ────────────────────────────

describe('isDestructiveCommand — git commit --amend', () => {
  beforeEach(() => {
    clearSessionCommits();
  });

  it('blocks git commit --amend when no session commits registered', () => {
    const result = isDestructiveCommand(
      'git commit --amend --no-edit',
      'amend the commit',
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
    expect(result!.reason).toContain('amend');
  });

  it('allows git commit (without --amend)', () => {
    const result = isDestructiveCommand(
      'git commit -m "fix"',
      'commit changes',
    );
    expect(result).toBeNull();
  });

  // The amend check tests both spellings rather than their concatenation, so
  // pin the wrapped form that only the unwrapped spelling reaches. Passes
  // before and after.
  it('blocks an amend inside a shell wrapper', () => {
    const result = isDestructiveCommand(
      'bash -c "git commit --amend --no-edit"',
      'amend the commit',
    );
    expect(result?.blocked).toBe(true);
    expect(result!.reason).toContain('amend');
  });
});

// ─── session commit tracking ──────────────────────────────────────────────

describe('session commit tracking', () => {
  beforeEach(() => {
    clearSessionCommits();
  });

  it('registerSessionCommit and clearSessionCommits work', () => {
    registerSessionCommit('abc123');
    // Can't test isAmendOfSessionCommit directly without a real git repo,
    // but we can verify clearSessionCommits doesn't throw
    clearSessionCommits();
  });

  it('isAmendOfSessionCommit returns false with no session commits', () => {
    // isAmendOfSessionCommit is not exported, but we test it indirectly
    // through isDestructiveCommand
    const result = isDestructiveCommand('git commit --amend', 'amend commit');
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });
});

// ─── non-shell commands ──────────────────────────────────────────────────

describe('isDestructiveCommand — non-destructive commands', () => {
  beforeEach(() => {
    clearSessionCommits();
  });

  it('returns null for non-git, non-IaC commands', () => {
    const commands = [
      'npm install',
      'python script.py',
      'ls -la',
      'cat file.txt',
      'echo "hello"',
      'mkdir -p src',
    ];
    for (const cmd of commands) {
      const result = isDestructiveCommand(cmd, 'do stuff');
      expect(result).toBeNull();
    }
  });
});
