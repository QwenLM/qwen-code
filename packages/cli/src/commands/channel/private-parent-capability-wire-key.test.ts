import { describe, expect, it } from 'vitest';
import {
  ACP_PRIVATE_PARENT_CAPABILITY_ENV,
  ACP_PRIVATE_PARENT_CAPABILITY_META_KEY,
} from '@qwen-code/channel-base';
import {
  PRIVATE_ACP_CAPABILITY_ENV,
  PRIVATE_PARENT_CAPABILITY_META_KEY,
} from '@qwen-code/qwen-code-core';

// The standalone channel bridge performs the private-parent capability
// handshake under the channel-base constants and the ACP child validates it
// under the core constants; the packages have no dependency path between
// them, so pin the wire contract here where both packages are importable.
describe('private parent capability wire keys', () => {
  it('are identical across channel-base and core', () => {
    expect(ACP_PRIVATE_PARENT_CAPABILITY_META_KEY).toBe(
      PRIVATE_PARENT_CAPABILITY_META_KEY,
    );
    expect(ACP_PRIVATE_PARENT_CAPABILITY_ENV).toBe(PRIVATE_ACP_CAPABILITY_ENV);
  });
});
