// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';
import type {
  DaemonClient,
  DaemonSessionGroupCatalog,
  DaemonSessionSearchResult,
  DaemonSessionSummary,
  DaemonWorkspaceCapability,
  DaemonWorkspaceGitStatus,
} from '@qwen-code/sdk/daemon';
import gitStyles from '../ChatEditor.module.css';
import type { WorkspaceSessionStats } from './workspaceOverviewModel';

const {
  workspaceGit,
  workspaceGitBranches,
  workspaceGitCheckout,
  pickerWorkspaceClient,
} = vi.hoisted(() => {
  const workspaceGit = vi.fn();
  const workspaceGitBranches = vi.fn();
  const workspaceGitCheckout = vi.fn();
  // A stable client so the popover's memoized workspace handle (and thus its
  // fetch effect) stays referentially stable across renders.
  const pickerWorkspaceClient = {
    workspaceByCwd: () => ({
      workspaceGit,
      workspaceGitBranches,
      workspaceGitCheckout,
      workspaceGitCreateBranch: vi.fn().mockResolvedValue(undefined),
      workspaceGitPush: vi
        .fn()
        .mockResolvedValue({ success: true, output: '' }),
      workspaceGitPull: vi
        .fn()
        .mockResolvedValue({ success: true, output: '' }),
      listWorkspaceSessionsPage: vi.fn().mockResolvedValue({ sessions: [] }),
    }),
  };
  return {
    workspaceGit,
    workspaceGitBranches,
    workspaceGitCheckout,
    pickerWorkspaceClient,
  };
});

// Mock useWorkspace so BranchPickerPopover can render without a real provider.
vi.mock('@qwen-code/web-shell/daemon-react-sdk', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@qwen-code/web-shell/daemon-react-sdk')
    >();
  return {
    ...actual,
    useWorkspace: () => ({
      client: pickerWorkspaceClient,
      capabilities: { features: [] },
    }),
  };
});

// A stable client whose `workspaceByCwd` always returns the same `workspaceGit`
// mock, so call assertions accumulate regardless of how often the component
// re-resolves the workspace handle.
function makeClient(): DaemonClient {
  return {
    workspaceByCwd: vi.fn(() => ({
      workspaceGit,
      workspaceGitBranches,
      workspaceGitCheckout,
      workspaceGitCreateBranch: vi.fn().mockResolvedValue(undefined),
      workspaceGitPush: vi
        .fn()
        .mockResolvedValue({ success: true, output: '' }),
      workspaceGitPull: vi
        .fn()
        .mockResolvedValue({ success: true, output: '' }),
      listWorkspaceSessionsPage: vi.fn().mockResolvedValue({ sessions: [] }),
      listSessionGroups: vi.fn().mockResolvedValue({ groups: [] }),
    })),
  } as unknown as DaemonClient;
}

const { I18nProvider } = await import('../../i18n');
const { WorkspaceSection } = await import('./WorkspaceSection');
const { readWorkspaceExpanded, writeWorkspaceExpanded } = await import(
  './workspaceExpansion'
);

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
if (!globalThis.PointerEvent) {
  globalThis.PointerEvent = MouseEvent as typeof PointerEvent;
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}

const trustedWorkspace: DaemonWorkspaceCapability = {
  id: 'primary',
  cwd: '/tmp/project',
  primary: true,
  trusted: true,
  removable: false,
};

const untrustedWorkspace: DaemonWorkspaceCapability = {
  id: 'danger',
  cwd: '/tmp/danger',
  primary: false,
  trusted: false,
  removable: true,
};

let root: Root;
let container: HTMLDivElement;

function renderSection(
  overrides: Partial<{
    workspace: DaemonWorkspaceCapability;
    onOpenGitDiff: (cwd: string) => void;
    client: DaemonClient;
    reloadToken: number;
    expanded: boolean;
    sourceType: string;
    channelGroupingEnabled: boolean;
    organizationEnabled: boolean;
    sessionCatalogRequestsEnabled: boolean;
    sessionGroupCatalog: DaemonSessionGroupCatalog;
    sessionLiveStateEnabled: boolean;
    overviewEnabled: boolean;
    renderHeader: (expanded: boolean) => ReactNode;
    headerActions: (
      visible: boolean,
      context: { overview: unknown; gitBranch: string | null | undefined },
    ) => ReactNode;
    sessionStats: WorkspaceSessionStats | null;
    renderSessions: boolean;
    excludePinned: boolean;
    searchQuery: string;
    gitBranchWanted: boolean;
    renderSession: (
      session: DaemonSessionSummary,
      options?: { searchSnippet?: string | undefined },
    ) => ReactNode;
    onOpenPathLocally: (cwd: string) => Promise<void>;
    onOpenTerminalLocally: (cwd: string) => Promise<void>;
  }> = {},
): void {
  act(() => {
    root.render(
      <I18nProvider language="en">
        <WorkspaceSection
          workspace={overrides.workspace ?? trustedWorkspace}
          client={overrides.client ?? makeClient()}
          reloadToken={overrides.reloadToken ?? 0}
          expanded={overrides.expanded}
          untrustedLabel="Untrusted"
          readOnlyLabel="Read-only"
          trustToOpenLabel="Trust to open"
          noSessionsLabel="No sessions"
          loadErrorLabel="Load failed"
          organizationEnabled={overrides.organizationEnabled ?? false}
          sessionCatalogRequestsEnabled={
            overrides.sessionCatalogRequestsEnabled
          }
          sessionGroupCatalog={overrides.sessionGroupCatalog}
          sessionLiveStateEnabled={overrides.sessionLiveStateEnabled}
          excludePinned={overrides.excludePinned}
          searchQuery={overrides.searchQuery}
          sourceType={overrides.sourceType}
          channelGroupingEnabled={overrides.channelGroupingEnabled}
          ungroupedLabel="Ungrouped"
          renderSession={
            overrides.renderSession ??
            ((session: DaemonSessionSummary): ReactNode => (
              <div key={session.sessionId}>{session.displayName}</div>
            ))
          }
          onOpenGitDiff={overrides.onOpenGitDiff}
          overviewEnabled={overrides.overviewEnabled}
          renderHeader={overrides.renderHeader}
          headerActions={overrides.headerActions}
          sessionStats={overrides.sessionStats}
          renderSessions={overrides.renderSessions}
          gitBranchWanted={overrides.gitBranchWanted}
          onOpenPathLocally={overrides.onOpenPathLocally}
          onOpenTerminalLocally={overrides.onOpenTerminalLocally}
        />
      </I18nProvider>,
    );
  });
}

/** A client whose facet calls are observable, for the overview gating tests. */
function makeOverviewClient(
  sessions: DaemonSessionSummary[] = [],
): DaemonClient & { workspaceMcp: ReturnType<typeof vi.fn> } {
  const workspaceMcp = vi.fn().mockResolvedValue({
    v: 1,
    workspaceCwd: '/tmp/project',
    initialized: true,
    discoveryState: 'completed',
    servers: [],
  });
  const client = {
    workspaceMcp,
    workspaceByCwd: vi.fn(() => ({
      workspaceGit,
      workspaceMcp,
      listWorkspaceSessionsPage: vi.fn().mockResolvedValue({ sessions }),
      listSessionGroups: vi.fn().mockResolvedValue({ groups: [] }),
    })),
  };
  return client as unknown as DaemonClient & {
    workspaceMcp: ReturnType<typeof vi.fn>;
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function gitChip(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-web-shell-git-branch]');
}

/** Open the workspace hover popover (300 ms delay) and return its dialog. */
async function openDetailsDialog(): Promise<HTMLElement> {
  vi.useFakeTimers();
  const headerRow = container.querySelector<HTMLElement>(
    '[class*="headerRow"]',
  );
  await act(async () => {
    headerRow?.dispatchEvent(new Event('pointerover', { bubbles: true }));
    vi.advanceTimersByTime(300);
    await Promise.resolve();
  });
  vi.useRealTimers();
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  expect(dialog).not.toBeNull();
  return dialog!;
}

function sessionCounts(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[data-web-shell-workspace-sessions]',
  );
}

