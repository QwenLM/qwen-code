import type { ServeChannelSelection } from './types.js';

export const MAX_CHANNEL_INSTANCE_NAME_LENGTH = 256;

export function isAllChannelSelectionName(name: string): boolean {
  return name.trim() === 'all';
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

export function isSafePathComponent(value: string): boolean {
  return (
    value.trim().length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !hasControlCharacter(value) &&
    value.length <= MAX_CHANNEL_INSTANCE_NAME_LENGTH
  );
}

export function isSafeChannelName(
  name: string,
  options: { allowReservedAll?: boolean } = {},
): boolean {
  return (
    isSafePathComponent(name) &&
    (options.allowReservedAll === true || !isAllChannelSelectionName(name))
  );
}

export function assertSafeChannelName(name: string): void {
  if (!isSafeChannelName(name)) {
    throw new Error(`Invalid channel name: ${JSON.stringify(name)}.`);
  }
}

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

  if (names.some(isAllChannelSelectionName)) {
    if (names.length > 1) {
      throw new Error('--channel all cannot be combined with channel names.');
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
