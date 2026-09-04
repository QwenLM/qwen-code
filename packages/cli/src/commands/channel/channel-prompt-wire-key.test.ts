import { describe, expect, it } from 'vitest';
import { CHANNEL_PROMPT_META_KEY } from '@qwen-code/channel-base';
import { CHANNEL_PROMPT_META_KEY as BRIDGE_CHANNEL_PROMPT_META_KEY } from '@qwen-code/acp-bridge/bridgeTypes';

// The channel bridges write the channel-turn classification under the
// channel-base key and the daemon-side strip/re-injection reads it under
// the acp-bridge key; the packages have no dependency path between them,
// so pin the wire contract here where both packages are importable.
describe('channel prompt classification wire key', () => {
  it('is identical across channel-base and acp-bridge', () => {
    expect(CHANNEL_PROMPT_META_KEY).toBe(BRIDGE_CHANNEL_PROMPT_META_KEY);
  });
});
