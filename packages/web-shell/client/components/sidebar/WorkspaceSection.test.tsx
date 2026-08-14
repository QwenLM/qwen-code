// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';
import type {
  DaemonClient,
  DaemonSessionSummary,
  DaemonWorkspaceCapability,
  DaemonWorkspaceGitStatus,
} from '@qwen-code/sdk/daemon';
import gitStyles from '../ChatEditor.module.css';

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
vi.mock('@qwen-code/webui/daemon-react-sdk', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/webui/daemon-react-sdk')>();
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
          sourceType={overrides.sourceType}
          channelGroupingEnabled={overrides.channelGroupingEnabled}
          ungroupedLabel="Ungrouped"
          formatTime={() => ''}
          renderSession={(session: DaemonSessionSummary): ReactNode => (
            <div key={session.sessionId}>{session.displayName}</div>
          )}
          onOpenGitDiff={overrides.onOpenGitDiff}
        />
      </I18nProvider>,
    );
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function gitChip(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-web-shell-git-branch]');
}

beforeEach(() => {
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

  it('shows the complete read-only session name in a native tooltip', async () => {
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
    ).not.toBeNull();
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
    expect(workspaceGit).toHaveBeenCalledTimes(2);
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
