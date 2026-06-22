// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
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

function renderTableContent(
  children: ReactNode,
  language: WebShellLanguage = 'en',
): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider language={language}>
        <EnhancedMarkdownTable>{children}</EnhancedMarkdownTable>
      </I18nProvider>,
    );
  });
  mounted.push({ root, container });
  return container;
}

function renderTable(language: WebShellLanguage = 'en'): HTMLElement {
  return renderTableContent(
    [
      <thead key="head">
        <tr>
          <th>Team</th>
          <th>Score</th>
        </tr>
      </thead>,
      <tbody key="body">
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
      </tbody>,
    ],
    language,
  );
}

function renderWideTable(): HTMLElement {
  return renderTableContent([
    <thead key="head">
      <tr>
        <th>Team</th>
        <th>Region</th>
        <th>Score</th>
      </tr>
    </thead>,
    <tbody key="body">
      <tr>
        <td>Alpha</td>
        <td>US</td>
        <td>10</td>
      </tr>
      <tr>
        <td>Beta</td>
        <td>EMEA</td>
        <td>2</td>
      </tr>
    </tbody>,
  ]);
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
  return [...container.querySelectorAll('tbody tr')]
    .filter((row) => row.querySelectorAll('td').length > 1)
    .map((row) =>
      [...row.querySelectorAll('td')]
        .slice(1)
        .map((cell) => cell.textContent ?? '')
        .join('|'),
    );
}

function textButton(container: HTMLElement, text: string): HTMLButtonElement {
  const el = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === text,
  );
  expect(el).not.toBeNull();
  return el!;
}

function mockClipboard() {
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  expect(el).not.toBeNull();
  return el!;
}

function dataRows(container: HTMLElement): HTMLTableRowElement[] {
  return [...container.querySelectorAll<HTMLTableRowElement>('tbody tr')].filter(
    (row) => row.querySelectorAll('td').length > 1,
  );
}

function dataCell(
  container: HTMLElement,
  rowIndex: number,
  visibleColumnIndex: number,
): HTMLTableCellElement {
  const row = dataRows(container)[rowIndex];
  expect(row).toBeDefined();
  const cell = [...row!.querySelectorAll<HTMLTableCellElement>('td')].slice(1)[
    visibleColumnIndex
  ];
  expect(cell).toBeDefined();
  return cell!;
}

function dragCells(from: Element, to: Element): void {
  act(() => {
    from.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, button: 0 }),
    );
    from.dispatchEvent(
      new MouseEvent('mouseout', { bubbles: true, relatedTarget: to }),
    );
    to.dispatchEvent(
      new MouseEvent('mouseover', { bubbles: true, relatedTarget: from }),
    );
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
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
    click(textButton(container, 'Confirm'));

    expect(rowTexts(container)).toEqual(['Gamma|30']);
    expect(container.textContent).toContain('1/3 rows');
  });

  it('quick copies the visible sorted table', () => {
    const writeText = mockClipboard();
    const container = renderTable();

    click(button(container, 'Sort by Score'));
    click(textButton(container, 'Quick copy'));

    expect(writeText).toHaveBeenCalledWith(
      ['Team\tScore', 'Beta\t2', 'Alpha\t10', 'Gamma\t30'].join('\n'),
    );
  });

  it('hides columns and restores them from the toolbar', () => {
    const container = renderTable();

    click(button(container, 'Filter Team'));
    click(textButton(container, 'Hide column'));

    expect(rowTexts(container)).toEqual(['10', '2', '30']);
    expect(container.textContent).toContain('Show 1 hidden column');
    expect(container.querySelector('thead')?.textContent).not.toContain('Team');

    click(textButton(container, 'Show 1 hidden column'));
    expect(rowTexts(container)).toEqual(['Alpha|10', 'Beta|2', 'Gamma|30']);
  });

  it('quick copy skips hidden columns', () => {
    const writeText = mockClipboard();
    const container = renderTable();

    click(button(container, 'Filter Team'));
    click(textButton(container, 'Hide column'));
    click(textButton(container, 'Quick copy'));

    expect(writeText).toHaveBeenCalledWith(
      ['Score', '10', '2', '30'].join('\n'),
    );
  });

  it('selection copy skips hidden columns between selected cells', () => {
    const writeText = mockClipboard();
    const container = renderWideTable();

    click(button(container, 'Filter Region'));
    click(textButton(container, 'Hide column'));
    dragCells(dataCell(container, 0, 0), dataCell(container, 1, 1));
    click(textButton(container, 'Copy TSV'));

    expect(writeText).toHaveBeenCalledWith(
      ['Alpha\t10', 'Beta\t2'].join('\n'),
    );
  });

  it('does not offer hiding the last visible column', () => {
    const container = renderTable();

    click(button(container, 'Filter Team'));
    click(textButton(container, 'Hide column'));
    click(button(container, 'Filter Score'));

    expect(
      [...container.querySelectorAll('button')].some(
        (el) => el.textContent === 'Hide column',
      ),
    ).toBe(false);
  });

  it('shows row details for visible columns', () => {
    const container = renderTable();

    click(button(container, 'View details for row 2'));
    expect(container.textContent).toContain('Row details');
    expect(container.textContent).toContain('Team');
    expect(container.textContent).toContain('Beta');
    expect(container.textContent).toContain('Score');
    expect(container.textContent).toContain('2');

    click(button(container, 'Filter Team'));
    click(textButton(container, 'Hide column'));
    expect(container.textContent).not.toContain('Beta');
    expect(container.textContent).toContain('Score');
    expect(container.textContent).toContain('2');
  });

  it('closes row details when the row is filtered out', () => {
    const container = renderTable();

    click(button(container, 'View details for row 2'));
    click(button(container, 'Filter Team'));
    const beta = container.querySelector<HTMLInputElement>(
      'input[name="markdown-table-filter-option-0-1"]',
    );
    expect(beta).not.toBeNull();
    click(beta!);
    click(textButton(container, 'Confirm'));

    expect(rowTexts(container)).toEqual(['Alpha|10', 'Gamma|30']);
    expect(container.textContent).not.toContain('Row details');
    expect(container.textContent).not.toContain('Beta');
  });

  it('localizes the new controls', () => {
    const container = renderTable('zh-CN');

    expect(container.textContent).toContain('快捷复制');
    expect(container.textContent).toContain('详情');
    click(button(container, '筛选 Team'));
    expect(container.textContent).toContain('隐藏列');
  });
});
