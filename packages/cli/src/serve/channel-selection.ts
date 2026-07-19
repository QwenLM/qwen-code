import type { ServeChannelSelection } from './types.js';

export const MAX_CHANNEL_INSTANCE_NAME_BYTES = 255;

const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function isAllChannelSelectionName(name: string): boolean {
  return name.trim() === 'all';
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        return false;
      }
      index++;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isWindowsDeviceName(value: string): boolean {
  const baseName = value.split('.', 1)[0]!.trimEnd();
  return WINDOWS_DEVICE_NAME.test(baseName);
}

export function isSafePathComponent(value: string): boolean {
  return (
    isWellFormedUnicode(value) &&
    value.trim().length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !/[:*?"<>|]/u.test(value) &&
    !hasControlCharacter(value) &&
    !value.endsWith('.') &&
    !value.endsWith(' ') &&
    !isWindowsDeviceName(value) &&
    Buffer.byteLength(value, 'utf8') <= MAX_CHANNEL_INSTANCE_NAME_BYTES
  );
}

export function isSafeChannelName(
  name: string,
  options: { allowReservedAll?: boolean } = {},
): boolean {
  if (options.allowReservedAll === true && isAllChannelSelectionName(name)) {
    return true;
  }
  return isSafePathComponent(name) && !isAllChannelSelectionName(name);
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
