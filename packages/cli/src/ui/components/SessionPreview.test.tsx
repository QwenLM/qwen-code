/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */
import { render } from 'ink-testing-library';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KeypressProvider } from '../contexts/KeypressContext.js';
import { SessionPreview } from './SessionPreview.js';

beforeEach(() => {
  Object.defineProperty(process.stdout, 'columns', {
    value: 80,
    configurable: true,
  });
  Object.defineProperty(process.stdout, 'rows', {
    value: 24,
    configurable: true,
  });
});

afterEach(() => vi.clearAllMocks());

const wait = (ms = 50) => new Promise((r) => setTimeout(r, ms));

function mockService(resolved: unknown) {
  return {
    loadSession: vi
      .fn()
      .mockReturnValue(
        resolved instanceof Promise ? resolved : Promise.resolve(resolved),
      ),
    listSessions: vi.fn(),
    loadLastSession: vi.fn(),
  } as never;
}

function fakeResumedData() {
  return {
    conversation: {
      sessionId: 's1',
      projectHash: 'h',
      startTime: '2026-01-01T00:00:00.000Z',
      lastUpdated: '2026-01-01T00:00:00.000Z',
      messages: [
        {
          uuid: 'u1',
          parentUuid: null,
          sessionId: 's1',
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'user',
          cwd: '/tmp',
          version: 'test',
          message: {
            role: 'user',
            parts: [{ text: 'Hello world PREVIEW-MARKER' }],
          },
        },
        {
          uuid: 'u2',
          parentUuid: 'u1',
          sessionId: 's1',
          timestamp: '2026-01-01T00:00:01.000Z',
          type: 'assistant',
          cwd: '/tmp',
          version: 'test',
          message: {
            role: 'model',
            parts: [{ text: 'Hi from assistant REPLY-MARKER' }],
          },
        },
      ],
    },
    filePath: '/tmp/s1.jsonl',
    lastCompletedUuid: 'u2',
  };
}

describe('SessionPreview', () => {
  it('shows loading state before data arrives', () => {
    const svc = mockService(new Promise(() => {})); // never resolves
    const { lastFrame } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <SessionPreview
          sessionService={svc}
          sessionId="s1"
          sessionTitle="My session"
          onExit={vi.fn()}
          onResume={vi.fn()}
        />
      </KeypressProvider>,
    );
    expect(lastFrame()).toContain('Loading session preview');
  });

  it('renders all messages after load', async () => {
    const svc = mockService(fakeResumedData());
    const { lastFrame } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <SessionPreview
          sessionService={svc}
          sessionId="s1"
          sessionTitle="My session"
          onExit={vi.fn()}
          onResume={vi.fn()}
        />
      </KeypressProvider>,
    );
    await wait(100);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('PREVIEW-MARKER');
    expect(frame).toContain('REPLY-MARKER');
  });

  it('renders footer metadata (messageCount · time · branch)', async () => {
    const svc = mockService(fakeResumedData());
    const { lastFrame } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <SessionPreview
          sessionService={svc}
          sessionId="s1"
          sessionTitle="My session"
          messageCount={42}
          mtime={Date.now() - 60_000}
          gitBranch="feat/preview"
          onExit={vi.fn()}
          onResume={vi.fn()}
        />
      </KeypressProvider>,
    );
    await wait(100);
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/42\s*messages/);
    expect(frame).toContain('feat/preview');
  });

  it('falls back to count from loaded conversation when messageCount prop is absent', async () => {
    // listSessions() now omits messageCount, so the picker passes undefined
    // through to SessionPreview. The footer must still show a count, derived
    // from the loaded ResumedSessionData using unique user/assistant UUIDs.
    const svc = mockService(fakeResumedData());
    const { lastFrame } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <SessionPreview
          sessionService={svc}
          sessionId="s1"
          sessionTitle="My session"
          onExit={vi.fn()}
          onResume={vi.fn()}
        />
      </KeypressProvider>,
    );
    await wait(100);
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/2\s*messages/);
    expect(frame).not.toContain('undefined');
  });

  it('calls onExit when Escape is pressed', async () => {
    const onExit = vi.fn();
    const svc = mockService(fakeResumedData());
    const { stdin } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <SessionPreview
          sessionService={svc}
          sessionId="s1"
          sessionTitle="My session"
          onExit={onExit}
          onResume={vi.fn()}
        />
      </KeypressProvider>,
    );
    await wait(100);
    stdin.write('\u001B'); // ESC
    await wait(50);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('calls onResume(sessionId) when Enter is pressed', async () => {
    const onResume = vi.fn();
    const svc = mockService(fakeResumedData());
    const { stdin } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <SessionPreview
          sessionService={svc}
          sessionId="s1"
          sessionTitle="My session"
          onExit={vi.fn()}
          onResume={onResume}
        />
      </KeypressProvider>,
    );
    await wait(100);
    stdin.write('\r'); // Enter
    await wait(50);
    expect(onResume).toHaveBeenCalledWith('s1');
  });
});
