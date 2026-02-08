/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Element interaction module for Qwen CLI Chrome Extension
 * Provides functions for page interaction operations
 */

const TEXT_INPUT_TYPES = new Set([
  'text',
  'email',
  'search',
  'tel',
  'url',
  'number',
  'password',
]);

/**
 * Check if an element is writable (input, textarea, or contentEditable)
 */
function isWritableElement(el: Element | null): boolean {
  if (!el || typeof el !== 'object') return false;
  const tag = el.tagName?.toLowerCase();
  if (tag === 'textarea') return true;
  if (tag === 'input') {
    const type = (el.getAttribute('type') || '').toLowerCase();
    return TEXT_INPUT_TYPES.has(type) || type === '' || type === 'date';
  }
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

/**
 * Set text on an element
 */
function setElementText(
  el: Element,
  text: string,
  {
    mode = 'replace',
    simulateEvents = true,
    focus = false,
  }: {
    mode?: 'replace' | 'append';
    simulateEvents?: boolean;
    focus?: boolean;
  } = {},
): void {
  if (!isWritableElement(el)) {
    throw new Error('Element is not writable');
  }

  const applyValue = () => {
    if ((el as HTMLElement).isContentEditable) {
      (el as HTMLElement).innerText =
        mode === 'append'
          ? `${(el as HTMLElement).innerText || ''}${text}`
          : text;
    } else if (
      el.tagName?.toLowerCase() === 'textarea' ||
      el.tagName?.toLowerCase() === 'input'
    ) {
      (el as HTMLInputElement | HTMLTextAreaElement).value =
        mode === 'append'
          ? `${(el as HTMLInputElement | HTMLTextAreaElement).value || ''}${text}`
          : text;
    }
  };

  if (focus) {
    try {
      (el as HTMLElement).focus();
    } catch {
      // ignore focus failures
    }
  }

  applyValue();

  if (simulateEvents) {
    const events = ['input', 'change'];
    events.forEach((type) => {
      try {
        const evt = new Event(type, { bubbles: true });
        el.dispatchEvent(evt);
      } catch {
        // ignore dispatch failures
      }
    });
    try {
      (el as HTMLElement).blur();
    } catch {
      // ignore blur failures
    }
  }
}

/**
 * Normalize text for comparison
 */
function normalizeText(str: string): string {
  return String(str || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Find an input element by its label text
 */
function findElementByLabel(labelText: string): Element | null {
  const labelNorm = normalizeText(labelText);
  if (!labelNorm) return null;

  // <label> text -> for/id
  const labels = Array.from(document.querySelectorAll('label')).filter((lbl) =>
    normalizeText(lbl.textContent || '').includes(labelNorm),
  );
  for (const lbl of labels) {
    const forId = lbl.getAttribute('for');
    if (forId) {
      const target = document.getElementById(forId);
      if (target && isWritableElement(target)) return target;
    }
    const input = lbl.querySelector(
      'input, textarea, [contenteditable="true"]',
    );
    if (input && isWritableElement(input)) return input;
  }

  // aria-label / placeholder / name fallback
  const candidates = Array.from(
    document.querySelectorAll('input, textarea, [contenteditable="true"]'),
  );
  for (const el of candidates) {
    const aria = normalizeText(el.getAttribute?.('aria-label') || '');
    const placeholder = normalizeText(el.getAttribute?.('placeholder') || '');
    const name = normalizeText(el.getAttribute?.('name') || '');
    if (
      (aria && aria.includes(labelNorm)) ||
      (placeholder && placeholder.includes(labelNorm)) ||
      (name && name.includes(labelNorm))
    ) {
      if (isWritableElement(el)) return el;
    }
  }

  return null;
}

/**
 * Get a description of an element for debugging
 */
function describeElement(el: Element | null): string {
  if (!el) return 'unknown';
  const tag = (el.tagName || '').toLowerCase();
  const id = el.id ? `#${el.id}` : '';
  const name = el.name ? `[name="${el.name}"]` : '';
  const aria = el.getAttribute?.('aria-label')
    ? `[aria-label="${el.getAttribute('aria-label')}"]`
    : '';
  const placeholder = el.getAttribute?.('placeholder')
    ? `[placeholder="${el.getAttribute('placeholder')}"]`
    : '';
  return `${tag}${id}${name}${aria}${placeholder}` || tag || 'element';
}

/**
 * Get selected text from the page
 */
function getSelectedText(): string {
  return window.getSelection()?.toString() || '';
}

/**
 * Highlight an element on the page
 */
function highlightElement(selector: string): boolean {
  try {
    const element = document.querySelector(selector);
    if (element) {
      // Store original style
      const originalStyle = (element as HTMLElement).style.cssText;

      // Apply highlight
      (element as HTMLElement).style.cssText += `
        outline: 3px solid #FF6B6B !important;
        background-color: rgba(255, 107, 107, 0.1) !important;
        transition: all 0.3s ease !important;
      `;

      // Remove highlight after 3 seconds
      setTimeout(() => {
        (element as HTMLElement).style.cssText = originalStyle;
      }, 3000);

      return true;
    }
    return false;
  } catch (error) {
    console.error('Failed to highlight element:', error);
    return false;
  }
}

/**
 * Simulate a click on an element by selector
 */
function clickElement(selector: string): { success: boolean; error?: string } {
  if (!selector) {
    return { success: false, error: 'No selector provided' };
  }
  const element = document.querySelector(selector);
  if (!element) {
    return {
      success: false,
      error: `Element not found for selector: ${selector}`,
    };
  }
  try {
    if (typeof (element as HTMLElement).scrollIntoView === 'function') {
      (element as HTMLElement).scrollIntoView({
        block: 'center',
        behavior: 'smooth',
      });
    }
    const evtOptions = { bubbles: true, cancelable: true, composed: true };
    ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach((type) => {
      try {
        const evt = new MouseEvent(type, evtOptions);
        element.dispatchEvent(evt);
      } catch {
        // ignore individual dispatch failures
      }
    });
    return { success: true };
  } catch (error) {
    console.error('Failed to click element:', error);
    return { success: false, error: error?.message || String(error) };
  }
}

/**
 * Click element by visible text
 */
function clickElementByText(text: string): {
  success: boolean;
  error?: string;
} {
  if (!text) {
    return { success: false, error: 'No text provided' };
  }
  const norm = text.toLowerCase().trim();
  const candidates = Array.from(
    document.querySelectorAll(
      'button, a, [role="button"], input[type="button"], input[type="submit"], input[type="reset"]',
    ),
  );
  for (const el of candidates) {
    const txt = (el.textContent || '').toLowerCase().trim();
    if (txt && txt.includes(norm)) {
      try {
        if (typeof (el as HTMLElement).scrollIntoView === 'function') {
          (el as HTMLElement).scrollIntoView({
            block: 'center',
            behavior: 'smooth',
          });
        }
        const evtOptions = {
          bubbles: true,
          cancelable: true,
          composed: true,
        };
        ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach((type) => {
          try {
            const evt = new MouseEvent(type, evtOptions);
            el.dispatchEvent(evt);
          } catch {
            /* ignore */
          }
        });
        return { success: true };
      } catch (error) {
        return { success: false, error: error?.message || String(error) };
      }
    }
  }
  return { success: false, error: `No element found with text: ${text}` };
}

/**
 * Fill text into an input/textarea/contentEditable element
 */
function fillInput(
  selector: string,
  text: string,
  options: { clear?: boolean } = {},
): { success: boolean; appliedText?: string; error?: string } {
  if (!selector) {
    return { success: false, error: 'No selector provided' };
  }

  const element = document.querySelector(selector);
  if (!element) {
    return {
      success: false,
      error: `Element not found for selector: ${selector}`,
    };
  }

  const clearExisting = options.clear !== false; // default: clear before typing

  try {
    // Scroll into view and focus
    if (typeof (element as HTMLElement).scrollIntoView === 'function') {
      (element as HTMLElement).scrollIntoView({
        block: 'center',
        behavior: 'smooth',
      });
    }
    if (typeof (element as HTMLElement).focus === 'function') {
      (element as HTMLElement).focus({ preventScroll: true });
    }

    // Determine how to set text based on element type
    const tag = element.tagName?.toLowerCase();
    const isInput =
      tag === 'input' ||
      tag === 'textarea' ||
      (element as HTMLElement).isContentEditable;

    if (!isInput) {
      return {
        success: false,
        error: 'Target is not an input, textarea, or contentEditable element',
      };
    }

    // Helper to dispatch events so frameworks pick up the change
    const dispatch = (name: string) => {
      const evt =
        name === 'input' && typeof InputEvent !== 'undefined'
          ? new InputEvent(name, {
              bubbles: true,
              cancelable: true,
              composed: true,
            })
          : new Event(name, {
              bubbles: true,
              cancelable: true,
              composed: true,
            });
      element.dispatchEvent(evt);
    };

    if (tag === 'input' || tag === 'textarea') {
      if (clearExisting)
        (element as HTMLInputElement | HTMLTextAreaElement).value = '';
      (element as HTMLInputElement | HTMLTextAreaElement).value = text ?? '';
    } else if ((element as HTMLElement).isContentEditable) {
      if (clearExisting) (element as HTMLElement).innerText = '';
      (element as HTMLElement).innerText = text ?? '';
    }

    dispatch('input');
    dispatch('change');

    return {
      success: true,
      appliedText: text ?? '',
    };
  } catch (error) {
    console.error('Failed to fill input:', error);
    return { success: false, error: error?.message };
  }
}

/**
 * Execute custom JavaScript in page context
 */
function executeInPageContext(code: string): Promise<unknown> {
  try {
    const script = document.createElement('script');
    script.textContent = `
      (function() {
        try {
          const result = ${code};
          window.postMessage({
            type: 'QWEN_BRIDGE_RESULT',
            success: true,
            result: result
          }, '*');
        } catch (error) {
          window.postMessage({
            type: 'QWEN_BRIDGE_RESULT',
            success: false,
            error: error.message
          }, '*');
        }
      })();
    `;
    document.documentElement.appendChild(script);
    script.remove();

    return new Promise((resolve, reject) => {
      const listener = (event: MessageEvent) => {
        if (event.data && event.data.type === 'QWEN_BRIDGE_RESULT') {
          window.removeEventListener('message', listener);
          if (event.data.success) {
            resolve(event.data.result);
          } else {
            reject(new Error(event.data.error));
          }
        }
      };
      window.addEventListener('message', listener);

      // Timeout after 5 seconds
      setTimeout(() => {
        window.removeEventListener('message', listener);
        reject(new Error('Execution timeout'));
      }, 5000);
    });
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * Fill multiple inputs
 */
function fillInputs(
  entries: Array<{
    selector?: string;
    label?: string;
    text?: string | null;
    mode?: 'replace' | 'append';
    simulateEvents?: boolean;
    focus?: boolean;
  }>,
): Array<{
  index: number;
  selector: string | null;
  label: string | null;
  success: boolean;
  message: string;
  target: string | null;
}> {
  if (!Array.isArray(entries)) {
    throw new Error('entries must be an array');
  }

  const results = [];

  entries.forEach((entry, idx) => {
    const {
      selector,
      label,
      text,
      mode = 'replace',
      simulateEvents = true,
      focus = false,
    } = entry || {};
    const result = {
      index: idx,
      selector: selector || null,
      label: label || null,
      success: false,
      message: '',
      target: null as string | null,
    };

    try {
      if (text === undefined || text === null) {
        throw new Error('text is required');
      }
      const textValue = String(text);

      let target: Element | null = null;
      if (selector) {
        target = document.querySelector(selector);
      }
      if (!target && label) {
        target = findElementByLabel(label);
      }

      if (!target) {
        throw new Error('Target element not found');
      }

      if (!isWritableElement(target)) {
        throw new Error('Target element is not writable');
      }

      setElementText(target, textValue, { mode, simulateEvents, focus });

      result.success = true;
      result.target = describeElement(target);
      result.message = 'Filled successfully';
    } catch (err) {
      result.success = false;
      result.message = err?.message || String(err);
    }

    results.push(result);
  });

  return results;
}

export {
  getSelectedText,
  highlightElement,
  clickElement,
  clickElementByText,
  fillInput,
  fillInputs,
  executeInPageContext,
  isWritableElement,
  setElementText,
  findElementByLabel,
  describeElement,
};
