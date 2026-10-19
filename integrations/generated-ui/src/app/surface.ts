/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import createDOMPurify from 'dompurify';
import type { InputValues, UiEvent, UiPatch } from './runtime-contract.js';

const MAX_NODES = 512;
const MAX_INPUTS = 64;
const MAX_INPUT_BYTES = 16_000;
const MAX_MARKUP = 16_000;
const ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const TAGS = (
  'div span p h1 h2 h3 h4 h5 h6 section article header footer main aside ' +
  'fieldset legend label button input select option optgroup textarea output ' +
  'meter progress table thead tbody tfoot tr th td caption colgroup col ' +
  'ul ol li dl dt dd blockquote pre code strong em small b i u s sub sup br hr ' +
  'details summary svg g line rect circle ellipse path polygon polyline text tspan title desc'
).split(' ');
const ATTRS = (
  'id class style title role tabindex aria-label aria-labelledby aria-describedby ' +
  'aria-live aria-hidden aria-expanded for type value checked selected disabled ' +
  'min max step placeholder maxlength rows cols multiple name size open ' +
  'low high optimum colspan rowspan scope start reversed ' +
  'viewBox width height x y x1 x2 y1 y2 cx cy r rx ry d points fill stroke ' +
  'stroke-width stroke-linecap stroke-linejoin stroke-dasharray opacity ' +
  'fill-opacity stroke-opacity transform text-anchor dominant-baseline preserveAspectRatio'
).split(' ');
const INPUT_TYPES = new Set(['text', 'number', 'range', 'checkbox', 'radio']);
const FRAME_DOCUMENT =
  '<!doctype html><html><head><meta charset="utf-8">' +
  '<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; ' +
  'script-src &#39;none&#39;; style-src &#39;unsafe-inline&#39;; ' +
  'form-action &#39;none&#39;; base-uri &#39;none&#39;; object-src &#39;none&#39;; frame-src &#39;none&#39;">' +
  '<style>html{color-scheme:light dark}body{font:14px system-ui,sans-serif;margin:12px;overflow-wrap:anywhere}' +
  '*{box-sizing:border-box}input,select,textarea,button{font:inherit;max-width:100%}' +
  'svg{max-width:100%}pre{white-space:pre-wrap}</style></head><body></body></html>';

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

export class ViewSurface {
  private readonly purify;
  private content?: Document;
  private cleanup?: () => void;
  private cancelMount?: () => void;
  private stopped = false;

  constructor(
    private readonly frame: HTMLIFrameElement,
    private readonly onEvent: (event: UiEvent) => void,
    private readonly onError: (message: string) => void,
  ) {
    this.purify = createDOMPurify(frame.ownerDocument.defaultView!);
  }

  mount(html: string, css: string): Promise<InputValues> {
    this.frame.setAttribute('sandbox', 'allow-same-origin');
    this.frame.referrerPolicy = 'no-referrer';
    return new Promise((resolve, reject) => {
      this.cancelMount = () => reject(new Error('View stopped.'));
      this.frame.onload = () => {
        if (this.stopped) return;
        try {
          const doc = this.frame.contentDocument;
          if (!doc) throw new Error('This browser cannot display the view.');
          this.attach(doc, html, css);
          this.cancelMount = undefined;
          resolve(this.inputs());
        } catch (error) {
          this.cancelMount = undefined;
          reject(error);
        }
      };
      this.frame.srcdoc = FRAME_DOCUMENT;
    });
  }

  attach(doc: Document, html: string, css: string): void {
    this.cleanup?.();
    this.content = doc;
    const style = doc.createElement('style');
    style.textContent = css;
    doc.head.append(style);
    doc.body.replaceChildren(this.markup(html));
    this.validate(doc.body);
    const listener = (event: Event) => {
      if (this.stopped) return;
      try {
        const target = event.target as Element | null;
        if (!target || target.nodeType !== 1) return;
        const control =
          (event.type === 'click' ? target.closest('button[id]') : null) ??
          target.closest('[id]');
        if (!control?.id || !doc.body.contains(control)) return;
        const inputs = this.inputs();
        const input = inputs[control.id];
        this.onEvent({
          id: control.id,
          type: event.type as UiEvent['type'],
          value: input?.value ?? '',
          checked: input?.checked ?? false,
        });
      } catch {
        this.onError('The view exceeded its input limit.');
      }
    };
    for (const type of ['input', 'change', 'click']) {
      doc.body.addEventListener(type, listener);
    }
    this.cleanup = () => {
      for (const type of ['input', 'change', 'click']) {
        doc.body.removeEventListener(type, listener);
      }
    };
  }

  private markup(html: string): DocumentFragment {
    if (html.length > MAX_MARKUP)
      throw new Error('Generated markup is too large.');
    const fragment = this.purify.sanitize(html, {
      // Keep the parser root: stripping it clones radios into their own group
      // and clears the original checked state in Chromium. Only children return.
      ALLOWED_TAGS: ['body', ...TAGS],
      ALLOWED_ATTR: ATTRS,
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
      // Preserve IDs such as "reset". Forms/named-document elements are excluded;
      // the trusted renderer uses explicit references, never named window globals.
      SANITIZE_DOM: false,
      RETURN_DOM_FRAGMENT: true,
    });
    if (fragment.querySelectorAll('*').length > MAX_NODES)
      throw new Error('The view contains too many elements.');
    return fragment;
  }

