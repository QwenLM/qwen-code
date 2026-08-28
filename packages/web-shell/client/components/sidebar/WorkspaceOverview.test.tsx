// @vitest-environment jsdom
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';
import { I18nProvider } from '../../i18n';
import { WorkspaceOverview, formatOverviewValue } from './WorkspaceOverview';
import type { WorkspaceOverviewSnapshot } from './workspaceOverviewModel';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

async function render(node: ReactNode): Promise<void> {
  await act(async () => {
    root.render(<I18nProvider language="en">{node}</I18nProvider>);
  });
}

const snapshot: WorkspaceOverviewSnapshot = {
  mcp: {
    initialized: true,
    discoveryState: 'completed',
    configured: 4,
    connected: 3,
    failed: 1,
    disabled: 0,
  },
  skills: { initialized: true, total: 12, enabled: 11 },
  extensions: { total: 4, active: 4 },
  channels: { configured: 2, connected: 2, failed: 0 },
  context: { initialized: false, fileCount: 0, ruleCount: 0 },
  fetchedAt: 1,
};

function chip(item: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(
    `[data-web-shell-workspace-overview="${item}"]`,
  );
  expect(element).not.toBeNull();
  return element!;
}

describe('formatOverviewValue', () => {
  it('formats known facets and leaves unknown ones undefined', () => {
    expect(formatOverviewValue(snapshot, 'mcp')).toBe('3/4');
    expect(formatOverviewValue(snapshot, 'skills')).toBe('11');
    expect(formatOverviewValue(snapshot, 'extensions')).toBe('4');
    expect(formatOverviewValue(snapshot, 'channels')).toBe('2/2');
    // The daemon reads context files itself: no files is a known zero.
    expect(formatOverviewValue(snapshot, 'context')).toBe('0');
    // A runtime facet that has not reported is unknown, never "0".
    expect(
      formatOverviewValue(
        {
          mcp: {
            initialized: false,
            configured: 0,
            connected: 0,
            failed: 0,
            disabled: 0,
          },
          fetchedAt: 1,
        },
        'mcp',
      ),
    ).toBeUndefined();
    expect(formatOverviewValue(undefined, 'mcp')).toBeUndefined();
  });

  it('shows the active/total split only when they differ', () => {
    expect(
      formatOverviewValue(
        { extensions: { total: 4, active: 2 }, fetchedAt: 1 },
        'extensions',
      ),
    ).toBe('2/4');
  });
});

describe('WorkspaceOverview', () => {
  it('renders one chip per item with value, label and detail tooltip', async () => {
    await render(
      <WorkspaceOverview
        overview={snapshot}
        items={['mcp', 'skills', 'context']}
      />,
    );
    expect(chip('mcp').textContent).toBe('MCP3/4');
    expect(chip('mcp').getAttribute('title')).toBe(
      'MCP: 3 of 4 connected, 1 failed',
    );
    expect(chip('skills').textContent).toBe('Skills11');
    expect(chip('context').textContent).toBe('Context0');
    expect(chip('context').getAttribute('title')).toBe(
      'Context: 0 context files, 0 rules',
    );
    expect(container.querySelector('[role="list"]')).not.toBeNull();
  });

  it('marks a facet with an issue and drops labels in compact mode', async () => {
    await render(
      <WorkspaceOverview
        overview={snapshot}
        items={['mcp', 'skills']}
        compact
      />,
    );
    expect(chip('mcp').className).toMatch(/chipIssue/);
    expect(chip('skills').className).not.toMatch(/chipIssue/);
    expect(chip('mcp').textContent).toBe('3/4');
    expect(chip('mcp').getAttribute('aria-label')).toBe(
      'MCP: 3 of 4 connected, 1 failed',
    );
  });

  it('keeps chips out of the button role', async () => {
    await render(<WorkspaceOverview overview={snapshot} items={['mcp']} />);
    expect(chip('mcp').tagName).toBe('SPAN');
    expect(container.querySelector('button')).toBeNull();
  });

  it('renders the opt-in hooks facet as unknown until initialized, then as a count', async () => {
    await render(
      <WorkspaceOverview
        overview={{
          hooks: { initialized: false, count: 0, disabled: false },
          fetchedAt: 1,
        }}
        items={['hooks']}
      />,
    );
    expect(chip('hooks').textContent).toBe('Hooks—');
    expect(chip('hooks').getAttribute('title')).toBe(
      'Hooks: not initialized yet',
    );
    await render(
      <WorkspaceOverview
        overview={{
          hooks: { initialized: true, count: 3, disabled: true },
          fetchedAt: 1,
        }}
        items={['hooks']}
      />,
    );
    expect(chip('hooks').textContent).toBe('Hooks3');
    expect(chip('hooks').getAttribute('title')).toBe(
      'Hooks: 3 hooks (disabled)',
    );
  });

  it('calls a missing daemon-side facet unavailable, not uninitialized', async () => {
    await render(
      <WorkspaceOverview
        overview={{ fetchedAt: 1 }}
        items={['extensions', 'channels', 'context', 'mcp']}
      />,
    );
    expect(chip('extensions').getAttribute('title')).toBe(
      'Extensions: unavailable on this daemon',
    );
    expect(chip('channels').getAttribute('title')).toBe(
      'Channels: unavailable on this daemon',
    );
    expect(chip('context').getAttribute('title')).toBe(
      'Context: unavailable on this daemon',
    );
    expect(chip('mcp').getAttribute('title')).toBe('MCP: not initialized yet');
  });

  it('renders nothing for an empty item list', async () => {
    await render(<WorkspaceOverview overview={snapshot} items={[]} />);
    expect(container.innerHTML).toBe('');
  });
});
