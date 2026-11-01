// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider, type WebShellLanguage } from '../i18n';
import { WebShellPortalRootContext } from '../portalRoot';
import {
  WorkflowModeControl,
  type WorkflowModeControlProps,
} from './WorkflowModeControl';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let portal: HTMLDivElement;
let root: Root;

function render(
  props: WorkflowModeControlProps,
  language: WebShellLanguage = 'en',
) {
  container = document.createElement('div');
  portal = document.createElement('div');
  document.body.append(container, portal);
  root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider language={language}>
        <WebShellPortalRootContext.Provider value={portal}>
          <WorkflowModeControl {...props} />
        </WebShellPortalRootContext.Provider>
      </I18nProvider>,
    );
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  portal?.remove();
});

const availableOff = {
  requested: false,
  available: true,
  effective: false,
};

describe('WorkflowModeControl', () => {
  it.each([undefined, 'unsupported'] as const)('hides status %s', (status) => {
    render({ workflowModeStatus: status });
    expect(container.innerHTML).toBe('');
  });

  it('does not present an unchecked mode before a session exists', async () => {
    const onWorkflowModeChange = vi.fn();
    render({
      workflowModeStatus: 'unbound',
      workflowMode: { requested: true, available: true, effective: true },
      onWorkflowModeChange,
    });
    expect(container.querySelector('[role="switch"]')).toBeNull();
    const details = container.querySelector<HTMLButtonElement>('button')!;
    await act(async () => details.click());
    expect(portal.querySelector('[role="dialog"]')?.textContent).toBe(
      'Create or resume a session to check availability.',
    );
    expect(onWorkflowModeChange).not.toHaveBeenCalled();
  });

  it('requests a change without optimistically changing the checked value', () => {
    const onWorkflowModeChange = vi.fn();
    render({
      workflowModeStatus: 'ready',
      workflowMode: availableOff,
      onWorkflowModeChange,
    });
    const control =
      container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(control.getAttribute('aria-label')).toBe('Workflow mode');
    expect(control.getAttribute('type')).toBe('button');
    act(() => control.click());
    expect(onWorkflowModeChange).toHaveBeenCalledExactlyOnceWith(true);
    expect(control.getAttribute('aria-checked')).toBe('false');
  });

  it('keeps an unavailable saved on preference checked and permits off', async () => {
    const onWorkflowModeChange = vi.fn();
    render({
      workflowModeStatus: 'ready',
      workflowMode: {
        requested: true,
        available: false,
        effective: false,
        reason: 'workflow_unavailable',
      },
      onWorkflowModeChange,
    });
    const control =
      container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(control.getAttribute('aria-checked')).toBe('true');
    expect(control.disabled).toBe(false);
    const details = container.querySelector<HTMLButtonElement>(
      '[data-web-shell-workflow-mode-details]',
    )!;
    await act(async () => details.click());
    expect(portal.textContent).toContain(
      'Workflow mode is on, but currently unavailable.',
    );
    expect(portal.textContent).toContain(
      'The Workflow tool is unavailable in this session.',
    );
    act(() => control.click());
    expect(onWorkflowModeChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('disables enabling an unavailable mode', () => {
    const onWorkflowModeChange = vi.fn();
    render({
      workflowModeStatus: 'ready',
      workflowMode: { ...availableOff, available: false },
      onWorkflowModeChange,
    });
    const control =
      container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(control.disabled).toBe(true);
    act(() => control.click());
    expect(onWorkflowModeChange).not.toHaveBeenCalled();
  });

  it.each([
    { workflowModeStatus: 'syncing' as const },
    { workflowModeStatus: 'unknown' as const },
    { workflowModeStatus: 'ready' as const, workflowModePending: true },
  ])('preserves the confirmed value while writes are disabled: %o', (state) => {
    const onWorkflowModeChange = vi.fn();
    render({
      ...state,
      workflowMode: { requested: true, available: true, effective: true },
      onWorkflowModeChange,
    });
    const control =
      container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(control.disabled).toBe(true);
    expect(control.getAttribute('aria-checked')).toBe('true');
    act(() => control.click());
    expect(onWorkflowModeChange).not.toHaveBeenCalled();
  });

  it('localizes both accessible label and state description', () => {
    render(
      {
        workflowModeStatus: 'ready',
        workflowMode: availableOff,
        onWorkflowModeChange: vi.fn(),
      },
      'zh-CN',
    );
    const control = container.querySelector('[role="switch"]')!;
    expect(control.getAttribute('aria-label')).toBe('Workflow 模式');
    const description = document.getElementById(
      control.getAttribute('aria-describedby')!,
    );
    expect(description?.textContent).toContain('Workflow 模式已关闭。');
  });
});