function sessionCount(kind: 'Running' | 'Attention' | 'Total'): string | null {
  return (
    sessionCounts()?.querySelector<HTMLElement>(`[class*="Count${kind}"]`)
      ?.textContent ?? null
  );
}

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  workspaceGit.mockReset();
  workspaceGitBranches.mockReset();
  workspaceGitBranches.mockResolvedValue({
    v: 1,
    workspaceCwd: '/tmp/project',
    available: true,
    local: [],
    remote: [],
    tags: [],
    recent: [],
    head: 'main',
    detached: false,
  });
  workspaceGitCheckout.mockReset();
  workspaceGitCheckout.mockResolvedValue(undefined);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('WorkspaceSection label', () => {
  it('prefers the workspace display name over the cwd basename', () => {
    renderSection({
      workspace: {
        ...trustedWorkspace,
        displayName: 'Payments API',
      },
    });

    expect(container.textContent).toContain('Payments API');
    expect(container.textContent).not.toContain('project');
  });

  it('shows read-only session details from row hover', async () => {
    const listWorkspaceSessionsPage = vi.fn().mockResolvedValue({
      sessions: [
        {
          sessionId: 'session-1',
          displayName: 'A very long session name',
          createdAt: '2026-01-01T00:00:00.000Z',
        } as DaemonSessionSummary,
      ],
    });
    const client = {
      workspaceByCwd: vi.fn(() => ({
        workspaceGit,
        listWorkspaceSessionsPage,
        listSessionGroups: vi.fn().mockResolvedValue({ groups: [] }),
      })),
    } as unknown as DaemonClient;

    renderSection({
      workspace: untrustedWorkspace,
      client,
      expanded: true,
    });
    await flush();

    expect(
      container.querySelector('[title="A very long session name"]'),
    ).toBeNull();
    const row = container.querySelector<HTMLElement>('[role="note"]');
    if (!row) throw new Error('read-only row was not rendered');
    expect(row.tabIndex).toBe(-1);
    vi.useFakeTimers();
    act(() => {
      row.dispatchEvent(new Event('pointerover', { bubbles: true }));
      vi.advanceTimersByTime(300);
    });
    const tooltip = document.querySelector('[role="dialog"]');
    expect(tooltip?.textContent).toContain('A very long session name');
    expect(tooltip?.textContent).toContain('danger');
    expect(tooltip?.querySelector('[title="/tmp/danger"]')).not.toBeNull();
    vi.useRealTimers();
  });

  it('restores and writes the workspace expansion preference', () => {
    writeWorkspaceExpanded(trustedWorkspace.id, false);
    renderSection();

    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-expanded]',
    );
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    act(() => toggle?.click());
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(readWorkspaceExpanded(trustedWorkspace.id)).toBe(true);
  });

  it('does not render sessions loaded for the previous source', async () => {
    let resolveChannel: (page: {
      sessions: DaemonSessionSummary[];
    }) => void = () => {};
    const channelPage = new Promise<{ sessions: DaemonSessionSummary[] }>(
      (resolve) => {
        resolveChannel = resolve;
      },
    );
    let resolveDefault: (page: {
      sessions: DaemonSessionSummary[];
    }) => void = () => {};
    const defaultPage = new Promise<{ sessions: DaemonSessionSummary[] }>(
      (resolve) => {
        resolveDefault = resolve;
      },
    );
    const listWorkspaceSessionsPage = vi.fn(
      (options?: { sourceType?: string }) =>
        options?.sourceType === 'channel' ? channelPage : defaultPage,
    );
    const client = {
      workspaceByCwd: vi.fn(() => ({
        workspaceGit,
        listWorkspaceSessionsPage,
        listSessionGroups: vi.fn().mockResolvedValue({ groups: [] }),
      })),
    } as unknown as DaemonClient;

    // Switch to the channel source while the default request is still in
    // flight. The catalog store keeps one snapshot per query, so the sources
    // cannot clobber each other.
    renderSection({ client, expanded: true, sourceType: 'default' });
    renderSection({ client, expanded: true, sourceType: 'channel' });
    expect(container.textContent).not.toContain('Task session');

    // The pre-switch default response settles AFTER the switch; it belongs
    // to the default source's catalog entry and must not clobber the
    // channel list now on screen.
    resolveDefault({
      sessions: [
        {
          sessionId: 'task-session',
          displayName: 'Task session',
          sourceType: 'default',
        },
      ],
    });
    await flush();
    expect(container.textContent).not.toContain('Task session');

    resolveChannel({
      sessions: [
        {
          sessionId: 'channel-session',
          displayName: 'Channel session',
          sourceType: 'channel',
        },
      ],
    });
    await flush();
    expect(container.textContent).toContain('Channel session');
  });

  it('does not carry a load error across a source switch', async () => {
    const listWorkspaceSessionsPage = vi.fn(
      (options?: { sourceType?: string }) =>
        options?.sourceType === 'channel'
          ? new Promise<{ sessions: DaemonSessionSummary[] }>(() => {})
          : Promise.reject(new Error('tasks unavailable')),
    );
    const client = {
      workspaceByCwd: vi.fn(() => ({
        workspaceGit,
        listWorkspaceSessionsPage,
        listSessionGroups: vi.fn().mockResolvedValue({ groups: [] }),
      })),
    } as unknown as DaemonClient;

    renderSection({ client, expanded: true, sourceType: 'default' });
    await flush();
    expect(container.textContent).toContain('Load failed');

    renderSection({ client, expanded: true, sourceType: 'channel' });
    await flush();
    expect(container.textContent).not.toContain('Load failed');
    // The switch must actually initiate the new source's fetch, not leave the
    // section stuck on the failed tasks load.
    expect(listWorkspaceSessionsPage).toHaveBeenCalledWith(
      expect.objectContaining({ sourceType: 'channel' }),
    );
    expect(
      listWorkspaceSessionsPage.mock.calls.filter(
        ([options]) =>
          (options as { sourceType?: string } | undefined)?.sourceType ===
          'channel',
      ),
    ).toHaveLength(1);
  });

  it('does not flash the empty notice while a fresh source settles', async () => {
    const client = {
      workspaceByCwd: vi.fn(() => ({
        workspaceGit,
        listWorkspaceSessionsPage: vi.fn(
          () => new Promise<{ sessions: DaemonSessionSummary[] }>(() => {}),
        ),
        listSessionGroups: vi.fn().mockResolvedValue({ groups: [] }),
      })),
    } as unknown as DaemonClient;

    renderSection({ client, expanded: true, sourceType: 'channel' });
    await flush();

    // The new query key's fetch is in flight with no settled page yet, so
    // the section renders nothing instead of "No sessions" for the
    // round-trip.
    expect(container.textContent).not.toContain('No sessions');
  });

  it('groups a secondary workspace with its own channel catalog', async () => {
    const listSessionGroups = vi.fn().mockResolvedValue({
      groups: [
        {
          id: 'organization-group',
          name: 'Organization group',
          color: 'blue',
          order: 0,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    const client = {
      workspaceByCwd: vi.fn(() => ({
        workspaceGit,
        listWorkspaceSessionsPage: vi.fn().mockResolvedValue({
          sessions: [
            {
              sessionId: 'ding-session',
              displayName: 'DingTalk secondary',
              sourceType: 'channel',
              sourceId: 'secondary-ding',
              groupId: 'organization-group',
            },
            {
              sessionId: 'feishu-session',
              displayName: 'Feishu secondary',
              sourceType: 'channel',
              sourceId: 'secondary-feishu',
              // Channel mode must keep pinned rows inside their platform
              // section (excludePinned is off for the channel source).
              isPinned: true,
            },
          ],
        }),
        listSessionGroups,
        workspaceChannelTypes: vi.fn().mockResolvedValue([
          {
            type: 'dingtalk',
            displayName: 'DingTalk',
            manageable: true,
            fields: [],
          },
          {
            type: 'feishu',
            displayName: 'Feishu',
            manageable: true,
            fields: [],
          },
        ]),
        workspaceChannels: vi.fn().mockResolvedValue({
          revision: '1',
          instances: {
            'secondary-ding': {
              name: 'secondary-ding',
              config: { type: 'dingtalk' },
              secrets: {},
              startsWithServe: false,
              runtime: { state: 'connected' },
            },
            'secondary-feishu': {
              name: 'secondary-feishu',
              config: { type: 'feishu' },
              secrets: {},
              startsWithServe: false,
              runtime: { state: 'connected' },
            },
          },
        }),
      })),
    } as unknown as DaemonClient;

    renderSection({
      workspace: { ...trustedWorkspace, primary: false },
      client,
      expanded: true,
      sourceType: 'channel',
      channelGroupingEnabled: true,
      organizationEnabled: true,
    });
    await flush();

    expect(
      container.querySelector('section[aria-label="DingTalk"]')?.textContent,
    ).toContain('DingTalk secondary');
    expect(
      container.querySelector('section[aria-label="Feishu"]')?.textContent,
    ).toContain('Feishu secondary');
    expect(
      container.querySelector('section[aria-label="Organization group"]'),
    ).toBeNull();
    // Channel mode discards the organization sections, so the catalog fetch
    // must be skipped too, mirroring the sidebar's own org prefetch gates.
    expect(listSessionGroups).not.toHaveBeenCalled();
  });

  it('never bypasses a fenced group catalog for a global reload token', async () => {
    const listSessionGroups = vi
      .fn()
      .mockResolvedValue({ groups: [], colorOptions: [] });
    const client = {
      workspaceByCwd: vi.fn(() => ({
        workspaceGit,
        listWorkspaceSessionsPage: vi.fn().mockResolvedValue({ sessions: [] }),
        listSessionGroups,
      })),
    } as unknown as DaemonClient;

    renderSection({
      client,
      expanded: true,
      organizationEnabled: true,
      sessionLiveStateEnabled: true,
      reloadToken: 0,
    });
    await flush();
    expect(listSessionGroups).not.toHaveBeenCalled();

    renderSection({
      client,
      expanded: true,
      organizationEnabled: true,
      sessionLiveStateEnabled: true,
      reloadToken: 1,
    });
    await flush();
    expect(listSessionGroups).not.toHaveBeenCalled();
  });

  it('defers legacy catalog requests until capability discovery completes', async () => {
    const listWorkspaceSessionsPage = vi
      .fn()
      .mockResolvedValue({ sessions: [] });
    const listSessionGroups = vi
      .fn()
      .mockResolvedValue({ groups: [], colorOptions: [] });
    const client = {
      workspaceByCwd: vi.fn(() => ({
        workspaceGit,
        listWorkspaceSessionsPage,
        listSessionGroups,
      })),
    } as unknown as DaemonClient;

    renderSection({
      client,
      expanded: true,
      organizationEnabled: true,
      sessionCatalogRequestsEnabled: false,
    });
    await flush();
    expect(listWorkspaceSessionsPage).not.toHaveBeenCalled();
    expect(listSessionGroups).not.toHaveBeenCalled();

    renderSection({
      client,
      expanded: true,
      organizationEnabled: true,
      sessionCatalogRequestsEnabled: true,
    });
    await flush();
    expect(listWorkspaceSessionsPage).toHaveBeenCalledTimes(1);
    expect(listSessionGroups).toHaveBeenCalledTimes(1);
  });

  it('renders channel sessions flat while the channel catalog failed to load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = {
      workspaceByCwd: vi.fn(() => ({
        workspaceGit,
        listWorkspaceSessionsPage: vi.fn().mockResolvedValue({
          sessions: [
            {
              sessionId: 'ding-session',
              displayName: 'DingTalk session',
              sourceType: 'channel',
              sourceId: 'ding-one',
              groupId: 'organization-group',
            },
          ],
        }),
        listSessionGroups: vi.fn().mockResolvedValue({
          groups: [
            {
              id: 'organization-group',
              name: 'Organization group',
              color: 'blue',
              order: 0,
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        }),
        workspaceChannelTypes: vi.fn().mockRejectedValue(new Error('boom')),
        workspaceChannels: vi.fn().mockRejectedValue(new Error('boom')),
      })),
    } as unknown as DaemonClient;

    renderSection({
      client,
      expanded: true,
      sourceType: 'channel',
      channelGroupingEnabled: true,
      organizationEnabled: true,
    });
    await flush();

    // Without a catalog the channel list is not groupable yet; it must stay
    // flat instead of falling through to organization groups, which would
    // invert the "channel grouping overrides user groups" precedence.
    expect(container.textContent).toContain('DingTalk session');
    expect(
      container.querySelector('section[aria-label="Organization group"]'),
    ).toBeNull();
    warn.mockRestore();
  });

  it('ignores a stale channel catalog response', async () => {
    let resolveStale!: (value: {
      revision: string;
      instances: Record<string, unknown>;
    }) => void;
    const staleSnapshot = new Promise<{
      revision: string;
      instances: Record<string, unknown>;
    }>((resolve) => {
      resolveStale = resolve;
    });
    const workspaceChannelTypes = vi.fn().mockResolvedValue([
      {
        type: 'dingtalk',
        displayName: 'DingTalk',
        manageable: true,
        fields: [],
      },
      {
        type: 'feishu',
        displayName: 'Feishu',
        manageable: true,
        fields: [],
      },
    ]);
    const workspaceChannels = vi
      .fn()
      .mockReturnValueOnce(staleSnapshot)
      .mockResolvedValue({
        revision: 'new',
        instances: {
          instance: {
            name: 'instance',
            config: { type: 'feishu' },
            secrets: {},
            startsWithServe: false,
          },
        },
      });
    const client = {
      workspaceByCwd: vi.fn(() => ({
        workspaceGit,
        listWorkspaceSessionsPage: vi.fn().mockResolvedValue({
          sessions: [
            {
              sessionId: 'channel-session',
              displayName: 'Channel session',
              sourceType: 'channel',
              sourceId: 'instance',
            },
          ],
        }),
        listSessionGroups: vi.fn().mockResolvedValue({ groups: [] }),
        workspaceChannelTypes,
        workspaceChannels,
      })),
    } as unknown as DaemonClient;

    renderSection({
      client,
      expanded: true,
      sourceType: 'channel',
      channelGroupingEnabled: true,
      reloadToken: 0,
    });
    await flush();
    renderSection({
      client,
      expanded: true,
      sourceType: 'channel',
      channelGroupingEnabled: true,
      reloadToken: 1,
    });
    await flush();
    expect(
      container.querySelector('section[aria-label="Feishu"]'),
    ).not.toBeNull();

    resolveStale({
      revision: 'old',
      instances: {
        instance: {
          name: 'instance',
          config: { type: 'dingtalk' },
        },
      },
    });
    await flush();

    expect(
      container.querySelector('section[aria-label="Feishu"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('section[aria-label="DingTalk"]'),
    ).toBeNull();
  });

  it('refreshes the channel catalog on the session poll tick', async () => {
    const workspaceChannelTypes = vi.fn().mockResolvedValue([
      {
        type: 'dingtalk',
        displayName: 'DingTalk',
        manageable: true,
        fields: [],
      },
    ]);
    const workspaceChannels = vi.fn().mockResolvedValue({
      revision: '1',
      instances: {},
    });
    const client = {
      workspaceByCwd: vi.fn(() => ({
        workspaceGit,
        listWorkspaceSessionsPage: vi.fn().mockResolvedValue({ sessions: [] }),
        listSessionGroups: vi.fn().mockResolvedValue({ groups: [] }),
        workspaceChannelTypes,
        workspaceChannels,
      })),
    } as unknown as DaemonClient;
    const setIntervalSpy = vi.spyOn(window, 'setInterval');

    renderSection({
      client,
      expanded: true,
      sourceType: 'channel',
      channelGroupingEnabled: true,
    });
    await flush();
    expect(workspaceChannelTypes).toHaveBeenCalledTimes(1);

    const poll = setIntervalSpy.mock.calls.findLast(
      ([, timeout]) => timeout === 10_000,
    );
    expect(poll).toBeDefined();
    await act(async () => {
      const callback = poll![0];
      expect(callback).toBeTypeOf('function');
      if (typeof callback === 'function') callback();
      await Promise.resolve();
    });
    await flush();

    expect(workspaceChannelTypes).toHaveBeenCalledTimes(2);

    // Background tabs skip the tick entirely, matching the sibling pollers.
    const originalVisibility = document.visibilityState;
    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    });
    await act(async () => {
      const callback = poll![0];
      if (typeof callback === 'function') callback();
      await Promise.resolve();
    });
    await flush();
    expect(workspaceChannelTypes).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, 'visibilityState', {
      value: originalVisibility,
      configurable: true,
    });
    setIntervalSpy.mockRestore();
  });
});

