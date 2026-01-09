/* global module */

// Centralized browser tool definitions for MCP and host exposure
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
];

module.exports = {
  TOOLS,
};
