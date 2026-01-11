// Centralized browser tool definitions for MCP exposure
// Keep this list in sync with extension-side INTERNAL_MCP_TOOLS.

export const TOOLS = [
  {
    name: 'browser_read_page',
    description:
      'Read the content of the current browser page. Returns URL, title, text content, links, and images. Use when the user asks to “read/view/analyze current page/页面/网页内容”.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'browser_capture_screenshot',
    description:
      'Capture a screenshot of the current browser tab. Returns a base64-encoded PNG image. Use when a visual is needed (e.g., “截图/界面长什么样”).',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'browser_get_network_logs',
    description:
      'Get recent network request logs (fetch/xhr) from the active tab for API debugging. Use when the user asks to check 接口/请求/网络日志/接口失败/返回体; returns method/url/status/headers/body when available.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'browser_get_console_logs',
    description:
      'Get console logs (log/error/warn/info) from the current browser tab. Use when前端报错/JS error/控制台日志被提及。',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'browser_fill_form',
    description:
      'Fill inputs/textareas/contenteditable elements on the current page using selectors or labels. Use when the user asks to 输入/填写/录入/填表/输入搜索词; ask for selector or label if missing.',
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
      'Fill a single input/textarea/contentEditable element using a CSS selector. Use when需要向特定输入框写入; ask for selector if not provided.',
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
      'Execute a JavaScript snippet in the page context (use with care). Use when a quick DOM query/调试/取值需要直接在页面运行 JS。',
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
      'Automatically fill form fields by matching keys to visible labels/placeholder/name. Use when提供字段名/标签和值即可自动匹配 (登录/搜索/下单等); ask for field keys if missing.',
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
