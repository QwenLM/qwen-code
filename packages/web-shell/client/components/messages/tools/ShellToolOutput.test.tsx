// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ACPToolCall } from '../../../adapters/types';
import { I18nProvider } from '../../../i18n';
import { TranscriptRenderModeProvider } from '../../../transcriptRenderMode';
import { ShellToolOutput } from './ShellToolOutput';

vi.mock('../../../utils/clipboard', () => ({
  writeClipboardText: vi.fn().mockResolvedValue(undefined),
}));
const { writeClipboardText } = await import('../../../utils/clipboard');
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
afterEach(() => {
  if (root) act(() => root.unmount());
  container?.remove();
  vi.clearAllMocks();
});
const command = 'printf "health OK\\n"';
function tool(text: string, overrides: Partial<ACPToolCall> = {}): ACPToolCall {
  return {
    callId: 'shell-1',
    toolName: 'run_shell_command',
    status: 'completed',
    args: { command },
    content: [{ type: 'content', content: { type: 'text', text } }],
    ...overrides,
  };
}
function envelope(
  output = 'health OK',
  footer = 'Error: (none)\nExit Code: 0\nSignal: (none)\nProcess Group PGID: 42',
  cmd = command,
) {
  return `Command: ${cmd}\nDirectory: (root)\nOutput: ${output}\n${footer}`;
}
function render(value: ACPToolCall, documentMode = false) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <I18nProvider language="en">
        <TranscriptRenderModeProvider
          value={documentMode ? 'document' : 'interactive'}
        >
          <ShellToolOutput tool={value} />
        </TranscriptRenderModeProvider>
      </I18nProvider>,
    ),
  );
  return container;
}

function result(overrides: Record<string, unknown> = {}) {
  return {
    type: 'shell_result',
    version: 1,
    text: 'Legacy display text',
    output: 'health OK',
    directory: '/workspace',
    exitCode: 0,
    signal: null,
    pid: 42,
    error: null,
    outcome: 'completed',
    notices: [],
    truncated: false,
    outputFiles: [],
    ...overrides,
  };
}

