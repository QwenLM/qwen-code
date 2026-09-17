// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { DaemonHttpError } from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../i18n';
import { requestToast } from '../components/ToastHost';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectReportedArtifacts,
  useReportedArtifactRegistration,
} from './useReportedArtifactRegistration';
import type {
  DaemonSessionArtifactInput,
  DaemonSessionArtifact,
  DaemonTranscriptBlock,
} from '@qwen-code/sdk/daemon';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const sdk = vi.hoisted(() => ({
  owner: 0,
  registered: [] as DaemonSessionArtifact[],
  hydrated: true,
  blocks: [] as unknown[],
  addArtifact: vi.fn(),
  refresh: vi.fn(),
  guard: { capture: vi.fn() },
  connection: {
    status: 'connected',
    catchingUp: false,
    sessionId: 'session-a',
    capabilities: { features: ['session_artifacts'] },
  },
}));

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useActions: () => ({ addArtifact: sdk.addArtifact }),
  useConnection: () => sdk.connection,
  useDaemonSessionOwnerGuard: () => sdk.guard,
}));

vi.mock('./useAnimationFrameTranscriptBlocks', () => ({
  useAnimationFrameTranscriptSnapshot: () => ({ blocks: sdk.blocks }),
}));

vi.mock('../components/ToastHost', () => ({ requestToast: vi.fn() }));

const exportedArtifact: DaemonSessionArtifactInput = {
  kind: 'file',
  storage: 'workspace',
  title: 'qwen-code-export-2026-01-01T00-00-00-000Z.md',
  workspacePath: 'qwen-code-export-2026-01-01T00-00-00-000Z.md',
  mimeType: 'text/markdown; charset=utf-8',
  sizeBytes: 42,
};

function transcriptBlock(
  kind: DaemonTranscriptBlock['kind'],
  reported: unknown,
): DaemonTranscriptBlock {
  return {
    id: `block-${kind}`,
    kind,
    text: 'Session exported to markdown',
    clientReceivedAt: 1,
    createdAt: 1,
    updatedAt: 1,
    meta: { source: 'slash_command', sessionArtifacts: reported },
  } as unknown as DaemonTranscriptBlock;
}

let root: Root;
let container: HTMLDivElement;

function Host() {
  useReportedArtifactRegistration(sdk.registered, sdk.hydrated, sdk.refresh);
  return null;
}

async function render() {
  await act(async () => {
    root.render(
      <I18nProvider language="en">
        <Host />
      </I18nProvider>,
    );
  });
}

