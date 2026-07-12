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
    // GPT-4o and DeepSeek are deletable (not runtime); runtime-model is not.
    // deletes[0] is GPT-4o (first in DOM order) — current models keep their
    // Delete button, so deleting it is valid and is what this asserts.
    const deletes = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).filter((b) => b.textContent?.trim() === 'Delete');
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
    // Scope to the runtime model's row (span.modelName → div.modelInfo →
    // div.modelRow) and assert it offers "Set current" but not "Delete",
    // rather than just checking the row rendered.
    const nameEl = Array.from(container.querySelectorAll('span')).find(
      (s) => s.textContent === 'Runtime Model',
    );
    expect(nameEl).toBeTruthy();
    const row = nameEl!.parentElement!.parentElement!;
    const labels = Array.from(row.querySelectorAll('button')).map((b) =>
      b.textContent?.trim(),
    );
    expect(labels).not.toContain('Delete');
    expect(labels).toContain('Set current');
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

  it('marks the current model by base id when currentModelId is the base form', () => {
    const { container } = renderSection({ currentModelId: 'deepseek-v4' });
    const setButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).filter((b) => b.textContent?.trim() === 'Set current');
    // deepseek-v4 is now current (matched by baseModelId) → no button; gpt-4o
    // and the runtime model remain selectable.
    expect(setButtons).toHaveLength(2);
    expect(container.textContent).toContain('Current');
  });

  it('omits baseUrl from the delete target for a model without one', () => {
    const { container, props } = renderSection();
    // DeepSeek V4 has no baseUrl; its Delete is the second (GPT-4o is first).
    const deletes = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).filter((b) => b.textContent?.trim() === 'Delete');
    act(() => deletes[1]!.click());
    act(() => buttonByText(container, 'Confirm').click());
    expect(props.onDeleteModel).toHaveBeenCalledWith({
      authType: 'openai',
      modelId: 'deepseek-v4',
    });
    const arg = (props.onDeleteModel as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect('baseUrl' in arg).toBe(false);
  });
});
