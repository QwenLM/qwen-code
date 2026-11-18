// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { ManagedArtifactLibraryPage } from './ManagedArtifactLibraryPage';
import { JavaManagedAgentHttpError } from './java-managed-agent-client';
import { artifact } from './managed-tool-result.test-fixtures';
import type { ManagedAgentSessionSummary } from './managed-agent-provider';
import type {
  ManagedArtifact,
  ManagedToolResultReader,
  ManagedWorkspaceArtifactReader,
} from './managed-tool-result-types';

const other: ManagedArtifact = {
  ...artifact,
  id: 'artifact-2',
  session_id: 'session-unknown',
  byte_length: 6,
  availability: 'unavailable',
};

function session(sessionId: string, title: string): ManagedAgentSessionSummary {
  return {
    sessionId,
    title,
    createdAt: 1,
    admittedAt: 1,
    updatedAt: 1,
    phase: 'completed',
    runtimeReady: true,
    runtimeState: 'ready',
    capabilities: { canSend: true, canCancel: false },
  };
}

function page(
  data: ManagedArtifact[],
  hasMore = false,
  nextCursor: string | null = null,
) {
  return {
    data: data.map((item) => ({
      artifact: item,
      access: { can_read_content: item.availability === 'available' },
    })),
    hasMore,
    nextCursor,
  };
}

