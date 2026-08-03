/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
import { ConfigurationError } from './config.js';

export function installEnvironmentProxy(): EnvHttpProxyAgent {
  try {
    const dispatcher = new EnvHttpProxyAgent();
    setGlobalDispatcher(dispatcher);
    return dispatcher;
  } catch {
    throw new ConfigurationError(
      'Proxy environment configuration is invalid. Check HTTP_PROXY, HTTPS_PROXY, and NO_PROXY.',
    );
  }
}
