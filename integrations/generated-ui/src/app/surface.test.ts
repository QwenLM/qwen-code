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

  it('rejects duplicate IDs, unsupported controls and excessive markup or input data', () => {
    expect(() => harness('<div id="same"></div><input id="same">')).toThrow(
      /unique/,
    );
    expect(() => harness('<input id="upload" type="file">')).toThrow(
      /input type/,
    );
    expect(() => harness('<input>')).toThrow(/unique ID/);
    expect(() => harness('<span></span>'.repeat(513))).toThrow(/elements/);
    const h = harness('<input id="value">');
    (h.content.getElementById('value') as HTMLInputElement).value = 'x'.repeat(
      2049,
    );
    expect(() => h.surface.inputs()).toThrow(/too long/);
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
