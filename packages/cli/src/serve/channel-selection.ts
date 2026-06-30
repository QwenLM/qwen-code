import type { ServeChannelSelection } from './types.js';

export function normalizeServeChannelSelection(
  rawChannels: string[] | undefined,
): ServeChannelSelection | undefined {
  if (rawChannels === undefined || rawChannels.length === 0) {
    return undefined;
  }

  const names: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawChannels) {
    const name = raw.trim();
    if (!name) {
      throw new Error('--channel requires a non-empty channel name.');
    }
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }

  if (seen.has('all')) {
    if (names.length > 1) {
      throw new Error('--channel all cannot be combined with channel names.');
    }
    return { mode: 'all' };
  }

  return { mode: 'names', names };
}
