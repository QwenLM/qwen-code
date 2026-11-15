// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ManagedAgentProvider } from './managed/managed-agent-provider';

const bridge = vi.hoisted(() => ({
  status: { phase: 'idle', blocker: null } as { phase: string; blocker: null },
  connect: vi.fn(async () => {}),
  disconnect: vi.fn(async () => {}),
}));

vi.mock('../local-files/useManagedLocalFilesBridge', () => ({
  useManagedLocalFilesBridge: () => bridge,
}));
vi.mock('../i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

import { ManagedLocalFilesControl } from './ManagedLocalFilesControl';

function provider(withClientFiles: boolean): ManagedAgentProvider {
  return {
    storageKey: 'test',
    clientFiles: withClientFiles
      ? {
          transport: () => ({
            baseUrl: 'http://test/api/agent/web-shell/v1',
            fetch: async () => new Response('{}', { status: 200 }),
          }),
        }
      : undefined,
  } as unknown as ManagedAgentProvider;
}

describe('ManagedLocalFilesControl', () => {
  it('withholds the entry when the provider exposes no client files', () => {
    const { container } = render(
      <ManagedLocalFilesControl
        provider={provider(false)}
        sessionId="session-1"
        triggerClassName="trigger"
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the trigger when client files are available', () => {
    bridge.status = { phase: 'connected', blocker: null };
    render(
      <ManagedLocalFilesControl
        provider={provider(true)}
        sessionId="session-1"
        triggerClassName="trigger"
      />,
    );
    expect(screen.getByLabelText('localFiles.trigger')).toBeTruthy();
  });
});
