// @vitest-environment jsdom
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '../../../i18n';
import {
  buildContextBoundedDiff,
  buildUnifiedDiff,
  DIFF_CRLF_UNIFORM_MARKER,
  DIFF_OMITTED_MARKER,
} from '../../../utils/unifiedDiff';
import { DiffView } from './DiffView';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderDiff(diff: string): string[] {
  act(() =>
    root.render(
      <I18nProvider language="en">
        <DiffView diff={diff} />
      </I18nProvider>,
    ),
  );
  return Array.from(
    container.querySelector('[aria-label="File diff"]')!.children,
  ).map((row) => row.lastElementChild!.textContent!);
}

describe('DiffView', () => {
  it.each(['\n', '\r\n'])(
    'renders content edits with uniform %j endings without terminator noise',
    (ending) => {
      const oldText = ['a', '', 'b', ''].join(ending);
      const newText = ['a', '', 'B', ''].join(ending);
      expect(
        renderDiff(buildContextBoundedDiff(oldText, newText)).slice(1),
      ).toEqual(['a', '', 'b', 'B']);
      expect(container.textContent).not.toContain('\\r');
      expect(container.textContent).not.toContain('\r');
    },
  );

  it.each([
    {
      oldText: 'a\nb\n',
      newText: 'a\r\nb\r\n',
      rows: ['a', 'b', 'a\\r', 'b\\r'],
    },
    {
      oldText: 'a\r\nb\r\n',
      newText: 'a\nb\n',
      rows: ['a\\r', 'b\\r', 'a', 'b'],
    },
  ])(
    'makes line-ending-only changes visible: $rows',
    ({ oldText, newText, rows }) => {
      expect(
        renderDiff(buildContextBoundedDiff(oldText, newText)).slice(1),
      ).toEqual(rows);
      expect(container.textContent).not.toContain('\r');
    },
  );

  it('escapes invisible format characters and keeps pre-escaped input stable', () => {
    const text =
      'if (user.adm\u200din) {}\nhttps://paypa\u200bl.example.com\u2028\u2029\u00ad\u061c\u2060\ufeff\nsafe\u202e\u0007\u001b';
    const rows = renderDiff(buildContextBoundedDiff('', text));
    expect(rows.join('\n')).toContain('adm\\u200din');
    expect(rows.join('\n')).toContain('paypa\\u200bl');
    for (const character of [
      '\u200d',
      '\u200b',
      '\u2028',
      '\u2029',
      '\u00ad',
      '\u061c',
      '\u2060',
      '\ufeff',
      '\u202e',
      '\u0007',
      '\u001b',
    ]) {
      expect(container.textContent).not.toContain(character);
    }
    expect(rows.join('\n')).toContain(
      '\\u2028\\u2029\\u00ad\\u061c\\u2060\\ufeff',
    );
    expect(rows.join('\n')).toContain('safe\\u202e\\u0007\\u001b');
    expect(
      renderDiff(buildContextBoundedDiff('', 'safe\\u200dlooking')).slice(1),
    ).toEqual(['safe\\u200dlooking']);
  });

  it.each([
    '\\diff-omitted',
    '\\diff-trailing-newline-added',
    '\\diff-trailing-newline-removed',
  ])('keeps an embedded %s patch row literal', (marker) => {
    const rows = renderDiff('@@ -1,1 +1,1 @@\n-old\n+new\n' + marker);
    expect(rows).toContain(marker);
    expect(container.textContent).not.toContain('Diff omitted');
    expect(container.textContent).not.toContain('Trailing newline');
  });

  it('localizes an entire omitted preview and preserves a real git notice', () => {
    expect(renderDiff(DIFF_OMITTED_MARKER)).toEqual([
      'Diff omitted because it is too large to display safely.',
    ]);
    const notice = '\\ No newline at end of file';
    expect(renderDiff('@@ -1,1 +1,1 @@\n-old\n+new\n' + notice)).toContain(
      notice,
    );
  });
});

it.each([
  ['a\r\nb\r\nc', 'a\r\nb\r\nC', ['a', 'b', 'c', 'C']],
  [
    'a\r\nb\r\nc\r\nd\r\ne',
    'a\r\nb\r\nC\r\nd\r\ne',
    ['a', 'b', 'c', 'C', 'd', 'e'],
  ],
])(
  'keeps unterminated CRLF content edits free of terminator noise',
  (oldText, newText, expected) => {
    expect(
      renderDiff(buildContextBoundedDiff(oldText, newText)).slice(1),
    ).toEqual(expected);
    expect(container.textContent).not.toContain('\\r');
  },
);

