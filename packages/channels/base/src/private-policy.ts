import type { PrivatePolicy } from './types.js';

export function resolvePrivatePolicy(config: {
  privatePolicy?: unknown;
  senderPolicy?: unknown;
  dmPolicy?: unknown;
}): PrivatePolicy {
  const policy =
    config.privatePolicy !== undefined
      ? config.privatePolicy
      : config.dmPolicy === 'disabled'
        ? 'disabled'
        : (config.senderPolicy ?? 'allowlist');
  switch (policy) {
    case 'disabled':
      return 'disabled';
    case 'allowlist':
      return 'allowlist';
    case 'pairing':
      return 'pairing';
    case 'open':
      return 'open';
    default:
      throw new Error(
        'Channel privatePolicy must be one of: disabled, allowlist, pairing, open.',
      );
  }
}
