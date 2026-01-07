/**
 * Content Script for Qwen CLI Chrome Extension
 * Extracts data from web pages and communicates with background script
 */

if (window.__QWEN_BRIDGE_CONTENT_SCRIPT_LOADED__) {
  console.debug('Qwen Bridge content script already loaded, skipping.');
} else {
  window.__QWEN_BRIDGE_CONTENT_SCRIPT_LOADED__ = true;

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
      markdown: ''
    },

    // Structured data
    links: [],
    images: [],
    forms: [],

    // Console logs
    consoleLogs: [],

    // Performance metrics
    performance: {}
  };

  // Extract meta tags
  document.querySelectorAll('meta').forEach(meta => {
    const name = meta.getAttribute('name') || meta.getAttribute('property');
    const content = meta.getAttribute('content');
    if (name && content) {
      data.meta[name] = content;
    }
  });

  // Extract main content (try to find article or main element first)
  const mainContent = document.querySelector('article, main, [role="main"]') || document.body;
  data.content.text = extractTextContent(mainContent);
  data.content.html = mainContent.innerHTML;
  data.content.markdown = htmlToMarkdown(mainContent);

  // Extract all links
  document.querySelectorAll('a[href]').forEach(link => {
    data.links.push({
      text: link.textContent.trim(),
      href: link.href,
      target: link.target,
      isExternal: isExternalLink(link.href)
    });
  });

  // Extract all images
  document.querySelectorAll('img').forEach(img => {
    data.images.push({
      src: img.src,
      alt: img.alt,
      title: img.title,
      width: img.naturalWidth,
      height: img.naturalHeight
    });
  });

  // Extract form data (structure only, no sensitive data)
  document.querySelectorAll('form').forEach(form => {
    const formData = {
      action: form.action,
      method: form.method,
      fields: []
    };

    form.querySelectorAll('input, textarea, select').forEach(field => {
      formData.fields.push({
        type: field.type || field.tagName.toLowerCase(),
        name: field.name,
        id: field.id,
        placeholder: field.placeholder,
        required: field.required
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
      firstPaint: getFirstPaintTime()
    };
  }

  return data;
}

// Extract clean text content
function extractTextContent(element) {
  // Clone the element to avoid modifying the original
  const clone = element.cloneNode(true);

  // Remove script and style elements
  clone.querySelectorAll('script, style, noscript').forEach(el => el.remove());

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
  clone.querySelectorAll('script, style, noscript').forEach(el => el.remove());

  let markdown = '';
  const walker = document.createTreeWalker(
    clone,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    null,
    false
  );

  let node;
  let listStack = [];

  while (node = walker.nextNode()) {
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
        case 'a':
          const href = node.getAttribute('href');
          const text = node.textContent.trim();
          if (href) {
            markdown += `[${text}](${href}) `;
          }
          break;
        case 'img':
          const src = node.getAttribute('src');
          const alt = node.getAttribute('alt') || '';
          if (src) {
            markdown += `![${alt}](${src}) `;
          }
          break;
        case 'ul':
        case 'ol':
          markdown += '\n';
          listStack.push(node.tagName.toLowerCase());
          break;
        case 'li':
          const listType = listStack[listStack.length - 1];
          const prefix = listType === 'ol' ? '1. ' : '- ';
          markdown += prefix + node.textContent.trim() + '\n';
          break;
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
    const firstPaint = paintEntries.find(entry => entry.name === 'first-paint');
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
  info: console.info
};

// Intercept console methods
['log', 'error', 'warn', 'info'].forEach(method => {
  console[method] = function(...args) {
    // Store the log
    consoleLogs.push({
      type: method,
      message: args.map(arg => {
        try {
          if (typeof arg === 'object') {
            return JSON.stringify(arg);
          }
          return String(arg);
        } catch {
          return String(arg);
        }
      }).join(' '),
      timestamp: new Date().toISOString(),
      stack: new Error().stack
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

// Message listener for communication with background script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Content script received message:', request);

  switch (request.type) {
    case 'EXTRACT_DATA':
      // Extract and send page data
      const pageData = extractPageData();
      pageData.consoleLogs = consoleLogs;
      sendResponse({
        success: true,
        data: pageData
      });
      break;

    case 'GET_CONSOLE_LOGS':
      // Get captured console logs
      sendResponse({
        success: true,
        data: consoleLogs.slice() // Return a copy
      });
      break;

    case 'GET_SELECTED_TEXT':
      // Get currently selected text
      sendResponse({
        success: true,
        data: getSelectedText()
      });
      break;

    case 'HIGHLIGHT_ELEMENT':
      // Highlight an element on the page
      const highlighted = highlightElement(request.selector);
      sendResponse({
        success: highlighted
      });
      break;

    case 'EXECUTE_CODE':
      // Execute JavaScript in page context
      executeInPageContext(request.code)
        .then(result => {
          sendResponse({
            success: true,
            data: result
          });
        })
        .catch(error => {
          sendResponse({
            success: false,
            error: error.message
          });
        });
      return true; // Will respond asynchronously

    case 'SCROLL_TO':
      // Scroll to specific position
      window.scrollTo({
        top: request.y || 0,
        left: request.x || 0,
        behavior: request.smooth ? 'smooth' : 'auto'
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
        error: 'Unknown request type'
      });
  }
});

// Notify background script that content script is loaded
chrome.runtime.sendMessage({
  type: 'CONTENT_SCRIPT_LOADED',
  url: window.location.href
}).catch(() => {
  // Ignore errors if background script is not ready
});

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    extractPageData,
    extractTextContent,
    htmlToMarkdown,
    getSelectedText,
    highlightElement
  };
}
}
