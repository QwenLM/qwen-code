import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildNestorAuthHeaders } from './nestorAuthHeader.js';

describe('buildNestorAuthHeaders', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses Nestor-Token for JWTs issued by Nestor token exchange', () => {
    expect(buildNestorAuthHeaders('jwt-from-exchange')).toEqual({
      'Nestor-Token': 'jwt-from-exchange',
    });
  });

  it('uses Authorization Bearer for delegated Blaze env JWTs', () => {
    vi.stubEnv('BLAZE_DP_JWT', 'delegated-jwt');

    expect(buildNestorAuthHeaders('delegated-jwt')).toEqual({
      Authorization: 'Bearer delegated-jwt',
    });
  });

  it('keeps legacy Nessy delegated JWT compatibility', () => {
    vi.stubEnv('NESSY_CLI_DP_AUTH_TOKEN', 'legacy-delegated-jwt');

    expect(buildNestorAuthHeaders('legacy-delegated-jwt')).toEqual({
      Authorization: 'Bearer legacy-delegated-jwt',
    });
  });
});
