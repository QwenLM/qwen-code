// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider, type WebShellLanguage } from '../../i18n';
import { EnhancedMarkdownTable } from './EnhancedMarkdownTable';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.restoreAllMocks();
});

function renderTable(language: WebShellLanguage = 'en'): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider language={language}>
        <EnhancedMarkdownTable>
          <thead>
            <tr>
              <th>Team</th>
              <th>Score</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Alpha</td>
              <td>10</td>
            </tr>
            <tr>
              <td>Beta</td>
              <td>2</td>
            </tr>
            <tr>
              <td>Gamma</td>
              <td>30</td>
            </tr>
          </tbody>
        </EnhancedMarkdownTable>
      </I18nProvider>,
    );
  });
  mounted.push({ root, container });
  return container;
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function inputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function rowTexts(container: HTMLElement): string[] {
  return [...container.querySelectorAll('tbody tr')].map((row) =>
    [...row.querySelectorAll('td')]
      .map((cell) => cell.textContent ?? '')
      .join('|'),
  );
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  expect(el).not.toBeNull();
  return el!;
}

describe('EnhancedMarkdownTable', () => {
  it('sorts numeric columns from header clicks', () => {
    const container = renderTable();

    click(button(container, 'Sort by Score'));
    expect(rowTexts(container)).toEqual(['Beta|2', 'Alpha|10', 'Gamma|30']);

    click(button(container, 'Sort by Score'));
    expect(rowTexts(container)).toEqual(['Gamma|30', 'Alpha|10', 'Beta|2']);
  });

  it('filters rows from a column value menu', () => {
    const container = renderTable();

    click(button(container, 'Filter Team'));
    const search = container.querySelector<HTMLInputElement>(
      'input[name="markdown-table-option-search-0"]',
    );
    expect(search?.placeholder).toBe('Search filter values');
    expect(container.textContent).toContain('Select current results');

    const beta = container.querySelector<HTMLInputElement>(
      'input[name="markdown-table-filter-option-0-1"]',
    );
    expect(beta).not.toBeNull();
    click(beta!);
    click(
      [...container.querySelectorAll('button')].find(
        (el) => el.textContent === 'Confirm',
      )!,
    );

    expect(rowTexts(container)).toEqual(['Alpha|10', 'Gamma|30']);
    expect(container.textContent).toContain('2/3 rows');
  });

  it('applies a custom number filter', () => {
    const container = renderTable();

    click(button(container, 'Filter Score'));
    const numberFilter = container.querySelector<HTMLInputElement>(
      'input[name="markdown-table-number-filter-1"]',
    );
    expect(numberFilter).not.toBeNull();
    inputValue(numberFilter!, '10');
    click(
      [...container.querySelectorAll('button')].find(
        (el) => el.textContent === 'Confirm',
      )!,
    );

    expect(rowTexts(container)).toEqual(['Gamma|30']);
    expect(container.textContent).toContain('1/3 rows');
  });
});
