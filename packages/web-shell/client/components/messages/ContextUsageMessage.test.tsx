// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { DaemonSessionContextUsageStatus } from '@qwen-code/webui/daemon-react-sdk';
import { I18nProvider } from '../../i18n';
import { ContextUsageMessage } from './ContextUsageMessage';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

function makeStatus(
  totalTokens: number,
  isEstimated: boolean,
): DaemonSessionContextUsageStatus {
  return {
    v: 1,
    sessionId: 'session-1',
    workspaceCwd: '/workspace',
    formattedText: '',
    usage: {
      modelName: 'test-model',
      totalTokens,
      contextWindowSize: 100,
      breakdown: {
        systemPrompt: 20,
        builtinTools: 10,
        mcpTools: 0,
        memoryFiles: 5,
        skills: 5,
        messages: Math.max(0, totalTokens - 40),
        freeSpace: Math.max(0, 100 - totalTokens),
        autocompactBuffer: 10,
      },
      builtinTools: [],
      mcpTools: [],
      memoryFiles: [],
      skills: [],
      isEstimated,
    },
  };
}

function render(status: DaemonSessionContextUsageStatus): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider language="en">
        <ContextUsageMessage status={status} />
      </I18nProvider>,
    );
  });
  mounted.push({ root, container });
  return container;
}

describe('ContextUsageMessage', () => {
  it('keeps numeric usage visible when the provider count is estimated', () => {
    const container = render(makeStatus(120, true));

    expect(container.textContent).toContain(
      'Token usage is estimated until provider usage is received.',
    );
    expect(container.textContent).toContain('Context exceeds limit!');
    expect(container.textContent).toContain('Used');
    expect(container.textContent).toContain('Messages');
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it('uses the pre-conversation view before any token count is available', () => {
    const container = render(makeStatus(0, true));

    expect(container.textContent).toContain('No API response yet.');
    expect(container.textContent).toContain(
      'Estimated pre-conversation overhead',
    );
    expect(container.textContent).not.toContain('Messages');
    expect(container.textContent).not.toContain('Used');
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
  });
});
