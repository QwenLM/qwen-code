// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DaemonWorkspaceProviderStatus } from '@qwen-code/web-shell/daemon-react-sdk';
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
  it.each([
    {
      result: { updated: true as const, requiresRestart: true },
      notice: 'Saved. Restart existing sessions to apply.',
    },
    {
      result: {
        updated: true as const,
        requiresRestart: true,
        runtimeSync: { status: 'applied' as const },
      },
      notice: 'Saved. Restart existing sessions to apply.',
    },
    {
      result: {
        updated: true as const,
        requiresRestart: true,
        runtimeSync: { status: 'failed' as const },
      },
      notice:
        'The change was saved, but running sessions could not be refreshed. Restart qwen serve before using the updated model list.',
    },
  ])(
    'reports the context-window save result ($result)',
    async ({ result, notice }) => {
      const onUpdateContextWindow = vi.fn().mockResolvedValue(result);
      const { container } = renderSection({
        providers: [],
        configurations: [
          {
            key: 'saved-model',
            authType: 'openai',
            modelId: 'gpt-4o',
            contextWindowSize: 65536,
            purpose: 'chat',
            canEditContextWindow: true,
          },
        ],
        onUpdateContextWindow,
      });
      act(() => buttonByText(container, 'Edit context window').click());
      await act(async () => {
        container
          .querySelector('form')!
          .dispatchEvent(
            new Event('submit', { bubbles: true, cancelable: true }),
          );
      });
      expect(onUpdateContextWindow).toHaveBeenCalledExactlyOnceWith(
        'saved-model',
        65536,
      );
      expect(container.querySelector('[role="status"]')?.textContent).toBe(
        notice,
      );
    },
  );

  it('labels an ambiguous saved row and keeps its exact delete action without an ineffective window editor', () => {
    const { container, props } = renderSection({
      onUpdateContextWindow: vi.fn(),
      configurations: [
        {
          key: 'alias-key',
          authType: 'openai',
          modelId: 'gpt-4o',
          name: 'Saved alias',
          baseUrl: 'https://api.openai.com/v1',
          purpose: 'chat',
          contextWindowSize: 8192,
          canEditContextWindow: false,
        },
      ],
    });
    expect(
      container.querySelector('[aria-label="Delete GPT-4o"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain('Saved configuration');
    expect(container.textContent).toContain(
      'Multiple configurations share this route',
    );
    expect(
      container.querySelector('[aria-label="Edit context window Saved alias"]'),
    ).toBeNull();
    act(() =>
      (
        container.querySelector(
          '[aria-label="Delete Saved alias"]',
        ) as HTMLButtonElement
      ).click(),
    );
    act(() => buttonByText(container, 'Confirm').click());
    expect(props.onDeleteModel).toHaveBeenCalledWith({
      key: 'alias-key',
      authType: 'openai',
      modelId: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1',
    });
  });

  it('pairs rows by persisted key even when their displayed endpoint differs', () => {
    const configured = providers();
    configured[0].models[0].configurationKey = 'exact-key';
    const { container } = renderSection({
      providers: configured,
      onUpdateContextWindow: vi.fn(),
      configurations: [
        {
          key: 'exact-key',
          authType: 'openai',
          modelId: 'gpt-4o',
          name: 'GPT-4o',
          baseUrl: 'https://api.openai.com/v1',
          purpose: 'chat',
        },
      ],
    });
    expect(
      container.querySelectorAll('[aria-label="Edit context window GPT-4o"]'),
    ).toHaveLength(1);
    expect(
      container.querySelectorAll('[aria-label="Delete GPT-4o"]'),
    ).toHaveLength(1);
  });

  it('keeps distinct persisted service rows and deletes their exact key without selecting them', () => {
    const { container, props } = renderSection({
      providers: [],
      configurations: ['first', 'second'].map((key) => ({
        key,
        authType: 'openai',
        modelId: 'image',
        name: key,
        baseUrl: 'https://media.example/v1',
        purpose: 'image',
      })),
    });
    expect(
      container.querySelector('[aria-label="Delete first"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[aria-label="Delete second"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain('Image generation');
    expect(
      Array.from(container.querySelectorAll('button')).filter(
        (button) => button.textContent === 'Set current',
      ),
    ).toHaveLength(0);
    act(() =>
      (
        container.querySelector(
          '[aria-label="Delete second"]',
        ) as HTMLButtonElement
      ).click(),
    );
    act(() => buttonByText(container, 'Confirm').click());
    expect(props.onDeleteModel).toHaveBeenCalledWith({
      key: 'second',
      authType: 'openai',
      modelId: 'image',
      baseUrl: 'https://media.example/v1',
    });
    expect(props.onSelectModel).not.toHaveBeenCalled();
  });
  it.each([1, 2])(
    'deduplicates %s occurrences of a persisted key and labels empty names with the model ID',
    (count) => {
      const configuration = {
        key: 'same',
        authType: 'openai',
        modelId: 'image',
        name: '',
        purpose: 'image' as const,
      };
      const { container } = renderSection({
        providers: [],
        configurations: Array.from({ length: count }, () => configuration),
        onUpdateContextWindow: vi.fn().mockResolvedValue(undefined),
      });
      expect(
        container.querySelectorAll('[aria-label="Delete image"]'),
      ).toHaveLength(1);
      expect(
        container.querySelectorAll('[aria-label="Edit context window image"]'),
      ).toHaveLength(count === 1 ? 1 : 0);
    },
  );

  it('shows model configuration metadata and only declared input capabilities', () => {
    const configured = providers();
    Object.assign(configured[0].models[0], {
      description: 'A configured model',
      contextLimit: 131072,
      modalities: { image: true, audio: true, video: false },
      envKey: 'CUSTOM_MODEL_KEY',
    });
    const { container } = renderSection({ providers: configured });
    expect(container.textContent).toContain('gpt-4o');
    expect(container.textContent).toContain('A configured model');
    expect(container.textContent).toContain('131,072');
    expect(container.textContent).toContain('Image');
    expect(container.textContent).toContain('Audio');
    expect(container.textContent).not.toContain('Video');
    expect(container.textContent).toContain('CUSTOM_MODEL_KEY');
  });
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

  it('cancels the delete confirmation without deleting and restores the Delete button', () => {
    const { container, props } = renderSection();
    const deletes = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).filter((b) => b.textContent?.trim() === 'Delete');
    act(() => deletes[1]!.click()); // DeepSeek V4 enters confirm mode
    // Confirm + Cancel now shown for that row.
    expect(buttonByText(container, 'Confirm')).toBeTruthy();
    act(() => buttonByText(container, 'Cancel').click());
    // Back to the default state: Delete buttons restored, nothing deleted.
    expect(props.onDeleteModel).not.toHaveBeenCalled();
    const deletesAfter = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).filter((b) => b.textContent?.trim() === 'Delete');
    expect(deletesAfter).toHaveLength(2);
    expect(
      Array.from(container.querySelectorAll('button')).some(
        (b) => b.textContent?.trim() === 'Confirm',
      ),
    ).toBe(false);
  });

  it('dismisses the delete confirmation on Escape', () => {
    const { container, props } = renderSection();
    const deletes = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).filter((b) => b.textContent?.trim() === 'Delete');
    act(() => deletes[1]!.click()); // enter confirm mode
    expect(buttonByText(container, 'Confirm')).toBeTruthy();
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(props.onDeleteModel).not.toHaveBeenCalled();
    expect(
      Array.from(container.querySelectorAll('button')).some(
        (b) => b.textContent?.trim() === 'Confirm',
      ),
    ).toBe(false);
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

  it('marks only the qualified variant current when base ids collide across endpoints', () => {
    // Two endpoints expose the same base id; the current id is provider/endpoint
    // qualified, so exactly one row must be current (not both).
    const dupProviders: DaemonWorkspaceProviderStatus[] = [
      {
        kind: 'model_provider',
        status: 'ok',
        authType: 'openai',
        current: true,
        models: [
          {
            modelId: 'gpt-4o(openai)',
            baseModelId: 'gpt-4o',
            name: 'GPT-4o Primary',
            baseUrl: 'https://a.example',
            isCurrent: false,
            isRuntime: false,
          },
        ],
      },
      {
        kind: 'model_provider',
        status: 'ok',
        authType: 'azure',
        current: false,
        models: [
          {
            modelId: 'gpt-4o(azure)',
            baseModelId: 'gpt-4o',
            name: 'GPT-4o Azure',
            baseUrl: 'https://b.example',
            isCurrent: false,
            isRuntime: false,
          },
        ],
      },
    ];
    const { container } = renderSection({
      providers: dupProviders,
      currentModelId: 'gpt-4o(openai)',
    });
    const currentBadges = Array.from(
      container.querySelectorAll<HTMLSpanElement>('span'),
    ).filter((s) => s.textContent?.trim() === 'Current');
    expect(currentBadges).toHaveLength(1);
    // The Azure variant (same base id) stays selectable.
    const setButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).filter((b) => b.textContent?.trim() === 'Set current');
    expect(setButtons).toHaveLength(1);
  });

  it('does not guess a current row for a bare id shared by variants', () => {
    const dupProviders: DaemonWorkspaceProviderStatus[] = [
      {
        kind: 'model_provider',
        status: 'ok',
        authType: 'openai',
        current: true,
        models: [
          {
            modelId: 'gpt-4o(openai)',
            baseModelId: 'gpt-4o',
            name: 'GPT-4o A',
            baseUrl: 'https://a.example',
            isCurrent: false,
            isRuntime: false,
          },
          {
            modelId: 'gpt-4o(openai)',
            baseModelId: 'gpt-4o',
            name: 'GPT-4o B',
            baseUrl: 'https://b.example',
            isCurrent: false,
            isRuntime: false,
          },
        ],
      },
    ];
    const { container } = renderSection({
      providers: dupProviders,
      currentModelId: 'gpt-4o',
    });
    const currentBadges = Array.from(
      container.querySelectorAll<HTMLSpanElement>('span'),
    ).filter((s) => s.textContent?.trim() === 'Current');
    expect(currentBadges).toHaveLength(0);
  });

  it('labels each row action with the model identity for screen readers', () => {
    const { container } = renderSection();
    // DeepSeek V4 is selectable and deletable; its buttons name the model.
    const setCurrent = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Set current DeepSeek V4"]',
    );
    const del = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete DeepSeek V4"]',
    );
    expect(setCurrent).toBeTruthy();
    expect(del).toBeTruthy();
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
