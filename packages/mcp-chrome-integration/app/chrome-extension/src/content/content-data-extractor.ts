/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Data extraction module for Qwen CLI Chrome Extension
 * Extracts page data, text content, and HTML to Markdown conversion
 */

import { capturedResponses } from './content-shared.js';

// Console log interceptor
const consoleLogs: Array<{
  type: string;
  message: string;
  timestamp: string;
  stack?: string;
}> = [];
const originalConsole = {
  log: console.log,
  error: console.error,
  warn: console.warn,
  info: console.info,
};

// Intercept console methods
['log', 'error', 'warn', 'info'].forEach((method) => {
  console[method as 'log' | 'error' | 'warn' | 'info'] = function (
    ...args: unknown[]
  ) {
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
    originalConsole[method as 'log' | 'error' | 'warn' | 'info'].apply(
      console,
      args,
    );
  };
});

/**
 * Extract clean text content from an element
 */
function extractTextContent(element: Element): string {
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

/**
 * Simple HTML to Markdown converter
 */
function htmlToMarkdown(element: Element): string {
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

  let node: Node | null;
  const listStack: string[] = [];

  while ((node = walker.nextNode())) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.trim();
      if (text) {
        markdown += text + ' ';
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element;
      switch (el.tagName.toLowerCase()) {
        case 'h1':
          markdown += '\n# ' + el.textContent?.trim() + '\n';
          break;
        case 'h2':
          markdown += '\n## ' + el.textContent?.trim() + '\n';
          break;
        case 'h3':
          markdown += '\n### ' + el.textContent?.trim() + '\n';
          break;
        case 'h4':
          markdown += '\n#### ' + el.textContent?.trim() + '\n';
          break;
        case 'h5':
          markdown += '\n##### ' + el.textContent?.trim() + '\n';
          break;
        case 'h6':
          markdown += '\n###### ' + el.textContent?.trim() + '\n';
          break;
        case 'p':
          markdown += '\n' + el.textContent?.trim() + '\n';
          break;
        case 'br':
          markdown += '\n';
          break;
        case 'a': {
          const href = el.getAttribute('href');
          const text = el.textContent?.trim();
          if (href) {
            markdown += `[${text}](${href}) `;
          }
          break;
        }
        case 'img': {
          const src = el.getAttribute('src');
          const alt = el.getAttribute('alt') || '';
          if (src) {
            markdown += `![${alt}](${src}) `;
          }
          break;
        }
        case 'ul':
        case 'ol':
          markdown += '\n';
          listStack.push(el.tagName.toLowerCase());
          break;
        case 'li': {
          const listType = listStack[listStack.length - 1];
          const prefix = listType === 'ol' ? '1. ' : '- ';
          markdown += prefix + el.textContent?.trim() + '\n';
          break;
        }
        case 'code':
          markdown += '`' + el.textContent + '`';
          break;
        case 'pre':
          markdown += '\n```\n' + el.textContent + '\n```\n';
          break;
        case 'blockquote':
          markdown += '\n> ' + el.textContent?.trim() + '\n';
          break;
        case 'strong':
        case 'b':
          markdown += '**' + el.textContent + '**';
          break;
        case 'em':
        case 'i':
          markdown += '*' + el.textContent + '*';
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

/**
 * Check if link is external
 */
function isExternalLink(url: string): boolean {
  try {
    const link = new URL(url);
    return link.hostname !== window.location.hostname;
  } catch {
    return false;
  }
}

/**
 * Get first paint time
 */
function getFirstPaintTime(): number | null {
  if (window.performance && window.performance.getEntriesByType) {
    const paintEntries = window.performance.getEntriesByType('paint');
    const firstPaint = paintEntries.find(
      (entry) => entry.name === 'first-paint',
    );
    return firstPaint ? firstPaint.startTime : null;
  }
  return null;
}

/**
 * Extract page data
 */
function extractPageData(): {
  url: string;
  title: string;
  domain: string;
  path: string;
  timestamp: string;
  meta: Record<string, string>;
  content: {
    text: string;
    html: string;
    markdown: string;
  };
  links: Array<{
    text: string;
    href: string;
    target: string;
    isExternal: boolean;
  }>;
  images: Array<{
    src: string;
    alt: string;
    title: string;
    width: number;
    height: number;
  }>;
  forms: Array<{
    action: string;
    method: string;
    fields: Array<{
      type: string;
      name: string | null;
      id: string | null;
      placeholder: string | null;
      required: boolean;
    }>;
  }>;
  consoleLogs: typeof consoleLogs;
  performance: {
    loadTime: number;
    domReady: number;
    firstPaint: number | null;
  };
} {
  const data = {
    // Basic page info
    url: window.location.href,
    title: document.title,
    domain: window.location.hostname,
    path: window.location.pathname,
    timestamp: new Date().toISOString(),

    // Meta information
    meta: {} as Record<string, string>,

    // Page content
    content: {
      text: '',
      html: '',
      markdown: '',
    },

    // Structured data
    links: [] as Array<{
      text: string;
      href: string;
      target: string;
      isExternal: boolean;
    }>,
    images: [] as Array<{
      src: string;
      alt: string;
      title: string;
      width: number;
      height: number;
    }>,
    forms: [] as Array<{
      action: string;
      method: string;
      fields: Array<{
        type: string;
        name: string | null;
        id: string | null;
        placeholder: string | null;
        required: boolean;
      }>;
    }>,

    // Console logs
    consoleLogs: [] as typeof consoleLogs,

    // Performance metrics
    performance: {} as {
      loadTime: number;
      domReady: number;
      firstPaint: number | null;
    },
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
      text: link.textContent?.trim() || '',
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
      fields: [] as Array<{
        type: string;
        name: string | null;
        id: string | null;
        placeholder: string | null;
        required: boolean;
      }>,
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

export {
  consoleLogs,
  capturedResponses,
  extractPageData,
  extractTextContent,
  htmlToMarkdown,
  isExternalLink,
  getFirstPaintTime,
};
