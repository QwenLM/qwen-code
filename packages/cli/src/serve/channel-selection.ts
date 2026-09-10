import { sanitizeLogText } from '@qwen-code/channel-base';
import type { ServeChannelSelection } from './types.js';

export interface NormalizeServeChannelSelectionOptions {
  label?: string;
}

export interface StoredServeChannelNames {
  names: string[];
  rejected: string[];
}

export function isAllChannelSelectionName(name: string): boolean {
  return name.trim() === 'all';
}

export function isUnsafeServeChannelName(raw: string): boolean {
  return (
    raw.trimStart().startsWith('-') || sanitizeLogText(raw, raw.length) !== raw
  );
}

export function normalizeStoredServeChannelNames(
  rawChannels: readonly string[],
): StoredServeChannelNames {
  const names: string[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawChannels) {
    const name = raw.trim();
    if (!name || isUnsafeServeChannelName(raw)) {
      rejected.push(raw);
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return { names, rejected };
}

export function normalizeServeChannelSelection(
  rawChannels: string[] | undefined,
  options: NormalizeServeChannelSelectionOptions = {},
): ServeChannelSelection | undefined {
  if (rawChannels === undefined || rawChannels.length === 0) {
    return undefined;
  }

  const label = options.label ?? '--channel';
  for (const raw of rawChannels) {
    if (isUnsafeServeChannelName(raw)) {
      const rendered = sanitizeLogText(JSON.stringify(raw), 256);
      throw new Error(`${label} channel name ${rendered} is not allowed.`);
    }
    const name = raw.trim();
    if (!name) {
      throw new Error(`${label} requires a non-empty channel name.`);
    }
  }
  const { names } = normalizeStoredServeChannelNames(rawChannels);

  if (names.some(isAllChannelSelectionName)) {
    if (names.length > 1) {
      throw new Error(`${label} all cannot be combined with channel names.`);
    }
    return { mode: 'all' };
  }

  return { mode: 'names', names };
}

export function channelSelectionNames(
  selection: ServeChannelSelection,
): string[] {
  return selection.mode === 'all' ? ['all'] : [...selection.names];
}
