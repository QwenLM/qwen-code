// @vitest-environment jsdom
import { act, forwardRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../adapters/types';
import type { MessageListHandle, MessageListProps } from './MessageList';

const observed = vi.hoisted(() => ({
  navigation: undefined as unknown,
  railVisible: false,
  railFollow: undefined as { current: number } | undefined,
  rows: [] as Array<{
    id: string;
    key?: string;
    top: number;
    bottom: number;
  }>,
}));

vi.mock('../hooks/useMessageDeletion', () => ({
  useMessageDeletion: () => undefined,
}));
vi.mock('../hooks/useChatNavigationVisible', () => ({
  useChatNavigationVisible: () => observed.railVisible,
}));
vi.mock('../i18n', () => {
  const t = (key: string) => key;
  return { useI18n: () => ({ t }) };
});
vi.mock('../hooks/useTranscriptViewport', () => ({
  useTranscriptViewport: (messages: Message[]) => ({
    navigation: observed.navigation,
    messages,
    historical: false,
    loading: false,
    viewKey: 'live',
    toolSources: new Map(),
    pin: vi.fn(),
    returnToLive: vi.fn(),
    selectSearchHit: vi.fn(),
    continueLive: vi.fn(),
    cancelSelection: vi.fn(),
  }),
}));
vi.mock('./GlobalTurnNavigation', () => ({
  GlobalTurnNavigation: ({ follow }: { follow?: { current: number } }) => {
    observed.railFollow = follow;
    return null;
  },
}));
vi.mock('./MessageList', () => ({
  MessageList: forwardRef<MessageListHandle, MessageListProps>(function List() {
    return (
      <div data-web-shell-message-list data-top="0" data-bottom="300">
        {observed.rows.map((row) => (
          <div
            key={row.id}
            data-source-block-ids={row.id}
            data-message-row-key={row.key ?? `msg:${row.id}`}
            data-top={row.top}
            data-bottom={row.bottom}
          />
        ))}
      </div>
    );
  }),
}));

const { TranscriptViewport } = await import('./TranscriptViewport');

const message = (id: string): Message =>
  ({
    id,
    role:
      id.startsWith('prompt') || id.startsWith('mid') ? 'user' : 'assistant',
    content:
      id.startsWith('prompt') || id.startsWith('mid') ? `${id} text` : id,
    timestamp: 1,
    sourceBlockIds: [id],
  }) as Message;
const messages = [
  'prompt-0',
  'output-0a',
  'output-0b',
  'prompt-1',
  'mid-1',
  'output-1a',
  'output-1b',
].map(message);

function navigation(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'ready',
    totalTurns: 2,
    effectiveTurnCount: 2,
    indexPages: new Map([
      [
        0,
        {
          turns: [
            { ordinal: 0, turnId: 't0', label: 'First prompt' },
            { ordinal: 1, turnId: 't1', label: 'Second prompt' },
          ],
        },
      ],
    ]),
    locations: new Map([
      ['t0', { blockId: 'prompt-0' }],
      ['t1', { blockId: 'prompt-1' }],
    ]),
    provisionalTurns: [],
    ...overrides,
  };
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeEach(() => {
  observed.navigation = navigation();
  observed.railVisible = false;
  observed.railFollow = undefined;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      return {
        top: Number(this.dataset.top ?? 0),
        bottom: Number(this.dataset.bottom ?? 0),
      } as DOMRect;
    },
  );
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderViewport(props: Partial<MessageListProps> = {}, pinned = true) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <TranscriptViewport
        messages={messages}
        pendingApproval={null}
        pinnedPrompt={pinned}
        {...props}
      />,
    ),
  );
}
const pinnedText = () =>
  container!.querySelector('[data-pinned-turn-prompt]')?.textContent ??
  undefined;

