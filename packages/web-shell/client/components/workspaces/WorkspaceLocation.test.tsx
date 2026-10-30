// @vitest-environment jsdom
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '../../i18n';
import { rememberWorkspaceHost } from '../../config/workspace-hosts';
import { cleanupReact, mountReact } from '../../test/reactHarness';
import { WorkspaceLocation } from './WorkspaceLocation';

const ORIGINAL_HREF = window.location.href;

function renderChip(node: ReactElement): HTMLElement {
  return mountReact(<I18nProvider language="en">{node}</I18nProvider>);
}

describe('WorkspaceLocation', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanupReact();
    window.history.replaceState(null, '', ORIGINAL_HREF);
  });

  it('stays hidden while every saved host is the page origin', () => {
    rememberWorkspaceHost(window.location.origin, []);
    const container = renderChip(<WorkspaceLocation cwd="/repo" />);
    expect(
      container.querySelector('[data-testid="workspace-location"]'),
    ).toBeNull();
  });

  it('names the local host once another host is known', () => {
    rememberWorkspaceHost('https://remote.example', []);
    const container = renderChip(<WorkspaceLocation cwd="/repo" />);
    const chip = container.querySelector('[data-testid="workspace-location"]');
    expect(chip?.textContent).toBe('Local');
    expect(chip?.getAttribute('title')).toContain('/repo');
  });

  it('names the remote host while connected cross-origin', () => {
    window.history.replaceState(
      null,
      '',
      '/?daemon=https://remote.example:4170',
    );
    const container = renderChip(<WorkspaceLocation cwd="/srv/repo" />);
    const chip = container.querySelector('[data-testid="workspace-location"]');
    expect(chip?.textContent).toBe('Remote · remote.example:4170');
    expect(chip?.getAttribute('title')).toContain(
      'https://remote.example:4170',
    );
    expect(chip?.getAttribute('title')).toContain('/srv/repo');
  });

  it('names the session host over the page daemon on fan-out pages', () => {
    window.history.replaceState(null, '', '/?daemon=https://a.example:4170');
    const container = renderChip(
      <WorkspaceLocation cwd="/srv/repo" hostOrigin="https://b.example:4170" />,
    );
    const chip = container.querySelector('[data-testid="workspace-location"]');
    expect(chip?.textContent).toBe('Remote · b.example:4170');
    expect(chip?.getAttribute('title')).toContain('https://b.example:4170');
    expect(chip?.getAttribute('title')).toContain('/srv/repo');
  });
});
