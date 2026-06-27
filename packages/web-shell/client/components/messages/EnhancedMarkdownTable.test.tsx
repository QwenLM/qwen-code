// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StrictMode, act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider, type WebShellLanguage } from '../../i18n';
import { EnhancedMarkdownTable } from './EnhancedMarkdownTable';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
const originalElementFromPoint = document.elementFromPoint;

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.getSelection()?.removeAllRanges();
  if (originalElementFromPoint) {
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: originalElementFromPoint,
    });
  } else {
    Reflect.deleteProperty(document, 'elementFromPoint');
  }
});

function renderTableContent(
  children: ReactNode,
  language: WebShellLanguage = 'en',
  fallback?: ReactNode,
): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider language={language}>
        <EnhancedMarkdownTable fallback={fallback}>
          {children}
        </EnhancedMarkdownTable>
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

function selectValue(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    'value',
  )?.set;
  act(() => {
    setter?.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
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

function textButtonContaining(
  container: HTMLElement,
  text: string,
): HTMLButtonElement {
  const el = [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes(text),
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

function mockClipboardRejecting() {
  const writeText = vi.fn(() => Promise.reject(new Error('copy failed')));
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

function mockClipboardDelayed() {
  let resolveCopy: (() => void) | undefined;
  const writeText = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        resolveCopy = resolve;
      }),
  );
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  return {
    writeText,
    resolveCopy: () => {
      expect(resolveCopy).toBeDefined();
      resolveCopy?.();
    },
  };
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  expect(el).not.toBeNull();
  return el!;
}

function dataRows(container: HTMLElement): HTMLTableRowElement[] {
  return [
    ...container.querySelectorAll<HTMLTableRowElement>('tbody tr'),
  ].filter((row) => row.querySelectorAll('td').length > 1);
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

function dispatchCopy(target: Element) {
  const setData = vi.fn();
  const event = new Event('copy', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { setData },
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return { event, setData };
}

function touchEvent(
  type: string,
  touches: Array<Pick<Touch, 'clientX' | 'clientY'>>,
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { value: touches });
  Object.defineProperty(event, 'changedTouches', { value: touches });
  return event;
}

describe('EnhancedMarkdownTable', () => {
  it('sorts numeric columns from header clicks', () => {
    const container = renderTable();

    click(button(container, 'Sort by Score'));
    expect(rowTexts(container)).toEqual(['Beta|2', 'Alpha|10', 'Gamma|30']);
    expect(button(container, 'Sort by Score, ascending')).toBeDefined();
    expect(
      button(container, 'Sort by Score, ascending')
        .closest('th')
        ?.getAttribute('aria-sort'),
    ).toBe('ascending');

    click(button(container, 'Sort by Score, ascending'));
    expect(rowTexts(container)).toEqual(['Gamma|30', 'Alpha|10', 'Beta|2']);
    expect(button(container, 'Sort by Score, descending')).toBeDefined();
    expect(
      button(container, 'Sort by Score, descending')
        .closest('th')
        ?.getAttribute('aria-sort'),
    ).toBe('descending');

    click(button(container, 'Sort by Score, descending'));
    expect(rowTexts(container)).toEqual(['Alpha|10', 'Beta|2', 'Gamma|30']);
    expect(button(container, 'Sort by Score')).toBeDefined();
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

  it.each<[string, string[]]>([
    ['gte', ['Alpha|10', 'Gamma|30']],
    ['lt', ['Beta|2']],
    ['lte', ['Alpha|10', 'Beta|2']],
  ])('applies the %s number filter operator', (operator, expectedRows) => {
    const container = renderTable();

    click(button(container, 'Filter Score'));
    selectValue(
      container.querySelector<HTMLSelectElement>(
        'select[name="markdown-table-number-operator-1"]',
      )!,
      operator,
    );
    inputValue(
      container.querySelector<HTMLInputElement>(
        'input[name="markdown-table-number-filter-1"]',
      )!,
      '10',
    );
    click(textButton(container, 'Confirm'));

    expect(rowTexts(container)).toEqual(expectedRows);
  });

  it('applies text filter operators and reset', () => {
    const container = renderTable();

    click(button(container, 'Filter Team'));
    expect(
      container.querySelector<HTMLInputElement>(
        'input[name="markdown-table-option-search-0"]',
      ),
    ).toBe(document.activeElement);
    selectValue(
      container.querySelector<HTMLSelectElement>(
        'select[name="markdown-table-text-operator-0"]',
      )!,
      'equals',
    );
    inputValue(
      container.querySelector<HTMLInputElement>(
        'input[name="markdown-table-text-filter-0"]',
      )!,
      'Alpha',
    );
    click(textButton(container, 'Confirm'));
    expect(rowTexts(container)).toEqual(['Alpha|10']);

    click(button(container, 'Filter Team'));
    click(textButton(container, 'Reset'));
    expect(rowTexts(container)).toEqual(['Alpha|10', 'Beta|2', 'Gamma|30']);

    click(button(container, 'Filter Team'));
    selectValue(
      container.querySelector<HTMLSelectElement>(
        'select[name="markdown-table-text-operator-0"]',
      )!,
      'startsWith',
    );
    inputValue(
      container.querySelector<HTMLInputElement>(
        'input[name="markdown-table-text-filter-0"]',
      )!,
      'Ga',
    );
    click(textButton(container, 'Confirm'));
    expect(rowTexts(container)).toEqual(['Gamma|30']);

    click(button(container, 'Filter Team'));
    click(textButton(container, 'Reset'));
    click(button(container, 'Filter Team'));
    selectValue(
      container.querySelector<HTMLSelectElement>(
        'select[name="markdown-table-text-operator-0"]',
      )!,
      'endsWith',
    );
    inputValue(
      container.querySelector<HTMLInputElement>(
        'input[name="markdown-table-text-filter-0"]',
      )!,
      'ta',
    );
    click(textButton(container, 'Confirm'));
    expect(rowTexts(container)).toEqual(['Beta|2']);

    click(button(container, 'Filter Team'));
    click(textButton(container, 'Reset'));
    click(button(container, 'Filter Team'));
    selectValue(
      container.querySelector<HTMLSelectElement>(
        'select[name="markdown-table-text-operator-0"]',
      )!,
      'notEquals',
    );
    inputValue(
      container.querySelector<HTMLInputElement>(
        'input[name="markdown-table-text-filter-0"]',
      )!,
      'Beta',
    );
    click(textButton(container, 'Confirm'));
    expect(rowTexts(container)).toEqual(['Alpha|10', 'Gamma|30']);
  });

  it('applies a between number filter', () => {
    const container = renderTable();

    click(button(container, 'Filter Score'));
    selectValue(
      container.querySelector<HTMLSelectElement>(
        'select[name="markdown-table-number-operator-1"]',
      )!,
      'between',
    );
    inputValue(
      container.querySelector<HTMLInputElement>(
        'input[name="markdown-table-number-filter-1"]',
      )!,
      '10',
    );
    inputValue(
      container.querySelector<HTMLInputElement>(
        'input[name="markdown-table-number-filter-to-1"]',
      )!,
      '2',
    );
    click(textButton(container, 'Confirm'));

    expect(rowTexts(container)).toEqual(['Alpha|10', 'Beta|2']);
  });

  it('sorts decimal values without leading zero numerically', () => {
    const container = renderTableContent([
      <thead key="head">
        <tr>
          <th>Value</th>
        </tr>
      </thead>,
      <tbody key="body">
        <tr>
          <td>.5</td>
        </tr>
        <tr>
          <td>-.75</td>
        </tr>
        <tr>
          <td>.123</td>
        </tr>
      </tbody>,
    ]);

    click(button(container, 'Sort by Value'));
    expect(rowTexts(container)).toEqual(['-.75', '.123', '.5']);
  });

  it('sorts currency values numerically', () => {
    const container = renderTableContent([
      <thead key="head">
        <tr>
          <th>Amount</th>
        </tr>
      </thead>,
      <tbody key="body">
        <tr>
          <td>$100</td>
        </tr>
        <tr>
          <td>$20</td>
        </tr>
        <tr>
          <td>$3</td>
        </tr>
      </tbody>,
    ]);

    click(button(container, 'Sort by Amount'));
    expect(rowTexts(container)).toEqual(['$3', '$20', '$100']);
  });

  it('filters percentage values as fractions', () => {
    const container = renderTableContent([
      <thead key="head">
        <tr>
          <th>Ratio</th>
        </tr>
      </thead>,
      <tbody key="body">
        <tr>
          <td>40%</td>
        </tr>
        <tr>
          <td>0.5</td>
        </tr>
        <tr>
          <td>75%</td>
        </tr>
      </tbody>,
    ]);

    click(button(container, 'Filter Ratio'));
    inputValue(
      container.querySelector<HTMLInputElement>(
        'input[name="markdown-table-number-filter-0"]',
      )!,
      '.45',
    );
    click(textButton(container, 'Confirm'));

    expect(rowTexts(container)).toEqual(['0.5', '75%']);
  });

  it('preserves markdown table cell alignment', () => {
    const container = renderTableContent([
      <thead key="head">
        <tr>
          <th style={{ textAlign: 'right' }}>Amount</th>
          <th style={{ textAlign: 'center' }}>Status</th>
        </tr>
      </thead>,
      <tbody key="body">
        <tr>
          <td style={{ textAlign: 'right' }}>$10</td>
          <td style={{ textAlign: 'center' }}>Done</td>
        </tr>
      </tbody>,
    ]);

    const headerCells = [
      ...container.querySelectorAll<HTMLTableCellElement>('thead th'),
    ].slice(1);
    expect(headerCells[0]?.style.textAlign).toBe('right');
    expect(headerCells[1]?.style.textAlign).toBe('center');
    expect(dataCell(container, 0, 0).style.textAlign).toBe('right');
    expect(dataCell(container, 0, 1).style.textAlign).toBe('center');

    click(button(container, 'View details for row 1'));
    const detailElements = [...container.querySelectorAll<HTMLElement>('div')];
    expect(
      detailElements.find(
        (element) =>
          element.textContent === '$10' && element.style.textAlign === 'right',
      ),
    ).toBeDefined();
    expect(
      detailElements.find(
        (element) =>
          element.textContent === 'Done' &&
          element.style.textAlign === 'center',
      ),
    ).toBeDefined();
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

  it('sanitizes spreadsheet formulas when copying TSV', () => {
    const writeText = mockClipboard();
    const hiddenFormula = '\u200B=2+2';
    const container = renderTableContent([
      <thead key="head">
        <tr>
          <th>Name</th>
          <th>Formula</th>
        </tr>
      </thead>,
      <tbody key="body">
        <tr>
          <td>Alpha</td>
          <td>=1+1</td>
        </tr>
        <tr>
          <td>Beta</td>
          <td>-10</td>
        </tr>
        <tr>
          <td>Gamma</td>
          <td>{hiddenFormula}</td>
        </tr>
      </tbody>,
    ]);

    click(textButton(container, 'Quick copy'));
    expect(writeText).toHaveBeenCalledWith(
      [
        'Name\tFormula',
        "Alpha\t'=1+1",
        "Beta\t'-10",
        `Gamma\t'${hiddenFormula}`,
      ].join('\n'),
    );

    dragCells(dataCell(container, 0, 1), dataCell(container, 0, 1));
    click(textButton(container, 'Copy TSV'));
    expect(writeText).toHaveBeenLastCalledWith("'=1+1");
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

  it('shows checkmark feedback after quick copy', async () => {
    vi.useFakeTimers();
    mockClipboard();
    const container = renderTable();

    await act(async () => {
      textButton(container, 'Quick copy').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('✓');
    expect(container.textContent).toContain('Copied!');
    expect(container.textContent).not.toContain('Quick copy');

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    expect(container.textContent).not.toContain('✓');
    expect(container.textContent).toContain('Quick copy');
  });

  it('keeps copy feedback working under StrictMode effect replay', async () => {
    mockClipboard();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <StrictMode>
          <I18nProvider language="en">
            <EnhancedMarkdownTable>
              <thead>
                <tr>
                  <th>Team</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Alpha</td>
                </tr>
              </tbody>
            </EnhancedMarkdownTable>
          </I18nProvider>
        </StrictMode>,
      );
    });
    mounted.push({ root, container });

    await act(async () => {
      textButton(container, 'Quick copy').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Copied!');
  });

  it('keeps quick copy feedback visible for the latest click', async () => {
    vi.useFakeTimers();
    mockClipboard();
    const container = renderTable();

    await act(async () => {
      textButton(container, 'Quick copy').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      vi.advanceTimersByTime(1000);
      textButtonContaining(container, 'Copied!').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    expect(container.textContent).toContain('Copied!');
    expect(container.textContent).not.toContain('Quick copy');

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    expect(container.textContent).not.toContain('Copied!');
    expect(container.textContent).toContain('Quick copy');
  });

  it('resets quick copy feedback when visible table data changes', async () => {
    vi.useFakeTimers();
    mockClipboard();
    const container = renderTable();

    await act(async () => {
      textButton(container, 'Quick copy').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Copied!');

    click(button(container, 'Sort by Score'));

    expect(container.textContent).not.toContain('Copied!');
    expect(container.textContent).toContain('Quick copy');
  });

  it('ignores stale quick copy feedback after visible data changes', async () => {
    const clipboard = mockClipboardDelayed();
    const container = renderTable();

    act(() => {
      textButton(container, 'Quick copy').click();
    });
    click(button(container, 'Sort by Score'));

    await act(async () => {
      clipboard.resolveCopy();
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain('Copied!');
    expect(container.textContent).toContain('Quick copy');
  });

  it('resets quick copy feedback when filters change visible rows', async () => {
    vi.useFakeTimers();
    mockClipboard();
    const container = renderTable();

    await act(async () => {
      textButton(container, 'Quick copy').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Copied!');

    click(button(container, 'Filter Team'));
    const beta = container.querySelector<HTMLInputElement>(
      'input[name="markdown-table-filter-option-0-1"]',
    );
    expect(beta).not.toBeNull();
    click(beta!);
    click(textButton(container, 'Confirm'));

    expect(container.textContent).not.toContain('Copied!');
    expect(container.textContent).toContain('Quick copy');
  });

  it('does not show copied feedback when clipboard write fails', async () => {
    mockClipboardRejecting();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const container = renderTable();

    await act(async () => {
      textButton(container, 'Quick copy').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(warn).toHaveBeenCalled();
    expect(container.textContent).not.toContain('Copied!');
    expect(container.textContent).toContain('Quick copy');
  });

  it('shows checkmark feedback after copying a selection', async () => {
    vi.useFakeTimers();
    mockClipboard();
    const container = renderTable();

    dragCells(dataCell(container, 0, 0), dataCell(container, 0, 0));

    await act(async () => {
      textButton(container, 'Copy TSV').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('✓');
    expect(container.textContent).toContain('Copied!');
    expect(container.textContent).not.toContain('Copy TSV');

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    expect(container.textContent).not.toContain('✓');
    expect(container.textContent).toContain('Copy TSV');
  });

  it('resets selection copy feedback when the selection changes', async () => {
    vi.useFakeTimers();
    mockClipboard();
    const container = renderTable();

    dragCells(dataCell(container, 0, 0), dataCell(container, 0, 0));

    await act(async () => {
      textButton(container, 'Copy TSV').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Copied!');

    dragCells(dataCell(container, 1, 0), dataCell(container, 1, 0));

    expect(container.textContent).not.toContain('Copied!');
    expect(container.textContent).toContain('Copy TSV');
  });

  it('ignores stale selection copy feedback after selection changes', async () => {
    const clipboard = mockClipboardDelayed();
    const container = renderTable();

    dragCells(dataCell(container, 0, 0), dataCell(container, 0, 0));
    act(() => {
      textButton(container, 'Copy TSV').click();
    });
    dragCells(dataCell(container, 1, 0), dataCell(container, 1, 0));

    await act(async () => {
      clipboard.resolveCopy();
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain('Copied!');
    expect(container.textContent).toContain('Copy TSV');
  });

  it('resets interactive state when table columns change', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const render = (children: ReactNode) => {
      act(() => {
        root.render(
          <I18nProvider language="en">
            <EnhancedMarkdownTable>{children}</EnhancedMarkdownTable>
          </I18nProvider>,
        );
      });
    };

    render([
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
      </tbody>,
    ]);
    click(button(container, 'Filter Team'));
    click(textButton(container, 'Hide column'));
    expect(rowTexts(container)).toEqual(['10']);

    render([
      <thead key="head">
        <tr>
          <th>Name</th>
          <th>Value</th>
        </tr>
      </thead>,
      <tbody key="body">
        <tr>
          <td>Beta</td>
          <td>20</td>
        </tr>
      </tbody>,
    ]);

    expect(rowTexts(container)).toEqual(['Beta|20']);
    mounted.push({ root, container });
  });

  it('clears hidden column filters and sort', () => {
    const container = renderTable();

    click(button(container, 'Sort by Team'));
    click(button(container, 'Sort by Team, ascending'));
    click(button(container, 'Filter Team'));
    const beta = container.querySelector<HTMLInputElement>(
      'input[name="markdown-table-filter-option-0-1"]',
    );
    expect(beta).not.toBeNull();
    click(beta!);
    click(textButton(container, 'Confirm'));
    expect(rowTexts(container)).toEqual(['Gamma|30', 'Alpha|10']);

    click(button(container, 'Filter Team'));
    click(textButton(container, 'Hide column'));

    expect(rowTexts(container)).toEqual(['10', '2', '30']);
    expect(container.textContent).toContain('3 rows');
  });

  it('selection copy skips hidden columns between selected cells', () => {
    const writeText = mockClipboard();
    const container = renderWideTable();

    click(button(container, 'Filter Region'));
    click(textButton(container, 'Hide column'));
    dragCells(dataCell(container, 0, 0), dataCell(container, 1, 1));
    click(textButton(container, 'Copy TSV'));

    expect(writeText).toHaveBeenCalledWith(['Alpha\t10', 'Beta\t2'].join('\n'));
  });

  it('copies selected cells from the focused keyboard copy event', () => {
    const container = renderTable();
    const outsideButton = document.createElement('button');
    document.body.appendChild(outsideButton);
    outsideButton.focus();

    dragCells(dataCell(container, 0, 0), dataCell(container, 1, 1));
    const scroller = container.querySelector<HTMLElement>('div[tabindex="0"]');
    expect(scroller).not.toBeNull();
    expect(document.activeElement).toBe(scroller);
    const { event, setData } = dispatchCopy(document.activeElement!);

    expect(event.defaultPrevented).toBe(true);
    expect(setData).toHaveBeenCalledWith(
      'text/plain',
      ['Alpha\t10', 'Beta\t2'].join('\n'),
    );
    outsideButton.remove();
  });

  it('keeps native text selection copy behavior', () => {
    const container = renderTable();
    const selection = document.getSelection();
    const range = document.createRange();
    range.selectNodeContents(dataCell(container, 0, 0));
    act(() => {
      selection?.removeAllRanges();
      selection?.addRange(range);
    });

    const scroller = container.querySelector<HTMLElement>('div[tabindex="0"]');
    expect(scroller).not.toBeNull();
    const { event, setData } = dispatchCopy(scroller!);

    expect(event.defaultPrevented).toBe(false);
    expect(setData).not.toHaveBeenCalled();
  });

  it('keeps cross-boundary native text selection copy behavior', () => {
    const container = renderTable();
    const outside = document.createElement('span');
    outside.textContent = 'outside';
    document.body.appendChild(outside);
    const selection = document.getSelection();
    const range = document.createRange();
    const startNode = dataCell(container, 0, 0).firstChild;
    const endNode = outside.firstChild;
    expect(startNode).not.toBeNull();
    expect(endNode).not.toBeNull();
    range.setStart(startNode!, 0);
    range.setEnd(endNode!, outside.textContent.length);
    act(() => {
      selection?.removeAllRanges();
      selection?.addRange(range);
    });

    const scroller = container.querySelector<HTMLElement>('div[tabindex="0"]');
    expect(scroller).not.toBeNull();
    const { event, setData } = dispatchCopy(scroller!);

    expect(event.defaultPrevented).toBe(false);
    expect(setData).not.toHaveBeenCalled();
    outside.remove();
  });

  it('prevents native text selection when selecting cells with the mouse', () => {
    const container = renderTable();
    const event = new MouseEvent('mousedown', {
      bubbles: true,
      button: 0,
      cancelable: true,
    });

    act(() => {
      dataCell(container, 0, 0).dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
  });

  it('stops extending a selection after window blur', () => {
    const writeText = mockClipboard();
    const container = renderTable();
    const from = dataCell(container, 0, 0);
    const to = dataCell(container, 1, 1);

    act(() => {
      from.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, button: 0 }),
      );
      window.dispatchEvent(new Event('blur'));
      to.dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true, relatedTarget: from }),
      );
    });
    click(textButton(container, 'Copy TSV'));

    expect(writeText).toHaveBeenCalledWith('Alpha');
  });

  it('selects cells with touch drag', () => {
    const writeText = mockClipboard();
    const container = renderTable();
    const from = dataCell(container, 0, 0);
    const to = dataCell(container, 1, 1);
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => to),
    });

    act(() => {
      from.dispatchEvent(
        touchEvent('touchstart', [{ clientX: 1, clientY: 1 }]),
      );
      from.dispatchEvent(touchEvent('touchmove', [{ clientX: 2, clientY: 2 }]));
      from.dispatchEvent(touchEvent('touchend', []));
    });
    click(textButton(container, 'Copy TSV'));

    expect(writeText).toHaveBeenCalledWith(['Alpha\t10', 'Beta\t2'].join('\n'));
  });

  it('resets filter menu draft state when switching columns', () => {
    const container = renderWideTable();

    click(button(container, 'Filter Team'));
    const teamSearch = container.querySelector<HTMLInputElement>(
      'input[name="markdown-table-option-search-0"]',
    );
    expect(teamSearch).not.toBeNull();
    inputValue(teamSearch!, 'Al');

    click(button(container, 'Filter Score'));
    const scoreSearch = container.querySelector<HTMLInputElement>(
      'input[name="markdown-table-option-search-2"]',
    );
    expect(scoreSearch?.value).toBe('');
  });

  it('closes the filter menu when clicking outside it', () => {
    const container = renderTable();

    click(button(container, 'Filter Team'));
    expect(container.textContent).toContain('Custom filter');
    act(() => {
      dataCell(container, 0, 0).dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, button: 0 }),
      );
    });

    expect(container.textContent).not.toContain('Custom filter');
  });

  it('returns focus to the filter trigger when Escape closes the menu', async () => {
    const container = renderTable();
    const filterButton = button(container, 'Filter Team');

    click(filterButton);
    expect(container.textContent).toContain('Custom filter');
    expect(
      container.querySelector<HTMLInputElement>(
        'input[name="markdown-table-option-search-0"]',
      ),
    ).toBe(document.activeElement);

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }),
      );
    });
    await act(async () => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
    });

    expect(container.textContent).not.toContain('Custom filter');
    expect(document.activeElement).toBe(filterButton);
  });

  it('keeps Tab focus within the filter dialog', () => {
    const container = renderTable();

    click(button(container, 'Filter Team'));
    const menu = container.querySelector<HTMLElement>('[role="dialog"]');
    expect(menu).not.toBeNull();
    const focusableElements = Array.from(
      menu!.querySelectorAll<HTMLElement>('button, input, select'),
    ).filter((element) => !element.hasAttribute('disabled'));
    expect(focusableElements.length).toBeGreaterThan(1);
    focusableElements[0]!.focus();

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          key: 'Tab',
          shiftKey: true,
        }),
      );
    });

    expect(document.activeElement).toBe(
      focusableElements[focusableElements.length - 1],
    );
  });

  it('does not trap Tab when focus is outside the filter dialog', () => {
    const container = renderTable();
    const outsideButton = document.createElement('button');
    document.body.appendChild(outsideButton);

    click(button(container, 'Filter Team'));
    outsideButton.focus();
    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Tab',
    });
    act(() => {
      document.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(outsideButton);
    outsideButton.remove();
  });

  it('closes the filter menu on scroll', () => {
    const container = renderTable();

    click(button(container, 'Filter Team'));
    expect(container.textContent).toContain('Custom filter');
    act(() => {
      document.dispatchEvent(new Event('scroll'));
    });

    expect(container.textContent).not.toContain('Custom filter');
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

    const detailsButton = button(container, 'View details for row 2');
    click(detailsButton);
    const detailsId = detailsButton.getAttribute('aria-controls');
    expect(detailsId).toBeTruthy();
    expect(container.ownerDocument.getElementById(detailsId!)).not.toBeNull();
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

  it('falls back for oversized tables', () => {
    const rows = Array.from({ length: 501 }, (_, index) => (
      <tr key={index}>
        <td>{index}</td>
      </tr>
    ));
    const container = renderTableContent(
      [
        <thead key="head">
          <tr>
            <th>Value</th>
          </tr>
        </thead>,
        <tbody key="body">{rows}</tbody>,
      ],
      'en',
      <table>
        <tbody>
          <tr>
            <td>plain fallback</td>
          </tr>
        </tbody>
      </table>,
    );

    expect(container.textContent).toContain('plain fallback');
    expect(container.textContent).not.toContain('Quick copy');
  });

  it('falls back when a table has no parsed columns', () => {
    const container = renderTableContent(
      <tbody>
        <tr />
      </tbody>,
      'en',
      <table>
        <tbody>
          <tr>
            <td>plain fallback</td>
          </tr>
        </tbody>
      </table>,
    );

    expect(container.textContent).toContain('plain fallback');
    expect(container.textContent).not.toContain('Quick copy');
  });

  it('shows a distinct message for empty tables', () => {
    const container = renderTableContent([
      <thead key="head">
        <tr>
          <th>Value</th>
        </tr>
      </thead>,
    ]);

    expect(container.textContent).toContain('This table has no data.');
    expect(container.textContent).not.toContain('No rows match the filters.');
  });

  it('keeps footer rows visible', () => {
    const container = renderTableContent([
      <thead key="head">
        <tr>
          <th>Item</th>
        </tr>
      </thead>,
      <tbody key="body">
        <tr>
          <td>Alpha</td>
        </tr>
      </tbody>,
      <tfoot key="foot">
        <tr>
          <td>Total</td>
        </tr>
      </tfoot>,
    ]);

    expect(rowTexts(container)).toEqual(['Alpha', 'Total']);
  });

  it('parses direct table row children', () => {
    const container = renderTableContent([
      <tr key="head">
        <th>Team</th>
        <th>Score</th>
      </tr>,
      <tr key="alpha">
        <td>Alpha</td>
        <td>10</td>
      </tr>,
    ]);

    expect(container.textContent).toContain('Quick copy');
    expect(rowTexts(container)).toEqual(['Alpha|10']);
  });

  it('localizes the new controls', () => {
    const container = renderTable('zh-CN');

    expect(container.textContent).toContain('快捷复制');
    expect(container.textContent).toContain('详情');
    click(button(container, '筛选 Team'));
    expect(container.textContent).toContain('隐藏列');
  });
});
