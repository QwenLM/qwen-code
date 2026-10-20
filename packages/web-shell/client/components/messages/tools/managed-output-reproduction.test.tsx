// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../../i18n';
import { ShellToolOutput } from './ShellToolOutput';
import { managedEventsToMessages } from '../../managed/managed-session-messages';

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
});

it('does not render empty execution details when the Managed tool only has elapsed time', () => {
  const messages = managedEventsToMessages(
    [
      {
        id: 1,
        at: 1000,
        type: 'tool_started',
        sessionId: 'managed-repro',
        turnId: 'turn-1',
        data: { toolCallId: 'call-1', toolName: 'run_shell_command' },
      },
      {
        id: 2,
        at: 5000,
        type: 'tool_completed',
        sessionId: 'managed-repro',
        turnId: 'turn-1',
        data: { toolCallId: 'call-1', toolName: 'run_shell_command' },
      },
    ],
    '[truncated]',
  );
  const message = messages[0];
  expect(message.role).toBe('tool_group');
  if (message.role !== 'tool_group') throw new Error('Missing tool group');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <I18nProvider language="en">
        <ShellToolOutput tool={message.tools[0]} />
      </I18nProvider>,
    );
  });
  expect(container.textContent).toContain('4s');
  expect(container.textContent).toContain(
    'Output is unavailable for this tool call.',
  );
  expect(
    [...container.querySelectorAll('summary')].map((node) => node.textContent),
  ).not.toContain('Execution details');
});
