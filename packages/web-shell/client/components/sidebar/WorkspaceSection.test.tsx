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

// A stable client whose `workspaceByCwd` always returns the same `workspaceGit`
// mock, so call assertions accumulate regardless of how often the component
// re-resolves the workspace handle.
function makeClient(): DaemonClient {
  return {
    workspaceByCwd: vi.fn(() => ({
      workspaceGit,
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
  }> = {},
): void {
  act(() => {
    root.render(
      <I18nProvider language="en">
        <WorkspaceSection
          workspace={overrides.workspace ?? trustedWorkspace}
          client={overrides.client ?? makeClient()}
          reloadToken={overrides.reloadToken ?? 0}
          untrustedLabel="Untrusted"
          readOnlyLabel="Read-only"
          trustToOpenLabel="Trust to open"
          noSessionsLabel="No sessions"
          loadErrorLabel="Load failed"
          organizationEnabled={false}
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

describe('WorkspaceSection git chip', () => {
  it('renders a clickable git chip for a trusted repo and opens its diff', async () => {
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
    expect(chip?.tagName).toBe('BUTTON');
    expect(chip?.getAttribute('data-dirty')).toBe('true');
    // Icon-only (compact) form: the branch name is not shown as inline text but
    // stays reachable via the accessible name (the hover tooltip).
    expect(chip?.className).toContain(gitStyles.gitBranchChipCompact);
    expect(chip?.getAttribute('aria-label')).toContain('main');

    act(() => {
      chip?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onOpenGitDiff).toHaveBeenCalledWith('/tmp/project');
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
