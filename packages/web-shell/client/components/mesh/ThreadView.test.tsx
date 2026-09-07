// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ThreadView, type ThreadDetailView } from './ThreadView';
import { ThreadsPage } from './ThreadsPage';
import type {
  RoutingPreviewTarget,
  ThreadSummaryView,
} from './mesh-view-logic';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: Array<{ container: HTMLElement; root: Root }> = [];

function render(node: React.ReactNode): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  act(() => root.render(node));
  return container;
}

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

function thread(overrides: Partial<ThreadDetailView> = {}): ThreadDetailView {
  return {
    id: 'th_4f2',
    title: 'Investigate the flake',
    body: 'The web-shell smoke test is flaky.',
    status: 'blocked',
    reason: 'run rn_7 asked a question and is waiting for a person',
    posts: [
      {
        id: 'ms_1',
        sequence: 3,
        authorKind: 'human',
        authorName: 'you',
        text: 'Find out why.',
        at: 1_700_000_000_000,
      },
      {
        id: 'ms_2',
        sequence: 4,
        authorKind: 'system',
        authorName: 'assigned alice',
        text: 'Assigned to @alice.',
        at: 1_700_000_060_000,
      },
    ],
    runs: [
      {
        id: 'rn_7',
        agentId: 'ag_alice',
        agentName: 'alice',
        status: 'completed',
        closeKind: 'blocked',
        closeAcknowledged: false,
        trigger: 'assigned by you',
        endedAt: 20,
        hasTranscriptSlice: true,
      },
      {
        id: 'rn_9',
        agentId: 'ag_bob',
        agentName: 'bob',
        status: 'running',
        closeAcknowledged: false,
        trigger: 'mentioned by alice',
        startedAt: 30,
        hasTranscriptSlice: true,
      },
      {
        id: 'rn_2',
        agentId: 'ag_alice',
        agentName: 'alice',
        status: 'completed',
        closeKind: 'review',
        closeAcknowledged: true,
        trigger: 'assigned by you',
        endedAt: 5,
        hasTranscriptSlice: true,
      },
    ],
    budget: {
      turnsUsed: 4,
      turnLimit: 12,
      tokensUsed: 31_200,
      tokenLimit: 200_000,
    },
    ...overrides,
  };
}

function view(overrides: Partial<Parameters<typeof ThreadView>[0]> = {}) {
  return render(
    <ThreadView
      thread={thread()}
      draft=""
      onDraftChange={vi.fn()}
      onReply={vi.fn()}
      onBack={vi.fn()}
      onOpenTranscript={vi.fn()}
      {...overrides}
    />,
  );
}

describe('ThreadView', () => {
  it("shows the server's sentence, not a status word of its own", () => {
    const container = view();

    expect(container.textContent).toContain(
      'run rn_7 asked a question and is waiting for a person',
    );
    // No second status vocabulary anywhere on the page.
    expect(container.textContent).not.toContain('blocked');
  });

  it('puts the live signal in the header, naming the agent that is working', () => {
    const header = view().querySelector('header');
    expect(header?.textContent).toContain('bob working');
  });

  it('pins live runs and hides finished ones behind their count', () => {
    const container = view();
    const sidebar = container.querySelector('aside')!;

    expect(sidebar.textContent).toContain('bob');
    expect(sidebar.textContent).toContain('working');
    expect(sidebar.textContent).toContain('Show past runs (2)');
    // A finished run is evidence, not a task, so it is not on screen yet.
    expect(sidebar.textContent).not.toContain('submitted for review');

    const toggle = [...sidebar.querySelectorAll('button')].find((button) =>
      button.textContent?.startsWith('Show past runs'),
    )!;
    act(() => toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(sidebar.textContent).toContain('asked a question');
    expect(sidebar.textContent).toContain('submitted for review');
  });

  it('says why each run exists, because that is what a reader asks first', () => {
    const sidebar = view().querySelector('aside')!;
    expect(sidebar.textContent).toContain('mentioned by alice');
  });

  it('states the budget as lines and says the tree shares it', () => {
    const sidebar = view().querySelector('aside')!;

    expect(sidebar.textContent).toContain('4 of 12 unattended turns');
    expect(sidebar.textContent).toContain('31.2k of 200.0k tokens');
    expect(sidebar.textContent).toContain('across this thread tree');
    // A limit to notice, not a goal to fill.
    expect(sidebar.querySelector('progress')).toBeNull();
  });

  it('renders a system trigger as a ledger entry with no body', () => {
    const container = view();
    expect(container.textContent).toContain('assigned alice');
    expect(container.textContent).not.toContain('Assigned to @alice.');
  });

  it('previews who a draft will wake, and names the fix for who it will not', () => {
    const preview: RoutingPreviewTarget[] = [
      { agentName: 'bob', willWake: true },
      { agentName: 'carol', willWake: false, reason: 'queue_full' },
      {
        agentName: 'dave',
        willWake: false,
        reason: 'agent_unknown',
        unknown: true,
      },
    ];
    const container = view({ draft: 'have another look', preview });

    expect(container.textContent).toContain('bob will start working.');
    expect(container.textContent).toContain('already has a full backlog');
    expect(container.textContent).toContain('no agent named "dave"');
    expect(container.textContent).toContain('Check the spelling');
  });

  it('makes "nobody will be woken" the loudest thing on a reply that reaches no one', () => {
    const container = view({
      draft: 'anyone?',
      preview: [
        {
          agentName: 'dave',
          willWake: false,
          reason: 'agent_unknown',
          unknown: true,
        },
      ],
    });
    expect(container.textContent).toContain(
      'Nobody will be woken by this reply.',
    );
  });

  it('keeps the reply button inert until there is something to post', () => {
    const idle = view().querySelector('button[type="button"]');
    expect(idle).not.toBeNull();
    const send = [...view().querySelectorAll('button')].find(
      (button) => button.textContent === 'Post reply',
    )!;
    expect(send.hasAttribute('disabled')).toBe(true);
  });
});

describe('ThreadsPage', () => {
  function summary(
    overrides: Partial<ThreadSummaryView> = {},
  ): ThreadSummaryView {
    return {
      id: 'th_1',
      title: 'Investigate the flake',
      status: 'in_progress',
      reason: '1 run still working',
      updatedAt: 1,
      liveRunCount: 1,
      ...overrides,
    };
  }

  it('leads with what needs a person and collapses finished work', () => {
    const container = render(
      <ThreadsPage
        threads={[
          summary({
            id: 'th_done',
            title: 'Old work',
            status: 'done',
            liveRunCount: 0,
          }),
          summary({
            id: 'th_block',
            title: 'Retry audit',
            status: 'blocked',
            liveRunCount: 0,
          }),
        ]}
        onOpenThread={vi.fn()}
      />,
    );
    const headings = [...container.querySelectorAll('section > button')].map(
      (button) => button.textContent,
    );

    expect(headings[0]).toContain('Needs you');
    expect(container.textContent).toContain('Retry audit');
    expect(container.textContent).not.toContain('Old work');
  });

  it('invites the first thread instead of showing an empty list', () => {
    const container = render(
      <ThreadsPage threads={[]} onOpenThread={vi.fn()} />,
    );
    expect(container.textContent).toContain('No threads yet.');
    expect(container.textContent).toContain('hand to an agent');
  });

  it('opens the thread that was clicked', () => {
    const onOpenThread = vi.fn();
    const container = render(
      <ThreadsPage threads={[summary()]} onOpenThread={onOpenThread} />,
    );
    const row = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Investigate the flake'),
    )!;
    act(() => row.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(onOpenThread).toHaveBeenCalledWith('th_1');
  });
});
