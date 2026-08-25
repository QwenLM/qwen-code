/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { dwsProcessEnvironment } from './dws-environment.js';

describe('DWS process environment', () => {
  it('keeps runtime and DWS settings without forwarding unrelated secrets', () => {
    expect(
      dwsProcessEnvironment({
        HOME: '/srv/qwen',
        Path: '/usr/local/bin:/usr/bin',
        HTTPS_PROXY: 'http://proxy.example',
        LC_ALL: 'en_US.UTF-8',
        NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem',
        DWS_DISABLE_KEYCHAIN: '1',
        DWS_AGENT_PRODUCT: 'openclaw',
        AONE_SANDBOX_ID: 'sandbox-secret',
        XDG_DATA_HOME: '/srv/qwen/data',
        OPENAI_API_KEY: 'model-secret',
        QWEN_SERVER_TOKEN: 'daemon-secret',
        OTHER_CHANNEL_SECRET: 'channel-secret',
      }),
    ).toEqual({
      HOME: '/srv/qwen',
      Path: '/usr/local/bin:/usr/bin',
      HTTPS_PROXY: 'http://proxy.example',
      LC_ALL: 'en_US.UTF-8',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem',
      DWS_DISABLE_KEYCHAIN: '1',
      DWS_AGENT_PRODUCT: 'qwen-code',
      XDG_DATA_HOME: '/srv/qwen/data',
      NO_COLOR: '1',
    });
  });
});
