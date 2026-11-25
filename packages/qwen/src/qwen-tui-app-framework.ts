/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AppPlugin } from '@qwen-code/cli';
import { TuiAppFramework } from '@qwen-code/cli/framework';
import { QwenSubscriptionPlugin } from './subscription-plugin.js';

export class QwenTuiAppFramework extends TuiAppFramework {
  protected override createAppPlugins(): readonly AppPlugin[] {
    return [...super.createAppPlugins(), new QwenSubscriptionPlugin()];
  }
}
