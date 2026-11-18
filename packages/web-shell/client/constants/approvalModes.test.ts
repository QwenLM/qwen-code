import { describe, expect, it } from 'vitest';
import { DAEMON_APPROVAL_MODES } from '@qwen-code/sdk/daemon';
import { APPROVAL_MODES } from './approvalModes.js';

describe('approval-mode vocabulary parity', () => {
  it('mirrors the SDK permission modes exactly, in order', () => {
    expect([...APPROVAL_MODES]).toEqual([...DAEMON_APPROVAL_MODES]);
  });
});
