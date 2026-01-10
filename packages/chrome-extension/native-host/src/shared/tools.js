/* global module */

// Centralized browser tool definitions for MCP exposure
// Keep this list in sync with extension-side INTERNAL_MCP_TOOLS.

const TOOLS = [
  {
    name: 'browser_read_page',
    description:
      'Read the content of the current browser page. Returns URL, title, text content, links, and images.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'browser_capture_screenshot',
    description:
      'Capture a screenshot of the current browser tab. Returns a base64-encoded PNG image.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'browser_get_network_logs',
    description:
      'Get network request logs from the current browser tab. Useful for debugging API calls.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'browser_get_console_logs',
    description:
      'Get console logs (log, error, warn, info) from the current browser tab.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'browser_fill_form',
    description:
      'Fill inputs/textareas/contenteditable elements on the current page using selectors or labels.',
    inputSchema: {
      type: 'object',
      properties: {
        entries: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              selector: { type: 'string' },
              label: { type: 'string' },
              text: { type: 'string' },
              mode: {
                type: 'string',
                enum: ['replace', 'append'],
                default: 'replace',
              },
              focus: { type: 'boolean' },
              simulateEvents: { type: 'boolean' },
            },
            required: ['text'],
          },
        },
      },
      required: ['entries'],
    },
  },
  {
    name: 'browser_input_text',
    description:
      'Fill a single input/textarea/contentEditable element using a CSS selector.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        text: { type: 'string' },
        clear: {
          type: 'boolean',
          description: 'Clear existing text before filling (default true)',
        },
      },
      required: ['selector', 'text'],
    },
  },
  {
    name: 'browser_click',
    description: 'Click an element on the current page using a CSS selector.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'browser_click_text',
    description: 'Click an element (button/link) by matching its visible text.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Visible text to match (case-insensitive substring)',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'browser_run_js',
    description:
      'Execute a JavaScript snippet in the page context (use with care).',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'JavaScript expression or block to execute',
        },
      },
      required: ['code'],
    },
  },
  {
    name: 'browser_fill_form_auto',
    description:
      'Automatically fill form fields by matching keys to visible labels/placeholder/name. Provide pairs of key/value.',
    inputSchema: {
      type: 'object',
      properties: {
        fields: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              key: {
                type: 'string',
                description: 'Label/placeholder/name text to match',
              },
              value: { type: 'string', description: 'Text to fill' },
              mode: {
                type: 'string',
                enum: ['replace', 'append'],
                default: 'replace',
              },
              simulateEvents: { type: 'boolean' },
              focus: { type: 'boolean' },
            },
            required: ['key', 'value'],
          },
        },
      },
      required: ['fields'],
    },
  },
];

module.exports = {
  TOOLS,
};
