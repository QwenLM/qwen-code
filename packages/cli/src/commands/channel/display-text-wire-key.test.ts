import { describe, expect, it } from 'vitest';
import { CHANNEL_PROMPT_DISPLAY_TEXT_META_KEY } from '@qwen-code/channel-base';
import { DAEMON_PROMPT_DISPLAY_TEXT_META_KEY } from '@qwen-code/acp-bridge/bridgeTypes';

// The channel bridges write the display projection under the channel-base key
// and the daemon-side Session reads it under the acp-bridge key; the packages
// have no dependency path between them, so pin the wire contract here where
// both packages are importable.
describe('channel prompt display text wire key', () => {
  it('is identical across channel-base and acp-bridge', () => {
    expect(CHANNEL_PROMPT_DISPLAY_TEXT_META_KEY).toBe(
      DAEMON_PROMPT_DISPLAY_TEXT_META_KEY,
    );
  });
});
