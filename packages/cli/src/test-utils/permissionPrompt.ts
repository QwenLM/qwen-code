/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Raising a permission prompt in a test, the way the module does it.
 *
 * A test that wants a prompt on screen has to ask for one, because that is the only
 * way a prompt exists: the module calls the channel's ask handler and waits on the
 * promise it returns. Settling *is* resolving that promise, so a test that fabricated
 * a queue entry instead could not observe whether the code under test settled at all.
 */

import { vi } from 'vitest';
import type {
  HostAskHandler,
  PermissionRules,
} from '@qwen-code/core';

export interface RaisedPrompt {
  /** Resolves when something settles the prompt. */
  settled: Promise<{ kind: string }>;
  /**
   * Re-judge the call, as the module does when the mode or the rules change. This
   * is the only way a prompt leaves without whoever was asked having answered.
   */
  recheck(kind: 'allow' | 'deny'): void;
}

export function raisePrompt(
  handler: HostAskHandler,
  toolUseId: string,
  toolName = 'tool',
  opts?: { forcedAsk?: boolean; input?: Record<string, unknown> },
): RaisedPrompt {
  let listener: ((result: unknown) => void) | undefined;

  const settled = handler({
    toolUseId,
    toolName,
    input: opts?.input ?? {},
    toolCheckResult: {
      kind: 'ask',
      reason: {
        message: 'needs approval',
        // What makes an ask survive the bypass modes is its attribution, not a
        // flag: `interaction` means the prompt is the tool's whole purpose.
        attribution: opts?.forcedAsk
          ? { type: 'interaction', reason: 'the prompt is the tool' }
          : { type: 'other', reason: 'no rule' },
      },
    },
    onToolCheckResult: (fn: (result: unknown) => void) => {
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
  } as never) as Promise<{ kind: string }>;

  return {
    settled,
    recheck(kind) {
      listener?.({ kind });
    },
  };
}

/** Settled, or still waiting? For assertions that a prompt stayed on screen. */
export function watchSettlement(pending: Promise<{ kind: string }>) {
  const state: { settled?: { kind: string } } = {};
  void pending.then((result) => {
    state.settled = result;
  });
  return state;
}

/**
 * A permission module that records what was written to it and captures whatever ask
 * handler gets installed.
 *
 * Enough for the tests that only care about two questions: did the code under test
 * write the rules or directories it claimed to, and does asking through the handler
 * it installed settle the way it should. Not a real module — nothing here judges.
 */
export function createPermissionModuleStub(
  initial?: { rules?: PermissionRules; directories?: string[] },
) {
  let rules: PermissionRules =
    initial?.rules ?? ({ allow: {}, deny: {}, ask: {} } as PermissionRules);
  let directories = initial?.directories ?? [];
  let installed: HostAskHandler | undefined;

  const setRules = vi.fn(
    (next: PermissionRules, opts?: { merge?: boolean }) => {
      if (!opts?.merge) {
        rules = next;
        return;
      }
      // The merge the real module does: add into the existing buckets per
      // behaviour and source, rather than replacing them.
      const merged: PermissionRules = {
        allow: { ...rules.allow },
        deny: { ...rules.deny },
        ask: { ...rules.ask },
      };
      for (const behavior of ['allow', 'deny', 'ask'] as const) {
        for (const [source, entries] of Object.entries(next[behavior])) {
          merged[behavior][source as keyof (typeof merged)['allow']] = [
            ...(rules[behavior][
              source as keyof (typeof rules)['allow']
            ] ?? []),
            ...(entries ?? []),
          ];
        }
      }
      rules = merged;
    },
  );
  const setAdditionalDirectories = vi.fn((next: string[]) => {
    directories = next;
  });
  const addDirectory = vi.fn((dir: string) => {
    if (!directories.includes(dir)) directories = [...directories, dir];
  });
  const resetSessionScopedRules = vi.fn(() => {
    const strip = <T extends Record<string, unknown>>(bucket: T) => {
      const { session: _session, ...rest } = bucket;
      return rest;
    };
    setRules({
      allow: strip(rules.allow),
      deny: strip(rules.deny),
      ask: strip(rules.ask),
    });
  });

  return {
    setRules,
    setAdditionalDirectories,
    addDirectory,
    resetSessionScopedRules,
    setAskHandler: vi.fn((handler: HostAskHandler | undefined) => {
      installed = handler;
    }),
    getRules: () => rules,
    getAdditionalDirectories: () => directories,
    getPermissionMode: () => 'default' as const,

    /** The handler the code under test installed, for use with `raisePrompt`. */
    get askHandler(): HostAskHandler {
      if (!installed) {
        throw new Error('no ask handler was installed');
      }
      return installed;
    },
  };
}
