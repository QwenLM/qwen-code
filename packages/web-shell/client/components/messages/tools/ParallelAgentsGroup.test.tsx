// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../../i18n';
import type { ACPToolCall, PermissionRequest } from '../../../adapters/types';
import { SubagentDetailsProvider } from '../../../subagentDetailsContext';

const { ParallelAgentsGroup } = await import('./ParallelAgentsGroup');

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function agent(partial: Partial<ACPToolCall>): ACPToolCall {
  return {
    callId: 'a1',
    toolName: 'Task',
    status: 'completed',
    ...partial,
  } as ACPToolCall;
}

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

// Render the group and expand it (it starts collapsed) so the activity rows
// are in the DOM.
function renderExpandedGroup(agents: ACPToolCall[]): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider language="en">
        <ParallelAgentsGroup agents={agents} />
      </I18nProvider>,
    );
  });
  mounted.push({ root, container });
  const summary = container.querySelector('[aria-expanded]') as HTMLElement;
  act(() => summary.click());
  return container;
}

function renderManagedGroup(
  agents: ACPToolCall[],
  options: {
    autoManageExpansion?: boolean;
    automaticCollapseDelayMs?: number;
    deferAutomaticCollapse?: boolean;
    expandActiveWhenLive?: boolean;
    onAutomaticExpansionChange?: (expanded: boolean) => void;
    pendingApproval?: PermissionRequest | null;
    strictMode?: boolean;
  } = {},
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (nextAgents: ACPToolCall[], nextOptions = options) => {
    act(() => {
      const group = (
        <I18nProvider language="en">
          <ParallelAgentsGroup
            agents={nextAgents}
            autoManageExpansion={nextOptions.autoManageExpansion}
            automaticCollapseDelayMs={nextOptions.automaticCollapseDelayMs}
            deferAutomaticCollapse={nextOptions.deferAutomaticCollapse}
            expandActiveWhenLive={nextOptions.expandActiveWhenLive}
            onAutomaticExpansionChange={nextOptions.onAutomaticExpansionChange}
            pendingApproval={nextOptions.pendingApproval}
          />
        </I18nProvider>
      );
      root.render(
        nextOptions.strictMode ? <StrictMode>{group}</StrictMode> : group,
      );
    });
  };
  render(agents);
  mounted.push({ root, container });
  return { container, render };
}

function groupSummary(container: HTMLElement): HTMLButtonElement {
  return container.querySelector('[aria-expanded]') as HTMLButtonElement;
}

