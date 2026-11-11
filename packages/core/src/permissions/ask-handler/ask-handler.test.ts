/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { PermissionModes } from '../manager/decision/index.js';
import {
  createAskHandler,
  promptForCheck,
  type AskPresenter,
  type AskPrompt,
  rememberApproval,
  type AskSettlement,
} from './ask-handler.js';
import { createPermissionManager } from '../../test-utils/config.js';
import type { ToolPermissionReason } from '../../tools/tool-checkers/checker-reasons.js';
import type { SettingsWriter } from '../settings/permissionsLoader.js';
import { ASK_USER_TOOL_NAME, READ_FILE_TOOL_NAME } from '../../tools/tool-names.js';

function reason(
  overrides: Partial<ToolPermissionReason> = {},
): ToolPermissionReason {
  return {
    message: 'Allow this?',
    attribution: { type: 'other', reason: 'test' },
    ...overrides,
  };
}

/** A handler context with only what the handler reads. */
function context(overrides: Record<string, unknown> = {}) {
  const listeners = new Set<(result: unknown) => void>();
  const ctx = {
    toolUseId: 'call-1',
    toolName: READ_FILE_TOOL_NAME,
    input: { file_path: '/repo/secret.txt' },
    toolCheckResult: { kind: 'ask', reason: reason() },
    onToolCheckResult: (listener: (result: unknown) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ...overrides,
  };
  return {
    ctx,
    push: (result: unknown) => {
      for (const listener of [...listeners]) {
        listener(result);
      }
    },
    listenerCount: () => listeners.size,
  };
}

function presenter(
  overrides: Partial<AskPresenter> = {},
): AskPresenter & { shown: AskPrompt[]; refreshed: AskPrompt[]; tornDown: number } {
  const shown: AskPrompt[] = [];
  const refreshed: AskPrompt[] = [];
  let tornDown = 0;
  return {
    shown,
    refreshed,
    get tornDown() {
      return tornDown;
    },
    present(prompt) {
      shown.push(prompt);
      return () => {
        tornDown += 1;
      };
    },
    refresh(prompt) {
      refreshed.push(prompt);
    },
    ...overrides,
  } as AskPresenter & {
    shown: AskPrompt[];
    refreshed: AskPrompt[];
    tornDown: number;
  };
}

describe('promptForCheck', () => {
  it('shows the real input when the check offered no projection', () => {
    const prompt = promptForCheck(
      { kind: 'ask', reason: reason() },
      {
        toolUseId: 'c',
        toolName: READ_FILE_TOOL_NAME,
        input: { file_path: '/a' },
      },
    );

    expect(prompt.input).toEqual({ file_path: '/a' });
  });

  it('shows the projection instead of the input when one is supplied', () => {
    // The model can pre-fill the question tool's answers. Rendering them as-is
    // would display a fabricated choice as though the user had made it.
    const prompt = promptForCheck(
      {
        kind: 'ask',
        reason: reason(),
        extra: { promptInput: { questions: [{ header: 'Pick' }] } },
      },
      {
        toolUseId: 'c',
        toolName: ASK_USER_TOOL_NAME,
        input: {
          questions: [{ header: 'Pick' }],
          answers: { Pick: 'already chosen' },
        },
      },
    );

    expect(prompt.input).toEqual({ questions: [{ header: 'Pick' }] });
    expect(prompt.input['answers']).toBeUndefined();
  });

  it('marks an interaction ask as unskippable', () => {
    const prompt = promptForCheck(
      {
        kind: 'ask',
        reason: reason({
          attribution: { type: 'interaction', reason: 'the prompt is the point' },
        }),
      },
      { toolUseId: 'c', toolName: ASK_USER_TOOL_NAME, input: {} },
    );

    expect(prompt.skippable).toBe(false);
  });

  it('marks an ordinary ask as skippable', () => {
    const prompt = promptForCheck(
      { kind: 'ask', reason: reason() },
      { toolUseId: 'c', toolName: READ_FILE_TOOL_NAME, input: {} },
    );

    expect(prompt.skippable).toBe(true);
  });

  it('carries the suggestions through', () => {
    const suggestion = {
      type: 'addRules' as const,
      destination: 'session' as const,
      behavior: 'allow' as const,
      rules: [{ toolName: READ_FILE_TOOL_NAME }],
    };

    const prompt = promptForCheck(
      { kind: 'ask', reason: reason(), suggestions: [suggestion] },
      { toolUseId: 'c', toolName: READ_FILE_TOOL_NAME, input: {} },
    );

    expect(prompt.suggestions).toEqual([suggestion]);
  });
});

describe('createAskHandler', () => {
  it('settles with the answer the user gave', async () => {
    const channel = presenter({
      present: (_prompt, settle) => {
        settle({ kind: 'approved' });
        return () => {};
      },
    });
    const { ctx } = context();

    const result = await createAskHandler(channel)(ctx as never);

    expect(result).toEqual({ kind: 'approved' });
  });

  it('shows the prompt exactly once', async () => {
    const channel = presenter({
      present: (prompt, settle) => {
        channel.shown.push(prompt);
        settle({ kind: 'rejected' });
        return () => {};
      },
    });
    const { ctx } = context();

    await createAskHandler(channel)(ctx as never);

    expect(channel.shown).toHaveLength(1);
  });

  it('approves without an answer when a recheck says allow', async () => {
    const channel = presenter();
    const { ctx, push } = context();

    const pending = createAskHandler(channel)(ctx as never);
    push({ kind: 'allow' });

    expect(await pending).toEqual({ kind: 'approved' });
  });

  it('refuses without an answer when a recheck says deny', async () => {
    const channel = presenter();
    const { ctx, push } = context();

    const pending = createAskHandler(channel)(ctx as never);
    push({ kind: 'deny' });

    expect(await pending).toEqual({ kind: 'rejected' });
  });

  it('keeps the prompt when a recheck deny arrives under a prompting mode', async () => {
    // A rule written while the user is deciding must not dismiss the dialog:
    // deny settles only in modes that never prompt.
    const channel = presenter();
    const { ctx, push } = context();

    const pending = createAskHandler(channel, {
      getCurrentMode: () => PermissionModes.Default,
    })(ctx as never);
    push({ kind: 'deny' });

    let done = false;
    void pending.then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);

    // The user's decision still stands.
    push({ kind: 'allow' });
    expect(await pending).toEqual({ kind: 'approved' });
  });

  it('settles a recheck deny in modes that never prompt', async () => {
    for (const mode of [PermissionModes.Auto, PermissionModes.DontAsk]) {
      const channel = presenter();
      const { ctx, push } = context();

      const pending = createAskHandler(channel, {
        getCurrentMode: () => mode,
      })(ctx as never);
      push({ kind: 'deny' });

      expect(await pending).toEqual({ kind: 'rejected' });
    }
  });

  it('redraws instead of settling when a recheck still says ask', async () => {
    const channel = presenter();
    const { ctx, push } = context();

    const pending = createAskHandler(channel)(ctx as never);
    push({ kind: 'ask', reason: reason({ message: 'Allow this, revised?' }) });

    expect(channel.refreshed).toHaveLength(1);
    expect(channel.refreshed[0].reason.message).toBe('Allow this, revised?');

    // Still waiting: a fresh ask is not an answer.
    let done = false;
    void pending.then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);

    push({ kind: 'allow' });
    expect(await pending).toEqual({ kind: 'approved' });
  });

  it('lets the first source win and drops the rest', async () => {
    let settleFn: ((r: AskSettlement) => void) | undefined;
    const channel = presenter({
      present: (_prompt, settle) => {
        settleFn = settle;
        return () => {};
      },
    });
    const { ctx, push } = context();

    const pending = createAskHandler(channel)(ctx as never);

    settleFn?.({ kind: 'approved' });
    // Everything after this must be ignored, not throw or change the answer.
    push({ kind: 'deny' });
    settleFn?.({ kind: 'rejected' });

    expect(await pending).toEqual({ kind: 'approved' });
  });

  it('aborts when the signal fires while waiting', async () => {
    const controller = new AbortController();
    const channel = presenter();
    const { ctx } = context({ signal: controller.signal });

    const pending = createAskHandler(channel)(ctx as never);
    controller.abort();

    expect(await pending).toEqual({ kind: 'aborted' });
  });

  it('aborts immediately when the signal already fired', async () => {
    const controller = new AbortController();
    controller.abort();
    const channel = presenter();
    const { ctx } = context({ signal: controller.signal });

    const result = await createAskHandler(channel)(ctx as never);

    expect(result).toEqual({ kind: 'aborted' });
    // Nothing should have been drawn for a call that is already gone.
    expect(channel.shown).toHaveLength(0);
  });

  it('takes the prompt down however it ended', async () => {
    const teardown = vi.fn();
    const channel = presenter({
      present: () => teardown,
    });
    const { ctx, push } = context();

    const pending = createAskHandler(channel)(ctx as never);
    push({ kind: 'allow' });
    await pending;

    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes from rechecks when it settles', async () => {
    const channel = presenter();
    const { ctx, push, listenerCount } = context();

    const pending = createAskHandler(channel)(ctx as never);
    expect(listenerCount()).toBe(1);

    push({ kind: 'allow' });
    await pending;

    expect(listenerCount()).toBe(0);
  });

  it('treats a channel that throws as nobody answering', async () => {
    const channel = presenter({
      present: () => {
        throw new Error('the terminal went away');
      },
    });
    const { ctx } = context();

    // A broken channel is not the user refusing, so it must not read as a reject.
    expect(await createAskHandler(channel)(ctx as never)).toEqual({
      kind: 'aborted',
    });
  });

  it('refuses a result that is not an ask rather than approving it', async () => {
    const channel = presenter();
    const { ctx } = context({ toolCheckResult: { kind: 'allow' } });

    expect(await createAskHandler(channel)(ctx as never)).toEqual({
      kind: 'rejected',
    });
    expect(channel.shown).toHaveLength(0);
  });

  describe('onPromptShown', () => {
    it('fires exactly once, with the prompt that is shown', async () => {
      const onPromptShown = vi.fn();
      const channel = presenter({
        present: (prompt, settle) => {
          channel.shown.push(prompt);
          settle({ kind: 'approved' });
          return () => {};
        },
      });
      const { ctx } = context();

      await createAskHandler(channel, { onPromptShown })(ctx as never);

      expect(onPromptShown).toHaveBeenCalledTimes(1);
      expect(onPromptShown.mock.calls[0][0]).toMatchObject({
        toolUseId: 'call-1',
        toolName: READ_FILE_TOOL_NAME,
        input: { file_path: '/repo/secret.txt' },
      });
      // The notification and the show describe the same prompt.
      expect(channel.shown).toHaveLength(1);
      expect(onPromptShown.mock.calls[0][0]).toBe(channel.shown[0]);
    });

    it('does not fire when the race is already settled before any prompt', async () => {
      // The turn being gone is one of the racing settlements; when it wins
      // before a prompt exists, nothing is shown and nothing is notified.
      const onPromptShown = vi.fn();
      const controller = new AbortController();
      controller.abort();
      const channel = presenter();
      const { ctx } = context({ signal: controller.signal });

      const result = await createAskHandler(channel, { onPromptShown })(
        ctx as never,
      );

      expect(result).toEqual({ kind: 'aborted' });
      expect(onPromptShown).not.toHaveBeenCalled();
      expect(channel.shown).toHaveLength(0);
    });

    it('a notifier that throws cannot change the settlement', async () => {
      const onPromptShown = vi.fn(() => {
        throw new Error('notification pipe broke');
      });
      const channel = presenter({
        present: (_prompt, settle) => {
          settle({ kind: 'approved' });
          return () => {};
        },
      });
      const { ctx } = context();

      const result = await createAskHandler(channel, { onPromptShown })(
        ctx as never,
      );

      expect(result).toEqual({ kind: 'approved' });
      expect(onPromptShown).toHaveBeenCalledTimes(1);
    });
  });
});

