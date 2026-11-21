// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '../../i18n';
import type { WebShellLanguage } from '../../i18n';
import { ManagedSideQueryPanel } from './ManagedSideQueryPanel';
import type { useManagedSideQueries } from './use-managed-side-queries';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function mount(language: WebShellLanguage) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const sideQueries = {
    open: 'btw',
    identity: {},
    queries: [],
    pending: [],
    automatic: false,
    available: () => true,
    close: () => {},
    create: async () => true,
    setAutomatic: () => {},
  } as unknown as ReturnType<typeof useManagedSideQueries>;
  act(() => {
    root!.render(
      <I18nProvider language={language}>
        <ManagedSideQueryPanel sideQueries={sideQueries} interactive />
      </I18nProvider>,
    );
  });
  return document.querySelector('[role="dialog"]');
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe('ManagedSideQueryPanel', () => {
  // The table is positional, so a moved index renders a whole other language
  // to every user of that locale without a type error.
  it.each([
    ['en', 'BTW', 'Ask a follow-up question'],
    ['zh-CN', 'BTW 追问', '继续追问'],
    ['zh-TW', 'BTW 追問', '繼續追問'],
    ['ru', 'BTW', 'Задать уточняющий вопрос'],
    ['ar', 'سؤال جانبي', 'اطرح سؤال متابعة'],
  ] as const)(
    'reads the %s column of the label table',
    (language, title, question) => {
      const dialog = mount(language);
      expect(dialog?.textContent).toContain(title);
      expect(
        dialog?.querySelector('textarea')?.getAttribute('aria-label'),
      ).toBe(question);
    },
  );
});
