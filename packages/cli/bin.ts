#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { runCli } from './src/startup/runCli.js';

void runCli({
  defaultAuthType: 'qoder-oauth',
  defaultThemePair: { dark: 'Qwen Dark', light: 'Qwen Light' },
  declarations: async () => {
    const { QwenInstallationPlugin } = await import(
      './src/installation/plugin.js'
    );
    const { AuthPlugin } = await import('./src/auth/authPlugin.js');
    return [new QwenInstallationPlugin(), new AuthPlugin()];
  },
});