describe('TranscriptViewport pinned prompt', () => {
  it('shows the last user message text when its row is above the viewport', () => {
    observed.rows = [
      { id: 'prompt-1', top: -50, bottom: -10 },
      { id: 'output-1a', top: -10, bottom: 300 },
    ];
    renderViewport();
    expect(pinnedText()).toBe('prompt-1 text');
    expect(
      container!.querySelector('[data-pinned-turn-prompt]')?.closest('header'),
    ).toBeNull();
    expect(container!.querySelector('[role="banner"]')).toBeNull();
    expect(
      container!
        .querySelector('[data-web-shell-message-list]')
        ?.querySelector('[data-pinned-turn-prompt]'),
    ).toBeNull();
  });

  it('keeps the label when the prompt row has left the virtualizer window', () => {
    observed.rows = [{ id: 'output-0b', top: -10, bottom: 300 }];
    renderViewport();
    expect(pinnedText()).toBe('First prompt');
  });

  it('renders nothing while the prompt row of the current turn is in view', () => {
    observed.rows = [
      { id: 'prompt-1', top: 10, bottom: 50 },
      { id: 'output-1a', top: 50, bottom: 300 },
    ];
    renderViewport();
    expect(pinnedText()).toBeUndefined();
  });

  it('does not take the collapse row of a turn for its prompt row', () => {
    observed.rows = [
      { id: 'prompt-1', top: -50, bottom: -10 },
      { id: 'prompt-1', key: 'tc:prompt-1', top: -10, bottom: 30 },
      { id: 'output-1b', top: 30, bottom: 300 },
    ];
    renderViewport();
    expect(pinnedText()).toBe('prompt-1 text');
  });

  it('labels the pill with the last user message above the reading line, not the turn prompt', () => {
    observed.rows = [
      { id: 'prompt-1', top: -90, bottom: -60 },
      { id: 'mid-1', top: -60, bottom: -20 },
      { id: 'output-1a', top: -20, bottom: 300 },
    ];
    renderViewport();
    expect(pinnedText()).toBe('mid-1 text');
  });

  it('hides the pill when the mid-turn user message row is in view', () => {
    observed.rows = [
      { id: 'prompt-1', top: -60, bottom: -30 },
      { id: 'mid-1', top: -30, bottom: 20 },
      { id: 'output-1a', top: 20, bottom: 300 },
    ];
    renderViewport();
    expect(pinnedText()).toBeUndefined();
  });

  it('keeps the earlier user message label when the later one is below the reading line', () => {
    observed.rows = [
      { id: 'prompt-1', top: -50, bottom: -10 },
      { id: 'mid-1', top: 200, bottom: 240 },
      { id: 'output-1a', top: 240, bottom: 300 },
    ];
    renderViewport();
    expect(pinnedText()).toBe('prompt-1 text');
  });

  it('follows the reading line, not the first visible row', () => {
    observed.rows = [
      { id: 'output-0b', top: -10, bottom: 200 },
      { id: 'prompt-1', top: 200, bottom: 240 },
      { id: 'output-1a', top: 240, bottom: 300 },
    ];
    renderViewport();
    expect(pinnedText()).toBe('First prompt');
  });

  it('agrees with the turn the rail highlights', () => {
    observed.railVisible = true;
    observed.navigation = navigation({ effectiveTurnCount: 4, totalTurns: 4 });
    observed.rows = [{ id: 'output-1a', top: -10, bottom: 300 }];
    renderViewport();
    expect(observed.railFollow?.current).toBe(1);
    expect(pinnedText()).toBe('Second prompt');
  });

  it('works without the rail in full-width mode and short sessions', () => {
    observed.rows = [{ id: 'output-1a', top: -10, bottom: 300 }];
    renderViewport({ hideSessionTimeline: true });
    expect(pinnedText()).toBe('Second prompt');
  });

  it('uses the provisional label for a turn the index does not have yet', () => {
    observed.navigation = navigation({
      effectiveTurnCount: 3,
      provisionalTurns: [
        {
          provisionalId: 'p',
          promptId: 'p',
          label: 'Live prompt',
          blockId: 'prompt-1',
        },
      ],
      locations: new Map([['t0', { blockId: 'prompt-0' }]]),
    });
    observed.rows = [{ id: 'output-1a', top: -10, bottom: 300 }];
    renderViewport();
    expect(pinnedText()).toBe('Live prompt');
  });

  it('renders nothing when the turn has no label', () => {
    observed.navigation = navigation({
      indexPages: new Map([
        [0, { turns: [{ ordinal: 0, turnId: 't0', label: '' }] }],
      ]),
      locations: new Map([['t0', { blockId: 'prompt-0' }]]),
    });
    observed.rows = [{ id: 'output-0a', top: -10, bottom: 300 }];
    renderViewport();
    expect(pinnedText()).toBeUndefined();
  });

  it('renders nothing without turn navigation or in panes that do not opt in', () => {
    observed.rows = [{ id: 'output-1a', top: -10, bottom: 300 }];
    observed.navigation = navigation({ mode: 'degraded' });
    renderViewport();
    expect(pinnedText()).toBeUndefined();
    act(() => root?.unmount());
    root = undefined;
    observed.navigation = navigation();
    renderViewport({ hideSessionTimeline: true }, false);
    expect(pinnedText()).toBeUndefined();
  });
});
