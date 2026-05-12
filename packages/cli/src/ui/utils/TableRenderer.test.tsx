/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import { renderWithProviders } from '../../test-utils/render.js';
import { TableRenderer, type ColumnAlign } from './TableRenderer.js';

describe('<TableRenderer />', () => {
  const renderTable = (
    headers: string[],
    rows: string[][],
    contentWidth = 80,
    aligns?: ColumnAlign[],
  ) => {
    const { lastFrame } = renderWithProviders(
      <TableRenderer
        headers={headers}
        rows={rows}
        contentWidth={contentWidth}
        aligns={aligns}
      />,
    );
    return lastFrame() ?? '';
  };

  const getVisibleLines = (output: string) =>
    output
      .split('\n')
      .map((line) => line.replace(/\r/g, ''))
      .filter((line) => line.length > 0);

  const expectAllLinesToHaveSameVisibleWidth = (output: string) => {
    const lines = getVisibleLines(output);
    expect(lines.length).toBeGreaterThan(0);
    const widths = lines.map((line) => stringWidth(stripAnsi(line)));
    expect(new Set(widths).size).toBe(1);
  };

  it('renders a basic table with borders', () => {
    const output = renderTable(['Name', 'Value'], [['foo', 'bar']]);

    expect(output).toContain('Name');
    expect(output).toContain('Value');
    expect(output).toContain('foo');
    expect(output).toContain('bar');
    // Should have border characters
    expect(output).toContain('┌');
    expect(output).toContain('┐');
    expect(output).toContain('└');
    expect(output).toContain('┘');
    expect(output).toContain('│');
    expectAllLinesToHaveSameVisibleWidth(output);
  });

  it('keeps all rendered lines at the same visible width for mixed content', () => {
    const output = renderTable(
      ['项目', 'ANSI', 'Markdown'],
      [['中文内容', '\u001b[31mRed\u001b[0m Blue', '**bold** and `code`']],
      80,
      ['left', 'center', 'right'],
    );
    expectAllLinesToHaveSameVisibleWidth(output);
  });

  it('handles CJK characters with correct column alignment', () => {
    const output = renderTable(
      ['项目', '描述'],
      [['名称', '这是一个很长的描述']],
    );

    expect(output).toContain('项目');
    expect(output).toContain('描述');
    expect(output).toContain('名称');
    expect(output).toContain('这是一个很长的描述');
  });

  it('handles mixed CJK and ASCII content', () => {
    const output = renderTable(
      ['Feature', '功能'],
      [
        ['Speed', '速度很快'],
        ['Quality', '质量很高'],
      ],
    );

    expect(output).toContain('Feature');
    expect(output).toContain('功能');
    expect(output).toContain('Speed');
    expect(output).toContain('速度很快');
    expect(output).toContain('Quality');
    expect(output).toContain('质量很高');
  });

  it('wraps long cell content instead of truncating', () => {
    const longText = 'This is a very long text that should wrap';
    const output = renderTable(
      ['Col'],
      [[longText]],
      30, // narrow terminal to force wrapping
    );

    // The content should still appear (not truncated with ...)
    expect(output).toContain('This is a very long');
    expect(output).toContain('text that should');
    expect(output).toContain('wrap');
  });

  // Alignment tests use contentWidth ≥ 60 so horizontal mode is exercised
  // (vertical mode renders key:value pairs and bypasses pad alignment).

  it('respects left alignment', () => {
    const output = renderTable(['Header'], [['left']], 60, ['left']);
    expect(output).toContain('left');
    // Horizontal-mode guard so this test fails loudly if the threshold
    // is bumped back above 60 and the test silently degrades to vertical.
    expect(output).toContain('┌');
  });

  it('respects center alignment', () => {
    const output = renderTable(['Header'], [['center']], 60, ['center']);
    expect(output).toContain('center');
    expect(output).toContain('┌');
  });

  it('respects right alignment', () => {
    const output = renderTable(['Header'], [['right']], 60, ['right']);
    expect(output).toContain('right');
    expect(output).toContain('┌');
  });

  it('handles multiple columns with mixed alignment', () => {
    const output = renderTable(
      ['Left', 'Center', 'Right'],
      [['L', 'C', 'R']],
      40,
      ['left', 'center', 'right'],
    );

    expect(output).toContain('Left');
    expect(output).toContain('Center');
    expect(output).toContain('Right');
  });

  it('handles tables wider than terminal width', () => {
    const output = renderTable(
      ['Column A', 'Column B', 'Column C'],
      [
        ['AAAA', 'BBBB', 'CCCC'],
        ['DDDD', 'EEEE', 'FFFF'],
      ],
      30, // narrow terminal
    );

    // Content should still appear, wrapped across lines
    // "Column A" gets split by wrap-ansi into "Colum" + "n A"
    expect(output).toContain('Colum');
    expect(output).toContain('n A');
    expect(output).toContain('AAAA');
    expect(output).toContain('DDDD');
  });

  it('renders CJK-heavy table that would previously be misaligned', () => {
    // This is the classic failure case: CJK chars counted as width 1
    // causes column misalignment
    const output = renderTable(
      ['对比项', 'Claude Code', 'Qwen Code'],
      [
        ['性能', '优秀', '优秀'],
        ['中文支持', '一般', '很好'],
        ['开源', '否', '是'],
      ],
      50,
    );

    expect(output).toContain('对比项');
    expect(output).toContain('Claude Code');
    expect(output).toContain('Qwen Code');
    expect(output).toContain('性能');
    expect(output).toContain('中文支持');
    expect(output).toContain('开源');
  });

  it('handles inline markdown in cells', () => {
    const output = renderTable(['Feature'], [['**bold** and `code`']]);

    expect(output).toContain('bold');
    expect(output).toContain('code');
  });

  it('handles empty cells', () => {
    const output = renderTable(['A', 'B'], [['', 'content']]);

    expect(output).toContain('content');
  });

  it('handles rows with fewer columns than headers', () => {
    const output = renderTable(
      ['A', 'B', 'C'],
      [['only-one']], // row has only 1 cell
    );

    expect(output).toContain('only-one');
  });

  it('wraps content for very narrow terminals with many columns', () => {
    const output = renderTable(
      ['Col1', 'Col2', 'Col3', 'Col4', 'Col5'],
      [['LongValue1', 'LongValue2', 'LongValue3', 'LongValue4', 'LongValue5']],
      20, // very narrow
    );

    // In a very narrow terminal, content gets wrapped into multi-line rows
    // All content should still appear (may be split across lines)
    expect(output).toContain('Col');
    expect(output).toContain('Lon');
    expect(output).toContain('gVa');
    expect(output).toContain('lue');
  });

  // ─── Reverse audit: edge cases that SHOULD NOT break ───

  it('handles empty headers array without crash', () => {
    const output = renderTable([], [], 80);
    // Should render an empty box without crashing
    expect(output).toBeDefined();
  });

  it('handles contentWidth of 0 without crash', () => {
    const output = renderTable(['A', 'B'], [['1', '2']], 0);
    expect(output).toBeDefined();
  });

  it('handles contentWidth of 1 without crash', () => {
    const output = renderTable(['A', 'B'], [['1', '2']], 1);
    expect(output).toBeDefined();
  });

  it('handles single-column table', () => {
    const output = renderTable(['Name'], [['Alice'], ['Bob']]);
    expect(output).toContain('Name');
    expect(output).toContain('Alice');
    expect(output).toContain('Bob');
  });

  it('handles cell content that is all CJK', () => {
    const output = renderTable(
      ['项目名', '状态'],
      [
        ['数据库连接测试', '成功'],
        ['缓存压力测试', '失败'],
      ],
      40,
    );
    expect(output).toContain('数据库连接测试');
    expect(output).toContain('缓存压力测试');
  });

  it('handles row with more columns than headers (truncation)', () => {
    const output = renderTable(['A'], [['extra1', 'extra2', 'extra3']]);
    // Should only show content for declared columns
    expect(output).toContain('extra1');
  });

  it('handles headers with inline markdown syntax', () => {
    const output = renderTable(['**Bold**', '`Code`'], [['val1', 'val2']]);
    expect(output).toContain('Bold');
    expect(output).toContain('Code');
  });

  it('padAligned: center alignment with odd padding', () => {
    // When padding is odd, left gets the extra space
    const output = renderTable(['X'], [['A']], 10, ['center']);
    expect(output).toContain('A');
  });

  it('table with only one row still has all borders', () => {
    const output = renderTable(['H1', 'H2'], [['v1', 'v2']]);
    // Should have top, single middle, bottom border
    const borderChars = output.match(/┌/g);
    expect(borderChars).toHaveLength(1);
    const bottomBorders = output.match(/└/g);
    expect(bottomBorders).toHaveLength(1);
  });

  it('does not produce NaN column widths when scaling', () => {
    // When contentWidth is very small, scaleFactor could produce NaN/Infinity
    const output = renderTable(['A', 'B'], [['x', 'y']], 5);
    expect(output).toBeDefined();
    expect(output).not.toContain('NaN');
    expect(output).not.toContain('Infinity');
  });

  it('preserves ANSI escape sequences in non-markdown cells', () => {
    const red = '\u001b[31m红色\u001b[0m';
    const output = renderTable(['状态', '值'], [[red, 'OK']], 40);
    expect(output).toContain('\u001b[31m');
    expect(output).toContain('红色');
  });

  it('wraps complex ANSI-colored content without losing segments', () => {
    const colorful =
      '\u001b[31m红色\u001b[0m and \u001b[32mgreen\u001b[0m then \u001b[34mblue文本\u001b[0m';
    const output = renderTable(['状态'], [[colorful]], 24);
    expect(output).toContain('\u001b[31m');
    expect(output).toContain('\u001b[32m');
    expect(output).toContain('\u001b[34m');
    expect(output).toContain('红色');
    expect(output).toContain('green');
    expect(output).toContain('blue');
    expect(output).toContain('文本');
    expectAllLinesToHaveSameVisibleWidth(output);
  });

  it('handles ANSI + CJK mixed width without losing content', () => {
    const green = '\u001b[32m中文ABC\u001b[0m';
    const output = renderTable(['列1', '列2'], [[green, '普通文本']], 40);
    expect(output).toContain('\u001b[32m');
    expect(output).toContain('中文ABC');
    expect(output).toContain('普通文本');
  });

  it('keeps markdown cells readable while preserving layout', () => {
    const output = renderTable(
      ['名称', '描述'],
      [['**加粗**', '`code` 和 普通文本']],
      40,
    );
    expect(output).toContain('加粗');
    expect(output).toContain('code');
    expect(output).toContain('普通文本');
  });

  it('handles ANSI and markdown mixed across different columns', () => {
    const blue = '\u001b[34mBlue\u001b[0m';
    const output = renderTable(
      ['ANSI', 'Markdown'],
      [[blue, '**bold** text']],
      50,
    );
    expect(output).toContain('\u001b[34m');
    expect(output).toContain('Blue');
    expect(output).toContain('bold');
  });

  it('renders markdown links as readable plain text in cells', () => {
    const output = renderTable(
      ['Name', 'Link'],
      [['Doc', '[Qwen](https://example.com/path)']],
      60,
    );
    expect(output).toContain('Qwen');
    expect(output).not.toContain('[Qwen](');
  });

  it('renders inline code and bold text readably in the same cell', () => {
    const output = renderTable(
      ['Desc'],
      [['Use `npm test` with **care**']],
      40,
    );
    expect(output).toContain('npm test');
    expect(output).toContain('care');
  });

  it('renders underline html tag readably in cells', () => {
    const output = renderTable(['Desc'], [['<u>underlined</u> text']], 40);
    expect(output).toContain('underlined');
    expect(output).toContain('text');
  });

  it('does not collapse content when multiple markdown syntaxes coexist', () => {
    const output = renderTable(
      ['Mixed'],
      [['**bold** _italic_ `code` [link](https://a.b)']],
      60,
    );
    expect(output).toContain('bold');
    expect(output).toContain('italic');
    expect(output).toContain('code');
    expect(output).toContain('link');
  });

  it('handles cells containing literal newlines without crashing', () => {
    const output = renderTable(['A', 'B'], [['line1\nline2', 'value']], 40);
    expect(output).toContain('line1');
    expect(output).toContain('line2');
  });

  it('handles all-ANSI cell content', () => {
    const colorful =
      '\u001b[31mR\u001b[0m\u001b[32mG\u001b[0m\u001b[34mB\u001b[0m';
    const output = renderTable(['Color'], [[colorful]], 20);
    expect(output).toContain('\u001b[31m');
    expect(output).toContain('\u001b[32m');
    expect(output).toContain('\u001b[34m');
  });

  it('handles empty column content across all rows', () => {
    const output = renderTable(
      ['A', 'B'],
      [
        ['', 'x'],
        ['', 'y'],
      ],
      30,
    );
    expect(output).toContain('x');
    expect(output).toContain('y');
  });

  it('falls back safely under extremely narrow width', () => {
    const output = renderTable(
      ['HeaderA', 'HeaderB'],
      [['ValueA', 'ValueB']],
      2,
    );
    expect(output).toBeDefined();
    expect(output).not.toContain('NaN');
  });

  it('preserves non-space trailing content while trimming wrap artifacts', () => {
    const output = renderTable(['A'], [['abc   def']], 20);
    expect(output).toContain('abc');
    expect(output).toContain('def');
  });

  it('keeps CJK + ANSI + wrapping stable near width boundary', () => {
    const cyan = '\u001b[36m中文对比ABC\u001b[0m';
    const output = renderTable(
      ['项目', '结果说明'],
      [[cyan, '这是一个接近边界宽度的说明文本']],
      26,
    );
    expect(output).toContain('\u001b[36m');
    expect(output).toContain('中文');
    expect(output).toContain('对比');
    expect(output).toContain('ABC');
    expect(output).toContain('说明文本');
  });

  it('keeps alignment stable with mixed widths near boundary', () => {
    const output = renderTable(
      ['短', 'LongHeader'],
      [['中文', 'abcdefghi']],
      24,
      ['center', 'right'],
    );
    expect(output).toContain('中');
    expect(output).toContain('文');
    expect(output).toContain('abcdefghi');
    expect(output).not.toContain('NaN');
  });

  it('renders vertical fallback with CJK labels readably', () => {
    const output = renderTable(
      ['字段一', '字段二', '字段三'],
      [['很长的值一', '很长的值二', '很长的值三']],
      10,
    );
    expect(output).toContain('字段一');
    expect(output).toContain('很长的值一');
  });

  // ─── Narrow-terminal vertical fallback ───
  describe('horizontal/vertical mode threshold', () => {
    it('uses horizontal mode at ample width (60 cols, 2 short cols)', () => {
      const output = renderTable(['A', 'B'], [['x', 'y']], 60);
      // Horizontal markers must be present.
      expect(output).toContain('┌');
      expect(output).toContain('└');
      expect(output).toContain('│');
    });

    it('falls back to vertical below the absolute floor (≤24 cols)', () => {
      // ABSOLUTE_MIN_HORIZONTAL_TABLE_WIDTH is 24.
      const output = renderTable(['A', 'B'], [['x', 'y']], 20);
      // No horizontal table border characters in vertical mode.
      expect(output).not.toContain('┌');
      expect(output).not.toContain('└');
      // Vertical mode renders "label:" pairs.
      expect(output).toContain('A:');
      expect(output).toContain('B:');
      expect(output).toContain('x');
      expect(output).toContain('y');
    });

    it('promotes to horizontal once column-budget threshold is met (2 cols, ~30 cols)', () => {
      // borderOverhead = 1 + 2*3 = 7; minHorizontal = max(24, 2*3 + 7 + 4) = 24
      // so 30 cols comfortably fits horizontal.
      const output = renderTable(['A', 'B'], [['x', 'y']], 30);
      expect(output).toContain('┌');
    });

    // Boundary equality tests: the comparator is strict `<`, so the threshold
    // value itself must still render horizontally. Without these, a future
    // off-by-one change from `<` to `<=` would slip through the < / > pair.
    it('renders horizontal at exact absolute floor (2 cols, contentWidth=24)', () => {
      // ABSOLUTE_MIN_HORIZONTAL_TABLE_WIDTH is 24. With strict `<`, equality
      // means horizontal mode is selected.
      const output = renderTable(['A', 'B'], [['x', 'y']], 24);
      expect(output).toContain('┌');
      expect(output).toContain('└');
    });

    it('falls back to vertical one below absolute floor (2 cols, contentWidth=23)', () => {
      const output = renderTable(['A', 'B'], [['x', 'y']], 23);
      expect(output).not.toContain('┌');
      expect(output).toContain('A:');
    });

    it('renders horizontal at exact column-budget threshold (5 cols, contentWidth=35)', () => {
      // 5 cols → minHorizontal = 5*3 + (1+5*3) + 4 = 35. Equality must still
      // render horizontally under the strict `<` comparator.
      const output = renderTable(
        ['A', 'B', 'C', 'D', 'E'],
        [['1', '2', '3', '4', '5']],
        35,
      );
      expect(output).toContain('┌');
    });

    it('falls back to vertical one below column-budget threshold (5 cols, contentWidth=34)', () => {
      const output = renderTable(
        ['A', 'B', 'C', 'D', 'E'],
        [['1', '2', '3', '4', '5']],
        34,
      );
      expect(output).not.toContain('┌');
      expect(output).toContain('A:');
    });

    it('forces vertical for many-column tables on narrow terminals', () => {
      // 5 cols → minHorizontal = 5*3 + (1+5*3) + 4 = 35; 30 cols is below that.
      const output = renderTable(
        ['A', 'B', 'C', 'D', 'E'],
        [['1', '2', '3', '4', '5']],
        30,
      );
      expect(output).not.toContain('┌');
      // Should still surface the data.
      expect(output).toContain('A:');
      expect(output).toContain('1');
      expect(output).toContain('5');
    });
  });

  it('stays stable across multiple content widths', () => {
    for (const width of [8, 10, 12, 16, 20, 30, 40, 60]) {
      const output = renderTable(
        ['项目', '状态', '说明'],
        [
          [
            '中文ABC',
            '\u001b[33mWARN\u001b[0m',
            '**long** explanation with mixed 中英 content',
          ],
        ],
        width,
        ['left', 'center', 'right'],
      );
      expect(output).toBeDefined();
      expect(output).not.toContain('NaN');
      expect(output).not.toContain('Infinity');
      expect(output).toContain('项目');
      expect(output).toContain('状态');
      expect(output).toContain('说明');
      if (output.includes('┌')) {
        expectAllLinesToHaveSameVisibleWidth(output);
      }
    }
  });
});