beforeEach(() => {
  sdk.owner = 0;
  sdk.registered = [];
  sdk.hydrated = true;
  sdk.blocks = [];
  sdk.connection.capabilities.features = ['session_artifacts'];
  sdk.connection.status = 'connected';
  sdk.connection.catchingUp = false;
  sdk.connection.sessionId = 'session-a';
  sdk.guard.capture.mockImplementation(() => {
    const owner = sdk.owner;
    return { isCurrent: () => owner === sdk.owner };
  });
  sdk.refresh.mockReset().mockResolvedValue(undefined);
  vi.mocked(requestToast).mockClear();
  sdk.addArtifact.mockReset();
  sdk.addArtifact.mockImplementation(async () => ({}));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('collectReportedArtifacts', () => {
  it('reads the descriptors an assistant block reports', () => {
    expect(
      collectReportedArtifacts([
        transcriptBlock('assistant', [exportedArtifact]),
      ]),
    ).toEqual([exportedArtifact]);
  });

  it('ignores blocks that cannot carry message metadata', () => {
    // Only text blocks keep raw `_meta`; a tool block reporting the same key
    // must not be read as if it were the command result.
    expect(
      collectReportedArtifacts([transcriptBlock('tool', [exportedArtifact])]),
    ).toEqual([]);
  });

  it('drops entries the store would reject instead of failing the batch', () => {
    const reported = [
      exportedArtifact,
      { title: 'no locator' },
      { ...exportedArtifact, workspacePath: undefined },
      {
        ...exportedArtifact,
        workspacePath: 'a.md',
        url: 'https://example.com/a.md',
      },
      // Exactly one locator, so only the reserved storage kind can reject it.
      {
        ...exportedArtifact,
        storage: 'published',
        workspacePath: undefined,
        url: 'https://example.com/a.html',
      },
      { ...exportedArtifact, title: undefined },
      'not an object',
    ];

    expect(
      collectReportedArtifacts([transcriptBlock('assistant', reported)]),
    ).toEqual([exportedArtifact]);
  });

  it('ignores model-authored metadata and non-workspace locators', () => {
    const block = transcriptBlock('assistant', [exportedArtifact]);
    expect(
      collectReportedArtifacts([
        {
          ...block,
          meta: { sessionArtifacts: [exportedArtifact] },
        } as DaemonTranscriptBlock,
      ]),
    ).toEqual([]);
    expect(
      collectReportedArtifacts([
        transcriptBlock('assistant', [
          {
            ...exportedArtifact,
            storage: 'external_url',
            workspacePath: undefined,
            url: 'https://example.com/a.html',
          },
          { ...exportedArtifact, workspacePath: '../secret.html' },
        ]),
      ]),
    ).toEqual([]);
  });

  it('accepts POSIX directory names containing a literal backslash', () => {
    const artifact = {
      ...exportedArtifact,
      workspacePath: 'reports\\archive/export.md',
    };
    expect(
      collectReportedArtifacts([transcriptBlock('assistant', [artifact])]),
    ).toEqual([artifact]);
  });

  it.each([
    '../secret.md',
    '..\\secret.md',
    'reports/..\\secret.md',
    '/secret.md',
    '\\\\server\\share\\secret.md',
    'C:\\secret.md',
    'C:secret.md',
  ])('rejects absolute paths and traversal: %s', (workspacePath) => {
    expect(
      collectReportedArtifacts([
        transcriptBlock('assistant', [{ ...exportedArtifact, workspacePath }]),
      ]),
    ).toEqual([]);
  });

  it('leaves a malformed payload alone rather than throwing', () => {
    expect(
      collectReportedArtifacts([transcriptBlock('assistant', 'nope')]),
    ).toEqual([]);
  });
});

describe('useReportedArtifactRegistration', () => {
  it('does not submit twice when StrictMode replays effects', async () => {
    sdk.blocks = [transcriptBlock('assistant', [exportedArtifact])];
    await act(async () =>
      root.render(
        <StrictMode>
          <Host />
        </StrictMode>,
      ),
    );
    expect(sdk.addArtifact).toHaveBeenCalledTimes(1);
  });

  it('refreshes the catalog after another client wins concurrent registration', async () => {
    sdk.blocks = [transcriptBlock('assistant', [exportedArtifact])];
    sdk.addArtifact
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(
        new DaemonHttpError(
          403,
          { code: 'session_artifact_forbidden' },
          'owned by another client',
        ),
      );
    sdk.refresh.mockResolvedValue([{ ...exportedArtifact, id: 'existing' }]);
    await act(async () =>
      root.render(
        <>
          <Host />
          <Host />
        </>,
      ),
    );
    expect(sdk.addArtifact).toHaveBeenCalledTimes(2);
    expect(sdk.refresh).toHaveBeenCalledTimes(1);
    expect(requestToast).not.toHaveBeenCalled();
  });

  it('treats a cross-client conflict as already registered, without a failure toast', async () => {
    // The daemon raises the upsert 403 only after resolving an existing
    // artifact for the path, so the outcome does not depend on whether the
    // resync comes back with the catalog.
    sdk.blocks = [transcriptBlock('assistant', [exportedArtifact])];
    sdk.addArtifact.mockRejectedValue(
      new DaemonHttpError(
        403,
        { code: 'session_artifact_forbidden' },
        'conflict',
      ),
    );
    sdk.refresh.mockResolvedValue(undefined);
    await render();
    expect(sdk.refresh).toHaveBeenCalledTimes(1);
    expect(requestToast).not.toHaveBeenCalled();
  });

  it('reports unrelated permission errors in the active language', async () => {
    sdk.blocks = [transcriptBlock('assistant', [exportedArtifact])];
    sdk.addArtifact.mockRejectedValue(
      new DaemonHttpError(
        403,
        { code: 'workspace_untrusted', error: 'Access denied' },
        'Forbidden',
      ),
    );
    await act(async () =>
      root.render(
        <I18nProvider language="zh-CN">
          <Host />
        </I18nProvider>,
      ),
    );
    expect(sdk.refresh).not.toHaveBeenCalled();
    expect(requestToast).toHaveBeenCalledWith(
      'error',
      '无法添加导出文件：Access denied',
    );
  });

  it('ignores a conflict refresh completed after leaving the session', async () => {
    sdk.blocks = [transcriptBlock('assistant', [exportedArtifact])];
    sdk.addArtifact.mockRejectedValue(
      new DaemonHttpError(
        403,
        { code: 'session_artifact_forbidden' },
        'conflict',
      ),
    );
    let complete!: (value: undefined) => void;
    sdk.refresh.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    await render();
    sdk.owner++;
    await act(async () => complete(undefined));
    expect(requestToast).not.toHaveBeenCalled();
  });

  it('registers every reported file exactly once', async () => {
    sdk.blocks = [transcriptBlock('assistant', [exportedArtifact])];
    await render();

    expect(sdk.addArtifact).toHaveBeenCalledTimes(1);
    expect(sdk.addArtifact).toHaveBeenCalledWith(exportedArtifact);

    // The transcript hands back a fresh array on every daemon event, so the
    // effect re-runs; the same file must not be registered again.
    sdk.blocks = [transcriptBlock('assistant', [exportedArtifact])];
    await render();

    expect(sdk.addArtifact).toHaveBeenCalledTimes(1);
  });

  it('registers again for a file first seen in another session', async () => {
    sdk.blocks = [transcriptBlock('assistant', [exportedArtifact])];
    await render();
    sdk.connection.sessionId = 'session-b';
    await render();

    expect(sdk.addArtifact).toHaveBeenCalledTimes(2);
  });

  it('waits for the catalog and skips files already registered by another client', async () => {
    sdk.blocks = [transcriptBlock('assistant', [exportedArtifact])];
    sdk.hydrated = false;
    await render();
    expect(sdk.addArtifact).not.toHaveBeenCalled();
    sdk.registered = [
      {
        ...exportedArtifact,
        id: 'existing',
        clientId: 'another-client',
      } as DaemonSessionArtifact,
    ];
    sdk.hydrated = true;
    await render();
    expect(sdk.addArtifact).not.toHaveBeenCalled();
  });

  it('retries a failed registration after reconnecting', async () => {
    sdk.addArtifact.mockRejectedValueOnce(new Error('offline'));
    sdk.blocks = [transcriptBlock('assistant', [exportedArtifact])];
    await render();
    sdk.connection.status = 'disconnected';
    await render();
    sdk.connection.status = 'connected';
    await render();
    expect(sdk.addArtifact).toHaveBeenCalledTimes(2);
    expect(requestToast).toHaveBeenCalledWith(
      'error',
      'Could not add exported artifact: offline',
    );
  });

  it('stays out of the way without the artifact capability', async () => {
    sdk.connection.capabilities.features = [];
    sdk.blocks = [transcriptBlock('assistant', [exportedArtifact])];
    await render();

    expect(sdk.addArtifact).not.toHaveBeenCalled();
  });

  it('waits for the transcript catch-up to finish', async () => {
    sdk.connection.catchingUp = true;
    sdk.blocks = [transcriptBlock('assistant', [exportedArtifact])];
    await render();

    expect(sdk.addArtifact).not.toHaveBeenCalled();
  });

  it('does not register against a session the client has left', async () => {
    sdk.blocks = [transcriptBlock('assistant', [exportedArtifact])];
    sdk.guard.capture.mockImplementation(() => ({
      isCurrent: () => false,
    }));
    await render();

    expect(sdk.addArtifact).not.toHaveBeenCalled();
  });
});
