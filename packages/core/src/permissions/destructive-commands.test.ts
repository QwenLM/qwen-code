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
