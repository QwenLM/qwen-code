/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import { EnvConfigService } from '../env-config-service.js';
import { AGENTS_MD_SIZE_POLICY_KEY } from './agentsMdSizePolicy.js';
import { MODEL_REQUEST_ZSTD_GATE } from './modelRequestZstd.js';
import { CODE_MODE_FEATURE_GATE } from './codeMode.js';
import { PROMPT_SUGGESTION_FEATURE_GATE } from './promptSuggestion.js';
import { DYNAMIC_TURN_BUDGET_GATE } from './dynamicTurnBudget.js';
import {
  initializeConfigService,
  installConfigService,
  stopConfigService,
} from '../index.js';

describe('config-service/features registration', () => {
  it('registers Core feature gates against the installed source before it starts', async () => {
    const source = new EnvConfigService();
    const onValueChange = vi.spyOn(source, 'onValueChange');
    installConfigService(source);

    try {
      await initializeConfigService();

      expect(onValueChange).toHaveBeenCalledWith(
        AGENTS_MD_SIZE_POLICY_KEY,
        expect.any(Function),
      );
      expect(onValueChange).not.toHaveBeenCalledWith(
        'auto_mode_jev', expect.any(Function),
      );
      expect(onValueChange).toHaveBeenCalledWith(
        MODEL_REQUEST_ZSTD_GATE,
        expect.any(Function),
      );
      expect(onValueChange).toHaveBeenCalledWith(
        CODE_MODE_FEATURE_GATE,
        expect.any(Function),
      );
      expect(onValueChange).toHaveBeenCalledWith(
        PROMPT_SUGGESTION_FEATURE_GATE,
        expect.any(Function),
      );
      expect(onValueChange).toHaveBeenCalledWith(
        DYNAMIC_TURN_BUDGET_GATE,
        expect.any(Function),
      );
    } finally {
      await stopConfigService();
    }
  });
});
