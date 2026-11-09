// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { ManagedChildSessionView } from './ManagedChildSessionView';
import { createJavaManagedAgentProvider } from './java-managed-agent-provider';
import {
  diagnosticResources,
  diagnosticTrace,
} from './managed-diagnostics.test-fixtures';

const state = vi.hoisted(() => ({
  summary: {
    sessionId: 's1',
    title: 'Child',
    phase: 'agent_running',
    activeTurnId: 'turn-1',
    compactionRevision: 1,
    workspace: { contextRevision: 1 },
    capabilities: { diagnostics: true },
  },
}));
vi.mock('./use-managed-session', () => ({
  useManagedSession: () => ({
    summary: state.summary,
    events: [],
    loading: false,
  }),
}));
vi.mock('../MessageList', () => ({ MessageList: () => null }));

describe('ManagedChildSessionView diagnostics', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it.each(['turn', 'context'])(
    'refreshes child resources after the %s revision changes',
    async (change) => {
      state.summary.activeTurnId = 'turn-1';
      state.summary.workspace.contextRevision = 1;
      const getResources = vi.fn().mockResolvedValue(diagnosticResources);
      const provider = {
        ...createJavaManagedAgentProvider({
          baseUrl: 'https://product.example',
          productScope: 'tenant:actor',
          fetch: vi.fn(),
        }),
        diagnostics: {
          getResources,
          listAgentTrace: vi.fn().mockResolvedValue(diagnosticTrace),
        },
      };
      const render = async () =>
        act(async () =>
          root.render(
            <I18nProvider language="en">
              <ManagedChildSessionView
                provider={provider}
                clientId="actor"
                sessionId="s1"
                onClose={vi.fn()}
                restoreFocus={vi.fn()}
              />
            </I18nProvider>,
          ),
        );
      await render();
      const trigger = [
        ...document.querySelectorAll<HTMLButtonElement>('button'),
      ].find((button) => button.textContent === 'Session diagnostics')!;
      await act(async () => trigger.click());
      expect(getResources).toHaveBeenCalledTimes(1);
      if (change === 'turn') state.summary.activeTurnId = 'turn-2';
      else state.summary.workspace.contextRevision = 2;
      await render();
      expect(getResources).toHaveBeenCalledTimes(2);
    },
  );
});