describe('shell result presentation', () => {
  it('uses an intact text fallback for documents without structured metadata', () => {
    const text = envelope('failed output');
    render(tool(text, { status: 'failed' }), true);
    expect(container.textContent).toContain(text);
    expect(container.querySelector('details')).toBeNull();
    expect(container.textContent).not.toContain('Use default');
    expect(container.querySelector('button')).toBeNull();
  });
  it('does not repeat the command a second time in documents', () => {
    render(tool(envelope()), true);
    // The collapsed row header already carries the command; the card body must
    // not add a second copy next to the one inside the fallback envelope.
    expect(container.textContent?.split(command)).toHaveLength(2);
  });
  it('labels an empty legacy result in documents', () => {
    render(tool(''), true);
    expect(container.textContent).toContain('No output');
  });
  it.each([
    ['cancelled', null],
    ['timed_out', null],
    ['failed', 15],
  ])('hides synthetic exit zero for %s / signal %s', (outcome, signal) => {
    render(tool('', { rawOutput: result({ outcome, signal, exitCode: 0 }) }));
    expect(container.querySelector('dl')?.textContent).not.toContain(
      'Exit code',
    );
    expect(
      container.querySelector('[class*="shellStatus"]')?.textContent,
    ).not.toContain('Exited with code');
  });

  it('uses compatible text for unknown structured versions', () => {
    const rawOutput = result({ version: 2, notices: ['future notice'] });
    render(tool('', { rawOutput }));
    expect(
      container.querySelector('[class*="shellDetails"] > pre')?.textContent,
    ).toBe('Legacy display text');
  });
  it('preserves JSON when an unknown result has no text fallback', () => {
    const rawOutput = { type: 'shell_result', version: 2, data: 'future' };
    render(tool('', { rawOutput }));
    expect(
      container.querySelector('[class*="shellDetails"] > pre')?.textContent,
    ).toBe(JSON.stringify(rawOutput, null, 2));
  });
  it('does not mark a completed no-match result as failure', () => {
    render(tool('', { rawOutput: result({ exitCode: 1 }) }));
    expect(container.textContent).toContain('Completed');
    expect(container.textContent).not.toContain('Exited with code 1');
    expect(container.querySelector('.lucide-circle-x')).toBeNull();
    expect(container.querySelector('dl')?.textContent).toContain('Exit code1');
  });
  it('shows running elapsed time outside collapsed details', () => {
    // Fake timers: the elapsed string is rounded from a wall-clock gap, so a
    // live-clock fixture flips 5s to 6s on a loaded worker with no code
    // regression.
    vi.useFakeTimers();
    vi.setSystemTime(60_000);
    try {
      render(tool('', { status: 'in_progress', startTime: 55_000 }));
      expect(
        container.querySelector('[class*="shellStatus"]')?.textContent,
      ).toMatch(/Running.*5s/);
      expect(
        container
          .querySelector('[class*="shellDetails"]:last-child')
          ?.hasAttribute('open'),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
  it('keeps the elapsed time once a completed command has an endTime', () => {
    render(
      tool('', { status: 'completed', startTime: 1_000, endTime: 66_000 }),
    );
    expect(
      container.querySelector('[class*="shellStatus"]')?.textContent,
    ).toMatch(/Completed.*1m 5s/);
  });
  it('reads structured output and metadata independently of model text', () => {
    render(
      tool('model text must not become output', {
        rawOutput: result({ output: '\x1b[32mhealthy\x1b[0m' }),
      }),
    );
    expect(
      container.querySelector('[class*="shellDetails"] > pre')?.textContent,
    ).toBe('healthy');
    expect(
      container.querySelector('pre span')?.getAttribute('style'),
    ).toContain('color');
    expect(container.textContent).toContain('Succeeded');
    expect(container.textContent).toContain('/workspace');
    expect(container.textContent).not.toContain('model text');
    expect(
      [...container.querySelectorAll('details')].map((d) => d.open),
    ).toEqual([true, true, false]);
  });

  it('does not render a bare zero for signal zero', () => {
    render(tool('model text', { rawOutput: result({ signal: 0 }) }));
    const body = container.querySelector('[class*="shellBody"]');
    expect(body).not.toBeNull();
    expect(
      [...body!.childNodes]
        .filter((node) => node.nodeType === 3)
        .map((node) => node.textContent)
        .join(''),
    ).toBe('');
    expect(container.textContent).not.toContain('Signal:');
  });

  it.each([
    envelope(),
    envelope() + '\nNote: long running',
    'plain output',
    '{"ansiOutput":[],"message":"important"}',
  ])('keeps legacy text verbatim without parsing: %s', (text) => {
    render(tool(text));
    expect(
      container.querySelector('[class*="shellDetails"] > pre')?.textContent,
    ).toBe(text);
    expect(container.textContent).toContain('Completed');
    expect(container.textContent).not.toContain('Succeeded');
    // The command appears exactly once: inside the fallback envelope when the
    // envelope already leads with it, otherwise in the Command section.
    expect(container.textContent?.split(command)).toHaveLength(2);
  });

  it.each([
    ['failed', 2, 'Exited with code 2'],
    ['timed_out', null, 'Timed out'],
    ['cancelled', null, 'Cancelled'],
  ])('uses structured %s outcome', (outcome, exitCode, label) => {
    render(
      tool('model text', {
        rawOutput: result({
          outcome,
          exitCode,
          error: 'diagnostic',
          signal: 15,
        }),
      }),
    );
    expect(container.textContent).toContain(label);
    expect(container.textContent).toContain('diagnostic');
    expect(container.textContent).toContain('Signal: 15');
    if (outcome === 'cancelled') {
      expect(container.querySelector('.lucide-circle-x')).toBeNull();
    } else {
      expect(container.querySelector('.lucide-circle-x')).not.toBeNull();
    }
  });

  it('shows a success icon for a clean structured exit', () => {
    render(tool('', { rawOutput: result() }));
    expect(container.querySelector('.lucide-circle-check')).not.toBeNull();
    expect(container.querySelector('.lucide-circle-x')).toBeNull();
  });

  it('keeps long-running notices outside output and copies stdout only', async () => {
    render(
      tool('model text', {
        rawOutput: result({
          notices: ['This foreground command ran for 90s'],
          truncated: true,
          outputFiles: ['/tmp/output.txt'],
        }),
      }),
    );
    expect(container.textContent).toContain(
      'This foreground command ran for 90s',
    );
    expect(container.textContent).toContain('Output preview truncated');
    expect(container.textContent).toContain('/tmp/output.txt');
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Copy output"]')
        ?.click(),
    );
    expect(writeClipboardText).toHaveBeenLastCalledWith('health OK');
    expect(
      container.querySelector('button[aria-label="Copy output"] .lucide-check'),
    ).not.toBeNull();
  });

  it.each(['', '(empty)', 'Error: user log\nExit Code: 42'])(
    'preserves exact structured output: %s',
    async (output) => {
      render(tool('unrelated text', { rawOutput: result({ output }) }));
      expect(
        container.querySelector('[class*="shellDetails"] > pre')?.textContent,
      ).toBe(output || 'No output');
      const button = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Copy output"]',
      )!;
      expect(button.disabled).toBe(!output);
      if (output) {
        await act(async () => button.click());
        expect(writeClipboardText).toHaveBeenLastCalledWith(output);
      }
    },
  );

  it('prefers a string rawOutput display over model-facing content', () => {
    render(
      tool('Foreground command moved… press ↓ + Enter on the footer pill', {
        rawOutput: 'Promoted to background: sh_1',
      }),
    );
    expect(
      container.querySelector('[class*="shellDetails"] > pre')?.textContent,
    ).toBe('Promoted to background: sh_1');
    expect(container.textContent).not.toContain('footer pill');
  });

  it('treats an empty string rawOutput as authoritative empty output', () => {
    // A persisted empty display string is falsy but still authoritative: the
    // card must not fall back to the model-facing envelope in `content`.
    render(tool(envelope(''), { rawOutput: '' }));
    expect(container.textContent).not.toContain('Directory:');
    expect(
      container.querySelector('button[aria-label="Copy command"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[class*="shellDetails"] > pre')?.textContent,
    ).toBe('No output');
  });

  it('escapes control characters in the rendered command but copies it raw', async () => {
    const tricky = 'ls \u202efile';
    render(tool('', { args: { command: tricky } }));
    const commandPre = container.querySelector('[class*="shellSection"] pre');
    expect(commandPre?.textContent).toBe('ls \\u202efile');
    expect(commandPre?.textContent).not.toContain('\u202e');
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Copy command"]')
        ?.click(),
    );
    expect(writeClipboardText).toHaveBeenLastCalledWith(tricky);
  });

  it('escapes control characters in rendered output but copies it raw', async () => {
    const tricky = 'a\u202eb';
    render(tool('unrelated text', { rawOutput: result({ output: tricky }) }));
    expect(
      container.querySelector('[class*="shellDetails"] > pre')?.textContent,
    ).toBe('a\\u202eb');
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Copy output"]')
        ?.click(),
    );
    expect(writeClipboardText).toHaveBeenLastCalledWith(tricky);
  });

  it('copies the exact command and renders all content without actions in documents', async () => {
    const command = 'printf "one"\nprintf "two"';
    const value = tool('model', { args: { command }, rawOutput: result() });
    render(value);
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Copy command"]')
        ?.click(),
    );
    expect(writeClipboardText).toHaveBeenLastCalledWith(command);
    act(() =>
      root.render(
        <I18nProvider language="en">
          <TranscriptRenderModeProvider value="document">
            <ShellToolOutput tool={value} />
          </TranscriptRenderModeProvider>
        </I18nProvider>,
      ),
    );
    expect(
      [...container.querySelectorAll('details')].every((d) => d.open),
    ).toBe(true);
    expect(container.querySelector('button')).toBeNull();
  });

  it('renders running structured ANSI but preserves ordinary JSON stdout', () => {
    render(
      tool('', {
        status: 'in_progress',
        args: { command, timeout: 30000 },
        rawOutput: {
          ansiOutput: [[{ text: 'green', fg: '#00ff00' }]],
          totalLines: 1,
          totalBytes: 5,
        },
      }),
    );
    expect(container.textContent).toContain('green');
    expect(container.textContent).toContain('30000 ms');
    expect(container.querySelector('.lucide-loader-circle')).not.toBeNull();
    const text = '{"ansiOutput":[],"message":"important diagnostic"}';
    act(() =>
      root.render(
        <I18nProvider language="en">
          <ShellToolOutput
            tool={tool(text, { status: 'in_progress', rawOutput: text })}
          />
        </I18nProvider>,
      ),
    );
    expect(
      container.querySelector('[class*="shellDetails"] > pre')?.textContent,
    ).toBe(text);
  });

  it('does not drop unknown structured fields', () => {
    const rawOutput = { ansiOutput: [], message: 'diagnostic' };
    render(tool('', { status: 'in_progress', rawOutput }));
    expect(
      container.querySelector('[class*="shellDetails"] > pre')?.textContent,
    ).toBe(JSON.stringify(rawOutput, null, 2));
  });

  it('shows waiting output, default timeout and cancellation without invented success', () => {
    render(tool('', { status: 'in_progress' }));
    expect(container.textContent).toContain('Waiting for output');
    expect(container.textContent).toContain('Use default');
    act(() =>
      root.render(
        <I18nProvider language="en">
          <ShellToolOutput
            tool={tool('model text', {
              wasCancelled: true,
              args: { command, is_background: true },
            })}
          />
        </I18nProvider>,
      ),
    );
    expect(
      container.querySelector('[class*="shellStatus"]')?.textContent,
    ).toContain('Cancelled');
    expect(container.textContent).not.toContain('Timeout');
    expect(container.textContent).not.toContain('Succeeded');
  });

  it('omits the foreground timeout row for a run_in_background arg', () => {
    render(
      tool('', {
        status: 'in_progress',
        args: { command, run_in_background: true },
      }),
    );
    expect(container.textContent).not.toContain('Timeout');
  });

  it('omits the foreground timeout row for background execution mode', () => {
    render(tool('', { status: 'in_progress', executionMode: 'background' }));
    expect(container.textContent).not.toContain('Timeout');
  });

  it('reports clipboard failure', async () => {
    vi.mocked(writeClipboardText).mockRejectedValueOnce(new Error('denied'));
    render(tool('plain'));
    await act(async () => container.querySelector('button')?.click());
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Failed to copy',
    );
  });
});
