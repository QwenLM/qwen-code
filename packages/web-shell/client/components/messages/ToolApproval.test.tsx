// @vitest-environment jsdom
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider, type WebShellLanguage } from '../../i18n';
import type { PermissionRequest, TodoItem } from '../../adapters/types';
import { ToolApproval } from './ToolApproval';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const request: PermissionRequest = {
  id: 'req-1',
  content: [],
  options: [
    { id: 'proceed', label: 'Proceed', kind: 'allow_once' },
    { id: 'reject', label: 'Reject', kind: 'reject_once' },
  ],
};

const execRequest: PermissionRequest = {
  id: 'req-exec',
  content: [],
  toolName: 'run_shell_command',
  title: 'run_shell_command',
  options: [
    { id: 'proceed', label: 'Proceed', kind: 'allow_once' },
    { id: 'reject', label: 'Reject', kind: 'reject_once' },
  ],
  rawInput: {
    command: 'rm -rf /tmp/data',
    description: 'Delete temporary data',
  },
};

const planRequest: PermissionRequest = {
  id: 'req-plan',
  toolKind: 'switch_mode',
  toolName: 'exit_plan_mode',
  title: 'Exit Plan Mode',
  content: [{ type: 'text', text: 'Implement the approved workflow.' }],
  options: [
    { id: 'proceed', label: 'Proceed', kind: 'allow_once' },
    { id: 'reject', label: 'Keep planning', kind: 'reject_once' },
  ],
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let onConfirm: ReturnType<typeof vi.fn>;

beforeEach(() => {
  onConfirm = vi.fn();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function rerender(
  keyboardActive?: boolean,
  req: PermissionRequest = request,
  planTodos?: readonly TodoItem[],
  language: WebShellLanguage = 'en',
): void {
  act(() =>
    root!.render(
      <I18nProvider language={language}>
        <ToolApproval
          request={req}
          onConfirm={onConfirm}
          keyboardActive={keyboardActive}
          planTodos={planTodos}
        />
      </I18nProvider>,
    ),
  );
}

function render(
  keyboardActive?: boolean,
  req: PermissionRequest = request,
  planTodos?: readonly TodoItem[],
  language: WebShellLanguage = 'en',
): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  rerender(keyboardActive, req, planTodos, language);
}

function optionButtons(): HTMLButtonElement[] {
  return Array.from(
    container!.querySelectorAll<HTMLButtonElement>(
      '[data-web-shell-permission-option]',
    ),
  );
}

function optionLabels(): (string | null | undefined)[] {
  return optionButtons().map(
    (o) => o.querySelector('[data-web-shell-option-label]')?.textContent,
  );
}

function pressKey(target: Element, key: string): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

describe('ToolApproval accessibility', () => {
  it('shows the active Todo workflow before exiting Plan Mode', () => {
    render(undefined, planRequest, [
      { id: 'prepare', content: 'Prepare', status: 'completed' },
      {
        id: 'ship',
        content: 'Ship',
        status: 'pending',
        blockedBy: ['prepare'],
      },
    ]);

    expect(container!.querySelector('[data-plan-workflow]')).not.toBeNull();
    expect(container!.textContent).toContain('Prepare');
    expect(container!.textContent).toContain('Ship');
    expect(container!.textContent).toContain(
      'Implement the approved workflow.',
    );
  });

  it('localizes Workflow approval without changing ordinary approvals', () => {
    const planTodos = [
      { id: 'review', content: 'Review', status: 'pending' as const },
    ];
    render(undefined, planRequest, planTodos, 'zh-CN');

    expect(container!.textContent).toContain('计划并审阅');
    expect(container!.textContent).toContain('确认计划并开始协作？');
    expect(optionLabels()).toEqual(['继续完善计划', '确认并开始']);

    rerender(undefined, planRequest, planTodos, 'en');
    expect(container!.textContent).toContain('Plan & Review');
    expect(container!.textContent).toContain(
      'Confirm the plan and start collaboration?',
    );
    expect(optionLabels()).toEqual(['Continue planning', 'Confirm and start']);

    rerender(undefined, request, undefined, 'zh-CN');
    expect(container!.textContent).toContain('是否继续？');
    expect(container!.textContent).not.toContain('确认计划并开始协作？');
  });

  it('keeps restore_previous distinct from confirm in a Workflow approval', () => {
    // The production exit_plan_mode option set: two `allow_once` options whose
    // outcomes differ materially, so they must never share one label.
    const productionPlanRequest: PermissionRequest = {
      ...planRequest,
      options: [
        {
          id: 'restore_previous',
          label: 'Yes, restore previous mode (yolo)',
          kind: 'allow_once',
        },
        {
          id: 'proceed_always',
          label: 'Yes, and auto-accept edits',
          kind: 'allow_always',
        },
        {
          id: 'proceed_once',
          label: 'Yes, and manually approve edits',
          kind: 'allow_once',
        },
        { id: 'cancel', label: 'No, keep planning (esc)', kind: 'reject_once' },
      ],
    };
    render(undefined, productionPlanRequest, [
      { id: 'review', content: 'Review', status: 'pending' },
    ]);

    const labels = optionLabels();
    expect(labels).toContain('Confirm and start');
    expect(new Set(labels).size).toBe(labels.length);
    expect(
      labels.filter((label) => label === 'Confirm and start'),
    ).toHaveLength(1);
  });

  it('keeps the text-only Plan Mode approval when there are no Todos', () => {
    render(undefined, planRequest);

    expect(container!.querySelector('[data-plan-workflow]')).toBeNull();
    expect(container!.textContent).toContain(
      'Implement the approved workflow.',
    );
  });

  it('shows a dependency-free Plan Mode workflow as a list', () => {
    render(undefined, planRequest, [
      { id: 'review', content: 'Review the change', status: 'pending' },
    ]);

    expect(container!.querySelector('[data-plan-workflow]')).toBeNull();
    expect(container!.textContent).toContain('Review the change');
  });

  it('does not apply approval shortcuts to a focused workflow node', () => {
    render(undefined, planRequest, [
      { id: 'review', content: 'Review the change', status: 'pending' },
    ]);
    const node = container!.querySelector<HTMLButtonElement>(
      '[data-plan-node-id="review"]',
    )!;
    node.focus();

    pressKey(node, 'j');
    expect(document.activeElement).toBe(node);
    pressKey(node, '2');
    expect(onConfirm).not.toHaveBeenCalled();

    const enter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    act(() => node.dispatchEvent(enter));
    expect(enter.defaultPrevented).toBe(false);
  });

  it('does not show a stale workflow for another switch-mode tool', () => {
    render(undefined, { ...planRequest, toolName: 'enter_plan_mode' }, [
      { id: 'old', content: 'Old plan', status: 'pending' },
    ]);

    expect(container!.querySelector('[data-plan-workflow]')).toBeNull();
    expect(container!.textContent).not.toContain('Old plan');
  });

  it('requires a switch-mode permission before showing the workflow', () => {
    render(undefined, { ...planRequest, toolKind: 'other' }, [
      { id: 'unsafe', content: 'Unrelated workflow', status: 'pending' },
    ]);

    expect(container!.textContent).not.toContain('Unrelated workflow');
  });

  it('exposes an alertdialog of real, focusable buttons', () => {
    render(undefined);
    const panel = container!.querySelector('[data-web-shell-permission-panel]');
    expect(panel?.getAttribute('role')).toBe('alertdialog');

    const opts = optionButtons();
    expect(opts).toHaveLength(2);
    expect(opts.every((o) => o.tagName === 'BUTTON')).toBe(true);
    // Exactly one option is in the tab order (roving tabindex).
    expect(opts.filter((o) => o.tabIndex === 0)).toHaveLength(1);
  });

  it('exposes the options as radios in a radiogroup (single-select)', () => {
    render(undefined);
    const panel = container!.querySelector(
      '[data-web-shell-permission-panel]',
    )!;
    expect(panel.querySelector('[role="radiogroup"]')).not.toBeNull();

    const opts = optionButtons();
    // The safe default (reject, index 0) is the checked radio.
    expect(opts[0]!.getAttribute('role')).toBe('radio');
    expect(opts[0]!.getAttribute('aria-checked')).toBe('true');
    expect(opts[1]!.getAttribute('aria-checked')).toBe('false');
  });

  it('exposes the command and description to assistive tech', () => {
    render(undefined, execRequest);
    const panel = container!.querySelector(
      '[data-web-shell-permission-panel]',
    )!;
    const describedby = panel.getAttribute('aria-describedby');
    expect(describedby).toBeTruthy();

    // SR users must hear WHAT will run, not just the question — the referenced
    // elements include the command and the description.
    const texts = describedby!
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '');
    expect(texts.some((t) => t.includes('rm -rf /tmp/data'))).toBe(true);
    expect(texts.some((t) => t.includes('Delete temporary data'))).toBe(true);
  });

  it('emits no dangling aria-describedby references', () => {
    // Basic approval: no command, no description. describedby must reference
    // only elements that actually render — a dangling IDREF is an axe-core
    // aria-valid-attr-value violation.
    render(undefined);
    const panel = container!.querySelector(
      '[data-web-shell-permission-panel]',
    )!;
    const ids = panel.getAttribute('aria-describedby')!.split(' ');
    expect(ids.length).toBeGreaterThan(0);
    ids.forEach((id) => expect(document.getElementById(id)).not.toBeNull());
  });

  it('focuses the safe-default option when keyboardActive (the default)', () => {
    render(undefined);
    // Reject sorts first and is the safe default.
    const opts = optionButtons();
    expect(opts[0]?.getAttribute('data-option-id')).toBe('reject');
    expect(document.activeElement).toBe(opts[0]);
  });

  it('does not steal focus when keyboardActive is false (split-view panes)', () => {
    render(false);
    expect(optionButtons().some((o) => o === document.activeElement)).toBe(
      false,
    );
  });

  describe('yielding to active typing (#9571)', () => {
    let composer: HTMLTextAreaElement;

    beforeEach(() => {
      // The user is typing in the composer when the approval arrives. In the
      // app the overlay commit hides the composer in the same render, so the
      // editable target still holds focus when the focus effect runs (jsdom
      // mirrors that: display:none never blurs).
      composer = document.createElement('textarea');
      document.body.appendChild(composer);
      composer.focus();
    });

    afterEach(() => {
      composer.remove();
    });

    it('does not grab focus to the default option while an editable target is focused', () => {
      expect(document.activeElement).toBe(composer);
      render(undefined);
      // Stealing focus here redirects the in-progress keystroke (Enter to
      // send, Space, digits) onto the safe-default option and can confirm it.
      expect(document.activeElement).toBe(composer);
      expect(optionButtons().some((o) => o === document.activeElement)).toBe(
        false,
      );
    });

    it('does not re-grab focus when a new request arrives mid-typing', () => {
      render(undefined);
      expect(document.activeElement).toBe(composer);
      rerender(true, { ...request, id: 'req-2' });
      expect(document.activeElement).toBe(composer);
    });

    it('does not grab focus on re-activation while typing', () => {
      render(false);
      expect(document.activeElement).toBe(composer);
      rerender(true);
      expect(document.activeElement).toBe(composer);
    });

    it('still operates by keyboard once the user tabs in', () => {
      render(undefined);
      expect(document.activeElement).toBe(composer);
      // Explicit tab-in: focusing an option engages the usual roving behavior.
      const opts = optionButtons();
      act(() => {
        opts[0]!.focus();
      });
      pressKey(opts[0]!, 'ArrowDown');
      expect(document.activeElement).toBe(opts[1]);
    });

    it('yields to a contenteditable composer (CodeMirror shape)', () => {
      // The production composer is a CodeMirror EditorView — a contenteditable
      // div inside `.cm-editor` (the textarea backend is touch devices only).
      // The textarea cases above never exercise isEditableTarget's
      // contenteditable branches; pin them so simplifying the helper to bare
      // form controls cannot silently re-open #9571.
      const editor = document.createElement('div');
      editor.className = 'cm-editor';
      const editable = document.createElement('div');
      editable.setAttribute('contenteditable', 'true');
      editor.appendChild(editable);
      document.body.appendChild(editor);
      act(() => {
        editable.focus();
      });
      expect(document.activeElement).toBe(editable);
      render(undefined);
      expect(document.activeElement).toBe(editable);
      expect(optionButtons().some((o) => o === document.activeElement)).toBe(
        false,
      );
      editor.remove();
    });

    it('yields in shadow-DOM (portal) mode, where document.activeElement retargets', () => {
      // Portal mode mounts the shell inside a shadow root, where
      // document.activeElement retargets to the non-editable host; the guard
      // must resolve the active element from the panel's own root instead.
      const host = document.createElement('div');
      document.body.appendChild(host);
      const shadowRoot = host.attachShadow({ mode: 'open' });
      const shadowComposer = document.createElement('textarea');
      shadowRoot.appendChild(shadowComposer);
      const shadowContainer = document.createElement('div');
      shadowRoot.appendChild(shadowContainer);
      act(() => {
        shadowComposer.focus();
      });
      expect(shadowRoot.activeElement).toBe(shadowComposer);

      container = shadowContainer;
      root = createRoot(container);
      rerender(undefined);

      expect(shadowRoot.activeElement).toBe(shadowComposer);
      expect(optionButtons().some((o) => o === shadowRoot.activeElement)).toBe(
        false,
      );
      host.remove();
    });
  });

  it('confirms the clicked option', () => {
    render(undefined);
    act(() => {
      optionButtons()[1]!.click();
    });
    expect(onConfirm).toHaveBeenCalledWith('req-1', 'proceed');
  });

  it.each([
    ['en' as const, 'Yes, allow once', 'Allow once and switch to Default mode'],
    ['zh-CN' as const, '是，允许一次', '允许一次并切换到默认模式'],
  ])(
    'distinguishes the switch-to-default approval in %s',
    (language, allowOnceLabel, switchLabel) => {
      render(
        undefined,
        {
          ...request,
          options: [
            {
              id: 'proceed_once',
              label: 'Allow',
              kind: 'allow_once',
            },
            {
              id: 'proceed_once_and_switch_to_default',
              label: 'Switch to Default Mode and allow once (recommended)',
              kind: 'allow_once',
            },
          ],
        },
        undefined,
        language,
      );

      expect(optionLabels()).toEqual([
        expect.stringContaining(allowOnceLabel),
        expect.stringContaining(switchLabel),
      ]);

      act(() => {
        optionButtons()[1]!.click();
      });
      expect(onConfirm).toHaveBeenCalledWith(
        'req-1',
        'proceed_once_and_switch_to_default',
      );
    },
  );

  it('confirms by digit shortcut, scoped to the panel', () => {
    render(undefined);
    // '2' picks the second ordered option (proceed). Dispatched on a button so
    // it bubbles to the panel's onKeyDown — a window-level keypress would not.
    pressKey(optionButtons()[0]!, '2');
    expect(onConfirm).toHaveBeenCalledWith('req-1', 'proceed');
  });

  it('rejects on Escape', () => {
    render(undefined);
    pressKey(optionButtons()[0]!, 'Escape');
    expect(onConfirm).toHaveBeenCalledWith('req-1', 'reject');
  });

  it('moves focus between options with arrow keys (roving tabindex)', () => {
    render(undefined);
    const opts = optionButtons();
    expect(document.activeElement).toBe(opts[0]);

    pressKey(opts[0]!, 'ArrowDown');
    expect(document.activeElement).toBe(opts[1]);
    expect(opts[1]!.tabIndex).toBe(0);
    expect(opts[0]!.tabIndex).toBe(-1);

    pressKey(opts[1]!, 'ArrowUp');
    expect(document.activeElement).toBe(opts[0]);
    expect(opts[0]!.tabIndex).toBe(0);
  });

  it('jumps to first/last option with Home/End', () => {
    render(undefined);
    const opts = optionButtons();
    expect(document.activeElement).toBe(opts[0]);

    pressKey(opts[0]!, 'End');
    expect(document.activeElement).toBe(opts[1]);
    expect(opts[1]!.tabIndex).toBe(0);

    pressKey(opts[1]!, 'Home');
    expect(document.activeElement).toBe(opts[0]);
    expect(opts[0]!.tabIndex).toBe(0);
  });

  it('restores the selected option when re-activated, not the safe default', () => {
    render(undefined); // keyboardActive=true (topmost)
    const opts = optionButtons();
    // User moves off the default (Reject) to Proceed.
    pressKey(opts[0]!, 'ArrowDown');
    expect(document.activeElement).toBe(opts[1]);

    // A covering panel opens (keyboardActive=false) then closes (true).
    rerender(false);
    rerender(true);

    // Focus returns to the user's selection — it must not snap back to Reject
    // (which would silently change what Enter confirms).
    expect(document.activeElement).toBe(opts[1]);
  });

  it('focuses the safe default when a new request arrives while active', () => {
    render(undefined); // keyboardActive=true (topmost)
    const opts = optionButtons();
    // User moves off the safe default (Reject) to Proceed.
    pressKey(opts[0]!, 'ArrowDown');
    expect(document.activeElement).toBe(opts[1]);

    // A NEW request (different id) arrives while still active: focus must go to
    // the new request's safe default, not the stale option index the user was on
    // (which could map to a more permissive option in the new request).
    rerender(true, { ...request, id: 'req-2' });
    expect(document.activeElement).toBe(optionButtons()[0]);
  });

  it('defaults an agent-launch dialog to the one-shot allow, not Reject', () => {
    render(undefined, {
      id: 'req-agent-launch',
      toolName: 'agent',
      title: 'Launch Explore agent',
      content: [],
      options: [
        {
          id: 'proceed_always_project',
          label: 'Always in project',
          kind: 'allow_always',
        },
        {
          id: 'proceed_always_user',
          label: 'Always for user',
          kind: 'allow_always',
        },
        { id: 'proceed_once', label: 'Allow', kind: 'allow_once' },
        { id: 'cancel', label: 'Reject', kind: 'reject_once' },
      ],
    });
    const opts = optionButtons();
    expect(opts.map((o) => o.getAttribute('data-option-id'))).toEqual([
      'cancel',
      'proceed_always_user',
      'proceed_always_project',
      'proceed_once',
    ]);
    // Launching the agent is the proposed next action: focus and initial
    // selection land on the one-shot allow instead of the reject button.
    expect(document.activeElement).toBe(opts[3]);
    expect(opts[3]!.tabIndex).toBe(0);
  });

  it('defaults an agent-launch dialog to Reject when no one-shot allow exists', () => {
    render(undefined, {
      id: 'req-agent-no-once',
      toolName: 'agent',
      title: 'Launch Explore agent',
      content: [],
      options: [
        {
          id: 'proceed_always_project',
          label: 'Always in project',
          kind: 'allow_always',
        },
        {
          id: 'proceed_always_user',
          label: 'Always for user',
          kind: 'allow_always',
        },
        { id: 'cancel', label: 'Reject', kind: 'reject_once' },
      ],
    });
    const opts = optionButtons();
    // No one-shot allow: the default must be the reject, never a permanent
    // allow rule.
    expect(opts[0]!.getAttribute('data-option-id')).toBe('cancel');
    expect(document.activeElement).toBe(opts[0]);
    expect(opts[0]!.tabIndex).toBe(0);
  });

  it('leaves Enter to native button activation (no double-press guard)', () => {
    render(undefined);
    const opts = optionButtons();
    opts[1]!.focus();
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      opts[1]!.dispatchEvent(event);
    });
    // handleKeyDown must not intercept Enter: the focused button activates
    // natively on Enter, so a single press confirms. The old interactedRef
    // double-press guard preventDefault'd the first Enter — assert that no such
    // interception exists. (jsdom doesn't synthesize the native Enter->click, so
    // we assert the handler leaves the event un-cancelled instead.)
    expect(event.defaultPrevented).toBe(false);
  });

  it('deduplicates options with the same id', () => {
    const dupRequest: PermissionRequest = {
      id: 'req-dup',
      content: [],
      options: [
        { id: 'proceed_once', label: 'Allow', kind: 'allow_once' },
        { id: 'proceed_once', label: 'Allow', kind: 'allow_once' },
        { id: 'reject', label: 'Reject', kind: 'reject_once' },
      ],
    };
    render(undefined, dupRequest);
    const opts = optionButtons();
    expect(opts).toHaveLength(2);
    expect(opts[0]!.getAttribute('data-option-id')).toBe('reject');
    expect(opts[1]!.getAttribute('data-option-id')).toBe('proceed_once');
  });

  it.each([
    [
      'en' as const,
      ['Reject', 'Yes, restore previous mode', 'Yes, allow once'],
    ],
    ['zh-CN' as const, ['拒绝', '是，恢复之前的模式', '是，允许一次']],
  ])(
    'renders plan-mode allow_once options as distinct, localized buttons in %s',
    (language, expectedLabels) => {
      // plan mode emits two allow_once options (restore_previous +
      // proceed_once). They must stay distinct AND both localize: before
      // restore_previous got its own i18n key, zh-CN leaked the English server
      // labels for both.
      render(
        undefined,
        {
          id: 'req-plan',
          content: [],
          options: [
            {
              id: 'restore_previous',
              label: 'Yes, restore previous mode (default)',
              kind: 'allow_once',
            },
            {
              id: 'proceed_once',
              label: 'Yes, and manually approve edits',
              kind: 'allow_once',
            },
            { id: 'reject', label: 'Reject', kind: 'reject_once' },
          ],
        },
        undefined,
        language,
      );
      const opts = optionButtons();
      expect(opts).toHaveLength(3);
      expect(opts.map((o) => o.getAttribute('data-option-id'))).toEqual([
        'reject',
        'restore_previous',
        'proceed_once',
      ]);
      expect(optionLabels()).toEqual(expectedLabels);
    },
  );

  it('falls back to i18n when a standard option has an empty label', () => {
    render(undefined, {
      id: 'req-empty',
      content: [],
      options: [
        { id: 'proceed_once', label: '', kind: 'allow_once' },
        { id: 'reject', label: '', kind: 'reject_once' },
      ],
    });
    const labels = optionLabels();
    expect(labels).toContain('Yes, allow once');
    expect(labels).toContain('Reject');
  });

  it('never renders a blank button when colliding options have empty labels', () => {
    // Two generic allow_once options share the allowOnce key, so the collision
    // guard reaches for their server labels, but both are empty. It must
    // degrade to the localized string (duplicated yet readable) rather than
    // render an unlabeled button a screen reader cannot announce.
    render(undefined, {
      id: 'req-collide-empty',
      content: [],
      options: [
        { id: 'proceed_once', label: '', kind: 'allow_once' },
        { id: 'proceed_once_alt', label: '', kind: 'allow_once' },
        { id: 'reject', label: 'Reject', kind: 'reject_once' },
      ],
    });
    expect(optionLabels()).toEqual([
      'Reject',
      'Yes, allow once',
      'Yes, allow once',
    ]);
  });

  it('falls back to distinct server labels when options share an i18n key', () => {
    render(undefined, {
      id: 'req-collide',
      content: [],
      options: [
        { id: 'proceed_once', label: 'Allow A', kind: 'allow_once' },
        { id: 'proceed_once_alt', label: 'Allow B', kind: 'allow_once' },
        { id: 'reject', label: 'Reject', kind: 'reject_once' },
      ],
    });
    expect(optionLabels()).toEqual(['Reject', 'Allow A', 'Allow B']);
  });

  it('re-enables confirmation when a new request arrives', () => {
    render(undefined);
    act(() => optionButtons()[1]!.click());
    expect(onConfirm).toHaveBeenCalledWith('req-1', 'proceed');

    rerender(undefined, { ...request, id: 'req-2' });
    act(() => optionButtons()[1]!.click());
    expect(onConfirm).toHaveBeenCalledTimes(2);
    expect(onConfirm).toHaveBeenLastCalledWith('req-2', 'proceed');
  });

  it('re-enables confirmation when submission rejects', async () => {
    onConfirm
      .mockRejectedValueOnce(new Error('submit failed'))
      .mockResolvedValueOnce(undefined);
    render(undefined);

    act(() => optionButtons()[1]!.click());
    await act(async () => {
      await Promise.resolve();
    });
    act(() => optionButtons()[1]!.click());

    expect(onConfirm).toHaveBeenCalledTimes(2);
  });

  it('does not re-arm the submit guard on a stale rejection from a previous request', async () => {
    let rejectStale: ((err: Error) => void) | undefined;
    const staleSubmission = new Promise<void>((_resolve, reject) => {
      rejectStale = reject;
    });
    const successorSubmission = new Promise<void>(() => {});
    onConfirm
      .mockReturnValueOnce(staleSubmission)
      .mockReturnValueOnce(successorSubmission);
    render(undefined);

    // Confirm request A; its submission stays in flight.
    act(() => optionButtons()[1]!.click());
    expect(onConfirm).toHaveBeenCalledWith('req-1', 'proceed');

    // The daemon replaces A with request B (this instance is reused — no key
    // at the mount sites); the id-keyed reset effect re-arms the guard, and
    // confirming B arms it again while B's submission is in flight.
    rerender(undefined, { ...request, id: 'req-2' });
    act(() => optionButtons()[1]!.click());
    expect(onConfirm).toHaveBeenCalledTimes(2);
    expect(onConfirm).toHaveBeenLastCalledWith('req-2', 'proceed');

    // A's stale submission rejects late (the daemon answers duplicates with
    // "No pending permission request"). It must not disarm B's guard.
    await act(async () => {
      rejectStale?.(new Error('No pending permission request'));
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => optionButtons()[0]!.click());

    expect(onConfirm).toHaveBeenCalledTimes(2);
  });

  it('does not re-arm the submit guard when the same request changes options', () => {
    render(undefined, {
      id: 'same-id',
      content: [],
      options: [
        { id: 'reject_always', label: 'Never', kind: 'reject_always' },
        { id: 'proceed_once', label: 'Allow', kind: 'allow_once' },
      ],
    });
    act(() => optionButtons()[0]!.click());
    expect(onConfirm).toHaveBeenCalledTimes(1);

    // Same request id, but options change so safeDefaultIndex flips 1 -> 0.
    // The reset effect must NOT re-run: it is keyed strictly to request.id.
    rerender(undefined, {
      id: 'same-id',
      content: [],
      options: [
        { id: 'cancel', label: 'Reject', kind: 'reject_once' },
        { id: 'proceed_once', label: 'Allow', kind: 'allow_once' },
      ],
    });
    act(() => optionButtons()[0]!.click());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
