// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { getTranslator } from '../i18n';
import { WorkspaceIndicator } from './WorkspaceIndicator';

describe('WorkspaceIndicator', () => {
  it('renders a read-only workspace chip with the name and full cwd tooltip', () => {
    const name = 'api';
    const title = '/work/services/a-very-long-web-shell-workspace-path/api';
    const ariaLabel = `Workspace: ${name}`;
    const container = document.createElement('div');
    const root = createRoot(container);

    act(() => {
      root.render(
        <WorkspaceIndicator name={name} title={title} ariaLabel={ariaLabel} />,
      );
    });

    const chip = container.querySelector(`[aria-label="${ariaLabel}"]`);
    if (!chip) throw new Error('workspace chip was not rendered');
    expect(chip.tagName).toBe('OUTPUT');
    expect(chip.textContent).toContain(name);
    // It's a non-interactive chip — no button, no native `title` (the full cwd
    // rides in the Radix hover tooltip, matching the git branch chip).
    expect(container.querySelector('button')).toBeNull();
    expect(chip.getAttribute('title')).toBeNull();
    expect(chip.getAttribute('data-web-shell-workspace-title')).toBe(title);

    act(() => root.unmount());
  });

  it('keeps the full cwd discoverable when the name collapses in compact mode', () => {
    const container = document.createElement('div');
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

    // Even icon-only (compact) the tooltip source stays present so a narrow /
    // mobile composer can still reveal which workspace the pane targets.
    const chip = container.querySelector('[data-web-shell-workspace]');
    expect(chip?.getAttribute('data-web-shell-workspace-title')).toBe(
      '/work/api',
    );

    act(() => root.unmount());
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
