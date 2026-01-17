/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
/* global window, document, console, chrome, setTimeout, NodeFilter, Node, URL, MouseEvent, InputEvent, Event, module */

/**
 * Content Script for Qwen CLI Chrome Extension
 * Extracts data from web pages and communicates with background script
 */

if (window.__QWEN_BRIDGE_CONTENT_SCRIPT_LOADED__) {
  console.debug('Qwen Bridge content script already loaded, skipping.');
} else {
  window.__QWEN_BRIDGE_CONTENT_SCRIPT_LOADED__ = true;

  // Capture recent fetch/XHR responses for targeted debugging
  const capturedResponses = [];
  const MAX_CAPTURED = 100;
  const MAX_BODY_CHARS = 200000; // 200 KB text cap

  function recordCapturedResponse(entry) {
    capturedResponses.push(entry);
    if (capturedResponses.length > MAX_CAPTURED) {
      capturedResponses.splice(0, capturedResponses.length - MAX_CAPTURED);
    }
  }

  function sanitizeHeaders(headersLike) {
    const result = {};
    try {
      // headersLike can be Headers, array of [k,v], or plain object
      if (headersLike && typeof headersLike.forEach === 'function') {
        headersLike.forEach((v, k) => {
          result[String(k)] = String(v);
        });
      } else if (Array.isArray(headersLike)) {
        headersLike.forEach(([k, v]) => {
          if (k) result[String(k)] = String(v);
        });
      } else if (headersLike && typeof headersLike === 'object') {
        Object.entries(headersLike).forEach(([k, v]) => {
          result[String(k)] = String(v);
        });
      }
    } catch {
      // best-effort
    }
    return result;
  }

  // Patch fetch
  if (typeof window.fetch === 'function') {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const started = Date.now();
      try {
        const res = await originalFetch(...args);
        try {
          const req = args[0];
          const url = typeof req === 'string' ? req : req?.url;
          const init = args[1] || {};
          const method = (init.method || 'GET').toUpperCase();
          const status = res.status;
          const headers = sanitizeHeaders(res.headers);
          let body = null;
          try {
            const clone = res.clone();
            body = await clone.text();
            if (typeof body === 'string' && body.length > MAX_BODY_CHARS) {
              body = body.slice(0, MAX_BODY_CHARS) + '...';
            }
          } catch (e) {
            body = `error: ${e?.message || e}`;
          }
          recordCapturedResponse({
            source: 'fetch',
            url,
            method,
            status,
            headers,
            body,
            timestamp: started,
          });
        } catch {
          // best-effort capture; ignore capture errors
        }
        return res;
      } catch (err) {
        // Capture error case too
        try {
          const req = args[0];
          const url = typeof req === 'string' ? req : req?.url;
          const init = args[1] || {};
          const method = (init.method || 'GET').toUpperCase();
          recordCapturedResponse({
            source: 'fetch',
            url,
            method,
            status: 0,
            headers: {},
            body: `error: ${err?.message || err}`,
            timestamp: started,
          });
        } catch {
          /* ignore */
        }
        throw err;
      }
    };
  }

  // Patch XHR
  if (typeof window.XMLHttpRequest === 'function') {
    const OriginalXHR = window.XMLHttpRequest;
    function WrappedXHR() {
      const xhr = new OriginalXHR();
      let url = '';
      let method = 'GET';
      xhr.addEventListener('loadend', () => {
        try {
          const status = xhr.status;
          const headers = {};
          const raw = xhr.getAllResponseHeaders();
          if (raw) {
            raw
              .trim()
              .split(/\\r?\\n/)
              .forEach((line) => {
                const idx = line.indexOf(':');
                if (idx > 0) {
                  const k = line.slice(0, idx).trim();
                  const v = line.slice(idx + 1).trim();
                  if (k) headers[k] = v;
                }
              });
          }
          let body = xhr.responseText;
          if (typeof body === 'string' && body.length > MAX_BODY_CHARS) {
            body = body.slice(0, MAX_BODY_CHARS) + '...';
          }
          recordCapturedResponse({
            source: 'xhr',
            url,
            method,
            status,
            headers,
            body,
            timestamp: Date.now(),
          });
        } catch {
          // ignore capture errors
        }
      });
      const origOpen = xhr.open;
      xhr.open = function patchedOpen(m, u, ...rest) {
        method = (m || 'GET').toUpperCase();
        url = u || '';
        return origOpen.call(this, m, u, ...rest);
      };
      const origSend = xhr.send;
      xhr.send = function patchedSend(body) {
        return origSend.call(this, body);
      };
      return xhr;
    }
    window.XMLHttpRequest = WrappedXHR;
  }
  // Data extraction functions
  function extractPageData() {
    const data = {
      // Basic page info
      url: window.location.href,
      title: document.title,
      domain: window.location.hostname,
      path: window.location.pathname,
      timestamp: new Date().toISOString(),

      // Meta information
      meta: {},

      // Page content
      content: {
        text: '',
        html: '',
        markdown: '',
      },

      // Structured data
      links: [],
      images: [],
      forms: [],

      // Console logs
      consoleLogs: [],

      // Performance metrics
      performance: {},
    };

    // Extract meta tags
    document.querySelectorAll('meta').forEach((meta) => {
      const name = meta.getAttribute('name') || meta.getAttribute('property');
      const content = meta.getAttribute('content');
      if (name && content) {
        data.meta[name] = content;
      }
    });

    // Extract main content (try to find article or main element first)
    const mainContent =
      document.querySelector('article, main, [role="main"]') || document.body;
    data.content.text = extractTextContent(mainContent);
    data.content.html = mainContent.innerHTML;
    data.content.markdown = htmlToMarkdown(mainContent);

    // Extract all links
    document.querySelectorAll('a[href]').forEach((link) => {
      data.links.push({
        text: link.textContent.trim(),
        href: link.href,
        target: link.target,
        isExternal: isExternalLink(link.href),
      });
    });

    // Extract all images
    document.querySelectorAll('img').forEach((img) => {
      data.images.push({
        src: img.src,
        alt: img.alt,
        title: img.title,
        width: img.naturalWidth,
        height: img.naturalHeight,
      });
    });

    // Extract form data (structure only, no sensitive data)
    document.querySelectorAll('form').forEach((form) => {
      const formData = {
        action: form.action,
        method: form.method,
        fields: [],
      };

      form.querySelectorAll('input, textarea, select').forEach((field) => {
        formData.fields.push({
          type: field.type || field.tagName.toLowerCase(),
          name: field.name,
          id: field.id,
          placeholder: field.placeholder,
          required: field.required,
        });
      });

      data.forms.push(formData);
    });

    // Get performance metrics
    if (window.performance && window.performance.timing) {
      const perf = window.performance.timing;
      data.performance = {
        loadTime: perf.loadEventEnd - perf.navigationStart,
        domReady: perf.domContentLoadedEventEnd - perf.navigationStart,
        firstPaint: getFirstPaintTime(),
      };
    }

    return data;
  }

  // Extract clean text content
  function extractTextContent(element) {
    // Clone the element to avoid modifying the original
    const clone = element.cloneNode(true);

    // Remove script and style elements
    clone
      .querySelectorAll('script, style, noscript')
      .forEach((el) => el.remove());

    // Get text content and clean it up
    let text = clone.textContent || '';

    // Remove excessive whitespace
    text = text.replace(/\s+/g, ' ').trim();

    // Limit length to prevent excessive data
    const maxLength = 50000; // 50KB limit
    if (text.length > maxLength) {
      text = text.substring(0, maxLength) + '...';
    }

    return text;
  }

  // Simple HTML to Markdown converter
  function htmlToMarkdown(element) {
    const clone = element.cloneNode(true);

    // Remove script and style elements
    clone
      .querySelectorAll('script, style, noscript')
      .forEach((el) => el.remove());

    let markdown = '';
    const walker = document.createTreeWalker(
      clone,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      null,
      false,
    );

    let node;
    const listStack = [];

    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent.trim();
        if (text) {
          markdown += text + ' ';
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        switch (node.tagName.toLowerCase()) {
          case 'h1':
            markdown += '\n# ' + node.textContent.trim() + '\n';
            break;
          case 'h2':
            markdown += '\n## ' + node.textContent.trim() + '\n';
            break;
          case 'h3':
            markdown += '\n### ' + node.textContent.trim() + '\n';
            break;
          case 'h4':
            markdown += '\n#### ' + node.textContent.trim() + '\n';
            break;
          case 'h5':
            markdown += '\n##### ' + node.textContent.trim() + '\n';
            break;
          case 'h6':
            markdown += '\n###### ' + node.textContent.trim() + '\n';
            break;
          case 'p':
            markdown += '\n' + node.textContent.trim() + '\n';
            break;
          case 'br':
            markdown += '\n';
            break;
          case 'a': {
            const href = node.getAttribute('href');
            const text = node.textContent.trim();
            if (href) {
              markdown += `[${text}](${href}) `;
            }
            break;
          }
          case 'img': {
            const src = node.getAttribute('src');
            const alt = node.getAttribute('alt') || '';
            if (src) {
              markdown += `![${alt}](${src}) `;
            }
            break;
          }
          case 'ul':
          case 'ol':
            markdown += '\n';
            listStack.push(node.tagName.toLowerCase());
            break;
          case 'li': {
            const listType = listStack[listStack.length - 1];
            const prefix = listType === 'ol' ? '1. ' : '- ';
            markdown += prefix + node.textContent.trim() + '\n';
            break;
          }
          case 'code':
            markdown += '`' + node.textContent + '`';
            break;
          case 'pre':
            markdown += '\n```\n' + node.textContent + '\n```\n';
            break;
          case 'blockquote':
            markdown += '\n> ' + node.textContent.trim() + '\n';
            break;
          case 'strong':
          case 'b':
            markdown += '**' + node.textContent + '**';
            break;
          case 'em':
          case 'i':
            markdown += '*' + node.textContent + '*';
            break;
        }
      }
    }

    // Limit markdown length
    const maxLength = 30000;
    if (markdown.length > maxLength) {
      markdown = markdown.substring(0, maxLength) + '...';
    }

    return markdown.trim();
  }

  // Check if link is external
  function isExternalLink(url) {
    try {
      const link = new URL(url);
      return link.hostname !== window.location.hostname;
    } catch {
      return false;
    }
  }

  // Get first paint time
  function getFirstPaintTime() {
    if (window.performance && window.performance.getEntriesByType) {
      const paintEntries = window.performance.getEntriesByType('paint');
      const firstPaint = paintEntries.find(
        (entry) => entry.name === 'first-paint',
      );
      return firstPaint ? firstPaint.startTime : null;
    }
    return null;
  }

  // Console log interceptor
  const consoleLogs = [];
  const originalConsole = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    info: console.info,
  };

  // Intercept console methods
  ['log', 'error', 'warn', 'info'].forEach((method) => {
    console[method] = function (...args) {
      // Store the log
      consoleLogs.push({
        type: method,
        message: args
          .map((arg) => {
            try {
              if (typeof arg === 'object') {
                return JSON.stringify(arg);
              }
              return String(arg);
            } catch {
              return String(arg);
            }
          })
          .join(' '),
        timestamp: new Date().toISOString(),
        stack: new Error().stack,
      });

      // Keep only last 100 logs to prevent memory issues
      if (consoleLogs.length > 100) {
        consoleLogs.shift();
      }

      // Call original console method
      originalConsole[method].apply(console, args);
    };
  });

  // Get selected text
  function getSelectedText() {
    return window.getSelection().toString();
  }

  // Highlight element on page
  function highlightElement(selector) {
    try {
      const element = document.querySelector(selector);
      if (element) {
        // Store original style
        const originalStyle = element.style.cssText;

        // Apply highlight
        element.style.cssText += `
        outline: 3px solid #FF6B6B !important;
        background-color: rgba(255, 107, 107, 0.1) !important;
        transition: all 0.3s ease !important;
      `;

        // Remove highlight after 3 seconds
        setTimeout(() => {
          element.style.cssText = originalStyle;
        }, 3000);

        return true;
      }
      return false;
    } catch (error) {
      console.error('Failed to highlight element:', error);
      return false;
    }
  }

  // Simulate a click on a selector
  function clickElement(selector) {
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
      if (typeof element.scrollIntoView === 'function') {
        element.scrollIntoView({ block: 'center', behavior: 'smooth' });
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

  // Click element by visible text
  function clickElementByText(text) {
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
          if (typeof el.scrollIntoView === 'function') {
            el.scrollIntoView({ block: 'center', behavior: 'smooth' });
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

  // Fill text into an input/textarea/contentEditable element
  function fillInput(selector, text, options = {}) {
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
      if (typeof element.scrollIntoView === 'function') {
        element.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
      if (typeof element.focus === 'function') {
        element.focus({ preventScroll: true });
      }

      // Determine how to set text based on element type
      const tag = element.tagName?.toLowerCase();
      const isInput =
        tag === 'input' || tag === 'textarea' || element.isContentEditable;

      if (!isInput) {
        return {
          success: false,
          error: 'Target is not an input, textarea, or contentEditable element',
        };
      }

      // Helper to dispatch events so frameworks pick up the change
      const dispatch = (name) => {
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
        if (clearExisting) element.value = '';
        element.value = text ?? '';
      } else if (element.isContentEditable) {
        if (clearExisting) element.innerText = '';
        element.innerText = text ?? '';
      }

      dispatch('input');
      dispatch('change');

      return {
        success: true,
        appliedText: text ?? '',
      };
    } catch (error) {
      console.error('Failed to fill input:', error);
      return { success: false, error: error.message };
    }
  }

  // Execute custom JavaScript in page context
  function executeInPageContext(code) {
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
        const listener = (event) => {
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

  const TEXT_INPUT_TYPES = new Set([
    'text',
    'email',
    'search',
    'tel',
    'url',
    'number',
    'password',
  ]);

  function isWritableElement(el) {
    if (!el || typeof el !== 'object') return false;
    const tag = el.tagName?.toLowerCase();
    if (tag === 'textarea') return true;
    if (tag === 'input') {
      const type = (el.type || '').toLowerCase();
      return TEXT_INPUT_TYPES.has(type) || type === '' || type === 'date';
    }
    if (el.isContentEditable) return true;
    return false;
  }

  function setElementText(
    el,
    text,
    { mode = 'replace', simulateEvents = true, focus = false } = {},
  ) {
    if (!isWritableElement(el)) {
      throw new Error('Element is not writable');
    }

    const applyValue = () => {
      if (el.isContentEditable) {
        el.innerText =
          mode === 'append' ? `${el.innerText || ''}${text}` : text;
      } else if (
        el.tagName?.toLowerCase() === 'textarea' ||
        el.tagName?.toLowerCase() === 'input'
      ) {
        el.value = mode === 'append' ? `${el.value || ''}${text}` : text;
      }
    };

    if (focus) {
      try {
        el.focus();
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
        el.blur();
      } catch {
        // ignore blur failures
      }
    }
  }

  function normalizeText(str) {
    return String(str || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function findElementByLabel(labelText) {
    const labelNorm = normalizeText(labelText);
    if (!labelNorm) return null;

    // <label> text -> for/id
    const labels = Array.from(document.querySelectorAll('label')).filter(
      (lbl) => normalizeText(lbl.textContent).includes(labelNorm),
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
      const aria = normalizeText(el.getAttribute?.('aria-label'));
      const placeholder = normalizeText(el.getAttribute?.('placeholder'));
      const name = normalizeText(el.getAttribute?.('name'));
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

  function describeElement(el) {
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

  function fillInputs(entries) {
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
        target: null,
      };

      try {
        if (text === undefined || text === null) {
          throw new Error('text is required');
        }
        const textValue = String(text);

        let target = null;
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

  // Message listener for communication with background script
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log('Content script received message:', request);

    switch (request.type) {
      case 'EXTRACT_DATA': {
        // Extract and send page data
        const pageData = extractPageData();
        pageData.consoleLogs = consoleLogs;
        sendResponse({
          success: true,
          data: pageData,
        });
        break;
      }

      case 'GET_CONSOLE_LOGS':
        // Get captured console logs
        sendResponse({
          success: true,
          data: consoleLogs.slice(), // Return a copy
        });
        break;

      case 'GET_SELECTED_TEXT':
        // Get currently selected text
        sendResponse({
          success: true,
          data: getSelectedText(),
        });
        break;

      case 'GET_CAPTURED_RESPONSES': {
        const { urlSubstring, limit } = request || {};
        const max = typeof limit === 'number' && limit > 0 ? limit : 50;
        const filtered = capturedResponses
          .filter((r) => {
            if (!urlSubstring) return true;
            return String(r.url || '').includes(urlSubstring);
          })
          .slice(-max);
        sendResponse({
          success: true,
          data: filtered,
        });
        break;
      }

      case 'FILL_INPUTS': {
        try {
          const results = fillInputs(request.entries || []);
          sendResponse({
            success: true,
            data: { results },
          });
        } catch (error) {
          sendResponse({
            success: false,
            error: error?.message || String(error),
          });
        }
        break;
      }

      case 'HIGHLIGHT_ELEMENT': {
        // Highlight an element on the page
        const highlighted = highlightElement(request.selector);
        sendResponse({
          success: highlighted,
        });
        break;
      }

      case 'CLICK_ELEMENT': {
        const result = clickElement(request.selector);
        sendResponse(result);
        break;
      }

      case 'CLICK_TEXT': {
        const result = clickElementByText(request.text);
        sendResponse(result);
        break;
      }

      case 'FILL_INPUT': {
        const result = fillInput(request.selector, request.text, {
          clear: request.clear,
        });
        sendResponse(result);
        break;
      }

      case 'EXECUTE_CODE':
        // Execute JavaScript in page context
        executeInPageContext(request.code)
          .then((result) => {
            sendResponse({
              success: true,
              data: result,
            });
          })
          .catch((error) => {
            sendResponse({
              success: false,
              error: error.message,
            });
          });
        return true; // Will respond asynchronously

      case 'SCROLL_TO':
        // Scroll to specific position
        window.scrollTo({
          top: request.y || 0,
          left: request.x || 0,
          behavior: request.smooth ? 'smooth' : 'auto',
        });
        sendResponse({ success: true });
        break;

      case 'QWEN_EVENT':
        // Handle events from Qwen CLI
        console.log('Qwen event received:', request.event);
        // Could trigger UI updates or other actions based on event
        break;

      default:
        sendResponse({
          success: false,
          error: 'Unknown request type',
        });
    }
  });

  // Notify background script that content script is loaded
  chrome.runtime
    .sendMessage({
      type: 'CONTENT_SCRIPT_LOADED',
      url: window.location.href,
    })
    .catch(() => {
      // Ignore errors if background script is not ready
    });

  // Export for testing
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      extractPageData,
      extractTextContent,
      htmlToMarkdown,
      getSelectedText,
      highlightElement,
      fillInput,
    };
  }
}