  private validate(body: HTMLElement): void {
    if (body.querySelectorAll('*').length > MAX_NODES)
      throw new Error('The view contains too many elements.');
    const ids = new Set<string>();
    for (const element of body.querySelectorAll('[id]')) {
      if (!ID.test(element.id) || ids.has(element.id))
        throw new Error('Use unique element IDs starting with a letter.');
      ids.add(element.id);
    }
    const controls = body.querySelectorAll<Control>('input,select,textarea');
    if (controls.length > MAX_INPUTS)
      throw new Error('The view contains too many inputs.');
    for (const control of controls) {
      if (!control.id) throw new Error('Every input needs a unique ID.');
      if (
        control.tagName === 'INPUT' &&
        !INPUT_TYPES.has((control as HTMLInputElement).type)
      ) {
        throw new Error('This input type is not supported.');
      }
      if (
        control.tagName === 'SELECT' &&
        (control as HTMLSelectElement).multiple
      ) {
        // An input snapshot carries one value per control, so a multi-select's
        // state cannot be represented.
        throw new Error('This input type is not supported.');
      }
      if (control.tagName === 'INPUT' || control.tagName === 'TEXTAREA') {
        const field = control as HTMLInputElement | HTMLTextAreaElement;
        // Bound typing without raising a smaller declared maxlength.
        if (field.maxLength < 0 || field.maxLength > 2048)
          field.maxLength = 2048;
      }
    }
    for (const option of body.querySelectorAll('option')) {
      if (option.value.length > 2048)
        throw new Error('An input value is too long.');
    }
    this.readInputs(body);
  }

  inputs(): InputValues {
    return this.readInputs(this.content!.body);
  }

  private readInputs(body: HTMLElement): InputValues {
    const inputs = Object.fromEntries(
      Array.from(
        body.querySelectorAll<Control>('input,select,textarea'),
        (control) => {
          if (control.value.length > 2048)
            throw new Error('An input value is too long.');
          return [
            control.id,
            {
              value: control.value,
              checked:
                control.tagName === 'INPUT' &&
                (control as HTMLInputElement).checked,
            },
          ];
        },
      ),
    );
    if (
      new TextEncoder().encode(JSON.stringify(inputs)).byteLength >
      MAX_INPUT_BYTES
    ) {
      throw new Error('The view exceeded its input limit.');
    }
    return inputs;
  }

  apply(patches: UiPatch[], inflightInputs?: InputValues): void {
    if (this.stopped) return;
    if (
      !Array.isArray(patches) ||
      patches.length > 64 ||
      new TextEncoder().encode(JSON.stringify(patches)).byteLength > 16_000
    ) {
      throw new Error('The view exceeded its output limit.');
    }
    const body = this.content!.body;
    const projected = body.cloneNode(true) as HTMLElement;
    // Radio groups normalize only in a document; keep that state isolated.
    const preview = body.ownerDocument.implementation.createHTMLDocument();
    preview.body.replaceWith(projected);
    // Input/textarea cloning preserves live state; option selection needs copying.
    for (const select of body.querySelectorAll('select')) {
      const copy = projected.querySelector<HTMLSelectElement>(
        `[id="${select.id}"]`,
      )!;
      for (let index = 0; index < select.options.length; index++) {
        copy.options[index].selected = select.options[index].selected;
      }
      if (select.selectedIndex === -1) copy.selectedIndex = -1;
    }
    // Validate the whole round before changing live nodes, preserving input focus.
    this.applyTo(projected, patches);
    if (inflightInputs) {
      const current = this.readInputs(body);
      const next = this.readInputs(projected);
      // HTML/text can change controls beyond the patch target or remove them.
      // Discard the entire stale round, including its derived outputs.
      const superseded = Object.entries(current).some(([id, now]) => {
        const before = inflightInputs[id];
        return (
          (before?.value !== now.value || before?.checked !== now.checked) &&
          (patches.some((patch) => patch.kind === 'value' && patch.id === id) ||
            next[id]?.value !== now.value ||
            next[id]?.checked !== now.checked)
        );
      });
      if (superseded) return;
    }
    this.applyTo(body, patches);
  }

  private applyTo(body: HTMLElement, patches: UiPatch[]): void {
    for (const patch of patches) {
      if (
        !patch ||
        typeof patch.id !== 'string' ||
        !ID.test(patch.id) ||
        typeof patch.value !== 'string'
      ) {
        throw new Error('Invalid view update.');
      }
      const element = body.querySelector<HTMLElement>(`[id="${patch.id}"]`);
      if (!element)
        throw new Error('A view update referenced a missing element.');
      switch (patch.kind) {
        case 'text':
          element.textContent = patch.value;
          break;
        case 'html': {
          const fragment = this.markup(patch.value);
          const nextCount =
            body.querySelectorAll('*').length -
            element.querySelectorAll('*').length +
            fragment.querySelectorAll('*').length;
          if (nextCount > MAX_NODES)
            throw new Error('The view contains too many elements.');
          element.replaceChildren(fragment);
          break;
        }
        case 'value':
          if (!['INPUT', 'SELECT', 'TEXTAREA'].includes(element.tagName))
            throw new Error('Only inputs have editable values.');
          (element as Control).value = patch.value;
          break;
        default:
          throw new Error('Unsupported view update.');
      }
      this.validate(body);
    }
  }

  stop(): void {
    this.stopped = true;
    this.cancelMount?.();
    this.cancelMount = undefined;
    this.cleanup?.();
    this.frame.onload = null;
    if (this.content) this.content.body.inert = true;
  }
}