describe('ParallelAgentsGroup activity rendering', () => {
  it('renders stable active, completed, and failed activity rows without a timeline', () => {
    const container = renderExpandedGroup([
      agent({ callId: 'active', status: 'pending' }),
      agent({ callId: 'done', status: 'completed' }),
      agent({ callId: 'failed', status: 'failed' }),
    ]);

    expect(
      Array.from(container.querySelectorAll('[data-agent-status]')).map((row) =>
        row.getAttribute('data-agent-status'),
      ),
    ).toEqual(['active', 'completed', 'failed']);
    expect(container.querySelector('[class*="track"]')).toBeNull();
    expect(container.querySelector('[class*="ruler"]')).toBeNull();
  });

  it('keeps the task and current tool in separate stable fields', () => {
    const container = renderExpandedGroup([
      agent({
        callId: 'active',
        status: 'in_progress',
        args: { description: 'Inspect the message list' },
        subTools: [
          {
            callId: 'read',
            toolName: 'Read',
            status: 'in_progress',
            args: { file_path: 'src/MessageList.tsx' },
          },
        ],
      }),
    ]);

    expect(container.querySelector('[class*="rowTask"]')?.textContent).toBe(
      'Inspect the message list',
    );
    expect(
      container.querySelector('[class*="rowTool"]')?.textContent,
    ).toContain('MessageList.tsx');
  });

  it('auto-expands active agents and collapses 1.5s after completion', () => {
    vi.useFakeTimers();
    try {
      const onAutomaticExpansionChange = vi.fn();
      const active = [
        agent({ callId: 'a1', status: 'pending' }),
        agent({ callId: 'a2', status: 'in_progress' }),
      ];
      const { container, render } = renderManagedGroup(active, {
        autoManageExpansion: true,
        onAutomaticExpansionChange,
      });

      expect(onAutomaticExpansionChange).toHaveBeenLastCalledWith(true);
      expect(groupSummary(container).getAttribute('aria-expanded')).toBe(
        'true',
      );
      render(active.map((item) => ({ ...item, status: 'completed' as const })));
      act(() => vi.advanceTimersByTime(1_499));
      expect(groupSummary(container).getAttribute('aria-expanded')).toBe(
        'true',
      );
      act(() => vi.advanceTimersByTime(1));
      expect(groupSummary(container).getAttribute('aria-expanded')).toBe(
        'false',
      );
      expect(onAutomaticExpansionChange).toHaveBeenLastCalledWith(true);
      act(() => vi.advanceTimersByTime(180));
      expect(onAutomaticExpansionChange).toHaveBeenLastCalledWith(false);

      // A second wave into the same group re-expands it and re-pins the turn.
      render([
        ...active.map((item) => ({ ...item, status: 'completed' as const })),
        agent({ callId: 'a3', status: 'pending' }),
      ]);
      expect(groupSummary(container).getAttribute('aria-expanded')).toBe(
        'true',
      );
      expect(onAutomaticExpansionChange).toHaveBeenLastCalledWith(true);

      // The second wave's completion runs the release half of the cycle again.
      render([
        ...active.map((item) => ({ ...item, status: 'completed' as const })),
        agent({ callId: 'a3', status: 'completed' }),
      ]);
      act(() => vi.advanceTimersByTime(1_500));
      expect(groupSummary(container).getAttribute('aria-expanded')).toBe(
        'false',
      );
      act(() => vi.advanceTimersByTime(180));
      expect(onAutomaticExpansionChange).toHaveBeenLastCalledWith(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps automatically collapsed details mounted during their exit animation', () => {
    vi.useFakeTimers();
    try {
      const onAutomaticExpansionChange = vi.fn();
      const active = [
        agent({ callId: 'a1', status: 'pending' }),
        agent({ callId: 'a2', status: 'in_progress' }),
      ];
      const { container, render } = renderManagedGroup(active, {
        autoManageExpansion: true,
        automaticCollapseDelayMs: 400,
        onAutomaticExpansionChange,
      });

      render(active.map((item) => ({ ...item, status: 'completed' as const })));
      act(() => vi.advanceTimersByTime(400));

      expect(groupSummary(container).getAttribute('aria-expanded')).toBe(
        'false',
      );
      expect(
        container.querySelector('[data-agent-collapse-exit="true"]'),
      ).not.toBeNull();
      expect(
        container
          .querySelector('[data-agent-collapse-exit="true"]')
          ?.hasAttribute('inert'),
      ).toBe(true);
      expect(groupSummary(container).getAttribute('aria-disabled')).toBe(
        'true',
      );
      expect(container.querySelectorAll('[data-agent-status]')).toHaveLength(2);
      expect(onAutomaticExpansionChange).toHaveBeenLastCalledWith(true);

      act(() => vi.advanceTimersByTime(179));
      expect(
        container.querySelector('[data-agent-collapse-exit="true"]'),
      ).not.toBeNull();
      act(() => vi.advanceTimersByTime(1));
      expect(
        container.querySelector('[data-agent-collapse-exit="true"]'),
      ).toBeNull();
      expect(container.querySelectorAll('[data-agent-status]')).toHaveLength(0);
      expect(onAutomaticExpansionChange).toHaveBeenLastCalledWith(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips the exit animation when reduced motion is requested', () => {
    vi.useFakeTimers();
    const matchMedia = vi.spyOn(window, 'matchMedia').mockImplementation(
      (query) =>
        ({
          matches: query === '(prefers-reduced-motion: reduce)',
        }) as MediaQueryList,
    );
    try {
      const onAutomaticExpansionChange = vi.fn();
      const active = [
        agent({ callId: 'a1', status: 'pending' }),
        agent({ callId: 'a2', status: 'in_progress' }),
      ];
      const { container, render } = renderManagedGroup(active, {
        autoManageExpansion: true,
        automaticCollapseDelayMs: 400,
        onAutomaticExpansionChange,
      });

      render(active.map((item) => ({ ...item, status: 'completed' as const })));
      act(() => vi.advanceTimersByTime(400));

      expect(groupSummary(container).getAttribute('aria-expanded')).toBe(
        'false',
      );
      expect(
        container.querySelector('[data-agent-collapse-exit="true"]'),
      ).toBeNull();
      expect(onAutomaticExpansionChange).toHaveBeenLastCalledWith(false);
    } finally {
      matchMedia.mockRestore();
      vi.useRealTimers();
    }
  });

  it('cancels the exit animation when agent activity resumes', () => {
    vi.useFakeTimers();
    try {
      const onAutomaticExpansionChange = vi.fn();
      const active = [
        agent({ callId: 'a1', status: 'pending' }),
        agent({ callId: 'a2', status: 'in_progress' }),
      ];
      const completed = active.map((item) => ({
        ...item,
        status: 'completed' as const,
      }));
      const { container, render } = renderManagedGroup(active, {
        autoManageExpansion: true,
        automaticCollapseDelayMs: 400,
        onAutomaticExpansionChange,
      });

      render(completed);
      act(() => vi.advanceTimersByTime(400));
      expect(
        container.querySelector('[data-agent-collapse-exit="true"]'),
      ).not.toBeNull();

      render(active);
      expect(groupSummary(container).getAttribute('aria-expanded')).toBe(
        'true',
      );
      expect(
        container.querySelector('[data-agent-collapse-exit="true"]'),
      ).toBeNull();
      act(() => vi.advanceTimersByTime(180));
      expect(onAutomaticExpansionChange).toHaveBeenLastCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels the exit animation when a collapse deferral starts mid-animation', () => {
    vi.useFakeTimers();
    try {
      const onAutomaticExpansionChange = vi.fn();
      const active = [
        agent({ callId: 'a1', status: 'pending' }),
        agent({ callId: 'a2', status: 'pending' }),
      ];
      const completed = active.map((item) => ({
        ...item,
        status: 'completed' as const,
      }));
      const { container, render } = renderManagedGroup(active, {
        autoManageExpansion: true,
        automaticCollapseDelayMs: 400,
        onAutomaticExpansionChange,
      });

      render(completed, {
        autoManageExpansion: true,
        automaticCollapseDelayMs: 400,
        onAutomaticExpansionChange,
      });
      act(() => vi.advanceTimersByTime(400));
      expect(
        container.querySelector('[data-agent-collapse-exit="true"]'),
      ).not.toBeNull();

      render(completed, {
        autoManageExpansion: true,
        automaticCollapseDelayMs: 400,
        deferAutomaticCollapse: true,
        onAutomaticExpansionChange,
      });
      expect(groupSummary(container).getAttribute('aria-expanded')).toBe(
        'true',
      );
      expect(
        container.querySelector('[data-agent-collapse-exit="true"]'),
      ).toBeNull();
      act(() => vi.advanceTimersByTime(180));
      expect(onAutomaticExpansionChange).toHaveBeenLastCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels the exit animation when auto-management is disabled mid-animation', () => {
    vi.useFakeTimers();
    try {
      const onAutomaticExpansionChange = vi.fn();
      const active = [
        agent({ callId: 'a1', status: 'pending' }),
        agent({ callId: 'a2', status: 'pending' }),
      ];
      const completed = active.map((item) => ({
        ...item,
        status: 'completed' as const,
      }));
      const { container, render } = renderManagedGroup(active, {
        autoManageExpansion: true,
        automaticCollapseDelayMs: 400,
        onAutomaticExpansionChange,
      });

      render(completed, {
        autoManageExpansion: true,
        automaticCollapseDelayMs: 400,
        onAutomaticExpansionChange,
      });
      act(() => vi.advanceTimersByTime(400));
      expect(
        container.querySelector('[data-agent-collapse-exit="true"]'),
      ).not.toBeNull();

      render(completed, {
        autoManageExpansion: false,
        automaticCollapseDelayMs: 400,
        onAutomaticExpansionChange,
      });
      expect(groupSummary(container).getAttribute('aria-expanded')).toBe(
        'true',
      );
      expect(
        container.querySelector('[data-agent-collapse-exit="true"]'),
      ).toBeNull();
      act(() => vi.advanceTimersByTime(180));
      expect(onAutomaticExpansionChange).toHaveBeenLastCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('restarts a pending automatic collapse when its delay changes', () => {
    vi.useFakeTimers();
    try {
      const active = [
        agent({ callId: 'a1', status: 'pending' }),
        agent({ callId: 'a2', status: 'pending' }),
      ];
      const completed = active.map((item) => ({
        ...item,
        status: 'completed' as const,
      }));
      const { container, render } = renderManagedGroup(active, {
        autoManageExpansion: true,
      });

      render(completed, { autoManageExpansion: true });
      act(() => vi.advanceTimersByTime(500));
      render(completed, {
        autoManageExpansion: true,
        automaticCollapseDelayMs: 400,
      });
      act(() => vi.advanceTimersByTime(399));
      expect(groupSummary(container).getAttribute('aria-expanded')).toBe(
        'true',
      );
      act(() => vi.advanceTimersByTime(1));
      expect(groupSummary(container).getAttribute('aria-expanded')).toBe(
        'false',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels the pending collapse timer when agent activity resumes', () => {
    vi.useFakeTimers();
    try {
      const active = [agent({ callId: 'a1', status: 'pending' })];
      const completed = active.map((item) => ({
        ...item,
        status: 'completed' as const,
      }));
      const { container, render } = renderManagedGroup(active, {
        autoManageExpansion: true,
        automaticCollapseDelayMs: 400,
      });

      render(completed);
      act(() => vi.advanceTimersByTime(300));
      // A second wave starts inside the pending collapse window...
      render([...completed, agent({ callId: 'a2', status: 'pending' })]);
      render([...completed, agent({ callId: 'a2', status: 'completed' })]);
      // ...so the stale timer from the first completion must not fire.
      act(() => vi.advanceTimersByTime(100));
      expect(groupSummary(container).getAttribute('aria-expanded')).toBe(
        'true',
      );
      act(() => vi.advanceTimersByTime(300));
      expect(groupSummary(container).getAttribute('aria-expanded')).toBe(
        'false',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not restart a collapse whose exit animation has begun', () => {
    vi.useFakeTimers();
    try {
      const onAutomaticExpansionChange = vi.fn();
      const active = [
        agent({ callId: 'a1', status: 'pending' }),
        agent({ callId: 'a2', status: 'pending' }),
      ];
      const completed = active.map((item) => ({
        ...item,
        status: 'completed' as const,
      }));
      const { container, render } = renderManagedGroup(active, {
        autoManageExpansion: true,
        automaticCollapseDelayMs: 400,
        onAutomaticExpansionChange,
      });

      render(completed, {
        autoManageExpansion: true,
        automaticCollapseDelayMs: 400,
        onAutomaticExpansionChange,
      });
      act(() => vi.advanceTimersByTime(400));
      render(completed, {
        autoManageExpansion: true,
        automaticCollapseDelayMs: 1_500,
        onAutomaticExpansionChange,
      });

      expect(groupSummary(container).getAttribute('aria-expanded')).toBe(
        'false',
      );
      expect(
        container.querySelector('[data-agent-collapse-exit="true"]'),
      ).not.toBeNull();
      act(() => vi.advanceTimersByTime(180));
      expect(
        container.querySelector('[data-agent-collapse-exit="true"]'),
      ).toBeNull();
      expect(onAutomaticExpansionChange).toHaveBeenLastCalledWith(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps automatic expansion registered through StrictMode replay', () => {
    const onAutomaticExpansionChange = vi.fn();
    const { container } = renderManagedGroup(
      [
        agent({ callId: 'a1', status: 'pending' }),
        agent({ callId: 'a2', status: 'pending' }),
      ],
      {
        autoManageExpansion: true,
        onAutomaticExpansionChange,
        strictMode: true,
      },
    );

    expect(groupSummary(container).getAttribute('aria-expanded')).toBe('true');
    expect(onAutomaticExpansionChange).toHaveBeenLastCalledWith(true);
  });

  it('releases automatic expansion when the group unmounts', () => {
    const onAutomaticExpansionChange = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <ParallelAgentsGroup
            agents={[agent({ callId: 'a1', status: 'pending' })]}
            autoManageExpansion
            onAutomaticExpansionChange={onAutomaticExpansionChange}
          />
        </I18nProvider>,
      );
    });

    expect(onAutomaticExpansionChange).toHaveBeenLastCalledWith(true);
    act(() => root.unmount());
    container.remove();
    expect(onAutomaticExpansionChange).toHaveBeenLastCalledWith(false);
  });

  it('stops auto-managing expansion after the user toggles the summary', () => {
    vi.useFakeTimers();
    try {
      const active = [
        agent({ callId: 'a1', status: 'pending' }),
        agent({ callId: 'a2', status: 'pending' }),
      ];
      const onAutomaticExpansionChange = vi.fn();
      const { container, render } = renderManagedGroup(active, {
        autoManageExpansion: true,
        onAutomaticExpansionChange,
      });

      const emissionsAfterMount = onAutomaticExpansionChange.mock.calls.length;
      act(() => groupSummary(container).click());
      expect(onAutomaticExpansionChange).toHaveBeenLastCalledWith(false);
      expect(onAutomaticExpansionChange).toHaveBeenCalledTimes(
        emissionsAfterMount + 1,
      );
      expect(groupSummary(container).getAttribute('aria-expanded')).toBe(
        'false',
      );
      render(active.map((item) => ({ ...item, status: 'completed' as const })));
      render(active);
      expect(groupSummary(container).getAttribute('aria-expanded')).toBe(
        'false',
      );
      act(() => groupSummary(container).click());
      expect(onAutomaticExpansionChange).toHaveBeenCalledTimes(
        emissionsAfterMount + 1,
      );
      render(active.map((item) => ({ ...item, status: 'completed' as const })));
      act(() => vi.advanceTimersByTime(1_500));
      expect(groupSummary(container).getAttribute('aria-expanded')).toBe(
        'true',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not latch manual ownership for clicks made while auto-management is disabled', () => {
    vi.useFakeTimers();
    try {
      const active = [
        agent({ callId: 'a1', status: 'pending' }),
        agent({ callId: 'a2', status: 'pending' }),
      ];
      const onAutomaticExpansionChange = vi.fn();
      const { container, render } = renderManagedGroup(active, {
        autoManageExpansion: false,
        onAutomaticExpansionChange,
      });

      act(() => groupSummary(container).click());
      expect(groupSummary(container).getAttribute('aria-expanded')).toBe(
        'true',
      );
      expect(onAutomaticExpansionChange).not.toHaveBeenCalled();

      // Catch-up ends: live auto-management takes over despite the click.
      render(active, {
        autoManageExpansion: true,
        expandActiveWhenLive: true,
        onAutomaticExpansionChange,
      });
      expect(onAutomaticExpansionChange).toHaveBeenLastCalledWith(true);

      render(
        active.map((item) => ({ ...item, status: 'completed' as const })),
        {
          autoManageExpansion: true,
          expandActiveWhenLive: true,
          onAutomaticExpansionChange,
        },
      );
      act(() => vi.advanceTimersByTime(1_500));
      expect(groupSummary(container).getAttribute('aria-expanded')).toBe(
        'false',
      );
      act(() => vi.advanceTimersByTime(180));
      expect(onAutomaticExpansionChange).toHaveBeenLastCalledWith(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips the exit sequence when the user collapsed the group while auto-management was disabled', () => {
    vi.useFakeTimers();
    try {
      const active = [
        agent({ callId: 'a1', status: 'pending' }),
        agent({ callId: 'a2', status: 'pending' }),
      ];
      const completed = active.map((item) => ({
        ...item,
        status: 'completed' as const,
      }));
      const onAutomaticExpansionChange = vi.fn();
      const { container, render } = renderManagedGroup(active, {
        autoManageExpansion: true,
        onAutomaticExpansionChange,
      });
      expect(groupSummary(container).getAttribute('aria-expanded')).toBe(
        'true',
      );

      // Catch-up suspends auto-management; the user collapses the group.
      render(active, {
        autoManageExpansion: false,
        onAutomaticExpansionChange,
      });
      act(() => groupSummary(container).click());
      expect(groupSummary(container).getAttribute('aria-expanded')).toBe(
        'false',
      );

      render(completed, {
        autoManageExpansion: false,
        onAutomaticExpansionChange,
      });
      render(completed, {
        autoManageExpansion: true,
        onAutomaticExpansionChange,
      });
      act(() => vi.advanceTimersByTime(1_500));

      // Finalizing ownership must not remount the viewport in its closing
      // state or disable the summary button.
      expect(groupSummary(container).getAttribute('aria-expanded')).toBe(
        'false',
      );
      expect(groupSummary(container).hasAttribute('aria-disabled')).toBe(false);
      expect(
        container.querySelector('[data-agent-collapse-exit="true"]'),
      ).toBeNull();
      expect(container.querySelectorAll('[data-agent-status]')).toHaveLength(0);

      act(() => vi.advanceTimersByTime(180));
      expect(groupSummary(container).getAttribute('aria-expanded')).toBe(
        'false',
      );
      expect(groupSummary(container).hasAttribute('aria-disabled')).toBe(false);
      expect(onAutomaticExpansionChange).toHaveBeenLastCalledWith(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats active agents seen while auto-management is disabled as baseline', () => {
    const active = [
      agent({ callId: 'a1', status: 'pending' }),
      agent({ callId: 'a2', status: 'pending' }),
    ];
    const { container, render } = renderManagedGroup(active, {
      autoManageExpansion: false,
    });

    expect(groupSummary(container).getAttribute('aria-expanded')).toBe('false');
    render(active, { autoManageExpansion: true });
    expect(groupSummary(container).getAttribute('aria-expanded')).toBe('false');
    render(
      active.map((item) => ({ ...item, status: 'completed' as const })),
      { autoManageExpansion: true },
    );
    render(active, { autoManageExpansion: true });
    expect(groupSummary(container).getAttribute('aria-expanded')).toBe('true');
  });

  it('expands an active group when it becomes live after auto-management is enabled', () => {
    const active = [
      agent({ callId: 'a1', status: 'pending' }),
      agent({ callId: 'a2', status: 'pending' }),
    ];
    const { container, render } = renderManagedGroup(active, {
      autoManageExpansion: false,
      expandActiveWhenLive: false,
    });

    expect(groupSummary(container).getAttribute('aria-expanded')).toBe('false');
    render(active, {
      autoManageExpansion: true,
      expandActiveWhenLive: false,
    });
    expect(groupSummary(container).getAttribute('aria-expanded')).toBe('false');
    render(active, {
      autoManageExpansion: true,
      expandActiveWhenLive: true,
    });
    expect(groupSummary(container).getAttribute('aria-expanded')).toBe('true');
  });

  it('resumes automatic collapse after auto-management is re-enabled', () => {
    vi.useFakeTimers();
    try {
      const active = [
        agent({ callId: 'a1', status: 'pending' }),
        agent({ callId: 'a2', status: 'pending' }),
      ];
      const completed = active.map((item) => ({
        ...item,
        status: 'completed' as const,
      }));
      const { container, render } = renderManagedGroup(active, {
        autoManageExpansion: true,
      });

      render(active, { autoManageExpansion: false });
      render(completed, { autoManageExpansion: false });
      act(() => vi.advanceTimersByTime(1_500));
      expect(groupSummary(container).getAttribute('aria-expanded')).toBe(
        'true',
      );
      render(completed, { autoManageExpansion: true });
      act(() => vi.advanceTimersByTime(1_499));
      expect(groupSummary(container).getAttribute('aria-expanded')).toBe(
        'true',
      );
      act(() => vi.advanceTimersByTime(1));
      expect(groupSummary(container).getAttribute('aria-expanded')).toBe(
        'false',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('resumes automatic collapse when a collapse deferral lifts', () => {
    vi.useFakeTimers();
    try {
      const active = [
        agent({ callId: 'a1', status: 'pending' }),
        agent({ callId: 'a2', status: 'in_progress' }),
      ];
      const completed = active.map((item) => ({
        ...item,
        status: 'completed' as const,
      }));
      const { container, render } = renderManagedGroup(active, {
        autoManageExpansion: true,
        deferAutomaticCollapse: true,
      });

      render(completed, {
        autoManageExpansion: true,
        deferAutomaticCollapse: true,
      });
      act(() => vi.advanceTimersByTime(3_000));
      expect(groupSummary(container).getAttribute('aria-expanded')).toBe(
        'true',
      );

      render(completed, {
        autoManageExpansion: true,
        deferAutomaticCollapse: false,
      });
      act(() => vi.advanceTimersByTime(1_499));
      expect(groupSummary(container).getAttribute('aria-expanded')).toBe(
        'true',
      );
      act(() => vi.advanceTimersByTime(1));
      expect(groupSummary(container).getAttribute('aria-expanded')).toBe(
        'false',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('defers automatic collapse while the group approval stays pending', () => {
    vi.useFakeTimers();
    try {
      const active = [
        agent({ callId: 'a1', status: 'pending' }),
        agent({ callId: 'a2', status: 'pending' }),
      ];
      const approval: PermissionRequest = {
        id: 'approval',
        toolCallId: 'a1',
        content: [],
        options: [],
      };
      const onAutomaticExpansionChange = vi.fn();
      const { container, render } = renderManagedGroup(active, {
        autoManageExpansion: true,
        pendingApproval: approval,
        onAutomaticExpansionChange,
      });
      const completed = active.map((item) => ({
        ...item,
        status: 'completed' as const,
      }));

      render(completed, {
        autoManageExpansion: true,
        pendingApproval: approval,
        onAutomaticExpansionChange,
      });
      // The collapse keeps retrying while the approval holds the group open;
      // while the approval is pending, nothing may drop the panel without its
      // exit animation.
      act(() => vi.advanceTimersByTime(4_500));
      expect(groupSummary(container).getAttribute('aria-expanded')).toBe(
        'true',
      );
      expect(
        container.querySelector('[data-agent-collapse-exit="true"]'),
      ).toBeNull();
      expect(onAutomaticExpansionChange).toHaveBeenLastCalledWith(true);

      render(completed, {
        autoManageExpansion: true,
        pendingApproval: null,
        onAutomaticExpansionChange,
      });
      act(() => vi.advanceTimersByTime(1_499));
      expect(groupSummary(container).getAttribute('aria-expanded')).toBe(
        'true',
      );
      act(() => vi.advanceTimersByTime(1));
      expect(groupSummary(container).getAttribute('aria-expanded')).toBe(
        'false',
      );
      expect(
        container.querySelector('[data-agent-collapse-exit="true"]'),
      ).not.toBeNull();
      act(() => vi.advanceTimersByTime(180));
      expect(onAutomaticExpansionChange).toHaveBeenLastCalledWith(false);
      expect(
        container.querySelector('[data-agent-collapse-exit="true"]'),
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a pending automatic collapse when a deferral is re-asserted', () => {
    vi.useFakeTimers();
    try {
      const active = [
        agent({ callId: 'a1', status: 'pending' }),
        agent({ callId: 'a2', status: 'in_progress' }),
      ];
      const completed = active.map((item) => ({
        ...item,
        status: 'completed' as const,
      }));
      const { container, render } = renderManagedGroup(active, {
        autoManageExpansion: true,
      });

      render(completed, { autoManageExpansion: true });
      render(completed, {
        autoManageExpansion: true,
        deferAutomaticCollapse: true,
      });
      act(() => vi.advanceTimersByTime(3_000));
      expect(groupSummary(container).getAttribute('aria-expanded')).toBe(
        'true',
      );
      expect(
        container.querySelector('[data-agent-collapse-exit="true"]'),
      ).toBeNull();

      render(completed, {
        autoManageExpansion: true,
        deferAutomaticCollapse: false,
      });
      act(() => vi.advanceTimersByTime(1_499));
      expect(groupSummary(container).getAttribute('aria-expanded')).toBe(
        'true',
      );
      act(() => vi.advanceTimersByTime(1));
      expect(groupSummary(container).getAttribute('aria-expanded')).toBe(
        'false',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('reveals a pending approval that arrives during the exit animation', () => {
    vi.useFakeTimers();
    try {
      const active = [
        agent({ callId: 'a1', status: 'pending' }),
        agent({ callId: 'a2', status: 'pending' }),
      ];
      const completed = active.map((item) => ({
        ...item,
        status: 'completed' as const,
      }));
      const approval: PermissionRequest = {
        id: 'approval',
        toolCallId: 'a1',
        content: [],
        options: [],
      };
      const onAutomaticExpansionChange = vi.fn();
      const { container, render } = renderManagedGroup(active, {
        autoManageExpansion: true,
        automaticCollapseDelayMs: 400,
        onAutomaticExpansionChange,
      });

      render(completed, {
        autoManageExpansion: true,
        automaticCollapseDelayMs: 400,
        onAutomaticExpansionChange,
      });
      act(() => vi.advanceTimersByTime(400));
      expect(
        container.querySelector('[data-agent-collapse-exit="true"]'),
      ).not.toBeNull();

      render(completed, {
        autoManageExpansion: true,
        automaticCollapseDelayMs: 400,
        pendingApproval: approval,
        onAutomaticExpansionChange,
      });
      const viewport = container.querySelector('[class*="groupViewport"]');
      expect(groupSummary(container).getAttribute('aria-expanded')).toBe(
        'true',
      );
      expect(groupSummary(container).hasAttribute('aria-disabled')).toBe(false);
      expect(
        container.querySelector('[data-agent-collapse-exit="true"]'),
      ).toBeNull();
      expect(viewport?.hasAttribute('aria-hidden')).toBe(false);
      expect(viewport?.hasAttribute('inert')).toBe(false);
      expect(onAutomaticExpansionChange).toHaveBeenLastCalledWith(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('removes the panel outright when the approval that interrupted the exit resolves', () => {
    vi.useFakeTimers();
    try {
      const active = [
        agent({ callId: 'a1', status: 'pending' }),
        agent({ callId: 'a2', status: 'pending' }),
      ];
      const completed = active.map((item) => ({
        ...item,
        status: 'completed' as const,
      }));
      const approval: PermissionRequest = {
        id: 'approval',
        toolCallId: 'a1',
        content: [],
        options: [],
      };
      const onAutomaticExpansionChange = vi.fn();
      const { container, render } = renderManagedGroup(active, {
        autoManageExpansion: true,
        automaticCollapseDelayMs: 400,
        onAutomaticExpansionChange,
      });

      render(completed, {
        autoManageExpansion: true,
        automaticCollapseDelayMs: 400,
        onAutomaticExpansionChange,
      });
      act(() => vi.advanceTimersByTime(400));
      expect(
        container.querySelector('[data-agent-collapse-exit="true"]'),
      ).not.toBeNull();

      render(completed, {
        autoManageExpansion: true,
        automaticCollapseDelayMs: 400,
        pendingApproval: approval,
        onAutomaticExpansionChange,
      });
      expect(onAutomaticExpansionChange).toHaveBeenLastCalledWith(false);

      // The takeover handed visibility to the approval and already released
      // automatic expansion, so resolving it drops the panel without an exit
      // animation — there is no automatic expansion left to animate out.
      render(completed, {
        autoManageExpansion: true,
        automaticCollapseDelayMs: 400,
        pendingApproval: null,
        onAutomaticExpansionChange,
      });
      expect(groupSummary(container).getAttribute('aria-expanded')).toBe(
        'false',
      );
      expect(container.querySelectorAll('[data-agent-status]')).toHaveLength(0);
      expect(
        container.querySelector('[data-agent-collapse-exit="true"]'),
      ).toBeNull();
      expect(onAutomaticExpansionChange).toHaveBeenLastCalledWith(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('hands focus to the summary when the automatic exit starts under a focused row', () => {
    vi.useFakeTimers();
    try {
      const active = [
        agent({ callId: 'a1', status: 'pending' }),
        agent({ callId: 'a2', status: 'in_progress' }),
      ];
      const { container, render } = renderManagedGroup(active, {
        autoManageExpansion: true,
        automaticCollapseDelayMs: 400,
      });

      const row = container.querySelector(
        '[data-agent-status="active"]',
      ) as HTMLButtonElement;
      row.focus();
      expect(document.activeElement).toBe(row);

      render(active.map((item) => ({ ...item, status: 'completed' as const })));
      act(() => vi.advanceTimersByTime(400));

      expect(document.activeElement).toBe(groupSummary(container));
      expect(groupSummary(container).getAttribute('aria-expanded')).toBe(
        'false',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows live progress while background agents are pending', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    try {
      const agents = [
        agent({ callId: 'done', startTime: 1_000, endTime: 5_000 }),
        agent({
          callId: 'pending-early',
          status: 'pending',
          startTime: 2_000,
        }),
        agent({
          callId: 'pending-late',
          status: 'pending',
          startTime: 4_000,
        }),
      ];
      const container = renderExpandedGroup(agents);

      // The header clock anchors at the earliest ACTIVE agent's start (2s),
      // not the latest (4s) nor mount time.
      expect(container.textContent).toContain('Parallel agents 8s·1/3 done');
      expect(
        container.querySelectorAll('[data-agent-status="active"]'),
      ).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the header clock monotonic when the earliest agent finishes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(150_000);
    try {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      const early = agent({
        callId: 'early',
        status: 'pending',
        startTime: 0,
      });
      const late = agent({
        callId: 'late',
        status: 'pending',
        startTime: 100_000,
      });
      act(() => {
        root.render(
          <I18nProvider language="en">
            <ParallelAgentsGroup agents={[early, late]} />
          </I18nProvider>,
        );
      });
      mounted.push({ root, container });
      // A live tick surfaces the anchored elapsed time.
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(container.textContent).toContain(
        'Parallel agents 2m 31s·0/2 done',
      );

      act(() => {
        root.render(
          <I18nProvider language="en">
            <ParallelAgentsGroup
              agents={[
                { ...early, status: 'completed', endTime: 151_000 },
                late,
              ]}
            />
          </I18nProvider>,
        );
      });
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      // The earliest agent finishing must not rewind the header clock to the
      // later sibling's start time.
      expect(container.textContent).toContain(
        'Parallel agents 2m 32s·1/2 done',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-anchors the header clock when a second wave of agents starts', () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    try {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      const first = agent({
        callId: 'first',
        status: 'pending',
        startTime: 10_000,
      });
      const second = agent({
        callId: 'second',
        status: 'pending',
        startTime: 15_000,
      });
      act(() => {
        root.render(
          <I18nProvider language="en">
            <ParallelAgentsGroup agents={[first, second]} />
          </I18nProvider>,
        );
      });
      mounted.push({ root, container });
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(container.textContent).toContain('Parallel agents 11s·0/2 done');

      // The first wave finishes entirely and the live clock disappears.
      const finished = [
        { ...first, status: 'completed' as const, endTime: 21_000 },
        { ...second, status: 'completed' as const, endTime: 21_500 },
      ];
      act(() => {
        root.render(
          <I18nProvider language="en">
            <ParallelAgentsGroup agents={finished} />
          </I18nProvider>,
        );
      });
      expect(container.textContent).toContain('Parallel agents·2/2 done');

      // A second wave starts much later: the clock must re-anchor to the new
      // agent's start, not keep accumulating from the first wave's anchor.
      vi.setSystemTime(60_000);
      act(() => {
        root.render(
          <I18nProvider language="en">
            <ParallelAgentsGroup
              agents={[
                ...finished,
                agent({
                  callId: 'third',
                  status: 'pending',
                  startTime: 55_000,
                }),
              ]}
            />
          </I18nProvider>,
        );
      });
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(container.textContent).toContain('Parallel agents 6s·2/3 done');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps nested agents inspectable without a details provider', () => {
    const container = renderExpandedGroup([
      agent({ callId: 'nested', subContent: 'nested agent output' }),
    ]);
    const row = container.querySelector('[class*="row"]') as HTMLButtonElement;

    expect(container.textContent).not.toContain('nested agent output');
    expect(row.getAttribute('aria-expanded')).toBe('false');
    act(() => row.click());
    expect(container.textContent).toContain('nested agent output');
    expect(row.getAttribute('aria-expanded')).toBe('true');
  });

  it('opens nested agents through the details provider when available', () => {
    const onOpen = vi.fn();
    const nested = agent({ callId: 'nested' });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <SubagentDetailsProvider onOpen={onOpen}>
            <ParallelAgentsGroup agents={[nested]} />
          </SubagentDetailsProvider>
        </I18nProvider>,
      );
    });
    mounted.push({ root, container });
    act(() =>
      (container.querySelector('[aria-expanded]') as HTMLElement).click(),
    );
    const row = container.querySelector('[class*="row"]') as HTMLElement;
    expect(row.hasAttribute('aria-expanded')).toBe(false);
    act(() => row.click());

    expect(onOpen).toHaveBeenCalledWith(nested);
  });
});
