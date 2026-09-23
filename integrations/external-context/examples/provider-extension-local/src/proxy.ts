/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
import { ProviderConfigurationError } from './provider.js';

export function installEnvironmentProxy(): EnvHttpProxyAgent {
  try {
    const dispatcher = new EnvHttpProxyAgent({ proxyTunnel: false });
    setGlobalDispatcher(dispatcher);
    return dispatcher;
  } catch {
    throw new ProviderConfigurationError(
      'Provider proxy configuration is invalid.',
    );
  }
}