describe('WorkspaceSection session loading', () => {
  it('shows five sessions and resets Show all after the workspace closes', async () => {
    const sessions = Array.from({ length: 6 }, (_, index) => ({
      sessionId: `session-${index + 1}`,
      displayName: `Session ${index + 1}`,
      workspaceCwd: trustedWorkspace.cwd,
    }));
    const listWorkspaceSessionsPage = vi.fn().mockResolvedValue({ sessions });
    const client = {
      workspaceByCwd: vi.fn(() => ({
        workspaceGit,
        listWorkspaceSessionsPage,
        listSessionGroups: vi.fn().mockResolvedValue({ groups: [] }),
      })),
    } as unknown as DaemonClient;

    renderSection({ client, expanded: true });
    await flush();
    expect(container.textContent).toContain('Session 5');
    expect(container.textContent).not.toContain('Session 6');

    const showAll = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Show all',
    );
    act(() => showAll?.click());
    expect(container.textContent).toContain('Session 6');

    renderSection({ client, expanded: false });
    await flush();
    renderSection({ client, expanded: true });
    await flush();
    expect(container.textContent).not.toContain('Session 6');
  });

  it('refreshes the catalog when an expanded workspace loses trust', async () => {
    const listWorkspaceSessionsPage = vi
      .fn()
      .mockResolvedValueOnce({
        sessions: [
          {
            sessionId: 'session-1',
            displayName: 'Trusted session',
          } as DaemonSessionSummary,
        ],
      })
      .mockResolvedValueOnce({
        sessions: [
          {
            sessionId: 'session-2',
            displayName: 'Read-only session',
          } as DaemonSessionSummary,
        ],
      });
    const client = {
      workspaceByCwd: vi.fn(() => ({
        workspaceGit,
        listWorkspaceSessionsPage,
        listSessionGroups: vi.fn().mockResolvedValue({ groups: [] }),
      })),
    } as unknown as DaemonClient;
    const trustedSecondary = { ...untrustedWorkspace, trusted: true };

    renderSection({
      workspace: trustedSecondary,
      client,
      expanded: true,
    });
    await flush();
    expect(listWorkspaceSessionsPage).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Trusted session');

    renderSection({
      workspace: untrustedWorkspace,
      client,
      expanded: true,
    });
    await flush();

    expect(listWorkspaceSessionsPage).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('Read-only session');
  });

  it('refreshes a retained read-only catalog when the section reopens', async () => {
    const listWorkspaceSessionsPage = vi
      .fn()
      .mockResolvedValueOnce({
        sessions: [
          {
            sessionId: 'session-1',
            displayName: 'Initial session',
          } as DaemonSessionSummary,
        ],
      })
      .mockResolvedValueOnce({
        sessions: [
          {
            sessionId: 'session-2',
            displayName: 'Updated session',
          } as DaemonSessionSummary,
        ],
      });
    const client = {
      workspaceByCwd: vi.fn(() => ({
        workspaceGit,
        listWorkspaceSessionsPage,
        listSessionGroups: vi.fn().mockResolvedValue({ groups: [] }),
      })),
    } as unknown as DaemonClient;

    renderSection({
      workspace: untrustedWorkspace,
      client,
      expanded: true,
    });
    await flush();
    expect(listWorkspaceSessionsPage).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Initial session');

    renderSection({
      workspace: untrustedWorkspace,
      client,
      expanded: false,
    });
    await flush();
    renderSection({
      workspace: untrustedWorkspace,
      client,
      expanded: true,
    });
    await flush();

    expect(listWorkspaceSessionsPage).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('Updated session');
  });

  it('does not refresh a retained catalog when live-state owns freshness', async () => {
    const listWorkspaceSessionsPage = vi.fn().mockResolvedValue({
      sessions: [
        {
          sessionId: 'session-1',
          displayName: 'Initial session',
        } as DaemonSessionSummary,
      ],
    });
    const client = {
      workspaceByCwd: vi.fn(() => ({
        workspaceGit,
        listWorkspaceSessionsPage,
        listSessionGroups: vi.fn().mockResolvedValue({ groups: [] }),
      })),
    } as unknown as DaemonClient;

    renderSection({ client, expanded: true });
    await flush();
    expect(listWorkspaceSessionsPage).toHaveBeenCalledTimes(1);

    renderSection({
      client,
      expanded: false,
      sessionLiveStateEnabled: true,
    });
    await flush();
    renderSection({
      client,
      expanded: true,
      sessionLiveStateEnabled: true,
    });
    await flush();

    expect(listWorkspaceSessionsPage).toHaveBeenCalledTimes(1);
  });
});

