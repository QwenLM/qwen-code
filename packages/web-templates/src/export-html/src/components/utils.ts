import type { ChatData, ChatViewerMessage } from './types.js';

/**
 * Type guard for ChatViewerMessage
 */
export const isChatViewerMessage = (
  value: unknown,
): value is ChatViewerMessage => Boolean(value) && typeof value === 'object';

/**
 * Parse chat data from the embedded script tag
 */
export const parseChatData = (): ChatData => {
  const chatDataElement = document.getElementById('chat-data');
  if (!chatDataElement?.textContent) {
    return {};
  }

  try {
    const parsed = JSON.parse(chatDataElement.textContent) as unknown;
    if (parsed && typeof parsed === 'object') {
      return parsed as ChatData;
    }
    return {};
  } catch (error) {
    console.error('Failed to parse chat data.', error);
    return {};
  }
};

/**
 * Format session date for display
 */
export const formatSessionDate = (startTime?: string | null) => {
  if (!startTime) {
    return '-';
  }

  try {
    const date = new Date(startTime);
    return date.toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return startTime;
  }
};

/**
 * Format export time for display
 */
export const formatExportTime = (exportTime?: string | null) => {
  if (!exportTime) {
    return '-';
  }

  try {
    const date = new Date(exportTime);
    return date.toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return exportTime;
  }
};

/**
 * Format relative time (e.g., "5 minutes ago")
 */
export const formatRelativeTime = (startTime?: string | null) => {
  if (!startTime) {
    return '-';
  }

  try {
    const date = new Date(startTime);
    const startTimestamp = date.getTime();
    if (Number.isNaN(startTimestamp)) {
      return '-';
    }
    const now = new Date();
    const diffMs = Math.max(0, now.getTime() - startTimestamp);
    const diffSeconds = Math.floor(diffMs / 1000);
    const diffMinutes = Math.floor(diffSeconds / 60);
    const diffHours = Math.floor(diffMinutes / 60);
    const diffDays = Math.floor(diffHours / 24);
    const diffWeeks = Math.floor(diffDays / 7);
    const diffMonths = Math.floor(diffDays / 30);
    const diffYears = Math.floor(diffDays / 365);

    if (diffSeconds < 60) {
      return 'just now';
    } else if (diffMinutes < 60) {
      return `${diffMinutes} minute${diffMinutes === 1 ? '' : 's'} ago`;
    } else if (diffHours < 24) {
      return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
    } else if (diffDays < 7) {
      return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
    } else if (diffWeeks < 4) {
      return `${diffWeeks} week${diffWeeks === 1 ? '' : 's'} ago`;
    } else if (diffMonths < 12) {
      return `${diffMonths} month${diffMonths === 1 ? '' : 's'} ago`;
    } else {
      return `${diffYears} year${diffYears === 1 ? '' : 's'} ago`;
    }
  } catch {
    return '-';
  }
};

/**
 * Format path with truncation
 */
export const formatPath = (path: string, maxLength: number = 40) => {
  if (!path || path.length <= maxLength) return path;
  return '...' + path.slice(-maxLength + 3);
};

/**
 * Format token limit for display (e.g., 128k, 200k, 1m)
 * Returns undefined if tokens is not provided.
 */
export const formatTokenLimit = (tokens?: number): string | undefined => {
  if (tokens === undefined || tokens === null) return undefined;
  if (tokens >= 1000000) {
    return `${(tokens / 1000000).toFixed(tokens % 1000000 === 0 ? 0 : 1)}m`;
  }
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(tokens % 1000 === 0 ? 0 : 1)}k`;
  }
  return tokens.toString();
};
