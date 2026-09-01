// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonSessionArtifact } from '@qwen-code/sdk/daemon';
import type { WebShellSessionArtifactsChange } from '../customization';
import { useSessionArtifactsChange } from './useSessionArtifactsChange';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const sdkMock = vi.hoisted(() => ({
  ownerVersion: 0,
  artifactsVersion: 0,
  ownerGuard: { capture: vi.fn() },
}));

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useDaemonSessionOwnerGuard: () => sdkMock.ownerGuard,
  useWorkspaceEventSignals: () => ({
    artifactsVersion: sdkMock.artifactsVersion,
  }),
}));

interface HostProps {
  sessionId?: string;
  reconciling: boolean;
  ready: boolean;
  hydrated: boolean;
  artifacts: readonly DaemonSessionArtifact[];
  artifactsByTurn: ReadonlyMap<string, readonly DaemonSessionArtifact[]>;
  onChange?: (change: WebShellSessionArtifactsChange) => void;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function artifact(
  id: string,
  overrides: Partial<DaemonSessionArtifact> = {},
): DaemonSessionArtifact {
  return {
    id,
    kind: 'html',
    storage: 'workspace',
    source: 'tool',
    status: 'available',
    title: id,
    workspacePath: `${id}.html`,
    clientRetained: false,
    createdAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    ...overrides,
  };
}

function Host(props: HostProps) {
  useSessionArtifactsChange({ ...props });
  return null;
}

async function render(props: HostProps) {
  if (!root) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  }
  await act(async () => {
    root?.render(<Host {...props} />);
  });
}

function props(
  onChange: (change: WebShellSessionArtifactsChange) => void,
  overrides: Partial<HostProps> = {},
): HostProps {
  return {
    sessionId: 'session-a',
    reconciling: false,
    ready: true,
    hydrated: true,
    artifacts: [],
    artifactsByTurn: new Map(),
    onChange,
    ...overrides,
  };
}

beforeEach(() => {
  sdkMock.ownerVersion = 0;
  sdkMock.artifactsVersion = 0;
  sdkMock.ownerGuard.capture.mockImplementation(() => {
    const version = sdkMock.ownerVersion;
    return { isCurrent: () => sdkMock.ownerVersion === version };
  });
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

describe('useSessionArtifactsChange', () => {
  it('delivers empty and historical initial snapshots as restore', async () => {
    const onChange = vi.fn();
    await render(props(onChange));
    expect(onChange).toHaveBeenLastCalledWith({
      reason: 'restore',
      sessionId: 'session-a',
      sequence: 1,
      artifacts: [],
      artifactsByTurn: new Map(),
    });

    const historical = artifact('historical', { toolCallId: 'tool-old' });
    sdkMock.ownerVersion += 1;
    await render(
      props(onChange, {
        sessionId: 'session-b',
        artifacts: [historical],
        artifactsByTurn: new Map(),
      }),
    );
    expect(onChange).toHaveBeenLastCalledWith({
      reason: 'restore',
      sessionId: 'session-b',
      sequence: 1,
      artifacts: [historical],
      artifactsByTurn: new Map(),
    });
  });

  it('keeps a new tool Artifact pending until its turn projection appears', async () => {
    const onChange = vi.fn();
    await render(props(onChange));
    const generated = artifact('generated', { toolCallId: 'tool-1' });

    sdkMock.artifactsVersion = 1;
    await render(
      props(onChange, {
        artifacts: [generated],
      }),
    );
    expect(onChange).toHaveBeenCalledTimes(1);

    await render(
      props(onChange, {
        artifacts: [generated],
        artifactsByTurn: new Map([['turn-1', [generated]]]),
      }),
    );
    expect(onChange).toHaveBeenLastCalledWith({
      reason: 'change',
      sessionId: 'session-a',
      sequence: 2,
      artifacts: [generated],
      artifactsByTurn: new Map([['turn-1', [generated]]]),
    });
  });

  it('reports complete snapshots for metadata, projection, and consecutive changes', async () => {
    const onChange = vi.fn();
    await render(props(onChange));
    const first = artifact('first');
    sdkMock.artifactsVersion = 1;
    await render(
      props(onChange, {
        artifacts: [first],
      }),
    );
    const updated = artifact('first', {
      title: 'Updated',
      metadata: { z: 1, nested: { b: 2, a: 1 } },
      updatedAt: '2026-09-02T00:01:00.000Z',
    });
    sdkMock.artifactsVersion = 2;
    await render(
      props(onChange, {
        artifacts: [updated],
      }),
    );
    const second = artifact('second');
    sdkMock.artifactsVersion = 3;
    await render(
      props(onChange, {
        artifacts: [updated, second],
      }),
    );
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        reason: 'change',
        sequence: 4,
        artifacts: [updated, second],
      }),
    );

    sdkMock.artifactsVersion = 4;
    await render(
      props(onChange, {
        artifacts: [
          {
            ...updated,
            metadata: { nested: { a: 1, b: 2 }, z: 1 },
          },
          second,
        ],
      }),
    );
    expect(onChange).toHaveBeenCalledTimes(4);

    await render(
      props(onChange, {
        artifacts: [updated, second],
        artifactsByTurn: new Map([['turn-2', [second]]]),
      }),
    );
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sequence: 5,
        artifactsByTurn: new Map([['turn-2', [second]]]),
      }),
    );
  });

  it('preserves the baseline through reconnect and reconciles only real changes', async () => {
    const onChange = vi.fn();
    const first = artifact('first');
    const beforeReconnect = [first];
    await render(
      props(onChange, {
        artifacts: beforeReconnect,
        artifactsByTurn: new Map(),
      }),
    );
    await render(
      props(onChange, {
        reconciling: true,
        ready: false,
        artifacts: beforeReconnect,
      }),
    );
    sdkMock.artifactsVersion = 1;
    await render(props(onChange, { artifacts: beforeReconnect }));
    await render(props(onChange, { ready: false, artifacts: beforeReconnect }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const missed = artifact('missed', { toolCallId: 'trimmed-tool' });
    await render(
      props(onChange, {
        artifacts: [first, missed],
      }),
    );
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        reason: 'change',
        sequence: 2,
        artifacts: [first, missed],
      }),
    );
  });

  it('isolates a throwing listener and advances to later snapshots', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onChange = vi
      .fn<(change: WebShellSessionArtifactsChange) => void>()
      .mockImplementationOnce(() => {
        throw new Error('host failed');
      });
    await render(props(onChange));
    sdkMock.artifactsVersion = 1;
    await render(
      props(onChange, {
        artifacts: [artifact('later')],
      }),
    );
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange.mock.calls[1]?.[0].sequence).toBe(2);
    expect(error).toHaveBeenCalledOnce();
  });
});