describe('WorkspaceSection git chip', () => {
  it('renders a clickable git chip for a trusted repo', async () => {
    const status: DaemonWorkspaceGitStatus = {
      v: 2,
      workspaceCwd: '/tmp/project',
      branch: 'main',
      unstaged: 1,
    };
    workspaceGit.mockResolvedValue(status);
    const onOpenGitDiff = vi.fn();

    renderSection({ onOpenGitDiff });
    await flush();

    const chip = gitChip();
    expect(chip).not.toBeNull();
    // The chip is a read-only OUTPUT inside a button that opens the changes
    // view on click.
    expect(chip?.tagName).toBe('OUTPUT');
    expect(chip?.getAttribute('data-dirty')).toBe('true');
    expect(chip?.className).toContain(gitStyles.gitBranchChipCompact);
    expect(chip?.getAttribute('aria-label')).toContain('main');

    // The chip itself is a read-only OUTPUT; the wrapping button opens the
    // branch picker popover on click (which contains a "View Changes" action
    // that calls onOpenGitDiff). Verify the button is wired and clickable.
    const button = chip?.closest('button');
    expect(button).not.toBeNull();
    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // Clicking the chip opens the branch picker popover, not the diff dialog
    // directly. The diff dialog is accessible via "View Changes" inside the
    // popover.
    expect(button?.getAttribute('aria-expanded')).toBe('true');
  });

  it('re-fetches git status right after a picker checkout instead of waiting for the poll', async () => {
    // The sidebar chip only polls every 60s, so without the onBranchChanged
    // wiring it would keep showing the old branch for up to a minute after a
    // checkout made through the branch picker.
    workspaceGit.mockResolvedValue({
      v: 2,
      workspaceCwd: '/tmp/project',
      branch: 'feat/demo',
    });
    workspaceGitBranches.mockResolvedValue({
      v: 1,
      workspaceCwd: '/tmp/project',
      available: true,
      local: [
        { name: 'feat/demo', isHead: true },
        { name: 'main', isHead: false },
      ],
      remote: [],
      tags: [],
      recent: [],
      head: 'feat/demo',
      detached: false,
    });
    const client = makeClient();

    renderSection({ client, onOpenGitDiff: vi.fn() });
    await flush();
    expect(workspaceGit).toHaveBeenCalledTimes(1);

    const chipButton = gitChip()?.closest('button');
    expect(chipButton).not.toBeNull();
    act(() => {
      chipButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    // Opening the picker fetches a fresh status for its action hints and
    // hands it back to the chip.
    expect(workspaceGit).toHaveBeenCalledTimes(2);

    // The picker content is portaled outside the section container.
    const mainItem = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'main',
    );
    expect(mainItem).toBeTruthy();
    act(() => {
      mainItem?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(workspaceGitCheckout).toHaveBeenCalledWith('main', undefined);
    expect(workspaceGit).toHaveBeenCalledTimes(3);
  });

  it('hides the chip for an untrusted workspace and never queries git', async () => {
    workspaceGit.mockResolvedValue({
      v: 2,
      workspaceCwd: '/tmp/danger',
      branch: 'main',
    });

    renderSection({
      workspace: untrustedWorkspace,
      onOpenGitDiff: vi.fn(),
    });
    await flush();

    expect(gitChip()).toBeNull();
    expect(workspaceGit).not.toHaveBeenCalled();
  });

  it('skips the git poll when the workspace cwd is not a real path', async () => {
    // A synthetic fallback workspace carries a display name in `cwd`; polling
    // would qualify the route with it and 400, so no request fires and the chip
    // stays hidden.
    workspaceGit.mockResolvedValue({
      v: 2,
      workspaceCwd: 'Project',
      branch: 'main',
    });

    renderSection({
      workspace: { ...trustedWorkspace, cwd: 'Project' },
      onOpenGitDiff: vi.fn(),
    });
    await flush();

    expect(workspaceGit).not.toHaveBeenCalled();
    expect(gitChip()).toBeNull();
  });

  it('re-fetches git status when reloadToken changes', async () => {
    // reloadToken is in the polling effect's dependency array so agent activity
    // (which bumps it) refreshes the chip immediately instead of waiting for the
    // next 60s tick. A stable client isolates the re-fetch to the token change.
    workspaceGit.mockResolvedValue({
      v: 2,
      workspaceCwd: '/tmp/project',
      branch: 'main',
    });
    const client = makeClient();
    const onOpenGitDiff = vi.fn();

    renderSection({ client, reloadToken: 0, onOpenGitDiff });
    await flush();
    expect(workspaceGit).toHaveBeenCalledTimes(1);

    renderSection({ client, reloadToken: 1, onOpenGitDiff });
    await flush();
    expect(workspaceGit).toHaveBeenCalledTimes(2);
  });

  it('does not re-fetch git status when only the diff handler changes', async () => {
    workspaceGit.mockResolvedValue({
      v: 2,
      workspaceCwd: '/tmp/project',
      branch: 'main',
    });
    const client = makeClient();

    renderSection({ client, onOpenGitDiff: vi.fn() });
    await flush();
    expect(workspaceGit).toHaveBeenCalledTimes(1);

    renderSection({ client, onOpenGitDiff: vi.fn() });
    await flush();
    expect(workspaceGit).toHaveBeenCalledTimes(1);
  });

  it('hides the chip when the workspace is not a git repo (null branch)', async () => {
    workspaceGit.mockResolvedValue({
      v: 2,
      workspaceCwd: '/tmp/project',
      branch: null,
    });

    renderSection({ onOpenGitDiff: vi.fn() });
    await flush();

    expect(workspaceGit).toHaveBeenCalled();
    expect(gitChip()).toBeNull();
  });

  it('omits the chip when no diff handler is provided', async () => {
    workspaceGit.mockResolvedValue({
      v: 2,
      workspaceCwd: '/tmp/project',
      branch: 'main',
    });

    renderSection({ onOpenGitDiff: undefined });
    await flush();

    expect(gitChip()).toBeNull();
  });
});

describe('isAbsolutePath', () => {
  it('accepts unix, Windows and UNC absolute paths and rejects relative ones', async () => {
    const { isAbsolutePath } = await import('./WorkspaceSection');
    expect(isAbsolutePath('/x')).toBe(true);
    expect(isAbsolutePath('C:\\x')).toBe(true);
    expect(isAbsolutePath('\\\\server\\share')).toBe(true);
    expect(isAbsolutePath('relative/path')).toBe(false);
    expect(isAbsolutePath('name')).toBe(false);
  });
});

describe('WorkspaceSection overview', () => {
  it('fetches nothing while a custom header renderer hides every consumer', async () => {
    const client = makeOverviewClient();
    renderSection({
      client,
      expanded: true,
      overviewEnabled: true,
      renderHeader: () => <span>custom header</span>,
    });
    await flush();
    expect(client.workspaceMcp).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-web-shell-workspace-path]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-web-shell-workspace-overview]'),
    ).toBeNull();

    // Control arm: the default header consumes the snapshot and fetches.
    renderSection({ client, expanded: true, overviewEnabled: true });
    await flush();
    expect(client.workspaceMcp).toHaveBeenCalledTimes(1);
  });

  it('fetches nothing and shows no path for a synthetic workspace without a real cwd', async () => {
    const client = makeOverviewClient();
    renderSection({
      client,
      workspace: { ...trustedWorkspace, id: 'synthetic', cwd: 'My Project' },
      expanded: true,
      overviewEnabled: true,
    });
    await flush();
    expect(client.workspaceMcp).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-web-shell-workspace-path]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-web-shell-workspace-overview]'),
    ).toBeNull();
  });

  it('keeps the last session counts while the row is collapsed', async () => {
    const client = makeOverviewClient([
      {
        sessionId: 'a',
        workspaceCwd: '/tmp/other',
        displayName: 'Running',
        hasActivePrompt: true,
      },
      { sessionId: 'b', workspaceCwd: '/tmp/other', displayName: 'Idle' },
    ]);
    const workspace = {
      ...untrustedWorkspace,
      trusted: true,
      id: 'other',
      cwd: '/tmp/other',
    };
    renderSection({ client, workspace, expanded: true, overviewEnabled: true });
    await flush();
    await openDetailsDialog();
    expect(sessionCount('Total')).toBe('2');
    expect(sessionCount('Running')).toBe('1');

    renderSection({
      client,
      workspace,
      expanded: false,
      overviewEnabled: true,
    });
    await flush();
    expect(sessionCount('Total')).toBe('2');
  });

  it('shows no counts or path when the overview is disabled', async () => {
    const client = makeOverviewClient([
      { sessionId: 'a', workspaceCwd: '/tmp/project', hasActivePrompt: true },
    ]);
    renderSection({ client, expanded: true });
    await flush();
    expect(client.workspaceMcp).not.toHaveBeenCalled();
    expect(sessionCounts()).toBeNull();
    expect(
      document.querySelector('[data-web-shell-workspace-path]'),
    ).toBeNull();
  });
});

