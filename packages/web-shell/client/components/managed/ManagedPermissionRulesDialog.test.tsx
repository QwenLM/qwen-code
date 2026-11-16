// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { WebShellPortalRootContext } from '../../portalRoot';
import { ManagedPermissionRulesDialog } from './ManagedPermissionRulesDialog';
import type { ManagedPermissionRules } from './managed-agent-provider';

let root: Root;
let container: HTMLDivElement;
let portal: HTMLDivElement;
let save: ReturnType<typeof vi.fn>;
const rules = { allow: ['Read'], ask: [], deny: [] };

async function render(
  revision = 0,
  current: ManagedPermissionRules = rules,
  disabled = false,
) {
  await act(async () =>
    root.render(
      <I18nProvider language="en">
        <WebShellPortalRootContext.Provider value={portal}>
          <ManagedPermissionRulesDialog
            rules={current}
            revision={revision}
            disabled={disabled}
            busy={false}
            onSave={save}
          />
        </WebShellPortalRootContext.Provider>
      </I18nProvider>,
    ),
  );
}

async function click(label: string) {
  const button = [
    ...container.querySelectorAll('button'),
    ...portal.querySelectorAll('button'),
  ].find((item) => item.textContent === label)!;
  expect(button).toBeDefined();
  await act(async () => button.click());
}

async function fill(kind: number, value: string) {
  const input = portal.querySelectorAll('textarea')[kind]!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submit() {
  await act(async () => {
    portal
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  container = document.createElement('div');
  portal = document.createElement('div');
  document.body.append(container, portal);
  root = createRoot(container);
  save = vi.fn().mockResolvedValue(false);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  portal.remove();
});

it('edits each list in the scoped portal and explicitly clears existing rules', async () => {
  await render();
  await click('Permission rules');
  expect(portal.querySelector('[role="dialog"]')).not.toBeNull();
  await fill(0, ' Read \nBash(git status*)\n');
  await fill(1, 'WebFetch(domain:example.com)');
  await fill(2, 'Bash(rm *)');
  await submit();
  expect(save).toHaveBeenLastCalledWith({
    allow: ['Read', 'Bash(git status*)'],
    ask: ['WebFetch(domain:example.com)'],
    deny: ['Bash(rm *)'],
  });
  await click('Clear rules');
  await submit();
  expect(save).toHaveBeenLastCalledWith({ allow: [], ask: [], deny: [] });
});

it('rejects unsupported path rules and duplicate rules before saving', async () => {
  await render();
  await click('Permission rules');
  for (const value of ['Read(./secrets/**)', 'Read\nRead']) {
    await fill(2, value);
    await submit();
    expect(portal.querySelector('[role="alert"]')?.textContent).toContain(
      'syntax',
    );
  }
  expect(save).not.toHaveBeenCalled();
});

it('requires current rules after a concurrent revision and blocks a busy Session', async () => {
  await render();
  await click('Permission rules');
  await fill(2, 'Bash(rm *)');
  await render(1);
  await submit();
  expect(save).not.toHaveBeenCalled();
  expect(portal.textContent).toContain('changed elsewhere');
  await click('Reload policies');
  await fill(2, 'Bash(rm *)');
  await render(1, rules, true);
  await submit();
  expect(save).not.toHaveBeenCalled();
});

it('closes and returns focus through the shared ref-aware trigger after saving', async () => {
  save.mockResolvedValue(true);
  await render();
  await click('Permission rules');
  await fill(2, 'Bash(rm *)');
  await submit();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(portal.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(container.querySelector('button'));
});
