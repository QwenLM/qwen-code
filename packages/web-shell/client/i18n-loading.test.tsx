// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Direction } from 'radix-ui';
import { expect, it, vi } from 'vitest';
import {
  getTranslator,
  I18nProvider,
  loadLanguage,
  useI18n,
  useTranslator,
} from './i18n';
import type { WebShellLanguage } from './i18n';

vi.unmock('./i18n-catalogs.js');

function Prompt({ language }: { language: WebShellLanguage }) {
  const t = useTranslator(language);
  return <>{t('welcome.prompt')}</>;
}

function ProviderPrompt() {
  const { t } = useI18n();
  const dir = Direction.useDirection();
  return <span dir={dir}>{t('welcome.prompt')}</span>;
}

it('loads only requested catalogs and updates a mounted translator', async () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const english = getTranslator('en')('welcome.prompt');
  try {
    expect(loadLanguage('en')).toBeUndefined();
    expect(getTranslator('ru')('welcome.prompt')).toBe(english);
    expect(getTranslator('zh-CN')('welcome.prompt')).toBe(english);
    expect(getTranslator('zh-TW')('welcome.prompt')).toBe(english);

    act(() => root.render(<Prompt language="zh-TW" />));
    const traditional = loadLanguage('zh-TW');
    expect(traditional).toBeDefined();
    expect(loadLanguage('zh-TW')).toBe(traditional);
    expect(container.textContent).toBe(english);
    await act(async () => {
      await traditional;
    });
    expect(container.textContent).toBe('你想構建什麼？');
    expect(loadLanguage('zh-TW')).toBeUndefined();
    expect(getTranslator('ru')('welcome.prompt')).toBe(english);
    expect(getTranslator('zh-CN')('welcome.prompt')).toBe(english);

    act(() => root.render(<Prompt language="ru" />));
    const russian = loadLanguage('ru');
    expect(russian).toBeDefined();
    act(() => root.render(<Prompt language="zh-TW" />));
    await act(async () => {
      await russian;
    });
    expect(container.textContent).toBe('你想構建什麼？');
    act(() => root.render(<Prompt language="ru" />));
    expect(container.textContent).toBe('Что вы хотите сделать?');
  } finally {
    act(() => root.unmount());
  }
});

it('updates the mounted Arabic provider when its catalog loads', async () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const english = getTranslator('en')('welcome.prompt');
  const render = (language: WebShellLanguage) => {
    act(() =>
      root.render(
        <I18nProvider language={language}>
          <ProviderPrompt />
        </I18nProvider>,
      ),
    );
  };
  try {
    expect(getTranslator('ar')('welcome.prompt')).toBe(english);
    render('ar');
    const arabic = loadLanguage('ar');
    expect(arabic).toBeDefined();
    expect(loadLanguage('ar')).toBe(arabic);
    expect(container.textContent).toBe(english);
    await act(async () => {
      await arabic;
    });
    expect(container.textContent).toBe('ما الذي تود فعله؟');
    expect(container.firstElementChild?.getAttribute('dir')).toBe('rtl');
    expect(loadLanguage('ar')).toBeUndefined();
    render('en');
    expect(container.textContent).toBe(english);
    expect(container.firstElementChild?.getAttribute('dir')).toBe('ltr');
  } finally {
    act(() => root.unmount());
  }
});
