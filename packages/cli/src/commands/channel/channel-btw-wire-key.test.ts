import { describe, expect, it } from 'vitest';
import { SERVE_CONTROL_EXT_METHODS } from '@qwen-code/acp-bridge/status';
import { CHANNEL_BTW_METHOD } from '@qwen-code/channel-base';

describe('channel BTW wire contract', () => {
  it('matches the ACP method', () => {
    expect(CHANNEL_BTW_METHOD).toBe(SERVE_CONTROL_EXT_METHODS.sessionBtw);
  });
});
