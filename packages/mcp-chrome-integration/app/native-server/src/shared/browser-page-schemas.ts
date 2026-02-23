/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { type Tool } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_NAMES } from './tool-names.js';

export const PAGE_SCHEMAS: Tool[] = [
  {
    name: TOOL_NAMES.BROWSER.WEB_FETCHER,
    description: 'Fetch content from a web page',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'URL to fetch content from. If not provided, uses the current active tab',
        },
        tabId: {
          type: 'number',
          description: 'Target an existing tab by ID (default: active tab).',
        },
        background: {
          type: 'boolean',
          description:
            'Do not activate tab/focus window while fetching (default: false)',
        },
        htmlContent: {
          type: 'boolean',
          description:
            'Get the visible HTML content of the page. If true, textContent will be ignored (default: false)',
        },
        textContent: {
          type: 'boolean',
          description:
            'Get the visible text content of the page with metadata. Ignored if htmlContent is true (default: true)',
        },

        selector: {
          type: 'string',
          description:
            'CSS selector to get content from a specific element. If provided, only content from this element will be returned',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.READ_PAGE,
    description:
      'Get an accessibility tree representation of visible elements on the page. Only returns elements that are visible in the viewport. Optionally filter for only interactive elements.\nTip: If the returned elements do not include the specific element you need, use the computer tool\'s screenshot (action="screenshot") to capture the element\'s on-screen coordinates, then operate by coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          description:
            'Filter elements: "interactive" for such as  buttons/links/inputs only (default: all visible elements)',
        },
        depth: {
          type: 'number',
          description:
            'Maximum DOM depth to traverse (integer >= 0). Lower values reduce output size and can improve performance.',
        },
        refId: {
          type: 'string',
          description:
            'Focus on the subtree rooted at this element refId (e.g., "ref_12"). The refId must come from a recent chrome_read_page response in the same tab (refs may expire).',
        },
        tabId: {
          type: 'number',
          description: 'Target an existing tab by ID (default: active tab).',
        },
        windowId: {
          type: 'number',
          description:
            'Target window ID to pick active tab when tabId is omitted.',
        },
      },
      required: [],
    },
  },
];
