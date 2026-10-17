import { describe, expect, it } from 'vitest';
import { ACP_ASK_USER_QUESTION_CAPABILITY_META_KEY } from '@qwen-code/channel-base';
import { ASK_USER_QUESTION_CAPABILITY_META_KEY } from '@qwen-code/qwen-code-core';

// The channel bridge advertises the structured-question capability under the
// channel-base constant while the ACP child reads it under the core constant;
// the packages have no dependency path between them, so pin the wire contract
// here where both are importable. qwen-live carries the same value but is not
// importable from here, so it pins it in its own adaptor test.
describe('ask_user_question capability wire key', () => {
  it('is identical across channel-base and core', () => {
    expect(ACP_ASK_USER_QUESTION_CAPABILITY_META_KEY).toBe(
      ASK_USER_QUESTION_CAPABILITY_META_KEY,
    );
  });
});