describe('createAskHandler, against the real module', () => {
  function moduleWith(handler: ReturnType<typeof createAskHandler>) {
    return createPermissionManager({
      cwd: '/repo',
      permissionMode: PermissionModes.Default,
      askHandler: handler,
      checkerDeps: {
        skill: {
          isAllowedForMainSession: () => true,
          isDisabled: () => false,
          hasOnlySafeProperties: () => false,
        },
        mcpCall: { isKnownTool: () => false, parseQualifiedName: () => ({}) },
      },
    });
  }

  it('carries an approval through to an allow decision', async () => {
    const permission = moduleWith(
      createAskHandler({
        present: (_prompt, settle) => {
          settle({ kind: 'approved' });
          return () => {};
        },
      }),
    );

    const decision = await permission.check({
      toolName: READ_FILE_TOOL_NAME,
      input: { file_path: '/elsewhere/secret.txt' },
      toolUseId: 'call-1',
    });

    expect(decision.kind).toBe('allow');
    expect(decision.decidedBy).toBe('ask');
  });

  it('settles a pending prompt when a rule is written mid-flight', async () => {
    let shown = 0;
    // Wait for the prompt to actually be on screen before writing the rule.
    // Counting microtasks would be guesswork: the first tool check is async, so
    // a rule written too early lands before the judgement is even listening.
    let onShown: () => void;
    const displayed = new Promise<void>((resolve) => {
      onShown = resolve;
    });

    const permission = moduleWith(
      createAskHandler({
        present: () => {
          shown += 1;
          onShown();
          return () => {};
        },
      }),
    );

    const pending = permission.check({
      toolName: READ_FILE_TOOL_NAME,
      input: { file_path: '/elsewhere/secret.txt' },
      toolUseId: 'call-2',
    });

    await displayed;

    // The user picks "always allow" on another concurrent prompt, and the rule
    // that lands settles this one too — nobody answers this prompt.
    permission.setRules({
      allow: { session: [`${READ_FILE_TOOL_NAME}(//elsewhere/**)`] },
      deny: {},
      ask: {},
    });

    const decision = await pending;
    expect(shown).toBe(1);
    expect(decision.kind).toBe('allow');
    expect(decision.history).toHaveLength(2);
  });
});

