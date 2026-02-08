/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { type Tool } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_NAMES } from './tools.js';

export const BOOKMARK_SCHEMAS: Tool[] = [
  {
    name: TOOL_NAMES.BROWSER.HISTORY,
    description: 'Retrieve and search browsing history from Chrome',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description:
            'Text to search for in history URLs and titles. Leave empty to retrieve all history entries within the time range.',
        },
        startTime: {
          type: 'string',
          description:
            'Start time as a date string. Supports ISO format (e.g., "2023-10-01", "2023-10-01T14:30:00"), relative times (e.g., "1 day ago", "2 weeks ago", "3 months ago", "1 year ago"), and special keywords ("now", "today", "yesterday"). Default: 24 hours ago',
        },
        endTime: {
          type: 'string',
          description:
            'End time as a date string. Supports ISO format (e.g., "2023-10-31", "2023-10-31T14:30:00"), relative times (e.g., "1 day ago", "2 weeks ago", "3 months ago", "1 year ago"), and special keywords ("now", "today", "yesterday"). Default: current time',
        },
        maxResults: {
          type: 'number',
          description:
            'Maximum number of history entries to return. Use this to limit results for performance or to focus on the most relevant entries. (default: 100)',
        },
        excludeCurrentTabs: {
          type: 'boolean',
          description:
            "When set to true, filters out URLs that are currently open in any browser tab. Useful for finding pages you've visited but don't have open anymore. (default: false)",
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.BOOKMARK_SEARCH,
    description: 'Search Chrome bookmarks by title and URL',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Search query to match against bookmark titles and URLs. Leave empty to retrieve all bookmarks.',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum number of bookmarks to return (default: 50)',
        },
        folderPath: {
          type: 'string',
          description:
            'Optional folder path or ID to limit search to a specific bookmark folder. Can be a path string (e.g., "Work/Projects") or a folder ID.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.BOOKMARK_ADD,
    description: 'Add a new bookmark to Chrome',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'URL to bookmark. If not provided, uses the current active tab URL.',
        },
        title: {
          type: 'string',
          description:
            'Title for the bookmark. If not provided, uses the page title from the URL.',
        },
        parentId: {
          type: 'string',
          description:
            'Parent folder path or ID to add the bookmark to. Can be a path string (e.g., "Work/Projects") or a folder ID. If not provided, adds to the "Bookmarks Bar" folder.',
        },
        createFolder: {
          type: 'boolean',
          description:
            'Whether to create the parent folder if it does not exist (default: false)',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.BOOKMARK_DELETE,
    description: 'Delete a bookmark from Chrome',
    inputSchema: {
      type: 'object',
      properties: {
        bookmarkId: {
          type: 'string',
          description:
            'ID of the bookmark to delete. Either bookmarkId or url must be provided.',
        },
        url: {
          type: 'string',
          description:
            'URL of the bookmark to delete. Used if bookmarkId is not provided.',
        },
        title: {
          type: 'string',
          description:
            'Title of the bookmark to help with matching when deleting by URL.',
        },
      },
      required: [],
    },
  },
];
