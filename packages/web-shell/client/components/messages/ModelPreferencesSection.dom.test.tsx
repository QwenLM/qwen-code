// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  DaemonModelPreferenceRow,
  DaemonModelPreferenceScope,
} from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../../i18n';
import { ModelPreferencesSection } from './ModelPreferencesSection';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.splice(0).forEach((dispose) => dispose());
});

const chat: DaemonModelPreferenceRow = {
  key: 'openai/chat',
  name: 'Chat',
  modelId: 'chat',
  authType: 'openai',
  provider: 'primary.test',
  isCurrent: true,
  contextLimit: 200_000,
  reasoning: {
    canEnable: true,
    canDisable: true,
    efforts: ['low', 'high'],
    effortEnablesThinking: true,
  },
  locked: [],
  values: {
    user: { contextWindow: 128_000, reasoning: { effort: 'high' } },
    workspace: { contextWindow: 96_000 },
    userEffective: {
      contextWindow: 128_000,
      reasoning: { enabled: true, effort: 'high' },
    },
    effective: {
      contextWindow: 96_000,
      reasoning: { enabled: true, effort: 'high' },
    },
    inherited: {
      user: {
        contextWindow: 200_000,
        reasoning: { enabled: true, effort: 'low' },
      },
      workspace: {
        contextWindow: 128_000,
        reasoning: { enabled: true, effort: 'high' },
      },
    },
  },
  sources: { contextWindow: 'workspace', enabled: 'model', effort: 'user' },
  inheritedSources: {
    user: { contextWindow: 'model', enabled: 'model', effort: 'model' },
    workspace: { contextWindow: 'user', enabled: 'model', effort: 'user' },
  },
};

function render(models = [chat], save = vi.fn().mockResolvedValue(undefined)) {
  const container = document.createElement('div');
  document.body.append(container);
  const root: Root = createRoot(container);
  cleanup.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  const scope = (value: DaemonModelPreferenceScope) =>
    act(() =>
      root.render(
        <I18nProvider language="en">
          <ModelPreferencesSection
            scope={value}
            data={{ workspaceWritable: true, models }}
            onSave={save}
          />
        </I18nProvider>,
      ),
    );
  scope('workspace');
  const find = <T extends HTMLElement>(label: string) => {
    const result = container.querySelector<T>(`[aria-label="${label}"]`);
    if (!result) throw new Error(`Missing field ${label}`);
    return result;
  };
  const button = (label: string) => {
    const result = [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    if (!result) throw new Error(`Missing button ${label}`);
    return result;
  };
  const windowInput = () => find<HTMLInputElement>('Chat · Context window');
  return { container, scope, find, button, save, windowInput };
}

function input(target: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set?.call(target, value);
    target.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('ModelPreferencesSection', () => {
  it('keeps independent drafts and saves only changed fields in the current tab', async () => {
    const view = render();
    expect(view.windowInput().value).toBe('96000');
    expect(view.button('Save settings').disabled).toBe(true);
    input(view.windowInput(), '160000');
    expect(view.windowInput().value).toBe('160000');
    view.scope('user');
    expect(view.windowInput().value).toBe('128000');
    act(() => view.find('Chat · Thinking').click());
    expect(view.find('Chat · Effort').hasAttribute('disabled')).toBe(true);
    expect(view.find('Chat · Effort').textContent).toContain('High');

    await act(async () => view.button('Save settings').click());
    expect(view.save).toHaveBeenCalledWith({
      scope: 'user',
      changes: [{ key: chat.key, reasoning: { enabled: false } }],
    });
    view.scope('workspace');
    expect(view.windowInput().value).toBe('160000');
    act(() => view.button('Cancel').click());
    expect(view.windowInput().value).toBe('96000');
  });

  it('keeps a failed draft, validates the window, and clears with an explicit null', async () => {
    const view = render(
      [chat],
      vi
        .fn()
        .mockRejectedValueOnce(new Error('Settings file unavailable'))
        .mockResolvedValue(undefined),
    );
    const editor = view.windowInput();
    expect(editor.value).toBe('96000');
    expect(view.container.textContent).toContain('Limit 200,000');
    for (const invalid of ['', '0', '12.5', '1e5', '200001']) {
      input(editor, invalid);
      expect(editor.getAttribute('aria-invalid')).toBe('true');
      expect(view.button('Save settings').disabled).toBe(true);
    }
    input(editor, '199999');
    expect(editor.getAttribute('aria-invalid')).toBe('false');
    await act(async () => view.button('Save settings').click());
    expect(view.save).toHaveBeenCalledWith({
      scope: 'workspace',
      changes: [{ key: chat.key, contextWindow: 199_999 }],
    });
    expect(view.container.textContent).toContain('Settings file unavailable');
    expect(view.windowInput().value).toBe('199999');

    act(() => view.find('Chat · Context window · Reset to inherited').click());
    expect(view.windowInput().value).toBe('128000');
    await act(async () => view.button('Save settings').click());
    expect(view.save).toHaveBeenLastCalledWith({
      scope: 'workspace',
      changes: [{ key: chat.key, contextWindow: null }],
    });
  });

  it('renders thinking controls only where the route supports them', () => {
    const view = render([
      {
        ...chat,
        key: 'mandatory',
        name: 'Mandatory',
        reasoning: { ...chat.reasoning!, canDisable: false },
      },
      {
        ...chat,
        key: 'toggle',
        name: 'Toggle',
        reasoning: { ...chat.reasoning!, efforts: [] },
      },
      { ...chat, key: 'plain', name: 'Plain', reasoning: undefined },
    ]);
    expect(view.container.textContent).toContain('Always on');
    expect(
      view.container.querySelector('[aria-label="Mandatory · Thinking"]'),
    ).toBeNull();
    expect(view.find('Toggle · Thinking').getAttribute('role')).toBe('switch');
    expect(
      view.container.querySelector('[aria-label="Toggle · Effort"]'),
    ).toBeNull();
    expect(
      view.container.querySelector('[aria-label="Plain · Thinking"]'),
    ).toBeNull();
  });

  it('shows providers for models sharing a display name', () => {
    const { container } = render([
      chat,
      { ...chat, key: 'alternate', provider: 'alternate.test' },
      { ...chat, key: 'other', name: 'Other', provider: 'other.test' },
    ]);
    expect(container.textContent).toContain('primary.test');
    expect(container.textContent).toContain('alternate.test');
    expect(container.textContent).not.toContain('other.test');
  });
});
