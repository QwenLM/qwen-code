// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { ACPToolCall } from '../../../adapters/types';
import { I18nProvider } from '../../../i18n';
import { managedEventsToMessages } from '../../managed/managed-session-messages';
import {
  ToolDetailsContext,
  type ToolDetailsLoader,
} from './ToolDetailsContext';

vi.mock('../../../WebShellContexts', async () => {
  const { createContext } = await import('react');
  return {
    TodoTimelineContext: createContext(new Map()),
    TodoDetailContext: createContext(new Map()),
  };
});

const { ToolLine } = await import('../ToolGroup');
let root: Root | undefined;
let container: HTMLDivElement;
afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = undefined;
});

function render(children: ReactNode) {
  if (!root) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() =>
    root?.render(<I18nProvider language="en">{children}</I18nProvider>),
  );
}

function tool(overrides: Partial<ACPToolCall> = {}): ACPToolCall {
  return {
    callId: 'turn:item-1',
    toolName: 'read_file',
    status: 'failed',
    ...overrides,
  };
}

function deferred() {
  let resolve!: (value: Awaited<ReturnType<ToolDetailsLoader>>) => void;
  const promise = new Promise<Awaited<ReturnType<ToolDetailsLoader>>>(
    (done) => {
      resolve = done;
    },
  );
  return { promise, resolve };
}

it('loads the recorded ReadFile error only after its failed card is opened', async () => {
  const error = 'Absolute paths are not allowed: /tmp/pr-14599.diff';
  const load = vi.fn<ToolDetailsLoader>().mockResolvedValue({
    args: { path: '/tmp/pr-14599.diff' },
    rawOutput: error,
  });
  render(
    <ToolDetailsContext.Provider value={load}>
      <ToolLine tool={tool()} />
    </ToolDetailsContext.Provider>,
  );
  expect(load).not.toHaveBeenCalled();
  await act(async () => {
    container.querySelector<HTMLElement>('[aria-expanded="false"]')?.click();
  });
  expect(load).toHaveBeenCalledWith('turn:item-1', expect.any(AbortSignal));
  expect(container.textContent).toContain(error);
});

it('renders a recorded empty Shell result as No output and restores its command', async () => {
  const load = vi.fn<ToolDetailsLoader>().mockResolvedValue({
    args: { command: 'true' },
    rawOutput: '',
  });
  await act(async () => {
    render(
      <ToolDetailsContext.Provider value={load}>
        <ToolLine
          tool={tool({ toolName: 'run_shell_command', status: 'completed' })}
          forceExpanded
        />
      </ToolDetailsContext.Provider>,
    );
  });
  expect(container.textContent).toContain('No output');
  expect(container.textContent).toContain('true');
  expect(container.textContent).not.toContain('Output is unavailable');
});

it('preserves already recorded input and output without requesting them again', async () => {
  const load = vi.fn<ToolDetailsLoader>();
  await act(async () => {
    render(
      <ToolDetailsContext.Provider value={load}>
        <ToolLine
          tool={tool({
            args: { path: 'readme.md' },
            rawOutput: 'Existing error',
          })}
          forceExpanded
        />
      </ToolDetailsContext.Provider>,
    );
  });
  expect(load).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Existing error');
});

it('does not read details for unsupported tools', async () => {
  const load = vi.fn<ToolDetailsLoader>();
  await act(async () => {
    render(
      <ToolDetailsContext.Provider value={load}>
        <ToolLine tool={tool({ toolName: 'write_file' })} forceExpanded />
      </ToolDetailsContext.Provider>,
    );
  });
  expect(load).not.toHaveBeenCalled();
});