describe('WorkspaceSection counts across a source switch', () => {
  it('shows no counts while the new source is still loading', async () => {
    let resolveChannel: (page: {
      sessions: DaemonSessionSummary[];
    }) => void = () => {};
    const channelPage = new Promise<{ sessions: DaemonSessionSummary[] }>(
      (resolve) => {
        resolveChannel = resolve;
      },
    );
    const defaultPage = Promise.resolve({
      sessions: [
        { sessionId: 'a', workspaceCwd: '/tmp/other', hasActivePrompt: true },
        { sessionId: 'b', workspaceCwd: '/tmp/other' },
        { sessionId: 'c', workspaceCwd: '/tmp/other' },
      ] as DaemonSessionSummary[],
    });
    const listWorkspaceSessionsPage = vi.fn(
      (options?: { sourceType?: string }) =>
        options?.sourceType === 'channel' ? channelPage : defaultPage,
    );
    const client = {
      workspaceByCwd: vi.fn(() => ({
        workspaceGit,
        listWorkspaceSessionsPage,
        listSessionGroups: vi.fn().mockResolvedValue({ groups: [] }),
      })),
    } as unknown as DaemonClient;
    const workspace = { ...trustedWorkspace, id: 'other', cwd: '/tmp/other' };

    renderSection({
      client,
      workspace,
      expanded: true,
      overviewEnabled: true,
      sourceType: 'default',
    });
    await flush();
    await openDetailsDialog();
    expect(sessionCount('Total')).toBe('3');
    expect(sessionCount('Running')).toBe('1');

    // The channel query starts without a page: stale default counts above an
    // empty channel list would mislead, so the popover shows none.
    renderSection({
      client,
      workspace,
      expanded: true,
      overviewEnabled: true,
      sourceType: 'channel',
    });
    await flush();
    expect(sessionCounts()).toBeNull();

    resolveChannel({
      sessions: [
        { sessionId: 'x', workspaceCwd: '/tmp/other', sourceType: 'channel' },
      ] as DaemonSessionSummary[],
    });
    await flush();
    expect(sessionCount('Total')).toBe('1');

    // Collapsing keeps the last counts of the active source.
    renderSection({
      client,
      workspace,
      expanded: false,
      overviewEnabled: true,
      sourceType: 'channel',
    });
    await flush();
    expect(sessionCount('Total')).toBe('1');
  });
});

