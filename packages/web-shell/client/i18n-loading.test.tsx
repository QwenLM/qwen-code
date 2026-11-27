// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { getTranslator, loadLanguage, useTranslator } from './i18n';
import type { WebShellLanguage } from './i18n';

vi.unmock('./i18n-catalogs.js');

function Prompt({ language }: { language: WebShellLanguage }) {
  const t = useTranslator(language);
  return <>{t('welcome.prompt')}</>;
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
