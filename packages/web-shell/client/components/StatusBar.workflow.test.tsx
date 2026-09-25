// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonSessionWorkflowTaskStatus } from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../i18n';

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useConnection: () => ({
    status: 'connected',
    currentMode: 'default',
    currentModel: 'qwen',
    tokenCount: 0,
    contextWindow: 0,
  }),
}));

const { StatusBar } = await import('./StatusBar');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function workflowTask(
  status: 'pausing' | 'paused',
): DaemonSessionWorkflowTaskStatus {
  return {
    kind: 'workflow',
    id: 'workflow-1',
    label: 'review-and-fix',
    description: 'Review and fix',
    status,
    startTime: 1_000,
    runtimeMs: 500,
    isBackgrounded: true,
    currentPhase: 'Review',
    phaseVisits: [],
    dispatches: [],
    agentsDispatched: 2,
    agentsCompleted: 1,
    tokensSpent: 100,
    tokenBudgetTotal: null,
    recentLogs: [],
    pendingApprovalCount: 0,
  };
}

describe('StatusBar workflow task pill', () => {
  it.each(['pausing', 'paused'] as const)(
    'keeps a %s workflow visible as active work',
    (status) => {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      act(() => {
        root?.render(
          <I18nProvider language="en">
            <StatusBar
              onSelectMode={() => {}}
              onSelectModel={() => {}}
              onShowContext={() => {}}
              onOpenSettings={() => {}}
              onOpenTasks={() => {}}
              tasks={[workflowTask(status)]}
            />
          </I18nProvider>,
        );
      });

      expect(container.textContent).toContain('1 workflow');
      expect(container.textContent).not.toContain('1 task done');
    },
  );
});