describe('rememberApproval', () => {
  const suggestion = {
    type: 'addRules' as const,
    destination: 'session' as const,
    behavior: 'allow' as const,
    rules: [{ toolName: READ_FILE_TOOL_NAME }],
  };

  function permissionSpy(initial = { allow: {}, deny: {}, ask: {} }) {
    let rules = initial;
    const setRules = vi.fn((next: typeof initial) => {
      rules = next;
    });
    const setAdditionalDirectories = vi.fn();
    return {
      setRules,
      setAdditionalDirectories,
      current: () => rules,
      module: {
        getRules: () => rules,
        setRules,
        getAdditionalDirectories: () => [],
        setAdditionalDirectories,
      } as never,
    };
  }

  it('writes nothing for a once-only approval', () => {
    const permission = permissionSpy();

    rememberApproval({
      permission: permission.module,
      scope: 'once',
      suggestions: [suggestion],
    });

    expect(permission.setRules).not.toHaveBeenCalled();
  });

  it('writes nothing when the prompt offered no suggestions', () => {
    const permission = permissionSpy();

    rememberApproval({
      permission: permission.module,
      scope: 'persist',
      suggestions: undefined,
    });

    expect(permission.setRules).not.toHaveBeenCalled();
  });

  it('puts a session approval in the session bucket only', () => {
    const permission = permissionSpy();

    rememberApproval({
      permission: permission.module,
      scope: 'session',
      suggestions: [suggestion],
    });

    expect(permission.current().allow).toEqual({
      session: [READ_FILE_TOOL_NAME],
    });
  });

  it('sends an always-allow to a real settings file, not to session', () => {
    // A session-scoped suggestion would be silently dropped by the persister, so
    // "always" has to name somewhere on disk.
    const permission = permissionSpy();
    const mutateSettingsForSource = vi.fn<
      SettingsWriter['mutateSettingsForSource']
    >((_source, mutation) => {
      mutation({});
      return {};
    });

    rememberApproval({
      permission: permission.module,
      scope: 'persist',
      suggestions: [suggestion],
      settingsWriter: {
        getSettingsForSource: () => ({}),
        mutateSettingsForSource,
      },
    });

    expect(mutateSettingsForSource).toHaveBeenCalled();
    expect(mutateSettingsForSource.mock.calls[0][0]).toBe('localSettings');
    // And the live rules see it immediately, not only after a restart.
    expect(permission.current().allow).toEqual({
      localSettings: [READ_FILE_TOOL_NAME],
    });
  });

  it('routes a mode change through the host rather than the module', () => {
    const permission = permissionSpy();
    const onModeChange = vi.fn();

    rememberApproval({
      permission: permission.module,
      scope: 'session',
      suggestions: [
        { type: 'setMode', destination: 'session', mode: 'acceptEdits' },
      ],
      onModeChange,
    });

    expect(onModeChange).toHaveBeenCalledWith('acceptEdits');
  });

  it('adds a trusted directory when the option carried one', () => {
    const permission = permissionSpy();

    rememberApproval({
      permission: permission.module,
      scope: 'session',
      suggestions: [
        { type: 'addDirectories', destination: 'session', directories: ['/w'] },
      ],
    });

    expect(permission.setAdditionalDirectories).toHaveBeenCalledWith(['/w']);
  });
});

describe('promptForCheck and a bypass-immune ask', () => {
  const catastrophic = {
    kind: 'ask' as const,
    reason: reason({
      message: "Dangerous rm operation detected: '~'",
      attribution: {
        type: 'safetyCheck',
        reason: 'Dangerous rm operation on critical path: ~',
        safetyCheckKind: 'dangerousRemoval',
        bypassImmune: true,
      },
    }),
    suggestions: [],
  };

  it('is neither skippable nor persistable', () => {
    const prompt = promptForCheck(catastrophic, {
      toolUseId: 'c',
      toolName: 'Bash',
      input: { command: 'rm -rf ~' },
    });
    expect(prompt.skippable).toBe(false);
    expect(prompt.persistable).toBe(false);
  });

  it('an ordinary ask stays persistable', () => {
    const prompt = promptForCheck(
      { kind: 'ask', reason: reason() },
      { toolUseId: 'c', toolName: READ_FILE_TOOL_NAME, input: {} },
    );
    expect(prompt.persistable).toBe(true);
  });
});
