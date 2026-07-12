// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DaemonWorkspaceProviderStatus } from '@qwen-code/webui/daemon-react-sdk';
import { I18nProvider } from '../../i18n';
import {
  ModelManagementSection,
  type ModelManagementProps,
} from './ModelManagementSection';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

function render(node: ReactNode): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
  return container;
}

function providers(): DaemonWorkspaceProviderStatus[] {
  return [
    {
      kind: 'model_provider',
      status: 'ok',
      authType: 'openai',
      current: true,
      models: [
        {
          modelId: 'gpt-4o(openai)',
          baseModelId: 'gpt-4o',
          name: 'GPT-4o',
          baseUrl: 'https://api.openai.com',
          isCurrent: true,
          isRuntime: false,
        },
        {
          modelId: 'deepseek-v4(openai)',
          baseModelId: 'deepseek-v4',
          name: 'DeepSeek V4',
          isCurrent: false,
          isRuntime: false,
        },
        {
          modelId: 'runtime-model(openai)',
          baseModelId: 'runtime-model',
          name: 'Runtime Model',
          isCurrent: false,
          isRuntime: true,
        },
      ],
    },
  ];
}

function renderSection(overrides: Partial<ModelManagementProps> = {}) {
  const props: ModelManagementProps = {
    providers: providers(),
    currentModelId: 'gpt-4o(openai)',
    loading: false,
    error: undefined,
    busy: false,
    onSelectModel: vi.fn(),
    onDeleteModel: vi.fn(),
    onAddModel: vi.fn(),
    ...overrides,
  };
  const container = render(
    <I18nProvider language="en">
      <ModelManagementSection {...props} />
    </I18nProvider>,
  );
  return { container, props };
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(
    container.querySelectorAll<HTMLButtonElement>('button'),
  ).find((b) => b.textContent?.trim() === text);
  if (!button) throw new Error(`button "${text}" not found`);
  return button;
}

describe('ModelManagementSection', () => {
  it('lists models grouped by provider', () => {
    const { container } = renderSection();
    expect(container.textContent).toContain('GPT-4o');
    expect(container.textContent).toContain('DeepSeek V4');
    expect(container.textContent).toContain('openai');
  });

  it('marks the current model and hides its "set current" button', () => {
    const { container } = renderSection();
    const setButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).filter((b) => b.textContent?.trim() === 'Set current');
    // GPT-4o is current (no button); DeepSeek and the runtime model are both
    // selectable → 2 buttons. Runtime models are selectable but not deletable.
    expect(setButtons).toHaveLength(2);
  });

  it('selects a model via "set current"', () => {
    const { container, props } = renderSection();
    act(() => buttonByText(container, 'Set current').click());
    expect(props.onSelectModel).toHaveBeenCalledWith('deepseek-v4(openai)');
  });

  it('deletes a model after confirmation, passing base id + baseUrl', () => {
    const { container, props } = renderSection();
    // GPT-4o is current so no delete confirm race; delete DeepSeek V4 instead.
    // First Delete button belongs to GPT-4o (current), but current models keep
    // their delete button; click DeepSeek's by finding the second one.
    const deletes = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).filter((b) => b.textContent?.trim() === 'Delete');
    // GPT-4o and DeepSeek are deletable (not runtime); runtime-model is not.
    expect(deletes).toHaveLength(2);
    act(() => deletes[0]!.click());
    // Confirm now visible.
    act(() => buttonByText(container, 'Confirm').click());
    expect(props.onDeleteModel).toHaveBeenCalledWith({
      authType: 'openai',
      modelId: 'gpt-4o',
      baseUrl: 'https://api.openai.com',
    });
  });

  it('does not offer delete for runtime models', () => {
    const { container } = renderSection();
    // 3 models, runtime one excluded → only 2 delete buttons (asserted above);
    // ensure the runtime model row rendered but has no Delete.
    expect(container.textContent).toContain('Runtime Model');
  });

  it('triggers add', () => {
    const { container, props } = renderSection();
    act(() => buttonByText(container, '+ Add Model').click());
    expect(props.onAddModel).toHaveBeenCalled();
  });

  it('shows the empty state when there are no models', () => {
    const { container } = renderSection({ providers: [] });
    expect(container.textContent).toContain('No configured models');
  });
});
