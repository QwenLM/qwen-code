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

const { workspaceGit } = vi.hoisted(() => ({
  workspaceGit: vi.fn(),
}));

// Mock useWorkspace so BranchPickerPopover can render without a real provider.
vi.mock('@qwen-code/webui/daemon-react-sdk', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/webui/daemon-react-sdk')>();
  return {
    ...actual,
    useWorkspace: () => ({
      client: {
        workspaceGitBranches: vi.fn().mockResolvedValue({
          v: 1,
          workspaceCwd: '/tmp/project',
          available: true,
          local: [],
          remote: [],
          tags: [],
          recent: [],
          head: 'main',
          detached: false,
        }),
        workspaceGitCheckout: vi.fn().mockResolvedValue(undefined),
        workspaceGitCreateBranch: vi.fn().mockResolvedValue(undefined),
        workspaceGitPush: vi
          .fn()
          .mockResolvedValue({ success: true, output: '' }),
        workspaceGitPull: vi
          .fn()
          .mockResolvedValue({ success: true, output: '' }),
        workspaceByCwd: () => ({
          workspaceGit,
          workspaceGitBranches: vi.fn().mockResolvedValue({
            v: 1,
            workspaceCwd: '/tmp/project',
            available: true,
            local: [],
            remote: [],
            tags: [],
            recent: [],
            head: 'main',
            detached: false,
          }),
          workspaceGitCheckout: vi.fn().mockResolvedValue(undefined),
          workspaceGitCreateBranch: vi.fn().mockResolvedValue(undefined),
          workspaceGitPush: vi
            .fn()
            .mockResolvedValue({ success: true, output: '' }),
          workspaceGitPull: vi
            .fn()
            .mockResolvedValue({ success: true, output: '' }),
          listWorkspaceSessions: vi.fn().mockResolvedValue([]),
        }),
      },
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
      workspaceGitBranches: vi.fn().mockResolvedValue({
        v: 1,
        workspaceCwd: '/tmp/project',
        available: true,
        local: [],
        remote: [],
        tags: [],
        recent: [],
        head: 'main',
        detached: false,
      }),
      workspaceGitCheckout: vi.fn().mockResolvedValue(undefined),
      workspaceGitCreateBranch: vi.fn().mockResolvedValue(undefined),
      workspaceGitPush: vi
        .fn()
        .mockResolvedValue({ success: true, output: '' }),
      workspaceGitPull: vi
        .fn()
        .mockResolvedValue({ success: true, output: '' }),
      listWorkspaceSessions: vi.fn().mockResolvedValue([]),
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
    const listWorkspaceSessions = vi.fn().mockResolvedValue([
      {
        sessionId: 'session-1',
        displayName: 'A very long session name',
        createdAt: '2026-01-01T00:00:00.000Z',
      } as DaemonSessionSummary,
    ]);
    const client = {
      workspaceByCwd: vi.fn(() => ({
        workspaceGit,
        listWorkspaceSessions,
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
    let resolveChannel: (sessions: DaemonSessionSummary[]) => void = () => {};
    const channelSessions = new Promise<DaemonSessionSummary[]>((resolve) => {
      resolveChannel = resolve;
    });
    // Every default-source request gets its OWN pending promise so the
    // pre-switch request can settle late, after the switch.
    const defaultResolvers: Array<(sessions: DaemonSessionSummary[]) => void> =
      [];
    const listWorkspaceSessions = vi.fn((options?: { sourceType?: string }) =>
      options?.sourceType === 'channel'
        ? channelSessions
        : new Promise<DaemonSessionSummary[]>((resolve) => {
            defaultResolvers.push(resolve);
          }),
    );
    const client = {
      workspaceByCwd: vi.fn(() => ({
        workspaceGit,
        listWorkspaceSessions,
        listSessionGroups: vi.fn().mockResolvedValue({ groups: [] }),
      })),
    } as unknown as DaemonClient;

    renderSection({ client, expanded: true, sourceType: 'default' });
    defaultResolvers[0]!([
      {
        sessionId: 'task-session',
        displayName: 'Task session',
        sourceType: 'default',
      },
    ]);
    await flush();
    expect(container.textContent).toContain('Task session');

    // A poll tick still on the default source issues a second request that
    // stays pending across the source switch below.
    renderSection({
      client,
      expanded: true,
      sourceType: 'default',
      reloadToken: 1,
    });

    renderSection({
      client,
      expanded: true,
      sourceType: 'channel',
      reloadToken: 1,
    });
    expect(container.textContent).not.toContain('Task session');

    resolveChannel([
      {
        sessionId: 'channel-session',
        displayName: 'Channel session',
        sourceType: 'channel',
      },
    ]);
    await flush();
    expect(container.textContent).toContain('Channel session');

    // The pending pre-switch default response settles AFTER the switch; the
    // requestId ordering guard must drop it — without it the stale write
    // clobbers the new-source list and the section renders the empty
    // placeholder until the next poll (indefinitely for read-only
    // workspaces, which have no polling interval).
    defaultResolvers[1]!([
      {
        sessionId: 'stale-task-session',
        displayName: 'Stale task session',
        sourceType: 'default',
      },
    ]);
    await flush();
    expect(container.textContent).toContain('Channel session');
    expect(container.textContent).not.toContain('Stale task session');
  });

  it('groups a secondary workspace with its own channel catalog', async () => {
    const client = {
      workspaceByCwd: vi.fn(() => ({
        workspaceGit,
        listWorkspaceSessions: vi.fn().mockResolvedValue([
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
        ]),
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
  });

  it('renders channel sessions flat while the channel catalog failed to load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = {
      workspaceByCwd: vi.fn(() => ({
        workspaceGit,
        listWorkspaceSessions: vi.fn().mockResolvedValue([
          {
            sessionId: 'ding-session',
            displayName: 'DingTalk session',
            sourceType: 'channel',
            sourceId: 'ding-one',
            groupId: 'organization-group',
          },
        ]),
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
        listWorkspaceSessions: vi.fn().mockResolvedValue([]),
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
    setIntervalSpy.mockRestore();
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