describe('WorkspaceSection local-open gates', () => {
  it('shows the open-locally buttons only for a trusted workspace with a real path', async () => {
    const onOpenPathLocally = vi.fn().mockResolvedValue(undefined);
    const onOpenTerminalLocally = vi.fn().mockResolvedValue(undefined);
    renderSection({
      client: makeOverviewClient(),
      expanded: true,
      overviewEnabled: true,
      onOpenPathLocally,
      onOpenTerminalLocally,
    });
    await flush();
    const details = await openDetailsDialog();
    const folderButton = details.querySelector(
      '[data-web-shell-open-workspace-folder]',
    );
    expect(folderButton).not.toBeNull();
    expect(
      details.querySelector('[data-web-shell-open-workspace-terminal]'),
    ).not.toBeNull();
    await act(async () => {
      folderButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(onOpenPathLocally).toHaveBeenCalledWith('/tmp/project');

    // Untrusted rows get no local-open surface.
    renderSection({
      client: makeOverviewClient(),
      workspace: untrustedWorkspace,
      expanded: true,
      overviewEnabled: true,
      onOpenPathLocally,
      onOpenTerminalLocally,
    });
    await flush();
    const lockedDetails = await openDetailsDialog();
    expect(
      lockedDetails.querySelector('[data-web-shell-open-workspace-folder]'),
    ).toBeNull();
    expect(
      lockedDetails.querySelector('[data-web-shell-open-workspace-terminal]'),
    ).toBeNull();
  });
});

describe('WorkspaceSection overview gates', () => {
  it('never asks an untrusted workspace for facets', async () => {
    const client = makeOverviewClient();
    renderSection({
      client,
      workspace: untrustedWorkspace,
      expanded: true,
      overviewEnabled: true,
    });
    await flush();
    expect(client.workspaceMcp).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-web-shell-workspace-overview]'),
    ).toBeNull();
  });

  it('polls git for the header actions even without a diff handler', async () => {
    workspaceGit.mockResolvedValue({
      v: 2,
      workspaceCwd: '/tmp/project',
      branch: 'main',
    });
    const headerActions = vi.fn(() => null);
    renderSection({
      client: makeOverviewClient(),
      headerActions,
      gitBranchWanted: true,
    });
    await flush();
    expect(workspaceGit).toHaveBeenCalled();
    const branches = headerActions.mock.calls.map(
      ([, context]) => context.gitBranch,
    );
    expect(branches).toContain('main');
    // The chip itself still needs the diff handler.
    expect(gitChip()).toBeNull();
  });

  it('skips the git poll when no header action reads the branch', async () => {
    workspaceGit.mockResolvedValue({
      v: 2,
      workspaceCwd: '/tmp/project',
      branch: 'main',
    });
    const headerActions = vi.fn(() => null);
    renderSection({ client: makeOverviewClient(), headerActions });
    await flush();
    expect(workspaceGit).not.toHaveBeenCalled();
    expect(headerActions).toHaveBeenCalled();
  });

  it('shows no counts while parent-owned stats are loading', async () => {
    const client = makeOverviewClient();
    // Production wiring for the primary row: the sidebar lists its sessions
    // itself, so the section renders none and owns no catalog query.
    renderSection({
      client,
      expanded: true,
      overviewEnabled: true,
      renderSessions: false,
      sessionStats: { total: 4, running: 1, attention: 2, truncated: true },
    });
    await flush();
    await openDetailsDialog();
    expect(sessionCount('Attention')).toBe('2');
    expect(sessionCount('Running')).toBe('1');
    expect(sessionCount('Total')).toBe('4+');
    expect(sessionCounts()?.getAttribute('aria-label')).toBe(
      '2 sessions waiting for you · 1 running session · 4+ sessions',
    );
    // A source switch: the sidebar has no page for the new source yet, and
    // the retained counts must not fill the gap.
    renderSection({
      client,
      expanded: true,
      overviewEnabled: true,
      renderSessions: false,
      sessionStats: null,
    });
    await flush();
    expect(sessionCounts()).toBeNull();
  });

  it('passes the overview snapshot to the header actions', async () => {
    const headerActions = vi.fn(() => null);
    renderSection({
      client: makeOverviewClient(),
      expanded: true,
      overviewEnabled: true,
      headerActions,
    });
    await flush();
    await flush();
    expect(
      headerActions.mock.calls.some(([, context]) => Boolean(context.overview)),
    ).toBe(true);
  });
});

describe('WorkspaceSection retained counts across a source switch', () => {
  it('drops counts retained for a previous source while collapsed', async () => {
    const channelPage = new Promise<{ sessions: DaemonSessionSummary[] }>(
      () => {},
    );
    const defaultPage = Promise.resolve({
      sessions: [
        { sessionId: 'a', workspaceCwd: '/tmp/other' },
        { sessionId: 'b', workspaceCwd: '/tmp/other' },
        { sessionId: 'c', workspaceCwd: '/tmp/other' },
      ] as DaemonSessionSummary[],
    });
    const listWorkspaceSessionsPage = vi.fn(
      (options?: { sourceType?: string }) =>
        options?.sourceType === 'channel' ? channelPage : defaultPage,
    );
    const client = {
      workspaceByCwd: vi.fn(() => ({
        workspaceGit,
        listWorkspaceSessionsPage,
        listSessionGroups: vi.fn().mockResolvedValue({ groups: [] }),
      })),
    } as unknown as DaemonClient;
    const workspace = { ...trustedWorkspace, id: 'other', cwd: '/tmp/other' };
    const render = (expanded: boolean, sourceType: string) =>
      renderSection({
        client,
        workspace,
        expanded,
        overviewEnabled: true,
        sourceType,
      });

    render(true, 'default');
    await flush();
    await openDetailsDialog();
    expect(sessionCount('Total')).toBe('3');
    render(false, 'default');
    await flush();
    expect(sessionCount('Total')).toBe('3');
    // The global source switches while the row stays collapsed: the default
    // source's counts no longer describe the active source.
    render(false, 'channel');
    await flush();
    expect(sessionCounts()).toBeNull();
    // Switching back restores the counts that source still owns.
    render(false, 'default');
    await flush();
    expect(sessionCount('Total')).toBe('3');
  });
});

