/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { ViewSurface } from './surface.js';

function harness(html: string) {
  const frame = document.createElement('iframe');
  document.body.replaceChildren(frame);
  const content = frame.contentDocument!;
  const onEvent = vi.fn();
  const onError = vi.fn();
  const surface = new ViewSurface(frame, onEvent, onError);
  surface.attach(content, html, 'body { color: black }');
  return { surface, frame, content, onEvent, onError };
}

describe('generated markup display', () => {
  it('preserves valid common IDs without exposing named DOM properties to the renderer', () => {
    const ids = [
      'reset',
      'submit',
      'action',
      'title',
      'name',
      'style',
      'length',
      'constructor',
      'body',
      'head',
      'getElementById',
    ];
    const h = harness(
      ids.map((id) => `<button id="${id}">${id}</button>`).join('') +
        '<form id="createElement"><input name="querySelectorAll" id="value"></form>',
    );
    for (const id of ids) {
      const button = h.content.getElementById(id)!;
      expect(button?.id).toBe(id);
      button.dispatchEvent(new Event('click', { bubbles: true }));
      expect(h.onEvent.mock.lastCall?.[0].id).toBe(id);
      h.surface.apply([{ kind: 'text', id, value: 'Updated' }]);
      expect(button.textContent).toBe('Updated');
    }
    expect(h.content.querySelector('form')).toBeNull();
    expect(h.content.body.tagName).toBe('BODY');
    expect(h.content.head.tagName).toBe('HEAD');
    expect(typeof h.content.createElement).toBe('function');
    expect(typeof h.content.querySelectorAll).toBe('function');
  });

  it('removes active content, external sources and handler attributes in initial and updated markup', () => {
    const h = harness(
      '<div id="view"><script>parent.pwned=1</script><input id="rate" value="3" oninput="parent.pwned=1">' +
        '<iframe src="https://example.invalid"></iframe><a href="javascript:alert(1)">link</a>' +
        '<svg><foreignObject><iframe src="/session"></iframe></foreignObject><use href="/secret"/></svg>' +
        '<img src="/secret"><form action="/session"><button id="go" formaction="/session">Go</button></form></div>',
    );
    expect(
      h.content.querySelector('script,iframe,a,img,form,foreignObject,use'),
    ).toBeNull();
    expect(
      h.content.querySelector('[oninput],[formaction],[href],[src]'),
    ).toBeNull();
    h.surface.apply([
      {
        kind: 'html',
        id: 'view',
        value:
          '<p id="out" onclick="alert(1)">Safe</p><script>alert(1)</script>',
      },
    ]);
    expect(h.content.getElementById('out')?.textContent).toBe('Safe');
    expect(h.content.querySelector('script,[onclick]')).toBeNull();
  });

  it('delegates current input state and nested button clicks without invoking host actions', () => {
    const h = harness(
      '<input id="rate" value="3"><input id="enabled" type="checkbox" checked><button id="go"><span>Calculate</span></button><output id="out"></output>',
    );
    const input = h.content.getElementById('rate') as HTMLInputElement;
    input.value = '7';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(h.onEvent).toHaveBeenLastCalledWith({
      id: 'rate',
      type: 'input',
      value: '7',
      checked: false,
    });
    expect(h.surface.inputs()).toEqual({
      rate: { value: '7', checked: false },
      enabled: { value: 'on', checked: true },
    });
    h.content
      .querySelector('span')!
      .dispatchEvent(new Event('click', { bubbles: true }));
    expect(h.onEvent.mock.lastCall?.[0].id).toBe('go');
    h.surface.apply([
      { kind: 'text', id: 'out', value: '<script>text only</script>' },
      { kind: 'value', id: 'rate', value: '9' },
    ]);
    expect(h.content.getElementById('out')?.textContent).toBe(
      '<script>text only</script>',
    );
    expect(h.surface.inputs()['rate'].value).toBe('9');
    expect(h.content.querySelector('script')).toBeNull();
  });

  it('keeps a declared maxlength and bounds undeclared controls at 2048', () => {
    const h = harness(
      '<input id="tight" maxlength="5"><input id="loose"><input id="wide" maxlength="5000"><textarea id="notes" maxlength="200"></textarea><input id="zero" maxlength="0"><textarea id="invalid" maxlength="-1"></textarea><output id="out"></output>',
    );
    const lengths = () =>
      Object.fromEntries(
        Array.from(
          h.content.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
            'input,textarea',
          ),
          (control) => [control.id, control.maxLength],
        ),
      );
    const expected = {
      tight: 5,
      loose: 2048,
      wide: 2048,
      notes: 200,
      zero: 0,
      invalid: 2048,
    };
    expect(lengths()).toEqual(expected);
    h.surface.apply([{ kind: 'text', id: 'out', value: 'Updated' }]);
    expect(lengths()).toEqual(expected);
  });

  it('renders the checked radio the markup declares', () => {
    const h = harness(
      '<input type="radio" name="plan" id="plan-a" value="a"><input type="radio" name="plan" id="plan-b" value="b" checked><input id="alone" type="radio" name="solo" checked><div id="dynamic"></div><output id="out"></output>',
    );
    expect(h.surface.inputs()['plan-b'].checked).toBe(true);
    expect(h.surface.inputs()['plan-a'].checked).toBe(false);
    expect(h.surface.inputs()['alone'].checked).toBe(true);
    (h.content.getElementById('plan-a') as HTMLInputElement).click();
    h.surface.apply([{ kind: 'text', id: 'out', value: 'Updated' }]);
    expect(h.surface.inputs()['plan-a'].checked).toBe(true);
    expect(h.surface.inputs()['plan-b'].checked).toBe(false);
    h.surface.apply([
      {
        kind: 'html',
        id: 'dynamic',
        value:
          '<input id="newA" type="radio" name="new"><input id="newB" type="radio" name="new" checked>',
      },
    ]);
    expect(h.surface.inputs()['newA'].checked).toBe(false);
    expect(h.surface.inputs()['newB'].checked).toBe(true);
    (h.content.getElementById('newA') as HTMLInputElement).click();
    expect(h.surface.inputs()['newA'].checked).toBe(true);
    expect(h.surface.inputs()['newB'].checked).toBe(false);
    expect(h.surface.inputs()['plan-a'].checked).toBe(true);
  });

  it('keeps a newer checkbox edit and all outputs when old markup would replace it', () => {
    const h = harness(
      '<div id="controls"><input id="enabled" type="checkbox"></div><output id="out">Original</output>',
    );
    const before = h.surface.inputs();
    const checkbox = h.content.getElementById('enabled') as HTMLInputElement;
    checkbox.checked = true;
    h.surface.apply(
      [
        { kind: 'text', id: 'out', value: 'Stale' },
        {
          kind: 'html',
          id: 'controls',
          value: '<input id="enabled" type="checkbox">',
        },
      ],
      before,
    );
    expect(h.content.getElementById('enabled')).toBe(checkbox);
    expect(h.surface.inputs()['enabled'].checked).toBe(true);
    expect(h.content.getElementById('out')?.textContent).toBe('Original');
  });

  it('rejects duplicate IDs, unsupported controls and excessive markup or input data', () => {
    expect(() => harness('<div id="same"></div><input id="same">')).toThrow(
      /unique/,
    );
    expect(() => harness('<input id="upload" type="file">')).toThrow(
      /input type/,
    );
    expect(() =>
      harness(
        '<select id="multi" multiple><option value="a">A</option></select>',
      ),
    ).toThrow(/input type/);
    expect(() => harness('<input>')).toThrow(/unique ID/);
    expect(() => harness('<span></span>'.repeat(513))).toThrow(/elements/);
    const h = harness('<input id="value">');
    (h.content.getElementById('value') as HTMLInputElement).value = 'x'.repeat(
      2049,
    );
    expect(() => h.surface.inputs()).toThrow(/too long/);
  });

  it('delegates an ID-less button click to its identified container', () => {
    const h = harness(
      '<div id="actions"><button><span>Go</span></button></div>',
    );
    h.content
      .querySelector('span')!
      .dispatchEvent(new Event('click', { bubbles: true }));
    expect(h.onEvent).toHaveBeenCalledWith({
      id: 'actions',
      type: 'click',
      value: '',
      checked: false,
    });
  });

  it.each([
    ['text', (value: string) => `<input id="field" value="${value}">`, 'x'],
    [
      'textarea',
      (value: string) => `<textarea id="field">${value}</textarea>`,
      'x',
    ],
    [
      'number',
      (value: string) => `<input id="field" type="number" value="${value}">`,
      'number',
    ],
    [
      'select',
      (value: string) =>
        `<select id="field"><option value="${value}">Choice</option></select>`,
      'x',
    ],
  ])('validates %s values when accepting markup', (_kind, markup, format) => {
    const value = (length: number) =>
      format === 'number' ? `0.${'0'.repeat(length - 3)}1` : 'x'.repeat(length);
    const h = harness(markup(value(2048)));
    expect(h.surface.inputs()['field'].value).toHaveLength(2048);
    expect(() => harness(markup(value(2049)))).toThrow(/too long/);
  });

  it('rejects oversized values in unselected options', () => {
    expect(() =>
      harness(
        `<select id="field"><option value="ok">Initial</option><option value="${'x'.repeat(2049)}">Later</option></select>`,
      ),
    ).toThrow(/too long/);
  });

  it('rejects combined input snapshots over the byte budget', () => {
    expect(() =>
      harness(
        `<div>${Array.from({ length: 9 }, (_, i) => `<input id="field${i}" value="${'界'.repeat(650)}">`).join('')}</div>`,
      ),
    ).toThrow(/input limit/);
  });

  it.each([
    ['duplicate ID', '<div id="view">Duplicate</div>', /unique/],
    ['invalid ID', '<div id="1bad"></div>', /unique/],
    ['unsupported input', '<input id="upload" type="file">', /input type/],
    ['multiple select', '<select id="multi" multiple></select>', /input type/],
    [
      'input count',
      Array.from({ length: 65 }, (_, i) => `<input id="field${i}">`).join(''),
      /too many inputs/,
    ],
    [
      'long number',
      `<input id="number" type="number" value="0.${'0'.repeat(2046)}1">`,
      /too long/,
    ],
  ])(
    'keeps the whole batch unchanged when rejecting %s',
    (_name, html, error) => {
      const h = harness(
        '<div id="view">Original</div><div id="other"></div><input id="rate" value="3"><button id="go">Go</button>',
      );
      const input = h.content.getElementById('rate') as HTMLInputElement;
      input.value = '7';
      expect(() =>
        h.surface.apply([
          { kind: 'value', id: 'rate', value: '10' },
          { kind: 'text', id: 'view', value: 'Changed' },
          { kind: 'html', id: 'other', value: html },
        ]),
      ).toThrow(error);
      expect(h.content.getElementById('view')?.textContent).toBe('Original');
      expect(h.content.getElementById('other')?.childElementCount).toBe(0);
      expect(h.content.getElementById('rate')).toBe(input);
      expect(h.surface.inputs()['rate'].value).toBe('7');
      h.content
        .getElementById('go')!
        .dispatchEvent(new Event('click', { bubbles: true }));
      expect(h.onEvent.mock.lastCall?.[0].id).toBe('go');
      expect(h.onError).not.toHaveBeenCalled();
    },
  );

  it('rejects oversized text on a textarea without corrupting live input state', () => {
    const h = harness(
      '<textarea id="notes">Original</textarea><output id="out">Original</output>',
    );
    expect(() =>
      h.surface.apply([
        { kind: 'text', id: 'out', value: 'Changed' },
        { kind: 'text', id: 'notes', value: 'x'.repeat(3000) },
      ]),
    ).toThrow(/too long/);
    expect(h.surface.inputs()['notes'].value).toBe('Original');
    expect(h.content.getElementById('out')?.textContent).toBe('Original');
  });

  it('uses native text content without replacing a control value', () => {
    const h = harness(
      '<select id="opts"><option value="a">A</option></select><input id="num" type="number" value="3"><output id="out"></output>',
    );
    h.surface.apply([{ kind: 'text', id: 'opts', value: 'None' }]);
    expect(h.content.querySelectorAll('#opts option')).toHaveLength(0);
    expect(h.surface.inputs()['opts'].value).toBe('');
    h.surface.apply([
      { kind: 'html', id: 'opts', value: '<option value="b">B</option>' },
      { kind: 'text', id: 'num', value: 'X' },
    ]);
    expect(h.surface.inputs()['opts'].value).toBe('b');
    expect(h.surface.inputs()['num'].value).toBe('3');
    h.content
      .getElementById('out')!
      .dispatchEvent(new Event('click', { bubbles: true }));
    expect(h.onEvent.mock.lastCall?.[0].id).toBe('out');
    expect(h.onError).not.toHaveBeenCalled();
  });

  it('preserves edited textarea values when replacing their default text', () => {
    const h = harness('<textarea id="notes">Initial</textarea>');
    const notes = h.content.getElementById('notes') as HTMLTextAreaElement;
    notes.value = 'User typed';
    h.surface.apply([{ kind: 'text', id: 'notes', value: 'Reset' }]);
    expect(notes.value).toBe('User typed');
    expect(notes.textContent).toBe('Reset');
    h.surface.apply([{ kind: 'text', id: 'notes', value: 'x'.repeat(3000) }]);
    expect(notes.textContent).toHaveLength(3000);
    expect(h.surface.inputs()['notes'].value).toBe('User typed');
  });

  it('validates the live option selection projected into a batch', () => {
    const h = harness(
      `<select id="s"><option value="${'y'.repeat(2000)}">Long</option><option value="b">B</option></select>` +
        Array.from(
          { length: 7 },
          (_, i) => `<textarea id="t${i}"></textarea>`,
        ).join('') +
        '<output id="out"></output>',
    );
    (h.content.getElementById('s') as HTMLSelectElement).selectedIndex = 1;
    for (let i = 0; i < 7; i++) {
      (h.content.getElementById(`t${i}`) as HTMLTextAreaElement).value =
        'x'.repeat(2000);
    }
    h.surface.apply([{ kind: 'text', id: 'out', value: 'ok' }]);
    expect(h.content.getElementById('out')?.textContent).toBe('ok');
  });

  it('rejects a whole batch when its live selection exceeds the input budget', () => {
    const h = harness(
      `<select id="s"><option value="a">A</option><option value="${'y'.repeat(2000)}">Long</option></select>` +
        Array.from(
          { length: 7 },
          (_, i) => `<textarea id="t${i}"></textarea>`,
        ).join('') +
        '<output id="out">Original</output><output id="other">Original</output>',
    );
    (h.content.getElementById('s') as HTMLSelectElement).selectedIndex = 1;
    for (let i = 0; i < 7; i++) {
      (h.content.getElementById(`t${i}`) as HTMLTextAreaElement).value =
        'x'.repeat(2000);
    }
    expect(() =>
      h.surface.apply([
        { kind: 'text', id: 'out', value: 'Changed' },
        { kind: 'text', id: 'other', value: 'Changed' },
      ]),
    ).toThrow(/input limit/);
    expect(h.content.getElementById('out')?.textContent).toBe('Original');
    expect(h.content.getElementById('other')?.textContent).toBe('Original');
  });

  it('projects an unselected dropdown without charging its first option', () => {
    const h = harness(
      `<select id="s"><option value="${'y'.repeat(2048)}">Long</option></select>` +
        Array.from(
          { length: 7 },
          (_, i) => `<textarea id="t${i}"></textarea>`,
        ).join('') +
        '<output id="out"></output>',
    );
    h.surface.apply([{ kind: 'value', id: 's', value: 'missing' }]);
    const select = h.content.getElementById('s') as HTMLSelectElement;
    expect(select.selectedIndex).toBe(-1);
    for (let i = 0; i < 7; i++) {
      (h.content.getElementById(`t${i}`) as HTMLTextAreaElement).value =
        'x'.repeat(2000);
    }
    expect(h.surface.inputs()['s'].value).toBe('');
    h.surface.apply([{ kind: 'text', id: 'out', value: 'ok' }]);
    expect(h.content.getElementById('out')?.textContent).toBe('ok');
    expect(select.selectedIndex).toBe(-1);
    expect(h.onError).not.toHaveBeenCalled();
  });

  it('reports an over-limit live snapshot through the error channel', () => {
    const h = harness(
      Array.from(
        { length: 9 },
        (_, i) => `<textarea id="t${i}"></textarea>`,
      ).join(''),
    );
    for (let i = 0; i < 9; i++) {
      (h.content.getElementById(`t${i}`) as HTMLTextAreaElement).value =
        '界'.repeat(650);
    }
    h.content
      .getElementById('t0')!
      .dispatchEvent(new Event('input', { bubbles: true }));
    expect(h.onError).toHaveBeenCalledWith(
      'The view exceeded its input limit.',
    );
    expect(h.onEvent).not.toHaveBeenCalled();
  });

  it('validates implicit option values while allowing ordinary label and dropdown updates', () => {
    const h = harness(
      '<select id="choices"><option id="first">First</option></select><p id="out"></p>',
    );
    expect(() =>
      h.surface.apply([{ kind: 'text', id: 'first', value: 'x'.repeat(2049) }]),
    ).toThrow(/too long/);
    expect(h.surface.inputs()['choices'].value).toBe('First');
    h.surface.apply([
      { kind: 'text', id: 'first', value: 'Renamed' },
      { kind: 'text', id: 'out', value: 'x'.repeat(5000) },
    ]);
    expect(h.surface.inputs()['choices'].value).toBe('Renamed');
    expect(h.content.getElementById('out')?.textContent).toHaveLength(5000);
    h.surface.apply([
      {
        kind: 'html',
        id: 'choices',
        value: '<option value="next">Next</option>',
      },
    ]);
    expect(h.surface.inputs()['choices'].value).toBe('next');
    h.surface.apply([{ kind: 'html', id: 'choices', value: '' }]);
    expect(h.content.querySelectorAll('option')).toHaveLength(0);
    expect(h.surface.inputs()['choices'].value).toBe('');
  });

  it('retains live control values, selected options and focus after a valid batch', () => {
    const h = harness(
      '<input id="rate" value="3"><input id="check" type="checkbox"><textarea id="notes">Initial</textarea><select id="choice"><option value="a">A</option><option value="b">B</option></select><output id="out"></output>',
    );
    const input = h.content.getElementById('rate') as HTMLInputElement;
    const check = h.content.getElementById('check') as HTMLInputElement;
    const notes = h.content.getElementById('notes') as HTMLTextAreaElement;
    const choice = h.content.getElementById('choice') as HTMLSelectElement;
    input.value = '7';
    input.focus();
    check.checked = true;
    notes.value = 'Edited';
    choice.selectedIndex = 1;
    h.surface.apply([{ kind: 'text', id: 'out', value: 'Updated' }]);
    expect(h.content.getElementById('rate')).toBe(input);
    expect(h.content.activeElement).toBe(input);
    expect(h.surface.inputs()).toEqual({
      rate: { value: '7', checked: false },
      check: { value: 'on', checked: true },
      notes: { value: 'Edited', checked: false },
      choice: { value: 'b', checked: false },
    });
    expect(choice.selectedIndex).toBe(1);
    expect(h.content.getElementById('out')?.textContent).toBe('Updated');
  });

  it('updates elements created earlier in a valid batch and preserves table wrappers', () => {
    const h = harness('<div id="view"></div>');
    h.surface.apply([
      {
        kind: 'html',
        id: 'view',
        value:
          '<input id="rate" value="3"><table><tbody><tr><td id="score">Initial</td></tr></tbody></table>',
      },
      { kind: 'value', id: 'rate', value: '7' },
      { kind: 'text', id: 'score', value: '14' },
    ]);
    expect(h.surface.inputs()['rate'].value).toBe('7');
    expect(
      h.content.querySelector('table > tbody > tr > td')?.textContent,
    ).toBe('14');
  });

  it('rejects updates outside the generated body, oversized batches and accumulated node growth', () => {
    const h = harness('<div id="view"></div><div id="other"></div>');
    h.content.head.id = 'outside';
    expect(() =>
      h.surface.apply([{ kind: 'text', id: 'outside', value: 'no' }]),
    ).toThrow(/missing/);
    expect(() =>
      h.surface.apply(
        Array.from({ length: 65 }, () => ({
          kind: 'text' as const,
          id: 'view',
          value: '',
        })),
      ),
    ).toThrow(/output limit/);
    h.surface.apply([
      { kind: 'html', id: 'view', value: '<span></span>'.repeat(500) },
    ]);
    expect(() =>
      h.surface.apply([
        { kind: 'html', id: 'other', value: '<span></span>'.repeat(11) },
      ]),
    ).toThrow(/elements/);
    expect(h.content.getElementById('other')?.childElementCount).toBe(0);
  });

  it('stops interaction and ignores updates after cancellation', () => {
    const h = harness(
      '<button id="go">Go</button><output id="out">Initial</output>',
    );
    h.surface.stop();
    h.content
      .getElementById('go')!
      .dispatchEvent(new Event('click', { bubbles: true }));
    h.surface.apply([{ kind: 'text', id: 'out', value: 'Late' }]);
    expect(h.onEvent).not.toHaveBeenCalled();
    expect(h.content.getElementById('out')?.textContent).toBe('Initial');
    expect(h.content.body.inert).toBe(true);
  });

  it('mounts a script-disabled frame with an independent restrictive CSP', async () => {
    const frame = document.createElement('iframe');
    document.body.replaceChildren(frame);
    const surface = new ViewSurface(frame, vi.fn(), vi.fn());
    const pending = surface.mount('<p>View</p>', '');
    expect(frame.getAttribute('sandbox')).toBe('allow-same-origin');
    expect(frame.srcdoc).toContain('default-src &#39;none&#39;');
    expect(frame.srcdoc).toContain('script-src &#39;none&#39;');
    expect(frame.referrerPolicy).toBe('no-referrer');
    surface.stop();
    await expect(pending).rejects.toThrow('View stopped.');
  });
});
