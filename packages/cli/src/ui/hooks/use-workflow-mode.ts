/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';

export function useWorkflowMode(config: Config | undefined) {
  const [state, setState] = useState(() => config?.getWorkflowMode?.());
  useEffect(() => {
    const refresh = () => setState(config?.getWorkflowMode?.());
    refresh();
    return config?.onWorkflowModeChange?.(refresh);
  }, [config]);
  return state;
}