describe('WorkspaceSection pinned group members (issue #10391)', () => {
  function makeOrganizationClient(
    sessions: Array<Partial<DaemonSessionSummary>>,
  ): DaemonClient {
    return {
      workspaceByCwd: vi.fn(() => ({
        workspaceGit,
        listWorkspaceSessionsPage: vi.fn().mockResolvedValue({ sessions }),
        listSessionGroups: vi.fn().mockResolvedValue({
          groups: [
            {
              id: 'design-group',
              name: 'Design',
              color: 'blue',
              order: 0,
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        }),
      })),
    } as unknown as DaemonClient;
  }

  it('keeps pinned members in their group section and count', async () => {
    renderSection({
      client: makeOrganizationClient([
        {
          sessionId: 'pinned-member',
          displayName: 'Pinned member',
          groupId: 'design-group',
          isPinned: true,
          pinnedAt: '2026-01-02T00:00:00.000Z',
        },
        {
          sessionId: 'plain-session',
          displayName: 'Plain session',
          groupId: null,
        },
      ] as Array<Partial<DaemonSessionSummary>>),
      expanded: true,
      organizationEnabled: true,
      excludePinned: true,
    });
    await flush();

    const groupSection = container.querySelector<HTMLElement>(
      'section[aria-label="Design"]',
    );
    expect(groupSection).not.toBeNull();
    // The reported symptom: a group whose members are all pinned rendered
    // `· 0`, visually identical to lost memberships.
    expect(groupSection?.textContent).toContain('· 1');
    expect(groupSection?.textContent).toContain('Pinned member');

    // Pinned members keep their group and must not fall into Ungrouped.
    const ungrouped = container.querySelector<HTMLElement>(
      'section[aria-label="Ungrouped"]',
    );
    expect(ungrouped?.textContent).toContain('Plain session');
    expect(ungrouped?.textContent ?? '').not.toContain('Pinned member');
  });

  it('still renders unpinned members when pinned rows are lifted into the group', async () => {
    renderSection({
      client: makeOrganizationClient([
        {
          sessionId: 'pinned-member',
          displayName: 'Pinned member',
          groupId: 'design-group',
          isPinned: true,
          pinnedAt: '2026-01-02T00:00:00.000Z',
        },
        {
          sessionId: 'active-member',
          displayName: 'Active member',
          groupId: 'design-group',
        },
      ] as Array<Partial<DaemonSessionSummary>>),
      expanded: true,
      organizationEnabled: true,
      excludePinned: true,
    });
    await flush();

    const groupSection = container.querySelector<HTMLElement>(
      'section[aria-label="Design"]',
    );
    expect(groupSection?.textContent).toContain('· 2');
    expect(groupSection?.textContent).toContain('Active member');
    expect(groupSection?.textContent).toContain('Pinned member');
    // Every session belongs to the group, so no Ungrouped bucket renders.
    expect(
      container.querySelector('section[aria-label="Ungrouped"]'),
    ).toBeNull();
  });

  it('renders group sections instead of the empty label when every session is pinned', async () => {
    renderSection({
      client: makeOrganizationClient([
        {
          sessionId: 'pinned-member',
          displayName: 'Pinned member',
          groupId: 'design-group',
          isPinned: true,
          pinnedAt: '2026-01-02T00:00:00.000Z',
        },
      ] as Array<Partial<DaemonSessionSummary>>),
      expanded: true,
      organizationEnabled: true,
      excludePinned: true,
    });
    await flush();

    // Every session is a pinned group member, so the pinned-filtered list is
    // empty; the grouped view must still render the member instead of the
    // empty label.
    const groupSection = container.querySelector<HTMLElement>(
      'section[aria-label="Design"]',
    );
    expect(groupSection).not.toBeNull();
    expect(groupSection?.textContent).toContain('\u00b7 1');
    expect(groupSection?.textContent).toContain('Pinned member');
    expect(container.textContent ?? '').not.toContain('No sessions');
  });

  it('keeps a pinned member in its group while searching matches only it', async () => {
    renderSection({
      client: makeOrganizationClient([
        {
          sessionId: 'pinned-member',
          displayName: 'Pinned member',
          groupId: 'design-group',
          isPinned: true,
          pinnedAt: '2026-01-02T00:00:00.000Z',
        },
        {
          sessionId: 'active-member',
          displayName: 'Active member',
          groupId: 'design-group',
        },
      ] as Array<Partial<DaemonSessionSummary>>),
      expanded: true,
      organizationEnabled: true,
      excludePinned: true,
      searchQuery: 'pinned',
    });
    await flush();

    // The query matches only the pinned member, so group items must derive
    // from the search-filtered list: it stays in its group while the
    // non-matching member disappears.
    const groupSection = container.querySelector<HTMLElement>(
      'section[aria-label="Design"]',
    );
    expect(groupSection).not.toBeNull();
    expect(groupSection?.textContent).toContain('\u00b7 1');
    expect(groupSection?.textContent).toContain('Pinned member');
    expect(groupSection?.textContent ?? '').not.toContain('Active member');
  });

  it('keeps a group-less pinned session out of the Ungrouped section', async () => {
    renderSection({
      client: makeOrganizationClient([
        {
          sessionId: 'pinned-free',
          displayName: 'Pinned free',
          groupId: null,
          isPinned: true,
          pinnedAt: '2026-01-02T00:00:00.000Z',
        },
        {
          sessionId: 'plain-session',
          displayName: 'Plain session',
          groupId: null,
        },
      ] as Array<Partial<DaemonSessionSummary>>),
      expanded: true,
      organizationEnabled: true,
      excludePinned: true,
    });
    await flush();

    // `ungrouped` derives from the pinned-filtered list, so the group-less
    // pinned session never duplicates the Pinned section inside Ungrouped.
    const ungrouped = container.querySelector<HTMLElement>(
      'section[aria-label="Ungrouped"]',
    );
    expect(ungrouped).not.toBeNull();
    expect(ungrouped?.textContent).toContain('\u00b7 1');
    expect(ungrouped?.textContent).toContain('Plain session');
    expect(ungrouped?.textContent ?? '').not.toContain('Pinned free');
  });
});

describe('WorkspaceSection content search', () => {
  function makeSearchClient(input: {
    sessions: Array<Partial<DaemonSessionSummary>>;
    searchResults: DaemonSessionSearchResult;
  }): DaemonClient & {
    searchWorkspaceSessions: ReturnType<typeof vi.fn>;
  } {
    const searchWorkspaceSessions = vi
      .fn()
      .mockResolvedValue(input.searchResults);
    const client = {
      searchWorkspaceSessions,
      workspaceByCwd: vi.fn(() => ({
        workspaceGit,
        listWorkspaceSessionsPage: vi
          .fn()
          .mockResolvedValue({ sessions: input.sessions }),
        listSessionGroups: vi.fn().mockResolvedValue({ groups: [] }),
      })),
    };
    return client as unknown as DaemonClient & {
      searchWorkspaceSessions: ReturnType<typeof vi.fn>;
    };
  }

  // The content search debounces 300ms before hitting the daemon.
  async function advanceSearchDebounce(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
  }

  const renderRow = (
    session: DaemonSessionSummary,
    options?: { searchSnippet?: string | undefined },
  ): ReactNode => (
    <div key={session.sessionId}>
      {session.displayName}
      {options?.searchSnippet ? `|${options.searchSnippet}` : ''}
    </div>
  );

  it('merges content hits not in the loaded catalog and forwards the snippet', async () => {
    const client = makeSearchClient({
      sessions: [{ sessionId: 'loaded', displayName: 'Loaded session' }],
      searchResults: {
        results: [
          {
            session: {
              sessionId: 'ghost-hit',
              workspaceCwd: '/tmp/project',
              displayName: 'Ghost hit',
            },
            snippet: 'qdrant excerpt',
          },
        ],
      },
    });
    renderSection({
      client,
      expanded: true,
      searchQuery: 'qdrant',
      renderSession: renderRow,
    });
    await flush();
    await advanceSearchDebounce();
    await flush();

    expect(client.searchWorkspaceSessions).toHaveBeenCalledWith(
      '/tmp/project',
      'qdrant',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    // The content hit renders with its snippet even though the loaded
    // catalog page doesn't carry the session; the non-matching loaded
    // session is filtered out.
    expect(container.textContent).toContain('Ghost hit');
    expect(container.textContent).toContain('qdrant excerpt');
    expect(container.textContent ?? '').not.toContain('Loaded session');
  });

  it('keeps the catalog entry for a content hit already listed locally', async () => {
    const client = makeSearchClient({
      sessions: [{ sessionId: 'loaded-hit', displayName: 'Loaded hit' }],
      searchResults: {
        results: [
          {
            session: {
              sessionId: 'loaded-hit',
              workspaceCwd: '/tmp/project',
              displayName: 'Stale search name',
            },
            snippet: 'qdrant excerpt',
          },
        ],
      },
    });
    renderSection({
      client,
      expanded: true,
      searchQuery: 'qdrant',
      renderSession: renderRow,
    });
    await flush();
    await advanceSearchDebounce();
    await flush();

    expect(container.textContent).toContain('Loaded hit');
    expect(container.textContent).toContain('qdrant excerpt');
    expect(container.textContent ?? '').not.toContain('Stale search name');
  });

  it('renders a pinned ghost hit instead of dropping it with excludePinned', async () => {
    const client = makeSearchClient({
      sessions: [],
      searchResults: {
        results: [
          {
            session: {
              sessionId: 'pinned-ghost',
              workspaceCwd: '/tmp/project',
              displayName: 'Pinned ghost',
              isPinned: true,
            },
            snippet: 'qdrant excerpt',
          },
        ],
      },
    });
    renderSection({
      client,
      expanded: true,
      searchQuery: 'qdrant',
      excludePinned: true,
      renderSession: renderRow,
    });
    await flush();
    await advanceSearchDebounce();
    await flush();

    // The pinned page never carries this ghost, so excluding it like a
    // loaded pinned row would render the matching session nowhere (R2-2).
    expect(container.textContent).toContain('Pinned ghost');
    expect(container.textContent).toContain('qdrant excerpt');
  });

  it('drops a hit row after its session is deleted while the query stays active', async () => {
    const listPage = vi.fn().mockResolvedValue({ sessions: [] });
    const search = vi.fn().mockResolvedValue({
      results: [
        {
          session: {
            sessionId: 'ghost',
            workspaceCwd: '/tmp/project',
            displayName: 'Ghost hit',
          },
          snippet: 'qdrant excerpt',
        },
      ],
    });
    const client = {
      searchWorkspaceSessions: search,
      workspaceByCwd: vi.fn(() => ({
        workspaceGit,
        listWorkspaceSessionsPage: listPage,
        listSessionGroups: vi.fn().mockResolvedValue({ groups: [] }),
      })),
    } as unknown as DaemonClient;
    renderSection({
      client,
      expanded: true,
      searchQuery: 'qdrant',
      renderSession: renderRow,
      reloadToken: 0,
    });
    await flush();
    await advanceSearchDebounce();
    await flush();
    expect(container.textContent).toContain('Ghost hit');

    // The session is deleted: catalog and transcript are gone and the
    // reload token bumps — the settled hit must not resurrect it.
    search.mockResolvedValue({ results: [] });
    renderSection({
      client,
      expanded: true,
      searchQuery: 'qdrant',
      renderSession: renderRow,
      reloadToken: 1,
    });
    await advanceSearchDebounce();
    await flush();

    expect(container.textContent ?? '').not.toContain('Ghost hit');
  });

  it('drops a hit row when a poll-observed catalog change removes the session', async () => {
    vi.useFakeTimers();
    const tick = async (ms: number) => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    };
    const listPage = vi.fn().mockResolvedValue({
      sessions: [{ sessionId: 's1', displayName: 'Loaded hit' }],
    });
    const search = vi.fn().mockResolvedValue({
      results: [
        {
          session: {
            sessionId: 's1',
            workspaceCwd: '/tmp/project',
            displayName: 'Loaded hit',
          },
          snippet: 'qdrant excerpt',
        },
      ],
    });
    const client = {
      searchWorkspaceSessions: search,
      workspaceByCwd: vi.fn(() => ({
        workspaceGit,
        listWorkspaceSessionsPage: listPage,
        listSessionGroups: vi.fn().mockResolvedValue({ groups: [] }),
      })),
    } as unknown as DaemonClient;

    renderSection({
      client,
      expanded: true,
      searchQuery: 'qdrant',
      renderSession: renderRow,
    });
    await tick(1); // catalog fetch settles
    await tick(350); // content-search debounce fires
    await tick(1); // search response settles
    expect(container.textContent).toContain('Loaded hit');
    expect(container.textContent).toContain('qdrant excerpt');

    // Another client deletes the session: the next 10s poll drops it from
    // the catalog — no handler token bump, only the membership change.
    listPage.mockResolvedValue({ sessions: [] });
    search.mockResolvedValue({ results: [] });
    await tick(10_000); // catalog poll
    await tick(350); // content-search refetch debounce
    await tick(1);

    expect(search).toHaveBeenCalledTimes(2);
    expect(container.textContent ?? '').not.toContain('Loaded hit');
  });
});

describe('WorkspaceSection overview plumbing', () => {
  it('still fetches for a custom header when header actions consume the snapshot', async () => {
    const client = makeOverviewClient();
    const headerActions = vi.fn(() => null);
    renderSection({
      client,
      expanded: true,
      overviewEnabled: true,
      renderHeader: () => <span>custom header</span>,
      headerActions,
    });
    await flush();
    await flush();
    expect(client.workspaceMcp).toHaveBeenCalledTimes(1);
    expect(
      headerActions.mock.calls.some(([, context]) => Boolean(context.overview)),
    ).toBe(true);
    // The path and chips stay hidden under a custom header.
    expect(
      document.querySelector('[data-web-shell-workspace-overview]'),
    ).toBeNull();
  });

  it('keeps the last snapshot for the header actions while collapsed', async () => {
    const client = makeOverviewClient();
    const headerActions = vi.fn(() => null);
    renderSection({
      client,
      expanded: true,
      overviewEnabled: true,
      headerActions,
    });
    await flush();
    await flush();
    expect(
      headerActions.mock.calls.some(([, context]) => Boolean(context.overview)),
    ).toBe(true);
    headerActions.mockClear();
    renderSection({
      client,
      expanded: false,
      overviewEnabled: true,
      headerActions,
    });
    await flush();
    const lastCall = headerActions.mock.calls.at(-1);
    expect(lastCall?.[1].overview).toBeDefined();
    // Collapsed rows do not refetch.
    expect(client.workspaceMcp).toHaveBeenCalledTimes(1);
  });

  it('refetches the facets when the reload token changes', async () => {
    const client = makeOverviewClient();
    renderSection({
      client,
      expanded: true,
      overviewEnabled: true,
      reloadToken: 0,
    });
    await flush();
    expect(client.workspaceMcp).toHaveBeenCalledTimes(1);
    renderSection({
      client,
      expanded: true,
      overviewEnabled: true,
      reloadToken: 1,
    });
    await flush();
    expect(client.workspaceMcp).toHaveBeenCalledTimes(2);
  });

  it('marks the total as a lower bound when the daemon capped its scan', async () => {
    const workspaceMcp = vi.fn().mockResolvedValue({
      v: 1,
      workspaceCwd: '/tmp/other',
      initialized: true,
      servers: [],
    });
    const client = {
      workspaceByCwd: vi.fn(() => ({
        workspaceGit,
        workspaceMcp,
        listWorkspaceSessionsPage: vi.fn().mockResolvedValue({
          sessions: [
            { sessionId: 'a', workspaceCwd: '/tmp/other' },
            { sessionId: 'b', workspaceCwd: '/tmp/other' },
            { sessionId: 'c', workspaceCwd: '/tmp/other' },
          ],
          // No next page, but the scan hit the daemon's cap.
          truncated: true,
        }),
        listSessionGroups: vi.fn().mockResolvedValue({ groups: [] }),
      })),
    } as unknown as DaemonClient;
    renderSection({
      client,
      workspace: { ...trustedWorkspace, id: 'other', cwd: '/tmp/other' },
      expanded: true,
      overviewEnabled: true,
    });
    await flush();
    await openDetailsDialog();
    expect(sessionCount('Total')).toBe('3+');
  });
});