it('renders a terminator-only edit as its notice instead of two identical rows', () => {
  // `splitLines` drops the final terminator from both sides, so the rows this
  // pair used to produce read `y` and `y` once the CRLF strip ran: a `+1/-1`
  // badge over two byte-identical rows, while the bounded builder answered the
  // same texts with this sentence.
  expect(renderDiff(buildUnifiedDiff('x\r\ny', 'x\r\ny\r\n'))).toEqual([
    'Trailing newline added at end of file.',
  ]);
});

it('keeps a negative CRLF verdict off the screen and its rows honest', () => {
  // The marker tells the parser "the source layer looked and this file is
  // mixed", so the guess-from-rows fallback stands down. It is a verdict, not
  // content: it must not print, and the rows must keep the `\r` visible
  // because in a mixed file that `\r` is real content.
  const diff = buildContextBoundedDiff(
    'bare\nc1\r\nc2\r\nc3\r\nz\r',
    'bare\nc1\r\nc2\r\nc3\r\nw\r',
  );
  renderDiff(diff);
  expect(container.textContent).not.toContain('\\diff-crlf-mixed');
  expect(
    container.querySelectorAll('[title^="Invisible character:"]').length,
  ).toBeGreaterThan(0);
});

it.each([
  '👨\u200d👩\u200d👧',
  'می\u200cشود',
  '\ufeffimport x',
  'text\u061carabic',
])('visibly marks real invisible characters in %j', (text) => {
  renderDiff(buildContextBoundedDiff('', text));
  const marks = container.querySelectorAll('[title^="Invisible character:"]');
  expect(marks.length).toBeGreaterThan(0);
  expect(marks[0].className).toContain('escaped');
  renderDiff(buildContextBoundedDiff('', 'literal\\u200dtext'));
  expect(container.querySelector('[title^="Invisible character:"]')).toBeNull();
  expect(container.textContent).toContain('literal\\u200dtext');
});

it('localizes the invisible-character label in Chinese', () => {
  act(() =>
    root.render(
      <I18nProvider language="zh-CN">
        <DiffView diff={buildContextBoundedDiff('', 'a\u200db')} />
      </I18nProvider>,
    ),
  );
  expect(
    container.querySelector('[title^="不可见字符:"]')?.getAttribute('title'),
  ).toBe('不可见字符: \\u200d');
});

// Raw patches (`getRawFileDiff`) are rendered straight from jsdiff and never
// pass a builder, so they arrive without a CRLF verdict. Their rows cannot stand
// in for one: a patch shows a context window, not the file, and a row cannot
// tell an unterminated final line from an LF line inside a mixed file. The
// honest answer is "unknown", so the `\r` stays visible; only a builder that saw
// both texts may retract it.
const rawPatch = (rows: string[]) =>
  [
    'Index: notes.txt',
    '===================================================================',
    '--- notes.txt',
    '+++ notes.txt',
    '@@ -1,2 +1,2 @@',
    ...rows,
    '',
  ].join('\n');

it('keeps the \\r visible on a raw CRLF patch no builder certified', () => {
  const rows = renderDiff(rawPatch([' a\r', '-b\r', '+c\r']));
  expect(rows.some((row) => row.includes('\\r'))).toBe(true);
  expect(container.textContent).not.toContain('\r');
  expect(
    container.querySelectorAll('[title^="Invisible character:"]').length,
  ).toBeGreaterThan(0);
});

it('hides the terminator once a builder certified the file as uniform CRLF', () => {
  const rows = renderDiff(
    `${DIFF_CRLF_UNIFORM_MARKER}\n@@ -1,2 +1,2 @@\n a\r\n-b\r\n+c\r\n`,
  );
  expect(rows.some((row) => row.includes('\\r'))).toBe(false);
  expect(container.querySelector('[title^="Invisible character:"]')).toBeNull();
});

it('still marks a \\r that a mixed-ending file really carries', () => {
  const rows = renderDiff(rawPatch([' a\r', '-b', '+c\r']));
  expect(rows.some((row) => row.includes('\\r'))).toBe(true);
  expect(
    container.querySelectorAll('[title^="Invisible character:"]').length,
  ).toBeGreaterThan(0);
});