it('waits until an expanded card becomes visible in its tool group', async () => {
  const load = vi.fn<ToolDetailsLoader>().mockResolvedValue({
    rawOutput: 'Saved error',
  });
  const show = (detailsVisible: boolean) =>
    render(
      <ToolDetailsContext.Provider value={load}>
        <ToolLine tool={tool()} forceExpanded detailsVisible={detailsVisible} />
      </ToolDetailsContext.Provider>,
    );
  await act(async () => show(false));
  expect(load).not.toHaveBeenCalled();
  await act(async () => show(true));
  expect(load).toHaveBeenCalledOnce();
  expect(container.textContent).toContain('Saved error');
});

it('reloads an opened Shell card when its result arrives after the completed receipt', async () => {
  const command = 'printf late-saved-output';
  const load = vi
    .fn<ToolDetailsLoader>()
    .mockResolvedValueOnce({ args: { command }, rawOutput: undefined })
    .mockResolvedValueOnce({
      args: { command },
      rawOutput: 'late-saved-output',
    });
  const show = (sourceSequence: number) => {
    const message = managedEventsToMessages(
      [
        {
          id: 1,
          at: 1000,
          type: 'tool_completed',
          sessionId: 'session-1',
          turnId: 'turn-1',
          data: {
            itemId: 'item-1',
            toolCallId: 'call-1',
            toolName: 'run_shell_command',
            sourceSequence,
          },
        },
      ],
      '[truncated]',
    )[0];
    if (message.role !== 'tool_group') throw new Error('Missing tool group');
    render(
      <ToolDetailsContext.Provider value={load}>
        <ToolLine tool={message.tools[0]} forceExpanded />
      </ToolDetailsContext.Provider>,
    );
  };
  await act(async () => show(11));
  expect(load).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain('Output is unavailable');
  await act(async () => show(12));
  expect(load).toHaveBeenCalledTimes(2);
  expect(
    container.querySelector('[class*="shellDetails"] > pre')?.textContent,
  ).toBe('late-saved-output');
  expect(container.textContent).not.toContain('Output is unavailable');
});

it('uses a loaded structured Shell result when a legacy preview was already present', async () => {
  const load = vi.fn<ToolDetailsLoader>().mockResolvedValue({
    args: { command: 'exit 7' },
    rawOutput: {
      type: 'shell_result',
      version: 1,
      text: 'display text',
      output: 'structured stdout',
      directory: '/workspace/project',
      exitCode: 7,
      signal: null,
      pid: null,
      error: null,
      outcome: 'failed',
      notices: [],
      truncated: false,
      outputFiles: [],
    },
  });
  await act(async () =>
    render(
      <ToolDetailsContext.Provider value={load}>
        <ToolLine
          tool={tool({
            toolName: 'run_shell_command',
            rawOutput: 'legacy preview',
          })}
          forceExpanded
        />
      </ToolDetailsContext.Provider>,
    ),
  );
  expect(load).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain('structured stdout');
  expect(container.textContent).toContain('/workspace/project');
  expect(container.textContent).toContain('Exited with code 7');
  expect(container.textContent).not.toContain('legacy preview');
});

it('hides the previous Session output and ignores a late response after switching loaders', async () => {
  const first = deferred();
  const second = deferred();
  const loadFirst = vi.fn<ToolDetailsLoader>().mockReturnValue(first.promise);
  const loadSecond = vi.fn<ToolDetailsLoader>().mockReturnValue(second.promise);
  const value = tool();
  const show = (load: ToolDetailsLoader) =>
    render(
      <ToolDetailsContext.Provider value={load}>
        <ToolLine tool={value} forceExpanded />
      </ToolDetailsContext.Provider>,
    );
  show(loadFirst);
  show(loadSecond);
  expect(loadFirst.mock.calls[0][1].aborted).toBe(true);
  await act(async () => {
    first.resolve({ rawOutput: 'Private first-session output' });
  });
  expect(container.textContent).not.toContain('Private first-session output');
  await act(async () => {
    second.resolve({ rawOutput: 'Current second-session output' });
  });
  expect(container.textContent).toContain('Current second-session output');
  const third = deferred();
  show(() => third.promise);
  expect(container.textContent).not.toContain('Current second-session output');
});
