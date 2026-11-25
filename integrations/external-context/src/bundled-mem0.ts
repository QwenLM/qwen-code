/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ConfigurationError, resolveConfig } from './config.js';
import { runMcp } from './mcp.js';
import { installEnvironmentProxy } from './proxy.js';

try {
  const source = process.env['QWEN_BUNDLED_MEM0_CONFIG'];
  if (!source || Buffer.byteLength(source) > 64 * 1024) {
    throw new ConfigurationError(
      'Bundled Mem0 configuration is missing or invalid.',
    );
  }
  const config = await resolveConfig(JSON.parse(source));
  if (config.version !== 1 || config.provider.type !== 'mem0') {
    throw new ConfigurationError('Bundled Mem0 requires a Mem0 configuration.');
  }
  installEnvironmentProxy();
  await runMcp(config);
} catch (error) {
  process.stderr.write(
    '[mem0] ' +
      (error instanceof ConfigurationError
        ? error.message
        : 'Mem0 startup failed.') +
      '\n',
  );
  process.exitCode = 1;
}
