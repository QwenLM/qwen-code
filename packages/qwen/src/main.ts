#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { runCli } from '@qwen-code/cli';

void runCli({
  defaultAuthType: 'openai',
  defaultThemePair: { dark: 'Qwen Dark', light: 'Qwen Light' },
  prepareSettings: async () => {
    const { prepareQwenSettings } = await import('./settings-preparation.js');
    return prepareQwenSettings();
  },
  declarations: async () => {
    const { createCommandDeclarations } = await import(
      './command-declarations.js'
    );
    return createCommandDeclarations();
  },
  createFramework: async (signal, settings, mode, input) => {
    const { createCliFramework } = await import('./entry-frameworks.js');
    return createCliFramework(signal, settings, mode, input);
  },
});
