// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { getTranslator } from '../i18n';
import { WorkspaceIndicator } from './WorkspaceIndicator';

// Radix Tooltip only mounts its content while open, and opens on a mouse
// `pointermove` over the trigger after `delayDuration`. jsdom has no
// `PointerEvent`, so a plain bubbling `pointermove` Event stands in (Radix reads
// `event.pointerType`, which is `undefined` here → treated as non-touch).
function openTooltip(chip: HTMLElement) {
  act(() => {
    chip.dispatchEvent(new Event('pointermove', { bubbles: true }));
    vi.advanceTimersByTime(300);
  });
}

describe('WorkspaceIndicator', () => {
  it('reveals the full cwd via a hover tooltip, not a native title', () => {
    vi.useFakeTimers();
    const name = 'api';
    const title = '/work/services/a-very-long-web-shell-workspace-path/api';
    const ariaLabel = `Workspace: ${name}`;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <WorkspaceIndicator name={name} title={title} ariaLabel={ariaLabel} />,
      );
    });

    const chip = container.querySelector<HTMLElement>(
      `[aria-label="${ariaLabel}"]`,
    );
    if (!chip) throw new Error('workspace chip was not rendered');
    expect(chip.tagName).toBe('OUTPUT');
    expect(chip.textContent).toContain(name);
    // Non-interactive chip: no button, and no native `title` — the full cwd
    // rides in the Radix hover tooltip, matching the git branch chip.
    expect(container.querySelector('button')).toBeNull();
    expect(chip.getAttribute('title')).toBeNull();
    expect(chip.getAttribute('data-web-shell-workspace-title')).toBe(title);

    // The headline behaviour: hovering renders the Radix tooltip with the full
    // cwd (guards against it rendering the short `name` or nothing at all).
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    openTooltip(chip);
    const tooltip = document.querySelector('[role="tooltip"]');
    expect(tooltip?.textContent).toBe(title);
    expect(tooltip?.textContent).not.toBe(name);

    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('keeps the full cwd discoverable when the name collapses in compact mode', () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <WorkspaceIndicator
          name="api"
          title="/work/api"
          ariaLabel="Workspace: api"
          compact
        />,
      );
    });

    const chip = container.querySelector<HTMLElement>(
      '[data-web-shell-workspace]',
    );
    if (!chip) throw new Error('workspace chip was not rendered');
    // Compact must actually apply the icon-only class...
    expect(chip.className).toContain('workspaceChipCompact');
    expect(chip.getAttribute('data-web-shell-workspace-title')).toBe(
      '/work/api',
    );

    // ...and the tooltip must still reveal the cwd once the name is hidden, so a
    // narrow / mobile composer can tell which workspace the pane targets.
    openTooltip(chip);
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      '/work/api',
    );

    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('tints the chip with the workspace accent so it stays distinct when compact', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <WorkspaceIndicator
          name="api"
          title="/work/api"
          ariaLabel="Workspace: api"
          color="blue"
          compact
        />,
      );
    });

    const chip = container.querySelector<HTMLElement>(
      '[data-web-shell-workspace]',
    );
    if (!chip) throw new Error('workspace chip was not rendered');
    // The accent (color-name class + the accented modifier) rides on the chip
    // even in compact mode, where the name is hidden — so the icon-only chip is
    // still distinguishable per workspace instead of a generic folder.
    expect(chip.className).toContain('workspaceChipCompact');
    expect(chip.className).toContain('blue');
    expect(chip.className).toContain('workspaceChipAccented');

    act(() => root.unmount());
    container.remove();
  });

  it('adds no accent classes when no color is given', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <WorkspaceIndicator name="api" title="/work/api" ariaLabel="ws" />,
      );
    });

    const chip = container.querySelector<HTMLElement>(
      '[data-web-shell-workspace]',
    );
    expect(chip?.className).not.toContain('workspaceChipAccented');

    act(() => root.unmount());
    container.remove();
  });

  it('localizes the accessible workspace label', () => {
    expect(getTranslator('en')('workspace.paneLabel', { name: 'api' })).toBe(
      'Workspace: api',
    );
    expect(getTranslator('zh-CN')('workspace.paneLabel', { name: 'api' })).toBe(
      '工作区：api',
    );
  });
});