describe('ManagedArtifactLibraryPage', () => {
  let root: Root;
  let container: HTMLDivElement;
  let library: ManagedWorkspaceArtifactReader;
  let reader: ManagedToolResultReader;
  let close: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    close = vi.fn();
    library = {
      listArtifacts: vi.fn().mockResolvedValue(page([artifact, other])),
    };
    reader = {
      canDownload: true,
      getResult: vi.fn(),
      getArtifact: vi
        .fn()
        .mockImplementation(async (sessionId: string, artifactId: string) => ({
          artifact: artifactId === artifact.id ? artifact : other,
          access: { can_read_content: artifactId === artifact.id },
        })),
      listArtifacts: vi.fn(),
      readRange: vi
        .fn()
        .mockImplementation(async (_artifact, offset: number, length: number) =>
          new TextEncoder().encode('hello').slice(offset, offset + length),
        ),
      downloadArtifact: vi.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };

  async function render(
    sessions: ManagedAgentSessionSummary[] = [session('session-1', 'Task one')],
  ) {
    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <ManagedArtifactLibraryPage
            library={library}
            reader={reader}
            workspaceId="ws-1"
            workspaceLabel="Project"
            clientId="client"
            sessions={sessions}
            onClose={close}
          />
        </I18nProvider>,
      );
      await flush();
    });
  }

  async function click(label: string) {
    const button = [...document.body.querySelectorAll('button')].find(
      (node) => node.textContent === label,
    );
    expect(button).toBeTruthy();
    await act(async () => {
      button!.click();
      await flush();
    });
  }

  function row(id: string) {
    return [...document.body.querySelectorAll('button[aria-pressed]')].find(
      (node) => node.textContent?.includes(id === artifact.id ? '5 B' : '6 B'),
    )!;
  }

  it('lists workspace rows with session titles, fallback labels and availability', async () => {
    await render();
    expect(library.listArtifacts).toHaveBeenCalledWith('ws-1', {
      clientId: 'client',
      signal: expect.any(AbortSignal),
      limit: 50,
    });
    expect(document.body.textContent).toContain('Artifact library · Project');
    expect(row(artifact.id).textContent).toContain('stdout · 5 B');
    expect(row(artifact.id).textContent).toContain('Task one');
    expect(row(artifact.id).textContent).not.toContain('Unavailable');
    expect(row(other.id).textContent).toContain('stdout · 6 B');
    const fallback = [...row(other.id).querySelectorAll('span')].find((node) =>
      node.textContent?.startsWith('Session '),
    );
    expect(fallback?.textContent).toBe('Session session-');
    expect(row(other.id).textContent).toContain('Unavailable');
    expect(reader.getArtifact).toHaveBeenCalledWith(
      'session-1',
      'artifact-1',
      expect.objectContaining({ clientId: 'client' }),
    );
  });

  it('previews the selected row through the session-scoped reader', async () => {
    await render();
    vi.mocked(reader.readRange).mockClear();
    await act(async () => {
      row(other.id).click();
      await flush();
    });
    expect(reader.getArtifact).toHaveBeenCalledWith(
      'session-unknown',
      'artifact-2',
      expect.objectContaining({ clientId: 'client' }),
    );
    expect(document.body.textContent).toContain(
      'Original output is not available to your account.',
    );
    expect(reader.readRange).not.toHaveBeenCalled();
  });

  it('appends cursor pages without dropping earlier rows', async () => {
    vi.mocked(library.listArtifacts)
      .mockResolvedValueOnce(page([artifact], true, 'page-2'))
      .mockResolvedValueOnce(page([other]));
    await render();
    await click('Load more');
    expect(library.listArtifacts).toHaveBeenNthCalledWith(
      2,
      'ws-1',
      expect.objectContaining({ cursor: 'page-2', limit: 50 }),
    );
    expect(row(artifact.id).textContent).toContain('stdout · 5 B');
    expect(row(other.id).textContent).toContain('stdout · 6 B');
    expect(document.body.querySelectorAll('button[aria-pressed]')).toHaveLength(
      2,
    );
    expect(
      [...document.body.querySelectorAll('button')].some(
        (node) => node.textContent === 'Load more',
      ),
    ).toBe(false);
  });

  it('deduplicates rows repeated across cursor pages', async () => {
    vi.mocked(library.listArtifacts)
      .mockResolvedValueOnce(page([artifact], true, 'page-2'))
      .mockResolvedValueOnce(page([artifact, other]));
    await render();
    await click('Load more');
    expect(document.body.querySelectorAll('button[aria-pressed]')).toHaveLength(
      2,
    );
  });

  it('keeps earlier rows and re-enables Load more when a cursor page fails', async () => {
    let rejectPage: (reason: unknown) => void = () => {};
    vi.mocked(library.listArtifacts)
      .mockResolvedValueOnce(page([artifact], true, 'page-2'))
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectPage = reject;
          }),
      );
    await render();
    const loadMore = () =>
      [...document.body.querySelectorAll('button')].find(
        (node) => node.textContent === 'Load more',
      )!;
    await act(async () => {
      loadMore().click();
      await flush();
    });
    expect(loadMore().disabled).toBe(true);
    await act(async () => {
      rejectPage(new Error('page boom'));
      await flush();
    });
    expect(document.body.textContent).toContain(
      'Could not load the artifact library:',
    );
    expect(document.body.textContent).toContain('page boom');
    expect(loadMore().disabled).toBe(false);
    expect(row(artifact.id).textContent).toContain('stdout · 5 B');
  });

  it('shows the empty state for a workspace without artifacts', async () => {
    vi.mocked(library.listArtifacts).mockResolvedValue(page([]));
    await render();
    expect(document.body.textContent).toContain(
      'No artifacts have been produced in this workspace yet.',
    );
  });

  it('answers a revoked workspace grant with the workspace-gone message', async () => {
    vi.mocked(library.listArtifacts).mockRejectedValue(
      new JavaManagedAgentHttpError(404, 'workspace_not_found', 'gone'),
    );
    await render();
    expect(document.body.textContent).toContain(
      'This workspace is no longer available to your account.',
    );
    expect(document.body.textContent).not.toContain(
      'The artifact library is not available on this server.',
    );
    expect(document.body.textContent).not.toContain(
      'No artifacts have been produced',
    );
  });

  it('answers the deployment gate 404 with the unavailable message', async () => {
    vi.mocked(library.listArtifacts).mockRejectedValue(
      new JavaManagedAgentHttpError(404, 'artifact_not_found', 'off'),
    );
    await render();
    expect(document.body.textContent).toContain(
      'The artifact library is not available on this server.',
    );
    expect(document.body.textContent).not.toContain(
      'This workspace is no longer available to your account.',
    );
    expect(document.body.textContent).not.toContain(
      'No artifacts have been produced',
    );
  });

  it('surfaces other failures with their message', async () => {
    vi.mocked(library.listArtifacts).mockRejectedValue(new Error('boom'));
    await render();
    expect(document.body.textContent).toContain(
      'Could not load the artifact library:',
    );
    expect(document.body.textContent).toContain('boom');
  });

  it('refreshes the page and closes on demand', async () => {
    await render();
    await click('Refresh');
    expect(library.listArtifacts).toHaveBeenCalledTimes(2);
    await click('Close');
    expect(close).toHaveBeenCalledOnce();
  });
});
